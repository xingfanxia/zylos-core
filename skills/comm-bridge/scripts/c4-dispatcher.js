#!/usr/bin/env node
/**
 * C4 Communication Bridge - Dispatcher
 * Control queue has higher priority than conversations.
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { logDeliveryFailure, saveTmuxCapture } from './c4-diagnostic.js';
import { getSessionForInstance, getStatusFileForInstance, getDefaultInstance, getAllInstanceIds, getInstanceType, getInstanceDef, startWatcher } from './c4-instance-router.js';

// Start the file watcher for hot-reload (long-running process)
startWatcher();
import {
  getNextPending,
  getNextPendingForInstance,
  getNextPendingForInstances,
  claimConversation,
  requeueConversation,
  markDelivered,
  getPendingCount,
  getPendingControlCount,
  close,
  incrementRetryCount,
  markFailed,
  getNextPendingControl,
  claimControl,
  requeueControl,
  retryOrFailControl,
  ackControl,
  expireTimedOutControls,
  cleanupControlQueue,
  markRejected,
  markControlRejected
} from './c4-db.js';
import {
  POLL_INTERVAL_BASE,
  POLL_INTERVAL_MAX,
  DELIVERY_DELAY_BASE,
  DELIVERY_DELAY_PER_KB,
  DELIVERY_DELAY_MAX,
  MAX_RETRIES,
  RETRY_BASE_MS,
  CONTROL_MAX_RETRIES,
  CONTROL_RETENTION_DAYS,
  CONTROL_CLEANUP_INTERVAL_MS,
  ENTER_VERIFY_MAX_RETRIES,
  ENTER_VERIFY_WAIT_MS,
  REQUIRE_IDLE_MIN_SECONDS,
  REQUIRE_IDLE_POST_SEND_HOLD_MS,
  REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS,
  REQUIRE_IDLE_EXECUTION_POLL_MS,
  TMUX_SESSION,
  AGENT_STATUS_FILE,
  PROC_STATE_FILE,
  API_ACTIVITY_FILE,
  STALE_STATUS_THRESHOLD,
  TMUX_MISSING_WARN_THRESHOLD
} from './c4-config.js';

let isShuttingDown = false;
let pollInterval = POLL_INTERVAL_BASE;
let tmuxMissingChecks = 0;
let lastControlCleanupMs = 0;

// On-demand instance lifecycle tracking
// Maps instanceId -> epoch ms of last message delivery (or startup time)
const onDemandLastActivity = new Map();
const ON_DEMAND_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function readJsonFileWithRetry(filePath, attempts = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

/**
 * Write a wake-signal file for a suspended instance so the Activity Monitor
 * knows to restart Claude Code.
 *
 * @param {string} instanceId
 */
function writeWakeSignal(instanceId) {
  try {
    const statusFile = getStatusFileForInstance(instanceId);
    const stateDir = statusFile
      ? path.dirname(statusFile)
      : path.join(ZYLOS_DIR, 'activity-monitor', instanceId);

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'wake-signal'), new Date().toISOString());
  } catch (err) {
    log(`Warning: failed to write wake-signal for ${instanceId}: ${err.message}`);
  }
}

/**
 * Start an on_demand instance by creating a tmux session and launching Claude Code.
 *
 * @param {string} instanceId
 * @returns {boolean} true if started successfully
 */
function startOnDemandInstance(instanceId) {
  const def = getInstanceDef(instanceId);
  if (!def) {
    log(`Cannot start on_demand instance ${instanceId}: no instance definition found`);
    return false;
  }

  const tmuxSession = def.tmux_session;
  if (!tmuxSession) {
    log(`Cannot start on_demand instance ${instanceId}: no tmux_session configured`);
    return false;
  }

  // Check if tmux session already exists
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxSession], { stdio: 'pipe', timeout: 15000 });
    // Session already exists — treat as started
    log(`On-demand instance ${instanceId}: tmux session ${tmuxSession} already exists`);
    onDemandLastActivity.set(instanceId, Date.now());
    return true;
  } catch {
    // Session doesn't exist — create it
  }

  try {
    const configDir = def.config_dir
      ? def.config_dir.replace(/^~/, os.homedir())
      : null;

    // Build tmux args with environment variable via -e flag (avoids shell injection)
    const runtime = def.runtime || 'claude';
    const tmuxArgs = ['new-session', '-d', '-s', tmuxSession, '-x', '220', '-y', '50'];
    if (configDir) tmuxArgs.push('-e', `CLAUDE_CONFIG_DIR=${configDir}`);
    tmuxArgs.push(runtime);

    // Create a detached tmux session running Claude Code
    execFileSync('tmux', tmuxArgs, { stdio: 'pipe', timeout: 15000 });

    log(`Started on-demand instance ${instanceId} in tmux session ${tmuxSession}`);
    onDemandLastActivity.set(instanceId, Date.now());
    return true;
  } catch (err) {
    log(`Failed to start on-demand instance ${instanceId}: ${err.message}`);
    return false;
  }
}

/**
 * Stop an on_demand instance by killing its tmux session.
 *
 * @param {string} instanceId
 */
function stopOnDemandInstance(instanceId) {
  const def = getInstanceDef(instanceId);
  if (!def || !def.tmux_session) return;

  try {
    execFileSync('tmux', ['kill-session', '-t', def.tmux_session], { stdio: 'pipe', timeout: 15000 });
    log(`Stopped idle on-demand instance ${instanceId} (session ${def.tmux_session})`);
  } catch {
    // Session already gone — fine
  }
  onDemandLastActivity.delete(instanceId);
}

/**
 * Check all on_demand instances for idle timeout and stop idle ones.
 */
function reapIdleOnDemandInstances() {
  const now = Date.now();
  for (const [instanceId, lastActivityMs] of onDemandLastActivity) {
    if (getInstanceType(instanceId) !== 'on_demand') continue;
    if ((now - lastActivityMs) >= ON_DEMAND_IDLE_TIMEOUT_MS) {
      log(`On-demand instance ${instanceId} idle for ${Math.round((now - lastActivityMs) / 60000)}min, stopping`);
      stopOnDemandInstance(instanceId);
    }
  }
}

/**
 * Get the list of instance IDs that are currently online (status file is fresh
 * and state is not offline/stopped). Returns null in legacy mode (no instances.json).
 *
 * @returns {string[]|null}
 */
function getOnlineInstanceIds() {
  const allIds = getAllInstanceIds();
  if (allIds.length === 0) return null; // legacy mode

  const online = [];
  for (const id of allIds) {
    const statusFile = getStatusFileForInstance(id);
    if (!statusFile) continue;
    const state = getClaudeState(statusFile);
    if (state.state !== 'offline' && state.state !== 'stopped') {
      online.push(id);
    }
  }
  return online;
}

/**
 * Resolve the tmux session name for a given target_instance.
 * Returns the legacy TMUX_SESSION if target_instance is null or unresolvable.
 */
function resolveSessionName(targetInstance) {
  if (!targetInstance) return TMUX_SESSION;
  const resolved = getSessionForInstance(targetInstance);
  if (!resolved) {
    log(`Warning: instance '${targetInstance}' has no tmux_session, falling back to ${TMUX_SESSION}`);
  }
  return resolved || TMUX_SESSION;
}

/**
 * Resolve the agent-status.json path for a given target_instance.
 * Returns the legacy CLAUDE_STATUS_FILE if target_instance is null or unresolvable.
 */
function resolveStatusFile(targetInstance) {
  if (!targetInstance) return CLAUDE_STATUS_FILE;
  const resolved = getStatusFileForInstance(targetInstance);
  if (!resolved) {
    log(`Warning: instance '${targetInstance}' has no status file config, falling back to default`);
  }
  return resolved || CLAUDE_STATUS_FILE;
}

function getClaudeState(statusFile = CLAUDE_STATUS_FILE) {
  try {
    if (!existsSync(statusFile)) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'missing' };
    }

    const stats = statSync(statusFile);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > STALE_STATUS_THRESHOLD) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'stale' };
    }

    const status = readJsonFileWithRetry(statusFile);
    let state = status.state;

    if (!state && typeof status.idle_seconds === 'number') {
      state = status.idle_seconds >= 5 ? 'idle' : 'busy';
    }
    if (!state) {
      state = 'busy';
    }

    const health = typeof status.health === 'string' ? status.health : 'ok';
    const idleSeconds = typeof status.idle_seconds === 'number' ? status.idle_seconds : 0;
    return { state, health, healthy: true, idleSeconds };
  } catch (err) {
    log(`Warning: Error reading agent status (${err.message})`);
    // health is fail-open by design; state still degrades to offline on read failure.
    return { state: 'offline', health: 'ok', healthy: false, reason: 'error' };
  }
}

/**
 * Read proc-state.json written by the activity monitor's ProcSampler.
 * Returns { alive, frozen, ... } or null if unavailable/stale (>30s).
 */
function readProcState() {
  try {
    if (!existsSync(PROC_STATE_FILE)) return null;
    const data = readJsonFileWithRetry(PROC_STATE_FILE);
    const age = nowSeconds() - (data.lastSampleAt || 0);
    if (age > 30) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Check if agent is confirmed active: api-activity.json must show active_tools > 0
 * AND be fresh (updated within 60s). Prevents stale hook state from gating auto-ack.
 */
function isAgentConfirmedActive() {
  try {
    if (!existsSync(API_ACTIVITY_FILE)) return false;
    const data = readJsonFileWithRetry(API_ACTIVITY_FILE);
    const updatedAt = data?.updated_at ? Math.floor(data.updated_at / 1000) : 0;
    const age = nowSeconds() - updatedAt;
    return (data?.active_tools ?? 0) > 0 && age < 60;
  } catch {
    return false;
  }
}

function isStatusFresh(statusFile = CLAUDE_STATUS_FILE) {
  try {
    if (!existsSync(statusFile)) {
      return false;
    }
    const stats = statSync(statusFile);
    return (Date.now() - stats.mtimeMs) <= STALE_STATUS_THRESHOLD;
  } catch {
    return false;
  }
}

export function getHeartbeatPhase(content) {
  const match = String(content || '').match(/\[phase=([a-z-]+)\]/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive }) {
  const isHeartbeat = Boolean(item && (item.content || '').includes('Heartbeat check'));
  if (!isHeartbeat) return false;

  if (agentState?.healthy !== true) return false;

  const agentAlive = agentState?.state !== 'offline' && agentState?.state !== 'stopped';
  if (!agentAlive) return false;
  if (!procState || procState.alive !== true) return false;

  // Busy path: preserve the existing "confirmed active" behavior for live generation.
  if (confirmedActive) {
    return true;
  }

  // Idle path: only auto-ack the periodic primary probe. Recovery/stuck/down
  // probes must still be delivered end-to-end so the heartbeat engine can
  // observe real failures while the session is idle.
  return (
    getHeartbeatPhase(item.content) === 'primary' &&
    agentState?.health === 'ok' &&
    agentState?.state === 'idle' &&
    agentState?.idleSeconds >= REQUIRE_IDLE_MIN_SECONDS &&
    procState.frozen !== true
  );
}

export function sanitizeMessage(message) {
  return message.replace(/[\x00-\x08\x0B-\x1F]/g, '');
}

export function getDeliveryDelay(byteLength) {
  const extra = Math.floor(byteLength / 1024) * DELIVERY_DELAY_PER_KB;
  return Math.min(DELIVERY_DELAY_BASE + extra, DELIVERY_DELAY_MAX);
}

export function getInputBoxText(capture) {
  const lines = capture.split('\n');
  const separatorIndexes = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^\u2500+$/.test(lines[i]) && lines[i].length > 10) {
      separatorIndexes.push(i);
    }
  }

  if (separatorIndexes.length < 2) {
    const footerIndex = lines.findIndex(line => /tab to queue message/i.test(line));
    if (footerIndex === -1) {
      return null;
    }

    let promptIndex = -1;
    for (let i = footerIndex - 1; i >= 0; i--) {
      if (/^\s*[›❯](?:\s.*)?$/.test(lines[i])) {
        promptIndex = i;
        break;
      }
    }

    if (promptIndex === -1) {
      return null;
    }

    const promptText = [lines[promptIndex].replace(/^\s*[›❯]\s?/, '')];
    for (let i = promptIndex + 1; i < footerIndex; i++) {
      const line = lines[i];
      if (!line.trim()) break;
      if (/^\s*[›❯](?:\s.*)?$/.test(line)) break;
      promptText.push(line);
    }

    return promptText.join('\n').trimEnd();
  }

  const start = separatorIndexes[separatorIndexes.length - 2] + 1;
  const end = separatorIndexes[separatorIndexes.length - 1];
  return lines.slice(start, end).join('\n');
}

export function checkInputBox(capture) {
  const text = getInputBoxText(capture);
  if (text === null) {
    return 'indeterminate';
  }

  const stripped = text
    .replace(/\u276F/g, '')
    .replace(/[\p{C}\p{Z}]+/gu, '');

  if (stripped.length === 0) {
    return 'empty';
  }

  return 'has_content';
}

export function isUsageOverlayCapture(capture) {
  if (!capture) return false;
  const hasUsageHeader = /Settings:\s+Status\s+Config\s+Usage/i.test(capture);
  const hasEscHint = /Esc to cancel/i.test(capture);
  return hasUsageHeader && hasEscHint;
}

async function dismissGhostTextAndCapture(session = TMUX_SESSION) {
  execFileSync('tmux', ['send-keys', '-t', session, 'Space'], { stdio: 'pipe', timeout: 15000 });
  await sleep(100);

  const capture = execFileSync('tmux', ['capture-pane', '-p', '-t', session], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5000
  });

  execFileSync('tmux', ['send-keys', '-t', session, 'BSpace'], { stdio: 'pipe', timeout: 15000 });
  await sleep(100);
  return capture;
}

async function submitAndVerify(session = TMUX_SESSION) {
  execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'pipe', timeout: 15000 });
  let lastState = 'indeterminate';

  for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
    await sleep(ENTER_VERIFY_WAIT_MS);
    const capture = await dismissGhostTextAndCapture(session);
    const state = checkInputBox(capture);
    lastState = state;

    if (state === 'empty') {
      return { verified: true, state };
    }

    if (state === 'indeterminate') {
      log(`Enter verify attempt ${attempt + 1}: separator detection failed, retrying capture`);
      saveTmuxCapture(capture, `separator-fail-attempt-${attempt + 1}`);

      // If a /usage settings overlay is open in the main session, dismiss it so
      // pasted user messages can be submitted normally.
      if (isUsageOverlayCapture(capture)) {
        log(`Enter verify attempt ${attempt + 1}: /usage overlay detected, sending Escape`);
        execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Escape'], { stdio: 'pipe', timeout: 5000 });
      }
      continue;
    }

    log(`Enter verify attempt ${attempt + 1}: input box has content, retrying Enter`);
    execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'pipe', timeout: 15000 });
  }

  return { verified: false, state: lastState };
}

async function sendToTmux(message, options = {}) {
  const session = options.session || TMUX_SESSION;
  const strictVerify = options.strictVerify === true;
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
  const sanitized = sanitizeMessage(message);
  const delayMs = getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8'));

  try {
    execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], { stdio: 'pipe', timeout: 15000 });
    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', session], { stdio: 'pipe', timeout: 15000 });
  } catch (err) {
    log(`Error pasting to tmux: ${err.message}`);
    logDeliveryFailure('tmux_paste', 0, 'PASTE_ERROR', { error: err.message });
    return 'paste_error';
  } finally {
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe', timeout: 15000 });
    } catch {
      // Ignore buffer deletion errors.
    }
  }

  await sleep(delayMs);

  let verifyResult = { verified: false, state: 'indeterminate' };
  try {
    verifyResult = await submitAndVerify(session);
  } catch (err) {
    log(`Warning: Enter verification error: ${err.message}`);
  }

  // Conversation delivery must be strict: if we cannot verify submission,
  // retry instead of marking delivered to avoid false positives.
  if (!verifyResult.verified && strictVerify) {
    log(`Verification failed in strict mode (state=${verifyResult.state}) — marking as verify_failed`);
    return 'verify_failed';
  }

  // For non-conversation controls, preserve prior permissive behavior when the
  // process is confirmed alive (only hard-fail if process is dead/offline).
  if (!verifyResult.verified) {
    const procState = readProcState();
    const agentState = getAgentState();
    if ((procState && procState.alive === false) ||
        agentState.state === 'offline' || agentState.state === 'stopped') {
      log('Verification failed and agent is dead/offline — marking as verify_failed');
      return 'verify_failed';
    }
  }

  return 'submitted';
}

export function isBypassState(item) {
  return item.type === 'control' && item.bypass_state === 1;
}

function releaseItem(item, reason = null) {
  if (item.type === 'control') {
    requeueControl(item.id, reason);
    return;
  }
  requeueConversation(item.id);
}

function hasAckSuffix(content = '') {
  return content.includes('---- ack via:');
}

async function handleConversationDeliveryFailure(msg, statusFile = CLAUDE_STATUS_FILE) {
  const channelHealthy = isStatusFresh(statusFile);

  if (channelHealthy) {
    const currentCount = msg.retry_count || 0;
    const nextCount = currentCount + 1;
    incrementRetryCount(msg.id);

    if (nextCount >= MAX_RETRIES) {
      markFailed(msg.id);
      log(`FAILED: conversation id=${msg.id} channel=${msg.channel} marked as failed after ${nextCount} retries`);
      logDeliveryFailure('conversation', msg.id, 'MAX_RETRIES', { channel: msg.channel, retries: nextCount });
      return;
    }

    requeueConversation(msg.id);
    const backoff = RETRY_BASE_MS * 2 ** (nextCount - 1);
    log(`Retry ${nextCount} for conversation id=${msg.id} after ${backoff}ms`);
    await sleep(backoff);
    return;
  }

  requeueConversation(msg.id);
  log(`Channel unhealthy; backing off for ${RETRY_BASE_MS}ms`);
  await sleep(RETRY_BASE_MS);
}

async function handleControlDeliveryFailure(control, reason) {
  const transition = retryOrFailControl(control.id, reason, CONTROL_MAX_RETRIES);
  if (!transition) return;

  if (transition.status === 'failed') {
    log(`FAILED: control id=${control.id} marked as failed after ${transition.retry_count} retries (${reason})`);
    logDeliveryFailure('control', control.id, reason, { retries: transition.retry_count });
    return;
  }

  log(`Retry ${transition.retry_count} for control id=${control.id}`);
}

async function waitForRequireIdleSettlement(msgId, statusFile = CLAUDE_STATUS_FILE) {
  log(`require_idle item id=${msgId}: hold ${REQUIRE_IDLE_POST_SEND_HOLD_MS}ms before next dispatch`);
  await sleep(REQUIRE_IDLE_POST_SEND_HOLD_MS);

  let state = getClaudeState(statusFile).state;
  if (state === 'offline' || state === 'stopped') {
    log(`require_idle item id=${msgId}: agent state=${state}, continuing`);
    return;
  }

  if (state === 'idle') {
    log(`require_idle item id=${msgId}: agent remained idle after hold, continuing`);
    return;
  }

  const deadline = Date.now() + REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REQUIRE_IDLE_EXECUTION_POLL_MS);
    state = getClaudeState(statusFile).state;
    if (state === 'idle' || state === 'offline' || state === 'stopped') {
      log(`require_idle item id=${msgId}: settled with agent state=${state}`);
      return;
    }
  }

  log(`require_idle item id=${msgId}: timeout after ${REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS}ms, continuing`);
}

/**
 * Claim the next item from the queue.
 * @param {string[]|null} onlineInstanceIds - list of online instance IDs for per-instance filtering, or null for legacy mode
 */
function claimNextItem(onlineInstanceIds = null) {
  const current = nowSeconds();
  const control = getNextPendingControl(current, onlineInstanceIds);
  if (control) {
    if (claimControl(control.id)) {
      return { ...control, type: 'control' };
    }

    // Keep strict control priority: if a control row was observed but claim lost,
    // do not fall through to conversation in the same loop iteration.
    return null;
  }

  // In multi-session mode, filter conversations to messages for online instances only.
  // In legacy mode (onlineInstanceIds is null), fetch any pending message.
  const msg = onlineInstanceIds
    ? getNextPendingForInstances(onlineInstanceIds)
    : getNextPending();

  if (msg && claimConversation(msg.id)) {
    return { ...msg, type: 'conversation' };
  }

  return null;
}

function maybeCleanupControlQueue() {
  const nowMs = Date.now();
  if (lastControlCleanupMs !== 0 && (nowMs - lastControlCleanupMs) < CONTROL_CLEANUP_INTERVAL_MS) {
    return;
  }

  const cutoff = nowSeconds() - (CONTROL_RETENTION_DAYS * 24 * 60 * 60);
  const deleted = cleanupControlQueue(cutoff);
  if (deleted > 0) {
    log(`Control cleanup deleted ${deleted} final record(s)`);
  }
  lastControlCleanupMs = nowMs;
}

async function processNextMessage() {
  maybeCleanupControlQueue();
  const timedOut = expireTimedOutControls();
  if (timedOut > 0) {
    log(`Control timeout sweep marked ${timedOut} record(s) as timeout`);
  }

  // Reap idle on-demand instances periodically
  reapIdleOnDemandInstances();

  // Default state check — resolve correct status file in multi-session mode
  const defaultInstanceId = getDefaultInstance();
  const defaultStatusFile = defaultInstanceId
    ? (getStatusFileForInstance(defaultInstanceId) || CLAUDE_STATUS_FILE)
    : CLAUDE_STATUS_FILE;
  const defaultState = getClaudeState(defaultStatusFile);
  if (defaultState.state === 'offline' || defaultState.state === 'stopped') {
    tmuxMissingChecks += 1;
    if (tmuxMissingChecks === TMUX_MISSING_WARN_THRESHOLD) {
      log(`WARNING: Agent status stale/missing for ${TMUX_MISSING_WARN_THRESHOLD} consecutive checks`);
    }
  } else {
    tmuxMissingChecks = 0;
  }

  // Compute online instance IDs for per-instance filtering (Fix 1).
  // Returns null in legacy mode (no instances.json) — claimNextItem falls back to getNextPending.
  const onlineInstanceIds = getOnlineInstanceIds();

  // Try up to MAX_SKIP_ATTEMPTS items — skip messages whose target instance is
  // offline and try the next one instead of backing off the entire loop.
  const MAX_SKIP_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_SKIP_ATTEMPTS; attempt++) {
    const item = claimNextItem(onlineInstanceIds);
    if (!item) {
      return { delivered: false, state: defaultState.state };
    }

    // Resolve per-instance tmux session and status file
    const targetInstance = item.target_instance || null;

    // Disabled instance check: drop messages silently (do NOT reroute to admin)
    if (targetInstance) {
      const instDef = getInstanceDef(targetInstance);
      if (instDef && instDef.enabled === false) {
        if (item.type === 'control') {
          markControlRejected(item.id);
        } else {
          markRejected(item.id);
        }
        log(`Rejected ${item.type} id=${item.id} — target instance '${targetInstance}' is disabled`);
        continue;
      }
    }

    const targetSession = resolveSessionName(targetInstance);
    const targetStatusFile = resolveStatusFile(targetInstance);

    // Re-read state for the target instance (may differ from default)
    const claudeState = (targetInstance && targetStatusFile !== CLAUDE_STATUS_FILE)
      ? getClaudeState(targetStatusFile)
      : defaultState;

    const bypass = isBypassState(item);

    // On-demand instance startup (Fix 3): if the target is an on_demand instance
    // that's offline, attempt to start it before requeuing.
    if ((claudeState.state === 'offline' || claudeState.state === 'stopped') && !bypass && targetInstance) {
      if (getInstanceType(targetInstance) === 'on_demand') {
        const started = startOnDemandInstance(targetInstance);
        if (started) {
          // Requeue and let the next poll cycle pick it up once the instance is ready
          releaseItem(item);
          log(`On-demand instance ${targetInstance} started; requeued ${item.type} id=${item.id} for next cycle`);
          continue;
        }
      }
    }

    // Instance offline/stopped: requeue and skip to next item
    if ((claudeState.state === 'offline' || claudeState.state === 'stopped') && !bypass) {
      releaseItem(item);
      if (targetInstance) {
        // Multi-session: skip this item and try the next one
        continue;
      }
      return { delivered: false, state: claudeState.state };
    }

    // Suspended instance: write wake-signal so the AM can restart CC, then skip
    if (claudeState.state === 'suspended' && targetInstance && !bypass) {
      writeWakeSignal(targetInstance);
      releaseItem(item);
      log(`Instance ${targetInstance} is suspended; wrote wake-signal and requeued ${item.type} id=${item.id}`);
      continue;
    }

    if (claudeState.health !== 'ok' && !bypass) {
      releaseItem(item);
      return { delivered: false, state: claudeState.state };
    }

    if (item.require_idle === 1 && (claudeState.state !== 'idle' || claudeState.idleSeconds < REQUIRE_IDLE_MIN_SECONDS)) {
      releaseItem(item);
      return { delivered: false, state: claudeState.state };
    }

    // D1: heartbeat must not interrupt active generation.
    // Auto-ack supports two paths:
    //   1. It's a heartbeat (not other bypass controls like context rotation)
    //   2. Agent state is not offline/stopped (proc-state can be stale for ~30s after crash)
    //   3. /proc confirms process is alive (and idle path also requires not frozen)
    //   4. Either:
    //      - busy path: fresh hooks confirm active generation, or
    //      - idle path: health=ok and idle_seconds >= sustained-idle minimum
    if (bypass) {
      const procState = readProcState();
      const confirmed = isAgentConfirmedActive();
      if (shouldAutoAckHeartbeat({ item, agentState: claudeState, procState, confirmedActive: confirmed })) {
        const phase = getHeartbeatPhase(item.content);
        const reason = confirmed
          ? `phase=${phase} /proc alive + active_tools>0 fresh (delta=${procState.lastDelta})`
          : `phase=${phase} /proc alive + health=ok + idle_seconds=${claudeState.idleSeconds}`;
        log(`Auto-acking heartbeat id=${item.id}: ${reason}`);
        ackControl(item.id);
        return { delivered: true, state: claudeState.state };
      }
    }

    log(`Delivering ${item.type} id=${item.id}${item.type === 'control' ? ` priority=${item.priority}` : ` from ${item.channel}`}${targetInstance ? ` → ${targetInstance}` : ''}`);
    const deliveryContent = item.content || '';
    const result = await sendToTmux(deliveryContent, {
      session: targetSession,
      strictVerify: item.type === 'conversation'
    });

    if (result === 'submitted') {
      if (item.type === 'conversation') {
        markDelivered(item.id);
        log(`Conversation id=${item.id} delivered`);
      } else {
        log(`Control id=${item.id} submitted, waiting ack`);
      }

      // Track on-demand instance activity for idle timeout
      if (targetInstance && getInstanceType(targetInstance) === 'on_demand') {
        onDemandLastActivity.set(targetInstance, Date.now());
      }

      if (item.require_idle === 1) {
        await waitForRequireIdleSettlement(item.id, targetStatusFile);
      }
      return { delivered: true, state: claudeState.state };
    }

    log(`Failed to paste ${item.type} id=${item.id} to tmux`);
    logDeliveryFailure(item.type, item.id, 'TMUX_PASTE_FAILED');
    if (item.type === 'control') {
      await handleControlDeliveryFailure(item, 'TMUX_PASTE_FAILED');
    } else {
      await handleConversationDeliveryFailure(item, targetStatusFile);
    }
    return { delivered: false, state: claudeState.state };
  }

  // Exhausted skip attempts — all tried items had offline instances
  return { delivered: false, state: defaultState.state };
}

async function dispatcherLoop() {
  while (!isShuttingDown) {
    try {
      const { delivered, state } = await processNextMessage();

      if (delivered) {
        pollInterval = POLL_INTERVAL_BASE;
        await sleep(POLL_INTERVAL_BASE);
        continue;
      }

      if (state === 'idle') {
        pollInterval = Math.min(POLL_INTERVAL_MAX, pollInterval + POLL_INTERVAL_BASE);
      } else {
        pollInterval = POLL_INTERVAL_BASE;
      }

      await sleep(pollInterval);
    } catch (err) {
      log(`Dispatcher error: ${err.stack}`);
      await sleep(pollInterval);
    }
  }
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Shutting down...');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  log('=== C4 Dispatcher Started ===');
  log(`Tmux session: ${TMUX_SESSION}`);
  log(`Poll interval: ${POLL_INTERVAL_BASE}ms (adaptive up to ${POLL_INTERVAL_MAX}ms)`);

  const pendingControl = getPendingControlCount();
  const pendingConversation = getPendingCount();
  if (pendingControl > 0) {
    log(`Found ${pendingControl} pending control item(s)`);
  }
  if (pendingConversation > 0) {
    log(`Found ${pendingConversation} pending conversation message(s)`);
  }

  await dispatcherLoop();
  close();
  process.exit(0);
}

// PM2 sets argv[1] to its own ProcessContainerFork.js, so classic ESM
// isMainModule checks are unreliable here. Keep the default auto-start
// behavior, but allow tests to disable the live loop before import.
if (process.env.C4_DISPATCHER_DISABLE_MAIN !== '1') {
  main();
}
