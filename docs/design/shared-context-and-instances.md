> **Superseded by [../multi-session.md](../multi-session.md)** — design implemented as described. See "Shared Knowledge System" section.

# Shared Context Layer & Instance Architecture — Design (ARCHIVED)

## Problem

In multi-session mode, each CC instance is an isolated silo. User-betty knows nothing about what admin discussed, group chats are invisible to DM instances, and scheduled tasks pollute the admin context.

## Instance Architecture

### Instance types and their roles

| Instance | Type | Lifecycle | Purpose |
|----------|------|-----------|---------|
| admin | dedicated, primary | always-on | System management, owner DMs, receives fallback routing |
| scheduler | dedicated | on-demand | Runs scheduled tasks (upgrades, digests, news) — keeps admin context clean |
| group | group | on-demand | Handles ALL group chat messages — cross-group awareness in one context |
| user-X | dedicated | on-demand | Private DM instances — privacy, isolation, full context budget |

All non-primary instances are on-demand: auto-start when message arrives, auto-stop after 30min idle.

### On-demand lifecycle

Non-primary instances are on-demand by design:
- **Auto-start:** When a message targets an offline instance, the dispatcher creates the tmux session and requeues the message for delivery after boot
- **Auto-stop:** Instances with no deliveries for 30 minutes get reaped by the dispatcher
- Primary instance (admin) is never auto-stopped

### Routing rules

1. Group chats detected by: Feishu `oc_` prefix, `|type:group`, Telegram negative chat_id → route to `group` instance
2. Scheduled tasks with no explicit `target_instance` → route to `scheduler` instance
3. Known DM endpoints → route to their user instance (via routing table or chat_ids in instance def)
4. Unknown endpoints → hold for approval (approval flow creates a new user instance)
5. Fallback → `default_instance` (admin)

## Shared Context Layer

### The problem with message previews

Dumping raw message previews (first 150 chars) into a digest is:
- Privacy-violating (user DM content leaks to other instances)
- Noisy (most messages are not cross-relevant)
- Not actionable (a truncated message doesn't give enough context to act on)

### Better approach: structured activity summary

The shared context digest should provide **awareness, not content**. Each instance needs to know:
- What topics/projects other instances are working on
- Whether another instance handled something relevant to the current conversation
- How to request cross-instance context when needed (query the other instance via C4)

### Digest format

```markdown
# Cross-Instance Activity Digest
Updated: 2026-03-30 10:30 UTC (auto-generated every 30 min)

## admin (primary)
- 3 messages via web-console
- Active tasks: system monitoring

## scheduler
- 5 tasks executed: daily-upgrade, news-digest, shared-context-digest, memory-commit, upgrade-check
- All completed successfully

## group (盘盘猫科技, Product Team)
- 12 messages via feishu, telegram
- 3 participants active

## user-betty
- 8 messages via telegram
- Active since 09:15 UTC

## user-limh
- 3 messages via telegram
- Last active 08:45 UTC
```

### What the digest does NOT include
- Message content or previews (privacy)
- Internal system messages (heartbeats, health checks)
- Outbound messages (only tracks inbound activity)

### What an instance can do when it needs more context
When user-betty's instance needs to know "did the group discuss project X?", it can:
1. Check the digest for "group is active"
2. Send a C4 message to the group instance asking for context
3. The group instance (which has the full conversation history) responds with relevant context

This is the "ask, don't leak" model — cross-instance awareness without cross-instance content sharing.

### Implementation

**shared-context.js** (scheduled task, runs every 30 min):
1. Opens c4.db readonly
2. Queries inbound messages from last 24h, grouped by target_instance
3. For each instance: message count, channels, last active timestamp
4. For scheduler instance: also queries task_history for completed task names
5. Writes `memory/shared/recent-activity.md` atomically
6. No message content in the output — counts and metadata only

**Session injection** (session-start-inject.js):
- Reads `memory/shared/recent-activity.md` if it exists
- Injects as `CROSS-INSTANCE CONTEXT` section
- Gives the instance awareness of system activity without leaking content

### Scheduler instance integration

The scheduler daemon should:
1. Read `scheduler_instance` from instances.json
2. Default all tasks without explicit `target_instance` to the scheduler instance
3. The scheduler instance auto-starts when a task is due, runs it, auto-stops after 30min idle

This keeps the admin instance clean for interactive work and system management.

## Decisions

1. **One group instance, on-demand.** Handles all groups. Auto-starts on first group message, auto-stops after 30min idle.
2. **Scheduler instance, on-demand.** All tasks without explicit target_instance default here. Auto-starts when task is due, auto-stops after idle.
3. **Inter-instance queries via C4.** All instances can talk to each other using `channel: internal`. No new infrastructure — C4 already routes by target_instance. Auto-start handles offline targets.
4. **Digest runs on scheduler instance.** It's a scheduled task like any other.

## Inter-Instance Communication

### How it works

C4 is already a message bus. Inter-instance communication uses it directly:

```
Instance A → c4-receive --channel internal --endpoint instance-A --target-instance B --content "question"
  → dispatcher routes to B (auto-starts if offline)
  → B processes, replies via: c4-send "internal" "instance-A"
  → dispatcher routes reply to A (auto-starts if offline)
  → A reads the reply in its conversation stream
```

### Helper: c4-query-instance.js

A convenience script that wraps the send + wait-for-reply pattern:

```bash
node c4-query-instance.js --from betty --to group --content "What was discussed about project X?"
```

Under the hood:
1. Generates a unique query ID
2. Sends via c4-receive with channel=internal, endpoint=instance-<from>, target-instance=<to>
3. Tags the message with the query ID so the reply can be correlated
4. Optionally polls for a reply (or fire-and-forget)

### Convention: channel "internal"

- `channel: internal` = inter-instance communication
- Not shown in external channel UIs (Telegram, Feishu)
- Replies use the same channel/endpoint pattern as external messages
- The `endpoint` is the requesting instance ID, enabling reply routing

### CLAUDE.md documentation

Instances should know they can:
- Read the shared context digest for awareness
- Query another instance for detailed context via C4 internal channel
- The target instance will auto-start if offline

Example prompt for CLAUDE.md:
```
When you need context from another instance (e.g., what the group discussed),
you can query it directly:
  node ~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel internal --endpoint instance-<your-id> \
    --target-instance <target-id> \
    --content "What was discussed about <topic>?"
The target instance will receive your question and reply via C4.
```
