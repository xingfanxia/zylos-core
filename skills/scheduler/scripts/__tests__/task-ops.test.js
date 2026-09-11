import assert from 'node:assert/strict';
import { describe, it, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  resolveTaskByPrefix, listTasks, insertTask, completeTask, removeTask,
  pauseTask, resumeTask, taskHistory, nextTasks, runningTasks, applyTaskUpdates,
} from '../task-ops.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ops-test-'));
const dbPath = path.join(tmpDir, 'scheduler.db');
let db;

after(() => {
  if (db) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('one-time', 'recurring', 'interval')),
    cron_expression TEXT,
    interval_seconds INTEGER,
    timezone TEXT DEFAULT 'UTC',
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    priority INTEGER DEFAULT 3 CHECK(priority BETWEEN 1 AND 3),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'paused')),
    require_idle INTEGER DEFAULT 0,
    miss_threshold INTEGER DEFAULT 300,
    reply_channel TEXT DEFAULT NULL,
    reply_endpoint TEXT DEFAULT NULL,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    target_instance TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT,
    failed_at INTEGER
  );
  CREATE TABLE task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    executed_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('started', 'success', 'failed', 'timeout')),
    duration_ms INTEGER,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

function spec(id, overrides = {}) {
  const t = Math.floor(Date.now() / 1000);
  return {
    id, name: id, prompt: `prompt for ${id}`, type: 'one-time',
    next_run_at: t + 60, priority: 3, require_idle: 0, miss_threshold: 300,
    created_at: t, updated_at: t, timezone: 'UTC', target_instance: null,
    ...overrides,
  };
}

beforeEach(() => {
  if (db) db.close();
  fs.rmSync(dbPath, { force: true });
  db = new Database(dbPath);
  db.exec(SCHEMA);
});

describe('task-ops scoping', () => {
  it('listTasks with scope returns only that instance\'s tasks', () => {
    insertTask(db, spec('task-a1', { target_instance: 'inst-a' }));
    insertTask(db, spec('task-b1', { target_instance: 'inst-b' }));
    insertTask(db, spec('task-n1')); // NULL target

    const scoped = listTasks(db, { scope: 'inst-a' });
    assert.deepEqual(scoped.map(t => t.id), ['task-a1']);

    // Unscoped (admin) sees everything, including NULL-target tasks.
    const all = listTasks(db);
    assert.equal(all.length, 3);
  });

  it('listTasks composes reply-channel filtering with instance scope', () => {
    insertTask(db, spec('task-a-telegram', {
      target_instance: 'inst-a',
      reply_channel: 'telegram',
    }));
    insertTask(db, spec('task-a-feishu', {
      target_instance: 'inst-a',
      reply_channel: 'feishu',
    }));
    insertTask(db, spec('task-b-telegram', {
      target_instance: 'inst-b',
      reply_channel: 'telegram',
    }));

    const scoped = listTasks(db, { scope: 'inst-a', replyChannel: 'telegram' });
    assert.deepEqual(scoped.map(t => t.id), ['task-a-telegram']);
  });

  it('completeTask refuses another instance\'s task (not_found under scope)', () => {
    insertTask(db, spec('task-b2', { target_instance: 'inst-b' }));

    const res = completeTask(db, 'task-b2', { scope: 'inst-a' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
    // Task untouched.
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-b2').status, 'pending');
  });

  it('completeTask under matching scope completes and closes history', () => {
    insertTask(db, spec('task-a3', { target_instance: 'inst-a' }));
    const startedAt = Math.floor(Date.now() / 1000) - 10;
    db.prepare(`INSERT INTO task_history (task_id, executed_at, status) VALUES (?, ?, 'started')`)
      .run('task-a3', startedAt);

    const res = completeTask(db, 'task-a3', { scope: 'inst-a' });
    assert.equal(res.ok, true);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-a3').status, 'completed');
    const hist = db.prepare('SELECT status, duration_ms FROM task_history WHERE task_id = ?').get('task-a3');
    assert.equal(hist.status, 'success');
    assert.ok(hist.duration_ms >= 10000);
  });

  it('NULL-target tasks are invisible to any scope', () => {
    insertTask(db, spec('task-n2'));
    const res = completeTask(db, 'task-n2', { scope: 'inst-a' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
  });

  it('scope restricts prefix resolution (no cross-instance prefix probing)', () => {
    insertTask(db, spec('task-x1', { target_instance: 'inst-a' }));
    insertTask(db, spec('task-x2', { target_instance: 'inst-b' }));

    // Under scope inst-a the prefix 'task-x' is unique, not ambiguous —
    // inst-b's task must not even be visible as an ambiguity hint.
    const res = resolveTaskByPrefix(db, 'task-x', { scope: 'inst-a' });
    assert.equal(res.ok, true);
    assert.equal(res.task.id, 'task-x1');
  });

  it('history/next/running are scope-filtered', () => {
    insertTask(db, spec('task-a4', { target_instance: 'inst-a' }));
    insertTask(db, spec('task-b4', { target_instance: 'inst-b', status: 'running' }));
    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = 'task-b4'`).run();
    db.prepare(`INSERT INTO task_history (task_id, executed_at, status) VALUES ('task-b4', 100, 'started')`).run();

    assert.equal(taskHistory(db, { scope: 'inst-a' }).entries.length, 0);
    assert.equal(taskHistory(db, { scope: 'inst-b' }).entries.length, 1);
    assert.deepEqual(nextTasks(db, { scope: 'inst-a' }).map(t => t.id), ['task-a4']);
    assert.deepEqual(runningTasks(db, { scope: 'inst-b' }).map(t => t.id), ['task-b4']);
    assert.equal(runningTasks(db, { scope: 'inst-a' }).length, 0);
  });
});

describe('task-ops resolution + lifecycle', () => {
  it('ambiguous prefix reports matches', () => {
    insertTask(db, spec('task-amb1'));
    insertTask(db, spec('task-amb2'));
    const res = resolveTaskByPrefix(db, 'task-amb');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ambiguous');
    assert.deepEqual(res.matches.sort(), ['task-amb1', 'task-amb2']);
  });

  it('pause requires pending, resume requires paused', () => {
    insertTask(db, spec('task-p1'));
    assert.equal(pauseTask(db, 'task-p1').ok, true);
    assert.equal(db.prepare(`SELECT status FROM tasks WHERE id = 'task-p1'`).get().status, 'paused');
    // Pausing again fails — no longer pending.
    assert.equal(pauseTask(db, 'task-p1').error, 'not_found');
    assert.equal(resumeTask(db, 'task-p1').ok, true);
    assert.equal(db.prepare(`SELECT status FROM tasks WHERE id = 'task-p1'`).get().status, 'pending');
  });

  it('removeTask deletes only the resolved task', () => {
    insertTask(db, spec('task-r1'));
    insertTask(db, spec('task-r2'));
    assert.equal(removeTask(db, 'task-r1').ok, true);
    assert.equal(listTasks(db).length, 1);
  });
});

describe('task-ops updates', () => {
  it('applies whitelisted updates', () => {
    insertTask(db, spec('task-u1'));
    const res = applyTaskUpdates(db, 'task-u1', { name: 'renamed', priority: 1 });
    assert.equal(res.ok, true);
    assert.equal(res.task.name, 'renamed');
    assert.equal(res.task.priority, 1);
  });

  it('rejects non-whitelisted fields', () => {
    insertTask(db, spec('task-u2'));
    const res = applyTaskUpdates(db, 'task-u2', { status: 'completed' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid_field');
    assert.equal(res.field, 'status');
  });

  it('allowRetarget=false blocks target_instance changes (broker path)', () => {
    insertTask(db, spec('task-u3', { target_instance: 'inst-a' }));
    const res = applyTaskUpdates(db, 'task-u3', { target_instance: 'inst-b' }, { scope: 'inst-a', allowRetarget: false });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'retarget_forbidden');
    assert.equal(db.prepare(`SELECT target_instance FROM tasks WHERE id = 'task-u3'`).get().target_instance, 'inst-a');
  });

  it('empty updates object is rejected', () => {
    insertTask(db, spec('task-u4'));
    assert.equal(applyTaskUpdates(db, 'task-u4', {}).error, 'no_updates');
  });
});
