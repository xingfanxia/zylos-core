/**
 * Fable allowance guard (FG-2/FG-3). The runtime-failover daemon is the single
 * transition owner: under the instances.json lock it derives each account's
 * holds from probe observations and persona evidence, commits one desired
 * launch {account, mode, generation} per persona, and reconciles it with a
 * cold-start restart. The guard never types into a pane, never writes
 * runtime_failover_blocked_profiles and never reports rate_limited.
 * Contract and operator commands: docs/fable-allowance-guard.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  expectedFableLaunch,
  FABLE_LAUNCH_FILE,
  fableAccountSettingsFile,
  fableGuardStatePath,
  fableLastObservation,
  fableLeaseObservation,
  fableUsagePath,
  readFableGuardConfig,
} from '../../multi-session/runtime-files.js';
import { baseModel, probeDue, recordProbeResult, runFableProbe } from './fable-probe.js';
import { VALID_SESSION_REF, writeRuntimeSwitchSignal } from './runtime-switch-signal.js';
import { withFileLock } from '../../multi-session/file-lock.js';

const CLOCK_SKEW_MS = 30_000;
const RESUME_GRACE_MS = 180_000;
const MODEL_EVIDENCE_TIMEOUT_MS = 600_000;
// A launch record older than the engine's current launch is not that launch.
const LAUNCH_MATCH_SKEW_MS = 5000;
const MAX_RESTART_ATTEMPTS = 3;
const STATUS_MAX_AGE_MS = 60_000;
const EVIDENCE_MAX_AGE_MS = 3_600_000;
const HOLD_KINDS = ['quota', 'crash', 'stale'];
export const LIMIT_EVIDENCE_FILE = 'fable-limit-evidence.json';
export const SESSION_FAILURES_FILE = 'fable-session-failures.json';
export const READINESS_FILE = 'fable-readiness.json';
// Readiness = a real (end-to-end) ACK from the launch; phases the dispatcher never auto-ACKs.
const READINESS_PHASES = new Set(['post_restart', 'recovery']);
// The readiness probe waits out a busy startup turn (STARTUP_PROBE_GRACE_SEC, 20 min).
const READINESS_TIMEOUT_MS = 30 * 60_000;

const iso = ms => new Date(ms).toISOString();
const ms = value => Date.parse(value || '');

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(filePath, value, mode = 0o640) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
  fs.renameSync(tmp, filePath);
}

export function emptyGuardState() {
  return { version: 1, generation_seq: 0, holds: {}, crash_trips: {}, rejection_seen: {}, personas: {} };
}

function normalizeState(state) {
  const base = emptyGuardState();
  if (!state || typeof state !== 'object' || state.version !== 1) return base;
  const next = structuredClone(state);
  for (const key of ['holds', 'crash_trips', 'rejection_seen', 'personas']) {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])) next[key] = {};
  }
  next.generation_seq = Number.isInteger(next.generation_seq) ? next.generation_seq : 0;
  return next;
}

/** Accounts to probe: current Claude account of every enabled Fable persona ∪ probe_accounts. */
export function fableProbeAccounts(document, config = readFableGuardConfig(document)) {
  const accounts = new Map();
  if (!config) return accounts;
  const add = profileId => {
    const settingsFile = fableAccountSettingsFile(document, profileId);
    if (settingsFile) accounts.set(profileId, settingsFile);
  };
  for (const instance of Object.values(document?.instances || {})) {
    if (instance?.enabled !== false && instance?.fable_enabled === true) add(instance.runtime_profile);
  }
  for (const profileId of config.probe_accounts) add(profileId);
  return accounts;
}

const lastObservation = fableLastObservation;
const freshObservation = fableLeaseObservation;

function laterWindow(obs, window) {
  return Number.isFinite(ms(window)) && ms(obs.resets_at) > ms(window);
}

// Trailing run of valid observations below threshold made after `sinceMs`.
function cleanStreak(entry, sinceMs, threshold) {
  let count = 0;
  for (const attempt of [...(entry?.recent || [])].reverse()) {
    if (!(ms(attempt.at) > sinceMs) || attempt.outcome !== 'valid' || !(Number(attempt.utilization) < threshold)) break;
    count += 1;
  }
  return count;
}

function currentWindow(entry, nowMs) {
  const obs = lastObservation(entry, nowMs);
  return obs && ms(obs.resets_at) > nowMs ? obs.resets_at : null;
}

function setQuotaHold(holds, { nowMs, resetWindow, detail }) {
  if (holds.quota) {
    holds.quota.detail = { ...holds.quota.detail, last: detail, last_at: iso(nowMs) };
    if (!holds.quota.reset_window && resetWindow) holds.quota.reset_window = resetWindow;
    return false;
  }
  holds.quota = { since: iso(nowMs), reset_window: resetWindow || null, detail };
  return true;
}

function updateAccountHolds({ account, next, entry, config, nowMs, probed, evidence, crashTrip, events }) {
  const holds = { ...(next.holds[account] || {}) };
  const obs = lastObservation(entry, nowMs);
  const fresh = freshObservation(entry, nowMs, config);
  const threshold = config.threshold;

  // Clear rules first; a trigger below can re-arm a hold in the same pass.
  for (const kind of ['quota', 'crash']) {
    const hold = holds[kind];
    if (!hold || (kind === 'crash' && hold.trip === 1)) continue;
    if (!obs || !(ms(obs.observed_at) > ms(hold.since))) continue;
    if (!hold.reset_window) { hold.reset_window = obs.resets_at; continue; } // pin the exhausted window
    if (Number(obs.utilization) < threshold && laterWindow(obs, hold.reset_window)) {
      delete holds[kind];
      events.push(`${account}: ${kind} hold cleared by a later window (${obs.utilization})`);
    }
  }
  if (holds.crash?.trip === 1 && nowMs >= ms(holds.crash.probation_until)) {
    delete holds.crash;
    events.push(`${account}: crash hold probation ended; one Fable retry allowed`);
  }
  const trips = next.crash_trips[account];
  if (trips && obs && !trips.window) trips.window = obs.resets_at;
  else if (trips && obs && laterWindow(obs, trips.window)) delete next.crash_trips[account];
  if (holds.stale && fresh && cleanStreak(entry, ms(holds.stale.since), threshold) >= config.stale_clear_observations) {
    delete holds.stale;
    events.push(`${account}: stale hold cleared after ${config.stale_clear_observations} valid observations`);
  }

  // Triggers.
  {
    if (fresh && Number(fresh.utilization) >= threshold && setQuotaHold(holds, {
      nowMs, resetWindow: fresh.resets_at, detail: { source: 'observation', utilization: fresh.utilization },
    })) events.push(`${account}: quota hold (${fresh.utilization} >= ${threshold})`);
    const rejection = entry?.rejection;
    if (rejection && ms(rejection.at) > (ms(next.rejection_seen[account]) || 0) && ms(rejection.at) <= nowMs + CLOCK_SKEW_MS) {
      next.rejection_seen[account] = rejection.at;
      if (setQuotaHold(holds, { nowMs, resetWindow: rejection.resets_at || currentWindow(entry, nowMs),
        detail: { source: 'probe_rejection', reason: rejection.detail } })) events.push(`${account}: quota hold (probe rejection)`);
    }
    for (const item of evidence) {
      if (setQuotaHold(holds, { nowMs, resetWindow: currentWindow(entry, nowMs),
        detail: { source: 'limit_ui', persona: item.persona, kind: item.kind } })) {
        events.push(`${account}: quota hold (limit dialog on ${item.persona})`);
      }
    }
    if (crashTrip && !holds.crash) {
      const trip = (next.crash_trips[account]?.count || 0) + 1;
      const window = currentWindow(entry, nowMs);
      next.crash_trips[account] = { count: trip, window: next.crash_trips[account]?.window || window };
      holds.crash = {
        since: iso(nowMs),
        trip: trip >= 2 ? 2 : 1,
        reset_window: trip >= 2 ? window : null,
        probation_until: trip >= 2 ? null : iso(nowMs + config.crash_probation_sec * 1000),
        detail: crashTrip,
      };
      events.push(`${account}: crash hold trip ${holds.crash.trip} (${crashTrip.persona})`);
    }
    if (probed && !fresh && !holds.stale) {
      holds.stale = { since: iso(nowMs), detail: { last_valid_at: obs?.observed_at || null } };
      events.push(`${account}: stale hold (no valid observation within the lease)`);
    }
  }
  if (Object.keys(holds).length) next.holds[account] = holds;
  else delete next.holds[account];
}

function accountAllowsFable(next, usage, account, config, nowMs) {
  if (Object.keys(next.holds[account] || {}).length) return false;
  const fresh = freshObservation(usage?.accounts?.[account], nowMs, config);
  return Boolean(fresh) && Number(fresh.utilization) < config.threshold;
}

function upgradeReady(persona, status, nowMs, config) {
  const last = ms(persona?.last_transition_at) || 0;
  if (nowMs - last < config.upgrade_min_dwell_sec * 1000) return false;
  const checkedMs = Number(status?.last_check) * 1000;
  return status?.state === 'idle' && status.health === 'ok' && !(Number(status.active_tools) > 0)
    && Number.isFinite(checkedMs) && nowMs - checkedMs <= STATUS_MAX_AGE_MS && checkedMs <= nowMs + CLOCK_SKEW_MS;
}

function sessionFailures(persona, monitorFailures, profileId, sinceMs) {
  const fromMonitor = (Array.isArray(monitorFailures?.failures) ? monitorFailures.failures : [])
    .filter(item => item?.mode === 'fable' && item.runtime_profile === profileId)
    .map(item => ({ at: item.at, reason: item.reason, source: 'monitor' }));
  return [...fromMonitor, ...(persona?.failures || [])]
    .filter(item => ms(item.at) > sinceMs);
}

/**
 * Pure planner. Inputs are snapshots read under the instances.json lock;
 * output is the next guard state plus the restarts this pass must execute.
 */
export function planFableGuard({
  document,
  state,
  usage = {},
  statusByInstance = {},
  modelByInstance = {},
  evidenceByInstance = {},
  failuresByInstance = {},
  launchByInstance = {},
  readinessByInstance = {},
  failoverInstanceIds = new Set(),
  nowMs = Date.now(),
} = {}) {
  const config = readFableGuardConfig(document);
  const next = normalizeState(state);
  const restarts = [];
  const events = [];
  const before = JSON.stringify(next);
  const instances = document?.instances || {};
  if (!config && !Object.keys(next.personas).length) {
    return { state: next, restarts, events, changed: false };
  }

  // 1. Persona evidence per account: classified limit dialogs and crash trips.
  const evidenceByAccount = {};
  const crashByAccount = {};
  for (const [id, instance] of Object.entries(instances)) {
    const persona = next.personas[id];
    if (!config || instance?.fable_enabled !== true || !persona) continue;
    const evidence = evidenceByInstance[id];
    const evidenceMs = ms(evidence?.at);
    if (Number.isFinite(evidenceMs) && evidenceMs > (ms(persona.evidence_seen_at) || 0)
        && evidenceMs <= nowMs + CLOCK_SKEW_MS && nowMs - evidenceMs <= EVIDENCE_MAX_AGE_MS
        && typeof evidence.runtime_profile === 'string') {
      persona.evidence_seen_at = evidence.at;
      (evidenceByAccount[evidence.runtime_profile] ||= []).push({ persona: id, kind: evidence.kind });
      // Known gap: a message submitted just before the dialog appeared is
      // recorded as delivered although the CLI sent nothing. Never replay it
      // (duplicate execution); flag it for the operator instead.
      persona.possible_dropped_message = { at: evidence.at, kind: evidence.kind };
      events.push(`${id}: ALERT limit dialog classified at ${evidence.at}; a message delivered just before it may not have been sent (not re-delivered)`);
    }
    const profileId = instance.runtime_profile;
    const sinceMs = Math.max(nowMs - config.crash_window_sec * 1000, ms(persona.crash_counted_after) || 0);
    const failures = sessionFailures(persona, failuresByInstance[id], profileId, sinceMs);
    if (failures.length >= config.crash_failures && !crashByAccount[profileId]) {
      crashByAccount[profileId] = { persona: id, failures: failures.length };
      persona.crash_counted_after = iso(nowMs);
    }
  }

  // 2. Account holds (frozen while the feature is unconfigured: launches are inert then).
  const probed = fableProbeAccounts(document, config);
  for (const account of config ? new Set([...probed.keys(), ...Object.keys(next.holds), ...Object.keys(evidenceByAccount)]) : []) {
    updateAccountHolds({
      account, next, entry: usage?.accounts?.[account], config, nowMs,
      probed: probed.has(account), evidence: evidenceByAccount[account] || [],
      crashTrip: crashByAccount[account] || null, events,
    });
  }

  // 3. Desired launch per persona, then reconcile.
  for (const [id, instance] of Object.entries(instances)) {
    const enabled = Boolean(config) && instance?.fable_enabled === true && instance.enabled !== false;
    const prior = next.personas[id];
    if (!enabled && !prior) continue;
    const persona = prior ? next.personas[id] : (next.personas[id] = {});
    const profileId = instance.runtime_profile || null;
    const status = statusByInstance[id] || {};
    const eligible = enabled && Boolean(fableAccountSettingsFile(document, profileId));
    const priorMode = persona.desired?.mode || 'opus';
    let mode = 'opus';
    const allowed = eligible && accountAllowsFable(next, usage, profileId, config, nowMs);
    if (allowed) mode = priorMode === 'fable' || upgradeReady(persona, status, nowMs, config) ? 'fable' : 'opus';
    // An account without its own settings file (claude-ax-main) cannot be
    // probed, so it never runs Fable. That is a supported, final state.
    if (enabled && !eligible) persona.unsupported = 'account_without_settings_file';
    else delete persona.unsupported;
    const expected = expectedFableLaunch({ document, instanceId: id, mode });
    const launch = launchByInstance[id] || null;
    const changed = !persona.desired || persona.desired.mode !== mode || persona.desired.account !== profileId
      || persona.desired.key !== expected.key;
    if (changed) {
      const generation = ++next.generation_seq;
      const reason = !enabled ? 'fable_disabled' : !eligible ? 'unsupported_account' : mode === 'fable' ? 'fable_allowed'
        : allowed ? 'upgrade_pending' : `fable_blocked:${Object.keys(next.holds[profileId] || {}).join('+') || 'no_lease'}`;
      if (priorMode !== mode) persona.last_transition_at = iso(nowMs);
      persona.desired = { account: profileId, mode, generation, key: expected.key, model: baseModel(expected.model),
        committed_at: iso(nowMs), reason };
      persona.executed_generation = generation;
      persona.executed_at = iso(nowMs);
      persona.attempts = 0;
      for (const key of ['verified', 'gave_up', 'restart_required', 'safe_stop', 'model_unknown_launch']) delete persona[key];
      if (launchServes(launch, status, nowMs) && launch.key === expected.key && launch.runtime_profile === profileId) {
        // The running launch already uses exactly this policy: adopt it.
        persona.desired.adopted_launch_id = launch.launch_id;
      } else if (failoverInstanceIds.has(id)) {
        persona.attempts = 1; // the account failover's cold restart carries this commit
      } else if (policyOnlyChange(persona.desired, launch) && status.state !== 'idle') {
        // Nothing here reduces Fable exposure: restart once the persona is idle.
      } else if (status.state !== 'suspended') {
        persona.attempts = 1;
        restarts.push({ instanceId: id, generation, attempt: 1, kind: 'restart', mode, profileId, reason,
          tmuxSession: instance.tmux_session || `claude-${id}` });
      }
      events.push(`${id}: commit g${generation} ${mode} on ${profileId} (${reason})`);
      continue;
    }
    reconcilePersona({ id, instance, persona, status, launch, actual: modelByInstance[id], readiness: readinessByInstance[id],
      config, nowMs, restarts, events,
      failureCount: () => sessionFailures(persona, failuresByInstance[id], profileId,
        Math.max(nowMs - (config?.crash_window_sec || 0) * 1000, ms(persona.crash_counted_after) || 0)).length });
    if (!enabled && persona.desired.mode === 'opus' && persona.verified?.model_at) delete next.personas[id];
  }

  const changed = JSON.stringify(next) !== before;
  return { state: next, restarts, events, changed };
}

function isRunning(status, nowMs) {
  const checkedMs = Number(status?.last_check) * 1000;
  return ['idle', 'busy'].includes(status?.state) && Number.isFinite(checkedMs) && nowMs - checkedMs <= 2 * STATUS_MAX_AGE_MS;
}

// The launch record describes the engine's current launch (not an older one).
function launchServes(launch, status, nowMs) {
  return Boolean(launch) && isRunning(status, nowMs)
    && Number(launch.launched_at_ms) >= (Number(status.runtime_launch_at) || 0) - LAUNCH_MATCH_SKEW_MS;
}

// The launch was made for this commit: same account, mode and launch policy,
// and either this generation or the launch adopted at commit time.
function launchMatches(desired, launch) {
  return Boolean(launch) && launch.key === desired.key && launch.runtime_profile === desired.account
    && launch.mode === desired.mode
    && (launch.generation === desired.generation || launch.launch_id === desired.adopted_launch_id);
}

// An Opus session on the right account whose launch policy (subagent env,
// profile model or effort) changed: no Fable exposure is at stake, so the
// restart waits for an idle persona instead of interrupting work.
function policyOnlyChange(desired, launch) {
  return desired.mode === 'opus' && launch?.mode === 'opus' && launch.runtime_profile === desired.account;
}

// Verify a committed generation against the running engine's launch record
// (account, policy, generation) and its reported model, and resume an
// interrupted transition. A committed opus with Fable still running is not done.
function reconcilePersona({ id, instance, persona, status, launch, actual, readiness, config, nowMs, restarts, events, failureCount }) {
  const desired = persona.desired;
  if (persona.executed_generation !== desired.generation) return;
  const executedMs = ms(persona.executed_at);
  const tmuxSession = instance.tmux_session || `claude-${id}`;
  // Fable may still be live: the last recorded launch, or the engine's own report, is Fable.
  const fableMayRun = launch?.mode === 'fable' || baseModel(actual?.model) === baseModel(config?.fable_model);
  const resume = why => {
    if ((persona.attempts || 0) >= MAX_RESTART_ATTEMPTS) {
      if (!persona.gave_up) events.push(`${id}: ALERT g${desired.generation} not converged after ${persona.attempts} restarts (${why}); operator check needed`);
      persona.gave_up = why;
      // A downgrade must never end with Fable left running: stop the persona.
      if (desired.mode === 'opus' && fableMayRun && !persona.safe_stop) {
        persona.safe_stop = { at: iso(nowMs), why, generation: desired.generation };
        restarts.push({ instanceId: id, generation: desired.generation, attempt: persona.attempts, kind: 'stop',
          mode: desired.mode, profileId: desired.account, reason: `safe_stop:${why}`, tmuxSession });
        events.push(`${id}: ALERT downgrade to Opus failed ${persona.attempts} times; persona STOPPED (pm2 stop + tmux kill) `
          + `so Fable does not keep running. After checking: pm2 start activity-monitor-${id} (the launch is admitted to Opus only)`);
      }
      return;
    }
    persona.attempts = (persona.attempts || 0) + 1;
    persona.executed_at = iso(nowMs);
    restarts.push({ instanceId: id, generation: desired.generation, attempt: persona.attempts, kind: 'restart',
      mode: desired.mode, profileId: desired.account, reason: `resume:${why}`, tmuxSession });
    events.push(`${id}: resume g${desired.generation} (${why})`);
  };
  if (persona.safe_stop?.generation === desired.generation) return;
  if (!isRunning(status, nowMs)) {
    // A suspended persona launches through the admission gate when it wakes.
    if (status.state === 'suspended') { persona.verified ||= { not_running_at: iso(nowMs) }; return; }
    // Otherwise the restart (or the monitor) did not land: keep reconciling.
    if (!persona.verified?.model_at && nowMs - executedMs > RESUME_GRACE_MS) resume(`not_running:${status.state || 'unknown'}`);
    return;
  }
  if (!launchServes(launch, status, nowMs) || !launchMatches(desired, launch)) {
    if (persona.verified?.model_at) delete persona.verified;
    if (policyOnlyChange(desired, launch) && launchServes(launch, status, nowMs)) {
      if (status.state === 'idle') resume('policy_change');
      return;
    }
    if (nowMs - executedMs > RESUME_GRACE_MS) resume(launch ? 'stale_launch' : 'launch_unrecorded');
    return;
  }
  const launchMs = Number(launch.launched_at_ms);
  const expected = desired.model;
  const actualModel = baseModel(actual?.model);
  if (!actualModel || !expected || !(Number(actual.observed_at_ms) >= launchMs)) {
    // No model report since this launch: bounded, never an endless wait.
    if (nowMs - launchMs > MODEL_EVIDENCE_TIMEOUT_MS && persona.model_unknown_launch !== launch.launch_id) {
      persona.model_unknown_launch = launch.launch_id;
      if (desired.mode === 'fable') {
        resume('model_unknown');
      } else {
        // The launcher passed the Opus model; Fable cannot be live. Surface it.
        persona.verified = { ...(persona.verified || {}), model_unknown_at: iso(nowMs), launch_id: launch.launch_id };
        events.push(`${id}: ALERT no model report from the Opus launch ${launch.launch_id} after `
          + `${Math.round(MODEL_EVIDENCE_TIMEOUT_MS / 60_000)} min (statusline.json); not restarted`);
      }
    }
    return;
  }
  if (actualModel !== expected) {
    if (persona.verified?.mismatch_launch === launch.launch_id) return;
    persona.verified = { mismatch_launch: launch.launch_id };
    // A session launched for this commit that is not on Fable is a Fable
    // session failure (e.g. the CLI's consent fallback). When it trips the
    // crash rule, the next pass commits Opus instead of relaunching Fable.
    if (desired.mode === 'fable') {
      persona.failures = [...(persona.failures || []), { at: iso(nowMs), reason: `model_mismatch:${actualModel}` }].slice(-10);
      if (failureCount() >= config.crash_failures) return;
    }
    resume(`model_mismatch:${actualModel}`);
    return;
  }
  if (!persona.verified?.model_at) persona.verified = { model_at: iso(nowMs), launch_id: launch.launch_id };
  verifyReadiness({ id, verified: persona.verified, launch, status, readiness, nowMs, events });
}

// Readiness is separate from model convergence: a real ACK from this launch
// (the monitor's end-to-end readiness probe, or another non-auto-ACKable
// heartbeat). A missing ACK is surfaced once and never restarts a correct model.
function verifyReadiness({ id, verified, launch, status, readiness, nowMs, events }) {
  if (verified.ready_at || verified.readiness) return;
  const launchMs = Number(launch.launched_at_ms);
  const ours = readiness?.launch_id === launch.launch_id ? readiness : null;
  if (ours?.outcome === 'ack') {
    verified.ready_at = ours.at;
  } else if (Number(status.functional_ack_at) >= launchMs && READINESS_PHASES.has(status.functional_ack_phase)) {
    verified.ready_at = iso(Number(status.functional_ack_at));
  } else if (ours?.outcome === 'missing' || nowMs - launchMs > READINESS_TIMEOUT_MS) {
    verified.readiness = ours?.outcome === 'missing' ? 'ack_missing' : 'no_probe_result';
    events.push(`${id}: ALERT model ${launch.model} converged but readiness not verified (${verified.readiness}: `
      + `no real ACK from launch ${launch.launch_id}); not restarted, check the persona`);
  }
}

// ── Disk I/O (runtime-failover daemon) ─────────────────────────────────────

function monitorDirFor(zylosDir, instanceId, instance) {
  if (instance?.state_dir) return instance.state_dir.replace(/^~/, os.homedir());
  return path.join(zylosDir, 'activity-monitor', instanceId);
}

function readActualModel(dir) {
  const file = path.join(dir, 'statusline.json');
  try {
    const model = JSON.parse(fs.readFileSync(file, 'utf8'))?.model?.id;
    return typeof model === 'string' ? { model, observed_at_ms: fs.statSync(file).mtimeMs } : null;
  } catch { return null; }
}

export function readFableGuardState(zylosDir) {
  return readJson(fableGuardStatePath(zylosDir), null);
}

/** Read inputs and plan one pass. Called inside the instances.json lock. */
export function planFableGuardPass({ zylosDir, document, failoverInstanceIds = new Set(), nowMs = Date.now() }) {
  const state = readFableGuardState(zylosDir);
  if (!readFableGuardConfig(document) && !Object.keys(state?.personas || {}).length) {
    return { state, restarts: [], events: [], changed: false };
  }
  const inputs = { statusByInstance: {}, modelByInstance: {}, evidenceByInstance: {}, failuresByInstance: {}, launchByInstance: {}, readinessByInstance: {} };
  for (const [id, instance] of Object.entries(document?.instances || {})) {
    if (instance?.fable_enabled !== true && !state?.personas?.[id]) continue;
    const dir = monitorDirFor(zylosDir, id, instance);
    inputs.statusByInstance[id] = readJson(path.join(dir, 'agent-status.json'), {});
    inputs.modelByInstance[id] = readActualModel(dir);
    inputs.evidenceByInstance[id] = readJson(path.join(dir, LIMIT_EVIDENCE_FILE), null);
    inputs.failuresByInstance[id] = readJson(path.join(dir, SESSION_FAILURES_FILE), null);
    inputs.launchByInstance[id] = readJson(path.join(dir, FABLE_LAUNCH_FILE), null);
    inputs.readinessByInstance[id] = readJson(path.join(dir, READINESS_FILE), null);
  }
  return planFableGuard({ document, state, usage: readJson(fableUsagePath(zylosDir), {}),
    failoverInstanceIds, nowMs, ...inputs });
}

// A restart executed this recently whose relaunch has not happened yet will
// launch from the newest commit (the launcher re-reads the guard state).
const IN_FLIGHT_MS = 30_000;

/**
 * Cold-start restart of each committed transition, reusing the failover path
 * (switch signal → kill tmux → pm2 restart), or the safe stop of an exhausted
 * downgrade. Each item is fenced on its own, under the instances.json lock:
 * a superseded generation is skipped, and a newer commit for a persona whose
 * restart is still landing reuses that restart. The fence records
 * `executing` in the guard state and writes the switch signal before the lock
 * is released; the kill and pm2 calls run outside it.
 */
export function executeFableRestarts({
  zylosDir,
  restarts,
  nowMs = Date.now(),
  execFileSyncImpl = execFileSync,
  log = console.log,
  lock = withFileLock,
  writeSignal = writeRuntimeSwitchSignal,
}) {
  const instancesFile = path.join(zylosDir, 'instances.json');
  const executed = [];
  for (const item of restarts) {
    let go = false;
    // The session this restart replaces, so the new monitor can fence C4 keys bound to it.
    const sessionRef = item.kind === 'stop' ? null : readTmuxSessionRef(item.tmuxSession, execFileSyncImpl);
    try {
      lock(`${instancesFile}.lock`, () => {
        const file = fableGuardStatePath(zylosDir);
        const state = readJson(file, null);
        const persona = state?.personas?.[item.instanceId];
        const generation = persona?.desired?.generation;
        if (generation !== item.generation) {
          log(`[fable-guard] ${item.instanceId}: g${item.generation} superseded by g${generation}; restart skipped`);
          return;
        }
        const prior = persona.executing;
        if (item.kind !== 'stop' && prior?.kind === 'restart' && prior.generation < item.generation
            && nowMs - ms(prior.at) < IN_FLIGHT_MS && !launchedSince(zylosDir, item.instanceId, readJson(instancesFile, null), ms(prior.at))) {
          log(`[fable-guard] ${item.instanceId}: restart for g${prior.generation} still in flight; it launches g${item.generation}`);
          return;
        }
        persona.executing = { generation, attempt: item.attempt ?? null, kind: item.kind || 'restart', at: iso(nowMs) };
        writeJsonAtomic(file, state);
        if (item.kind !== 'stop') {
          writeSignal({ zylosDir, nowMs, change: { instanceId: item.instanceId, fromProfile: item.profileId,
            toProfile: item.profileId, reason: `fable_guard:${item.mode}:g${item.generation}`, sessionRef } });
        }
        go = true;
      });
    } catch (err) {
      log(`[fable-guard] ${item.instanceId}: g${item.generation} not started (${err.message}); resumed on a later pass`);
      continue;
    }
    if (!go) continue;
    if (item.kind === 'stop') {
      // Safe end of an exhausted downgrade: the monitor first, so its Guardian cannot relaunch.
      try { execFileSyncImpl('pm2', ['stop', `activity-monitor-${item.instanceId}`], { stdio: 'ignore', timeout: 30_000 }); } catch (err) {
        log(`[fable-guard] ${item.instanceId}: pm2 stop failed (${err.message})`);
      }
      try { execFileSyncImpl('tmux', ['kill-session', '-t', item.tmuxSession], { stdio: 'ignore', timeout: 10_000 }); } catch { /* absent pane */ }
      log(`[fable-guard] ${item.instanceId}: STOPPED after g${item.generation} downgrade retries were exhausted (${item.reason})`);
      executed.push(item);
      continue;
    }
    try {
      execFileSyncImpl('tmux', ['kill-session', '-t', item.tmuxSession], { stdio: 'ignore', timeout: 10_000 });
    } catch { /* absent pane is fine */ }
    try {
      execFileSyncImpl('pm2', ['restart', `activity-monitor-${item.instanceId}`, '--update-env'], { stdio: 'ignore', timeout: 30_000 });
      log(`[fable-guard] ${item.instanceId}: restart g${item.generation} -> ${item.mode} (${item.reason})`);
    } catch (err) {
      log(`[fable-guard] ${item.instanceId}: restart g${item.generation} failed (${err.message}); resumed on a later pass`);
    }
    executed.push(item);
  }
  return executed;
}

/** comm-bridge sessionRef of a live tmux session, or null. */
export function readTmuxSessionRef(tmuxSession, execFileSyncImpl = execFileSync) {
  if (!tmuxSession) return null;
  try {
    const out = String(execFileSyncImpl('tmux', ['display-message', '-p', '-t', tmuxSession,
      '#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })).trim();
    return VALID_SESSION_REF.test(out) ? out : null;
  } catch {
    return null;
  }
}

function launchedSince(zylosDir, instanceId, document, sinceMs) {
  const launch = readJson(path.join(monitorDirFor(zylosDir, instanceId, document?.instances?.[instanceId]), FABLE_LAUNCH_FILE), null);
  return Number(launch?.launched_at_ms) > sinceMs;
}

/** Instances whose launches the guard owns: --apply must not restart them itself. */
export function fableGuardOwnsInstance({ document, state, instanceId }) {
  return (Boolean(readFableGuardConfig(document)) && document?.instances?.[instanceId]?.fable_enabled === true)
    || Boolean(state?.personas?.[instanceId]);
}

/**
 * One guard pass now, outside the daemon's poll: plan and commit under the
 * instances.json lock, then execute the fenced restarts. This is the entry
 * point for any writer of the launch policy (configure-ax-devbox-runtime.mjs
 * --apply): it writes instances.json under the lock, releases it, and calls
 * this instead of killing or restarting guard-owned personas itself. The
 * daemon may run the same pass concurrently; the lock serializes the commits
 * and the per-restart fence prevents an obsolete or duplicate restart.
 */
export function reconcileFableGuardNow({
  zylosDir,
  nowMs = Date.now(),
  execFileSyncImpl = execFileSync,
  log = console.log,
  lock = withFileLock,
} = {}) {
  const instancesFile = path.join(zylosDir, 'instances.json');
  let plan = { events: [], restarts: [], changed: false };
  lock(`${instancesFile}.lock`, () => {
    const document = readJson(instancesFile, null);
    plan = planFableGuardPass({ zylosDir, document, nowMs });
    if (plan.changed) writeJsonAtomic(fableGuardStatePath(zylosDir), plan.state);
  });
  for (const event of plan.events) log(`[fable-guard] ${event}`);
  const executed = plan.restarts.length
    ? executeFableRestarts({ zylosDir, restarts: plan.restarts, nowMs, execFileSyncImpl, log, lock })
    : [];
  return { events: plan.events, planned: plan.restarts, executed };
}

// ── Probe scheduling (runtime-failover daemon, non-blocking) ───────────────

const inFlight = new Set();

export function scheduleFableProbes({
  zylosDir,
  nowMs = Date.now(),
  probe = runFableProbe,
  log = console.log,
  pending = inFlight,
} = {}) {
  const document = readJson(path.join(zylosDir, 'instances.json'), null);
  const config = readFableGuardConfig(document);
  if (!config) return [];
  const usageFile = fableUsagePath(zylosDir);
  const store = readJson(usageFile, {});
  const started = [];
  for (const [account, settingsFile] of fableProbeAccounts(document, config)) {
    if (pending.has(account) || !probeDue(store, account, nowMs)) continue;
    pending.add(account);
    const run = Promise.resolve()
      .then(() => probe({ account, settingsFile, fableModel: config.fable_model }))
      .catch(err => ({ outcome: 'invalid', reason: `probe_error:${err.message}` }))
      .then(result => {
        const updated = recordProbeResult(readJson(usageFile, {}), { account, result, nowMs: Date.now(), config });
        writeJsonAtomic(usageFile, updated);
        if (result.outcome !== 'valid') log(`[fable-guard] probe ${account}: ${result.outcome} (${result.reason})`);
      })
      .catch(err => log(`[fable-guard] probe ${account}: store write failed (${err.message})`))
      .finally(() => pending.delete(account));
    started.push(run);
  }
  return started;
}

// ── Operator commands ──────────────────────────────────────────────────────

export function clearFableHold(state, { account, kind = 'all', nowMs = Date.now(), reason = 'manual' }) {
  const next = normalizeState(state);
  const holds = { ...(next.holds[account] || {}) };
  const kinds = kind === 'all' ? Object.keys(holds) : [kind];
  if (kind !== 'all' && !HOLD_KINDS.includes(kind)) throw new Error(`unknown hold kind: ${kind}`);
  const cleared = kinds.filter(item => holds[item]);
  for (const item of cleared) delete holds[item];
  if (cleared.includes('crash')) delete next.crash_trips[account];
  if (Object.keys(holds).length) next.holds[account] = holds;
  else delete next.holds[account];
  next.manual_clears = [...(Array.isArray(next.manual_clears) ? next.manual_clears : []),
    { at: iso(nowMs), account, kinds: cleared, reason }].slice(-20);
  return { state: next, cleared };
}
