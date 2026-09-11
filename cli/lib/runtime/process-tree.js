/**
 * Process-tree utilities — single source of truth for "find the runtime process
 * under a tmux pane".
 *
 * WHY THIS EXISTS: os_user isolation launches the runtime as
 * `sudo -> sudo -> node -> claude`, so the actual runtime (claude/codex) is a
 * DESCENDANT of the tmux pane pid, not a direct child. Every place that used a
 * direct-child check (`pgrep -P <panePid>`) silently failed for isolated
 * instances — reporting them "not running" so the dispatcher never delivered
 * messages, and (in proc-sampler) sampling the sudo wrapper instead of the
 * runtime. This module walks the FULL subtree so all callers agree.
 *
 * ESM-only, Node 20+.
 */

import { execFileSync } from 'child_process';

const PS_TIMEOUT_MS = 3000;

/**
 * Snapshot the whole process table in one `ps -e` call.
 * @returns {{ childrenOf: Map<number, number[]>, infoOf: Map<number, {comm: string, args: string}> }}
 */
export function buildProcessTree() {
  const childrenOf = new Map();
  const infoOf = new Map();
  let out;
  try {
    out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    });
  } catch {
    return { childrenOf, infoOf };
  }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const ppid = Number.parseInt(m[2], 10);
    infoOf.set(pid, { comm: m[3], args: m[4] || '' });
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  return { childrenOf, infoOf };
}

/**
 * BFS the subtree rooted at `rootPid`; return the first descendant pid whose
 * process comm equals `pattern` (fallback: full command line contains it), else 0.
 *
 * @param {number} rootPid
 * @param {string} pattern - runtime process name, e.g. 'claude' | 'codex'
 * @param {{childrenOf: Map, infoOf: Map}} [tree] - reuse a snapshot; else built here
 * @returns {number} matching pid, or 0 when none
 */
export function findDescendantPid(rootPid, pattern, tree) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !pattern) return 0;
  const { childrenOf, infoOf } = tree || buildProcessTree();
  const queue = [...(childrenOf.get(rootPid) || [])];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = infoOf.get(pid);
    if (info && (info.comm === pattern || info.args.includes(pattern))) return pid;
    for (const child of (childrenOf.get(pid) || [])) queue.push(child);
  }
  return 0;
}

/**
 * True if the subtree rooted at `rootPid` contains a process matching `pattern`.
 * @param {number} rootPid
 * @param {string} pattern
 * @param {{childrenOf: Map, infoOf: Map}} [tree]
 * @returns {boolean}
 */
export function hasDescendantProcess(rootPid, pattern, tree) {
  return findDescendantPid(rootPid, pattern, tree) > 0;
}

/**
 * Resolve the runtime pid under a tmux pane pid: the pane process itself when it
 * IS the runtime (non-os_user launch, pane pid == runtime), otherwise the first
 * matching descendant (os_user nested `sudo -> sudo -> node -> claude`). Returns
 * 0 when no match. This is the canonical "which pid is the runtime for this
 * pane" helper — every runtime-detection site should use it.
 *
 * @param {number} panePid
 * @param {string} pattern - runtime process name, e.g. 'claude' | 'codex'
 * @param {{childrenOf: Map, infoOf: Map}} [tree]
 * @returns {number} runtime pid, or 0
 */
export function findRuntimePidUnderPane(panePid, pattern, tree) {
  if (!Number.isInteger(panePid) || panePid <= 0 || !pattern) return 0;
  const t = tree || buildProcessTree();
  const paneInfo = t.infoOf.get(panePid);
  if (paneInfo && (paneInfo.comm === pattern || paneInfo.args.includes(pattern))) return panePid;
  return findDescendantPid(panePid, pattern, t);
}
