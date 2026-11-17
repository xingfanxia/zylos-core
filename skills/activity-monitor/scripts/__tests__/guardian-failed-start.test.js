// SWITCH-1: a persona whose engine fails to start is noticed, retried once,
// then held with one operator alert; the downtime is recorded. A failed start
// never moves the persona: runtime-failover acts only on its own signals.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// runtime-failover reads ZYLOS_DIR at import: point it at a sandbox first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch1-'));
process.env.ZYLOS_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { Guardian, START_CONFIRM_SEC, MAX_ALERT_ATTEMPTS, describeFailedStart } = await import('../guardian.js');
const { applyRuntimeFailover } = await import('../runtime-failover.js');

const HELD_RETRY_SEC = 300;
const T0 = Date.parse('2026-11-17T02:00:00Z');

// A persona whose launches never come up unless `world.up` is set (or
// `upOnLaunch`); every launch leaves `world.result` as the launcher's record.
function harness({ result, prepareError = null, initialStartFailure = null, inheritHold = false, notify } = {}) {
  const world = { up: false, upOnLaunch: false, result, launches: 0, alerts: [], log: [], nowMs: T0, t: 0 };
  const adapter = {
    sessionName: 'claude-user-sean',
    displayName: 'Claude Code',
    isRunning: async () => world.up,
    launch: async () => {
      world.launches++;
      if (prepareError) throw prepareError;
      if (world.upOnLaunch) world.up = true;
    },
    readLaunchResult: () => world.result,
  };
  const guardian = new Guardian(adapter, {
    log: message => world.log.push(message),
    execSyncImpl: command => {
      if (command.startsWith('tmux has-session') && world.up) return '';
      throw new Error('absent');
    },
    nowMs: () => world.nowMs,
    profileId: 'claude-ax-backup',
    initialStartFailure,
    inheritHold,
    heldRetrySec: HELD_RETRY_SEC,
    notifyStartHeld: notify || (details => { world.alerts.push(details); return Promise.resolve({ ok: true }); }),
  });
  world.tickTo = async (until) => {
    while (world.t < until) {
      world.t += 1;
      world.nowMs += 1000;
      await guardian.tick({ currentTime: world.t, health: 'ok' });
      await new Promise(setImmediate); // let an alert receipt settle
    }
  };
  return { guardian, world };
}

const exited = (extra = {}) => ({ launch_id: 'L', state: 'exited', exit_code: 1, signal: null, ran_ms: 1800, ...extra });
const moduleMissing = { launch_id: 'L', state: 'launcher_failed', stage: 'modules', error_code: 'ERR_MODULE_NOT_FOUND',
  error: "Cannot find package 'dotenv' imported from /home/xingfanxia/zylos-core/cli/lib/runtime/tmux-env.js" };

// The real planner over real files: the persona's agent-status as the monitor
// writes it (health from the HealthEngine, which stays ok while the Guardian
// relaunches, plus the Guardian's start facts).
const CHAIN = ['claude-ax-backup', 'claude-ax-cl', 'claude-ax-main'];
function planner(statuses) {
  const instances = {};
  for (const [id, status] of Object.entries(statuses)) {
    const stateDir = path.join(root, 'state', id);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'agent-status.json'), JSON.stringify(status));
    instances[id] = { enabled: true, runtime: 'claude', runtime_profile: 'claude-ax-backup', runtime_failover_enabled: true,
      runtime_profile_changed_at: new Date(T0 - 3600_000).toISOString(), state_dir: stateDir, tmux_session: `claude-${id}` };
  }
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
    runtime_profiles: Object.fromEntries(CHAIN.map(id => [id, { runtime: 'claude', usage_provider: id }])),
    runtime_failover: { enabled: true, chain: CHAIN, switch_threshold: 95, recover_threshold: 90, min_dwell_sec: 300, auto_recover: true },
    instances,
  }));
  const seen = { available: true, quota_authoritative: true, observed_at: new Date(T0).toISOString(),
    primary: { used_percent: 40, resets_at: '2099-01-01T00:00:00Z' } };
  const calls = [];
  const changes = applyRuntimeFailover({
    providerUsage: { providers: Object.fromEntries(CHAIN.map(id => [id, seen])) },
    nowMs: T0, log: () => {}, zylosDir: root,
    execFileSyncImpl: (command, args) => { calls.push([command, ...args]); return ''; },
  });
  return { changes, calls, document: JSON.parse(fs.readFileSync(path.join(root, 'instances.json'), 'utf8')) };
}
const statusOf = guardian => ({ health: 'ok', state: 'offline', runtime_profile: 'claude-ax-backup', ...guardian.startStatus() });

describe('Guardian failed starts', () => {
  it('a launch with no live session by the deadline is a failed start, retried once on the same profile; the planner does not move it (t=45 s)', async () => {
    const { guardian, world } = harness({ result: exited() });
    await world.tickTo(5);
    assert.equal(world.launches, 1);
    await world.tickTo(45); // 30 grace ticks + the 10 s backoff: launch 1 judged, retry issued
    assert.equal(world.launches, 2, 'first failed start is retried as is');
    assert.equal(guardian.startStatus().start_failure.attempts, 1);
    assert.ok(world.log.some(line => /start failed on claude-ax-backup \(1 in a row\): engine exited after 2s \(exit 1\)/.test(line)));

    const at45 = planner({ 'user-sean': statusOf(guardian) });
    assert.deepEqual(at45.changes, [], 'no move while the same-profile retry starts');
    assert.deepEqual(at45.calls, [], 'no tmux kill, no pm2 restart');
    assert.equal(at45.document.instances['user-sean'].runtime_profile, 'claude-ax-backup');
    assert.equal(at45.document.instances['user-sean'].runtime_failover_blocked_profiles, undefined, 'no block');
  });

  it('(harness check) the same planner does move a persona on its own health signal', () => {
    const moved = planner({ 'user-pan': { health: 'auth_failed', state: 'idle', runtime_profile: 'claude-ax-backup' } });
    assert.equal(moved.changes[0]?.toProfile, 'claude-ax-cl');
    assert.ok(moved.calls.some(call => call[0] === 'pm2'));
  });

  for (const [label, result] of [
    ['a generic exit', exited()],
    ['EACCES', { launch_id: 'L', state: 'spawn_failed', error_code: 'EACCES', error: 'spawn /usr/bin/claude EACCES' }],
    ['SIGSEGV', exited({ exit_code: null, signal: 'SIGSEGV' })],
    ['a broken launcher module', moduleMissing],
  ]) {
    it(`${label}: held after the second failure with one alert, no chain walk and no restart loop`, async () => {
      const { guardian, world } = harness({ result });
      await world.tickTo(95); // launch 2 judged
      const failure = guardian.startStatus().start_failure;
      assert.equal(failure.attempts, 2);
      assert.ok(failure.held_since);
      assert.equal(world.alerts.length, 1);
      assert.ok(failure.alerted_at, 'recorded after the verified send');

      const held = planner({ 'user-sean': statusOf(guardian) });
      assert.deepEqual(held.changes, []);
      assert.deepEqual(held.calls, []);

      await world.tickTo(95 + HELD_RETRY_SEC - 1);
      assert.equal(world.launches, 2, 'no relaunch inside the hold window');
      await world.tickTo(95 + HELD_RETRY_SEC);
      assert.equal(world.launches, 3, 'one scheduled retry');
      await world.tickTo(95 + 2 * HELD_RETRY_SEC + 100);
      assert.equal(world.launches, 4, 'the failed retry stays held until the next window');
      assert.equal(world.alerts.length, 1, 'alerted once per episode');
    });
  }

  it('describes each cause from the launch path', () => {
    assert.match(describeFailedStart({ launchResult: moduleMissing }), /^launcher modules: ERR_MODULE_NOT_FOUND Cannot find package 'dotenv'/);
    assert.equal(describeFailedStart({ launchResult: null }), 'launcher left no record (sudo, node or the launcher failed before running)');
    assert.equal(describeFailedStart({ prepareError: 'Operator Tavily overlay does not match the managed Zylos scope' }),
      'prepare: Operator Tavily overlay does not match the managed Zylos scope');
    assert.equal(describeFailedStart({ launchResult: exited({ exit_code: null, signal: 'SIGSEGV' }) }), 'engine exited after 2s (signal SIGSEGV)');
  });

  it('an in-process launch failure is captured as the prepare cause', async () => {
    const { guardian, world } = harness({ result: undefined,
      prepareError: new Error('Operator Tavily overlay does not match the managed Zylos scope') });
    await world.tickTo(95);
    assert.equal(guardian.startStatus().start_failure.cause, 'prepare: Operator Tavily overlay does not match the managed Zylos scope');
    assert.equal(world.alerts.length, 1);
  });

  it('a sibling\'s success changes nothing for the held persona', async () => {
    const { guardian, world } = harness({ result: exited() });
    await world.tickTo(95);
    const before = structuredClone(guardian.startStatus());
    const sibling = { health: 'ok', state: 'idle', runtime_profile: 'claude-ax-backup', functional_ack_at: T0 + 90_000,
      start_confirmed_at: T0 + 80_000, start_failure: null };
    const planned = planner({ 'user-sean': statusOf(guardian), 'user-elaine': sibling });
    assert.deepEqual(planned.changes, []);
    await world.tickTo(95 + HELD_RETRY_SEC - 1);
    assert.equal(world.launches, 2);
    assert.deepEqual(guardian.startStatus(), before);
  });

  it('a throwing or failing notifier persists no "alerted"; the send is retried at the retry windows, bounded', async () => {
    let calls = 0;
    const { guardian, world } = harness({ result: exited(), notify: () => {
      calls++;
      if (calls === 1) throw new Error('c4-send crashed');
      return Promise.resolve({ ok: false, output: 'exit 1' });
    } });
    await world.tickTo(95);
    assert.equal(calls, 1);
    assert.equal(guardian.startStatus().start_failure.alerted_at, null);
    assert.ok(world.log.some(line => line.includes('alert not delivered (c4-send crashed)')));
    await world.tickTo(95 + 5 * HELD_RETRY_SEC);
    assert.equal(calls, MAX_ALERT_ATTEMPTS, 'retried at the next windows, then given up');
    assert.equal(guardian.startStatus().start_failure.alerted_at, null);
    assert.ok(world.log.some(line => line.endsWith('not retried')));
  });

  it('a missing admin destination is logged once and not retried', async () => {
    let calls = 0;
    const { guardian, world } = harness({ result: exited(),
      notify: () => { calls++; return Promise.resolve({ ok: false, output: 'no admin chat_id configured', permanent: true }); } });
    await world.tickTo(95 + 3 * HELD_RETRY_SEC);
    assert.equal(calls, 1);
    assert.equal(world.log.filter(line => line.includes('no admin chat_id configured')).length, 1);
    assert.equal(guardian.startStatus().start_failure.alerted_at, null);
  });

  it('a send that failed is retried by the next monitor too (no alerted_at was inherited)', async () => {
    const inherited = { since: '2026-11-17T01:00:00.000Z', profile: 'claude-ax-backup', attempts: 2, cause: 'engine exited after 2s (exit 1)',
      held_since: '2026-11-17T01:01:00.000Z', next_attempt_at: '2026-11-17T01:21:00.000Z', alerted_at: null, alert_attempts: 1,
      alert_error: 'exit 1' };
    const { world } = harness({ result: exited(), initialStartFailure: inherited, inheritHold: true });
    await world.tickTo(5);
    assert.equal(world.alerts.length, 1, 'the due retry window also retries the alert');
  });

  it('records recovery: a held persona whose scheduled retry stays up is confirmed, with down-from, down-to and cause', async () => {
    const { guardian, world } = harness({ result: moduleMissing });
    await world.tickTo(95);
    world.upOnLaunch = true; // the operator fixed the ACL; the next scheduled launch comes up
    await world.tickTo(95 + HELD_RETRY_SEC + 1);
    assert.equal(world.launches, 3);
    assert.ok(guardian.startStatus().start_failure, 'not yet confirmed: still the open episode');
    await world.tickTo(95 + HELD_RETRY_SEC + START_CONFIRM_SEC + 2);
    const status = guardian.startStatus();
    assert.equal(status.start_failure, null);
    assert.ok(status.start_confirmed_at > 0);
    const line = world.log.find(entry => entry.startsWith('Guardian: start recovered on claude-ax-backup'));
    assert.match(line, /down from 2026-11-17T02:00:05\.000Z to 2026-11-17T02:\d\d:\d\d\.000Z \(\d+s, 2 failed starts; last cause: launcher modules/);
  });

  it('a plain monitor restart keeps the 20-minute hold; a runtime switch (inheritHold false) gets an immediate attempt', async () => {
    const inherited = { since: '2026-11-17T01:50:00.000Z', profile: 'claude-ax-backup', attempts: 2, cause: 'engine exited after 2s (exit 1)',
      held_since: '2026-11-17T01:59:00.000Z', next_attempt_at: '2026-11-17T02:04:00.000Z', alerted_at: '2026-11-17T01:59:01.000Z',
      alert_attempts: 1 };
    const kept = harness({ result: exited(), initialStartFailure: inherited, inheritHold: true });
    await kept.world.tickTo(200);
    assert.equal(kept.world.launches, 0, 'still inside the persisted window');
    await kept.world.tickTo(245);
    assert.equal(kept.world.launches, 1, 'retried when the persisted window opens');
    assert.equal(kept.world.alerts.length, 0, 'already alerted for this episode');

    const switched = harness({ result: exited(), initialStartFailure: inherited, inheritHold: false });
    await switched.world.tickTo(5);
    assert.equal(switched.world.launches, 1, 'the new tier is tried at once');
    assert.equal(switched.guardian.startStatus().start_failure.since, inherited.since, 'same downtime episode');

    const otherProfile = harness({ result: exited(), initialStartFailure: { ...inherited, profile: 'claude-ax-cl' }, inheritHold: true });
    await otherProfile.world.tickTo(5);
    assert.equal(otherProfile.world.launches, 1, 'a hold never carries over to another profile');
  });

  it('a session that ran past the confirm window and then died is a crash, not a failed start', async () => {
    const { guardian, world } = harness({ result: exited() });
    world.up = true;
    guardian.startAgent();
    await world.tickTo(START_CONFIRM_SEC + 2);
    world.up = false;
    await world.tickTo(START_CONFIRM_SEC + 60);
    assert.equal(guardian.startStatus().start_failure, null);
    assert.equal(world.launches, 2);
  });
});
