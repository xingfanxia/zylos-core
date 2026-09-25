/**
 * Advisory cross-process file lock (mkdir-based).
 *
 * `fs.mkdirSync` is atomic — it fails with EEXIST when the lock dir already
 * exists — so it is a reliable mutual-exclusion primitive across processes on
 * the same filesystem. The holder's pid is recorded inside so a lock left
 * behind by a crashed process (a dead pid) can be reclaimed instead of
 * deadlocking forever. Mirrors the singleton-pidfile pattern in c4-broker /
 * c4-dispatcher, generalized to a reusable critical section.
 *
 * Used to serialize read-modify-write cycles on instances.json (ZY-LOCK-1),
 * where multiple writers (c4-approve, the dashboard, the CLI) would otherwise
 * lose updates: two processes each read the file, mutate their own copy, and
 * the second rename clobbers the first writer's change.
 */

import fs from 'fs';
import path from 'path';

/** Sync sleep without a busy loop — Atomics.wait on a throwaway buffer. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} lockDir - lock directory path (e.g. `${file}.lock`)
 * @param {string} pidFile - pid marker path inside the lock dir
 * @returns {boolean} true if the lock was stale and successfully reclaimed
 */
function reclaimIfStale(lockDir, pidFile) {
  let holderPid = 0;
  try {
    holderPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  } catch {
    // pid marker missing/unreadable — treat as stale and try to reclaim.
  }
  if (Number.isInteger(holderPid) && holderPid > 0 && holderPid !== process.pid) {
    try {
      process.kill(holderPid, 0); // signal 0 = liveness probe
      return false;               // holder alive → not stale
    } catch (err) {
      if (err?.code === 'EPERM') return false; // alive but owned by another user
    }
  }
  // Dead pid, unreadable marker, or our own leftover → reclaim.
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive advisory lock on `lockDir`.
 * Spins with a short backoff on live contention, reclaiming stale locks, then
 * throws if it cannot acquire within the retry budget. Always releases in a
 * finally so a throwing `fn` never leaks the lock.
 *
 * @template T
 * @param {string} lockDir - lock directory (created/removed by this fn)
 * @param {() => T} fn - critical section
 * @param {{ retries?: number, sleepMs?: number }} [opts]
 * @returns {T}
 */
export function withFileLock(lockDir, fn, { retries = 100, sleepMs = 20 } = {}) {
  const pidFile = path.join(lockDir, 'pid');
  let held = false;
  for (let attempt = 0; attempt <= retries && !held; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(pidFile, String(process.pid)); } catch { /* best effort */ }
      held = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Held by someone: reclaim if stale (retry immediately), else back off.
      if (!reclaimIfStale(lockDir, pidFile)) {
        if (attempt < retries) sleepSync(sleepMs);
      }
    }
  }
  if (!held) {
    throw new Error(`withFileLock: could not acquire ${lockDir} after ${retries} retries`);
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
