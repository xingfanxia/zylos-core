---
name: comm-bridge
description: >-
  C4 communication bridge — central gateway for ALL external communication (Telegram, Lark, etc.).
  Use when replying to users via the "reply via" path, sending proactive messages to external channels,
  querying recent conversations or checkpoint status (prefer c4-db.js CLI; sqlite3 OK for unsupported queries),
  fetching conversation history for Memory Sync, or creating checkpoints after sync.
  Incoming messages are queued by channel bots and delivered to Claude via a PM2 dispatcher daemon.
  Session-start hooks automatically provide conversation context and can trigger Memory Sync when unsummarized conversations exceed the configured threshold.
---

# Communication Bridge (C4)

Central message hub - ALL communication with Claude goes through C4.

## Architecture

```
Web Console ──┐
Telegram    ───┼──► C4 Bridge ◄──► Claude
Lark        ───┘
```

## Components

| Script | Purpose | Reference |
|--------|---------|-----------|
| `c4-receive.js` | External → Claude (queue incoming messages) | [c4-receive](references/c4-receive.md) |
| `c4-send.js` | Claude → External (route outgoing messages) | [c4-send](references/c4-send.md) |
| `c4-control.js` | System control plane (heartbeat, maintenance) | [c4-control](references/c4-control.md) |
| `c4-dispatcher.js` | PM2 daemon: polls pending queue, delivers to tmux | — |
| `c4-session-init.js` | Hook (session start): context + Memory Sync trigger | [hooks](references/hooks.md) |
| `c4-fetch.js` | Fetch conversations by id range or time | [c4-fetch](references/c4-fetch.md) |
| `c4-db.js` | Database module and CLI for querying conversations and checkpoints | [c4-db](references/c4-db.md) |
| `c4-checkpoint.js` | Create/query checkpoints (sync boundaries) | [c4-checkpoint](references/c4-checkpoint.md) |

## Sending Messages

```bash
# Send to Telegram DM
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! Quotes, $vars, **markdown** — all safe via stdin.
EOF

# Send to Lark group thread
cat <<'EOF' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx|type:group|root:msg_yyy"
Report ready.
EOF
```

Always pipe messages via stdin heredoc — never pass as CLI arguments. See [c4-send](references/c4-send.md) for full reference.
Treat the heredoc wrapper as fixed shell syntax: only the message body goes between the start line and the closing terminator line, and the terminator itself must never be copied into the actual outgoing message.

**Attachments** are sent by prefixing the message with `[MEDIA:file]<path>` or
`[MEDIA:image]<path>`. For isolated instances the send is performed by the
global broker, which runs as a different unix user and cannot read your private
`~/workspace`. Attach files from your publish area
`~/zylos/workspace/users/<your-instance>/` (or another broker-readable shared
path) — an unreadable path is rejected before send with
`attachment_unreadable: broker cannot read <path>; publish it under ~/zylos/workspace/users/<instance>/ and resend`,
and no message is delivered. Prefer absolute paths. The `[MEDIA:type]<path>`
directive occupies its own line — the file path is the rest of that line, so
put nothing else on it. Text on the other lines is a caption, delivered as a
separate text message IN ORDER: a lead-in above the directive is sent before the
file, a caption below it after. (Multiple `[MEDIA:]` directives per message are
not supported — send one file per message.)

A broker send waits for the channel to finish, attachment upload included; the
broker stops a send after 135 s. If c4-send reports `Broker send outcome
unknown` or `channel_send_timeout`, the message may already have been
delivered: do not resend it yet. Check what you sent with

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js --recent 5
```

Each line is `#id time status channel chat preview`; status is `sending`,
`delivered`, `failed` or `unknown`. Resend only a `failed` message; for
`unknown`, ask the recipient whether it arrived.


## Database

SQLite at `~/zylos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out) with priority, status, retry tracking
- `checkpoints`: Recovery points with conversation id ranges
- `control_queue`: System control messages (heartbeat, maintenance) with priority, ack deadlines, and status lifecycle

## Health & Status

The activity monitor writes `~/zylos/activity-monitor/agent-status.json` which includes a `health` field:

| Value | Meaning |
|-------|---------|
| `ok` | System healthy, messages accepted normally |
| `recovering` | Legacy persisted liveness state; normalized to unavailable at runtime |
| `down` | Legacy persisted liveness state; normalized to unavailable at runtime |

**Fail-open semantics**: If the status file is missing or malformed, health is assumed `ok` — intake is never blocked by a read failure.

When health is not `ok`, `c4-receive.js` asks the activity monitor MessageRouter how to route the current message. Unhealthy messages are recorded as delivered and receive an immediate status reply when replies are enabled; `--no-reply` messages are accepted silently. If the MessageRouter IPC is unavailable, `c4-receive.js` falls back to the status file with the same delivered/current-message behavior.

## Keystroke Delivery

The dispatcher supports `[KEYSTROKE]` control messages for sending raw keystrokes to the tmux session. This is an **ops-level capability** — no source gating is applied.

When a control message content starts with `[KEYSTROKE]`, the dispatcher:
- Extracts the key name (e.g., `Enter`, `Tab`, `Escape`)
- Sends it directly via `tmux send-keys` (no buffer paste, no "Meanwhile" prefix, no verification)
- Auto-acks the control immediately after delivery

Example: the permission auto-approve hook enqueues `[KEYSTROKE]Enter` at priority 0 with bypass-state to auto-confirm Claude Code's permission prompts.

## Modal Delivery Guard

While a Claude Code dialog or select list owns the pane's keyboard (`detectModal()` in `scripts/tmux-input-state.js`: the usage-credits / Fable-limit consent dialog, any other dialog, the `/usage` overlay), both dispatchers paste nothing and send no Enter (initial or retry) and no `[KEYSTROKE]` key. Each Enter is preceded by its own fresh pane read. The row is deferred: it is released back to pending without consuming a retry and is never recorded as delivered; multi-session holds it for the cycle (`heldReasons.modal`) and keeps serving other instances. It is delivered once the modal is gone, or into the replacement pane after a restart when the old pane never received Enter for it. The one exception is a recognized permission prompt, which `[KEYSTROKE]` may still answer (auto-approve). `classifyLimitDialog()` names a live limit dialog (`fable_limit` / `credits_offer`); its wording list tracks the CLI text, and a wording miss still blocks delivery as an `unknown` modal.

Any process with access to `c4-control.js` can enqueue keystroke controls. This mirrors the existing reality that any process can call `tmux send-keys` directly — the C4 queue adds priority ordering and delivery guarantees, not access control.

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher
```
