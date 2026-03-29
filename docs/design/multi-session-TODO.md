# Multi-Session Architecture — Remaining TODO

**Last updated:** 2026-03-29
**Reference:** [multi-session-architecture.md](multi-session-architecture.md)

---

## P0 — Must Do (blocking full deployment)

### ~~1. Memory restructuring: create `shared/` dir, migrate flat structure~~ ✅ DONE

Implemented in commit `0739995`. New layout: `shared/` (identity, references, reference/), `instances/<id>/` (state, sessions), `groups/`. All memory scripts updated with backward-compat resolution. Migration script at `scripts/migrate-memory-layout.sh`.

### ~~2. Ecosystem config: exclude `on_demand` type instances from PM2~~ ✅ DONE

Implemented in commit `0739995`. Added `if (instance.type === 'on_demand') continue;` filter in `loadInstanceMonitors()`.

### ~~3. Disabled instance handling~~ ✅ DONE

Already implemented. AM checks `isInstanceEnabled()`, ecosystem config skips disabled, dispatcher naturally excludes via stale status files.

### ~~4. Dispatcher multi-target delivery~~ ✅ DONE

Already implemented. Full per-instance tmux resolution, online-instance filtering, on-demand lifecycle management, suspended instance wake-signals.

### ~~5. Activity monitor parameterization~~ ✅ DONE

Already implemented. All 4 scripts (activity-monitor, hook-activity, context-monitor, session-start-prompt) fully parameterized with `ZYLOS_INSTANCE_ID`.

### ~~6. c4-session-init instance filtering~~ ✅ DONE

Already implemented. Filters unsummarized conversations by `target_instance` with instance-aware DB queries.

### Deployment: run memory migration on live system

After merging, run on the live system:
```bash
ZYLOS_INSTANCE_ID=admin bash ~/zylos/scripts/migrate-memory-layout.sh
```
This moves files to the new layout and creates backward-compat symlinks.

---

## P1 — Should Do (improves UX significantly)

### ~~7. Web management dashboard~~ ✅ DONE

Implemented as extension to web-console Express server. Dashboard at `/dashboard/` with instance cards (status, actions), PM2 processes, system resources. API: `GET /api/dashboard`, `POST /api/dashboard/instances/:id/{enable,disable,suspend,resume}`.

### ~~8. Token usage dashboard~~ ✅ DONE

Implemented as part of the web dashboard. `GET /api/dashboard/tokens?days=N` returns per-instance daily breakdown from token-tracker DB. Frontend shows table + CSS bar charts for visual comparison. Auto-refreshes every 30 seconds.

### ~~9. Per-instance CLAUDE.md generation~~ DONE

Implemented via `session-start-inject.js`. Per-instance CLAUDE.md content is injected at session start as an `=== INSTANCE INSTRUCTIONS ===` section. Resolution: `claude_md` field in instances.json (explicit path) > convention path `~/zylos/instances/<id>/CLAUDE.md`. Both support `~` expansion.

- **Files changed:**
  - `zylos-memory/scripts/session-start-inject.js` — `resolveInstanceClaudeMd()` + injection in `main()`
  - `templates/instances.json` — added `claude_md` field
  - `docs/design/multi-session-architecture.md` — updated schema and Section 6.6
- **Complexity:** M
- **Dependencies:** Activity monitor parameterization (P0 #5)

### ~~10. Admin approval flow / Instance management CLI~~ ✅ DONE

Instance CLI implemented at `cli/instance.js` with full CRUD: create, list, show, enable, disable, suspend, resume, remove. Also integrated into `zylos instance` wrapper. Admin approval flow is handled via CLAUDE.md instructions — admin receives unknown user messages and uses the CLI to create instances.

### ~~11. Scheduler `--target-instance` flag~~ ✅ DONE

Implemented end-to-end: DB migration (target_instance column), CLI flag for add/update/list, c4-receive.js `--target-instance` override, runtime/daemon dispatch chain.

---

## P2 — Nice to Have

### ~~12. Weekly/monthly token usage summary~~ ✅ DONE

Implemented as `activity-monitor/scripts/token-usage-summary.js`. CLI: `--days N`, `--output <path>`. Readonly DB access, per-instance breakdown, daily/weekly/monthly summaries with cost estimates.

### ~~13. Instance health alerts~~ ✅ DONE

Implemented in activity-monitor. Tracks unhealthy duration, sends priority-1 system alert after 5 minutes, sends recovery notice. Primary instances skip self-alerting.

### ~~14. Bulk instance management~~ ✅ DONE

Implemented as `suspend-all` and `resume-all` commands in the instance CLI. Skips primary instance for suspend-all.

### ~~15. Usage quotas per instance~~ ✅ DONE (config storage)

`quota_tokens_daily` field stored in instances.json via `create --quota-daily` and `set-quota` commands. Quota enforcement (checking + auto-suspend) in token-tracker.js is a future follow-up.
