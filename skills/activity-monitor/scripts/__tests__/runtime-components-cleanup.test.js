import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { scheduleStaleRuntimeCleanup } from '../adapters/runtime-components.js';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-legacy-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const callbacks = [], calls = [];
  const options = { env: {}, zylosDir: root, log: () => {},
    setTimeoutImpl: (fn) => callbacks.push(fn), execFileSyncImpl: (bin, args) => calls.push([bin, ...args]), ...overrides };
  return { root, callbacks, calls, options };
}

test('group and scheduler never schedule cleanup of admin when instance identity is set', (t) => {
  for (const id of ['group', 'scheduler']) {
    const f = fixture(t, { env: { ZYLOS_INSTANCE_ID: id } });
    scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: `claude-${id}` }, f.options);
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('instances.json protects every configured identity even without instance env or valid JSON', (t) => {
  const f = fixture(t);
  for (const data of ['{"instances":{"admin":{"tmux_session":"claude-main"}}}', 'malformed']) {
    fs.writeFileSync(path.join(f.root, 'instances.json'), data);
    for (const name of ['claude-group', 'claude-scheduler', 'codex-main']) {
      scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: name }, f.options);
    }
  }
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.calls.length, 0);
});

test('inaccessible configuration and unknown workspace fail closed', (t) => {
  const f = fixture(t, { lstatSyncImpl: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  scheduleStaleRuntimeCleanup({ runtimeId: 'claude', sessionName: 'claude-main' }, f.options);
  scheduleStaleRuntimeCleanup({ runtimeId: 'claude', sessionName: 'claude-main' }, { ...f.options, zylosDir: path.join(f.root, 'missing') });
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.calls.length, 0);
});

test('broken instances config symlink is protected instead of mistaken for single-session', (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'unavailable-config'), path.join(f.root, 'instances.json'));
  scheduleStaleRuntimeCleanup({ runtimeId: 'claude', sessionName: 'claude-main' }, f.options);
  assert.equal(f.callbacks.length, 0);
});

test('active stable names and custom persona names are never legacy cleanup candidates', (t) => {
  const f = fixture(t);
  for (const name of ['claude-main', 'claude-group', 'my-agent']) {
    scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: name }, f.options);
  }
  assert.equal(f.callbacks.length, 0);
  assert.equal(f.calls.length, 0);
});

test('verified legacy single-session install retains its distinct stale-session cleanup', (t) => {
  const f = fixture(t);
  scheduleStaleRuntimeCleanup({ runtimeId: 'claude', sessionName: 'claude-main' }, f.options);
  assert.equal(f.callbacks.length, 1);
  f.callbacks[0]();
  assert.deepEqual(f.calls, [['tmux', 'kill-session', '-t', 'codex-main']]);
});

test('transition to multi-instance during the grace period cancels the pending cleanup', (t) => {
  const f = fixture(t);
  scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: 'codex-main' }, f.options);
  assert.equal(f.callbacks.length, 1);
  fs.writeFileSync(path.join(f.root, 'instances.json'), '{}');
  f.callbacks[0]();
  assert.equal(f.calls.length, 0);
});
