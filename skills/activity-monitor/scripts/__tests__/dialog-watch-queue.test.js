// DELIVER-1 reviews: the database is the dialog watch's authority. Its own
// rows are found by (instance, pane, prompt, kind), never by an id; at most
// one Escape and one decline message exist per instance, pane and prompt; its
// remaining state lives in the service-owned table dialog_watch_state; and it
// queues nothing until the running dispatcher (and broker, for an isolated
// persona) enforce the binding. Real c4-db, real watch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-watch-queue-'));
process.env.ZYLOS_DIR = root;
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });

const db = await import('../../../comm-bridge/scripts/c4-db.js');
const { createDialogWatch, bindDialogWatchQueue } = await import('../dialog-watch.js');
const { detectModal } = await import('../../../comm-bridge/scripts/tmux-input-state.js');
const fx = await import('../../../comm-bridge/scripts/__tests__/fixtures/claude-dialogs.js');
after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => db.getDb().exec('DELETE FROM control_queue; DELETE FROM dialog_watch_state; DELETE FROM c4_process_capabilities;'));

const PAN_PANE = '$5:1763400000:%7:4242';
const ELAINE_PANE = '$6:1763400001:%8:4343';
const PROMPT = detectModal(fx.DANGEROUS_RM_PROMPT);
const ELAINE_PROMPT = 'fedcba9876543210';
const T0 = Date.parse('2026-11-18T04:16:35Z');
const SEC = 1000;
const row = (id) => db.getDb().prepare('SELECT status, last_error, target_instance, dialog_ref FROM control_queue WHERE id = ?').get(id);
const escapes = () => db.getDb().prepare("SELECT id, target_instance, status FROM control_queue WHERE raw_content = '[KEYSTROKE]Escape' ORDER BY id").all();
const capable = (...names) => { for (const name of names) db.publishCapabilities(name, ['dialog_ref']); };
const DISPATCHER = ['c4-dispatcher'];

function watchFor(instanceId, { isolated = false, logs = [], alerts = [] } = {}) {
  const clock = { t: T0 };
  const watch = createDialogWatch({
    instanceId,
    ...bindDialogWatchQueue({ instanceId, isolated, db }),
    notifyOperator: async (message) => { alerts.push(message); return { ok: true }; },
    log: (line) => logs.push(line),
    now: () => clock.t,
  });
  return { watch, clock, logs, alerts,
    async run(until, frame) {
      for (; clock.t <= T0 + until; clock.t += SEC) { watch.tick({ sessionState: 'idle', healthOk: true, ...frame }); await watch.settled(); }
    } };
}

describe('ownership: the queue, not saved state, is the authority', () => {
  it('a forged saved state naming another persona\'s control id, pane and prompt withdraws nothing', async () => {
    capable('c4-dispatcher');
    const theirs = db.insertDialogControl({ instanceId: 'user-elaine', sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT,
      kind: 'escape', content: '[KEYSTROKE]Escape', priority: 0, bypassState: true, requires: DISPATCHER }).id;
    db.saveDialogWatchState('user-pan', { version: 1, dialog: null, declines: [
      { escapeId: theirs, sessionRef: ELAINE_PANE, id: ELAINE_PROMPT, title: 'x', notice: null, since: T0 - 1000, goneAt: T0 - 500 },
      { escapeId: theirs, sessionRef: PAN_PANE, id: PROMPT.id, title: 'x', notice: null, since: T0 - 1000, goneAt: T0 - 500 },
    ] });
    const pan = watchFor('user-pan');
    await pan.run(10 * SEC, { modal: null, sessionRef: PAN_PANE });
    assert.deepEqual(row(theirs), { status: 'pending', last_error: null, target_instance: 'user-elaine', dialog_ref: ELAINE_PROMPT });
    assert.ok(pan.logs.some((l) => /not confirmed by the queue \(kind escape\); ignored/.test(l)));
    assert.ok(pan.logs.every((l) => !l.includes(String(theirs))), 'the forged id is not logged');
  });

  it('every scoped call refuses another persona\'s row, even by its exact id', () => {
    capable('c4-dispatcher');
    const theirs = db.insertDialogControl({ instanceId: 'user-elaine', sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT,
      kind: 'escape', content: '[KEYSTROKE]Escape', priority: 0, bypassState: true, requires: DISPATCHER }).id;
    const pan = bindDialogWatchQueue({ instanceId: 'user-pan', db });
    assert.equal(pan.findOwnControl({ sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT, kind: 'escape' }), null);
    assert.equal(pan.withdrawOwnControl({ id: theirs, sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT, kind: 'escape' }), false);
    const elaine = bindDialogWatchQueue({ instanceId: 'user-elaine', db });
    assert.equal(elaine.withdrawOwnControl({ id: theirs, sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT, kind: 'notice' }), false, 'wrong kind');
    assert.equal(row(theirs).status, 'pending');
    assert.equal(elaine.withdrawOwnControl({ id: theirs, sessionRef: ELAINE_PANE, dialogRef: ELAINE_PROMPT, kind: 'escape' }), true);
  });

  it('a monitor restarted with the same prompt on screen sends no second Escape and resumes from the table', async () => {
    capable('c4-dispatcher');
    const first = watchFor('user-pan');
    await first.run(61 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.deepEqual(escapes().map((e) => e.target_instance), ['user-pan']);
    db.ackControl(escapes()[0].id); // the dispatcher sent it
    await first.run(70 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.ok(db.loadDialogWatchState('user-pan')?.dialog);

    const second = watchFor('user-pan');
    second.clock.t = first.clock.t + 30 * SEC;
    await second.run(20 * 60 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.equal(escapes().length, 1, 'no second Escape for the same prompt');
    assert.ok(second.logs.some((l) => /resumed permission dialog state/.test(l)));
  });
});

describe('at most one Escape and one decline message per instance, pane and prompt', () => {
  it('a second insert, in any status of the first, returns the existing row (and the index refuses a raw duplicate)', () => {
    capable('c4-dispatcher');
    const scope = { instanceId: 'user-pan', sessionRef: PAN_PANE, dialogRef: PROMPT.id, requires: DISPATCHER };
    const first = db.insertDialogControl({ ...scope, kind: 'escape', content: '[KEYSTROKE]Escape', priority: 0, bypassState: true });
    assert.equal(first.existing, false);
    for (const status of ['pending', 'done', 'superseded']) {
      db.getDb().prepare('UPDATE control_queue SET status = ? WHERE id = ?').run(status, first.id);
      assert.deepEqual(db.insertDialogControl({ ...scope, kind: 'escape', content: '[KEYSTROKE]Escape', priority: 0, bypassState: true }),
        { id: first.id, status, existing: true });
    }
    assert.throws(() => db.getDb().prepare(`INSERT INTO control_queue (raw_content, content, priority, status, created_at, updated_at,
      target_instance, session_ref, dialog_ref) VALUES ('[KEYSTROKE]Escape', '[KEYSTROKE]Escape', 0, 'pending', 0, 0, ?, ?, ?)`)
      .run('user-pan', PAN_PANE, PROMPT.id), /UNIQUE constraint failed/);
    const notice = db.insertDialogControl({ ...scope, kind: 'notice', content: 'declined', priority: 1 });
    assert.equal(db.insertDialogControl({ ...scope, kind: 'notice', content: 'declined again', priority: 1 }).id, notice.id);
    assert.equal(escapes().length, 1);
  });

  it('a lost state write cannot double the Escape: a fresh watch adopts the queued one', async () => {
    capable('c4-dispatcher');
    const first = watchFor('user-pan');
    await first.run(61 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    db.saveDialogWatchState('user-pan', null); // as if the state write had failed
    const second = watchFor('user-pan');
    second.clock.t = first.clock.t;
    await second.run(5 * 60 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.equal(escapes().length, 1);
    assert.ok(second.logs.some((l) => /already queued; not queued again/.test(l)));
  });
});

describe('capability gate', () => {
  it('nothing is queued until the running dispatcher published the binding; it only alerts meanwhile', async () => {
    const pan = watchFor('user-pan');
    pan.watch.tick({ modal: null, sessionRef: PAN_PANE });
    await pan.run(7 * 60 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.deepEqual(escapes(), [], 'no Escape without a capable dispatcher');
    assert.equal(pan.alerts.length, 1, 'the prompt is still reported');
    assert.match(pan.alerts[0], /没有发送 Esc/);
    capable('c4-dispatcher');
    await pan.run(7 * 60 * SEC + 15 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.equal(escapes().length, 1, 'queued once the dispatcher enforces the binding');
  });

  it('an isolated persona also needs a capable broker; a stale or dead publisher does not count', async () => {
    capable('c4-dispatcher');
    const pan = watchFor('user-pan', { isolated: true });
    await pan.run(2 * 60 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.deepEqual(escapes(), [], 'dispatcher only: not enough for an isolated persona');
    db.publishCapabilities('c4-broker', ['dialog_ref'], { pid: 2 ** 22 + 12345, startedAt: 1 });
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), false, 'dead pid');
    db.publishCapabilities('c4-broker', ['dialog_ref'], { startedAt: db.processStartTime(process.pid) - 60 });
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), false, 'a reused pid: the running process started at another time');
    db.publishCapabilities('c4-broker', ['dialog_ref']);
    db.getDb().prepare("UPDATE c4_process_capabilities SET updated_at = updated_at - 600 WHERE process = 'c4-broker'").run();
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), false, 'stale row');
    db.refreshCapabilities('c4-broker');
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), true);
    await pan.run(2 * 60 * SEC + 15 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.equal(escapes().length, 1);
    db.withdrawCapabilities('c4-broker');
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), false, 'withdrawn at exit');
  });

  it('a capability withdrawn after the Escape was sent authorizes no decline, even while the pre-check still says yes', async () => {
    capable('c4-dispatcher', 'c4-broker');
    const logs = [];
    const clock = { t: T0 };
    // A pre-check that always answers yes, as a stale cached positive would.
    const watch = createDialogWatch({ instanceId: 'user-pan',
      ...bindDialogWatchQueue({ instanceId: 'user-pan', isolated: true, db }), deliveryCapable: () => true,
      notifyOperator: async () => ({ ok: true }), log: (line) => logs.push(line), now: () => clock.t });
    const run = async (until, frame) => {
      for (; clock.t <= T0 + until; clock.t += SEC) { watch.tick({ sessionState: 'idle', healthOk: true, ...frame }); await watch.settled(); }
    };
    await run(61 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    assert.equal(escapes().length, 1);
    db.ackControl(escapes()[0].id);
    await run(63 * SEC, { modal: PROMPT, sessionRef: PAN_PANE });
    db.withdrawCapabilities('c4-broker');
    assert.equal(db.hasLiveCapability('c4-broker', 'dialog_ref'), false);
    await run(70 * SEC, { modal: null, sessionRef: PAN_PANE });
    const notices = db.getDb().prepare("SELECT COUNT(*) AS n FROM control_queue WHERE substr(raw_content, 1, 11) != '[KEYSTROKE]'").get().n;
    assert.equal(notices, 0, 'the insert transaction refused it');
    assert.ok(logs.some((l) => /does not enforce the prompt binding/.test(l)));
    capable('c4-broker');
    await run(80 * SEC, { modal: null, sessionRef: PAN_PANE });
    assert.equal(db.getDb().prepare("SELECT COUNT(*) AS n FROM control_queue WHERE substr(raw_content, 1, 11) != '[KEYSTROKE]'").get().n, 1,
      'announced once the broker enforces the binding again');
  });
});

// PASTE-STRAND-1: the composer alert's count of failed inbound rows comes from
// the store the monitor already reads, read-only.
describe('dialog watch queue: failed inbound rows of a persona since a time', () => {
  it('counts that persona\'s failed inbound rows that arrived since then; the primary also counts untargeted ones', () => {
    const d = db.getDb();
    d.exec("DELETE FROM conversations");
    const add = (target, status, at) => d.prepare(`INSERT INTO conversations (timestamp, direction, channel, endpoint_id, content, status, target_instance)
      VALUES (datetime(?, 'unixepoch'), 'in', 'telegram', 'chat', 'harmless', ?, ?)`).run(at, status, target);
    const since = Math.floor(T0 / 1000);
    add('user-pan', 'failed', since + 5);
    add('user-pan', 'failed', since + 600);
    add('user-pan', 'failed', since - 5);      // before the episode
    add('user-pan', 'delivered', since + 10);
    add('user-elaine', 'failed', since + 5);   // another persona
    add(null, 'failed', since + 5);            // untargeted: the primary's
    const pan = bindDialogWatchQueue({ instanceId: 'user-pan', db });
    assert.equal(pan.countFailedSince(since), 2);
    const primary = bindDialogWatchQueue({ instanceId: 'admin', routesUntargeted: () => true, db });
    assert.equal(primary.countFailedSince(since), 1);
  });
});
