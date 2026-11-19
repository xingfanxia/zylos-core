# c4-db.js — Database Module

Core database module for C4. Provides both a programmatic API (imported by other C4 scripts) and a standalone CLI for querying conversations and checkpoints.

## CLI Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js <command> [args]
```

## Commands

### init

Initialize the database (creates tables if not present).

```bash
c4-db.js init
```

### recent

Get the latest conversations (default: 20), printed in chronological order.

```bash
c4-db.js recent [limit]
```

**Output:** JSON array of the latest conversation records, oldest to newest within the returned slice.

```json
[
  {
    "id": 3126,
    "timestamp": "2026-02-23 04:04:26",
    "direction": "in",
    "channel": "telegram",
    "endpoint_id": "1234567890",
    "content": "[TG DM] alice said: hello",
    "status": "delivered",
    "priority": 3,
    "require_idle": 0,
    "retry_count": 0
  }
]
```

### unsummarized

Show the range and count of conversations not yet covered by a checkpoint.

```bash
c4-db.js unsummarized
```

**Output:**

```json
{
  "begin_id": 3032,
  "end_id": 3125,
  "count": 94
}
```

### checkpoint

Disabled — it created unscoped (NULL `target_instance`) rows that
instance-scoped readers can never see. Create checkpoints through
`c4-checkpoint.js`, which forces an instance scope:

```bash
c4-checkpoint.js create <end_conversation_id> [--summary "..."] [--target-instance <id>]
```

### checkpoints

List all checkpoints in reverse chronological order.

```bash
c4-db.js checkpoints
```

### insert

Insert a conversation record (used by other scripts; rarely needed directly).

```bash
c4-db.js insert <direction> <channel> <endpoint_id> <content>
```

## Programmatic API

When imported by other C4 scripts, `c4-db.js` exports:

| Function | Purpose |
|----------|---------|
| `getDb()` | Get/initialize SQLite connection (WAL mode) |
| `insertConversation()` | Queue a new message |
| `getNextPending()` | Get highest-priority pending incoming message |
| `claimConversation(id)` | Atomically claim a pending message for delivery |
| `markDelivered(id)` | Mark a message as delivered (and delete its `in_flight` delivery record in the same transaction) |
| `getRecentConversations(limit)` | Get recent conversations |
| `getUnsummarizedRange()` | Get range/count of unsummarized conversations |
| `getConversationsByRange(begin, end)` | Fetch conversations by id range |
| `getConversationsSince(since)` | Fetch conversations at or after a UTC timestamp |
| `createCheckpoint(endId, summary)` | Create a sync checkpoint |
| `getLastCheckpoint()` | Get the most recent checkpoint |
| `formatConversations(records)` | Format records into readable text |
| `insertControl()` | Queue a control message |
| `getNextPendingControl()` | Get next pending control item |
| `claimControl(id)` | Claim a control item for processing |
| `ackControl(id)` | Mark a control item as done (and delete its `in_flight` / `submitted` delivery record in the same transaction) |
| `bindControlSession(id, sessionRef)` | Bind a claimed control to a session unless already bound → `{ sessionRef, stamped }` |
| `supersedeControl(id, reason)` | Supersede one pending/claimed control (final) |
| `supersedeControlsForSession({ instanceId, sessionRef, reason })` | Supersede the pending and claimed `[KEYSTROKE]` controls bound to a replaced session → `{ superseded }` |
| `recordUncertainDelivery({ itemType, itemId, dialogKind, sessionRef })` | Record that a limit dialog followed this row's Enter; finalizes the row without replay (dispatcher) |
| `beginDelivery({ itemType, itemId, sessionRef })` | Right before a row's paste: record it `in_flight` in `delivery_uncertain`; refused (`{ ok: false, outcome }`) when the row already has an `in_flight`, `submitted` or `uncertain` record (a row is pasted at most once) |
| `markDeliverySubmitted({ itemType, itemId })` | An ack-mode control's verified submission: its record waits for the ack (`submitted`) |
| `settleInterruptedDeliveries()` | Dispatcher start: every `in_flight` record becomes uncertain (`interrupted`) with the row rules of `recordUncertainDelivery` → `{ conversations, controls }` |
| `resolveUncertainDelivery({ itemType, itemId, resolution })` | A person's resolution of an uncertain row: `delivered` or `redeliver` (CLI: `c4-db.js uncertain delivered|redeliver <conversation|control> <id>`) |
| `getUncertainDeliveries({ instanceId, unnotifiedOnly = true, limit = 50, kinds })` | Uncertain records (outcome `uncertain`, oldest first; `kinds` limits `dialog_kind`) with a 120-char conversation preview, for the operator notification |
| `markUncertainDeliveryNotified(id)` | Mark an uncertain record as notified |
| `close()` | Close database connection |
