/**
 * Egress policy — shared source-tier detection for the src-egress-guard hook
 * (PreToolUse, client-side, belt-and-braces) and the C4 broker (server-side,
 * the structural enforcement point per ZY-ISO-2).
 *
 * Invariant enforced by both callers:
 *   FILES INSIDE SOURCE-TIER REPOS ARE NEVER SENT THROUGH CHAT CHANNELS.
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
import { execSync } from 'child_process';

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
  } catch { /* group absent — no source tier configured */ }
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
