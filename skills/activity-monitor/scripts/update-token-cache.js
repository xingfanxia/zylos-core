#!/usr/bin/env node
/**
 * Update Token Cache — runs ccusage and writes per-instance token data
 * to ~/zylos/activity-monitor/token-cache.json for the dashboard.
 *
 * Designed to run as a cron/scheduled task (e.g. hourly via PM2 cron).
 *
 * Output format:
 *   {
 *     daily: [...],           // aggregate daily data
 *     totals: {...},          // aggregate totals
 *     instances: {            // per-instance breakdown
 *       "admin": { daily: [...], totals: {...} },
 *       "group": { ... },
 *       ...
 *     },
 *     updated_at: <iso>,
 *     cache_age_minutes: 0
 *   }
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const CACHE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'token-cache.json');
const DAYS_BACK = 30;
const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.TOKEN_CACHE_INTERVAL_MS || '', 10) || 60 * 60 * 1000;
const DEFAULT_RETRY_MS = Number.parseInt(process.env.TOKEN_CACHE_RETRY_MS || '', 10) || 10 * 60 * 1000;
const KNOWN_RUNTIMES = ['claude', 'codex', 'other'];
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const CODEX_USAGE_BIN = process.env.CCUSAGE_CODEX_BIN || 'npx';
const CODEX_USAGE_PACKAGE = process.env.CCUSAGE_CODEX_PACKAGE || '@ccusage/codex@latest';

// ccusage pinned per-skill: v19+ dropped `--instances` and the `projects`
// output shape this parser consumes (a global v20 upgrade silently broke the
// hourly cache refresh on 2026-07-08). Prefer the skill-local pin, fall back
// to PATH for deployments without one.
const SKILL_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PINNED_CCUSAGE = path.join(SKILL_DIR, 'node_modules', '.bin', 'ccusage');
const CCUSAGE_BIN = process.env.CCUSAGE_BIN
  || (fs.existsSync(PINNED_CCUSAGE) ? PINNED_CCUSAGE : 'ccusage');

/**
 * OS-isolated instances write transcripts under their own HOME
 * (/home/<os_user>/.claude/projects), not the service user's. ccusage honors
 * comma-separated CLAUDE_CONFIG_DIR — scan every home we know about.
 * Requires service-user read ACLs on the agent .claude dirs (provisioned by
 * scripts/ops/provision-agent-user.sh).
 */
function buildClaudeConfigDirs(zylosDir = ZYLOS_DIR) {
  const dirs = [path.join(os.homedir(), '.claude')];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(zylosDir, 'instances.json'), 'utf8'));
    for (const inst of Object.values(config?.instances || {})) {
      if (inst?.claude_config_dir && !dirs.includes(inst.claude_config_dir)) {
        dirs.push(inst.claude_config_dir);
      }
    }
  } catch { /* single-session or unreadable config — service home only */ }
  return dirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

function loadKnownInstanceIds(zylosDir = ZYLOS_DIR) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(zylosDir, 'instances.json'), 'utf8'));
    return new Set(Object.keys(config?.instances || {}));
  } catch {
    return null;
  }
}

/**
 * Map ccusage project name to instance ID.
 * Project names are like: -home-x-computelabs-ai-zylos-instances-admin
 * Instance ID is the last segment after "instances-".
 */
function projectToInstanceId(projectName) {
  const match = projectName.match(/zylos-instances-(.+)$/);
  return match ? match[1] : null;
}

/**
 * Normalize ccusage field names (camelCase) to dashboard field names (snake_case).
 */
function normalizeDailyEntry(entry) {
  return {
    date: entry.date,
    input_tokens: entry.inputTokens || 0,
    output_tokens: entry.outputTokens || 0,
    cache_write: entry.cacheCreationTokens || 0,
    cache_read: entry.cacheReadTokens || 0,
    total_tokens: entry.totalTokens || 0,
    cost_usd: entry.totalCost || 0,
  };
}

function normalizeBreakdownEntry(date, breakdown) {
  return {
    date,
    input_tokens: breakdown.inputTokens || 0,
    output_tokens: breakdown.outputTokens || 0,
    cache_write: breakdown.cacheCreationTokens || 0,
    cache_read: breakdown.cacheReadTokens || 0,
    total_tokens:
      (breakdown.inputTokens || 0) +
      (breakdown.outputTokens || 0) +
      (breakdown.cacheCreationTokens || 0) +
      (breakdown.cacheReadTokens || 0),
    cost_usd: breakdown.cost || 0,
  };
}

export function classifyModelRuntime(modelName = '') {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return 'other';
  if (normalized.startsWith('claude-')) return 'claude';
  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4') ||
    normalized.includes('codex')
  ) {
    return 'codex';
  }
  return 'other';
}

function mergeDailyEntry(target, entry) {
  target.input_tokens += entry.input_tokens || 0;
  target.output_tokens += entry.output_tokens || 0;
  target.cache_write += entry.cache_write || 0;
  target.cache_read += entry.cache_read || 0;
  target.total_tokens += entry.total_tokens || 0;
  target.cost_usd += entry.cost_usd || 0;
}

function emptyDailyEntry(date) {
  return {
    date,
    input_tokens: 0,
    output_tokens: 0,
    cache_write: 0,
    cache_read: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function addEntryToDateMap(map, entry) {
  if (!map.has(entry.date)) {
    map.set(entry.date, emptyDailyEntry(entry.date));
  }
  mergeDailyEntry(map.get(entry.date), entry);
}

export function splitEntryByRuntime(entry) {
  const perRuntime = {};
  const breakdowns = Array.isArray(entry?.modelBreakdowns) ? entry.modelBreakdowns : [];

  if (breakdowns.length > 0) {
    for (const breakdown of breakdowns) {
      const runtime = classifyModelRuntime(breakdown.modelName);
      const normalized = normalizeBreakdownEntry(entry.date, breakdown);
      if (!perRuntime[runtime]) {
        perRuntime[runtime] = {
          date: entry.date,
          input_tokens: 0,
          output_tokens: 0,
          cache_write: 0,
          cache_read: 0,
          total_tokens: 0,
          cost_usd: 0,
        };
      }
      mergeDailyEntry(perRuntime[runtime], normalized);
    }
    return perRuntime;
  }

  const inferredRuntime = classifyModelRuntime(entry?.modelsUsed?.[0] || '');
  perRuntime[inferredRuntime] = normalizeDailyEntry(entry);
  return perRuntime;
}

function mergeEntryIntoDailyArray(dailyEntries, entry) {
  let target = dailyEntries.find((row) => row.date === entry.date);
  if (!target) {
    target = emptyDailyEntry(entry.date);
    dailyEntries.push(target);
  }
  mergeDailyEntry(target, entry);
}

function ensureRuntimeBucket(target, runtime) {
  if (!target.runtimes) target.runtimes = {};
  if (!target.runtimes[runtime]) {
    target.runtimes[runtime] = {
      daily: [],
      totals: computeTotals([]),
    };
  }
  return target.runtimes[runtime];
}

function ensureInstanceBucket(result, instanceId) {
  if (!result.instances[instanceId]) {
    result.instances[instanceId] = {
      project: null,
      daily: [],
      totals: computeTotals([]),
      runtimes: Object.fromEntries(KNOWN_RUNTIMES.map((runtime) => [runtime, {
        daily: [],
        totals: computeTotals([]),
      }])),
    };
  } else if (!result.instances[instanceId].runtimes) {
    result.instances[instanceId].runtimes = Object.fromEntries(KNOWN_RUNTIMES.map((runtime) => [runtime, {
      daily: [],
      totals: computeTotals([]),
    }]));
  } else {
    for (const runtime of KNOWN_RUNTIMES) {
      ensureRuntimeBucket(result.instances[instanceId], runtime);
    }
  }
  return result.instances[instanceId];
}

function finalizeTokenCacheResult(result) {
  result.daily.sort((a, b) => a.date.localeCompare(b.date));
  result.totals = computeTotals(result.daily);

  if (!result.runtimes) result.runtimes = {};
  for (const runtime of KNOWN_RUNTIMES) {
    const bucket = ensureRuntimeBucket(result, runtime);
    bucket.daily.sort((a, b) => a.date.localeCompare(b.date));
    bucket.totals = computeTotals(bucket.daily);
  }

  for (const [instanceId, instanceData] of Object.entries(result.instances || {})) {
    instanceData.daily.sort((a, b) => a.date.localeCompare(b.date));
    instanceData.totals = computeTotals(instanceData.daily);
    for (const runtime of KNOWN_RUNTIMES) {
      const bucket = ensureRuntimeBucket(instanceData, runtime);
      bucket.daily.sort((a, b) => a.date.localeCompare(b.date));
      bucket.totals = computeTotals(bucket.daily);
    }
    result.instances[instanceId] = instanceData;
  }

  result.per_instance = Object.entries(result.instances || {}).map(([id, instanceData]) => ({
    instance_id: id,
    ...instanceData.totals,
  }));
  return result;
}

function sessionDate(session) {
  if (session?.lastActivity) {
    const parsed = new Date(session.lastActivity);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  if (typeof session?.directory === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(session.directory)) {
    return session.directory.replace(/\//g, '-');
  }
  return null;
}

function sessionFilePath(session, codexSessionsDir = CODEX_SESSIONS_DIR) {
  if (!session?.directory || !session?.sessionFile) return null;
  const fileName = session.sessionFile.endsWith('.jsonl') ? session.sessionFile : `${session.sessionFile}.jsonl`;
  return path.join(codexSessionsDir, session.directory, fileName);
}

function readRolloutHead(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.size) return '';
  const readBytes = Math.min(16_384, stat.size);
  const buf = Buffer.alloc(readBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, readBytes, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

function instanceIdFromCwd(cwd = '') {
  const match = String(cwd).match(/\/instances\/([^/]+)$/);
  return match?.[1] || null;
}

function readInstanceIdFromRollout(filePath) {
  try {
    const head = readRolloutHead(filePath).split('\n');
    for (const line of head) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'session_meta' && event.payload?.cwd) {
          return instanceIdFromCwd(event.payload.cwd);
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeCodexSessionEntry(session) {
  const date = sessionDate(session);
  if (!date) return null;
  return {
    date,
    input_tokens: session.inputTokens || 0,
    output_tokens: session.outputTokens || 0,
    cache_write: 0,
    cache_read: session.cachedInputTokens || 0,
    total_tokens:
      (session.inputTokens || 0) +
      (session.outputTokens || 0) +
      (session.cachedInputTokens || 0),
    cost_usd: session.costUSD || 0,
  };
}

export function mergeCodexSessionsIntoResult(result, sessions, {
  codexSessionsDir = CODEX_SESSIONS_DIR,
  knownInstanceIds = null,
} = {}) {
  if (!result || !Array.isArray(sessions) || sessions.length === 0) return result;

  for (const session of sessions) {
    const entry = normalizeCodexSessionEntry(session);
    if (!entry) continue;

    const rolloutPath = sessionFilePath(session, codexSessionsDir);
    const instanceId = rolloutPath ? readInstanceIdFromRollout(rolloutPath) : null;
    if (!instanceId) continue;
    if (knownInstanceIds && !knownInstanceIds.has(instanceId)) continue;

    const instanceBucket = ensureInstanceBucket(result, instanceId);
    const runtimeBucket = ensureRuntimeBucket(instanceBucket, 'codex');
    const aggregateRuntimeBucket = ensureRuntimeBucket(result, 'codex');

    mergeEntryIntoDailyArray(result.daily, entry);
    mergeEntryIntoDailyArray(aggregateRuntimeBucket.daily, entry);
    mergeEntryIntoDailyArray(instanceBucket.daily, entry);
    mergeEntryIntoDailyArray(runtimeBucket.daily, entry);
  }

  return finalizeTokenCacheResult(result);
}

/**
 * Compute totals from normalized daily entries.
 */
function computeTotals(dailyEntries) {
  let input_tokens = 0, output_tokens = 0, cache_write = 0, cache_read = 0, cost_usd = 0;

  for (const entry of dailyEntries) {
    input_tokens += entry.input_tokens || entry.inputTokens || 0;
    output_tokens += entry.output_tokens || entry.outputTokens || 0;
    cache_write += entry.cache_write || entry.cacheCreationTokens || 0;
    cache_read += entry.cache_read || entry.cacheReadTokens || 0;
    cost_usd += entry.cost_usd || entry.totalCost || 0;
  }

  return {
    input_tokens,
    output_tokens,
    cache_write,
    cache_read,
    total_tokens: input_tokens + output_tokens + cache_write + cache_read,
    cost_usd,
    days: dailyEntries.length,
  };
}

export function buildTokenCacheResult(data, now = new Date()) {
  const projects = data.projects || {};
  const instances = {};
  const aggregateDailyMap = new Map();
  const aggregateRuntimeMaps = Object.fromEntries(KNOWN_RUNTIMES.map((runtime) => [runtime, new Map()]));

  for (const [projectName, dailyEntries] of Object.entries(projects)) {
    const instanceId = projectToInstanceId(projectName);
    const normalized = dailyEntries.map(normalizeDailyEntry);
    const instanceRuntimeMaps = Object.fromEntries(KNOWN_RUNTIMES.map((runtime) => [runtime, new Map()]));

    if (instanceId) {
      instances[instanceId] = {
        project: projectName,
        daily: normalized,
        totals: computeTotals(normalized),
      };
    }

    for (let idx = 0; idx < dailyEntries.length; idx++) {
      const rawEntry = dailyEntries[idx];
      const entry = normalized[idx];
      addEntryToDateMap(aggregateDailyMap, entry);

      const runtimeEntries = splitEntryByRuntime(rawEntry);
      for (const [runtime, runtimeEntry] of Object.entries(runtimeEntries)) {
        if (!instanceRuntimeMaps[runtime]) instanceRuntimeMaps[runtime] = new Map();
        if (!aggregateRuntimeMaps[runtime]) aggregateRuntimeMaps[runtime] = new Map();
        addEntryToDateMap(instanceRuntimeMaps[runtime], runtimeEntry);
        addEntryToDateMap(aggregateRuntimeMaps[runtime], runtimeEntry);
      }
    }

    if (instanceId) {
      instances[instanceId].runtimes = {};
      for (const runtime of Object.keys(instanceRuntimeMaps)) {
        const daily = Array.from(instanceRuntimeMaps[runtime].values()).sort((a, b) => a.date.localeCompare(b.date));
        instances[instanceId].runtimes[runtime] = {
          daily,
          totals: computeTotals(daily),
        };
      }
    }
  }

  const aggregateDaily = Array.from(aggregateDailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date));

  const runtimes = {};
  for (const runtime of Object.keys(aggregateRuntimeMaps)) {
    const daily = Array.from(aggregateRuntimeMaps[runtime].values()).sort((a, b) => a.date.localeCompare(b.date));
    runtimes[runtime] = {
      daily,
      totals: computeTotals(daily),
    };
  }

  return finalizeTokenCacheResult({
    daily: aggregateDaily,
    totals: computeTotals(aggregateDaily),
    runtimes,
    per_instance: Object.entries(instances).map(([id, instanceData]) => ({
      instance_id: id,
      ...instanceData.totals,
    })),
    instances,
    updated_at: now.toISOString(),
    cache_age_minutes: 0,
  });
}

function fetchClaudeTokenCacheData({
  execFileSyncImpl = execFileSync,
  now = new Date(),
} = {}) {
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
  const since = sinceDate.toISOString().slice(0, 10).replace(/-/g, '');

  let raw;
  try {
    raw = execFileSyncImpl(CCUSAGE_BIN, ['daily', '--json', '--instances', '--breakdown', '--since', since, '--offline'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: buildClaudeConfigDirs().join(',') },
    });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`ccusage failed: ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ccusage output: ${err.message}`);
  }

  return buildTokenCacheResult(data, now);
}

function fetchCodexSessionData({
  execFileSyncImpl = execFileSync,
  now = new Date(),
} = {}) {
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
  const since = sinceDate.toISOString().slice(0, 10);
  const until = now.toISOString().slice(0, 10);

  let raw;
  try {
    raw = execFileSyncImpl(CODEX_USAGE_BIN, [
      '-y',
      CODEX_USAGE_PACKAGE,
      'session',
      '--json',
      '--since',
      since,
      '--until',
      until,
      '--offline',
    ], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`@ccusage/codex failed: ${detail}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse @ccusage/codex output: ${err.message}`);
  }

  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export function fetchTokenCacheData({
  execFileSyncImpl = execFileSync,
  now = new Date(),
  codexSessionsDir = CODEX_SESSIONS_DIR,
  zylosDir = ZYLOS_DIR,
} = {}) {
  const result = fetchClaudeTokenCacheData({ execFileSyncImpl, now });
  try {
    const codexSessions = fetchCodexSessionData({ execFileSyncImpl, now });
    mergeCodexSessionsIntoResult(result, codexSessions, {
      codexSessionsDir,
      knownInstanceIds: loadKnownInstanceIds(zylosDir),
    });
  } catch (err) {
    result.warnings = [...(result.warnings || []), err.message];
  }
  return result;
}

export function writeTokenCache(result, cacheFile = CACHE_FILE) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmpFile = cacheFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(tmpFile, cacheFile);
}

export function runUpdateOnce({
  execFileSyncImpl = execFileSync,
  cacheFile = CACHE_FILE,
  codexSessionsDir = CODEX_SESSIONS_DIR,
  zylosDir = ZYLOS_DIR,
  now = new Date(),
  log = console.log,
} = {}) {
  const result = fetchTokenCacheData({ execFileSyncImpl, now, codexSessionsDir, zylosDir });
  writeTokenCache(result, cacheFile);

  const instanceCount = Object.keys(result.instances).length;
  const totalCost = result.totals.cost_usd.toFixed(2);
  log(`[update-token-cache] Written ${cacheFile} (${result.daily.length} days, ${instanceCount} instances, $${totalCost} total)`);
  for (const warning of result.warnings || []) {
    log(`[update-token-cache] Warning: ${warning}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemon({
  intervalMs = DEFAULT_INTERVAL_MS,
  retryMs = DEFAULT_RETRY_MS,
  once = runUpdateOnce,
  log = console.log,
  error = console.error,
} = {}) {
  log(`[update-token-cache] Daemon mode started (interval=${intervalMs}ms retry=${retryMs}ms)`);
  while (true) {
    let nextDelay = intervalMs;
    try {
      once({ log });
    } catch (err) {
      nextDelay = retryMs;
      error(`[update-token-cache] ${err.message}`);
      error(`[update-token-cache] Retrying in ${Math.round(retryMs / 1000)}s`);
    }
    await sleep(nextDelay);
  }
}

async function main() {
  const daemonMode = process.argv.includes('--daemon');
  if (daemonMode) {
    await runDaemon();
    return;
  }

  try {
    runUpdateOnce();
  } catch (err) {
    console.error(`[update-token-cache] ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN !== '1') {
  await main();
}
