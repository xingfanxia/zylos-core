import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'content-error-alert-'));
const ORIG = process.env.ZYLOS_DIR;
process.env.ZYLOS_DIR = TMP;
const db = await import(new URL('../../../comm-bridge/scripts/c4-db.js', import.meta.url));
const { createContentErrorAlert, formatContentErrorAlert, CONTENT_ERROR_ALERT_FILE } = await import(new URL('../content-error-alert.js', import.meta.url));
if (ORIG === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = ORIG;
process.on('exit', () => { try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('content-error rows', () => {
  it('only failed inbound rows marked content-error are listed, after the given id', () => {
    const a = db.insertConversation('in', 'feishu', 'oc_1', 'x', 'pending', 3, false, null, 'user-pan');
    const b = db.insertConversation('in', 'feishu', 'oc_1', 'y', 'pending', 3, false, null, 'user-pan');
    const c = db.insertConversation('in', 'feishu', 'oc_1', 'z', 'pending', 3, false, null, 'user-pan');
    db.markContentError(a.id, 'recipient_acl_failed'); db.markFailed(a.id);   // listed
    db.markContentError(b.id, 'recipient_acl_failed');                       // still pending: not yet
    db.markFailed(c.id);                                                     // failed for another reason
    const rows = db.getContentErrorFailures(0);
    assert.deepEqual(rows.map((r) => [r.id, r.target_instance, r.delivery_action]), [[a.id, 'user-pan', 'content-error:recipient_acl_failed']]);
    assert.deepEqual(db.getContentErrorFailures(a.id), []);
  });
});

describe('content-error alert', () => {
  const rows = [{ id: 7, target_instance: 'user-pan', delivery_action: 'content-error:recipient_acl_failed', timestamp: '2026-11-18 20:00:00' }];

  it('names each id, persona and reason', () => {
    const text = formatContentErrorAlert(rows);
    assert.match(text, /1 条用户消息没有送达/);
    assert.match(text, /#7 pan：recipient_acl_failed（2026-11-18 20:00:00 UTC）/);
  });

  it('sends once per new batch, records the id only after a verified send, retries a failed send', async () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'mon-'));
    const sent = [];
    const listed = [];
    let ok = false;
    const alert = createContentErrorAlert({
      monitorDir: dir,
      list: (after) => { listed.push(after); return rows.filter((r) => r.id > after); },
      send: async (m) => { sent.push(m); return ok ? { ok: true } : { ok: false, output: 'feishu down' }; },
      log: () => {},
    });
    alert.run({ currentTime: 1 }); await alert.settled();
    assert.equal(sent.length, 1);
    assert.equal(fs.existsSync(path.join(dir, CONTENT_ERROR_ALERT_FILE)), false, 'failed send records nothing');
    ok = true;
    alert.run({ currentTime: 301 }); await alert.settled();
    assert.equal(sent.length, 2, 'retried at the next interval');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, CONTENT_ERROR_ALERT_FILE), 'utf8')).last_id, 7);
    alert.run({ currentTime: 601 }); await alert.settled();
    assert.equal(sent.length, 2, 'no repeat after a verified send');
    assert.deepEqual(listed, [0, 0, 7]);
    assert.equal(alert.getLastRunAt(), 601);
  });

  it('a check never throws into the scheduler', async () => {
    const alert = createContentErrorAlert({ monitorDir: TMP, list: () => { throw new Error('db gone'); }, send: async () => ({ ok: true }), log: () => {} });
    assert.equal(alert.run({ currentTime: 1 }), true);
    await alert.settled();
  });
});
