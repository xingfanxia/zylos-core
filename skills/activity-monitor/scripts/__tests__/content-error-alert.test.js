import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'content-error-alert-'));
const ORIG = process.env.ZYLOS_DIR;
process.env.ZYLOS_DIR = TMP;
const db = await import(new URL('../../../comm-bridge/scripts/c4-db.js', import.meta.url));
const { createContentErrorAlert, formatContentErrorAlert } = await import(new URL('../content-error-alert.js', import.meta.url));
if (ORIG === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = ORIG;
process.on('exit', () => { try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const inbound = () => db.insertConversation('in', 'feishu', 'oc_1', 'x', 'pending', 3, false, null, 'user-pan').id;
const failContent = (id) => db.markFailed(id, 'content-error:recipient_acl_failed');
const reset = () => db.getDb().prepare("DELETE FROM conversations").run();

// One "monitor process": the real DB reader and marker, a recording sender.
function monitor({ ok = () => true } = {}) {
  const sent = [];
  const alert = createContentErrorAlert({
    list: () => db.getContentErrorFailures(20),
    markNotified: (id) => db.markContentErrorNotified(id),
    send: async (m) => { sent.push(m); return ok() ? { ok: true } : { ok: false, output: 'feishu down' }; },
    log: () => {},
  });
  const tick = async (t) => { alert.run({ currentTime: t }); await alert.settled(); };
  return { sent, tick, alert };
}
const idsIn = (messages) => messages.flatMap((m) => [...m.matchAll(/#(\d+) /g)].map((x) => Number(x[1])));

describe('content-error rows', () => {
  it('only failed inbound rows whose terminal failure was a content error, not yet notified, are listed', () => {
    reset();
    const a = inbound(); const b = inbound(); const c = inbound();
    failContent(a);          // listed
    db.markFailed(c);        // failed for another reason: not listed
    assert.deepEqual(db.getContentErrorFailures().map((r) => [r.id, r.delivery_action]), [[a, 'content-error:recipient_acl_failed']]);
    assert.equal(db.markContentErrorNotified(a), true);
    assert.equal(db.markContentErrorNotified(a), false, 'a row is marked notified once');
    assert.equal(db.markContentErrorNotified(b), false, 'a row that has not failed cannot be marked');
    assert.deepEqual(db.getContentErrorFailures(), []);
    assert.match(db.getDb().prepare('SELECT delivery_action d FROM conversations WHERE id = ?').get(a).d, /^content-error-notified:recipient_acl_failed$/);
  });
});

describe('content-error alert', () => {
  it('names each id, persona and reason', () => {
    const text = formatContentErrorAlert([{ id: 7, target_instance: 'user-pan', delivery_action: 'content-error:recipient_acl_failed', timestamp: '2026-11-18 20:00:00' }]);
    assert.match(text, /1 条用户消息没有送达/);
    assert.match(text, /#7 pan：recipient_acl_failed（2026-11-18 20:00:00 UTC）/);
  });

  it('a lower-id failure after a higher-id notification is notified once', async () => {
    reset();
    const low = inbound(); const high = inbound();
    const m = monitor();
    failContent(high);
    await m.tick(1);
    failContent(low); // fails later, but has the lower id
    await m.tick(301);
    await m.tick(601);
    assert.deepEqual(idsIn(m.sent), [high, low]);
  });

  it('the same after a monitor restart, and nothing is notified twice', async () => {
    reset();
    const low = inbound(); const high = inbound();
    const first = monitor();
    failContent(high);
    await first.tick(1);
    const second = monitor(); // a new monitor process: no in-memory state
    await second.tick(1);
    assert.deepEqual(idsIn(second.sent), [], 'the restarted monitor does not repeat the notified row');
    failContent(low);
    await second.tick(301);
    await second.tick(601);
    assert.deepEqual([...idsIn(first.sent), ...idsIn(second.sent)], [high, low]);
  });

  it('a failed send marks nothing and is retried at the next interval', async () => {
    reset();
    const id = inbound();
    failContent(id);
    let up = false;
    const m = monitor({ ok: () => up });
    await m.tick(1);
    assert.equal(db.getContentErrorFailures().length, 1, 'still unnotified');
    up = true;
    await m.tick(301);
    await m.tick(601);
    assert.deepEqual(idsIn(m.sent), [id, id], 'one failed attempt, one delivered alert, then nothing');
    assert.deepEqual(db.getContentErrorFailures(), []);
  });

  it('a check never throws into the scheduler', async () => {
    const alert = createContentErrorAlert({ list: () => { throw new Error('db gone'); }, markNotified: () => true, send: async () => ({ ok: true }), log: () => {} });
    assert.equal(alert.run({ currentTime: 1 }), true);
    await alert.settled();
  });
});
