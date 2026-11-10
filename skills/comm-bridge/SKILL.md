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

### Session fence (`sessionRef`)

A raw key belongs to one Claude session, so every `[KEYSTROKE]` control is fenced to the session it was meant for:

- **`sessionRef`** = the tmux pane identity `${session_id}:${session_created}:${pane_id}:${pane_pid}` (example `$3:1762790000:%12:48211`), the same string the dispatcher reads with every frame (`readTmuxInputState().paneIdentity`). A Guardian or Fable-guard relaunch kills the tmux session and creates a new one, so each relaunch has a new `sessionRef`. Read it with `readSessionRef(sessionName)` (`scripts/tmux-input-state.js`, re-exported by `cli/lib/tmux-input-state.js`).
- **Stored** in `control_queue.session_ref` (`migrations/003-add-control-session-ref.sql`; `NULL` = unbound). An enqueuer that knows the session passes it: `c4-control.js enqueue --session-ref <ref>` or `insertControl(content, { sessionRef })`. Otherwise the dispatcher binds the key to the pane it reads when it claims the row, before any modal deferral.
- **Before every key** the dispatcher reads the target pane once (the only tmux call before `send-keys`) and decides (`fenceKeystrokeControl`): unreadable pane → no key, a retry is consumed; bound to another `sessionRef` → `superseded` (`SESSION_REPLACED`); unbound and queued before the current session started (`created_at < session_created`) → `superseded` (`SESSION_PREDATES`); modal other than a permission prompt → deferred; otherwise the key is sent. A superseded row is final: requeue, ack, claim and orphan reset leave it alone. An equivalent new key only replaces a pending key of the same binding.
- **Replacing a session** (activity monitor, before or at relaunch): `supersedeControlsForSession({ instanceId, sessionRef, reason })` from `scripts/c4-db.js`, with the OLD session's `sessionRef` read before the kill. It supersedes that session's pending and already-claimed keys and returns `{ superseded: n }`; keys bound to any other session (the replacement's) and unbound keys are not touched (the claim-time fence covers unbound ones).
- **Limit:** a relaunch inside a surviving tmux pane (Claude restarted from the pane's shell) keeps the same `sessionRef`; the fence cannot tell those two processes apart.

## Modal Delivery Guard

**Always on for Claude.** This guard is part of both dispatchers for every Claude-runtime pane (all personas), whether or not the Fable allowance guard is configured; there is no switch. Non-Claude runtimes skip modal detection. With no modal on screen, message delivery issues exactly the same tmux calls as before the guard (base `d16221a4`); `scripts/__tests__/fixtures/base-delivery-calls.d16221a.json` pins that sequence for both dispatchers. A `[KEYSTROKE]` control costs one pane read directly before the key (modal check and session fence); the key call itself is unchanged.

While a Claude Code dialog or select list owns the pane's keyboard (`detectModal()` in `scripts/tmux-input-state.js`: the usage-credits / Fable-limit consent dialog, any other dialog, the `/usage` overlay), both dispatchers paste nothing and send no Enter (initial or retry) and no `[KEYSTROKE]` key. Each Enter is decided by the pane read directly before it (no await and no other tmux call in between): that read must have succeeded, must show the pane the text was pasted into (pane identity = `session_id:session_created:pane_id:pane_pid`), and must show no modal. A failed capture or a replacement pane gets no Enter. The row is deferred: it is released back to pending without consuming a retry and is never recorded as delivered; multi-session holds it for the cycle (`heldReasons.modal`) and keeps serving other instances. It is delivered once the modal is gone, or into the replacement pane after a restart when the old pane never received Enter for it. The one exception is a recognized permission prompt, which `[KEYSTROKE]` may still answer (auto-approve). Dialogs are classified by identity, never by wording found somewhere inside them: the title row (first row under the pane divider), the option set (the limit dialog's options are unnumbered and come from its fixed answer list; permission prompts and AskUserQuestion number theirs) and the question row directly above the options (`Do you want to …?`). So a permission prompt for `echo "You've reached your Fable limit"`, a diff preview or tool output carrying that sentence stays a permission prompt or an `unknown` modal. `classifyLimitDialog()` names a live limit dialog (`fable_limit` / `credits_offer`); its title/option lists track the CLI text, and a miss still blocks delivery as an `unknown` modal.

Any process with access to `c4-control.js` can enqueue keystroke controls. This mirrors the existing reality that any process can call `tmux send-keys` directly — the C4 queue adds priority ordering and delivery guarantees, not access control.

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher
```
