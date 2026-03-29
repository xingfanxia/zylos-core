/**
 * Runtime Monitor
 * Monitors Claude's execution state and handles inter-process communication
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ZYLOS_DIR = process.env.ZYLOS_DIR || join(homedir(), 'zylos');
const INSTANCES_FILE = join(ZYLOS_DIR, 'instances.json');

/**
 * Resolve the status file path for the scheduler's target instance.
 * Falls back to the legacy single-instance path.
 */
function resolveStatusFilePath() {
  try {
    if (!existsSync(INSTANCES_FILE)) {
      return join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
    }
    const config = JSON.parse(readFileSync(INSTANCES_FILE, 'utf-8'));
    const targetId = config.scheduler_instance || config.default_instance;
    if (!targetId || !config.instances?.[targetId]) {
      return join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
    }
    const inst = config.instances[targetId];
    const stateDir = inst.state_dir
      ? inst.state_dir.replace(/^~/, homedir())
      : join(ZYLOS_DIR, 'activity-monitor', targetId);
    return join(stateDir, 'agent-status.json');
  } catch {
    return join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
  }
}

/**
 * Read agent status for the scheduler's target instance.
 * @returns {object|null} Status object or null if unavailable
 */
export function readStatusFile() {
  try {
    const statusFile = resolveStatusFilePath();
    if (!existsSync(statusFile)) return null;
    const content = readFileSync(statusFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * Find the c4-receive.js path, trying production location first, then development
 * @returns {string} Path to c4-receive.js
 */
function findC4ReceivePath() {
  // Method 1: Production location (priority for efficiency in deployed environment)
  const productionPath = join(homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
  if (existsSync(productionPath)) {
    return productionPath;
  }

  // Method 2: Development location (fallback for source tree testing)
  // Current file: .../skills/scheduler/scripts/runtime.js
  // Target file:  .../skills/comm-bridge/scripts/c4-receive.js
  const currentFile = fileURLToPath(import.meta.url);
  const skillsDir = join(dirname(currentFile), '..', '..');
  const devPath = join(skillsDir, 'comm-bridge', 'scripts', 'c4-receive.js');

  if (existsSync(devPath)) {
    return devPath;
  }

  // If both fail, return production path (will fail with clear error message)
  return productionPath;
}

/**
 * Send a message to Claude via C4 Communication Bridge
 * @param {string} message - Message to send
 * @param {object} options - Dispatch options
 * @param {number} options.priority - Message priority 1-3 (default: 3)
 * @param {boolean} options.requireIdle - Whether to wait for idle state (default: false)
 * @param {string} options.replyChannel - Reply channel (e.g., 'telegram')
 * @param {string} options.replyEndpoint - Reply endpoint (e.g., user ID)
 * @param {string} options.targetInstance - Target instance ID for multi-session routing
 * @returns {boolean} True if successful
 */
export function sendViaC4(message, options = {}) {
  const {
    priority = 3,
    requireIdle = false,
    replyChannel = null,
    replyEndpoint = null,
    targetInstance = null
  } = options;

  try {
    const c4ReceivePath = findC4ReceivePath();

    // Build c4-receive.js command arguments
    const args = [c4ReceivePath];

    // Source and reply configuration from task's reply settings
    if (replyChannel) {
      args.push('--channel', replyChannel);
      if (replyEndpoint) {
        args.push('--endpoint', replyEndpoint);
      }
    } else {
      args.push('--no-reply');
    }

    if (requireIdle) {
      args.push('--require-idle');
    }

    if (targetInstance) {
      args.push('--target-instance', targetInstance);
    }

    args.push('--priority', String(priority), '--content', message);

    // Use execFileSync to avoid shell injection - passes arguments directly
    execFileSync('node', args, { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch (error) {
    console.error('Failed to send via C4:', error.message);
    return false;
  }
}
