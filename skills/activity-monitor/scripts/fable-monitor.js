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
 *
 * Contract: docs/fable-allowance-guard.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FABLE_LAUNCH_FILE,
  fableAdmission,
  fableGuardStatePath,
  fableUsagePath,
} from '../../multi-session/runtime-files.js';

export const LEASE_ENFORCEMENT_FILE = 'fable-lease-enforcement.json';
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
  now = () => Date.now(),
  log = () => {},
  graceMs = LEASE_ENFORCEMENT_GRACE_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
} = {}) {
  if (!runtimeProfile?.fable || !instanceId || !monitorDir) return null;
  const readLaunch = () => readJson(path.join(monitorDir, FABLE_LAUNCH_FILE), null);
  let unadmittedSince = 0;
  let lastCheckAt = 0;
  let enforcedLaunchId = null;

  function tick() {
    const nowMs = now();
    if (nowMs - lastCheckAt < checkIntervalMs) return null;
    lastCheckAt = nowMs;
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
    try { stopSession(); } catch (err) { log(`Fable guard lease enforcement stop failed: ${err.message}`); }
    return record;
  }

  return { tick, readLaunch };
}
