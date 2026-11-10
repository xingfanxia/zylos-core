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
const { sendToTmux, submitAndVerify, keystrokeBlockedByModal, isKeystrokeControl, parseKeystrokeKey, fenceKeystrokeControl } = dispatcher;
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
const { detectModal } = await import('../tmux-input-state.js');
const fx = await import('./fixtures/claude-dialogs.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const LIMIT = { kind: 'fable_limit', text: "You've reached your Fable limit" };
const st = (inputState, extra = {}) => ({ inputState, paneIdentity: 'pane-one', inProgressCapture: false,
  usageOverlay: false, modal: null, ...extra });
const modal = (extra = {}) => st('indeterminate', { modal: LIMIT, ...extra });
// A non-limit dialog (e.g. a permission prompt or a future CLI dialog).
const otherModal = (extra = {}) => st('indeterminate', { modal: { kind: 'unknown', text: 'Something new' }, ...extra });

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
    h.useStates([st('empty'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('withholds the first Enter when the modal opens between paste and Enter', async () => {
    // initial, then the read that decides the first Enter (right after the
    // paste, no tmux call in between) shows the dialog
    const h = harness([st('empty'), modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 0);
    // Dialog dismissed, the composer shows the owned text again: Enter once, no second paste.
    h.useStates([st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('withholds a retried Enter when the modal opens after the first Enter', async () => {
    // the read after the first Enter (the one that would decide a retry) shows a dialog
    const h = harness([st('empty'), st('has_content'), otherModal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    assert.equal(h.enters(), 1);
    h.useStates([st('has_content'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 2);
  });

  it('re-pastes once when the modal swallowed the paste (no Enter was ever sent)', async () => {
    const h = harness([st('empty'), modal()]);
    assert.equal(await sendToTmux('hello', h.options), 'modal_deferred');
    h.useStates([st('empty'), st('empty'), st('has_content'), st('empty')]);
    assert.equal(await sendToTmux('hello', h.options), 'submitted');
    assert.equal(h.pastes(), 2);
    assert.equal(h.enters(), 1);
  });

  it('carries a held-back message into the replacement pane after a guard restart', async () => {
    const h = harness([st('empty'), modal()]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:7' }), 'modal_deferred');
    const two = { paneIdentity: 'pane-two' };
    h.useStates([st('empty', two), st('has_content', two), st('empty', two)]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:7' }), 'submitted');
    assert.equal(h.pastes(), 2, 'one paste per pane');
    assert.equal(h.enters(), 1, 'Enter only in the replacement pane');
    assert.equal(h.options.submissionReceipts.size, 0, 'no stale verify_failed receipt');
  });

  it('never replays into a replacement pane once Enter was sent (no duplicate execution)', async () => {
    const h = harness([st('empty'), st('has_content'), otherModal()]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:8' }), 'modal_deferred');
    h.useStates([st('empty', { paneIdentity: 'pane-two' })]);
    assert.equal(await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:8' }), 'verify_failed');
    assert.equal(h.pastes(), 1);
    assert.equal(h.enters(), 1);
  });

  it('defers another row too, without pasting over the held-back text', async () => {
    const h = harness([st('empty'), modal()]);
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

  it('the permission exception holds for every permission variant and never for a limit dialog (Astra #5)', () => {
    for (const capture of [fx.PERMISSION_PROMPT_LIVE, fx.PERMISSION_ECHO_LIMIT, fx.PERMISSION_DIFF_LIMIT, fx.TOOL_OUTPUT_ABOVE_PERMISSION]) {
      assert.equal(keystrokeBlockedByModal(detectModal(capture)), false);
    }
    for (const capture of [fx.FABLE_LIMIT_LIVE, fx.FABLE_LIMIT_ABOVE_COMPOSER, fx.CREDITS_OFFER_LIVE, fx.CREDITS_CHECKING_LIVE,
      fx.ASK_QUESTION_LIMIT, fx.TOOL_OUTPUT_ABOVE_SELECT, fx.UNKNOWN_DIALOG_LIVE]) {
      assert.equal(keystrokeBlockedByModal(detectModal(capture)), true);
    }
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

const paneTarget = (modal, sessionRef = '$1:1000:%2:123') => ({ ok: true, sessionRef, modal, sessionCreatedAt: 1000 });
const noBinding = () => ({ sessionRef: null, stamped: false });

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
    isKeystrokeControl, parseKeystrokeKey,
    readKeystrokeTarget: () => paneTarget(null),
    fenceKeystrokeControl: (item, target) => fenceKeystrokeControl(item, target, { bind: noBinding }),
    supersedeControl: () => true,
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

    h.useStates([st('empty'), st('has_content'), st('empty')]);
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
      readKeystrokeTarget: () => paneTarget(screenModal),
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
      readKeystrokeTarget: () => paneTarget({ kind: 'permission', text: 'Bash command' }),
      sendKeystroke: (session, key) => keys.push(key),
    }));
    assert.equal(res.delivered, true);
    assert.deepEqual(keys, ['Enter']);
  });
});

// ── A: every Enter is bound to the pasted pane (Astra #5) ──────────────────
// Invariant checked on the interleaved log of reads and tmux calls: each
// Enter directly follows (no other tmux call, no await in between) a read that
// succeeded, shows the pane the text was pasted into, and shows no modal.
function boundHarness(states) {
  let i = 0;
  const events = [];
  const options = { session: 'claude-user-pan', pendingSubmissions: new Map(), submissionReceipts: new Map(),
    sleepImpl: async () => { events.push({ sleep: true }); },
    readInputStateImpl: () => { const s = states[Math.min(i++, states.length - 1)]; events.push({ read: s }); return s; },
    execFileSyncImpl: (command, args) => { events.push({ exec: args }); return ''; } };
  return { options, events, useStates: (next) => { states = next; i = 0; },
    enters: () => events.filter((e) => e.exec && e.exec[0] === 'send-keys').length };
}

function enterViolations(events) {
  const violations = [];
  let bound = null;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.exec?.[0] === 'paste-buffer') {
      const lastRead = [...events.slice(0, k)].reverse().find((x) => x.read);
      bound = lastRead?.read.paneIdentity ?? null;
    }
    if (e.exec?.[0] === 'send-keys') {
      // the read directly before, skipping only same-tick non-tmux bookkeeping
      const prev = events[k - 1];
      const s = prev?.read;
      if (!s) violations.push({ at: k, why: 'Enter not directly preceded by a read' });
      else if (s.captureOk === false) violations.push({ at: k, why: 'Enter after a failed capture' });
      else if (s.paneIdentity !== bound) violations.push({ at: k, why: `Enter after a read of ${s.paneIdentity}, pasted into ${bound}` });
      else if (s.modal) violations.push({ at: k, why: 'Enter after a read showing a modal' });
    }
  }
  return violations;
}

const two = { paneIdentity: 'pane-two' };
const failedCapture = { inputState: 'indeterminate', paneIdentity: null, captureOk: false, inProgressCapture: false,
  usageOverlay: false, modal: null, promptVisible: false };

describe('Enter is bound to the pasted pane (Astra #5)', () => {
  it('reviewer case: the pane is replaced between the observed paste and Enter -> no Enter into the replacement', async () => {
    const h = boundHarness([st('empty'), st('has_content'), st('empty', two), st('empty', two)]);
    const result = await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:31' });
    assert.deepEqual(enterViolations(h.events), []);
    assert.notEqual(result, 'submitted');
  });

  it('a failed capture right before Enter means no Enter', async () => {
    const h = boundHarness([st('empty'), st('has_content'), failedCapture, failedCapture]);
    await sendToTmux('hello', { ...h.options, deliveryId: 'conversation:32' });
    assert.deepEqual(enterViolations(h.events), []);
  });

  it('resumed submission (observed, Enter not yet sent): a failed capture or a replacement pane gets no Enter', async () => {
    for (const bad of [failedCapture, st('has_content', two)]) {
      const calls = [];
      const pending = { deliveryId: 'conversation:33', paneIdentity: 'pane-one', observed: true, enterSent: false };
      const result = await submitAndVerify('claude-user-pan', { pending, readState: () => bad, sleepImpl: async () => {},
        logImpl: () => {}, execFileSyncImpl: (command, args) => { calls.push(args); return ''; } });
      assert.deepEqual(calls, [], `no tmux key for ${JSON.stringify(bad)}`);
      assert.equal(result.verified, false);
      assert.equal(pending.enterSent, false);
    }
  });

  it('holds for a replacement or a failed capture injected at every read of a delivery and its retry', async () => {
    const good = [st('empty'), st('has_content'), st('has_content'), st('has_content'), st('empty')];
    for (let pos = 0; pos < good.length; pos++) {
      for (const bad of [st('has_content', two), st('empty', two), failedCapture]) {
        const states = good.slice();
        states[pos] = bad;
        const h = boundHarness(states);
        const options = { ...h.options, deliveryId: `conversation:${40 + pos}` };
        await sendToTmux('hello', options);
        await sendToTmux('hello', options);
        assert.deepEqual(enterViolations(h.events), [], `bad read at position ${pos}: ${JSON.stringify(bad)}`);
      }
    }
  });
});

// ── D: with no modal on screen, delivery is byte-for-byte base ─────────────
// fixtures/base-delivery-calls.d16221a.json was recorded by running the same
// scenario drivers (fixtures/tmux-pane-model.js) against the base commit
// d16221a4 (before the Fable guard). The check covers the whole tmux call
// sequence, reads included; only the per-process buffer name is normalized.
describe('no modal on screen: tmux calls identical to base d16221a4 (Astra #5, scope)', async () => {
  const model = await import('./fixtures/tmux-pane-model.js');
  const base = JSON.parse(fs.readFileSync(new URL('./fixtures/base-delivery-calls.d16221a.json', import.meta.url), 'utf8'));

  for (const [name, scenario] of Object.entries(model.DELIVERY_SCENARIOS)) {
    it(`single-session sendToTmux: ${name}`, async () => {
      assert.ok(base.single[name], `base recording has scenario ${name}`);
      assert.deepEqual(await model.runSingleScenario(sendToTmux, scenario), base.single[name]);
    });
  }

  it('multi-session dispatcher: conversation delivery', async () => {
    assert.deepEqual(await model.runMultiConversation(sendToTmux, processWithMultiSession), base.multi.conversation);
  });

  it('multi-session dispatcher: a raw key is the base key call, preceded by one pane read', async () => {
    const got = await model.runMultiKeystroke(dispatcher, processWithMultiSession);
    const isRead = (call) => call[1] === 'capture-pane';
    assert.equal(got.delivered, true);
    assert.deepEqual(got.calls.filter((call) => !isRead(call)), base.multi.keystroke.calls);
    assert.deepEqual(got.calls.map(isRead), [true, false]);
  });
});
