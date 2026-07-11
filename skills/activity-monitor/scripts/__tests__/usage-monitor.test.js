import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'node:test';
import { UsageMonitor } from '../usage-monitor.js';

const tmpDirs = [];

const DEFAULT_INSTANCES = [
  { id: 'admin', type: 'dedicated', primary: true, enabled: true, chat_ids: ['oc_admin'] },
  { id: 'user-pan', type: 'user', enabled: true, chat_ids: ['oc_pan'] },
  { id: 'user-limh', type: 'user', enabled: true, chat_ids: ['oc_limh'] },
  { id: 'group', type: 'group', enabled: true, chat_ids: [] },
  { id: 'user-off', type: 'user', enabled: false, chat_ids: ['oc_off'] },
];

function makeMonitor(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-'));
  tmpDirs.push(dir);
  const calls = { log: [], control: [], send: [] };
  const instances = overrides.instances ?? DEFAULT_INSTANCES;
  const statuslineFileFor = overrides.statuslineFileFor
    ?? ((id) => path.join(dir, `statusline-${id ?? 'self'}.json`));
  const monitor = new UsageMonitor(
    { runtimeId: overrides.runtimeId || 'claude' },
    {
      zylosDir: dir,
      statuslineFile: path.join(dir, 'statusline.json'),
      usageStateFile: path.join(dir, 'usage.json'),
      usageCodexStateFile: path.join(dir, 'usage-codex.json'),
      usageAlertStateFile: path.join(dir, 'usage-alert-state.json'),
      monitorEnabled: true,
      alertEnabled: true,
      checkIntervalSec: 3600,
      idleGateSec: 30,
      warnThreshold: 80,
      highThreshold: 90,
      criticalThreshold: 95,
      fiveHourWarnThreshold: 70,
      fiveHourHighThreshold: 85,
      fiveHourCriticalThreshold: 95,
      notifyCooldownSec: 14400,
      activeHoursStart: 8,
      activeHoursEnd: 23,
      // Fleet alert wiring
      isPrimary: overrides.isPrimary ?? (() => true),
      getAllInstances: () => instances,
      adminChatId: overrides.adminChatId === undefined ? 'oc_admin' : overrides.adminChatId,
      fleetAlertStateFile: path.join(dir, 'usage-fleet-alert-state.json'),
      statuslineFileFor,
      notifyUsers: overrides.notifyUsers ?? true,
      statuslineStaleSec: overrides.statuslineStaleSec ?? 900,
      userAlertMinIntervalSec: overrides.userAlertMinIntervalSec ?? 1800,
      c4Send: (channel, endpoint, message) => {
        calls.send.push({ channel, endpoint, message });
        return { ok: true, output: 'sent' };
      },
      getLocalHour: () => overrides.localHour ?? 10,
      runC4Control: (args) => {
        calls.control.push(args);
        return { ok: true, output: 'OK: enqueued control 1' };
      },
      log: (message) => calls.log.push(message),
    }
  );
  return { dir, monitor, calls, statuslineFileFor, instances };
}

function writeRateLimitStatusline(file, { fiveHour, weekly, fiveResetAt = 1900000020, weeklyResetAt = 1900500000 }, mtimeEpoch = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: fiveResetAt },
      seven_day: { used_percentage: weekly, resets_at: weeklyResetAt },
    }
  }));
  if (mtimeEpoch != null) fs.utimesSync(file, mtimeEpoch, mtimeEpoch);
}

function seed(statuslineFileFor, ids, reading, mtimeEpoch) {
  for (const id of ids) writeRateLimitStatusline(statuslineFileFor(id), reading, mtimeEpoch);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('UsageMonitor', () => {
  it('preserves startup check timing semantics for Claude and Codex', () => {
    const claude = makeMonitor();
    assert.equal(claude.monitor.initializeLastCheckAt(5000), 5000);

    fs.writeFileSync(path.join(claude.dir, 'usage.json'), JSON.stringify({ lastCheckEpoch: 1234 }));
    assert.equal(claude.monitor.initializeLastCheckAt(5000), 1234);

    const codex = makeMonitor({ runtimeId: 'codex' });
    assert.equal(codex.monitor.initializeLastCheckAt(5000), 0);
  });

  it('refreshes local usage state without sending an alert', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'statusline.json'), JSON.stringify({
      usage: {
        session: { percent: 12, resets: 'soon' },
        weeklyAll: { percent: 45, resets: 'Monday' },
        weeklySonnet: { percent: 30, resets: 'Monday' },
        fiveHour: { percent: 20, resets: 'later' }
      }
    }));

    assert.equal(monitor.runMonitor({ currentTime: 1000 }), true);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(state.lastCheckEpoch, 1000);
    assert.equal(state.session.percent, 12);
    assert.equal(state.weeklyAll.percent, 45);
    assert.equal(state.tier, 'ok');
    assert.equal(state.statusShape, 'statusline_usage');
    assert.deepEqual(calls.control, []);
  });

  it('tiers on the 5h dimension even when weekly is ok (incident regression)', () => {
    const { dir, monitor } = makeMonitor();
    // weekly 45% (ok) but 5h 96% (critical) — the incident logged tier=ok while 5h=100%.
    fs.writeFileSync(path.join(dir, 'statusline.json'), JSON.stringify({
      usage: {
        session: { percent: 14, resets: 'soon' },
        weeklyAll: { percent: 45, resets: 'Monday' },
        fiveHour: { percent: 96, resets: 'later' }
      }
    }));

    assert.equal(monitor.runMonitor({ currentTime: 1000 }), true);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
    assert.equal(state.tier, 'critical');
    assert.equal(state.fiveHourTier, 'critical');
    assert.equal(state.weeklyTier, 'ok');
  });

  it('sends usage alerts from persisted monitor state and writes alert state', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
      session: { percent: 70, resets: 'soon' },
      weeklyAll: { percent: 96, resets: 'Monday' },
      weeklySonnet: { percent: 91, resets: 'Monday' },
      tier: 'critical'
    }));

    assert.equal(monitor.runAlert({ currentTime: 2000 }), true);

    assert.equal(calls.control.length, 1);
    assert.deepEqual(calls.control[0].slice(0, 2), ['enqueue', '--content']);
    assert.match(calls.control[0][2], /Usage Critical/);
    const alertState = JSON.parse(fs.readFileSync(path.join(dir, 'usage-alert-state.json'), 'utf8'));
    assert.equal(alertState.lastObservedTier, 'critical');
    assert.equal(alertState.lastNotifiedTier, 'critical');
    assert.equal(alertState.sourceRuntime, 'claude');
  });

  it('suppresses repeated alerts during cooldown', () => {
    const { dir, monitor, calls } = makeMonitor();
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
      session: { percent: 70 },
      weeklyAll: { percent: 92 },
      tier: 'high'
    }));
    fs.writeFileSync(path.join(dir, 'usage-alert-state.json'), JSON.stringify({
      lastNotifiedTier: 'high',
      lastNotifiedAt: new Date(1000 * 1000).toISOString()
    }));

    assert.equal(monitor.runAlert({ currentTime: 2000 }), true);

    assert.deepEqual(calls.control, []);
    assert.ok(calls.log.some(message => message.includes('suppressing notification')));
  });
});

describe('UsageMonitor fleet alert', () => {
  it('fans out to users + admin when >=3 fresh sources agree (median quorum)', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);

    const userSends = calls.send.filter(s => s.endpoint !== 'oc_admin');
    const adminSends = calls.send.filter(s => s.endpoint === 'oc_admin');
    assert.deepEqual(userSends.map(s => s.endpoint).sort(), ['oc_limh', 'oc_pan']);
    assert.equal(adminSends.length, 1);
  });

  it('median ignores a single forged outlier (1 forged high among 2 ok → no alert)', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    // Two honest instances read 20% (ok); one forges 99%. Median 5h = 20 → ok.
    writeRateLimitStatusline(statuslineFileFor('admin'), { fiveHour: 20, weekly: 10 }, now);
    writeRateLimitStatusline(statuslineFileFor('user-pan'), { fiveHour: 20, weekly: 10 }, now);
    writeRateLimitStatusline(statuslineFileFor('user-limh'), { fiveHour: 99, weekly: 99 }, now);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);
    assert.deepEqual(calls.send, []);
  });

  it('with only 1-2 fresh sources, alerts admin only and names the sources (no user fan-out)', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan'], { fiveHour: 96, weekly: 20 }, now);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);

    const userSends = calls.send.filter(s => s.endpoint !== 'oc_admin');
    const adminSends = calls.send.filter(s => s.endpoint === 'oc_admin');
    assert.equal(userSends.length, 0, 'no user fan-out below quorum');
    assert.equal(adminSends.length, 1);
    assert.match(adminSends[0].message, /admin|user-pan/); // source instances named
    assert.match(adminSends[0].message, /2/); // usable-source count surfaced
  });

  it('does not alert on a non-primary instance', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ isPrimary: () => false });
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 99, weekly: 99 }, now);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);
    assert.deepEqual(calls.send, []);
  });

  it('user floor: tier=warning notifies admin only, no user sends', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 72, weekly: 10 }, now);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].endpoint, 'oc_admin');
  });

  it('dedupes same {tier, window}, re-fires on escalation, re-arms on raw-epoch window reset', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];

    seed(statuslineFileFor, ids, { fiveHour: 88, weekly: 10, fiveResetAt: 1900000020 }, now);
    monitor.runFleetAlert({ currentTime: now });
    const afterFirst = calls.send.length;
    assert.ok(afterFirst > 0, 'first crossing fires');

    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 88, weekly: 10, fiveResetAt: 1900000020 }, now);
    monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, afterFirst, 'same tier + window suppressed');

    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000020 }, now);
    monitor.runFleetAlert({ currentTime: now });
    const afterEsc = calls.send.length;
    assert.ok(afterEsc > afterFirst, 'escalation re-fires');

    // New window: SAME wall-clock minute (formats to same HH:MM string) but a
    // different raw resets_at epoch. Formatted-string keying would wrongly
    // suppress; raw-epoch keying re-arms. (F6)
    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000050 }, now);
    monitor.runFleetAlert({ currentTime: now });
    assert.ok(calls.send.length > afterEsc, 'window reset (raw epoch) re-arms');
  });

  it('independent user rate limit throttles user re-blast on window churn (admin still fires)', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ userAlertMinIntervalSec: 1800 });
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];

    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000020 }, now);
    monitor.runFleetAlert({ currentTime: now });
    const users1 = calls.send.filter(s => s.endpoint !== 'oc_admin').length;
    assert.equal(users1, 2, 'users notified on first crossing');

    // New window 120s later (churn) → admin re-fires, users throttled (< 1800s).
    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900018000 }, now);
    monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, users1, 'users throttled on churn');
    assert.equal(calls.send.filter(s => s.endpoint === 'oc_admin').length, 2, 'admin still fires');

    // Past the user interval + a new window → users fire again.
    now += 1801;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900036000 }, now);
    monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, users1 + 2, 'users notified after interval');
  });

  it('admin text carries 5h% + tier-switch CTA + usable count; user text is zh and short', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    monitor.runFleetAlert({ currentTime: now });

    const admin = calls.send.find(s => s.endpoint === 'oc_admin');
    const user = calls.send.find(s => s.endpoint === 'oc_pan');
    assert.ok(admin, 'admin send present');
    assert.match(admin.message, /5h/);
    assert.match(admin.message, /96/);
    assert.match(admin.message, /切换/);
    assert.match(admin.message, /3/); // usable-source count

    assert.ok(user, 'user send present');
    assert.ok(user.message.length < 2000);
    assert.match(user.message, /额度/);
    assert.doesNotMatch(user.message, /切换/);
  });

  it('no usable readings emits exactly one monitoring-blind admin alert per episode', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ statuslineStaleSec: 900 });
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];
    seed(statuslineFileFor, ids, { fiveHour: 99, weekly: 99 }, now - 1000); // stale

    monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 1, 'one blind alert');
    assert.equal(calls.send[0].endpoint, 'oc_admin');
    assert.match(calls.send[0].message, /失明|statusline/);

    // Still blind, even after a full stale-window elapses → no re-fire (per episode).
    monitor.runFleetAlert({ currentTime: now + 5000 });
    assert.equal(calls.send.length, 1, 'blind alert deduped for whole episode');

    // A fresh valid reading clears the episode; going blind again re-alerts.
    now += 6000;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now); // fresh ok → clears blind
    monitor.runFleetAlert({ currentTime: now });
    now += 6000;
    seed(statuslineFileFor, ids, { fiveHour: 99, weekly: 99 }, now - 2000); // stale again
    monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 2, 'new blind episode re-alerts');
  });

  it('logs cross-instance read failures loudly, distinguishing EACCES from ENOENT', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    // admin: fresh valid (the only usable source). user-pan: unreadable (EACCES).
    // user-limh: never written (ENOENT — benign).
    writeRateLimitStatusline(statuslineFileFor('admin'), { fiveHour: 96, weekly: 20 }, now);
    const accessFile = statuslineFileFor('user-pan');
    writeRateLimitStatusline(accessFile, { fiveHour: 96, weekly: 20 }, now);
    fs.chmodSync(accessFile, 0o000);

    assert.equal(monitor.runFleetAlert({ currentTime: now }), true);

    const eaccesLog = calls.log.find(m => /EACCES|permission|user-pan/i.test(m));
    assert.ok(eaccesLog, 'EACCES logged loudly');
    // ENOENT for user-limh must NOT be logged as a loud error.
    assert.ok(!calls.log.some(m => /user-limh/.test(m) && /permission|EACCES/i.test(m)));
    // Only 1 usable source (admin) → admin-only alert, count surfaced.
    const adminSends = calls.send.filter(s => s.endpoint === 'oc_admin');
    assert.equal(adminSends.length, 1);
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, 0);

    fs.chmodSync(accessFile, 0o600); // restore for cleanup
  });

  it('gracefully skips + loudly logs when adminChatId is null', () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ adminChatId: null });
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    assert.doesNotThrow(() => monitor.runFleetAlert({ currentTime: now }));
    // Users still notified; no admin send; loud log about missing adminChatId.
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, 2);
    assert.equal(calls.send.filter(s => s.endpoint === 'oc_admin').length, 0);
    assert.ok(calls.log.some(m => /adminChatId/i.test(m)));
  });
});
