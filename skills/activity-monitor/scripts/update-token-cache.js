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

function main() {
  // Calculate --since date (YYYYMMDD format)
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
  const since = sinceDate.toISOString().slice(0, 10).replace(/-/g, '');

  let raw;
  try {
    raw = execFileSync('ccusage', ['daily', '--json', '--instances', '--since', since, '--offline'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`[update-token-cache] ccusage failed: ${err.stderr || err.message}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`[update-token-cache] Failed to parse ccusage output: ${err.message}`);
    process.exit(1);
  }

  // data.projects is an object: { "project-name": [daily entries...] }
  const projects = data.projects || {};
  const instances = {};
  let aggregateDaily = [];

  for (const [projectName, dailyEntries] of Object.entries(projects)) {
    const instanceId = projectToInstanceId(projectName);
    const normalized = dailyEntries.map(normalizeDailyEntry);

    if (instanceId) {
      instances[instanceId] = {
        project: projectName,
        daily: normalized,
        totals: computeTotals(normalized),
      };
    }

    // Aggregate all projects into a single daily timeline
    for (const entry of normalized) {
      const existing = aggregateDaily.find(e => e.date === entry.date);
      if (existing) {
        existing.input_tokens += entry.input_tokens;
        existing.output_tokens += entry.output_tokens;
        existing.cache_write += entry.cache_write;
        existing.cache_read += entry.cache_read;
        existing.total_tokens += entry.total_tokens;
        existing.cost_usd += entry.cost_usd;
      } else {
        aggregateDaily.push({ ...entry });
      }
    }
  }

  // Sort aggregate by date ascending
  aggregateDaily.sort((a, b) => a.date.localeCompare(b.date));

  // Build per_instance array (what the dashboard frontend expects)
  const perInstance = Object.entries(instances).map(([id, data]) => ({
    instance_id: id,
    ...data.totals,
  }));

  const result = {
    daily: aggregateDaily,
    totals: computeTotals(aggregateDaily),
    per_instance: perInstance,
    instances,
    updated_at: new Date().toISOString(),
    cache_age_minutes: 0,
  };

  // Atomic write
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const tmpFile = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(tmpFile, CACHE_FILE);

  const instanceCount = Object.keys(instances).length;
  const totalCost = result.totals.cost_usd.toFixed(2);
  console.log(`[update-token-cache] Written ${CACHE_FILE} (${aggregateDaily.length} days, ${instanceCount} instances, $${totalCost} total)`);
}

main();
