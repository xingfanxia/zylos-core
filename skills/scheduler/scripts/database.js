/**
 * Database Layer
 * SQLite-based persistence for tasks and execution history
 */

import Database from 'better-sqlite3';
import * as schema from './schema.js';
import { guardDatabase, assertCoreDatabaseAvailable } from '../../comm-bridge/scripts/sqlite-schema.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Data goes to ~/zylos/scheduler/, code stays in skills directory
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'scheduler');
const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
const HISTORY_RETENTION_DAYS = 30;

let db = null;

export function getDb() {
  assertCoreDatabaseAvailable(ZYLOS_DIR);
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const connection = new Database(DB_PATH);
    try {
      guardDatabase(connection, schema);
      connection.pragma('journal_mode = WAL');
      // Two long-lived writers share this DB (scheduler daemon + c4-broker);
      // without a busy_timeout a write collision fails immediately with
      // SQLITE_BUSY instead of briefly queueing.
      connection.pragma('busy_timeout = 5000');
      db = connection;
      // Fork: multi-session target_instance column on top of the core chain.
      ensureTargetInstanceColumn();
    } catch (error) { db = null; connection.close(); throw error; }
  }
  return db;
}


/**
 * Fork: add the multi-session target_instance column to an existing tasks table.
 * Safe to call repeatedly — checks PRAGMA table_info before altering.
 */
function ensureTargetInstanceColumn() {
  const columnNames = new Set(db.pragma('table_info(tasks)').map(c => c.name));
  if (!columnNames.has('target_instance')) {
    db.exec('ALTER TABLE tasks ADD COLUMN target_instance TEXT DEFAULT NULL');
  }
}

// Clean up old history entries (older than HISTORY_RETENTION_DAYS)
export function cleanupHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - (HISTORY_RETENTION_DAYS * 24 * 60 * 60);
  const result = db.prepare('DELETE FROM task_history WHERE executed_at < ?').run(cutoff);
  return result.changes;
}

// Generate a unique task ID
export function generateId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

// Get current Unix timestamp
export function now() {
  return Math.floor(Date.now() / 1000);
}
