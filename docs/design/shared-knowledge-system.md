# Shared Knowledge System — Design

## Problem

The shared-context.js Node script generates a rolling 24h digest by running SQL
queries against c4.db. It can count messages but can't understand conversations,
extract domain knowledge, or decide what's worth persisting. This is fundamentally
the wrong approach — you need an LLM to extract meaning from conversations.

## Solution: LLM-driven shared knowledge maintenance

Replace the Node script with a **scheduled prompt** dispatched to the scheduler
instance. Claude reads conversations, extracts knowledge, and updates shared
memory files — the same pattern as the existing per-instance Memory Sync.

## Architecture

### Two complementary processes

| Process | Trigger | Scope | Output |
|---------|---------|-------|--------|
| **Per-instance Memory Sync** (existing) | Session init / high context | Single instance's conversations | `instances/<id>/state.md`, `sessions/current.md` |
| **Shared Knowledge Sync** (new) | Scheduled every 30 min | ALL instances' conversations | `shared/reference/*.md`, `shared/recent-activity.md` |

Per-instance sync handles private state. Shared sync handles cross-instance knowledge.

### Shared memory layout

```
~/zylos/memory/shared/
├── identity.md              # Bot personality (existing)
├── references.md            # Config pointers (existing)
├── recent-activity.md       # Rolling activity digest (auto-maintained)
├── reference/
│   ├── decisions.md         # Key decisions (existing, now auto-enriched)
│   ├── projects.md          # Project status (existing, now auto-enriched)
│   ├── preferences.md       # Team preferences (existing, now auto-enriched)
│   ├── ideas.md             # Uncommitted plans (existing, now auto-enriched)
│   ├── products.md          # Product knowledge (NEW, auto-maintained)
│   ├── customers.md         # Customer context (NEW, auto-maintained)
│   └── domain.md            # Industry/business knowledge (NEW, auto-maintained)
└── users/
    └── <id>/profile.md      # Per-user preferences (existing)
```

### What goes where

| Knowledge type | File | Examples |
|----------------|------|---------|
| Product info, pricing, features | `products.md` | "Product X supports 3 tiers: Basic ($29), Pro ($79), Enterprise (custom)" |
| Customer context, relationships | `customers.md` | "李萌慧 is focused on English teaching materials, prefers concise answers" |
| Business domain knowledge | `domain.md` | "Cross-border e-commerce requires ICP filing for .cn domains" |
| Decisions that close alternatives | `decisions.md` | "Chose Next.js over Nuxt for the marketing site (reason: team expertise)" |
| Project status and scope | `projects.md` | "识川AI智能获客平台: PRD complete, Phase 1 in development" |
| Team/workflow preferences | `preferences.md` | "All client deliverables must include both .md and .docx formats" |
| Uncommitted ideas | `ideas.md` | "Consider adding WeChat mini-program integration" |

### Classification heuristic for the LLM

When processing a conversation, ask:
1. Would another instance benefit from knowing this? → shared
2. Is this durable (still true next week)? → reference file
3. Is this ephemeral (only relevant today)? → recent-activity.md or skip
4. Is this private to one user? → user profile, not shared

## Implementation

### Delete shared-context.js

The Node script is replaced by a scheduled prompt. Delete it.

### Scheduled prompt: shared-knowledge-sync

Registered as a scheduled task targeting the scheduler instance:
```
name: shared-knowledge-sync
every: 1800 (30 min)
require_idle: true
priority: 3
target_instance: scheduler
```

The prompt:

```
[Shared Knowledge Sync]

You are maintaining the shared knowledge base that all instances read.

1. Fetch ALL instances' unsummarized conversations:
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized --all-instances

2. Read current shared knowledge files:
   - memory/shared/reference/products.md
   - memory/shared/reference/customers.md
   - memory/shared/reference/domain.md
   - memory/shared/reference/decisions.md
   - memory/shared/reference/projects.md
   - memory/shared/reference/preferences.md

3. From the conversations, extract DURABLE cross-instance knowledge:
   - New product information → products.md
   - Customer insights → customers.md
   - Business domain knowledge → domain.md
   - Decisions made → decisions.md
   - Project status changes → projects.md
   - Team preference changes → preferences.md

   Skip: ephemeral chatter, greetings, debugging details, single-instance tasks.

4. Write memory/shared/recent-activity.md with a brief activity digest:
   Per instance: message count, channels, last active, one-line summary of
   what they worked on. No message content — just awareness.

5. Create checkpoint to mark conversations as processed.
```

### c4-fetch.js change: --all-instances flag

The existing `c4-fetch.js --unsummarized` only returns conversations for the
current instance (filtered by ZYLOS_INSTANCE_ID). Add an `--all-instances` flag
that returns unsummarized conversations across ALL instances, for use by the
shared knowledge sync.

### memory-guard.js change

The memory guard currently allows non-primary instances to write to shared/
only through specific paths. The scheduler instance needs write access to all
shared/reference/ files. Update the guard to allow the scheduler instance
(or any instance running a shared-knowledge-sync task) to write to shared/.

### Session injection

session-start-inject.js already injects `shared/recent-activity.md` as
CROSS-INSTANCE CONTEXT. No change needed — the content just gets better
because it's now LLM-generated instead of SQL-counted.

## What this replaces

| Before | After |
|--------|-------|
| shared-context.js (Node script, SQL queries) | Scheduled prompt to scheduler instance |
| Message counts + channels | LLM-extracted knowledge + meaningful digest |
| No persistent knowledge accumulation | Shared reference files auto-enriched |
| Keyword extraction (broken for CJK) | Claude understands all languages |

## Migration

1. Delete `skills/multi-session/shared-context.js`
2. Add `--all-instances` flag to `c4-fetch.js`
3. Create initial `shared/reference/products.md`, `customers.md`, `domain.md` (empty templates)
4. Register the scheduled task via `zylos init` or manual scheduler CLI
5. The scheduled prompt handles everything else
