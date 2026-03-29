/**
 * Suspend Manager — auto-suspend and resume for idle instances.
 *
 * Imported by activity-monitor.js. Handles:
 * 1. Auto-suspend: when CC is idle for longer than idle_timeout_min, stop CC
 *    and set status to "suspended" (AM keeps running to detect wake events).
 * 2. Auto-resume: poll c4.db for pending messages targeting this instance;
 *    if found and CC is suspended, restart CC.
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

// Global activity-monitor directory — c4-receive writes pending-channels.jsonl here,
// not in the per-instance subdirectory.
const GLOBAL_AM_DIR = path.join(ZYLOS_DIR, 'activity-monitor');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Read suspend config for a given instance ID from instances.json.
 *
 * @param {string} instanceId
 * @returns {{ autoSuspend: boolean, idleTimeoutMin: number } | null}
 */
export function loadSuspendConfig(instanceId) {
  if (!instanceId) return null;
  try {
    if (!fs.existsSync(INSTANCES_FILE)) return null;
    const config = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    const inst = config?.instances?.[instanceId];
    if (!inst) return null;
    return {
      autoSuspend: inst.auto_suspend === true,
      idleTimeoutMin: inst.idle_timeout_min || 30,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suspend state
// ---------------------------------------------------------------------------

/**
 * Tracks suspend state between poll ticks.
 */
export class SuspendManager {
  /**
   * @param {object} deps - Injected dependencies
   * @param {function} deps.log - Logging function
   * @param {function} deps.killTmuxSession - Kill the tmux session
   * @param {function} deps.startClaude - Start CC
   * @param {function} deps.writeStatusFile - Write claude-status.json
   * @param {function} deps.isClaudeRunning - Check if CC is running
   * @param {function} deps.tmuxHasSession - Check if tmux session exists
   * @param {object} opts
   * @param {string} opts.instanceId - ZYLOS_INSTANCE_ID
   * @param {string} opts.monitorDir - State directory for this instance
   */
  constructor(deps, opts) {
    this.log = deps.log;
    this.killTmuxSession = deps.killTmuxSession;
    this.startClaude = deps.startClaude;
    this.writeStatusFile = deps.writeStatusFile;
    this.isClaudeRunning = deps.isClaudeRunning;
    this.tmuxHasSession = deps.tmuxHasSession;

    this.instanceId = opts.instanceId;
    this.monitorDir = opts.monitorDir;

    this._configCache = null;
    this._configLoadedAt = 0;

    // Restore suspend state from claude-status.json to survive AM restarts
    this.suspended = false;
    this.suspendedAt = 0;
    try {
      const statusPath = path.join(opts.monitorDir, 'claude-status.json');
      if (fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (status.state === 'suspended') {
          this.suspended = true;
          this.suspendedAt = status.suspended_at || 0;
        }
      }
    } catch { /* best-effort — default to not suspended */ }
  }

  /**
   * Reload suspend config every 30s to pick up changes.
   */
  _getConfig() {
    const now = Date.now();
    if (!this._configCache || now - this._configLoadedAt > 30000) {
      this._configCache = loadSuspendConfig(this.instanceId);
      this._configLoadedAt = now;
    }
    return this._configCache;
  }

  /**
   * Check if this instance is in suspended state.
   * @returns {boolean}
   */
  isSuspended() {
    return this.suspended;
  }

  /**
   * Called every tick from the monitor loop.
   *
   * @param {object} ctx - Current tick context
   * @param {number} ctx.currentTime - Unix timestamp (seconds)
   * @param {number} ctx.idleSeconds - How long CC has been idle
   * @param {boolean} ctx.claudeRunning - Whether CC is currently running
   * @param {string} ctx.currentTimeHuman - Human-readable timestamp
   */
  tick(ctx) {
    const cfg = this._getConfig();
    if (!cfg || !cfg.autoSuspend) return;

    if (this.suspended) {
      this._checkForWake(ctx);
    } else if (ctx.claudeRunning) {
      this._checkForSuspend(ctx, cfg);
    }
  }

  /**
   * Check if idle time exceeds threshold and suspend if so.
   */
  _checkForSuspend(ctx, cfg) {
    const idleThresholdSec = cfg.idleTimeoutMin * 60;
    if (ctx.idleSeconds < idleThresholdSec) return;

    this.log(`Suspend: Instance ${this.instanceId} idle for ${ctx.idleSeconds}s (threshold: ${idleThresholdSec}s), suspending...`);

    // Kill the tmux session (stops CC)
    this.killTmuxSession();

    // Write suspended status
    this.writeStatusFile({
      state: 'suspended',
      suspended_at: ctx.currentTime,
      last_check: ctx.currentTime,
      last_check_human: ctx.currentTimeHuman,
      idle_seconds: ctx.idleSeconds,
      message: `Auto-suspended after ${cfg.idleTimeoutMin} min idle`
    });

    this.suspended = true;
    this.suspendedAt = ctx.currentTime;
    this.log(`Suspend: Instance ${this.instanceId} suspended successfully.`);
  }

  /**
   * Check c4.db for pending messages targeting this instance.
   * If found, restart CC.
   */
  _checkForWake(ctx) {
    if (this._hasPendingMessages()) {
      this.log(`Suspend: Pending messages found for instance ${this.instanceId}, resuming...`);
      this.suspended = false;
      this.suspendedAt = 0;

      // startClaude will be called by the normal guardian flow (session not found → restart).
      // We just need to clear the suspended flag so the guardian doesn't skip it.
      this.log(`Suspend: Instance ${this.instanceId} marked for resume. Guardian will restart CC.`);
    }
  }

  /**
   * Check c4.db for pending messages that route to this instance.
   * Uses a simple file-based signal: check for pending-wake.signal in monitor dir.
   * The C4 dispatcher writes this signal when it routes a message to a suspended instance.
   *
   * Also checks for recent control queue entries as a fallback.
   */
  _hasPendingMessages() {
    // Signal file approach: C4 dispatcher writes this when it can't deliver to a suspended instance
    const signalFile = path.join(this.monitorDir, 'wake-signal');
    try {
      fs.unlinkSync(signalFile);
      return true; // signal was present
    } catch (e) {
      if (e.code === 'ENOENT') { /* no signal — fall through to pending check */ }
      else { return false; }
    }

    // Fallback: check pending-channels.jsonl for recent entries.
    // c4-receive writes to the global activity-monitor dir, not per-instance subdir.
    const pendingFile = path.join(GLOBAL_AM_DIR, 'pending-channels.jsonl');
    try {
      if (!fs.existsSync(pendingFile)) return false;
      const content = fs.readFileSync(pendingFile, 'utf8').trim();
      if (content.length > 0) {
        // Clear the file after reading to prevent stale entries from accumulating
        fs.writeFileSync(pendingFile, '');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
