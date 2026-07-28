import { describe, it, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Fake filesystem ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-launch-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeZylosDir = path.join(fakeHome, 'zylos');

const savedEnv = {
  HOME: process.env.HOME,
  ZYLOS_DIR: process.env.ZYLOS_DIR,
  CLAUDE_BIN: process.env.CLAUDE_BIN,
  CODEX_BIN: process.env.CODEX_BIN,
  CLAUDE_BYPASS_PERMISSIONS: process.env.CLAUDE_BYPASS_PERMISSIONS,
  CODEX_BYPASS_PERMISSIONS: process.env.CODEX_BYPASS_PERMISSIONS,
  ZYLOS_INSTANCE_ID: process.env.ZYLOS_INSTANCE_ID,
  ZYLOS_TMUX_SESSION: process.env.ZYLOS_TMUX_SESSION,
  CODEX_HOME: process.env.CODEX_HOME,
};

process.env.HOME = fakeHome;
process.env.ZYLOS_DIR = fakeZylosDir;
process.env.CLAUDE_BIN = 'claude';
process.env.CODEX_BIN = 'codex';
process.env.CLAUDE_BYPASS_PERMISSIONS = 'false';
process.env.CODEX_BYPASS_PERMISSIONS = 'false';

// Directory structure
for (const dir of [
  path.join(fakeHome, '.claude'),
  path.join(fakeZylosDir, '.claude', 'skills', 'comm-bridge', 'scripts'),
  path.join(fakeZylosDir, '.claude', 'skills', 'zylos-memory', 'scripts'),
  path.join(fakeZylosDir, '.claude', 'skills', 'activity-monitor', 'scripts'),
  path.join(fakeZylosDir, 'memory'),
  path.join(fakeZylosDir, 'activity-monitor'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
  'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
].join('\n'));

fs.writeFileSync(path.join(fakeZylosDir, 'memory', 'state.md'), '- Status: completed\n');
fs.writeFileSync(path.join(fakeZylosDir, 'CLAUDE.md'), 'legacy claude instructions\n');
fs.writeFileSync(path.join(fakeZylosDir, 'AGENTS.md'), 'legacy codex instructions\n');

for (const script of [
  '.claude/skills/zylos-memory/scripts/session-start-inject.js',
  '.claude/skills/comm-bridge/scripts/c4-session-init.js',
  '.claude/skills/activity-monitor/scripts/session-start-prompt.js',
]) {
  fs.writeFileSync(path.join(fakeZylosDir, script), '// stub');
}

// ── Mock child_process ───────────────────────────────────────────────────────

const calls = { execSync: [], execFileSync: [] };
let tmuxSessionExists = false;

mock.module('node:child_process', {
  namedExports: {
    execSync: mock.fn((cmd, opts) => {
      calls.execSync.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('tmux has-session')) {
        if (!tmuxSessionExists) throw new Error('no session');
      }
      return '';
    }),
    execFileSync: mock.fn((file, args, opts) => {
      calls.execFileSync.push({ file, args: args ? [...args] : [], opts });
      if (file === 'tmux' && args?.[0] === 'has-session') {
        if (!tmuxSessionExists) throw new Error('no session');
        return '';
      }
      if (args?.[0] === '--version') return '2.1.137';
      if (args?.includes('auth')) throw new Error('not logged in');
      return '';
    }),
    spawnSync: mock.fn((file, args, opts) => {
      const canonicalZylosDir = fs.realpathSync(fakeZylosDir);
      const hooksPath = path.join(canonicalZylosDir, '.codex', 'hooks.json');
      const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      const stateLines = [];
      for (const [event, groups] of Object.entries(hooks.hooks || {})) {
        const eventName = event.replace(/[A-Z]/g, (m, i) => `${i ? '_' : ''}${m.toLowerCase()}`);
        groups.forEach((group, groupIndex) => {
          group.hooks.forEach((hook, hookIndex) => {
            if (!hook.command) return;
            const key = `${hooksPath}:${eventName}:${groupIndex}:${hookIndex}`;
            stateLines.push(
              `[hooks.state."${key}"]`,
              'enabled = true',
              'trusted_hash = "sha256:test"',
              '',
            );
          });
        });
      }
      const configPath = path.join(opts?.env?.CODEX_HOME || path.join(fakeHome, '.codex'), 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, [
        '[features]',
        'hooks = true',
        '',
        ...stateLines,
      ].join('\n'));
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n',
        stderr: '',
      };
    }),
    execFile: mock.fn((...fnArgs) => {
      const cb = fnArgs.find(a => typeof a === 'function');
      if (cb) process.nextTick(() => cb(null, '', ''));
      return { on: () => {}, stdout: null, stderr: null, pid: 0 };
    }),
  },
});

// ── Import adapters after mocks ──────────────────────────────────────────────

const { ClaudeAdapter } = await import('../runtime/claude.js');
const { CodexAdapter } = await import('../runtime/codex.js');

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls.execSync.length = 0;
  calls.execFileSync.length = 0;
  tmuxSessionExists = false;
  delete process.env.ZYLOS_INSTANCE_ID;
  delete process.env.ZYLOS_TMUX_SESSION;
  delete process.env.CODEX_HOME;
  try { fs.unlinkSync(path.join(fakeZylosDir, 'instances.json')); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function findTmuxNewSession() {
  return calls.execFileSync.find(
    c => c.file === 'tmux' && c.args?.includes('new-session')
  );
}

function makeAdapter(Cls) {
  const adapter = new Cls({});
  adapter.buildInstructionFile = async () => '/fake/instruction.md';
  return adapter;
}

function readSpecEnv() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    const spec = JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
    return spec.env;
  } catch {
    return null;
  }
}

function readLaunchSpec() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    return JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
  } catch {
    return null;
  }
}

// ── Claude launch tests ──────────────────────────────────────────────────────

describe('Claude launch — new session', () => {
  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain API key or ANTHROPIC_API_KEY', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('sk-ant-'), 'tmux cmdline must not contain API key value');
    assert.ok(!joined.includes('ANTHROPIC_API_KEY'), 'tmux cmdline must not expose ANTHROPIC_API_KEY');
  });

  it('spec.env excludes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT even when present in process.env', async () => {
    tmuxSessionExists = false;
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.CLAUDECODE, undefined, 'CLAUDECODE must be stripped from spec.env');
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, 'CLAUDE_CODE_ENTRYPOINT must be stripped from spec.env');
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  it('spec.env excludes auth tokens when native auth is detected', async () => {
    tmuxSessionExists = false;
    // Simulate native auth by writing a credentials file
    const credFile = path.join(fakeHome, '.claude', '.credentials.json');
    fs.writeFileSync(credFile, JSON.stringify({
      claudeAiOauth: { refreshToken: 'fake-refresh-token' },
    }));
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must be stripped when native auth detected');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'CLAUDE_CODE_OAUTH_TOKEN must be stripped when native auth detected');
    } finally {
      fs.unlinkSync(credFile);
    }
  });

  it('sets per-instance GH_CONFIG_DIR when launched for an instance', async () => {
    tmuxSessionExists = false;
    process.env.ZYLOS_INSTANCE_ID = 'user-pan';

    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
    const env = readSpecEnv();
    assert.ok(env, 'spec should be written');
    assert.equal(env.GH_CONFIG_DIR, path.join(fakeZylosDir, 'instances', 'user-pan', '.config', 'gh'));
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.ZYLOS_INSTANCE_ID, 'user-pan');
    assert.ok(fs.existsSync(env.GH_CONFIG_DIR), 'per-instance gh config dir should be created');
  });

  it('forces the Claude profile reasoning effort into the launch environment', async () => {
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.config.runtimeProfile = { id: 'claude-subscription', reasoningEffort: 'high' };

    await adapter.launch({ bypassPermissions: false });

    assert.equal(readSpecEnv().CLAUDE_EFFORT, 'high');
  });
});

describe('Claude launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('sends command via sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('claude'), 'sent command should reference claude');
  });

  it('exports per-instance GH_CONFIG_DIR before reusing a session', async () => {
    tmuxSessionExists = true;
    process.env.ZYLOS_INSTANCE_ID = 'user-limh';
    let sent = '';
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.includes("export GH_CONFIG_DIR='"));
    assert.ok(sent.includes(path.join(fakeZylosDir, 'instances', 'user-limh', '.config', 'gh')));
  });

  it('exports the Claude profile reasoning effort before reusing a session', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.config.runtimeProfile = { id: 'claude-subscription', reasoningEffort: 'high' };
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.includes("export CLAUDE_EFFORT='high'"));
  });
});

describe('Claude launch — compat mode PATH dedupe', () => {
  it('spec.env.PATH is deduplicated in compat mode', async () => {
    tmuxSessionExists = false;
    // Switch to compat mode
    fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
      'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
      'ZYLOS_CLEAN_ENV=false',
    ].join('\n'));
    // Inject a bloated PATH
    const origPath = process.env.PATH;
    process.env.PATH = '/a:/b:/a:/c:/b';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.PATH, '/a:/b:/c', 'PATH must be deduplicated in compat mode');

      const tmux = findTmuxNewSession();
      const pathArg = tmux.args.find(a => a.startsWith('PATH='));
      assert.ok(pathArg, 'tmux args should contain PATH= env');
      assert.equal(pathArg, 'PATH=/a:/b:/c', 'tmux -e PATH must also be deduplicated');
    } finally {
      process.env.PATH = origPath;
      // Restore default (clean env is now the default)
      fs.writeFileSync(path.join(fakeZylosDir, '.env'), [
        'ANTHROPIC_API_KEY=sk-ant-secret-test-key-do-not-expose',
      ].join('\n'));
    }
  });
});

// ── Codex launch tests ───────────────────────────────────────────────────────

describe('Codex launch — new session', () => {
  it('refuses to launch without instructions while split migration is pending', async () => {
    const agentsPath = path.join(fakeZylosDir, 'AGENTS.md');
    fs.unlinkSync(agentsPath);
    try {
      await assert.rejects(
        () => makeAdapter(CodexAdapter).launch({ bypassPermissions: false }),
        /missing while split instructions are pending migration/,
      );
    } finally {
      fs.writeFileSync(agentsPath, 'legacy codex instructions\n');
    }
  });

  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain secrets', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('sk-ant-'), 'tmux cmdline must not contain API key value');
  });

  it('launch spec carries the internal kick sentinel, not a human-looking prompt', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const spec = readLaunchSpec();
    assert.ok(spec, 'spec should be written');
    // Since #681 the only launch arg is the kick prompt that triggers the
    // SessionStart hook — never the retired text bootstrap payload. Since
    // #743/#745 that prompt is a stateless internal lifecycle sentinel,
    // never a human-looking greeting that could be mistaken for a user turn.
    assert.equal(spec.args.length, 1);
    // Exact-string lock: the full contract text, not a prefix — a mutated
    // second sentence must fail here.
    assert.equal(spec.args[0],
      'System startup trigger, not a user message. Continue with startup context.');
    assert.doesNotMatch(spec.args[0], /\bhello\b/i);
    assert.doesNotMatch(spec.args[0], /welcome back/i);
    assert.ok(!JSON.stringify(spec).includes('session-start-inject.js'));
  });

  it('kick sentinel is stateless — identical argv on every launch, no marker files (#743)', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });
    const first = readLaunchSpec().args[0];

    calls.execFileSync.length = 0;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });
    const second = readLaunchSpec().args[0];

    assert.equal(first, second, 'kick must not vary across launches');
    assert.ok(!fs.existsSync(path.join(fakeZylosDir, '.zylos', 'first-start-done')),
      'stateless sentinel must not persist launch state');
  });

  it('honors CODEX_HOME for an upstream single-session runtime profile', async () => {
    const codexHome = path.join(fakeHome, '.codex-subscription');
    fs.mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;

    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    assert.equal(readSpecEnv().CODEX_HOME, codexHome);
  });

  it('sets per-instance GH_CONFIG_DIR when launched for an instance', async () => {
    tmuxSessionExists = false;
    process.env.ZYLOS_INSTANCE_ID = 'yanzi';

    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });
    const env = readSpecEnv();
    assert.ok(env, 'spec should be written');
    assert.equal(env.GH_CONFIG_DIR, path.join(fakeZylosDir, 'instances', 'yanzi', '.config', 'gh'));
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.ZYLOS_INSTANCE_ID, 'yanzi');
    assert.ok(fs.existsSync(env.GH_CONFIG_DIR), 'per-instance gh config dir should be created');
    assert.equal(
      fs.existsSync(path.join(fakeZylosDir, 'instances', 'yanzi', '.codex', 'hooks.json')),
      false,
      'instance overlays must use the shared root hook instead of creating a duplicate',
    );
  });

  it('launches an os_user instance with its isolated Codex profile and forced model settings', async () => {
    tmuxSessionExists = false;
    process.env.ZYLOS_INSTANCE_ID = 'user-pan';
    const agentHome = path.join(tmpRoot, 'zylos-pan');
    const codexHome = path.join(agentHome, '.codex-azure');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'azure-secret-not-on-command-line',
    }));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'openai_base_url = "https://azure.example.com/openai/v1"',
      '[features]',
      'hooks = true',
    ].join('\n'));
    fs.writeFileSync(path.join(fakeZylosDir, 'instances.json'), JSON.stringify({
      instances: { 'user-pan': { os_user: 'zylos-pan' } },
    }));

    const adapter = makeAdapter(CodexAdapter);
    adapter.config.runtimeProfile = {
      id: 'codex-azure',
      runtime: 'codex',
      runtimeHome: agentHome,
      codexHome,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      providerEnvKey: 'AZURE_FOUNDRY_KEY',
    };
    await adapter.launch({ bypassPermissions: false });

    const spec = readLaunchSpec();
    assert.ok(spec, 'spec should be written');
    assert.equal(spec.env.HOME, agentHome);
    assert.equal(spec.env.USER, 'zylos-pan');
    assert.equal(spec.env.CODEX_HOME, codexHome);
    assert.equal(spec.env.AZURE_FOUNDRY_KEY, 'azure-secret-not-on-command-line');
    assert.deepEqual(spec.args, [
      '-m', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort="medium"',
      'System startup trigger, not a user message. Continue with startup context.',
    ]);

    const tmux = findTmuxNewSession();
    const command = tmux.args[tmux.args.length - 1];
    assert.match(command, /sudo -n -u zylos-pan -H --/);
    assert.equal(command.includes('azure-secret-not-on-command-line'), false);
    assert.equal(tmux.args.join(' ').includes('AZURE_FOUNDRY_KEY'), false);

    const configPath = path.join(codexHome, 'config.toml');
    assert.ok(calls.execFileSync.some(call =>
      call.file === 'sudo'
      && call.args.join('\0') === ['-n', 'chgrp', 'zylos-pan', configPath].join('\0')
    ), 'hook trust rewrites must restore the persona-private config group');
    assert.ok(calls.execFileSync.some(call =>
      call.file === 'sudo'
      && call.args.join('\0') === ['-n', 'chmod', '0660', configPath].join('\0')
    ), 'hook trust rewrites must restore group read/write mode');
  });
});

describe('Codex launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('does not inject a bootstrap prompt in sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('codex'), 'sent command should reference codex');
    // Exact-string lock for the paste path: the kick must ride as one
    // double-quoted argv carrying the full contract text.
    assert.ok(sent.includes(
      '"System startup trigger, not a user message. Continue with startup context."'),
    'existing-session command must carry the exact kick as one quoted argv');
    assert.ok(!sent.includes('_p=$(cat'), 'existing-session command should not load bootstrap prompt');
    assert.ok(!sent.includes('session-start-inject.js'), 'existing-session command should not run text bootstrap');
  });

  it('exports per-instance GH_CONFIG_DIR before reusing a session', async () => {
    tmuxSessionExists = true;
    process.env.ZYLOS_INSTANCE_ID = 'scheduler';
    let sent = '';
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.includes("export GH_CONFIG_DIR='"));
    assert.ok(sent.includes(path.join(fakeZylosDir, 'instances', 'scheduler', '.config', 'gh')));
  });
});
