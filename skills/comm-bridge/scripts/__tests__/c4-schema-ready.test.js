// DELIVER-1: a missing or blocked migration is never an outage. Every opener
// of c4.db serves with the schema it finds and logs a migration failure once,
// as on the base. Only the dialog binding depends on migrations/005 and 006:
// c4-dispatcher and c4-broker verify that schema and publish their capability
// only once it is there, retrying with backoff and logging once a minute
// meanwhile, and keep serving as before. Each step runs in its own process.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makePre005Blocked, unblock, schemaFacts } from './fixtures/pre005-db.js';

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
const imports = `import * as db from ${JSON.stringify(path.join(SCRIPTS, 'c4-db.js'))};
  import * as multi from ${JSON.stringify(path.join(SCRIPTS, 'c4-db-multi.js'))};`;
function inChild(root, source) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `${imports}\n${source}`], { env: env(root), encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}
function pre005Blocked() {
  const root = freshRoot();
  assert.equal(inChild(root, 'db.getDb(); db.close();').status, 0);
  makePre005Blocked(dbFile(root));
  return root;
}
const waitFor = async (predicate, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (predicate()) return;
  assert.fail(`timed out waiting for ${what}`);
};

it('an ordinary opener on a pre-005 database with a blocked migration logs it once and serves as on the base', () => {
  const root = pre005Blocked();
  const r = inChild(root, `
    const conv = db.insertConversation('in', 'feishu', 'chat', 'hello', null, 3, false, null, 'user-pan');
    db.insertControl('[KEYSTROKE]Escape', { targetInstance: 'user-pan', appendAckSuffix: false });
    const second = db.insertControl('[KEYSTROKE]Escape', { targetInstance: 'user-pan', appendAckSuffix: false });
    const single = db.getNextPendingControl();
    const control = multi.getNextPendingControlForInstances(Math.floor(Date.now() / 1000), ['user-pan']);
    const message = multi.getNextPendingForInstances(['user-pan']);
    const held = db.getHeldWorkSummary('user-pan');
    console.log(JSON.stringify({ conv: conv.id, superseded: second.superseded_count, single: single.dialog_ref,
      control: [control.id, control.dialog_ref], message: message.id, held: held.count,
      capability: db.hasLiveCapability('c4-dispatcher', 'dialog_ref'), state: db.loadDialogWatchState('user-pan') }));
    db.close();`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { conv: 1, superseded: 1, single: null, control: [2, null], message: 1, held: 2,
    capability: false, state: null });
  assert.deepEqual(r.stderr.match(/\[c4-db\] Migration error: .*/g), ['[c4-db] Migration error: migration 005 blocked'], 'logged once');
  assert.deepEqual(schemaFacts(dbFile(root)), { dialogRef: false, tables: [], capabilities: [] }, 'nothing of 005/006 created');
});

it('the schema check waits with backoff, logs once a minute, never calls onReady while blocked, and does once unblocked', () => {
  const root = pre005Blocked();
  const r = inChild(root, `
    const lines = []; let readyCalls = 0; let t = 0;
    const check = db.startDialogSchemaCheck({ processName: 'probe', log: (l) => lines.push(l), now: () => t,
      onReady: () => { readyCalls++; }, delayMs: 20, maxDelayMs: 20 });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(400);
    const blocked = { lines: lines.length, ready: check.ready(), readyCalls };
    t = 61_000; await sleep(100);
    const aMinuteLater = lines.length;
    const { default: Database } = await import(${JSON.stringify(path.join(SCRIPTS, '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js'))});
    const raw = new Database(process.env.ZYLOS_DIR + '/comm-bridge/c4.db'); raw.exec('DROP TRIGGER block_005'); raw.close();
    await sleep(200);
    console.log(JSON.stringify({ blocked, aMinuteLater, ready: check.ready(), readyCalls, lines }));
    check.stop(); db.close();`);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.blocked, { lines: 1, ready: false, readyCalls: 0 }, 'about 20 attempts, one line');
  assert.equal(out.aMinuteLater, 2);
  assert.match(out.lines[0], /^probe: dialog binding schema not ready \(migration 005 blocked\); serving as before without it, capability not published; retrying$/);
  assert.deepEqual([out.ready, out.readyCalls], [true, 1]);
  assert.equal(out.lines.at(-1), 'probe: dialog binding schema verified; capability published');
  assert.equal(schemaFacts(dbFile(root)).dialogRef, true);
});

function startProcess(root, script, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(SCRIPTS, script)], { env: { ...env(root), ...extraEnv } });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  return { child, out, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); } };
}

it('the dispatcher on a pre-005 database with a blocked migration keeps its loop running and publishes no capability; unblocked, it publishes', async () => {
  const root = pre005Blocked();
  const p = startProcess(root, 'c4-dispatcher.js', { C4_DISPATCHER_DISABLE_MAIN: '', C4_HEARTBEAT_INTERVAL_MS: '500' });
  try {
    await waitFor(() => (p.out.text.match(/dispatcher alive/g) || []).length >= 3, 20_000, 'three heartbeats');
    assert.match(p.out.text, /=== C4 Dispatcher Started ===/);
    assert.equal((p.out.text.match(/dialog binding schema not ready \(migration 005 blocked\)/g) || []).length, 1);
    assert.deepEqual(schemaFacts(dbFile(root)), { dialogRef: false, tables: [], capabilities: [] });
    unblock(dbFile(root));
    await waitFor(() => schemaFacts(dbFile(root)).capabilities.length === 1, 30_000, 'the capability row');
    assert.deepEqual(schemaFacts(dbFile(root)).capabilities, [{ process: 'c4-dispatcher', pid: p.child.pid, capabilities: 'dialog_ref' }]);
    assert.match(p.out.text, /c4-dispatcher: dialog binding schema verified; capability published/);
  } finally { await p.stop(); }
  assert.deepEqual(schemaFacts(dbFile(root)).capabilities, [], 'withdrawn at exit');
});

it('the broker on a pre-005 database with a blocked migration serves and publishes no capability; unblocked, it publishes', async () => {
  const root = pre005Blocked();
  const p = startProcess(root, 'c4-broker.js', { C4_BROKER_DISABLE_MAIN: '' });
  try {
    await waitFor(() => /dialog binding schema not ready/.test(p.out.text), 15_000, 'the not-ready line');
    assert.match(p.out.text, /=== C4 Broker Started ===/);
    assert.equal(p.child.exitCode, null, 'still running');
    assert.deepEqual(schemaFacts(dbFile(root)).capabilities, []);
    unblock(dbFile(root));
    await waitFor(() => schemaFacts(dbFile(root)).capabilities.length === 1, 30_000, 'the capability row');
    assert.deepEqual(schemaFacts(dbFile(root)).capabilities, [{ process: 'c4-broker', pid: p.child.pid, capabilities: 'dialog_ref' }]);
  } finally { await p.stop(); }
  assert.deepEqual(schemaFacts(dbFile(root)).capabilities, [], 'withdrawn at exit');
});

it('on a fresh database the dispatcher publishes dialog_ref with its pid at once, and withdraws it at exit', async () => {
  const root = freshRoot();
  const p = startProcess(root, 'c4-dispatcher.js', { C4_DISPATCHER_DISABLE_MAIN: '' });
  try {
    await waitFor(() => { try { return schemaFacts(dbFile(root)).capabilities.length === 1; } catch { return false; } }, 15_000, 'the capability row');
    assert.deepEqual(schemaFacts(dbFile(root)).capabilities, [{ process: 'c4-dispatcher', pid: p.child.pid, capabilities: 'dialog_ref' }]);
    assert.doesNotMatch(p.out.text, /not ready/);
  } finally { await p.stop(); }
  assert.deepEqual(schemaFacts(dbFile(root)).capabilities, []);
});
