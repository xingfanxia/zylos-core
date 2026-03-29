# Multi-Session Architecture Design

**Author:** Zylos (AI Engineering Agent)
**Date:** 2026-03-29
**Status:** APPROVED — AX review decisions incorporated
**Stakeholders:** AX (owner/CTO), team members (Elaine, Betty, 潘潘)

---

## 1. Executive Summary

### Problem

Zylos currently runs a single Claude Code (CC) instance that serves all users through one shared tmux session (`claude-main`). All inbound messages — from AX's engineering requests, Elaine's market research, Betty's content work, and 潘潘's teaching materials — funnel through one C4 dispatcher into one CC process. This creates four concrete problems: (1) slow responses when multiple users are active simultaneously, since CC processes messages sequentially; (2) context leakage, since CC sees all channels and can inadvertently reference one user's conversation when replying to another; (3) no parallel processing — a heavy background task (codebase analysis, deep research) blocks all other users; (4) accelerated context exhaustion, as multi-user traffic fills the 200K-token window faster, triggering more frequent session rotations.

### Proposed Solution

Introduce **per-user and per-group isolated CC instances**, each running in its own tmux session with its own activity monitor, state files, and conversation routing. The C4 comm-bridge gains an instance routing layer: `c4-receive.js` extracts the chat ID from the existing `endpoint_id` to determine the target instance — no changes to channel bots needed. The memory system is restructured into shared, per-instance, and per-user profile tiers. An instance registry (`~/zylos/instances.json`) declares which instances exist and how messages map to them.

All code changes are made in a fork of `zylos-ai/zylos-core` at `xingfanxia/zylos-core`. Channel bots (feishu, telegram) require zero modifications.

### Phased Rollout

| Phase | Scope | Key Changes | Status |
|-------|-------|-------------|--------|
| **Phase 0** | Foundation | Instance registry + DB schema migration. No behavior change. | In progress |
| **Phase 1** | Multi-instance | admin instance (always-on) + group instances (panpanmao, ghostwriter, shichuan). User instances created on-demand with admin approval. | In progress |
| **Phase 2** | Dynamic provisioning + dashboards | Per-instance CLAUDE.md. Web management dashboard (instance + telemetry). Token usage dashboard. | Future |
| **Phase 3** | Advanced | Auto-scaling, load-aware routing, cross-host instances. | Future |

AX-approved first step: Phase 1 with admin instance (always-on) + group instances for active groups. User instances are provisioned on-demand with admin approval — unknown user DMs route to admin, AX approves, instance is created. No pre-provisioned user instances; no shared team instance.

---

## 2. Architecture Overview

### Current Architecture (Single Instance)

```
  Feishu ──┐
  Telegram ┤                    ┌──────────────────────────┐
  Web ─────┼── c4-receive.js ──>│  c4.db (conversations)   │
  Shell ───┤                    │  (no target_instance)     │
  Scheduler┘                    └────────────┬─────────────┘
                                             │
                                     c4-dispatcher.js
                                     (single process)
                                             │
                                             v
                                  ┌─────────────────────┐
                                  │  tmux: claude-main   │
                                  │  ┌─────────────────┐ │
                                  │  │  Claude Code     │ │
                                  │  │  (all users)     │ │
                                  │  └─────────────────┘ │
                                  └─────────────────────┘
                                             │
                                   activity-monitor.js
                                   (single process)
                                             │
                              ~/zylos/activity-monitor/
                              agent-status.json (one file)
```

### Target Architecture (Multi-Instance)

```
  Feishu ──┐                                                    INSTANCE: admin (always-on)
  Telegram ┤                    ┌──────────────────────────┐   ┌──────────────────────────┐
  Web ─────┼── c4-receive.js ──>│  c4.db (conversations)   │   │  tmux: claude-admin       │
  Shell ───┤   + endpoint_id    │  + target_instance col   │──>│  ┌──────────────────────┐ │
  Scheduler┘   routing          └────────────┬─────────────┘   │  │  Claude Code (admin)  │ │
                                             │                 │  └──────────────────────┘ │
                                     c4-dispatcher.js          └──────────────────────────┘
                                     (routes by                            │
                                      target_instance)         activity-monitor-admin (PM2)
                                             │                             │
                                             │         ~/zylos/activity-monitor/admin/
                                             │
                                             │         PER-USER INSTANCES (auto-suspend after 30min)
                                             │         ┌──────────────────────────┐
                                             ├────────>│  tmux: claude-user-elaine │
                                             │         │  tmux: claude-user-betty  │
                                             │         │  tmux: claude-user-panpan │
                                             │         │  (each isolated context)  │
                                             │         └──────────────────────────┘
                                             │         activity-monitor-user-* (PM2)
                                             │
                                             │         GROUP INSTANCES (auto-suspend after 30min)
                                             │         ┌──────────────────────────┐
                                             ├────────>│  tmux: claude-group-*     │
                                             │         │  (panpanmao, ghostwriter, │
                                             │         │   shichuan)               │
                                             │         └──────────────────────────┘
                                             │         Auto-suspend after 30min idle;
                                             │         unknown users route to admin

                                   ┌─────────────────────────────────┐
                                   │       SHARED RESOURCES          │
                                   │  ~/zylos/memory/shared/         │
                                   │  ~/zylos/.env     (read-only)   │
                                   │  ~/zylos/comm-bridge/c4.db      │
                                   │  ~/zylos/workspace/  (repos)    │
                                   │  ~/.claude/skills/  (skills)    │
                                   └─────────────────────────────────┘
```

### Instance Types

| Type | Example | Use Case |
|------|---------|----------|
| **Dedicated** | `admin` | AX's primary instance — engineering, admin tasks, scheduler. Always-on. |
| **Per-user (on-demand)** | `user-elaine` | Created when admin approves a new user. Auto-suspend after 30min idle. Not pre-provisioned — instance is created on first approved interaction. |
| **Group** | `group-panpanmao` | Dedicated instance per active group chat. Auto-suspend after 30min idle. |

### Routing Principle

- **DMs** go to the **user's own instance** (admin for AX, user-elaine/user-betty/user-panpan for team members)
- **Group messages** go to the **group's instance** (each active group gets its own CC instance)
- **Unknown users** route to the **admin instance** — AX decides whether to approve and create a new instance for them (no automatic provisioning)
- **Disabled instances** (`enabled: false`) drop messages silently — messages are NOT rerouted to admin. Disabled instances should not pollute admin's context.
- All non-admin instances auto-suspend after 30 minutes of idle, releasing ~500MB RAM each; they auto-resume when a new message arrives (cold start ~5-10 seconds)

---

## 3. Instance Registry

### Registry File

**Path:** `~/zylos/instances.json`

This is the single source of truth for which instances exist and their configuration. All components (dispatcher, activity monitor, PM2 ecosystem, session-init) read from this file.

### Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "default_instance": { "type": "string" },
    "instances": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "tmux_session": { "type": "string" },
          "runtime": { "enum": ["claude", "codex"] },
          "enabled": { "type": "boolean" },
          "type": { "enum": ["dedicated", "group"], "description": "dedicated = per-user or admin (always-on or auto-suspend). group = per-group chat. No shared/team instance (AX decided per-user isolation)." },
          "chat_ids": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Raw endpoint IDs routed to this instance (e.g., 'ou_xxx', '123456789', 'oc_xxx'). These are the segment before the first '|' in the pipe-delimited endpoint_id."
          },
          "on_demand": {
            "type": "boolean",
            "description": "If true, instance is started on first message and shut down after idle_timeout"
          },
          "auto_suspend": {
            "type": "boolean",
            "description": "If true, activity-monitor stops the CC process after idle_timeout_min of idle, releasing ~500MB RAM. Dispatcher auto-starts CC when a new message arrives. Admin should be false (always-on). All other instances should be true."
          },
          "idle_timeout_min": {
            "type": "integer",
            "description": "Minutes of idle before auto-suspend (CC process stopped, memory released). Applicable when auto_suspend is true. Default: 30."
          },
          "claude_md": {
            "type": "string",
            "description": "Path to per-instance CLAUDE.md override file. Appended (not replacing) base ~/zylos/CLAUDE.md at session start. If empty/unset, falls back to convention path ~/zylos/instances/<id>/CLAUDE.md. Supports ~ expansion."
          },
          "state_dir": {
            "type": "string",
            "description": "Path to per-instance state directory"
          },
          "description": { "type": "string" }
        },
        "required": ["tmux_session", "runtime", "enabled", "type"]
      }
    },
    "scheduler_instance": {
      "type": "string",
      "description": "Dedicated instance for all system/scheduler messages. Keeps scheduler traffic out of admin's DM context. If unset, falls back to default_instance."
    },
    "routing": {
      "type": "object",
      "description": "chat_id -> instance_id mapping (overrides instance.chat_ids for fine-grained control)",
      "additionalProperties": { "type": "string" }
    }
  }
}
```

### Example: Phase 1 Configuration

```json
{
  "version": 1,
  "default_instance": "admin",
  "instances": {
    "admin": {
      "tmux_session": "claude-admin",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "primary": true,
      "auto_suspend": false,
      "chat_ids": [
        "ou_2619f0333713881523ed017979c12e08",
        "123456789"
      ],
      "state_dir": "~/zylos/activity-monitor/admin",
      "description": "AX dedicated instance (admin, engineering, scheduler). Always-on."
    },
    "user-elaine": {
      "tmux_session": "claude-user-elaine",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_elaine_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-elaine",
      "description": "Elaine's isolated instance — market research, content"
    },
    "user-betty": {
      "tmux_session": "claude-user-betty",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_betty_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-betty",
      "description": "Betty's isolated instance"
    },
    "user-panpan": {
      "tmux_session": "claude-user-panpan",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_panpan_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-panpan",
      "description": "潘潘's isolated instance — teaching materials"
    },
    "group-panpanmao": {
      "tmux_session": "claude-group-panpanmao",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_panpanmao_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-panpanmao",
      "description": "PanPanMao project group instance"
    },
    "group-ghostwriter": {
      "tmux_session": "claude-group-ghostwriter",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_ghostwriter_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-ghostwriter",
      "description": "Ghostwriter project group instance"
    },
    "group-shichuan": {
      "tmux_session": "claude-group-shichuan",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_shichuan_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-shichuan",
      "description": "ShiChuan project group instance"
    }
  },
  "routing": {
    "ou_2619f0333713881523ed017979c12e08": "admin",
    "123456789": "admin",
    "console": "admin",
    "ou_elaine_open_id": "user-elaine",
    "ou_betty_open_id": "user-betty",
    "ou_panpan_open_id": "user-panpan",
    "oc_panpanmao_group_id": "group-panpanmao",
    "oc_ghostwriter_group_id": "group-ghostwriter",
    "oc_shichuan_group_id": "group-shichuan"
  }
}
```

### Endpoint ID Format and Chat ID Extraction

Channel bots pass an `endpoint_id` to `c4-receive.js` using a **pipe-delimited** format. The instance router (`c4-instance-router.js`) extracts the **chat_id** by splitting on `|` and taking the first segment.

| Channel | endpoint_id format (pipe-delimited) | Extracted chat_id (before first `\|`) |
|---------|-------------------------------------|---------------------------------------|
| Feishu DM | `ou_2619f...\|feishu\|msg:om_xxx` | `ou_2619f...` |
| Feishu Group | `oc_8a648...\|feishu\|msg:om_xxx` | `oc_8a648...` |
| Telegram DM | `123456789\|telegram` | `123456789` |
| Telegram Group | `-987654321\|telegram` | `-987654321` |
| Web Console | `console` | `console` |
| Shell | `shell` | `shell` |
| Scheduler | (no endpoint, or null) | (falls to default_instance) |

**How `resolveInstance` works:**

```javascript
// c4-instance-router.js — resolveInstance(endpointId)
// 1. Split endpointId on "|", take first segment as chat_id
// 2. Look up chat_id in routing table (exact match)
// 3. Try full endpointId as routing key (for pipe-containing keys)
// 4. Scan instances[*].chat_ids[] for chat_id or full endpointId
// 5. Fall back to default_instance (admin)
// 6. Return null if no instances.json (legacy single-instance mode)
```

Note: The `routing` table and `chat_ids` arrays in `instances.json` use **raw endpoint IDs** (e.g., `ou_2619f...`, `123456789`, `oc_8a648...`) — not prefixed with `feishu::dm::` or similar. The channel type is already implicit in the ID format (Feishu open_ids start with `ou_`/`oc_`, Telegram IDs are numeric).

### Routing Resolution Order

```
1. routing[chat_id]              -> exact match (chat_id = first segment before "|")
2. routing[full_endpoint_id]     -> exact match on full pipe-delimited string
3. instances[*].chat_ids[]       -> scan instance chat_id lists for chat_id or full endpoint_id
4. default_instance              -> fallback (admin)
5. null                          -> legacy single-instance mode (no instances.json)
```

**Unknown user routing (Option B — confirmed by AX):** If a message arrives from a chat_id not in the routing table or any instance's chat_ids, it falls through to `default_instance` ("admin"). The admin instance (AX) sees the message and decides whether to approve creating a new per-user instance for that person. Instance provisioning is always admin-approved — never automatic. This prevents unbounded instance creation while ensuring no messages from unknown users are silently dropped.

---

## 4. C4 Comm-Bridge Changes

### 4.1 Database Schema Migration

```sql
-- Migration: 001_add_instance_routing.sql
-- Backward-compatible: NULL target_instance = legacy behavior

-- Add target_instance to conversations
ALTER TABLE conversations ADD COLUMN target_instance TEXT DEFAULT NULL;

-- Index for dispatcher query efficiency
CREATE INDEX idx_conversations_target_instance
  ON conversations(target_instance, status, priority);

-- Add target_instance to control_queue
ALTER TABLE control_queue ADD COLUMN target_instance TEXT DEFAULT NULL;

CREATE INDEX idx_control_queue_target_instance
  ON control_queue(target_instance, status, priority);
```

No data migration needed — existing rows have `target_instance = NULL`, which the dispatcher interprets as "deliver to default instance" for backward compatibility.

### 4.2 Instance Routing in c4-receive.js

**Current flow:** c4-receive.js validates input, inserts into `conversations` with no instance awareness. Channel bots already pass `endpoint_id` containing the chat/group ID.

**New flow:** After validation, before insertion, c4-receive.js extracts the chat ID from `endpoint_id` and resolves the target instance. No `--user-key` argument needed — the endpoint_id already contains the necessary information.

```javascript
// Module: c4-instance-router.js
// Loaded once at module init, watches instances.json for changes (fs.watchFile, 5s interval).
// Gracefully handles missing instances.json (returns null = legacy single-instance mode).

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

let config = null;    // parsed instances.json or null
let lastMtime = 0;

function loadConfig() { /* reads INSTANCES_FILE, parses JSON, updates config + lastMtime */ }

// Hot-reload on file change
fs.watchFile(INSTANCES_FILE, { interval: 5000 }, () => loadConfig());
loadConfig();

/**
 * Resolve an endpoint_id to an instance ID.
 *
 * Endpoint IDs are pipe-delimited strings from channel bots:
 *   "ou_2619f...|feishu|msg:om_xxx"  →  chat_id = "ou_2619f..."
 *   "123456789|telegram"             →  chat_id = "123456789"
 *   "oc_8a648...|feishu|msg:om_xxx"  →  chat_id = "oc_8a648..."
 *
 * Resolution order:
 *   1. routing[chat_id]            (first segment before "|")
 *   2. routing[full_endpointId]    (try full string as-is)
 *   3. instances[*].chat_ids[]     (scan for chat_id or full endpointId)
 *   4. default_instance            (fallback — "admin")
 *   5. null                        (no instances.json — legacy mode)
 *
 * @param {string} endpointId - Pipe-delimited endpoint string
 * @returns {string|null} Instance ID, or null in legacy mode
 */
export function resolveInstance(endpointId) {
  loadConfig(); // ensure fresh
  if (!config) return null;

  if (endpointId && config.routing) {
    const chatId = String(endpointId).split('|')[0];
    if (chatId && config.routing[chatId]) return config.routing[chatId];
    if (config.routing[endpointId]) return config.routing[endpointId];
  }

  if (endpointId && config.instances) {
    const chatId = String(endpointId).split('|')[0];
    for (const [instanceId, inst] of Object.entries(config.instances)) {
      if (Array.isArray(inst.chat_ids)) {
        if (inst.chat_ids.includes(chatId) || inst.chat_ids.includes(endpointId)) {
          return instanceId;
        }
      }
    }
  }

  return config.default_instance || null;
}
```

> **Note:** The implementation uses a single-argument signature `resolveInstance(endpointId)` — the channel is not needed because endpoint IDs are self-describing (Feishu IDs start with `ou_`/`oc_`, Telegram IDs are numeric). The design doc's original `resolveInstance(channel, endpointId)` two-argument signature was simplified during implementation.

**Change to c4-receive.js insertion:**

```javascript
// Before: insertConversation('in', channel, endpoint, content, 'pending', priority, requireIdle)
// After:
import { resolveInstance } from './c4-instance-router.js';

const targetInstance = resolveInstance(endpoint);  // single-arg: extracts chat_id from pipe-delimited endpoint

const record = insertConversation('in', channel, endpoint, dbContent, 'pending', priority, requireIdle, targetInstance);
```

### 4.3 No Channel Bot Changes Required

Channel bots (feishu, telegram) already pass `endpoint_id` to `c4-receive.js` containing the chat/group ID. The routing layer extracts this information from the existing `endpoint_id` field.

**No `--user-key` argument is needed.** The `endpoint_id` already distinguishes:
- DMs: `"feishu dm ou_xxx"` or `"telegram dm 123456789"`
- Groups: `"feishu group oc_xxx"` or `"telegram group -987654321"`

This means **zero changes to feishu/src/index.js or telegram/src/bot.js**.

### 4.4 Dispatcher: Multi-Instance Delivery

**Approach: Single dispatcher, multi-target delivery.**

The dispatcher continues as one PM2 process polling c4.db. The key change: instead of delivering to the hardcoded `TMUX_SESSION`, it reads `target_instance` from the claimed message and resolves the tmux session name from the instance registry.

```
c4-dispatcher poll loop (modified):
  1. Claim next pending item (prioritizing control_queue over conversations)
  2. Read target_instance from claimed row
  3. Resolve tmux session: instances.json[target_instance].tmux_session
  4. If instance is on_demand and not running: start it, wait for ready
  5. Read per-instance agent-status: instances.json[target_instance].state_dir + '/agent-status.json'
  6. State gate: check instance-specific health (not global)
  7. Deliver to resolved tmux session via tmux set-buffer + paste-buffer
  8. Verify delivery in the correct pane
```

**Changes to c4-config.js:**

```javascript
// REMOVE: the singleton TMUX_SESSION export
// export const TMUX_SESSION = _getActiveSessionName();  // <-- DELETE

// ADD: per-instance session resolution
import { readFileSync } from 'fs';

let _instances = null;

function _loadInstances() {
  try {
    const config = JSON.parse(readFileSync(
      path.join(ZYLOS_DIR, 'instances.json'), 'utf8'
    ));
    _instances = config;
    return config;
  } catch {
    // Fallback: legacy single-instance mode
    return null;
  }
}

export function getSessionForInstance(instanceId) {
  const config = _instances || _loadInstances();
  if (!config || !config.instances[instanceId]) {
    // Legacy fallback
    return _getActiveSessionName();
  }
  return config.instances[instanceId].tmux_session;
}

export function getStatusFileForInstance(instanceId) {
  const config = _instances || _loadInstances();
  if (!config || !config.instances[instanceId]) {
    return path.join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
  }
  const stateDir = config.instances[instanceId].state_dir.replace('~', os.homedir());
  return path.join(stateDir, 'agent-status.json');
}

export function getDefaultInstance() {
  const config = _instances || _loadInstances();
  return config?.default_instance || null;
}
```

**Changes to dispatcher claim query:**

```sql
-- Before:
SELECT * FROM conversations WHERE status='pending' ORDER BY priority, id LIMIT 1;

-- After (unchanged query — but post-claim logic reads target_instance):
-- The claim query stays the same. After claiming, the dispatcher reads:
--   row.target_instance → resolve session → deliver
-- NULL target_instance → use default_instance from registry → legacy behavior
```

### 4.5 Group Message Routing

Each active group gets its own CC instance. Group messages are routed by the group's chat ID, not by the sender's identity.

**Rule:** DMs route by user identity (who sent the DM). Group messages route by group identity (which group the message came from).

Rationale: A group instance maintains the full group conversation context. All participants in the same group talk to the same CC instance, which provides continuity and avoids fragmenting the group discussion across multiple instances.

This is naturally handled by the `endpoint_id` approach — `resolveInstance()` extracts the chat ID (first segment before `|`) from the pipe-delimited endpoint, and groups have a group-level ID (e.g., `oc_xxx`) while DMs have a user-level ID (e.g., `ou_xxx`). The routing table maps these raw IDs to instance IDs.

### 4.6 Auto-Suspend and Resume

All instances except admin have `auto_suspend: true` with `idle_timeout_min: 30`. This lifecycle applies:

1. **Instance is active:** CC process running in tmux, activity-monitor serving messages normally
2. **Idle for 30 minutes:** activity-monitor detects no new messages or API calls → stops the CC process (kills the tmux pane). The activity-monitor PM2 process itself stays running.
3. **Memory released:** ~500MB RAM freed per suspended instance
4. **New message arrives:** Dispatcher reads agent-status for the instance → detects CC is stopped → signals activity-monitor to start CC → message queued in c4.db (status remains `pending`)
5. **CC starts:** activity-monitor launches CC in the tmux session, sends session-init prompt
6. **Ready:** agent-status transitions to `idle` → dispatcher delivers the queued message
7. **Cold start time:** ~5-10 seconds

**On-demand group instances** additionally follow this lifecycle from first message:

1. **First message arrives** for a group instance that has never started
2. Dispatcher detects instance is not running (no tmux session, no CC process)
3. Dispatcher starts the AM process: `pm2 start activity-monitor-<id>`
4. AM process launches CC in the new tmux session
5. Dispatcher waits for agent-status to become ready, then delivers
6. Idle timer and auto-suspend rules apply from that point onward

**Admin instance** has `auto_suspend: false` — it is always-on and never suspended.

### 4.7 Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| `instances.json` missing | Everything works as before (single instance, legacy code paths) |
| `target_instance = NULL` in DB | Dispatcher delivers to `default_instance`, or falls back to `_getActiveSessionName()` |
| Old messages in DB (pre-migration) | All have `target_instance = NULL` — delivered normally |
| Unknown endpoint_id format | `resolveInstance()` returns `default_instance` |

**No breaking changes.** The system degrades gracefully to single-instance mode when `instances.json` is absent.

---

## 5. Activity Monitor Changes

### 5.1 Strategy: N Separate PM2 Processes

The activity monitor has 15+ module-level state variables, a singleton adapter, and singleton HeartbeatEngine — all tightly coupled to managing one agent. Refactoring to multi-instance within one process would require a deep rewrite of the core loop.

Instead: **run one `activity-monitor-<instance_id>` PM2 process per instance.** Each process manages exactly one CC session, maintaining the existing 1:1 relationship. The only changes are parameterization.

### 5.2 Parameterized Session Names and State Directories

Each activity-monitor process receives its instance ID via environment variable:

```bash
ZYLOS_INSTANCE_ID=admin  # or 'user-elaine', 'user-betty', 'user-panpan', 'group-panpanmao', etc.
```

**Changes to activity-monitor.js init():**

```javascript
// At module level:
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// In init():
function getMonitorDir() {
  if (INSTANCE_ID) {
    return path.join(ZYLOS_DIR, 'activity-monitor', INSTANCE_ID);
  }
  // Legacy: no instance ID → use root activity-monitor dir
  return path.join(ZYLOS_DIR, 'activity-monitor');
}

const MONITOR_DIR = getMonitorDir();
// Ensure directory exists
fs.mkdirSync(MONITOR_DIR, { recursive: true });

// All state file paths derived from MONITOR_DIR:
const STATUS_FILE     = path.join(MONITOR_DIR, 'agent-status.json');
const HEARTBEAT_FILE  = path.join(MONITOR_DIR, 'heartbeat-pending.json');
const API_ACTIVITY    = path.join(MONITOR_DIR, 'api-activity.json');
const HOOK_STATE      = path.join(MONITOR_DIR, 'hook-state.json');
const PROC_STATE      = path.join(MONITOR_DIR, 'proc-state.json');
const STATUSLINE      = path.join(MONITOR_DIR, 'statusline.json');
// ... etc
```

**Changes to RuntimeAdapter (claude.js):**

```javascript
// Before:
const SESSION = 'claude-main';

// After:
function getSessionName() {
  const instanceId = process.env.ZYLOS_INSTANCE_ID;
  if (instanceId) return `claude-${instanceId}`;
  return 'claude-main'; // legacy
}
const SESSION = getSessionName();
```

### 5.3 Per-Instance State Directory Layout

```
~/zylos/activity-monitor/
  admin/                         # AX's dedicated instance (always-on)
    agent-status.json
    heartbeat-pending.json
    api-activity.json
    hook-state.json
    proc-state.json
    statusline.json
    context-monitor-state.json
    health-check-state.json
    daily-upgrade-state.json
    daily-memory-commit-state.json
    usage.json
    pending-channels.jsonl
    user-message-signal.json
    activity.log
    claude-exit.log
  user-elaine/                   # Elaine's per-user instance (auto_suspend)
    agent-status.json
    ... (same structure)
  user-betty/                    # Betty's per-user instance (auto_suspend)
    agent-status.json
    ...
  user-panpan/                   # 潘潘's per-user instance (auto_suspend)
    agent-status.json
    ...
  group-panpanmao/               # Group instance (on-demand, auto_suspend)
    agent-status.json
    ... (same structure)
  group-ghostwriter/
    ...
  group-shichuan/
    ...
```

### 5.4 PM2 Ecosystem Changes

The ecosystem config reads `instances.json` and generates one activity-monitor process per enabled instance:

```javascript
// In ecosystem.config.cjs — replace single activity-monitor entry with:

function loadInstanceMonitors() {
  const instancesPath = path.join(ZYLOS_DIR, 'instances.json');
  try {
    const config = JSON.parse(fs.readFileSync(instancesPath, 'utf8'));
    return Object.entries(config.instances)
      .filter(([_, inst]) => inst.enabled && !inst.on_demand)
      .map(([id, inst]) => ({
        name: `activity-monitor-${id}`,
        script: path.join(SKILLS_DIR, 'activity-monitor', 'scripts', 'activity-monitor.js'),
        cwd: HOME,
        env: {
          PATH: ENHANCED_PATH,
          NODE_ENV: 'production',
          CLAUDE_BYPASS_PERMISSIONS,
          CODEX_BYPASS_PERMISSIONS,
          ZYLOS_INSTANCE_ID: id,
          ...(ZYLOS_PACKAGE_ROOT ? { ZYLOS_PACKAGE_ROOT } : {}),
        },
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
      }));
  } catch {
    // No instances.json — fall back to legacy single monitor
    return [{
      name: 'activity-monitor',
      script: path.join(SKILLS_DIR, 'activity-monitor', 'scripts', 'activity-monitor.js'),
      cwd: HOME,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production',
        CLAUDE_BYPASS_PERMISSIONS,
        CODEX_BYPASS_PERMISSIONS,
        ...(ZYLOS_PACKAGE_ROOT ? { ZYLOS_PACKAGE_ROOT } : {}),
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    }];
  }
}

// In apps array:
// REMOVE: the hardcoded activity-monitor entry
// ADD:
...loadInstanceMonitors(),
```

Note: `on_demand` instances (group instances) are NOT included in the ecosystem config — they are started dynamically by the dispatcher on first message. `auto_suspend: true` instances (user-elaine, user-betty, user-panpan) ARE included in the ecosystem config — their PM2 activity-monitor processes always run; only the CC process inside tmux is stopped/started on idle/resume.

### 5.5 Instance Lifecycle

| Operation | Implementation |
|-----------|---------------|
| **Create** | Add entry to `instances.json`, `mkdir -p` state dir, `pm2 start ecosystem --only activity-monitor-<id>` |
| **Start** | `pm2 start activity-monitor-<id>` — AM process auto-launches CC in tmux |
| **Stop** | `pm2 stop activity-monitor-<id>` — AM ceases; CC in tmux remains until killed |
| **Destroy** | `pm2 delete activity-monitor-<id>`, `tmux kill-session -t claude-<id>`, remove from `instances.json`, archive state dir |
| **Health** | Read `~/zylos/activity-monitor/<id>/agent-status.json` |
| **On-demand start** | Dispatcher calls `pm2 start` when first message arrives for a dormant on-demand instance |
| **Idle shutdown** | AM monitors last-activity timestamp; shuts down CC + itself after `idle_timeout_min` |

### 5.6 Claude Code Hook Changes

Claude Code hooks (`hook-activity.js`, `context-monitor.js`) write state files. In multi-instance, each CC session runs its own hooks. The hooks need to write to the correct per-instance directory.

**Propagation mechanism:** The activity monitor launches Claude Code inside a tmux session. It already passes environment variables via `tmux new-session -d -s <session> -e KEY=VALUE`. Add `ZYLOS_INSTANCE_ID` to the tmux environment:

```javascript
// In claude.js launch():
const env = [
  `-e ZYLOS_INSTANCE_ID=${process.env.ZYLOS_INSTANCE_ID || ''}`,
  // ... existing env vars
];
execSync(`tmux new-session -d -s ${SESSION} ${env.join(' ')} ...`);
```

Hooks read `ZYLOS_INSTANCE_ID` to resolve their state directory:

```javascript
// hook-activity.js:
const instanceId = process.env.ZYLOS_INSTANCE_ID;
const stateDir = instanceId
  ? path.join(ZYLOS_DIR, 'activity-monitor', instanceId)
  : path.join(ZYLOS_DIR, 'activity-monitor');
const API_ACTIVITY_FILE = path.join(stateDir, 'api-activity.json');
```

### 5.7 Daily Tasks: Run Once, Not Per-Instance

Daily tasks (memory commit, upgrade, upgrade check) should run once globally, not per-instance. Options:

**Approach: Elect a primary instance.**

```json
{
  "instances": {
    "admin": { "primary": true, ... },
    "user-elaine": { "primary": false, ... }
  }
}
```

Only the AM process for the primary instance runs daily tasks. Others skip them. If the primary is disabled, fallback to the first enabled instance.

---

## 6. Memory Architecture

### 6.1 Directory Structure

The memory system is restructured into three tiers: shared (cross-instance), per-instance (keyed by instance_id), and per-user profiles (pre-existing, for user preferences only).

**Only `shared/` exists upfront** — it holds the current flat structure (identity, references, decisions) migrated into a subdirectory. `instances/<instance_id>/` directories are **created by the migration script** or on demand when an instance first starts.

```
memory/
  shared/                        # Cross-instance shared knowledge (exists upfront)
    identity.md                  # Bot personality, principles, digital assets
    references.md                # Pointers to config files, key paths
    products/                    # Product profiles (panpanmao, miolumi, etc.)
    reference/                   # Shared knowledge base
      decisions.md               # Deliberate choices that close off alternatives
      projects.md                # Work efforts with defined scope
      preferences.md             # Standing instructions (shared across users)
      ideas.md                   # Uncommitted plans, explorations

  instances/
    <instance_id>/               # Per-instance (keyed by instance_id)
      state.md                   # Instance's pending tasks, active work
      sessions/
        current.md               # Instance's event log

  users/
    <id>/                        # Per-user profiles (pre-existing, unchanged)
      profile.md                 # User preferences, communication style

  archive/                       # Cold storage for old data (unchanged)
```

### 6.2 Instance ID as Memory Key

Instances are identified by their instance_id from `instances.json` (e.g., `admin`, `user-elaine`, `group-panpanmao`). Each instance's state and session logs live under `memory/instances/<instance_id>/`.

This is decoupled from the routing layer: the routing layer maps chat_ids to instances, while the memory layer uses instance_ids directly. This allows multiple chat_ids to map to the same instance (and therefore the same memory partition).

### 6.3 Read Path

All CC instances share `~/zylos/memory/` via the filesystem. Reads are naturally concurrent. Backward-compatible symlinks at the memory root (e.g., `identity.md -> shared/identity.md`, `state.md -> instances/<id>/state.md`) allow existing code to read via the original flat paths.

- **Shared tier:** All instances load `shared/identity.md`, `shared/references.md` at session start, and read `shared/reference/*.md` on demand
- **Instance tier:** Each instance reads `instances/<instance_id>/state.md` and `instances/<instance_id>/sessions/current.md` for its own state
- **User tier:** An instance reads `users/<id>/profile.md` when interacting with that user

### 6.4 Write Contention

Per-instance state and session logs eliminate 90% of write contention. Each instance writes only to its own `instances/<instance_id>/` memory partition.

| File | Risk Level | Mitigation |
|------|------------|------------|
| `instances/<id>/state.md` | **NONE** — only that instance writes | Natural isolation |
| `instances/<id>/sessions/current.md` | **NONE** — per-instance event log | Natural isolation |
| `users/<id>/profile.md` | **LOW** — written only when interacting with that user | Single-writer in practice |
| `shared/identity.md` | **LOW** — rarely written | No change |
| `shared/reference/*.md` | **MEDIUM** — shared knowledge base | Primary instance writes |

**Phase 1 strategy: Partition + primary-writer.**

- Per-instance state and session logs are naturally isolated (no contention)
- `shared/reference/*.md` and `shared/identity.md`: only the primary instance (admin) writes to shared state files
- No file locking for Phase 1 — the partitioned structure eliminates the need

### 6.5 Memory Sync in Multi-Instance

Memory Sync (zylos-memory skill) processes conversations from c4.db and creates checkpoints.

**Recommended for Phase 1:** Single global Memory Sync triggered by the primary instance (admin). It processes all conversations across all instances and writes to the appropriate memory tier (shared, user, or group).

### 6.6 CLAUDE.md: Shared vs Per-Instance

`~/zylos/CLAUDE.md` contains identity, behavioral rules, project routing, and engineering processes. Most of this is shared across all instances — it is the bot's "soul."

**For Phase 1:** All instances share the same `CLAUDE.md`. This is correct because the bot personality and capabilities are identical regardless of which instance handles the message.

**Per-instance CLAUDE.md (implemented):** A layered approach with per-instance overrides, enabling tailored instructions per instance. E.g., Betty's instance gets persona-specific guidance; a group instance gets project-specific context.

```
~/zylos/CLAUDE.md                              # Shared base (identity, rules, skills)
~/zylos/instances/admin/CLAUDE.md             # Admin-specific overrides (optional)
~/zylos/instances/user-<name>/CLAUDE.md       # Per-user overrides (optional)
```

Override files append to (not replace) the base. Injected at session start via `session-start-inject.js` as an `=== INSTANCE INSTRUCTIONS ===` section. Resolution order:
1. Explicit path from `claude_md` field in `instances.json` (supports `~` expansion)
2. Convention path: `~/zylos/instances/<id>/CLAUDE.md`

If neither exists, no override is injected (backward-compatible).

---

## 7. Per-Instance Configuration

### 7.1 What Each Instance Needs

| Resource | Shared or Per-Instance | Notes |
|----------|----------------------|-------|
| tmux session | Per-instance | `claude-<instance_id>` |
| CLAUDE.md | Shared (Phase 1) | Same bot identity |
| .env | Shared | Same API keys, same Anthropic account |
| Memory shared tier | Shared | `~/zylos/memory/shared/` |
| Memory instance tier | Per-instance | Each instance writes its own `instances/<id>/` partition |
| Skills (`~/.claude/skills/`) | Shared | Same capabilities |
| Workspace (`~/zylos/workspace/`) | Shared | Same repos |
| Activity-monitor state | Per-instance | `~/zylos/activity-monitor/<id>/` |
| Claude projects dir | Per-instance (see below) | Conversation history isolation |
| c4.db | Shared | Single message queue |

### 7.2 Per-Instance Config Isolation via CLAUDE_CONFIG_DIR (CONFIRMED)

Claude Code stores all config, conversation history, and project data under `~/.claude/`. Without isolation, all instances would share this directory — conversations would leak across instances.

**Solution (confirmed by AX):** `CLAUDE_CONFIG_DIR` environment variable (verified supported in CC source code). This is the chosen isolation method — not symlinks, not cwd tricks.

Each instance gets its own config directory:

```
admin:              CLAUDE_CONFIG_DIR=~/.claude              (default, preserves existing data)
user-elaine:        CLAUDE_CONFIG_DIR=~/.claude-instances/user-elaine
user-betty:         CLAUDE_CONFIG_DIR=~/.claude-instances/user-betty
user-panpan:        CLAUDE_CONFIG_DIR=~/.claude-instances/user-panpan
group-panpanmao:    CLAUDE_CONFIG_DIR=~/.claude-instances/group-panpanmao
group-ghostwriter:  CLAUDE_CONFIG_DIR=~/.claude-instances/group-ghostwriter
group-shichuan:     CLAUDE_CONFIG_DIR=~/.claude-instances/group-shichuan
```

Activity-monitor passes this env var when launching CC in tmux:

```javascript
// In claude.js launch():
const configDir = instance.config_dir || path.join(os.homedir(), '.claude');
execSync(`tmux new-session -d -s ${SESSION} -e CLAUDE_CONFIG_DIR=${configDir} ...`);
```

**Benefits:**
- Complete conversation/project isolation per instance
- ccusage reads per-directory → natural per-user token tracking
- admin keeps `~/.claude` (backward compatible, zero migration)
- No symlinks needed, no cwd tricks

### 7.3 Instance Directory Structure

```
~/zylos/
  instances.json                    # Instance registry
  instances/
    admin/                          # Per-instance working directory (if needed)
      CLAUDE.md -> ../../CLAUDE.md  # Symlink to shared
    user-elaine/
      CLAUDE.md -> ../../CLAUDE.md
    user-betty/
      CLAUDE.md -> ../../CLAUDE.md
    user-panpan/
      CLAUDE.md -> ../../CLAUDE.md
    group-panpanmao/
      CLAUDE.md -> ../../CLAUDE.md
    group-ghostwriter/
      CLAUDE.md -> ../../CLAUDE.md
    group-shichuan/
      CLAUDE.md -> ../../CLAUDE.md
  activity-monitor/
    admin/                          # Per-instance AM state (always-on)
      agent-status.json
      ...
    user-elaine/                    # Per-user AM state (auto_suspend)
      agent-status.json
      ...
    user-betty/
      agent-status.json
      ...
    user-panpan/
      agent-status.json
      ...
    group-panpanmao/
      agent-status.json
      ...
  memory/
    shared/                         # Cross-instance shared knowledge
      identity.md
      references.md
      products/
      reference/
    instances/
      <instance_id>/                # Per-instance state and sessions
        state.md
        sessions/current.md
    users/
      <id>/                         # Per-user profiles (pre-existing, unchanged)
        profile.md
    archive/                        # Cold storage (unchanged)
```

---

## 8. Message Routing Rules

### 8.1 DM Routing

```
User sends DM → Channel bot passes endpoint_id (e.g., "ou_xxx|feishu|msg:om_yyy")
  → c4-receive.js calls resolveInstance("ou_xxx|feishu|msg:om_yyy")
  → resolveInstance splits on "|", extracts chat_id = "ou_xxx"
  → checks:
      1. routing["ou_xxx"]              →  "admin" / "user-elaine" / etc (exact match)
      2. instances[*].chat_ids          →  scan for "ou_xxx"
      3. default_instance               →  "admin"  (unknown users land here)
  → INSERT INTO conversations (..., target_instance = 'user-elaine')
  → Dispatcher delivers to tmux: claude-user-elaine
  → If instance is auto_suspend and CC process is stopped:
      dispatcher detects stopped → activity-monitor auto-starts CC → message queued in c4.db until ready
      Cold start ~5-10 seconds, then delivery proceeds normally
```

**Unknown user example:**
```
Unknown user sends DM → endpoint_id = "ou_unknown|feishu|msg:om_zzz"
  → resolveInstance extracts chat_id = "ou_unknown" → not in routing table or chat_ids
  → falls through to default_instance = "admin"
  → AX sees message in admin instance, decides: create user-xxx instance or handle directly
```

### 8.2 Group Message Routing

```
User @mentions bot in group → Channel bot passes endpoint_id (e.g., "oc_xxx|feishu|msg:om_yyy")
  → c4-receive.js calls resolveInstance("oc_xxx|feishu|msg:om_yyy")
  → resolveInstance splits on "|", extracts chat_id = "oc_xxx"
  → checks routing["oc_xxx"] or instances[*].chat_ids for "oc_xxx"
  → Routes to group's dedicated instance (e.g., group-panpanmao)
  → If instance is on_demand and not running: dispatcher starts it
  → Delivers to tmux: claude-group-panpanmao
```

All participants in the same group talk to the same CC instance. The group instance maintains full group conversation context.

### 8.3 Control Messages

| Control Type | Routing |
|-------------|---------|
| **Heartbeat** | Per-instance. Each AM enqueues heartbeats for its own instance with `target_instance` set. |
| **Health check** | Per-instance. Each AM triggers its own health check. |
| **Memory Sync** | Primary instance only (admin). |
| **New session** | Per-instance. Context rotation is instance-local. |
| **Upgrade** | Primary instance only. Upgrade affects the CC binary, not the session. |

### 8.4 Scheduler Tasks

Scheduler tasks are independent — they are not inherently tied to a specific instance.

**Phase 1:** Scheduler/system messages route to a dedicated `scheduler_instance` field in `instances.json`, keeping scheduler traffic out of admin's DM conversation context. If `scheduler_instance` is not set, falls back to `default_instance` ("admin"). This is already implemented.

```javascript
// c4-receive.js system channel routing:
let targetInstance = resolveInstance(endpoint);  // null for system (no endpoint)
if (targetInstance === null && (channel === 'system' || channel === 'scheduler')) {
  targetInstance = getSchedulerInstance() || getDefaultInstance();  // → scheduler_instance or "admin"
}
```

**Phase 2:** Add `--target-instance` flag to scheduler CLI:

```javascript
// When scheduling:
cli.js add "Review Elaine's document" --in "15min" --target-instance user-elaine

// Stored in scheduler DB:
{ target_instance: 'user-elaine', ... }

// At dispatch time:
sendViaC4(content, { targetInstance: task.target_instance || 'admin' });
```

### 8.5 Web Console

The web console binds to the admin instance. It's a simple, clean routing — AX is the only web console user.

```json
{
  "routing": {
    "console": "admin"
  }
}
```

### 8.6 Fallback: Target Instance Down

When the dispatcher claims a message and discovers the target instance is unhealthy:

```
1. Read agent-status from target instance's state_dir
2. If instance is on_demand:
   a. Start the instance (pm2 start activity-monitor-<id>)
   b. Wait for agent-status to become ready
   c. Deliver
3. If state = offline/stopped AND health != ok:
   a. Requeue message (set status back to 'pending')
   b. The target AM process will restart CC (normal recovery flow)
   c. Dispatcher will retry on next poll cycle
4. If instance is disabled in registry (enabled: false):
   a. Drop/reject the message silently (do NOT reroute to admin)
   b. Mark message status as 'rejected' in DB
   c. Log the drop (disabled instances should not pollute admin's context)
5. If all instances are down:
   a. Requeue with backoff (existing retry mechanism)
```

---

## 9. Security & Isolation

### 9.1 Context Isolation

**CRITICAL REQUIREMENT:** Instances MUST NOT see each other's conversation history.

Enforcement points:

| Layer | Isolation Mechanism |
|-------|-------------------|
| **tmux sessions** | Separate tmux sessions = separate stdin/stdout. No cross-contamination. |
| **c4-session-init** | Modified to filter by `target_instance`: only inject conversations belonging to this instance. |
| **Conversation DB** | `target_instance` column enables filtered queries. |
| **CLAUDE.md** | Shared identity is fine — it contains no user-specific conversation data. |
| **Memory files** | Shared tier is bot knowledge. User/group tiers are naturally isolated. |

**c4-session-init.js changes:**

```javascript
// c4-session-init.js reads ZYLOS_INSTANCE_ID and uses instance-aware DB helpers:
const ZYLOS_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// When ZYLOS_INSTANCE_ID is set, filter conversations to only those
// targeting this instance (or legacy NULL target_instance):
const range = ZYLOS_INSTANCE_ID
  ? getUnsummarizedRangeForInstance(ZYLOS_INSTANCE_ID)
  : getUnsummarizedRange();

const conversations = ZYLOS_INSTANCE_ID
  ? getUnsummarizedConversationsForInstance(ZYLOS_INSTANCE_ID, limit)
  : getUnsummarizedConversations(limit);
// Underlying SQL: WHERE (target_instance = ? OR target_instance IS NULL)
```

### 9.2 Memory Isolation

Per-instance state and sessions (`memory/instances/<instance_id>/`) are naturally isolated — each instance reads and writes only its own partition. The memory-guard hook enforces this at the filesystem level: non-primary instances are blocked from writing to `shared/`, and any instance is blocked from writing to another instance's `instances/<other_id>/` directory.

Shared state files (`shared/reference/*.md`) are intentionally shared. This is correct: if AX creates a project decision in the admin instance, user instances should see it too.

**Risk:** An instance could inadvertently write user A's preferences into shared memory (e.g., `shared/reference/preferences.md`). Mitigation: the memory classification rules in CLAUDE.md direct user-specific prefs to `users/<id>/profile.md`, and the memory-guard hook provides runtime enforcement. User profile directories (`memory/users/<id>/`) are writable by any instance since any instance may interact with any user.

### 9.3 Credential Sharing

All instances share `~/zylos/.env` (API keys, bot tokens, Anthropic credentials). This is correct for Phase 1 — all instances use the same Anthropic plan and the same bot accounts.

**Future consideration (Phase 3):** If instances run on different hosts or different API plans, per-instance `.env` overrides would be needed. The instance registry could include an `env_overrides` field.

---

## 10. Per-User Token Usage Tracking

### 10.1 Motivation

Multiple CC instances burn through the Anthropic plan faster. AX needs visibility into which users and groups are consuming the most tokens to manage costs and capacity.

### 10.2 Data Source

`hook-activity.js` already captures API call data per instance in `api-activity.json`. In multi-session, each instance writes to its own `~/zylos/activity-monitor/<instance_id>/api-activity.json`. This provides per-instance token data that can be attributed to users/groups via the routing table.

### 10.3 Database Schema

Token usage is stored in a **separate SQLite database** at `~/zylos/activity-monitor/token-usage.db` (not in `c4.db`). This avoids lock contention — token writes happen frequently from activity-monitor hooks, while c4.db is used by the dispatcher and receiver.

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,        -- which instance served this user/group
  date TEXT NOT NULL,               -- YYYY-MM-DD
  chat_id TEXT,                     -- routing chat_id (e.g., "ou_xxx"); NULL for legacy/unrouted
  model TEXT,                       -- model name (e.g., "claude-sonnet-4-20250514")
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,         -- cost in USD (float; sufficient precision for reporting)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(instance_id, date)         -- one row per instance per day, upserted
);

CREATE INDEX IF NOT EXISTS idx_token_usage_instance_date
  ON token_usage (instance_id, date);
```

> **Design note:** The original design specified `total_cost_cents INTEGER` (integer cents) in c4.db. The implementation uses `cost_usd REAL` in a separate DB. Float USD is pragmatic for reporting (sub-cent precision matters at scale; integer cents truncate). The separate DB avoids c4.db write amplification. The `chat_id` column enables per-user attribution when populated via the routing table lookup; it is nullable for backward compatibility with pre-routing data.

### 10.4 Data Collection

Each activity-monitor instance periodically reads its `api-activity.json` and writes aggregated daily totals into the `token_usage` table:

```javascript
// In activity-monitor, runs every 5 minutes:
function syncTokenUsage() {
  const instanceId = process.env.ZYLOS_INSTANCE_ID;
  const apiActivity = readJSON(path.join(MONITOR_DIR, 'api-activity.json'));

  // Determine which chat_id this instance serves
  // For dedicated/shared: resolve from instances.json
  // For group: the group's chat_id
  const chatIds = getChatIdsForInstance(instanceId);

  const today = new Date().toISOString().split('T')[0];

  for (const chatId of chatIds) {
    db.prepare(`
      INSERT INTO token_usage (date, chat_id, instance_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, chat_id, instance_id) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_cost_cents = excluded.total_cost_cents
    `).run(today, chatId, instanceId, ...tokenCounts);
  }
}
```

### 10.5 Aggregation Views

```sql
-- Daily usage per user/group
SELECT chat_id, date,
  SUM(input_tokens) as total_input,
  SUM(output_tokens) as total_output,
  SUM(total_cost_cents) as total_cost
FROM token_usage
WHERE date = '2026-03-29'
GROUP BY chat_id, date;

-- Weekly usage per user/group
SELECT chat_id,
  SUM(input_tokens) as total_input,
  SUM(output_tokens) as total_output,
  SUM(total_cost_cents) as total_cost
FROM token_usage
WHERE date >= date('now', '-7 days')
GROUP BY chat_id;

-- Monthly usage per instance
SELECT instance_id,
  SUM(input_tokens) as total_input,
  SUM(output_tokens) as total_output,
  SUM(total_cost_cents) as total_cost
FROM token_usage
WHERE date >= date('now', 'start of month')
GROUP BY instance_id;
```

### 10.6 Reporting

**On-demand reports (Phase 1):** Admin asks "show me token usage" and gets a report generated from the token-usage DB. No scheduled email blasts — reporting is pull-based.

**Web dashboard (Phase 2):** Part of the web management dashboard. Per-user daily/weekly/monthly charts + aggregation tables. Reads from existing data sources: activity-monitor state files + token-tracker DB + `pm2 jlist`. Lightweight — no OpenTelemetry needed.

---

## 11. Fork & Distribution Strategy

### 11.1 Fork Approach

All multi-session changes are made in a fork of the zylos-core package:

- **Upstream:** `zylos-ai/zylos-core` (community/official)
- **Fork:** `xingfanxia/zylos-core` (AX's customized version)

Changes are concentrated in two skills within the fork:
- `comm-bridge` — instance routing, dispatcher multi-target delivery
- `activity-monitor` — parameterized session names, state directories, ecosystem config

### 11.2 Installation

```bash
# Install from fork instead of upstream
npm install -g github:xingfanxia/zylos-core
```

### 11.3 Self-Upgrade Changes

The `self-upgrade.js` script needs its `REPO` constant updated to point to the fork:

```javascript
// Before:
const REPO = 'zylos-ai/zylos-core';

// After:
const REPO = 'xingfanxia/zylos-core';
```

### 11.4 Auto-Merge Upstream

To stay current with upstream improvements while maintaining fork customizations:

```bash
# zylos upgrade --self now includes upstream merge
zylos upgrade --self
```

This command:
1. Fetches latest from `zylos-ai/zylos-core` (upstream)
2. Merges upstream changes into the fork
3. If conflicts arise, CC resolves them automatically
4. Pushes resolved merge to `xingfanxia/zylos-core`
5. Installs the updated fork

---

## 12. Phased Implementation Plan

### Phase 0: Foundation (No behavior change)

**Goal:** Ship all schema and config changes. System behavior is unchanged — everything routes to the single existing instance.

| Task | Files | Effort |
|------|-------|--------|
| Fork `zylos-ai/zylos-core` → `xingfanxia/zylos-core` | GitHub | 5 min |
| Create `~/zylos/instances.json` with single instance `main` | New file | 5 min |
| Add `c4-instance-router.js` module (reads instances.json, extracts chat_id from endpoint_id) | New file in comm-bridge/scripts/ | 30 min |
| DB migration: add `target_instance` to conversations + control_queue + `token_usage` table | SQL migration script | 20 min |
| Modify c4-receive.js to call `resolveInstance()` using endpoint_id (no new CLI args) | comm-bridge/scripts/c4-receive.js | 30 min |
| Modify c4-config.js to export `getSessionForInstance()` alongside legacy `TMUX_SESSION` | comm-bridge/scripts/c4-config.js | 20 min |
| Add `ZYLOS_INSTANCE_ID` env var reading to activity-monitor (no-op if not set) | activity-monitor/scripts/activity-monitor.js | 20 min |
| Update self-upgrade.js REPO constant to fork | self-upgrade.js | 5 min |
| Tests: verify null target_instance = legacy behavior | Test scripts | 30 min |

**Validation:** System runs exactly as before. `instances.json` exists but isn't yet used for routing. DB has new column but all values are NULL.

### Phase 1: Multi-Instance

**Goal:** admin instance for AX (always-on), group instances for active groups (on-demand + auto_suspend). User instances created on-demand with admin approval (not pre-provisioned).

| Task | Files | Effort |
|------|-------|--------|
| Update `instances.json` with admin + group instances (user instances created on-demand via admin approval) | instances.json | 10 min |
| Wire c4-receive.js to call `resolveInstance()` and set `target_instance` on insert | c4-receive.js | 30 min |
| Modify dispatcher to read `target_instance`, resolve tmux session | c4-dispatcher.js | 1 hour |
| Modify dispatcher to read per-instance agent-status | c4-dispatcher.js | 30 min |
| Add on-demand instance start/stop logic to dispatcher | c4-dispatcher.js | 1 hour |
| Create per-instance state directories | mkdir script | 5 min |
| Parameterize activity-monitor paths with `ZYLOS_INSTANCE_ID` | activity-monitor.js, claude.js | 1 hour |
| Parameterize hook-activity.js and context-monitor.js | hook-activity.js, context-monitor.js | 30 min |
| Update ecosystem.config.cjs to generate per-instance AM processes (excluding on_demand) | ecosystem.config.cjs | 30 min |
| Modify c4-session-init.js to filter by `target_instance` | c4-session-init.js | 30 min |
| Modify session-start-prompt.js to set `ZYLOS_INSTANCE_ID` env | session-start-prompt.js | 15 min |
| Restructure memory into shared/users/groups tiers | memory migration script | 1 hour |
| Scheduler: hardcode `--target-instance admin` in C4 dispatch | scheduler/scripts/runtime.js | 10 min |
| Web console: route to admin instance | instances.json routing | 5 min |
| End-to-end test: send DM as AX → verify delivery to claude-admin | Manual test | 30 min |
| End-to-end test: send DM as Elaine → verify delivery to claude-user-elaine | Manual test | 30 min |
| End-to-end test: send group message → verify delivery to group instance | Manual test | 30 min |
| Heartbeat test: all instances have independent health | Manual test | 15 min |
| Token usage tracking: DB schema + collection in hook-activity.js (see Section 10) | c4.db migration, hook-activity.js | 1 hour |
| Token usage: on-demand report (admin asks → gets report) | admin command handler | 30 min |
| Disabled instance handling: dispatcher drops messages for `enabled: false` (no reroute) | c4-dispatcher.js | 15 min |

**Estimated total: ~10.5 hours of implementation work**

**Deployment sequence:**
1. Deploy Phase 0 changes (no behavior change)
2. Run system for 24h to verify stability
3. Restructure memory directories
4. Update `instances.json` to Phase 1 config (admin + group instances; user instances created on-demand via admin approval)
5. `pm2 delete activity-monitor` (remove legacy)
6. `pm2 start ecosystem.config.cjs` (starts AM-admin; group instances are on-demand; user instances are created when admin approves)
7. AM-admin auto-launches CC in tmux (always-on); group and user instances start on first message
8. Monitor all instances for 1 hour
9. Declare Phase 1 live

### Phase 2: Dashboards + Dynamic Provisioning (FUTURE — not implemented)

**Goal:** Web management dashboard, token usage dashboard, admin-approved instance provisioning flow, per-instance CLAUDE.md, scheduler `--target-instance`.

| Task | Description |
|------|-------------|
| Web management dashboard | Instance list, start/stop/create/delete, telemetry (CPU, memory, uptime per instance). Reads from activity-monitor state files + pm2 jlist. No OpenTelemetry. |
| Token usage dashboard | Per-user daily/weekly/monthly charts + aggregation tables. Reads from token-tracker DB. Part of the web management dashboard. |
| Admin approval flow for new users | Unknown DM → admin notification → approve/deny → auto-create instance. Replaces manual `instances.json` editing. |
| Instance management CLI | `zylos instance create <id> --chat-id "ou_xxx" --type dedicated` |
| Dynamic PM2 process management | Create/destroy AM processes without restarting PM2 |
| ~~Per-instance CLAUDE.md customization~~ | **DONE.** Layered CLAUDE.md (base + overrides). Injected via `session-start-inject.js`. Resolution: `claude_md` field > convention path `~/zylos/instances/<id>/CLAUDE.md`. |
| Instance pool limits | Max concurrent instances (CPU/memory gating) |
| Scheduler `--target-instance` flag | Tasks can specify which instance handles them |
| Instance migration | Move user between instances (e.g., shared → dedicated) |

### Phase 3: Advanced (FUTURE — not implemented)

| Task | Description |
|------|-------------|
| Auto-scaling | Spin up instances on demand, scale down when idle |
| Cross-host instances | Move CC to different machines (requires remote tmux or containerization) |
| Context-aware routing | Route to instance that already has relevant context loaded |
| Load balancing | Distribute users across shared instances based on load |
| Instance templates | Pre-configured instance profiles (engineering, research, content) |

---

## 13. Migration Strategy

### From Current to Phase 1 (Zero Downtime)

**Preparation (while current instance is running):**

1. Fork `zylos-ai/zylos-core` → `xingfanxia/zylos-core`
2. Deploy Phase 0 changes (DB migration, new modules, env var support)
3. Create `instances.json` with single `main` instance pointing to existing `claude-main`
4. Verify everything works unchanged for 24h
5. Restructure `~/zylos/memory/` into the new shared/users/groups layout

**Cutover:**

```bash
# Step 1: Stop current activity-monitor (CC keeps running in tmux)
pm2 stop activity-monitor

# Step 2: Create admin state directory (user/group dirs created on demand)
mkdir -p ~/zylos/activity-monitor/admin

# Step 3: Copy current state to admin's instance (admin is the primary)
cp ~/zylos/activity-monitor/agent-status.json ~/zylos/activity-monitor/admin/
cp ~/zylos/activity-monitor/heartbeat-pending.json ~/zylos/activity-monitor/admin/ 2>/dev/null
# ... copy other state files

# Step 4: Update instances.json to Phase 1 config (admin + group instances)
# User instances are created on-demand when admin approves new users
# (see Section 3 example)

# Step 5: Reload PM2 with new ecosystem config
pm2 delete activity-monitor  # Remove legacy single AM
pm2 start ~/zylos/pm2/ecosystem.config.cjs --only activity-monitor-admin
# Group instances are on-demand — they start when first message arrives
# User instances are created on-demand via admin approval flow

# Step 6: Kill the legacy tmux session (will be replaced by new instances)
# Wait for new instances to start first:
sleep 10
tmux kill-session -t claude-main 2>/dev/null

# Step 7: Verify
pm2 list  # Should show activity-monitor-admin (user/group instances start on demand)
tmux ls   # Should show claude-admin

# Step 8: Save PM2 state
pm2 save
```

**Duration:** ~2 minutes of transition. Users may experience a brief delay (messages queue in c4.db) while instances start.

### Database Migration Script

```bash
#!/bin/bash
# migrate-001-add-target-instance.sh
# Run once. Idempotent — safe to re-run.

DB_PATH="$HOME/zylos/comm-bridge/c4.db"

sqlite3 "$DB_PATH" <<'SQL'
-- Check if column exists before adding
SELECT CASE
  WHEN COUNT(*) = 0 THEN 'ALTER TABLE conversations ADD COLUMN target_instance TEXT DEFAULT NULL;'
  ELSE 'SELECT 1;'
END
FROM pragma_table_info('conversations')
WHERE name = 'target_instance';
SQL

# Execute the generated ALTER (if needed)
sqlite3 "$DB_PATH" "ALTER TABLE conversations ADD COLUMN target_instance TEXT DEFAULT NULL;" 2>/dev/null
sqlite3 "$DB_PATH" "ALTER TABLE control_queue ADD COLUMN target_instance TEXT DEFAULT NULL;" 2>/dev/null

# Create indexes (idempotent)
sqlite3 "$DB_PATH" "CREATE INDEX IF NOT EXISTS idx_conversations_target_instance ON conversations(target_instance, status, priority);"
sqlite3 "$DB_PATH" "CREATE INDEX IF NOT EXISTS idx_control_queue_target_instance ON control_queue(target_instance, status, priority);"

echo "Migration complete."
```

### Rollback Plan

If Phase 1 causes issues:

```bash
# Step 1: Stop multi-instance AMs (admin + any dynamically created user/group instances)
pm2 stop activity-monitor-admin  # plus any other running activity-monitor-* processes

# Step 2: Revert instances.json to single instance
cat > ~/zylos/instances.json << 'EOF'
{
  "version": 1,
  "default_instance": "main",
  "instances": {
    "main": {
      "tmux_session": "claude-main",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated"
    }
  }
}
EOF

# Step 3: Start legacy AM (no ZYLOS_INSTANCE_ID = legacy mode)
pm2 start ~/zylos/pm2/ecosystem.config.cjs --only activity-monitor
pm2 save

# The target_instance column stays in DB but is ignored (all NULL = legacy)
# c4-receive falls back to default instance = 'main' = claude-main
# Dispatcher falls back to legacy session resolution
```

Rollback is safe because:
- DB column is additive (NULL = legacy behavior)
- `c4-instance-router.js` returns null when `instances.json` is missing/broken
- All modified code has `if (INSTANCE_ID) { ... } else { /* legacy */ }` fallback paths

---

## 14. Open Questions & Decisions

### Remaining Decisions (Phase 2+)

1. **Single dispatcher vs. per-instance dispatcher**: A single dispatcher is simpler but is a single point of failure. Per-instance dispatchers are more resilient but add N PM2 processes. Decision: single dispatcher for Phase 1 (it's already reliable); consider per-instance if the single dispatcher becomes a bottleneck in Phase 3.

2. **CC working directory isolation**: Using symlinked instance directories (`~/zylos/instances/<id>/`) gives clean project dir isolation but adds filesystem complexity. Decision: shared cwd for Phase 1. Session-init filtering by `target_instance` provides sufficient context isolation without filesystem tricks. Revisit if conversation bleed is observed.

3. **Per-instance CLAUDE.md**: Implemented. Layered approach: base `~/zylos/CLAUDE.md` + optional per-instance overrides at `~/zylos/instances/<id>/CLAUDE.md`. Injected via `session-start-inject.js` at session start. See Section 6.6.

### Decided (AX Review 2026-03-29)

| Question | Decision | Status |
|----------|----------|--------|
| Instance naming | `admin` (tmux: `claude-admin`) — not `ax` or `main` | Implemented |
| Phase 1 instance set | 7 instances: admin, user-elaine, user-betty, user-panpan, group-panpanmao, group-ghostwriter, group-shichuan. **No shared "team" instance** — every user gets their own isolated context. | Implemented |
| Instance isolation method | **CLAUDE_CONFIG_DIR** env var per instance (not symlinks). Admin keeps `~/.claude` (backward compatible). Others get `~/.claude-instances/<id>/`. | Implemented (Section 7.2) |
| Auto-suspend | All non-admin instances: `auto_suspend: true`, `idle_timeout_min: 30`. Admin: `auto_suspend: false` (always-on). CC process stopped on idle (~500MB RAM released); auto-resumed on next message (~5-10s cold start). | Implemented |
| Unknown user routing | **Option B:** Falls through to `default_instance` = admin. AX decides whether to create a new instance. No auto-provisioning in Phase 1. | Implemented |
| Group message routing | Per-group instance, not route-by-sender | Implemented |
| Channel bot changes | None required — routing uses existing pipe-delimited endpoint_id | Implemented |
| Code distribution | Fork `zylos-ai/zylos-core` → `xingfanxia/zylos-core` | Implemented |
| Scheduler task routing | All to admin instance (Phase 1), add `--target-instance` in Phase 2 | Phase 1 done |
| Web console routing | Binds to admin instance | Implemented |
| Memory write contention | Partition (per-instance state/session logs) + primary-writer for shared state. Memory-guard hook enforces isolation. No file locking Phase 1. | Implemented |
| API usage tracking | Per-instance token tracking in separate DB (see Section 10). On-demand reports (admin asks → gets report). Web dashboard with per-user charts in Phase 2. No weekly email blasts. | Phase 1 in progress |
| Instance provisioning | On-demand with admin approval. Unknown user DMs route to admin → AX approves → instance created. Never automatic. | Decided |
| Disabled instance handling | Messages for `enabled: false` instances are dropped silently. NOT rerouted to admin. | Decided |
| Memory dir creation | `shared/` exists upfront. `instances/<instance_id>/` created by migration script or on first start. `users/<id>/` pre-existing for profiles. No `groups/` directory in memory (groups removed in commit 55e8160). | Implemented |
| Scheduler instance | Dedicated `scheduler_instance` field in instances.json routes system/scheduler messages to a separate instance, keeping admin free for DM conversations. | Implemented |
| Web dashboard scope | Instance management + telemetry (token usage, CPU, memory per instance). No OpenTelemetry — reads existing state files + token-tracker DB + pm2 jlist. | Decided |
| Per-instance CLAUDE.md | Phase 2. `claude_md` schema field reserved. Enables persona-specific instructions per instance. | Phase 2 |

---

## Appendix A: Affected File Inventory

All changes are made in the **`xingfanxia/zylos-core` fork**. No changes to external components.

| File | Change Type | Phase | Status |
|------|------------|-------|--------|
| `~/zylos/instances.json` | **NEW** | 0 | Done |
| `comm-bridge/scripts/c4-instance-router.js` | **NEW** (in fork) | 0 | Done |
| `comm-bridge/scripts/c4-receive.js` | MODIFY (in fork) | 0-1 | Done (routing + system channel) |
| `comm-bridge/scripts/c4-config.js` | MODIFY (in fork) | 0-1 | Pending |
| `comm-bridge/scripts/c4-dispatcher.js` | MODIFY (in fork) | 1 | Pending |
| `comm-bridge/scripts/c4-session-init.js` | MODIFY (in fork) | 1 | Done (instance filtering) |
| `comm-bridge/init-db.sql` | MODIFY (in fork) | 0 | Pending |
| `activity-monitor/scripts/activity-monitor.js` | MODIFY (in fork) | 1 | Pending |
| `activity-monitor/scripts/claude.js` | MODIFY (in fork) | 1 | Pending |
| `activity-monitor/scripts/token-tracker.js` | MODIFY (in fork) — schema + cache columns | 0-1 | Done |
| `activity-monitor/scripts/hook-activity.js` | MODIFY (in fork) — token usage collection | 0-1 | Pending |
| `activity-monitor/scripts/context-monitor.js` | MODIFY (in fork) | 1 | Pending |
| `activity-monitor/scripts/session-start-prompt.js` | MODIFY (in fork) | 1 | Pending |
| `self-upgrade.js` | MODIFY (in fork) | 0 | Pending |
| `~/zylos/pm2/ecosystem.config.cjs` | MODIFY | 1 | Pending |
| `scheduler/scripts/runtime.js` | MODIFY (in fork) | 1 | Pending |
| `zylos-memory/SKILL.md` | MODIFY (in fork) | 1 | Pending |

**Zero changes required:**
- `feishu/src/index.js` — no modification needed
- `telegram/src/bot.js` — no modification needed
- Browser, imagegen, and all other external components — no changes

## Appendix B: Instance Registry Schema (Full)

> **Note:** Routing keys and `chat_ids` use **raw endpoint IDs** (the segment before the first `|` in the pipe-delimited `endpoint_id`). No `feishu::dm::` prefix. The channel type is implicit in the ID format.

```json
{
  "version": 1,
  "default_instance": "admin",
  "instances": {
    "admin": {
      "tmux_session": "claude-admin",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "primary": true,
      "auto_suspend": false,
      "chat_ids": [
        "ou_2619f0333713881523ed017979c12e08",
        "123456789"
      ],
      "state_dir": "~/zylos/activity-monitor/admin",
      "description": "AX dedicated instance (admin, engineering, scheduler). Always-on."
    },
    "user-elaine": {
      "tmux_session": "claude-user-elaine",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "primary": false,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_elaine_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-elaine",
      "description": "Elaine's isolated instance — market research, content"
    },
    "user-betty": {
      "tmux_session": "claude-user-betty",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "primary": false,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_betty_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-betty",
      "description": "Betty's isolated instance"
    },
    "user-panpan": {
      "tmux_session": "claude-user-panpan",
      "runtime": "claude",
      "enabled": true,
      "type": "dedicated",
      "primary": false,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["ou_panpan_open_id"],
      "state_dir": "~/zylos/activity-monitor/user-panpan",
      "description": "潘潘's isolated instance — teaching materials"
    },
    "group-panpanmao": {
      "tmux_session": "claude-group-panpanmao",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "primary": false,
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_panpanmao_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-panpanmao",
      "description": "PanPanMao project group instance"
    },
    "group-ghostwriter": {
      "tmux_session": "claude-group-ghostwriter",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "primary": false,
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_ghostwriter_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-ghostwriter",
      "description": "Ghostwriter project group instance"
    },
    "group-shichuan": {
      "tmux_session": "claude-group-shichuan",
      "runtime": "claude",
      "enabled": true,
      "type": "group",
      "primary": false,
      "on_demand": true,
      "auto_suspend": true,
      "idle_timeout_min": 30,
      "chat_ids": ["oc_shichuan_group_id"],
      "state_dir": "~/zylos/activity-monitor/group-shichuan",
      "description": "ShiChuan project group instance"
    }
  },
  "routing": {
    "ou_2619f0333713881523ed017979c12e08": "admin",
    "123456789": "admin",
    "console": "admin",
    "ou_elaine_open_id": "user-elaine",
    "ou_betty_open_id": "user-betty",
    "ou_panpan_open_id": "user-panpan",
    "oc_panpanmao_group_id": "group-panpanmao",
    "oc_ghostwriter_group_id": "group-ghostwriter",
    "oc_shichuan_group_id": "group-shichuan"
  }
}
```

## Appendix C: Dispatcher Routing Pseudocode

```
function deliverMessage(row):
    instanceId = row.target_instance
                  || getDefaultInstance()
                  || LEGACY_FALLBACK

    instance = instances.json[instanceId]

    // Disabled instance: drop message silently (don't reroute to admin)
    if not instance.enabled:
        markRejected(row)
        log("Dropped message for disabled instance: " + instanceId)
        return

    session = instance.tmux_session
    statusFile = instance.state_dir + '/agent-status.json'

    // On-demand instance management
    if instance.on_demand and not isRunning(instanceId):
        startInstance(instanceId)   // pm2 start activity-monitor-<id>
        waitForReady(statusFile)    // poll agent-status until ready

    agentStatus = readJSON(statusFile)

    // State gate (per-instance)
    if agentStatus.state in ['offline', 'stopped']:
        if not row.bypass_state:
            requeue(row)
            return

    if agentStatus.health != 'ok':
        if not row.bypass_state:
            requeue(row)
            return

    if row.require_idle and agentStatus.state != 'idle':
        requeue(row)
        return

    // Deliver to correct tmux session
    tmux_set_buffer(session, row.content)
    tmux_paste_buffer(session)
    press_enter(session)

    // Verify in correct pane
    if verify_delivery(session):
        mark_delivered(row)
    else:
        retry_or_fail(row)
```
