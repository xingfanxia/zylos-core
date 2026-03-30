# Shared Knowledge Sync

You are maintaining the shared knowledge base that all instances read.
This runs as a scheduled task on the scheduler instance every 30 minutes.
No human supervision — execute the full flow autonomously.

## Step 1: Fetch Conversations

Fetch ALL instances' unsummarized conversations (not just your own):

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --unsummarized --all-instances
```

If the output says "No unsummarized conversations.", skip to Step 5 (still update the activity digest with a "no new activity" note). Otherwise, note the `end_id` from the `[Unsummarized Range]` line — you'll need it for the checkpoint in Step 5.

## Step 2: Read Current Shared Knowledge

Read these files to understand what's already known. Missing or empty files are fine — they'll be populated as knowledge is discovered.

```
~/zylos/memory/shared/reference/products.md
~/zylos/memory/shared/reference/customers.md
~/zylos/memory/shared/reference/domain.md
~/zylos/memory/shared/reference/decisions.md
~/zylos/memory/shared/reference/projects.md
~/zylos/memory/shared/reference/preferences.md
~/zylos/memory/shared/reference/ideas.md
```

## Step 3: Extract and Classify Knowledge

Process each conversation from Step 1. For each piece of information, ask:

1. **Would another instance benefit from knowing this?** If no, skip it.
2. **Is this durable (still true next week)?** If yes, write to a reference file. If no, it goes in the activity digest only.
3. **Is this private to one user?** If yes, skip — user profiles are managed by per-instance Memory Sync.

### Classification targets

| Knowledge type | Target file | Examples |
|----------------|-------------|---------|
| Product info, pricing, features, specifications | `products.md` | "Product X has 3 tiers: Basic ($29), Pro ($79), Enterprise (custom)" |
| Customer context, relationships, preferences | `customers.md` | "Customer Y prefers bilingual deliverables (EN+ZH)" |
| Business/industry domain knowledge | `domain.md` | "Cross-border e-commerce requires ICP filing for .cn domains" |
| Decisions that close off alternatives | `decisions.md` | "Chose Next.js over Nuxt for the marketing site (reason: team expertise)" |
| Project status changes, scope updates | `projects.md` | "Project Z: Phase 1 complete, entering Phase 2" |
| Team/workflow preference changes | `preferences.md` | "All client deliverables must include both .md and .docx formats" |
| Uncommitted plans, explorations | `ideas.md` | "Consider adding WeChat mini-program integration" |

### What to skip

- Greetings, small talk, ephemeral chatter
- Debugging details and stack traces (unless they reveal a product bug worth tracking)
- Single-instance operational tasks (deployments, config changes)
- Information already captured in the reference files
- Raw message content — extract the knowledge, don't copy messages

### Writing rules

- **Append, don't replace.** Add new entries below existing content. Never delete existing entries unless they're explicitly superseded.
- **Update in place** when new information supersedes an existing entry (e.g., project status changed). Add an "Updated: YYYY-MM-DD" note.
- **Be concise.** One to three sentences per entry. Include source context ("from [channel] conversation on [date]") when useful.
- **Preserve structure.** Follow the existing heading/formatting conventions in each file. If the file only has a header and "(No ... yet.)", replace that placeholder with the first entry.

## Step 4: Write Activity Digest

Write `~/zylos/memory/shared/recent-activity.md` with a brief cross-instance activity summary. This file is loaded at session start to give every instance situational awareness.

Format:

```markdown
# Recent Activity

Last updated: YYYY-MM-DD HH:MM

## Instance Activity

### <instance-id>
- **Channels:** <list of channels active>
- **Messages:** <count> since last sync
- **Summary:** <one-line summary of what this instance worked on>

### <instance-id>
...

## Key Events
- <Notable cross-instance events, decisions, or status changes — 3-5 bullets max>
```

Rules:
- Cover ALL instances that had activity, not just the busiest one.
- Keep summaries to one line per instance — this is awareness, not a transcript.
- The "Key Events" section captures anything that multiple instances should know about.
- If no new conversations were fetched, write "No new activity since last sync." under the last-updated timestamp and preserve the previous instance summaries.

## Step 5: Checkpoint

If conversations were fetched in Step 1, create a checkpoint to mark them as processed:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js create <end_id> --summary "Shared knowledge sync: <brief summary of what was extracted>"
```

Replace `<end_id>` with the value from Step 1's `[Unsummarized Range]` output.

If no conversations were fetched, skip this step.

## Completion

Report what was done:
- How many conversations were processed
- Which reference files were updated (if any)
- Whether the activity digest was refreshed
