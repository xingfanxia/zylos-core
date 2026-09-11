import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const DEFAULT_CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const TAIL_BYTES = 65_536;
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

function formatResetTime(epochSeconds) {
  if (!epochSeconds) return null;

  try {
    const resetAt = new Date(epochSeconds * 1000);
    const now = new Date();
    const sameDay =
      resetAt.getFullYear() === now.getFullYear() &&
      resetAt.getMonth() === now.getMonth() &&
      resetAt.getDate() === now.getDate();

    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(resetAt);

    if (sameDay) return time;

    const date = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short'
    }).format(resetAt);

    return `${time} on ${date}`;
  } catch {
    return null;
  }
}

function readTailLines(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.size) return [];

  const readBytes = Math.min(TAIL_BYTES, stat.size);
  const offset = stat.size - readBytes;
  const buf = Buffer.alloc(readBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, readBytes, offset);
  } finally {
    fs.closeSync(fd);
  }

  return buf.toString('utf8').split('\n');
}

function readHeadLines(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.size) return [];

  const readBytes = Math.min(16_384, stat.size);
  const buf = Buffer.alloc(readBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, readBytes, 0);
  } finally {
    fs.closeSync(fd);
  }

  return buf.toString('utf8').split('\n');
}

export function extractRolloutCwdFromLines(lines) {
  if (!Array.isArray(lines)) return null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'session_meta' && event.payload?.cwd) {
        return event.payload.cwd;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

function rolloutMatchesInstance(filePath, instanceId) {
  if (!instanceId) return true;
  try {
    const cwd = extractRolloutCwdFromLines(readHeadLines(filePath));
    return typeof cwd === 'string' && cwd.endsWith(`/instances/${instanceId}`);
  } catch {
    return false;
  }
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

export function getActiveRolloutPath({
  instanceId = INSTANCE_ID,
  execFileSyncImpl = execFileSync,
  codexHome = DEFAULT_CODEX_DIR,
  sqliteFile = path.join(codexHome, 'state_5.sqlite'),
  sessionsDir = path.join(codexHome, 'sessions'),
} = {}) {
  let indexedPath = null;
  try {
    const sql = [
      'SELECT rollout_path FROM threads',
      'WHERE archived = 0',
      instanceId ? `AND cwd LIKE '%${sqlEscape(`/instances/${instanceId}`)}'` : null,
      'ORDER BY updated_at DESC',
      'LIMIT 1;'
    ].filter(Boolean).join(' ');
    // Read-only SQLite can still create WAL/SHM with the monitor's ownership.
    // Immutable URI reads never write beside another persona's state database.
    const uri = pathToFileURL(sqliteFile);
    uri.search = '?mode=ro&immutable=1';
    const out = execFileSyncImpl('sqlite3', ['-readonly', uri.href, sql], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    }).trim();
    if (out) indexedPath = out;
  } catch {
    // Fall back to filesystem scan when sqlite3 is unavailable.
  }

  try {
    let bestPath = null;
    let bestMtime = 0;
    // The immutable index omits uncheckpointed WAL rows. Compare live rollout
    // files even after an index hit so a newer quota event is not hidden.
    if (indexedPath && rolloutMatchesInstance(indexedPath, instanceId)) {
      try { bestMtime = fs.statSync(indexedPath).mtimeMs; bestPath = indexedPath; }
      catch { /* stale index path */ }
    }

    for (const year of fs.readdirSync(sessionsDir)) {
      const yearDir = path.join(sessionsDir, year);
      for (const month of fs.readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of fs.readdirSync(monthDir)) {
          const dayDir = path.join(monthDir, day);
          for (const file of fs.readdirSync(dayDir)) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            const fullPath = path.join(dayDir, file);
            if (!rolloutMatchesInstance(fullPath, instanceId)) continue;
            const mtimeMs = fs.statSync(fullPath).mtimeMs;
            if (mtimeMs > bestMtime) {
              bestMtime = mtimeMs;
              bestPath = fullPath;
            }
          }
        }
      }
    }

    return bestPath;
  } catch {
    return indexedPath;
  }
}

/**
 * Codex rate-limit payloads do not guarantee that `primary` means 5h and
 * `secondary` means weekly. Some subscriptions expose only one 10080-minute
 * window as `primary`. Classify by the declared duration first and retain the
 * legacy positional fallback only when older events omit window_minutes.
 */
export function classifyCodexRateLimitWindows(rateLimits) {
  const primary = rateLimits?.primary ?? null;
  const secondary = rateLimits?.secondary ?? null;
  const tertiary = rateLimits?.tertiary ?? null;
  const windows = [primary, secondary, tertiary].filter(Boolean);
  const minutes = (window) => Number(window?.window_minutes ?? window?.windowMinutes);

  const fiveHour = windows.find((window) => minutes(window) === 300)
    ?? (Number.isFinite(minutes(primary)) ? null : primary);
  const weekly = windows.find((window) => minutes(window) === 10080)
    ?? (Number.isFinite(minutes(secondary)) ? null : secondary);

  return { fiveHour, weekly };
}

export function parseCodexUsageFromRolloutLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;

      const rateLimits = event.payload?.rate_limits;
      const { fiveHour, weekly } = classifyCodexRateLimitWindows(rateLimits);
      if (!fiveHour && !weekly) continue;

      const fiveHourPercent = fiveHour?.used_percent ?? null;
      const weeklyAllPercent = weekly?.used_percent ?? null;

      return {
        sessionPercent: fiveHourPercent,
        sessionResets: formatResetTime(fiveHour?.resets_at ?? null),
        fiveHourPercent,
        fiveHourResets: formatResetTime(fiveHour?.resets_at ?? null),
        fiveHourResetsAt: fiveHour?.resets_at ?? null,
        weeklyAllPercent,
        weeklyAllResets: formatResetTime(weekly?.resets_at ?? null),
        weeklyAllResetsAt: weekly?.resets_at ?? null,
        statusShape: 'rollout'
      };
    } catch {
      // Skip malformed or partial lines at the tail boundary.
    }
  }

  return null;
}

export function readCodexUsageFromActiveRollout(opts = {}) {
  const rolloutPath = getActiveRolloutPath(opts);
  if (rolloutPath) {
    try {
      const active = parseCodexUsageFromRolloutLines(readTailLines(rolloutPath));
      if (active) return active;
    } catch { /* try recent rollouts below */ }
  }

  // A trust helper/app-server thread can be the newest SQLite row even though
  // it never emits token_count rate limits. Fall back to the newest usable
  // rollout instead of reporting the subscription monitor unavailable.
  const codexHome = opts.codexHome || DEFAULT_CODEX_DIR;
  const sessionsDir = opts.sessionsDir || path.join(codexHome, 'sessions');
  const candidates = [];
  const walk = (dir) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          if (!opts.instanceId || rolloutMatchesInstance(full, opts.instanceId)) candidates.push(full);
        }
      }
    } catch { /* unreadable profile home */ }
  };
  walk(sessionsDir);
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const candidate of candidates.slice(0, 200)) {
    if (candidate === rolloutPath) continue;
    try {
      const usage = parseCodexUsageFromRolloutLines(readTailLines(candidate));
      if (usage) return usage;
    } catch { /* continue */ }
  }
  return null;
}
