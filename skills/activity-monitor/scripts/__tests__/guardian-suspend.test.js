/**
 * ZY-LIFE-1 — Guardian auto-suspend gate (REAL Guardian, temp monitorDir).
 *
 * The guardian must skip relaunch while an instance is suspended (suspend-signal
 * file, or agent-status state:'suspended'), but a pending wake-signal always wins
 * — it's consumed, the suspend state cleared, and relaunch proceeds. With no
 * monitorDir wired, behavior is unchanged (always relaunch).
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Guardian } from '../guardian.js';
import { createGuardian as createRuntimeGuardian } from '../adapters/runtime-components.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-suspend-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeGuardian(monitorDir, { nowMs, signalTtlSec } = {}) {
  const calls = { launch: 0 };
  const adapter = {
    sessionName: 'test-main',
    displayName: 'TestRuntime',
    isRunning: async () => false,
    launch: async () => { calls.launch++; },
    clearStaleState: () => {},
    enqueueStartupPrompt: () => {},
  };
  const guardian = new Guardian(adapter, {
    log: () => {},
    resetToolLifecycleState: () => {},
    execSyncImpl: () => { throw new Error('no session'); }, // tmuxHasSession → false
    nowMs: nowMs ?? (() => 100_000),
    monitorDir,
    ...(signalTtlSec !== undefined ? { signalTtlSec } : {}),
  });
  return { guardian, calls };
}

const write = (name, body = 'x') => (dir) => fs.writeFileSync(path.join(dir, name), body);

describe('_shouldStaySuspended', () => {
  it('returns false with no monitorDir (legacy always-relaunch)', () => {
    const { guardian } = makeGuardian(null);
    assert.equal(guardian._shouldStaySuspended(), false);
  });
  it('returns false when no signals are present', () => {
    const { guardian } = makeGuardian(tmp);
    assert.equal(guardian._shouldStaySuspended(), false);
  });
  it('returns true when a suspend-signal file exists', () => {
    const { guardian } = makeGuardian(tmp);
    write('suspend-signal')(tmp);
    assert.equal(guardian._shouldStaySuspended(), true);
  });
  it('returns true when agent-status state is suspended', () => {
    const { guardian } = makeGuardian(tmp);
    fs.writeFileSync(path.join(tmp, 'agent-status.json'), JSON.stringify({ state: 'suspended' }));
    assert.equal(guardian._shouldStaySuspended(), true);
  });
  it('wake-signal wins: consumes it, clears suspend-signal + suspended status, returns false', () => {
    const { guardian } = makeGuardian(tmp);
    write('suspend-signal')(tmp);
    write('wake-signal')(tmp);
    fs.writeFileSync(path.join(tmp, 'agent-status.json'), JSON.stringify({ state: 'suspended' }));
    assert.equal(guardian._shouldStaySuspended(), false);
    assert.equal(fs.existsSync(path.join(tmp, 'wake-signal')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'suspend-signal')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'agent-status.json'), 'utf8')).state, 'starting');
  });
});

describe('tick honors the suspend gate', () => {
  it('returns state:suspended and does NOT relaunch when suspended', async () => {
    const { guardian, calls } = makeGuardian(tmp);
    write('suspend-signal')(tmp);
    const r = await guardian.tick({ currentTime: 1 });
    assert.equal(r.state, 'suspended');
    assert.equal(r.attempted_restart, false);
    assert.equal(calls.launch, 0);
  });

  it('does not gate (proceeds toward relaunch) when a wake-signal is present', async () => {
    const { guardian } = makeGuardian(tmp);
    write('suspend-signal')(tmp);
    write('wake-signal')(tmp);
    const r = await guardian.tick({ currentTime: 1 });
    assert.notEqual(r.state, 'suspended'); // wake consumed → normal not-running path
  });
});

// REL-6 regression guard: orphaned signal files (prod had 1-2-day-old suspend/wake
// signals; yanzi carries a stale suspend-signal with NO wake-signal) must not
// strand-suspend an instance when the gate turns on.
describe('signal TTL', () => {
  const staleDate = () => new Date(Date.now() - 700_000); // 700s > default 600s TTL

  it('ignores and deletes a stale suspend-signal instead of strand-suspending', () => {
    const { guardian } = makeGuardian(tmp, { nowMs: () => Date.now(), signalTtlSec: 600 });
    const sus = path.join(tmp, 'suspend-signal');
    write('suspend-signal')(tmp);
    fs.utimesSync(sus, staleDate(), staleDate());

    assert.equal(guardian._shouldStaySuspended(), false);
    assert.equal(fs.existsSync(sus), false, 'stale signal must be deleted');
  });

  it('ignores and deletes a stale wake-signal but honors a fresh suspend-signal', () => {
    const { guardian } = makeGuardian(tmp, { nowMs: () => Date.now(), signalTtlSec: 600 });
    const wake = path.join(tmp, 'wake-signal');
    write('wake-signal')(tmp);
    fs.utimesSync(wake, staleDate(), staleDate());
    write('suspend-signal')(tmp); // fresh

    assert.equal(guardian._shouldStaySuspended(), true, 'stale wake must not clear a fresh suspend');
    assert.equal(fs.existsSync(wake), false, 'stale wake-signal must be deleted');
    assert.equal(fs.existsSync(path.join(tmp, 'suspend-signal')), true);
  });

  it('honors fresh signals within the TTL', () => {
    const { guardian } = makeGuardian(tmp, { nowMs: () => Date.now(), signalTtlSec: 600 });
    write('suspend-signal')(tmp);
    assert.equal(guardian._shouldStaySuspended(), true);
  });
});

describe('wake-on-arrival and suspend chains', () => {
  it('stays suspended (no relaunch) until a wake-signal arrives, then relaunches', async () => {
    const { guardian, calls } = makeGuardian(tmp, { nowMs: () => Date.now() });
    write('suspend-signal')(tmp);

    for (let i = 1; i <= 10; i++) {
      const r = await guardian.tick({ currentTime: i });
      assert.equal(r.state, 'suspended');
    }
    assert.equal(calls.launch, 0);

    // Dispatcher writes the wake-signal on message arrival for this instance.
    write('wake-signal')(tmp);
    for (let i = 11; i <= 16; i++) {
      await guardian.tick({ currentTime: i });
    }
    assert.equal(calls.launch, 1, 'wake-signal must lead to relaunch');
    assert.equal(fs.existsSync(path.join(tmp, 'wake-signal')), false, 'wake-signal consumed');
    assert.equal(fs.existsSync(path.join(tmp, 'suspend-signal')), false, 'suspend cleared by wake');
  });

  it('a stale suspend-signal TTLs out and the guardian relaunches on its own', async () => {
    const { guardian, calls } = makeGuardian(tmp, { nowMs: () => Date.now(), signalTtlSec: 600 });
    const sus = path.join(tmp, 'suspend-signal');
    write('suspend-signal')(tmp);
    fs.utimesSync(sus, new Date(Date.now() - 700_000), new Date(Date.now() - 700_000));

    let result;
    for (let i = 1; i <= 5; i++) {
      result = await guardian.tick({ currentTime: i });
    }
    assert.notEqual(result.state, 'suspended');
    assert.equal(calls.launch, 1);
  });
});

// The production defect lived at the wiring seam: monitor.js's createGuardian
// wrapper omitted monitorDir, silently disabling the whole gate. Assert the
// factory threads both monitorDir and signalTtlSec into Guardian deps.
describe('runtime-components createGuardian wiring', () => {
  it('threads monitorDir and signalTtlSec into Guardian deps', () => {
    const adapter = { sessionName: 'wire-main', displayName: 'Wire' };
    const guardian = createRuntimeGuardian(adapter, { reset: () => {} }, 0, {
      apiActivityFile: path.join(tmp, 'api-activity.json'),
      hookStateFile: path.join(tmp, 'hook-state.json'),
      monitorDir: tmp,
      signalTtlSec: 123,
      log: () => {},
    });

    assert.equal(guardian.deps.monitorDir, tmp);
    assert.equal(guardian.deps.signalTtlSec, 123);
  });

  it('falls back to the default TTL when signalTtlSec is not provided', () => {
    const adapter = { sessionName: 'wire-main', displayName: 'Wire' };
    const guardian = createRuntimeGuardian(adapter, { reset: () => {} }, 0, {
      apiActivityFile: path.join(tmp, 'api-activity.json'),
      hookStateFile: path.join(tmp, 'hook-state.json'),
      monitorDir: tmp,
      log: () => {},
    });

    // The TTL default is applied at the read site (?? DEFAULT_SIGNAL_TTL_SEC),
    // so an unset dep must stay nullish — never 0, which would disable the TTL.
    assert.equal(guardian.deps.signalTtlSec == null, true);
  });
});
