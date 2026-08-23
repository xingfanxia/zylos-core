/**
 * HealthEngine - Runtime functional liveness state machine.
 *
 * v5 changes (REL-3 — flap escalation ceiling + self-driven recovery):
 *   - Kill-restart CYCLES are counted in a rolling hour window
 *     (restartCycleTimestamps); the window resets ONLY on a functional
 *     heartbeat ACK — never on onProcessRestarted, whose per-cycle counter
 *     reset kept the 2026-07-09 incident loop at "attempt 1" for 11h42m.
 *   - Above `flap_ceiling_per_hour` cycles → DEGRADED: a bounded-relaunch
 *     state (not terminal). triggerRecovery short-circuits, the guardian
 *     skips relaunch EXCEPT one probe per `degraded_probe_interval`
 *     (relaunch → recovery heartbeat → ACK exits to ok; failure kills the
 *     session and waits for the next window). deps.notifyDegraded fires an
 *     out-of-band admin alert exactly once per !degraded→degraded transition.
 *   - rate_limited cooldown expiry now fires a throttled recovery probe
 *     (`rate_limit_probe_interval` floor) so a zero-traffic instance
 *     recovers on its own instead of parking rate_limited forever.
 *
 * v4 changes (#256 — behavioral rate limit detection):
 *   - Rate limit detection moved from proactive tmux scan to heartbeat failure
 *   - deps.detectRateLimit callback: called on heartbeat failure before triggering
 *     kill+restart recovery. If rate limit detected → enter rate_limited instead.
 *   - Eliminates false positives from conversation content matching "rate limit"
 *
 * v3 changes (#233 — RATE_LIMITED state + user message triggered recovery):
 *   - New RATE_LIMITED health state: no kill+restart, waits for cooldown
 *   - enterRateLimited(cooldownUntil, resetTime): called by activity-monitor
 *     when rate-limit signals detected in tmux pane content
 *   - After cooldownUntil expires: stay rate_limited and wait for a later
 *     user-message/recovery probe to verify natural recovery
 *   - User message triggered recovery: notifyUserMessage() resets cooldown
 *     timer (5 min cooldown between triggers)
 *   - State transitions: ok/recovering → rate_limited → ok
 *
 * v2 changes (#177 — exponential backoff + process signal acceleration):
 *   - Exponential backoff: min(3600, 60 × 5^(n-1)) → 1m, 5m, 25m, 60m cap
 *   - No maxRestartFailures limit in unavailable/recovering — but v5's flap
 *     ceiling bounds kill-restart cycles per rolling hour (→ degraded)
 *   - Legacy DOWN state remains readable for transitional persisted status.
 *   - Process signal acceleration: when agentRunning transitions false→true,
 *     wait a grace period then immediately verify via heartbeat (skip backoff)
 *
 * All external side-effects (C4 control, file I/O, tmux) are injected via
 * the `deps` object so the class can be tested in isolation.
 */

const USER_MESSAGE_CHECK_DELAY_MS = 5000;
const CONSECUTIVE_HITS_THRESHOLD = 2;
const STICKY_ERROR_MIN_INTERVAL_MS = 30000;
// Rolling window for the flap-escalation ceiling. Cycles are counted per hour;
// only the ceiling itself is configurable (flap_ceiling_per_hour).
const FLAP_WINDOW_SEC = 3600;

function isUnavailableRecoveryState(health) {
  return health === 'unavailable' || health === 'recovering';
}

function isPostRestartProbeState(health) {
  return isUnavailableRecoveryState(health) || health === 'down' || health === 'auth_failed';
}

function isPublicUnavailableState(health) {
  return isUnavailableRecoveryState(health) || health === 'down';
}

export class HealthEngine {
  /**
   * @param {object} deps - Injected dependencies
   * @param {(phase: string) => boolean} deps.enqueueHeartbeat
   * @param {(controlId: number) => string} deps.getHeartbeatStatus
   * @param {() => object|null} deps.readHeartbeatPending
   * @param {() => void} deps.clearHeartbeatPending
   * @param {() => void} deps.killTmuxSession
   * @param {(message: string) => void} deps.log
   * @param {() => {detected: boolean, cooldownUntil?: number, resetTime?: string}} [deps.detectRateLimit]
   * @param {() => {detected: boolean, pattern?: string}} [deps.detectAuthFailure]
   * @param {() => {detected: boolean, pattern?: string}} [deps.detectApiError]
   * @param {() => Promise<{status: 'success'|'failure'|'uncertain', reason?: string}>|{status: 'success'|'failure'|'uncertain', reason?: string}} [deps.checkAuth]
   * @param {(details: {cycleCount: number, windowSec: number, ceiling: number, probeIntervalSec: number, reason: string}) => void} [deps.notifyDegraded] - Out-of-band admin alert, fired exactly once per !degraded→degraded transition
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   * @param {object} [options]
   * @param {number} [options.heartbeatInterval=1800]
   * @param {number} [options.downDegradeThreshold=3600] - Seconds of continuous failure before entering DOWN
   * @param {number} [options.downRetryInterval=3600] - Seconds between DOWN-state probes
   * @param {number} [options.signalGracePeriod=30] - Seconds to wait after agentRunning transitions before probing
   * @param {number} [options.rateLimitDefaultCooldown=3600] - Default cooldown when reset time can't be parsed
   * @param {number} [options.userMessageRecoveryCooldown=60] - Min seconds between user-message-triggered recoveries
   * @param {number} [options.flapCeilingPerHour=6] - Kill-restart cycles per rolling hour before entering degraded
   * @param {number} [options.degradedProbeInterval=1200] - Seconds between bounded self-probes while degraded
   * @param {number} [options.rateLimitProbeInterval=900] - Min seconds between rate-limit cooldown-expiry probes
   * @param {string} [options.initialHealth='ok']
   * @param {boolean} [options.heartbeatEnabled=true]
   * @param {number} [options.maintenanceIntervalMs=1000]
   * @param {number} [options.postRestartProbeDelayMs=5000]
   * @param {number} [options.userMessageCheckDelayMs=5000]
   * @param {() => number} [options.now]
   */
  constructor(deps, options = {}) {
    this.deps = deps;
    this.heartbeatInterval = options.heartbeatInterval ?? 1800;
    this.downDegradeThreshold = options.downDegradeThreshold ?? 3600; // 1 hour
    this.downRetryInterval = options.downRetryInterval ?? 3600; // 1 hour
    this.signalGracePeriod = options.signalGracePeriod ?? 30;
    this.rateLimitDefaultCooldown = options.rateLimitDefaultCooldown ?? 3600; // 1 hour
    this.userMessageRecoveryCooldown = options.userMessageRecoveryCooldown ?? 60; // 1 min
    this.flapCeilingPerHour = options.flapCeilingPerHour ?? 6;
    this.degradedProbeInterval = options.degradedProbeInterval ?? 1200; // 20 min
    this.rateLimitProbeInterval = options.rateLimitProbeInterval ?? 900; // 15 min
    this.heartbeatEnabled = options.heartbeatEnabled ?? true;
    this.userMessageCheckDelayMs = options.userMessageCheckDelayMs ?? USER_MESSAGE_CHECK_DELAY_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1000;
    this.postRestartProbeDelayMs = options.postRestartProbeDelayMs ?? USER_MESSAGE_CHECK_DELAY_MS;
    this.now = options.now ?? (() => Date.now());

    // Internal state
    this.healthState = options.initialHealth ?? 'ok';
    this.healthReason = options.initialReason ?? '';
    this.restartFailureCount = 0;
    this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    this.lastRecoveryAt = 0;
    this.lastDownCheckAt = 0;
    // If resuming in recovering state (e.g., PM2 restart mid-recovery),
    // initialize recoveringStartedAt so DOWN degradation timer works correctly.
    this.recoveringStartedAt = isUnavailableRecoveryState(this.healthState) ? Math.floor(Date.now() / 1000) : 0;
    this.unavailableSince = isPublicUnavailableState(this.healthState) ? Math.floor(Date.now() / 1000) : 0;

    // Process signal acceleration state
    this.agentRunning = false;
    this.lastAgentRunning = null; // null = unknown (first tick)
    this.signalDetectedAt = 0; // When agentRunning transitioned false→true

    // Rate-limited state
    this.cooldownUntil = 0; // Epoch seconds when rate limit cooldown expires
    this.rateLimitResetTime = ''; // Human-readable reset time for display
    this.lastUserMessageRecoveryAt = 0; // Last time user message triggered early recovery
    this.cooldownTimer = null;
    this.postRestartProbeTimer = null;
    this.maintenanceTimer = null;

    // API error detection throttle
    this._lastApiErrorScanAt = 0; // Last time tmux pane was scanned for API errors

    // Flap escalation: kill-restart cycle timestamps (epoch sec) in the rolling
    // hour window. Incremented in triggerRecovery; reset ONLY by a functional
    // heartbeat ACK (onHeartbeatSuccess) — never by onProcessRestarted, whose
    // per-cycle reset was the 11h42m "attempt 1" incident bug.
    this.restartCycleTimestamps = [];
    // Last time a degraded probe window was consumed (guardian relaunch). 0 ⇒ due.
    this.lastDegradedProbeAt = 0;
    // In-flight rate-limit cooldown-expiry probe (re-entrancy guard across the
    // maintenance interval, the cooldownTimer callback, and am.sock callbacks).
    this._expiryProbeInFlight = false;

    // In-flight async verify of a text-triggered auth_failed entry (tests await it)
    this._authVerifyPromise = null;

    // Cold-start grace period: skip heartbeat processing during warmup (fork)
    this.warmupUntil = 0;

    // OK-path detection debounce counters, advanced by dispatcher delivery notifications.
    this.rateLimitConsecutiveHits = 0;
    this.stickyErrorConsecutiveHits = 0;
    this.lastStickyErrorHitAt = 0;
  }

  get health() {
    return this.healthState;
  }

  start() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      try {
        this.runMaintenanceCycle(this.agentRunning, Math.floor(this.now() / 1000));
      } catch (err) {
        this.deps.log(`HealthEngine maintenance error: ${err?.message || err}`);
      }
    }, this.maintenanceIntervalMs);
    if (typeof this.maintenanceTimer.unref === 'function') {
      this.maintenanceTimer.unref();
    }
  }

  stop() {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this._clearRateLimitCooldownTimer();
    this._clearPostRestartProbeTimer();
  }

  destroy() {
    this.stop();
  }

  setAgentRunning(agentRunning, currentTime = Math.floor(this.now() / 1000)) {
    this.agentRunning = Boolean(agentRunning);
    this._trackAgentRunning(this.agentRunning, currentTime);
  }

  setHealth(nextHealth, reason = '') {
    if (this.healthState === nextHealth) {
      if (reason && nextHealth !== 'ok') this.healthReason = reason;
      if (isPublicUnavailableState(nextHealth) && this.unavailableSince === 0) {
        this.unavailableSince = Math.floor(Date.now() / 1000);
      }
      return;
    }
    const suffix = reason ? ` (${reason})` : '';
    const prevHealth = this.healthState;
    this.deps.log(`Health: ${this.healthState.toUpperCase()} -> ${nextHealth.toUpperCase()}${suffix}`);
    this.healthState = nextHealth;
    this.healthReason = nextHealth === 'ok' ? '' : (reason || '');
    if (isPublicUnavailableState(nextHealth)) {
      if (!isPublicUnavailableState(prevHealth) || this.unavailableSince === 0) {
        this.unavailableSince = Math.floor(Date.now() / 1000);
      }
    } else {
      this.unavailableSince = 0;
    }
    if (prevHealth === 'rate_limited' && nextHealth !== 'rate_limited') {
      this._clearRateLimitCooldownTimer();
    }
    if (nextHealth === 'ok' || nextHealth === 'rate_limited') {
      this._clearPostRestartProbeTimer();
    }
  }

  /**
   * Signal that a cold start is in progress. Suppresses heartbeat processing
   * for `seconds` to avoid false-positive failures during instance startup.
   * Also resets health to 'ok' so the instance starts clean.
   * @param {number} seconds - Grace period duration
   */
  notifyColdStart(seconds) {
    this.warmupUntil = Math.floor(Date.now() / 1000) + seconds;
    this.setHealth('ok', `cold_start_grace_${seconds}s`);
    this.deps.log(`Cold start: suppressing heartbeat for ${seconds}s`);
  }

  /**
   * Calculate exponential backoff delay for the current failure count.
   * Formula: min(3600, 60 × 5^(n-1)) where n = restartFailureCount
   * Sequence: 60s, 300s, 1500s, 3600s, 3600s, ...
   */
  getBackoffDelay() {
    if (this.restartFailureCount <= 0) return 0;
    return Math.min(3600, 60 * Math.pow(5, this.restartFailureCount - 1));
  }

  /**
   * Enter RATE_LIMITED state. Called by activity-monitor when rate-limit
   * signals are detected in tmux pane content.
   *
   * @param {number} cooldownUntil - Epoch seconds when cooldown expires
   * @param {string} [resetTime] - Human-readable reset time for display
   */
  enterRateLimited(cooldownUntil, resetTime = '') {
    if (this.healthState === 'rate_limited') {
      // Already rate-limited; update cooldown if the new one is later
      if (cooldownUntil > this.cooldownUntil) {
        this.cooldownUntil = cooldownUntil;
        this.rateLimitResetTime = resetTime || this.rateLimitResetTime;
        this.deps.log(`Rate limit cooldown extended to ${cooldownUntil} (${resetTime || 'unknown'})`);
        this._scheduleRateLimitCooldown();
      }
      return;
    }

    this.cooldownUntil = cooldownUntil;
    this.rateLimitResetTime = resetTime;
    this.restartFailureCount = 0;
    this.recoveringStartedAt = 0;
    this.signalDetectedAt = 0;
    this.setHealth('rate_limited', resetTime ? `resets at ${resetTime}` : `cooldown ${cooldownUntil - Math.floor(Date.now() / 1000)}s`);
    this._scheduleRateLimitCooldown();
  }

  /**
   * Notify that a user message was received while service is unavailable.
   * Triggers or accelerates recovery depending on current health state.
   *
   * - rate_limited: clears cooldown for immediate recovery check
   * - unavailable/recovering: resets backoff to retry immediately
   * - down: triggers immediate probe (skips downRetryInterval wait)
   *
   * Returns true if recovery was triggered/accelerated, false if on cooldown or healthy.
   */
  notifyUserMessage(currentTime) {
    if (this.healthState === 'ok') return false;

    if ((currentTime - this.lastUserMessageRecoveryAt) < this.userMessageRecoveryCooldown) {
      const remaining = this.userMessageRecoveryCooldown - (currentTime - this.lastUserMessageRecoveryAt);
      this.deps.log(`User message recovery on cooldown (${remaining}s remaining)`);
      return false;
    }

    this.lastUserMessageRecoveryAt = currentTime;

    if (this.healthState === 'auth_failed') {
      this.deps.log('User message received during auth failure — triggering immediate retry');
      return true;
    }

    if (this.healthState === 'degraded') {
      // Mirror the rate_limited path: user contact opens the degraded probe
      // window immediately (guardian relaunches next tick) and the router
      // fires a recovery probe.
      this.deps.log('User message received while degraded — self-probe now due');
      this.lastDegradedProbeAt = 0;
      return true;
    }

    if (this.healthState === 'rate_limited') {
      this.deps.log('User message triggered rate-limit recovery attempt');
      this.cooldownUntil = 0;
      this._clearRateLimitCooldownTimer();
      return true;
    }

    if (isUnavailableRecoveryState(this.healthState)) {
      this.deps.log('User message triggered recovery acceleration (backoff reset)');
      this.restartFailureCount = 0;
      this.lastRecoveryAt = 0;
      return true;
    }

    if (this.healthState === 'down') {
      this.deps.log('User message triggered immediate down-state probe');
      this.lastDownCheckAt = 0;
      return true;
    }

    return false;
  }

  runMaintenanceCycle(agentRunning, currentTime) {
    // Fork: skip processing during cold-start grace period
    if (currentTime < this.warmupUntil) return;

    // Track agentRunning transitions for process signal acceleration
    this._trackAgentRunning(agentRunning, currentTime);

    const pending = this.deps.readHeartbeatPending();

    if (pending) {
      const status = this.deps.getHeartbeatStatus(pending.control_id);

      // Guard against stuck pending: if created_at is too old, treat as timeout
      const pendingAge = currentTime - (pending.created_at || 0);
      const maxPendingAge = 600; // 10 min absolute ceiling
      if ((status === 'pending' || status === 'running' || status === 'error') && pendingAge < maxPendingAge) {
        // API error fast-detection: when a heartbeat has been pending for >30s,
        // periodically scan the tmux pane for fatal API errors (e.g. 400 from
        // corrupted image). Triggers immediate recovery instead of waiting for
        // the full ack_deadline timeout (120s). Scans at most once per 15s.
        if (pendingAge > 30 && this.deps.detectApiError
            && (currentTime - this._lastApiErrorScanAt) >= 15) {
          this._lastApiErrorScanAt = currentTime;
          const apiError = this.deps.detectApiError();
          if (apiError.detected) {
            this.deps.log(`API error detected in tmux pane: ${apiError.pattern}. Triggering immediate recovery.`);
            this.onHeartbeatFailure(pending, 'api_error');
            return;
          }
        }
        return;
      }
      if (pendingAge >= maxPendingAge && status !== 'done') {
        this.deps.log(`Heartbeat pending too long (${pendingAge}s, status=${status}), treating as timeout`);
        this.onHeartbeatFailure(pending, 'stale_pending');
        return;
      }

      if (status === 'done') {
        this.onHeartbeatSuccess(pending.phase || 'unknown');
        return;
      }

      if (status === 'failed' || status === 'timeout' || status === 'not_found') {
        this.onHeartbeatFailure(pending, status);
        return;
      }

      this.deps.log(`Heartbeat unexpected status: ${status}`);
      this.onHeartbeatFailure(pending, `unexpected_${status}`);
      return;
    }

    // Rate-limited recovery: when cooldown expires, stop waiting but do not
    // restart the runtime. Rate limit is an upstream condition; expiry fires
    // a throttled recovery probe so an instance with zero user traffic still
    // verifies recovery on its own (the parked-forever incident gap).
    if (this.healthState === 'rate_limited') {
      if (this.cooldownUntil > 0 && currentTime < this.cooldownUntil) {
        return;
      }
      if (this.cooldownUntil > 0) {
        this._expireRateLimitCooldown();
      }
      // Cooldown expired: probe on the rate_limit_probe_interval floor while
      // the agent is running (a still-limited probe re-extends the cooldown
      // via the detectRateLimit re-check in onHeartbeatFailure).
      if (agentRunning) {
        this._maybeRunRateLimitExpiryProbe(currentTime);
      }
      return;
    }

    // Degraded is a bounded-relaunch state. The probe driver depends on how
    // degraded was entered (pending heartbeat results are processed above, so
    // an ACK exits degraded either way):
    //  - session still ALIVE (the ceiling trips BEFORE a kill — the dominant
    //    login-screen-park entry): probe it directly here once per
    //    degraded_probe_interval. An ACK exits degraded with zero SessionStart
    //    burn; an ack-deadline failure kills once (onHeartbeatFailure's
    //    degraded branch) and converges to
    //  - session DEAD: the guardian's probe-window relaunch → post-restart probe.
    if (this.healthState === 'degraded') {
      if (agentRunning && this.isDegradedProbeDue(currentTime)) {
        this.lastDegradedProbeAt = currentTime; // consume this probe window
        const ok = this.enqueueHeartbeat('recovery');
        this.deps.log(ok
          ? `Degraded self-probe: session alive, probing directly (next window in ${this.degradedProbeInterval}s)`
          : 'Degraded self-probe enqueue failed; retrying next window');
      }
      return;
    }

    if (!agentRunning) {
      return;
    }

    // Process signal acceleration: agentRunning just transitioned false→true,
    // grace period elapsed — send immediate heartbeat to verify recovery.
    // Works in unavailable/recovering, down, and auth_failed states.
    if (isPostRestartProbeState(this.healthState) && this._shouldAccelerate(currentTime)) {
      this.deps.log(`Process signal acceleration: Agent restarted (health=${this.healthState}), verifying immediately`);
      this.signalDetectedAt = 0; // Consume the signal
      const ok = this.enqueueHeartbeat('post_restart');
      if (!ok) {
        this.lastRecoveryAt = Math.floor(Date.now() / 1000);
      }
      if (ok && this.healthState === 'down') {
        this.lastDownCheckAt = currentTime;
      }
      return;
    }

    if (isUnavailableRecoveryState(this.healthState)) {
      // Exponential backoff: wait progressively longer between recovery attempts
      const backoffDelay = this.getBackoffDelay();
      if (backoffDelay > 0 && (currentTime - this.lastRecoveryAt) < backoffDelay) {
        return;
      }
      const ok = this.enqueueHeartbeat('recovery');
      if (!ok) {
        // Prevent retry storm: treat failed enqueue as if we just tried
        this.lastRecoveryAt = Math.floor(Date.now() / 1000);
      }
      return;
    }

    if (this.healthState === 'down') {
      // Periodic retry: check every downRetryInterval instead of every tick
      if ((currentTime - this.lastDownCheckAt) < this.downRetryInterval) {
        return;
      }
      const ok = this.enqueueHeartbeat('down-check');
      if (ok) {
        this.lastDownCheckAt = currentTime;
      }
      return;
    }

    // heartbeatEnabled only gates primary periodic polling — all other paths
    // (pending result processing, rate_limited recovery, signal acceleration,
    // recovering backoff, down-check) remain active regardless of this flag.
    if (!this.heartbeatEnabled) return;

    if ((currentTime - this.lastHeartbeatAt) >= this.heartbeatInterval) {
      this.enqueueHeartbeat('primary');
    }
  }

  processHeartbeat(agentRunning, currentTime) {
    return this.runMaintenanceCycle(agentRunning, currentTime);
  }

  onHeartbeatSuccess(phase) {
    this.deps.clearHeartbeatPending();
    this.restartFailureCount = 0;
    this.recoveringStartedAt = 0;
    this.signalDetectedAt = 0;
    this.cooldownUntil = 0;
    this.rateLimitResetTime = '';
    // Functional ACK is the ONLY reset for the flap-cycle window.
    this.restartCycleTimestamps = [];
    this.lastDegradedProbeAt = 0;
    this._clearRateLimitCooldownTimer();
    this._clearPostRestartProbeTimer();
    this.lastUserMessageRecoveryAt = 0;
    if (this.healthState !== 'ok') {
      this.setHealth('ok', `heartbeat_ack phase=${phase}`);
    }
    if (phase !== 'primary') {
      this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    }
  }

  triggerRecovery(reason) {
    if (this.healthState === 'down') {
      this.deps.log(`Heartbeat recovery skipped in DOWN state (${reason})`);
      return;
    }

    if (this.healthState === 'rate_limited') {
      this.deps.log(`Heartbeat recovery skipped in RATE_LIMITED state (${reason})`);
      return;
    }

    // auth_failed is an upstream credential condition, same class as
    // rate_limited: killing and restarting the session cannot fix it and just
    // thrashes the pane. Recovery paths out of auth_failed: heartbeat ACK once
    // credentials are restored (heartbeats bypass the health gate), the
    // user-message-triggered probe (notifyUserMessage → runRecoveryProbe), the
    // post-restart probe, and _verifyAuthFailedEntry's false-positive escape
    // (live checkAuth OK → hang → restart) on each failed heartbeat.
    if (this.healthState === 'auth_failed') {
      this.deps.log(`Heartbeat recovery skipped in AUTH_FAILED state (${reason})`);
      return;
    }

    // Degraded short-circuits the kill loop entirely; recovery happens only
    // through the bounded probe window (see isDegradedProbeDue) or an ACK.
    if (this.healthState === 'degraded') {
      this.deps.log(`Heartbeat recovery skipped in DEGRADED state (${reason})`);
      return;
    }

    const now = Math.floor(this.now() / 1000);

    // Flap escalation ceiling: count kill-restart CYCLES in a rolling hour.
    this.restartCycleTimestamps.push(now);
    this._pruneRestartCycles(now);
    if (this.restartCycleTimestamps.length > this.flapCeilingPerHour) {
      this._enterDegraded(now, reason);
      return;
    }

    if (this.healthState === 'ok') {
      this.setHealth('unavailable', reason);
      this.recoveringStartedAt = now;
    }

    this.restartFailureCount += 1;
    this.lastRecoveryAt = now;
    this.deps.log(`Heartbeat recovery attempt ${this.restartFailureCount} (${reason}), next backoff ${this.getBackoffDelay()}s`);
    this.deps.killTmuxSession();

    // Legacy DOWN is still accepted when restored from persisted state, but new
    // AM v3 recovery paths stay in public unavailable and expose duration via reason.
    const failureDuration = now - this.recoveringStartedAt;
    if (this.recoveringStartedAt > 0 && failureDuration >= this.downDegradeThreshold) {
      this.setHealth('unavailable', `continuous_failure_for_${failureDuration}s`);
    }
  }

  onHeartbeatFailure(pending, status) {
    const phase = pending.phase || 'primary';
    const now = Math.floor(Date.now() / 1000);
    this.deps.clearHeartbeatPending();

    // Before triggering kill+restart recovery, check if the failure is due to
    // a rate limit. This is the "behavioral + text" dual-signal approach:
    // heartbeat failed (behavioral) AND tmux shows rate limit text (text signal).
    // Only checked in states where a heartbeat failure may otherwise change health.
    if ((this.healthState === 'ok' || isUnavailableRecoveryState(this.healthState) || this.healthState === 'rate_limited') && this.deps.detectRateLimit) {
      const rateLimit = this.deps.detectRateLimit();
      if (rateLimit.detected) {
        this.enterRateLimited(rateLimit.cooldownUntil, rateLimit.resetTime);
        return;
      }
    }

    // Same dual-signal for auth failures: a heartbeat timing out because the
    // session sits on a login screen used to be misclassified as 'unavailable'
    // and entered an endless kill+restart loop (each restart lands on the same
    // login screen). Behavioral signal = this heartbeat failure; text signal =
    // auth-failure pane text. Enter auth_failed instead of killing.
    // Pane text alone can false-positive (a genuinely HUNG agent whose pane
    // echoes "not logged in" from tool output would otherwise be parked in
    // auth_failed forever, since a hung agent never ACKs), so the flip is
    // verified asynchronously with the adapter's live checkAuth() — a
    // confirmed-good credential means this was a hang: resume kill+restart.
    // (Intentionally NOT checked in rate_limited: the rate-limit branch above
    // takes precedence there.)
    if ((this.healthState === 'ok' || isUnavailableRecoveryState(this.healthState)) && this.deps.detectAuthFailure) {
      const authFailure = this.deps.detectAuthFailure();
      if (authFailure.detected) {
        this.restartFailureCount = 0;
        this.recoveringStartedAt = 0;
        this.signalDetectedAt = 0;
        this.setHealth('auth_failed', `${phase}_${status}:${authFailure.pattern || 'auth_text'}`);
        this._authVerifyPromise = this._verifyAuthFailedEntry(`${phase}_${status}`);
        return;
      }
    }

    // Already auth_failed and another heartbeat failed: re-verify. This is the
    // bounded escape for a hung-agent false positive whose first verify came
    // back 'uncertain' (network flake) — every subsequent failed heartbeat
    // re-runs the live probe until it resolves to broken creds (stay) or good
    // creds (hang → restart).
    if (this.healthState === 'auth_failed') {
      this._authVerifyPromise = this._verifyAuthFailedEntry(`${phase}_${status}`);
      return;
    }

    // Degraded self-probe failed its ack deadline: kill the (non-ACKing)
    // session so it doesn't burn quota, stay degraded, and wait for the next
    // probe window. Kill directly — triggerRecovery is short-circuited here
    // and must not count this as a new flap cycle.
    if (this.healthState === 'degraded') {
      this.deps.log(`Degraded self-probe failed (${phase}_${status}); killing session until next probe window`);
      this.deps.killTmuxSession();
      return;
    }

    if (this.healthState === 'rate_limited') {
      this.restartFailureCount += 1;
      this.lastRecoveryAt = now;
      this.setHealth('unavailable', `${phase}_${status}`);
      this.deps.log(`Rate limit recovery failed without active rate-limit signal (${status}); transitioning to unavailable`);
      return;
    }

    // In ok state, any failure triggers recovery directly (no verify phase).
    // The verify phase was removed in v2 — stuck detection provides the
    // corroborating signal that verify used to offer.
    if (this.healthState === 'ok') {
      this.triggerRecovery(`${phase}_${status}`);
      return;
    }

    if (isUnavailableRecoveryState(this.healthState)) {
      this.triggerRecovery(`recovery_${status}`);
      return;
    }

    if (this.healthState === 'down') {
      this.deps.log(`Heartbeat failed in DOWN state (${status}); still probing periodically`);
      return;
    }

    this.triggerRecovery(`heartbeat_${status}`);
  }

  /**
   * Event-driven OK-path health detection. Called asynchronously after the C4
   * dispatcher successfully delivers a user message to the runtime.
   */
  async onUserMessageDelivered() {
    if (this.healthState !== 'ok') return;

    if (this.userMessageCheckDelayMs > 0) {
      await this._sleep(this.userMessageCheckDelayMs);
    }
    if (this.healthState !== 'ok') return;

    const rateLimit = this.deps.detectRateLimit ? this.deps.detectRateLimit() : { detected: false };
    if (rateLimit.detected) {
      this.rateLimitConsecutiveHits += 1;
      this.stickyErrorConsecutiveHits = 0;
      this.lastStickyErrorHitAt = 0;
      if (this.rateLimitConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
        this.rateLimitConsecutiveHits = 0;
        const nowSec = Math.floor(this.now() / 1000);
        this.enterRateLimited(rateLimit.cooldownUntil || nowSec + this.rateLimitDefaultCooldown, rateLimit.resetTime || '');
      }
      return;
    }

    const authFailure = this.deps.detectAuthFailure ? this.deps.detectAuthFailure() : { detected: false };
    if (authFailure.detected) {
      const authResult = await this._checkAuth({ requireRemote: true });
      if (authResult && authResult.status === 'failure') {
        this.rateLimitConsecutiveHits = 0;
        this.stickyErrorConsecutiveHits = 0;
        this.lastStickyErrorHitAt = 0;
        this.setHealth('auth_failed', authResult.reason || 'auth_check_failed');
      } else {
        this.rateLimitConsecutiveHits = 0;
        this.stickyErrorConsecutiveHits = 0;
        this.lastStickyErrorHitAt = 0;
      }
      return;
    }

    const stickyError = this.deps.detectApiError ? this.deps.detectApiError() : { detected: false };
    if (stickyError.detected) {
      this.stickyErrorConsecutiveHits += 1;
      this.rateLimitConsecutiveHits = 0;
      if (this.stickyErrorConsecutiveHits === 1) {
        this.lastStickyErrorHitAt = this.now();
      }
      if (this.stickyErrorConsecutiveHits >= CONSECUTIVE_HITS_THRESHOLD) {
        if ((this.now() - this.lastStickyErrorHitAt) < STICKY_ERROR_MIN_INTERVAL_MS) {
          return;
        }
        this.stickyErrorConsecutiveHits = 0;
        this.lastStickyErrorHitAt = 0;
        this.deps.log(`sticky error 2x: ${stickyError.pattern || 'unknown'}, killing session`);
        this.setHealth('unavailable', 'sticky_context_restart');
        this.deps.killTmuxSession();
      }
      return;
    }

    this.rateLimitConsecutiveHits = 0;
    this.stickyErrorConsecutiveHits = 0;
    this.lastStickyErrorHitAt = 0;
  }

  /** Wrapper that updates lastHeartbeatAt on successful primary enqueue. */
  enqueueHeartbeat(phase) {
    const ok = this.deps.enqueueHeartbeat(phase);
    if (ok && phase === 'primary') {
      this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    }
    return ok;
  }

  async runRecoveryProbe({ phase = 'recovery', timeoutMs = 25000, pollIntervalMs = 1000 } = {}) {
    if (this.healthState === 'ok') {
      return { recovered: true };
    }

    this.lastRecoveryAt = Math.floor(this.now() / 1000);

    if (this.healthState === 'auth_failed') {
      const authResult = await this._checkAuth({ requireRemote: true });
      if (authResult.status === 'success') {
        const now = Math.floor(Date.now() / 1000);
        this.deps.log('Auth probe recovered; restarting session before marking healthy');
        this.restartFailureCount = 0;
        this.lastRecoveryAt = now;
        this.recoveringStartedAt = now;
        this.setHealth('unavailable', 'auth_recovered_restart');
        this.deps.killTmuxSession();
        return { recovered: false, health: 'unavailable', restartTriggered: true };
      }
      const reason = authResult.reason || 'auth_still_failed';
      this.setHealth('auth_failed', reason);
      return { recovered: false, health: 'auth_failed', reason };
    }

    let pending = this.deps.readHeartbeatPending();
    if (!pending) {
      const ok = this.enqueueHeartbeat(phase);
      if (!ok) {
        return { recovered: false, reason: this.healthReason || this.healthState, enqueueFailed: true };
      }
      pending = this.deps.readHeartbeatPending();
    }

    if (!pending) {
      return { recovered: false, reason: this.healthReason || this.healthState, pendingMissing: true };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = this.deps.getHeartbeatStatus(pending.control_id);
      if (status === 'done') {
        this.onHeartbeatSuccess(pending.phase || 'recovery');
        return { recovered: true };
      }
      if (status === 'failed' || status === 'timeout' || status === 'not_found') {
        this.onHeartbeatFailure(pending, status);
        return { recovered: false, reason: this.healthReason || status, status };
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return { recovered: false, reason: this.healthReason || this.healthState, timedOut: true };
  }

  onProcessRestarted(currentTime = Math.floor(this.now() / 1000)) {
    // Counter/backoff reset is gated on flap context: during a flap the
    // guardian restarts the runtime EVERY cycle, and resetting here is what
    // kept the incident loop at "attempt 1" for 11h42m. Counters reset only
    // on a functional heartbeat ACK (onHeartbeatSuccess); a restart with no
    // recent kill cycles is a genuine fresh start and keeps the old behavior.
    this._pruneRestartCycles(currentTime);
    if (this.restartCycleTimestamps.length === 0) {
      this.restartFailureCount = 0;
      this.lastRecoveryAt = 0;
      this.deps.log('Process restarted, recovery backoff reset');
    } else {
      this.deps.log(`Process restarted mid-flap (${this.restartCycleTimestamps.length} cycles in window); keeping recovery backoff`);
    }

    if (this.healthState === 'degraded') {
      // The guardian relaunch consumed this degraded probe window.
      this.lastDegradedProbeAt = currentTime;
    }

    // Recovery acceleration must survive the split: the post-restart probe
    // always fires on a restart in non-ok health.
    if (this.healthState !== 'ok') {
      this.signalDetectedAt = currentTime;
      this._schedulePostRestartProbe();
    }
  }

  /**
   * True when the guardian may run one bounded degraded-relaunch probe.
   * Read live by the orchestrator each tick and passed into guardian.tick().
   */
  isDegradedProbeDue(currentTime = Math.floor(this.now() / 1000)) {
    if (this.healthState !== 'degraded') return false;
    return (currentTime - this.lastDegradedProbeAt) >= this.degradedProbeInterval;
  }

  _pruneRestartCycles(nowSec) {
    const cutoff = nowSec - FLAP_WINDOW_SEC;
    this.restartCycleTimestamps = this.restartCycleTimestamps.filter(ts => ts >= cutoff);
  }

  _enterDegraded(nowSec, reason) {
    const cycleCount = this.restartCycleTimestamps.length;
    this.lastDegradedProbeAt = nowSec; // first self-probe waits one full interval
    this.signalDetectedAt = 0;
    this._clearPostRestartProbeTimer(); // bound burn: probes only via the probe window
    this.setHealth('degraded', `flap_ceiling_${cycleCount}cyc_1h (${reason})`);
    this.deps.log(`Flap ceiling: ${cycleCount} kill-restart cycles in the last hour (ceiling ${this.flapCeilingPerHour}); entering degraded, self-probe every ${this.degradedProbeInterval}s`);
    // Alert fires exactly here — the only !degraded→degraded transition point
    // (triggerRecovery short-circuits while degraded, so no re-entry).
    if (typeof this.deps.notifyDegraded === 'function') {
      try {
        this.deps.notifyDegraded({
          cycleCount,
          windowSec: FLAP_WINDOW_SEC,
          ceiling: this.flapCeilingPerHour,
          probeIntervalSec: this.degradedProbeInterval,
          reason,
        });
      } catch (err) {
        this.deps.log(`Degraded admin alert failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * Track agentRunning state transitions for process signal acceleration.
   * When agentRunning goes false→true while unavailable/recovering, record the timestamp
   * so we can send an accelerated probe after the grace period.
   */
  _trackAgentRunning(agentRunning, currentTime) {
    const prev = this.lastAgentRunning;
    this.lastAgentRunning = agentRunning;

    // Detect false→true transition (skip null→true on first tick)
    if (prev === false && agentRunning === true && isPostRestartProbeState(this.healthState)) {
      this.signalDetectedAt = currentTime;
      this.deps.log(`Process signal: agentRunning false→true, grace period ${this.signalGracePeriod}s`);
    }
  }

  /**
   * Check if process signal acceleration should fire.
   * Returns true when a signal was detected and the grace period has elapsed.
   */
  _shouldAccelerate(currentTime) {
    if (this.signalDetectedAt === 0) return false;
    return (currentTime - this.signalDetectedAt) >= this.signalGracePeriod;
  }

  _sleep(ms) {
    if (typeof this.deps.sleep === 'function') return this.deps.sleep(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _checkAuth(options) {
    if (typeof this.deps.checkAuth !== 'function') return { status: 'success', reason: 'no_checkAuth' };
    try {
      return await this.deps.checkAuth(options);
    } catch (err) {
      return { status: 'failure', reason: err?.message || 'auth_check_failed' };
    }
  }

  /**
   * Verify a text-triggered auth_failed entry with the adapter's live checkAuth
   * probe. Pane text alone can false-positive on a genuinely HUNG agent whose
   * pane merely echoes auth-ish output ("gh auth status", curled API bodies) —
   * and a hung agent never ACKs, so without this it would be parked in
   * auth_failed forever. checkAuth 'success' = credentials are fine, the
   * heartbeat failure was a real hang → resume normal kill+restart recovery.
   * 'failure' confirms auth_failed. 'uncertain' stays put — every subsequent
   * failed heartbeat re-runs this verify, and a live agent heals via ACK.
   */
  async _verifyAuthFailedEntry(reason) {
    const result = await this._checkAuth({ requireRemote: true });
    if (this.healthState !== 'auth_failed') return; // recovered (ACK) or moved on meanwhile
    if (result?.status === 'success') {
      this.deps.log(`auth_failed was a text false positive (live checkAuth OK) — treating as hung session (${reason})`);
      this.setHealth('unavailable', `${reason}:auth_text_false_positive`);
      // Mirror triggerRecovery's from-ok bookkeeping: start the continuous-
      // failure clock (it only sets this when transitioning from 'ok').
      this.recoveringStartedAt = Math.floor(this.now() / 1000);
      this.triggerRecovery(`${reason}:hung_with_auth_text`);
    }
  }

  _scheduleRateLimitCooldown() {
    this._clearRateLimitCooldownTimer();
    if (this.healthState !== 'rate_limited' || this.cooldownUntil <= 0) return;

    const delayMs = Math.max(0, (this.cooldownUntil * 1000) - this.now());
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this._expireRateLimitCooldown();
    }, delayMs);
    if (typeof this.cooldownTimer.unref === 'function') {
      this.cooldownTimer.unref();
    }
  }

  _clearRateLimitCooldownTimer() {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  _expireRateLimitCooldown() {
    if (this.healthState !== 'rate_limited') return;
    this.deps.log('Rate limit cooldown expired; probing to verify recovery');
    this.cooldownUntil = 0;
    this._clearRateLimitCooldownTimer();
    // The probe itself fires from the maintenance cycle (≤1s later) so it is
    // gated on agentRunning — heartbeats to a dead session only time out.
  }

  /**
   * Self-driven rate-limit recovery: one throttled recovery probe after the
   * cooldown expires, floored by rate_limit_probe_interval via lastRecoveryAt.
   * A still-limited probe re-extends the cooldown through the existing
   * detectRateLimit re-check in onHeartbeatFailure — no re-implementation here.
   */
  _maybeRunRateLimitExpiryProbe(currentTime) {
    if (this._expiryProbeInFlight) return;
    if (this.lastRecoveryAt > 0 && (currentTime - this.lastRecoveryAt) < this.rateLimitProbeInterval) return;
    if (this.deps.readHeartbeatPending()) return; // a heartbeat is already in flight

    this._expiryProbeInFlight = true;
    this.runRecoveryProbe({ phase: 'recovery' })
      .catch(err => this.deps.log(`Rate-limit expiry probe failed: ${err?.message || err}`))
      .finally(() => {
        this._expiryProbeInFlight = false;
      });
  }

  _schedulePostRestartProbe() {
    this._clearPostRestartProbeTimer();
    this.postRestartProbeTimer = setTimeout(async () => {
      this.postRestartProbeTimer = null;
      if (this.healthState === 'ok') return;
      try {
        await this.runRecoveryProbe({ phase: 'post_restart' });
      } catch (err) {
        this.deps.log(`post-restart recovery probe failed: ${err?.message || err}`);
      }
    }, this.postRestartProbeDelayMs);
    if (typeof this.postRestartProbeTimer.unref === 'function') {
      this.postRestartProbeTimer.unref();
    }
  }

  _clearPostRestartProbeTimer() {
    if (this.postRestartProbeTimer) {
      clearTimeout(this.postRestartProbeTimer);
      this.postRestartProbeTimer = null;
    }
  }
}

export { HealthEngine as HeartbeatEngine };
