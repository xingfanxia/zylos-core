# Mixed Runtime Plan

Goal: support Claude Code and Codex concurrently in one Zylos deployment, with:

- `admin` optionally pinned to Claude
- selected user / worker instances allowed to run Codex
- `scheduler` able to run either runtime
- dashboard controls for per-instance runtime changes
- dashboard control for global runtime change across all instances

This document now serves as a status + roadmap document. Core mixed-runtime
support is already live; the remaining items here are the hardening and parity
work still worth tracking.

## Current State

What already exists:

- Runtime adapters for both Claude and Codex
- Global runtime switch via `zylos runtime <claude|codex>`
- Per-instance `runtime` field in `instances.json`
- Per-instance tmux session naming and per-instance working directories
- activity-monitor resolves runtime per instance instead of one global adapter
- Claude and Codex sessions can coexist in one deployment
- dispatcher delivery and verification are runtime-aware enough for live mixed deployment
- dashboard runtime actions exist:
  - per-instance runtime switch
  - global switch-all runtime action
- dashboard usage cards are runtime-aware
- Mixed-runtime memory hardening:
  - strict shared-vs-instance memory policy
  - Codex bootstrap reads per-instance state
  - startup memory injection resolves runtime-aware per-instance instruction files
  - per-instance cwd includes both `CLAUDE.md` and `AGENTS.md`
- Codex runtime config rendering preserves/writes runtime settings needed for unattended sessions
- Codex token history is merged into dashboard cache via `@ccusage/codex`

What is still shared / imperfect:

- raw Codex state still lives in shared `~/.codex`
- Codex isolation depends on correct `cwd` attribution rather than separate per-instance Codex homes
- Codex live limit sources are split:
  - top cards use rollout snapshots for Codex
  - Claude top cards use CodexBar CLI
- Codex auto-compaction has not yet been stress-verified with an intentional 800k+ live session

## Requirements

### Functional

1. Each instance must be able to declare its own runtime in `instances.json`.
2. activity-monitor must use the runtime of the current instance, not the global runtime.
3. Dispatcher must deliver to Claude-targeted and Codex-targeted instances safely in the same deployment.
4. Dashboard must support changing a single instance's runtime.
5. Dashboard must support switching all instances to a selected runtime.
6. Global switch from dashboard must optionally update the global default runtime for newly created instances.

### Dashboard Requirements

#### Per-instance runtime change

User story:
- from the dashboard, operator can open an instance card and switch that instance between `claude` and `codex`

Expected behavior:
- update `instances.json` for that instance
- rebuild / sync runtime-specific local files if needed
- restart only that instance's activity monitor and runtime session
- preserve message queue state
- show success/failure response in dashboard

API target:
- `POST /api/dashboard/instances/:id/runtime`
- request body:
```json
{ "runtime": "claude" }
```

Response target:
```json
{
  "ok": true,
  "id": "user-betty",
  "runtime": "codex",
  "restarted": true
}
```

#### Global runtime change

User story:
- from the dashboard, operator can switch all instances to one runtime

Expected behavior:
- update every instance `runtime`
- optionally update `~/zylos/.zylos/config.json` default runtime
- perform a rolling restart to avoid avoidable queue disruption
- report per-instance success/failure

API target:
- `POST /api/dashboard/runtime/switch-all`
- request body:
```json
{
  "runtime": "codex",
  "update_default": true
}
```

Response target:
```json
{
  "ok": true,
  "runtime": "codex",
  "update_default": true,
  "results": [
    { "id": "admin", "ok": true },
    { "id": "scheduler", "ok": true },
    { "id": "user-betty", "ok": true }
  ]
}
```

### Safety

- primary instance cannot be left without a valid runtime
- runtime change must be rejected if target runtime is not installed or not authenticated
- dashboard should expose dry-run / preflight errors clearly
- runtime switches must not mutate another instance's memory ownership

## Implementation Phases

## Phase 1: Per-instance runtime resolution
Status: shipped

Objective:
- remove the global runtime assumption from instance execution paths

Work:
- add a shared helper for resolving instance runtime from `instances.json`
- update activity-monitor startup to choose adapter by `ZYLOS_INSTANCE_ID`
- update PM2-generated activity-monitor env to include explicit runtime if helpful
- keep global config runtime only as default / legacy fallback

Key files:
- `skills/multi-session/runtime-files.js`
- `skills/activity-monitor/scripts/activity-monitor.js`
- `templates/pm2/ecosystem.config.cjs`
- `cli/lib/runtime/index.js`

Acceptance:
- two instance monitors can resolve different runtimes from config without touching the global runtime value

## Phase 2: Remove global cross-runtime cleanup
Status: shipped

Objective:
- allow Claude and Codex sessions to coexist

Work:
- remove the startup behavior that kills `claude-main` when Codex starts and vice versa
- replace it with instance-scoped cleanup only
- ensure runtime stop/restart only affects the instance being managed

Key files:
- `skills/activity-monitor/scripts/activity-monitor.js`
- `cli/commands/runtime.js`

Acceptance:
- starting a Codex instance does not kill a healthy Claude instance
- starting a Claude instance does not kill a healthy Codex instance

## Phase 3: Dispatcher runtime awareness
Status: shipped for live mixed deployment, still worth incremental hardening

Objective:
- make delivery and verification safe for mixed runtimes

Work:
- make dispatcher aware of target instance runtime
- verify submit / tmux-input behavior for Codex and Claude per target session
- ensure strict verification remains correct for both runtimes
- extend smoke tests to mixed-runtime cases

Key files:
- `skills/comm-bridge/scripts/c4-dispatcher.js`
- `skills/comm-bridge/scripts/c4-dispatcher-multi.js`
- `skills/comm-bridge/scripts/c4-instance-router.js`
- live smoke scripts

Acceptance:
- mixed deployment can deliver to Claude and Codex sessions during the same dispatcher loop
- cold-start wake path works for both runtimes

## Phase 4: Dashboard instance runtime actions
Status: shipped

Objective:
- allow runtime switching from the dashboard

Work:
- add per-instance runtime API
- add global runtime switch API
- add runtime selector UI on instance cards
- add global runtime action panel
- add preflight checks:
  - target runtime installed
  - target runtime authenticated
  - runtime-specific config sync complete

Key files:
- `skills/web-console/scripts/dashboard-routes.js`
- `skills/web-console/public/dashboard/app.js`
- `skills/web-console/public/dashboard/index.html`
- `skills/web-console/public/dashboard/styles.css`

Acceptance:
- operator can switch one instance runtime from dashboard
- operator can switch all instances runtime from dashboard
- dashboard surfaces partial failures cleanly

## Phase 5: Runtime-specific startup parity
Status: partially shipped; remaining items below are still active follow-up

Objective:
- make Codex and Claude instance startup behavior equally robust

Work:
- keep session-start injection and startup prompt runtime-aware
- add Codex-native enforcement path or equivalent guardrails for memory ownership
- verify per-instance instruction overlays for both `CLAUDE.md` and `AGENTS.md`
- ensure scheduler tasks can target either runtime cleanly

Acceptance:
- Codex worker instance boots with correct state, policy, and instructions
- Claude worker instance still behaves unchanged

Remaining follow-up under this phase:

- stronger Codex-side hard enforcement for memory ownership
- longer live soak for Codex auto-compaction and session rotation
- continued cleanup of any residual runtime-specific fallback assumptions in operator tooling

## Rolling Restart Strategy

For dashboard global runtime changes:

1. Preflight all instances
   - installed
   - authenticated
   - configuration writable
2. Persist target runtime to all instance configs
3. Restart non-primary on-demand instances first
4. Restart scheduler
5. Restart group instance
6. Restart admin last

Reason:
- admin is the highest-value conversational surface and should be restarted last

## Open Questions

1. Should `scheduler` be included in "switch all" by default, or should the UI expose a checkbox?
2. Should newly approved users inherit the dashboard-selected global default runtime or always start on Claude?
3. Do we want runtime badges and filters in the dashboard instance table before adding switch actions?
4. For Codex, do we need a stronger tool-hook equivalent to Claude's `memory-guard.js`, or is startup policy + prompt discipline enough for the first release?

## Recommended Order

Remaining work is still best approached in this order:

1. Per-instance runtime resolution
2. Remove global runtime cleanup
3. Dispatcher runtime awareness
4. Live mixed-runtime smoke tests
5. Dashboard per-instance runtime switch
6. Dashboard global switch-all action

This order keeps the operator-facing dashboard work on top of stable runtime plumbing instead of forcing UI work to lead architecture.
