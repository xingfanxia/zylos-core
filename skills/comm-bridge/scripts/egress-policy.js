/**
 * Egress policy — shared source-tier detection for the src-egress-guard hook
 * (PreToolUse, client-side, belt-and-braces) and the C4 broker (server-side,
 * the structural enforcement point per ZY-ISO-2).
 *
 * Invariants enforced by both callers:
 *   1. FILES INSIDE SOURCE-TIER REPOS ARE NEVER SENT THROUGH CHAT CHANNELS.
 *   2. AN ISOLATED TENANT MAY NEVER SEND A FILE OWNED BY ANOTHER ISOLATED
 *      TENANT (REL-8 cross-tenant egress guard — the confused-deputy fix).
 *
 * Source-tier repos are discovered dynamically: workspace/<dir> owned by unix
 * group `zylos-src` (the triage tier's readable product source). This is the
 * single source of truth for that detection — do not re-implement it inline.
 *
 * ESM-only, Node 20+.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { execSync, execFileSync } from 'child_process';

/**
 * Resolve source-tier repo roots (realpath'd): workspace dirs group-owned by
 * `zylos-src`. Dirs merely service-locked to 750 are unreadable to isolated
 * agents anyway (unix perms cover them); this only surfaces the tier a triage
 * instance can legitimately read but must never egress.
 *
 * @param {string} workspaceDir - absolute path to the shared workspace dir
 * @returns {string[]} realpath'd source-tier root directories
 */
export function sourceTierRoots(workspaceDir) {
  const roots = [];
  let srcGid = null;
  try {
    srcGid = execSync('getent group zylos-src', { encoding: 'utf8', timeout: 2000 }).split(':')[2];
  } catch (err) {
    // getent exits 2 when the group simply doesn't exist (a valid "no source
    // tier" state). Any other failure (getent missing, timeout) means the
    // egress check may be silently disabled — warn loudly. Fail-open is
    // deliberate: the primary control is unix perms (only zylos-src members can
    // read source at all); this guard is a bar-raiser on top (LOW-3).
    if (err && err.status !== 2) {
      try { process.stderr.write(`[egress-policy] WARN: getent group zylos-src failed (${err.message}); source-tier egress check disabled\n`); } catch { /* ignore */ }
    }
  }
  if (srcGid == null || String(srcGid).trim() === '') return roots;
  const wantGid = String(srcGid).trim();

  let entries = [];
  try { entries = fs.readdirSync(workspaceDir, { withFileTypes: true }); } catch { return roots; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(workspaceDir, e.name);
    try {
      const st = fs.statSync(p);
      if (String(st.gid) === wantGid) {
        try { roots.push(fs.realpathSync(p)); } catch { roots.push(p); }
      }
    } catch { /* unreadable entry — not our concern */ }
  }
  return roots;
}

/**
 * Return { path, root } if `candidatePath` resolves inside one of `roots`,
 * else null. Realpath-first (handles absolute + symlinked paths) with a
 * textual `…/workspace/<repo>/` fallback for paths realpath can't resolve from
 * this process (farm-dir symlinks, relative paths). Over-inclusive by design —
 * for a bar-raiser, over-blocking is the safe direction.
 *
 * @param {string} candidatePath - a filesystem path token from a send command
 * @param {string[]} roots - source-tier roots from sourceTierRoots()
 * @param {string} [homedir] - home dir for ~ expansion (defaults to os.homedir())
 * @returns {{ path: string, root: string } | null}
 */
export function checkPathViolation(candidatePath, roots, homedir = os.homedir()) {
  if (!candidatePath || roots.length === 0) return null;
  const rootNames = new Set(roots.map((r) => path.basename(r)));
  const cand = candidatePath.replace(/^~\//, `${homedir}/`);

  let resolved = cand;
  try { resolved = fs.realpathSync(cand); } catch { /* keep literal — textual fallback below */ }
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return { path: resolved, root };
    }
  }

  const m = cand.match(/(?:^|\/)workspace\/([^/]+)/);
  if (m && rootNames.has(m[1])) {
    return { path: cand, root: m[1] };
  }
  return null;
}

/**
 * Extract the file path from a `[MEDIA:type]path` message prefix (the feishu
 * send.js media convention), or null when the content is plain text.
 *
 * @param {string} content
 * @returns {string | null}
 */
export function mediaPathFromContent(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/^\[MEDIA:\w+\](.+)$/s);
  return m ? m[1].trim() : null;
}

// ── REL-8 owner-validated attachment staging ────────────────────────────────
// The confused-deputy this closes: the broker runs as the hub user with
// supplementary groups (and simple world-read) that let it READ files a tenant
// must never egress — a *peer tenant's* home file, or hub/service-owned shared
// state such as the c4.db conversation store (world-readable, owned by the hub
// user, holding EVERY tenant's messages). A tenant could send
// `[MEDIA:file]/…/c4.db` (or symlink-swap a path between the broker's check and
// send.js's read) and the broker would forward it to that tenant's own chat.
//
// The fix is default-deny + read-once:
//   1. an isolated tenant may attach ONLY a file IT OWNS (fd-validated, so a
//      symlink swap after the check cannot change the inode we validated), and
//   2. the broker reads the validated bytes ONCE into a broker-private staging
//      copy that send.js reads — so the child never re-resolves a caller-mutable
//      path (closes the TOCTOU), and only-owner-uid means hub/peer files are
//      structurally unreachable regardless of read permission.
// Primary instances (admin, scheduler — no os_user) are trusted above the tenant
// boundary and skip this entirely.

/** Hard byte ceiling for a staged attachment — above any channel's file cap; an
 *  OOM/DoS backstop, not a product limit. */
export const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

/**
 * Resolve a unix username to a numeric uid via `id -u`, memoized for the process
 * lifetime (the caller→uid mapping is static). Returns null when the user does
 * not exist or the lookup fails. Callers treat null as fail-CLOSED (a send whose
 * owner cannot be proven is rejected), so — unlike a block-list — a resolution
 * failure never widens access. Negative results are NOT cached, so a transient
 * NSS/LDAP hiccup self-heals on the next send instead of sticking.
 *
 * @param {(cmd:string, args:string[], opts:object)=>string} [execFileFn] - injectable for tests
 * @param {(msg:string)=>void} [warn] - loud logger for resolution failures
 * @returns {(osUser:string)=>number|null}
 */
export function makeUidResolver(execFileFn = execFileSync, warn = null) {
  const cache = new Map();
  return function resolveUid(osUser) {
    if (!osUser || typeof osUser !== 'string') return null;
    if (cache.has(osUser)) return cache.get(osUser);
    let uid = null;
    try {
      const out = execFileFn('id', ['-u', osUser], { encoding: 'utf8', timeout: 2000 });
      const n = Number.parseInt(String(out).trim(), 10);
      if (Number.isInteger(n) && n >= 0) uid = n;
    } catch (err) {
      if (warn) { try { warn(`[egress-policy] uid resolve failed for ${osUser}: ${err && err.message}`); } catch { /* ignore */ } }
    }
    if (uid != null) cache.set(osUser, uid);   // cache successes only — negatives self-heal
    return uid;
  };
}

/**
 * Validate that `mediaPath` is a regular file OWNED BY `callerUid`, then copy its
 * bytes into a fresh broker-private staging file and return that path. Default-
 * deny: any file the caller does not own — peer-tenant homes, hub/service files
 * such as c4.db, root-owned logs — is rejected (`not_owned_by_caller`).
 *
 * TOCTOU-safe by construction: ownership is checked with `fstat` on the OPEN fd
 * (the inode is pinned — a symlink swap after the open cannot change what we
 * validated), and the bytes handed to send.js are the broker's own copy, so the
 * child never re-resolves the caller-mutable original path.
 *
 * @param {string} mediaPath - the [MEDIA:] path from the send content
 * @param {number|null} callerUid - resolved caller uid; null/non-int → fail closed
 * @param {string} stagingDir - broker-private (0700) staging root
 * @param {object} [deps] - injection seam for tests: { fs, randomName, maxBytes }
 * @returns {{ ok: true, stagingPath: string, stagingSubdir: string, bytes: number }
 *          | { ok: false, error: string, owner?: number, size?: number }}
 */
export function stageOwnedMedia(mediaPath, callerUid, stagingDir, deps = {}) {
  const _fs = deps.fs || fs;
  const _randomName = deps.randomName || (() => randomUUID());
  const _max = deps.maxBytes || MAX_ATTACH_BYTES;
  if (!Number.isInteger(callerUid)) return { ok: false, error: 'caller_uid_unresolved' };
  let fd;
  try { fd = _fs.openSync(mediaPath, 'r'); }
  catch { return { ok: false, error: 'unreadable' }; }
  try {
    const st = _fs.fstatSync(fd);            // stat the OPENED inode — pinned, unswappable
    if (!st.isFile()) return { ok: false, error: 'not_regular_file' };
    if (st.uid !== callerUid) return { ok: false, error: 'not_owned_by_caller', owner: st.uid };
    if (st.size > _max) return { ok: false, error: 'too_large', size: st.size };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = _fs.readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    // per-send subdir → the ORIGINAL basename (the recipient's display name) is
    // preserved with no cross-send collision. Sanitization is Unicode-aware:
    // \p{L}\p{N} keeps CJK/accented letters (the recipient-visible name — an
    // ASCII-only \w turned 「外刊精读练习册-No08-威尼斯-高考版.pdf」 into
    // 「-No08--.pdf」) while still excluding path separators, control chars,
    // and shell-hostile punctuation. '.'/'..' can survive the char filter but
    // must never be used as a filename (join would escape the subdir).
    const subdir = path.join(stagingDir, _randomName());
    const rawBase = path.basename(mediaPath).replace(/[^\p{L}\p{N}._\- ]/gu, '_');
    const base = (!rawBase || rawBase === '.' || rawBase === '..') ? 'attachment' : rawBase;
    const stagingPath = path.join(subdir, base);
    // A write failure (ENOSPC/EROFS/EACCES on the staging tree) must NOT throw
    // out of here and leave an orphaned subdir + a 'delivered' audit row upstream
    // (rev crash-correctness MEDIUM). Clean up and fail-closed like any other
    // rejection; the caller maps this to a generic attachment_rejected reason.
    try {
      _fs.mkdirSync(subdir, { recursive: true, mode: 0o700 });
      _fs.writeFileSync(stagingPath, buf.subarray(0, read), { mode: 0o600 });
    } catch (err) {
      try { _fs.rmSync(subdir, { recursive: true, force: true }); } catch { /* nothing (or already) removed */ }
      return { ok: false, error: 'stage_failed' };
    }
    return { ok: true, stagingPath, stagingSubdir: subdir, bytes: read };
  } finally {
    try { _fs.closeSync(fd); } catch { /* already closed */ }
  }
}
