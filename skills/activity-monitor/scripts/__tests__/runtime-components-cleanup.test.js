import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleStaleRuntimeCleanup } from '../adapters/runtime-components.js';

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
