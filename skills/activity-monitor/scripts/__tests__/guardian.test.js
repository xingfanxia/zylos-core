import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Guardian, isTmuxTimeoutError, probeTmuxSession } from '../guardian.js';

// tmux probes run shell-free via execFileSync('tmux', [args]); mocks key on args[0].
function tmuxMock(handlers) {
  return (_file, args = []) => {
    const sub = args[0];
    if (sub === 'has-session' && 'hasSession' in handlers) return handlers.hasSession();
    if (sub === 'list-panes' && 'listPanes' in handlers) return handlers.listPanes();
    throw new Error(`unexpected tmux args: ${JSON.stringify(args)}`);
  };
}

function timeoutError() {
  return Object.assign(new Error('Command timed out'), { signal: 'SIGTERM', killed: true });
}

function exitError(status = 1) {
  return Object.assign(new Error(`exit ${status}`), { status });
}

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
    execFileSyncImpl: overrides.execFileSyncImpl ?? (() => {
      throw new Error('no session');
    }),
    nowMs: overrides.nowMs ?? (() => 100_000),
    initialRuntimeLaunchAtMs: overrides.initialRuntimeLaunchAtMs ?? 0,
  };

  return { deps, calls };
}

describe('Guardian', () => {
  it('starts the runtime after the offline restart delay without reading health state', async () => {
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

  it('aborts the offline restart when the session reappears on the pre-launch re-probe', async () => {
    const { adapter, calls } = createAdapter();
    // has-session throws (absent) for the 5 accumulating ticks, then returns ''
    // (present) on the 6th call — the confirmation re-probe fired at the restart
    // threshold. The runtime came back mid-flap, so the guardian must NOT launch.
    let n = 0;
    const { deps, calls: depCalls } = createDeps({
      execFileSyncImpl: (_file, args = []) => {
        if (args[0] !== 'has-session') throw new Error(`unexpected tmux args: ${JSON.stringify(args)}`);
        n += 1;
        if (n <= 5) throw exitError(1); // absent
        return ''; // present on the pre-launch confirmation probe
      },
    });
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 5; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, false);
    assert.equal(calls.launch, 0);
    assert.equal(result.notRunningSeconds, 0); // counter reset after abort
    assert.equal(guardian.getState().notRunningCount, 0);
    assert.ok(depCalls.log.some((m) => m.includes('aborting redundant launch')));
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
      execFileSyncImpl: tmuxMock({ hasSession: () => '', listPanes: () => '12345\n' }),
    });
    const guardian = new Guardian(adapter, deps);

    const result = await guardian.tick({ currentTime: 1 });

    assert.equal(result.state, 'stopped');
    assert.equal(result.message, 'TestRuntime not running in tmux');
    assert.equal(result.notRunningSeconds, 1);
  });

  it('resets restart backoff after stable running time', async () => {
    const { adapter } = createAdapter({ isRunning: true });
    const { deps } = createDeps({
      execFileSyncImpl: tmuxMock({ hasSession: () => '' }),
    });
    const guardian = new Guardian(adapter, deps);

    guardian.startAgent();
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    await guardian.tick({ currentTime: 10 });
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    const result = await guardian.tick({ currentTime: 70 });

    assert.equal(result.state, 'running');
    assert.equal(guardian.getState().consecutiveRestarts, 0);
    assert.equal(guardian.getState().stableRunningSince, 0);
  });

  it('classifies tmux timeout errors as indeterminate, not absent', () => {
    assert.equal(isTmuxTimeoutError(timeoutError()), true);
    assert.equal(isTmuxTimeoutError({ code: 'ETIMEDOUT' }), true);
    assert.equal(isTmuxTimeoutError({ killed: true }), true);
    assert.equal(isTmuxTimeoutError(exitError(1)), false);
    assert.equal(isTmuxTimeoutError(new Error('no session')), false);
    assert.equal(isTmuxTimeoutError(null), false);
  });

  it('probeTmuxSession distinguishes present / absent / unknown', () => {
    assert.equal(probeTmuxSession({ sessionName: 's', execFileSyncImpl: () => '' }), 'present');
    assert.equal(probeTmuxSession({ sessionName: 's', execFileSyncImpl: () => { throw exitError(1); } }), 'absent');
    assert.equal(probeTmuxSession({ sessionName: 's', execFileSyncImpl: () => { throw timeoutError(); } }), 'unknown');
  });

  it('holds (never restarts) when the tmux session probe times out', async () => {
    const { adapter, calls } = createAdapter({ isRunning: false });
    const { deps } = createDeps({ execFileSyncImpl: () => { throw timeoutError(); } });
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 10; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'indeterminate');
    assert.equal(result.skippedForIndeterminateProbe, true);
    assert.equal(result.attempted_restart, false);
    assert.equal(calls.launch, 0);                        // never restarts on a hung tmux
    assert.equal(calls.isRunning, 0);                     // never even reaches isRunning
    assert.equal(guardian.getState().notRunningCount, 0); // counters never advance → no flap
  });

  it('holds when tmux is unresponsive during the agent probe (session ok, list-panes hangs)', async () => {
    const { adapter, calls } = createAdapter({ isRunning: false });
    const { deps } = createDeps({
      execFileSyncImpl: tmuxMock({
        hasSession: () => '',                 // session present
        listPanes: () => { throw timeoutError(); }, // disambiguation probe hangs
      }),
    });
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 10; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'indeterminate');
    assert.equal(result.skippedForIndeterminateProbe, true);
    assert.equal(calls.launch, 0);
    assert.equal(guardian.getState().notRunningCount, 0);
  });

  it('still reports stopped and restarts when tmux is responsive but the agent is gone', async () => {
    const { adapter, calls } = createAdapter({ isRunning: false });
    const { deps } = createDeps({
      execFileSyncImpl: tmuxMock({
        hasSession: () => '',
        listPanes: () => '12345\n', // responsive: panes exist
      }),
    });
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 5; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'stopped');
    assert.equal(result.attempted_restart, true);
    assert.equal(calls.launch, 1);
  });

  it('holds when a non-swallowing adapter isRunning() throws a tmux timeout', async () => {
    // Defensive branch (guardian.js): the shipped Claude adapter swallows tmux
    // timeouts, but an adapter that propagates one must be treated as
    // indeterminate, not dead.
    const { adapter, calls } = createAdapter();
    adapter.isRunning = async () => { calls.isRunning++; throw timeoutError(); };
    const { deps } = createDeps({
      execFileSyncImpl: tmuxMock({ hasSession: () => '' }), // session present
    });
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 10; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'indeterminate');
    assert.equal(result.skippedForIndeterminateProbe, true);
    assert.equal(calls.launch, 0);
    assert.equal(guardian.getState().notRunningCount, 0);
  });

  it('prepares instructions before launch and does not launch on preparation failure', async () => {
    const order = [];
    let rejectPreparation;
    const adapter = {
      sessionName: 'test-main',
      displayName: 'TestRuntime',
      buildInstructionFile: () => new Promise((resolve, reject) => {
        rejectPreparation = reject;
        order.push('prepare');
      }),
      launch: async () => { order.push('launch'); },
      clearStaleState: () => {},
      enqueueStartupPrompt: () => { order.push('prompt'); },
    };
    const { deps, calls } = createDeps();
    const guardian = new Guardian(adapter, deps);
    assert.equal(guardian.startAgent(), true);
    assert.deepEqual(order, ['prepare']);
    rejectPreparation(new Error('assembly failed'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['prepare']);
    assert.ok(calls.log.some(message => message.includes('assembly failed')));
  });

  it('launches only after asynchronous instruction preparation resolves', async () => {
    const order = [];
    let resolvePreparation;
    const adapter = {
      sessionName: 'test-main',
      displayName: 'TestRuntime',
      buildInstructionFile: () => new Promise(resolve => {
        resolvePreparation = resolve;
        order.push('prepare');
      }),
      launch: async () => { order.push('launch'); },
      clearStaleState: () => {},
      enqueueStartupPrompt: () => { order.push('prompt'); },
    };
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);
    guardian.startAgent();
    assert.deepEqual(order, ['prepare']);
    resolvePreparation();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['prepare', 'launch', 'prompt']);
  });
});
