// DELIVER-1 third review: a process that needs control_queue.dialog_ref never
// serves on a handle that lacks it. getDb verifies every migration and the
// schema they add, retries with backoff, and caches nothing incomplete; the
// dispatcher and the broker publish their capability only once verified, and
// withdraw it when they exit. Each step runs in its own process.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPTS = path.dirname(fileURLToPath(new URL('../c4-db.js', import.meta.url)));
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-schema-ready-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });
  return root;
}
const env = (root) => ({ ...process.env, ZYLOS_DIR: root, ZYLOS_INSTANCE_ID: '' });
const dbFile = (root) => path.join(root, 'comm-bridge', 'c4.db');
const c4db = `import * as db from ${JSON.stringify(path.join(SCRIPTS, 'c4-db.js'))};`;
function inChild(root, source) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: env(root), encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

it('an incomplete schema is retried with backoff and never cached; once repaired the next open serves', () => {
  const root = freshRoot();
  assert.equal(inChild(root, `${c4db} db.getDb(); db.close();`).status, 0);
  // The ledger says 005 is applied, but the column is gone (a partial or failed migration).
  const raw = new Database(dbFile(root));
  raw.exec(`DROP INDEX idx_control_queue_dialog_escape; DROP INDEX idx_control_queue_dialog_notice;
    ALTER TABLE control_queue DROP COLUMN dialog_ref;`);
  raw.close();
  const broken = inChild(root, `${c4db}
    let first = null, second = null;
    try { db.getDb(); } catch (e) { first = e.message; }
    try { db.getDb(); } catch (e) { second = e.message; }
    console.log(JSON.stringify({ first, second }));`);
  const out = JSON.parse(broken.stdout);
  assert.match(out.first, /control_queue\.dialog_ref missing/);
  assert.match(out.second, /control_queue\.dialog_ref missing/, 'not cached: the next call verifies again');
  assert.match(broken.stderr, /Schema not ready \(attempt 1\/5\)/);

  const repair = new Database(dbFile(root));
  repair.exec('ALTER TABLE control_queue ADD COLUMN dialog_ref TEXT DEFAULT NULL;');
  repair.close();
  const ok = inChild(root, `${c4db} const d = db.getDb();
    console.log(d.prepare('PRAGMA table_info(control_queue)').all().some((c) => c.name === 'dialog_ref')); db.close();`);
  assert.equal(ok.stdout, 'true');
});

it('a migration blocked by another writer past busy_timeout is retried, not skipped', () => {
  const root = freshRoot();
  assert.equal(inChild(root, `${c4db} db.getDb(); db.close();`).status, 0);
  const raw = new Database(dbFile(root));
  raw.exec(`DROP INDEX idx_control_queue_dialog_escape; DROP INDEX idx_control_queue_dialog_notice;
    DROP TABLE dialog_watch_state; DROP TABLE c4_process_capabilities;
    DELETE FROM _migrations WHERE name = '006-add-dialog-watch-state.sql';`);
  raw.close();
  // Another writer holds the write lock for 6.5 s (busy_timeout is 5 s).
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import Database from ${JSON.stringify(path.join(SCRIPTS, '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js'))};
    const d = new Database(${JSON.stringify(dbFile(root))}); d.exec('BEGIN IMMEDIATE'); console.log('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500); d.exec('COMMIT'); d.close();`], { env: env(root) });
  return new Promise((resolve, reject) => {
    holder.stdout.once('data', () => {
      const r = inChild(root, `${c4db} const d = db.getDb();
        console.log(d.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = '006-add-dialog-watch-state.sql'").get().n); db.close();`);
      try {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, '1');
        assert.match(r.stderr, /Schema not ready \(attempt 1\/5\).*(locked|busy)/i);
        resolve();
      } catch (err) { reject(err); }
    });
    holder.on('error', reject);
  });
});

async function publishedWhileRunning(script, disableVar, processName) {
  const root = freshRoot();
  const child = spawn(process.execPath, [path.join(SCRIPTS, script)], { env: { ...env(root), [disableVar]: '' } });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const deadline = Date.now() + 15_000;
  let row = null;
  while (Date.now() < deadline && !row) {
    await new Promise((r) => setTimeout(r, 200));
    if (!fs.existsSync(dbFile(root))) continue;
    try {
      const d = new Database(dbFile(root), { readonly: true });
      try { row = d.prepare('SELECT pid, capabilities FROM c4_process_capabilities WHERE process = ?').get(processName) || null; }
      finally { d.close(); }
    } catch { /* not created yet */ }
  }
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  const d = new Database(dbFile(root), { readonly: true });
  const afterExit = d.prepare('SELECT COUNT(*) AS n FROM c4_process_capabilities WHERE process = ?').get(processName).n;
  d.close();
  return { row, afterExit, pid: child.pid, output };
}

it('the dispatcher publishes dialog_ref with its pid once the schema is verified, and withdraws it at exit', async () => {
  const got = await publishedWhileRunning('c4-dispatcher.js', 'C4_DISPATCHER_DISABLE_MAIN', 'c4-dispatcher');
  assert.deepEqual(got.row, { pid: got.pid, capabilities: 'dialog_ref' }, got.output);
  assert.equal(got.afterExit, 0);
  assert.match(got.output, /=== C4 Dispatcher Started === \(schema verified; capabilities: dialog_ref\)/);
});

it('the broker publishes dialog_ref with its pid once the schema is verified, and withdraws it at exit', async () => {
  const got = await publishedWhileRunning('c4-broker.js', 'C4_BROKER_DISABLE_MAIN', 'c4-broker');
  assert.deepEqual(got.row, { pid: got.pid, capabilities: 'dialog_ref' }, got.output);
  assert.equal(got.afterExit, 0);
});
