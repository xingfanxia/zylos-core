/**
 * C4 Communication Bridge - Multi-Instance Database Queries
 *
 * Instance-filtered database operations for multi-session mode.
 * Imports getDb() from c4-db.js — does not manage its own connection.
 *
 * All queries include a `target_instance IS NULL` fallback so legacy
 * (pre-multi-session) rows are still returned to any requesting instance.
 *
 * @module c4-db-multi
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './c4-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Run pending SQL migrations from the migrations/ directory.
 * Tracks applied migrations in a `_migrations` table. Each .sql file is applied
 * at most once, in sorted filename order. Stops on first failure to avoid
 * partial state.
 *
 * @param {import('better-sqlite3').Database} [database] - database handle; defaults to getDb()
 */
export function runPendingMigrations(database) {
  const db = database ?? getDb();

  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  // Ensure tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    try {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      console.log(`[C4-DB] Applied migration: ${file}`);
    } catch (err) {
      console.error(`[C4-DB] Migration ${file} failed: ${err.message}`);
      // Stop on first failure to avoid partial state
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation queries — instance-filtered
// ---------------------------------------------------------------------------

/**
 * Get the next pending conversation for a specific instance.
 * Returns messages explicitly targeting this instance OR legacy NULL-targeted
 * messages, ordered by priority then timestamp.
 *
 * @param {string} instanceId - the instance ID to filter by
 * @returns {object|null} highest priority pending message, or null
 */
export function getNextPendingForInstance(instanceId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, channel, endpoint_id, content, timestamp,
           priority, require_idle, retry_count, target_instance
    FROM conversations
    WHERE direction = 'in' AND status = 'pending'
      AND (target_instance = ? OR target_instance IS NULL)
    ORDER BY COALESCE(priority, 3) ASC, timestamp ASC
    LIMIT 1
  `).get(instanceId) || null;
}

/**
 * Get the next pending conversation for any of the given online instances.
 * Prefers messages explicitly targeting an online instance, then falls back to
 * legacy NULL-targeted messages. Messages targeting offline instances stay
 * pending until the target comes online.
 *
 * @param {string[]} onlineInstanceIds - array of instance IDs currently online
 * @returns {object|null} highest priority pending message for any online instance, or null
 */
export function getNextPendingForInstances(onlineInstanceIds) {
  const db = getDb();

  if (!onlineInstanceIds || onlineInstanceIds.length === 0) {
    // No instances online — only return legacy NULL-targeted messages
    return db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp,
             priority, require_idle, retry_count, target_instance
      FROM conversations
      WHERE direction = 'in' AND status = 'pending'
        AND target_instance IS NULL
      ORDER BY COALESCE(priority, 3) ASC, timestamp ASC
      LIMIT 1
    `).get() || null;
  }

  // Parameterized IN clause — safe against SQL injection
  const placeholders = onlineInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, direction, channel, endpoint_id, content, timestamp,
           priority, require_idle, retry_count, target_instance
    FROM conversations
    WHERE direction = 'in' AND status = 'pending'
      AND (target_instance IN (${placeholders}) OR target_instance IS NULL)
    ORDER BY COALESCE(priority, 3) ASC, timestamp ASC
    LIMIT 1
  `).get(...onlineInstanceIds) || null;
}

/**
 * Get distinct target instances that currently have pending inbound
 * conversations but are not in the online instance set.
 *
 * Used by the dispatcher to write wake signals before normal delivery
 * selection, so suspended/offline user instances can be restarted when a
 * fresh user message arrives.
 *
 * @param {string[]} onlineInstanceIds - array of instance IDs currently online
 * @returns {Array<{target_instance: string, min_priority: number, oldest_timestamp: string, oldest_id: number}>}
 */
export function getPendingTargetInstancesNeedingWake(onlineInstanceIds) {
  const db = getDb();

  if (!onlineInstanceIds || onlineInstanceIds.length === 0) {
    return db.prepare(`
      SELECT target_instance,
             MIN(COALESCE(priority, 3)) AS min_priority,
             MIN(timestamp) AS oldest_timestamp,
             MIN(id) AS oldest_id
      FROM conversations
      WHERE direction = 'in' AND status = 'pending'
        AND target_instance IS NOT NULL
      GROUP BY target_instance
      ORDER BY min_priority ASC, oldest_timestamp ASC
    `).all();
  }

  const placeholders = onlineInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT target_instance,
           MIN(COALESCE(priority, 3)) AS min_priority,
           MIN(timestamp) AS oldest_timestamp,
           MIN(id) AS oldest_id
    FROM conversations
    WHERE direction = 'in' AND status = 'pending'
      AND target_instance IS NOT NULL
      AND target_instance NOT IN (${placeholders})
    GROUP BY target_instance
    ORDER BY min_priority ASC, oldest_timestamp ASC
  `).all(...onlineInstanceIds);
}

// ---------------------------------------------------------------------------
// Control queue queries — instance-filtered
// ---------------------------------------------------------------------------

/**
 * Get the next pending control item filtered to online instances, with
 * available_at gate.
 *
 * @param {number} currentTimestamp - unix seconds (for available_at comparison)
 * @param {string[]} onlineInstanceIds - array of instance IDs currently online
 * @returns {object|null} next eligible control item, or null
 */
export function getNextPendingControlForInstances(currentTimestamp, onlineInstanceIds) {
  const db = getDb();

  if (!onlineInstanceIds || onlineInstanceIds.length === 0) {
    // No instances online — only return legacy NULL-targeted controls
    return db.prepare(`
      SELECT id, content, priority, require_idle, bypass_state, ack_deadline_at,
             status, retry_count, available_at, last_error, created_at, updated_at,
             target_instance
      FROM control_queue
      WHERE status = 'pending'
        AND (available_at IS NULL OR available_at <= ?)
        AND target_instance IS NULL
      ORDER BY COALESCE(priority, 3) ASC, id ASC
      LIMIT 1
    `).get(currentTimestamp) || null;
  }

  // Parameterized IN clause — safe against SQL injection
  const placeholders = onlineInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at,
           target_instance
    FROM control_queue
    WHERE status = 'pending'
      AND (available_at IS NULL OR available_at <= ?)
      AND (target_instance IN (${placeholders}) OR target_instance IS NULL)
    ORDER BY COALESCE(priority, 3) ASC, id ASC
    LIMIT 1
  `).get(currentTimestamp, ...onlineInstanceIds) || null;
}

// ---------------------------------------------------------------------------
// Status mutations
// ---------------------------------------------------------------------------

/**
 * Mark a conversation as rejected (e.g. targeting a disabled instance).
 *
 * @param {number} id - conversation id
 */
export function markRejected(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('rejected', id);
}

/**
 * Mark a control queue item as rejected (e.g. targeting a disabled instance).
 *
 * @param {number} id - control queue id
 */
export function markControlRejected(id) {
  const db = getDb();
  db.prepare('UPDATE control_queue SET status = ? WHERE id = ?').run('rejected', id);
}

// ---------------------------------------------------------------------------
// Checkpoint queries — instance-filtered
// ---------------------------------------------------------------------------

/**
 * Get the most recent checkpoint for a specific instance.
 * Falls back to global (NULL) checkpoints for backward compatibility.
 *
 * @param {string} instanceId - the instance ID to filter by
 * @returns {object|null} checkpoint record or null
 */
export function getLastCheckpointForInstance(instanceId) {
  const db = getDb();
  return db.prepare(
    `SELECT id, timestamp, summary, start_conversation_id, end_conversation_id, target_instance
     FROM checkpoints
     WHERE target_instance = ? OR target_instance IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(instanceId) || null;
}

/**
 * Create a checkpoint scoped to a specific instance.
 *
 * @param {number} endConversationId - last conversation ID covered
 * @param {string|null} summary - checkpoint summary
 * @param {string} instanceId - target instance ID
 * @returns {object} created checkpoint record
 */
export function createCheckpointForInstance(endConversationId, summary, instanceId) {
  const db = getDb();
  const prevCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE (target_instance = ? OR target_instance IS NULL) ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const startId = prevCheckpoint ? (prevCheckpoint.end_conversation_id || 0) + 1 : 1;
  const stmt = db.prepare('INSERT INTO checkpoints (summary, start_conversation_id, end_conversation_id, target_instance) VALUES (?, ?, ?, ?)');
  const result = stmt.run(summary, startId, endConversationId, instanceId);
  return {
    id: result.lastInsertRowid,
    start_conversation_id: startId,
    end_conversation_id: endConversationId,
    target_instance: instanceId,
    timestamp: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Unsummarized / range queries — instance-filtered
// ---------------------------------------------------------------------------

/**
 * Get range and count of unsummarized conversations for a specific instance.
 * Includes conversations targeting this instance OR legacy NULL target_instance.
 *
 * @param {string} instanceId - the instance ID to filter by
 * @returns {{ begin_id: number|null, end_id: number|null, count: number }}
 */
export function getUnsummarizedRangeForInstance(instanceId) {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? OR target_instance IS NULL ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  const result = db.prepare(`
    SELECT MIN(id) as begin_id, MAX(id) as end_id, COUNT(*) as count
    FROM conversations
    WHERE id > ? AND status = 'delivered' AND (target_instance = ? OR target_instance IS NULL)
  `).get(afterId, instanceId);

  return {
    begin_id: result?.begin_id || null,
    end_id: result?.end_id || null,
    count: result?.count || 0,
  };
}

/**
 * Get unsummarized conversations for a specific instance.
 * Includes conversations targeting this instance OR legacy NULL target_instance.
 *
 * @param {string} instanceId - the instance ID to filter by
 * @param {{ limit?: number }} [opts] - optional limit for most recent N records
 * @returns {object[]} conversation records in chronological order
 */
export function getUnsummarizedConversationsForInstance(instanceId, opts) {
  const db = getDb();
  const limit = opts?.limit ?? null;

  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? OR target_instance IS NULL ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  if (limit) {
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM conversations
        WHERE id > ? AND status = 'delivered' AND (target_instance = ? OR target_instance IS NULL)
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(afterId, instanceId, limit);
  }

  return db.prepare(`
    SELECT * FROM conversations
    WHERE id > ? AND status = 'delivered' AND (target_instance = ? OR target_instance IS NULL)
    ORDER BY id ASC
  `).all(afterId, instanceId);
}

/**
 * Get conversations by id range for a specific instance (inclusive).
 * Includes conversations targeting this instance OR legacy NULL target_instance.
 *
 * @param {number} begin - start conversation id (inclusive)
 * @param {number} end - end conversation id (inclusive)
 * @param {string} instanceId - the instance ID to filter by
 * @returns {object[]} conversation records in chronological order
 */
export function getConversationsByRangeForInstance(begin, end, instanceId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM conversations
    WHERE id >= ? AND id <= ?
      AND (target_instance = ? OR target_instance IS NULL)
    ORDER BY id ASC
  `).all(begin, end, instanceId);
}
