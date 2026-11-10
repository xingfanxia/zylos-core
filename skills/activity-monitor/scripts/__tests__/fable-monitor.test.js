import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createFableMonitor, LEASE_ENFORCEMENT_FILE } from '../fable-monitor.js';
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

function monitorFor(fx, clock, extra = {}) {
  const calls = { stops: 0, logs: [] };
  const monitor = createFableMonitor({
    zylosDir: fx.zylosDir, instanceId: 'user-pan', monitorDir: fx.monitorDir, runtimeProfile: fx.profile,
    stopSession: () => { calls.stops += 1; }, now: () => clock.now, log: message => calls.logs.push(message), ...extra,
  });
  return { monitor, calls };
}

describe('Fable lease enforcement in the persona monitor (review #1)', () => {
  it('downgrades a running Fable session whose lease expired while the guard daemon is dead', () => {
    const fx = fixture();
    const clock = { now: T0 };
    assert.equal(fx.launch(clock.now).model, FABLE);
    const { monitor, calls } = monitorFor(fx, clock);
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
    assert.ok(calls.logs.some(line => line.includes('ALERT')));
    // Guardian relaunches the session through the cached profile: Opus.
    assert.equal(fx.launch(clock.now).model, OPUS);
    clock.now += 10 * MIN;
    monitor.tick();
    assert.equal(calls.stops, 1, 'an Opus session is never touched');
  });

  it('leaves the transition to a live daemon that commits and restarts within the grace', () => {
    const fx = fixture();
    const clock = { now: T0 };
    fx.launch(clock.now);
    const { monitor, calls } = monitorFor(fx, clock);
    clock.now = T0 + 5 * MIN;
    fx.writeUsage(clock.now, 0.8); // the daemon reads 80% and commits Opus
    fx.writeState('opus', 4, { [BACKUP]: { quota: { since: new Date(clock.now).toISOString() } } });
    monitor.tick();
    clock.now += 20_000;
    fx.launch(clock.now); // its cold restart lands
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
