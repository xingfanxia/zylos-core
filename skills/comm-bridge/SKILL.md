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

A channel may add one plain sentence to the result (Feishu media sends do):
`sent: … (message om_…)`, `not sent: <why and what would work>`, or
`unknown: …`. Tell the user a file was sent only on `sent`, follow the
`not sent` advice, and never resend an `unknown` one.


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
- Sends it directly via `tmux send-keys` to the pane id read just before it (see Pane-id targeting; no buffer paste, no "Meanwhile" prefix, no verification)
- Auto-acks the control immediately after delivery

Example: the activity monitor's tool watchdog binds its interrupt key (`Escape`) with `--session-ref`, reading the adapter's tmux session with `readSessionRef()` right before the enqueue; its dialog watch queues a plain `[KEYSTROKE]Escape` bound to the pane (`session_ref`) and to the permission prompt it cancels (`dialog_ref`, migrations/005, out of band), and only after the running dispatcher (and broker, for an isolated persona) published that it enforces the binding (Schema readiness and capabilities, below). Nothing queues an approving key (the former auto-approve hook only logs). When that read is impossible (no `TMUX_PANE`, or an os_user-isolated CLI that cannot reach the service user's tmux socket) the key is enqueued unbound and the claim-time fence below applies (the watchdog logs it).

### Session fence (`sessionRef`)

A raw key belongs to one Claude session, so every `[KEYSTROKE]` control is fenced to the session it was meant for:

- **`sessionRef`** = the tmux pane identity `${session_id}:${session_created}:${pane_id}:${pane_pid}` (example `$3:1762790000:%12:48211`), the same string the dispatcher reads with every frame (`readTmuxInputState().paneIdentity`). A Guardian or Fable-guard relaunch kills the tmux session and creates a new one, so each relaunch has a new `sessionRef`. Read it with `readSessionRef(sessionName)` (`scripts/tmux-input-state.js`, re-exported by `cli/lib/tmux-input-state.js`).
- **Stored** in `control_queue.session_ref` (`migrations/003-add-control-session-ref.sql`; `NULL` = unbound). An enqueuer that knows the session passes it: `c4-control.js enqueue --session-ref <ref>` or `insertControl(content, { sessionRef })`. Otherwise the dispatcher binds the key to the pane it reads when it claims the row, before any modal deferral.
- **Before every key** the dispatcher reads the target pane once (the only tmux call before `send-keys`) and decides (`fenceKeystrokeControl`): unreadable pane → no key, a retry is consumed; bound to another `sessionRef` → `superseded` (`SESSION_REPLACED`); unbound and queued before the current session started or in the same second (`created_at <= session_created`; both are whole seconds, so a same-second key is ambiguous and fenced) → `superseded` (`SESSION_PREDATES`); a dialog-bound key (`dialog_ref`) whose prompt (same pane, same prompt `id`) is not on screen → `superseded` (`DIALOG_GONE`); any key but Escape while a permission prompt is up, whatever its origin or age (Enter, a digit, `y`, text) → `superseded` (`PERMISSION_PROMPT`): an unattended prompt is only ever cancelled; any other modal → deferred, every key including Escape; otherwise the key is sent. Escape keys are claimed before any other control of their priority (`CONTROL_CLAIM_ORDER` in `c4-db.js`).
- **Session-bound text controls:** a control with a `session_ref` that is not a key (the dialog watch's decline message) is pasted only into that pane: if the first read before the paste shows another pane identity it is `superseded` (`SESSION_REPLACED`), never pasted. A superseded row is final: requeue, ack, claim and orphan reset leave it alone. An equivalent new key only replaces a pending key of the same binding (same `session_ref` and `dialog_ref`): an unbound Escape never replaces a dialog-bound one. The dialog watch's rows go through `insertDialogControl` instead: at most one Escape and one notice per (instance, `session_ref`, `dialog_ref`) in any status, enforced by unique partial indexes (migrations/006) and recovered rather than duplicated; its reads and withdrawals (`findDialogControl`, `withdrawDialogControl`) are scoped in SQL to instance, pane, prompt and kind, never a bare id. The broker never sets `dialog_ref` (a persona cannot forge a bound row).
- **Schema readiness and capabilities:** a missing or blocked migration is never an outage. Every opener (`getDb()`) applies pending migrations (each with its ledger row in one write-locked transaction), logs a failure once (`[c4-db] Migration error: …`) and serves with the schema it finds, as before. Only the dialog binding depends on migrations/005 and 006: while `control_queue.dialog_ref` is missing the claim queries select `NULL AS dialog_ref`, `insertControl` leaves out its `dialog_ref` equivalence clause (the statement is the base's) and the held-work count drops its filter; no row can be bound without the column. A migration, and every other optional write of the dialog binding (capability publish, refresh and withdraw, the watch's state save), waits at most 250 ms for the write lock (never the connection's 5 s, which deliveries keep): a busy database only means a later attempt, and a capability that could not be refreshed goes stale by the 3-minute rule. `c4-dispatcher` and `c4-broker` serve first (the loop, the sockets) and then run `startDialogSchemaCheck()`, first attempt a second later: it applies pending migrations strictly and requires, from the database alone, the `_migrations` rows of 005 and 006 by name, the column, both tables and both indexes (`verifyDialogSchema()`), then publishes. A schema gap and a failed publication share one backoff (2 s doubling to 60 s) and one log line a minute at most (`<process>: dialog binding not ready (<reason>); serving as before without it, capability not published; retrying`). Once both succeed each publishes `dialog_ref` in `c4_process_capabilities` (process, pid, the process's start time from the operating system; refreshed every minute; deleted at exit) and logs `<process>: dialog binding schema verified; capability published`. `hasLiveCapability()` is false without the schema, for a row older than 3 min, or when the process with that pid is not running or started at another time (`processStartTime()`: /proc on Linux, `ps` elsewhere).
- **Replacing a session** (activity monitor, before or at relaunch): `supersedeControlsForSession({ instanceId, sessionRef, reason })` from `scripts/c4-db.js`, with the OLD session's `sessionRef` read before the kill. It supersedes that session's pending and already-claimed keys and returns `{ superseded: n }`; keys bound to any other session (the replacement's) and unbound keys are not touched (the claim-time fence covers unbound ones).
- **Pane-id targeting:** every send — the paste, each Enter, each `[KEYSTROKE]` key — targets the immutable pane id (`%N`, the `pane_id` field of the `sessionRef` the deciding read returned), never the reusable session name. The paste goes to the pane of the read that found the composer empty, an Enter to the pane of the read that allowed it (the same identity as the paste), a key to the pane of the fence read. A session replaced under the same name in between makes the send fail (`can't find pane`), handled as any failed send: no redirect, no delivered mark (a paste → the row is recorded uncertain, its text may have reached the old pane; an Enter → the row is recorded uncertain (Own draft only, below); a key → `KEYSTROKE_ERROR`, a retry is consumed). Reads and sends run the same `tmux` client in the same environment (no `-L`/`-S` anywhere), so they address the same server; pane ids are unique and monotonic within a server, and a server restart between read and send is caught because each read compares the full identity (`session_created`, `pane_pid`). Only when no identity was read does a send fall back to the session name (`sendTarget()` in `scripts/c4-dispatcher.js`).
- **Limit:** a relaunch inside a surviving tmux pane (Claude restarted from the pane's shell) keeps the same `sessionRef`; the fence cannot tell those two processes apart.

## Modal Delivery Guard

**Always on for Claude.** This guard is part of both dispatchers for every Claude-runtime pane (all personas), whether or not the Fable allowance guard is configured; there is no switch. Non-Claude runtimes skip modal detection. With no modal on screen, message delivery issues exactly the same tmux calls as before the guard (base `d16221a4`) except for one intended difference: the target argument of `send-keys` / `paste-buffer` is the pane id instead of the session name (Session fence → Pane-id targeting). `scripts/__tests__/fixtures/base-delivery-calls.d16221a.json` pins the base sequence for both dispatchers; the tests map only that argument (`baseWithPaneTargets()` in `fixtures/tmux-pane-model.js`). A `[KEYSTROKE]` control costs one pane read directly before the key (modal check and session fence).

While a Claude Code dialog or select list owns the pane's keyboard (`detectModal()` in `scripts/tmux-input-state.js`: the usage-credits / Fable-limit consent dialog, any other dialog, the `/usage` overlay), both dispatchers paste nothing and send no Enter (initial or retry) and no `[KEYSTROKE]` key. Each Enter is decided by the pane read directly before it (no await and no other tmux call in between): that read must have succeeded, must show the pane the text was pasted into (pane identity = `session_id:session_created:pane_id:pane_pid`), and must show no modal. A failed capture or a replacement pane gets no Enter. The Enter targets the pane id of that read, so a session killed and recreated under the same name between the read and `send-keys` makes the Enter fail rather than reach the replacement. The row is deferred: it is released back to pending without consuming a retry and is never recorded as delivered; multi-session holds it for the cycle (`heldReasons.modal`) and keeps serving other instances. It is delivered once the modal is gone, or into the replacement pane after a restart when the old pane never received Enter for it. The one exception is `[KEYSTROKE]Escape` to a positively identified permission prompt (cancellation); no other key and no paste ever reaches a permission prompt (Session fence above). Dialogs are classified by identity, never by wording found somewhere inside them: the title row (first row under the pane divider), the option set (the limit dialog's options are unnumbered and come from its fixed answer list; permission prompts and AskUserQuestion number theirs) and the question row directly above the options (`Do you want to …?`). Kind `permission` is given only on positive identification, read up from the bottom: no composer on screen, the prompt's own guide row (`Esc to cancel …`) last, its numbered option block (one focused row, 1..n, a "Yes" first and a "No") directly above, the question row directly above that, and only indented rows, blank rows or column-0 dashed rules (`╌`, which frame a Bash command since CLI 2.1.326; read as transcript rows they made the dangerous-command prompt an untitled `unknown` modal on 2026-11-18) up to the pane divider. It returns the title, the `│` notice rows of a safety check as `notice`, and an `id` hashed over the prompt's rows except the CLI's own auto-block countdown. Dashed rules count only inside that match, so a menu printed in the transcript above a composer stays no modal. So a permission prompt for `echo "You've reached your Fable limit"`, a diff preview or tool output carrying that sentence stays a permission prompt or an `unknown` modal. `classifyLimitDialog()` names a live limit dialog (`fable_limit` / `credits_offer`); its title/option lists track the CLI text, and a miss still blocks delivery as an `unknown` modal.

### Uncertain outcome after a limit dialog

When a Fable-limit / usage-credits dialog (`classifyLimitDialog`) is read right after the dispatcher sent Enter for a row, the CLI holds that message behind the dialog: it reaches the model or not depending on the answer. The dispatcher therefore records the row as **uncertain**, never as delivered, and never replays it. It catches the dialog on the read after Enter, on the next cycle's first read while the submission is still unverified, and up to 30 s after a submission it had just verified on the same pane (the row is re-marked). A dialog that no later dispatcher read sees (no further rows for that pane) is not attributed here; the activity monitor's own evidence covers it by time only.

- **Record:** table `delivery_uncertain` in `c4.db` (`migrations/004-add-delivery-uncertain.sql`): `item_type` (`conversation`/`control`), `item_id`, `target_instance`, `channel`, `endpoint_id`, `session_ref` (pane the Enter went to), `dialog_kind` (`fable_limit`/`credits_offer`), `outcome='uncertain'`, `detected_at`, `notified_at`. One record per row.
- **Row status:** a conversation becomes `uncertain`; an ack-mode control stays `running` (its ack or ack deadline decides); a no-ack control becomes `failed` with `last_error = DELIVERY_UNCERTAIN:<kind>`.
- **Query (activity monitor / operator notification):** `getUncertainDeliveries({ instanceId, unnotifiedOnly = true, limit })` from `scripts/c4-db.js` returns the records with a 120-character preview of the conversation text; after notifying, call `markUncertainDeliveryNotified(id)`. Nothing is replayed automatically; whether to resend is the operator's call.

### Own draft only, at most once (2026-11-19)

The persona windows were tmux's default 80x24, and a message of a few hundred characters scrolled Claude Code's composer past its prompt row. The reader saw no prompt (`indeterminate`), the dispatcher never observed its own paste, left it in the composer and failed that row and every later one for user-pan, user-elaine and the scheduler within seconds, for hours, with no alert. The rule since: no way to send Enter or to paste beyond the deployed head's, except one, Enter on the dispatcher's own complete draft; whatever cannot be confirmed waits for a person.

- **Window size:** agent sessions are created at 200x60 and the active window pinned there by its window id (`AGENT_WINDOW`, `tmuxPinAgentWindow` in `cli/lib/runtime/tmux-helpers.js`; `resize-window` sets `window-size` manual, so an attached client no longer shrinks it; a larger window keeps its size). At 200x60 Claude Code's composer shows 25 rows. A pasted message is at most 800 characters and 2048 bytes (longer ones are spilled first); 800 double-width characters with two line breaks (a third collapses the paste into one placeholder row), more than that limit allows, take 11 rows, so a pasted message is never scrolled.
- **Reader:** a Claude composer scrolled past its prompt row reads `has_content` (`composerScrolled`; the cursor inside the composer's two column-0 rules, every row between and below them blank or indented). Codex keeps its prompt row when it scrolls and is read as before.
- **Enter only on the own draft:** after a paste the dispatcher sends Enter only when a read shows the complete draft in the composer equal to the pasted text, whitespace removed (`ownDraftOnScreen` in `scripts/tmux-input-state.js`): Claude, the rows from the `❯` row to the bottom rule, or Claude Code's collapsed placeholder `[Pasted text #N +M lines]` as the whole draft (it shows that a paste is there, not whose; the deployed head accepted any non-empty prompt row); Codex, the rows from the `›` row to the first blank row, with no `↑`/`↓` scroll mark. A scrolled composer, a different draft, a blank panel or anything else gets no key. At most one Enter per row: the deployed head's retried Enter on text that stayed is gone.
- **A composer that is not free:** a row whose turn comes while the composer is not empty (and not its own retained draft) or is unreadable is `held`: not attempted, no retry consumed, no key, no paste; both dispatchers hold it like a modal (multi-session: the `paste` class, other personas served). The activity monitor marks the session `delivery_stuck` once an idle composer has not been empty for 60 s and alerts (activity-monitor SKILL.md, Dialog watch).
- **Pasted at most once, durably:** right before a row's text reaches the pane (`set-buffer` done, `paste-buffer` next) the dispatcher writes a `delivery_uncertain` record with outcome `in_flight` (`beginDelivery`), refused when the row already has an `in_flight`, `submitted` or `uncertain` record. Recording success deletes it in the same transaction (`markDelivered`, `ackControl`); an ack-mode control's verified submission sets it to `submitted` until its ack. At start the dispatcher turns every remaining `in_flight` record into `uncertain` (`interrupted`) before releasing rows left running (`startupReconcile`).
- **Uncertain, not failed, never replayed:** a paste never seen as its own draft (`paste_unverified`, including a modal that swallowed it and text lost with a replaced pane), an Enter not confirmed (`enter_unverified`), an attempt cut off by a restart (`interrupted`), and the existing limit-dialog case are recorded through `recordUncertainDelivery` (row rules unchanged: a conversation becomes `uncertain`, an ack-mode control stays running until its ack or deadline, a no-ack control becomes `failed` with `DELIVERY_UNCERTAIN:<kind>`). Still decided by observation alone, with no further key: a working model after the Enter, a read that could not decide the Enter, `/exit` whose session has not yet been seen ending. The dialog watch names each uncertain row by id once; the Fable guard names the two dialog kinds.
- **Resolved by a person only:** `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js uncertain` lists them; `… uncertain delivered <conversation|control> <id>` (it reached the session: delivered / done) or `… uncertain redeliver <conversation|control> <id>` (it did not: pending again, pasted afresh; check first that the composer is empty).
- **Still failing as before:** content errors (`content-error:*`, with their alert), a failed `set-buffer` (`paste_error`, nothing reached the pane), a bound row whose pane cannot be read, keystroke failures. The first-failure notice (`first-failure-notice.js`) covers runtime stop failures of a delivered message, not undelivered rows.

Any process with access to `c4-control.js` can enqueue keystroke controls. This mirrors the existing reality that any process can call `tmux send-keys` directly — the C4 queue adds priority ordering and delivery guarantees, not access control.

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher
```
