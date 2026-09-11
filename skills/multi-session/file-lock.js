/**
 * Advisory cross-process file lock (atomic hard-link publication).
 *
 * The PID record is fully written to a sibling temporary file, then published
 * at the lock path with an atomic no-replace hard link. A lock left by a
 * crashed process can be reclaimed after probing its recorded PID. Legacy
 * mkdir-based locks remain readable during rolling upgrades.
 *
 * Used to serialize read-modify-write cycles on instances.json (ZY-LOCK-1),
 * where multiple writers (c4-approve, the dashboard, the CLI) would otherwise
 * lose updates: two processes each read the file, mutate their own copy, and
 * the second rename clobbers the first writer's change.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

/** Sync sleep without a busy loop — Atomics.wait on a throwaway buffer. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a holder pid from both the current atomic lock-file format and the
 * legacy lock-directory format. The latter keeps stale locks left by older
 * releases recoverable during rolling upgrades.
 *
 * @param {string} lockPath
 * @returns {number|null}
 */
function readHolderPid(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) return null;
    const pidPath = stat.isDirectory() ? path.join(lockPath, 'pid') : lockPath;
    const holderPid = Number.parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
    return Number.isInteger(holderPid) && holderPid > 0 ? holderPid : null;
  } catch {
    return null;
  }
}

/**
 * Publish a complete PID record atomically. Writing a PID after mkdir leaves a
 * race where a contender can observe the directory without its marker and
 * reclaim a lock that is already held. A hard link is a no-replace operation:
 * contenders see either no lock or the fully-written record, never a partial
 * lock.
 *
 * @param {string} lockPath
 */
function tryAcquire(lockPath) {
  const candidate = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(candidate, String(process.pid), { flag: 'wx', mode: 0o600 });
    fs.linkSync(candidate, lockPath);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { fs.unlinkSync(candidate); } catch { /* best effort */ }
  }
}

/**
 * @param {string} lockPath - lock path (e.g. `${file}.lock`)
 * @returns {boolean} true if the lock was stale and successfully reclaimed
 */
function reclaimIfStale(lockPath) {
  const holderPid = readHolderPid(lockPath);
  // Missing/unreadable ownership is ambiguous. Preserve the lock rather than
  // violating mutual exclusion; an operator can inspect and remove it.
  if (holderPid === null) return false;
  if (holderPid !== process.pid) {
    try {
      process.kill(holderPid, 0); // signal 0 = liveness probe
      return false;               // holder alive → not stale
    } catch (err) {
      if (err?.code === 'EPERM') return false; // alive but owned by another user
    }
  }
  // Dead pid or our own leftover → reclaim.
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive advisory lock on `lockPath`.
 * Spins with a short backoff on live contention, reclaiming stale locks, then
 * throws if it cannot acquire within the retry budget. Always releases in a
 * finally so a throwing `fn` never leaks the lock.
 *
 * @template T
 * @param {string} lockPath - lock path (created/removed by this fn)
 * @param {() => T} fn - critical section
 * @param {{ retries?: number, sleepMs?: number }} [opts]
 * @returns {T}
 */
export function withFileLock(lockPath, fn, { retries = 100, sleepMs = 20 } = {}) {
  let held = false;
  for (let attempt = 0; attempt <= retries && !held; attempt++) {
    held = tryAcquire(lockPath);
    if (!held && !reclaimIfStale(lockPath) && attempt < retries) {
      sleepSync(sleepMs);
    }
  }
  if (!held) {
    throw new Error(`withFileLock: could not acquire ${lockPath} after ${retries} retries`);
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
