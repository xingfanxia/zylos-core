# Runtime Switch — Authentication Recovery

Read this when `zylos runtime <target>` exits with **code 2 (auth required)**.
The switch command itself (confirmation etiquette, what it does, transition
notice) is covered by the system instructions; this file holds the full
per-target authentication steps. Honor the existing runtime-change approval;
authentication does not authorize unrelated activation or service changes.

Never ask users to send API keys, setup tokens, or credential files in chat.
Never pass secret values in CLI arguments, paste them into logs or reports, or
read them back for verification. Use the deployment's approved secret manager
and operator provisioning path for API-key/setup-token installation. If that
path is not established, report the missing provisioning capability and use a
supported interactive login only when authorized; do not invent a secret CLI.

## Switching to Codex (`zylos runtime codex` exits 2)

Use the method already requested or provisioned. For authorized headless login,
run `codex login --device-auth` in the target runtime's environment and relay
only the temporary verification URL/code to the initiating authorized user in
their private channel. The user completes login with the provider; do not ask
for a password, key, token, or credential file. For a local browser flow, use
`codex login`. Wait for successful login before retrying the approved switch.

Codex checks its own credential store (`auth.json` under the effective Codex
home); see `cli/lib/runtime/codex.js#checkAuth`. That check deliberately does
not treat an `OPENAI_API_KEY` in `~/zylos/.env` as authentication. An API-key save
path may mirror credentials into `.env`, but device/browser auth is not an
always-mirrored two-store contract. Do not inspect or echo stored values.

## Switching to Claude Code (`zylos runtime claude` exits 2)

When a Claude runtime switch is explicitly authorized, use `claude auth login`
for browser OAuth and have the user complete the provider flow. Relay a login
URL only to the initiating authorized user. API keys and setup tokens require
the approved operator provisioning path described above.

Claude authentication depends on its installed credential/configuration source;
see `cli/lib/runtime/claude.js`. Do not promise that every auth method stores
the same data in both settings and `.env`, or copy credentials between them
merely to satisfy that claim.

## After authentication succeeds

Retry the original `zylos runtime <target>` command. Once it completes, send
a brief transition notice — keep it short, as the new runtime will send its
own ready message. Do NOT mention `zylos attach` (that is for terminal users
only). Example:

> "Switching now, should be ready in about 10 seconds."
