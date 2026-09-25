import { execSync as defaultExecSync, execFileSync as defaultExecFileSync } from 'child_process';

/**
 * Run a tmux command WITHOUT a shell. On timeout Node kills the tmux child
 * directly; a shell-wrapped `execSync('tmux ... 2>/dev/null')` would only kill
 * the /bin/sh child and orphan the tmux grandchild — and during a sustained
 * tmux-server hang the guardian probes ~3x/sec, so that would pile leaked tmux
 * clients onto an already-sick server. No-shell also removes any
 * shell-interpolation risk on the session name. 3s timeout is well under the 1s
 * monitor loop budget in the common case; a degraded server can stretch a tick
 * but the self-scheduling loop never overlaps and staleness is flagged downstream.
 */
function runTmux(args, { execFileSyncImpl = defaultExecFileSync } = {}) {
  return execFileSyncImpl('tmux', args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export const BASE_RESTART_DELAY = 5;
export const MAX_RESTART_DELAY = 60;
export const BACKOFF_RESET_THRESHOLD = 60;
export const STARTUP_GRACE_TICKS = 30;
export const MAINTENANCE_WAIT_TIMEOUT = 300;

export function getRunningMaintenance({ execSyncImpl = defaultExecSync } = {}) {
  try {
    execSyncImpl('pgrep -f "[r]estart-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'restart-claude';
  } catch { }

  try {
    execSyncImpl('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'upgrade-claude';
  } catch { }

  try {
    execSyncImpl('pgrep -f "[c]laude.ai/install.sh" > /dev/null 2>&1', { timeout: 500 });
    return 'upgrade (curl install.sh)';
  } catch { }

  return null;
}

export function waitForMaintenance({
  log = () => {},
  execSyncImpl = defaultExecSync,
  maxWait = MAINTENANCE_WAIT_TIMEOUT,
} = {}) {
  let waited = 0;
  let scriptName = getRunningMaintenance({ execSyncImpl });
  if (!scriptName) return 0;

  log(`Guardian: Detected ${scriptName} running, waiting for completion...`);
  while (true) {
    scriptName = getRunningMaintenance({ execSyncImpl });
    if (!scriptName) break;

    if (waited >= maxWait) {
      log(`Guardian: Warning - ${scriptName} still running after ${maxWait}s, proceeding anyway`);
      break;
    }

    if (waited > 0 && waited % 30 === 0) {
      log(`Guardian: Still waiting for ${scriptName}... (${waited}s)`);
    }

    execSyncImpl('sleep 1', { timeout: 1500 });
    waited += 1;
  }

  if (waited > 0 && waited < maxWait) {
    log(`Guardian: maintenance completed after ${waited}s`);
  }
  return waited;
}

/**
 * Classify whether an execSync failure is a probe TIMEOUT (indeterminate state —
 * tmux server unresponsive) rather than a clean answer. On a timeout Node kills
 * the child and sets `killed=true` + `signal='SIGTERM'` (and on some versions
 * `code='ETIMEDOUT'`). A genuine "no such session" is a clean non-zero exit with
 * no signal. Distinguishing the two is the crux of avoiding the false-STOPPED
 * restart flap: a timeout means "unknown", never "dead".
 */
export function isTmuxTimeoutError(err) {
  if (!err) return false;
  return err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' || err.killed === true;
}

/**
 * Probe whether the tmux session exists, distinguishing a definitive answer from
 * an indeterminate one (tmux unresponsive / probe timed out).
 * @returns {'present'|'absent'|'unknown'}
 */
export function probeTmuxSession({ sessionName, execFileSyncImpl = defaultExecFileSync } = {}) {
  try {
    runTmux(['has-session', '-t', sessionName], { execFileSyncImpl });
    return 'present';
  } catch (err) {
    return isTmuxTimeoutError(err) ? 'unknown' : 'absent';
  }
}

/**
 * Probe tmux responsiveness via list-panes — the heavier call that hung during
 * the 2026-06-20 incident while has-session still answered. Used to disambiguate
 * a not-running verdict: never trust "agent stopped" while tmux itself is
 * unresponsive.
 * @returns {'responsive'|'no-session'|'unknown'}
 */
export function probeTmuxResponsive({ sessionName, execFileSyncImpl = defaultExecFileSync } = {}) {
  try {
    const out = runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { execFileSyncImpl });
    return String(out ?? '').trim() ? 'responsive' : 'no-session';
  } catch (err) {
    return isTmuxTimeoutError(err) ? 'unknown' : 'no-session';
  }
}

export class Guardian {
  constructor(adapter, deps = {}) {
    this.adapter = adapter;
    this.deps = {
      log: () => {},
      resetToolLifecycleState: () => {},
      execSyncImpl: defaultExecSync,
      execFileSyncImpl: defaultExecFileSync,
      nowMs: () => Date.now(),
      initialRuntimeLaunchAtMs: 0,
      ...deps,
    };
    this.notRunningCount = 0;
    this.consecutiveRestarts = 0;
    this.stableRunningSince = 0;
    this.startupGrace = 0;
    this.startAgentInProgress = false;
    this.runtimeLaunchAtMs = this.deps.initialRuntimeLaunchAtMs;
  }

  getState() {
    return {
      notRunningCount: this.notRunningCount,
      consecutiveRestarts: this.consecutiveRestarts,
      stableRunningSince: this.stableRunningSince,
      startupGrace: this.startupGrace,
      startAgentInProgress: this.startAgentInProgress,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
    };
  }

  async tick({ currentTime } = {}) {
    const sessionProbe = probeTmuxSession({
      sessionName: this.adapter.sessionName,
      execFileSyncImpl: this.deps.execFileSyncImpl,
    });

    if (sessionProbe === 'unknown') {
      return this._holdIndeterminate('tmux session probe timed out (tmux unresponsive)');
    }

    if (sessionProbe === 'absent') {
      return this._handleNotRunning({
        state: 'offline',
        message: 'tmux session not found',
        restartLog: `Guardian: Session not found for {count}s, attempting to start ${this.adapter.displayName}...`,
        // Under heavy load has-session can return a transient/racy 'absent' while
        // the session is mid-(re)create (context rotation or a slow launcher).
        // Re-verify immediately before launching: restarting on a stale 'absent'
        // spawns a redundant runtime and collides with the launcher ("duplicate
        // session") — the exact flap the timeout-guard alone does not catch.
        confirmDown: () => probeTmuxSession({
          sessionName: this.adapter.sessionName,
          execFileSyncImpl: this.deps.execFileSyncImpl,
        }) === 'absent',
      });
    }

    let agentRunning = false;
    try {
      agentRunning = await this.adapter.isRunning();
    } catch (err) {
      // Defensive: the shipped Claude adapter swallows tmux timeouts internally
      // (returns false, handled by the responsiveness re-probe below), so this
      // branch is dead for Claude. It matters for any adapter whose isRunning()
      // propagates a tmux timeout instead — treat that as indeterminate, not dead.
      if (isTmuxTimeoutError(err)) {
        return this._holdIndeterminate(`agent probe timed out: ${err.message}`);
      }
      this.deps.log(`Guardian: adapter.isRunning() threw: ${err.message}`);
    }

    if (!agentRunning) {
      // A "not running" verdict is only trustworthy if tmux itself is responsive.
      // A hung tmux server makes isRunning() falsely report stopped — restarting
      // on that is what caused the 2026-06-20 flap. Disambiguate, and hold (never
      // restart) while tmux is unresponsive.
      const responsive = probeTmuxResponsive({
        sessionName: this.adapter.sessionName,
        execFileSyncImpl: this.deps.execFileSyncImpl,
      });
      if (responsive === 'unknown') {
        return this._holdIndeterminate('tmux unresponsive during agent probe — not trusting stopped verdict');
      }

      return this._handleNotRunning({
        state: 'stopped',
        message: `${this.adapter.displayName} not running in tmux`,
        restartLog: `Guardian: Agent not running for {count}s, attempting to start ${this.adapter.displayName}...`,
      });
    }

    this.startupGrace = 0;
    this.notRunningCount = 0;

    if (this.consecutiveRestarts > 0) {
      if (this.stableRunningSince === 0) {
        this.stableRunningSince = currentTime;
      } else if (currentTime - this.stableRunningSince >= BACKOFF_RESET_THRESHOLD) {
        this.consecutiveRestarts = 0;
        this.stableRunningSince = 0;
      }
    }

    return {
      state: 'running',
      attempted_restart: false,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: 0,
      message: null,
      skippedForStartupGrace: false,
    };
  }

  /**
   * Indeterminate probe: liveness cannot be confirmed because tmux is
   * unresponsive. Hold last-known state — do NOT restart and do NOT advance the
   * not-running counters, so a transient or sustained tmux hang can never escalate
   * into a restart flap. When tmux recovers, the next tick resumes normally.
   */
  _holdIndeterminate(reason) {
    return {
      state: 'indeterminate',
      attempted_restart: false,
      skippedForIndeterminateProbe: true,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: this.notRunningCount,
      message: reason,
      skippedForStartupGrace: false,
    };
  }

  _handleNotRunning({ state, message, restartLog, confirmDown = null }) {
    if (this.startupGrace > 0) {
      this.startupGrace -= 1;
      return {
        state,
        attempted_restart: false,
        runtimeLaunchAtMs: this.runtimeLaunchAtMs,
        notRunningSeconds: this.notRunningCount,
        message,
        skippedForStartupGrace: true,
      };
    }

    this.notRunningCount += 1;
    this.stableRunningSince = 0;

    let attemptedRestart = false;
    const restartDelay = Math.min(
      BASE_RESTART_DELAY * Math.pow(2, this.consecutiveRestarts),
      MAX_RESTART_DELAY
    );
    if (this.notRunningCount >= restartDelay) {
      // Final confirmation right before launching. Guards against acting on a
      // stale probe verdict: if the runtime reappeared (or tmux went
      // unresponsive), abort and reset the counter instead of spawning a
      // redundant runtime that races the live/launching session.
      if (confirmDown && !confirmDown()) {
        this.notRunningCount = 0;
        this.deps.log(`Guardian: ${this.adapter.displayName} reappeared before restart — aborting redundant launch`);
        return {
          state,
          attempted_restart: false,
          runtimeLaunchAtMs: this.runtimeLaunchAtMs,
          notRunningSeconds: 0,
          message: `${message} (restart aborted: reappeared)`,
          skippedForStartupGrace: false,
        };
      }
      this.deps.log(restartLog.replace('{count}', String(this.notRunningCount)));
      attemptedRestart = this.startAgent();
    }

    return {
      state,
      attempted_restart: attemptedRestart,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: this.notRunningCount,
      message,
      skippedForStartupGrace: false,
    };
  }

  startAgent() {
    if (this.startAgentInProgress) return false;
    this.startAgentInProgress = true;

    try {
      if (getRunningMaintenance({ execSyncImpl: this.deps.execSyncImpl })) {
        this.deps.log('Guardian: Maintenance script detected, waiting for completion...');
        waitForMaintenance({
          log: this.deps.log,
          execSyncImpl: this.deps.execSyncImpl,
        });
      }

      this.consecutiveRestarts += 1;
      this.startupGrace = STARTUP_GRACE_TICKS;
      this.notRunningCount = 0;
      this.runtimeLaunchAtMs = this.deps.nowMs();

      this.deps.log(`Guardian: Starting ${this.adapter.displayName}...`);

      try {
        this.adapter.clearStaleState?.();
      } catch { }

      try {
        this.deps.resetToolLifecycleState();
      } catch { }

      const reportFailure = (err) => {
        this.deps.log(`Guardian: Failed to start ${this.adapter.displayName}: ${err.message}`);
      };
      const launchPrepared = () => {
        try {
          const launchResult = this.adapter.launch();
          try { this.adapter.enqueueStartupPrompt?.(); } catch { }
          Promise.resolve(launchResult).catch(reportFailure);
        } catch (err) {
          reportFailure(err);
        }
      };
      try {
        const preparation = this.adapter.buildInstructionFile?.();
        if (preparation && typeof preparation.then === 'function') {
          preparation.then(launchPrepared).catch(reportFailure);
        } else {
          launchPrepared();
        }
      } catch (err) {
        reportFailure(err);
      }

      return true;
    } finally {
      this.startAgentInProgress = false;
    }
  }
}
