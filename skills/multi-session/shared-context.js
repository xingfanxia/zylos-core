#!/usr/bin/env node
/**
 * Shared Context Digest Generator
 *
 * CLI script (invoked by scheduler every 30 minutes) that reads recent
 * conversations from the C4 database across all instances and writes a
 * rolling digest to ~/zylos/memory/shared/recent-activity.md.
 *
 * The digest gives every instance cross-instance awareness of what other
 * instances have been handling, enabling collaborative context without
 * sharing full conversation history.
 *
 * Privacy rules:
 *  - NO message content or previews for user or group instances
 *  - Scheduler instance: extract task names from [Scheduled Task: id] prefix only
 *  - All instances: message count, channels, last active time
 *  - Group instance: count distinct participants (endpoints)
 *
 * Usage:
 *   node skills/multi-session/shared-context.js
 *
 * Designed to run standalone (no daemon dependencies). Opens c4.db
 * readonly, writes atomically, and exits cleanly.
 *
 * ESM module -- Node 20+.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// -- Constants ---------------------------------------------------------------

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DB_PATH = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');

// Digest output: shared memory directory (falls back to memory/ root)
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SHARED_DIR = path.join(MEMORY_DIR, 'shared');
const OUTPUT_DIR = fs.existsSync(SHARED_DIR) ? SHARED_DIR : MEMORY_DIR;
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'recent-activity.md');

const LOOKBACK_HOURS = 24;
const SCHEDULER_CONTENT_PREVIEW = 150;

// -- Database ----------------------------------------------------------------

/**
 * Open c4.db in readonly mode. Returns null if the database doesn't exist.
 * @returns {Database.Database | null}
 */
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[shared-context] Database not found: ${DB_PATH}`);
    return null;
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    console.error(`[shared-context] Failed to open database: ${err.message}`);
    return null;
  }
}

/**
 * Query recent inbound conversations grouped by target_instance.
 * Includes content column (used only for scheduler task-name extraction)
 * and endpoint_id (used for group participant counting).
 *
 * @param {Database.Database} db
 * @returns {Array<{target_instance: string, channel: string, content: string, endpoint_id: string|null, timestamp: string}>}
 */
function queryRecentConversations(db) {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');

  return db.prepare(`
    SELECT target_instance, channel, content, endpoint_id, timestamp
    FROM conversations
    WHERE direction = 'in'
      AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(cutoff);
}

// -- Analysis ----------------------------------------------------------------

/**
 * @typedef {Object} InstanceActivity
 * @property {number} count
 * @property {Set<string>} channels
 * @property {Set<string>} taskNames - scheduler only: extracted task names
 * @property {Set<string>} participants - group only: distinct endpoint_ids
 * @property {string|null} lastActive - ISO timestamp of most recent message
 */

/**
 * Group conversations by target_instance with enriched metadata.
 * @param {Array<{target_instance: string, channel: string, content: string, endpoint_id: string|null, timestamp: string}>} rows
 * @returns {Map<string, InstanceActivity>}
 */
function groupByInstance(rows) {
  const groups = new Map();

  for (const row of rows) {
    const instance = row.target_instance || 'admin';
    if (!groups.has(instance)) {
      groups.set(instance, {
        count: 0,
        channels: new Set(),
        taskNames: new Set(),
        participants: new Set(),
        lastActive: null
      });
    }
    const group = groups.get(instance);
    group.count += 1;
    group.channels.add(row.channel || 'unknown');

    // Track last active time (rows are ordered DESC, so first hit is latest)
    if (!group.lastActive) {
      group.lastActive = row.timestamp;
    }

    // Scheduler instance: extract task names from [Scheduled Task: id] prefix
    if (instance === 'scheduler' && row.content) {
      const preview = row.content.substring(0, SCHEDULER_CONTENT_PREVIEW);
      const match = preview.match(/\[Scheduled Task:\s*([^\]]+)\]/);
      if (match) {
        group.taskNames.add(match[1].trim());
      }
    }

    // Group instance: count distinct participants (endpoints)
    if (instance === 'group' && row.endpoint_id) {
      group.participants.add(row.endpoint_id);
    }
  }

  return groups;
}

// -- Markdown generation -----------------------------------------------------

/**
 * Format a timestamp for display (HH:MM UTC).
 * @param {string|null} ts - SQLite timestamp string
 * @returns {string}
 */
function formatTime(ts) {
  if (!ts) return 'unknown';
  try {
    // SQLite timestamps may or may not have T separator
    const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return 'unknown';
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  } catch {
    return 'unknown';
  }
}

/**
 * Determine instance config to check primary status.
 * Returns null in single-session mode.
 */
function loadInstanceConfig() {
  try {
    const configPath = path.join(ZYLOS_DIR, 'instances.json');
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Generate the markdown digest from grouped instance data.
 * @param {Map<string, InstanceActivity>} groups
 * @returns {string}
 */
function generateDigest(groups) {
  const now = new Date();
  const utcStr = now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

  const lines = [
    '# Cross-Instance Activity Digest',
    `Updated: ${utcStr}`,
    ''
  ];

  if (groups.size === 0) {
    lines.push('No activity in the last 24 hours.');
    lines.push('');
    return lines.join('\n');
  }

  const config = loadInstanceConfig();

  // Sort: admin first, then scheduler, then group, then alphabetical
  const sorted = [...groups.entries()].sort((a, b) => {
    const order = { admin: 0, scheduler: 1, group: 2 };
    const oa = order[a[0]] ?? 3;
    const ob = order[b[0]] ?? 3;
    if (oa !== ob) return oa - ob;
    return a[0].localeCompare(b[0]);
  });

  for (const [instanceId, data] of sorted) {
    const isPrimary = config?.instances?.[instanceId]?.primary === true;
    const label = isPrimary ? `${instanceId} (primary)` : instanceId;
    lines.push(`## ${label}`);

    if (instanceId === 'scheduler') {
      // Scheduler: show completed task names
      if (data.taskNames.size > 0) {
        lines.push(`- ${data.count} tasks completed: ${[...data.taskNames].join(', ')}`);
      } else {
        lines.push(`- ${data.count} tasks dispatched`);
      }
    } else if (instanceId === 'group') {
      // Group: message count, channels, participants, last active
      lines.push(`- ${data.count} messages via ${[...data.channels].join(', ')}`);
      if (data.participants.size > 0) {
        lines.push(`- ${data.participants.size} active participants`);
      }
      lines.push(`- Last active: ${formatTime(data.lastActive)}`);
    } else {
      // User/admin instances: message count, channels, last active (NO content)
      lines.push(`- ${data.count} messages via ${[...data.channels].join(', ')}`);
      lines.push(`- Last active: ${formatTime(data.lastActive)}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// -- Atomic write ------------------------------------------------------------

/**
 * Write content to a file atomically (write to .tmp, then rename).
 * Creates parent directories if needed.
 * @param {string} filePath
 * @param {string} content
 */
function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// -- Main --------------------------------------------------------------------

function main() {
  const db = openDb();
  if (!db) {
    writeAtomic(OUTPUT_FILE, '# Cross-Instance Activity Digest\nNo data available (database not found).\n');
    console.log('[shared-context] No database found, wrote empty digest.');
    process.exit(0);
  }

  try {
    const rows = queryRecentConversations(db);
    const groups = groupByInstance(rows);
    const digest = generateDigest(groups);

    writeAtomic(OUTPUT_FILE, digest);

    const instanceCount = groups.size;
    const totalMessages = [...groups.values()].reduce((sum, g) => sum + g.count, 0);
    console.log(
      `[shared-context] Digest written: ${instanceCount} instances, ${totalMessages} messages. -> ${OUTPUT_FILE}`
    );
  } finally {
    db.close();
  }
}

main();
