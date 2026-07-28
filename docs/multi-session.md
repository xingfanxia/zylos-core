# Multi-Session Architecture

Multi-session v2 runs multiple runtime instances in parallel, each handling a
different set of users/channels. Claude Code and Codex can coexist in one
deployment, with the active runtime profile chosen per instance in
`instances.json`. Upstream/public single-session deployments can use the same
profile model through `.zylos/runtime-profiles.json` without being converted to
multi-session.

## Instance Types

| Instance | tmux Session | Type | Lifecycle | Purpose |
|----------|-------------|------|-----------|---------|
| admin | `instances.json` `tmux_session` | primary | always-on | Owner DMs, system admin, escalations |
| scheduler | `instances.json` `tmux_session` | dedicated | on-demand | Runs C5 scheduled tasks |
| group | `instances.json` `tmux_session` | group | on-demand | All Feishu/Telegram group chats |
| user-\* | `instances.json` `tmux_session` | user | on-demand | Auto-provisioned per approved user |

**On-demand lifecycle:** Auto-start via AM wake signal when a message arrives. Auto-suspend after 30 minutes idle (configurable via `idle_timeout_min`). AM handles the full launch (auth, env, cwd, onboarding).

**Suspend/wake flow:**
1. **Suspend path (two mechanisms):**
   - **SuspendManager** (in AM): `tick()` checks `idleSeconds` against `idle_timeout_min * 60` each second. When exceeded and Claude is running, kills the tmux session and writes `state: 'suspended'` to `agent-status.json`. Idle time is derived from CC's conversation JSONL file mtime (`source=conv_file`), not tmux pane activity.
   - **Dispatcher reap** (belt-and-suspenders): `reapIdleInstances()` tracks `lastDeliveryAt` per instance. If no message was delivered within `IDLE_REAP_TIMEOUT_MS`, writes a `suspend-signal` file for the AM to pick up.
2. **Wake path:** When a pending message targets an offline instance, the dispatcher's `getPendingTargetInstancesNeedingWake()` detects it and writes a `wake-signal` file. The AM reads this on its next tick, clears suspended state, and Guardian auto-restarts the tmux/Claude session. The dispatcher then delivers the queued message.

**Important:** The AM's `CONV_DIR` must resolve to CC's actual project directory. CC derives project dirs from `realpath(instanceCwd)` with `/` and `_` replaced by `-`. The AM uses `instanceConfig.getInstanceCwd()` + `fs.realpathSync()` to match this. If idle detection shows `source=tmux_activity` instead of `source=conv_file` in `agent-status.json`, the CONV_DIR resolution is broken.

**Stable session identity:** an explicit `tmux_session` in `instances.json`
belongs to the persona, not the engine. Runtime failover kills and recreates the
engine pane under that same tmux name. The `<runtime>-<id>` convention is only a
fallback for definitions that do not provide a stable name.

## Runtime Profiles and Automatic Failover

`runtime_profiles` separates an engine choice from persona state. A profile may
select `claude` or `codex`, a model and reasoning effort, a private Codex home,
and the **name** of a provider environment variable. Credential values are
forbidden in the profile document.

The `runtime-failover` daemon evaluates the configured chain. The production
chain is typically:

```
claude-subscription -> codex-subscription -> codex-azure
```

It advances when the current provider reaches `switch_threshold` or reports a
live `rate_limited` health state. It can return to an earlier recovered profile
below `recover_threshold` after `min_dwell_sec`. Provider usage uses the live
Claude subscription windows and Codex's 5-hour and exact 10,080-minute weekly
windows. Unknown usage permits one optimistic hop; a subsequent live rate-limit
signal advances to the next tier.

`auto_recover: false` keeps an explicitly selected profile active instead of
returning to an earlier tier after the dwell window. When that selected profile
is the final chain entry, `wrap_on_exhausted: true` lets a live health or usage
failure wrap to the first usable earlier tier. This supports an API-primary
deployment without removing subscription fallback profiles.

A profile transition is deliberately engine-only. It may update
`runtime_profile`, `runtime`, transition metadata, generated `CLAUDE.md` or
`AGENTS.md`, and the engine process. It must preserve all of the following in
place:

- `ZYLOS.md` and persona identity;
- the same memory directories and files, without a runtime-specific copy;
- `.claude/skills`, exposed to Codex only through
  `.agents/skills -> .claude/skills`;
- the same persona-owned workspace `.env` and secret files, so either engine
  can use them from the unchanged working directory;
- the same C4 database, queue, task state, and chat routing;
- the working directory and stable tmux identity.

Provider credentials are the sole intentional runtime-private state. Each
Codex profile uses a protected `CODEX_HOME`; provider keys are read from that
home's `auth.json` into a mode-0600 launch specification and never stored in
`instances.json`, PM2 configuration, process argv, or logs. This isolation does
not copy or replace the persona workspace `.env`.

For an `os_user` persona, `instances/<id>/.env` resolves to the writable
`/home/<os_user>/zylos/.env`, never the private root Zylos env. The launch spec
contains only its path; after `sudo` drops to the persona, `tmux-launcher`
reads that file and merges its variables into either Claude or Codex. Explicit
runtime values win on conflicts, so a persona env cannot replace HOME,
CODEX_HOME, model/profile identity, or provider injection. A regular/custom
workspace `.env` is preserved by repeated `ensureInstanceCwd()` calls.
Shared-user personas may retain the legacy root link or replace it with their
own regular/custom workspace env; repeated setup preserves that choice too.

Codex SessionStart hooks are installed only once at the shared Zylos root.
Per-instance `.codex/config.toml` remains an engine overlay, but duplicate
per-instance hook files are removed. Hook discovery runs from the actual
instance cwd and automatically trusts only the shared Zylos-managed hook file.
Heartbeat controls always include `target_instance`, and equivalent controls
supersede only within that persona, preventing cross-persona health timeouts.

## Key Components

### Instance Config (`skills/multi-session/instance-config.js`)
Central module for instance identity and path resolution. All instance-aware files import from here.

Key exports:
- `getInstanceId()` — current instance ID from `ZYLOS_INSTANCE_ID` env var
- `getInstanceCwd(id)` — resolve working directory path
- `ensureInstanceCwd(id)` — create instance dir with symlinks if missing
- `getMonitorDir(id)` — per-instance state directory
- `getSessionName(id)` — tmux session name
- `resolveStatusFile(id)` — path to agent-status.json

### Message Routing (`skills/comm-bridge/scripts/c4-instance-router.js`)
Routes incoming messages to the correct instance:
1. Detect group chats (`|type:group` in endpoint for Feishu, negative chat_id for Telegram) → route to `group` instance
2. Check routing table in `instances.json` (explicit chat_id → instance mapping)
3. Check `chat_ids` arrays in instance definitions
4. Fall back to default instance

**Important:** Feishu `oc_` prefix does NOT indicate group chat — it's used for both groups AND p2p DMs. Only `|type:group` in the endpoint string is reliable.

Both `resolveInstance()` (message delivery) and `isEndpointRouted()` (approval check) use `isGroupEndpoint()` for group detection. This ensures group chats bypass the approval flow and route directly to the group instance without needing explicit routing entries.

### Multi-Session Dispatcher (`skills/comm-bridge/scripts/c4-dispatcher-multi.js`)
Extracted dispatch logic with zero imports from the base dispatcher. Receives all dependencies via injection. Handles:
- Routing messages to the correct instance's tmux session
- Auto-starting offline instances (writes wake signal file)
- Grace period during instance boot (60s)
- Idle instance reaping

**Skip loop:** `processWithMultiSession` claims items one at a time in a loop (up to `MAX_SKIP_ATTEMPTS=10`). Items that can't be delivered (offline target, suspended, unhealthy, `require_idle` not met) are **held in `running` state** via a `heldItems` array during the loop and only released back to `pending` when the loop exits. This prevents re-claiming the same undeliverable item on every skip-loop iteration (which would consume all attempts on one item). It also prevents head-of-line blocking where an undeliverable item at the front of the queue starves items behind it.

**`require_idle` settlement:** After delivering a `require_idle=1` message (e.g., scheduled tasks), the dispatcher holds the queue for 5 seconds then waits up to 120s for the target instance to return to idle before dispatching the next item. This prevents flooding a single instance with back-to-back system tasks.

**Known pitfall — stale agent-status:** If an instance's `agent-status.json` shows `busy` but the instance is actually idle (stale status from a crashed/stuck activity monitor), `require_idle=1` items targeting that instance will be skipped indefinitely. The items remain in `pending` status until the status file is corrected or the items are manually expired.

### User Approval (`skills/comm-bridge/scripts/c4-approve.js`)
When an unknown **DM user** messages, the flow is:
1. `isEndpointRouted()` returns false (not in routing table, not a group chat) → message held with `status=pending_approval`
2. Dashboard shows pending user with approve/deny buttons
3. On approve: creates instance via CLI (`--chat-ids` flag writes routing + chat_ids), creates per-instance cwd + memory dir, sets `type=user`, `auto_suspend=true`, `idle_timeout_min=30`, releases held messages (`pending_approval` → `pending`), starts AM process
4. On deny: marks messages as rejected

**Group chats skip approval entirely** — `isEndpointRouted()` detects `|type:group` endpoints and returns true when a group instance exists, so they route directly to the group instance.

**Note:** The approve script calls the deployed CLI at `~/zylos/cli/instance.js` (not the repo copy at `cli/commands/instance.js`). The deployed CLI supports `--chat-ids` for comma-separated chat ID routing. The dashboard API strips `|type:p2p` suffixes before passing chat IDs to the approve script.

### RuntimeAdapter (`cli/lib/runtime/claude.js`)
Launches CC from per-instance working directory:
- Computes `instanceCwd = ~/zylos/instances/<id>/` from `ZYLOS_INSTANCE_ID`
- Calls `ensureInstanceCwd()` to create dir + symlinks if missing
- Pre-trusts the instance dir for CC onboarding
- All `cd` commands in the tmux shell use `instanceCwd`
- **Auto-continue:** Detects prior sessions (*.jsonl in CC project dir) and adds `--continue` flag to resume the most recent conversation on restart

### Session Context Restoration

On every CC restart (suspend/wake, crash recovery, heartbeat timeout, context rotation, daily upgrade), three layers restore context:

1. **`--continue` flag** — resumes CC's internal context window (compressed conversation, reasoning, tool calls). CC's project dir is derived from `realpath(instanceCwd)` with `/` and `_` replaced by `-`.
2. **`session-start-inject.js`** (SessionStart hook) — injects per-instance memory (`state.md`, `sessions/current.md`), per-instance `ZYLOS.md` identity anchor, and (for admin/scheduler/group only) cross-instance activity digest
3. **`c4-session-init.js`** (SessionStart hook) — injects last checkpoint summary + up to 30 recent instance-scoped conversations from c4.db. If instance-scoped queries are unavailable, injects nothing (never falls back to unfiltered global queries).

Layer 1 preserves CC's internal understanding; layers 2-3 provide structured context from external systems. All three fire on every restart.

### Identity Isolation

Four mechanisms prevent instances from confusing user identities:

1. **Per-instance `ZYLOS.md`** — generated by `ensureInstanceCwd()` at launch. Contains the instance's `display_name` (from `instances.json`), bound chat IDs, and explicit identity rules ("serve ONLY this user"). Injected as `=== INSTANCE INSTRUCTIONS ===` by `session-start-inject.js`.
2. **Instance-scoped conversation queries** — `c4-session-init.js` uses `getUnsummarizedConversationsForInstance()` from `c4-db-multi.js` which filters strictly on `target_instance = ?` (no `OR target_instance IS NULL` fallback). This excludes outgoing messages (stored with NULL target_instance) from every instance's context. If the import fails, conversation injection is skipped entirely (fail-safe, not fail-open).
3. **Cross-instance digest gating** — `shared/recent-activity.md` is only injected for admin (primary), scheduler, and group instances. User-type instances do not receive other users' activity summaries.
4. **Per-instance checkpoints** — `checkpoints.target_instance` column (migration 002) scopes checkpoints per instance. Each instance's `getLastCheckpointForInstance()` query uses its own checkpoint, so one instance's sync doesn't shift another's "unsummarized" boundary.

## Memory Isolation

The memory layer is now hardened for future mixed-runtime use.

### Ownership Rules

| Scope | Path | Allowed writer |
|------|------|----------------|
| Shared identity / references / shared reference docs | `memory/shared/...` | primary instance or scheduler |
| Archive | `memory/archive/...` | primary instance or scheduler |
| Per-instance working state | `memory/instances/<id>/...` | owning instance only |
| Per-group memory (ZY-GRP-1) | `memory/groups/<group_key>/...` | the group instance (`type:group`) only |
| User profile | `memory/users/<uid>/profile.md` | any instance |

**Per-group memory (ZY-GRP-1):** the group instance serves many chats, so its
session-init injects history SEGMENTED into one labeled section per chat
(keyed on `groupKeyFromEndpoint()` = the endpoint id before the first `|`),
most-recently-active first, capped per group. Durable per-chat memory lives
under `memory/groups/<group_key>/`; that tier is writable only by the group
instance (memory-guard code check + unix perms — `2770 zylos-group`, other
agents denied by `verify-isolation.sh`).

### Enforcement Paths

- `skills/activity-monitor/scripts/memory-guard.js` now enforces the shared-vs-instance policy through the Claude hook template.
- The guard resolves symlinked paths, so compatibility links still map back to the real shared or instance-owned target before validation.
- Codex startup memory injection now prints a `MEMORY WRITE POLICY` block so Codex instances receive the same ownership rules even before Codex-native hook enforcement exists.
- Codex bootstrap now reads per-instance `memory/instances/<id>/state.md` instead of assuming legacy flat `memory/state.md`.

### Operational Note

When deploying changes that touch `templates/.claude/settings.json`, run:

```bash
cd ~/zylos-core
node cli/lib/sync-settings-hooks.js
```

Otherwise existing installs will not pick up the updated hook wiring.

## Per-Instance Working Directories

Each instance runs its runtime from its own directory:

```
~/zylos/instances/<id>/
  ├── .claude → ../../.claude       (shared skills)
  ├── .agents → ../../.agents       (Codex view of the same skills)
  ├── CLAUDE.md → ../../CLAUDE.md   (shared instructions)
  ├── AGENTS.md → ../../AGENTS.md   (Codex instructions)
  ├── .env → ../../.env             (shared config)
  └── memory → ../../memory         (shared memory)
```

Claude derives its project dir from `cwd`, so each instance writes JSONL
transcripts to a unique dir in `~/.claude/projects/`.

Codex stores engine state under the active profile's protected `CODEX_HOME`
(for example `~/.codex-subscription` or `~/.codex-azure`), not inside the
instance folder. Zylos reconstructs persona attribution by reading rollout
metadata and grouping sessions by `session_meta.cwd`. Credential/provider state
is profile-private; identity, memory, skills, workspace secrets, messaging, and
tasks remain shared persona state.

Directories are created automatically:
- For built-in instances (admin, scheduler, group): by `ensureInstanceCwd()` on first launch
- For user instances: by `c4-approve.js` during approval

## Token Tracking

### Data Flow
1. Claude writes JSONL session transcripts to `~/.claude/projects/<project-dir>/`.
2. Codex writes session history under each configured profile's
   `CODEX_HOME/sessions/.../rollout-*.jsonl`.
3. `update-token-cache.js` runs from PM2 and merges:
   - Claude history from `ccusage daily --json --instances --breakdown`
   - Codex history from the pinned `ccusage@20.0.17 codex session --json`
4. Zylos maps:
   - Claude project names → instance IDs
   - Codex rollout `session_meta.cwd` → instance IDs
5. The merged cache is written to `~/zylos/activity-monitor/token-cache.json`
6. Dashboard reads the cache and renders per-runtime plus per-instance views

API-backed profiles report input, output, cached, and total token counts. Their
cost is a LiteLLM-pricing equivalent API estimate (`cost_basis` is
`litellm_equivalent_api_estimate`), not a provider invoice. Subscription
profiles retain the tool's subscription-equivalent attribution and are not
presented as billed API spend.

### Dashboard Token Features
- Stacked bar chart with per-instance color coding
- Pie chart showing cost percentage breakdown
- Per-instance table with input/output/cache tokens and cost
- Runtime filter: `All`, `Claude`, `Codex`
- Top runtime usage cards:
  - Claude live limits from CodexBar CLI
  - Codex live limits from local rollout snapshots
- "System" category for unattributed usage (pre-cwd migration data)
- "Include system usage" toggle (default: off)
- Day filter buttons (7/14/30 days, client-side filtering)
- Per-instance endpoint: `/api/dashboard/tokens/:instanceId`

## Dashboard Management

The web console dashboard (`/dashboard`) provides:

### Instance Management
- View all instances with status (running/idle/stopped/suspended)
- Enable/disable instances
- Suspend/resume on-demand instances
- Instance cards show: status, type, tmux state, last activity, uptime, idle time
- Runtime switching is supported from the dashboard:
  - per-instance runtime change
  - global switch-all runtime action
  - runtime-aware status and usage cards

### User Approval
- Pending user queue with approve/deny buttons
- Custom instance name input on approval
- Shows sender name, channel, message preview, held message count

### Token Usage
- Aggregate and per-instance token/cost data
- Visual charts (stacked bars + pie)
- Configurable time window
- Runtime-aware top cards and runtime filters

### System Health
- CPU, memory, disk usage bars
- PM2 process table with status, uptime, restarts, memory, CPU

## PM2 Process Architecture

The ecosystem config (`templates/pm2/ecosystem.config.cjs`) manages:

| Process | Purpose |
|---------|---------|
| scheduler | C5 task scheduler daemon |
| web-console | Dashboard + API server |
| c4-dispatcher | Message dispatch loop |
| activity-monitor-\<id\> | One per enabled instance (generated dynamically) |
| token-cache-updater | Daemon: merges Claude `ccusage` and pinned `ccusage codex` history |
| provider-usage-updater | Daemon: refreshes top runtime usage cards |
| runtime-failover | Daemon: switches opted-in personas across the configured profile chain |
| caddy | Reverse proxy (if configured) |
| zylos-telegram | Telegram bot connector |
| zylos-feishu | Feishu bot connector |

## Shared Knowledge System

Cross-instance knowledge is maintained by a scheduled task (`shared-knowledge-sync`) that runs every 30 minutes on the scheduler instance. It:
1. Fetches unsummarized conversations from all instances
2. Extracts durable knowledge (products, customers, decisions, projects, etc.)
3. Writes to shared reference files in `~/zylos/memory/shared/reference/`
4. Updates an activity digest for cross-instance awareness

The sync is LLM-driven (prompt at `skills/multi-session/shared-knowledge-sync-prompt.md`), not code-based — maximizes extraction quality without maintaining brittle parsing logic.

## Configuration

### instances.json
Runtime instance definitions at `~/zylos/instances.json`. Template at `templates/instances.json`.

Key fields per instance:
- `tmux_session` — tmux session name
- `enabled` — boolean, skipped if false
- `type` — dedicated/group/user
- `primary` — boolean, only one should be true
- `auto_suspend` — boolean, enables idle timeout
- `idle_timeout_min` — minutes before auto-suspend (default 30)
- `state_dir` — path to agent-status.json and other state files
- `chat_ids` — array of chat IDs routed to this instance

### Environment Variables
Passed to CC process via tmux `-e` flags:
- `ZYLOS_INSTANCE_ID` — instance identifier
- `ZYLOS_TMUX_SESSION` — tmux session name
- `ZYLOS_PACKAGE_ROOT` — path to zylos-core repo (for AM to find RuntimeAdapter)
