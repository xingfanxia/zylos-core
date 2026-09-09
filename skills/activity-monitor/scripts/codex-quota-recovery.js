import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { profileIdentity, readSubscriptionAccountKey } from './codex-account-usage.js';

export const QUOTA_RECOVERY_INTERVAL_MS = 10 * 60_000;
export const QUOTA_PROOF_MAX_AGE_MS = 10 * 60_000;
const ANSWER = 'SUBSCRIPTION_RECOVERED';
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// Keep OAuth refreshes produced by the isolated CLI only if the original
// credential file has not changed meanwhile. Preserve its inode/mode/owner.
export function reconcileRefreshedAuth({ codexHome, temporaryHome, originalBytes, accountKey }) {
  const refreshed = fs.readFileSync(path.join(temporaryHome, 'auth.json'));
  if (refreshed.equals(originalBytes)) return 'unchanged';
  if (profileIdentity(temporaryHome).accountKey !== accountKey) return 'account_changed';
  const authFile = path.join(codexHome, 'auth.json');
  const fd = fs.openSync(authFile, 'r+');
  try {
    const stat = fs.fstatSync(fd), current = fs.readFileSync(fd);
    const named = fs.statSync(authFile);
    if (stat.ino !== named.ino || stat.dev !== named.dev || !current.equals(originalBytes)) return 'concurrent_change';
    fs.writeSync(fd, refreshed, 0, refreshed.length, 0);
    fs.ftruncateSync(fd, refreshed.length);
    fs.fsyncSync(fd);
    return 'preserved';
  } finally { fs.closeSync(fd); }
}

// One isolated model response, only when recovering a persisted quota hold.
// No user's workspace, configuration, MCP servers, hooks, plugins or tools.
export async function probeCodexQuotaRecovery({ codexHome, model, effort, codexBin = '/usr/bin/codex', timeoutMs = 60_000, spawnImpl = spawn } = {}) {
  const identity = profileIdentity(codexHome);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-quota-proof-'));
  fs.chmodSync(root, 0o700);
  const originalBytes = fs.readFileSync(path.join(codexHome, 'auth.json'));
  let child, timer;
  try {
    fs.writeFileSync(path.join(root, 'auth.json'), originalBytes, { mode: 0o600 });
    fs.chmodSync(path.join(root, 'auth.json'), 0o600);
    // The file may have rotated between identity read and copy.
    if (profileIdentity(root).accountKey !== identity.accountKey) throw Error('account_changed');
    fs.writeFileSync(path.join(root, 'config.toml'), [
      'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
      '[features]', 'shell_tool = false', 'shell_snapshot = false', 'hooks = false',
      'plugins = false', 'multi_agent = false', 'multi_agent_v2 = false', 'js_repl = false', '',
    ].join('\n'), { mode: 0o600 });
    const env = { HOME: root, CODEX_HOME: root };
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) if (process.env[key] !== undefined) env[key] = process.env[key];
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-m', model];
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push(`Reply exactly ${ANSWER}. Do not use tools.`);
    const result = await new Promise((resolve) => {
      let bytes = 0, buffer = '', answer = false, complete = false, invalid = false;
      child = spawnImpl(codexBin, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill?.('SIGKILL'); } };
      timer = setTimeout(() => { invalid = true; stop(); resolve(false); }, timeoutMs);
      child.once('error', () => resolve(false));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 128_000) { invalid = true; stop(); return; }
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { invalid = true; continue; }
          if (event.type === 'error' || event.type === 'turn.failed') invalid = true;
          if (event.type === 'turn.completed') complete = true;
          if (event.type?.startsWith('item.') && event.item?.type && event.item.type !== 'agent_message' && event.item.type !== 'reasoning') invalid = true;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim() === ANSWER) answer = true;
        }
      });
      child.once('exit', code => resolve(code === 0 && complete && answer && !invalid));
    });
    const refresh = reconcileRefreshedAuth({ codexHome, temporaryHome: root, originalBytes, accountKey: identity.accountKey });
    if (refresh === 'concurrent_change' || refresh === 'account_changed') return { ok: false, error: refresh };
    if (profileIdentity(codexHome).accountKey !== identity.accountKey) return { ok: false, error: 'account_changed' };
    return { ok: result, account_key: identity.accountKey, error: result ? null : 'subscription_probe_failed' };
  } finally {
    clearTimeout(timer);
    // Also reap descendants if a launcher exited before its children.
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function userHome(user) {
  if (!user || user === os.userInfo().username) return os.homedir();
  const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.split(':')[0] === user);
  const home = row?.split(':')[5];
  if (!home || !path.isAbsolute(home)) throw Error('persona_home_unknown');
  return home;
}

export function readCurrentSubscriptionAccountKeys(document, { homeForUser = userHome, readAccountKey = readSubscriptionAccountKey } = {}) {
  const profiles = document?.runtime_profiles || {};
  const states = document?.instances || { single: document };
  const result = {};
  for (const [id, state] of Object.entries(states)) {
    result[id] = {};
    for (const [profileId, profile] of Object.entries(profiles)) {
      if (profile?.usage_provider !== 'codex' || !profile.codex_home) continue;
      try {
        const home = profile.codex_home.replace(/^~/, homeForUser(state?.os_user));
        result[id][profileId] = readAccountKey(home);
      } catch { result[id][profileId] = null; }
    }
  }
  return document?.instances ? result : result.single;
}

export function collectQuotaHolds(document) {
  if (!document?.runtime_failover?.enabled || document.runtime_failover.auto_recover === false) return [];
  const profiles = document?.runtime_profiles || {};
  const states = document?.instances ? Object.values(document.instances) : [document];
  const holds = new Map();
  for (const state of states) {
    if (!state || state.enabled === false || (document?.instances && state.runtime_failover_enabled !== true)) continue;
    for (const [id, hold] of Object.entries(state.runtime_failover_blocked_profiles || {})) {
      const profile = profiles[id];
      if ((state.runtime_profile || state.active_profile) === id) continue;
      if (hold?.health !== 'rate_limited' || profile?.usage_provider !== 'codex' || !profile.model || !profile.codex_home) continue;
      const previous = holds.get(id);
      if (!previous || Date.parse(hold.blocked_at) > Date.parse(previous.hold.blocked_at)) holds.set(id, { id, profile, hold });
    }
  }
  return [...holds.values()];
}

export async function refreshQuotaRecoveryProofs({
  zylosDir, document,
  now = () => Date.now(),
  probeImpl = probeCodexQuotaRecovery,
  identityImpl = profileIdentity,
  codexBin = process.env.CODEX_QUOTA_PROBE_BIN || '/usr/bin/codex',
  cacheFile = path.join(zylosDir, 'activity-monitor', 'codex-quota-recovery.json'),
} = {}) {
  const holds = collectQuotaHolds(document);
  if (!holds.length) return {}; // Healthy agents never run a model canary.
  const cache = readJson(cacheFile, {});
  const receipts = {};
  for (const { id, profile, hold } of holds) {
    const home = profile.codex_home.replace(/^~/, os.homedir());
    let identity;
    try { identity = identityImpl(home); } catch { continue; }
    const previous = cache[id];
    const same = previous?.account_key === identity.accountKey && previous?.model === profile.model
      && previous?.reasoning_effort === (profile.reasoning_effort || null) && Date.parse(previous?.started_at) > Date.parse(hold.blocked_at);
    const nowMs = now();
    if (same && Number.isFinite(Date.parse(previous.checked_at)) && nowMs - Date.parse(previous.checked_at) >= 0
        && nowMs - Date.parse(previous.checked_at) < QUOTA_RECOVERY_INTERVAL_MS) {
      receipts[id] = previous;
      continue;
    }
    let proof;
    try { proof = await probeImpl({ codexHome: home, model: profile.model, effort: profile.reasoning_effort, codexBin }); }
    catch { proof = { ok: false }; }
    const checked = new Date(now()).toISOString();
    receipts[id] = cache[id] = {
      profile_id: id, account_key: identity.accountKey, model: profile.model,
      reasoning_effort: profile.reasoning_effort || null, blocked_at: hold.blocked_at,
      started_at: new Date(nowMs).toISOString(), checked_at: checked, observed_at: proof.ok ? checked : null,
      ok: proof.ok === true && proof.account_key === identity.accountKey,
    };
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(cache) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, cacheFile);
  return receipts;
}

export function verifiedQuotaRecoveries({ blockedProfiles = {}, profiles, providerUsage, nowMs, currentAccountKeys = {} }) {
  const proofs = providerUsage?.quota_recovery || {};
  const account = providerUsage?.providers?.codex?.account_key;
  const recovered = [];
  for (const [id, hold] of Object.entries(blockedProfiles)) {
    const proof = proofs[id], profile = profiles[id];
    const observed = Date.parse(proof?.observed_at), failed = Date.parse(hold?.blocked_at);
    if (hold?.health !== 'rate_limited' || !profile || proof?.ok !== true || !account || proof.account_key !== account
        || currentAccountKeys[id] !== account || proof.profile_id !== id || proof.model !== profile.model || proof.reasoning_effort !== (profile.reasoning_effort || null)
        || !(Date.parse(proof.started_at) > failed) || !Number.isFinite(observed) || !Number.isFinite(failed)
        || observed <= failed || observed > nowMs || nowMs - observed >= QUOTA_PROOF_MAX_AGE_MS) continue;
    recovered.push(id);
  }
  return recovered;
}
