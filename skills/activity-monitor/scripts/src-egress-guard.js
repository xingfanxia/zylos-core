#!/usr/bin/env node
/**
 * Source Egress Guard -- PreToolUse hook that blocks exfiltration of
 * source-tier repos through outbound channel sends.
 *
 * Threat model: an instance with legitimate source access (the triage tier,
 * e.g. the group instance) is asked by an external chat user to send product
 * source files. Unix permissions cannot stop this confused-deputy path — the
 * agent has read access by design. This hook enforces a simple deterministic
 * invariant instead:
 *
 *   FILES INSIDE SOURCE-TIER REPOS ARE NEVER SENT THROUGH CHAT CHANNELS.
 *
 * Triage output is summaries and git commits, not raw files. The owner reads
 * source from the repo, not from a bot upload. No endpoint whitelisting — a
 * flat ban is simpler to reason about and immune to endpoint spoofing.
 *
 * Scope: applies to every instance that runs with ZYLOS_INSTANCE_ID set and
 * an os_user in instances.json (isolated tier, including the triage tier).
 * Admin-tier instances (no os_user) are exempt.
 *
 * Detection: Bash commands matching an outbound-send pattern
 * (send/upload channel scripts, curl form/upload flags) where any token
 * resolves to a path inside a source-tier repo. Source-tier repos are
 * discovered dynamically: workspace/<dir> owned by group `zylos-src`, plus
 * any workspace/<dir> that is mode-750 service-user-locked (defense in depth
 * for repos an instance shouldn't even read).
 *
 * Known residual (documented in docs/design/agent-os-isolation.md): message
 * TEXT egress (pasting code into a reply) and raw-API sends using channel
 * creds from the instance .env are not blocked here — the C4 broker milestone
 * (ZY-ISO-2) is the structural fix. This hook raises the bar for the common
 * path and for prompt-injection-driven exfil.
 *
 * Hook protocol: reads JSON from stdin; outputs
 * { "decision": "block", "reason": "..." } to block, or nothing to allow.
 * Fails open on internal errors (availability over strictness — the flows
 * this guards are already permission-limited elsewhere).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');
const WORKSPACE_DIR = path.join(ZYLOS_DIR, 'workspace');

const SEND_PATTERN = /\b(send-file|send-image|send-video|send-image-raw|send-file-raw|send-video-raw|upload|c4-send|drive-upload|curl\b[^\n]*(?:-F|--form|-T|--upload-file|--data-binary))\b/i;

/** Isolated tier = instance has an os_user in instances.json. */
function isIsolatedInstance() {
  if (!INSTANCE_ID) return false;
  try {
    const config = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    return Boolean(config?.instances?.[INSTANCE_ID]?.os_user);
  } catch {
    return false;
  }
}

/** Resolve source-tier repo roots (realpath'd) from workspace dir metadata. */
function sourceTierRoots() {
  const roots = [];
  let srcGid = null;
  try { srcGid = execSync('getent group zylos-src', { encoding: 'utf8', timeout: 2000 }).split(':')[2]; } catch { }
  let entries = [];
  try { entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true }); } catch { return roots; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(WORKSPACE_DIR, e.name);
    try {
      const st = fs.statSync(p);
      const mode = st.mode & 0o777;
      const isSrcGroup = srcGid !== null && String(st.gid) === String(srcGid).trim();
      const isServiceLocked = (mode & 0o007) === 0 && !isSrcGroup && (mode & 0o070) === 0;
      if (isSrcGroup || isServiceLocked) {
        try { roots.push(fs.realpathSync(p)); } catch { roots.push(p); }
      }
    } catch { /* unreadable entry — not our concern */ }
  }
  return roots;
}

/** Extract candidate filesystem paths from a shell command string. */
function candidatePaths(command) {
  const tokens = command.split(/[\s"'`;|&()<>]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (t.startsWith('-')) continue;
    if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.includes('/workspace/')) {
      out.push(t.replace(/^~\//, `${os.homedir()}/`));
    }
  }
  return out;
}

function findViolation(command) {
  if (!SEND_PATTERN.test(command)) return null;
  const roots = sourceTierRoots();
  if (roots.length === 0) return null;
  const rootNames = new Set(roots.map((r) => path.basename(r)));
  for (const cand of candidatePaths(command)) {
    let resolved = cand;
    try { resolved = fs.realpathSync(cand); } catch { /* keep literal — checks below */ }
    for (const root of roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) {
        return { path: resolved, root };
      }
    }
    // Textual fallback for paths realpath can't resolve from this process
    // (farm-dir symlinks, relative paths): any …/workspace/<src-repo>/ segment.
    const m = cand.match(/(?:^|\/)workspace\/([^/]+)/);
    if (m && rootNames.has(m[1])) {
      return { path: cand, root: m[1] };
    }
  }
  return null;
}

function main() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { return; }
  let payload;
  try { payload = JSON.parse(input); } catch { return; }

  if (payload?.tool_name !== 'Bash') return;
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return;
  if (!isIsolatedInstance()) return;

  const violation = findViolation(command);
  if (violation) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `src-egress-guard: files under source-tier repos are never sent through chat channels (${violation.path}). Triage output is summaries and git commits. If the owner needs an excerpt, they read the repo directly.`,
    }));
  }
}

try { main(); } catch { /* fail open */ }
