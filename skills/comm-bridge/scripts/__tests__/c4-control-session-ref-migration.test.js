// migrations/003 (control_queue.session_ref) and 004 (delivery_uncertain) on
// an existing, live database:
// additive, idempotent, safe with another connection open, and old rows keep
// today's behavior (unbound, delivered as before).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPTS = path.dirname(fileURLToPath(new URL('../c4-db.js', import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-sessref-mig-'));
const dbPath = path.join(root, 'comm-bridge', 'c4.db');
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Each step runs in a fresh process, like a dispatcher or c4-control start.
function inChild(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ZYLOS_DIR: root, ZYLOS_INSTANCE_ID: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
}
const db = (name) => `import * as db from ${JSON.stringify(path.join(SCRIPTS, name))};`;

it('adds session_ref and delivery_uncertain to a pre-003 database without touching existing rows', () => {
  // A database as the previous release leaves it: everything but 003 and 004.
  inChild(`${db('c4-db.js')} db.getDb(); db.close();`);
  const old = new Database(dbPath);
  old.exec(`DROP INDEX idx_control_queue_session_ref; ALTER TABLE control_queue DROP COLUMN session_ref;
    DELETE FROM _migrations WHERE name = '003-add-control-session-ref.sql';
    DROP TABLE delivery_uncertain; DELETE FROM _migrations WHERE name = '004-add-delivery-uncertain.sql';`);
  const now = Math.floor(Date.now() / 1000);
  old.prepare(`INSERT INTO control_queue (raw_content, content, priority, bypass_state, status, created_at, updated_at, target_instance)
    VALUES ('[KEYSTROKE]Enter', '[KEYSTROKE]Enter', 0, 1, 'pending', ?, ?, 'user-pan')`).run(now, now);
  assert.equal(old.prepare('PRAGMA table_info(control_queue)').all().some((c) => c.name === 'session_ref'), false);

  // Live database: another connection stays open while the next process migrates.
  const migrated = inChild(`${db('c4-db.js')} import * as schema from ${JSON.stringify(path.join(SCRIPTS, 'c4-schema.js'))};
    const d = db.getDb();
    const strict = schema.inspectSchema(d, { strict: true });
    const rows = d.prepare('SELECT id, session_ref, status FROM control_queue').all();
    const applied = d.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name IN ('003-add-control-session-ref.sql', '004-add-delivery-uncertain.sql')").get().n;
    const uncertain = db.getUncertainDeliveries();
    db.close();
    console.log(JSON.stringify({ rows, applied, uncertain, extensions: strict.extensions }));`);
  assert.deepEqual(migrated.rows.map(({ session_ref, status }) => ({ session_ref, status })), [{ session_ref: null, status: 'pending' }]);
  assert.equal(migrated.applied, 2);
  assert.deepEqual(migrated.uncertain, []);
  assert.deepEqual(migrated.extensions, { tables: [], columns: [] }, 'strict inspection accepts the fork column');

  // The connection that was open during the migration sees the new column.
  assert.equal(old.prepare('PRAGMA table_info(control_queue)').all().some((c) => c.name === 'session_ref'), true);
  old.close();

  // Reopening applies nothing twice; the old unbound row still claims, binds and acks.
  const reused = inChild(`${db('c4-db.js')} const d = db.getDb();
    const row = db.getNextPendingControl();
    const claimed = db.claimControl(row.id);
    const bound = db.bindControlSession(row.id, '$1:1000:%2:123');
    const acked = db.ackControl(row.id).status;
    const applied = d.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '003-add-control-session-ref.sql'").get().n;
    db.close();
    console.log(JSON.stringify({ claimed, bound, acked, applied }));`);
  assert.deepEqual(reused, { claimed: true, bound: { sessionRef: '$1:1000:%2:123', stamped: true }, acked: 'done', applied: 1 });
});

// DELIVER-1: migrations/005 adds control_queue.dialog_ref (the prompt a dialog
// watch Escape or decline message is bound to) the same way: additive,
// idempotent, applied by whichever process opens the database first, strict
// inspection accepts it, and rows written before it keep NULL.
it('adds dialog_ref to a pre-005 database without touching existing rows; a bound Escape stays a plain key', () => {
  inChild(`${db('c4-db.js')} db.getDb(); db.close();`);
  const old = new Database(dbPath);
  old.exec(`DELETE FROM control_queue; ALTER TABLE control_queue DROP COLUMN dialog_ref;
    DELETE FROM _migrations WHERE name = '005-add-control-dialog-ref.sql';`);
  const now = Math.floor(Date.now() / 1000);
  old.prepare(`INSERT INTO control_queue (raw_content, content, priority, bypass_state, status, created_at, updated_at, target_instance)
    VALUES ('[KEYSTROKE]Escape', '[KEYSTROKE]Escape', 0, 1, 'pending', ?, ?, 'user-pan')`).run(now, now);
  const migrated = inChild(`${db('c4-db.js')} import * as schema from ${JSON.stringify(path.join(SCRIPTS, 'c4-schema.js'))};
    const d = db.getDb();
    const strict = schema.inspectSchema(d, { strict: true });
    const bound = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false,
      targetInstance: 'user-pan', sessionRef: '$1:1000:%2:123', dialogRef: '0123456789abcdef' });
    const rows = d.prepare('SELECT raw_content, content, dialog_ref, status FROM control_queue ORDER BY id').all();
    const applied = d.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '005-add-control-dialog-ref.sql'").get().n;
    db.close();
    console.log(JSON.stringify({ rows, applied, extensions: strict.extensions, boundId: bound.id }));`);
  assert.equal(migrated.applied, 1);
  assert.deepEqual(migrated.extensions, { tables: [], columns: [] }, 'strict inspection accepts the fork column');
  assert.deepEqual(migrated.rows, [
    { raw_content: '[KEYSTROKE]Escape', content: '[KEYSTROKE]Escape', dialog_ref: null, status: 'pending' },
    { raw_content: '[KEYSTROKE]Escape', content: '[KEYSTROKE]Escape', dialog_ref: '0123456789abcdef', status: 'pending' },
  ], 'the bound row is the plain key a dispatcher without the column sends as any Escape; the older equivalent row is not superseded by it');
  assert.equal(old.prepare('PRAGMA table_info(control_queue)').all().some((c) => c.name === 'dialog_ref'), true);
  old.close();
});
