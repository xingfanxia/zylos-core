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

function addEntryToDateMap(map, entry) {
  if (!map.has(entry.date)) {
    map.set(entry.date, {
      date: entry.date,
      input_tokens: 0,
      output_tokens: 0,
      cache_write: 0,
      cache_read: 0,
      total_tokens: 0,
      cost_usd: 0,
    });
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

  return {
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
  };
}

export function fetchTokenCacheData({
  execFileSyncImpl = execFileSync,
  now = new Date(),
} = {}) {
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
  const since = sinceDate.toISOString().slice(0, 10).replace(/-/g, '');

  let raw;
  try {
    raw = execFileSyncImpl('ccusage', ['daily', '--json', '--instances', '--breakdown', '--since', since, '--offline'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
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

export function writeTokenCache(result, cacheFile = CACHE_FILE) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmpFile = cacheFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(tmpFile, cacheFile);
}

export function runUpdateOnce({
  execFileSyncImpl = execFileSync,
  cacheFile = CACHE_FILE,
  now = new Date(),
  log = console.log,
} = {}) {
  const result = fetchTokenCacheData({ execFileSyncImpl, now });
  writeTokenCache(result, cacheFile);

  const instanceCount = Object.keys(result.instances).length;
  const totalCost = result.totals.cost_usd.toFixed(2);
  log(`[update-token-cache] Written ${cacheFile} (${result.daily.length} days, ${instanceCount} instances, $${totalCost} total)`);
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
