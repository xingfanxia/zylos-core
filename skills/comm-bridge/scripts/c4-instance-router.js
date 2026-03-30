/**
 * C4 Instance Router — resolves endpoint IDs to instance IDs.
 *
 * Reads ~/zylos/instances.json (hot-reloaded via fs.watchFile) and exposes
 * helpers for multi-session routing. All functions gracefully handle missing
 * instances.json (legacy single-instance mode).
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAllInstances } from '../../multi-session/instance-config.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

let config = null;       // parsed instances.json or null
let lastMtime = 0;       // mtime of last successful load
let watcherActive = false;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) {
      config = null;
      lastMtime = 0;
      return;
    }
    const stat = fs.statSync(INSTANCES_FILE);
    if (stat.mtimeMs === lastMtime) return; // unchanged
    const raw = fs.readFileSync(INSTANCES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.instances === 'object') {
      config = parsed;
      lastMtime = stat.mtimeMs;
    }
  } catch (err) {
    // Best-effort: keep previous config (or null).
    console.error(`[C4-Router] Failed to load instances.json: ${err.message}`);
  }
}

function ensureWatcher() {
  if (watcherActive) return;
  watcherActive = true;
  try {
    fs.watchFile(INSTANCES_FILE, { interval: 5000 }, () => {
      loadConfig();
    });
  } catch {
    // If watchFile fails (e.g., file doesn't exist yet), that's fine.
    // loadConfig() is also called on every public function call.
    watcherActive = false;
  }
}

// Initial load only — watcher is started lazily by long-running processes (dispatcher, AM)
// to avoid keeping short-lived CLI processes alive (c4-control.js, c4-receive.js, tests).
loadConfig();

/**
 * Start the file watcher for hot-reload. Should only be called by long-running
 * processes (c4-dispatcher, activity-monitor), NOT by CLI scripts or tests.
 */
export function startWatcher() {
  ensureWatcher();
}

/**
 * Stop the file watcher. Used by tests and CLI scripts to allow clean exit.
 */
export function stopWatcher() {
  if (watcherActive) {
    fs.unwatchFile(INSTANCES_FILE);
    watcherActive = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an endpoint_id (e.g., "123456789|telegram") to an instance ID.
 *
 * 1. Extract chat_id (part before the first "|")
 * 2. Look up in routing table
 * 3. Fall back to default_instance
 * 4. Return null if no instances.json (legacy mode)
 *
 * @param {string} endpointId - The endpoint identifier
 * @returns {string|null} Instance ID, or null in legacy mode
 */
export function resolveInstance(endpointId) {
  loadConfig(); // ensure fresh
  if (!config) return null;

  if (endpointId && config.routing) {
    // Extract chat_id: the part before the first "|"
    const chatId = String(endpointId).split('|')[0];

    // Detect group chats and route to group instance
    const isGroup = isGroupEndpoint(chatId, endpointId);
    if (isGroup) {
      const groupInstance = getGroupInstance();
      if (groupInstance) return groupInstance.id;
    }

    if (chatId && config.routing[chatId]) {
      return config.routing[chatId];
    }

    // Also try the full endpoint_id as a routing key
    if (config.routing[endpointId]) {
      return config.routing[endpointId];
    }
  }

  // Step 2: Scan instances[*].chat_ids arrays for a match
  if (endpointId && config.instances) {
    const chatId = String(endpointId).split('|')[0];
    for (const [instanceId, instanceDef] of Object.entries(config.instances)) {
      if (Array.isArray(instanceDef.chat_ids)) {
        if (instanceDef.chat_ids.includes(chatId) || instanceDef.chat_ids.includes(endpointId)) {
          return instanceId;
        }
      }
    }
  }

  return config.default_instance || null;
}

/**
 * Get the tmux session name for an instance.
 *
 * @param {string} instanceId
 * @returns {string|null} tmux session name, or null if instance not found
 */
export function getSessionForInstance(instanceId) {
  loadConfig();
  if (!config) return null;

  const instance = config.instances?.[instanceId];
  if (!instance) return null;
  return instance.tmux_session || null;
}

/**
 * Get the agent-status.json path for an instance.
 *
 * @param {string} instanceId
 * @returns {string|null} Absolute path to agent-status.json, or null
 */
export function getStatusFileForInstance(instanceId) {
  loadConfig();
  if (!config) return null;

  const instance = config.instances?.[instanceId];
  if (!instance) return null;

  const stateDir = instance.state_dir
    ? instance.state_dir.replace(/^~/, os.homedir())
    : path.join(ZYLOS_DIR, 'activity-monitor', instanceId);

  return path.join(stateDir, 'agent-status.json');
}

/**
 * Get the CLAUDE_CONFIG_DIR path for an instance.
 *
 * @param {string} instanceId
 * @returns {string|null} Absolute path, or null if not configured
 */
export function getConfigDirForInstance(instanceId) {
  loadConfig();
  if (!config) return null;

  const instance = config.instances?.[instanceId];
  if (!instance) return null;

  if (!instance.config_dir) return null;
  return instance.config_dir.replace(/^~/, os.homedir());
}

/**
 * Get the default instance ID.
 *
 * @returns {string|null} Default instance ID, or null in legacy mode
 */
export function getDefaultInstance() {
  loadConfig();
  if (!config) return null;
  return config.default_instance || null;
}

/**
 * Get the scheduler instance ID (for system/scheduled task routing).
 * Falls back to default_instance if no dedicated scheduler is configured.
 *
 * @returns {string|null} Scheduler instance ID, or null in legacy mode
 */
export function getSchedulerInstance() {
  loadConfig();
  if (!config) return null;
  return config.scheduler_instance || config.default_instance || null;
}

/**
 * Check if multi-session mode is active.
 * Returns true only if instances.json exists AND has more than 1 instance.
 *
 * @returns {boolean}
 */
export function isMultiSession() {
  loadConfig();
  if (!config) return false;
  const instanceCount = Object.keys(config.instances || {}).length;
  return instanceCount > 1;
}

/**
 * Atomically update instances.json via write-to-temp-then-rename pattern.
 *
 * @param {function} mutator - Receives a deep clone of config, returns the updated config.
 */
export function updateInstancesConfig(mutator) {
  loadConfig(); // ensure fresh
  const input = config ? structuredClone(config) : null;
  const updated = mutator(input);
  if (!updated) return; // mutator declined the update
  const tmpPath = INSTANCES_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n');
  fs.renameSync(tmpPath, INSTANCES_FILE);
  config = updated; // update in-memory
  lastMtime = fs.statSync(INSTANCES_FILE).mtimeMs; // use actual filesystem mtime
}

/**
 * Get the type of an instance (e.g., "dedicated", "on_demand").
 * Returns "dedicated" as the default if not specified.
 *
 * @param {string} instanceId
 * @returns {string} Instance type string, or "dedicated" as default
 */
export function getInstanceType(instanceId) {
  loadConfig();
  if (!config) return 'dedicated';
  const instance = config.instances?.[instanceId];
  if (!instance) return 'dedicated';
  return instance.type || 'dedicated';
}

/**
 * Get all configured instance IDs.
 * Returns empty array in legacy mode (no instances.json).
 *
 * @returns {string[]} Array of instance IDs
 */
export function getAllInstanceIds() {
  loadConfig();
  if (!config || !config.instances) return [];
  return Object.keys(config.instances);
}

/**
 * Get the full instance definition object for a given instance ID.
 *
 * @param {string} instanceId
 * @returns {object|null} The instance definition, or null if not found
 */
export function getInstanceDef(instanceId) {
  loadConfig();
  if (!config) return null;
  return config.instances?.[instanceId] || null;
}

/**
 * Check if an endpoint is explicitly routed (appears in routing table or
 * any instance's chat_ids array). Returns false in legacy mode (no config).
 *
 * This distinguishes "routed to admin because it's admin's chat" from
 * "routed to admin because nothing else matched" (fallback to default_instance).
 *
 * @param {string} chatId - The chat ID (part before first "|")
 * @param {string} endpointId - The full endpoint identifier
 * @returns {boolean} true if the endpoint has an explicit routing entry
 */
export function isEndpointRouted(chatId, endpointId) {
  loadConfig();
  if (!config) return false;

  // Check routing table
  if (config.routing) {
    if (chatId && config.routing[chatId]) return true;
    if (endpointId && config.routing[endpointId]) return true;
  }

  // Check instance chat_ids arrays
  if (config.instances) {
    for (const instanceDef of Object.values(config.instances)) {
      if (Array.isArray(instanceDef.chat_ids)) {
        if (instanceDef.chat_ids.includes(chatId) || instanceDef.chat_ids.includes(endpointId)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Group chat routing helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether an endpoint represents a group chat.
 *
 * Heuristics:
 *  - Feishu/Lark: endpoint contains '|type:group' (oc_ prefix is NOT reliable —
 *    Feishu uses oc_ for both group and p2p DM chats)
 *  - Telegram: negative numeric chat_id indicates group/supergroup
 *
 * @param {string} chatId - The chat ID (part before first "|")
 * @param {string} endpointId - The full endpoint identifier
 * @returns {boolean}
 */
export function isGroupEndpoint(chatId, endpointId) {
  // Feishu: only |type:group is reliable (oc_ prefix used for both groups and DMs)
  if (endpointId.includes('|type:group')) return true;
  // Telegram: negative numeric chat_id = group/supergroup
  const num = Number(chatId);
  if (!isNaN(num) && num < 0) return true;
  return false;
}

/**
 * Find the first instance with type === 'group'.
 * Uses getAllInstances() from instance-config.js.
 *
 * @returns {{ id: string } & object | null}
 */
function getGroupInstance() {
  const instances = getAllInstances();
  return instances.find(inst => inst.type === 'group') || null;
}

