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
  fableAccountSettingsFile,
  fableGuardStatePath,
  fableUsagePath,
  readFableGuardConfig,
} from '../../multi-session/runtime-files.js';
import { baseModel, probeDue, recordProbeResult, runFableProbe } from './fable-probe.js';
import { writeRuntimeSwitchSignal } from './runtime-switch-signal.js';

const CLOCK_SKEW_MS = 30_000;
const RESUME_GRACE_MS = 180_000;
const MAX_RESTART_ATTEMPTS = 3;
const STATUS_MAX_AGE_MS = 60_000;
const EVIDENCE_MAX_AGE_MS = 3_600_000;
const HOLD_KINDS = ['quota', 'crash', 'stale'];
export const LIMIT_EVIDENCE_FILE = 'fable-limit-evidence.json';
export const SESSION_FAILURES_FILE = 'fable-session-failures.json';

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

// The last valid observation, unless the local clock says it is from the future.
function lastObservation(entry, nowMs) {
  const obs = entry?.last_valid;
  const observedMs = ms(obs?.observed_at);
  if (!obs || !Number.isFinite(observedMs) || observedMs > nowMs + CLOCK_SKEW_MS) return null;
  if (!Number.isFinite(Number(obs.utilization)) || !Number.isFinite(ms(obs.resets_at))) return null;
  return obs;
}

// Lease: a valid observation younger than lease_sec whose window has not reset.
function freshObservation(entry, nowMs, config) {
  const obs = lastObservation(entry, nowMs);
  if (!obs) return null;
  return nowMs - ms(obs.observed_at) < config.lease_sec * 1000 && ms(obs.resets_at) > nowMs ? obs : null;
}

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
  failoverInstanceIds = new Set(),
  nowMs = Date.now(),
} = {}) {
  const config = readFableGuardConfig(document);
  const next = normalizeState(state);
  const restarts = [];
  const events = [];
  const before = JSON.stringify(next);
  const instances = document?.instances || {};
  const profiles = document?.runtime_profiles || {};
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
    if (eligible && accountAllowsFable(next, usage, profileId, config, nowMs)) {
      mode = priorMode === 'fable' || upgradeReady(persona, status, nowMs, config) ? 'fable' : 'opus';
    }
    const changed = !persona.desired || persona.desired.mode !== mode || persona.desired.account !== profileId;
    if (changed) {
      const generation = ++next.generation_seq;
      const modeChanged = priorMode !== mode;
      const reason = !enabled ? 'fable_disabled' : mode === 'fable' ? 'fable_allowed'
        : `fable_blocked:${Object.keys(next.holds[profileId] || {}).join('+') || (eligible ? 'no_lease' : 'ineligible_account')}`;
      persona.desired = { account: profileId, mode, generation, committed_at: iso(nowMs), reason };
      if (modeChanged) persona.last_transition_at = iso(nowMs);
      persona.executed_generation = generation;
      persona.executed_at = iso(nowMs);
      persona.restart_required = modeChanged;
      persona.attempts = 0;
      delete persona.verified;
      const alreadyRunning = runningModelMatches(status, modelByInstance[id],
        mode === 'fable' ? config?.fable_model : profiles[profileId]?.model);
      if (alreadyRunning) persona.restart_required = false;
      if (modeChanged && !failoverInstanceIds.has(id) && !alreadyRunning) {
        persona.attempts = 1;
        restarts.push({ instanceId: id, generation, mode, profileId, reason,
          tmuxSession: instance.tmux_session || `claude-${id}` });
      }
      events.push(`${id}: commit g${generation} ${mode} on ${profileId} (${reason})`);
      continue;
    }
    reconcilePersona({ id, instance, persona, status, actual: modelByInstance[id], profiles, config, nowMs, restarts, events,
      failureCount: () => sessionFailures(persona, failuresByInstance[id], profileId,
        Math.max(nowMs - (config?.crash_window_sec || 0) * 1000, ms(persona.crash_counted_after) || 0)).length });
    if (!enabled && persona.desired.mode === 'opus' && persona.verified) delete next.personas[id];
  }

  const changed = JSON.stringify(next) !== before;
  return { state: next, restarts, events, changed };
}

// Verify a committed generation against the running engine and resume an
// interrupted transition. A committed opus with Fable still running is not done.
function runningModelMatches(status, actual, model) {
  const launchMs = Number(status?.runtime_launch_at) || 0;
  return ['idle', 'busy'].includes(status?.state) && Boolean(baseModel(model))
    && baseModel(actual?.model) === baseModel(model) && Number(actual?.observed_at_ms) >= launchMs;
}

function reconcilePersona({ id, instance, persona, status, actual, profiles, config, nowMs, restarts, events, failureCount }) {
  const desired = persona.desired;
  if (persona.executed_generation !== desired.generation) return;
  if (!['idle', 'busy'].includes(status.state)) {
    // A stopped engine launches from the committed state next time.
    if (status.state !== 'starting' && !persona.restart_required) persona.verified ||= { not_running_at: iso(nowMs) };
    return;
  }
  const expected = desired.mode === 'fable' ? baseModel(config?.fable_model) : baseModel(profiles[desired.account]?.model);
  const launchMs = Number(status.runtime_launch_at) || 0;
  const executedMs = ms(persona.executed_at);
  const resume = why => {
    if ((persona.attempts || 0) >= MAX_RESTART_ATTEMPTS) {
      if (!persona.gave_up) events.push(`${id}: g${desired.generation} not converged after ${persona.attempts} restarts (${why}); operator check needed`);
      persona.gave_up = why;
      return;
    }
    persona.attempts = (persona.attempts || 0) + 1;
    persona.executed_at = iso(nowMs);
    restarts.push({ instanceId: id, generation: desired.generation, mode: desired.mode, profileId: desired.account,
      reason: `resume:${why}`, tmuxSession: instance.tmux_session || `claude-${id}` });
    events.push(`${id}: resume g${desired.generation} (${why})`);
  };
  if (persona.restart_required && launchMs < executedMs - 2000) {
    if (nowMs - executedMs > RESUME_GRACE_MS) resume('no_new_launch');
    return;
  }
  const actualModel = baseModel(actual?.model);
  if (!actualModel || !expected || !(Number(actual.observed_at_ms) >= launchMs)) return;
  if (actualModel !== expected) {
    if (persona.verified?.mismatch_launch === launchMs) return;
    persona.verified = { mismatch_launch: launchMs };
    // A session launched after this commit that is not on Fable is a Fable
    // session failure (e.g. the CLI's consent fallback). When it trips the
    // crash rule, the next pass commits Opus instead of relaunching Fable.
    if (desired.mode === 'fable' && launchMs >= executedMs - 2000) {
      persona.failures = [...(persona.failures || []), { at: iso(nowMs), reason: `model_mismatch:${actualModel}` }].slice(-10);
      if (failureCount() >= config.crash_failures) return;
    }
    resume(`model_mismatch:${actualModel}`);
    return;
  }
  if (!persona.verified?.model_at) persona.verified = { model_at: iso(nowMs) };
  if (!persona.verified.ack_at && Number(status.functional_ack_at) >= launchMs
      && typeof status.functional_ack_phase === 'string' && status.functional_ack_phase !== 'primary') {
    persona.verified.ack_at = iso(Number(status.functional_ack_at));
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
  const inputs = { statusByInstance: {}, modelByInstance: {}, evidenceByInstance: {}, failuresByInstance: {} };
  for (const [id, instance] of Object.entries(document?.instances || {})) {
    if (instance?.fable_enabled !== true && !state?.personas?.[id]) continue;
    const dir = monitorDirFor(zylosDir, id, instance);
    inputs.statusByInstance[id] = readJson(path.join(dir, 'agent-status.json'), {});
    inputs.modelByInstance[id] = readActualModel(dir);
    inputs.evidenceByInstance[id] = readJson(path.join(dir, LIMIT_EVIDENCE_FILE), null);
    inputs.failuresByInstance[id] = readJson(path.join(dir, SESSION_FAILURES_FILE), null);
  }
  return planFableGuard({ document, state, usage: readJson(fableUsagePath(zylosDir), {}),
    failoverInstanceIds, nowMs, ...inputs });
}

/**
 * Cold-start restart of each committed transition, reusing the failover path
 * (switch signal → kill tmux → pm2 restart). A restart whose generation was
 * superseded before it ran is skipped.
 */
export function executeFableRestarts({ zylosDir, restarts, nowMs = Date.now(), execFileSyncImpl = execFileSync, log = console.log }) {
  const live = restarts.filter(item => {
    const generation = readFableGuardState(zylosDir)?.personas?.[item.instanceId]?.desired?.generation;
    if (generation === item.generation) return true;
    log(`[fable-guard] ${item.instanceId}: g${item.generation} superseded by g${generation}; restart skipped`);
    return false;
  });
  for (const item of live) {
    writeRuntimeSwitchSignal({ zylosDir, nowMs, change: { instanceId: item.instanceId, fromProfile: item.profileId,
      toProfile: item.profileId, reason: `fable_guard:${item.mode}:g${item.generation}` } });
  }
  for (const item of live) {
    try {
      execFileSyncImpl('tmux', ['kill-session', '-t', item.tmuxSession], { stdio: 'ignore', timeout: 10_000 });
    } catch { /* absent pane is fine */ }
    try {
      execFileSyncImpl('pm2', ['restart', `activity-monitor-${item.instanceId}`, '--update-env'], { stdio: 'ignore', timeout: 30_000 });
      log(`[fable-guard] ${item.instanceId}: restart g${item.generation} -> ${item.mode} (${item.reason})`);
    } catch (err) {
      log(`[fable-guard] ${item.instanceId}: restart g${item.generation} failed (${err.message}); resumed on a later pass`);
    }
  }
  return live;
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

// ── Monitor-side evidence (activity monitor of a Fable-mode persona) ───────

/**
 * HealthEngine deps for a persona whose engine was launched on Fable. Other
 * personas get none, so their health handling is unchanged.
 */
export function createFableMonitorDeps({ runtimeProfile, monitorDir, sessionName, classifyLimitDialog,
  capturePane = session => execFileSync('tmux', ['capture-pane', '-p', '-t', session],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }),
  now = () => Date.now() } = {}) {
  if (runtimeProfile?.fable?.mode !== 'fable') return {};
  const stamp = () => ({ at: iso(now()), runtime_profile: runtimeProfile.id,
    mode: 'fable', generation: runtimeProfile.fable.generation });
  const onRecoveryRestart = reason => {
    const file = path.join(monitorDir, SESSION_FAILURES_FILE);
    const prior = readJson(file, {});
    const failures = [...(Array.isArray(prior.failures) ? prior.failures : []), { ...stamp(), reason }].slice(-10);
    writeJsonAtomic(file, { failures });
  };
  if (typeof classifyLimitDialog !== 'function') return { onRecoveryRestart };
  return {
    onRecoveryRestart,
    detectLimitDialog: () => {
      let text;
      try { text = capturePane(sessionName); } catch { return null; }
      const result = classifyLimitDialog(text);
      return result && (result.kind === 'fable_limit' || result.kind === 'credits_offer') ? result : null;
    },
    onLimitDialog: result => writeJsonAtomic(path.join(monitorDir, LIMIT_EVIDENCE_FILE),
      { ...stamp(), kind: result.kind, text: String(result.text || '').slice(0, 300), source: result.source || null }),
  };
}

/**
 * Supersede pending [KEYSTROKE] controls (watchdog interrupts, auto-approve
 * Enter) aimed at this persona's previous session. Claimed/running rows are
 * left to the dispatcher. Returns the number of rows superseded.
 */
export function dropPendingKeystrokes(database, instanceId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!database || !instanceId) return 0;
  return database.prepare(`
    UPDATE control_queue
    SET status = 'superseded', last_error = 'FABLE_GUARD_RELAUNCH', updated_at = ?
    WHERE status = 'pending' AND target_instance = ? AND content LIKE '[KEYSTROKE]%'
  `).run(nowSec, instanceId).changes || 0;
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
