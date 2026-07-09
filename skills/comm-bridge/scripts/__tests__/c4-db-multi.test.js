/**
 * c4-db-multi — REAL module imports against a temp c4.db (no replica SQL).
 *
 * The old test/multi-session-comm-bridge.test.js hand-copied the SQL because
 * "we cannot import c4-db-multi.js directly". That is no longer true (ZYLOS_DIR
 * is resolved at import time from env), and the replica had DRIFTED from the
 * real code — e.g. it tested getConversationsByRangeForInstance as NULL-inclusive
 * while the real query is instance-only (tightened by the checkpoint-bleed fix).
 * These tests exercise the real exports so behavior and tests can't diverge.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-multi-'));
process.env.ZYLOS_DIR = tmpDir;
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });

const dbMod = await import('../c4-db.js');
const multi = await import('../c4-db-multi.js');
const db = dbMod.getDb();

// Raw seed helpers (bypass routing — we want deterministic rows).
function conv({ dir = 'in', channel = 'system', endpoint = null, content = 'x', status = 'pending', priority = 3, target = null }) {
  return db.prepare(
    `INSERT INTO conversations (direction, channel, endpoint_id, content, status, priority, target_instance)
     VALUES (?,?,?,?,?,?,?)`
  ).run(dir, channel, endpoint, content, status, priority, target).lastInsertRowid;
}
function control({ content = 'c', status = 'pending', priority = 3, target = null, availableAt = null }) {
  return db.prepare(
    `INSERT INTO control_queue (raw_content, content, status, priority, target_instance, available_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,0)`
  ).run(content, content, status, priority, target, availableAt).lastInsertRowid;
}
function checkpoint({ summary = null, start = 1, end = 1, target = null }) {
  return db.prepare(
    `INSERT INTO checkpoints (summary, start_conversation_id, end_conversation_id, target_instance) VALUES (?,?,?,?)`
  ).run(summary, start, end, target).lastInsertRowid;
}
function reset() {
  db.exec('DELETE FROM conversations; DELETE FROM control_queue; DELETE FROM checkpoints;');
}

beforeEach(reset);
after(() => {
  try { dbMod.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('runPendingMigrations', () => {
  it('records applied migrations and is idempotent (running twice does not error)', () => {
    // getDb() already ran the migrations on init; re-running must be a clean no-op.
    assert.doesNotThrow(() => multi.runPendingMigrations(db));
    assert.doesNotThrow(() => multi.runPendingMigrations(db));
    const names = db.prepare('SELECT name FROM _migrations ORDER BY name').all().map(r => r.name);
    assert.ok(names.length >= 1, 'at least one migration recorded');
    // target_instance columns exist on all three tables (idempotent dup-column handling).
    for (const table of ['conversations', 'control_queue', 'checkpoints']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      assert.ok(cols.includes('target_instance'), `${table}.target_instance present`);
    }
  });
});

describe('getNextPendingForInstance', () => {
  it('returns messages targeting the instance OR legacy NULL, by priority', () => {
    conv({ content: 'admin-low', target: 'admin', priority: 3 });
    conv({ content: 'legacy', target: null, priority: 3 });
    conv({ content: 'admin-urgent', target: 'admin', priority: 1 });
    conv({ content: 'betty', target: 'user-betty', priority: 1 });
    const next = multi.getNextPendingForInstance('admin');
    assert.equal(next.content, 'admin-urgent'); // priority 1 wins
  });

  it('never returns another instance\'s targeted message', () => {
    conv({ content: 'betty', target: 'user-betty' });
    assert.equal(multi.getNextPendingForInstance('admin'), null);
  });
});

describe('getNextPendingForInstances', () => {
  it('returns messages for any online instance or NULL', () => {
    conv({ content: 'betty', target: 'user-betty', priority: 2 });
    conv({ content: 'admin', target: 'admin', priority: 3 });
    const next = multi.getNextPendingForInstances(['admin', 'user-betty']);
    assert.equal(next.content, 'betty'); // priority 2 < 3
  });

  it('returns ONLY NULL-targeted rows when the online set is empty', () => {
    conv({ content: 'legacy', target: null });
    conv({ content: 'admin', target: 'admin' });
    const next = multi.getNextPendingForInstances([]);
    assert.equal(next.content, 'legacy');
  });

  it('skips messages targeting offline instances', () => {
    conv({ content: 'betty', target: 'user-betty' });
    assert.equal(multi.getNextPendingForInstances(['admin']), null);
  });
});

describe('getPendingTargetInstancesNeedingWake', () => {
  it('lists offline target instances with pending inbound, excluding online + NULL', () => {
    conv({ content: 'a', target: 'user-betty' });
    conv({ content: 'b', target: 'user-carol' });
    conv({ content: 'c', target: 'admin' });
    conv({ content: 'legacy', target: null });
    const rows = multi.getPendingTargetInstancesNeedingWake(['admin']);
    const ids = rows.map(r => r.target_instance).sort();
    assert.deepEqual(ids, ['user-betty', 'user-carol']);
  });
});

describe('markRejected / markControlRejected', () => {
  it('marks a conversation rejected; no-op for unknown id', () => {
    const id = conv({ content: 'x', target: 'gone' });
    multi.markRejected(id);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(id).status, 'rejected');
    assert.doesNotThrow(() => multi.markRejected(999999));
  });
  it('marks a control item rejected', () => {
    const id = control({ content: 'x', target: 'gone' });
    multi.markControlRejected(id);
    assert.equal(db.prepare('SELECT status FROM control_queue WHERE id=?').get(id).status, 'rejected');
  });
});

describe('getNextPendingControlForInstances', () => {
  it('honors available_at gate and instance/NULL scoping', () => {
    control({ content: 'ready', target: 'admin', availableAt: null });
    control({ content: 'future', target: 'admin', availableAt: 9_999_999_999 });
    const next = multi.getNextPendingControlForInstances(1000, ['admin']);
    assert.equal(next.content, 'ready');
  });
});

describe('getConversationsByRangeForInstance — instance-only (NOT NULL-inclusive)', () => {
  it('returns only rows targeting the instance in range; legacy NULL rows are excluded', () => {
    const a = conv({ content: 'admin1', target: 'admin' });
    conv({ content: 'legacy', target: null });        // must be excluded
    const c = conv({ content: 'admin2', target: 'admin' });
    const rows = multi.getConversationsByRangeForInstance(a, c, 'admin');
    assert.deepEqual(rows.map(r => r.content), ['admin1', 'admin2']);
  });
});

describe('unsummarized queries — delivered + instance-scoped', () => {
  it('counts delivered instance rows after the last checkpoint only', () => {
    // AUTOINCREMENT keeps climbing across beforeEach DELETEs, so anchor the
    // checkpoint on the actual 'old' row id, not a hardcoded 1.
    const oldId = conv({ content: 'old', status: 'delivered', target: 'admin' });
    checkpoint({ summary: 's', start: oldId, end: oldId, target: 'admin' });
    conv({ content: 'new', status: 'delivered', target: 'admin' });   // after checkpoint
    conv({ content: 'pending', status: 'pending', target: 'admin' }); // excluded (not delivered)
    conv({ content: 'legacy', status: 'delivered', target: null });   // excluded (NULL)
    const range = multi.getUnsummarizedRangeForInstance('admin');
    assert.equal(range.count, 1);
    const rows = multi.getUnsummarizedConversationsForInstance('admin');
    assert.deepEqual(rows.map(r => r.content), ['new']);
  });
});

describe('checkpoints — strictly instance-scoped (no NULL bleed)', () => {
  it('getLastCheckpointForInstance ignores NULL-targeted checkpoints', () => {
    checkpoint({ summary: 'null-cp', end: 5, target: null });
    checkpoint({ summary: 'admin-cp', end: 3, target: 'admin' });
    const cp = multi.getLastCheckpointForInstance('admin');
    assert.equal(cp.summary, 'admin-cp');
  });
  it('createCheckpointForInstance chains start from the prior instance checkpoint', () => {
    checkpoint({ summary: 'first', start: 1, end: 4, target: 'admin' });
    const created = multi.createCheckpointForInstance(9, 'second', 'admin');
    assert.equal(created.start_conversation_id, 5); // prior end + 1
    assert.equal(created.end_conversation_id, 9);
    assert.equal(created.target_instance, 'admin');
  });
});

describe('getUnansweredDeliveredForInstance', () => {
  it('returns a delivered replyable message with no later reply to its chat', () => {
    const id = conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_1', content: 'k线保存失败', status: 'delivered', target: 'group' });
    const rows = multi.getUnansweredDeliveredForInstance('group');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
  });

  it('excludes a message once a later outbound to the same chat exists', () => {
    conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_1', content: 'q', status: 'delivered', target: 'group' });
    conv({ dir: 'out', channel: 'feishu', endpoint: 'oc_A|type:group', content: 'reply', status: 'delivered', target: null });
    assert.equal(multi.getUnansweredDeliveredForInstance('group').length, 0);
  });

  it('a reply to a DIFFERENT chat does not clear this one', () => {
    const id = conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_1', content: 'q', status: 'delivered', target: 'group' });
    conv({ dir: 'out', channel: 'feishu', endpoint: 'oc_B|type:group', content: 'reply-elsewhere', status: 'delivered', target: null });
    const rows = multi.getUnansweredDeliveredForInstance('group');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
  });

  it('excludes void/system and null-endpoint (non-replyable) rows', () => {
    conv({ dir: 'in', channel: 'void', endpoint: 'session-handoff', content: 'h', status: 'delivered', target: 'group' });
    conv({ dir: 'in', channel: 'system', endpoint: null, content: 's', status: 'delivered', target: 'group' });
    conv({ dir: 'in', channel: 'feishu', endpoint: null, content: 'noreply', status: 'delivered', target: 'group' });
    assert.equal(multi.getUnansweredDeliveredForInstance('group').length, 0);
  });

  it('is instance-scoped (no cross-instance bleed) and ignores pending/summarized', () => {
    conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_1', content: 'for group', status: 'delivered', target: 'group' });
    assert.equal(multi.getUnansweredDeliveredForInstance('user-elaine').length, 0); // wrong instance
    reset();
    conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_2', content: 'still pending', status: 'pending', target: 'group' });
    assert.equal(multi.getUnansweredDeliveredForInstance('group').length, 0); // not yet delivered
    reset();
    const oldId = conv({ dir: 'in', channel: 'feishu', endpoint: 'oc_A|type:group|msg:om_3', content: 'old', status: 'delivered', target: 'group' });
    checkpoint({ summary: 's', start: oldId, end: oldId, target: 'group' });
    assert.equal(multi.getUnansweredDeliveredForInstance('group').length, 0); // already summarized
  });
});
