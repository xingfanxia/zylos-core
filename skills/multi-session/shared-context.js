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
const MAX_CONTENT_CHARS = 100; // chars per message for keyword extraction
const MAX_KEYWORDS_PER_INSTANCE = 10;

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
 * @returns {Array<{target_instance: string, channel: string, endpoint_id: string, content: string, timestamp: string}>}
 */
function queryRecentConversations(db) {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');

  const stmt = db.prepare(`
    SELECT target_instance, channel, endpoint_id, content, timestamp
    FROM conversations
    WHERE direction = 'in'
      AND timestamp > ?
    ORDER BY timestamp DESC
  `);

  return stmt.all(cutoff);
}

// ── Analysis ───────────────────────────────────────────────────────────

/**
 * Extract simple keywords from a message snippet.
 * Strips common noise words and returns meaningful tokens.
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text) return [];
  const snippet = text.slice(0, MAX_CONTENT_CHARS);
  // Remove URLs, mentions, common punctuation
  const cleaned = snippet
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\S+/g, '')
    .replace(/[^\w\s\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
    .trim();

  // Split on whitespace, filter short/noise words
  const noiseWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'and', 'or', 'but', 'not', 'no', 'so', 'if', 'then',
    'this', 'that', 'it', 'its', 'my', 'your', 'his', 'her',
    'we', 'they', 'you', 'i', 'me', 'us', 'them',
    'said', 'just', 'like', 'also', 'very', 'really',
    'de', 'la', 'le', 'les', 'des', 'du', 'un', 'une',
    // Chinese particles
    '的', '了', '在', '是', '我', '你', '他', '她', '它',
    '们', '这', '那', '有', '和', '就', '不', '也', '都',
    '会', '能', '可以', '要', '吗', '呢', '啊', '吧'
  ]);

  const tokens = cleaned.split(/\s+/).filter(t =>
    t.length > 1 && !noiseWords.has(t.toLowerCase())
  );

  return [...new Set(tokens)];
}

/**
 * Group conversations by target_instance and generate per-instance summaries.
 * @param {Array} rows - query results
 * @returns {Map<string, {count: number, channels: Set<string>, keywords: string[]}>}
 */
function groupByInstance(rows) {
  /** @type {Map<string, {count: number, channels: Set<string>, allKeywords: string[]}>} */
  const groups = new Map();

  for (const row of rows) {
    const instance = row.target_instance || 'admin';
    if (!groups.has(instance)) {
      groups.set(instance, { count: 0, channels: new Set(), allKeywords: [] });
    }
    const group = groups.get(instance);
    group.count += 1;

    // Track channel names (use endpoint_id for more descriptive names)
    const channelLabel = row.channel || 'unknown';
    group.channels.add(channelLabel);

    // Collect keywords from message content
    const kws = extractKeywords(row.content);
    group.allKeywords.push(...kws);
  }

  // Deduplicate and limit keywords per instance
  for (const [, group] of groups) {
    // Count keyword frequency, take top N
    const freq = new Map();
    for (const kw of group.allKeywords) {
      freq.set(kw, (freq.get(kw) || 0) + 1);
    }
    const sorted = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYWORDS_PER_INSTANCE)
      .map(([kw]) => kw);
    group.keywords = sorted;
    delete group.allKeywords;
  }

  return groups;
}

// ── Markdown generation ────────────────────────────────────────────────

/**
 * Generate the markdown digest from grouped instance data.
 * @param {Map<string, object>} groups
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

    const channelList = [...data.channels].join(', ');
    lines.push(`- ${data.count} messages via ${channelList}`);

    if (data.keywords.length > 0) {
      lines.push(`- Topics: ${data.keywords.join(', ')}`);
    }

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
    // No database — write an empty digest so the file exists but is benign
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
