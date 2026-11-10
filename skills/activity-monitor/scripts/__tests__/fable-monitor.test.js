import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createFableMonitor, LEASE_ENFORCEMENT_FILE, READINESS_FILE, UNCERTAIN_DELIVERIES_FILE } from '../fable-monitor.js';
import { SESSION_FAILURES_FILE } from '../fable-guard.js';
import { Guardian } from '../guardian.js';
import { writeRuntimeSwitchSignal } from '../runtime-switch-signal.js';
import {
  fableGuardStatePath,
  fableUsagePath,
  prepareFableLaunch,
  resolveRuntimeProfile,
} from '../../../multi-session/runtime-files.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T08:00:00Z');
const BACKUP = 'claude-ax-backup';
const FABLE = 'claude-fable-5-2[1m]';
const OPUS = 'claude-opus-5-5[1m]';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function fixture({ mode = 'fable', observedAt = T0 } = {}) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-monitor-'));
  dirs.push(zylosDir);
  const document = {
    fable_guard: { fable_model: FABLE },
    runtime_profiles: { [BACKUP]: { runtime: 'claude', usage_provider: BACKUP, model: OPUS, reasoning_effort: 'high',
      claude_settings_file: '/home/zylos-shared/auth/claude-ax-backup.settings.json' } },
    instances: { 'user-pan': { runtime: 'claude', runtime_profile: BACKUP, fable_enabled: true },
      admin: { runtime: 'claude', runtime_profile: BACKUP } },
  };
  fs.mkdirSync(path.join(zylosDir, 'activity-monitor', 'user-pan'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(document));
  const writeState = (desiredMode, generation = 3, holds = {}) => fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify({
    version: 1, generation_seq: generation, holds,
    personas: { 'user-pan': { desired: { account: BACKUP, mode: desiredMode, generation } } } }));
  const writeUsage = (atMs, utilization = 0.1) => fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify({ version: 1,
    accounts: { [BACKUP]: { last_valid: { utilization, resets_at: '2026-11-13T06:00:00.000Z', observed_at: new Date(atMs).toISOString() } } } }));
  writeState(mode);
  writeUsage(observedAt);
  const monitorDir = path.join(zylosDir, 'activity-monitor', 'user-pan');
  // The profile the monitor resolves once at start (getInstanceRuntimeProfile).
  const profile = resolveRuntimeProfile({ document, instanceId: 'user-pan',
    fableGuardState: JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')),
    fableUsage: JSON.parse(fs.readFileSync(fableUsagePath(zylosDir), 'utf8')), nowMs: T0 });
  // Guardian relaunch: the real adapter path re-evaluates the cached profile.
  const launch = nowMs => prepareFableLaunch({ profile, instanceId: 'user-pan', zylosDir, monitorDir, nowMs });
  return { zylosDir, monitorDir, profile, launch, writeState, writeUsage };
}

// The persona's tmux session as the monitor sees it: identity (sessionRef),
// liveness and the CLI's --model argument. A relaunch is a new session.
function monitorFor(fx, clock, extra = {}) {
  const calls = { stops: 0, logs: [], fenced: [] };
  const session = { ref: '$3:1762790000:%12:48211', alive: true, model: 'claude-fable-5-2', seq: 12 };
  session.relaunch = model => { session.seq += 1; session.ref = `$${session.seq}:1762791000:%${session.seq}:4${session.seq}00`;
    session.alive = true; session.model = model; };
  const monitor = createFableMonitor({
    zylosDir: fx.zylosDir, instanceId: 'user-pan', monitorDir: fx.monitorDir, runtimeProfile: fx.profile,
    stopSession: ref => { calls.stops += 1; if (ref === session.ref) session.alive = false; },
    readSessionRef: () => (session.alive ? session.ref : null),
    probeSession: ref => (session.alive && session.ref === ref ? 'present' : 'gone'),
    readProcessModel: () => (session.alive ? { model: session.model } : null),
    now: () => clock.now, log: message => calls.logs.push(message), fenceReplacedSession: ref => calls.fenced.push(ref), ...extra,
  });
  return { monitor, calls, session };
}

describe('Fable lease enforcement in the persona monitor (review #1)', () => {
  it('downgrades a running Fable session whose lease expired while the guard daemon is dead', () => {
    const fx = fixture();
    const clock = { now: T0 };
    assert.equal(fx.launch(clock.now).model, FABLE);
    const { monitor, calls, session } = monitorFor(fx, clock);
    clock.now = T0 + 5 * MIN;
    monitor.tick();
    assert.equal(calls.stops, 0, 'lease still fresh');
    clock.now = T0 + 12 * MIN + 1000; // lease expired, no daemon pass
    monitor.tick();
    assert.equal(calls.stops, 0, 'the daemon gets a grace period to act first');
    clock.now = T0 + 14 * MIN + 2000;
    monitor.tick();
    assert.equal(calls.stops, 1, 'the monitor forces the safe direction itself');
    const record = JSON.parse(fs.readFileSync(path.join(fx.monitorDir, LEASE_ENFORCEMENT_FILE), 'utf8'));
    assert.equal(record.reason, 'lease_expired');
    assert.deepEqual(calls.fenced, ['$3:1762790000:%12:48211'], 'keys bound to the stopped session are fenced');
    assert.ok(calls.logs.some(line => line.includes('ALERT')));
    assert.ok(JSON.parse(fs.readFileSync(path.join(fx.monitorDir, LEASE_ENFORCEMENT_FILE), 'utf8')).confirmed_at, 'observed gone');
    // Guardian relaunches the session through the cached profile: Opus.
    assert.equal(fx.launch(clock.now).model, OPUS);
    session.relaunch('claude-opus-5-5');
    clock.now += 10 * MIN;
    monitor.tick();
    assert.equal(calls.stops, 1, 'an Opus session is never touched');
  });

  it('leaves the transition to a live daemon that commits and restarts within the grace', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const { monitor, calls, session } = monitorFor(fx, clock);
    clock.now = T0 + 5 * MIN;
    fx.writeUsage(clock.now, 0.8); // the daemon reads 80% and commits Opus
    fx.writeState('opus', 4, { [BACKUP]: { quota: { since: new Date(clock.now).toISOString() } } });
    monitor.tick();
    clock.now += 20_000;
    fx.launch(clock.now); // its cold restart lands
    session.relaunch('claude-opus-5-5');
    clock.now += 10 * MIN;
    monitor.tick();
    assert.equal(calls.stops, 0);
  });

  it('is not created for a persona whose monitor started without a Fable decision', () => {
    const fx = fixture();
    const admin = resolveRuntimeProfile({ document: JSON.parse(fs.readFileSync(path.join(fx.zylosDir, 'instances.json'), 'utf8')),
      instanceId: 'admin' });
    assert.equal(createFableMonitor({ zylosDir: fx.zylosDir, instanceId: 'admin', monitorDir: fx.monitorDir, runtimeProfile: admin }), null);
  });
});

describe('Fable session crash accounting in the persona monitor (review #6)', () => {
  // A real Guardian over a fake pane: `alive` toggles what tmux/isRunning report.
  function guardianFor(fx, clock, monitor) {
    const pane = { alive: true, launches: 0 };
    const adapter = { sessionName: 'claude-user-pan', displayName: 'Claude',
      isRunning: async () => pane.alive,
      launch: () => { pane.launches += 1; pane.alive = true; fx.launch(clock.now); } };
    const guardian = new Guardian(adapter, { log: () => {}, nowMs: () => clock.now,
      execSyncImpl: cmd => { if (/has-session/.test(cmd) && !pane.alive) throw new Error('no session'); if (/pgrep/.test(cmd)) throw new Error('none'); return ''; },
      onAgentStart: info => monitor.guardianDeps.onAgentStart(info) });
    const run = async (ticks = 1) => { for (let i = 0; i < ticks; i++) { await guardian.tick({ currentTime: Math.floor(clock.now / 1000) }); clock.now += 1000; } };
    return { guardian, pane, run };
  }
  const failures = fx => (JSON.parse(fs.readFileSync(path.join(fx.monitorDir, SESSION_FAILURES_FILE), 'utf8')).failures || []);

  it('counts an unexpected exit of a Fable session, never planned or already-counted relaunches', async () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const { monitor } = monitorFor(fx, clock);
    const { pane, run } = guardianFor(fx, clock, monitor);
    await run(); // running
    pane.alive = false; // the CLI process died on its own
    await run(70);
    assert.equal(pane.launches, 1);
    assert.deepEqual(failures(fx).map(item => [item.reason, item.mode, item.runtime_profile]), [['unexpected_exit', 'fable', BACKUP]]);

    // A HealthEngine recovery kill is counted once (onRecoveryRestart), not again at the relaunch.
    await run(5);
    monitor.healthDeps.onRecoveryRestart('heartbeat_recovery_timeout');
    pane.alive = false;
    await run(70);
    assert.deepEqual(failures(fx).map(item => item.reason), ['unexpected_exit', 'heartbeat_recovery_timeout']);

    // A guard / failover / --apply transition writes a switch signal before its kill: planned.
    await run(5);
    writeRuntimeSwitchSignal({ zylosDir: fx.zylosDir, nowMs: clock.now, change: { instanceId: 'user-pan',
      fromProfile: BACKUP, toProfile: BACKUP, reason: 'fable_guard:opus:g4' } });
    pane.alive = false;
    await run(70);
    assert.equal(failures(fx).length, 2, 'planned transitions are excluded');
  });

  it('does not count an Opus session or the lease-enforcement stop', async () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const { monitor } = monitorFor(fx, clock);
    const { pane, run } = guardianFor(fx, clock, monitor);
    await run();
    clock.now = T0 + 15 * MIN;
    monitor.tick(); // lease expired: unadmitted from now
    clock.now += 3 * MIN;
    assert.ok(monitor.tick(), 'enforcement stops the session');
    pane.alive = false;
    await run(70);
    assert.equal(fs.existsSync(path.join(fx.monitorDir, SESSION_FAILURES_FILE)), false);
    assert.equal(monitor.readLaunch().mode, 'opus');
    pane.alive = false; // the Opus session dies
    await run(70);
    assert.equal(fs.existsSync(path.join(fx.monitorDir, SESSION_FAILURES_FILE)), false, 'Opus exits are not Fable failures');
  });

  it('records the readiness probe result for the current launch', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const { monitor } = monitorFor(fx, clock);
    assert.equal(monitor.healthDeps.guardReadiness.phase, 'post_restart');
    monitor.healthDeps.guardReadiness.onResult({ outcome: 'missing', status: 'timeout' });
    const record = JSON.parse(fs.readFileSync(path.join(fx.monitorDir, READINESS_FILE), 'utf8'));
    assert.deepEqual([record.launch_id, record.outcome, record.status], [monitor.readLaunch().launch_id, 'missing', 'timeout']);
  });
});

describe('Uncertain deliveries are named, not timestamped (review h / delivery_uncertain)', () => {
  it('alerts once per C4 delivery_uncertain record with the message preview and keeps it for status', async () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const rows = [{ id: 7, item_type: 'conversation', item_id: 4012, target_instance: 'user-pan', channel: 'feishu',
      endpoint_id: 'oc_1', session_ref: '$3:1762790000:%12:48211', dialog_kind: 'fable_limit', outcome: 'uncertain',
      detected_at: Math.floor(T0 / 1000), notified_at: null, preview: 'please send the Q3 report to Lin' }];
    const notified = [];
    const sent = [];
    const { monitor, calls } = monitorFor(fx, clock, { uncertainDeliveries: {
      list: () => rows.filter(row => !notified.includes(row.id)), markNotified: id => notified.push(id) },
    notifyOperator: async message => { sent.push(message); return { ok: true }; } });
    monitor.tick();
    await monitor.flushNotifications();
    clock.now += 20_000;
    monitor.tick();
    await monitor.flushNotifications();
    assert.deepEqual(notified, [7]);
    assert.equal(sent.length, 1, 'one operator notification');
    const alerts = calls.logs.filter(line => line.includes('delivery uncertain'));
    assert.equal(alerts.length, 1, 'surfaced once');
    assert.match(alerts[0], /conversation #4012/);
    assert.match(alerts[0], /please send the Q3 report to Lin/);
    const kept = JSON.parse(fs.readFileSync(path.join(fx.monitorDir, UNCERTAIN_DELIVERIES_FILE), 'utf8')).records;
    assert.deepEqual(kept.map(item => [item.id, item.item_id, item.preview]), [[7, 4012, 'please send the Q3 report to Lin']]);
  });
});

// ── Review #2: an attempt record is not a completion receipt ─────────────────
// A fake tmux world for the persona: the session the monitor would stop is
// identified by its sessionRef; the process model is the running CLI's
// --model argument.
function sessionWorld({ model = 'claude-fable-5-2' } = {}) {
  let seq = 12;
  const world = { ref: `$3:1762790000:%${seq}:48211`, alive: true, model, stops: [], failStops: 0 };
  world.replace = (nextModel) => { seq += 1; world.ref = `$${seq}:1762791000:%${seq}:4${seq}00`; world.alive = true; world.model = nextModel; };
  world.deps = {
    readSessionRef: () => (world.alive ? world.ref : null),
    readProcessModel: () => (world.alive ? { model: world.model } : null),
    probeSession: ref => (world.alive && world.ref === ref ? 'present' : 'gone'),
    stopSession: ref => {
      world.stops.push(ref);
      if (world.failStops > 0) { world.failStops -= 1; throw new Error('injected kill failure'); }
      if (world.alive && ref === world.ref) world.alive = false;
    },
  };
  return world;
}

function monitorInWorld(fx, clock, world, extra = {}) {
  const logs = [];
  const fenced = [];
  const monitor = createFableMonitor({
    zylosDir: fx.zylosDir, instanceId: 'user-pan', monitorDir: fx.monitorDir, runtimeProfile: fx.profile,
    now: () => clock.now, log: message => logs.push(message), fenceReplacedSession: ref => fenced.push(ref),
    ...world.deps, ...extra,
  });
  return { monitor, logs, fenced };
}

describe('Fable lease enforcement: stop intent is not completion (review-2 #1)', () => {
  it('failed stop then retry: a stop that did not take is retried with backoff and an ALERT until the session is gone', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const world = sessionWorld();
    world.failStops = 2; // the first two kills fail; the Fable session keeps running
    const { monitor, logs } = monitorInWorld(fx, clock, world);
    clock.now = T0 + 13 * MIN;
    monitor.tick(); // unadmitted from now
    clock.now += 3 * MIN;
    monitor.tick();
    assert.equal(world.stops.length, 1, 'first attempt');
    assert.equal(world.alive, true);
    for (let i = 0; i < 40 && world.alive; i++) { clock.now += 15_000; monitor.tick(); }
    assert.equal(world.alive, false, 'the unsafe session is eventually stopped');
    assert.equal(world.stops.length, 3, 'two failed attempts, then the one that took');
    assert.ok(logs.filter(line => /ALERT/.test(line) && /not confirmed/.test(line)).length >= 2, 'an ALERT while unresolved');
    const record = JSON.parse(fs.readFileSync(path.join(fx.monitorDir, LEASE_ENFORCEMENT_FILE), 'utf8'));
    assert.ok(record.confirmed_at, 'the receipt is the observed stop');
    // The confirmed stop is not repeated.
    const before = world.stops.length;
    for (let i = 0; i < 10; i++) { clock.now += 15_000; monitor.tick(); }
    assert.equal(world.stops.length, before);
  });

  it('a stop whose session is still there afterwards is not counted as done', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const world = sessionWorld();
    // The kill call "succeeds" but the session survives (e.g. wrong target, tmux race).
    const { monitor } = monitorInWorld(fx, clock, world, { stopSession: ref => { world.stops.push(ref); } });
    clock.now = T0 + 13 * MIN;
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    for (let i = 0; i < 20; i++) { clock.now += 15_000; monitor.tick(); }
    assert.ok(world.stops.length >= 2, `retried (${world.stops.length})`);
    const record = JSON.parse(fs.readFileSync(path.join(fx.monitorDir, LEASE_ENFORCEMENT_FILE), 'utf8'));
    assert.equal(record.confirmed_at ?? null, null);
  });
});

describe('Fable launch record is intent, not proof (review-2 #2)', () => {
  it('record write failure: a Fable decision whose launch record cannot be committed launches Opus', () => {
    const fx = fixture();
    const profile = prepareFableLaunch({ profile: fx.profile, instanceId: 'user-pan', zylosDir: fx.zylosDir, monitorDir: fx.monitorDir,
      nowMs: T0, writeRecord: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    assert.equal(profile.model, OPUS);
    assert.equal(profile.fable?.mode, 'opus');
    assert.equal(profile.fable?.reason, 'launch_record_failed');
    assert.equal(profile.launchEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1', 'the subagent pin stays');
  });

  it('a tracked session with no launch record is judged by the running process, not taken as safe', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    fs.rmSync(path.join(fx.monitorDir, 'fable-launch.json')); // the record is missing
    const world = sessionWorld({ model: 'claude-fable-5-2' }); // the process runs --model claude-fable-5-2
    const { monitor } = monitorInWorld(fx, clock, world);
    clock.now = T0 + 13 * MIN;
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    assert.equal(world.stops.length, 1, 'a Fable process past its lease is stopped');
  });

  it('an old Opus record does not hide a Fable process; a process confirmed on Opus is left alone', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.writeState('opus', 4);
    fx.launch(clock.now); // record: opus (intent)
    const world = sessionWorld({ model: 'claude-fable-5-2' }); // but the running process is Fable
    const { monitor } = monitorInWorld(fx, clock, world);
    clock.now = T0 + MIN;
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    assert.equal(world.stops.length, 1);

    const fx2 = fixture();
    const clock2 = { now: T0 };
    fx2.writeState('opus', 4);
    fx2.launch(clock2.now);
    const opus = sessionWorld({ model: 'claude-opus-5-5' });
    const { monitor: monitor2 } = monitorInWorld(fx2, clock2, opus);
    for (let i = 0; i < 30; i++) { clock2.now += 15_000; monitor2.tick(); }
    assert.equal(opus.stops.length, 0);
  });
});

describe('Fable lease enforcement shares the execution fence (review-2 #3)', () => {
  it('replacement during monitor enforcement: the daemon replaces the session after the admission check; the replacement Opus session is not stopped', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const world = sessionWorld();
    let replaced = false;
    // The daemon wins the per-persona execution claim just before the monitor
    // acts: it relaunches the persona on Opus (new launch record, new session).
    const lock = (lockPath, fn) => {
      if (!replaced && lockPath.includes('fable-exec')) {
        replaced = true;
        fx.writeState('opus', 4);
        fx.launch(clock.now);
        world.replace('claude-opus-5-5');
      }
      return fn();
    };
    const { monitor, logs } = monitorInWorld(fx, clock, world, { lock });
    clock.now = T0 + 13 * MIN;
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    assert.equal(replaced, true, 'the monitor claimed the same per-persona execution fence');
    assert.deepEqual(world.stops, [], 'the replacement was never stopped');
    assert.equal(world.alive, true);
    assert.ok(logs.some(line => /superseded/.test(line)));
  });

  it('skips while the daemon holds the persona execution claim, then acts on the same session', async () => {
    const { claimExecution, completeExecution } = await import('../fable-exec-claim.js');
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const world = sessionWorld();
    const { monitor } = monitorInWorld(fx, clock, world);
    const held = claimExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', nowMs: T0 + 15 * MIN,
      op: { owner: 'daemon', kind: 'restart', generation: 9, attempt: 1 } });
    assert.equal(held.ok, true);
    clock.now = T0 + 13 * MIN;
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    assert.deepEqual(world.stops, [], 'the daemon is executing for this persona');
    completeExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', token: held.token, outcome: 'failed', nowMs: clock.now });
    clock.now += 15_000;
    monitor.tick();
    assert.equal(world.stops.length, 1);
  });
});

describe('Uncertain-delivery notification needs a receipt (review-2 #6)', () => {
  it('notification failure: a row stays unnotified until the operator notification succeeds, retried with a bound', async () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const rows = [{ id: 7, item_type: 'conversation', item_id: 4012, target_instance: 'user-pan', channel: 'feishu',
      endpoint_id: 'oc_1', session_ref: '$3:1762790000:%12:48211', dialog_kind: 'fable_limit', outcome: 'uncertain',
      detected_at: Math.floor(T0 / 1000), notified_at: null, preview: 'please send the Q3 report to Lin' }];
    const notified = [];
    const sent = [];
    let failures = 2;
    const world = sessionWorld({ model: 'claude-fable-5-2' });
    const { monitor, logs } = monitorInWorld(fx, clock, world, {
      uncertainDeliveries: { list: () => rows.filter(row => !notified.includes(row.id)), markNotified: id => notified.push(id) },
      notifyOperator: async message => { sent.push(message); if (failures > 0) { failures -= 1; return { ok: false, output: 'feishu 503' }; } return { ok: true }; },
    });
    monitor.tick();
    await monitor.flushNotifications?.();
    assert.deepEqual(notified, [], 'a failed notification does not mark the row');
    assert.ok(logs.some(line => /ALERT/.test(line) && /not notified/.test(line)));
    clock.now += 15_000;
    monitor.tick();
    await monitor.flushNotifications?.();
    assert.equal(sent.length, 1, 'retried only after a backoff, not every tick');
    for (let i = 0; i < 40 && !notified.length; i++) { clock.now += 15_000; monitor.tick(); await monitor.flushNotifications?.(); }
    assert.deepEqual(notified, [7], 'marked once the notification succeeded');
    assert.equal(sent.length, 3);
    assert.match(sent.at(-1), /4012/);
    assert.match(sent.at(-1), /please send the Q3 report to Lin/);
  });
});
