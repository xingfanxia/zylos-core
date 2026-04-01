/**
 * Multi-session instance identity and path resolution.
 *
 * Single source of truth for "who am I?" and "where are my files?" in
 * multi-session mode.  Every file that needs instance-aware paths imports
 * from here instead of duplicating resolution logic.
 *
 * Design:
 *  - TTL-based cache for instances.json (10 s, mtime-aware)
 *  - Graceful single-session fallback when instances.json is absent
 *  - All instanceId parameters default to getInstanceId() when omitted
 *  - ESM-only, Node 20+
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Core constants ──────────────────────────────────────────────────

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_PATH = path.join(ZYLOS_DIR, 'instances.json');
const CACHE_TTL_MS = 10_000;

// ── instances.json cache ────────────────────────────────────────────

/** @type {{ data: object | null, mtime: number, readAt: number }} */
let _cache = { data: null, mtime: 0, readAt: 0 };

/**
 * Read and cache instances.json.  Returns null when the file is absent
 * or unparseable (single-session / legacy mode).
 *
 * Re-parses only when the TTL has expired AND the file's mtime changed.
 * @returns {object | null}
 */
function _readInstances() {
  const now = Date.now();
  if (_cache.data !== null && now - _cache.readAt < CACHE_TTL_MS) {
    return _cache.data;
  }

  let stat;
  try {
    stat = fs.statSync(INSTANCES_PATH);
  } catch {
    // File doesn't exist — single-session mode.
    _cache = { data: null, mtime: 0, readAt: now };
    return null;
  }

  const mtimeMs = stat.mtimeMs;
  if (_cache.data !== null && mtimeMs === _cache.mtime) {
    // File unchanged — reuse cached parse.
    _cache.readAt = now;
    return _cache.data;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(INSTANCES_PATH, 'utf8'));
    _cache = { data: raw, mtime: mtimeMs, readAt: now };
    return raw;
  } catch {
    _cache = { data: null, mtime: 0, readAt: now };
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Current instance ID from the environment.
 * Returns null in legacy single-session mode.
 * @returns {string | null}
 */
export function getInstanceId() {
  return process.env.ZYLOS_INSTANCE_ID || null;
}

/**
 * Return the instance definition for `instanceId` from instances.json.
 * Returns null when instances.json is absent or the id is unknown.
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {object | null}
 */
export function getInstanceDef(instanceId) {
  const id = instanceId ?? getInstanceId();
  if (!id) return null;
  const config = _readInstances();
  return config?.instances?.[id] ?? null;
}

/**
 * Return all instance definitions from instances.json.
 * Returns an empty array when the file is absent.
 * @returns {Array<{ id: string } & object>}
 */
export function getAllInstances() {
  const config = _readInstances();
  if (!config?.instances) return [];
  return Object.entries(config.instances).map(([id, def]) => ({ id, ...def }));
}

/**
 * Absolute path to instances.json.
 * @returns {string}
 */
export function getInstancesFile() {
  return INSTANCES_PATH;
}

/**
 * Per-instance state directory (activity-monitor data, status files, etc.).
 *
 * Resolution order:
 *  1. `state_dir` from instance definition (~ expanded)
 *  2. `~/zylos/activity-monitor/<instanceId>` (convention)
 *  3. `~/zylos/activity-monitor/` (single-session fallback)
 *
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {string}
 */
export function getMonitorDir(instanceId) {
  const id = instanceId ?? getInstanceId();
  const inst = id ? getInstanceDef(id) : null;

  if (inst?.state_dir) {
    return inst.state_dir.replace(/^~/, os.homedir());
  }
  if (id) {
    return path.join(ZYLOS_DIR, 'activity-monitor', id);
  }
  return path.join(ZYLOS_DIR, 'activity-monitor');
}

/**
 * tmux session name for this instance.
 *
 * Resolution order:
 *  1. `tmux_session` from instance definition
 *  2. `claude-<instanceId>` (convention)
 *  3. Active runtime from config.json (single-session fallback)
 *
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {string}
 */
export function getSessionName(instanceId) {
  const id = instanceId ?? getInstanceId();
  const inst = id ? getInstanceDef(id) : null;

  if (inst?.tmux_session) return inst.tmux_session;
  if (id) return `claude-${id}`;

  // Single-session: read active runtime from config.json (matches c4-config.js logic)
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(ZYLOS_DIR, '.zylos', 'config.json'), 'utf8')
    );
    return cfg.runtime === 'codex' ? 'codex-main' : 'claude-main';
  } catch {
    return 'claude-main';
  }
}

/**
 * Absolute path to agent-status.json for an instance.
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {string}
 */
export function resolveStatusFile(instanceId) {
  return path.join(getMonitorDir(instanceId), 'agent-status.json');
}

/**
 * Absolute path to the .claude project directory for an instance
 * (used for conversation history).
 *
 * For non-default instances, looks for a `claude_config_dir` key in the
 * instance definition; falls back to ~/.claude.
 *
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {string}
 */
export function resolveConvDir(instanceId) {
  const id = instanceId ?? getInstanceId();
  const inst = id ? getInstanceDef(id) : null;

  let baseDir;
  if (inst?.claude_config_dir) {
    baseDir = inst.claude_config_dir.replace(/^~/, os.homedir());
  } else {
    baseDir = path.join(os.homedir(), '.claude');
  }

  const zylosPath = ZYLOS_DIR.replace(/\//g, '-');
  return path.join(baseDir, 'projects', zylosPath);
}

/**
 * Whether this instance is enabled.
 * Defaults to true when instances.json is absent or the flag is missing.
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {boolean}
 */
export function isInstanceEnabled(instanceId) {
  const id = instanceId ?? getInstanceId();
  if (!id) return true;
  const inst = getInstanceDef(id);
  if (!inst) return true;
  return inst.enabled !== false;
}

/**
 * Whether this instance is the primary.
 * Daily tasks (upgrade checks, memory commits) should only run on the primary.
 * Defaults to true in single-session mode.
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {boolean}
 */
export function isPrimary(instanceId) {
  const id = instanceId ?? getInstanceId();
  if (!id) return true;
  const inst = getInstanceDef(id);
  if (!inst) return true;
  return inst.primary === true;
}

/**
 * Return the instance definition with `default: true`.
 * Falls back to the first instance if none is explicitly marked.
 * Returns null when instances.json is absent.
 * @returns {{ id: string } & object | null}
 */
export function getDefaultInstance() {
  const all = getAllInstances();
  if (all.length === 0) return null;
  return all.find(i => i.default === true) ?? all[0];
}

/**
 * Ensure the per-instance working directory exists with correct symlinks.
 *
 * Creates `~/zylos/instances/<instanceId>/` and sets up symlinks to shared
 * resources (.claude, CLAUDE.md, AGENTS.md, .env, memory) so the runtime launches from an
 * isolated cwd while sharing auth, skills, config, and memory.
 *
 * Safe to call repeatedly — only creates missing dirs/links, updates stale ones.
 *
 * @param {string} instanceId
 * @returns {string} Absolute path to the instance working directory
 */
export function ensureInstanceCwd(instanceId) {
  if (!instanceId) throw new Error('ensureInstanceCwd: instanceId required');

  const instanceDir = path.join(ZYLOS_DIR, 'instances', instanceId);
  fs.mkdirSync(instanceDir, { recursive: true });

  const symlinks = [
    ['.claude', '../../.claude'],
    ['CLAUDE.md', '../../CLAUDE.md'],
    ['AGENTS.md', '../../AGENTS.md'],
    ['.env', '../../.env'],
    ['memory', '../../memory'],
  ];

  for (const [name, target] of symlinks) {
    const linkPath = path.join(instanceDir, name);
    try {
      const existing = fs.readlinkSync(linkPath);
      if (existing === target) continue; // already correct
      fs.unlinkSync(linkPath);
    } catch {
      // Doesn't exist or not a symlink — remove if it's a regular file/dir
      try { fs.unlinkSync(linkPath); } catch { /* fine */ }
    }
    try {
      fs.symlinkSync(target, linkPath);
    } catch { /* best effort */ }
  }

  return instanceDir;
}

/**
 * Resolve the working directory for an instance.
 *
 * Returns `~/zylos/instances/<instanceId>/` for multi-session mode,
 * or `ZYLOS_DIR` for single-session fallback.
 *
 * Does NOT create the directory — use ensureInstanceCwd() for that.
 *
 * @param {string} [instanceId] - defaults to getInstanceId()
 * @returns {string}
 */
export function getInstanceCwd(instanceId) {
  const id = instanceId ?? getInstanceId();
  if (!id) return ZYLOS_DIR;
  return path.join(ZYLOS_DIR, 'instances', id);
}

/**
 * Return the instance that should receive scheduled tasks.
 *
 * Resolution order:
 *  1. `scheduler_instance` key in instances.json root → that instance
 *  2. `default_instance` key in instances.json root → that instance
 *  3. getDefaultInstance() fallback
 *
 * @returns {{ id: string } & object | null}
 */
export function getSchedulerInstance() {
  const config = _readInstances();
  if (!config?.instances) return null;

  const targetId = config.scheduler_instance ?? config.default_instance;
  if (targetId && config.instances[targetId]) {
    return { id: targetId, ...config.instances[targetId] };
  }
  return getDefaultInstance();
}
