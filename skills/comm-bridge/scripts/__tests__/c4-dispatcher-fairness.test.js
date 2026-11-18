// Fair selection across personas (2026-11-18): user-pan's pane held a dialog
// for 4 h 48 min; its ten held rows used up every dispatcher pass
// (MAX_SKIP_ATTEMPTS, state=skip_exhausted) and user-elaine's rows, on a free
// session, stayed pending for 70 minutes. These tests run the real claim path:
// c4-db rows, c4-db-multi queries, c4-dispatcher claimNextItem / releaseItem /
// keystroke fence, and processWithMultiSession; only the pane is simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fairness-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });
fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
const stateDir = (id) => path.join(root, 'state', id);
const IDS = ['admin', 'user-pan', 'user-elaine'];
for (const id of IDS) fs.mkdirSync(stateDir(id), { recursive: true });
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ version: 1, instances: Object.fromEntries(IDS.map((id, i) => [id,
  { primary: i === 0, enabled: true, runtime: 'claude', tmux_session: `claude-${id}`, state_dir: stateDir(id) }])) }));

const dbMod = await import('../c4-db.js');
const dbMulti = await import('../c4-db-multi.js');
const dispatcher = await import('../c4-dispatcher.js');
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
const db = dbMod.getDb();
after(() => { try { dbMod.close(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => db.exec('DELETE FROM conversations; DELETE FROM control_queue;'));

function conversation(target, timestamp) {
  return Number(db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, priority, target_instance, timestamp)
    VALUES ('in', 'feishu', 'oc_x', 'm', 'pending', 3, ?, ?)`).run(target, timestamp).lastInsertRowid);
}
function control(target, content, { bypass = false, priority = 0, dialogRef = null } = {}) {
  return dbMod.insertControl(content, { priority, bypassState: bypass, appendAckSuffix: false, targetInstance: target, dialogRef }).id;
}
const conv = (id) => db.prepare('SELECT status, retry_count FROM conversations WHERE id = ?').get(id);
const ctl = (id) => db.prepare('SELECT status, last_error FROM control_queue WHERE id = ?').get(id);

const SESSION_REF = '$1:1000:%2:123';
const LIVE = { state: 'idle', health: 'ok', idleSeconds: 30, healthy: true };

// One simulated screen per persona: a modal or a free composer.
function pass(screens, { agentState = () => LIVE } = {}) {
  const pastes = [];
  const keys = [];
  const reads = [];
  const sessionModal = (session) => screens[session.replace(/^claude-/, '')] ?? null;
  const helpers = {
    getAgentState: (file) => agentState(IDS.find((id) => String(file).includes(id))),
    isStatusFresh: () => true,
    sendToTmux: async (message, opts) => {
      reads.push(opts.session);
      if (sessionModal(opts.session)) return 'modal_deferred';
      pastes.push({ session: opts.session, deliveryId: opts.deliveryId });
      return 'submitted';
    },
    claimNextItem: dispatcher.claimNextItem,
    releaseItem: dispatcher.releaseItem,
    isBypassState: dispatcher.isBypassState,
    shouldAutoAckHeartbeat: () => false,
    handleConversationDeliveryFailure: async () => { throw new Error('no delivery may fail here'); },
    handleControlDeliveryFailure: async () => { throw new Error('no delivery may fail here'); },
    handleContentFailure: async () => { throw new Error('content is always available here'); },
    waitForRequireIdleSettlement: async () => {},
    markDelivered: dbMod.markDelivered,
    ackControl: dbMod.ackControl,
    readProcState: () => ({ alive: true }),
    isAgentConfirmedActive: () => false,
    log: () => {},
    sleep: async () => {},
    nowSeconds: () => Math.floor(Date.now() / 1000),
    getDeliveryContent: (item) => item.content,
    markRejected: dbMulti.markRejected,
    markControlRejected: dbMulti.markControlRejected,
    getNextPendingForInstances: dbMulti.getNextPendingForInstances,
    getPendingTargetInstancesNeedingWake: () => [],
    getNextPendingControlForInstances: dbMulti.getNextPendingControlForInstances,
    notifyMessageDelivered: () => Promise.resolve(),
    sendKeystroke: (target, key) => keys.push({ target, key }),
    isKeystrokeControl: dispatcher.isKeystrokeControl,
    parseKeystrokeKey: dispatcher.parseKeystrokeKey,
    readKeystrokeTarget: (session) => ({ ok: true, sessionRef: SESSION_REF, modal: sessionModal(session), sessionCreatedAt: 1000 }),
    fenceKeystrokeControl: dispatcher.fenceKeystrokeControl,
    supersedeControl: dbMod.supersedeControl,
    isSessionEndingControl: dispatcher.isSessionEndingControl,
  };
  return processWithMultiSession(helpers).then((result) => ({ result, pastes, keys, reads }));
}

const UNKNOWN = { kind: 'unknown', text: 'Something new needs your answer' };
const { detectModal } = await import('../tmux-input-state.js');
const fx = await import('./fixtures/claude-dialogs.js');
// The incident prompt as the pane read classifies it (kind, title, notice, id).
const PROMPT = detectModal(fx.DANGEROUS_RM_PROMPT);

describe('fair selection across personas', () => {
  it('ten rows held behind one persona\'s dialog: a later row for another persona is delivered on the next pass', async () => {
    const pan = Array.from({ length: 10 }, (_, i) => conversation('user-pan', `2026-11-18 04:${String(20 + i).padStart(2, '0')}:00`));
    const { result: before } = await pass({ 'user-pan': UNKNOWN });
    assert.equal(before.delivered, false, 'nothing deliverable yet');
    const elaine = conversation('user-elaine', '2026-11-18 07:57:00');

    const { result, pastes, reads } = await pass({ 'user-pan': UNKNOWN });
    assert.equal(result.delivered, true);
    assert.deepEqual(pastes, [{ session: 'claude-user-elaine', deliveryId: `conversation:${elaine}` }]);
    assert.equal(reads.filter((s) => s === 'claude-user-pan').length, 1, 'one look at the held pane per pass, not one per held row');
    assert.equal(conv(elaine).status, 'delivered');
    for (const id of pan) assert.deepEqual(conv(id), { status: 'pending', retry_count: 0 }, 'held, released, no retry used');
  });

  it('untargeted rows share the primary\'s hold', async () => {
    for (let i = 0; i < 10; i++) conversation(null, `2026-11-18 04:${String(10 + i).padStart(2, '0')}:00`);
    conversation('admin', '2026-11-18 04:30:00');
    const elaine = conversation('user-elaine', '2026-11-18 07:57:00');
    const { result, pastes, reads } = await pass({ admin: UNKNOWN });
    assert.equal(result.delivered, true);
    assert.deepEqual(pastes.map((p) => p.deliveryId), [`conversation:${elaine}`]);
    assert.equal(reads.filter((s) => s === 'claude-admin').length, 1);
  });

  it('a persona held as unhealthy still gets its bypass-state controls in the same pass', async () => {
    const plain = control('user-pan', 'usage note', { priority: 1 });
    const bypass = control('user-pan', 'context handoff', { priority: 1, bypass: true });
    const { result, pastes } = await pass({}, { agentState: (id) => (id === 'user-pan' ? { ...LIVE, health: 'degraded' } : LIVE) });
    assert.equal(result.delivered, true);
    assert.deepEqual(pastes.map((p) => p.deliveryId), [`control:${bypass}`]);
    assert.equal(ctl(plain).status, 'pending');
  });
});

describe('fair selection for every row class (DELIVER-1 review)', () => {
  it('ten deferred key controls of one persona use one attempt: another persona\'s message is delivered on the next pass', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => control('user-pan', `[KEYSTROKE]F${i + 1}`, { bypass: true }));
    const elaine = conversation('user-elaine', '2026-11-18 07:57:00');
    const { result, pastes, keys: sent } = await pass({ 'user-pan': UNKNOWN });
    assert.equal(result.delivered, true);
    assert.deepEqual(pastes.map((p) => p.deliveryId), [`conversation:${elaine}`]);
    assert.deepEqual(sent, []);
    for (const id of keys) assert.equal(ctl(id).status, 'pending', 'held, released, never sent');
  });

  it('ten idle-only controls of a busy persona use one attempt: its neighbour\'s message is delivered on the next pass', async () => {
    const idle = Array.from({ length: 10 }, (_, i) => dbMod.insertControl(`/clear ${i}`, { priority: 1, requireIdle: true,
      appendAckSuffix: false, targetInstance: 'user-pan' }).id);
    const elaine = conversation('user-elaine', '2026-11-18 07:57:00');
    const { result, pastes } = await pass({}, { agentState: (id) => (id === 'user-pan' ? { ...LIVE, state: 'busy', idleSeconds: 0 } : LIVE) });
    assert.equal(result.delivered, true);
    assert.deepEqual(pastes.map((p) => p.deliveryId), [`conversation:${elaine}`]);
    for (const id of idle) assert.equal(ctl(id).status, 'pending');
  });

  it('the Escape for a permission prompt is claimed first: before older keys and messages of the same persona', async () => {
    conversation('user-pan', '2026-11-18 04:20:00');
    const older = ['Enter', '1', '2', '3', 'y', 'n', 'a', 'b', 'c', 'd'].map((k) => control('user-pan', `[KEYSTROKE]${k}`, { bypass: true }));
    const escape = control('user-pan', '[KEYSTROKE]Escape', { bypass: true, dialogRef: PROMPT.id });
    const { result, keys } = await pass({ 'user-pan': PROMPT });
    assert.equal(result.delivered, true);
    assert.deepEqual(keys, [{ target: '%2', key: 'Escape' }]);
    assert.equal(ctl(escape).status, 'done');
    for (const id of older) assert.equal(ctl(id).status, 'pending', 'not even claimed this pass');
  });
});

describe('cancellation only, bound to its prompt', () => {
  it('no key but Escape reaches a permission prompt: an Enter, a digit, y or text queued for it is superseded', async () => {
    const approving = ['Enter', '1', 'y', 'hello'].map((k) => control('user-pan', `[KEYSTROKE]${k}`, { bypass: true }));
    const { keys } = await pass({ 'user-pan': PROMPT });
    assert.deepEqual(keys, []);
    for (const id of approving) assert.deepEqual(ctl(id), { status: 'superseded', last_error: 'PERMISSION_PROMPT' });
  });

  it('a pasted message is never delivered to a permission prompt: it is held', async () => {
    const id = conversation('user-pan', '2026-11-18 04:20:00');
    const { pastes } = await pass({ 'user-pan': PROMPT });
    assert.deepEqual(pastes, []);
    assert.equal(conv(id).status, 'pending');
  });

  it('a dialog-bound Escape is superseded once its prompt is gone or replaced by another one', async () => {
    const gone = control('user-pan', '[KEYSTROKE]Escape', { bypass: true, dialogRef: PROMPT.id });
    let run = await pass({});
    assert.deepEqual(run.keys, []);
    assert.deepEqual(ctl(gone), { status: 'superseded', last_error: 'DIALOG_GONE' });
    const other = control('user-pan', '[KEYSTROKE]Escape', { bypass: true, dialogRef: PROMPT.id });
    run = await pass({ 'user-pan': { ...PROMPT, id: 'fedcba9876543210' } });
    assert.deepEqual(run.keys, []);
    assert.deepEqual(ctl(other), { status: 'superseded', last_error: 'DIALOG_GONE' });
  });

  it('no key from the queue reaches an unknown or a Fable-guard dialog, Escape included', async () => {
    for (const modal of [UNKNOWN, { kind: 'fable_limit', text: "You've reached your Fable limit" }]) {
      db.exec('DELETE FROM control_queue;');
      const escape = control('user-pan', '[KEYSTROKE]Escape', { bypass: true });
      const { keys } = await pass({ 'user-pan': modal });
      assert.deepEqual(keys, [], modal.kind);
      assert.equal(ctl(escape).status, 'pending');
    }
  });
});
