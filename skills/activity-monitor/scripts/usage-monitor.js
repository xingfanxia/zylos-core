import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { shouldStartUsageCheck } from './usage-check-engine.js';
import {
  classifyCodexRateLimitWindows,
  readCodexUsageFromActiveRollout,
} from './usage-codex-rollout-reader.js';
import {
  readClaudeUsageFromMonitorFiles,
  readCodexUsageFromMonitorFile,
  readStatuslineWithDiagnostics
} from './usage-monitor-file-reader.js';

export class UsageMonitor {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.options = options;
    this.lastUsageCheckAt = 0;
    this.lastFleetAlertAt = 0;
  }

  get runtimeId() {
    return this.adapter.runtimeId;
  }

  get usageProvider() {
    return Object.prototype.hasOwnProperty.call(this.options, 'usageProvider')
      ? this.options.usageProvider
      : this.runtimeId;
  }

  initializeLastCheckAt(nowEpoch) {
    const usageState = this.loadUsageState();
    if (this.usageProvider === 'codex') return 0;
    if (usageState?.lastCheckEpoch) return usageState.lastCheckEpoch;
    return nowEpoch;
  }

  isMonitorEnabled() {
    return Boolean(this.usageProvider) && this.options.monitorEnabled;
  }

  isAlertEnabled() {
    return Boolean(this.usageProvider) && this.options.alertEnabled;
  }

  getLastMonitorRunAt() {
    return this.lastUsageCheckAt;
  }

  getLastAlertRunAt() {
    const state = this.loadUsageAlertState();
    return state?.lastCheckedAt ? Math.floor(new Date(state.lastCheckedAt).getTime() / 1000) : 0;
  }

  canRunTask({ claudeState, idleSeconds, currentTime, apiActivity, activeHoursOnly = false }) {
    if (this.usageProvider !== 'claude' && this.usageProvider !== 'codex') return false;

    const promptUpdatedAt = apiActivity?.updated_at
      ? Math.floor(apiActivity.updated_at / 1000) : 0;
    return shouldStartUsageCheck({
      runtimeId: this.usageProvider,
      allowedRuntimeIds: ['claude', 'codex'],
      claudeState,
      idleSeconds,
      currentTime,
      lastUsageCheckAt: 0,
      checkInterval: { seconds: this.options.checkIntervalSec, idleGate: this.options.idleGateSec },
      inPrompt: this.usageProvider === 'claude' ? Boolean(apiActivity?.in_prompt) : false,
      promptUpdatedAt,
      localHour: this.options.getLocalHour(),
      activeHoursStart: activeHoursOnly ? this.options.activeHoursStart : 0,
      activeHoursEnd: activeHoursOnly ? this.options.activeHoursEnd : 24,
      pendingQueueCount: this.getPendingWorkCount(),
      lockBusy: false,
      backoffUntil: 0,
      circuitUntil: 0,
    });
  }

  runMonitor({ currentTime }) {
    if (!this.usageProvider) return true;
    let snapshot = null;
    let source = null;
    if (this.usageProvider === 'claude') {
      snapshot = readClaudeUsageFromMonitorFiles({
        statuslineFile: this.options.statuslineFile,
        usageStateFile: this.options.usageStateFile
      });
      source = snapshot?.statusShape || 'none';
    } else {
      // The active rollout is the live subscription source. usage-codex.json is
      // this monitor's own persisted output, so preferring it would keep a
      // stale value forever after a profile/account switch.
      snapshot = readCodexUsageFromActiveRollout({
        codexHome: this.options.codexHome,
        instanceId: this.options.instanceId,
      });
      source = snapshot?.statusShape || 'rollout-missing';

      if (!snapshot) {
        snapshot = readCodexUsageFromMonitorFile({
          usageStateFile: this.options.usageCodexStateFile
        });
        source = snapshot?.statusShape || 'usage-codex-missing';
        if (snapshot) this.options.log('Usage monitor (codex): live rollout unavailable, using persisted snapshot');
      }
    }

    if (!snapshot) {
      this.options.log(`Usage monitor (${this.usageProvider}): no local usage snapshot available`);
      this.lastUsageCheckAt = currentTime;
      return true;
    }

    const usage = {
      session: snapshot.sessionPercent,
      sessionResets: snapshot.sessionResets,
      weeklyAll: snapshot.weeklyAllPercent,
      weeklyAllResets: snapshot.weeklyAllResets,
      weeklySonnet: snapshot.weeklySonnetPercent,
      weeklySonnetResets: snapshot.weeklySonnetResets,
      fiveHour: snapshot.fiveHourPercent,
      fiveHourResets: snapshot.fiveHourResets
    };
    const now = new Date().toISOString();
    const tierMetric = usage.weeklyAll ?? usage.session;
    // The shared 5h rate-limit fills fast and caused the incident (tier=ok while
    // 5h=100%). Tier on BOTH dimensions and persist the compound max so no hot
    // window is silently ignored.
    const weeklyTier = this.getUsageTier(tierMetric ?? 0);
    const fiveHourTier = this.getFiveHourTier(usage.fiveHour ?? 0);
    const tier = maxRankTier(weeklyTier, fiveHourTier);

    const usageData = {
      lastCheck: now,
      lastCheckEpoch: currentTime,
      session: { percent: usage.session, resets: usage.sessionResets },
      weeklyAll: { percent: usage.weeklyAll, resets: usage.weeklyAllResets },
      weeklySonnet: { percent: usage.weeklySonnet, resets: usage.weeklySonnetResets },
      fiveHour: { percent: usage.fiveHour, resets: usage.fiveHourResets },
      tier,
      weeklyTier,
      fiveHourTier,
      statusShape: source
    };

    this.options.log(
      `Usage monitor (${this.usageProvider}): source=${source} session=${usage.session ?? 'null'}% ` +
      `5h=${usage.fiveHour ?? 'null'}% weekly=${usage.weeklyAll ?? 'null'}% ` +
      `tier=${tier} (weekly=${weeklyTier},5h=${fiveHourTier})`
    );

    this.writeUsageState(usageData);
    this.lastUsageCheckAt = currentTime;
    return true;
  }

  runAlert({ currentTime }) {
    if (!this.usageProvider) return true;
    const checkedAt = new Date(currentTime * 1000).toISOString();
    const alertState = this.loadUsageAlertState();
    const writeCheckedState = (patch = {}) => {
      this.writeUsageAlertState({
        version: 1,
        ...alertState,
        lastCheckedAt: checkedAt,
        sourceRuntime: this.usageProvider,
        ...patch
      });
    };

    const state = this.loadUsageState();
    if (!state) {
      this.options.log(`Usage alert (${this.usageProvider}): no usage state available`);
      writeCheckedState();
      return true;
    }

    const weekly = state.weeklyAll?.percent;
    if (weekly === null || weekly === undefined) {
      this.options.log(`Usage alert (${this.usageProvider}): no weekly usage metric available`);
      writeCheckedState();
      return true;
    }

    const tier = state.tier || this.getUsageTier(weekly);
    if (tier === 'ok') {
      writeCheckedState({ lastObservedTier: tier });
      return true;
    }

    const prevTier = alertState?.lastNotifiedTier || state.lastNotifiedTier || null;
    const prevNotifiedIso = alertState?.lastNotifiedAt || state.lastNotifiedAt || null;
    const prevNotifiedAt = prevNotifiedIso ? Math.floor(new Date(prevNotifiedIso).getTime() / 1000) : 0;
    const tierEscalated = prevTier !== tier && tierRank(tier) > tierRank(prevTier);
    const cooldownExpired = (currentTime - prevNotifiedAt) >= this.options.notifyCooldownSec;

    if (!tierEscalated && !cooldownExpired) {
      this.options.log(`Usage alert (${this.usageProvider}): suppressing notification (cooldown active, tier=${tier})`);
      writeCheckedState({ lastObservedTier: tier });
      return true;
    }

    const usage = {
      session: state.session?.percent,
      weeklyAll: state.weeklyAll?.percent,
      weeklySonnet: state.weeklySonnet?.percent,
      weeklyAllResets: state.weeklyAll?.resets
    };
    this.options.log(`Usage alert (${this.usageProvider}): notifying owner for tier=${tier}`);
    this.sendNotification(formatUsageNotification(usage, tier, this.usageProvider));
    writeCheckedState({
      lastObservedTier: tier,
      lastNotifiedTier: tier,
      lastNotifiedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Fleet-level near-full alert. Runs ONLY on the primary (admin) instance —
   * the only non-isolated runner that can fan out to any chat_id via the legacy
   * direct c4-send path. Never depends on a (possibly rate-limited) instance claude.
   *
   * Anti-forgery quorum (review S1): instances write their OWN statusline.json,
   * so no single instance is trusted. We collect ALL fresh+valid readings and:
   *   - >=3 sources → use the per-dimension MEDIAN (a lone forger can't move it)
   *     and allow the full user fan-out;
   *   - 1-2 sources → alert the ADMIN ONLY (name the sources), never users;
   *   - 0 sources  → "monitoring blind" admin alert, never a false all-clear.
   * A separate user-alert min-interval (review S1b) stops resets_at churn from
   * re-blasting real users. Read failures degrade LOUDLY, distinguishing EACCES
   * (frozen supplementary groups — actionable) from ENOENT (idle instance).
   */
  // REL-9: the task scheduler calls this synchronously and does NOT await it, so
  // the sync prologue below (primary gate + run-marker) runs before the first
  // await inside _runFleetAlertInner — this preserves interval re-entry gating
  // (getLastFleetAlertRunAt reads lastFleetAlertAt). The async body is
  // fire-and-forget; the .catch guarantees a rejected send-promise can never
  // surface as an unhandled rejection.
  runFleetAlert({ currentTime }) {
    if (!this.usageProvider || !this.isPrimaryInstance()) return true;
    this.lastFleetAlertAt = currentTime;
    return this._runFleetAlertInner({ currentTime }).catch((err) => {
      this.options.log(`Usage fleet alert: unexpected error — ${err && err.message}`);
      return true;
    });
  }

  /**
   * Preferred fleet-alert source: provider-usage.json, written every ~5min by
   * the provider-usage-updater daemon (codexbar) — an ACTIVE query of the
   * shared account's real quota, independent of whether any instance is
   * rendering. Statusline files are passive render exhaust: stale whenever the
   * fleet is idle OR an instance sits inside one long busy turn, which made
   * the old statusline-only fleet alert go "blind" nightly (2026-07-12: 12
   * flap alerts while the direct read was fresh all night). Source order is
   * provider → statusline scan; "blind" now requires BOTH channels down.
   * Returns { ok:true, reading } | { ok:false, reason } — never throws.
   */
  readProviderUsage(currentTime) {
    const file = this.options.providerUsageFile
      ?? (this.options.zylosDir ? path.join(this.options.zylosDir, 'activity-monitor', 'provider-usage.json') : null);
    if (!file) return { ok: false, reason: 'unconfigured' };
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { ok: false, reason: err?.code === 'ENOENT' ? 'missing' : `unreadable(${err?.code || 'EPARSE'})` };
    }
    const p = doc?.providers?.[this.usageProvider];
    if (!p || p.available !== true) {
      return { ok: false, reason: p?.error ? `unavailable(${String(p.error).slice(0, 80)})` : 'unavailable' };
    }
    const fetchedAtSec = Math.floor(new Date(p.fetched_at || doc.updated_at || 0).getTime() / 1000);
    if (!Number.isFinite(fetchedAtSec) || fetchedAtSec <= 0) return { ok: false, reason: 'no_timestamp' };
    const ageSec = currentTime - fetchedAtSec;
    // updater cadence is 5min (60s retry) — 15min = 3 missed cycles = poll is down.
    const staleSec = this.options.providerUsageStaleSec ?? 900;
    if (ageSec > staleSec) return { ok: false, reason: `stale(${Math.round(ageSec / 60)}m)` };
    const { fiveHour: fiveHourWindow, weekly: weeklyWindow } = classifyCodexRateLimitWindows(p);
    const fiveHour = fiveHourWindow?.used_percent;
    const weekly = weeklyWindow?.used_percent;
    if (![fiveHour, weekly].some(value => typeof value === 'number' && Number.isFinite(value))) {
      return { ok: false, reason: 'no_known_usage_window' };
    }
    return {
      ok: true,
      reading: {
        fiveHour: (typeof fiveHour === 'number' && Number.isFinite(fiveHour)) ? fiveHour : 0,
        // a provider payload without a weekly window tiers weekly as 0 (off) —
        // 5h still tiers, and maxRankTier means a real weekly is never masked.
        weekly: (typeof weekly === 'number' && Number.isFinite(weekly)) ? weekly : 0,
        fiveHourResetsAt: fiveHourWindow?.resets_at ?? null,
        fiveHourResets: fiveHourWindow?.reset_description || fiveHourWindow?.resets_at || null,
        weeklyAllResetsAt: weeklyWindow?.resets_at ?? null,
        weeklyAllResets: weeklyWindow?.reset_description || weeklyWindow?.resets_at || null,
        ageSec,
      },
    };
  }

  async _runFleetAlertInner({ currentTime }) {
    const fleetState = this.loadFleetAlertState();
    const staleSec = this.options.statuslineStaleSec;
    const nowIso = new Date(currentTime * 1000).toISOString();

    const readings = [];
    const loudErrors = {};          // id → error code (EACCES/EPARSE/EINVALID/…) — NOT ENOENT
    const reasonCounts = { stale: 0, eacces: 0, enoent: 0, unreadable: 0, invalid: 0 };

    // Direct read first; the per-instance statusline scan below is now the
    // FALLBACK channel, only walked when the provider read is unusable.
    const provider = this.readProviderUsage(currentTime);
    const sourceMode = provider.ok ? 'provider' : 'statusline';
    if (provider.ok) {
      readings.push({
        id: 'provider-usage',
        fiveHour: provider.reading.fiveHour,
        weekly: provider.reading.weekly,
        fiveHourResetsAt: provider.reading.fiveHourResetsAt,
        fiveHourResets: provider.reading.fiveHourResets,
        weeklyAllResetsAt: provider.reading.weeklyAllResetsAt,
        weeklyAllResets: provider.reading.weeklyAllResets,
        mtimeSec: currentTime - provider.reading.ageSec,
      });
    } else if (provider.reason !== this._lastProviderReason) {
      // in-memory change-dedup (2-min cycles would spam); a restart re-logs once.
      this.options.log(`Usage fleet alert: provider usage unusable (${provider.reason}) — falling back to statusline scan`);
    }
    this._lastProviderReason = provider.ok ? null : provider.reason;

    const instances = this.options.getAllInstances ? this.options.getAllInstances() : [];
    const scanList = provider.ok ? [] : (instances.length ? instances : [{ id: null }]);

    for (const inst of scanList) {
      const id = inst.id;
      const file = this.options.statuslineFileFor(id);
      let st;
      try {
        st = fs.statSync(file);
      } catch (err) {
        const code = err.code || 'ESTAT';
        if (code === 'ENOENT') { reasonCounts.enoent += 1; }
        else { loudErrors[id] = code; reasonCounts.eacces += (code === 'EACCES' ? 1 : 0); reasonCounts.unreadable += (code === 'EACCES' ? 0 : 1); }
        continue;
      }
      const mtimeSec = Math.floor(st.mtimeMs / 1000);
      if ((currentTime - mtimeSec) > staleSec) { reasonCounts.stale += 1; continue; }

      const { error, reading } = readStatuslineWithDiagnostics(file);
      if (error) {
        if (error === 'ENOENT') { reasonCounts.enoent += 1; continue; }
        loudErrors[id] = error;
        if (error === 'EACCES') reasonCounts.eacces += 1;
        else if (error === 'EINVALID') reasonCounts.invalid += 1;
        else reasonCounts.unreadable += 1;
        continue;
      }
      if (
        reading.statusShape !== 'statusline_rate_limits' ||
        typeof reading.fiveHourPercent !== 'number' ||
        typeof reading.weeklyAllPercent !== 'number'
      ) {
        loudErrors[id] = 'EINVALID';
        reasonCounts.invalid += 1;
        continue;
      }
      readings.push({
        id,
        fiveHour: reading.fiveHourPercent,
        weekly: reading.weeklyAllPercent,
        fiveHourResetsAt: reading.fiveHourResetsAt ?? null,
        fiveHourResets: reading.fiveHourResets ?? null,
        weeklyAllResetsAt: reading.weeklyAllResetsAt ?? null,
        weeklyAllResets: reading.weeklyAllResets ?? null,
        mtimeSec
      });
    }

    // Log read failures loudly, once per instance per error-episode (review F2):
    // only when the code changed from what we last recorded (avoids 120s spam).
    const prevStatErrors = fleetState.statErrors || {};
    for (const [id, code] of Object.entries(loudErrors)) {
      if (prevStatErrors[id] !== code) {
        const hint = code === 'EACCES'
          ? 'permission denied (frozen supplementary groups? add an ACL) — actionable'
          : 'unreadable';
        this.options.log(`Usage fleet alert: statusline read failed for instance=${id} code=${code} (${hint})`);
      }
    }

    const usableCount = readings.length;
    const sources = readings.map((r) => r.id);

    // 0 usable readings → BOTH channels down (provider poll unusable AND every
    // statusline stale/broken) → blind (never a false all-clear).
    if (usableCount === 0) {
      return await this.emitMonitoringBlind({
        currentTime, fleetState, staleSec, usableCount, reasonCounts, loudErrors,
        providerReason: provider.reason,
      });
    }

    // Provider direct read is the single trusted source (hub-owned daemon) →
    // quorum by definition. Statusline fallback keeps the forgery-resistant
    // rule: >=3 sources → median; 1-2 → worst-case (max), admin-only.
    const quorum = sourceMode === 'provider' || usableCount >= 3;
    const fiveHour = quorum
      ? median(readings.map((r) => r.fiveHour))
      : Math.max(...readings.map((r) => r.fiveHour));
    const weeklyAll = quorum
      ? median(readings.map((r) => r.weekly))
      : Math.max(...readings.map((r) => r.weekly));

    // Window identity + display come from the freshest usable reading.
    const freshest = readings.reduce((a, b) => (b.mtimeSec >= a.mtimeSec ? b : a));
    const weeklyTier = this.getUsageTier(weeklyAll ?? 0);
    const fiveHourTier = this.getFiveHourTier(fiveHour ?? 0);
    const tier = maxRankTier(weeklyTier, fiveHourTier);
    const hotWindow = tierRank(fiveHourTier) >= tierRank(weeklyTier) ? '5h' : 'weekly';
    const alertWindowKey = String(hotWindow === 'weekly'
      ? (freshest.weeklyAllResetsAt ?? freshest.weeklyAllResets ?? 'weekly:unknown')
      : (freshest.fiveHourResetsAt ?? freshest.fiveHourResets ?? '5h:unknown'));

    const data = {
      fiveHour,
      weeklyAll,
      fiveHourResets: freshest.fiveHourResets,
      weeklyAllResets: freshest.weeklyAllResets,
      weeklyTier,
      fiveHourTier,
      hotWindow,
      usableCount,
      sources,
      quorum,
      sourceMode,
      usageProvider: this.usageProvider,
      providerAgeMin: provider.ok ? Math.round(provider.reading.ageSec / 60) : null
    };

    // Any usable reading clears a prior "monitoring blind" episode.
    const carry = {
      ...fleetState,
      blindAlertedAt: null,
      statErrors: loudErrors,
      lastCheckedAt: nowIso
    };

    if (tier === 'ok') {
      this.writeFleetAlertState({ ...carry, lastObservedTier: 'ok' });
      return true;
    }

    // Dedupe on the 5h window (keyed on the RAW resets_at epoch — review F6):
    // fire once per threshold crossing per window, re-arm when the window resets,
    // re-fire on tier-rank escalation.
    const previousWindowKey = fleetState.lastAlertedWindowKey ?? fleetState.lastAlertedFiveHourResetsKey;
    const windowChanged = previousWindowKey !== alertWindowKey;
    const escalated = tierRank(tier) > tierRank(fleetState.lastAlertedTier || 'ok');
    const firstAlert = !fleetState.lastAlertedTier;
    if (!windowChanged && !escalated && !firstAlert) {
      this.options.log(`Usage fleet alert: suppressing (tier=${tier}, window unchanged, source=${sourceMode}, sources=${usableCount})`);
      this.writeFleetAlertState({ ...carry, lastObservedTier: tier });
      return true;
    }

    // User fan-out gate: quorum required + user-notify enabled + tier>=high +
    // independent user rate limit (review S1a/S1b).
    const userRateLimitOk =
      (currentTime - (fleetState.lastUserAlertedAt || 0)) >= this.options.userAlertMinIntervalSec;
    const doUserFanout =
      this.options.notifyUsers && quorum && tierRank(tier) >= tierRank('high') && userRateLimitOk;
    if (this.options.notifyUsers && tierRank(tier) >= tierRank('high') && !doUserFanout) {
      const why = !quorum ? `below quorum (sources=${usableCount})` : 'user rate-limit active';
      this.options.log(`Usage fleet alert: user fan-out suppressed — ${why}`);
    }

    const { userSends, adminSent } = await this.deliverFleetAlert(tier, data, { doUserFanout });
    this.options.log(
      `Usage fleet alert: delivered tier=${tier} (users=${userSends}, admin=${adminSent}, ` +
      `source=${sourceMode}, sources=${usableCount}, 5h=${fiveHour}% weekly=${weeklyAll}%)`
    );
    this.writeFleetAlertState({
      version: 1,
      lastAlertedTier: tier,
      lastAlertedWindowKey: alertWindowKey,
      // Backward-compatible state field for existing deployments/tests.
      lastAlertedFiveHourResetsKey: alertWindowKey,
      lastAlertedAt: nowIso,
      lastObservedTier: tier,
      lastCheckedAt: nowIso,
      lastUserAlertedAt: doUserFanout ? currentTime : (fleetState.lastUserAlertedAt || 0),
      blindAlertedAt: null,
      // the blind re-alert cooldown survives recovery + tier alerts by design
      blindLastAlertAt: fleetState.blindLastAlertAt || 0,
      statErrors: loudErrors
    });
    return true;
  }

  // REL-9: async, non-blocking fan-out. Every c4Send runs CONCURRENTLY (wall-clock
  // = slowest single send, not the sum), and the AM event loop is never blocked
  // while they're in flight. `Promise.resolve(...)` tolerates a c4Send that returns
  // a plain value (sync test fakes) as well as a real Promise. Counts are tallied
  // in the .then callbacks and only read after Promise.all settles, so the
  // `delivered users=X admin=Y` log stays accurate.
  async deliverFleetAlert(tier, data, { doUserFanout }) {
    let userSends = 0;
    let adminSent = 0;
    const pending = [];
    if (doUserFanout) {
      const userText = formatUserNotification(data, tier);
      for (const inst of (this.options.getAllInstances ? this.options.getAllInstances() : [])) {
        if (inst.enabled === false) continue;
        if (inst.type !== 'user' && inst.type !== 'group') continue;
        const chatIds = Array.isArray(inst.chat_ids) ? inst.chat_ids : [];
        for (const chatId of chatIds) {
          if (!chatId) continue;
          pending.push(Promise.resolve().then(() => this.options.c4Send('feishu', chatId, userText)).then((res) => {
            if (res?.ok) userSends++;
            else this.options.log(`Usage fleet alert: user send failed for ${chatId} (${res?.output})`);
          }));
        }
      }
    }
    // Admin always (caller guarantees tier >= warning here).
    if (this.options.adminChatId) {
      pending.push(Promise.resolve()
        .then(() => this.options.c4Send('feishu', this.options.adminChatId, formatAdminNotification(data, tier)))
        .then((res) => {
          if (res?.ok) adminSent = 1;
          else this.options.log(`Usage fleet alert: admin send failed (${res?.output})`);
        }));
    } else {
      this.options.log('Usage fleet alert: no adminChatId configured — admin alert skipped (check instances.json admin.chat_ids)');
    }
    await Promise.all(pending);
    return { userSends, adminSent };
  }

  async emitMonitoringBlind({ currentTime, fleetState, staleSec, usableCount, reasonCounts, loudErrors, providerReason = null }) {
    const nowIso = new Date(currentTime * 1000).toISOString();
    // Two dedupe layers, because blindness FLAPS:
    //   1. blindAlertedAt — one alert per contiguous blind EPISODE (review F3);
    //      cleared by any usable reading, so an idle overnight fleet gets one
    //      alert, not one every staleSec.
    //   2. blindLastAlertAt — a persistent re-alert COOLDOWN that recovery does
    //      NOT clear. Statusline files only update while an instance is actively
    //      rendering turns, so a short scheduled turn freshens one file (clears
    //      the episode) and 15min later it re-expires → new "episode" → new
    //      alert. 2026-07-12: 12 identical blind alerts in 6h overnight, incl.
    //      re-fires while a persona was ACTIVE mid-long-turn (statuslines don't
    //      refresh inside one long turn). The cooldown caps the spam to one
    //      alert per blindRealertCooldownSec regardless of flapping.
    if (fleetState.blindAlertedAt) {
      this.options.log('Usage fleet alert: monitoring blind — already alerted this episode');
      this.writeFleetAlertState({ ...fleetState, lastCheckedAt: nowIso, statErrors: loudErrors });
      return true;
    }
    const cooldownSec = this.options.blindRealertCooldownSec ?? 4 * 60 * 60;
    const sinceLastSec = currentTime - (fleetState.blindLastAlertAt || 0);
    if (sinceLastSec < cooldownSec) {
      this.options.log(
        `Usage fleet alert: monitoring blind — re-alert suppressed (cooldown, last alert ${Math.round(sinceLastSec / 60)}m ago)`
      );
      // Mark the episode so subsequent stale cycles take the cheap branch above.
      this.writeFleetAlertState({ ...fleetState, blindAlertedAt: nowIso, lastCheckedAt: nowIso, statErrors: loudErrors });
      return true;
    }
    const text = formatBlindNotification({ staleSec, usableCount, reasonCounts, providerReason });
    if (this.options.adminChatId) {
      const res = await Promise.resolve().then(() => this.options.c4Send('feishu', this.options.adminChatId, text));
      this.options.log(`Usage fleet alert: monitoring-blind admin alert (${res?.ok ? 'ok' : 'fail'})`);
    } else {
      this.options.log('Usage fleet alert: monitoring blind but no adminChatId configured (check instances.json admin.chat_ids)');
    }
    this.writeFleetAlertState({
      ...fleetState,
      blindAlertedAt: nowIso,
      blindLastAlertAt: currentTime,
      lastCheckedAt: nowIso,
      statErrors: loudErrors
    });
    return true;
  }

  loadFleetAlertState() {
    try {
      const file = this.options.fleetAlertStateFile;
      if (file && fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      }
    } catch { }
    return {};
  }

  writeFleetAlertState(data) {
    try {
      atomicWriteJson(this.options.fleetAlertStateFile, data);
    } catch (err) {
      this.options.log(`Usage fleet alert: failed to write state (${err.message})`);
    }
  }

  loadUsageState() {
    try {
      const stateFile = this.getUsageStateFile();
      if (!fs.existsSync(stateFile)) return null;
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch { }
    return null;
  }

  writeUsageState(data) {
    try {
      fs.writeFileSync(this.getUsageStateFile(), JSON.stringify(data, null, 2));
    } catch (err) {
      this.options.log(`Usage monitor: failed to write state (${err.message})`);
    }
  }

  getUsageStateFile() {
    if (this.usageProvider === 'codex') return this.options.usageCodexStateFile;
    return this.options.usageStateFile;
  }

  loadUsageAlertState() {
    try {
      if (!fs.existsSync(this.options.usageAlertStateFile)) return null;
      return JSON.parse(fs.readFileSync(this.options.usageAlertStateFile, 'utf8'));
    } catch { }
    return null;
  }

  writeUsageAlertState(data) {
    try {
      fs.writeFileSync(this.options.usageAlertStateFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.options.log(`Usage alert: failed to write state (${err.message})`);
    }
  }

  getPendingWorkCount() {
    try {
      const dbPath = path.join(this.options.zylosDir, 'comm-bridge', 'c4.db');
      if (!fs.existsSync(dbPath)) return 0;

      const out = execSync(
        `sqlite3 "${dbPath}" "SELECT ((SELECT COUNT(*) FROM control_queue WHERE status='pending') + (SELECT COUNT(*) FROM conversations WHERE direction='in' AND status='pending'))" 2>/dev/null`,
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      return parseInt(out || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  getUsageTier(weeklyPercent) {
    if (weeklyPercent >= this.options.criticalThreshold) return 'critical';
    if (weeklyPercent >= this.options.highThreshold) return 'high';
    if (weeklyPercent >= this.options.warnThreshold) return 'warning';
    return 'ok';
  }

  getFiveHourTier(fiveHourPercent) {
    if (fiveHourPercent >= this.options.fiveHourCriticalThreshold) return 'critical';
    if (fiveHourPercent >= this.options.fiveHourHighThreshold) return 'high';
    if (fiveHourPercent >= this.options.fiveHourWarnThreshold) return 'warning';
    return 'ok';
  }

  isPrimaryInstance() {
    return this.options.isPrimary ? this.options.isPrimary() : true;
  }

  getLastFleetAlertRunAt() {
    return this.lastFleetAlertAt || 0;
  }

  sendNotification(message) {
    const content = `Usage alert received from activity monitor. Please forward this to the owner via their preferred DM channel:\n\n${message}`;
    const result = this.options.runC4Control([
      'enqueue',
      '--content', content,
      '--priority', '1',
      '--available-in', '5',
      '--no-ack-suffix'
    ]);
    if (result.ok) {
      this.options.log(`Usage monitor: notification enqueued (${result.output})`);
    } else {
      this.options.log(`Usage monitor: notification enqueue failed (${result.output})`);
    }
  }
}

function providerLabel(provider) {
  return provider === 'codex' ? 'Codex subscription' : 'Claude subscription';
}

function remainingPercent(used) {
  return Math.max(0, 100 - (Number(used) || 0));
}

function remainingLabel(used) {
  return used == null ? 'unknown' : `${remainingPercent(used)}%`;
}

function formatUsageNotification(usage, tier, provider = 'claude') {
  const weekly = usage.weeklyAll ?? 0;
  const session = usage.session ?? 0;
  const resets = usage.weeklyAllResets || 'unknown';

  const tierLabels = {
    warning: '⚠️ Usage Warning',
    high: '🔶 Usage High',
    critical: '🔴 Usage Critical'
  };

  const lines = [
    tierLabels[tier] || 'Usage Alert',
    '',
    `Provider: ${providerLabel(provider)}`,
    `Weekly (all models): ${weekly}% used / ${remainingLabel(weekly)} remaining`,
    `Session: ${session}% used / ${remainingLabel(session)} remaining`
  ];

  if (usage.weeklySonnet !== undefined && usage.weeklySonnet !== null) {
    lines.push(`Weekly (Sonnet): ${usage.weeklySonnet}% used`);
  }

  lines.push(`Resets: ${resets}`);

  if (tier === 'critical') {
    lines.push('', 'Approaching plan limit. Consider reducing activity to avoid interruption.');
  } else if (tier === 'high') {
    lines.push('', 'Usage is elevated. Monitor closely.');
  }

  return lines.join('\n');
}

function tierRank(tier) {
  const ranks = { ok: 0, warning: 1, high: 2, critical: 3 };
  return ranks[tier] ?? 0;
}

function maxRankTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

// Affected-user text: zh, short (feishu 2000-char cap), no ops detail. Reports
// the window that drove the tier so the message matches what the user feels.
function formatUserNotification(data, tier) {
  const hot = data.hotWindow === 'weekly'
    ? { pct: data.weeklyAll ?? 0, reset: data.weeklyAllResets, label: '本周' }
    : { pct: data.fiveHour ?? 0, reset: data.fiveHourResets, label: '5小时窗口' };
  const reset = hot.reset || '稍后';
  return `⚠️ 系统提示：${providerLabel(data.usageProvider)} 共享额度已用 ${hot.pct}%、剩余 ${remainingPercent(hot.pct)}%` +
    `（${hot.label}，${reset} 重置）。` +
    `期间回复可能变慢或暂停，重置后自动恢复，无需重复发送。`;
}

// Admin text: both dimensions + resets + which window is hot + how many/which
// instances the reading came from (review S1/F2) + the standing tier-switch CTA
// (AX 2026-07-10 note).
function formatAdminNotification(data, tier) {
  const tierLabels = { warning: '⚠️ 额度预警', high: '🔶 额度偏高', critical: '🔴 额度接近上限' };
  const hot = data.hotWindow === 'weekly' ? '周额度(weekly)' : '5小时(5h)';
  const usableCount = data.usableCount ?? 0;
  const agg = data.quorum ? '中位数' : '最坏值';
  const sourceLine = data.sourceMode === 'provider'
    ? `读数来源: provider 直读（codexbar，${data.providerAgeMin ?? '?'} 分钟前查询）`
    : `读数来源: ${usableCount} 个实例 statusline（${agg}，直读通道不可用）` +
      (data.sources?.length ? `：${data.sources.join(', ')}` : '');
  const lines = [
    `${tierLabels[tier] || '额度提醒'}（${providerLabel(data.usageProvider)}，${tier}，热点=${hot}）`,
    `5h: ${data.fiveHour ?? 'null'}% 已用 / ${remainingLabel(data.fiveHour)} 剩余（${data.fiveHourResets || '未知'} 重置）`,
    `weekly: ${data.weeklyAll ?? 'null'}% 已用 / ${remainingLabel(data.weeklyAll)} 剩余（${data.weeklyAllResets || '未知'} 重置）`,
    sourceLine
  ];
  if (!data.quorum) {
    lines.push('⚠️ 来源不足 3 个，未向用户群发（仅管理员）。');
  }
  lines.push('', '如额度问题反复出现，考虑切换模型档位或升级 Max 套餐（AX 2026-07-10 备注）。');
  return lines.join('\n');
}

// Admin-only "monitoring blind" text — emitted only when BOTH channels are
// down: the provider direct read (codexbar → provider-usage.json) is unusable
// AND no usable statusline reading exists. That is an actionable ops signal
// (poll daemon / auth / disk), unlike the old statusline-only blindness which
// fired whenever the fleet was merely idle or mid-long-turn.
function formatBlindNotification({ staleSec, usableCount, reasonCounts = {}, providerReason = null }) {
  const parts = [];
  if (reasonCounts.stale) parts.push(`${reasonCounts.stale} 过期`);
  if (reasonCounts.eacces) parts.push(`${reasonCounts.eacces} 权限拒绝(EACCES)`);
  if (reasonCounts.invalid) parts.push(`${reasonCounts.invalid} 格式无效`);
  if (reasonCounts.unreadable) parts.push(`${reasonCounts.unreadable} 读取失败`);
  if (reasonCounts.enoent) parts.push(`${reasonCounts.enoent} 未写入`);
  const breakdown = parts.length ? parts.join('、') : '无数据';
  return [
    '🔴 额度监控失明（直读 + statusline 双通道均不可用）',
    `provider 直读: ${providerReason || '不可用'} —— 检查 pm2 provider-usage-updater / codexbar / 账号 auth。`,
    `statusline 兜底: 可用 ${usableCount ?? 0}（阈值 ${Math.round(staleSec / 60)} 分钟），状态: ${breakdown}。`,
    reasonCounts.eacces
      ? '存在 EACCES：admin 无法读取其它实例 statusline（冻结的补充组？给 statusline 文件加 ACL）。'
      : '无法判断共享额度是否接近上限——请先修复 provider-usage-updater（这是主通道）。'
  ].join('\n');
}
