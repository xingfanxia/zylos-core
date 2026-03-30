# Multi-Session v2 — Goals & Scope

## Architecture Goal
Restructure multi-session as modular hooks on upstream, minimizing upstream file changes
from ~2,565 lines (v1) to ~200 lines. All real logic lives in new files.

## Feature Goals (function parity with v1 + improvements)

### Core Multi-Session
- [ ] Instance management CLI (zylos instance create/start/stop/etc.)
- [ ] Per-instance tmux sessions with isolated Claude Code
- [ ] Message routing by chat_id via instance router
- [ ] Per-instance activity monitors (one PM2 process per instance)
- [ ] Dynamic PM2 config generation for per-instance AMs
- [ ] Memory restructuring: shared/ + instances/<id>/ with backward compat
- [ ] Auto-provision flow: unknown user → hold → dashboard approve → instance created
- [ ] Web management dashboard with instance CRUD, token usage, pending approvals

### v1 Bug Fixes (bake into v2)
- [ ] Never include config_dir (breaks OAuth)
- [ ] Verify timeout 60s (not 30s)
- [ ] Fix getAgentState() undefined → getClaudeState(statusFile)
- [ ] Git-level upstream detection for fork upgrades

### v1 Unfinished → v2 Goals
- [ ] Dashboard "Last Activity" → only track UserPromptSubmit events, not all hook events
- [ ] Dispatcher idle-gating → release item if CC is busy, retry on next poll
- [ ] Shared context layer → cross-instance conversation digest (so user instances
      know what admin/other users discussed recently)
- [ ] Group chat context → group chats get their own instances or shared context model
- [ ] Delivery confirmation → verify CC actually consumed the pasted message
- [ ] agent-status.json rename migration → live AMs may write claude-status.json

## Implementation Phases

### Phase 1: Foundation modules (new files only)
- skills/multi-session/instance-config.js — centralized instance resolution
- skills/multi-session/c4-helpers.js — C4 argument builder
- cli/lib/fork-config.js — fork repo constants
- cli/lib/upstream-merge.js — step0 for fork upgrades
- cli/commands/instance.js — instance management CLI
- skills/comm-bridge/scripts/c4-instance-router.js — endpoint → instance routing
- templates/instances.json — instance template

### Phase 2: Database + comm-bridge
- init-db.sql — add target_instance column
- c4-db.js — minimal hooks (targetInstance params, migration runner)
- c4-db-multi.js — instance-filtered queries
- c4-dispatcher.js — parameterize functions + multi-session dispatch hook
- c4-dispatcher-multi.js — lifecycle, routing, skip-loop, idle-gating
- c4-receive.js — --target-instance, instance routing, approval check
- c4-approval.js — approval flow
- Small files (c4-fetch, c4-control, c4-session-init) — inline changes

### Phase 3: Activity monitor
- activity-monitor.js — parameterize paths, add guards
- am-lifecycle.js — suspend, health alerts, wake signals
- hook-activity.js — filter to UserPromptSubmit for "Last Activity"
- token-tracker.js, suspend-manager.js, memory-guard.js, health-dashboard.js — new files

### Phase 4: Web console + scheduler + memory + CLI + templates
- dashboard-routes.js — extracted dashboard with fixed "Last Activity"
- server.js — single hook to register dashboard routes
- Memory scripts — shared/ + instances/<id>/ resolvers
- Scheduler — target_instance support
- CLI hooks (zylos.js, self-upgrade.js)
- Templates (ecosystem.config.cjs, CLAUDE.md, instances.json)

### Phase 5: Shared context layer (new feature)
- Shared context digest service — periodic job reads recent conversations across instances
- shared/recent-activity.md — rolling 24h digest injected into all instance session starts
- Admin instance as context hub — user instances can query via C4

### Phase 6: Tests + verification
- Rewrite tests for new module boundaries
- Fix pre-existing test failures
- Verify single-session fallback
- Verify multi-session end-to-end
