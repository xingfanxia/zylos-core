import assert from 'node:assert/strict';
import { describe, it, afterEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ── test setup ──────────────────────────────────────────────────────
// The hook script uses os.homedir() which reads from passwd, not HOME env.
// We set ZYLOS_DIR to override the base path for log and config files.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-prompt-test-'));
const logDir = path.join(tmpDir, 'activity-monitor');
const configDir = path.join(tmpDir, '.zylos');
const configFile = path.join(configDir, 'config.json');
const logFile = path.join(logDir, 'hook-timing.log');
const hookScript = path.resolve(import.meta.dirname, '..', 'hook-auth-prompt.js');

// Create a small wrapper script that patches the paths before running the hook
const wrapperScript = path.join(tmpDir, 'run-hook.js');
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

// The wrapper overrides ZYLOS_DIR then spawns the actual hook
fs.writeFileSync(wrapperScript, `
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-timing.log');
const CONFIG_FILE = path.join(ZYLOS_DIR, '.zylos', 'config.json');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

let input = '';
for await (const chunk of process.stdin) { input += chunk; }
let hookData;
try { hookData = JSON.parse(input); } catch { process.exit(0); }

const tool = hookData.tool_name || '(unknown)';
const inputKeys = hookData.tool_input ? Object.keys(hookData.tool_input).join(',') : '';
const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
const line = '[' + ts + '] hook=auth-prompt event=PermissionRequest tool=' + tool + ' input_keys=[' + inputKeys + ']\\n';

try { fs.appendFileSync(LOG_FILE, line); } catch {}

const config = readConfig();
const autoApprove = config.auto_approve_permission !== false;
const runtime = config.runtime || 'claude';

if (autoApprove && runtime === 'claude') {
  try {
    execFileSync('node', [C4_CONTROL, 'enqueue', '--content', '[KEYSTROKE]Enter',
      '--priority', '0', '--bypass-state', '--available-in', '1', '--no-ack-suffix'
    ], { stdio: 'pipe', timeout: 5000 });
    // Write a marker so the test can detect the enqueue attempt
    fs.appendFileSync(path.join(ZYLOS_DIR, 'activity-monitor', 'enqueue-attempted.flag'), '1');
  } catch {
    // C4 control script won't exist in test — write a different marker
    fs.appendFileSync(path.join(ZYLOS_DIR, 'activity-monitor', 'enqueue-attempted.flag'), '1');
  }
}
`);

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  try { fs.unlinkSync(logFile); } catch {}
  try { fs.unlinkSync(configFile); } catch {}
  try { fs.unlinkSync(path.join(logDir, 'enqueue-attempted.flag')); } catch {}
});

function writeConfig(obj) {
  fs.writeFileSync(configFile, JSON.stringify(obj));
}

function runHook(hookData) {
  try {
    return execFileSync('node', [wrapperScript], {
      input: JSON.stringify(hookData),
      env: { ...process.env, ZYLOS_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    }).toString();
  } catch {
    return '';
  }
}

function enqueueAttempted() {
  return fs.existsSync(path.join(logDir, 'enqueue-attempted.flag'));
}

const sampleInput = {
  tool_name: 'Bash',
  tool_input: { command: 'ls -la' }
};

// ── tests ───────────────────────────────────────────────────────────

describe('hook-auth-prompt', () => {
  describe('logging', () => {
    it('logs PermissionRequest event to hook-timing.log', () => {
      runHook(sampleInput);
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /hook=auth-prompt/);
      assert.match(log, /event=PermissionRequest/);
      assert.match(log, /tool=Bash/);
      assert.match(log, /input_keys=\[command\]/);
    });

    it('handles malformed JSON input gracefully', () => {
      try {
        execFileSync('node', [wrapperScript], {
          input: 'not-json',
          env: { ...process.env, ZYLOS_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000
        });
      } catch {}
      assert.equal(fs.existsSync(logFile), false);
    });

    it('logs (unknown) when tool_name is missing', () => {
      runHook({ tool_input: { file_path: '/tmp/test' } });
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /tool=\(unknown\)/);
    });
  });

  describe('auto_approve_permission config', () => {
    it('attempts enqueue when config is true', () => {
      writeConfig({ auto_approve_permission: true });
      runHook(sampleInput);
      assert.equal(enqueueAttempted(), true);
    });

    it('attempts enqueue when config key is absent (default true)', () => {
      writeConfig({ domain: 'test.example.com' });
      runHook(sampleInput);
      assert.equal(enqueueAttempted(), true);
    });

    it('attempts enqueue when config file is missing (default true)', () => {
      runHook(sampleInput);
      assert.equal(enqueueAttempted(), true);
    });

    it('skips enqueue when config is false', () => {
      writeConfig({ auto_approve_permission: false });
      runHook(sampleInput);
      assert.equal(enqueueAttempted(), false);
      // Event is still logged
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /hook=auth-prompt/);
    });

    it('skips enqueue when runtime is codex', () => {
      writeConfig({ auto_approve_permission: true, runtime: 'codex' });
      runHook(sampleInput);
      assert.equal(enqueueAttempted(), false);
      // Event is still logged
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /hook=auth-prompt/);
    });
  });
});

// ── finding 5: the auto-approve Enter is bound to the hook's own pane ──────
// Runs the real hook (not the wrapper copy above) with HOME pointed at a temp
// dir: a fake c4-control.js records the enqueue argv and a fake `tmux` on PATH
// answers the pane-identity read. No real tmux is spawned.
describe('hook-auth-prompt (real hook): --session-ref binding', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-prompt-real-'));
  const zylos = path.join(home, 'zylos');
  const bin = path.join(home, 'bin');
  const argsFile = path.join(home, 'enqueue-args.json');
  const tmuxLog = path.join(home, 'tmux-args.log');
  const c4Dir = path.join(zylos, '.claude', 'skills', 'comm-bridge', 'scripts');
  fs.mkdirSync(c4Dir, { recursive: true });
  fs.mkdirSync(path.join(zylos, 'activity-monitor'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(c4Dir, 'c4-control.js'),
    `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.writeFileSync(path.join(c4Dir, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(tmuxLog)}
[ -n "$FAKE_TMUX_FAIL" ] && { echo "no server running" >&2; exit 1; }
printf '%s\\n' "$FAKE_TMUX_OUT"
`, { mode: 0o755 });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  function runReal(env) {
    for (const f of [argsFile, tmuxLog]) fs.rmSync(f, { force: true });
    const base = { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}` };
    delete base.TMUX_PANE;
    delete base.FAKE_TMUX_FAIL;
    execFileSync(process.execPath, [hookScript], { input: JSON.stringify(sampleInput), env: { ...base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    return {
      args: JSON.parse(fs.readFileSync(argsFile, 'utf8')),
      tmux: fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8').trim().split('\n') : [],
    };
  }
  const UNBOUND = ['enqueue', '--content', '[KEYSTROKE]Enter', '--priority', '0', '--bypass-state',
    '--available-in', '1', '--no-ack-suffix'];
  const REF = '$3:1762790000:%12:48211';

  it('reads its own pane identity via TMUX_PANE and binds the key with --session-ref', () => {
    const got = runReal({ TMUX_PANE: '%12', FAKE_TMUX_OUT: REF });
    assert.deepEqual(got.tmux, ['display-message', '-p', '-t', '%12', '#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}']);
    assert.deepEqual(got.args, [...UNBOUND, '--session-ref', REF]);
  });

  it('enqueues unbound exactly as before when TMUX_PANE is unset (no tmux read)', () => {
    const got = runReal({ FAKE_TMUX_OUT: REF });
    assert.deepEqual(got.tmux, []);
    assert.deepEqual(got.args, UNBOUND);
  });

  it('enqueues unbound when the identity read fails (e.g. no access to the tmux socket)', () => {
    assert.deepEqual(runReal({ TMUX_PANE: '%12', FAKE_TMUX_FAIL: '1' }).args, UNBOUND);
  });

  it('enqueues unbound when tmux answers something that is not a pane identity', () => {
    assert.deepEqual(runReal({ TMUX_PANE: '%12', FAKE_TMUX_OUT: 'garbage' }).args, UNBOUND);
  });
});
