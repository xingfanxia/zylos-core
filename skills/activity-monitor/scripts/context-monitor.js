#!/usr/bin/env node
/**
 * Context Monitor — statusLine handler for Claude Code
 *
 * Receives JSON from Claude Code's statusLine feature via stdin after every turn.
 * - Writes status to ~/zylos/activity-monitor/statusline.json for external queries
 * - Tracks session cost: logs final cost to cost-log.jsonl when session changes
 * - Triggers new-session handoff when context usage exceeds threshold
 *
 * Replaces the old polling-based check-context mechanism:
 * - Old: activity-monitor polls hourly → enqueues /context command (costs a turn) → parses output
 * - New: Claude writes status after every turn → this script reacts instantly, zero turn cost
 *
 * Configured in ~/zylos/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/context-monitor.js" }
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CHECKPOINT_THRESHOLD } from '../../comm-bridge/scripts/c4-config.js';
import {
  createMemorySyncControlPrompt,
  markMemorySyncRequested,
  shouldTriggerMemorySync,
} from './memory-sync-gate.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// Instance-aware activity-monitor directory
let AM_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
if (INSTANCE_ID) {
  try {
    const { getMonitorDir } = await import('../../multi-session/instance-config.js');
    AM_DIR = getMonitorDir(INSTANCE_ID);
  } catch { /* use default */ }
}
const STATUS_FILE = path.join(AM_DIR, 'statusline.json');
const STATE_FILE = path.join(AM_DIR, 'context-monitor-state.json');
const COST_LOG_FILE = path.join(AM_DIR, 'cost-log.jsonl');
const CONTEXT_WINDOW_FILE = path.join(AM_DIR, 'context-window.json');
const LAST_CONTEXT_HANDOFF_FILE = path.join(AM_DIR, 'last-context-handoff.json');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
// Routing-aware unsummarized-count read: isolated agents go through the broker,
// admin/scheduler read c4-db directly. Never touch c4-db.js here (it is a pure
// library with no broker routing — an isolated agent has no DB access post-B3).
const C4_CLIENT = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-client.js');
const CONFIG_FILE = path.join(ZYLOS_DIR, '.zylos', 'config.json');

// Thresholds — configurable via config.json `new_session_threshold` (default 70)
const DEFAULT_THRESHOLD = 70;
const RESTART_THRESHOLD = readThresholdFromConfig();
const COOLDOWN_SECONDS = 300;   // Re-trigger after 5 minutes if still above threshold

// Hard ceiling — forced-reset band, configurable via config.json
// `hard_ceiling_threshold` (default 88). When context climbs this high the
// graceful new-session prompt has failed to land: a continuously-busy agent
// never reaches sustained-idle, so the new-session skill's require_idle /clear
// starves and context keeps climbing toward 100% (where lossy auto-compact
// takes over). In this band we enqueue /clear directly, WITHOUT require_idle,
// so the reset cannot be starved. Clamped strictly above RESTART_THRESHOLD and
// below 100 so the forced /clear has runway before the window fills.
const DEFAULT_HARD_CEILING = 88;
const HARD_CEILING_THRESHOLD = readHardCeilingFromConfig();
// Forced band re-assert interval. Deliberately short and independent of the
// graceful cooldown: the forced /clear must re-fire each turn while context
// stays at/above the ceiling, so it re-wins the content-only supersede in
// c4-db (a late require_idle /clear from the new-session skill would otherwise
// replace it and re-introduce starvation), and retries a /clear that was
// delivered but not yet executed. A real reset changes session_id and drops
// usage below the ceiling, so re-asserting never double-resets a fresh session.
const FORCED_REASSERT_SECONDS = 60;

// Early memory sync: inject at 80% of session-switch threshold so memory sync
// completes in the background before new-session fires.
const MEMORY_SYNC_RATIO = 0.8;
const MEMORY_SYNC_THRESHOLD = Math.round(RESTART_THRESHOLD * MEMORY_SYNC_RATIO);
// CHECKPOINT_THRESHOLD imported from c4-config.js (single source of truth).
const MEMORY_SYNC_COOLDOWN_SECONDS = 600;  // 10 min — prevent re-inject while sync is running
const MEMORY_SYNC_IN_FLIGHT_TTL_SECONDS = 1800;  // 30 min safety TTL for delivered-but-unacked sync prompts

function readThresholdFromConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const val = parseInt(config.new_session_threshold, 10);
    if (!isNaN(val) && val > 0 && val <= 100) return val;
  } catch { /* config missing or malformed */ }
  return DEFAULT_THRESHOLD;
}

function readHardCeilingFromConfig() {
  let val = DEFAULT_HARD_CEILING;
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const v = parseInt(config.hard_ceiling_threshold, 10);
    if (!isNaN(v) && v > 0 && v <= 100) val = v;
  } catch { /* config missing or malformed */ }
  // Must sit strictly above the graceful restart threshold and below 100.
  return Math.min(99, Math.max(val, RESTART_THRESHOLD + 1));
}

// Ensure data directory exists once at startup
let dirReady = false;
function ensureDirOnce() {
  if (dirReady) return;
  if (!fs.existsSync(AM_DIR)) fs.mkdirSync(AM_DIR, { recursive: true });
  dirReady = true;
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    main(input);
  } catch (err) {
    // Silent failure — statusLine errors must not break Claude
    try {
      const preview = input.substring(0, 200).replace(/\n/g, '\\n');
      log(`ERROR: ${err.message} (input length: ${input.length}, preview: ${preview})`);
    } catch {}
  }
});

function main(raw) {
  if (!raw || !raw.trim()) return;

  // Parse status JSON
  const status = JSON.parse(raw);

  // Ensure data directory exists
  ensureDirOnce();

  // Always write status file for external queries
  atomicWrite(STATUS_FILE, JSON.stringify(status, null, 2));

  // Normalize Claude statusLine into the same context observability files used by Codex.
  const contextSnapshot = buildContextWindowSnapshot(status);
  if (contextSnapshot) {
    atomicWrite(CONTEXT_WINDOW_FILE, JSON.stringify(contextSnapshot, null, 2));
  }

  // Single load → mutate → one save per exit path. statusLine handlers run as
  // separate per-turn processes; keeping one read-modify-write per turn (instead
  // of trackSessionCost and the trigger block each loading+saving) narrows the
  // window where an overlapping handler's write is silently lost.
  let state = trackSessionCost(status, loadState() || {});

  // Check context percentage
  const usedPct = status.context_window?.used_percentage;
  if (usedPct == null) { saveState(state); return; }

  const now = Math.floor(Date.now() / 1000);

  // Early memory sync injection: when usage reaches 80% of the session-switch
  // threshold, prompt Claude to run memory sync in the background. By the time
  // the session switch fires, sync should already be done (or nearly done).
  if (usedPct >= MEMORY_SYNC_THRESHOLD && usedPct < RESTART_THRESHOLD) {
    state = maybeEnqueueMemorySync(usedPct, state, now);
    saveState(state);
    return;
  }

  // Session-switch threshold
  if (usedPct < RESTART_THRESHOLD) { saveState(state); return; }

  // Two-tier reset:
  //   [RESTART_THRESHOLD, HARD_CEILING_THRESHOLD)  graceful — prompt the agent to
  //     run the new-session skill (writes a handoff summary, then a require_idle
  //     /clear that waits for a clean idle window).
  //   >= HARD_CEILING_THRESHOLD                    forced — the graceful prompt has
  //     failed to land (busy agent never reaches sustained-idle, so its /clear
  //     starves). Enqueue /clear directly, WITHOUT require_idle, so the reset
  //     cannot be starved before the window fills to 100%.
  const forced = usedPct >= HARD_CEILING_THRESHOLD;
  const sessionId = status?.session_id || null;
  state = { ...state, used_percentage: usedPct };

  // Band-specific cooldowns. The forced band tracks its OWN re-assert timer so a
  // recent graceful trigger can never suppress the first forced fire, and so it
  // re-asserts each turn (see FORCED_REASSERT_SECONDS) to re-win c4-db's
  // content-only supersede against a late require_idle /clear from the skill.
  if (forced) {
    // If a forced /clear already fired and the session has since rotated, the
    // reset landed. Don't carry the prior session's re-assert into the fresh
    // session — which can briefly still report a stale high % — or we'd wipe
    // real post-reset work. Disarm; the new session must climb back to the
    // ceiling on its own (through the graceful band first) before forcing again.
    if (state.last_forced_session_id != null && state.last_forced_session_id !== sessionId) {
      saveState({ ...state, last_forced_trigger_at: null, last_forced_session_id: sessionId });
      return;
    }
    if (state.last_forced_trigger_at != null &&
        (now - state.last_forced_trigger_at) < FORCED_REASSERT_SECONDS) {
      saveState(state);
      return;
    }
  } else if (state.last_trigger_at != null &&
      (now - state.last_trigger_at) < COOLDOWN_SECONDS) {
    saveState(state);
    return;
  }

  // Enqueue with bypass_state so the dispatcher delivers it even when
  // health !== 'ok' (fixes #274: context rotation deadlock).
  const MAX_RETRIES = 3;
  let enqueued = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const enqueueArgs = [C4_CONTROL, 'enqueue', '--priority', '1', '--bypass-state', '--no-ack-suffix'];
      if (forced) {
        // Slash command delivered verbatim, no require_idle → not starvable.
        enqueueArgs.push('--content', '/clear');
      } else {
        enqueueArgs.push('--content', `Context usage at ${usedPct}%, exceeding ${RESTART_THRESHOLD}% threshold. Use the new-session skill to start a fresh session.`);
      }
      if (INSTANCE_ID) enqueueArgs.push('--target-instance', INSTANCE_ID);
      execFileSync('node', enqueueArgs, { encoding: 'utf8', stdio: 'pipe' });

      enqueued = true;
      log(forced
        ? `FORCED new-session (hard ceiling ${HARD_CEILING_THRESHOLD}%): context at ${usedPct}%, enqueued /clear directly`
        : `Triggered new-session: context at ${usedPct}%`);
      break;
    } catch (err) {
      log(`Failed to enqueue ${forced ? 'forced /clear' : 'new-session'} (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
    }
  }

  const handoffRecord = buildLastContextHandoffRecord(status, { enqueueOk: enqueued, forced });
  if (handoffRecord) {
    atomicWrite(LAST_CONTEXT_HANDOFF_FILE, JSON.stringify(handoffRecord, null, 2));
  }

  // Only update the band's cooldown after a successful enqueue (avoid silent
  // gaps on failure). Forced and graceful track separate timers.
  if (enqueued) {
    state = forced
      ? { ...state, last_forced_trigger_at: now, last_forced_session_id: sessionId }
      : { ...state, last_trigger_at: now };
  }
  saveState(state);
}

/**
 * Enqueue early memory sync when context approaches the session-switch threshold.
 * Only triggers when there are enough unsummarized conversations to warrant sync.
 */
function maybeEnqueueMemorySync(usedPct, state, now) {
  // Check unsummarized conversation count — skip if below threshold
  const unsummarizedCount = getUnsummarizedCount();
  const gate = shouldTriggerMemorySync({
    state,
    now,
    unsummarizedCount,
    checkpointThreshold: CHECKPOINT_THRESHOLD,
    cooldownSeconds: MEMORY_SYNC_COOLDOWN_SECONDS,
    inFlightTtlSeconds: MEMORY_SYNC_IN_FLIGHT_TTL_SECONDS,
  });

  if (!gate.shouldEnqueue) {
    log(`Early memory sync skipped at ${usedPct}%: ${gate.reason} (unsummarized=${unsummarizedCount}, threshold=${CHECKPOINT_THRESHOLD})`);
    return gate.nextState;
  }

  const content = createMemorySyncControlPrompt({
    pct: usedPct,
    thresholdPct: RESTART_THRESHOLD,
  });
  const MAX_RETRIES = 3;
  let enqueued = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execFileSync('node', [C4_CONTROL, 'enqueue',
        '--content', content,
        '--priority', '2',
        '--no-ack-suffix'
      ], { encoding: 'utf8', stdio: 'pipe' });

      enqueued = true;
      log(`Triggered early memory sync: context at ${usedPct}%, unsummarized=${unsummarizedCount} (threshold: ${CHECKPOINT_THRESHOLD})`);
      break;
    } catch (err) {
      log(`Failed to enqueue memory sync (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
    }
  }

  if (enqueued) {
    return markMemorySyncRequested({
      state: gate.nextState,
      now,
      unsummarizedCount,
      pct: usedPct,
      thresholdPct: RESTART_THRESHOLD,
      inFlightTtlSeconds: MEMORY_SYNC_IN_FLIGHT_TTL_SECONDS,
    });
  }
  return gate.nextState;
}

/**
 * Get count of unsummarized conversations from C4 database.
 * Returns 0 on any error (fail-safe: don't trigger sync on error).
 */
function getUnsummarizedCount() {
  try {
    const output = execFileSync('node', [C4_CLIENT, 'unsummarized'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000
    });
    const range = JSON.parse(output);
    return range.count || 0;
  } catch {
    return 0;
  }
}

/**
 * Track session cost: detect session changes and log the previous session's final cost.
 * State file stores current session_id and last_cost; when session_id changes,
 * the previous session's cost is appended to cost-log.jsonl.
 */
function trackSessionCost(status, state) {
  const sessionId = status.session_id;
  const costUsd = status.cost?.total_cost_usd;
  const usedPct = status.context_window?.used_percentage;
  if (!sessionId) return state;

  // Session changed — log previous session's final cost
  if (state && state.session_id && state.session_id !== sessionId) {
    if (state.last_cost != null) {
      const entry = {
        session_id: state.session_id,
        cost_usd: state.last_cost,
        ended_at: new Date().toISOString(),
        context_used_pct: state.used_percentage ?? null,
      };
      try {
        fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
        log(`Session cost logged: ${state.session_id} = $${state.last_cost}`);
      } catch (err) {
        log(`Failed to write cost log: ${err.message}`);
      }
    }

    // Reset cost for new session — don't carry over previous session's cost.
    return {
      ...state,
      session_id: sessionId,
      last_cost: costUsd ?? null,
      used_percentage: usedPct ?? null,
      last_logged_session_id: state.session_id,
    };
  }

  // Same session — update cost and context percentage
  return {
    ...state,
    session_id: sessionId,
    last_cost: costUsd ?? state?.last_cost,
    used_percentage: usedPct ?? state?.used_percentage,
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  ensureDirOnce();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function buildContextWindowSnapshot(status) {
  const cw = status?.context_window;
  if (!cw || cw.used_percentage == null || !cw.context_window_size) return null;

  const percentUsed = Math.round(cw.used_percentage);
  const ceilingTokens = cw.context_window_size;
  return {
    runtime: 'claude',
    instance_id: INSTANCE_ID,
    observed_at: new Date().toISOString(),
    used_tokens: Math.round((percentUsed / 100) * ceilingTokens),
    ceiling_tokens: ceilingTokens,
    percent_used: percentUsed,
    percent_remaining: cw.remaining_percentage != null
      ? Math.round(cw.remaining_percentage)
      : Math.max(0, 100 - percentUsed),
    threshold_percent: RESTART_THRESHOLD,
    source: 'claude_statusline',
    rollout_path: null,
    session_id: status?.session_id || null,
  };
}

function buildLastContextHandoffRecord(status, { enqueueOk = false, forced = false } = {}) {
  const cw = status?.context_window;
  if (!cw || cw.used_percentage == null || !cw.context_window_size) return null;

  const percentUsed = Math.round(cw.used_percentage);
  const ceilingTokens = cw.context_window_size;
  return {
    runtime: 'claude',
    instance_id: INSTANCE_ID,
    triggered_at: new Date().toISOString(),
    used_tokens: Math.round((percentUsed / 100) * ceilingTokens),
    ceiling_tokens: ceilingTokens,
    percent_used: percentUsed,
    threshold_percent: RESTART_THRESHOLD,
    // Forced handoffs cross the hard ceiling: record which band fired so a 90%
    // forced /clear isn't misread as a graceful threshold_percent event.
    forced,
    hard_ceiling_percent: HARD_CEILING_THRESHOLD,
    source: 'claude_statusline',
    rollout_path: null,
    enqueue_ok: enqueueOk,
    session_id: status?.session_id || null,
  };
}

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption from concurrent reads or interrupted writes.
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function log(msg) {
  try {
    ensureDirOnce();
    const logFile = path.join(AM_DIR, 'context-monitor.log');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
