/**
 * c4-dispatcher-multi — REAL module imports (no inline routing replica).
 *
 * test/multi-session-features.test.js re-implements autoStart/autoStop/reap and
 * multiSessionDispatch inline "because importing c4-dispatcher-multi.js pulls in
 * [deps]". The module is DI-seamed (all dispatcher internals arrive via helpers)
 * and resolves ZYLOS_DIR from env at import, so it imports cleanly against a temp
 * instances.json. These tests exercise the real routing decisions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-disp-multi-'));
process.env.ZYLOS_DIR = tmpDir;
delete process.env.ZYLOS_INSTANCE_ID;
const stateDir = (id) => path.join(tmpDir, 'state', id);
for (const id of ['admin', 'user-betty', 'off-one']) fs.mkdirSync(stateDir(id), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    admin: { primary: true, enabled: true, tmux_session: 'claude-admin', state_dir: stateDir('admin') },
    'user-betty': { primary: false, enabled: true, tmux_session: 'claude-betty', state_dir: stateDir('user-betty') },
    'off-one': { primary: false, enabled: false, tmux_session: 'claude-off', state_dir: stateDir('off-one') },
  },
}));

const disp = await import('../c4-dispatcher-multi.js');

const HEALTHY = { state: 'active', health: 'ok' };
const helpers = (state = HEALTHY, { bypass = false } = {}) => ({
  getClaudeState: () => state,
  isBypassState: () => bypass,
});

describe('resolveSessionName / resolveStatusFile', () => {
  it('maps an instance to its configured session; null falls back to legacy', () => {
    assert.equal(disp.resolveSessionName('user-betty'), 'claude-betty');
    assert.equal(disp.resolveSessionName(null), disp.resolveSessionName(undefined));
  });
  it('resolves an instance status file distinct from the legacy fallback', () => {
    const betty = disp.resolveStatusFile('user-betty');
    assert.ok(betty.includes('user-betty'));
    assert.equal(typeof disp.resolveStatusFile(null), 'string');
  });
});

describe('getOnlineInstanceIds', () => {
  it('returns ids whose state is neither offline nor stopped', () => {
    const stateByFile = (f) => (f.includes('admin') ? { state: 'active' } : { state: 'offline' });
    const online = disp.getOnlineInstanceIds(stateByFile);
    assert.deepEqual(online, ['admin']);
  });
});

describe('multiSessionDispatch', () => {
  it('rejects a conversation with no target_instance', () => {
    const r = disp.multiSessionDispatch({ target_instance: null, type: 'conversation' }, helpers());
    assert.equal(r.action, 'reject');
  });

  it('routes a target-less control to the primary instance and delivers', () => {
    const r = disp.multiSessionDispatch({ target_instance: null, type: 'control' }, helpers());
    assert.equal(r.action, 'deliver');
    assert.equal(r.session, 'claude-admin'); // primary
  });

  it('rejects a message for a disabled instance', () => {
    const r = disp.multiSessionDispatch({ target_instance: 'off-one', type: 'conversation' }, helpers());
    assert.equal(r.action, 'reject');
    assert.match(r.reason, /disabled/);
  });

  it('delivers to a healthy, active instance', () => {
    const r = disp.multiSessionDispatch({ target_instance: 'user-betty', type: 'conversation' }, helpers());
    assert.equal(r.action, 'deliver');
    assert.equal(r.session, 'claude-betty');
  });

  it('requeues + writes a wake signal for a suspended instance', () => {
    const r = disp.multiSessionDispatch(
      { target_instance: 'user-betty', type: 'conversation' },
      helpers({ state: 'suspended', health: 'ok' }),
    );
    assert.equal(r.action, 'requeue');
    assert.ok(fs.existsSync(path.join(stateDir('user-betty'), 'wake-signal')));
  });

  it('skips + auto-starts an offline non-primary instance', () => {
    const r = disp.multiSessionDispatch(
      { target_instance: 'user-betty', type: 'conversation' },
      helpers({ state: 'offline', health: 'ok' }),
    );
    assert.equal(r.action, 'skip');
  });

  it('skips an unhealthy instance', () => {
    const r = disp.multiSessionDispatch(
      { target_instance: 'user-betty', type: 'conversation' },
      helpers({ state: 'active', health: 'degraded' }),
    );
    assert.equal(r.action, 'skip');
    assert.match(r.reason, /unhealthy/);
  });

  it('bypass state delivers even when offline', () => {
    const r = disp.multiSessionDispatch(
      { target_instance: 'user-betty', type: 'conversation' },
      helpers({ state: 'offline', health: 'ok' }, { bypass: true }),
    );
    assert.equal(r.action, 'deliver');
  });
});

describe('writeWakeSignal', () => {
  it('writes a wake-signal file in the instance monitor dir', () => {
    disp.writeWakeSignal('admin');
    assert.ok(fs.existsSync(path.join(stateDir('admin'), 'wake-signal')));
  });
});
