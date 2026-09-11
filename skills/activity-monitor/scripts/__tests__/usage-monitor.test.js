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
      ...(Object.prototype.hasOwnProperty.call(overrides, 'usageProvider')
        ? { usageProvider: overrides.usageProvider }
        : {}),
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
      // Only forwarded when a test sets it, so omitting it exercises the
      // production default (4h) — pass 0 to opt out of the blind cooldown.
      ...(overrides.blindRealertCooldownSec !== undefined
        ? { blindRealertCooldownSec: overrides.blindRealertCooldownSec }
        : {}),
      c4Send: overrides.c4Send ?? ((channel, endpoint, message) => {
        calls.send.push({ channel, endpoint, message });
        return { ok: true, output: 'sent' };
      }),
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

// provider-usage.json fixture — the codexbar direct-read channel (shape mirrors
// update-provider-usage.js output; the fleet alert prefers this over statuslines).
function writeProviderUsage(dir, {
  fiveHour, weekly = 40, fetchedAtEpoch, available = true,
  fiveResetAt = '2026-07-12T05:50:00Z', weeklyResetAt = '2026-07-17T06:00:00Z',
} = {}) {
  const file = path.join(dir, 'activity-monitor', 'provider-usage.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const iso = new Date(fetchedAtEpoch * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({
    updated_at: iso,
    providers: {
      claude: {
        provider: 'claude',
        available,
        fetched_at: iso,
        primary: { used_percent: fiveHour, window_minutes: 300, resets_at: fiveResetAt, reset_description: '5:50am(UTC)' },
        secondary: { used_percent: weekly, window_minutes: 10080, resets_at: weeklyResetAt, reset_description: 'Jul17,6am(UTC)' },
      },
    },
  }));
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

  it('disables subscription monitoring for an API-backed Codex profile', async () => {
    const { monitor, calls } = makeMonitor({ runtimeId: 'codex', usageProvider: null });
    assert.equal(monitor.isMonitorEnabled(), false);
    assert.equal(monitor.isAlertEnabled(), false);
    assert.equal(monitor.canRunTask({
      claudeState: 'idle', idleSeconds: 100, currentTime: 1000, apiActivity: {},
    }), false);
    assert.equal(monitor.runMonitor({ currentTime: 1000 }), true);
    assert.equal(monitor.runAlert({ currentTime: 1000 }), true);
    assert.equal(await monitor.runFleetAlert({ currentTime: 1000 }), true);
    assert.deepEqual(calls.control, []);
    assert.deepEqual(calls.send, []);
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
  it('fans out to users + admin when >=3 fresh sources agree (median quorum)', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);

    const userSends = calls.send.filter(s => s.endpoint !== 'oc_admin');
    const adminSends = calls.send.filter(s => s.endpoint === 'oc_admin');
    assert.deepEqual(userSends.map(s => s.endpoint).sort(), ['oc_limh', 'oc_pan']);
    assert.equal(adminSends.length, 1);
  });

  it('median ignores a single forged outlier (1 forged high among 2 ok → no alert)', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    // Two honest instances read 20% (ok); one forges 99%. Median 5h = 20 → ok.
    writeRateLimitStatusline(statuslineFileFor('admin'), { fiveHour: 20, weekly: 10 }, now);
    writeRateLimitStatusline(statuslineFileFor('user-pan'), { fiveHour: 20, weekly: 10 }, now);
    writeRateLimitStatusline(statuslineFileFor('user-limh'), { fiveHour: 99, weekly: 99 }, now);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);
    assert.deepEqual(calls.send, []);
  });

  it('with only 1-2 fresh sources, alerts admin only and names the sources (no user fan-out)', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan'], { fiveHour: 96, weekly: 20 }, now);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);

    const userSends = calls.send.filter(s => s.endpoint !== 'oc_admin');
    const adminSends = calls.send.filter(s => s.endpoint === 'oc_admin');
    assert.equal(userSends.length, 0, 'no user fan-out below quorum');
    assert.equal(adminSends.length, 1);
    assert.match(adminSends[0].message, /admin|user-pan/); // source instances named
    assert.match(adminSends[0].message, /2/); // usable-source count surfaced
  });

  it('does not alert on a non-primary instance', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ isPrimary: () => false });
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 99, weekly: 99 }, now);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);
    assert.deepEqual(calls.send, []);
  });

  it('user floor: tier=warning notifies admin only, no user sends', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 72, weekly: 10 }, now);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].endpoint, 'oc_admin');
  });

  it('dedupes same {tier, window}, re-fires on escalation, re-arms on raw-epoch window reset', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];

    seed(statuslineFileFor, ids, { fiveHour: 88, weekly: 10, fiveResetAt: 1900000020 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    const afterFirst = calls.send.length;
    assert.ok(afterFirst > 0, 'first crossing fires');

    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 88, weekly: 10, fiveResetAt: 1900000020 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, afterFirst, 'same tier + window suppressed');

    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000020 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    const afterEsc = calls.send.length;
    assert.ok(afterEsc > afterFirst, 'escalation re-fires');

    // New window: SAME wall-clock minute (formats to same HH:MM string) but a
    // different raw resets_at epoch. Formatted-string keying would wrongly
    // suppress; raw-epoch keying re-arms. (F6)
    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000050 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    assert.ok(calls.send.length > afterEsc, 'window reset (raw epoch) re-arms');
  });

  it('independent user rate limit throttles user re-blast on window churn (admin still fires)', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ userAlertMinIntervalSec: 1800 });
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];

    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900000020 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    const users1 = calls.send.filter(s => s.endpoint !== 'oc_admin').length;
    assert.equal(users1, 2, 'users notified on first crossing');

    // New window 120s later (churn) → admin re-fires, users throttled (< 1800s).
    now += 120;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900018000 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, users1, 'users throttled on churn');
    assert.equal(calls.send.filter(s => s.endpoint === 'oc_admin').length, 2, 'admin still fires');

    // Past the user interval + a new window → users fire again.
    now += 1801;
    seed(statuslineFileFor, ids, { fiveHour: 96, weekly: 10, fiveResetAt: 1900036000 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, users1 + 2, 'users notified after interval');
  });

  it('admin text carries 5h% + tier-switch CTA + usable count; user text is zh and short', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    await monitor.runFleetAlert({ currentTime: now });

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

  it('no usable readings emits exactly one monitoring-blind admin alert per episode', async () => {
    // cooldown 0 → pure episode semantics (the flap cooldown has its own test below)
    const { monitor, calls, statuslineFileFor } = makeMonitor({ statuslineStaleSec: 900, blindRealertCooldownSec: 0 });
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];
    seed(statuslineFileFor, ids, { fiveHour: 99, weekly: 99 }, now - 1000); // stale

    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 1, 'one blind alert');
    assert.equal(calls.send[0].endpoint, 'oc_admin');
    assert.match(calls.send[0].message, /失明|statusline/);

    // Still blind, even after a full stale-window elapses → no re-fire (per episode).
    await monitor.runFleetAlert({ currentTime: now + 5000 });
    assert.equal(calls.send.length, 1, 'blind alert deduped for whole episode');

    // A fresh valid reading clears the episode; going blind again re-alerts.
    now += 6000;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now); // fresh ok → clears blind
    await monitor.runFleetAlert({ currentTime: now });
    now += 6000;
    seed(statuslineFileFor, ids, { fiveHour: 99, weekly: 99 }, now - 2000); // stale again
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 2, 'new blind episode re-alerts');
  });

  it('flapping blindness is capped by the persistent re-alert cooldown (default 4h)', async () => {
    // Regression (2026-07-12): statusline files only refresh while an instance
    // actively renders turns, so short scheduled turns made blindness FLAP —
    // each brief recovery cleared the episode and the next expiry re-alerted:
    // 12 identical blind alerts in 6h. The cooldown survives recovery.
    const { monitor, calls, statuslineFileFor } = makeMonitor({ statuslineStaleSec: 900 }); // no override → default 4h
    let now = Math.floor(Date.now() / 1000);
    const ids = ['admin', 'user-pan', 'user-limh'];

    seed(statuslineFileFor, ids, { fiveHour: 50, weekly: 50 }, now - 1000); // stale → blind
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 1, 'first blind alert fires');

    // Flap: a short turn freshens the files (episode clears) …
    now += 1200;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now);
    await monitor.runFleetAlert({ currentTime: now });
    // … then they re-expire 20min later → new episode, but within cooldown.
    now += 1200;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now - 1000);
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 1, 'flap within cooldown suppressed');
    assert.ok(calls.log.some((l) => l.includes('re-alert suppressed (cooldown')), 'suppression is logged');

    // Same flap AFTER the cooldown elapses → re-alerts.
    now += 4 * 60 * 60;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now);       // recover
    await monitor.runFleetAlert({ currentTime: now });
    now += 1200;
    seed(statuslineFileFor, ids, { fiveHour: 10, weekly: 10 }, now - 1000); // blind again
    await monitor.runFleetAlert({ currentTime: now });
    assert.equal(calls.send.length, 2, 'post-cooldown flap re-alerts');
  });

  describe('provider direct-read source (provider-usage.json preferred over statuslines)', () => {
    const IDS = ['admin', 'user-pan', 'user-limh'];

    it('fresh provider read drives the alert alone — quorum without any statusline file', async () => {
      const { dir, monitor, calls } = makeMonitor();
      const now = Math.floor(Date.now() / 1000);
      writeProviderUsage(dir, { fiveHour: 96, weekly: 20, fetchedAtEpoch: now - 120 });

      await monitor.runFleetAlert({ currentTime: now });

      const admin = calls.send.find(s => s.endpoint === 'oc_admin');
      assert.ok(admin, 'admin alerted from provider read');
      assert.match(admin.message, /96/);
      assert.match(admin.message, /直读/);
      // single trusted source == quorum → tier>=high fans out to users
      assert.ok(calls.send.some(s => s.endpoint === 'oc_pan'), 'user fan-out on provider quorum');
    });

    it('fresh provider=ok wins over stale statuslines — no blind, no alert (long-busy-turn scenario)', async () => {
      const { dir, monitor, calls, statuslineFileFor } = makeMonitor();
      const now = Math.floor(Date.now() / 1000);
      seed(statuslineFileFor, IDS, { fiveHour: 99, weekly: 99 }, now - 5000); // stale junk
      writeProviderUsage(dir, { fiveHour: 10, weekly: 10, fetchedAtEpoch: now - 60 });

      await monitor.runFleetAlert({ currentTime: now });
      assert.deepEqual(calls.send, [], 'provider says ok → silence, despite stale statuslines');
    });

    it('a stale provider read falls back to the statusline scan', async () => {
      const { dir, monitor, calls, statuslineFileFor } = makeMonitor();
      const now = Math.floor(Date.now() / 1000);
      writeProviderUsage(dir, { fiveHour: 5, weekly: 5, fetchedAtEpoch: now - 3600 }); // 60m > 15m cap
      seed(statuslineFileFor, IDS, { fiveHour: 96, weekly: 20 }, now);                 // fresh critical

      await monitor.runFleetAlert({ currentTime: now });

      const admin = calls.send.find(s => s.endpoint === 'oc_admin');
      assert.ok(admin, 'fallback alert fires from statusline data');
      assert.match(admin.message, /96/);
      assert.match(admin.message, /statusline/);
      assert.ok(calls.log.some(l => l.includes('falling back to statusline scan')), 'fallback is logged');
    });

    it('BOTH channels down → blind alert names the provider failure', async () => {
      const { dir, monitor, calls } = makeMonitor();
      const now = Math.floor(Date.now() / 1000);
      writeProviderUsage(dir, { fiveHour: 5, fetchedAtEpoch: now - 3600 }); // stale(60m)
      // no statusline files at all → fallback has 0 usable sources

      await monitor.runFleetAlert({ currentTime: now });

      assert.equal(calls.send.length, 1, 'blind alert fires once');
      assert.match(calls.send[0].message, /失明/);
      assert.match(calls.send[0].message, /stale\(60m\)/);
      assert.match(calls.send[0].message, /provider-usage-updater/);
    });

    it('provider resets_at is the dedupe key: same window suppressed, new window re-arms', async () => {
      const { dir, monitor, calls } = makeMonitor();
      let now = Math.floor(Date.now() / 1000);

      writeProviderUsage(dir, { fiveHour: 72, weekly: 10, fetchedAtEpoch: now, fiveResetAt: '2026-07-12T05:00:00Z' });
      await monitor.runFleetAlert({ currentTime: now });
      assert.equal(calls.send.length, 1, 'warning fires (admin only)');

      now += 120;
      writeProviderUsage(dir, { fiveHour: 74, weekly: 10, fetchedAtEpoch: now, fiveResetAt: '2026-07-12T05:00:00Z' });
      await monitor.runFleetAlert({ currentTime: now });
      assert.equal(calls.send.length, 1, 'same tier + same resets_at suppressed');

      now += 120;
      writeProviderUsage(dir, { fiveHour: 74, weekly: 10, fetchedAtEpoch: now, fiveResetAt: '2026-07-12T10:00:00Z' });
      await monitor.runFleetAlert({ currentTime: now });
      assert.equal(calls.send.length, 2, 'new 5h window re-arms');
    });
  });

  it('logs cross-instance read failures loudly, distinguishing EACCES from ENOENT', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor();
    const now = Math.floor(Date.now() / 1000);
    // admin: fresh valid (the only usable source). user-pan: unreadable (EACCES).
    // user-limh: never written (ENOENT — benign).
    writeRateLimitStatusline(statuslineFileFor('admin'), { fiveHour: 96, weekly: 20 }, now);
    const accessFile = statuslineFileFor('user-pan');
    writeRateLimitStatusline(accessFile, { fiveHour: 96, weekly: 20 }, now);
    fs.chmodSync(accessFile, 0o000);

    assert.equal(await monitor.runFleetAlert({ currentTime: now }), true);

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

  it('gracefully skips + loudly logs when adminChatId is null', async () => {
    const { monitor, calls, statuslineFileFor } = makeMonitor({ adminChatId: null });
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    await monitor.runFleetAlert({ currentTime: now });
    // Users still notified; no admin send; loud log about missing adminChatId.
    assert.equal(calls.send.filter(s => s.endpoint !== 'oc_admin').length, 2);
    assert.equal(calls.send.filter(s => s.endpoint === 'oc_admin').length, 0);
    assert.ok(calls.log.some(m => /adminChatId/i.test(m)));
  });

  it('REL-9: fan-out dispatches all sends concurrently (never blocks per-recipient) and counts accurately', async () => {
    // A c4Send that only resolves when we release it — proves the fan-out
    // dispatches EVERY send before awaiting any (concurrent), and that userSends/
    // adminSent are tallied correctly once the promises settle.
    const dispatched = [];
    const resolvers = [];
    const c4Send = (channel, endpoint, message) => {
      dispatched.push(endpoint);
      return new Promise((resolve) => { resolvers.push(() => resolve({ ok: true, output: 'sent' })); });
    };
    const { monitor, calls, statuslineFileFor } = makeMonitor({ c4Send });
    const now = Math.floor(Date.now() / 1000);
    seed(statuslineFileFor, ['admin', 'user-pan', 'user-limh'], { fiveHour: 96, weekly: 20 }, now);

    const done = monitor.runFleetAlert({ currentTime: now }); // do NOT await yet
    await Promise.resolve(); // let the synchronous fan-out dispatch run

    // 2 users + 1 admin all dispatched while every send is still pending — i.e.
    // no send blocked the loop waiting for the previous one to complete.
    assert.equal(dispatched.length, 3, 'all 3 sends dispatched before any resolved');
    assert.ok(dispatched.includes('oc_admin') && dispatched.includes('oc_pan') && dispatched.includes('oc_limh'));

    resolvers.forEach((r) => r()); // release all sends
    assert.equal(await done, true);

    // Accurate accounting only observable after the awaited promises settled.
    const delivered = calls.log.find((m) => /delivered tier=/.test(m));
    assert.ok(delivered, 'delivery summary logged');
    assert.match(delivered, /users=2/);
    assert.match(delivered, /admin=1/);
  });
});

// REL-9b finding #7: the scheduler calls runFleetAlert synchronously and does NOT
// await it. Two invariants protect the liveness supervisor:
//   - the sync prologue (primary gate + run-marker) runs BEFORE the first await,
//     so interval re-entry gating holds even though the body is fire-and-forget;
//   - the .catch net turns any rejection from the async body into a logged,
//     resolved(true) — a dropped send edge can never surface as an unhandled
//     rejection that crashes the monitor.
describe('UsageMonitor fleet alert — crash-net & sync re-entry marker (REL-9b)', () => {
  it('nets an unexpected error from the async body: logs it, resolves true, never rejects', async () => {
    // statuslineFileFor is invoked INSIDE _runFleetAlertInner (after the sync
    // prologue); throwing there rejects the inner promise → the .catch must absorb it.
    const { monitor, calls } = makeMonitor({
      statuslineFileFor: () => { throw new Error('boom inside inner'); },
    });
    const now = Math.floor(Date.now() / 1000);

    const p = monitor.runFleetAlert({ currentTime: now });
    await assert.doesNotReject(p);
    assert.equal(await p, true);
    assert.ok(
      calls.log.some((m) => /unexpected error/.test(m)),
      'the .catch net logs the swallowed error',
    );
    assert.deepEqual(calls.send, [], 'the doomed run sent nothing');
  });

  it('sets lastFleetAlertAt synchronously (run-marker) before the async body awaits', () => {
    // The inner body throws, but the marker must already be set by the sync
    // prologue at the moment runFleetAlert returns — proving re-entry gating is
    // synchronous and does not depend on the awaited body completing.
    const { monitor } = makeMonitor({
      statuslineFileFor: () => { throw new Error('inner'); },
    });
    const now = Math.floor(Date.now() / 1000);
    assert.equal(monitor.lastFleetAlertAt, 0);

    const p = monitor.runFleetAlert({ currentTime: now });
    assert.equal(monitor.lastFleetAlertAt, now, 'run-marker set before we await the body');

    return p; // let the netted rejection settle (resolves true)
  });

  it('non-primary short-circuits synchronously and does not stamp the run-marker', () => {
    const { monitor, calls } = makeMonitor({ isPrimary: () => false });
    const now = Math.floor(Date.now() / 1000);

    const r = monitor.runFleetAlert({ currentTime: now });
    assert.equal(r, true, 'returns a plain true (no promise created past the primary gate)');
    assert.equal(monitor.lastFleetAlertAt, 0, 'non-primary never advances the run-marker');
    assert.deepEqual(calls.send, []);
  });
});
