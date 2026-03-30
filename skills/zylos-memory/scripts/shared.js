/**
 * Shared utilities for zylos-memory scripts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse } from 'dotenv';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
export const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

// Multi-session path constants
export const SHARED_DIR = fs.existsSync(path.join(MEMORY_DIR, 'shared'))
  ? path.join(MEMORY_DIR, 'shared')
  : MEMORY_DIR;
export const INSTANCES_DIR = path.join(MEMORY_DIR, 'instances');

export const BUDGETS = {
  'identity.md': 4096,
  'state.md': 4096,
  'references.md': 2048
};

export const REFERENCE_FILES = [
  'reference/decisions.md',
  'reference/projects.md',
  'reference/preferences.md',
  'reference/ideas.md'
];

/**
 * Load TZ from ~/zylos/.env and return it.
 * Side effect: sets process.env.TZ, which changes Date behavior process-wide.
 * @returns {string|null} timezone string or null
 */
export function loadTimezoneFromEnv() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const envText = fs.readFileSync(envPath, 'utf8');
    const env = parse(envText);
    if (env.TZ) {
      process.env.TZ = env.TZ;
      return env.TZ;
    }
  } catch {
    // .env may not exist on fresh setups
  }

  return process.env.TZ || null;
}

const MAX_WALK_DEPTH = 10;

/**
 * Recursively walk a directory and return file metadata.
 * Skips dot-files and limits recursion depth.
 * @param {string} rootDir - Directory to walk
 * @param {string} [prefix=''] - Relative path prefix for output
 * @param {number} [depth=0] - Current recursion depth
 * @returns {Array<{path: string, sizeBytes: number, modifiedAt: string, ageDays: number}>}
 */
export function walkFiles(rootDir, prefix = '', depth = 0) {
  const out = [];

  if (!fs.existsSync(rootDir) || depth > MAX_WALK_DEPTH) {
    return out;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, relPath, depth + 1));
      continue;
    }

    const stat = fs.statSync(fullPath);
    out.push({
      path: relPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24))
    });
  }

  return out;
}

/**
 * Resolve a file path in shared/ if it exists, else fall back to MEMORY_DIR.
 * @param {string} filename - File name (e.g., 'identity.md')
 * @returns {string} Absolute path
 */
export function resolveSharedFile(filename) {
  const sharedPath = path.join(SHARED_DIR, filename);
  if (fs.existsSync(sharedPath)) return sharedPath;
  return path.join(MEMORY_DIR, filename);
}

/**
 * Resolve the directory for a specific instance.
 * @param {string} instanceId
 * @returns {string} Absolute path to INSTANCES_DIR/<id>/
 */
export function resolveInstanceDir(instanceId) {
  return path.join(INSTANCES_DIR, instanceId);
}

/**
 * Resolve a file path within an instance's directory.
 * @param {string} instanceId
 * @param {string} filename
 * @returns {string} Absolute path
 */
export function resolveInstanceFile(instanceId, filename) {
  return path.join(INSTANCES_DIR, instanceId, filename);
}

/**
 * Resolve sessions directory. Instance-specific when instanceId is provided.
 * @param {string} [instanceId] - Optional instance ID
 * @returns {string} Absolute path to sessions directory
 */
export function resolveSessionsDir(instanceId) {
  if (instanceId) {
    return path.join(INSTANCES_DIR, instanceId, 'sessions');
  }
  return SESSIONS_DIR;
}

/**
 * Return array of reference file paths from shared/reference/ or MEMORY_DIR/reference/.
 * @returns {string[]} Absolute paths to existing reference files
 */
export function resolveReferenceFiles() {
  const results = [];
  for (const relPath of REFERENCE_FILES) {
    const sharedPath = path.join(SHARED_DIR, relPath);
    if (fs.existsSync(sharedPath)) {
      results.push(sharedPath);
      continue;
    }
    const defaultPath = path.join(MEMORY_DIR, relPath);
    if (fs.existsSync(defaultPath)) {
      results.push(defaultPath);
    }
  }
  return results;
}

export function dateInTimeZone(date, tz) {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);

      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;

      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    } catch {
      // Invalid TZ value falls back to local date below
    }
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
