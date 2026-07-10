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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-disp-multi-'));
process.env.ZYLOS_DIR = tmpDir;
delete process.env.ZYLOS_INSTANCE_ID;
// The keystroke test imports c4-dispatcher.js for its pure helpers — without
// this the import auto-starts the live dispatcher loop inside the test process
// (which then never exits).
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
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
  it('routes a legacy NULL-target conversation to the primary instance (never dropped)', () => {
    // getNextPendingForInstances deliberately surfaces NULL-target legacy rows;
    // rejecting them here (the old behavior) silently dropped them permanently.
    const r = disp.multiSessionDispatch({ target_instance: null, type: 'conversation' }, helpers());
    assert.equal(r.action, 'deliver');
    assert.equal(r.session, 'claude-admin'); // primary
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
  function baseHelpers({ item, notifyCalls, sendResult = 'submitted', overrides = {} }) {
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
      ...overrides,
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

  it('delivers [KEYSTROKE] controls as raw keys to the per-instance session, never pasted text', async () => {
    const notifyCalls = [];
    const keystrokes = [];
    const acked = [];
    const pastes = [];
    const item = {
      id: 8, type: 'control', priority: 0, bypass_state: 0,
      target_instance: 'user-betty', content: '[KEYSTROKE] Enter',
    };
    const { isKeystrokeControl, parseKeystrokeKey } = await import('../c4-dispatcher.js');
    const res = await disp.processWithMultiSession(baseHelpers({
      item, notifyCalls,
      overrides: {
        isKeystrokeControl, parseKeystrokeKey,
        sendKeystroke: (session, key) => keystrokes.push({ session, key }),
        sendToTmux: async (msg) => { pastes.push(msg); return 'submitted'; },
        ackControl: (id) => acked.push(id),
      },
    }));
    assert.equal(res.delivered, true);
    assert.deepEqual(keystrokes, [{ session: 'claude-betty', key: 'Enter' }]);
    assert.deepEqual(acked, [8]);
    assert.equal(pastes.length, 0, 'keystroke must never be buffer-pasted as text');
  });

  it('holds (not spin-requeues) a suspended instance item and still delivers to a healthy instance', async () => {
    // Item 1 targets a suspended instance, item 2 a healthy one. The suspended
    // item must be HELD for the cycle (released at the end), and the healthy
    // item must still be delivered within the same cycle — the old immediate
    // requeue let claimNextItem spin on item 1 for all MAX_SKIP_ATTEMPTS.
    const notifyCalls = [];
    const released = [];
    const claims = [];
    const suspended = { id: 1, type: 'conversation', channel: 'feishu', target_instance: 'user-betty', content: 'a', endpoint_id: 'oc_A' };
    const healthy = { id: 2, type: 'conversation', channel: 'feishu', target_instance: 'admin', content: 'b', endpoint_id: 'oc_B' };
    const queue = [suspended, healthy];
    const res = await disp.processWithMultiSession(baseHelpers({
      item: null, notifyCalls,
      overrides: {
        // betty suspended, admin healthy — keyed off the status file path.
        getAgentState: (f) => (String(f).includes('user-betty')
          ? { state: 'suspended', health: 'ok', idleSeconds: 0 }
          : { state: 'active', health: 'ok', idleSeconds: 0 }),
        claimNextItem: () => { const it = queue.shift() || null; if (it) claims.push(it.id); return it; },
        releaseItem: (it) => released.push(it.id),
      },
    }));
    assert.equal(res.delivered, true);
    assert.deepEqual(claims, [1, 2], 'each item claimed exactly once — no spin on the suspended item');
    assert.deepEqual(released, [1], 'suspended item released back at cycle end');
  });

  it('signals legacy mode with legacy:true instead of a plain not-delivered result', () => {
    // instance-config captures ZYLOS_DIR at import, so legacy mode (no
    // instances.json) needs a fresh subprocess pointed at an empty dir.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-legacy-'));
    try {
      const moduleUrl = pathToFileURL(path.resolve('skills/comm-bridge/scripts/c4-dispatcher-multi.js')).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(moduleUrl)});
        const res = await m.processWithMultiSession({ getAgentState: () => ({ state: 'active', health: 'ok' }) });
        console.log(JSON.stringify(res));
      `], { env: { ...process.env, ZYLOS_DIR: legacyDir }, encoding: 'utf8', cwd: path.resolve('.') });
      const res = JSON.parse(out.trim().split('\n').pop());
      assert.equal(res.legacy, true);
      assert.equal(res.delivered, false);
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
