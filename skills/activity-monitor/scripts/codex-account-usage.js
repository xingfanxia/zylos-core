import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// The active-profile wrapper would select Azure while testing subscription.
// Use the raw CLI beside this Node runtime unless explicitly configured.
export function rawCodexQuotaProbeBin() {
  return process.env.CODEX_QUOTA_PROBE_BIN || path.join(path.dirname(process.execPath), 'codex');
}

export const CODEX_QUOTA_CACHE_MS = 120_000;
const MAX_RPC_BYTES = 1_000_000;
const fail = (code) => Object.assign(new Error(code), { code });

// Hashes only leave this module. Never publish account identifiers or tokens.
export function profileIdentity(codexHome, uid = process.getuid?.()) {
  const dir = fs.statSync(codexHome);
  const authPath = path.join(codexHome, 'auth.json');
  const authStat = fs.statSync(authPath);
  if (!dir.isDirectory() || !authStat.isFile() || dir.uid !== uid || authStat.uid !== uid) throw fail('profile_owner_mismatch');
  if ((dir.mode & 0o077) || (authStat.mode & 0o077)) throw fail('profile_not_private');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (auth.auth_mode && auth.auth_mode !== 'chatgpt') throw fail('subscription_auth_required');
  return accountIdentity(auth);
}

// Metadata-only read for an operator's already-authorized per-persona scope.
// It does not grant permission to launch a canary inside a different UID home.
export function readSubscriptionAccountKey(codexHome) {
  const auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
  if (auth.auth_mode && auth.auth_mode !== 'chatgpt') throw fail('subscription_auth_required');
  return accountIdentity(auth).accountKey;
}

function accountIdentity(auth) {
  const accountId = auth.tokens?.account_id || auth.account_id;
  let subject;
  try {
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
    subject = claims.sub;
    const jwtAccount = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (jwtAccount && jwtAccount !== accountId) throw fail('account_identity_mismatch');
  } catch (error) {
    if (error.code === 'account_identity_mismatch') throw error;
  }
  if (typeof accountId !== 'string' || !accountId || typeof subject !== 'string' || !subject) throw fail('account_identity_unavailable');
  const accountKey = createHash('sha256').update(JSON.stringify([accountId, subject])).digest('hex');
  return { accountId, accountKey };
}

function unavailable(error, checkedAt, extra = {}) {
  return { provider: 'codex', available: false, quota_authoritative: false,
    source: 'codex-account-api', freshness: 'unknown', observed_at: null, fetched_at: null,
    checked_at: checkedAt, error, primary: null, secondary: null, tertiary: null,
    account_email: null, ...extra };
}

function normalizeWindow(window, nowMs) {
  if (!window) return null;
  const { usedPercent, windowDurationMins, resetsAt } = window;
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || !Number.isInteger(windowDurationMins) || windowDurationMins <= 0 ||
      !Number.isFinite(resetsAt)) throw fail('quota_window_invalid');
  if (resetsAt * 1000 <= nowMs) throw fail('quota_window_expired');
  return { used_percent: usedPercent, left_percent: Math.max(0, 100 - usedPercent),
    window_minutes: windowDurationMins, resets_at: new Date(resetsAt * 1000).toISOString() };
}

export function normalizeCodexAccountUsage(response, { observedAt, accountKey } = {}) {
  const nowMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs)) throw fail('quota_timestamp_invalid');
  const defaults = response?.rateLimits;
  const limits = response?.rateLimitsByLimitId?.codex ||
    (defaults && (!defaults.limitId || defaults.limitId === 'codex') ? defaults : null);
  if (!limits || (limits.limitId && limits.limitId !== 'codex')) throw fail('codex_limit_missing');
  const windows = [limits.primary, limits.secondary].map((w) => normalizeWindow(w, nowMs)).filter(Boolean);
  if (!windows.length) throw fail('quota_windows_missing');
  const primary = windows.find((w) => w.window_minutes === 300) || null;
  const secondary = windows.find((w) => w.window_minutes === 10080) || null;
  const tertiary = windows.find((w) => w !== primary && w !== secondary) || null;
  return { provider: 'codex', available: true, quota_authoritative: true,
    source: 'codex-account-api', freshness: 'fresh', observed_at: observedAt, fetched_at: observedAt,
    account_key: accountKey, account_email: null, login_method: 'chatgpt',
    rate_limit_reached_type: limits.rateLimitReachedType || null,
    spend_control_reached: limits.spendControlReached ?? null,
    primary, secondary, tertiary };
}

/** Fresh read only: initialize + account/rateLimits/read, never thread/turn/config operations. */
export async function readCodexAccountRateLimits({ codexHome, codexBin, timeoutMs = 12_000, spawnImpl = spawn } = {}) {
  profileIdentity(codexHome, process.getuid?.()); // public probe boundary also forbids cross-UID homes
  const environment = {};
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) if (process.env[key] !== undefined) environment[key] = process.env[key];
  environment.CODEX_HOME = codexHome;
  const detached = process.platform !== 'win32';
  const child = spawnImpl(codexBin, ['app-server', '--listen', 'stdio://'], {
    env: environment, stdio: ['pipe', 'pipe', 'ignore'], detached,
  });
  child.stdout.setEncoding('utf8');
  let finished = false;
  const exited = new Promise((resolve) => { child.once('exit', () => { finished = true; resolve(); }); child.once('error', () => { finished = true; resolve(); }); });
  const groupPid = detached ? child.pid : null;
  const ownedProcessesRemain = () => {
    if (!groupPid) return !finished;
    try { process.kill(-groupPid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  const signal = (kind) => {
    // A wrapper can exit before its descendants. Its exit does not release our
    // responsibility for the dedicated process group created by detached spawn.
    try { if (groupPid) process.kill(-groupPid, kind); else if (!finished) child.kill(kind); }
    catch { /* already exited */ }
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      let buffer = '', bytes = 0, initialized = false;
      const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
      timer = setTimeout(() => reject(fail('quota_probe_timeout')), timeoutMs);
      child.once('error', () => reject(fail('quota_probe_launch_failed')));
      child.once('exit', () => reject(fail('quota_probe_exited')));
      child.stdin.on('error', () => reject(fail('quota_probe_exited')));
      child.stdout.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_RPC_BYTES) return reject(fail('quota_response_too_large'));
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { return reject(fail('quota_response_invalid')); }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) return reject(fail('quota_rpc_error'));
          if (message.id === 1 && !initialized) {
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' }); // protocol params is null, not {}
          } else if (message.id === 2 && initialized) resolve(message.result);
        }
      });
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'zylos_quota_collector', version: '1' }, capabilities: { experimentalApi: true },
      } });
    });
  } finally {
    clearTimeout(timer);
    signal('SIGTERM');
    const graceDeadline = Date.now() + 500;
    while (ownedProcessesRemain() && Date.now() < graceDeadline) await pause(25);
    if (ownedProcessesRemain()) signal('SIGKILL');
    // Reap our direct child, without an unbounded wait if its exit cannot be
    // observed. Orphan descendants are reaped by the OS after the group kill.
    if (!finished) await Promise.race([exited, pause(500)]);
    if (!finished) throw fail('quota_probe_cleanup_failed');
  }
}

function freshCache(cache, accountKey, nowMs, maxAgeMs) {
  const observed = Date.parse(cache?.observed_at);
  const windows = [cache?.primary, cache?.secondary, cache?.tertiary].filter(Boolean);
  return cache?.available === true && cache?.quota_authoritative === true && cache?.source === 'codex-account-api' &&
    cache.account_key === accountKey && Number.isFinite(observed) && observed <= nowMs && nowMs - observed < maxAgeMs &&
    windows.length > 0 && windows.every((w) => Number.isFinite(w.used_percent) && w.used_percent >= 0 &&
      Number.isInteger(w.window_minutes) && w.window_minutes > 0 && Date.parse(w.resets_at) > nowMs);
}

export async function fetchCodexAccountUsage({
  codexHome = process.env.CODEX_SUBSCRIPTION_HOME || path.join(os.homedir(), '.codex-subscription'),
  codexBin = rawCodexQuotaProbeBin(),
  cacheFile = path.join(codexHome, 'zylos-rate-limits-cache.json'),
  cacheMaxAgeMs = CODEX_QUOTA_CACHE_MS,
  now = () => new Date().toISOString(),
  readImpl = readCodexAccountRateLimits,
} = {}) {
  const checkedAt = now();
  const uid = process.getuid?.();
  let identity;
  try { identity = profileIdentity(codexHome, uid); }
  catch (error) { return unavailable(error.code?.startsWith('profile_') || error.code?.startsWith('account_') || error.code === 'subscription_auth_required' ? error.code : 'subscription_profile_unavailable', checkedAt); }
  if (cacheFile) {
    try {
      const stat = fs.lstatSync(cacheFile);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && !(stat.mode & 0o077) && stat.size < 16384) {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (freshCache(cache, identity.accountKey, Date.parse(checkedAt), Math.min(cacheMaxAgeMs, CODEX_QUOTA_CACHE_MS))) {
          return { ...cache, checked_at: checkedAt, cache_used: true }; // do not renew observation time
        }
      }
    } catch { /* unavailable cache requires a fresh RPC */ }
  }
  let snapshot;
  try {
    const response = await readImpl({ codexHome, codexBin });
    if (response?.accountId && response.accountId !== identity.accountId) throw fail('quota_account_mismatch');
    snapshot = normalizeCodexAccountUsage(response, { observedAt: now(), accountKey: identity.accountKey });
  } catch (error) {
    return unavailable(error.code?.startsWith('quota_') || error.code === 'codex_limit_missing' ? error.code : 'quota_probe_failed', now(), { account_key: identity.accountKey });
  }
  if (cacheFile) {
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(snapshot) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, cacheFile); }
    catch { /* cache failure does not invalidate a successful official read */ }
    finally { try { fs.unlinkSync(temporary); } catch { /* absent */ } }
  }
  return { ...snapshot, checked_at: snapshot.observed_at, cache_used: false };
}
