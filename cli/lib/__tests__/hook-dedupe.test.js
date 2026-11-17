import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// A host shaped like ax-devbox: the real install lives outside $HOME and
// `~/zylos` is a symlink to it. settings.json then holds the same scripts as
// `~/zylos/.claude/...` (old template) and as the absolute real path (sync).
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-dedupe-')));
const realZylos = path.join(base, 'srv', 'zylos');
const home = path.join(base, 'home', 'operator');
fs.mkdirSync(path.join(realZylos, '.claude', 'skills', 'activity-monitor', 'scripts'), { recursive: true });
fs.mkdirSync(path.join(realZylos, '.zylos', 'instructions'), { recursive: true });
fs.writeFileSync(path.join(realZylos, '.zylos', 'instructions', 'assembler.mjs'), '');
fs.mkdirSync(home, { recursive: true });
fs.symlinkSync(realZylos, path.join(home, 'zylos'));

const savedEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
process.env.HOME = home;
process.env.ZYLOS_DIR = realZylos;

const { hookScriptKey } = await import('../hook-utils.js');
const { desiredClaudeHooks, pruneDuplicateHookRegistrations, syncHooks } = await import('../sync-settings-hooks.js');
const { pruneSettingsFile } = await import('../prune-duplicate-hooks.js');

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

const SCRIPTS = 'skills/activity-monitor/scripts';
const tilde = name => `node ~/zylos/.claude/${SCRIPTS}/${name}`;
const absolute = name => `node ${realZylos}/.claude/${SCRIPTS}/${name}`;
const SHARDS = ['identity', 'custom', 'references', 'state', 'c4-checkpoint', 'c4-conversations', 'fg', 'start-prompt'];

function assemblerHook() {
  const dir = path.join(realZylos, '.zylos', 'instructions');
  return {
    type: 'command',
    command: `node "${dir}/assembler.mjs" --marker "${dir}/meta.json" --system "${dir}/claude-system.md" --user "${realZylos}/ZYLOS.md" --output "${realZylos}/CLAUDE.md"`,
    timeout: 20000,
  };
}

// The live 2026-11-17 layout: every hook under both spellings, and the legacy
// no-argument orchestrator next to the per-shard commands.
function liveLikeSettings() {
  const cmd = (command, extra = {}) => ({ type: 'command', command, ...extra });
  const activity = { async: true, timeout: 5 };
  return {
    model: 'claude-opus-5',
    hooks: {
      SessionStart: ['startup', 'clear', 'compact'].map(matcher => ({
        matcher,
        hooks: [
          assemblerHook(),
          cmd(tilde('session-start-orchestrator.js'), { timeout: 20000 }),
          ...SHARDS.map(shard => cmd(`${absolute('session-start-orchestrator.js')} --shard ${shard}`, { timeout: 20000 })),
        ],
      })),
      UserPromptSubmit: [{ hooks: [cmd(tilde('hook-activity.js'), activity), cmd(absolute('hook-activity.js'), activity)] }],
      PreToolUse: [{
        matcher: '',
        hooks: [
          cmd(tilde('hook-activity.js'), activity),
          cmd(tilde('memory-guard.js'), { timeout: 5 }),
          cmd(tilde('src-egress-guard.js'), { timeout: 5 }),
          cmd(absolute('memory-guard.js'), { timeout: 5 }),
          cmd(absolute('src-egress-guard.js'), { timeout: 5 }),
          cmd(absolute('hook-activity.js'), activity),
          cmd('node /home/someone/.claude/hooks/egress-guard.py'),
        ],
      }],
      PostToolUse: [{ matcher: '', hooks: [cmd(tilde('hook-activity.js'), activity), cmd(absolute('hook-activity.js'), activity)] }],
      PostToolUseFailure: [{ matcher: '', hooks: [cmd(tilde('hook-activity.js'), activity), cmd(absolute('hook-activity.js'), activity)] }],
      Stop: [{ hooks: [cmd(tilde('hook-activity.js'), activity), cmd(absolute('hook-activity.js'), activity)] }],
      Notification: [{ matcher: 'idle_prompt', hooks: [cmd(tilde('hook-activity.js'), activity), cmd(absolute('hook-activity.js'), activity)] }],
      PermissionRequest: [{ hooks: [cmd(tilde('hook-auth-prompt.js'), { async: true, timeout: 5000 }), cmd(absolute('hook-auth-prompt.js'), { async: true, timeout: 5000 })] }],
    },
  };
}

function commandCounts(settings) {
  return Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [
    event,
    groups.map(group => group.hooks.length),
  ]));
}

const EXPECTED_AFTER = {
  SessionStart: [9, 9, 9],
  UserPromptSubmit: [1],
  PreToolUse: [4],
  PostToolUse: [1],
  PostToolUseFailure: [1],
  Stop: [1],
  Notification: [1],
  PermissionRequest: [1],
};

describe('hook script identity through a symlinked install', () => {
  it('keys the ~/zylos spelling and the real absolute path identically', () => {
    assert.equal(hookScriptKey(tilde('hook-activity.js')), `${SCRIPTS}/hook-activity.js`);
    assert.equal(hookScriptKey(absolute('hook-activity.js')), `${SCRIPTS}/hook-activity.js`);
    assert.equal(
      hookScriptKey(`${tilde('session-start-orchestrator.js')} --shard state`),
      hookScriptKey(`${absolute('session-start-orchestrator.js')} --shard state`),
    );
  });

  it('still keeps hooks outside the install as their full path', () => {
    assert.equal(hookScriptKey('node /home/someone/.claude/hooks/egress-guard.py'), '/home/someone/.claude/hooks/egress-guard.py');
  });
});

describe('pruneDuplicateHookRegistrations', () => {
  it('leaves one registration per script and drops the legacy orchestrator', () => {
    const settings = liveLikeSettings();
    const removed = pruneDuplicateHookRegistrations(settings, { zylosDir: realZylos });
    assert.deepEqual(commandCounts(settings), EXPECTED_AFTER);
    assert.equal(removed.filter(item => /legacy orchestrator/.test(item.reason)).length, 3);
    // The HOME-independent absolute spelling is the one kept.
    for (const groups of Object.values(settings.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) assert.equal(hook.command.includes('~/'), false, hook.command);
      }
    }
    // The user's own hook outside the install is untouched.
    assert.ok(settings.hooks.PreToolUse[0].hooks.some(hook => hook.command.includes('egress-guard.py')));
    assert.equal(settings.hooks.PreToolUse[0].hooks.find(hook => hook.command.includes('hook-activity.js')).async, true);
  });

  it('is idempotent', () => {
    const settings = liveLikeSettings();
    pruneDuplicateHookRegistrations(settings, { zylosDir: realZylos });
    const snapshot = JSON.stringify(settings);
    assert.deepEqual(pruneDuplicateHookRegistrations(settings, { zylosDir: realZylos }), []);
    assert.equal(JSON.stringify(settings), snapshot);
  });

  it('dry run reports without changing anything', () => {
    const settings = liveLikeSettings();
    const snapshot = JSON.stringify(settings);
    const removed = pruneDuplicateHookRegistrations(settings, { zylosDir: realZylos, dryRun: true });
    assert.equal(removed.length, 3 + 3 + 6);
    assert.equal(JSON.stringify(settings), snapshot);
  });
});

describe('syncHooks over the live-like layout', () => {
  const desiredHooks = desiredClaudeHooks({ zylosDir: realZylos, existsSync: () => true, stopFailureSupported: false });

  it('converges to one registration per event and is a no-op the second time', () => {
    const settings = liveLikeSettings();
    syncHooks(settings, {}, { log: () => {}, desiredHooks, claimedKeys: new Set(), zylosDir: realZylos });
    assert.deepEqual(commandCounts(settings), EXPECTED_AFTER);
    const second = syncHooks(settings, {}, { log: () => {}, desiredHooks, claimedKeys: new Set(), zylosDir: realZylos });
    assert.deepEqual(second, { added: 0, updated: 0, removed: 0 });
  });

  it('dry run counts each removal once', () => {
    const settings = liveLikeSettings();
    const result = syncHooks(settings, {}, { dryRun: true, log: () => {}, desiredHooks, claimedKeys: new Set(), zylosDir: realZylos });
    assert.equal(result.removed, 12);
  });
});

describe('prune-duplicate-hooks CLI core', () => {
  it('dry run by default; --apply writes once with a backup and keeps the file mode', () => {
    const settingsPath = path.join(base, 'settings.json');
    fs.writeFileSync(settingsPath, `${JSON.stringify(liveLikeSettings(), null, 2)}\n`);
    fs.chmodSync(settingsPath, 0o664);
    const before = fs.readFileSync(settingsPath, 'utf8');

    const dry = pruneSettingsFile({ settingsPath, zylosDir: realZylos, log: () => {} });
    assert.equal(dry.written, false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);

    const applied = pruneSettingsFile({ settingsPath, zylosDir: realZylos, apply: true, now: 1, log: () => {} });
    assert.equal(applied.written, true);
    assert.equal(fs.readFileSync(applied.backupPath, 'utf8'), before);
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(commandCounts(after), EXPECTED_AFTER);
    assert.equal(after.model, 'claude-opus-5');
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o664);
    // Nothing is added: no hook-health registration appears.
    assert.equal(JSON.stringify(after).includes('hook-health'), false);

    const again = pruneSettingsFile({ settingsPath, zylosDir: realZylos, apply: true, now: 2, log: () => {} });
    assert.equal(again.written, false);
  });
});
