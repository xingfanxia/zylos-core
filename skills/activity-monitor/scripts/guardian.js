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

// Failed starts (SWITCH-1). A launch is a started session once the engine has
// been running for START_CONFIRM_SEC without a break; a launch the Guardian has
// to replace before that is a failed start. The first one is retried as is;
// after the second the persona is held, whatever the cause: the operator is
// alerted once and the launch is retried once every heldRetrySec. A failed
// start never moves the persona: runtime-failover keeps acting only on its own
// signals, and if it moves a held persona, the new monitor starts fresh on the
// new tier (the episode ends when a start there is confirmed).
export const START_CONFIRM_SEC = 30;
export const DEFAULT_HELD_RETRY_SEC = 1200;
// A known failed alert send is retried at the next retry windows, this often in all.
export const MAX_ALERT_ATTEMPTS = 3;
const iso = ms => new Date(ms).toISOString();

/** Why a launch did not come up, from facts the launch path already has. */
export function describeFailedStart({ prepareError = null, launchResult } = {}) {
  if (prepareError) return `prepare: ${prepareError}`;
  if (launchResult === undefined) return 'engine did not stay up';
  if (launchResult === null) return 'launcher left no record (sudo, node or the launcher failed before running)';
  const detail = [launchResult.error_code, launchResult.error].filter(Boolean).join(' ');
  if (launchResult.state === 'launcher_failed') return `launcher ${launchResult.stage}: ${detail}`;
  if (launchResult.state === 'spawn_failed') return `engine binary: ${detail}`;
  if (launchResult.state === 'exited') {
    const how = launchResult.signal ? `signal ${launchResult.signal}` : `exit ${launchResult.exit_code}`;
    return `engine exited after ${Math.round((launchResult.ran_ms || 0) / 1000)}s (${how})`;
  }
  return 'engine started but did not stay up';
}

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
      profileId: null, // runtime profile this monitor launches (start-failure records)
      initialStartFailure: null, // the previous monitor's open start-failure episode
      inheritHold: false, // keep that episode's hold timing (no runtime switch since)
      notifyStartHeld: null, // operator alert: resolves {ok, output, permanent}
      heldRetrySec: DEFAULT_HELD_RETRY_SEC,
      ...deps,
    };
    this.notRunningCount = 0;
    this.consecutiveRestarts = 0;
    this.stableRunningSince = 0;
    this.startupGrace = 0;
    this.startAgentInProgress = false;
    this.runtimeLaunchAtMs = this.deps.initialRuntimeLaunchAtMs;
    this.lastGateLog = { reason: null, at: 0 };
    // Fable guard crash accounting (deps.onAgentStart): was the agent seen
    // running in this process since the last start, and did a wake cause it?
    this.sawRunningSinceStart = false;
    this.wokeSinceStart = false;
    // Failed-start bookkeeping. `launch` is the latest launch this process
    // issued; `startFailure` the open downtime episode, persisted through
    // agent-status.json. A restarted monitor keeps the episode; it keeps the
    // hold timing only on the same profile with no runtime switch (failover,
    // Fable guard) in between, so a move always gets a fresh attempt.
    this.launch = null;
    this.failedStarts = 0;
    this.startConfirmedAtMs = 0;
    this.alertInFlight = false;
    const prior = this.deps.initialStartFailure;
    const keepHold = this.deps.inheritHold && prior?.profile === this.deps.profileId
      && Number.isFinite(Date.parse(prior?.next_attempt_at || ''));
    this.startFailure = typeof prior?.since === 'string'
      ? { ...prior, ...(keepHold ? {} : { held_since: null, next_attempt_at: null }) }
      : null;
  }

  /** The start facts agent-status.json publishes (runtime-failover reads them). */
  startStatus() {
    return { start_failure: this.startFailure, start_confirmed_at: this.startConfirmedAtMs || null };
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
    this.sawRunningSinceStart = true;
    // An episode inherited while a session already runs (the previous monitor
    // launched it and was restarted before confirming): confirm that session.
    if (!this.launch && this.startFailure) {
      this.launch = { atMs: this.deps.nowMs(), runningSince: 0, confirmed: false, judged: false, prepareError: null };
    }
    if (this.launch && !this.launch.confirmed) {
      if (!this.launch.runningSince) this.launch.runningSince = currentTime;
      else if (currentTime - this.launch.runningSince >= START_CONFIRM_SEC) this._confirmStart();
    }

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
        this.wokeSinceStart = true;
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
    if (this.launch) this.launch.runningSince = 0;

    let attemptedRestart = false;
    const restartDelay = Math.min(
      BASE_RESTART_DELAY * Math.pow(2, this.consecutiveRestarts),
      MAX_RESTART_DELAY
    );
    if (this.notRunningCount >= restartDelay) {
      if (healthGate) {
        this._logGateThrottled(healthGate, currentTime);
      } else if (this._mayRelaunch()) {
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
      const maintenance = Boolean(getRunningMaintenance({ execSyncImpl: this.deps.execSyncImpl }));
      try {
        this.deps.onAgentStart?.({ previouslyRunning: this.sawRunningSinceStart, woke: this.wokeSinceStart, maintenance });
      } catch { /* accounting only */ }
      this.sawRunningSinceStart = false;
      this.wokeSinceStart = false;
      if (maintenance) {
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
      const launch = { atMs: this.runtimeLaunchAtMs, runningSince: 0, confirmed: false, judged: false, prepareError: null };
      this.launch = launch;

      this.deps.log(`Guardian: Starting ${this.adapter.displayName}...`);

      try {
        this.adapter.clearStaleState?.();
      } catch { }

      try {
        this.deps.resetToolLifecycleState();
      } catch { }

      const reportFailure = (err) => {
        this.deps.log(`Guardian: Failed to start ${this.adapter.displayName}: ${err.message}`);
        launch.prepareError = String(err?.message || err).split('\n')[0].slice(0, 300);
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

  // ── Failed starts (SWITCH-1) ─────────────────────────────────────────
  // Called when a relaunch is otherwise due: the latest launch did not come up,
  // so judge it once, then say whether this tick may launch again.
  _mayRelaunch() {
    if (this.launch && !this.launch.confirmed && !this.launch.judged) this._recordFailedStart();
    const failure = this.startFailure;
    if (!failure?.held_since) return true;
    const nowMs = this.deps.nowMs();
    if (nowMs < Date.parse(failure.next_attempt_at)) return false;
    failure.next_attempt_at = iso(nowMs + this.deps.heldRetrySec * 1000);
    this.deps.log(`Guardian: start held on ${this.deps.profileId || 'current profile'}; scheduled retry`);
    this._alertOnce(); // a send that failed before gets its next try here
    return true;
  }

  _recordFailedStart() {
    const launch = this.launch;
    launch.judged = true;
    this.failedStarts += 1;
    let launchResult;
    try { launchResult = this.adapter.readLaunchResult?.(); } catch { launchResult = null; }
    const cause = describeFailedStart({ prepareError: launch.prepareError, launchResult });
    const prior = this.startFailure;
    this.startFailure = {
      since: iso(launch.atMs),
      held_since: null,
      next_attempt_at: null,
      alerted_at: null,
      alert_attempts: 0,
      ...prior,
      profile: this.deps.profileId,
      attempts: (prior?.attempts || 0) + 1,
      cause,
      last_failed_at: iso(this.deps.nowMs()),
    };
    this.deps.log(`Guardian: start failed on ${this.deps.profileId || 'current profile'} `
      + `(${this.failedStarts} in a row): ${cause}`);
    // A held retry that fails stays held; a first failure is retried as is.
    if (this.startFailure.held_since || this.failedStarts < 2) return;
    this._hold();
  }

  _hold() {
    const nowMs = this.deps.nowMs();
    const failure = this.startFailure;
    failure.held_since = iso(nowMs);
    failure.next_attempt_at = iso(nowMs + this.deps.heldRetrySec * 1000);
    this.deps.log(`Guardian: start held on ${this.deps.profileId || 'current profile'}; `
      + `retrying once every ${this.deps.heldRetrySec}s`);
    this._alertOnce();
  }

  // One operator alert per episode, recorded only on a verified send. A failed
  // send is retried at the next retry window, MAX_ALERT_ATTEMPTS in all; a
  // permanent failure (no admin destination) is logged once and not retried.
  _alertOnce() {
    const failure = this.startFailure;
    if (!failure || failure.alerted_at || this.alertInFlight || !this.deps.notifyStartHeld
        || (failure.alert_attempts || 0) >= MAX_ALERT_ATTEMPTS) return;
    failure.alert_attempts = (failure.alert_attempts || 0) + 1;
    this.alertInFlight = true;
    const settle = (ok, detail, permanent) => {
      this.alertInFlight = false;
      if (this.startFailure !== failure) return; // the episode ended meanwhile
      if (ok) {
        failure.alerted_at = iso(this.deps.nowMs());
        this.deps.log('Guardian: start-held alert sent');
        return;
      }
      if (permanent) failure.alert_attempts = MAX_ALERT_ATTEMPTS;
      this.deps.log(`Guardian: start-held alert not delivered (${String(detail || 'send failed').slice(0, 200)}); `
        + (failure.alert_attempts < MAX_ALERT_ATTEMPTS ? 'retrying at the next retry window' : 'not retried'));
    };
    let sent;
    try {
      sent = Promise.resolve(this.deps.notifyStartHeld({ profile: this.deps.profileId, since: failure.since,
        attempts: failure.attempts, cause: failure.cause, retrySec: this.deps.heldRetrySec }));
    } catch (err) {
      settle(false, err?.message || err, false);
      return;
    }
    sent.then(res => settle(res?.ok === true, res?.output, res?.permanent === true),
      err => settle(false, err?.message || err, false));
  }

  _confirmStart() {
    this.launch.confirmed = true;
    this.startConfirmedAtMs = this.deps.nowMs();
    const failure = this.startFailure;
    if (failure) {
      const downSec = Math.max(0, Math.round((this.startConfirmedAtMs - Date.parse(failure.since)) / 1000));
      this.deps.log(`Guardian: start recovered on ${this.deps.profileId || 'current profile'}: down from ${failure.since} `
        + `to ${iso(this.startConfirmedAtMs)} (${downSec}s, ${failure.attempts} failed starts; last cause: ${failure.cause})`);
    }
    this.startFailure = null;
    this.failedStarts = 0;
  }
}
