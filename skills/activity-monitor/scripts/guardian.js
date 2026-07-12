import { execSync as defaultExecSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const BASE_RESTART_DELAY = 5;
export const MAX_RESTART_DELAY = 60;
export const BACKOFF_RESET_THRESHOLD = 60;
export const STARTUP_GRACE_TICKS = 30;
export const MAINTENANCE_WAIT_TIMEOUT = 300;
// Suspend/wake signal files older than this are orphans (writer died or the
// consume gate was off, as in prod pre-REL-6): ignore AND delete them so a
// stale suspend-signal can never strand-suspend an instance.
export const DEFAULT_SIGNAL_TTL_SEC = 600;
// Throttle for the health-gate skip log (the gate can hold for hours at 1s ticks).
const GATE_LOG_INTERVAL_SEC = 60;

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

export function tmuxHasSession({ sessionName, execSyncImpl = defaultExecSync } = {}) {
  try {
    execSyncImpl(`tmux has-session -t "${sessionName}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export class Guardian {
  constructor(adapter, deps = {}) {
    this.adapter = adapter;
    this.deps = {
      log: () => {},
      resetToolLifecycleState: () => {},
      execSyncImpl: defaultExecSync,
      nowMs: () => Date.now(),
      initialRuntimeLaunchAtMs: 0,
      monitorDir: null, // ZY-LIFE-1: per-instance state dir for suspend/wake signals
      signalTtlSec: null, // null → DEFAULT_SIGNAL_TTL_SEC; 0 disables the TTL
      ...deps,
    };
    this.notRunningCount = 0;
    this.consecutiveRestarts = 0;
    this.stableRunningSince = 0;
    this.startupGrace = 0;
    this.startAgentInProgress = false;
    this.runtimeLaunchAtMs = this.deps.initialRuntimeLaunchAtMs;
    this.lastGateLog = { reason: null, at: 0 };
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

  // `health`/`degradedProbeDue` are read FRESH from the HealthEngine by the
  // orchestrator on every tick — never latched into guardian state or a file,
  // so _verifyAuthFailedEntry's auth_failed→unavailable flip un-gates the very
  // next tick. Legacy callers that omit them get the old always-relaunch behavior.
  async tick({ currentTime, health, degradedProbeDue = false } = {}) {
    const healthGate = this._evaluateHealthGate({ health, degradedProbeDue });
    const hasSession = tmuxHasSession({
      sessionName: this.adapter.sessionName,
      execSyncImpl: this.deps.execSyncImpl,
    });

    if (!hasSession) {
      if (this._shouldStaySuspended()) return this._suspendedResult('tmux session not found (instance suspended)');
      return this._handleNotRunning({
        state: 'offline',
        message: 'tmux session not found',
        restartLog: `Guardian: Session not found for {count}s, attempting to start ${this.adapter.displayName}...`,
        healthGate,
        currentTime,
      });
    }

    let agentRunning = false;
    try {
      agentRunning = await this.adapter.isRunning();
    } catch (err) {
      this.deps.log(`Guardian: adapter.isRunning() threw: ${err.message}`);
    }

    if (!agentRunning) {
      if (this._shouldStaySuspended()) return this._suspendedResult(`${this.adapter.displayName} suspended`);
      return this._handleNotRunning({
        state: 'stopped',
        message: `${this.adapter.displayName} not running in tmux`,
        restartLog: `Guardian: Agent not running for {count}s, attempting to start ${this.adapter.displayName}...`,
        healthGate,
        currentTime,
      });
    }

    this.startupGrace = 0;
    this.notRunningCount = 0;

    if (this.consecutiveRestarts > 0) {
      if (this.stableRunningSince === 0) {
        this.stableRunningSince = currentTime;
      } else if (currentTime - this.stableRunningSince >= BACKOFF_RESET_THRESHOLD
          && (health === undefined || health === 'ok')) {
        // Reset only on a functional ACK equivalent (health ok), not on mere
        // process-aliveness — a flapping claude parks ALIVE on a login screen
        // for >60s each cycle, which used to zero this counter every loop.
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

  // ── ZY-LIFE-1: auto-suspend gate ─────────────────────────────────────
  // The dispatcher writes a `suspend-signal` when it reaps an idle instance and
  // a `wake-signal` when a message arrives for an offline instance; the dashboard
  // Suspend also drops a suspend-signal. This gate makes the guardian RESPECT
  // suspension (skip relaunch) instead of restarting immediately — but a pending
  // wake-signal always wins, so a suspended instance self-heals on the user's
  // next message. Legacy behavior (always relaunch) is preserved when no
  // monitorDir is wired.

  _signalPath(name) {
    return this.deps.monitorDir ? path.join(this.deps.monitorDir, name) : null;
  }

  /**
   * True when the named signal file exists AND is fresh. A file older than the
   * TTL is an orphan: it is deleted and reported absent.
   */
  _hasFreshSignal(name) {
    const signalPath = this._signalPath(name);
    if (!signalPath) return false;
    try {
      if (!fs.existsSync(signalPath)) return false;
      const ttlSec = this.deps.signalTtlSec ?? DEFAULT_SIGNAL_TTL_SEC;
      if (ttlSec > 0) {
        const ageMs = this.deps.nowMs() - fs.statSync(signalPath).mtimeMs;
        if (ageMs > ttlSec * 1000) {
          try { fs.unlinkSync(signalPath); } catch { /* best effort */ }
          this.deps.log(`Guardian: ignored and deleted stale ${name} (age ${Math.round(ageMs / 1000)}s > ttl ${ttlSec}s)`);
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Health gate (REL-3): auth_failed / degraded do-not-restart ───────────
  // auth_failed: relaunching lands on the same login screen and each relaunch
  // burns a SessionStart context-injection call. degraded: the flap ceiling
  // tripped; only the bounded probe window may relaunch.
  _evaluateHealthGate({ health, degradedProbeDue }) {
    if (health === 'auth_failed') return 'auth_failed';
    if (health === 'degraded' && !degradedProbeDue) return 'degraded (waiting for next self-probe window)';
    return null;
  }

  _logGateThrottled(reason, currentTime) {
    const nowSec = currentTime ?? 0;
    if (this.lastGateLog.reason === reason && (nowSec - this.lastGateLog.at) < GATE_LOG_INTERVAL_SEC) return;
    this.deps.log(`Guardian: relaunch gated by health (${reason})`);
    this.lastGateLog = { reason, at: nowSec };
  }

  /**
   * @returns {boolean} true if the instance should remain suspended (skip relaunch)
   */
  _shouldStaySuspended() {
    if (!this.deps.monitorDir) return false; // not wired → legacy always-relaunch

    // Wake takes priority: consume the wake-signal, clear suspension, relaunch.
    // (_hasFreshSignal TTLs out orphaned signals — a stale wake is deleted and
    // ignored rather than consumed as a wake.)
    try {
      if (this._hasFreshSignal('wake-signal')) {
        const wake = this._signalPath('wake-signal');
        fs.unlinkSync(wake);
        const sus = this._signalPath('suspend-signal');
        try { if (sus && fs.existsSync(sus)) fs.unlinkSync(sus); } catch { /* ignore */ }
        this._clearSuspendedStatus();
        return false;
      }
    } catch { /* fall through to suspend checks */ }

    // Suspended via the durable signal file (dispatcher reap / dashboard).
    try {
      if (this._hasFreshSignal('suspend-signal')) return true;
    } catch { /* ignore */ }

    // Secondary: an explicit suspended state in agent-status.json.
    try {
      const sp = this._signalPath('agent-status.json');
      if (sp && fs.existsSync(sp)) {
        const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
        if (st && st.state === 'suspended') return true;
      }
    } catch { /* ignore */ }

    return false;
  }

  _clearSuspendedStatus() {
    const sp = this._signalPath('agent-status.json');
    if (!sp) return;
    try {
      const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
      if (st && st.state === 'suspended') {
        st.state = 'starting';
        st.resumed_at = this.deps.nowMs();
        fs.writeFileSync(sp, JSON.stringify(st));
      }
    } catch { /* best effort */ }
  }

  _suspendedResult(message) {
    this.notRunningCount = 0;
    this.startupGrace = 0;
    this.stableRunningSince = 0;
    return {
      state: 'suspended',
      attempted_restart: false,
      runtimeLaunchAtMs: this.runtimeLaunchAtMs,
      notRunningSeconds: 0,
      message,
      skippedForStartupGrace: false,
    };
  }

  _handleNotRunning({ state, message, restartLog, healthGate, currentTime }) {
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
      if (healthGate) {
        this._logGateThrottled(healthGate, currentTime);
      } else {
        this.deps.log(restartLog.replace('{count}', String(this.notRunningCount)));
        attemptedRestart = this.startAgent();
      }
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

      this.adapter.launch().catch(err => {
        this.deps.log(`Guardian: Failed to start ${this.adapter.displayName}: ${err.message}`);
      });

      try {
        this.adapter.enqueueStartupPrompt?.();
      } catch { }

      return true;
    } finally {
      this.startAgentInProgress = false;
    }
  }
}
