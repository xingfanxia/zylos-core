/**
 * Fable allowance probe (FG-1). One lean headless Fable request per account
 * reads the account's weekly Fable window from the CLI's stream-json
 * `rate_limit_event.rate_limit_info.unifiedWindows.seven_day_overage_included`.
 * Only Fable requests carry that window; setup-tokens cannot read
 * /api/oauth/usage. Contract: docs/fable-allowance-guard.md.
 *
 * The probe never copies a token: `--settings` references the account's own
 * settings file, and HOME / CLAUDE_CONFIG_DIR / cwd are a private temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 90_000;
const VERSION_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESET_AHEAD_MS = 8 * 86_400_000;
const RECENT_LIMIT = 8;
const FABLE_WINDOW = 'seven_day_overage_included';
// Explicit Fable exhaustion wording on an error result (CLI 2.1.322 strings).
const FABLE_REJECTION_TEXT = /Fable limit|included Fable usage|model_requires_usage_credits|requires usage credits/i;
const RATE_LIMIT_TEXT = /\b429\b|rate[ _-]?limit|too many requests/i;

export function baseModel(model) {
  return typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : null;
}

export function parseCliVersion(text) {
  const match = String(text || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

export function probeArgs({ model, settingsFile }) {
  return [
    '-p', 'Reply OK',
    '--model', baseModel(model),
    '--system-prompt', 'Reply with OK.',
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', settingsFile,
    '--strict-mcp-config',
    '--max-turns', '1',
  ];
}

function parseEvents(stdout) {
  const events = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch { /* partial line */ }
  }
  return events;
}

function resetIso(seconds, nowMs) {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= nowMs || ms - nowMs > MAX_RESET_AHEAD_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * Classify one probe run. Outcomes:
 *  - valid:        a usable observation (every validity rule in FG-1 holds)
 *  - rejected:     explicit Fable rejection = exhaustion evidence (any exit code)
 *  - rate_limited: generic 429 / limit without a Fable claim (backoff, no observation)
 *  - invalid:      anything else (no observation)
 */
export function classifyProbeOutput({
  stdout = '',
  stderr = '',
  exitCode,
  fableModel,
  nowMs,
  cliVersion,
  account,
  settingsFile,
} = {}) {
  const events = parseEvents(stdout);
  const info = events.filter(event => event?.type === 'rate_limit_event' && event.rate_limit_info)
    .at(-1)?.rate_limit_info || null;
  const window = info?.unifiedWindows?.[FABLE_WINDOW] || null;
  const result = events.filter(event => event?.type === 'result').at(-1) || null;
  const failed = exitCode !== 0 || result?.is_error === true;
  const errorText = failed
    ? [result?.result, result?.error, ...(Array.isArray(result?.errors) ? result.errors : []), stderr]
      .filter(value => typeof value === 'string').join('\n')
    : '';
  const invalid = reason => ({ outcome: 'invalid', reason });

  if (window?.status === 'rejected'
      || (info?.status === 'rejected' && info.rateLimitType === FABLE_WINDOW)
      || info?.isUsingOverage === true
      || FABLE_REJECTION_TEXT.test(errorText)) {
    const resetSeconds = window?.resetsAt ?? (info?.rateLimitType === FABLE_WINDOW ? info.resetsAt : null);
    return {
      outcome: 'rejected',
      reason: info?.isUsingOverage === true ? 'using_overage' : 'fable_rejected',
      resets_at: resetIso(resetSeconds, nowMs),
    };
  }
  if (info?.status === 'rejected' || (failed && RATE_LIMIT_TEXT.test(errorText))) {
    return { outcome: 'rate_limited', reason: 'rate_limited' };
  }
  if (exitCode !== 0) return invalid(`exit_${exitCode}`);
  if (!result || result.is_error) return invalid('result_error');

  const models = Object.keys(result.modelUsage || {});
  if (models.length === 0) {
    for (const event of events) {
      if (event?.type === 'assistant' && typeof event.message?.model === 'string') models.push(event.message.model);
    }
  }
  const fableBase = baseModel(fableModel);
  if (models.length === 0 || models.some(model => baseModel(model) !== fableBase)) return invalid('model_mismatch');
  if (!window) return invalid('fable_window_missing');
  const utilization = Number(window.utilization);
  if (window.utilization == null || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) {
    return invalid('utilization_out_of_range');
  }
  const resetsAt = resetIso(window.resetsAt, nowMs);
  if (!resetsAt) return invalid('reset_out_of_range');
  if (!account || !settingsFile) return invalid('account_unbound');
  if (!cliVersion) return invalid('cli_version_unknown');
  return {
    outcome: 'valid',
    observation: {
      account,
      utilization,
      resets_at: resetsAt,
      observed_at: new Date(nowMs).toISOString(),
      cli_version: cliVersion,
      model: fableBase,
      status: typeof window.status === 'string' ? window.status : null,
    },
  };
}

export function runCommand(command, args, { env, cwd, timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr: err.message, timedOut });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = (chunk, key) => {
      if (key === 'stdout' && stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
      if (key === 'stderr' && stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', chunk => collect(chunk, 'stderr'));
    child.on('error', err => { stderr += err.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export function resolveProbeClaudeBin(homeDir = os.homedir()) {
  if (process.env.FABLE_PROBE_CLAUDE_BIN) return process.env.FABLE_PROBE_CLAUDE_BIN;
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const local = path.join(homeDir, '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

export async function runFableProbe({
  account,
  settingsFile,
  fableModel,
  claudeBin = resolveProbeClaudeBin(),
  run = runCommand,
  now = () => Date.now(),
  tmpRoot = os.tmpdir(),
  homeDir = os.homedir(),
} = {}) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, 'zylos-fable-probe-'));
    for (const sub of ['cfg', 'home', 'work']) fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
    const options = {
      cwd: path.join(dir, 'work'),
      env: {
        PATH: [path.join(homeDir, '.local', 'bin'), process.env.PATH || '/usr/bin:/bin'].join(':'),
        HOME: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'),
        DISABLE_AUTOUPDATER: '1',
      },
    };
    const version = await run(claudeBin, ['--version'], { ...options, timeoutMs: VERSION_TIMEOUT_MS });
    const cliVersion = version.code === 0 ? parseCliVersion(version.stdout) : null;
    const probe = await run(claudeBin, probeArgs({ model: fableModel, settingsFile }), { ...options, timeoutMs: PROBE_TIMEOUT_MS });
    return classifyProbeOutput({
      stdout: probe.stdout,
      stderr: probe.stderr,
      exitCode: probe.timedOut ? 'timeout' : probe.code,
      fableModel,
      nowMs: now(),
      cliVersion,
      account,
      settingsFile,
    });
  } catch (err) {
    return { outcome: 'invalid', reason: `probe_error:${err.message}` };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fold one probe result into the usage store. Only a valid observation
 * replaces `last_valid`; a generic 429 backs off (bounded by
 * probe_backoff_max_sec) without touching the lease, which is measured from
 * `last_valid.observed_at` alone.
 */
export function recordProbeResult(store, { account, result, nowMs, config }) {
  const next = structuredClone(store && typeof store === 'object' ? store : {});
  next.version = 1;
  next.accounts = next.accounts && typeof next.accounts === 'object' ? next.accounts : {};
  const entry = { failures: 0, recent: [], ...(next.accounts[account] || {}) };
  const at = new Date(nowMs).toISOString();
  const intervalMs = config.probe_interval_sec * 1000;
  entry.last_attempt = { at, outcome: result.outcome, reason: result.reason || null };
  entry.recent = [...(Array.isArray(entry.recent) ? entry.recent : []), {
    at,
    outcome: result.outcome,
    ...(result.outcome === 'valid'
      ? { utilization: result.observation.utilization, resets_at: result.observation.resets_at } : {}),
  }].slice(-RECENT_LIMIT);
  let delayMs = intervalMs;
  if (result.outcome === 'valid') {
    entry.last_valid = result.observation;
    entry.failures = 0;
  } else if (result.outcome === 'rejected') {
    entry.rejection = { at, resets_at: result.resets_at || null, detail: result.reason || 'fable_rejected' };
    entry.failures = 0;
  } else if (result.outcome === 'rate_limited') {
    entry.failures = (Number(entry.failures) || 0) + 1;
    delayMs = Math.min(intervalMs * 2 ** entry.failures, config.probe_backoff_max_sec * 1000);
  }
  entry.next_probe_at = new Date(nowMs + delayMs).toISOString();
  next.accounts[account] = entry;
  next.updated_at = at;
  return next;
}

export function probeDue(store, account, nowMs) {
  const nextMs = Date.parse(store?.accounts?.[account]?.next_probe_at || '');
  // A next_probe_at far in the future (clock stepped back) never strands an account.
  return !Number.isFinite(nextMs) || nextMs <= nowMs || nextMs - nowMs > 3_600_000;
}
