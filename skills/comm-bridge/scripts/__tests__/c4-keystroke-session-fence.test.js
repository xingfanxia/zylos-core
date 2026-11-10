// [KEYSTROKE] session fence on the multi-session path, against the real C4 DB
// and the dispatcher's own claim/release/ack helpers (Astra #5): an
// --apply-style restart interleaved with pending and already-claimed keys.
// Only the pane reader and the key sender are fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-key-fence-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
for (const id of ['admin', 'user-pan']) fs.mkdirSync(path.join(root, 'state', id), { recursive: true });
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ version: 1, instances: {
  admin: { primary: true, enabled: true, runtime: 'claude', tmux_session: 'claude-admin', state_dir: path.join(root, 'state', 'admin') },
  'user-pan': { primary: false, enabled: true, runtime: 'claude', tmux_session: 'claude-user-pan', state_dir: path.join(root, 'state', 'user-pan') },
} }));

const dispatcher = await import('../c4-dispatcher.js');
const db = await import('../c4-db.js');
const multiDb = await import('../c4-db-multi.js');
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const now = Math.floor(Date.now() / 1000);
const A = `$5:${now - 100}:%7:111`;
const B = `$6:${now - 1}:%8:222`;
const UNKNOWN = { kind: 'unknown', text: 'Something new' };

const panes = { 'claude-user-pan': { sessionRef: A, modal: null } };
const sent = [];
let afterRead = null; // runs right after a pane read (a session replaced in between)
const helpers = {
  getAgentState: () => ({ state: 'idle', health: 'ok', idleSeconds: 30, healthy: true }),
  isStatusFresh: () => true, isAgentStatusFresh: () => true,
  isBypassState: dispatcher.isBypassState, shouldAutoAckHeartbeat: () => false,
  claimNextItem: dispatcher.claimNextItem, releaseItem: dispatcher.releaseItem, ackControl: dispatcher.ackControl,
  handleControlDeliveryFailure: dispatcher.handleControlDeliveryFailure,
  handleConversationDeliveryFailure: dispatcher.handleConversationDeliveryFailure,
  waitForRequireIdleSettlement: async () => {}, readProcState: () => ({ alive: true }), isAgentConfirmedActive: () => false,
  markDelivered: () => {}, log: () => {}, sleep: async () => {}, nowSeconds: () => now,
  getDeliveryContent: dispatcher.getDeliveryContent,
  isKeystrokeControl: dispatcher.isKeystrokeControl, parseKeystrokeKey: dispatcher.parseKeystrokeKey,
  getNextPendingForInstances: multiDb.getNextPendingForInstances,
  getPendingTargetInstancesNeedingWake: multiDb.getPendingTargetInstancesNeedingWake,
  getNextPendingControlForInstances: multiDb.getNextPendingControlForInstances,
  markRejected: multiDb.markRejected, markControlRejected: multiDb.markControlRejected,
  sendToTmux: async () => { throw new Error('keys are never pasted'); },
  // production wiring: c4-dispatcher.js passes these three
  readKeystrokeTarget: (session) => {
    const pane = panes[session];
    const target = { ok: true, sessionRef: pane.sessionRef, modal: pane.modal, sessionCreatedAt: Number(pane.sessionRef.split(':')[1]) };
    afterRead?.();
    return target;
  },
  fenceKeystrokeControl: dispatcher.fenceKeystrokeControl,
  supersedeControl: db.supersedeControl,
  // The dispatcher sends to the pane id of its read; record it with the pane that owns the name.
  sendKeystroke: (target, key) => sent.push({ target, key, pane: panes['claude-user-pan'].sessionRef }),
};
const row = (id) => db.getDb().prepare('SELECT status, last_error, session_ref FROM control_queue WHERE id = ?').get(id);
const enqueue = (key, extra = {}) => db.insertControl(`[KEYSTROKE]${key}`,
  { priority: 0, bypassState: true, appendAckSuffix: false, targetInstance: 'user-pan', ...extra });
async function drain() { for (let i = 0; i < 6; i++) await processWithMultiSession(helpers); }

describe('multi-session: --apply restart interleaved with claimed keys', () => {
  it('no key of the old session reaches the replacement; the replacement keeps its own keys', async () => {
    // 1. Old session A shows a dialog: an unbound watchdog key is claimed, bound to A and held.
    panes['claude-user-pan'] = { sessionRef: A, modal: UNKNOWN };
    const watchdog = enqueue('Escape');
    await processWithMultiSession(helpers);
    assert.deepEqual(sent, []);
    assert.equal(row(watchdog.id).status, 'pending');
    assert.equal(row(watchdog.id).session_ref, A);

    // 2. A hook of session A queues a bound key; another dispatcher pass has already claimed it.
    const hookKey = enqueue('Enter', { sessionRef: A });
    assert.equal(db.claimControl(hookKey.id), true);

    // 3. --apply restart: the monitor fences the old session before relaunch.
    assert.deepEqual(db.supersedeControlsForSession({ instanceId: 'user-pan', sessionRef: A, reason: 'FABLE_GUARD_RELAUNCH' }),
      { superseded: 2 });

    // 4. Replacement session B is up and idle; it queues its own key. A late
    //    hook of A still queues one, and an unbound key from before B started is left over.
    panes['claude-user-pan'] = { sessionRef: B, modal: null };
    const replacementKey = enqueue('Escape', { sessionRef: B });
    const lateOld = enqueue('Tab', { sessionRef: A });
    const leftover = enqueue('Up');
    db.getDb().prepare('UPDATE control_queue SET created_at = ? WHERE id = ?').run(now - 50, leftover.id);

    // 5. A repeated fence for A never touches B's key; the claimed old key's
    //    own dispatcher pass releasing it cannot requeue it.
    assert.deepEqual(db.supersedeControlsForSession({ instanceId: 'user-pan', sessionRef: A, reason: 'FABLE_GUARD_RELAUNCH' }),
      { superseded: 1 }); // lateOld only
    dispatcher.releaseItem({ id: hookKey.id, type: 'control' }, 'MODAL_DEFERRED');

    await drain();
    assert.deepEqual(sent, [{ target: '%8', key: 'Escape', pane: B }]);
    assert.equal(row(replacementKey.id).status, 'done');
    for (const id of [watchdog.id, hookKey.id, lateOld.id]) assert.equal(row(id).status, 'superseded');
    assert.deepEqual(row(leftover.id), { status: 'superseded', last_error: 'SESSION_PREDATES', session_ref: B });
  });

  it('a key bound to A that escaped the fence is superseded at claim, not sent to B', async () => {
    sent.length = 0;
    panes['claude-user-pan'] = { sessionRef: B, modal: null };
    const stray = enqueue('PageUp', { sessionRef: A });
    await drain();
    assert.deepEqual(sent, []);
    assert.deepEqual(row(stray.id), { status: 'superseded', last_error: 'SESSION_REPLACED', session_ref: A });
  });
});

describe('multi-session: the key goes to the pane id the deciding read saw (finding 5)', () => {
  it('a session replaced between the read and the key: the key targets the old pane, the replacement gets nothing', async () => {
    sent.length = 0;
    panes['claude-user-pan'] = { sessionRef: A, modal: null };
    // A real tmux send to a pane id that no longer exists fails; the name would resolve to B.
    const real = helpers.sendKeystroke;
    const targets = [];
    helpers.sendKeystroke = (target, key) => {
      targets.push(target);
      const owner = panes['claude-user-pan'].sessionRef;
      if (target.startsWith('%') && target !== owner.split(':')[2]) throw new Error(`can't find pane: ${target}`);
      sent.push({ key, pane: owner });
    };
    afterRead = () => { panes['claude-user-pan'] = { sessionRef: B, modal: null }; afterRead = null; };
    try {
      const key = enqueue('Escape');
      await processWithMultiSession(helpers);
      assert.deepEqual(targets, ['%7'], 'the key names pane %7 of the read, not the session name');
      assert.deepEqual(sent, [], 'nothing reaches the replacement session');
      assert.notEqual(row(key.id).status, 'done', 'a failed send is not a delivery');
      db.getDb().prepare("UPDATE control_queue SET status = 'failed' WHERE id = ?").run(key.id);
    } finally {
      helpers.sendKeystroke = real;
      afterRead = null;
    }
  });
});

describe('same-second unbound keys (finding 5)', () => {
  it('an unbound key queued in the same second the replacement session was created is superseded', async () => {
    sent.length = 0;
    panes['claude-user-pan'] = { sessionRef: B, modal: null };
    const key = enqueue('Escape');
    db.getDb().prepare('UPDATE control_queue SET created_at = ? WHERE id = ?').run(Number(B.split(':')[1]), key.id);
    await drain();
    assert.deepEqual(sent, []);
    assert.deepEqual(row(key.id), { status: 'superseded', last_error: 'SESSION_PREDATES', session_ref: B });
  });

  it('fenceKeystrokeControl: created_at equal to session_created is ambiguous and fenced; a later second is delivered', () => {
    const target = { ok: true, sessionRef: B, modal: null, sessionCreatedAt: Number(B.split(':')[1]) };
    const bind = () => ({ sessionRef: B, stamped: true });
    assert.deepEqual(dispatcher.fenceKeystrokeControl({ id: 1, created_at: target.sessionCreatedAt }, target, { bind }),
      { action: 'supersede', reason: 'SESSION_PREDATES' });
    assert.deepEqual(dispatcher.fenceKeystrokeControl({ id: 2, created_at: target.sessionCreatedAt + 1 }, target, { bind }),
      { action: 'deliver' });
    // A key bound to this session at enqueue time is never fenced by the clock.
    assert.deepEqual(dispatcher.fenceKeystrokeControl({ id: 3, created_at: target.sessionCreatedAt },
      target, { bind: () => ({ sessionRef: B, stamped: false }) }), { action: 'deliver' });
  });
});
