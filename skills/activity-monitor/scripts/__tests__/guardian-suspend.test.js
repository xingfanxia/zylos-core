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

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-suspend-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeGuardian(monitorDir) {
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
    nowMs: () => 100_000,
    monitorDir,
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
