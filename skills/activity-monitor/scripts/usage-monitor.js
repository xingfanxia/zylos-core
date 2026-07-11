import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { shouldStartUsageCheck } from './usage-check-engine.js';
import { readCodexUsageFromActiveRollout } from './usage-codex-rollout-reader.js';
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

  initializeLastCheckAt(nowEpoch) {
    const usageState = this.loadUsageState();
    if (this.runtimeId === 'codex') return 0;
    if (usageState?.lastCheckEpoch) return usageState.lastCheckEpoch;
    return nowEpoch;
  }

  isMonitorEnabled() {
    return this.options.monitorEnabled;
  }

  isAlertEnabled() {
    return this.options.alertEnabled;
  }

  getLastMonitorRunAt() {
    return this.lastUsageCheckAt;
  }

  getLastAlertRunAt() {
    const state = this.loadUsageAlertState();
    return state?.lastCheckedAt ? Math.floor(new Date(state.lastCheckedAt).getTime() / 1000) : 0;
  }

  canRunTask({ claudeState, idleSeconds, currentTime, apiActivity, activeHoursOnly = false }) {
    if (this.runtimeId !== 'claude' && this.runtimeId !== 'codex') return false;

    const promptUpdatedAt = apiActivity?.updated_at
      ? Math.floor(apiActivity.updated_at / 1000) : 0;
    return shouldStartUsageCheck({
      runtimeId: this.runtimeId,
      allowedRuntimeIds: ['claude', 'codex'],
      claudeState,
      idleSeconds,
      currentTime,
      lastUsageCheckAt: 0,
      checkInterval: { seconds: this.options.checkIntervalSec, idleGate: this.options.idleGateSec },
      inPrompt: this.runtimeId === 'claude' ? Boolean(apiActivity?.in_prompt) : false,
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
    let snapshot = null;
    let source = null;
    if (this.runtimeId === 'claude') {
      snapshot = readClaudeUsageFromMonitorFiles({
        statuslineFile: this.options.statuslineFile,
        usageStateFile: this.options.usageStateFile
      });
      source = snapshot?.statusShape || 'none';
    } else {
      snapshot = readCodexUsageFromMonitorFile({
        usageStateFile: this.options.usageCodexStateFile
      });
      source = snapshot?.statusShape || 'usage-codex-missing';

      if (!snapshot) {
        const rolloutStatus = readCodexUsageFromActiveRollout();
        if (rolloutStatus) {
          snapshot = {
            sessionPercent: rolloutStatus.sessionPercent,
            sessionResets: rolloutStatus.sessionResets,
            weeklyAllPercent: rolloutStatus.weeklyAllPercent,
            weeklyAllResets: rolloutStatus.weeklyAllResets,
            weeklySonnetPercent: null,
            weeklySonnetResets: null,
            fiveHourPercent: rolloutStatus.fiveHourPercent,
            fiveHourResets: rolloutStatus.fiveHourResets,
            statusShape: 'rollout_fallback'
          };
          source = snapshot.statusShape;
          this.options.log('Usage monitor (codex): usage-codex.json unavailable, falling back to rollout reader');
        }
      }
    }

    if (!snapshot) {
      this.options.log(`Usage monitor (${this.runtimeId}): no local usage snapshot available`);
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
      `Usage monitor (${this.runtimeId}): source=${source} session=${usage.session ?? 'null'}% ` +
      `5h=${usage.fiveHour ?? 'null'}% weekly=${usage.weeklyAll ?? 'null'}% ` +
      `tier=${tier} (weekly=${weeklyTier},5h=${fiveHourTier})`
    );

    this.writeUsageState(usageData);
    this.lastUsageCheckAt = currentTime;
    return true;
  }

  runAlert({ currentTime }) {
    const checkedAt = new Date(currentTime * 1000).toISOString();
    const alertState = this.loadUsageAlertState();
    const writeCheckedState = (patch = {}) => {
      this.writeUsageAlertState({
        version: 1,
        ...alertState,
        lastCheckedAt: checkedAt,
        sourceRuntime: this.runtimeId,
        ...patch
      });
    };

    const state = this.loadUsageState();
    if (!state) {
      this.options.log(`Usage alert (${this.runtimeId}): no usage state available`);
      writeCheckedState();
      return true;
    }

    const weekly = state.weeklyAll?.percent;
    if (weekly === null || weekly === undefined) {
      this.options.log(`Usage alert (${this.runtimeId}): no weekly usage metric available`);
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
      this.options.log(`Usage alert (${this.runtimeId}): suppressing notification (cooldown active, tier=${tier})`);
      writeCheckedState({ lastObservedTier: tier });
      return true;
    }

    const usage = {
      session: state.session?.percent,
      weeklyAll: state.weeklyAll?.percent,
      weeklySonnet: state.weeklySonnet?.percent,
      weeklyAllResets: state.weeklyAll?.resets
    };
    this.options.log(`Usage alert (${this.runtimeId}): notifying owner for tier=${tier}`);
    this.sendNotification(formatUsageNotification(usage, tier));
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
  runFleetAlert({ currentTime }) {
    if (!this.isPrimaryInstance()) return true;
    this.lastFleetAlertAt = currentTime;

    const fleetState = this.loadFleetAlertState();
    const staleSec = this.options.statuslineStaleSec;
    const nowIso = new Date(currentTime * 1000).toISOString();

    const instances = this.options.getAllInstances ? this.options.getAllInstances() : [];
    const scanList = instances.length ? instances : [{ id: null }];

    const readings = [];
    const loudErrors = {};          // id → error code (EACCES/EPARSE/EINVALID/…) — NOT ENOENT
    const reasonCounts = { stale: 0, eacces: 0, enoent: 0, unreadable: 0, invalid: 0 };

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

    // 0 usable readings → we cannot see the shared meter → blind (never a false all-clear).
    if (usableCount === 0) {
      return this.emitMonitoringBlind({ currentTime, fleetState, staleSec, usableCount, reasonCounts, loudErrors });
    }

    // >=3 sources → median (robust to one forger); 1-2 → worst-case (max), admin-only.
    const quorum = usableCount >= 3;
    const fiveHour = quorum
      ? median(readings.map((r) => r.fiveHour))
      : Math.max(...readings.map((r) => r.fiveHour));
    const weeklyAll = quorum
      ? median(readings.map((r) => r.weekly))
      : Math.max(...readings.map((r) => r.weekly));

    // Window identity + display come from the freshest usable reading.
    const freshest = readings.reduce((a, b) => (b.mtimeSec >= a.mtimeSec ? b : a));
    const fiveHourResetsKey = String(freshest.fiveHourResetsAt ?? freshest.fiveHourResets ?? 'unknown');

    const weeklyTier = this.getUsageTier(weeklyAll ?? 0);
    const fiveHourTier = this.getFiveHourTier(fiveHour ?? 0);
    const tier = maxRankTier(weeklyTier, fiveHourTier);
    const hotWindow = tierRank(fiveHourTier) >= tierRank(weeklyTier) ? '5h' : 'weekly';

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
      quorum
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
    const windowChanged = fleetState.lastAlertedFiveHourResetsKey !== fiveHourResetsKey;
    const escalated = tierRank(tier) > tierRank(fleetState.lastAlertedTier || 'ok');
    const firstAlert = !fleetState.lastAlertedTier;
    if (!windowChanged && !escalated && !firstAlert) {
      this.options.log(`Usage fleet alert: suppressing (tier=${tier}, window unchanged, sources=${usableCount})`);
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

    const { userSends, adminSent } = this.deliverFleetAlert(tier, data, { doUserFanout });
    this.options.log(
      `Usage fleet alert: delivered tier=${tier} (users=${userSends}, admin=${adminSent}, ` +
      `sources=${usableCount}, 5h=${fiveHour}% weekly=${weeklyAll}%)`
    );
    this.writeFleetAlertState({
      version: 1,
      lastAlertedTier: tier,
      lastAlertedFiveHourResetsKey: fiveHourResetsKey,
      lastAlertedAt: nowIso,
      lastObservedTier: tier,
      lastCheckedAt: nowIso,
      lastUserAlertedAt: doUserFanout ? currentTime : (fleetState.lastUserAlertedAt || 0),
      blindAlertedAt: null,
      statErrors: loudErrors
    });
    return true;
  }

  deliverFleetAlert(tier, data, { doUserFanout }) {
    let userSends = 0;
    let adminSent = 0;
    if (doUserFanout) {
      const userText = formatUserNotification(data, tier);
      for (const inst of (this.options.getAllInstances ? this.options.getAllInstances() : [])) {
        if (inst.enabled === false) continue;
        if (inst.type !== 'user' && inst.type !== 'group') continue;
        const chatIds = Array.isArray(inst.chat_ids) ? inst.chat_ids : [];
        for (const chatId of chatIds) {
          if (!chatId) continue;
          const res = this.options.c4Send('feishu', chatId, userText);
          if (res?.ok) userSends++;
          else this.options.log(`Usage fleet alert: user send failed for ${chatId} (${res?.output})`);
        }
      }
    }
    // Admin always (caller guarantees tier >= warning here).
    if (this.options.adminChatId) {
      const res = this.options.c4Send('feishu', this.options.adminChatId, formatAdminNotification(data, tier));
      if (res?.ok) adminSent = 1;
      else this.options.log(`Usage fleet alert: admin send failed (${res?.output})`);
    } else {
      this.options.log('Usage fleet alert: no adminChatId configured — admin alert skipped (check instances.json admin.chat_ids)');
    }
    return { userSends, adminSent };
  }

  emitMonitoringBlind({ currentTime, fleetState, staleSec, usableCount, reasonCounts, loudErrors }) {
    const nowIso = new Date(currentTime * 1000).toISOString();
    // Exactly one blind alert per BLIND EPISODE (review F3): once blindAlertedAt
    // is set it stays set until a fresh valid reading clears it — so an idle
    // overnight fleet gets one alert, not one every staleSec.
    if (fleetState.blindAlertedAt) {
      this.options.log('Usage fleet alert: monitoring blind — already alerted this episode');
      this.writeFleetAlertState({ ...fleetState, lastCheckedAt: nowIso, statErrors: loudErrors });
      return true;
    }
    const text = formatBlindNotification({ staleSec, usableCount, reasonCounts });
    if (this.options.adminChatId) {
      const res = this.options.c4Send('feishu', this.options.adminChatId, text);
      this.options.log(`Usage fleet alert: monitoring-blind admin alert (${res?.ok ? 'ok' : 'fail'})`);
    } else {
      this.options.log('Usage fleet alert: monitoring blind but no adminChatId configured (check instances.json admin.chat_ids)');
    }
    this.writeFleetAlertState({ ...fleetState, blindAlertedAt: nowIso, lastCheckedAt: nowIso, statErrors: loudErrors });
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
    if (this.runtimeId === 'codex') return this.options.usageCodexStateFile;
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

function formatUsageNotification(usage, tier) {
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
    `Weekly (all models): ${weekly}% used`,
    `Session: ${session}% used`
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
  return `⚠️ 系统提示：AI 助手共享额度已用 ${hot.pct}%（${hot.label}，${reset} 重置）。` +
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
  const lines = [
    `${tierLabels[tier] || '额度提醒'}（${tier}，热点=${hot}）`,
    `5h: ${data.fiveHour ?? 'null'}%（${data.fiveHourResets || '未知'} 重置）`,
    `weekly: ${data.weeklyAll ?? 'null'}%（${data.weeklyAllResets || '未知'} 重置）`,
    `读数来源: ${usableCount} 个实例（${agg}）` + (data.sources?.length ? `：${data.sources.join(', ')}` : '')
  ];
  if (!data.quorum) {
    lines.push('⚠️ 来源不足 3 个，未向用户群发（仅管理员）。');
  }
  lines.push('', '如额度问题反复出现，考虑切换模型档位或升级 Max 套餐（AX 2026-07-10 备注）。');
  return lines.join('\n');
}

// Admin-only "monitoring blind" text — emitted when NO usable cross-instance
// reading exists (all stale / inaccessible / invalid), so a rate-limit ramp is
// never masked by a false all-clear. Names the dominant cause so ops can act.
function formatBlindNotification({ staleSec, usableCount, reasonCounts = {} }) {
  const parts = [];
  if (reasonCounts.stale) parts.push(`${reasonCounts.stale} 过期`);
  if (reasonCounts.eacces) parts.push(`${reasonCounts.eacces} 权限拒绝(EACCES)`);
  if (reasonCounts.invalid) parts.push(`${reasonCounts.invalid} 格式无效`);
  if (reasonCounts.unreadable) parts.push(`${reasonCounts.unreadable} 读取失败`);
  if (reasonCounts.enoent) parts.push(`${reasonCounts.enoent} 未写入`);
  const breakdown = parts.length ? parts.join('、') : '无数据';
  return [
    '🟡 额度监控失明（无可用 statusline 读数）',
    `可用来源: ${usableCount ?? 0}（阈值 ${Math.round(staleSec / 60)} 分钟）。来源状态: ${breakdown}。`,
    reasonCounts.eacces
      ? '存在 EACCES：admin 无法读取其它实例 statusline（冻结的补充组？给 statusline 文件加 ACL）。'
      : '无法判断共享额度是否接近上限——请人工确认 fleet 是否处于 rate-limit/重启循环。'
  ].join('\n');
}
