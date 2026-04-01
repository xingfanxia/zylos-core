# Multi-Session Architecture

Multi-session v2 runs multiple runtime instances in parallel, each handling a
different set of users/channels. Claude Code and Codex can coexist in one
deployment, with runtime chosen per instance in `instances.json`.

## Instance Types

| Instance | tmux Session | Type | Lifecycle | Purpose |
|----------|-------------|------|-----------|---------|
| admin | `instances.json` `tmux_session` | primary | always-on | Owner DMs, system admin, escalations |
| scheduler | `instances.json` `tmux_session` | dedicated | on-demand | Runs C5 scheduled tasks |
| group | `instances.json` `tmux_session` | group | on-demand | All Feishu/Telegram group chats |
| user-\* | `instances.json` `tmux_session` | user | on-demand | Auto-provisioned per approved user |

**On-demand lifecycle:** Auto-start via AM wake signal when a message arrives. Auto-suspend after 30 minutes idle. AM handles the full launch (auth, env, cwd, onboarding).

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
1. Check routing table in `instances.json` (explicit chat_id → instance mapping)
2. Check `chat_ids` arrays in instance definitions
3. Detect group chats (`|type:group` in endpoint for Feishu, negative chat_id for Telegram)
4. Fall back to default instance

**Important:** Feishu `oc_` prefix does NOT indicate group chat — it's used for both groups AND p2p DMs. Only `|type:group` in the endpoint string is reliable.

### Multi-Session Dispatcher (`skills/comm-bridge/scripts/c4-dispatcher-multi.js`)
Extracted dispatch logic with zero imports from the base dispatcher. Receives all dependencies via injection. Handles:
- Routing messages to the correct instance's tmux session
- Auto-starting offline instances (writes wake signal file)
- Grace period during instance boot (60s)
- Idle instance reaping

### User Approval (`skills/comm-bridge/scripts/c4-approve.js`)
When an unknown user messages, the flow is:
1. Message held with `status=pending_approval`
2. Dashboard shows pending user with approve/deny buttons
3. On approve: creates instance (CLI), creates per-instance cwd, sets auto_suspend, releases held messages, starts AM process
4. On deny: marks messages as rejected

### RuntimeAdapter (`cli/lib/runtime/claude.js`)
Launches CC from per-instance working directory:
- Computes `instanceCwd = ~/zylos/instances/<id>/` from `ZYLOS_INSTANCE_ID`
- Calls `ensureInstanceCwd()` to create dir + symlinks if missing
- Pre-trusts the instance dir for CC onboarding
- All `cd` commands in the tmux shell use `instanceCwd`

## Memory Isolation

The memory layer is now hardened for future mixed-runtime use.

### Ownership Rules

| Scope | Path | Allowed writer |
|------|------|----------------|
| Shared identity / references / shared reference docs | `memory/shared/...` | primary instance or scheduler |
| Archive | `memory/archive/...` | primary instance or scheduler |
| Per-instance working state | `memory/instances/<id>/...` | owning instance only |
| User profile | `memory/users/<uid>/profile.md` | any instance |

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
  ├── CLAUDE.md → ../../CLAUDE.md   (shared instructions)
  ├── AGENTS.md → ../../AGENTS.md   (Codex instructions)
  ├── .env → ../../.env             (shared config)
  └── memory → ../../memory         (shared memory)
```

Claude derives its project dir from `cwd`, so each instance writes JSONL
transcripts to a unique dir in `~/.claude/projects/`.

Codex stores runtime state globally under `~/.codex/`, not inside each
instance folder. Zylos reconstructs per-instance ownership by reading the
rollout/session metadata and grouping sessions by `session_meta.cwd`.

Operationally, this means Codex separation is enforced logically by Zylos
rather than by separate per-instance `~/.codex` roots.

Directories are created automatically:
- For built-in instances (admin, scheduler, group): by `ensureInstanceCwd()` on first launch
- For user instances: by `c4-approve.js` during approval

## Token Tracking

### Data Flow
1. Claude writes JSONL session transcripts to `~/.claude/projects/<project-dir>/`.
2. Codex writes session history to shared `~/.codex/sessions/.../rollout-*.jsonl`.
3. `update-token-cache.js` runs from PM2 and merges:
   - Claude history from `ccusage daily --json --instances --breakdown`
   - Codex history from `@ccusage/codex session --json`
4. Zylos maps:
   - Claude project names → instance IDs
   - Codex rollout `session_meta.cwd` → instance IDs
5. The merged cache is written to `~/zylos/activity-monitor/token-cache.json`
6. Dashboard reads the cache and renders per-runtime plus per-instance views

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
| token-cache-updater | Daemon: merges Claude `ccusage` and Codex `@ccusage/codex` history |
| provider-usage-updater | Daemon: refreshes top runtime usage cards |
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
