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
`runtime: "claude"` and its own `claude_settings_file`. A persona's account is
its current `runtime_profile`.

**Unsupported accounts.** A profile without its own settings file (on
ax-devbox: `claude-ax-main`, the host-default credential) cannot be probed, so
Fable is **unsupported** there, not pending: a `fable_enabled` persona on such
an account always runs Opus (with the subagent pin), its commit reason and
launch reason are `unsupported_account`, the guard state marks it
`unsupported: account_without_settings_file`, and `fable-guard-cli.js status`
prints `UNSUPPORTED account …: always Opus`. It is never shown as converging
or recovering, and nothing will move it to Fable until the account gets its
own settings file. A `fable_enabled` persona that the account failover moves
to a non-Claude profile (Codex) is marked `not_a_claude_profile`; the guard
neither restarts nor verifies it (that engine cannot run Fable and the
failover owns its restart).

For `azure-agents-infra` `devbox-runtime-policy.mjs`:

- `FABLE_MODEL` → `fable_guard.fable_model`; `FABLE_THRESHOLD` (0.75) →
  `fable_guard.threshold`; `FABLE_PROBE_ACCOUNTS` → `fable_guard.probe_accounts`
  (profile ids); lease/cadence constants → the integer keys above, or omit them
  for the defaults; `FABLE_PERSONAS` → `fable_enabled: true` on exactly those
  instances and removal of the key everywhere else.
- `--apply` must not write or delete `activity-monitor/fable-guard.json` or
  `activity-monitor/fable-usage.json`. Holds live there, so they survive
  `--apply` without special handling.
- `--apply` must not kill or restart a guard-owned persona itself. The
  protocol is "write the desired policy, let the guard execute it":
  1. Under `instances.json.lock`, write the new `instances.json` (accounts,
     `fable_enabled`, profile models, `fable_guard`), as today.
  2. Release the lock.
  3. For every moved instance, restart it yourself only if
     `fableGuardOwnsInstance({ document, state, instanceId })` is false for
     BOTH the document before and after the write (`state` = the current
     `fable-guard.json`). Guard-owned instances are skipped.
  4. Call `reconcileFableGuardNow({ zylosDir })` (import from
     `activity-monitor/scripts/fable-guard.js`) or run
     `node fable-guard-cli.js reconcile --json`. It runs one guard pass now:
     plan and commit under the lock (any change of account, `fable_enabled`,
     model or subagent env commits a new generation), then execute each
     restart behind the per-restart generation fence. If the daemon is alive
     it may run the same pass concurrently; the lock serializes the commits
     and the generation fence plus the per-persona execution claim prevent an obsolete, duplicate or overlapping restart.

  Exact instructions for `configure-ax-devbox-runtime.mjs`:
  `azure-agents-infra/scratch/reports/fable52-main-mode/fg-apply-protocol.md`.
- Restart fencing: each restart is checked on its own, under
  `instances.json.lock`, against the persona's committed generation; a
  superseded one is skipped. The check records `executing {generation, at}` and
  writes the switch signal inside the lock; `tmux kill-session` and `pm2`
  run after it. A newer commit for a persona whose restart was executed less
  than 30 s ago and has not launched yet reuses that restart (the relaunch
  re-reads the guard state), so an `--apply` interleaved with a guard restart
  never causes an obsolete second restart.
- Execution claim (`fable-exec-claim.js`). Every effect on a guard-owned
  persona takes that persona's claim
  (`<ZYLOS_DIR>/activity-monitor/fable-exec/<id>.json`, under its own `.lock`)
  before it runs: the daemon's guard restarts and safe stops,
  `reconcileFableGuardNow` (`--apply`), the account failover's restart or
  suspend of a guard-owned persona, and the persona monitor's lease
  enforcement. At most one claim is `running` per persona, so these never
  overlap; an operation (kind, generation, attempt, target account / launch /
  session) that already ran is never executed again, so the same
  generation/attempt submitted twice executes once.
- Claim ownership is the executor process, never the claim's age. The claim
  records `executor {pid, start, host}` (`start`: on Linux the boot id plus the
  process start time from `/proc/<pid>/stat`, elsewhere `ps -o lstart` in UTC)
  and is stamped with the time it was acquired, not the caller's pass time. A
  `running` claim is taken over only when its executor provably cannot
  continue: the pid no longer exists (executor crash), or it now belongs to a
  different process (start identity differs: pid reuse, reboot), or the owner
  is the claiming process itself and the operation is no longer executing in
  it (its completion could not be recorded). A paused or slow executor keeps
  its claim however long it takes; a claim recorded on another host is not
  judged here (remove `activity-monitor/fable-exec/<id>.json` by hand only
  after checking that no executor runs). A claim written before the
  `executor` field existed keeps the old rule (recoverable after 90 s).
  Every executor re-checks that it still holds the claim right before each
  irreversible effect (`tmux kill-session`, `pm2 restart` / `pm2 stop`, the
  monitor's session kill); one that lost it logs `ALERT … lost its execution
  claim` and stops before acting. A restart skipped because the claim is busy is picked up by the
  level-triggered reconcile below; an account-failover suspend skipped that
  way is kept (`deferred`) and run by the next daemon pass, unless the
  failover has lifted that suspension meanwhile. The claim records execution,
  not completion: a stop is complete only when observed, a restart only when
  the guard verifies the launch. Personas the guard does not own keep the
  account failover's direct restart path unchanged.

## Components

| Piece | File | Runs in |
|---|---|---|
| Probe | `skills/activity-monitor/scripts/fable-probe.js` | `runtime-failover` daemon (background child process) |
| Holds, desired launch, reconcile | `skills/activity-monitor/scripts/fable-guard.js` | `runtime-failover` daemon, under `instances.json.lock` |
| Launch policy, admission, launch record | `skills/multi-session/runtime-files.js` + `cli/lib/runtime/claude.js` | activity monitor (every Guardian launch) |
| Lease enforcement | `skills/activity-monitor/scripts/fable-monitor.js` | activity monitor of a tracked persona |
| Per-persona execution claim | `skills/activity-monitor/scripts/fable-exec-claim.js` | every executor of a guard-owned persona (daemon, account failover, `--apply`, monitor) |
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

Fable-session failures (`<monitor dir>/fable-session-failures.json`, stamped
with the launch record of the session that failed) are:

- HealthEngine failure-driven kill+restarts of a Fable session;
- unexpected foreground exits: the Guardian is about to relaunch a session it
  had seen running in this monitor process, with no planned cause. Planned
  causes are excluded: a runtime switch signal is pending (guard, account
  failover and `--apply` restarts write it before their kill), a wake from
  suspend, a running maintenance script, the monitor's own lease enforcement,
  or a recovery kill already counted above; the first launch of a monitor
  process is never counted;
- guard-observed launches that came up on a non-Fable model (for example the
  CLI's consent fallback).

Only failures of sessions launched on Fable count; an Opus session's exits
never feed the crash rule.

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
  in the same pass (through the guard's executor, carrying this generation as
  attempt 1), or the running launch record already has exactly this
  `key` and account (it is then adopted as `adopted_launch_id`). An Opus →
  Opus change of policy only (for example the subagent pin after enabling a
  persona that is still on Opus) waits until the persona is idle, and is never
  restarted again while a restart issued for it is still landing (three
  minutes after it was executed).
- **Convergence is level-triggered against the launch record**, not inferred
  from what changed in a pass. A committed generation is converged only when
  the engine's current launch (`fable-launch.json` no older than
  `agent-status.json` `runtime_launch_at`) has the committed account, mode and
  `key` **and** the committed generation (or the adopted launch id), and
  `statusline.json` `model.id`, reported after that launch, is the expected
  model. A running engine whose launch does not match is restarted again after
  three minutes (`resume:stale_launch`), at most three times per generation.
- Interrupted restarts keep reconciling. A persona that is not running (or
  whose `agent-status.json` is older than two minutes, i.e. its monitor is
  gone) three minutes after the commit is restarted again
  (`resume:not_running:<state>`); a suspended persona is left alone because
  its wake goes through the admission gate. Missing model evidence is bounded:
  ten minutes after a launch without a `statusline.json` report, a Fable
  launch is restarted (`resume:model_unknown`) and an Opus launch is surfaced
  (`verified.model_unknown_at`, `ALERT` in the daemon log) without a restart.
- Retry exhaustion: after three attempts the guard logs `ALERT … not
  converged` and stops retrying that generation. If the commit was a
  downgrade and the last launch record or the engine's model report is Fable,
  the guard records the stop **intent** `safe_stop {generation, attempts,
  next_at}` and stops the persona (`pm2 stop activity-monitor-<id>`, then
  `tmux kill-session`). The stop is complete only when it is observed:
  `pm2 stop` succeeded **and** `tmux has-session` reports the session gone
  (`safe_stop.confirmed_at`, log `STOPPED`), or the persona's current launch is
  Opus and reports Opus. A failed `pm2 stop`, a session that survives the
  kill, or a daemon that died after recording the intent leaves it pending
  (`last_error`, log and status `ALERT … not confirmed` / `SAFE-STOP
  PENDING`); the planner issues the stop again after 1, 2, 4 … minutes (at
  most 15) until it is confirmed. Recovery after a confirmed stop: check the
  persona, then `pm2 start activity-monitor-<id>`; its launch is admitted to
  Opus only, and any later commit restarts it normally.
- Crash atomicity across `instances.json` (account, written by the account
  failover) and `fable-guard.json` (the guard's tuple) is not obtained by a
  cross-file transaction. The guard file is the single journal of the guard's
  tuple, and both failure orders are safe and self-healing: the launcher admits
  Fable only when the committed account equals the instance's current
  `runtime_profile` (a torn state launches Opus), and the reconciler compares
  the running launch with the journal on every pass, so a lost restart, a
  restart that read the previous generation, or a crash between the two writes
  is restarted on the next pass instead of being verified on the old session.
- Model convergence and readiness are separate states. `verified.model_at`
  means the converged launch reports the expected model. Readiness
  (`verified.ready_at`) needs a real ACK from that launch: the guard-relaunched
  monitor's HealthEngine sends its cold-start readiness probe with the
  end-to-end phase `post_restart` (the dispatcher never auto-ACKs it) instead of
  the auto-ACKable `primary`, and only once the startup turn is no longer busy
  (bounded by the 20-minute startup grace). The monitor writes the result to
  `<monitor dir>/fable-readiness.json` `{launch_id, outcome: ack|missing}`. A
  missing ACK, or no result 30 minutes after the launch, sets
  `verified.readiness = ack_missing|no_probe_result` and logs one `ALERT`; it
  never restarts a persona that runs the correct model, and the readiness
  probe failure never triggers HealthEngine recovery. A genuine ACK from the
  same launch that arrives later (an `ack` readiness result, or a
  `post_restart`/`recovery` functional ACK after the launch) still moves it
  to `verified.ready_at` and logs `readiness recovered`.
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
`lease_sec`, window not reset, below `threshold`); and the persona's monitor
has no open "model observation unavailable" alert (below). Otherwise it is the
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

The record is written before the CLI starts, so it is the launch **intent**,
not proof of what runs. Fable is admitted only when its record is committed:
if writing a Fable record fails, the launch uses the profile's own model
(`reason: launch_record_failed`, subagent pin kept) and an Opus record is
attempted. The lease enforcement below judges a running session from the
session itself, never from a missing or older record.

### Lease enforcement without the daemon

The persona's own activity monitor (`fable-monitor.js`, every 15 s) judges the
running session, identified by its `sessionRef`, from the session itself: the
CLI process's `--model` argument (`ps` of the Claude process in the pane) and
the model it reports in `statusline.json` after that session started. A
session is safe only when that evidence says a non-Fable model; Fable **or no
evidence** (record missing, older than the session, process unreadable) means
it may be on Fable. Such a session is checked against admission (for the
account of its launch record when the record belongs to this session, else
the instance's current account). If admission has failed for longer than
120 s (one daemon poll plus its cold restart, so a live daemon always acts
first), the monitor logs `Fable guard ALERT`, writes
`<monitor dir>/fable-lease-enforcement.json` (`status: pending`), and stops
that session:

- it takes the persona's execution claim (the daemon's executor holds the same
  claim while it restarts or stops the persona; a busy claim makes the
  monitor wait), then revalidates that the session (`sessionRef`) and launch
  record are still the ones it judged. A session the daemon replaced
  meanwhile is never stopped (`status: superseded`);
- it kills exactly that tmux session by its session id (`tmux kill-session -t
  $<id>`), never by the reusable name;
- the stop is done only when the session is observed gone
  (`status: confirmed`, `confirmed_at`); otherwise it stays pending and is
  retried after 15 s, 30 s, 1 min … (at most 5 min) with an `ALERT … not
  confirmed` each time.

Unknown evidence is bounded across launches. When neither the process
`--model` nor a fresh `statusline.json` model can be read, the first such stop
is kept (the session may be on Fable). Such stops are counted per persona in
`<monitor dir>/fable-observation.json` (`unknown_stops`), which survives
relaunches and monitor restarts; at most one is made per 6 hours. When the
budget is spent, a session launched on Opus (its own launch record says
`opus`) is not stopped again: the monitor raises a persistent `alert`
(`reason: model_observation_unavailable`, one `Fable guard ALERT: model
observation unavailable` log line per incident, `ALERT model observation
unavailable` in `fable-guard-cli.js status`), and while it is open the
launcher admits no Fable for that persona (`reason: observation_unavailable`)
and the guard commits Opus (`fable_blocked:observation_unavailable`). A
session whose launch record says `fable` is still stopped on unknown
evidence; its relaunch is Opus because of the alert. The alert clears by
itself (`model observation recovered` in the monitor log) as soon as either
source is readable again, after which Fable can be admitted on the next
upgrade.

Observation readability on ax-devbox (checked 2026-11-10 over read-only SSH
as `xingfanxia`, the user of the PM2 daemon that runs every
`activity-monitor-*`): `/proc` is mounted without `hidepid`, so the monitor
user reads the command line of the isolated personas' CLIs, which run as
`zylos-pan`, `zylos-elaine`, `zylos-group` and `zylos-sean` under
`sudo -> sudo -> node -> claude` in tmux sessions owned by `xingfanxia`.
`findRuntimePidUnderPane` resolves that `claude` pid and `ps -o args=` shows
`--model claude-opus-5-5[1m]` for `admin`, `user-pan`, `user-elaine`, `group`
and `user-sean`. Each persona's `statusline.json` (owned by the persona user,
mode `0660`, ACL `user:xingfanxia:rwx`, effective `rw-`) is readable by
`xingfanxia` and reports `model.id`. Both sources are readable for every
persona; re-check them before enabling a new persona, because a persona whose
monitor user can read neither never gets past the observation alert.

The Guardian relaunch re-evaluates admission and comes up on Opus. The monitor
only ever forces Opus. It never upgrades and never writes the guard state; the
daemon stays the single transition owner. PM2 is not a lease enforcer: a
running Fable session outlives a dead daemon only for the lease plus this
grace (about 14 minutes with the defaults).

## Limit-dialog precedence (FG-4, health half)

Only the monitor of a guard-tracked persona gets the dialog hooks
(`fable-monitor.js`), and they act only while the current launch record says
`fable` (a Guardian relaunch can change the mode without a new monitor). The
classifier is the real `classifyLimitDialog` export of the delivery side,
imported by name in `monitor.js`, so a renamed export fails the monitor at
load instead of silently disabling detection. On a heartbeat failure, before rate-limit/auth handling and ordinary
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

A Fable guard relaunch keeps the tmux name, so keys must be fenced by session,
not by name. Just before the guard kills a session it reads that session's
`sessionRef` (`tmux display-message -p -t <tmux_session>
'#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}'`, e.g.
`$3:1762790000:%12:48211`) and stores it as `session_ref` in the switch
signal. When the new monitor consumes a `fable_guard:` signal that carries one,
it calls the C4 owning API `supersedeControlsForSession({ instanceId,
sessionRef, reason: 'FABLE_GUARD_RELAUNCH' })` (`skills/comm-bridge/scripts/c4-db.js`),
which supersedes the pending AND already-claimed `[KEYSTROKE]` controls bound
to that old session and never those bound to the replacement. The monitor's
lease enforcement does the same for the session it stops. The `sessionRef`
is read with comm-bridge's `readSessionRef()` (the dispatcher's
`paneIdentity`), and the activity monitor never writes the control queue
itself.

Known limit of the session fence: a Claude relaunch inside the same surviving
shell pane (no new tmux session) keeps the same `sessionRef`, so keys bound to
the previous process are not told apart from the new one. Guard restarts and
the lease enforcement kill the tmux session, so they always get a new
`sessionRef`.

The watchdog interrupt and the permission auto-approve Enter are enqueued
bound: the watchdog reads the adapter session's ref (`readSessionRef`) right
before the enqueue, and the auth-prompt hook reads its own pane with `tmux
display-message -t "$TMUX_PANE"`; each passes it as `--session-ref`. A key
whose identity cannot be read (no `TMUX_PANE`, or an os_user-isolated CLI that
cannot reach the service user's tmux socket) is enqueued unbound. The
dispatcher fences an unbound key at claim time: it is bound to the pane it
reads then, and superseded (`SESSION_PREDATES`) when its `created_at` is at or
before that session's `session_created`; a same-second key is ambiguous and
is fenced, not delivered. Every key, paste and Enter is then sent to the pane
id (`%N`) of the read that decided it, never to the reusable session name, so
a session replaced in between makes the send fail instead of receiving it.
This fork's dispatcher has no periodic Enter nudge: upstream's
`periodic-enter.js` (`C4_PERIODIC_ENTER_*`) is not wired in, so no Enter is
sent without a deciding read.

**Uncertain deliveries.** If the CLI raises a Fable-limit / usage-credits
dialog right after the dispatcher sent Enter, C4 records the message as
uncertain (`c4.db` table `delivery_uncertain`, migration 004; see
`skills/comm-bridge/SKILL.md`): it is neither delivered nor failed and is never
replayed. The tracked persona's monitor reads unnotified rows every 15 s
(`getUncertainDeliveries({ instanceId, unnotifiedOnly: true, limit: 20 })`),
logs one `Fable guard ALERT: delivery uncertain …` per row naming the item
(`conversation #<id> from <channel> "<preview>"`), and sends the operator a
notification through the same path as the degraded-persona admin alert
(`c4-send.js` to the admin instance's first `chat_id`, delivery action
`health-alert`). The row is marked notified
(`markUncertainDeliveryNotified(id)`) only after that send exits 0; a log line
is not a notification. A failed send (or no admin `chat_id`) keeps the row
unnotified and is retried after 1, 2, 4 … minutes (at most 30), at most 12
times; the monitor logs `ALERT … not notified` each time. The last 20 rows,
with `notified_at` or `notify_attempts`/`last_notify_error`, are kept in
`<monitor dir>/fable-uncertain-deliveries.json` for `fable-guard-cli.js status`
(`UNCERTAIN DELIVERY … (operator notified …)` or `(operator NOT notified …)`).
An operator decides whether to resend.
Known blind spot: a dialog that appears with no later dispatcher read of that
pane is not claimed by any message, so no row is recorded; the limit evidence
still creates the `quota` hold.

Guard restarts reuse the cold-start handling (pending heartbeat cleared,
grace, busy-startup protection) in a fresh monitor process, so they never
count as recovery restarts.

## What changes even when the guard is unconfigured

The guard's own logic is inert without `fable_guard`, but these shared changes
reach every Claude persona:

- `agent-status.json` carries `functional_ack_phase` (the phase of the last
  functional ACK) next to `functional_ack_at`, for every persona.
- Pane reads (`readTmuxInputState`, delivery side): while a modal (dialog or
  select list) owns the bottom of the pane, `modal` is set and
  `promptVisible` is false, so `canTreatPaneAsRecovered` is false. The tool
  watchdog therefore never treats a permission prompt or other dialog as a
  recovered pane. The delivery guard's paste/Enter/raw-key deferral is likewise
  global; its contract is in `skills/comm-bridge/SKILL.md`.
- `ClaudeAdapter.launch()` reads `instances.json` and
  `activity-monitor/fable-guard.json` on every launch (`prepareFableLaunch`).
  For an untracked persona that is the only effect: launch args, env and the
  profile object are unchanged and no file is written.
- `Guardian` calls an optional `onAgentStart` hook before each launch and
  `HealthEngine` accepts optional `guardReadiness` / limit-dialog deps; both
  are wired only for guard-tracked personas.

## Operator commands

Run as the service user on the host (`ZYLOS_DIR` defaults to `~/zylos`):

```
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js status          # holds, readings, personas
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js status --json
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js clear claude-ax-backup quota --reason "drill teardown"
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js clear claude-ax-backup all
node ~/zylos/.claude/skills/activity-monitor/scripts/fable-guard-cli.js reconcile --json  # one guard pass now (the --apply entry point)
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

## Rollback

The delivery half adds two c4.db schema extensions: `control_queue.session_ref`
(migration 003, nullable, default NULL) and the `delivery_uncertain` table
(migration 004), both recorded in `_migrations`. Rolling the code back to the
pre-guard release (d16221a) needs **no database action**. Checked against that
release's `c4-schema.js` / `sqlite-schema.js` on a database built by the new
migrations: its runtime open (`guardDatabase`) and its upgrade worker (owners
wrapped as `strict: false, rejectUnsafeExtensions: true`) accept both and
report them as extensions (`tables: [delivery_uncertain]`, `columns:
[control_queue.session_ref]`); the old code never names the column in its
INSERTs, and its migration runner applies only the files it ships and ignores
the extra ledger rows. Only a direct `inspectSchema(db)` call with the default
`strict: true` rejects the layout (`c4: unsupported columns
control_queue.session_ref`); no runtime or upgrade path of that release makes
that call.

Do **not** drop the column or the table, or delete the `003`/`004` rows from
`_migrations`, as part of a rollback: a later re-upgrade skips migrations whose
ledger row exists, so removing only one side leaves a schema the new code
cannot use. Remove the guard's runtime files instead if wanted
(`activity-monitor/fable-guard.json`, `fable-usage.json`, `activity-monitor/fable-exec/`, and per persona
`fable-launch.json`, `fable-readiness.json`, `fable-lease-enforcement.json`, `fable-observation.json`,
`fable-uncertain-deliveries.json`, `fable-session-failures.json`,
`fable-limit-evidence.json`); the old code ignores them.

## Deployment notes

- Skills files to install: `activity-monitor/scripts/{fable-probe,fable-guard,fable-exec-claim,fable-monitor,fable-guard-cli,runtime-failover,health-engine,monitor,monitor-orchestrator,hook-auth-prompt}.js`,
  `activity-monitor/scripts/adapters/runtime-components.js`,
  `multi-session/runtime-files.js`, `activity-monitor/scripts/{guardian,runtime-switch-signal}.js`,
  and the comm-bridge files of the delivery half (`c4-db.js`,
  `tmux-input-state.js`, migrations 003/004). `cli/lib/runtime/claude.js`
  loads from the checkout. Keep `chmod -R go-w` on `activity-monitor` after copying.
- Restart `runtime-failover` to start probing. A persona's monitor picks up the
  health and launch changes on its next restart, which the guard performs on
  every transition.
- Reset-window logic is proven by fixtures until a real weekly reset has been
  observed.
