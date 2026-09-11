/**
 * Upstream merge step for the fork's self-upgrade pipeline.
 *
 * Extracted as a standalone module so self-upgrade.js never needs its
 * REPO constant changed — that was v1's biggest mistake.
 *
 * @module upstream-merge
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { FORK_REPO, UPSTREAM_REPO } from './fork-config.js';
import { getCurrentVersion } from './self-upgrade.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in a given cwd, returning trimmed stdout.
 *
 * @param {string} cmd  - Git command (without the `git` prefix if you want,
 *                        but callers pass the full string).
 * @param {string} cwd  - Working directory.
 * @param {number} [timeout=120000] - Timeout in ms.
 * @returns {string} Trimmed stdout.
 */
function git(cmd, cwd, timeout = 120_000) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
  }).trim();
}

/**
 * Build a consistent step-result object.
 *
 * @param {'done'|'skipped'|'failed'} status
 * @param {number} startTime - `Date.now()` captured at step entry.
 * @param {object} [extra]   - Optional `message` and/or `error` fields.
 * @returns {{ step: number, name: string, status: string, duration: number, message?: string, error?: string }}
 */
function stepResult(status, startTime, extra = {}) {
  return {
    step: 0,
    name: 'merge_upstream',
    status,
    duration: Date.now() - startTime,
    ...extra,
  };
}

/**
 * Safely remove a directory, swallowing errors.
 *
 * @param {string} dir
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Step 0: merge upstream into fork
// ---------------------------------------------------------------------------

/**
 * Merge upstream (UPSTREAM_REPO) into the fork (FORK_REPO).
 *
 * Same interface as every other step in the self-upgrade pipeline:
 * takes `ctx`, returns `{ step, name, status, message?, error?, duration }`.
 *
 * @param {object} ctx - Upgrade context created by `createContext()`.
 * @returns {{ step: number, name: string, status: 'done'|'skipped'|'failed', message?: string, error?: string, duration: number }}
 */
export function step0_mergeUpstream(ctx) {
  const startTime = Date.now();

  // Guard: caller opted out
  if (ctx.skipUpstreamMerge) {
    return stepResult('skipped', startTime, {
      message: 'opt-in only (use --merge-upstream)',
    });
  }

  const tmpClone = path.join(
    os.tmpdir(),
    `zylos-upstream-merge-${Date.now()}`,
  );

  try {
    // 1. Shallow-clone the fork
    git(
      `git clone --depth 50 https://github.com/${FORK_REPO}.git "${tmpClone}"`,
      os.tmpdir(),
    );

    // 2. Add the upstream remote
    git(
      `git remote add upstream https://github.com/${UPSTREAM_REPO}.git`,
      tmpClone,
      30_000,
    );

    // 3. Fetch upstream main
    git('git fetch upstream main', tmpClone);

    // 4. Anything to merge?
    const behindCount = git(
      'git rev-list --count HEAD..upstream/main',
      tmpClone,
      15_000,
    );

    if (behindCount === '0') {
      cleanup(tmpClone);
      return stepResult('skipped', startTime, {
        message: 'already up to date',
      });
    }

    // 5. Attempt the merge
    try {
      git('git merge upstream/main --no-edit', tmpClone, 60_000);
    } catch {
      // Merge conflict — gather conflict files, abort, and bail
      let conflictFiles = [];
      try {
        const raw = git(
          'git diff --name-only --diff-filter=U',
          tmpClone,
          15_000,
        );
        conflictFiles = raw ? raw.split('\n') : [];
      } catch { /* best-effort */ }

      try {
        git('git merge --abort', tmpClone, 15_000);
      } catch { /* best-effort */ }

      cleanup(tmpClone);
      return stepResult('skipped', startTime, {
        message: `merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`,
      });
    }

    // 6. Safety: verify local branch is not behind origin/main.
    //    On shallow clones the merge may silently diverge — pushing in
    //    that state would overwrite remote commits.
    const aheadBehind = git(
      'git rev-list --left-right --count origin/main...HEAD',
      tmpClone,
      15_000,
    );
    const [behind] = aheadBehind.split(/\s+/).map(Number);

    if (behind > 0) {
      cleanup(tmpClone);
      return stepResult('skipped', startTime, {
        message: `local branch is ${behind} commit(s) behind origin/main — aborting push to avoid overwriting remote commits (shallow clone divergence)`,
      });
    }

    // 7. Push merged result to fork's origin main
    git('git push origin main', tmpClone);

    cleanup(tmpClone);
    return stepResult('done', startTime, {
      message: `merged ${behindCount} commit(s) from upstream`,
    });
  } catch (err) {
    cleanup(tmpClone);
    return stepResult('skipped', startTime, {
      message: `upstream merge failed: ${err.message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI version capture / restore (for rollback)
// ---------------------------------------------------------------------------

/**
 * Save the currently installed CLI version to `ctx.previousCliVersion`.
 *
 * Call this early in the pipeline (before npm install overwrites the binary)
 * so that `restoreCliVersion` can roll back if needed.
 *
 * @param {object} ctx - Upgrade context.
 */
export function captureCliVersion(ctx) {
  const current = getCurrentVersion();
  if (current.success) {
    ctx.previousCliVersion = current.version;
  }
}

/**
 * Attempt to restore the CLI to a previously captured version during rollback.
 *
 * @param {object} ctx - Upgrade context (must have `previousCliVersion` set).
 * @returns {{ success: boolean, version?: string, error?: string }}
 */
export function restoreCliVersion(ctx) {
  if (!ctx.previousCliVersion) {
    return { success: false, error: 'no previous version captured' };
  }

  try {
    execSync(`npm install -g zylos@${ctx.previousCliVersion}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZYLOS_SKIP_POSTINSTALL: '1' },
      timeout: 120_000,
    });
    return { success: true, version: ctx.previousCliVersion };
  } catch (err) {
    return {
      success: false,
      error: `could not restore CLI to v${ctx.previousCliVersion}: ${err.message}`,
    };
  }
}
