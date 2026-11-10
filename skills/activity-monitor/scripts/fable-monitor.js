/**
 * Fable allowance guard, persona-monitor half. Runs inside the activity
 * monitor of a guard-tracked persona and never depends on the
 * runtime-failover daemon being alive:
 *
 *  - lease enforcement: a session launched on Fable whose admission no longer
 *    holds (lease expired, hold, Opus committed, threshold) is stopped after a
 *    grace that lets a live daemon act first. The Guardian relaunch
 *    re-evaluates admission (prepareFableLaunch) and comes up on Opus. The
 *    monitor only ever forces this safe direction; every upgrade stays with
 *    the daemon, the single transition owner.
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

const iso = ms => new Date(ms).toISOString();

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, filePath);
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
  stopSession,
  sessionName = null,
  classifyLimitDialog = null,
  capturePane = session => execFileSync('tmux', ['capture-pane', '-p', '-t', session],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }),
  // C4 key fence for the stopped session (comm-bridge supersedeControlsForSession).
  readSessionRef = () => readTmuxSessionRef(sessionName),
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
  let unadmittedSince = 0;
  let lastCheckAt = 0;
  let enforcedLaunchId = null;
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

  function tick() {
    const nowMs = now();
    if (nowMs - lastCheckAt < checkIntervalMs) return null;
    lastCheckAt = nowMs;
    notifyUncertainDeliveries();
    const launch = readLaunch();
    if (launch?.mode !== 'fable' || launch.launch_id === enforcedLaunchId) {
      unadmittedSince = 0;
      return null;
    }
    const document = readJson(path.join(zylosDir, 'instances.json'), null);
    const admission = fableAdmission({ document, instanceId, profileId: launch.runtime_profile, nowMs,
      guardState: readJson(fableGuardStatePath(zylosDir), null), usage: readJson(fableUsagePath(zylosDir), null) });
    if (admission?.admitted) {
      unadmittedSince = 0;
      return null;
    }
    const reason = admission?.reason || 'not_enabled';
    if (!unadmittedSince) unadmittedSince = nowMs;
    if (nowMs - unadmittedSince < graceMs) return null;
    enforcedLaunchId = launch.launch_id;
    unadmittedSince = 0;
    const record = { at: iso(nowMs), instance_id: instanceId, reason, launch_id: launch.launch_id,
      generation: launch.generation ?? null, runtime_profile: launch.runtime_profile };
    try { writeJsonAtomic(path.join(monitorDir, LEASE_ENFORCEMENT_FILE), record); } catch { /* evidence only */ }
    log(`Fable guard ALERT: Fable session ${launch.launch_id} no longer admitted (${reason}) and the guard daemon did not act `
      + `within ${Math.round(graceMs / 1000)}s; stopping it so the relaunch comes up on Opus`);
    plannedStop = 'lease_enforcement';
    const sessionRef = readSessionRef();
    try { stopSession(); } catch (err) { log(`Fable guard lease enforcement stop failed: ${err.message}`); }
    if (sessionRef) {
      try { fenceReplacedSession(sessionRef); } catch (err) { log(`Fable guard key fence failed: ${err.message}`); }
    }
    return record;
  }

  return { tick, readLaunch, healthDeps, guardianDeps };
}
