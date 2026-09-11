/**
 * Token Tracker — per-instance token usage recording and querying.
 *
 * Stores usage data in SQLite at ~/zylos/activity-monitor/token-usage.db.
 * Uses better-sqlite3 resolved from a sibling skill (comm-bridge or scheduler)
 * that already has it installed.
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DB_PATH = path.join(ZYLOS_DIR, 'activity-monitor', 'token-usage.db');

// ---------------------------------------------------------------------------
// Resolve better-sqlite3 from sibling skills
// ---------------------------------------------------------------------------

let Database = null;

function loadDatabase() {
  if (Database) return Database;

  // Try multiple resolution paths for better-sqlite3
  const candidates = [
    // Production: installed skills
    path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge'),
    path.join(ZYLOS_DIR, '.claude', 'skills', 'scheduler'),
    // Development: source tree
    path.join(__dirname, '..', '..', 'comm-bridge'),
    path.join(__dirname, '..', '..', 'scheduler'),
  ];

  for (const base of candidates) {
    try {
      const require = createRequire(path.join(base, 'package.json'));
      Database = require('better-sqlite3');
      return Database;
    } catch {
      // Try next candidate
    }
  }

  console.error('[TokenTracker] better-sqlite3 not found — token tracking disabled');
  return null;
}

// ---------------------------------------------------------------------------
// DB initialization
// ---------------------------------------------------------------------------

let db = null;

function getDb() {
  if (db) return db;

  const Ctor = loadDatabase();
  if (!Ctor) return null;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Ctor(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      date TEXT NOT NULL,
      chat_id TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(instance_id, date)
    )
  `);

  // Migrate existing databases: add columns if missing (idempotent)
  try {
    db.exec(`ALTER TABLE token_usage ADD COLUMN chat_id TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE token_usage ADD COLUMN cache_write_tokens INTEGER DEFAULT 0`);
  } catch { /* column already exists */ }

  // Create UNIQUE index for upsert support (idempotent — CREATE TABLE UNIQUE handles new DBs,
  // this handles pre-existing DBs that lack the constraint)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_instance_date_unique ON token_usage (instance_id, date)`);
  } catch { /* constraint already exists from CREATE TABLE */ }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_instance_date
    ON token_usage (instance_id, date)
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _recordWarnedOnce = false;

/**
 * Close the SQLite connection if open.
 */
export function closeDb() {
  if (db) {
    try {
      db.close();
    } catch { /* best-effort */ }
    db = null;
  }
}

/**
 * Record a token usage event.
 *
 * Uses INSERT ... ON CONFLICT to upsert daily aggregates per instance.
 * The UNIQUE(instance_id, date) constraint ensures one row per instance per day.
 *
 * @param {string} instanceId
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} model
 * @param {number} costUsd
 * @param {object} [opts] - Optional additional fields
 * @param {string} [opts.chatId] - Routing chat_id for per-user attribution
 * @param {number} [opts.cacheReadTokens] - Cache read tokens
 * @param {number} [opts.cacheWriteTokens] - Cache write tokens
 */
export function recordTokenUsage(instanceId, inputTokens, outputTokens, model, costUsd, opts = {}) {
  try {
    const d = getDb();
    if (!d) {
      if (!_recordWarnedOnce) {
        console.error('[TokenTracker] DB unavailable — token usage not recorded');
        _recordWarnedOnce = true;
      }
      return;
    }

    const date = new Date().toISOString().substring(0, 10);
    const chatId = opts.chatId || null;
    const cacheRead = opts.cacheReadTokens || 0;
    const cacheWrite = opts.cacheWriteTokens || 0;

    d.prepare(`
      INSERT INTO token_usage (instance_id, date, chat_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, date) DO UPDATE SET
        chat_id = COALESCE(excluded.chat_id, chat_id),
        model = excluded.model,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `).run(instanceId, date, chatId, model || 'unknown', inputTokens || 0, outputTokens || 0, cacheRead, cacheWrite, costUsd || 0);
  } catch {
    // Best-effort — never interfere with Claude.
  }
}

/**
 * Get aggregated usage for a given instance and date.
 *
 * @param {string} instanceId
 * @param {string} date - YYYY-MM-DD
 * @returns {{ input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, cost_usd: number, requests: number } | null}
 */
export function getDailyUsage(instanceId, date) {
  try {
    const d = getDb();
    if (!d) return null;

    return d.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COUNT(*) as requests
      FROM token_usage
      WHERE instance_id = ? AND date = ?
    `).get(instanceId, date);
  } catch {
    return null;
  }
}

/**
 * Get aggregated usage for the last 7 days.
 *
 * @param {string} instanceId
 * @returns {Array<{ date: string, input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, cost_usd: number, requests: number }>}
 */
export function getWeeklyUsage(instanceId) {
  try {
    const d = getDb();
    if (!d) return [];

    return d.prepare(`
      SELECT
        date,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COUNT(*) as requests
      FROM token_usage
      WHERE instance_id = ? AND date >= date('now', '-7 days')
      GROUP BY date
      ORDER BY date DESC
    `).all(instanceId);
  } catch {
    return [];
  }
}

/**
 * Get aggregated usage for the current month.
 *
 * @param {string} instanceId
 * @returns {{ input_tokens: number, output_tokens: number, cache_read_tokens: number, cache_write_tokens: number, cost_usd: number, requests: number } | null}
 */
export function getMonthlyUsage(instanceId) {
  try {
    const d = getDb();
    if (!d) return null;

    const monthPrefix = new Date().toISOString().substring(0, 7); // YYYY-MM
    return d.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd,
        COUNT(*) as requests
      FROM token_usage
      WHERE instance_id = ? AND date LIKE ? || '%'
    `).get(instanceId, monthPrefix);
  } catch {
    return null;
  }
}

/**
 * Get usage summary across all instances and time periods.
 *
 * @returns {Array<{ instance_id: string, total_input: number, total_output: number, total_cache_read: number, total_cache_write: number, total_cost: number, total_requests: number, first_date: string, last_date: string }>}
 */
export function getAllUsageSummary() {
  try {
    const d = getDb();
    if (!d) return [];

    return d.prepare(`
      SELECT
        instance_id,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COUNT(*) as total_requests,
        MIN(date) as first_date,
        MAX(date) as last_date
      FROM token_usage
      GROUP BY instance_id
      ORDER BY instance_id
    `).all();
  } catch {
    return [];
  }
}
