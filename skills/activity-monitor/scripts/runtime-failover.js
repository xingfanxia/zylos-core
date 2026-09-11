#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../../multi-session/file-lock.js';
import { writeRuntimeSwitchSignal } from './runtime-switch-signal.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');
const SINGLE_PROFILE_FILE = path.join(ZYLOS_DIR, '.zylos', 'runtime-profiles.json');
const CONFIG_FILE = path.join(ZYLOS_DIR, '.zylos', 'config.json');
const PROVIDER_USAGE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'provider-usage.json');
const DEFAULT_POLL_MS = Number.parseInt(process.env.RUNTIME_FAILOVER_POLL_MS || '', 10) || 10_000;
const HEALTH_FAILOVER_STATES = new Set(['rate_limited', 'auth_failed', 'degraded', 'down']);
const QUARANTINE_HEALTH_STATES = new Set(['auth_failed', 'degraded', 'down']);

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function windowUsedPercent(window, nowMs) {
  if (!window || !Number.isFinite(Number(window.used_percent))) return null;
  const resetMs = Date.parse(window.resets_at || '');
  if (Number.isFinite(resetMs) && resetMs <= nowMs) return 0;
  return Number(window.used_percent);
}

function providerUsageState(providerUsage, provider, nowMs) {
  if (!provider) return { available: true, exhausted: false, usedPercent: 0 };
  const data = providerUsage?.providers?.[provider];
  if (!data?.available) return { available: false, exhausted: false, usedPercent: null };
  const values = [data.primary, data.secondary, data.tertiary]
    .map(window => windowUsedPercent(window, nowMs))
    .filter(Number.isFinite);
  if (values.length === 0) return { available: false, exhausted: false, usedPercent: null };
  return { available: true, exhausted: false, usedPercent: Math.max(...values) };
}

/**
 * Choose a profile without side effects. Unknown usage is allowed as a
 * one-time optimistic hop (needed before the first Codex subscription session
 * has emitted rate-limit data); a live rate_limited health signal then moves
 * immediately to the next tier.
 */
export function chooseRuntimeProfile({
  currentProfile,
  chain,
  profiles,
  providerUsage,
  currentHealth = 'ok',
  switchThreshold = 98,
  recoverThreshold = 80,
  changedAtMs = 0,
  nowMs = Date.now(),
  minDwellMs = 300_000,
  autoRecover = true,
  wrapOnExhausted = false,
  blockedProfiles = [],
} = {}) {
  const currentIndex = chain.indexOf(currentProfile);
  if (currentIndex < 0) return { profile: chain[0] || currentProfile, reason: 'profile_not_in_chain' };

  const current = profiles[currentProfile] || {};
  const currentUsage = providerUsageState(providerUsage, current.usage_provider, nowMs);
  const blocked = new Set(Array.isArray(blockedProfiles) ? blockedProfiles : Object.keys(blockedProfiles || {}));
  const healthLimited = HEALTH_FAILOVER_STATES.has(currentHealth);
  const usageLimited = currentUsage.available && currentUsage.usedPercent >= switchThreshold;

  // A profile switch carries the previous adapter's persisted health until the
  // new adapter completes a functional heartbeat. Give that probe one dwell
  // window before chaining again, otherwise one stale `degraded` status can
  // race through every fallback tier in consecutive daemon polls.
  if (healthLimited && changedAtMs > 0 && nowMs - changedAtMs < minDwellMs) {
    return { profile: currentProfile, reason: 'no_change' };
  }

  if (healthLimited || usageLimited) {
    for (let i = currentIndex + 1; i < chain.length; i++) {
      const candidateId = chain[i];
      if (blocked.has(candidateId)) continue;
      const candidate = profiles[candidateId] || {};
      const state = providerUsageState(providerUsage, candidate.usage_provider, nowMs);
      if (!candidate.usage_provider || !state.available || state.usedPercent < switchThreshold) {
        return {
          profile: candidateId,
          reason: healthLimited
            ? `health_${currentHealth}:${currentProfile}`
            : `usage_exhausted:${current.usage_provider}`,
        };
      }
    }

    // An operator may deliberately make the final API profile active while
    // retaining the subscription tiers as health fallbacks. In that mode a
    // failing last-tier engine must be able to wrap to an earlier usable tier;
    // normal usage-driven progression still follows the declared chain first.
    if (wrapOnExhausted) {
      for (let i = 0; i < currentIndex; i++) {
        const candidateId = chain[i];
        if (blocked.has(candidateId)) continue;
        const candidate = profiles[candidateId] || {};
        const state = providerUsageState(providerUsage, candidate.usage_provider, nowMs);
        if (!candidate.usage_provider || !state.available || state.usedPercent < switchThreshold) {
          return {
            profile: candidateId,
            reason: healthLimited
              ? `health_${currentHealth}_wrap:${currentProfile}`
              : `usage_exhausted_wrap:${current.usage_provider}`,
          };
        }
      }
    }
    return { profile: currentProfile, reason: 'fallback_chain_exhausted' };
  }

  if (autoRecover && currentIndex > 0 && nowMs - changedAtMs >= minDwellMs) {
    for (let i = 0; i < currentIndex; i++) {
      const candidateId = chain[i];
      if (blocked.has(candidateId)) continue;
      const candidate = profiles[candidateId] || {};
      const state = providerUsageState(providerUsage, candidate.usage_provider, nowMs);
      if (!candidate.usage_provider || (state.available && state.usedPercent < recoverThreshold)) {
        return {
          profile: candidateId,
          reason: `preferred_provider_recovered:${candidate.usage_provider || candidateId}`,
        };
      }
    }
  }

  return { profile: currentProfile, reason: 'no_change' };
}

export function planRuntimeFailover({
  document,
  providerUsage,
  healthByInstance = {},
  nowMs = Date.now(),
} = {}) {
  const next = structuredClone(document || {});
  const policy = next.runtime_failover || {};
  const profiles = next.runtime_profiles || {};
  const chain = Array.isArray(policy.chain) ? policy.chain.filter(id => profiles[id]) : [];
  const changes = [];
  if (!policy.enabled || chain.length < 2) return { document: next, changes };

  for (const [instanceId, instance] of Object.entries(next.instances || {})) {
    if (instance.enabled === false || instance.runtime_failover_enabled !== true) continue;
    if (healthByInstance[instanceId] === 'suspended') continue;
    const currentProfile = instance.runtime_profile || chain[0];
    const changedAtMs = Date.parse(instance.runtime_profile_changed_at || '') || 0;
    const blockedProfiles = instance.runtime_failover_blocked_profiles
      && typeof instance.runtime_failover_blocked_profiles === 'object'
      && !Array.isArray(instance.runtime_failover_blocked_profiles)
      ? instance.runtime_failover_blocked_profiles
      : {};
    const currentHealth = healthByInstance[instanceId] || 'ok';
    const decision = chooseRuntimeProfile({
      currentProfile,
      chain,
      profiles,
      providerUsage,
      currentHealth,
      switchThreshold: Number(policy.switch_threshold) || 98,
      recoverThreshold: Number(policy.recover_threshold) || 80,
      minDwellMs: Math.max(0, Number(policy.min_dwell_sec) || 0) * 1000,
      changedAtMs,
      nowMs,
      autoRecover: policy.auto_recover !== false,
      wrapOnExhausted: policy.wrap_on_exhausted === true,
      blockedProfiles,
    });
    if (decision.profile === currentProfile) continue;

    const target = profiles[decision.profile];
    if (QUARANTINE_HEALTH_STATES.has(currentHealth)) {
      // Quota failures self-expire from provider usage windows. Functional
      // failures do not have a trustworthy recovery signal, so quarantine the
      // failed profile until an operator clears this persisted entry after
      // repairing credentials/provider access. This prevents auto-recover from
      // bouncing a healthy fallback back into a known-bad provider.
      instance.runtime_failover_blocked_profiles = {
        ...blockedProfiles,
        [currentProfile]: {
          health: currentHealth,
          blocked_at: new Date(nowMs).toISOString(),
        },
      };
    }
    instance.runtime_profile = decision.profile;
    instance.runtime = target.runtime;
    instance.runtime_profile_changed_at = new Date(nowMs).toISOString();
    instance.runtime_profile_change_reason = decision.reason;
    changes.push({
      instanceId,
      fromProfile: currentProfile,
      toProfile: decision.profile,
      runtime: target.runtime,
      reason: decision.reason,
      tmuxSession: instance.tmux_session || `${target.runtime}-${instanceId}`,
    });
  }
  return { document: next, changes };
}

/**
 * Plan the same engine-only transition for upstream/public single-session
 * Zylos. This document intentionally contains no persona content: identity,
 * memory, skills, .env, C4 and chat routing continue to live in ZYLOS_DIR.
 */
export function planSingleSessionRuntimeFailover({
  document,
  providerUsage,
  currentHealth = 'ok',
  nowMs = Date.now(),
} = {}) {
  const next = structuredClone(document || {});
  const policy = next.runtime_failover || {};
  const profiles = next.runtime_profiles || {};
  const chain = Array.isArray(policy.chain) ? policy.chain.filter(id => profiles[id]) : [];
  const changes = [];
  if (!policy.enabled || chain.length < 2) return { document: next, changes };

  const currentProfile = next.active_profile || chain[0];
  const currentBlockedProfiles = next.runtime_failover_blocked_profiles
    && typeof next.runtime_failover_blocked_profiles === 'object'
    && !Array.isArray(next.runtime_failover_blocked_profiles)
    ? next.runtime_failover_blocked_profiles
    : {};
  const decision = chooseRuntimeProfile({
    currentProfile,
    chain,
    profiles,
    providerUsage,
    currentHealth,
    switchThreshold: Number(policy.switch_threshold) || 98,
    recoverThreshold: Number(policy.recover_threshold) || 80,
    minDwellMs: Math.max(0, Number(policy.min_dwell_sec) || 0) * 1000,
    changedAtMs: Date.parse(next.runtime_profile_changed_at || '') || 0,
    nowMs,
    autoRecover: policy.auto_recover !== false,
    wrapOnExhausted: policy.wrap_on_exhausted === true,
    blockedProfiles: currentBlockedProfiles,
  });
  if (decision.profile === currentProfile) return { document: next, changes };

  const target = profiles[decision.profile];
  if (QUARANTINE_HEALTH_STATES.has(currentHealth)) {
    next.runtime_failover_blocked_profiles = {
      ...currentBlockedProfiles,
      [currentProfile]: {
        health: currentHealth,
        blocked_at: new Date(nowMs).toISOString(),
      },
    };
  }
  next.active_profile = decision.profile;
  next.active_runtime = target.runtime;
  next.runtime_profile_changed_at = new Date(nowMs).toISOString();
  next.runtime_profile_change_reason = decision.reason;
  changes.push({
    instanceId: next.persona_id || 'single',
    fromProfile: currentProfile,
    toProfile: decision.profile,
    runtime: target.runtime,
    reason: decision.reason,
    tmuxSession: next.tmux_session || 'claude-main',
    monitorName: next.monitor_name || 'activity-monitor',
    singleSession: true,
  });
  return { document: next, changes };
}

function monitorDirFor(instanceId, instance) {
  if (instance?.state_dir) return instance.state_dir.replace(/^~/, os.homedir());
  return path.join(ZYLOS_DIR, 'activity-monitor', instanceId);
}

function readHealthByInstance(document) {
  const result = {};
  for (const [instanceId, instance] of Object.entries(document?.instances || {})) {
    const status = readJson(path.join(monitorDirFor(instanceId, instance), 'agent-status.json'), {});
    result[instanceId] = status.health || status.health_state || status.state || 'ok';
  }
  return result;
}

function writeInstancesAtomic(document) {
  const tmp = `${INSTANCES_FILE}.tmp.${process.pid}`;
  const mode = fs.statSync(INSTANCES_FILE).mode & 0o777;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { mode });
  fs.renameSync(tmp, INSTANCES_FILE);
}

function writeJsonAtomic(filePath, document) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  let mode = 0o600;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch { /* first install */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { mode });
  fs.renameSync(tmp, filePath);
}

function updateConfiguredRuntime(runtime) {
  const config = readJson(CONFIG_FILE, {});
  if (config.runtime === runtime) return;
  writeJsonAtomic(CONFIG_FILE, { ...config, runtime });
}

export function applyRuntimeFailover({
  providerUsage = readJson(PROVIDER_USAGE_FILE, {}),
  nowMs = Date.now(),
  execFileSyncImpl = execFileSync,
  log = console.log,
} = {}) {
  let changes = [];
  if (fs.existsSync(INSTANCES_FILE)) {
    withFileLock(`${INSTANCES_FILE}.lock`, () => {
      const document = readJson(INSTANCES_FILE, {});
      const planned = planRuntimeFailover({
        document,
        providerUsage,
        healthByInstance: readHealthByInstance(document),
        nowMs,
      });
      changes = planned.changes;
      if (changes.length > 0) writeInstancesAtomic(planned.document);
    });
  } else if (fs.existsSync(SINGLE_PROFILE_FILE)) {
    withFileLock(`${SINGLE_PROFILE_FILE}.lock`, () => {
      const document = readJson(SINGLE_PROFILE_FILE, {});
      const stateDir = String(document.state_dir || path.join(ZYLOS_DIR, 'activity-monitor'))
        .replace(/^~/, os.homedir());
      const status = readJson(path.join(stateDir, 'agent-status.json'), {});
      const currentHealth = status.health || status.health_state || status.state || 'ok';
      const planned = planSingleSessionRuntimeFailover({
        document,
        providerUsage,
        currentHealth,
        nowMs,
      });
      changes = planned.changes;
      if (changes.length > 0) {
        writeJsonAtomic(SINGLE_PROFILE_FILE, planned.document);
        updateConfiguredRuntime(changes[0].runtime);
      }
    });
  }

  // Publish every cold-start signal before restarting the first monitor. If a
  // later PM2 restart fails, its durable signal still protects the next boot
  // from inheriting the previous adapter's degraded heartbeat state.
  for (const change of changes) {
    if (change.singleSession) continue;
    writeRuntimeSwitchSignal({
      zylosDir: ZYLOS_DIR,
      change,
      nowMs,
    });
  }

  for (const change of changes) {
    try {
      execFileSyncImpl('tmux', ['kill-session', '-t', change.tmuxSession], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch { /* absent pane is fine */ }
    const monitorName = change.monitorName || `activity-monitor-${change.instanceId}`;
    execFileSyncImpl('pm2', ['restart', monitorName, '--update-env'], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    log(`[runtime-failover] ${change.instanceId}: ${change.fromProfile} -> ${change.toProfile} (${change.reason})`);
  }
  return changes;
}

export async function runDaemon({
  pollMs = DEFAULT_POLL_MS,
  apply = applyRuntimeFailover,
  log = console.log,
  error = console.error,
} = {}) {
  log(`[runtime-failover] daemon started (poll=${pollMs}ms)`);
  while (true) {
    try { apply({ log }); } catch (err) { error(`[runtime-failover] ${err.message}`); }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

let invokedAsMain = false;
try {
  // PM2 launches through ~/zylos (a symlink to the fleet root), while ESM
  // canonicalizes import.meta.url to the real path. Compare real paths so the
  // daemon does not silently no-op under that production layout.
  invokedAsMain = Boolean(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch { /* imported module or an already-removed script */ }
if (invokedAsMain || process.argv.includes('--daemon')) await runDaemon();
