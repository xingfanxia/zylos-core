#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const PROVIDER_USAGE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'provider-usage.json');
const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PROVIDER_USAGE_INTERVAL_MS || '', 10) || 5 * 60 * 1000;
const DEFAULT_RETRY_MS = Number.parseInt(process.env.PROVIDER_USAGE_RETRY_MS || '', 10) || 60 * 1000;
const DEFAULT_CODEXBAR_BIN = process.env.CODEXBAR_BIN || path.join(ZYLOS_DIR, 'bin', 'codexbar');

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

export function writeProviderUsage(data, filePath = PROVIDER_USAGE_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

export function runProviderUsageOnce({
  execFileSyncImpl = execFileSync,
  filePath = PROVIDER_USAGE_FILE,
  log = console.log,
} = {}) {
  const fetchedAt = new Date().toISOString();
  const codexbarBin = resolveCodexBarBin();
  const claude = fetchProviderUsage('claude', { execFileSyncImpl, codexbarBin, now: fetchedAt });
  const codex = fetchProviderUsage('codex', { execFileSyncImpl, codexbarBin, now: fetchedAt });
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
