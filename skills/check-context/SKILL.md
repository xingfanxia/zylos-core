---
name: check-context
description: Accurately check current context window and token usage. Use when the user asks about context usage, token consumption, or when monitoring context levels.
user-invocable: false
---

# Check Context Skill

Check current context/token usage. The data source depends on the active runtime.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

Identify the active runtime from the current session. If needed, inspect only
the `runtime` field in `~/zylos/.zylos/config.json`. Missing or unreadable
metadata means the runtime is unknown; do not silently assume Claude.

### If Claude runtime

Read the relevant fields in `~/zylos/activity-monitor/statusline.json` (updated
after every turn). Confirm the file belongs to the current instance/session
and report its timestamp; stale data is a last-known observation.

Report from the JSON:
- **Context usage**: `context_window.used_percentage`% used, `context_window.remaining_percentage`% remaining
- **Tokens**: `context_window.total_input_tokens` input, `context_window.total_output_tokens` output (window size: `context_window.context_window_size`)
- **Session cost**: `cost.total_cost_usd`
- **Model**: `model.display_name`

### If Codex runtime

Prefer token/context metadata exposed by the current session. For a local
fallback, identify the matching rollout under the active Codex home using its
session id and `session_meta` identity/cwd. Instance metadata can narrow the
search, but the newest file across all sessions may belong to another agent.
If the active rollout cannot be identified, report that limitation.

Read only the latest matching `event_msg` with `payload.type: token_count`:

- `payload.info.last_token_usage.input_tokens` is the last request's context
  fill. Do not substitute cumulative `total_token_usage`.
- `payload.info.model_context_window` is the effective ceiling reported by
  that runtime. Do not apply another percentage reduction to it.
- Compute `100 * used / ceiling` only when both values are finite, `used` is
  nonnegative, and `ceiling` is positive. Include the event timestamp and
  identify this as the last request's measurement.

If the event lacks a ceiling, a confirmed active `model_context_window` setting
or an exact active-model entry in `models_cache.json` may provide a labelled
configuration estimate. Account for `effective_context_window_percent` only
for a raw cache window. Do not use the first cache entry, a stale model's limit,
or a fixed 128k/model-marketing limit as live evidence. If the effective ceiling
is unresolved, report available token counts and mark percentage unknown.

For rotation policy, read `codex_new_session_threshold` from the active Zylos
configuration. The current implementation in
`cli/lib/runtime/codex.js#getContextMonitor` parses that percentage and falls
back to 75% when it is missing or outside 1–100; distinguish this configured or
code-default threshold from the model's context ceiling. Do not invent a
threshold when the deployed implementation/configuration is unknown.

The daemon's `cli/lib/runtime/codex-context-monitor.js` still has a legacy 128k
fallback when metadata is unavailable. That fallback is not a measured Astra
limit. This reporting skill does not change daemon behavior or authorize a
rotation; use the existing handoff policy for any requested action.
