import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHealthEngine, scheduleStaleRuntimeCleanup } from '../adapters/runtime-components.js';

function withCapturedTimers(fn) {
  const original = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return { unref() {} };
  };
  try {
    fn();
  } finally {
    globalThis.setTimeout = original;
  }
  return scheduled;
}

describe('scheduleStaleRuntimeCleanup on single-session agents', () => {
  it('never schedules a kill of its own session when a Codex engine keeps the claude-main pane (herdr Bohe)', () => {
    const scheduled = withCapturedTimers(() => {
      scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: 'claude-main' }, { log: () => {} });
    });
    assert.equal(scheduled.length, 0);
  });

  it('still schedules removal of the other runtime session for a default codex-main agent (CL)', () => {
    const scheduled = withCapturedTimers(() => {
      scheduleStaleRuntimeCleanup({ runtimeId: 'codex', sessionName: 'codex-main' }, { log: () => {} });
    });
    assert.equal(scheduled.length, 1);
  });
});

describe('createHealthEngine per-instance options', () => {
  function make(options = {}) {
    const engine = createHealthEngine({
      getHeartbeatDeps: () => ({ enqueueHeartbeat: () => true, readHeartbeatPending: () => null }),
      stop() {},
    }, { health: 'ok' }, { log() {}, ...options });
    return engine;
  }

  it('keeps upstream defaults when config sets nothing (herdr)', () => {
    const engine = make();
    assert.equal(engine.authFailureHold, false);
    engine.destroy?.();
  });

  // Upstream 0.8.3 removed periodic primary probes, so heartbeat_interval no
  // longer exists; only the auth-failure hold is per-instance.
  it('forwards auth_failure_hold (CL SWE/auto-reviewer)', () => {
    const engine = make({ authFailureHold: true });
    assert.equal(engine.authFailureHold, true);
    engine.destroy?.();
  });
});
