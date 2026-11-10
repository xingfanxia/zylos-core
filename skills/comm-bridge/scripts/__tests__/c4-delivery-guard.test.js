// FG-5 delivery guard: while a modal owns the keyboard the dispatcher pastes
// nothing and sends no Enter or raw key; the row is deferred (no retry
// consumed, never recorded delivered) and delivered once the modal is gone or
// the session was replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-guard-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
const stateDir = (id) => path.join(root, 'state', id);
for (const id of ['admin', 'user-pan']) fs.mkdirSync(stateDir(id), { recursive: true });
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ version: 1, instances: {
  admin: { primary: true, enabled: true, runtime: 'claude', tmux_session: 'claude-admin', state_dir: stateDir('admin') },
  'user-pan': { primary: false, enabled: true, runtime: 'claude', tmux_session: 'claude-user-pan', state_dir: stateDir('user-pan') },
} }));

const dispatcher = await import('../c4-dispatcher.js');
const { sendToTmux, keystrokeBlockedByModal, isKeystrokeControl, parseKeystrokeKey } = dispatcher;
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const LIMIT = { kind: 'fable_limit', text: "You've reached your Fable limit" };
const st = (inputState, extra = {}) => ({ inputState, paneIdentity: 'pane-one', inProgressCapture: false,
  usageOverlay: false, modal: null, ...extra });
const modal = (extra = {}) => st('indeterminate', { modal: LIMIT, ...extra });

function harness(states) {
  let i = 0;
  const calls = [];
  const options = { session: 'claude-user-pan', pendingSubmissions: new Map(), submissionReceipts: new Map(),
    sleepImpl: async () => {},
    readInputStateImpl: () => states[Math.min(i++, states.length - 1)],
    execFileSyncImpl: (command, args) => { calls.push(args); return ''; } };
  return { options, calls,
    pastes: () => calls.filter((a) => a[0] === 'paste-buffer').length,
    enters: () => calls.filter((a) => a[0] === 'send-keys' && a.includes('Enter')).length,
    useStates: (next) => { states = next; i = 0; } };
}

describe('sendToTmux delivery guard', () => {
  it('pastes nothing and sends no Enter while a modal is on screen, then delivers once it is gone', async () => {
    const h = harness([modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    assert.equal(h.calls.length, 0);
    h.useStates([st('empty'), st('has_content'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('withholds the first Enter when the modal opens between paste and Enter', async () => {
    // initial, observed paste, then the frame read right before Enter shows the dialog
    const h = harness([st('empty'), st('has_content'), modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 0);
    // Dialog dismissed, the composer shows the owned text again: Enter once, no second paste.
    h.useStates([st('has_content'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('withholds a retried Enter when the modal opens after the first Enter', async () => {
    // first Enter did not take (composer still holds text); the pre-retry frame shows the dialog
    const h = harness([st('empty'), st('has_content'), st('has_content'), st('has_content'), modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    assert.equal(h.enters(), 1);
    h.useStates([st('has_content'), st('has_content'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 2);
  });

  it('re-pastes once when the modal swallowed the paste (no Enter was ever sent)', async () => {
    const h = harness([st('empty'), modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    h.useStates([st('empty'), st('empty'), st('has_content'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 2);
    assert.equal(h.enters(), 1);
  });

  it('carries a held-back message into the replacement pane after a guard restart', async () => {
    const h = harness([st('empty'), st('has_content'), modal()]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:7' }), 'modal_deferred');
    const two = { paneIdentity: 'pane-two' };
    h.useStates([st('empty', two), st('has_content', two), st('has_content', two), st('empty', two)]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:7' }), 'submitted');
    assert.equal(h.pastes(), 2, 'one paste per pane');
    assert.equal(h.enters(), 1, 'Enter only in the replacement pane');
    assert.equal(h.options.submissionReceipts.size, 0, 'no stale verify_failed receipt');
  });

  it('never replays into a replacement pane once Enter was sent (no duplicate execution)', async () => {
    const h = harness([st('empty'), st('has_content'), st('has_content'), st('has_content'), modal()]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:8' }), 'modal_deferred');
    h.useStates([st('empty', { paneIdentity: 'pane-two' })]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:8' }), 'verify_failed');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('defers another row too, without pasting over the held-back text', async () => {
    const h = harness([st('empty'), st('has_content'), modal()]);
    assert.equal(await sendToTmux('first', { ...h.options, deliveryId: 'conversation:1' }), 'modal_deferred');
    h.useStates([modal()]);
    assert.equal(await sendToTmux('second', { ...h.options, deliveryId: 'control:2' }), 'modal_deferred');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 0);
  });

  it('plain composer delivery is unchanged: one paste, one Enter, submitted', async () => {
    // A pane model (paste fills the composer, Enter clears it) rather than a
    // scripted frame list, so the check does not depend on how often it reads.
    let composer = 'empty';
    const calls = [];
    const options = { session: 'claude-user-pan', pendingSubmissions: new Map(), submissionReceipts: new Map(),
      sleepImpl: async () => {}, readInputStateImpl: () => st(composer),
      execFileSyncImpl: (command, args) => {
        calls.push(args);
        if (args[0] === 'paste-buffer') composer = 'has_content';
        if (args[0] === 'send-keys') composer = 'empty';
        return '';
      } };
    assert.equal(await sendToTmux('hello', options), 'submitted');
    assert.equal(calls.filter((a) => a[0] === 'paste-buffer').length, 1);
    assert.equal(calls.filter((a) => a[0] === 'send-keys').length, 1);
  });
});

describe('keystroke policy', () => {
  it('blocks raw keys for any modal except a permission prompt', () => {
    assert.equal(keystrokeBlockedByModal(null), false);
    assert.equal(keystrokeBlockedByModal(LIMIT), true);
    assert.equal(keystrokeBlockedByModal({ kind: 'credits_offer', text: '' }), true);
    assert.equal(keystrokeBlockedByModal({ kind: 'unknown', text: '' }), true);
    assert.equal(keystrokeBlockedByModal({ kind: 'permission', text: '' }), false);
  });
});

// A tiny queue with the same row semantics the DB gives the dispatcher.
function rowQueue(rows) {
  const byId = new Map(rows.map((row) => [row.id, { ...row, status: 'pending', retry_count: 0 }]));
  const delivered = [];
  const acked = [];
  const notified = [];
  return {
    byId, delivered, acked, notified,
    claimNextItem: () => {
      const row = [...byId.values()].find((r) => r.status === 'pending');
      if (!row) return null;
      row.status = 'running';
      return { ...row };
    },
    releaseItem: (item) => { byId.get(item.id).status = 'pending'; },
    markDelivered: (id) => { byId.get(id).status = 'delivered'; delivered.push(id); },
    ackControl: (id) => { byId.get(id).status = 'done'; acked.push(id); },
    handleConversationDeliveryFailure: async (item) => { const r = byId.get(item.id); r.retry_count++; r.status = 'pending'; },
    handleControlDeliveryFailure: async (item) => { const r = byId.get(item.id); r.retry_count++; r.status = 'pending'; },
    notifyMessageDelivered: (arg) => { notified.push(arg.conversationId); return Promise.resolve(); },
  };
}

function multiHelpers(queue, overrides = {}) {
  return {
    getAgentState: () => ({ state: 'idle', health: 'ok', idleSeconds: 10, healthy: true }),
    isStatusFresh: () => true,
    isBypassState: (item) => item.type === 'control' && item.bypass_state === 1,
    shouldAutoAckHeartbeat: () => false,
    waitForRequireIdleSettlement: async () => {},
    readProcState: () => ({ alive: true }),
    isAgentConfirmedActive: () => false,
    log: () => {},
    sleep: async () => {},
    nowSeconds: () => 0,
    getDeliveryContent: (item) => item.content,
    markRejected: () => {},
    markControlRejected: () => {},
    getNextPendingForInstances: () => null,
    getPendingTargetInstancesNeedingWake: () => [],
    getNextPendingControlForInstances: () => null,
    isKeystrokeControl, parseKeystrokeKey, keystrokeBlockedByModal,
    readSessionModal: () => null,
    sendKeystroke: () => { throw new Error('unexpected keystroke'); },
    ...queue,
    ...overrides,
  };
}

describe('multi-session delivery guard', () => {
  it('holds a queued conversation while the limit dialog is up and delivers it exactly once afterwards', async () => {
    const queue = rowQueue([{ id: 42, type: 'conversation', channel: 'feishu', target_instance: 'user-pan', content: 'hi' }]);
    const h = harness([modal()]);
    const send = (message, opts) => sendToTmux(message, { ...h.options, ...opts });
    const helpers = multiHelpers(queue, { sendToTmux: send });

    for (let cycle = 0; cycle < 3; cycle++) {
      const res = await processWithMultiSession(helpers);
      assert.equal(res.delivered, false);
      assert.deepEqual(res.heldReasons, { modal: 1 });
    }
    const row = queue.byId.get(42);
    assert.equal(row.status, 'pending', 'released back to pending, never lost');
    assert.equal(row.retry_count, 0, 'deferral consumes no retries');
    assert.deepEqual(queue.delivered, []);
    assert.deepEqual(queue.notified, [], 'no delivery notification (no false ACK path)');
    assert.equal(h.calls.length, 0);

    h.useStates([st('empty'), st('has_content'), st('has_content'), st('empty')]);
    const res = await processWithMultiSession(helpers);
    assert.equal(res.delivered, true);
    assert.deepEqual(queue.delivered, [42]);
    assert.deepEqual(queue.notified, [42]);
    assert.equal(await processWithMultiSession(helpers).then((r) => r.delivered), false, 'nothing left to deliver');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('keeps serving other instances while one instance is held by a modal', async () => {
    const queue = rowQueue([
      { id: 1, type: 'conversation', channel: 'feishu', target_instance: 'user-pan', content: 'to pan' },
      { id: 2, type: 'conversation', channel: 'feishu', target_instance: 'admin', content: 'to admin' },
    ]);
    const send = async (message, opts) => (opts.session === 'claude-user-pan' ? 'modal_deferred' : 'submitted');
    const res = await processWithMultiSession(multiHelpers(queue, { sendToTmux: send }));
    assert.equal(res.delivered, true);
    assert.deepEqual(queue.delivered, [2]);
    assert.equal(queue.byId.get(1).status, 'pending');
    assert.equal(queue.byId.get(1).retry_count, 0);
  });

  it('holds raw keys on the multi-session path while a modal is up', async () => {
    const queue = rowQueue([{ id: 8, type: 'control', priority: 0, bypass_state: 1, target_instance: 'user-pan', content: '[KEYSTROKE]Escape' }]);
    const keys = [];
    let screenModal = LIMIT;
    const helpers = multiHelpers(queue, {
      readSessionModal: () => screenModal,
      sendKeystroke: (session, key) => keys.push({ session, key }),
      sendToTmux: async () => { throw new Error('keystroke must never be pasted'); },
    });
    const held = await processWithMultiSession(helpers);
    assert.equal(held.delivered, false);
    assert.deepEqual(held.heldReasons, { modal: 1 });
    assert.deepEqual(keys, []);
    assert.equal(queue.byId.get(8).retry_count, 0);
    assert.deepEqual(queue.acked, []);

    screenModal = null;
    const sent = await processWithMultiSession(helpers);
    assert.equal(sent.delivered, true);
    assert.deepEqual(keys, [{ session: 'claude-user-pan', key: 'Escape' }]);
    assert.deepEqual(queue.acked, [8]);
  });

  it('still lets the auto-approve Enter answer a permission prompt', async () => {
    const queue = rowQueue([{ id: 9, type: 'control', priority: 0, bypass_state: 1, target_instance: 'user-pan', content: '[KEYSTROKE]Enter' }]);
    const keys = [];
    const res = await processWithMultiSession(multiHelpers(queue, {
      readSessionModal: () => ({ kind: 'permission', text: 'Bash command' }),
      sendKeystroke: (session, key) => keys.push(key),
    }));
    assert.equal(res.delivered, true);
    assert.deepEqual(keys, ['Enter']);
  });
});
