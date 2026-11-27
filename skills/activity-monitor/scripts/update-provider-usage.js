#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { readClaudeUsageFromMonitorFiles } from './usage-monitor-file-reader.js';
import { readCodexUsageFromActiveRollout } from './usage-codex-rollout-reader.js';
import { fetchCodexAccountUsage, rawCodexQuotaProbeBin } from './codex-account-usage.js';
import { refreshQuotaRecoveryProofs } from './codex-quota-recovery.js';
import { ineligibleProfiles, sharedProjectTokenFile } from '../../multi-session/runtime-files.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const PROVIDER_USAGE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'provider-usage.json');
const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PROVIDER_USAGE_INTERVAL_MS || '', 10) || 60 * 1000;
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
    const usage = normalizeProviderPayload(provider, JSON.parse(raw), now);
    // A successful live CLI probe is a current account observation. Native
    // monitor-file fallbacks stay non-authoritative: they freeze on switch.
    return usage.available ? { ...usage, quota_authoritative: true, observed_at: now } : usage;
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

/**
 * Probe one extra Claude subscription account (profile usage_provider
 * claude-<account>) through CodexBar with a private CLAUDE_CONFIG_DIR holding
 * only that account's setup-token plus the operator's onboarding state.
 */
export function fetchClaudeAccountUsage(provider, settingsFile, {
  execFileSyncImpl = execFileSync,
  codexbarBin = resolveCodexBarBin(),
  now = new Date().toISOString(),
  homeDir = os.homedir(),
  cwd = ZYLOS_DIR,
} = {}) {
  let configDir = null;
  try {
    const token = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.env?.CLAUDE_CODE_OAUTH_TOKEN;
    if (typeof token !== 'string' || !token.startsWith('sk-ant-')) throw new Error('settings file has no setup-token');
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-claude-usage-'));
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: token, refreshToken: '', expiresAt: Date.parse(now) + 300 * 86_400_000,
      scopes: ['user:inference', 'user:sessions:claude_code'],
    } }), { mode: 0o600 });
    const state = path.join(homeDir, '.claude.json');
    if (fs.existsSync(state)) fs.copyFileSync(state, path.join(configDir, '.claude.json'));
    const raw = execFileSyncImpl(codexbarBin, ['usage', '--provider', 'claude', '--source', 'cli', '--json-only'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
    const usage = { ...normalizeProviderPayload('claude', JSON.parse(raw), now), provider };
    return usage.available ? { ...usage, quota_authoritative: true, observed_at: now } : usage;
  } catch (err) {
    return { provider, available: false, fetched_at: now, source: 'cli', error: err.message,
      primary: null, secondary: null, tertiary: null, account_email: null, version: null };
  } finally {
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  }
}

// Extra Claude accounts to probe, and those whose every profile is on a plan
// that is not eligible (runtime_failover.ineligible_profiles): their probe
// cannot succeed, so it is not run until the profile leaves that list.
function extraClaudeAccounts(document) {
  const accounts = new Map();
  const ineligible = new Map();
  const skipped = ineligibleProfiles(document?.runtime_failover);
  for (const [id, profile] of Object.entries(document?.runtime_profiles || {})) {
    if (profile?.runtime === 'claude' && /^claude-[a-z0-9-]+$/.test(profile.usage_provider || '')
        && typeof profile.claude_settings_file === 'string') {
      if (skipped.has(id)) ineligible.set(profile.usage_provider, [...(ineligible.get(profile.usage_provider) || []), id]);
      else accounts.set(profile.usage_provider, profile.claude_settings_file);
    }
  }
  for (const provider of accounts.keys()) ineligible.delete(provider);
  return { accounts, ineligible };
}

function ineligibleAccountUsage(provider, profileIds, now) {
  return {
    provider,
    available: false,
    plan_eligible: false,
    fetched_at: now,
    source: 'policy',
    error: `plan not eligible (runtime_failover.ineligible_profiles: ${profileIds.join(', ')}); not probed`,
    primary: null,
    secondary: null,
    tertiary: null,
    account_email: null,
    version: null,
  };
}

export function fetchClaudeNativeUsage({
  zylosDir = ZYLOS_DIR,
  now = new Date().toISOString(),
  readImpl = readClaudeUsageFromMonitorFiles,
  statImpl = fs.statSync,
} = {}) {
  const monitorDir = path.join(zylosDir, 'activity-monitor');
  const statuslineFile = path.join(monitorDir, 'statusline.json');
  const usageStateFile = path.join(monitorDir, 'usage.json');
  const usage = readImpl({ statuslineFile, usageStateFile });
  // The reading is as old as the monitor file it came from. Stamping it with
  // the poll time made a file nothing writes any more look current.
  let observedAt = null;
  if (usage) {
    try {
      observedAt = new Date(statImpl(usage.statusShape === 'usage_json' ? usageStateFile : statuslineFile).mtimeMs)
        .toISOString();
    } catch { /* removed between read and stat */ }
  }

  if (!usage || !observedAt) {
    return {
      provider: 'claude',
      available: false,
      fetched_at: now,
      source: 'zylos-native',
      error: usage ? 'Claude monitor file has no observation time' : 'No Claude usage data found in monitor files',
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
  const native = normalizeNativeClaudeUsage({
    session: hasFiveHour ? usage.fiveHourPercent : usage.sessionPercent,
    sessionResets: hasFiveHour ? usage.fiveHourResets : usage.sessionResets,
    sessionResetsAt: hasFiveHour ? usage.fiveHourResetsAt : usage.sessionResetsAt,
    weeklyAll: usage.weeklyAllPercent,
    weeklyAllResets: usage.weeklyAllResets,
    weeklyAllResetsAt: usage.weeklyAllResetsAt,
    weeklySonnet: usage.weeklySonnetPercent,
    weeklySonnetResets: usage.weeklySonnetResets,
  }, observedAt);
  // fetched_at and observed_at carry the file time, which every age check
  // reads; checked_at is this poll. Never authoritative: the files freeze
  // when the session leaves Claude.
  return { ...native, observed_at: observedAt, checked_at: now, quota_authoritative: false };
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
      quota_authoritative: false,
      fetched_at: null,
      observed_at: null,
      checked_at: now,
      freshness: 'unknown',
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
  const observedMs = Date.parse(usage.observedAt);
  const observedAt = Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null;
  const age = observedAt ? Date.parse(now) - observedMs : null;
  return {
    provider: 'codex',
    available: false,
    quota_authoritative: false,
    fetched_at: null,
    observed_at: observedAt,
    checked_at: now,
    freshness: age !== null && age > 180000 ? 'stale' : 'unknown',
    error: 'Official Codex quota unavailable; retained rollout data is historical',
    source: 'zylos-native-rollout',
    version: null,
    account_email: null,
    login_method: 'chatgpt',
    primary: window(usage.fiveHourPercent, 300, usage.fiveHourResetsAt, usage.fiveHourResets),
    secondary: window(usage.weeklyAllPercent, 10080, usage.weeklyAllResetsAt, usage.weeklyAllResets),
    tertiary: null,
  };
}

// The temp file is this process's own: two writers sharing one temp name can
// rename a mix of both documents into place, and an unparseable published file
// then fails every later pass. A write within one process is synchronous.
export function writeProviderUsage(data, filePath = PROVIDER_USAGE_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* never created */ }
    throw err;
  }
}

// Absent is a first run. A file that exists but cannot be read or parsed is
// never overwritten: the pass fails and the daemon retries. Our own writes are
// temp file + rename, so they never leave a partial document behind.
function readPublishedUsage(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`cannot read ${filePath}: ${err?.code || 'read error'}`);
  }
  let document = null;
  try { document = JSON.parse(raw); } catch { /* reported below */ }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`cannot parse ${filePath}: EPARSE`);
  }
  return document;
}

// The profile list names the extra Claude accounts. Neither file existing is a
// host with none; a file that exists but cannot be read leaves them unknown.
function readInventory(zylosDir) {
  for (const file of [path.join(zylosDir, 'instances.json'), path.join(zylosDir, '.zylos', 'runtime-profiles.json')]) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      return { ok: false, error: `${file}: ${err?.code || 'read error'}` };
    }
    try {
      const document = JSON.parse(raw);
      if (document && typeof document === 'object' && !Array.isArray(document)) return { ok: true, document };
    } catch { /* reported below */ }
    return { ok: false, error: `${file}: EPARSE` };
  }
  return { ok: true, document: undefined };
}

/**
 * One pass over every account. Each observation is dated by the moment its
 * own probe started and is published as soon as it returns: the probes run
 * one after another (three Claude probes take ~2 minutes), and the failover
 * treats a reading older than usage_max_age_sec (180 s) as unknown, so a
 * reading held back until the end of the pass was mostly stale on arrival.
 *
 * Every publish reads the file as it is at that moment and replaces only the
 * entry just probed: the codex rotation handoff runs a one-shot pass after a
 * credential change, and an entry this process did not just probe must never
 * be written back from memory over another writer's newer one. `updated_at`
 * is the time of the write, never the age of any entry. quota_recovery is
 * refreshed once, at the end, and the final write drops providers this pass
 * did not probe (only this updater writes provider entries) when the profile
 * list was read; if it could not be, nothing is pruned.
 *
 * Caller contract: the daemon is the only standing writer. The Codex rotation
 * handoff runs no pass of its own; it waits for the daemon's reading of the new
 * account (runtime-failover counts a Codex reading only for the account
 * installed now). The only other caller is the herdr setup script's one-shot,
 * which can overlap a daemon pass on the same accounts: nothing here prevents
 * that, and one overlapping publish can lose the other's update of an entry,
 * leaving an older same-account reading that may still count, until that
 * entry's next probe. Each writer has its own temp file, so the
 * published file is always one complete document.
 */
export async function runProviderUsageOnce({
  execFileSyncImpl = execFileSync,
  filePath = PROVIDER_USAGE_FILE,
  fetchClaudeNativeUsageImpl = fetchClaudeNativeUsage,
  fetchCodexNativeUsageImpl = fetchCodexNativeUsage,
  fetchCodexAccountUsageImpl = fetchCodexAccountUsage,
  refreshQuotaRecoveryProofsImpl = refreshQuotaRecoveryProofs,
  fetchClaudeAccountUsageImpl = fetchClaudeAccountUsage,
  nowImpl = () => new Date().toISOString(),
  zylosDir = ZYLOS_DIR,
  log = console.log,
} = {}) {
  const codexbarBin = resolveCodexBarBin();
  readPublishedUsage(filePath); // an unreadable file fails the pass before any probe
  const probed = new Set();
  const publish = (entries, final = null) => {
    const onDisk = readPublishedUsage(filePath);
    let providers = { ...(onDisk.providers && typeof onDisk.providers === 'object' ? onDisk.providers : {}), ...entries };
    if (final?.prune) providers = Object.fromEntries(Object.entries(providers).filter(([provider]) => probed.has(provider)));
    const payload = { ...onDisk, updated_at: nowImpl(), source_bin: codexbarBin,
      ...(final && 'quotaRecovery' in final ? { quota_recovery: final.quotaRecovery } : {}), providers };
    writeProviderUsage(payload, filePath);
    return payload;
  };
  const observe = (provider, entry) => {
    probed.add(provider);
    publish({ [provider]: entry });
  };

  // `claude` is the account a Claude launch without its own account file runs
  // on: the shared project token when that file holds one (the launch passes
  // the same file with --settings), else the operator's own login.
  const sharedTokenFile = sharedProjectTokenFile(zylosDir);
  const claudeStartedAt = nowImpl();
  let claude = sharedTokenFile
    ? fetchClaudeAccountUsageImpl('claude', sharedTokenFile, { execFileSyncImpl, codexbarBin, now: claudeStartedAt })
    : fetchProviderUsage('claude', { execFileSyncImpl, codexbarBin, now: claudeStartedAt });
  if (!claude.available) {
    // The top-level monitor files are the live session's only on a
    // single-session host. With instances.json every instance writes its own,
    // and the top-level ones belong to no account.
    const nativeClaude = fs.existsSync(path.join(zylosDir, 'instances.json'))
      ? { available: false, error: 'Multi-instance host: top-level monitor files belong to no account' }
      : fetchClaudeNativeUsageImpl({ zylosDir, now: nowImpl() });
    if (nativeClaude.available) {
      claude = { ...nativeClaude, probe_error: claude.error || null };
    } else {
      claude = {
        ...claude,
        fallback_error: nativeClaude.error || null,
      };
    }
  }
  observe('claude', claude);

  let codex = await fetchCodexAccountUsageImpl({ codexHome: DEFAULT_CODEX_SUBSCRIPTION_HOME,
    codexBin: rawCodexQuotaProbeBin(), now: nowImpl });
  if (!codex.available) {
    const nativeCodex = fetchCodexNativeUsageImpl({ now: nowImpl() });
    codex = { ...nativeCodex, available: false, quota_authoritative: false, fetched_at: null,
      account_key: codex.account_key || null, api_error: codex.error || 'quota_probe_failed' };
  }
  observe('codex', codex);

  const inventory = readInventory(zylosDir);
  if (!inventory.ok) {
    // Which accounts exist is unknown: probe none, prune none, and keep the
    // published recovery proofs (they cannot be refreshed without the holds).
    const payload = publish({}, {});
    log(`[update-provider-usage] Written ${filePath} without pruning; profile list unreadable (${inventory.error})`);
    return payload;
  }
  const { document } = inventory;
  const extra = extraClaudeAccounts(document);
  for (const [provider, settingsFile] of extra.accounts) {
    observe(provider, fetchClaudeAccountUsageImpl(provider, settingsFile,
      { execFileSyncImpl, codexbarBin, now: nowImpl() }));
  }
  for (const [provider, profileIds] of extra.ineligible) observe(provider, ineligibleAccountUsage(provider, profileIds, nowImpl()));

  const quotaRecovery = await refreshQuotaRecoveryProofsImpl({ zylosDir, document });
  // The final write drops accounts no longer configured, so a removed
  // profile's last reading cannot outlive it.
  const payload = publish({}, { quotaRecovery, prune: true });
  log(`[update-provider-usage] Written ${filePath}`);
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Passes are paced start to start: the next one begins intervalMs after the
 * previous one began, or after 1 s when a pass ran longer than that. A thrown
 * pass waits retryMs.
 */
export async function runDaemon({
  intervalMs = DEFAULT_INTERVAL_MS,
  retryMs = DEFAULT_RETRY_MS,
  once = runProviderUsageOnce,
  sleepImpl = sleep,
  nowMsImpl = Date.now,
  log = console.log,
  error = console.error,
} = {}) {
  log(`[update-provider-usage] Daemon mode started (interval=${intervalMs}ms retry=${retryMs}ms)`);
  while (true) {
    const startedMs = nowMsImpl();
    let delay;
    try {
      await once({ log });
      delay = Math.max(1000, intervalMs - (nowMsImpl() - startedMs));
    } catch (err) {
      delay = retryMs;
      error(`[update-provider-usage] ${err.message}`);
    }
    await sleepImpl(delay);
  }
}

async function main() {
  const daemonMode = process.argv.includes('--daemon');
  if (daemonMode) {
    await runDaemon();
    return;
  }
  await runProviderUsageOnce();
}

if (process.env.UPDATE_PROVIDER_USAGE_DISABLE_MAIN !== '1') {
  await main();
}
