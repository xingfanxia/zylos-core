import fs from 'fs';
import path from 'path';
import os from 'os';

function resolveTilde(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
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

  const instances = {};
  for (const [id, data] of Object.entries(cached?.instances || {})) {
    instances[id] = {
      ...data,
      runtime: runtimeByInstance[id] || 'claude',
    };
  }

  const perInstance = Array.isArray(cached?.per_instance)
    ? cached.per_instance.map((row) => ({
        ...row,
        runtime: runtimeByInstance[row.instance_id] || 'claude',
      }))
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
