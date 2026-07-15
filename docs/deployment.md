# Deployment Guide

This fork (xingfanxia/zylos-core) deploys directly from the repo — no `npm install -g` packaging needed.

## Directory Layout

| Path | Purpose |
|------|---------|
| `~/zylos-core/` | Fork repo (this repo) |
| `~/zylos/` | Runtime home (zylos-config repo) |
| `~/zylos/.claude/skills/` | Deployed skills (rsynced from repo) |
| `~/zylos/pm2/ecosystem.config.cjs` | PM2 config (copied from repo) |
| `~/zylos/instances/` | Per-instance working directories |
| `~/zylos/instances.json` | Instance definitions (runtime config) |
| `~/.local/bin/zylos` | CLI binary symlink → `~/zylos-core/cli/zylos.js` |

For upstream/public single-session installs, runtime profile state may instead
live in `~/zylos/.zylos/runtime-profiles.json`. Do not add `instances.json` just
to enable failover; that would change the deployment topology.

## Deploy Steps

```bash
# 1. Pull latest from fork
cd ~/zylos-core && git pull origin main

# 2. Rsync skills (exclude component skills — they're separately installed)
rsync -av --delete \
  --exclude='telegram/' --exclude='feishu/' \
  --exclude='browser/' --exclude='imagegen/' \
  --exclude='snapdesign-rednote/' \
  --exclude='node_modules/' \
  ~/zylos-core/skills/ ~/zylos/.claude/skills/

# 3. Deploy ecosystem config
cp ~/zylos-core/templates/pm2/ecosystem.config.cjs ~/zylos/pm2/ecosystem.config.cjs

# 4. Reload PM2 (picks up new ecosystem config)
pm2 delete all && pm2 start ~/zylos/pm2/ecosystem.config.cjs && pm2 save

# 5. Restart CC instances (AM auto-restarts them within ~20s)
# Session prefix matches runtime: codex-* for Codex, claude-* for Claude
for s in codex-main codex-scheduler codex-group; do tmux kill-session -t "$s" 2>/dev/null; done
tmux list-sessions -F '#{session_name}' | grep '^codex-user-' | xargs -I{} tmux kill-session -t {}
```

## Runtime Failover Deployment Contract

Runtime failover is an engine replacement, not a persona migration. Before and
after a failover canary, verify that `ZYLOS.md`, memory paths/inodes,
`.claude/skills`, the workspace `.env`, C4 databases, chat routing, instance cwd, and explicit
tmux names are unchanged. Every instance working directory must expose the
shared files through `.claude`, `.agents`, and `memory` links; an OS-isolated
instance's `.env` must resolve to its writable `/home/<os_user>/zylos/.env`, not
the root env. The root
`.agents/skills` link must resolve to the root `.claude/skills` tree.

Only profile/provider credentials use separate homes. Keep subscription and API
credentials in protected `CODEX_HOME` directories. Profile JSON may contain a
provider environment variable **name**, never its value. The launcher reads the
key from that profile's `auth.json` into its mode-0600 launch spec, so it does
not appear in PM2 state, shell arguments, or logs. The launcher reads the
persona `.env` only after dropping to the persona user and makes that same file
available to either engine; runtime-controlled values win on conflicts.

For multi-session deployments, `runtime-failover` atomically changes only the
instance's runtime/profile metadata, kills its stable tmux pane, and restarts
that instance's activity monitor. For upstream single-session deployments it
does the same through `.zylos/runtime-profiles.json`, the existing
`.zylos/config.json`, the existing stable tmux name, and the existing
`activity-monitor`; it must not create `instances.json` or duplicate persona
state.

After deployment, verify both transitions with a bounded canary:

1. switch one persona from subscription to the API profile and allow the
   monitor to recreate its engine;
2. confirm model/reasoning/provider and credential environment **names** only;
3. confirm the identity, memory, skills, `.env`, C4/routing, cwd, and tmux
   invariants above;
4. confirm API token totals and the LiteLLM equivalent estimate are attributed
   to that persona/profile;
5. fail back to the subscription profile and repeat the invariant check.

Claude profiles use `CLAUDE_EFFORT`; current fleet policy is `high` with
ultracode disabled. Codex model and reasoning are profile fields and therefore
can differ by host without changing the persona.

Step 5 is only needed when `cli/lib/runtime/claude.js` (the RuntimeAdapter) changes. For skills-only changes, steps 1-4 are sufficient since PM2 restart reloads the AM which imports skills.

If the deploy includes changes to runtime templates or Claude hook wiring, run:

```bash
cd ~/zylos-core
node cli/lib/sync-settings-hooks.js
```

This is required after changes to:

- `templates/.claude/settings.json`
- Codex runtime config rendering (`~/.codex/config.toml`)
- any core hook command path or timeout

If the deploy includes changes to token collection or dashboard usage logic, refresh
the cached usage files once after rollout:

```bash
cd ~/zylos-core
node skills/activity-monitor/scripts/update-token-cache.js
```

## Post-Deploy Smoke Tests

After deploying to `~/zylos`, run the live smoke suite from the repo checkout:

```bash
cd ~/zylos-core
bash test/full-smoke-live.sh
```

This runs two layers of verification:

- `test/e2e-live.sh` for routing, queueing, instance selection, live delivery, cold auto-start, scheduler delivery, inter-instance queries, and memory isolation.
- `test/live-roundtrip-smoke.sh` for real Feishu roundtrip probes against `admin` plus every enabled user instance.

### Mixed-Runtime Verification

When Codex runtime plumbing changes, verify both the live context window and the
dashboard history path:

```bash
# 1. Fresh Codex session should report the large effective context window
sqlite3 -header -column ~/.codex/state_5.sqlite \
  "SELECT datetime(updated_at,'unixepoch') AS updated_utc, cwd, rollout_path
   FROM threads
   WHERE archived = 0 AND cwd LIKE '%/instances/%'
   ORDER BY updated_at DESC
   LIMIT 5;"

# then inspect the latest rollout for token_count.model_context_window

# 2. Dashboard token cache should contain Codex history
curl -s http://127.0.0.1:3456/api/dashboard/tokens | jq '.runtimes.codex.totals'
```

Expected current behavior:

- fresh spawned Codex instance sessions report an effective `model_context_window`
  around `950000` (the 95% working ceiling of the configured 1M window)
- `/api/dashboard/tokens` shows non-zero `runtimes.codex` totals once the cache refresh finishes

### Reusable Roundtrip Probe

Use the single-instance probe when you only need to verify one session:

```bash
cd ~/zylos-core
bash test/live-roundtrip-smoke.sh --instance user-limh
```

Useful options:

- `--cold-start` — kill the target tmux session before sending, then verify wake + recovery
- `--chat-id <oc_xxx>` — override the Feishu chat used for send/readback
- `--endpoint <endpoint_id>` — override the full C4 endpoint
- `--skip-chat-readback` — skip the final Feishu chat verification step

### Safety Model

By default, the roundtrip probe targets the selected instance but sends the visible reply back to the first admin DM chat from `~/zylos/instances.json`.

That means:

- the target instance really processes the message
- the outbound reply really goes through Feishu
- no real user DM is disturbed during the smoke test

Expect one `PROBE_ACK_*` message in the admin DM for each roundtrip probe.

### npm Shortcuts

```bash
cd ~/zylos-core
npm run test:smoke:roundtrip -- --instance user-limh
npm run test:smoke:full
```

## Mixed-Runtime Memory Notes

The current mixed-runtime hardening assumes Claude and Codex may read the same
memory tree even before full mixed-runtime orchestration is implemented.

What is now enforced:

- Shared memory writes are restricted: only the primary instance or scheduler may write `memory/shared/...` and `memory/archive/...`.
- Non-primary user/worker instances may write only their own `memory/instances/<id>/...` files plus `memory/users/<uid>/profile.md`.
- The memory guard is now wired through the Claude hook template, so existing installs need `node cli/lib/sync-settings-hooks.js` after deploy.
- Codex bootstrap now reads per-instance `memory/instances/<id>/state.md` instead of assuming legacy flat `memory/state.md`.
- Session-start memory injection now prints a `MEMORY WRITE POLICY` block and resolves runtime-aware per-instance instruction overlays.
- Per-instance working directories now symlink both `CLAUDE.md` and `AGENTS.md`.
- Codex runtime config rendering now preserves operator overrides and writes the
  runtime defaults Zylos expects for unattended sessions:
  - `model = "gpt-5.4"`
  - `model_context_window = 1000000`
  - `model_auto_compact_token_limit = 800000`
  - `model_reasoning_effort = "xhigh"`
  - `personality = "pragmatic"`

Operationally, this means runtime switching can preserve memory more safely,
and future mixed-runtime instances will start from a stricter memory policy.

For the broader concurrent Claude+Codex roadmap, including dashboard runtime
controls, see [design/mixed-runtime-plan.md](design/mixed-runtime-plan.md).

## Why Not `npm install -g`?

The AM imports the RuntimeAdapter via `ZYLOS_PACKAGE_ROOT` env var, which the ecosystem config resolves by following the `zylos` binary symlink. As long as the symlink points to the fork repo, the adapter is found without npm packaging.

## Component Skills (DO NOT rsync --delete)

These are installed separately from their own repos and must be excluded from rsync:

- `telegram/` — zylos-ai/zylos-telegram
- `feishu/` — zylos-ai/zylos-feishu
- `browser/` — zylos-ai/zylos-browser
- `imagegen/` — zylos-ai/zylos-imagegen
- `snapdesign-rednote/`

## Upstream Merge

Fork main stays on top of upstream v0.4.12 (last synced 2026-04-09). Fork contains 6 squashed feature commits on top of upstream.

### Simple merge (small upstream updates)

```bash
cd ~/zylos-core
git remote add upstream https://github.com/zylos-ai/zylos-core.git  # if not added
git fetch upstream
git merge upstream/main  # resolve conflicts
git push origin main
```

Then follow deploy steps above.

### Rebase (keeps fork history linear on top of upstream)

Preferred when fork commits are clean and upstream updates are small:

```bash
git fetch upstream
git rebase upstream/main
# Resolve conflicts file-by-file if any (typically package.json, CHANGELOG.md)
git push --force-with-lease origin main
```

### Squash-cleanup workflow (when fork accumulates many fix-regression chains)

When the fork has accumulated many commits fixing regressions from earlier fork
work, squash before merging for a cleaner history:

```bash
# 1. Backup
git branch backup-main-pre-cleanup main
git tag backup-pre-cleanup-$(date +%Y%m%d)
git push origin backup-main-pre-cleanup backup-pre-cleanup-$(date +%Y%m%d)

# 2. Find merge-base with upstream
MERGE_BASE=$(git merge-base main upstream/main)

# 3. Soft-reset to merge-base, keeping all changes staged
git checkout -b cleanup-squash main
git reset --soft $MERGE_BASE
git reset  # unstage

# 4. Commit in logical groups
git add <group-1-files> && git commit -m "feat: ..."
# ... repeat for each group

# 5. Verify tree matches main (zero loss)
git diff cleanup-squash..main --stat  # should be empty

# 6. Rebase onto upstream/main to pull in new upstream commits
git rebase upstream/main  # git 3-way merges auto-resolve non-overlapping files

# 7. Run tests
npm test
bash test/live-roundtrip-smoke.sh --instance admin --skip-chat-readback

# 8. Force-push when green
git branch -f main cleanup-squash
git push --force-with-lease origin main

# 9. Rollback command if needed
git push --force-with-lease origin backup-main-pre-cleanup:main
```

Last squash: 2026-04-09 — 67 fork commits → 6 clean commits on upstream v0.4.12.
