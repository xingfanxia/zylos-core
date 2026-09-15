import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleStaleRuntimeCleanup, createHealthEngine } from '../adapters/runtime-components.js';

describe('scheduleStaleRuntimeCleanup', () => {
  it('never kills the active stable tmux identity after a runtime profile switch', () => {
    let scheduled = 0;
    let killed = 0;
    scheduleStaleRuntimeCleanup(
      { runtimeId: 'codex', sessionName: 'claude-main' },
      {
        log: () => {},
        setTimeoutImpl: () => { scheduled += 1; },
        execFileSyncImpl: () => { killed += 1; },
      },
    );
    assert.equal(scheduled, 0);
    assert.equal(killed, 0);
  });

  it('still removes a distinct legacy session', () => {
    let callback = null;
    const calls = [];
    scheduleStaleRuntimeCleanup(
      { runtimeId: 'claude', sessionName: 'claude-main' },
      {
        log: () => {},
        setTimeoutImpl: (fn) => { callback = fn; },
        execFileSyncImpl: (bin, args) => calls.push([bin, ...args]),
      },
    );
    callback();
    assert.deepEqual(calls, [['tmux', 'kill-session', '-t', 'codex-main']]);
  });
});

// Periodic cost tuning must not slow process/recovery probes.
describe('configured heartbeat cadence', () => {
  function make(options = {}) {
    const phases = [];
    const engine = createHealthEngine({
      getHeartbeatDeps: () => ({ enqueueHeartbeat: phase => { phases.push(phase); return true; }, readHeartbeatPending: () => null }),
      stop() {},
    }, { health: 'ok' }, { log() {}, ...options });
    return { engine, phases };
  }
  it('keeps the default cadence and forwards a per-instance override', () => {
    assert.equal(make().engine.heartbeatInterval, 1800);
    assert.equal(make({ heartbeatInterval: 7200 }).engine.heartbeatInterval, 7200);
  });
  it('defers routine probes until two hours without changing recovery timing', () => {
    const { engine, phases } = make({ heartbeatInterval: 7200 });
    engine.lastHeartbeatAt = 100;
    engine.lastAgentRunning = true;
    engine.processHeartbeat(true, 1900);
    assert.deepEqual(phases, []);
    engine.processHeartbeat(true, 7300);
    assert.deepEqual(phases, ['primary']);
    assert.equal(engine.signalGracePeriod, 30);
    assert.equal(engine.userMessageRecoveryCooldown, 60);
    assert.equal(engine.downRetryInterval, 3600);
    engine.destroy();
  });
});
