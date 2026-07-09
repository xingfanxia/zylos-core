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

describe('processWithMultiSession — per-instance delivery notify', () => {
  // Minimal helper set that drives one claimed item all the way to delivery.
  function baseHelpers({ item, notifyCalls, sendResult = 'submitted' }) {
    let claimed = false;
    return {
      getAgentState: () => ({ state: 'active', health: 'ok', idleSeconds: 0 }),
      isStatusFresh: () => true,
      sendToTmux: async () => sendResult,
      claimNextItem: () => { if (claimed) return null; claimed = true; return item; },
      releaseItem: () => {},
      isBypassState: () => false,
      shouldAutoAckHeartbeat: () => false,
      handleConversationDeliveryFailure: async () => {},
      handleControlDeliveryFailure: async () => {},
      waitForRequireIdleSettlement: async () => {},
      markDelivered: () => {},
      ackControl: () => {},
      readProcState: () => ({ alive: true }),
      isAgentConfirmedActive: () => false,
      log: () => {},
      sleep: async () => {},
      nowSeconds: () => 0,
      getDeliveryContent: (i) => i.content,
      markRejected: () => {},
      markControlRejected: () => {},
      getNextPendingForInstances: () => null,
      getPendingTargetInstancesNeedingWake: () => [],
      getNextPendingControlForInstances: () => null,
      notifyMessageDelivered: (arg) => { notifyCalls.push(arg); return Promise.resolve(); },
    };
  }

  it('fires notifyMessageDelivered to the target instance am.sock after a conversation delivery', async () => {
    const notifyCalls = [];
    const item = {
      id: 42, type: 'conversation', channel: 'feishu',
      target_instance: 'user-betty', content: 'hi', endpoint_id: 'oc_A|type:group',
    };
    const res = await disp.processWithMultiSession(baseHelpers({ item, notifyCalls }));
    assert.equal(res.delivered, true);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].conversationId, 42);
    assert.equal(notifyCalls[0].channel, 'feishu');
    // Must target THIS instance's socket, not the global default.
    assert.ok(notifyCalls[0].socketPath.includes('user-betty'), notifyCalls[0].socketPath);
    assert.ok(notifyCalls[0].socketPath.endsWith('am.sock'), notifyCalls[0].socketPath);
  });

  it('does NOT notify for control-item deliveries (no user reply to health-check)', async () => {
    const notifyCalls = [];
    const item = {
      id: 7, type: 'control', priority: 2, target_instance: 'user-betty', content: '/status',
    };
    await disp.processWithMultiSession(baseHelpers({ item, notifyCalls }));
    assert.equal(notifyCalls.length, 0);
  });

  it('does NOT notify when delivery is not submitted', async () => {
    const notifyCalls = [];
    const item = {
      id: 43, type: 'conversation', channel: 'feishu',
      target_instance: 'user-betty', content: 'hi', endpoint_id: 'oc_A|type:group',
    };
    await disp.processWithMultiSession(baseHelpers({ item, notifyCalls, sendResult: 'verify_failed' }));
    assert.equal(notifyCalls.length, 0);
  });
});
