#!/usr/bin/env node
/**
 * C4 Communication Bridge - Dispatcher
 * Control queue has higher priority than conversations.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import {
  readFileSync, existsSync, statSync,
  openSync as fsOpenSync, writeSync as fsWriteSync,
  closeSync as fsCloseSync, unlinkSync as fsUnlinkSync,
} from 'fs';
import net from 'net';
import { logDeliveryFailure, saveTmuxCapture } from './c4-diagnostic.js';
import {
  getNextPending,
  claimConversation,
  requeueConversation,
  resetOrphanedRunning,
  markDelivered,
  getPendingCount,
  getPendingControlCount,
  hasPendingRequireIdleControl,
  close,
  incrementRetryCount,
  markFailed,
  getNextPendingControl,
  claimControl,
  requeueControl,
  retryOrFailControl,
  ackControl,
  expireTimedOutControls,
  cleanupControlQueue
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
  ACTIVE_RUNTIME,
  TMUX_SESSION,
  DB_PATH,
  ACTIVITY_MONITOR_DIR,
  AGENT_STATUS_FILE,
  PROC_STATE_FILE,
  API_ACTIVITY_FILE,
  STALE_STATUS_THRESHOLD,
  TMUX_MISSING_WARN_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  WATCHDOG_MAX_TICK_MS,
} from './c4-config.js';
import {
  findPromptY as sharedFindPromptY,
  isUsageOverlayCapture as sharedIsUsageOverlayCapture,
  readTmuxInputState
} from './tmux-input-state.js';
import { buildReplyViaSuffix, hasLegacyReplyViaSuffix, truncateForDelivery } from './c4-utils.js';

let isShuttingDown = false;
let pollInterval = POLL_INTERVAL_BASE;
let tmuxMissingChecks = 0;
let lastControlCleanupMs = 0;
// Observability state (WS-A). lastHeartbeatMs=0 → the first tick emits a
// heartbeat immediately (a positive "alive" signal at startup), then every
// HEARTBEAT_INTERVAL_MS. lastTickCompletedAt drives the stuck-tick watchdog and
// is refreshed at the end of BOTH the success and error branches of the loop.
let lastHeartbeatMs = 0;
let lastTickCompletedAt = Date.now();

const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock');
const NOTIFY_DELIVERED_TIMEOUT_MS = 5000;
// How often the watchdog checks for a stuck tick. Well below WATCHDOG_MAX_TICK_MS
// so detection latency is bounded; internal implementation detail, not a tuning knob.
const WATCHDOG_CHECK_INTERVAL_MS = 30000;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function notifyMessageDelivered({ conversationId, channel, deliveredAt = Date.now(), socketPath = AM_SOCKET_PATH } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    function settle() {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    }

    socket.setTimeout(NOTIFY_DELIVERED_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        version: 1,
        type: 'notify_delivered',
        requestId: `dispatcher-${process.pid}-${deliveredAt}`,
        conversationId,
        channel,
        deliveredAt,
      })}\n`);
    });
    socket.on('data', () => {});
    socket.on('end', settle);
    socket.on('timeout', settle);
    socket.on('error', settle);
  });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ── Loop liveness decisions (WS-A) ─────────────────────────────────────────
// Extracted as pure functions with an injected `now` so the heartbeat/watchdog
// logic is unit-testable without driving the live dispatcher loop.

/** True when at least `intervalMs` has elapsed since the last heartbeat. */
export function shouldEmitHeartbeat(now, lastHeartbeat, intervalMs = HEARTBEAT_INTERVAL_MS) {
  return now - lastHeartbeat >= intervalMs;
}

/**
 * True only when a tick has been silent strictly LONGER than `maxTickMs`.
 * Strict `>` keeps a healthy long require_idle delivery (120s deadline + backoffs)
 * from being falsely killed; an alive-but-erroring loop still refreshes
 * lastTickCompletedAt each iteration, so it reads as healthy too (review LOW-7).
 */
export function isWatchdogExpired(now, lastTick, maxTickMs = WATCHDOG_MAX_TICK_MS) {
  return now - lastTick > maxTickMs;
}

/**
 * Render the periodic liveness line. Emitted unconditionally each interval, so a
 * gap in these lines means the loop is dead/hung — the exact signal missing
 * during the 6h04m silence. held/heldReasons default for legacy single-session
 * results that don't carry them.
 */
export function formatHeartbeatLine({ pendingConv, pendingControl, held = 0, heldReasons = {}, state }) {
  const breakdown = Object.entries(heldReasons).map(([k, v]) => `${k}:${v}`).join(',');
  return `dispatcher alive: ${pendingConv} pending-conv, ${pendingControl} pending-control, ` +
    `held=${held}${breakdown ? ` {${breakdown}}` : ''}, state=${state}`;
}

/** Read-only accessor for the watchdog clock (module-private state), for tests. */
export function getLastTickCompletedAt() {
  return lastTickCompletedAt;
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

function getAgentState(statusFile = AGENT_STATUS_FILE) {
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
function readProcState(statusFile = AGENT_STATUS_FILE) {
  try {
    const procFile = path.join(path.dirname(statusFile), 'proc-state.json');
    if (!existsSync(procFile)) return null;
    const data = readJsonFileWithRetry(procFile);
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
function isAgentConfirmedActive(statusFile = AGENT_STATUS_FILE) {
  try {
    const apiFile = path.join(path.dirname(statusFile), 'api-activity.json');
    if (!existsSync(apiFile)) return false;
    const data = readJsonFileWithRetry(apiFile);
    const updatedAt = data?.updated_at ? Math.floor(data.updated_at / 1000) : 0;
    const age = nowSeconds() - updatedAt;
    return (data?.active_tools ?? 0) > 0 && age < 60;
  } catch {
    return false;
  }
}

function isAgentStatusFresh(statusFile = AGENT_STATUS_FILE) {
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
  const match = String(content || '').match(/\[phase=([a-z_-]+)\]/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function isRecoveryHeartbeatPhase(phase) {
  return phase === 'recovery' || phase === 'post_restart';
}

export function shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive, requireIdleWaiting = false }) {
  const isHeartbeat = Boolean(item && (item.content || '').includes('Heartbeat check'));
  if (!isHeartbeat) return false;
  const phase = getHeartbeatPhase(item.content);

  // Recovery heartbeats are real runtime liveness probes. They must be
  // delivered end-to-end and explicitly acked by the runtime heartbeat control
  // rule, never by dispatcher auto-ack.
  if (isRecoveryHeartbeatPhase(phase)) return false;

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
  //
  // Starvation guard: when a require_idle control (e.g. /clear) is already
  // pending behind the sustained-idle threshold, delivering this heartbeat to
  // Claude would prompt a reply, reset the idle counter, and starve the
  // waiting control. In that case, auto-ack on any idle moment — the
  // require_idle check at the consumer side still enforces the threshold for
  // the actual /clear delivery.
  return (
    phase === 'primary' &&
    agentState?.health === 'ok' &&
    agentState?.state === 'idle' &&
    (requireIdleWaiting || agentState?.idleSeconds >= REQUIRE_IDLE_MIN_SECONDS) &&
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

export function getClaudeInputBoxText(capture) {
  const lines = capture.split('\n');

  const separatorIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\u2500{10,}/.test(lines[i])) {
      separatorIndexes.push(i);
    }
  }
  if (separatorIndexes.length < 2) {
    return null;
  }

  const start = separatorIndexes[separatorIndexes.length - 2] + 1;
  const end = separatorIndexes[separatorIndexes.length - 1];
  return lines.slice(start, end).join('\n');
}

/**
 * Find the Y coordinate (0-indexed line number) of the last prompt line
 * (starting with › or ❯) in a tmux capture string.
 * Returns -1 if no prompt line is found.
 */
export function findPromptY(capture) {
  return sharedFindPromptY(capture);
}

/**
 * Claude-only fallback parser.
 */
export function checkClaudeFallbackInputBox(capture) {
  const text = getClaudeInputBoxText(capture);
  if (text === null) {
    return 'indeterminate';
  }

  // Only inspect the first 10 chars to the right of the prompt symbol
  // to avoid buddy-art variants on the far right side.
  const firstLine = text.split('\n')[0] || '';
  const promptRight = firstLine.replace(/^\s*[›❯]/, '');
  const window = Array.from(promptRight).slice(0, 10).join('');
  const stripped = window.replace(/[\p{C}\p{Z}]+/gu, '');

  return stripped.length === 0 ? 'empty' : 'has_content';
}

/**
 * Cursor-based detector: primary signal for all runtimes.
 * Multi-session: session parameter defaults to TMUX_SESSION but per-instance dispatch passes the instance session.
 */
export function checkInputBoxByCursor(session = TMUX_SESSION) {
  return readTmuxInputState({ sessionName: session }).inputState;
}

export function runtimeForSession(session = TMUX_SESSION) {
  try {
    const config = JSON.parse(readFileSync(path.join(path.dirname(ACTIVITY_MONITOR_DIR), 'instances.json'), 'utf8'));
    for (const [id, inst] of Object.entries(config.instances || {})) {
      if ((inst.tmux_session || `${inst.runtime || ACTIVE_RUNTIME}-${id}`) !== session) continue;
      return config.runtime_profiles?.[inst.runtime_profile]?.runtime || inst.runtime || ACTIVE_RUNTIME;
    }
  } catch { /* single-session installation */ }
  return ACTIVE_RUNTIME;
}

function deliveryInputState(session, runtime, execFileSyncImpl = execFileSync) {
  const state = readTmuxInputState({ sessionName: session, execFileSyncImpl });
  if (runtime === 'claude' && state.inputState === 'has_content') {
    const fallback = checkClaudeFallbackInputBox(state.capture);
    if (fallback !== 'indeterminate') return { ...state, inputState: fallback };
  }
  return state;
}

export function checkInputBox(session = TMUX_SESSION) {
  return deliveryInputState(session, runtimeForSession(session)).inputState;
}

export function isUsageOverlayCapture(capture) {
  return sharedIsUsageOverlayCapture(capture);
}

export function getCursorX(session = TMUX_SESSION) {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', session, '#{cursor_x}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

export function getCursorY(session = TMUX_SESSION) {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', session, '#{cursor_y}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

// A failed observation leaves ownership with the same delivery. Its retry
// resumes verification/Enter, never pastes a second copy into the composer.
const pendingSubmissions = new Map();
// Receipts exist only for reconciled/retired ambiguous deliveries, keyed by C4
// row identity. A later retry cannot replay their old payload into a new pane.
const submissionReceipts = new Map();

export function retireSubmission(deliveryId, { pendingSubmissions: submissions = pendingSubmissions,
  submissionReceipts: receipts = submissionReceipts } = {}) {
  for (const [session, pending] of submissions) {
    if (pending.deliveryId === deliveryId) {
      pending.terminal = true;
      receipts.set(`${session}\0${deliveryId}`, 'verify_failed');
    }
  }
}

function wasReplaced(pending, state) {
  return !!(pending.paneIdentity && state.paneIdentity && pending.paneIdentity !== state.paneIdentity);
}

function replacementResult(pending) {
  return { verified: !!(pending.shutdown && pending.observed && pending.enterSent), state: 'replaced' };
}

export async function submitAndVerify(session, {
  pending, readState, execFileSyncImpl = execFileSync, sleepImpl = sleep, logImpl = log,
} = {}) {
  const enter = () => execFileSyncImpl('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'pipe', timeout: 5000 });
  if (!pending.observed) {
    // Native bracketed paste is asynchronous. An old empty frame cannot prove
    // that the newly pasted message was consumed. Observe its populated
    // composer before sending Enter and before accepting a later empty frame.
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = readState();
      if (wasReplaced(pending, state)) return replacementResult(pending);
      if (state.inputState === 'has_content' && !state.usageOverlay) {
        pending.observed = true;
        break;
      }
      await sleepImpl(250);
    }
    if (!pending.observed) return { verified: false, state: 'paste_unobserved' };
  }
  if (!pending.enterSent) {
    enter();
    pending.enterSent = true;
  }
  for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
    await sleepImpl(ENTER_VERIFY_WAIT_MS);
    const state = readState();
    if (wasReplaced(pending, state)) return replacementResult(pending);
    if (state.inputState === 'empty') return { verified: true, state: 'empty' };
    // A working model must never receive repeated Enter, nor an Escape that
    // could interrupt it. Keep the delivery pending until its composer clears.
    if (state.inProgressCapture) return { verified: false, state: 'working' };
    if (state.inputState === 'has_content' && !state.usageOverlay) {
      logImpl(`Enter verify attempt ${attempt + 1}: owned input remains, retrying Enter`);
      enter();
    }
  }
  return { verified: false, state: 'indeterminate' };
}

async function sendToTmux(message, options = {}) {
  const session = options.session || TMUX_SESSION;
  const runtime = options.runtime || runtimeForSession(session);
  const exec = options.execFileSyncImpl || execFileSync;
  const wait = options.sleepImpl || sleep;
  const readState = options.readInputStateImpl || (() => deliveryInputState(session, runtime, exec));
  const submissions = options.pendingSubmissions || pendingSubmissions;
  const receipts = options.submissionReceipts || submissionReceipts;
  const statusFile = options.statusFile || AGENT_STATUS_FILE;
  const sanitized = sanitizeMessage(message);
  const deliveryId = options.deliveryId || sanitized;
  const receiptKey = `${session}\0${deliveryId}`;
  if (receipts.has(receiptKey)) return receipts.get(receiptKey);
  let pending = submissions.get(session);
  let initial = readState();
  if (pending && wasReplaced(pending, initial)) {
    const consumed = replacementResult(pending).verified;
    receipts.set(`${session}\0${pending.deliveryId}`, consumed ? 'submitted' : 'verify_failed');
    submissions.delete(session);
    pending = null;
    if (receipts.has(receiptKey)) return receipts.get(receiptKey);
  }
  if (pending && pending.deliveryId !== deliveryId) {
    // The old row may have exhausted retries or been manually submitted. Only
    // confirmed empty input releases it; occupied text is never cleared.
    if (initial.inputState !== 'empty' || (!pending.terminal && !(pending.observed && pending.enterSent))) return 'verify_failed';
    await wait(100);
    const confirmed = readState();
    if (confirmed.inputState !== 'empty' || confirmed.paneIdentity !== initial.paneIdentity) return 'verify_failed';
    receipts.set(`${session}\0${pending.deliveryId}`, pending.terminal ? 'verify_failed' : 'submitted');
    submissions.delete(session);
    pending = null;
    initial = confirmed;
  }
  if (pending && initial.inputState === 'has_content' && !initial.usageOverlay) pending.observed = true;
  if (!pending) {
    if (initial.inputState !== 'empty' || initial.usageOverlay) return 'verify_failed';
    const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
    try {
      exec('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], { stdio: 'pipe', timeout: 5000 });
      // -p uses the native bracketed-paste protocol; -r preserves newlines.
      // Without these, tmux changes LF to Enter and Codex's paste-burst parser
      // may split one message into several inputs or swallow the submit key.
      exec('tmux', ['paste-buffer', '-p', '-r', '-b', bufferName, '-t', session], { stdio: 'pipe', timeout: 5000 });
      pending = { deliveryId, message: sanitized, paneIdentity: initial.paneIdentity,
        observed: false, enterSent: false, terminal: false,
        shutdown: options.acceptShutdownAfterSubmit || (runtime === 'codex' && sanitized.trim() === '/exit') };
      submissions.set(session, pending);
    } catch (err) {
      log(`Error pasting to tmux: ${err.message}`);
      logDeliveryFailure('tmux_paste', 0, 'PASTE_ERROR', { error: err.message });
      return 'paste_error';
    } finally {
      try { exec('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe', timeout: 5000 }); }
      catch { /* private buffer may already be gone */ }
    }
    await wait(getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8')));
  }
  let result = { verified: false, state: 'indeterminate' };
  try { result = await submitAndVerify(session, { pending, readState, execFileSyncImpl: exec, sleepImpl: wait }); }
  catch (err) { log(`Warning: Enter verification error: ${err.message}`); }
  if (result.verified) {
    submissions.delete(session);
    if (result.state === 'replaced') receipts.set(receiptKey, 'submitted');
    return 'submitted';
  }
  if (result.state === 'replaced') {
    submissions.delete(session);
    receipts.set(receiptKey, 'verify_failed');
    return 'verify_failed';
  }
  // /exit intentionally removes the UI after its observed submit. Every other
  // control needs the same submission proof as a conversation; process liveness
  // alone cannot establish that a pasted message reached the model.
  if (pending.observed && pending.enterSent && pending.shutdown) {
    const proc = readProcState(statusFile);
    const state = getAgentState(statusFile);
    if (proc?.alive === false || state.state === 'offline' || state.state === 'stopped') {
      submissions.delete(session);
      receipts.set(receiptKey, 'submitted');
      return 'submitted';
    }
  }
  log(`Submission remains unverified (state=${result.state}); retaining pasted input for retry`);
  return 'verify_failed';
}

export function isBypassState(item) {
  return item.type === 'control' && item.bypass_state === 1;
}

export function isKeystrokeControl(item) {
  return item.type === 'control' && (item.content || '').startsWith('[KEYSTROKE]');
}

export function parseKeystrokeKey(content) {
  return (content || '').slice('[KEYSTROKE]'.length).trim();
}

/**
 * Send a raw key to a tmux session (no buffer paste, no verify). Used for
 * [KEYSTROKE] controls (auto-approve Enter, watchdog interrupts). Injected into
 * the multi-session path so per-instance sessions get real keypresses too.
 * @param {string} session - tmux session name
 * @param {string} key - tmux send-keys key name (e.g. 'Enter', 'Escape')
 */
export function sendKeystroke(session, key) {
  execFileSync('tmux', ['send-keys', '-t', session, key], { stdio: 'pipe', timeout: 5000 });
}

export function isCodexExitLifecycleControl(item, activeRuntime = ACTIVE_RUNTIME) {
  return item.type === 'control' && activeRuntime === 'codex' && item.content === '/exit';
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

export function getDeliveryContent(item) {
  const rawContent = item.content || '';
  if (item.type === 'conversation') {
    const replyViaSuffix = (
      item.endpoint_id &&
      !hasLegacyReplyViaSuffix(rawContent)
    ) ? buildReplyViaSuffix(item.channel, item.endpoint_id) : '';
    return truncateForDelivery(rawContent, replyViaSuffix, item.id);
  }

  const isSlashCommand = rawContent.startsWith('/');
  return (item.type === 'control' && !isSlashCommand) ? `Meanwhile, ${rawContent}` : rawContent;
}

async function handleConversationDeliveryFailure(msg, statusFile = AGENT_STATUS_FILE) {
  const channelHealthy = isAgentStatusFresh(statusFile);

  if (channelHealthy) {
    const currentCount = msg.retry_count || 0;
    const nextCount = currentCount + 1;
    incrementRetryCount(msg.id);

    if (nextCount >= MAX_RETRIES) {
      markFailed(msg.id);
      retireSubmission(`conversation:${msg.id}`);
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
    retireSubmission(`control:${control.id}`);
    log(`FAILED: control id=${control.id} marked as failed after ${transition.retry_count} retries (${reason})`);
    logDeliveryFailure('control', control.id, reason, { retries: transition.retry_count });
    return;
  }

  log(`Retry ${transition.retry_count} for control id=${control.id}`);
}

async function waitForRequireIdleSettlement(msgId, statusFile = AGENT_STATUS_FILE) {
  log(`block_queue_until_idle item id=${msgId}: hold ${REQUIRE_IDLE_POST_SEND_HOLD_MS}ms before next dispatch`);
  await sleep(REQUIRE_IDLE_POST_SEND_HOLD_MS);

  let state = getAgentState(statusFile).state;
  if (state === 'offline' || state === 'stopped') {
    log(`block_queue_until_idle item id=${msgId}: agent state=${state}, continuing`);
    return;
  }

  if (state === 'idle') {
    log(`block_queue_until_idle item id=${msgId}: agent remained idle after hold, continuing`);
    return;
  }

  const deadline = Date.now() + REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REQUIRE_IDLE_EXECUTION_POLL_MS);
    state = getAgentState(statusFile).state;
    if (state === 'idle' || state === 'offline' || state === 'stopped') {
      log(`block_queue_until_idle item id=${msgId}: settled with agent state=${state}`);
      return;
    }
  }

  log(`block_queue_until_idle item id=${msgId}: timeout after ${REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS}ms, continuing`);
}

function claimNextItem(onlineInstanceIds = null, { getNextPendingForInstances, getNextPendingControlForInstances } = {}) {
  const current = nowSeconds();

  // When multi-session provides instance IDs, use instance-filtered queries.
  if (onlineInstanceIds !== null && getNextPendingControlForInstances && getNextPendingForInstances) {
    const control = getNextPendingControlForInstances(current, onlineInstanceIds);
    if (control) {
      if (claimControl(control.id)) {
        return { ...control, type: 'control' };
      }
      return null;
    }

    const msg = getNextPendingForInstances(onlineInstanceIds);
    if (msg && claimConversation(msg.id)) {
      return { ...msg, type: 'conversation' };
    }

    return null;
  }

  const control = getNextPendingControl(current);
  if (control) {
    if (claimControl(control.id)) {
      return { ...control, type: 'control' };
    }

    // Keep strict control priority: if a control row was observed but claim lost,
    // do not fall through to conversation in the same loop iteration.
    return null;
  }

  const msg = getNextPending();
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
  // Control maintenance sweeps run in BOTH modes. They used to sit below the
  // multi-session hook (which returns early), so in multi-session deployments
  // control timeouts never fired and control_queue retention never ran.
  maybeCleanupControlQueue();
  const timedOut = expireTimedOutControls();
  if (timedOut > 0) {
    log(`Control timeout sweep marked ${timedOut} record(s) as timeout`);
  }

  // Multi-session dispatch hook. Module-load failure (modules absent) falls
  // through to single-session; a RUNTIME error inside multi-session dispatch
  // must NOT — falling through would paste instance-targeted messages into the
  // default primary pane (cross-instance mis-delivery). Legacy mode (no
  // instances.json) is signalled via `legacy: true` and falls through cleanly.
  let multi = null;
  try {
    const { processWithMultiSession } = await import('./c4-dispatcher-multi.js');
    const {
      getNextPendingForInstances,
      getPendingTargetInstancesNeedingWake,
      getNextPendingControlForInstances,
      markRejected,
      markControlRejected
    } = await import('./c4-db-multi.js');
    multi = {
      processWithMultiSession,
      getNextPendingForInstances,
      getPendingTargetInstancesNeedingWake,
      getNextPendingControlForInstances,
      markRejected,
      markControlRejected,
    };
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') log(`Multi-session module load error: ${e.message}`);
    // Fall through to single-session logic below
  }

  if (multi) {
    try {
      const result = await multi.processWithMultiSession({
        getAgentState, isAgentStatusFresh, sendToTmux, claimNextItem,
        releaseItem, isBypassState, shouldAutoAckHeartbeat,
        handleConversationDeliveryFailure, handleControlDeliveryFailure,
        waitForRequireIdleSettlement, readProcState, isAgentConfirmedActive,
        markDelivered, ackControl, log, sleep, nowSeconds, getDeliveryContent,
        sendKeystroke, isKeystrokeControl, parseKeystrokeKey,
        getNextPendingForInstances: multi.getNextPendingForInstances,
        getPendingTargetInstancesNeedingWake: multi.getPendingTargetInstancesNeedingWake,
        getNextPendingControlForInstances: multi.getNextPendingControlForInstances,
        markRejected: multi.markRejected,
        markControlRejected: multi.markControlRejected,
        notifyMessageDelivered,
      });
      if (!result?.legacy) return result;
      // legacy mode (no instances.json): fall through to single-session
    } catch (e) {
      log(`Multi-session dispatch error: ${e.message}`);
      return { delivered: false, state: 'multi_error' };
    }
  }

  const agentState = getAgentState();
  if (agentState.state === 'offline' || agentState.state === 'stopped') {
    tmuxMissingChecks += 1;
    if (tmuxMissingChecks === TMUX_MISSING_WARN_THRESHOLD) {
      log(`WARNING: Agent status stale/missing for ${TMUX_MISSING_WARN_THRESHOLD} consecutive checks`);
    }
  } else {
    tmuxMissingChecks = 0;
  }

  const item = claimNextItem();
  if (!item) {
    return { delivered: false, state: agentState.state };
  }

  const bypass = isBypassState(item);

  if ((agentState.state === 'offline' || agentState.state === 'stopped') && !bypass) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  if (agentState.health !== 'ok' && !bypass) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  if (item.require_idle === 1 && (agentState.state !== 'idle' || agentState.idleSeconds < REQUIRE_IDLE_MIN_SECONDS)) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  // D1: heartbeat must not interrupt active generation.
  // Auto-ack supports two paths:
  //   1. It's a heartbeat (not other bypass controls like context rotation)
  //   2. Agent state is not offline/stopped (proc-state can be stale for ~30s after crash)
  //   3. /proc confirms process is alive (and idle path also requires not frozen)
  //   4. Either:
  //      - busy path: fresh hooks confirm active generation, or
  //      - idle path: health=ok and idle_seconds >= sustained-idle minimum
  // This preserves the existing busy auto-ack behavior while allowing a narrow
  // idle auto-ack path on healthy, stable sessions.
  if (bypass) {
    const procState = readProcState();
    const confirmed = isAgentConfirmedActive();
    const requireIdleWaiting = hasPendingRequireIdleControl();
    if (shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive: confirmed, requireIdleWaiting })) {
      const phase = getHeartbeatPhase(item.content);
      const reason = confirmed
        ? `phase=${phase} /proc alive + active_tools>0 fresh (delta=${procState.lastDelta})`
        : `phase=${phase} /proc alive + health=ok + idle_seconds=${agentState.idleSeconds}${requireIdleWaiting ? ' + require_idle_waiting' : ''}`;
      log(`Auto-acking heartbeat id=${item.id}: ${reason}`);
      ackControl(item.id);
      return { delivered: true, state: agentState.state };
    }
  }

  // Keystroke delivery: content prefixed with [KEYSTROKE] sends raw key to tmux
  // without buffer paste or "Meanwhile" prefix. Used for auto-approve permission prompts.
  const rawContent = item.content || '';
  if (isKeystrokeControl(item)) {
    const key = parseKeystrokeKey(rawContent);
    log(`Delivering keystroke key=${key} (control id=${item.id} priority=${item.priority})`);
    try {
      execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, key], { stdio: 'pipe', timeout: 5000 });
      ackControl(item.id);
      log(`Keystroke delivered: key=${key} (control id=${item.id})`);
      return { delivered: true, state: agentState.state };
    } catch (err) {
      log(`Keystroke delivery error: ${err.message}`);
      await handleControlDeliveryFailure(item, `KEYSTROKE_ERROR: ${err.message}`);
      return { delivered: false, state: agentState.state };
    }
  }

  log(`Delivering ${item.type} id=${item.id}${item.type === 'control' ? ` priority=${item.priority}` : ` from ${item.channel}`}`);
  const deliveryContent = getDeliveryContent(item);
  const result = await sendToTmux(deliveryContent, {
    deliveryId: `${item.type}:${item.id}`,
    strictVerify: item.type === 'conversation',
    acceptShutdownAfterSubmit: isCodexExitLifecycleControl(item)
  });

  if (result === 'submitted') {
    if (item.type === 'conversation') {
      markDelivered(item.id);
      log(`Conversation id=${item.id} delivered`);
      notifyMessageDelivered({ conversationId: item.id, channel: item.channel }).catch((err) => {
        log(`Warning: failed to notify AM of message delivery: ${err.message}`);
      });
    } else {
      if (hasAckSuffix(item.content || '')) {
        log(`Control id=${item.id} submitted, waiting ack`);
      } else {
        ackControl(item.id);
        log(`Control id=${item.id} submitted (no-ack mode), marked done`);
      }
    }

    if (item.require_idle === 1) {
      await waitForRequireIdleSettlement(item.id);
    }
    return { delivered: true, state: agentState.state };
  }

  const reason = result === 'verify_failed' ? 'VERIFY_FAILED' : 'TMUX_PASTE_FAILED';
  log(`Failed to deliver ${item.type} id=${item.id} to tmux (${reason})`);
  logDeliveryFailure(item.type, item.id, reason);
  if (item.type === 'control') {
    await handleControlDeliveryFailure(item, reason);
  } else {
    await handleConversationDeliveryFailure(item);
  }
  return { delivered: false, state: agentState.state };
}

// Emit the periodic liveness line at most once per interval. Reads the last
// tick's result for held/heldReasons/state; DB counts are cheap enough at ~1/min.
// Defensive: a DB hiccup while counting must never crash the loop — lastHeartbeatMs
// is advanced before the read so a persistent error can't spin the log every tick.
function maybeEmitHeartbeat(result) {
  const now = Date.now();
  if (!shouldEmitHeartbeat(now, lastHeartbeatMs, HEARTBEAT_INTERVAL_MS)) return;
  lastHeartbeatMs = now;
  try {
    log(formatHeartbeatLine({
      pendingConv: getPendingCount(),
      pendingControl: getPendingControlCount(),
      held: result?.held ?? 0,
      heldReasons: result?.heldReasons ?? {},
      state: result?.state,
    }));
  } catch (err) {
    log(`Heartbeat emit error: ${err.message}`);
  }
}

/**
 * One dispatcher iteration, extracted from the loop so the liveness invariant is
 * unit-testable without driving the infinite loop. Refreshes the watchdog clock
 * AND emits the heartbeat on BOTH the success and error paths — an alive-but-
 * erroring loop must keep lastTickCompletedAt fresh so the watchdog does not
 * falsely kill it, while a genuinely stuck tick (which never returns here) goes
 * stale and trips it (review LOW-7). `processFn` and `now` are injectable for
 * tests; dispatcherLoop calls it with the defaults.
 *
 * @returns {Promise<{ result: object, errored: boolean }>}
 */
export async function runDispatcherTick(processFn = processNextMessage, now = Date.now) {
  try {
    const result = await processFn();
    lastTickCompletedAt = now();
    maybeEmitHeartbeat(result);
    return { result, errored: false };
  } catch (err) {
    log(`Dispatcher error: ${err.stack}`);
    lastTickCompletedAt = now();
    maybeEmitHeartbeat({ state: 'error' });
    return { result: { delivered: false, state: 'error' }, errored: true };
  }
}

async function dispatcherLoop() {
  while (!isShuttingDown) {
    const { result, errored } = await runDispatcherTick();
    const { delivered, state } = result;

    // On error keep the prior poll interval and back off by it — unchanged from
    // the original catch-branch behavior (an erroring tick does not reset the
    // adaptive interval).
    if (errored) {
      await sleep(pollInterval);
      continue;
    }

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
  }
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Shutting down...');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Singleton guard. WAL + guarded-UPDATE claims make double-DELIVERY of one
 * row impossible, but two dispatchers can still claim different rows for the
 * same instance and interleave tmux keystrokes into one pane, and duplicate
 * the in-memory lifecycle signals (wake/suspend/auto-start). PM2 fork-mode is
 * the only thing preventing that today — this pidfile makes it a code
 * guarantee. Stale pidfiles (dead pid) are reclaimed automatically.
 */
function acquireSingletonLock() {
  const lockPath = path.join(path.dirname(DB_PATH), 'c4-dispatcher.pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fsOpenSync(lockPath, 'wx');
      fsWriteSync(fd, String(process.pid));
      fsCloseSync(fd);
      const cleanup = () => { try { fsUnlinkSync(lockPath); } catch { /* best-effort */ } };
      process.on('exit', cleanup);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') { log(`Singleton lock error: ${err.message} — continuing without lock`); return true; }
      let holderPid = 0;
      try { holderPid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10); } catch { }
      let holderAlive = false;
      if (Number.isInteger(holderPid) && holderPid > 0 && holderPid !== process.pid) {
        try { process.kill(holderPid, 0); holderAlive = true; }
        catch (e) { holderAlive = e?.code === 'EPERM'; }
      }
      if (holderAlive) {
        log(`Another dispatcher is running (pid ${holderPid}) — exiting.`);
        return false;
      }
      try { fsUnlinkSync(lockPath); } catch { }
    }
  }
  log('Could not acquire singleton lock after stale-cleanup retry — exiting.');
  return false;
}

async function main() {
  if (!acquireSingletonLock()) {
    close();
    process.exit(1);
  }
  log('=== C4 Dispatcher Started ===');
  log(`Tmux session: ${TMUX_SESSION}`);
  log(`Poll interval: ${POLL_INTERVAL_BASE}ms (adaptive up to ${POLL_INTERVAL_MAX}ms)`);

  // Reclaim rows a previous dispatcher left in 'running' (killed mid-delivery).
  // Safe here: the singleton lock is held, so no other dispatcher owns a claim.
  // Without this, a message claimed right before a SIGKILL/pm2 kill_timeout is
  // invisible to every pending query forever — silent loss.
  try {
    const orphaned = resetOrphanedRunning();
    if (orphaned.conversations > 0 || orphaned.controls > 0) {
      log(`Reclaimed orphaned in-flight rows from a prior dispatcher: ${orphaned.conversations} conversation(s), ${orphaned.controls} control(s)`);
    }
  } catch (err) {
    log(`Warning: orphaned-running reclaim failed: ${err.message}`);
  }

  const pendingControl = getPendingControlCount();
  const pendingConversation = getPendingCount();
  if (pendingControl > 0) {
    log(`Found ${pendingControl} pending control item(s)`);
  }
  if (pendingConversation > 0) {
    log(`Found ${pendingConversation} pending conversation message(s)`);
  }

  // Stuck-tick watchdog (defense-in-depth). pm2 can't detect a hung-but-online
  // event loop, so a self-timer force-exits when no tick has completed in
  // WATCHDOG_MAX_TICK_MS; pm2 (autorestart) then restarts and resetOrphanedRunning
  // reclaims in-flight rows. .unref() so this timer never blocks the clean-shutdown
  // process.exit(0) below.
  lastTickCompletedAt = Date.now();
  const watchdog = setInterval(() => {
    if (isWatchdogExpired(Date.now(), lastTickCompletedAt, WATCHDOG_MAX_TICK_MS)) {
      log(`WATCHDOG: no tick completed in >${WATCHDOG_MAX_TICK_MS}ms (last tick ${new Date(lastTickCompletedAt).toISOString()}) — exiting for pm2 restart`);
      process.exit(1);
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
  watchdog.unref();

  await dispatcherLoop();
  close();
  process.exit(0);
}

export {
  getAgentState, isAgentStatusFresh, sendToTmux, claimNextItem,
  releaseItem, handleConversationDeliveryFailure, handleControlDeliveryFailure,
  waitForRequireIdleSettlement, readProcState, isAgentConfirmedActive,
  markDelivered, ackControl, log, sleep, nowSeconds,
};

// PM2 sets argv[1] to its own ProcessContainerFork.js, so classic ESM
// isMainModule checks are unreliable here. Keep the default auto-start
// behavior, but allow tests to disable the live loop before import.
if (process.env.C4_DISPATCHER_DISABLE_MAIN !== '1') {
  main();
}
