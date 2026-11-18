import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Runs the real hook with HOME pointed at a temp dir. A fake c4-control.js
// records any enqueue and a fake `tmux` on PATH records any pane read, so the
// tests see every key the hook could queue. No real tmux is spawned.
//
// 2026-11-18 (DELIVER-1): the hook never answers a permission prompt. Its
// auto-approve Enter was queued for Claude Code 2.1.326's dangerous-command
// prompt about user-pan's `rm -f $D/*` (bypass mode included) and would have
// selected "1. Yes" had the prompt been read correctly. Prompts are cancelled
// by the dialog watch instead.
const hookScript = path.resolve(import.meta.dirname, '..', 'hook-auth-prompt.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-prompt-real-'));
const zylos = path.join(home, 'zylos');
const bin = path.join(home, 'bin');
const argsFile = path.join(home, 'enqueue-args.json');
const tmuxLog = path.join(home, 'tmux-args.log');
const logFile = path.join(zylos, 'activity-monitor', 'hook-timing.log');
const configFile = path.join(zylos, '.zylos', 'config.json');
const c4Dir = path.join(zylos, '.claude', 'skills', 'comm-bridge', 'scripts');
fs.mkdirSync(c4Dir, { recursive: true });
fs.mkdirSync(path.join(zylos, 'activity-monitor'), { recursive: true });
fs.mkdirSync(path.dirname(configFile), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(c4Dir, 'c4-control.js'),
  `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
fs.writeFileSync(path.join(c4Dir, 'package.json'), '{"type":"commonjs"}');
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(tmuxLog)}
printf '%s\\n' '$3:1762790000:%12:48211'
`, { mode: 0o755 });
after(() => fs.rmSync(home, { recursive: true, force: true }));

function runReal(input, { config = null, raw = null } = {}) {
  for (const f of [argsFile, tmuxLog, logFile, configFile]) fs.rmSync(f, { force: true });
  if (config) fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, TMUX_PANE: '%12' };
  execFileSync(process.execPath, [hookScript], { input: raw ?? JSON.stringify(input), env,
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
  return {
    enqueued: fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null,
    tmux: fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8').trim().split('\n') : [],
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : null,
  };
}

const bash = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -f $D/*' } };

describe('hook-auth-prompt', () => {
  it('logs the event: tool, input keys and permission mode, never the input values', () => {
    const got = runReal({ ...bash, permission_mode: 'bypassPermissions' });
    assert.match(got.log, /hook=auth-prompt event=PermissionRequest tool=Bash input_keys=\[command\] mode=bypassPermissions\n$/);
    assert.doesNotMatch(got.log, /rm -f/);
  });

  it('logs (unknown) for a missing tool name and mode', () => {
    assert.match(runReal({ tool_input: { file_path: '/tmp/x' } }).log, /tool=\(unknown\) input_keys=\[file_path\] mode=unknown/);
  });

  it('ignores malformed input', () => {
    assert.equal(runReal(null, { raw: 'not-json' }).log, null);
  });

  it('never queues a key, in any permission mode or configuration, and reads no pane', () => {
    for (const permission_mode of ['bypassPermissions', 'default', 'acceptEdits', 'plan', undefined]) {
      for (const config of [null, { auto_approve_permission: true }, { runtime: 'claude' }]) {
        const got = runReal({ ...bash, permission_mode }, { config });
        assert.equal(got.enqueued, null, `mode=${permission_mode} config=${JSON.stringify(config)}`);
        assert.deepEqual(got.tmux, []);
      }
    }
  });
});
