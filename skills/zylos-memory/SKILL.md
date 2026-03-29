---
name: zylos-memory
description: >-
  Core memory system. Maintains persistent memory across sessions via tiered
  markdown files following the Inside Out model. Handles Memory Sync (processing
  conversations into structured memory), session rotation, consolidation, and
  context-aware state saving. Must be launched via a runtime-appropriate
  background subagent mechanism — do not invoke with the Skill tool.
disable-model-invocation: true
user-invocable: false
---

# Memory System

Maintains persistent memory across sessions via tiered markdown files.
This skill must be run via a runtime-appropriate background subagent mechanism. For Claude, use the Task tool (`subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`). For Codex, use the current session's available background-agent capability with a Codex-supported model; do not hardcode `sonnet`.

## Architecture

```text
~/zylos/memory/
├── shared/                    # All instances share (read at session start)
│   ├── identity.md            # Bot soul + digital assets
│   ├── references.md          # Pointers to config files
│   └── reference/
│       ├── decisions.md       # Key decisions with rationale
│       ├── projects.md        # Active/planned projects
│       ├── preferences.md     # Shared team preferences
│       └── ideas.md           # Uncommitted plans and ideas
├── instances/                 # Per-instance working state
│   └── <instance-id>/
│       ├── state.md           # Active work for this instance
│       └── sessions/
│           └── current.md     # Today's session log
├── users/
│   └── <id>/profile.md       # Per-user preferences
└── archive/                   # Cold storage
```

**Backward compatibility:** When `shared/` does not exist, all scripts fall back to the legacy flat layout (files directly in `memory/`). The `ZYLOS_INSTANCE_ID` env var determines per-instance paths; when unset, scripts behave as single-instance mode.

## Memory Sync

### Priority

Memory Sync is the highest-priority internal maintenance task.
When triggered, run it before handling queued user messages.

### Trigger Paths

1. Session init: if C4 unsummarized count is over threshold, launch memory sync.
2. Scheduled context check: if context usage is high, launch memory sync.

Both launch a background subagent using the current runtime's supported subagent mechanism with this file's Sync Flow as the prompt.

### Sync Flow

1. Rotate session log if needed:
   `node ~/zylos/.claude/skills/zylos-memory/scripts/rotate-session.js`
2. Fetch unsummarized conversations from C4:
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized`
   If output says "No unsummarized conversations.", skip to step 5
   (still save current state). Otherwise, note the `end_id` from the
   `[Unsummarized Range]` line.
3. Read memory files: shared identity (`shared/identity.md`), instance state (`instances/<id>/state.md`), shared references (`shared/references.md`), user profiles, `shared/reference/*`, instance session log (`instances/<id>/sessions/current.md`). Falls back to legacy flat layout when `shared/` doesn't exist.
4. Extract and classify updates from conversations into the correct files:
   - Shared knowledge (decisions, projects, preferences, ideas) → `shared/reference/*.md`
   - User-specific preferences → `users/<user_open_id>/profile.md` (create dir if needed)
   - Session events and conversation context → `instances/<instance_id>/sessions/current.md`
   - Active tasks and focus → `instances/<instance_id>/state.md`
   - Note: each instance runs its own memory sync and only sees its own conversations
     (via instance-filtered c4-fetch). Group context naturally goes into the group
     instance's state.md and sessions/current.md — no separate groups/ directory needed.
   - Only the primary (admin) instance should write to `shared/reference/*` files.
5. Write memory updates (always — even without new conversations,
   update `state.md` and `sessions/current.md` with current context).
6. Create checkpoint (only if conversations were fetched in step 2):
   `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js create <end_id> --summary "SUMMARY"`
7. Confirm completion.

## Classification Rules

- `shared/reference/decisions.md`: committed choices that close alternatives.
- `shared/reference/projects.md`: scoped work efforts with status.
- `shared/reference/preferences.md`: standing team-wide preferences.
- `shared/reference/ideas.md`: uncommitted proposals.
- `users/<id>/profile.md`: user-specific preferences.
- `instances/<id>/state.md`: active focus and pending tasks for an instance.
- `instances/<id>/sessions/current.md`: session log and conversation context for an instance.
- `shared/references.md`: pointers only; do not duplicate `.env` values.

## File Formats and Examples

Each memory file type has a format definition in `references/` and a
worked example in `examples/`:

| File | Format | Example |
|------|--------|---------|
| `identity.md` | `references/identity-format.md` | `examples/identity.md` |
| `state.md` | `references/state-format.md` | `examples/state.md` |
| `references.md` | `references/references-file-format.md` | `examples/references.md` |
| `users/<id>/profile.md` | `references/user-profile-format.md` | `examples/user-profile.md` |
| `reference/decisions.md` | `references/decisions-format.md` | `examples/decisions.md` |
| `reference/projects.md` | `references/projects-format.md` | `examples/projects.md` |
| `reference/preferences.md` | `references/preferences-format.md` | `examples/preferences.md` |
| `reference/ideas.md` | `references/ideas-format.md` | `examples/ideas.md` |
| `sessions/current.md` | `references/session-log-format.md` | `examples/session-log.md` |

## Supporting Scripts

- `session-start-inject.js`: prints core memory context blocks for hooks.
- `rotate-session.js`: rotates `sessions/current.md` at day boundary.
- `daily-commit.js`: local git snapshot for `memory/` if changed.
- `consolidate.js`: JSON consolidation report (sizes, age, budget checks).
- `memory-status.js`: quick health summary.

C4 scripts used by sync flow (provided by comm-bridge skill):
- `c4-fetch.js --unsummarized`: fetch unsummarized conversations and range.
- `c4-checkpoint.js create <end_id> --summary "..."`: create sync checkpoint.

## Consolidation Review

The weekly consolidation task runs `consolidate.js` and outputs a JSON report.
Review the report and apply these rules:

### Core File Budgets
- Files over 100% budget: summarize and trim older entries.
  Move historical content to `reference/` or `archive/`.
- `state.md` is the strictest — must stay under 4KB.

### Session Logs
- Logs in `archiveCandidatesOlderThan30Days`: move from `sessions/` to `archive/`.

### Reference Files (`reference/*.md`)
These files have no size cap. Maintenance is at the entry level.
Freshness is reported by file mtime (Phase 1 limitation):
- **active** (< 7 days): no action.
- **aging** (7–30 days): no action.
- **fading** (30–90 days): open the file. Review entries by their dates
  and status fields. Update or confirm still-relevant entries; move
  obsolete entries (superseded/completed/abandoned/dropped) to `archive/`.
- **stale** (> 90 days): same as fading, but prioritize review.
  Entries that are clearly still critical may remain.

**Immunity:** Entries with importance 1-2 (defined in entry metadata) are
immune to automatic fading suggestions. They may still be reviewed but
should not be archived based on age alone.

### User Profiles
- Profiles over ~1KB: summarize older notes.

### General Rules
1. Never delete — always move to `archive/`. Content is recoverable
   from `archive/` or git history.
2. Log consolidation actions in `sessions/current.md`.

## Best Practices

1. Keep `state.md` lean (tight context budget).
2. Prefer updates over duplication.
3. Use explicit dates/timestamps for entries.
4. Archive instead of deleting historical data.
5. Route user data to user profiles.
6. Keep configuration values in config files; use `references.md` as an index.
