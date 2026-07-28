# OS-User Isolation (`os_user`)

Multi-session zylos can run each instance's agent process as a **dedicated unix
user** instead of the service user, turning instance isolation from advisory
(hooks) into kernel-enforced (process credentials + file permissions).

## Why

All instances sharing one unix user means any agent session — including ones
driven by external humans over chat channels (a prompt-injection surface) — can
read every other instance's files, the shared `.env`, the operator's `~/.claude`
(credentials, transcripts), and any source repo on the box. PreToolUse guards
(memory-guard.js) are advisory; same-UID processes bypass them with Bash.

## How

`instances.json` per-instance field:

```json
"user-pan": { "os_user": "zylos-pan", ... }
```

When set, both runtime adapters and the shared launcher:

1. builds the launch env with `HOME=/home/<os_user>`, `USER`/`LOGNAME=<os_user>`
2. chowns the launch spec to the agent user (launcher must read + unlink it)
3. starts the pane via `sudo -n -u <os_user> -H -- node tmux-launcher.js <spec>`
   — the tmux server stays on the service user, so send-keys / capture-pane /
   dispatcher delivery are unchanged; only the pane's process tree drops
   privilege
4. skips `_ensureOnboardingComplete` (provisioning pre-writes the agent home's
   `.claude.json` + `.claude/settings.json`)
5. kills any leftover tmux session instead of reusing it (a privileged pane
   can't be reused safely)
6. keeps `instances/<id>/.env` linked to the persona's real farm env and lets
   `tmux-launcher` read it only after dropping to that OS user; Claude and Codex
   therefore receive the same persona-managed variables, while runtime-forced
   identity/profile values take precedence

`os_user` values are validated against `/^[a-z_][a-z0-9_-]{0,31}$/`.

`c4-approve.js` provisions the unix user automatically for newly approved
users when `$ZYLOS_DIR/scripts/ops/provision-agent-user.sh` exists, then sets
`os_user` in instances.json. Without the script it degrades to the shared
service user with a warning.

## Agent home layout (provisioned)

```
/home/zylos-<name>/            750, group joined by the service user
  zylos/                       "farm dir" — $HOME/zylos resolves here
    .env                       REAL per-instance env (allow-listed keys, 600)
    <everything else>          symlinks into the shared $ZYLOS_DIR
  .claude/
    .credentials.json -> shared hardlinked credentials (group rw)
    settings.json              skipDangerousModePermissionPrompt
  .claude.json                 onboarding + project trust pre-accepted
```

The farm dir is the key trick: every skill that resolves `$HOME/zylos/.env`
(channel send scripts, imagegen, etc.) transparently gets the per-instance env
with zero code changes. The instance cwd `.env` resolves to this same file, so
the persona may add or update its own service credentials and both runtimes see
them without a copy. The root Zylos `.env` stays unreadable to isolated users.

## Shared-write surfaces

The instance state dir and comm-bridge sqlite are co-written by the service
user's daemons and the agent process. Provisioning covers this with setgid
dirs + POSIX default ACLs (`u:<service>:rwX`, `u:<agent>:rwX`), and a
`zylos-agents` group grants WAL read-write on `comm-bridge/`.

Known limitation: the shared sqlite has no row-level isolation — any agent can
read other instances' conversation rows. Follow-up design: broker c4 send/query
through the per-instance activity-monitor socket so the DB handle stays with
the service user. (Shipped as ZY-ISO-2 — the C4 broker; see the deployment plan.)

Per-group memory tier (ZY-GRP-1): `memory/groups/<group_key>/` is owned by the
group user (`2770 zylos-group` + setgid + service-user default ACL, provision
step 8b). Only the group instance may write it — other agents are not in the
`zylos-group` primary group and get no ACL, so they can't even traverse in;
`verify-isolation.sh` asserts both directions, and `memory-guard.js` enforces
the same rule at the code layer.

## Deployment-side pieces (live in the deployment's `scripts/ops/`)

- `provision-agent-user.sh <instance-id>` — idempotent: user, groups, home
  skeleton, farm dir, ACLs
- `harden-shared-perms.sh` — one-time shared-filesystem lockdown (root `.env`,
  operator config, source repos, gh/gws/channel secrets, workspace policy)
- `verify-isolation.sh [ids...]` — DENY/ALLOW assertion matrix; run after any
  provisioning or permission change
