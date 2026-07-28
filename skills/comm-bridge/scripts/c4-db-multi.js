/**
 * C4 Communication Bridge - Multi-Instance Database Queries
 *
 * Instance-filtered database operations for multi-session mode.
 * Imports getDb() from c4-db.js — does not manage its own connection.
 *
 * Dispatch queries (getNextPending*) include a `target_instance IS NULL`
 * fallback so legacy pre-multi-session rows still get delivered. Checkpoint,
 * unsummarized, and range queries are STRICTLY scoped (target_instance = id,
 * no NULL fallback) — the fallback there leaked one instance's context into
 * another's session-init (fixed 2026-07-08).
 *
 * @module c4-db-multi
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './c4-db.js';
import { groupKeyFromEndpoint } from '../../multi-session/c4-helpers.js';

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
      try {
        db.exec(sql);
      } catch (err) {
        // Idempotent: init-db.sql creates the multi-session columns up front, so
        // ADD COLUMN migrations hit "duplicate column name" on a fresh DB — the
        // effect already exists, so mark applied and continue rather than aborting.
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
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
 *
 * STRICTLY instance-scoped: NULL-targeted checkpoints are NOT returned. They
 * were a "legacy compatibility" fallback, but the checkpoint-creation path now
 * writes NULL-targeted rows in practice (247 observed 2026-07-08), so the
 * fallback leaked one instance's summary into another's session-init (e.g. limh
 * receiving Elaine's summary). New checkpoints are always instance-scoped
 * (broker forces target_instance = caller); legacy NULL rows are inert.
 *
 * @param {string} instanceId - the instance ID to filter by
 * @returns {object|null} checkpoint record or null
 */
export function getLastCheckpointForInstance(instanceId) {
  const db = getDb();
  return db.prepare(
    `SELECT id, timestamp, summary, start_conversation_id, end_conversation_id, target_instance
     FROM checkpoints
     WHERE target_instance = ?
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
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? ORDER BY id DESC LIMIT 1'
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
 * Strictly scoped: only rows with target_instance = instanceId (NULL-target
 * rows are excluded to prevent cross-instance context bleed).
 *
 * @param {string} instanceId - the instance ID to filter by
 * @returns {{ begin_id: number|null, end_id: number|null, count: number }}
 */
export function getUnsummarizedRangeForInstance(instanceId) {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  // Only include messages explicitly targeting this instance.
  // Exclude NULL-targeted rows (legacy/outgoing) to prevent cross-instance context bleed.
  const result = db.prepare(`
    SELECT MIN(id) as begin_id, MAX(id) as end_id, COUNT(*) as count
    FROM conversations
    WHERE id > ? AND status = 'delivered' AND target_instance = ?
  `).get(afterId, instanceId);

  return {
    begin_id: result?.begin_id || null,
    end_id: result?.end_id || null,
    count: result?.count || 0,
  };
}

/**
 * Get unsummarized conversations for a specific instance.
 * Strictly scoped: only rows with target_instance = instanceId (NULL-target
 * rows are excluded to prevent cross-instance context bleed).
 *
 * @param {string} instanceId - the instance ID to filter by
 * @param {{ limit?: number }} [opts] - optional limit for most recent N records
 * @returns {object[]} conversation records in chronological order
 */
export function getUnsummarizedConversationsForInstance(instanceId, opts) {
  const db = getDb();
  const limit = opts?.limit ?? null;

  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  // Only include messages explicitly targeting this instance.
  // Exclude NULL-targeted rows (legacy/outgoing) to prevent cross-instance context bleed.
  if (limit) {
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM conversations
        WHERE id > ? AND status = 'delivered' AND target_instance = ?
        ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(afterId, instanceId, limit);
  }

  return db.prepare(`
    SELECT * FROM conversations
    WHERE id > ? AND status = 'delivered' AND target_instance = ?
    ORDER BY id ASC
  `).all(afterId, instanceId);
}

/**
 * Get conversations by id range for a specific instance (inclusive).
 * Strictly scoped: only rows with target_instance = instanceId (NULL-target
 * rows are excluded to prevent cross-instance context bleed).
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
      AND target_instance = ?
    ORDER BY id ASC
  `).all(begin, end, instanceId);
}

/**
 * Find delivered-but-unanswered inbound user messages for an instance.
 *
 * A message can be marked 'delivered' (the dispatcher pasted keystrokes and
 * verified the input box cleared) yet never actually be PROCESSED — if the
 * instance was not-logged-in, frozen, or got restarted before acting on it.
 * Such a message is then silently lost: on the next session it reappears only
 * as passive RECENT-CONVERSATIONS context, not as something needing a reply
 * (this is exactly how a group @-mention went unanswered on 2026-07-09). This
 * surfaces those so session-init can flag them as ACTION-REQUIRED.
 *
 * "Unanswered" = no outbound row to the same chat (groupKeyFromEndpoint) with a
 * later id. Scoped to the instance, replyable (endpoint_id not null), real
 * channels only (void/system excluded), and only since the last checkpoint so
 * once answered or summarized they drop off (no perpetual nagging).
 *
 * @param {string} instanceId
 * @returns {object[]} unanswered inbound rows, chronological
 */
export function getUnansweredDeliveredForInstance(instanceId) {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints WHERE target_instance = ? ORDER BY id DESC LIMIT 1'
  ).get(instanceId);
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  const inbound = db.prepare(`
    SELECT id, channel, endpoint_id, content, timestamp
    FROM conversations
    WHERE direction = 'in' AND status = 'delivered'
      AND endpoint_id IS NOT NULL
      AND target_instance = ?
      AND channel NOT IN ('void', 'system')
      AND id > ?
    ORDER BY id ASC
  `).all(instanceId, afterId);
  if (inbound.length === 0) return [];

  // Outbound rows from the earliest candidate onward tell us which chats have
  // since been replied to (and how recently). Only rows that could plausibly be
  // a real answer count:
  //  - real channels only (a void handoff / system row is never a user reply)
  //  - status != 'failed' (c4-send/broker mark rows whose channel send failed —
  //    the user never received those, so they must not mask the inbound)
  //  - not a health status-notice (the automated "please resend" auto-reply is
  //    sent precisely BECAUSE the message wasn't processed — counting it as an
  //    answer would hide exactly the messages this function exists to find)
  // Keyed by channel+chat so a chat-id collision across channels (telegram
  // numeric id vs another channel's prefix) can't cross-mask.
  const outbound = db.prepare(`
    SELECT id, channel, endpoint_id FROM conversations
    WHERE direction = 'out' AND id >= ?
      AND channel NOT IN ('void', 'system')
      AND status != 'failed'
      AND (delivery_action IS NULL OR delivery_action != 'status-notice')
  `).all(inbound[0].id);
  const lastReplyIdByChat = new Map();
  for (const o of outbound) {
    const chat = groupKeyFromEndpoint(o.endpoint_id);
    if (!chat) continue;
    const key = `${o.channel}:${chat}`;
    const prev = lastReplyIdByChat.get(key) || 0;
    if (o.id > prev) lastReplyIdByChat.set(key, o.id);
  }

  // Unanswered iff no outbound to this chat has a later id than the message.
  //
  // Known conservative limits (deliberate — reply provenance does not exist in
  // the schema: an out-row does not say WHICH inbound it answers):
  //  - per-chat granularity: a real later reply to the same chat also clears
  //    earlier unanswered messages in that chat (two questions, one answer —
  //    the earlier asker is not re-surfaced). Fixing this needs reply-to
  //    metadata threaded through every channel send.
  //  - checkpoint boundary: once Memory Sync summarizes past a message it is
  //    treated as handled (the agent demonstrably saw it during sync).
  return inbound.filter((m) => {
    const chat = groupKeyFromEndpoint(m.endpoint_id);
    if (!chat) return false;
    return (lastReplyIdByChat.get(`${m.channel}:${chat}`) || 0) <= m.id;
  });
}

// ---------------------------------------------------------------------------
// Group-instance segmentation (pure — no DB)
// ---------------------------------------------------------------------------

/**
 * Segment a flat list of conversation rows into per-group buckets for the group
 * instance's session-init injection. Pure — no DB access, so it unit-tests with
 * synthetic rows.
 *
 * Grouping key = groupKeyFromEndpoint(row.endpoint_id). Rows with a null key
 * (system/scheduler notifications targeting the group instance) collapse into a
 * single trailing "(system / ungrouped)" bucket. Buckets are ordered
 * most-recently-active first (by the max row id seen), with the null-key bucket
 * always sunk to the end. Each bucket keeps only its most recent `perGroupLimit`
 * rows, restored to ascending (oldest-first) order. At most `maxGroups` buckets
 * are returned; the remainder are counted in `omittedGroups`.
 *
 * @param {Array<{id:number, endpoint_id?:string|null}>} conversations - id-ascending rows
 * @param {{ perGroupLimit?: number, maxGroups?: number }} [opts]
 * @returns {{ buckets: Array<{key:string|null, label:string, lastId:number, count:number, conversations:object[]}>, omittedGroups: number, totalGroups: number }}
 */
export function groupConversationsByGroup(conversations, opts = {}) {
  const perGroupLimit = opts.perGroupLimit ?? Infinity;
  const maxGroups = opts.maxGroups ?? Infinity;

  // Map keyed on the group key (null included — Map handles null keys) so all
  // system/ungrouped rows share one bucket.
  const map = new Map();
  for (const row of conversations || []) {
    const key = groupKeyFromEndpoint(row.endpoint_id);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, rows: [], lastId: 0 };
      map.set(key, bucket);
    }
    bucket.rows.push(row);
    if (row.id > bucket.lastId) bucket.lastId = row.id;
  }

  // Order most-recently-active first; the null-key (system) bucket sinks last.
  const ordered = [...map.values()].sort((a, b) => {
    const aSys = a.key === null;
    const bSys = b.key === null;
    if (aSys !== bSys) return aSys ? 1 : -1;
    return b.lastId - a.lastId;
  });

  const shown = ordered.slice(0, maxGroups);
  const omittedGroups = ordered.length - shown.length;

  const buckets = shown.map((b) => {
    const count = b.rows.length;
    const kept = (perGroupLimit === Infinity || count <= perGroupLimit)
      ? b.rows
      : b.rows.slice(count - perGroupLimit);
    return {
      key: b.key,
      label: b.key === null ? '(system / ungrouped)' : b.key,
      lastId: b.lastId,
      count,
      conversations: kept,
    };
  });

  return { buckets, omittedGroups, totalGroups: ordered.length };
}
