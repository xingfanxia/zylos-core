import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveTilde(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

export function normalizeDashboardTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // SQLite timestamps in c4.db are stored as naive UTC strings like
  // "2026-04-01 09:57:13". Normalize them to ISO UTC so the browser can
  // safely localize them with toLocaleString().
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw.replace(' ', 'T') + 'Z';
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function loadInstancesConfig(zylosDir) {
  const instancesFile = path.join(zylosDir, 'instances.json');
  try {
    if (!fs.existsSync(instancesFile)) return null;
    return JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
  } catch {
    return null;
  }
}

export function annotateTokenCacheWithRuntimes(cached, instancesConfig) {
  const runtimeByInstance = {};
  for (const [id, inst] of Object.entries(instancesConfig?.instances || {})) {
    runtimeByInstance[id] = inst?.runtime || 'claude';
  }
  const knownIds = new Set(Object.keys(runtimeByInstance));

  const instances = {};
  for (const [id, data] of Object.entries(cached?.instances || {})) {
    if (knownIds.size > 0 && !knownIds.has(id)) continue;
    instances[id] = {
      ...data,
      runtime: runtimeByInstance[id] || 'claude',
    };
  }

  const perInstance = Array.isArray(cached?.per_instance)
    ? cached.per_instance.map((row) => ({
        ...row,
        runtime: runtimeByInstance[row.instance_id] || 'claude',
      })).filter((row) => knownIds.size === 0 || knownIds.has(row.instance_id))
    : [];

  return {
    ...cached,
    instances,
    per_instance: perInstance,
  };
}

export function readUsageWindowSnapshot({
  instanceId,
  instanceDef,
  zylosDir,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
} = {}) {
  const runtime = instanceDef?.runtime || 'claude';
  const stateDir = resolveTilde(instanceDef?.state_dir) || path.join(zylosDir, 'activity-monitor', instanceId);
  const usageFile = runtime === 'codex'
    ? path.join(stateDir, 'usage-codex.json')
    : path.join(stateDir, 'usage.json');

  if (!existsSync(usageFile)) {
    return {
      runtime,
      available: false,
      source_file: path.basename(usageFile),
      session: null,
      fiveHour: null,
      weeklyAll: null,
      weeklySonnet: null,
      tier: null,
      lastCheck: null,
      age_minutes: null,
      statusShape: null,
    };
  }

  try {
    const data = JSON.parse(readFileSync(usageFile, 'utf8'));
    const ageMinutes = Math.floor((Date.now() - statSync(usageFile).mtimeMs) / 60000);
    return {
      runtime,
      available: true,
      source_file: path.basename(usageFile),
      session: data.session || null,
      fiveHour: data.fiveHour || null,
      weeklyAll: data.weeklyAll || null,
      weeklySonnet: data.weeklySonnet || null,
      tier: data.tier || null,
      lastCheck: data.lastCheck || null,
      age_minutes: ageMinutes,
      statusShape: data.statusShape || null,
    };
  } catch {
    return {
      runtime,
      available: false,
      source_file: path.basename(usageFile),
      session: null,
      fiveHour: null,
      weeklyAll: null,
      weeklySonnet: null,
      tier: null,
      lastCheck: null,
      age_minutes: null,
      statusShape: null,
    };
  }
}

export function buildUsageWindows(instancesConfig, zylosDir) {
  const windows = {};
  for (const [id, inst] of Object.entries(instancesConfig?.instances || {})) {
    windows[id] = readUsageWindowSnapshot({
      instanceId: id,
      instanceDef: inst,
      zylosDir,
    });
  }
  return windows;
}

export function readContextWindowSnapshot({
  instanceId,
  instanceDef,
  zylosDir,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
} = {}) {
  const stateDir = resolveTilde(instanceDef?.state_dir) || path.join(zylosDir, 'activity-monitor', instanceId);
  const filePath = path.join(stateDir, 'context-window.json');
  if (!existsSync(filePath)) {
    return {
      available: false,
      observed_at: null,
      age_minutes: null,
      source: null,
      used_tokens: null,
      ceiling_tokens: null,
      percent_used: null,
      percent_remaining: null,
      threshold_percent: null,
      rollout_path: null,
    };
  }

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      ...data,
      available: true,
      age_minutes: Math.floor((Date.now() - statSync(filePath).mtimeMs) / 60000),
    };
  } catch {
    return {
      available: false,
      observed_at: null,
      age_minutes: null,
      source: null,
      used_tokens: null,
      ceiling_tokens: null,
      percent_used: null,
      percent_remaining: null,
      threshold_percent: null,
      rollout_path: null,
    };
  }
}

export function buildContextWindows(instancesConfig, zylosDir) {
  const windows = {};
  for (const [id, inst] of Object.entries(instancesConfig?.instances || {})) {
    windows[id] = readContextWindowSnapshot({
      instanceId: id,
      instanceDef: inst,
      zylosDir,
    });
  }
  return windows;
}

export function readLastContextHandoff({
  instanceId,
  instanceDef,
  zylosDir,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
} = {}) {
  const stateDir = resolveTilde(instanceDef?.state_dir) || path.join(zylosDir, 'activity-monitor', instanceId);
  const filePath = path.join(stateDir, 'last-context-handoff.json');
  if (!existsSync(filePath)) {
    return {
      available: false,
      triggered_at: null,
      age_minutes: null,
      source: null,
      used_tokens: null,
      ceiling_tokens: null,
      percent_used: null,
      threshold_percent: null,
      enqueue_ok: null,
      rollout_path: null,
    };
  }

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      ...data,
      available: true,
      age_minutes: Math.floor((Date.now() - statSync(filePath).mtimeMs) / 60000),
    };
  } catch {
    return {
      available: false,
      triggered_at: null,
      age_minutes: null,
      source: null,
      used_tokens: null,
      ceiling_tokens: null,
      percent_used: null,
      threshold_percent: null,
      enqueue_ok: null,
      rollout_path: null,
    };
  }
}

export function buildLastContextHandoffs(instancesConfig, zylosDir) {
  const handoffs = {};
  for (const [id, inst] of Object.entries(instancesConfig?.instances || {})) {
    handoffs[id] = readLastContextHandoff({
      instanceId: id,
      instanceDef: inst,
      zylosDir,
    });
  }
  return handoffs;
}

function emptyTokenTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function sumDailyRows(rows) {
  const out = emptyTokenTotals();
  for (const row of rows || []) {
    out.input_tokens += row.input_tokens || 0;
    out.output_tokens += row.output_tokens || 0;
    out.cache_read += row.cache_read || 0;
    out.cache_write += row.cache_write || 0;
    out.cost_usd += row.cost_usd || 0;
    out.total_tokens += row.total_tokens || (
      (row.input_tokens || 0) +
      (row.output_tokens || 0) +
      (row.cache_read || 0) +
      (row.cache_write || 0)
    );
  }
  return out;
}

function filterRowsSince(rows, sinceDate) {
  return (rows || []).filter((row) => row.date >= sinceDate);
}

export function buildInstanceTokenBurnMap(tokenCache) {
  const today = new Date().toISOString().slice(0, 10);
  const weekDate = new Date();
  weekDate.setDate(weekDate.getDate() - 6);
  const sinceWeek = weekDate.toISOString().slice(0, 10);

  const result = {};
  for (const [instanceId, data] of Object.entries(tokenCache?.instances || {})) {
    const rows = Array.isArray(data?.daily) ? data.daily : [];
    result[instanceId] = {
      today: sumDailyRows(rows.filter((row) => row.date === today)),
      week: sumDailyRows(filterRowsSince(rows, sinceWeek)),
    };
  }
  return result;
}

export function enrichInstancesForDashboard(instances = [], {
  tokenCache = null,
  contextWindows = {},
  lastContextHandoffs = {},
} = {}) {
  const tokenBurn = buildInstanceTokenBurnMap(tokenCache);
  return (instances || []).map((inst) => ({
    ...inst,
    token_burn: tokenBurn[inst.id] || {
      today: emptyTokenTotals(),
      week: emptyTokenTotals(),
    },
    context_window: contextWindows?.[inst.id] || null,
    last_context_handoff: lastContextHandoffs?.[inst.id] || null,
  }));
}

export function readProviderUsage(zylosDir, {
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync,
} = {}) {
  const filePath = path.join(zylosDir, 'activity-monitor', 'provider-usage.json');
  if (!existsSync(filePath)) {
    return {
      available: false,
      updated_at: null,
      age_minutes: null,
      providers: {},
    };
  }

  try {
    const payload = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      ...payload,
      available: true,
      age_minutes: Math.floor((Date.now() - statSync(filePath).mtimeMs) / 60000),
    };
  } catch {
    return {
      available: false,
      updated_at: null,
      age_minutes: null,
      providers: {},
    };
  }
}

export function buildRuntimeUsage({
  instancesConfig,
  usageWindows,
  providerUsage,
} = {}) {
  const runtimeUsage = {};

  function matchingWindows(runtime) {
    return Object.entries(instancesConfig?.instances || {})
      .filter(([, inst]) => (inst?.runtime || 'claude') === runtime)
      .map(([id]) => usageWindows?.[id])
      .filter((entry) => entry && entry.available);
  }

  function aggregateLocalMetric(entries, key) {
    let best = null;
    for (const entry of entries) {
      const metric = entry?.[key];
      if (!metric || metric.percent === null || metric.percent === undefined) continue;
      if (!best || metric.percent > best.percent) best = metric;
    }
    if (!best) return null;
    return {
      percent: Math.max(0, 100 - best.percent),
      resets: best.resets || null,
    };
  }

  function latestCheck(entries) {
    let best = null;
    for (const entry of entries) {
      const ts = entry?.lastCheck ? Date.parse(entry.lastCheck) : 0;
      if (!best || ts > best.ts) best = { ts, value: entry.lastCheck };
    }
    return best?.value || null;
  }

  const claudeProvider = providerUsage?.providers?.claude;
  if (claudeProvider?.available) {
    runtimeUsage.claude = {
      source: 'codexbar',
      session: claudeProvider.primary ? {
        percent: claudeProvider.primary.left_percent,
        resets: claudeProvider.primary.reset_description,
      } : null,
      fiveHour: null,
      weeklyAll: claudeProvider.secondary ? {
        percent: claudeProvider.secondary.left_percent,
        resets: claudeProvider.secondary.reset_description,
      } : null,
      weeklySonnet: claudeProvider.tertiary ? {
        percent: claudeProvider.tertiary.left_percent,
        resets: claudeProvider.tertiary.reset_description,
      } : null,
      lastCheck: claudeProvider.fetched_at || providerUsage?.updated_at || null,
      account_email: claudeProvider.account_email || null,
    };
  }

  const codexEntries = matchingWindows('codex');
  if (codexEntries.length > 0) {
    runtimeUsage.codex = {
      source: 'local_rollout',
      session: null,
      fiveHour: aggregateLocalMetric(codexEntries, 'fiveHour'),
      weeklyAll: aggregateLocalMetric(codexEntries, 'weeklyAll'),
      weeklySonnet: null,
      lastCheck: latestCheck(codexEntries),
      account_email: providerUsage?.providers?.codex?.account_email || null,
    };
  } else {
    const codexProvider = providerUsage?.providers?.codex;
    if (codexProvider?.available) {
      runtimeUsage.codex = {
        source: 'codexbar',
        session: null,
        fiveHour: codexProvider.primary ? {
          percent: codexProvider.primary.left_percent,
          resets: codexProvider.primary.reset_description,
        } : null,
        weeklyAll: codexProvider.secondary ? {
          percent: codexProvider.secondary.left_percent,
          resets: codexProvider.secondary.reset_description,
        } : null,
        weeklySonnet: null,
        lastCheck: codexProvider.fetched_at || providerUsage?.updated_at || null,
        account_email: codexProvider.account_email || null,
      };
    }
  }

  return runtimeUsage;
}
