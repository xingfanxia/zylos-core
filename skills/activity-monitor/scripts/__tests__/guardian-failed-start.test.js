// SWITCH-1: a persona whose engine fails to start is acted on, once, by the
// Guardian, and the downtime is recorded.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Guardian, MOVE_WAIT_SEC, START_CONFIRM_SEC, classifyFailedStart } from '../guardian.js';

const HELD_RETRY_SEC = 300;

// A persona whose launches never come up unless `world.up` is set; every
// launch returns `world.result` as the launcher's record.
function harness({ result, prepareError = null, initialStartFailure = null, fableMode = false } = {}) {
  const world = { up: false, result, launches: 0, alerts: [], log: [], nowMs: Date.parse('2026-11-17T02:00:00Z') };
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
    fableMode,
    initialStartFailure,
    heldRetrySec: HELD_RETRY_SEC,
    notifyStartHeld: details => world.alerts.push(details),
  });
  let t = 0;
  world.tickTo = async (until) => {
    while (t < until) {
      t += 1;
      world.nowMs += 1000;
      await guardian.tick({ currentTime: t, health: 'ok' });
    }
  };
  return { guardian, world };
}

const exited = { launch_id: 'L', state: 'exited', exit_code: 1, signal: null, ran_ms: 1800 };
const moduleMissing = { launch_id: 'L', state: 'launcher_failed', stage: 'modules', error_code: 'ERR_MODULE_NOT_FOUND',
  error: "Cannot find package 'dotenv' imported from /home/xingfanxia/zylos-core/cli/lib/runtime/tmux-env.js" };

describe('Guardian failed starts', () => {
  it('detects a launch with no live session by the deadline, retries it once, then asks for the next line on an account cause', async () => {
    const { guardian, world } = harness({ result: exited });
    await world.tickTo(5);
    assert.equal(world.launches, 1);

    await world.tickTo(45); // 30 grace ticks + the 10 s backoff: launch 1 is judged
    assert.equal(world.launches, 2, 'first failed start is retried as is');
    assert.equal(guardian.startStatus().start_failure.attempts, 1);
    assert.ok(world.log.some(line => /start failed on claude-ax-backup \(1 in a row, account\): engine exited after 2s \(exit 1\)/.test(line)));

    await world.tickTo(95); // launch 2 judged
    const failure = guardian.startStatus().start_failure;
    assert.equal(failure.class, 'account');
    assert.equal(failure.profile, 'claude-ax-backup');
    assert.equal(failure.attempts, 2);
    assert.equal(failure.held_since, null);
    assert.ok(world.log.some(line => line === 'Guardian: asking runtime-failover for the next line'));

    await world.tickTo(95 + MOVE_WAIT_SEC - 1);
    assert.equal(world.launches, 2, 'no third launch while runtime-failover moves the persona');
    assert.equal(world.alerts.length, 0);
  });

  it('holds and alerts once when no other line takes over', async () => {
    const { guardian, world } = harness({ result: exited });
    await world.tickTo(95 + MOVE_WAIT_SEC);
    assert.equal(world.alerts.length, 1);
    assert.equal(world.alerts[0].class, 'account');
    assert.ok(guardian.startStatus().start_failure.held_since);
    await world.tickTo(95 + MOVE_WAIT_SEC + HELD_RETRY_SEC - 1);
    assert.equal(world.launches, 2, 'held: no restart loop');
  });

  it('a local cause is held and alerted once with its launcher error, no chain move, and only a slow retry', async () => {
    const { guardian, world } = harness({ result: moduleMissing });
    await world.tickTo(95);
    const failure = guardian.startStatus().start_failure;
    assert.equal(failure.class, 'local', 'runtime-failover acts only on class account');
    assert.match(failure.cause, /^launcher modules: ERR_MODULE_NOT_FOUND Cannot find package 'dotenv'/);
    assert.ok(failure.held_since);
    assert.equal(world.alerts.length, 1);
    assert.match(world.alerts[0].cause, /ERR_MODULE_NOT_FOUND/);
    assert.ok(!world.log.some(line => line.includes('asking runtime-failover')));

    await world.tickTo(95 + HELD_RETRY_SEC - 1);
    assert.equal(world.launches, 2, 'no relaunch inside the hold window');
    await world.tickTo(95 + HELD_RETRY_SEC);
    assert.equal(world.launches, 3, 'one scheduled retry');
    await world.tickTo(95 + 2 * HELD_RETRY_SEC + 200);
    assert.equal(world.launches, 4, 'the failed retry stays held until the next window');
    assert.equal(world.alerts.length, 1, 'alerted once per episode');
  });

  it('a launcher that leaves no record at all is a local cause', () => {
    assert.equal(classifyFailedStart({ launchResult: null }).class, 'local');
    assert.equal(classifyFailedStart({ launchResult: { state: 'spawn_failed', error_code: 'ENOENT', error: 'spawn claude ENOENT' } }).class, 'account');
    assert.equal(classifyFailedStart({ prepareError: { class: 'local', message: 'Failed to chown launch spec' } }).class, 'local');
    assert.equal(classifyFailedStart({ prepareError: { class: 'account', message: 'auth.json has no API key' } }).class, 'account');
  });

  it('an in-process launch failure is captured as the prepare cause', async () => {
    const { guardian, world } = harness({ result: undefined,
      prepareError: new Error('Operator Tavily overlay does not match the managed Zylos scope') });
    await world.tickTo(95);
    const failure = guardian.startStatus().start_failure;
    assert.equal(failure.class, 'local');
    assert.equal(failure.cause, 'prepare: Operator Tavily overlay does not match the managed Zylos scope');
    assert.equal(world.alerts.length, 1);
  });

  it('records recovery: a held persona whose scheduled retry stays up is confirmed, with down-from, down-to and cause', async () => {
    const { guardian, world } = harness({ result: moduleMissing });
    await world.tickTo(95);
    world.upOnLaunch = true; // the operator fixed the ACL; the next scheduled launch comes up
    await world.tickTo(95 + HELD_RETRY_SEC + 1);
    assert.equal(world.launches, 3);
    assert.equal(guardian.startStatus().start_failure.class, 'local', 'not yet confirmed: still the open episode');
    await world.tickTo(95 + HELD_RETRY_SEC + START_CONFIRM_SEC + 2);
    const status = guardian.startStatus();
    assert.equal(status.start_failure, null);
    assert.ok(status.start_confirmed_at > 0);
    const line = world.log.find(entry => entry.startsWith('Guardian: start recovered on claude-ax-backup'));
    assert.match(line, /down from 2026-11-17T02:00:05\.000Z to 2026-11-17T02:\d\d:\d\d\.000Z \(\d+s, 2 failed starts; last cause: launcher modules/);
    assert.equal(world.alerts.length, 1);
  });

  it('a monitor restarted inside an episode keeps its start time and alert receipt, not its hold', async () => {
    const inherited = { since: '2026-11-17T01:00:00.000Z', attempts: 2, class: 'local', cause: 'launcher modules: x',
      held_since: '2026-11-17T01:01:00.000Z', alerted_at: '2026-11-17T01:01:00.000Z' };
    const { guardian, world } = harness({ result: moduleMissing, initialStartFailure: inherited });
    await world.tickTo(5);
    assert.equal(world.launches, 1, 'a fresh monitor tries again at once');
    await world.tickTo(95);
    const failure = guardian.startStatus().start_failure;
    assert.equal(failure.since, inherited.since);
    assert.equal(failure.attempts, 4);
    assert.equal(world.alerts.length, 0, 'the operator was already told about this episode');
  });

  it('a Fable-mode launch leaves the move to the Fable guard (no account-class request)', async () => {
    const { guardian, world } = harness({ result: exited, fableMode: true });
    await world.tickTo(95);
    assert.equal(guardian.startStatus().start_failure.class, 'fable');
    assert.ok(world.log.some(line => line.includes('waiting for the Fable guard')));
  });

  it('a session that ran past the confirm window and then died is a crash, not a failed start', async () => {
    const { guardian, world } = harness({ result: exited });
    world.up = true;
    guardian.startAgent();
    await world.tickTo(START_CONFIRM_SEC + 2);
    world.up = false;
    await world.tickTo(START_CONFIRM_SEC + 60);
    assert.equal(guardian.startStatus().start_failure, null);
    assert.equal(world.launches, 2);
  });
});
