/**
 * Fable allowance guard, persona-monitor half. Runs inside the activity
 * monitor of a guard-tracked persona and never depends on the
 * runtime-failover daemon being alive:
 *
 *  - lease enforcement: a running session that may be on Fable (judged from
 *    the session itself: the CLI process's --model argument and the model it
 *    reports; the launch record is only the launch intent) and whose admission
 *    no longer holds (lease expired, hold, Opus committed, threshold) is
 *    stopped after a grace that lets a live daemon act first. The stop is
 *    bound to that exact session (sessionRef). A
 *    stop is done only when the session is observed gone; a failed or
 *    unconfirmed stop is retried with backoff and an ALERT. The Guardian
 *    relaunch re-evaluates admission (prepareFableLaunch) and comes up on Opus.
 *    The monitor only ever forces this safe direction; every upgrade stays
 *    with the daemon, the single transition owner.
 *  - evidence for the daemon, stamped with the CURRENT launch record (a
 *    Guardian relaunch can change the mode without a new monitor): classified
 *    limit dialogs, Fable-session failures (recovery kills and unexpected
 *    foreground exits, never planned transitions) and the readiness probe.
 *
 * Contract: docs/fable-allowance-guard.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIMIT_EVIDENCE_FILE, READINESS_FILE, SESSION_FAILURES_FILE } from './fable-guard.js';
import { readSessionRef as readTmuxSessionRef } from '../../comm-bridge/scripts/tmux-input-state.js';
import { runtimeSwitchSignalPath } from './runtime-switch-signal.js';
import {
  FABLE_LAUNCH_FILE,
  fableAdmission,
  fableGuardStatePath,
  fableUsagePath,
  readFableGuardConfig,
} from '../../multi-session/runtime-files.js';

export const LEASE_ENFORCEMENT_FILE = 'fable-lease-enforcement.json';
export { READINESS_FILE };
export const UNCERTAIN_DELIVERIES_FILE = 'fable-uncertain-deliveries.json';
// End-to-end heartbeat phase: the dispatcher never auto-ACKs it.
const READINESS_PHASE = 'post_restart';
// Longer than one daemon poll plus its cold restart, so a live daemon always
// performs the transition and the monitor acts only when the daemon cannot.
export const LEASE_ENFORCEMENT_GRACE_MS = 120_000;
const CHECK_INTERVAL_MS = 15_000;
// An unconfirmed stop is retried after 15 s, 30 s, 1 min ... at most 5 min.
const STOP_RETRY_MS = 15_000;
const STOP_RETRY_MAX_MS = 5 * 60_000;
// A launch record describes a session when it was written shortly before that
// session was created (prepareFableLaunch runs right before the tmux launch).
const RECORD_SESSION_WINDOW_MS = 120_000;
const SESSION_GONE_RE = /can't find session|no server running|session not found/i;
const SESSION_REF_RE = /^\$\d+:\d+:%\d+:\d+$/;

const iso = ms => new Date(ms).toISOString();
const baseModel = model => (typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : null);
const backoff = (attempt, base, max) => Math.min(base * 2 ** Math.max(0, attempt - 1), max);

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, filePath);
}

/** The model argument of a CLI command line (`--model X` / `--model=X`), else null. */
export function parseModelArgument(commandLine) {
  const match = /(?:^|\s)--model(?:=|\s+)(['"]?)([^\s'"]+)\1/.exec(String(commandLine || ''));
  return match ? match[2] : null;
}

/** Is exactly this tmux session (sessionRef) still there? 'present' | 'gone' | 'unknown'. */
export function probeTmuxSessionRef(sessionRef, { execFileSyncImpl = execFileSync } = {}) {
  if (!SESSION_REF_RE.test(sessionRef || '')) return 'unknown';
  const [sessionId, created] = sessionRef.split(':');
  try {
    const out = String(execFileSyncImpl('tmux', ['display-message', '-p', '-t', sessionId, '#{session_id}:#{session_created}'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })).trim();
    return out === `${sessionId}:${created}` ? 'present' : 'gone';
  } catch (err) {
    return SESSION_GONE_RE.test(`${err?.stderr || ''} ${err?.message || ''}`) ? 'gone' : 'unknown';
  }
}

/** Kill exactly the tmux session of `sessionRef` (its session id), never a session reusing the name. */
export function killTmuxSessionRef(sessionRef, { execFileSyncImpl = execFileSync } = {}) {
  if (!SESSION_REF_RE.test(sessionRef || '')) throw new Error(`invalid sessionRef ${sessionRef}`);
  execFileSyncImpl('tmux', ['kill-session', '-t', sessionRef.split(':')[0]], { stdio: 'pipe', timeout: 10_000 });
}

/** The model the persona's CLI last reported (statusline.json), with the time of that report. */
export function readStatuslineModel(monitorDir) {
  const file = path.join(monitorDir, 'statusline.json');
  try {
    const model = JSON.parse(fs.readFileSync(file, 'utf8'))?.model?.id;
    return typeof model === 'string' ? { model, observed_at_ms: fs.statSync(file).mtimeMs } : null;
  } catch { return null; }
}

/**
 * Monitor-side guard for one persona, or null when the monitor started
 * without a Fable decision (feature inert, persona not fable_enabled).
 */
export function createFableMonitor({
  zylosDir,
  instanceId,
  monitorDir,
  runtimeProfile,
  // Kills exactly the session identified by its sessionRef (not by name).
  stopSession = sessionRef => killTmuxSessionRef(sessionRef),
  sessionName = null,
  classifyLimitDialog = null,
  capturePane = session => execFileSync('tmux', ['capture-pane', '-p', '-t', session],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }),
  readSessionRef = () => readTmuxSessionRef(sessionName),
  probeSession = sessionRef => probeTmuxSessionRef(sessionRef),
  // The running CLI's model argument: { model } or null when unreadable.
  readProcessModel = () => null,
  readModelReport = () => readStatuslineModel(monitorDir),
  // C4 key fence for the stopped session (comm-bridge supersedeControlsForSession).
  fenceReplacedSession = () => {},
  // C4 delivery_uncertain for this persona: { list() -> unnotified rows, markNotified(id) }.
  uncertainDeliveries = null,
  now = () => Date.now(),
  log = () => {},
  graceMs = LEASE_ENFORCEMENT_GRACE_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
} = {}) {
  if (!runtimeProfile?.fable || !instanceId || !monitorDir) return null;
  const readLaunch = () => readJson(path.join(monitorDir, FABLE_LAUNCH_FILE), null);
  const fableLaunch = () => { const launch = readLaunch(); return launch?.mode === 'fable' ? launch : null; };
  const stamp = launch => ({ at: iso(now()), runtime_profile: launch.runtime_profile, mode: launch.mode,
    generation: launch.generation ?? null, launch_id: launch.launch_id });
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  let lastCheckAt = 0;
  // Unadmitted since, bound to the session it was observed on.
  let unadmitted = null;
  // A stop decided for one exact session, kept until that session is observed gone.
  let pending = null;
  // The next session exit is planned or already counted (recovery kill, lease enforcement).
  let plannedStop = null;

  function recordFailure(reason, launch = fableLaunch()) {
    if (launch?.mode !== 'fable') return; // only Fable-session failures feed the crash rule
    const file = path.join(monitorDir, SESSION_FAILURES_FILE);
    const prior = readJson(file, {});
    const failures = [...(Array.isArray(prior?.failures) ? prior.failures : []), { ...stamp(launch), reason }].slice(-10);
    writeJsonAtomic(file, { failures });
  }

  function switchSignalPending() {
    try { return fs.existsSync(runtimeSwitchSignalPath({ zylosDir, instanceId })); } catch { return false; }
  }

  const healthDeps = {
    onRecoveryRestart: reason => {
      try { recordFailure(reason); } catch { /* evidence only */ }
      plannedStop = `recovery:${reason}`;
    },
    guardReadiness: {
      phase: READINESS_PHASE,
      onResult: result => {
        const launch = readLaunch();
        writeJsonAtomic(path.join(monitorDir, READINESS_FILE), { launch_id: launch?.launch_id || null,
          generation: launch?.generation ?? null, outcome: result.outcome, phase: result.phase || null,
          status: result.status || null, at: iso(now()) });
      },
    },
    ...(typeof classifyLimitDialog === 'function' ? {
      detectLimitDialog: () => {
        if (!fableLaunch()) return null; // only a Fable session can show the Fable limit
        let text;
        try { text = capturePane(sessionName); } catch { return null; }
        const result = classifyLimitDialog(text);
        return result && (result.kind === 'fable_limit' || result.kind === 'credits_offer') ? result : null;
      },
      onLimitDialog: result => {
        const launch = fableLaunch();
        if (!launch) return;
        writeJsonAtomic(path.join(monitorDir, LIMIT_EVIDENCE_FILE), { ...stamp(launch), kind: result.kind,
          text: String(result.text || '').slice(0, 300), source: result.source || null });
      },
    } : {}),
  };

  // Guardian is about to (re)launch: was the previous session's exit expected?
  const guardianDeps = {
    onAgentStart: ({ previouslyRunning = false, woke = false, maintenance = false } = {}) => {
      const planned = plannedStop;
      plannedStop = null;
      if (!previouslyRunning || woke || maintenance || planned || switchSignalPending()) return;
      try { recordFailure('unexpected_exit'); } catch { /* evidence only */ }
    },
  };

  // Name each message whose delivery a dialog made uncertain, once. It is
  // never re-delivered (duplicate-execution risk); an operator decides.
  function notifyUncertainDeliveries() {
    let rows = [];
    try { rows = uncertainDeliveries?.list() || []; } catch (err) { log(`Fable guard: uncertain deliveries unavailable (${err.message})`); }
    for (const row of rows) {
      const record = { id: row.id, item_type: row.item_type, item_id: row.item_id, channel: row.channel || null,
        endpoint_id: row.endpoint_id || null, dialog_kind: row.dialog_kind, session_ref: row.session_ref || null,
        preview: row.preview || null, detected_at: Number.isFinite(Number(row.detected_at)) ? iso(Number(row.detected_at) * 1000) : null };
      log(`Fable guard ALERT: delivery uncertain on ${instanceId} (${row.dialog_kind}): ${row.item_type} #${row.item_id}`
        + `${row.channel ? ` from ${row.channel}` : ''}${row.preview ? ` "${row.preview}"` : ''}; the CLI may not have received it. `
        + 'Not re-delivered: resend by hand if needed.');
      try {
        const file = path.join(monitorDir, UNCERTAIN_DELIVERIES_FILE);
        const prior = readJson(file, {});
        writeJsonAtomic(file, { records: [...(Array.isArray(prior?.records) ? prior.records : []), record].slice(-20) });
        uncertainDeliveries.markNotified(row.id);
      } catch (err) { log(`Fable guard: uncertain delivery ${row.id} not recorded (${err.message})`); }
    }
  }

  // ── Lease enforcement ──────────────────────────────────────────────────────
  // Without a configured fable_model (guard disabled since start) any Fable model name counts.
  const isFableModel = (model, config) => Boolean(model)
    && (config?.fable_model ? baseModel(model) === baseModel(config.fable_model) : /fable/i.test(model));

  // The session's model from the session itself: 'fable' | 'opus' | 'unknown'.
  function sessionModel(sessionRef, config) {
    const createdMs = Number(sessionRef.split(':')[1]) * 1000;
    const proc = safe(readProcessModel);
    const report = safe(readModelReport);
    const reportFresh = report?.model && Number(report.observed_at_ms) >= createdMs ? report.model : null;
    if (isFableModel(proc?.model, config) || isFableModel(reportFresh, config)) return 'fable';
    if (proc?.model || reportFresh) return 'opus';
    return 'unknown';
  }

  // The launch record written for this session, if any (it is the launch intent).
  function recordFor(launch, sessionRef) {
    const createdMs = Number(sessionRef.split(':')[1]) * 1000;
    const launchedMs = Number(launch?.launched_at_ms);
    return Number.isFinite(launchedMs) && launchedMs >= createdMs - RECORD_SESSION_WINDOW_MS ? launch : null;
  }

  function writeEnforcement(extra) {
    try {
      writeJsonAtomic(path.join(monitorDir, LEASE_ENFORCEMENT_FILE), { instance_id: instanceId, reason: pending?.reason || null,
        launch_id: pending?.launchId ?? null, generation: pending?.generation ?? null, runtime_profile: pending?.profileId ?? null,
        session_ref: pending?.sessionRef ?? null, evidence: pending?.evidence ?? null, decided_at: pending ? iso(pending.since) : null,
        attempts: pending?.attempts ?? 0, ...extra });
    } catch { /* evidence only */ }
  }

  function enforce(nowMs) {
    if (nowMs < pending.nextAt) return null;
    pending.attempts += 1;
    plannedStop = 'lease_enforcement';
    let error = null;
    try { stopSession(pending.sessionRef); } catch (err) { error = err.message; }
    const after = safe(() => probeSession(pending.sessionRef), 'unknown');
    if (after === 'gone') {
      const record = { at: iso(nowMs), status: 'confirmed', confirmed_at: iso(nowMs) };
      writeEnforcement(record);
      log(`Fable guard: lease enforcement stopped session ${pending.sessionRef} (attempt ${pending.attempts}); `
        + 'the relaunch is admitted to Opus only');
      try { fenceReplacedSession(pending.sessionRef); } catch (err) { log(`Fable guard key fence failed: ${err.message}`); }
      const done = { ...pending, ...record };
      pending = null;
      return done;
    }
    plannedStop = null;
    const detail = `${error ? `stop failed: ${error}; ` : ''}session ${after}`;
    pending.nextAt = nowMs + backoff(pending.attempts, STOP_RETRY_MS, STOP_RETRY_MAX_MS);
    writeEnforcement({ at: iso(nowMs), status: 'pending', last_error: detail, next_attempt_at: iso(pending.nextAt) });
    log(`Fable guard ALERT: lease enforcement stop of session ${pending.sessionRef} not confirmed (attempt ${pending.attempts}: `
      + `${detail}); Fable may still be running, retrying at ${iso(pending.nextAt)}`);
    return { ...pending, status: 'pending', last_error: detail };
  }

  function tick() {
    const nowMs = now();
    if (nowMs - lastCheckAt < checkIntervalMs) return null;
    lastCheckAt = nowMs;
    notifyUncertainDeliveries();
    if (pending) return enforce(nowMs);
    const sessionRef = safe(readSessionRef);
    // No session to judge (or to stop) right now; a relaunch is judged on its own.
    if (!sessionRef || !SESSION_REF_RE.test(sessionRef)) return null;
    const document = readJson(path.join(zylosDir, 'instances.json'), null);
    const config = readFableGuardConfig(document);
    const evidence = sessionModel(sessionRef, config);
    if (evidence === 'opus') { unadmitted = null; return null; }
    // Fable or unknown: missing evidence is never taken as safe.
    const launch = readLaunch();
    const record = recordFor(launch, sessionRef);
    const profileId = record?.runtime_profile || document?.instances?.[instanceId]?.runtime_profile || null;
    const admission = fableAdmission({ document, instanceId, profileId, nowMs,
      guardState: readJson(fableGuardStatePath(zylosDir), null), usage: readJson(fableUsagePath(zylosDir), null) });
    if (admission?.admitted) { unadmitted = null; return null; }
    if (!unadmitted || unadmitted.sessionRef !== sessionRef) unadmitted = { sessionRef, since: nowMs };
    if (nowMs - unadmitted.since < graceMs) return null;
    unadmitted = null;
    pending = { sessionRef, launchId: record?.launch_id ?? null, generation: record?.generation ?? null, profileId,
      reason: admission?.reason || 'not_enabled', evidence, since: nowMs, attempts: 0, nextAt: nowMs };
    writeEnforcement({ at: iso(nowMs), status: 'pending' });
    log(`Fable guard ALERT: session ${sessionRef} (model evidence: ${evidence}, launch ${pending.launchId || 'unrecorded'}) `
      + `is not admitted to Fable (${pending.reason}) and the guard daemon did not act within ${Math.round(graceMs / 1000)}s; `
      + 'stopping it so the relaunch comes up on Opus');
    return enforce(nowMs);
  }

  return { tick, readLaunch, healthDeps, guardianDeps };
}
