/**
 * Per-persona execution claim of the Fable allowance guard. Every effect that
 * restarts or stops a guard-owned persona goes through it: the daemon's guard
 * restarts and safe stops, `reconcileFableGuardNow` (the --apply entry point),
 * the account failover's restart or suspend of a guard-owned persona, and the
 * persona monitor's lease-enforcement stop. At most one claim per persona is
 * `running`; an operation (kind + generation + attempt + target) that already
 * ran is never executed again.
 *
 * A claim belongs to the executor PROCESS that took it (`executor`: pid,
 * start identity, host). Its age proves nothing: a paused or slow executor can
 * still continue. A `running` claim is taken over only when its owner provably
 * cannot continue: the pid is gone, or now belongs to a different process
 * (start identity differs: pid reuse, reboot), or the owner is this very
 * process and the claimed operation is no longer executing here. A claim
 * written without an executor (before this field existed) falls back to the
 * old age rule. Every executor also re-checks `holdsExecution` right before
 * each irreversible effect, so one that lost its claim stops before acting.
 *
 * A claim is an execution record, not a completion receipt: completion of a
 * stop is the observed absence of the session, and convergence of a restart
 * is the launch the guard verifies afterwards.
 *
 * File: <ZYLOS_DIR>/activity-monitor/fable-exec/<instance>.json (+ .lock).
 * Contract: docs/fable-allowance-guard.md ("Execution claim").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../../multi-session/file-lock.js';

// Only for a running claim without a recorded executor (written before the
// executor field existed): longer than the effects a claim covers.
export const CLAIM_STALE_MS = 90_000;
const HISTORY_LIMIT = 20;

const iso = ms => new Date(ms).toISOString();

// Tokens of operations this process is executing right now. Every effect is
// synchronous, so a claim owned by this process whose token is not here has
// ended (its completion was not recorded).
const activeTokens = new Set();

/**
 * Start identity of a process, stable for its lifetime and different for a
 * later process reusing the pid: on Linux the boot id plus the start time in
 * clock ticks (/proc/<pid>/stat field 22); elsewhere `ps -o lstart` in UTC.
 * null when it cannot be read.
 */
export function processStartIdentity(pid, { readFileSync = fs.readFileSync, execFileSyncImpl = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = String(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = String(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (start && boot) return `linux:${boot}:${start}`;
  } catch { /* not Linux, or the process is gone */ }
  try {
    const out = String(execFileSyncImpl('ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', stdio: 'pipe', timeout: 3000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })).trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

let selfExecutor = null;
/** This process as a claim owner. */
export function currentExecutor() {
  selfExecutor ||= { pid: process.pid, start: processStartIdentity(process.pid), host: os.hostname() };
  return selfExecutor;
}

/**
 * Can the recorded executor still be running? 'alive' | 'dead' | 'foreign'
 * (recorded on another host: not judged from here) | 'unrecorded'.
 * A pid that exists but cannot be identified counts as alive.
 */
export function executorState(executor, {
  self = currentExecutor(),
  signal = pid => process.kill(pid, 0),
  identityOf = processStartIdentity,
} = {}) {
  if (!Number.isInteger(executor?.pid) || executor.pid <= 0) return 'unrecorded';
  if (executor.host && self.host && executor.host !== self.host) return 'foreign';
  try {
    signal(executor.pid);
  } catch (err) {
    if (err?.code === 'ESRCH') return 'dead';
  }
  const start = identityOf(executor.pid);
  if (executor.start && start && start !== executor.start) return 'dead';
  return 'alive';
}

const sameProcess = (a, b) => Boolean(a && b) && a.pid === b.pid && a.start === b.start && a.host === b.host;

export function executionClaimDir(zylosDir) {
  return path.join(zylosDir, 'activity-monitor', 'fable-exec');
}

export function executionClaimPath(zylosDir, instanceId) {
  return path.join(executionClaimDir(zylosDir), `${instanceId}.json`);
}

/** Identity of one operation: what it does, for which commit/launch, which attempt. */
export function executionKey(op) {
  return [op.kind, `g${op.generation ?? '-'}`, `a${op.attempt ?? '-'}`, op.profileId ?? '-', op.launchId ?? '-',
    op.sessionRef ?? '-', op.suspendedAt ?? '-'].join(':');
}

function readDoc(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { current: doc.current || null, history: Array.isArray(doc.history) ? doc.history : [],
      deferred: Array.isArray(doc.deferred) ? doc.deferred : [] };
  } catch {
    return { current: null, history: [], deferred: [] };
  }
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, file);
}

export function readExecution(zylosDir, instanceId) {
  return readDoc(executionClaimPath(zylosDir, instanceId));
}

/** Why a running claim may be taken over, or null while its executor may still continue. */
function takeoverReason(current, { nowMs, staleMs, self, stateOf }) {
  const executor = current.executor;
  if (!executor?.pid) return nowMs - Number(current.at_ms) >= staleMs ? 'stale_unrecorded_executor' : null;
  if (sameProcess(executor, self)) return activeTokens.has(current.token) ? null : 'ended_in_this_process';
  return stateOf(executor, { self }) === 'dead' ? 'executor_gone' : null;
}

/**
 * Claim the persona for one operation. Returns { ok: true, token, at_ms } or
 * { ok: false, reason } with reason `busy:<owner>:<kind>` (another operation
 * is executing and its executor may still continue) or `already_<status>`
 * (this exact operation already ran). The claim is stamped with the time it
 * is acquired (`now()` inside the lock), not with the caller's pass time.
 * `op`: { owner, kind, generation?, attempt?, profileId?, launchId?, sessionRef?, suspendedAt?, reason? }.
 */
export function claimExecution({
  zylosDir,
  instanceId,
  op,
  now = Date.now,
  lock = withFileLock,
  staleMs = CLAIM_STALE_MS,
  self = currentExecutor(),
  stateOf = executorState,
}) {
  const file = executionClaimPath(zylosDir, instanceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let result = { ok: false, reason: 'not_claimed' };
  lock(`${file}.lock`, () => {
    const doc = readDoc(file);
    const current = doc.current;
    const nowMs = now();
    const takeover = current?.status === 'running' ? takeoverReason(current, { nowMs, staleMs, self, stateOf }) : null;
    if (current?.status === 'running' && !takeover) {
      result = { ok: false, reason: `busy:${current.owner}:${current.kind}`, current };
      return;
    }
    const key = executionKey(op);
    const ran = [current, ...doc.history].find(entry => entry?.key === key && entry.status !== 'running');
    if (ran) {
      result = { ok: false, reason: `already_${ran.status}`, current };
      return;
    }
    // A `running` claim whose executor cannot continue was interrupted.
    const recovered = takeover ? current.key : null;
    if (current) {
      doc.history = [{ ...current, ...(recovered ? { status: 'interrupted', interrupted_by: takeover } : {}) }, ...doc.history]
        .slice(0, HISTORY_LIMIT);
    }
    const token = randomUUID();
    doc.current = { ...op, key, token, status: 'running', at: iso(nowMs), at_ms: nowMs,
      executor: { pid: self.pid, start: self.start, host: self.host }, ...(recovered ? { recovered } : {}) };
    doc.deferred = doc.deferred.filter(item => executionKey(item) !== key);
    writeDoc(file, doc);
    activeTokens.add(token);
    result = { ok: true, token, key, at_ms: nowMs, ...(recovered ? { recovered } : {}) };
  });
  return result;
}

/**
 * Does `token` still hold the persona's claim? Checked right before every
 * irreversible effect; false (or an unreadable claim) means: do not act.
 */
export function holdsExecution({ zylosDir, instanceId, token, lock = withFileLock }) {
  const file = executionClaimPath(zylosDir, instanceId);
  let held = false;
  lock(`${file}.lock`, () => {
    const current = readDoc(file).current;
    held = Boolean(token) && current?.token === token && current.status === 'running';
  });
  return held;
}

/**
 * Record the outcome of the claimed operation (`done` | `failed`). No-op for
 * a token that no longer holds the claim. The operation stops executing in
 * this process either way.
 */
export function completeExecution({
  zylosDir,
  instanceId,
  token,
  outcome,
  detail = null,
  now = Date.now,
  lock = withFileLock,
}) {
  const file = executionClaimPath(zylosDir, instanceId);
  let completed = false;
  try {
    lock(`${file}.lock`, () => {
      const doc = readDoc(file);
      if (doc.current?.token !== token) return;
      doc.current = { ...doc.current, status: outcome, finished_at: iso(now()), ...(detail ? { detail } : {}) };
      writeDoc(file, doc);
      completed = true;
    });
  } finally {
    activeTokens.delete(token);
  }
  return completed;
}

/**
 * Keep an operation that could not run because another one held the claim
 * (an account-failover suspend has no level-triggered retry of its own).
 */
export function deferExecution({ zylosDir, instanceId, item, lock = withFileLock }) {
  const file = executionClaimPath(zylosDir, instanceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  lock(`${file}.lock`, () => {
    const doc = readDoc(file);
    const key = executionKey(item);
    if (!doc.deferred.some(entry => executionKey(entry) === key)) doc.deferred.push(item);
    writeDoc(file, doc);
  });
}

/** Deferred operations of every persona (empty when the guard never ran). */
export function listDeferredExecutions(zylosDir) {
  const dir = executionClaimDir(zylosDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return []; }
  return names.flatMap(name => readDoc(path.join(dir, name)).deferred);
}

/** Drop a deferred operation that no longer applies. */
export function dropDeferredExecution({ zylosDir, instanceId, item, lock = withFileLock }) {
  const file = executionClaimPath(zylosDir, instanceId);
  lock(`${file}.lock`, () => {
    const doc = readDoc(file);
    const key = executionKey(item);
    doc.deferred = doc.deferred.filter(entry => executionKey(entry) !== key);
    writeDoc(file, doc);
  });
}
