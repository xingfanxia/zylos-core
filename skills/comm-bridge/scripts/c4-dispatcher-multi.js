/**
 * C4 Dispatcher — Multi-session extension.
 *
 * Extracted routing, lifecycle, and orchestration logic for multi-session mode.
 * This module has ZERO imports from c4-dispatcher.js.  All dispatcher internals
 * are received via the `helpers` object (dependency injection), so the upstream
 * dispatcher can evolve independently.
 *
 * Imports:
 *  - instance-config.js for instance resolution (getAllInstances, getInstanceDef, etc.)
 *  - c4-config.js for legacy constants (TMUX_SESSION, AGENT_STATUS_FILE) as fallbacks
 *
 * ESM-only, Node 20+.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

import {
  getAllInstances,
  getInstanceDef,
  getMonitorDir,
  getSessionName,
  resolveStatusFile as icResolveStatusFile,
} from '../../multi-session/instance-config.js';

import {
  TMUX_SESSION,
  AGENT_STATUS_FILE,
} from './c4-config.js';

// ── Constants ──────────────────────────────────────────────────────────

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

/**
 * Maximum items to attempt per processWithMultiSession call before giving up.
 * Prevents unbounded looping when every claimed item is for an offline instance.
 */
const MAX_SKIP_ATTEMPTS = 10;

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle functions
// ─────────────────────────────────────────────────────────────────────────

/**
 * Write a wake-signal file so the Activity Monitor knows to restart a
 * suspended instance's Claude Code process.
 *
 * @param {string} instanceId - Target instance to wake.
 * @param {string} [zylosDir] - Override for ZYLOS_DIR (testing).
 */
export function writeWakeSignal(instanceId, zylosDir) {
  try {
    const monDir = getMonitorDir(instanceId);
    const dir = monDir || path.join(zylosDir || ZYLOS_DIR, 'activity-monitor', instanceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'wake-signal'), new Date().toISOString());
  } catch (err) {
    // Best-effort — log but do not throw.
    console.error(`[dispatcher-multi] Failed to write wake-signal for ${instanceId}: ${err.message}`);
  }
}

// ── Auto-start / auto-stop for instance sessions ──────────────────────

/** Tracks last delivery time per instance for idle reaping. */
const lastDeliveryAt = new Map();

/** Tracks auto-start timestamps to prevent requeue loops during CC boot. */
const autoStartedAt = new Map();

/** Grace period after auto-start before retrying delivery (CC needs time to boot). */
const AUTO_START_GRACE_MS = 60 * 1000;

/** Default idle timeout before auto-stopping a non-primary instance (30 min). */
const IDLE_REAP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Signal the Activity Monitor to start an instance session.
 *
 * The dispatcher does NOT launch CC directly — the AM's RuntimeAdapter
 * handles auth, env vars, cwd, bypass permissions, instruction files, etc.
 * We just write a wake-signal file that the AM picks up on its next tick.
 *
 * @param {object} instDef - Instance definition from instances.json.
 * @param {string} instDef.id
 * @returns {boolean} true if signal was written (AM should pick it up within 1-2s)
 */
export function requestInstanceStart(instDef) {
  if (!instDef?.id) return false;

  // Check if we already requested a start recently (grace period)
  const startedTs = autoStartedAt.get(instDef.id);
  if (startedTs && (Date.now() - startedTs) < AUTO_START_GRACE_MS) {
    return false; // already requested, waiting for boot
  }

  writeWakeSignal(instDef.id);
  autoStartedAt.set(instDef.id, Date.now());
  console.log(`[dispatcher-multi] Requested start for instance '${instDef.id}' via wake signal`);
  return true;
}

/**
 * Write a suspend signal for an idle non-primary instance.
 * The AM picks this up and gracefully stops CC + kills the tmux session.
 *
 * @param {string} instanceId
 */
export function requestInstanceStop(instanceId) {
  try {
    const monDir = getMonitorDir(instanceId);
    const dir = monDir || path.join(ZYLOS_DIR, 'activity-monitor', instanceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'suspend-signal'), new Date().toISOString());
    lastDeliveryAt.delete(instanceId);
    autoStartedAt.delete(instanceId);
    console.log(`[dispatcher-multi] Requested stop for idle instance '${instanceId}' via suspend signal`);
  } catch (err) {
    console.error(`[dispatcher-multi] Failed to write suspend signal for '${instanceId}': ${err.message}`);
  }
}

/**
 * Reap non-primary instances that haven't received a message in IDLE_REAP_TIMEOUT_MS.
 * Called once per dispatch cycle.
 */
export function reapIdleInstances() {
  const now = Date.now();
  for (const [instanceId, lastTs] of lastDeliveryAt) {
    if (now - lastTs < IDLE_REAP_TIMEOUT_MS) continue;

    const def = getInstanceDef(instanceId);
    if (!def || def.primary) continue; // never reap primary

    const session = def.tmux_session;
    if (!session) continue;

    requestInstanceStop(instanceId);
  }
}

/**
 * Scan all configured instances, read each one's status file, and return
 * the IDs of instances whose state is neither offline nor stopped.
 *
 * Returns `null` when no instances.json exists (single-session / legacy mode),
 * signalling the caller to fall back to legacy behaviour.
 *
 * @param {(statusFile: string) => { state: string }} getClaudeStateFn
 *   A function that reads an agent-status file and returns `{ state, ... }`.
 *   Injected to avoid importing from c4-dispatcher.js.
 * @returns {string[] | null}
 */
export function getOnlineInstanceIds(getClaudeStateFn) {
  const all = getAllInstances();
  if (all.length === 0) return null; // legacy mode

  const online = [];
  for (const inst of all) {
    const statusFile = icResolveStatusFile(inst.id);
    if (!statusFile) continue;
    const st = getClaudeStateFn(statusFile);
    if (st.state !== 'offline' && st.state !== 'stopped') {
      online.push(inst.id);
    }
  }
  return online;
}

// ─────────────────────────────────────────────────────────────────────────
// Resolution helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map an instance ID to its tmux session name.
 * Returns the legacy `TMUX_SESSION` when `targetInstance` is null / undefined
 * or when the instance has no configured session.
 *
 * @param {string | null | undefined} targetInstance
 * @returns {string}
 */
export function resolveSessionName(targetInstance) {
  if (!targetInstance) return TMUX_SESSION;
  const resolved = getSessionName(targetInstance);
  return resolved || TMUX_SESSION;
}

/**
 * Map an instance ID to its agent-status.json path.
 * Returns the legacy `AGENT_STATUS_FILE` when `targetInstance` is null /
 * undefined or when the instance has no configured status file.
 *
 * @param {string | null | undefined} targetInstance
 * @returns {string}
 */
export function resolveStatusFile(targetInstance) {
  if (!targetInstance) return AGENT_STATUS_FILE;
  const resolved = icResolveStatusFile(targetInstance);
  return resolved || AGENT_STATUS_FILE;
}

// ─────────────────────────────────────────────────────────────────────────
// Core routing — per-item dispatch decision
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DispatchDeliver
 * @property {'deliver'} action
 * @property {string} session    - tmux session name
 * @property {string} statusFile - agent-status.json path
 * @property {object} claudeState - result of getClaudeState(statusFile)
 */

/**
 * @typedef {Object} DispatchSkip
 * @property {'skip'} action
 * @property {string} reason
 */

/**
 * @typedef {Object} DispatchReject
 * @property {'reject'} action
 * @property {string} reason
 */

/**
 * @typedef {Object} DispatchRequeue
 * @property {'requeue'} action
 * @property {string} reason
 */

/** @typedef {DispatchDeliver | DispatchSkip | DispatchReject | DispatchRequeue} DispatchResult */

/**
 * Decide what to do with a single claimed queue item in multi-session mode.
 *
 * @param {object} item - Queue row (conversation or control), must include
 *   `target_instance`, `type`, `bypass_state`, `require_idle`, `content`.
 * @param {object} helpers
 * @param {(statusFile: string) => object} helpers.getClaudeState
 * @param {(statusFile: string) => boolean} helpers.isStatusFresh
 * @param {(item: object) => boolean} helpers.isBypassState
 * @returns {DispatchResult}
 */
export function multiSessionDispatch(item, helpers) {
  const { getClaudeState, isBypassState } = helpers;
  let targetInstance = item.target_instance || null;
  if (!targetInstance) {
    // Controls without target (heartbeats from adapter) → route to primary/default
    if (item.type === 'control') {
      const all = getAllInstances();
      const primary = all.find(i => i.primary === true) ?? all[0];
      if (primary) targetInstance = primary.id;
    }
    if (!targetInstance) {
      return { action: 'reject', reason: 'no target_instance (every message must be routed to an instance)' };
    }
  }
  const bypass = isBypassState(item);

  // 1. Disabled instance → reject (drop permanently).
  if (targetInstance) {
    const def = getInstanceDef(targetInstance);
    if (def && def.enabled === false) {
      return { action: 'reject', reason: `instance '${targetInstance}' is disabled` };
    }
  }

  const session = resolveSessionName(targetInstance);
  const statusFile = resolveStatusFile(targetInstance);
  const claudeState = getClaudeState(statusFile);

  // 2. Suspended instance → wake + requeue.
  if (claudeState.state === 'suspended' && targetInstance && !bypass) {
    writeWakeSignal(targetInstance);
    return { action: 'requeue', reason: `instance '${targetInstance}' is suspended — wake signal written` };
  }

  // 3. Offline / stopped → auto-start non-primary, skip primary.
  if ((claudeState.state === 'offline' || claudeState.state === 'stopped') && !bypass) {
    const def = targetInstance ? getInstanceDef(targetInstance) : null;
    if (def && !def.primary) {
      // Signal the AM to start this instance, then skip (message retried on next poll)
      requestInstanceStart({ ...def, id: targetInstance });
      return { action: 'skip', reason: `instance '${targetInstance}' offline, wake signal sent` };
    }
    return { action: 'skip', reason: `instance target offline (state=${claudeState.state})` };
  }

  // 5. Unhealthy → skip.
  if (claudeState.health !== 'ok' && !bypass) {
    return { action: 'skip', reason: `instance unhealthy (health=${claudeState.health})` };
  }

  // 6. Deliverable.
  return { action: 'deliver', session, statusFile, claudeState };
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator — replaces processNextMessage in multi-session mode
// ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProcessResult
 * @property {boolean} delivered - Whether a message was successfully delivered.
 * @property {string}  state    - Last observed agent state string.
 */

/**
 * Multi-session dispatch loop.  Claims items one at a time, runs
 * `multiSessionDispatch` for routing, and performs the full delivery pipeline
 * (heartbeat auto-ack shortcut, sendToTmux, mark delivered, idle settlement,
 * failure handling).
 *
 * Designed to be called from the upstream dispatcher's `processNextMessage()`
 * as a drop-in replacement when multi-session mode is active.
 *
 * @param {object} helpers — every dispatcher function needed, injected to
 *   avoid importing from c4-dispatcher.js:
 * @param {(statusFile: string) => object} helpers.getClaudeState
 * @param {(statusFile: string) => boolean} helpers.isStatusFresh
 * @param {(message: string, options?: object) => Promise<string>} helpers.sendToTmux
 * @param {() => Promise<{ verified: boolean, state: string }>} helpers.submitAndVerify
 * @param {(onlineIds?: string[] | null) => object | null} helpers.claimNextItem
 * @param {(item: object, reason?: string) => void} helpers.releaseItem
 * @param {(item: object) => boolean} helpers.isBypassState
 * @param {(opts: object) => boolean} helpers.shouldAutoAckHeartbeat
 * @param {(msg: object, statusFile?: string) => Promise<void>} helpers.handleConversationDeliveryFailure
 * @param {(control: object, reason: string) => Promise<void>} helpers.handleControlDeliveryFailure
 * @param {(msgId: number, statusFile?: string) => Promise<void>} helpers.waitForRequireIdleSettlement
 * @param {(id: number) => void} helpers.markDelivered
 * @param {(id: number) => void} helpers.ackControl
 * @param {() => object | null} helpers.readProcState
 * @param {() => boolean} helpers.isAgentConfirmedActive
 * @param {(message: string) => void} helpers.log
 * @param {(ms: number) => Promise<void>} helpers.sleep
 * @param {() => number} helpers.nowSeconds
 * @param {(instanceIds: string[]) => object | null} helpers.getNextPendingForInstances
 * @param {(instanceIds: string[]) => object[]} helpers.getPendingTargetInstancesNeedingWake
 * @param {(instanceIds: string[]) => object | null} helpers.getNextPendingControlForInstances
 * @param {(id: number) => void} helpers.markRejected
 * @param {(id: number) => void} helpers.markControlRejected
 * @returns {Promise<ProcessResult>}
 */
export async function processWithMultiSession(helpers) {
  const {
    getAgentState,
    isStatusFresh,
    sendToTmux,
    claimNextItem,
    releaseItem,
    isBypassState,
    shouldAutoAckHeartbeat,
    handleConversationDeliveryFailure,
    handleControlDeliveryFailure,
    waitForRequireIdleSettlement,
    markDelivered,
    ackControl,
    readProcState,
    isAgentConfirmedActive,
    log,
    sleep,
    nowSeconds,
    markRejected,
    markControlRejected,
    getNextPendingForInstances,
    getPendingTargetInstancesNeedingWake,
    getNextPendingControlForInstances,
  } = helpers;

  // Reap idle non-primary instances before processing.
  reapIdleInstances();


  // Compute online instance IDs.  Returns null in legacy mode — callers
  // should NOT invoke this function in legacy mode, but we handle it gracefully.
  const onlineIds = getOnlineInstanceIds(getAgentState);

  if (onlineIds === null) {
    // Fallback: caller should use the single-session processNextMessage instead.
    return { delivered: false, state: 'unknown' };
  }

  // Wake offline targets with pending inbound conversations before claiming
  // online-deliverable work. This avoids a deadlock where offline instances
  // never receive a wake signal because pending rows are filtered out of the
  // normal claim query until the instance is already online.
  const wakeCandidates = getPendingTargetInstancesNeedingWake
    ? getPendingTargetInstancesNeedingWake(onlineIds)
    : [];

  for (const candidate of wakeCandidates) {
    const targetInstance = candidate?.target_instance;
    if (!targetInstance) continue;

    const def = getInstanceDef(targetInstance);
    if (!def) {
      markRejected(candidate.oldest_id);
      log(`Rejected conversation id=${candidate.oldest_id}: unknown instance '${targetInstance}'`);
      continue;
    }

    if (def.enabled === false) {
      markRejected(candidate.oldest_id);
      log(`Rejected conversation id=${candidate.oldest_id}: instance '${targetInstance}' is disabled`);
      continue;
    }

    requestInstanceStart({ ...def, id: targetInstance });
  }

  // Skip-loop: try up to MAX_SKIP_ATTEMPTS items.
  for (let attempt = 0; attempt < MAX_SKIP_ATTEMPTS; attempt++) {
    const item = claimNextItem(onlineIds, { getNextPendingForInstances, getNextPendingControlForInstances });
    if (!item) {
      return { delivered: false, state: 'idle' };
    }

    const decision = multiSessionDispatch(item, { getClaudeState: getAgentState, isStatusFresh, isBypassState });

    // ── reject ──
    if (decision.action === 'reject') {
      if (item.type === 'control') {
        markControlRejected(item.id);
      } else {
        markRejected(item.id);
      }
      log(`Rejected ${item.type} id=${item.id}: ${decision.reason}`);
      continue;
    }

    // ── requeue ──
    if (decision.action === 'requeue') {
      releaseItem(item);
      log(`Requeued ${item.type} id=${item.id}: ${decision.reason}`);
      continue;
    }

    // ── skip ──
    if (decision.action === 'skip') {
      releaseItem(item);
      continue;
    }

    // ── deliver ──
    const { session, statusFile, claudeState } = decision;
    const bypass = isBypassState(item);

    // require_idle gate (must be idle with sufficient duration).
    // Continue the skip loop instead of returning — a non-idle target must not
    // block delivery of other items targeting different (idle) instances.
    if (item.require_idle === 1 && (claudeState.state !== 'idle' || claudeState.idleSeconds < 3)) {
      releaseItem(item);
      continue;
    }

    // Heartbeat auto-ack shortcut.
    if (bypass) {
      const procState = readProcState();
      const confirmed = isAgentConfirmedActive();
      if (shouldAutoAckHeartbeat({ item, agentState: claudeState, procState, confirmedActive: confirmed })) {
        ackControl(item.id);
        log(`Auto-acked heartbeat id=${item.id} for instance ${item.target_instance || 'default'}`);
        return { delivered: true, state: claudeState.state };
      }
    }

    // Actual tmux delivery.
    const targetInstance = item.target_instance || null;
    log(
      `Delivering ${item.type} id=${item.id}` +
      (item.type === 'control' ? ` priority=${item.priority}` : ` from ${item.channel}`) +
      (targetInstance ? ` -> ${targetInstance}` : '')
    );

    const deliveryContent = item.content || '';
    const result = await sendToTmux(deliveryContent, {
      session,
      strictVerify: item.type === 'conversation',
    });

    if (result === 'submitted') {
      if (item.type === 'conversation') {
        markDelivered(item.id);
        log(`Conversation id=${item.id} delivered`);
      } else {
        const hasAck = (item.content || '').includes('---- ack via:');
        if (hasAck) {
          log(`Control id=${item.id} submitted, waiting ack`);
        } else {
          ackControl(item.id);
          log(`Control id=${item.id} submitted (no-ack mode), marked done`);
        }
      }

      if (item.require_idle === 1) {
        await waitForRequireIdleSettlement(item.id, statusFile);
      }

      // Track delivery time for idle reaping; clear boot grace period.
      if (targetInstance) {
        lastDeliveryAt.set(targetInstance, Date.now());
        autoStartedAt.delete(targetInstance);
      }

      return { delivered: true, state: claudeState.state };
    }

    // Delivery failed.
    const reason = result === 'verify_failed' ? 'VERIFY_FAILED' : 'TMUX_PASTE_FAILED';
    log(`Failed to deliver ${item.type} id=${item.id} to tmux (${reason})`);

    if (item.type === 'control') {
      await handleControlDeliveryFailure(item, reason);
    } else {
      await handleConversationDeliveryFailure(item, statusFile);
    }

    return { delivered: false, state: claudeState.state };
  }

  // Exhausted skip attempts — all tried items were for offline/busy instances.
  return { delivered: false, state: 'skip_exhausted' };
}
