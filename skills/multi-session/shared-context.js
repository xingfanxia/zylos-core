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
 * Usage:
 *   node skills/multi-session/shared-context.js
 *
 * Designed to run standalone (no daemon dependencies). Opens c4.db
 * readonly, writes atomically, and exits cleanly.
 *
 * ESM module — Node 20+.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// ── Constants ──────────────────────────────────────────────────────────

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DB_PATH = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');

// Digest output: shared memory directory (falls back to memory/ root)
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const SHARED_DIR = path.join(MEMORY_DIR, 'shared');
const OUTPUT_DIR = fs.existsSync(SHARED_DIR) ? SHARED_DIR : MEMORY_DIR;
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'recent-activity.md');

const LOOKBACK_HOURS = 24;

// ── Database ───────────────────────────────────────────────────────────

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
 * @param {Database.Database} db
 * @returns {Array<{target_instance: string, channel: string}>}
 */
function queryRecentConversations(db) {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');

  return db.prepare(`
    SELECT target_instance, channel
    FROM conversations
    WHERE direction = 'in'
      AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(cutoff);
}

// ── Analysis ───────────────────────────────────────────────────────────

/**
 * Group conversations by target_instance, counting messages and collecting channels.
 * @param {Array<{target_instance: string, channel: string}>} rows
 * @returns {Map<string, {count: number, channels: Set<string>}>}
 */
function groupByInstance(rows) {
  const groups = new Map();

  for (const row of rows) {
    const instance = row.target_instance || 'admin';
    if (!groups.has(instance)) {
      groups.set(instance, { count: 0, channels: new Set() });
    }
    const group = groups.get(instance);
    group.count += 1;
    group.channels.add(row.channel || 'unknown');
  }

  return groups;
}

// ── Markdown generation ────────────────────────────────────────────────

/**
 * Generate the markdown digest from grouped instance data.
 * @param {Map<string, {count: number, channels: Set<string>}>} groups
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

  // Sort: primary/admin first, then alphabetical
  const sorted = [...groups.entries()].sort((a, b) => {
    if (a[0] === 'admin') return -1;
    if (b[0] === 'admin') return 1;
    if (a[0] === 'group') return -1;
    if (b[0] === 'group') return 1;
    return a[0].localeCompare(b[0]);
  });

  for (const [instanceId, data] of sorted) {
    const isPrimary = instanceId === 'admin';
    const label = isPrimary ? `${instanceId} (primary)` : instanceId;
    lines.push(`## ${label}`);
    lines.push(`${data.count} messages via ${[...data.channels].join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Atomic write ───────────────────────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────────────────

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
      `[shared-context] Digest written: ${instanceCount} instances, ${totalMessages} messages. → ${OUTPUT_FILE}`
    );
  } finally {
    db.close();
  }
}

main();
