/**
 * monitor.js — async-send seam (REL-9b, finding #2).
 *
 * monitor.js is the activity-monitor daemon ENTRY. It is import-safe only under
 * MONITOR_DISABLE_MAIN=1 (the main-module guard skips init/handlers/scheduleLoop);
 * ZYLOS_DIR + an instances.json with an admin chat_id must be in place BEFORE the
 * dynamic import so ADMIN_CHAT_ID resolves at module load (notifyDegradedAdmin
 * short-circuits when it is null). These are the two regression anchors for the
 * REL-9 async-send crash-hardening:
 *   - runC4Send NEVER rejects: every failure edge (spawn throw, async stdin EPIPE,
 *     child 'error', non-zero close, 15s timeout) resolves { ok:false }. A single
 *     unhandled rejection here would take the whole liveness supervisor down.
 *   - notifyDegradedAdmin is a fire-and-forget callback the health-engine invokes
 *     inside a SYNCHRONOUS try/catch, so its promise must never reject even when
 *     formatDegradedAdminAlert throws on malformed details.
 * spawn is injected via runC4Send's optional 5th arg so no real child is spawned.
 */

import assert from 'node:assert/strict';
import { describe, it, mock, after } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Sandbox scaffold (must precede the dynamic import) ──────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-seam-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.MONITOR_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(tmpDir, 'state', 'admin'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    admin: { primary: true, state_dir: path.join(tmpDir, 'state', 'admin'), tmux_session: 'claude-main', chat_ids: ['oc_admin'] },
  },
}));

const monitor = await import('../monitor.js');

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

// A fake ChildProcess with the exact surface runC4Send touches: stdout/stderr/stdin
// event emitters, stdin.write/end, and a kill() spy. Nothing is emitted until the
// test drives it, so the child "never closes" until told to.
function makeFakeChild({ writeImpl } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = writeImpl ?? (() => {});
  child.stdin.end = () => {};
  child.kill = mock.fn();
  return child;
}

describe('monitor runC4Send (async send, never-reject seam)', () => {
  it('resolves {ok:false} with a /stdin/ output on an async stdin EPIPE (no throw)', async () => {
    const child = makeFakeChild();
    const p = monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', { spawn: () => child });
    // The child exits before reading stdin → Node emits an ASYNC 'error' on
    // child.stdin. With no listener this becomes an uncaughtException that kills
    // the daemon; the seam attaches a listener that resolves {ok:false}.
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const res = await p;
    assert.equal(res.ok, false);
    assert.match(res.output, /stdin/);
  });

  it('kills the child and resolves {ok:false, /timeout/} once the 15s cap elapses', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const child = makeFakeChild();
      const p = monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', { spawn: () => child });
      mock.timers.tick(15000); // never emits close → only the cap can settle it
      const res = await p;
      assert.equal(res.ok, false);
      assert.match(res.output, /timeout/);
      assert.equal(child.kill.mock.callCount(), 1, 'the hung child must be SIGKILLed');
      assert.deepEqual(child.kill.mock.calls[0].arguments, ['SIGKILL']);
    } finally {
      mock.timers.reset();
    }
  });

  it('resolves {ok:false} when spawn throws synchronously', async () => {
    const res = await monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', {
      spawn: () => { throw new Error('ENOENT node'); },
    });
    assert.equal(res.ok, false);
    assert.match(res.output, /ENOENT node/);
  });

  it('resolves {ok:true} with trimmed stdout on close code 0', async () => {
    const child = makeFakeChild();
    const p = monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', { spawn: () => child });
    child.stdout.emit('data', '  delivered  ');
    child.emit('close', 0);
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.output, 'delivered');
  });

  it('resolves {ok:false} with stderr on a non-zero close code', async () => {
    const child = makeFakeChild();
    const p = monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', { spawn: () => child });
    child.stderr.emit('data', 'send failed: boom');
    child.emit('close', 3);
    const res = await p;
    assert.equal(res.ok, false);
    assert.match(res.output, /boom/);
  });

  it('resolves (never rejects) on a child process error event', async () => {
    const child = makeFakeChild();
    const p = monitor.runC4Send('feishu', 'oc_admin', 'hi', 'usage-alert', { spawn: () => child });
    child.emit('error', new Error('spawn failed post-hoc'));
    await assert.doesNotReject(p);
    assert.equal((await p).ok, false);
  });
});

describe('monitor notifyDegradedAdmin (fire-and-forget, never-reject)', () => {
  it('resolves without rejecting when the details are malformed (format throws)', async () => {
    // formatDegradedAdminAlert(null) throws while evaluating runC4Send's args;
    // the self-contained try/catch must swallow it so the health-engine caller —
    // which invokes this inside a synchronous try/catch — gets no unhandledRejection.
    await assert.doesNotReject(() => monitor.notifyDegradedAdmin(null));
  });
});
