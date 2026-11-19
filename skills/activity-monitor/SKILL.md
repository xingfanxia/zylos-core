---
name: activity-monitor
description: Guardian service that monitors the active runtime agent's state and automatically restarts it if stopped. Use when checking agent liveness state or understanding the auto-restart mechanism.
user-invocable: false
---

# Activity Monitor Skill

PM2 guardian service that monitors the active runtime agent's (Claude or Codex) activity state and ensures it's always running.

## When to Use

This is a **PM2 service** (not directly invoked by Claude). It runs continuously in the background.

## What It Does

1. **Activity Monitoring**: Tracks the agent's busy/idle state every second
2. **Status File**: Writes `~/zylos/activity-monitor/agent-status.json` with current state (busy/idle, idle_seconds, health)
3. **Guardian Mode**: Automatically restarts the agent if it stops or crashes
4. **Maintenance Awareness**: Waits for restart/upgrade scripts to complete before starting the agent
5. **Recovery Liveness Detection**: Sends C4 heartbeat probes during recovery and after restarts; healthy sessions have no periodic primary heartbeat
6. **Health Check**: Periodically enqueues system health checks (PM2, disk, memory) via the C4 control queue
7. **Daily Upgrade**: Enqueues a Claude Code upgrade via the C4 control queue at 5:00 AM local time daily (disabled by default; enable with `zylos config set daily_upgrade_enabled true`)
8. **Context Monitoring**: Receives context usage data after every turn; triggers early memory sync and new-session handoff at thresholds read from `config.json` (`new_session_threshold` for Claude, `codex_new_session_threshold` for Codex), each with a built-in runtime fallback if the key is unset

## Status File Format

```json
{
  "state": "idle",
  "last_activity": 1738675200,
  "last_check": 1738675210,
  "last_check_human": "2026-02-04 20:30:10",
  "idle_seconds": 5,
  "inactive_seconds": 10,
  "source": "conv_file",
  "health": "ok"
}
```

- `state`: "busy" | "idle" | "stopped" | "offline"
- `idle_seconds`: Time since entering idle state (0 when busy)
- `source`: "conv_file" (reliable) | "tmux_activity" (fallback)
- `health`: "ok" | "unavailable" | "rate_limited" | "auth_failed" — current public health; legacy `recovering` / `down` states remain readable

## PM2 Management

```bash
# Start
pm2 start ~/zylos/.claude/skills/activity-monitor/scripts/activity-monitor.js --name activity-monitor

# Restart
pm2 restart activity-monitor

# View logs
pm2 logs activity-monitor

# Check status
pm2 list
```

## Guardian Behavior

- **Detection**: Checks if the agent is running every second
- **Restart Delay**: Waits 5 seconds of continuous "not running" before restarting
- **Maintenance Wait**: Detects restart/upgrade scripts and waits for completion
- **Recovery Prompt**: Sends catch-up message via C4 after restart
- **Failed starts**: a launch counts as started once the engine has run 30 s without a break. A launch the Guardian has to replace before that is a failed start, with its cause from the launch path: the adapter's own error, or the launcher's record `launch-result.json` in the persona's monitor dir (`launcher_failed` with its module/stage error, `spawn_failed`, or `exited` with the engine's exit code or signal). The first failed start is retried as is. After the second the persona is **held**, whatever the cause: one admin alert per downtime episode (recorded only after a verified send; a failed send is retried at the next retry windows, 3 tries in all; no admin chat is logged once), then one retry every `degraded_probe_interval` (20 min) until a start succeeds.
  - A failed start never moves the persona and writes no failover block. `runtime-failover` keeps acting on its own signals (quota, auth, rate limit, degraded); if it, or the Fable guard, moves a held persona, its move wins: the new monitor tries the new tier at once, and the episode ends when a start there is confirmed.
  - The hold timing survives a plain monitor restart (same profile, no runtime switch in between).
  - Downtime is in the PM2 out log as `Guardian: start failed …`, `start held …` and `start recovered on <profile>: down from <A> to <B> (… last cause: …)`; the open episode (`start_failure`) and the last confirmed start (`start_confirmed_at`) are in `agent-status.json`.
- **Deploy canary**: `node cli/lib/runtime/tmux-launcher.js --check`, run as each persona's Unix user, loads the launcher's module graph and starts nothing.

## How It Works

1. **Monitor Loop** (every 1s):
   - Check if tmux session exists
   - Check if agent process is running
   - Detect activity (conversation file mtime for Claude; tmux activity for Codex)
   - Calculate idle/busy state
   - Write status to ~/zylos/activity-monitor/agent-status.json

2. **Guardian Logic**:
   - If agent not running for 5+ seconds → restart
   - Wait for maintenance scripts to complete
   - Send recovery prompt via C4 after successful restart

3. **Activity Detection**:
   - Claude primary: Conversation file modification time (reliable)
   - Codex / fallback: tmux window activity
   - Threshold: 3 seconds without activity = idle

## Heartbeat Liveness Detection

The health engine uses the C4 control queue to verify runtime responsiveness during recovery. Healthy sessions do not receive periodic `primary` probes, and there is no heartbeat enable/interval setting. The internal maintenance timer still processes pending probe results and recovery scheduling.

### Recovery Probes

| Phase | Trigger | On Success | On Failure |
|-------|---------|------------|------------|
| `recovery` | Unavailable/recovering maintenance retry or user-message recovery | Return to `ok` | Apply existing rate-limit detection or recovery handling |
| `post_restart` | Restart notification or process-running signal after its grace period | Return to `ok` | Apply existing recovery handling |
| `down-check` | Legacy `down` state retry interval | Return to `ok` | Stay `down` and retry later |

Retries in unavailable/recovering use exponential backoff (1m, 5m, 25m, then 60m). Rate-limit cooldown expiry only clears the wait; a later recovery trigger verifies responsiveness. Failed or expired pending probes still run their existing failure handling, including API-error fast scanning while waiting.

Recovery and post-restart probes require end-to-end acknowledgement. The dispatcher retains confirmed-active busy auto-ack for other heartbeat phases; idle heartbeat auto-ack has been removed.

See [Recovery and maintenance behavior](references/health-engine.md) for timing and compatibility details.

### Unhealthy Message Routing

When health is not `ok`, C4 intake still records incoming messages as delivered. The MessageRouter returns an immediate status response for the current message when replies are enabled; `--no-reply` messages are accepted silently. If the router IPC is unavailable, `c4-receive.js` falls back to the status file and follows the same delivered/current-message behavior.

## Health Check

The activity monitor periodically enqueues system health checks via the C4 control queue.

- **Enabled**: On by default. Disable with `zylos config set health_check_enabled false`
- **Interval**: Every 24 hours (86400 seconds)
- **Persisted state**: `~/zylos/activity-monitor/health-check-state.json` (survives restarts)
- **Priority**: 3 (normal)
- **Primary-only**: One fleet-wide check is enqueued by the primary instance; user-tier monitors never enqueue it
- **Gated by health**: Only enqueued when `health === 'ok'`
- **Gated by agent**: Only enqueued when the agent process is running

The health check control message instructs Claude to:
1. Check PM2 services via the health-check skill's sanitized PM2 snapshot helper
2. Check disk space via `df -h`
3. Check memory via `free -m`
4. If issues found, notify the most recent communication channel
5. Log results to `~/zylos/logs/health.log`
6. Acknowledge the control message

Raw `pm2 jlist` output must never enter an agent/tool transcript because it
contains each process's inherited environment.

## Daily Upgrade

The activity monitor enqueues a daily Claude Code upgrade via the C4 control queue.

- **Enabled**: Off by default. Enable with `zylos config set daily_upgrade_enabled true`
- **Schedule**: 5:00 AM local time (configured by `DAILY_UPGRADE_HOUR`)
- **Timezone**: Loaded from `~/zylos/.env` `TZ` field, falls back to `process.env.TZ`, then `UTC`
- **Persisted state**: `~/zylos/activity-monitor/daily-upgrade-state.json` (tracks last upgrade date)
- **Priority**: 3 (normal)
- **Gated by health**: Only enqueued when `health === 'ok'`
- **Gated by config**: Only enqueued when `daily_upgrade_enabled` is `true` in config
- **Once per day**: Checks local date to avoid duplicate enqueues

The control message instructs Claude to use the `upgrade-claude` skill, which handles idle detection, `/exit`, upgrade, and automatic restart.

## Context Monitoring

Event-driven context monitoring via Claude Code's statusLine feature, replacing the old hourly polling.

- **Mechanism**: `context-monitor.js` runs as a statusLine command — Claude Code pipes context data to it via stdin after every turn (zero turn cost)
- **Status file**: Writes `~/zylos/activity-monitor/statusline.json` with full context data (used_percentage, remaining_percentage, cost, session_id)
- **Three thresholds** (Claude):
  - **Early memory sync** at 80% of the new-session threshold (e.g. 40% when the threshold is 50%): Enqueues a prompt for Claude to run memory sync as a background task, so it completes well before the session switch. Only triggers when unsummarized conversation count exceeds the checkpoint threshold (30).
  - **New-session handoff (graceful)** at the new-session threshold (configurable via `new_session_threshold` (Claude) / `codex_new_session_threshold` (Codex) in config.json; when the key is absent the runtime applies a built-in fallback — Claude `70%`, Codex `75%`): Enqueues the new-session trigger. Priority 1, 5-minute cooldown. The agent runs the new-session skill, which writes a handoff summary and then enqueues `/clear` gated by `block-queue-until-idle`.
  - **Forced reset (hard ceiling)** at `hard_ceiling_threshold` (default `88%`, clamped strictly above the new-session threshold and below 100). The graceful `/clear` is `require_idle`, so a continuously-busy agent that never reaches sustained-idle would let context climb to 100% (lossy auto-compact). At the hard ceiling the monitor enqueues `/clear` **directly**, WITHOUT `require_idle`, so the reset cannot be starved. It re-asserts every `FORCED_REASSERT_SECONDS` (60s) while ≥ ceiling — on its own timer, independent of the graceful cooldown — to re-win c4-db's content-only supersede against a late require_idle `/clear`. When the session rotates (reset landed), it disarms so a fresh session isn't force-cleared on a stale high reading. Skips the in-conversation handoff (early memory sync at the lower band already persisted memory).
- **Delivery**: Enqueues via C4 control queue with bypass_state — ensures the trigger reaches Claude even during long tasks
- **Two-stage graceful design**: The graceful trigger message instructs Claude to start the new-session handoff flow; the actual `/clear` is gated by block-queue-until-idle in the new-session skill's final step. The forced reset bypasses both the skill and the idle gate.
- **Log**: `~/zylos/activity-monitor/context-monitor.log`

The early memory sync decouples memory sync from the session switch. Memory sync is also triggered by the new session's startup hook if unsummarized conversations exceed the threshold, so data is never lost.

## Daily Memory Commit

The activity monitor runs a daily git commit of the `memory/` directory.

- **Schedule**: 3:00 AM local time
- **Timezone**: Same as daily upgrade (from `~/zylos/.env` TZ)
- **One owner**: every instance's monitor has the task; the first to reach the hour creates that day's record `~/zylos/activity-monitor/daily-memory-commit/<date>.json` (exclusive create) and commits. The others find the record and do nothing, so the commit runs once a day while any monitor is up
- **Record**: `status` (`running`, then `ok` or `failed`), the instance that ran it, and `summary` (the script's output, first 500 characters). The last 30 days are kept
- **Script**: Calls `zylos-memory/scripts/daily-commit.js` directly (no C4, no Claude needed)
- **Once per day, also when it fails**: the next attempt is the next day
- **Idempotent**: If no memory changes exist, the script skips the commit
- **Left out and listed**: files over 50 MB (untracked ones stay untracked, later changes to tracked ones are not committed), and files or directories the monitor's user cannot read; the rest is committed (`Committed <sha> with N skipped.`)

## Timing Guarantees

Both daily tasks (upgrade, memory commit) use the same `DailySchedule` class:
- **Window**: Each target hour provides a ~3600s window; with ~1s loop interval it is virtually impossible to miss entirely
- **Dedup**: Date-based (`last_date === today`) ensures exactly-once per day, even with imprecise timing
- **Persistence**: State files survive activity monitor restarts

## Permission Prompts: Cancelled, Never Approved

Unattended sessions never answer a permission prompt with an approving key. `hook-auth-prompt.js` (the PermissionRequest hook) only logs the event to `hook-timing.log` (tool, input keys, `mode=` permission mode; never input values). It used to queue a `[KEYSTROKE]Enter` (`auto_approve_permission`, now without effect): on 2026-11-18 that Enter was queued for Claude Code 2.1.326's dangerous-command prompt about user-pan's own `rm -f $D/*` (asked even under `--dangerously-skip-permissions`) and would have selected "1. Yes" had the prompt been read correctly. The dispatcher sends nothing but Escape to a pane showing a permission prompt (comm-bridge SKILL.md, Session fence), and the dialog watch below cancels it.

A host that runs Claude without bypass mode now gets every ordinary permission prompt cancelled after 60 s (with a message to the session) instead of approved: tools that need approval do not run unattended there. Such a host needs bypass mode (`zylos` default) or allow rules in its Claude settings.

## Dialog Watch

`dialog-watch.js`, ticked by every Claude persona's monitor with the pane read it already makes each second (no extra tmux call). After 2026-11-18, when user-pan's own `rm -f $D/*` raised a dangerous-command prompt that nobody answered for 4 h 48 min while every message to Pan was held:

- **Permission prompt** (positively identified by `detectModal`: guide row last, numbered Yes/No options, question row, divider; with its `id`) on screen for 60 s: one plain `[KEYSTROKE]Escape`, queued in-process and bound out of band to that pane (`session_ref`) and that prompt (`dialog_ref`, migrations/005). The dispatcher sends it only while that very prompt is still on that pane, otherwise supersedes it (`DIALOG_GONE`).
- **One per prompt, decided by the database**: at most one Escape and one decline message exist per instance, pane and prompt, in any status (unique partial indexes, migrations/006; `insertDialogControl` returns the existing row instead of a second). The watch finds and withdraws its own rows by (instance, pane, prompt, kind) in SQL, never by an id it remembered. So an identical prompt that comes back in the same session gets no second Escape, only the alert.
- **Capability gate**: nothing is queued until the running `c4-dispatcher` (and, for an os_user-isolated persona, `c4-broker`) has published `dialog_ref` in `c4_process_capabilities`, which each does only after verifying the dialog-binding schema (migrations/005, 006). A row counts only while it is younger than 3 min and the process with its pid is running and started exactly at the published start time (from the operating system: a dead or reused pid does not count). Every insert the watch makes (Escape or decline) is authorized inside its own write transaction from the rows as they are then (`insertDialogControl({ requires })`); no cached answer authorizes anything, and only a refusal is remembered (10 s, observe-only). Until then, and on a database without that schema, the watch only observes and alerts ("没有发送 Esc"): it queues nothing and reads or saves no state. A mixed-version deploy, a withdrawn capability or a blocked migration never queues a bound row that a process would treat as an ordinary one.
- **Decline message**, once, only when certain: the Escape control is `done` and the prompt is gone. It quotes the prompt's title and notice rows (Claude Code's own text), says to rewrite the command as the prompt advised, and is bound the same way: a relaunched session never gets it (`SESSION_REPLACED`). An Escape still pending when the prompt closes by itself is withdrawn (`DIALOG_GONE`, pending rows only); a claimed one is waited for. A failed enqueue is not repeated.
- **Any other dialog** (`unknown`, the Fable guard's `fable_limit` / `credits_offer` / `usage_overlay`) gets no key.
- **Operator alert** (the degraded alert's direct admin send, `health-alert`), at most once an hour while the dialog lasts: when a dialog of any kind has held work for 5 min (every row waiting for that persona, inbound messages and controls, except the watch's own bound rows and ack-waiting controls: `getHeldWorkSummary`), or when a permission prompt is still on screen 5 min after its Escape went out (or was queued, if it never went out), even with nothing queued. Persona, kind, minutes, counts; the title row only for a permission prompt. Also once per backlog when work waits more than 10 min while the session is idle. A failed send is tried again a minute later.
- **Restarts**: what the queue cannot hold (prompt id or a hash of an unknown dialog's title, pane, first seen, next alert, the prompt's title and notice rows, unresolved declines) is kept in the service-owned table `dialog_watch_state` in `c4.db` (one row per instance, migrations/006), never in a persona-writable directory. On start it is a hint only: the key is rebuilt, times are clamped, Escape facts come from the queue, and the dialog must match the live pane. One Escape per prompt and one alert per hour hold across monitor restarts. Cleared once the dialog is gone. A save waits at most 250 ms for the write lock; a failed one is tried again 30 s later (logged once a minute).
- **Text left in the composer** (2026-11-19: an 80x24 window scrolled the composer past its prompt row; the dispatcher could not see its own paste and failed every message to user-pan, user-elaine and the scheduler for hours): the dispatcher never pastes over text in a composer and sends no key to clear it, so such text holds every paste for that persona (comm-bridge SKILL.md, Unverified paste). When work is waiting, the session is idle and the composer this monitor reads (`readTmuxInputState().inputState`) has not been `empty` for 60 s with no dialog on screen, the status shows `delivery_stuck` (cause `composer:has_content` or `composer:indeterminate`) and the operator gets one alert per episode saying how to free it (enlarge a small window; otherwise clear the composer, do not press Enter), without waiting for the 10-minute backlog below.
- **Status**: while work has waited more than 10 min and the session is idle or held by a dialog, `agent-status.json` shows `health: unavailable`, `unavailable_reason: delivery_stuck`, `delivery_stuck: { cause, pending, oldest_age_seconds }` instead of `ok` (only over an engine health of `ok`). The primary instance counts the untargeted rows it delivers. The dispatcher never holds delivery on this reason and a monitor never starts its health engine from it (`DELIVERY_STUCK_REASON` in `comm-bridge/scripts/c4-config.js`).

Logs and alerts carry ids, counts, kinds and ages; a dialog's title row only for a permission prompt; never message content or other pane rows.

## Log File

Activity log: `activity.log` in the instance's state directory (`~/zylos/activity-monitor/<instance>/`)
- Rotated daily (UTC) to `activity.log.<date>`; 30 days are kept, at most 20 MB of rotated logs per instance
- Logs state changes and guardian actions
