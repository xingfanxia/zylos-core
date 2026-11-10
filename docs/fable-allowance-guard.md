# Fable allowance guard

The Fable allowance guard runs selected Claude personas on a Fable main model
while their account's weekly Fable allowance is below a threshold, and moves
them to the profile's own (Opus) model when it is not. It is a fork feature for
the multi-session deployment (`instances.json`). It is **inert** until
`instances.json` carries a valid `fable_guard.fable_model`, and it never changes
a persona that lacks `fable_enabled: true`.

Honest limit: an account can be shared with sessions the guard cannot see (for
example an operator's own Claude sessions). A polling guard cannot prove that
the CLI's usage-credits prompt is never reached; it reduces exposure. The
delivery guard (no keystrokes into a modal) and a credits-disabled organization
are the backstops.

## Configuration contract (`instances.json`)

The policy writer owns these keys. Nothing else writes them.

```json
{
  "fable_guard": {
    "fable_model": "claude-fable-5-2[1m]",
    "threshold": 0.75,
    "probe_accounts": ["claude-ax-backup"]
  },
  "instances": {
    "user-pan": { "runtime_profile": "claude-ax-backup", "fable_enabled": true }
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `fable_guard` | object | absent | Absent, not an object, `enabled: false`, or an invalid `fable_model` ⇒ the whole feature is inert: no probe, no state, unchanged launches. |
| `fable_guard.fable_model` | string, `VALID_MODEL` (`[1m]` suffix allowed) | required | Main model of a Fable-mode launch. The probe uses it without `[1m]`. |
| `fable_guard.threshold` | number in (0, 1] | `0.75` | Fraction of the weekly Fable window (not a percent). `>=` holds the account. Out of range ⇒ default. |
| `fable_guard.probe_accounts` | array of profile ids | `[]` | Accounts probed even when no enabled persona sits on them (rollout before enabling anyone). |
| `fable_guard.subagent_model` | string | `claude-opus-5-5` | Value of `CLAUDE_CODE_SUBAGENT_MODEL` for Fable personas. |
| `fable_guard.probe_interval_sec` | integer 60–3600 | `300` | Fixed probe cadence per account. |
| `fable_guard.lease_sec` | integer 120–7200 | `720` | A Fable launch needs a valid observation younger than this. |
| `fable_guard.probe_backoff_max_sec` | integer 60–3600 | `900` | Ceiling of the generic-429 backoff. |
| `fable_guard.upgrade_min_dwell_sec` | integer 0–86400 | `1800` | Minimum time since a persona's last model transition before Opus → Fable. |
| `fable_guard.stale_clear_observations` | integer 1–20 | `3` | Consecutive valid readings below threshold that clear a `stale` hold. |
| `fable_guard.crash_window_sec` / `crash_failures` | integers | `1800` / `2` | Fable-session failures per persona within the window that trip a `crash` hold. |
| `fable_guard.crash_probation_sec` | integer | `7200` | First crash trip: one Fable retry after this long. |
| `instances.<id>.fable_enabled` | `true` | absent | Opts the persona in. Anything else ⇒ the persona is untouched. |

Out-of-range numbers fall back to the default; they never disable the guard.

**Accounts** are Claude runtime profile ids (`claude-ax-backup`, not
`ax-backup`). A profile is probe-able, and can run Fable, only when it has
`runtime: "claude"` and its own `claude_settings_file`. A profile without one
(for example a host-default credential) never gets an observation, so its
personas stay on Opus. A persona's account is its current `runtime_profile`.

For `azure-agents-infra` `devbox-runtime-policy.mjs`:

- `FABLE_MODEL` → `fable_guard.fable_model`; `FABLE_THRESHOLD` (0.75) →
  `fable_guard.threshold`; `FABLE_PROBE_ACCOUNTS` → `fable_guard.probe_accounts`
  (profile ids); lease/cadence constants → the integer keys above, or omit them
  for the defaults; `FABLE_PERSONAS` → `fable_enabled: true` on exactly those
  instances and removal of the key everywhere else.
- `--apply` must not read, write or delete `activity-monitor/fable-guard.json`
  or `activity-monitor/fable-usage.json`. Holds live there, so they survive
  `--apply` without special handling. Enabling or disabling a persona is only
  the `fable_enabled` flag; the guard's next pass reconciles it.
- `--apply` relaunching a moved persona is safe: the launcher refuses Fable
  unless the guard committed Fable for that exact account and the lease is
  fresh.

## Components

| Piece | File | Runs in |
|---|---|---|
| Probe | `skills/activity-monitor/scripts/fable-probe.js` | `runtime-failover` daemon (background child process) |
| Holds, desired launch, reconcile | `skills/activity-monitor/scripts/fable-guard.js` | `runtime-failover` daemon, under `instances.json.lock` |
| Launch policy, admission, launch record | `skills/multi-session/runtime-files.js` + `cli/lib/runtime/claude.js` | activity monitor (every Guardian launch) |
| Lease enforcement | `skills/activity-monitor/scripts/fable-monitor.js` | activity monitor of a tracked persona |
| Limit-dialog precedence | `skills/activity-monitor/scripts/health-engine.js`, `monitor.js` | activity monitor of a Fable-mode persona |
| Operator command | `skills/activity-monitor/scripts/fable-guard-cli.js` | operator shell |

The dialog classifier itself (`classifyLimitDialog(paneText)` in
`skills/comm-bridge/scripts/tmux-input-state.js`, re-exported from
`cli/lib/tmux-input-state.js`) belongs to the delivery guard. The monitor reads
it through a namespace import; without that export no dialog is classified
(no-op default).

## Probe (FG-1)

Probe accounts = current account of every enabled Fable persona ∪
`probe_accounts`, regardless of the personas' current mode. Each is probed
every `probe_interval_sec` with:

```
claude -p "Reply OK" --model <fable_model without [1m]> --system-prompt "Reply with OK." --tools "" \
  --disable-slash-commands --no-session-persistence --output-format stream-json --verbose \
  --settings <profile claude_settings_file> --strict-mcp-config --max-turns 1   (stdin /dev/null)
```

`HOME`, `CLAUDE_CONFIG_DIR` and cwd are a private temp dir, removed afterwards;
the token is never copied. `claude --version` runs first with the same env. The
binary is `FABLE_PROBE_CLAUDE_BIN`, else `CLAUDE_BIN`, else
`~/.local/bin/claude`, else `claude` on `PATH`.

An observation is valid only if: exit 0; every answering model is the Fable
model; `seven_day_overage_included.utilization` is in [0, 1]; its reset is in
the future and at most 8 days away; the account has a settings file; the CLI
version was read. Anything else is "no observation" and never refreshes the
last good one.

- Explicit Fable rejection (the Fable window `rejected`, a `rejected` status
  naming that window, `isUsingOverage: true`, or Fable-limit wording on an
  error result) is exhaustion evidence, even on a non-zero exit. Every
  `rate_limit_event` in the stream is checked: a rejection followed by the
  CLI's fallback events and a successful non-Fable answer is still a
  rejection, with the reset window of the event that rejected. A rejection is
  recorded only under the account that was probed.
- A generic 429 is no observation and backs off 10, 15, 15 … minutes (ceiling
  `probe_backoff_max_sec`). The lease is measured from the last valid
  observation only, so backoff never extends it.

Store: `<ZYLOS_DIR>/activity-monitor/fable-usage.json`, written only by the
daemon, separate from the 30-second `provider-usage.json` rewrite:

```json
{ "version": 1, "accounts": { "claude-ax-backup": {
  "last_valid": { "account": "...", "utilization": 0.02, "resets_at": "...", "observed_at": "...",
                  "cli_version": "2.1.322", "model": "claude-fable-5-2", "status": "allowed" },
  "last_attempt": { "at": "...", "outcome": "valid|rejected|rate_limited|invalid", "reason": null },
  "rejection": { "at": "...", "resets_at": "...", "detail": "fable_rejected" },
  "recent": [ { "at": "...", "outcome": "valid", "utilization": 0.02, "resets_at": "..." } ],
  "failures": 0, "next_probe_at": "..." } } }
```

## Holds and transitions (FG-2)

State: `<ZYLOS_DIR>/activity-monitor/fable-guard.json` (mode 0640), owned by the
`runtime-failover` daemon. Canonical state is per account; a persona's mode is
derived from it.

```json
{ "version": 1, "generation_seq": 12,
  "holds": { "claude-ax-backup": { "quota": { "since": "...", "reset_window": "...", "detail": {} } } },
  "crash_trips": {}, "rejection_seen": {},
  "personas": { "user-pan": {
    "desired": { "account": "claude-ax-backup", "mode": "fable|opus", "generation": 12, "key": "<launch key>",
                 "model": "claude-fable-5-2", "committed_at": "...", "reason": "...", "adopted_launch_id": "<uuid, optional>" },
    "executed_generation": 12, "executed_at": "...", "attempts": 1,
    "last_transition_at": "...", "verified": { "model_at": "...", "ack_at": "..." } } },
  "manual_clears": [] }
```

An account may hold several kinds at once; Fable needs none of them **and** a
valid lease (an observation younger than `lease_sec`, window not yet reset,
below threshold). Unknown quota on an account ⇒ Opus.

| Kind | Set when | Cleared when |
|---|---|---|
| `quota` | a fresh reading ≥ threshold; a probe rejection; a classified limit dialog on a persona of that account | a valid reading below threshold from a **later** reset window than `reset_window` (a hold without a known window pins the first later reading's window). Never by stale/crash events or by lowering the threshold back. |
| `stale` | the account is probed and has no valid lease | `stale_clear_observations` consecutive valid readings below threshold made after the hold |
| `crash` | `crash_failures` Fable-session failures of one persona within `crash_window_sec` | trip 1: after `crash_probation_sec` (one retry). Trip 2 in the same window: a later-window reading below threshold |

Fable-session failures are HealthEngine failure-driven kill+restarts of a
Fable-mode session and guard-observed launches that came up on a non-Fable
model (for example the CLI's consent fallback). Guard restarts and planned
restarts are not failures.

Each daemon pass, under `instances.json.lock` and after the account failover
has chosen the account: derive holds → derive the persona's mode →
commit `desired {account, mode, generation}` once → reconcile.

- Downgrade is immediate. Upgrade also needs `upgrade_min_dwell_sec` since the
  persona's last model transition and the persona idle (fresh status, `idle`,
  health ok, no active tools).
- The commit is the tuple `{account, mode, generation, key}`, where `key` is
  the full launch policy the persona should run (`expectedFableLaunch`:
  account, mode, main model, effort, settings file, subagent env). A new
  generation is committed whenever any part of it changes: the guard's own
  decision, the account failover moving the persona, or a policy change such
  as `fable_enabled` or the profile's model.
- A commit restarts the persona through the failover's cold-start path
  (runtime switch signal with an unchanged profile → `tmux kill-session` →
  `pm2 restart activity-monitor-<id>`), unless the account failover restarts it
  in the same pass, or the running launch record already has exactly this
  `key` and account (it is then adopted as `adopted_launch_id`). An Opus →
  Opus change of policy only (for example the subagent pin after enabling a
  persona that is still on Opus) waits until the persona is idle.
- **Convergence is level-triggered against the launch record**, not inferred
  from what changed in a pass. A committed generation is converged only when
  the engine's current launch (`fable-launch.json` no older than
  `agent-status.json` `runtime_launch_at`) has the committed account, mode and
  `key` **and** the committed generation (or the adopted launch id), and
  `statusline.json` `model.id`, reported after that launch, is the expected
  model. A running engine whose launch does not match is restarted again after
  three minutes (`resume:stale_launch`), at most three times per generation.
- Crash atomicity across `instances.json` (account, written by the account
  failover) and `fable-guard.json` (the guard's tuple) is not obtained by a
  cross-file transaction. The guard file is the single journal of the guard's
  tuple, and both failure orders are safe and self-healing: the launcher admits
  Fable only when the committed account equals the instance's current
  `runtime_profile` (a torn state launches Opus), and the reconciler compares
  the running launch with the journal on every pass, so a lost restart, a
  restart that read the previous generation, or a crash between the two writes
  is restarted on the next pass instead of being verified on the old session.
- `verified.ack_at` records the first functional ACK after that launch whose
  phase is not the auto-ACKable cold-start `primary` probe. It is evidence for
  the operator, not a gate.
- The guard never types into a pane, never writes
  `runtime_failover_blocked_profiles` or `runtime_profile`, and never reports
  `rate_limited`. `instances.json` is not written by the guard.

## Launch policy (FG-3)

For `fable_enabled` personas on a configured guard, in both modes, the launch
env carries `CLAUDE_CODE_SUBAGENT_MODEL=<subagent_model>` and
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (new-session spec env and the
existing-session `export`). `--model` is `fable_model` only when **all** of
these hold at the moment of the launch (`fableAdmission` in
`runtime-files.js`): the account has its own settings file; the guard committed
Fable for the persona's current account; that account has no hold; and
`fable-usage.json` holds a lease (a valid observation younger than
`lease_sec`, window not reset, below `threshold`). Otherwise it is the
profile's model. The committed state alone never admits Fable: it can be
arbitrarily old when the daemon is dead or hung. All other personas launch
exactly as before. `CLAUDE_CODE_NO_MODEL_FALLBACK` is never set.

The adapter resolves the profile when the activity monitor starts, and the
Guardian reuses it for every relaunch. `ClaudeAdapter.launch()` therefore calls
`prepareFableLaunch()` on every launch: for a persona the guard does not track
it returns the profile unchanged and writes nothing; for a tracked persona it
re-evaluates admission (it can only move a cached Fable decision to Opus,
never the reverse) and writes the launch record
`<monitor dir>/fable-launch.json`:

```json
{ "version": 1, "launch_id": "<uuid>", "instance_id": "user-pan", "launched_at_ms": 0,
  "runtime_profile": "claude-ax-backup", "mode": "fable|opus", "model": "claude-fable-5-2[1m]",
  "generation": 12, "reason": "admitted|lease_expired|hold:quota|not_committed|...", "key": "<launch key>", "pid": 0 }
```

`key` (`fableLaunchKey`) is the launch policy actually used: account, mode,
main model, effort, settings file and launch env. A persona is tracked when its
monitor started with a Fable decision, when it is `fable_enabled` on a
configured guard, or when the guard state still lists it.

### Lease enforcement without the daemon

The persona's own activity monitor (`fable-monitor.js`, every 15 s) re-checks
admission for a session whose launch record says `fable`. If admission has
failed for longer than 120 s (one daemon poll plus its cold restart, so a live
daemon always acts first), the monitor logs `Fable guard ALERT`, writes
`<monitor dir>/fable-lease-enforcement.json`, and stops the session; the
Guardian relaunch re-evaluates admission and comes up on Opus. The monitor only
ever forces Opus. It never upgrades and never writes the guard state; the
daemon stays the single transition owner. PM2 is not a lease enforcer: a
running Fable session outlives a dead daemon only for the lease plus this
grace (about 14 minutes with the defaults).

## Limit-dialog precedence (FG-4, health half)

Only the monitor of a persona launched in Fable mode gets the dialog hooks.
On a heartbeat failure, before rate-limit/auth handling and ordinary
kill+restart, the HealthEngine captures the pane and asks
`classifyLimitDialog`. A classified `fable_limit` / `credits_offer` dialog
writes `<monitor dir>/fable-limit-evidence.json`, is not killed and is not
counted toward `flap_ceiling_per_hour`; the guard turns the evidence into a
`quota` hold and restarts the persona into Opus. The same check runs on a
heartbeat pending longer than 30 s, after a delivered user message, before any
`triggerRecovery` (including the tool watchdog's escalation), and before the
tool watchdog queues an interrupt key (the watchdog then retries after its
cooldown). If the guard has not acted within 15 minutes the ordinary recovery
resumes. A bare keyword the classifier rejects, a permission prompt, or an
unknown modal changes nothing here.

A Fable guard relaunch keeps the tmux name. When the new monitor consumes a
switch signal whose reason starts with `fable_guard:`, it supersedes the
persona's still-pending `[KEYSTROKE]` controls (`last_error =
FABLE_GUARD_RELAUNCH`), so a late watchdog Escape queued for the old session
cannot interrupt the new one. Controls already claimed by the dispatcher are
left alone.

Known limitation: if the CLI raises the limit dialog after Enter was already
sent, the dispatcher records that message as delivered although the CLI sent
nothing. The guard never re-delivers it (duplicate-execution risk). When a
classified dialog creates the hold, the daemon logs `ALERT limit dialog
classified …` for the persona and records `possible_dropped_message` in its
guard state, shown by `fable-guard-cli.js status`; an operator decides whether
to resend. Guard restarts reuse the
cold-start handling (pending heartbeat cleared, grace, busy-startup
protection) in a fresh monitor process, so they never count as recovery
restarts.

## Operator commands

Run as the service user on the host (`ZYLOS_DIR` defaults to `~/zylos`):

```
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js status          # holds, readings, personas
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js status --json
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js clear claude-ax-backup quota --reason "drill teardown"
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js clear claude-ax-backup all
```

`clear` takes `instances.json.lock`, removes the named kind (`quota`, `stale`,
`crash`, or `all`; clearing `crash` also resets that account's trip count) and
appends an entry to `manual_clears`. Evidence already consumed is not re-applied.
A hold whose cause is still present is re-armed on the next pass: a reading
still at or above the threshold re-arms `quota`, an expired lease re-arms
`stale`.

Threshold drill teardown: restore `threshold` to 0.75 **and** clear the drill's
`quota` hold. Restoring the threshold alone keeps the latch until the next
weekly window.

## Deployment notes

- Skills files to install: `activity-monitor/scripts/{fable-probe,fable-guard,fable-monitor,fable-guard-cli,runtime-failover,health-engine,monitor,monitor-orchestrator}.js`,
  `activity-monitor/scripts/adapters/runtime-components.js`,
  `multi-session/runtime-files.js`. `cli/lib/runtime/claude.js` loads from the
  checkout. Keep `chmod -R go-w` on `activity-monitor` after copying.
- Restart `runtime-failover` to start probing. A persona's monitor picks up the
  health and launch changes on its next restart, which the guard performs on
  every transition.
- Reset-window logic is proven by fixtures until a real weekly reset has been
  observed.
