/**
 * Recipient-scoped access for spill files (SAFE-1 Phase 2).
 *
 * A spill `attachments/conv-<id>/message.txt` is readable by the service user
 * and by exactly one persona: the os_user of the instance that conversation
 * row <id> is routed to (its stored target_instance). The recipient never
 * comes from message text, file names or timestamps. Instances without an
 * os_user (admin, scheduler) run as the service user, so their spills, and
 * spills of rows without a target, stay owner-only.
 *
 * Final access, set in ONE absolute operation per path:
 *   directory  u::rwx  u:<os_user>:--x  g::---  m::--x  o::---   (open by path, no listing)
 *   file       u::rw-  u:<os_user>:r--  g::---  m::r--  o::---
 *   owner-only: chmod 0700 / 0600
 * Because every change goes straight to the final state (never through an
 * owner-only intermediate), a correct reader is never revoked midway, and a
 * producer and the backfill that act on the same path at the same time
 * converge: both derive the same final ACL from the same row.
 *
 * Safety contract: a path must be a directory or a single-link regular file
 * owned by this process, never a symlink, inside parents that nobody but this
 * process can modify (assertServiceDir). If an isolated recipient's ACL cannot
 * be set the call throws, so a caller never hands out a path its recipient
 * cannot open.
 */
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

// multi-session is optional for comm-bridge (c4-db.js, which imports this
// module through c4-utils.js, must load without it, as c4-dispatcher.js's own
// multi-session import does). Without it no instance is known, so a spill
// with a target fails closed (recipient_unknown) instead of guessing.
let getInstanceDef = () => null;
try {
  ({ getInstanceDef } = await import('../../multi-session/instance-config.js'));
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
}

const OS_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SELF = os.userInfo().username;

/**
 * OS user that may read a spill for `instanceId`, or null for owner-only
 * (no target, a service-run instance, or an os_user that is this process's
 * own user). Throws for an unknown instance or
 * an unusable os_user: that recipient could not open an owner-only file, so
 * the caller must not deliver one.
 * @param {string|null|undefined} instanceId - the row's target_instance
 * @returns {string|null}
 */
export function recipientUser(instanceId) {
  if (!instanceId) return null;
  const def = getInstanceDef(instanceId);
  if (!def) throw new Error(`recipient_unknown: ${instanceId}`);
  if (!def.os_user || def.os_user === SELF) return null; // the owner reads it anyway
  if (!OS_USER.test(def.os_user) || def.os_user === 'root') {
    throw new Error(`recipient_unresolvable: ${instanceId}`);
  }
  return def.os_user;
}

/**
 * A parent directory that only this process can change: a real directory
 * owned by our uid with no group, ACL-mask or other write bit (022). On a
 * directory with an ACL the group bits ARE the mask, so this also rejects any
 * named user or group that has write access.
 */
export function assertServiceDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o022)) {
    throw new Error(`unsafe_parent: ${dir}`);
  }
}

/**
 * lstat `p` and require it to be ours and of the expected kind.
 * @param {string} p
 * @param {'dir'|'file'} kind
 * @returns {fs.Stats}
 */
export function assertOwnedEntry(p, kind) {
  const st = fs.lstatSync(p);
  const ok = st.uid === process.getuid() && !st.isSymbolicLink()
    && (kind === 'dir' ? st.isDirectory() : st.isFile() && st.nlink === 1);
  if (!ok) throw new Error(`unsafe_path: ${p}`);
  return st;
}

/** The final ACL text for a recipient, or null for owner-only. */
export function finalAcl(isDir, user) {
  if (!user) return null;
  return isDir
    ? `u::rwx,u:${user}:--x,g::---,m::--x,o::---`
    : `u::rw-,u:${user}:r--,g::---,m::r--,o::---`;
}

function runSetfacl(p, acl) {
  execFileSync('setfacl', ['--set', acl, '--', p], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000 });
}

/**
 * Put `p` into its final state for `user` in one operation.
 * @param {string} p - checked with assertOwnedEntry by the caller
 * @param {boolean} isDir
 * @param {string|null} user - from recipientUser()
 * @param {{run?: (p: string, acl: string) => void}} [deps] - setfacl runner (tests)
 * @throws {Error} recipient_acl_failed when the recipient's ACL cannot be set
 */
export function setFinalAccess(p, isDir, user, { run = runSetfacl } = {}) {
  const acl = finalAcl(isDir, user);
  if (!acl) {
    fs.chmodSync(p, isDir ? 0o700 : 0o600);
    return;
  }
  try {
    run(p, acl);
  } catch (err) {
    const why = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    throw new Error(`recipient_acl_failed: ${user} on ${p}: ${why}`);
  }
}
