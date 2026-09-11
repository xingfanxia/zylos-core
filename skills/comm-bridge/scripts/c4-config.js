import fs from 'fs';
import path from 'path';
import os from 'os';

export const POLL_INTERVAL_BASE = 1000;
export const POLL_INTERVAL_MAX = 3000;

export const DELIVERY_DELAY_BASE = 200;
export const DELIVERY_DELAY_PER_KB = 100;
export const DELIVERY_DELAY_MAX = 1000;

export const MAX_RETRIES = 2;
export const RETRY_BASE_MS = 500;
export const CONTROL_MAX_RETRIES = 3;
export const CONTROL_RETENTION_DAYS = 7;
export const CONTROL_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const ENTER_VERIFY_MAX_RETRIES = 3;
export const ENTER_VERIFY_WAIT_MS = 500;

// For legacy require_idle / external block_queue_until_idle messages:
// minimum sustained idle seconds before delivery.
export const REQUIRE_IDLE_MIN_SECONDS = 3;
// For legacy require_idle / external block_queue_until_idle messages:
// allow execution time before dispatching the next message.
export const REQUIRE_IDLE_POST_SEND_HOLD_MS = 5000;
export const REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS = 120000;
export const REQUIRE_IDLE_EXECUTION_POLL_MS = 1000;

export const FILE_SIZE_THRESHOLD = 2048; // bytes
export const CONTENT_PREVIEW_CHARS = 100;

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

// Read active runtime from config.json to dispatch to the correct tmux session.
// Defaults to 'claude' when config is absent or runtime is unset.
function _readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ZYLOS_DIR, '.zylos', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}
const _cfg = _readConfig();
export const ACTIVE_RUNTIME = _cfg.runtime === 'codex' ? 'codex' : 'claude';
export const TMUX_SESSION = ACTIVE_RUNTIME === 'codex' ? 'codex-main' : 'claude-main';
export const DATA_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
export const DB_PATH = path.join(DATA_DIR, 'c4.db');
export const ACTIVITY_MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
export const AGENT_STATUS_FILE = path.join(ACTIVITY_MONITOR_DIR, 'agent-status.json');
export const PROC_STATE_FILE = path.join(ACTIVITY_MONITOR_DIR, 'proc-state.json');
export const API_ACTIVITY_FILE = path.join(ACTIVITY_MONITOR_DIR, 'api-activity.json');
export const PENDING_CHANNELS_FILE = path.join(ACTIVITY_MONITOR_DIR, 'pending-channels.jsonl');
export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
export const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');

// Single source of truth for the Memory Sync checkpoint threshold (unsummarized
// conversation count that triggers a sync). Imported by the activity-monitor
// context-monitor / monitor scripts — do NOT re-declare it as a literal elsewhere.
export const CHECKPOINT_THRESHOLD = 15;

// Group instance (type:'group') session-init segmentation caps. Injected history
// is split into one section per chat/group; each group shows its most recent
// SESSION_INIT_GROUP_PER_GROUP messages, and at most SESSION_INIT_GROUP_MAX_GROUPS
// (most-recently-active first) are shown — the rest are summarized as "N omitted".
export const SESSION_INIT_GROUP_PER_GROUP = 10;
export const SESSION_INIT_GROUP_MAX_GROUPS = 8;
export const SESSION_INIT_RECENT_COUNT = 6;  // max conversations returned by session-init when above threshold

export const STALE_STATUS_THRESHOLD = 5000; // ms
export const TMUX_MISSING_WARN_THRESHOLD = 30;

// Dispatcher loop observability (WS-A / REL-2). Env-overridable following the
// ZYLOS_DIR `process.env.X || default` idiom above.
// HEARTBEAT_INTERVAL_MS: the dispatcher emits one `dispatcher alive: ...` line
// per interval unconditionally, so a silent log means a dead/hung loop (the
// 6h04m un-diagnosable silence on 2026-07-09 had no positive liveness signal).
export const HEARTBEAT_INTERVAL_MS = Number(process.env.C4_HEARTBEAT_INTERVAL_MS) || 60000;
// WATCHDOG_MAX_TICK_MS: defense-in-depth stuck-tick guard. Must exceed the
// legitimate worst-case tick (waitForRequireIdleSettlement's 120s deadline plus
// retry backoffs); 300s is safely above it. On expiry the dispatcher exits(1)
// so pm2 autorestart reclaims it (resetOrphanedRunning recovers in-flight rows).
export const WATCHDOG_MAX_TICK_MS = Number(process.env.C4_WATCHDOG_MAX_TICK_MS) || 300000;
