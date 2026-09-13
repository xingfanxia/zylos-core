# Codex quota notification milestones

The PPM deployment reports authoritative Codex account usage at each newly
reached 10% band (10, 20, …, 100), independently for weekly and five-hour quotas.
The notice contains the actual latest percentage, not a rounded measurement.
A poll that jumps several bands sends one notice, not a backlog.

The persistent watermark is scoped to the provider's hashed account identity
and the quota cycle. Returning to an account, restarting the monitor, falling
readings and seconds of reset-time jitter do not repeat an already reported band.
A later cycle re-arms after the previous cycle ends. Legacy already-notified
state seeds the current band during upgrade without sending it again.

Only newly crossed windows are included. A low five-hour progress update does
not repeat an unchanged high weekly warning or fan it out to users. Existing
high-usage fan-out limits and authoritative snapshot checks still apply.
Transport is attempted only after saving the watermark. Ambiguous failures are
logged without blindly repeating the same notice. This prioritizes avoiding
repeated owner messages; it is not an exactly-once delivery guarantee.

Provider/account changes are separate events. These progress watermarks do not
change the 95% account rotation policy, Azure fallback, or recovery checks.
Claude's existing alert policy is unchanged.

Validation on 2026-09-13: 45 focused quota tests passed. Full Jest suite passed
286 tests. Full Node suite passed 1854, skipped one and failed three; all three
failures reproduced at the deployed base e03037d on this Mac (two SQLite WAL
sidecar assertions and the C4 startup spill assertion). They do not exercise
the changed quota path.
