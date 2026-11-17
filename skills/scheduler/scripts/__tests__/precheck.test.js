// Scheduler pre-check (precheck.js) and the skipped-run record
// (daemon-tasks.js recordSkippedRun) against a temporary ZYLOS_DIR: a real
// scheduler database, a c4.db with only the conversations table, and a memory
// tree whose mtimes the tests set. Covers which task names are internal (and
// that any other task always runs), each internal job's skip and run
// conditions, and the conservative cases (no history, unreadable memory, no
// c4.db). Run for changes to the pre-check or scheduler dispatch; skip
// otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, before, beforeEach, describe, it } from 'node:test';
import { skipReason, lastSuccessAt, countInbound, changedSince, PRODUCT_SWEEP_QUIET_DAYS } from '../precheck.js';
import { recordSkippedRun } from '../daemon-tasks.js';

const NOW = Math.floor(Date.now() / 1000);
const LAST_RUN = NOW - 86400;
const INSTANCES = [
  { id: 'admin', type: 'dedicated' },
  { id: 'user-pan', type: 'user' },
  { id: 'group', type: 'group' },
];

let root, memory, c4Path, db, c4;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-precheck-'));
  process.env.ZYLOS_DIR = root;
  const { getDb } = await import(new URL(`../database.js?precheck-${Date.now()}`, import.meta.url));
  db = getDb();
  memory = path.join(root, 'memory');
  c4Path = path.join(root, 'comm-bridge', 'c4.db');
  fs.mkdirSync(path.dirname(c4Path), { recursive: true });
  c4 = new Database(c4Path);
  c4.exec(`CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL, channel TEXT NOT NULL, endpoint_id TEXT, content TEXT NOT NULL,
    target_instance TEXT DEFAULT NULL)`);
});

after(() => {
  db.close();
  c4.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM task_history; DELETE FROM tasks;');
  c4.exec('DELETE FROM conversations');
  fs.rmSync(memory, { recursive: true, force: true });
  for (const dir of ['instances/user-pan', 'instances/group', 'instances/admin', 'groups/oc_x', 'shared']) {
    write(`${dir}/notes.md`, LAST_RUN - 3600);
  }
});

/** Write a memory file at `at` (epoch seconds): its mtime, and that of each directory that gained an entry. */
function write(relative, at) {
  const file = path.join(memory, relative);
  let top = path.dirname(file);
  while (!fs.existsSync(path.dirname(top)) && path.dirname(top).startsWith(memory)) top = path.dirname(top);
  const created = !fs.existsSync(top);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
  for (let p = file; ; p = path.dirname(p)) {
    fs.utimesSync(p, at, at);
    if (p === (created ? path.dirname(top) : path.dirname(file)) || p === memory) break;
  }
}

function addTask(name, target, { completedAt = LAST_RUN } = {}) {
  const id = `task-${name}`;
  db.prepare(`INSERT INTO tasks (id, name, prompt, type, cron_expression, next_run_at, status, created_at, updated_at, target_instance)
    VALUES (?, ?, 'p', 'recurring', '0 5 * * *', ?, 'pending', ?, ?, ?)`).run(id, name, NOW, NOW, NOW, target);
  if (completedAt != null) {
    db.prepare(`INSERT INTO task_history (task_id, executed_at, completed_at, status) VALUES (?, ?, ?, 'success')`)
      .run(id, completedAt - 60, completedAt);
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function inbound(instance, at, channel = 'feishu') {
  c4.prepare(`INSERT INTO conversations (timestamp, direction, channel, content, target_instance)
    VALUES (datetime(?, 'unixepoch'), 'in', ?, 'm', ?)`).run(at, channel, instance);
}

const deps = (overrides = {}) => ({
  lastSuccessAt: (taskId) => lastSuccessAt(db, taskId),
  countInbound: (ids, since) => countInbound(c4Path, ids, since),
  changedSince,
  instances: INSTANCES,
  memoryDir: memory,
  now: NOW,
  ...overrides,
});

describe('scheduler pre-check', () => {
  it('never looks at a task that is not an internal job', () => {
    const untouchable = () => { throw new Error('a user task must not be checked'); };
    for (const [name, target] of [['ai-xiaobai-daily-pan', 'user-pan'], ['Elaine 每日3分钟培训', 'user-elaine'],
      ['instance-dream-user-pan', 'user-elaine'], ['shared-knowledge-sync', 'scheduler'], [null, 'user-pan']]) {
      const task = addTask(name ?? 'unnamed', target);
      task.name = name;
      assert.equal(skipReason(task, deps({ lastSuccessAt: untouchable, countInbound: untouchable, changedSince: untouchable })), null, String(name));
    }
  });

  it('skips an instance consolidation with no user message and no memory change since its last run', () => {
    const task = addTask('instance-dream-user-pan', 'user-pan');
    // Messages and memory of other instances, and a system message to this one, do not count.
    inbound('user-elaine', NOW - 60);
    inbound('user-pan', NOW - 60, 'system');
    write('instances/admin/new.md', NOW - 60);
    assert.equal(skipReason(task, deps()), 'no user message and no memory change for user-pan since the last run');
  });

  it('runs an instance consolidation after a user message or a memory change', () => {
    const task = addTask('instance-dream-user-pan', 'user-pan');
    inbound('user-pan', NOW - 60);
    assert.equal(skipReason(task, deps()), null);

    c4.exec('DELETE FROM conversations');
    write('instances/user-pan/archive/deep/new.md', NOW - 60);
    assert.equal(skipReason(task, deps()), null);
  });

  it('counts the group tier as the group instance memory', () => {
    const task = addTask('instance-dream-group', 'group');
    assert.match(skipReason(task, deps()), /^no user message/);
    write('groups/oc_x/context.md', NOW - 60);
    assert.equal(skipReason(task, deps()), null);
  });

  it('runs when it cannot tell: no completed run, no c4.db, unreadable memory', { skip: process.getuid?.() === 0 }, () => {
    assert.equal(skipReason(addTask('instance-dream-admin', 'admin', { completedAt: null }), deps()), null);

    const task = addTask('instance-dream-user-pan', 'user-pan');
    assert.equal(skipReason(task, deps({ countInbound: (ids, since) => countInbound(path.join(root, 'missing.db'), ids, since) })), null);

    const locked = path.join(memory, 'instances', 'user-pan', 'locked');
    fs.mkdirSync(locked);
    fs.utimesSync(locked, LAST_RUN - 3600, LAST_RUN - 3600);
    fs.utimesSync(path.dirname(locked), LAST_RUN - 3600, LAST_RUN - 3600);
    fs.chmodSync(locked, 0o000);
    try {
      assert.equal(skipReason(task, deps()), null);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('skips the shared consolidation unless memory outside instances and groups changed', () => {
    const task = addTask('shared-memory-dream', 'admin');
    write('instances/user-pan/new.md', NOW - 60);
    write('groups/oc_x/new.md', NOW - 60);
    assert.equal(skipReason(task, deps()), 'no shared memory change since the last run');
    write('shared/reference/decisions.md', NOW - 60);
    assert.equal(skipReason(task, deps()), null);
  });

  it(`skips the product sweep when no group chat had a user message in ${PRODUCT_SWEEP_QUIET_DAYS} days`, () => {
    const task = addTask('daily-product-sweep', 'scheduler', { completedAt: null });
    inbound('user-pan', NOW - 60);
    inbound('group', NOW - (PRODUCT_SWEEP_QUIET_DAYS + 1) * 86400);
    assert.equal(skipReason(task, deps()), `no user message to a group chat in ${PRODUCT_SWEEP_QUIET_DAYS} days`);
    inbound('group', NOW - 3 * 86400);
    assert.equal(skipReason(task, deps()), null);
    assert.equal(skipReason(task, deps({ instances: INSTANCES.filter(inst => inst.type !== 'group') })), null, 'no group instance: run');
  });

  it('records a skipped run as completed with its reason, schedules the next run and moves the baseline', () => {
    const task = addTask('instance-dream-user-pan', 'user-pan');
    recordSkippedRun(db, task, 'nothing new');
    const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(task.id);
    assert.equal(entry.status, 'success');
    assert.equal(entry.duration_ms, 0);
    assert.equal(entry.error, 'skipped: nothing new');
    assert.ok(lastSuccessAt(db, task.id) >= NOW);
    const row = db.prepare('SELECT status, next_run_at, last_run_at FROM tasks WHERE id = ?').get(task.id);
    assert.equal(row.status, 'pending');
    assert.ok(row.next_run_at > NOW);
    assert.ok(row.last_run_at >= NOW);
  });
});
