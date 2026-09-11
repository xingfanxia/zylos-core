/**
 * Task Operations — shared core for the scheduler CLI and the C4 broker.
 *
 * Every function takes an open better-sqlite3 handle and an optional `scope`
 * (instance id). With scope set, every lookup and mutation is restricted to
 * tasks WHERE target_instance = scope — the broker passes the socket-derived
 * caller id, so isolated agents can only see and touch their own tasks.
 * scope = null (admin/scheduler direct path) applies no filter.
 *
 * Functions return plain data ({ ok, ... }); callers own all formatting.
 */

/** Escape special LIKE pattern characters in user input */
export function escapeLike(str) {
  return str.replace(/[%_!]/g, '!$&');
}

/** Allowed columns for applyTaskUpdates — mirrors the CLI surface. */
export const ALLOWED_UPDATE_COLUMNS = new Set([
  'name', 'prompt', 'priority', 'require_idle', 'reply_channel', 'reply_endpoint',
  'miss_threshold', 'type', 'cron_expression', 'interval_seconds', 'next_run_at', 'timezone', 'updated_at',
  'target_instance'
]);

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function scopeSql(scope) {
  return scope ? ' AND target_instance = ?' : '';
}

function scopeParams(scope) {
  return scope ? [scope] : [];
}

/**
 * Resolve a task by exact-or-prefix id.
 * @param {object} db - better-sqlite3 handle
 * @param {string} prefix - task id or unique prefix
 * @param {{ scope?: string|null, status?: string|null }} [opts]
 * @returns {{ok:true, task:object} | {ok:false, error:'not_found'|'ambiguous', matches?:string[]}}
 */
export function resolveTaskByPrefix(db, prefix, { scope = null, status = null } = {}) {
  let sql = `SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'` + scopeSql(scope);
  const params = [escapeLike(prefix) + '%', ...scopeParams(scope)];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  const tasks = db.prepare(sql).all(...params);
  if (tasks.length === 0) return { ok: false, error: 'not_found' };
  if (tasks.length > 1) return { ok: false, error: 'ambiguous', matches: tasks.map(t => t.id) };
  return { ok: true, task: tasks[0] };
}

/** Active tasks (same predicate the CLI list has always used). */
export function listTasks(db, { scope = null, replyChannel = null } = {}) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE (status != 'completed' OR type != 'one-time')${scopeSql(scope)}${replyChannel ? ' AND reply_channel = ?' : ''}
    ORDER BY priority ASC, next_run_at ASC
  `).all(...scopeParams(scope), ...(replyChannel ? [replyChannel] : []));
}

/**
 * Insert a fully-validated task spec. Callers validate timing/priority
 * (DB CHECK constraints are the backstop); the broker forces
 * spec.target_instance = caller before calling this.
 * @returns {{ok:true, task:object}}
 */
export function insertTask(db, spec) {
  db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type,
      cron_expression, interval_seconds,
      next_run_at, priority, status,
      require_idle, miss_threshold,
      reply_channel, reply_endpoint,
      created_at, updated_at, timezone,
      target_instance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.id, spec.name, spec.prompt, spec.type,
    spec.cron_expression ?? null, spec.interval_seconds ?? null,
    spec.next_run_at, spec.priority,
    spec.require_idle ? 1 : 0, spec.miss_threshold,
    spec.reply_channel ?? null, spec.reply_endpoint ?? null,
    spec.created_at, spec.updated_at, spec.timezone,
    spec.target_instance ?? null
  );
  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(spec.id) };
}

/**
 * Mark a task completed and close its open history entry.
 * @returns {{ok:true, task:object} | {ok:false, error, matches?}}
 */
export function completeTask(db, prefix, { scope = null } = {}) {
  const resolved = resolveTaskByPrefix(db, prefix, { scope });
  if (!resolved.ok) return resolved;
  const task = resolved.task;
  const currentTime = nowSec();

  db.prepare(`
    UPDATE tasks
    SET status = 'completed', last_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(currentTime, currentTime, task.id);

  const historyEntry = db.prepare(`
    SELECT id, executed_at FROM task_history
    WHERE task_id = ? AND status = 'started'
    ORDER BY executed_at DESC LIMIT 1
  `).get(task.id);

  if (historyEntry) {
    const durationMs = (currentTime - historyEntry.executed_at) * 1000;
    db.prepare(`
      UPDATE task_history
      SET status = 'success', completed_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(currentTime, durationMs, historyEntry.id);
  }

  return { ok: true, task };
}

/** @returns {{ok:true, task:object} | {ok:false, error, matches?}} */
export function removeTask(db, prefix, { scope = null } = {}) {
  const resolved = resolveTaskByPrefix(db, prefix, { scope });
  if (!resolved.ok) return resolved;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(resolved.task.id);
  return { ok: true, task: resolved.task };
}

/** Pause a pending task. @returns {{ok:true, task} | {ok:false, error, matches?}} */
export function pauseTask(db, prefix, { scope = null } = {}) {
  const resolved = resolveTaskByPrefix(db, prefix, { scope, status: 'pending' });
  if (!resolved.ok) return resolved;
  db.prepare(`UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?`)
    .run(nowSec(), resolved.task.id);
  return { ok: true, task: resolved.task };
}

/** Resume a paused task. @returns {{ok:true, task} | {ok:false, error, matches?}} */
export function resumeTask(db, prefix, { scope = null } = {}) {
  const resolved = resolveTaskByPrefix(db, prefix, { scope, status: 'paused' });
  if (!resolved.ok) return resolved;
  db.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`)
    .run(nowSec(), resolved.task.id);
  return { ok: true, task: resolved.task };
}

/**
 * Execution history (latest 20), optionally narrowed by task-id prefix.
 * @returns {{entries:object[], prefixMatches:string[]}}
 */
export function taskHistory(db, { scope = null, prefix = null } = {}) {
  let sql = `
    SELECT h.*, t.name, t.prompt
    FROM task_history h
    JOIN tasks t ON h.task_id = t.id
    WHERE 1=1${scope ? ' AND t.target_instance = ?' : ''}
  `;
  const params = [...scopeParams(scope)];
  let prefixMatches = [];

  if (prefix) {
    sql += ` AND h.task_id LIKE ? ESCAPE '!'`;
    params.push(escapeLike(prefix) + '%');
    prefixMatches = db.prepare(
      `SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!'` + scopeSql(scope)
    ).all(escapeLike(prefix) + '%', ...scopeParams(scope)).map(t => t.id);
  }

  sql += ' ORDER BY h.executed_at DESC LIMIT 20';
  return { entries: db.prepare(sql).all(...params), prefixMatches };
}

/** Count a scope's non-terminal tasks (for per-instance add caps). */
export function countActiveTasks(db, { scope = null } = {}) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending','running','paused')${scopeSql(scope)}`
  ).get(...scopeParams(scope)).n;
}

/** Next pending tasks (up to 5). */
export function nextTasks(db, { scope = null } = {}) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'${scopeSql(scope)}
    ORDER BY next_run_at ASC
    LIMIT 5
  `).all(...scopeParams(scope));
}

/** Currently running tasks. */
export function runningTasks(db, { scope = null } = {}) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'running'${scopeSql(scope)}
    ORDER BY updated_at ASC
  `).all(...scopeParams(scope));
}

/**
 * Apply a validated updates object to a task.
 * With allowRetarget=false (broker path), target_instance changes are
 * rejected — retargeting would be a cross-instance message primitive.
 * @returns {{ok:true, task} | {ok:false, error:'not_found'|'ambiguous'|'invalid_field'|'retarget_forbidden'|'no_updates', matches?, field?}}
 */
export function applyTaskUpdates(db, prefix, updates, { scope = null, allowRetarget = true } = {}) {
  const resolved = resolveTaskByPrefix(db, prefix, { scope });
  if (!resolved.ok) return resolved;

  if (!allowRetarget && 'target_instance' in updates) {
    return { ok: false, error: 'retarget_forbidden' };
  }
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, error: 'no_updates' };
  for (const key of keys) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
      return { ok: false, error: 'invalid_field', field: key };
    }
  }

  const merged = { ...updates, updated_at: nowSec() };
  const setClauses = Object.keys(merged).map(key => `${key} = ?`).join(', ');
  db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`)
    .run(...Object.values(merged), resolved.task.id);

  return { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(resolved.task.id) };
}
