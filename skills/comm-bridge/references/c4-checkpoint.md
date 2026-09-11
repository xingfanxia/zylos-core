# c4-checkpoint.js — Checkpoint Interface

Creates and queries checkpoints that mark sync boundaries. Each checkpoint records a conversation id range: `start_conversation_id` is automatically computed from the previous checkpoint's end + 1, per instance.

Checkpoints are always instance-scoped: `create` and `latest` require a target instance — `ZYLOS_INSTANCE_ID` (set in every instance session) or an explicit `--target-instance <id>` — and error loudly without one. Unscoped (NULL-target) rows are invisible to every scoped reader and used to cause cross-instance context bleed.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js <command> [options]
```

## Subcommands

### create

Create a new checkpoint.

```bash
c4-checkpoint.js create <end_conversation_id> [--summary "<summary>"] [--target-instance <id>]
```

| Option | Description |
|--------|-------------|
| `<end_conversation_id>` | Last conversation id covered by this checkpoint (required) |
| `--summary <text>` | Checkpoint summary |
| `--target-instance <id>` | Instance to scope the checkpoint to (defaults to `ZYLOS_INSTANCE_ID`; errors if neither is set) |

**Output:**

```
Checkpoint created: {"id":2,"start_conversation_id":1,"end_conversation_id":50,"timestamp":"2025-01-15T10:00:00.000Z"}
```

### list

List checkpoints in reverse chronological order.

```bash
c4-checkpoint.js list [--limit <n>]
```

| Option | Description |
|--------|-------------|
| `--limit <n>` | Return only the most recent N checkpoints |

**Output:**

```json
[
  {
    "id": 3,
    "summary": "Synced conversations 101-150",
    "start_conversation_id": 101,
    "end_conversation_id": 150,
    "timestamp": "2025-01-17 10:00:00"
  },
  {
    "id": 2,
    "summary": "Synced conversations 51-100",
    "start_conversation_id": 51,
    "end_conversation_id": 100,
    "timestamp": "2025-01-16 10:00:00"
  }
]
```

### latest

Get the most recent checkpoint for this instance (scoped the same way as `create`: `ZYLOS_INSTANCE_ID` or `--target-instance`, errors without one).

```bash
c4-checkpoint.js latest [--target-instance <id>]
```

**Output:**

```json
{
  "id": 3,
  "summary": "Synced conversations 101-150",
  "start_conversation_id": 101,
  "end_conversation_id": 150,
  "timestamp": "2025-01-17 10:00:00"
}
```

## Examples

```bash
# Create a checkpoint
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js create 50 --summary "Synced conversations 1-50"

# List last 3 checkpoints
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js list --limit 3

# Get the latest checkpoint
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js latest
```
