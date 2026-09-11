#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { readClaudeUsageFromMonitorFiles } from './usage-monitor-file-reader.js';
import { readCodexUsageFromActiveRollout } from './usage-codex-rollout-reader.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const PROVIDER_USAGE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'provider-usage.json');
const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PROVIDER_USAGE_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
const DEFAULT_RETRY_MS = Number.parseInt(process.env.PROVIDER_USAGE_RETRY_MS || '', 10) || 60 * 1000;
const DEFAULT_CODEXBAR_BIN = process.env.CODEXBAR_BIN || path.join(ZYLOS_DIR, 'bin', 'codexbar');
const DEFAULT_CODEX_SUBSCRIPTION_HOME = process.env.CODEX_SUBSCRIPTION_HOME
  || path.join(os.homedir(), '.codex-subscription');

function resolveCodexBarBin() {
  if (DEFAULT_CODEXBAR_BIN && fs.existsSync(DEFAULT_CODEXBAR_BIN)) return DEFAULT_CODEXBAR_BIN;
  return 'codexbar';
}

function normalizeWindow(window) {
  if (!window) return null;
  return {
    used_percent: window.usedPercent ?? null,
    left_percent: window.usedPercent === null || window.usedPercent === undefined
      ? null
      : Math.max(0, 100 - window.usedPercent),
    window_minutes: window.windowMinutes ?? null,
    resets_at: window.resetsAt ?? null,
    reset_description: window.resetDescription ?? null,
  };
}

export function normalizeProviderPayload(provider, payload, fetchedAt = new Date().toISOString()) {
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result || result.error) {
    return {
      provider,
      available: false,
      fetched_at: fetchedAt,
      source: result?.source || 'cli',
      error: result?.error?.message || 'Unknown provider usage error',
      primary: null,
      secondary: null,
      tertiary: null,
      account_email: null,
      version: result?.version || null,
    };
  }

  return {
    provider,
    available: true,
    fetched_at: fetchedAt,
    source: result.source || 'cli',
    version: result.version || null,
    account_email: result.usage?.identity?.accountEmail || result.usage?.accountEmail || null,
    login_method: result.usage?.identity?.loginMethod || result.usage?.loginMethod || null,
    primary: normalizeWindow(result.usage?.primary),
    secondary: normalizeWindow(result.usage?.secondary),
    tertiary: normalizeWindow(result.usage?.tertiary),
  };
}

// Reset epochs are the only signal that lets a consumer expire a stale
// window: monitor files stop refreshing once the persona switches runtime,
// so a frozen used_percent must self-zero when its published reset passes
// (runtime-failover.js windowUsedPercent). Same conversion as the codex
// window() helper below.
function nativeResetIso(epochSeconds) {
  if (epochSeconds == null || !Number.isFinite(Number(epochSeconds))) return null;
  return new Date(Number(epochSeconds) * 1000).toISOString();
}

export function normalizeNativeClaudeUsage(usage, fetchedAt = new Date().toISOString()) {
  return {
    provider: 'claude',
    available: true,
    fetched_at: fetchedAt,
    source: 'zylos-native',
    version: null,
    account_email: null,
    login_method: 'claude-cli',
    primary: usage?.session == null ? null : {
      used_percent: usage.session,
      left_percent: Math.max(0, 100 - usage.session),
      window_minutes: 300,
      resets_at: nativeResetIso(usage.sessionResetsAt),
      reset_description: usage.sessionResets || null,
    },
    secondary: usage?.weeklyAll == null ? null : {
      used_percent: usage.weeklyAll,
      left_percent: Math.max(0, 100 - usage.weeklyAll),
      window_minutes: 10080,
      resets_at: nativeResetIso(usage.weeklyAllResetsAt),
      reset_description: usage.weeklyAllResets || null,
    },
    tertiary: usage?.weeklySonnet == null ? null : {
      used_percent: usage.weeklySonnet,
      left_percent: Math.max(0, 100 - usage.weeklySonnet),
      window_minutes: 10080,
      resets_at: nativeResetIso(usage.weeklySonnetResetsAt),
      reset_description: usage.weeklySonnetResets || null,
    },
  };
}

export function fetchProviderUsage(provider, {
  execFileSyncImpl = execFileSync,
  codexbarBin = resolveCodexBarBin(),
  now = new Date().toISOString(),
} = {}) {
  try {
    const raw = execFileSyncImpl(codexbarBin, [
      'usage',
      '--provider', provider,
      '--source', 'cli',
      '--json-only',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: provider === 'claude' ? 45_000 : 20_000,
    });
    return normalizeProviderPayload(provider, JSON.parse(raw), now);
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const detail = stderr || stdout || err.message;
    return {
      provider,
      available: false,
      fetched_at: now,
      source: 'cli',
      error: detail,
      primary: null,
      secondary: null,
      tertiary: null,
      account_email: null,
      version: null,
    };
  }
}

export function fetchClaudeNativeUsage({
  zylosDir = ZYLOS_DIR,
  now = new Date().toISOString(),
  readImpl = readClaudeUsageFromMonitorFiles,
} = {}) {
  const monitorDir = path.join(zylosDir, 'activity-monitor');
  const usage = readImpl({
    statuslineFile: path.join(monitorDir, 'statusline.json'),
    usageStateFile: path.join(monitorDir, 'usage.json'),
  });

  if (!usage) {
    return {
      provider: 'claude',
      available: false,
      fetched_at: now,
      source: 'zylos-native',
      error: 'No Claude usage data found in monitor files',
      primary: null,
      secondary: null,
      tertiary: null,
      account_email: null,
      version: null,
    };
  }

  // Newer statuslines (Format B) report sessionPercent from context_window —
  // not a rate limit — and carry the genuine 5h window in fiveHourPercent.
  // Prefer the rate-limit window so the published primary never mistakes
  // context fill for provider usage; older shapes keep their session window.
  const hasFiveHour = usage.fiveHourPercent != null;
  return normalizeNativeClaudeUsage({
    session: hasFiveHour ? usage.fiveHourPercent : usage.sessionPercent,
    sessionResets: hasFiveHour ? usage.fiveHourResets : usage.sessionResets,
    sessionResetsAt: hasFiveHour ? usage.fiveHourResetsAt : usage.sessionResetsAt,
    weeklyAll: usage.weeklyAllPercent,
    weeklyAllResets: usage.weeklyAllResets,
    weeklyAllResetsAt: usage.weeklyAllResetsAt,
    weeklySonnet: usage.weeklySonnetPercent,
    weeklySonnetResets: usage.weeklySonnetResets,
  }, now);
}

export function fetchCodexNativeUsage({
  codexHome = DEFAULT_CODEX_SUBSCRIPTION_HOME,
  now = new Date().toISOString(),
  readImpl = readCodexUsageFromActiveRollout,
} = {}) {
  const usage = readImpl({ codexHome, instanceId: null });
  if (!usage || (usage.fiveHourPercent == null && usage.weeklyAllPercent == null)) {
    return {
      provider: 'codex',
      available: false,
      fetched_at: now,
      source: 'zylos-native-rollout',
      error: 'No Codex subscription rate-limit event found',
      primary: null,
      secondary: null,
      tertiary: null,
      account_email: null,
      version: null,
    };
  }

  const window = (percent, minutes, resetsAt, resetDescription) => percent == null ? null : {
    used_percent: percent,
    left_percent: Math.max(0, 100 - percent),
    window_minutes: minutes,
    resets_at: resetsAt == null ? null : new Date(Number(resetsAt) * 1000).toISOString(),
    reset_description: resetDescription || null,
  };
  return {
    provider: 'codex',
    available: true,
    fetched_at: now,
    source: 'zylos-native-rollout',
    version: null,
    account_email: null,
    login_method: 'chatgpt',
    primary: window(usage.fiveHourPercent, 300, usage.fiveHourResetsAt, usage.fiveHourResets),
    secondary: window(usage.weeklyAllPercent, 10080, usage.weeklyAllResetsAt, usage.weeklyAllResets),
    tertiary: null,
  };
}

export function writeProviderUsage(data, filePath = PROVIDER_USAGE_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

export function runProviderUsageOnce({
  execFileSyncImpl = execFileSync,
  filePath = PROVIDER_USAGE_FILE,
  fetchClaudeNativeUsageImpl = fetchClaudeNativeUsage,
  fetchCodexNativeUsageImpl = fetchCodexNativeUsage,
  log = console.log,
} = {}) {
  const fetchedAt = new Date().toISOString();
  const codexbarBin = resolveCodexBarBin();
  let claude = fetchProviderUsage('claude', { execFileSyncImpl, codexbarBin, now: fetchedAt });
  if (!claude.available) {
    const nativeClaude = fetchClaudeNativeUsageImpl({ zylosDir: ZYLOS_DIR, now: fetchedAt });
    if (nativeClaude.available) {
      claude = nativeClaude;
    } else {
      claude = {
        ...claude,
        fallback_error: nativeClaude.error || null,
      };
    }
  }
  let codex = fetchProviderUsage('codex', { execFileSyncImpl, codexbarBin, now: fetchedAt });
  if (!codex.available) {
    const nativeCodex = fetchCodexNativeUsageImpl({ now: fetchedAt });
    if (nativeCodex.available) {
      codex = nativeCodex;
    } else {
      codex = {
        ...codex,
        fallback_error: nativeCodex.error || null,
      };
    }
  }
  const payload = {
    updated_at: fetchedAt,
    source_bin: codexbarBin,
    providers: {
      claude,
      codex,
    },
  };
  writeProviderUsage(payload, filePath);
  log(`[update-provider-usage] Written ${filePath}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemon({
  intervalMs = DEFAULT_INTERVAL_MS,
  retryMs = DEFAULT_RETRY_MS,
  once = runProviderUsageOnce,
  log = console.log,
  error = console.error,
} = {}) {
  log(`[update-provider-usage] Daemon mode started (interval=${intervalMs}ms retry=${retryMs}ms)`);
  while (true) {
    let delay = intervalMs;
    try {
      once({ log });
    } catch (err) {
      delay = retryMs;
      error(`[update-provider-usage] ${err.message}`);
    }
    await sleep(delay);
  }
}

async function main() {
  const daemonMode = process.argv.includes('--daemon');
  if (daemonMode) {
    await runDaemon();
    return;
  }
  runProviderUsageOnce();
}

if (process.env.UPDATE_PROVIDER_USAGE_DISABLE_MAIN !== '1') {
  await main();
}
