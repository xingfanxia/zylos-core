import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Guardian } from '../guardian.js';

function createAdapter(overrides = {}) {
  const calls = {
    clearStaleState: 0,
    enqueueStartupPrompt: 0,
    launch: 0,
    isRunning: 0,
  };

  const adapter = {
    sessionName: 'test-main',
    displayName: 'TestRuntime',
    isRunning: async () => {
      calls.isRunning++;
      return overrides.isRunning ?? false;
    },
    launch: async () => {
      calls.launch++;
    },
    clearStaleState: () => {
      calls.clearStaleState++;
    },
    enqueueStartupPrompt: () => {
      calls.enqueueStartupPrompt++;
    },
  };

  return { adapter, calls };
}

function createDeps(overrides = {}) {
  const calls = {
    log: [],
    resetToolLifecycleState: 0,
  };

  const deps = {
    log: (message) => calls.log.push(message),
    resetToolLifecycleState: () => {
      calls.resetToolLifecycleState++;
    },
    execSyncImpl: overrides.execSyncImpl ?? (() => {
      throw new Error('no session');
    }),
    nowMs: overrides.nowMs ?? (() => 100_000),
    initialRuntimeLaunchAtMs: overrides.initialRuntimeLaunchAtMs ?? 0,
  };

  return { deps, calls };
}

describe('Guardian', () => {
  it('starts the runtime after the offline restart delay when no health gate applies', async () => {
    const { adapter, calls } = createAdapter();
    const { deps, calls: depCalls } = createDeps();
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 5; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, true);
    assert.equal(result.runtimeLaunchAtMs, 100_000);
    assert.equal(calls.launch, 1);
    assert.equal(calls.clearStaleState, 1);
    assert.equal(calls.enqueueStartupPrompt, 1);
    assert.equal(depCalls.resetToolLifecycleState, 1);
  });

  it('uses startup grace after a launch attempt', async () => {
    const { adapter } = createAdapter();
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);

    for (let i = 1; i <= 5; i++) {
      await guardian.tick({ currentTime: i });
    }

    const result = await guardian.tick({ currentTime: 6 });

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, false);
    assert.equal(result.skippedForStartupGrace, true);
    assert.equal(guardian.getState().startupGrace, 29);
  });

  it('reports stopped when tmux exists but the runtime process is not running', async () => {
    const { adapter } = createAdapter({ isRunning: false });
    const { deps } = createDeps({
      execSyncImpl: () => '',
    });
    const guardian = new Guardian(adapter, deps);

    const result = await guardian.tick({ currentTime: 1 });

    assert.equal(result.state, 'stopped');
    assert.equal(result.message, 'TestRuntime not running in tmux');
    assert.equal(result.notRunningSeconds, 1);
  });

  it('resets restart backoff after stable running time with functional health ok', async () => {
    const { adapter } = createAdapter({ isRunning: true });
    const { deps } = createDeps({
      execSyncImpl: (command) => {
        if (command.startsWith('tmux has-session')) return '';
        throw new Error(`unexpected command: ${command}`);
      },
    });
    const guardian = new Guardian(adapter, deps);

    guardian.startAgent();
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    await guardian.tick({ currentTime: 10, health: 'ok' });
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    const result = await guardian.tick({ currentTime: 70, health: 'ok' });

    assert.equal(result.state, 'running');
    assert.equal(guardian.getState().consecutiveRestarts, 0);
    assert.equal(guardian.getState().stableRunningSince, 0);
  });

  it('does not reset restart backoff on process-alive alone while health is not ok', async () => {
    // Incident regression: claude parks ALIVE on a login screen for >60s each
    // flap cycle — process-alive must not be conflated with a functional ACK.
    const { adapter } = createAdapter({ isRunning: true });
    const { deps } = createDeps({
      execSyncImpl: (command) => {
        if (command.startsWith('tmux has-session')) return '';
        throw new Error(`unexpected command: ${command}`);
      },
    });
    const guardian = new Guardian(adapter, deps);

    guardian.startAgent();

    await guardian.tick({ currentTime: 10, health: 'recovering' });
    const result = await guardian.tick({ currentTime: 70, health: 'recovering' });

    assert.equal(result.state, 'running');
    assert.equal(guardian.getState().consecutiveRestarts, 1, 'no reset without functional health');

    await guardian.tick({ currentTime: 130, health: 'ok' });
    assert.equal(guardian.getState().consecutiveRestarts, 0, 'resets once health is functionally ok');
  });
});

describe('Guardian health gate', () => {
  it('skips relaunch while health is auth_failed', async () => {
    const { adapter, calls } = createAdapter();
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 10; i++) {
      result = await guardian.tick({ currentTime: i, health: 'auth_failed' });
    }

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, false);
    assert.equal(calls.launch, 0);
  });

  it('auto-un-gates when health flips auth_failed → unavailable (hung-agent escape)', async () => {
    const { adapter, calls } = createAdapter();
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);

    for (let i = 1; i <= 6; i++) {
      await guardian.tick({ currentTime: i, health: 'auth_failed' });
    }
    assert.equal(calls.launch, 0);

    // _verifyAuthFailedEntry flipped auth_failed → unavailable: the live health
    // read must un-gate on the very next tick.
    const result = await guardian.tick({ currentTime: 7, health: 'unavailable' });

    assert.equal(result.attempted_restart, true);
    assert.equal(calls.launch, 1);
  });

  it('skips relaunch while degraded until the probe window is due, then relaunches once', async () => {
    const { adapter, calls } = createAdapter();
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);

    for (let i = 1; i <= 10; i++) {
      const r = await guardian.tick({ currentTime: i, health: 'degraded', degradedProbeDue: false });
      assert.equal(r.attempted_restart, false);
    }
    assert.equal(calls.launch, 0);

    const result = await guardian.tick({ currentTime: 11, health: 'degraded', degradedProbeDue: true });

    assert.equal(result.attempted_restart, true);
    assert.equal(calls.launch, 1);
  });
});
