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
function control(target, content, { bypass = false, priority = 0 } = {}) {
  return dbMod.insertControl(content, { priority, bypassState: bypass, appendAckSuffix: false, targetInstance: target }).id;
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
const SAFETY = { kind: 'permission', text: 'Bash command', notice: 'Dangerous rm operation on possibly-empty variable path: $D/* in `rm -f $D/*` (rewrite it as "${D:?}"/* or use a literal path)' };

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

describe('a dialog\'s own cancel key is never held behind other rows of its persona', () => {
  it('Escape reaches an unknown dialog although a message and another key of the same persona are held', async () => {
    conversation('user-pan', '2026-11-18 04:20:00');
    const heartbeat = control('user-pan', 'Heartbeat check. [phase=primary]', { bypass: true });
    const enter = control('user-pan', '[KEYSTROKE]Enter', { bypass: true });
    const escape = control('user-pan', '[KEYSTROKE]Escape', { bypass: true });
    const { result, keys } = await pass({ 'user-pan': UNKNOWN });
    assert.equal(result.delivered, true);
    assert.deepEqual(keys, [{ target: '%2', key: 'Escape' }]);
    assert.equal(ctl(escape).status, 'done');
    assert.equal(ctl(enter).status, 'pending', 'any other key stays held while the dialog is up');
    assert.equal(ctl(heartbeat).status, 'pending');
  });

  it('an Enter never answers a safety prompt: it is superseded, and the Escape declines the prompt', async () => {
    const enter = control('user-pan', '[KEYSTROKE]Enter', { bypass: true });
    const escape = control('user-pan', '[KEYSTROKE]Escape', { bypass: true });
    const { keys } = await pass({ 'user-pan': SAFETY });
    assert.deepEqual(keys, [{ target: '%2', key: 'Escape' }]);
    assert.deepEqual(ctl(enter), { status: 'superseded', last_error: 'SAFETY_PROMPT' });
    assert.equal(ctl(escape).status, 'done');
  });

  it('no key from the queue reaches a Fable-guard dialog, Escape included', async () => {
    const escape = control('user-pan', '[KEYSTROKE]Escape', { bypass: true });
    const { keys } = await pass({ 'user-pan': { kind: 'fable_limit', text: "You've reached your Fable limit" } });
    assert.deepEqual(keys, []);
    assert.equal(ctl(escape).status, 'pending');
  });
});
