/**
 * Mechanical pre-check for the operator's internal scheduled jobs. When such a
 * job has nothing new to read since its last completed run, the daemon records
 * the run as skipped instead of dispatching it, so it costs no model turn.
 *
 * Internal jobs are recognized by their exact task name, as the operator set
 * them up. Every other task, including anything a user asked for (reminders,
 * daily products), always runs.
 *
 *   instance-dream-<id>, targeting <id>: consolidation of one instance's
 *     memory. Skipped when <id> received no user message and nothing under
 *     memory/instances/<id> (and memory/groups for a group instance) changed.
 *   shared-memory-dream: consolidation of shared memory. Skipped when nothing
 *     in memory/ outside instances/ and groups/ changed.
 *   daily-product-sweep: product context for group chats. Skipped when no
 *     group instance received a user message in PRODUCT_SWEEP_QUIET_DAYS.
 *
 * Whatever the check cannot establish (no completed run in the history, an
 * unreadable directory, no c4.db, no group instance) means the job runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const PRODUCT_SWEEP_QUIET_DAYS = 14;

/** Last completed (or skipped) run of the task, epoch seconds, or null. */
export function lastSuccessAt(db, taskId) {
  return db.prepare(`
    SELECT MAX(completed_at) AS at FROM task_history WHERE task_id = ? AND status = 'success'
  `).get(taskId)?.at ?? null;
}

/** User messages (any channel but system/scheduler) received by these instances after `since`; null if c4.db cannot be read. */
export function countInbound(c4DbPath, instanceIds, since) {
  let c4;
  try {
    c4 = new Database(c4DbPath, { readonly: true, fileMustExist: true });
    return c4.prepare(`
      SELECT COUNT(*) AS n FROM conversations
      WHERE direction = 'in' AND channel NOT IN ('system', 'scheduler')
        AND target_instance IN (${instanceIds.map(() => '?').join(', ')})
        AND timestamp > datetime(?, 'unixepoch')
    `).get(...instanceIds, since).n;
  } catch {
    return null;
  } finally {
    c4?.close();
  }
}

/** True if anything under `dirs` (outside .git and `skip`) was modified after `since`, or cannot be read. */
export function changedSince(dirs, since, { skip = [] } = {}) {
  const sinceMs = since * 1000;
  const walk = (dir) => {
    let entries;
    try {
      if (fs.lstatSync(dir).mtimeMs > sinceMs) return true;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return err.code !== 'ENOENT';
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.git' || skip.includes(full)) continue;
      if (entry.isDirectory()) {
        if (walk(full)) return true;
        continue;
      }
      try {
        if (fs.lstatSync(full).mtimeMs > sinceMs) return true;
      } catch (err) {
        if (err.code !== 'ENOENT') return true;
      }
    }
    return false;
  };
  return dirs.some(walk);
}

/**
 * Why an internal task has nothing to do now, or null when it must run.
 * @param {object} task - scheduler task row
 * @param {object} deps - { lastSuccessAt(taskId), countInbound(ids, since), changedSince(dirs, since, opts), instances, memoryDir, now }
 */
export function skipReason(task, deps) {
  const { instances, memoryDir, now } = deps;
  const dream = /^instance-dream-(.+)$/.exec(task.name || '');

  if (dream && task.target_instance === dream[1]) {
    const id = dream[1];
    const since = deps.lastSuccessAt(task.id);
    if (since == null) return null;
    if (deps.countInbound([id], since) !== 0) return null;
    const dirs = [path.join(memoryDir, 'instances', id)];
    if (instances.find(inst => inst.id === id)?.type === 'group') dirs.push(path.join(memoryDir, 'groups'));
    if (deps.changedSince(dirs, since)) return null;
    return `no user message and no memory change for ${id} since the last run`;
  }

  if (task.name === 'shared-memory-dream') {
    const since = deps.lastSuccessAt(task.id);
    if (since == null) return null;
    const skip = ['instances', 'groups'].map(name => path.join(memoryDir, name));
    if (deps.changedSince([memoryDir], since, { skip })) return null;
    return 'no shared memory change since the last run';
  }

  if (task.name === 'daily-product-sweep') {
    const groups = instances.filter(inst => inst.type === 'group').map(inst => inst.id);
    if (groups.length === 0) return null;
    if (deps.countInbound(groups, now - PRODUCT_SWEEP_QUIET_DAYS * 86400) !== 0) return null;
    return `no user message to a group chat in ${PRODUCT_SWEEP_QUIET_DAYS} days`;
  }

  return null;
}
