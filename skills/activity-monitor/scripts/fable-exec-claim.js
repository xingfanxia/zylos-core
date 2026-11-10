/**
 * Per-persona execution claim of the Fable allowance guard. Every effect that
 * restarts or stops a guard-owned persona goes through it: the daemon's guard
 * restarts and safe stops, `reconcileFableGuardNow` (the --apply entry point),
 * the account failover's restart or suspend of a guard-owned persona, and the
 * persona monitor's lease-enforcement stop. At most one claim per persona is
 * `running`; an operation (kind + generation + attempt + target) that already
 * ran is never executed again; a `running` claim older than CLAIM_STALE_MS is
 * an interrupted execution and may be recovered.
 *
 * A claim is an execution record, not a completion receipt: completion of a
 * stop is the observed absence of the session, and convergence of a restart
 * is the launch the guard verifies afterwards.
 *
 * File: <ZYLOS_DIR>/activity-monitor/fable-exec/<instance>.json (+ .lock).
 * Contract: docs/fable-allowance-guard.md ("Execution claim").
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../../multi-session/file-lock.js';

// Longer than the effects a claim covers (tmux kill 10 s + pm2 30 s + slack).
export const CLAIM_STALE_MS = 90_000;
const HISTORY_LIMIT = 20;

const iso = ms => new Date(ms).toISOString();

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

function isBusy(current, nowMs, staleMs) {
  return current?.status === 'running' && nowMs - Number(current.at_ms) < staleMs;
}

/**
 * Claim the persona for one operation. Returns { ok: true, token } or
 * { ok: false, reason } with reason `busy:<owner>:<kind>` (another operation
 * is executing) or `already_<status>` (this exact operation already ran).
 * `op`: { owner, kind, generation?, attempt?, profileId?, launchId?, sessionRef?, suspendedAt?, reason? }.
 */
export function claimExecution({
  zylosDir,
  instanceId,
  op,
  nowMs = Date.now(),
  lock = withFileLock,
  staleMs = CLAIM_STALE_MS,
}) {
  const file = executionClaimPath(zylosDir, instanceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let result = { ok: false, reason: 'not_claimed' };
  lock(`${file}.lock`, () => {
    const doc = readDoc(file);
    const current = doc.current;
    if (isBusy(current, nowMs, staleMs)) {
      result = { ok: false, reason: `busy:${current.owner}:${current.kind}`, current };
      return;
    }
    const key = executionKey(op);
    const ran = [current, ...doc.history].find(entry => entry?.key === key && entry.status !== 'running');
    if (ran) {
      result = { ok: false, reason: `already_${ran.status}`, current };
      return;
    }
    // A `running` claim past staleMs was interrupted (its process died mid-effect).
    const recovered = current?.status === 'running' ? current.key : null;
    if (current) doc.history = [{ ...current, ...(recovered ? { status: 'interrupted' } : {}) }, ...doc.history].slice(0, HISTORY_LIMIT);
    const token = randomUUID();
    doc.current = { ...op, key, token, status: 'running', at: iso(nowMs), at_ms: nowMs, ...(recovered ? { recovered } : {}) };
    doc.deferred = doc.deferred.filter(item => executionKey(item) !== key);
    writeDoc(file, doc);
    result = { ok: true, token, key, ...(recovered ? { recovered } : {}) };
  });
  return result;
}

/** Record the outcome of the claimed operation (`done` | `failed`). */
export function completeExecution({
  zylosDir,
  instanceId,
  token,
  outcome,
  detail = null,
  nowMs = Date.now(),
  lock = withFileLock,
}) {
  const file = executionClaimPath(zylosDir, instanceId);
  let completed = false;
  lock(`${file}.lock`, () => {
    const doc = readDoc(file);
    if (doc.current?.token !== token) return;
    doc.current = { ...doc.current, status: outcome, finished_at: iso(nowMs), ...(detail ? { detail } : {}) };
    writeDoc(file, doc);
    completed = true;
  });
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
