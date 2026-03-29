# Multi-Session Architecture — Status & Progress

**Date:** 2026-03-29
**Branch:** `xingfanxia/zylos-core feat/multi-session` (42 commits)

---

## Current System State

### Live Instances

| Instance | Type | Status | User | Auto-suspend |
|----------|------|--------|------|-------------|
| admin | dedicated (primary) | Running | AX | No |
| scheduler | dedicated | Running | System tasks | No |
| test | dedicated | Disabled | — | No |
| user-limh | dedicated | Running | 李萌慧 | Yes (30min) |
| user-pan | dedicated | Running | 潘潘 | Yes (30min) |

### What Works

- **Message routing**: Feishu DMs route to correct instance by chat_id
- **Instance isolation**: Each user gets own tmux session, own CC process, own memory state
- **Shared knowledge**: All instances share identity, references, product docs via `shared/`
- **Auto-provision flow**: Unknown user → hold messages → dashboard approve → instance created → messages released
- **Web dashboard**: Instance management, pending approvals, system health at `/dashboard/`
- **Memory guard**: PreToolUse hook prevents cross-instance memory writes
- **Heartbeat cold-start grace**: 60s warmup prevents CC kill loop on fresh start
- **Activity monitor**: Per-instance AM reads tmux_session and state_dir from instances.json
- **Disabled instance rejection**: Messages to disabled instances marked `rejected` in DB
- **DB-backed dedup**: Notification dedup uses DB, not fragile JSON files

### What Was Fixed During Live Testing

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Messages stuck as pending | Admin's `state_dir` in instances.json didn't match AM's write path | AM reads state_dir from instances.json |
| AM creates wrong tmux session | AM hardcoded `claude-${INSTANCE_ID}` instead of reading `tmux_session` | AM reads tmux_session from instances.json |
| AX's DM triggered auto-provision | AX's chat_id not in admin's `chat_ids` | Added AX's feishu ID to admin config |
| Approval notification not sent | `content` param not passed to `recordUnknownEndpoint()` | Fixed function signature |
| Dashboard pending users disappear on restart | Read from fragile JSON file | Dashboard reads directly from DB |
| New instance stuck at OAuth login | `CLAUDE_CONFIG_DIR` breaks CC auth (token bound to config dir) | Dropped CLAUDE_CONFIG_DIR, all instances share `~/.claude/` |
| Heartbeat kills CC on cold start | Heartbeat fires before CC finishes loading | 60s cold-start grace period in heartbeat engine |
| `health: recovering` blocks message delivery | Stale health state persisted across AM restarts | Cold-start grace resets health to `ok` |
| CLI import path wrong in deployed env | `../skills/` vs `../.claude/skills/` | Check both paths |
| PM2 restart kills all instances | `pm2 restart ecosystem.config.cjs` restarts everything | Use `pm2 start` for just the new AM process |
| Instance name input resets on dashboard | Auto-refresh re-renders while typing | Skip render when input is focused |

---

## Known Issues / TODOs

### P0 — Blocking user experience

1. **Dispatcher delivers too fast**: When multiple messages are requeued, dispatcher delivers them all in seconds without waiting for CC to go idle. CC queues them in input buffer instead of processing one at a time. Fix: always idle-gate conversation deliveries.

2. **Delivered messages lost on CC restart**: Dispatcher marks messages `delivered` when pasted into tmux. If CC crashes or restarts, those messages are gone — DB says delivered but CC never processed them. Fix: delivery confirmation via hook-activity ack.

### P1 — Should fix

3. **Auto-provision PM2 start**: `c4-approve.js` uses `execSync` with env prefix for PM2 — works but fragile. The dashboard approve endpoint calls it. Should use a more robust PM2 API.

4. **Notification routing to admin**: The `[Instance Approval Required]` notification goes to admin CC as a system message. Admin CC processes it but sometimes doesn't forward to AX (LLM interpretation). Dashboard approve button is the reliable path.

5. **`.credentials.json` symlink doesn't work**: CC doesn't follow symlinks for credentials. Must be copied. The `c4-approve.js` no longer sets `config_dir` so this is moot, but documented for future reference.

### P2 — Nice to have

6. **Token usage tracking**: DB exists but has 0 rows — token-tracker hasn't recorded data since the multi-session restarts. Will populate as instances process messages.

7. **Auto-suspend not tested**: `auto_suspend: true` and `idle_timeout_min: 30` are set on user instances but the suspend/resume cycle hasn't been tested end-to-end in production.

8. **Memory sync for user instances**: Each instance should run memory sync independently. Currently only the primary (admin) runs it. User instances accumulate conversation context but don't persist it to memory files yet.

9. **Group instances**: No group instances created yet. The architecture supports them (`type: group`, `on_demand: true`) but no group chat_ids are configured.

10. **Design doc outdated**: The design doc references `CLAUDE_CONFIG_DIR` isolation which was dropped. Should be updated to reflect shared `~/.claude/` approach.

---

## Architecture Summary (as deployed)

```
Message Flow:
  Feishu/Telegram → c4-receive.js → resolveInstance(endpoint) → DB (target_instance)
  → c4-dispatcher.js → resolveSessionName(instance) → tmux paste → CC processes → c4-send.js → user

Instance Provisioning:
  Unknown user → c4-receive holds as pending_approval → notification to admin
  → Dashboard approve button → c4-approve.js → create instance + release messages + start PM2

Memory Layout:
  ~/zylos/memory/
  ├── shared/ (identity, references, reference/) — all instances read
  ├── instances/<id>/ (state, sessions/) — per-instance, isolated
  └── users/<id>/ (profiles) — per-user

CC Config:
  All instances share ~/.claude/ (auth, settings, hooks, skills)
  Isolation via ZYLOS_INSTANCE_ID env var (memory, session-init, c4-fetch)

Process Model:
  Per instance: 1 activity-monitor PM2 process + 1 tmux session with CC
  Shared: 1 c4-dispatcher, 1 scheduler, 1 web-console, 1 feishu, 1 telegram
```
