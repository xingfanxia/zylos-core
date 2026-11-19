/**
 * The composer advisory needs a minute of uninterrupted monitor ticks. A tick
 * that does not reach the dialog watch (the session offline, stopped,
 * suspended, frozen, in startup grace, or a tick that threw) resets the
 * composer observation. Drives the real Guardian, MonitorOrchestrator and
 * dialog watch through the step monitor.js monitorLoop runs after each tick
 * (stepDialogWatch). Harmless fixtures only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';

import { Guardian } from '../guardian.js';
import { MonitorOrchestrator } from '../monitor-orchestrator.js';
import { createDialogWatch, stepDialogWatch } from '../dialog-watch.js';

const SEC = 1000;
const T0 = 1_800_000_000; // seconds
const PANE = '%7';
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// One monitor process: real guardian + orchestrator + watch; `world` says
// what each second looks like.
function loop() {
  const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-loop-'));
  dirs.push(monitorDir);
  const world = { session: true, running: true, frozen: false, activityThrows: false, health: 'ok' };
  const h = { t: 0, alerts: [], world, monitorDir };
  const adapter = { runtimeId: 'claude', displayName: 'Claude', sessionName: 'claude-main',
    isRunning: async () => world.running, launch: async () => {}, stop: () => {} };
  const engine = { get health() { return world.health; }, start: () => {}, setRuntimeBusy: () => {},
    setAgentRunning: () => {}, isDegradedProbeDue: () => false, onProcessRestarted: () => {} };
  h.guardian = new Guardian(adapter, {
    execSyncImpl: (cmd) => { if (/has-session/.test(cmd) && !world.session) throw new Error('no session'); return ''; },
    nowMs: () => (T0 + h.t) * SEC, monitorDir, signalTtlSec: 0,
  });
  const procSampler = { tick: () => {}, isFrozen: () => world.frozen, getState: () => ({ frozenCount: 30 }), reset: () => {} };
  const orchestrator = new MonitorOrchestrator({
    env: { ZYLOS_DIR: path.join(monitorDir, 'zylos') }, monitorDir,
    getActiveAdapter: () => adapter, readConfigObject: () => ({ runtime: 'claude' }),
    createToolPipeline: () => ({ pipeline: { tick: () => ({ foregroundIdentity: null, apiActivity: null }),
      writeApiActivitySnapshot: () => {}, buildApiActivity: () => null }, toolRules: {} }),
    readWatchdogState: () => null, createProcSampler: () => procSampler,
    loadInitialHealth: () => ({ health: 'ok', runtime_launch_at: 1 }), createHealthEngine: () => engine,
    createGuardian: () => h.guardian, startMessageRouterServer: () => {}, readDailyUpgradeEnabled: () => true,
    createUsageMonitor: () => ({}), createTaskScheduler: () => ({ tick: () => {} }), initializeUsageMonitor: () => {},
    startContextMonitor: () => ({}), scheduleStaleRuntimeCleanup: () => {}, log: () => {},
    nowMs: () => (T0 + h.t) * SEC, readSessionRef: () => null,
  });
  orchestrator.start();
  const watch = createDialogWatch({
    instanceId: 'user-pan', now: () => (T0 + h.t) * SEC,
    enqueueKey: () => ({ ok: true, id: 1 }), findOwnControl: () => null, withdrawOwnControl: () => false,
    enqueueNotice: () => ({ ok: true, id: 2 }), readHeld: () => ({ conversations: 0, controls: 0, count: 0, oldestAt: null }),
    loadState: () => null, saveState: () => {}, log: () => {}, countFailedSince: () => null,
    notifyOperator: async (message) => { h.alerts.push({ t: h.t, message }); return { ok: true }; },
  });
  let state = { runtimeLaunchAtMs: 1, lastState: 'busy', idleSince: 0, watchdogState: null };

  // monitor.js monitorLoop, in order: the orchestrator tick, then the watch step.
  h.tick = async () => {
    const currentTime = T0 + h.t;
    let paneFrame = null;
    let tickState;
    try {
      tickState = await orchestrator.handleMonitorTick({
        currentTime, currentTimeHuman: 'x', nowMs: currentTime * SEC, state, idleThreshold: 3,
        checkDailyTruncate: () => {}, buildNotRunningStatus: (s) => s, buildRunningStatus: (s) => s,
        writeStatusFile: () => {}, clearWatchdogState: () => {}, writeWatchdogState: () => {},
        getConversationFileModTime: () => 0,
        getTmuxActivity: () => { if (world.activityThrows) throw new Error('tmux timed out'); return T0 - 600; },
        getTmuxClaudePid: () => 4242,
        readTmuxInputState: () => (paneFrame = { inputState: 'indeterminate', modal: null, captureOk: true, paneIdentity: PANE }),
        canTreatPaneAsRecovered: () => false, runC4Control: () => ({ ok: true, output: '' }),
      });
    } catch {
      stepDialogWatch(watch, { failed: true });
      return;
    }
    state = { runtimeLaunchAtMs: tickState.runtimeLaunchAtMs, lastState: tickState.lastState,
      idleSince: tickState.idleSince, watchdogState: tickState.watchdogState };
    stepDialogWatch(watch, { lastState: state.lastState, paneFrame, runtimeId: adapter.runtimeId, healthOk: engine.health === 'ok' });
    await watch.settled();
  };
  // Ticks once a second from h.t up to `until` (seconds); `at` sets the world for one second.
  h.run = async (until, at = {}) => {
    for (; h.t <= until; h.t += 1) {
      const set = at[h.t];
      if (set) set(world, h);
      await h.tick();
    }
  };
  return h;
}

const composerAlerts = (h) => h.alerts.filter((a) => /的输入框/.test(a.message));

describe('composer advisory: a tick that skips the watch resets the observation', () => {
  it('his schedule: idle t=0..58, offline at t=59, idle on the same pane at t=60: alert at t=120, not t=60', async () => {
    const h = loop();
    await h.run(130, {
      59: (w) => { w.session = false; },
      60: (w) => { w.session = true; },
    });
    assert.deepEqual(composerAlerts(h).map((a) => a.t), [120]);
  });

  it('control: the same minute uninterrupted alerts at t=60', async () => {
    const h = loop();
    await h.run(130);
    assert.deepEqual(composerAlerts(h).map((a) => a.t), [60]);
  });

  const skips = {
    'offline under a health gate': { 59: (w) => { w.session = false; w.health = 'auth_failed'; }, 60: (w) => { w.session = true; w.health = 'ok'; } },
    'stopped (the agent not running in the session)': { 59: (w) => { w.running = false; }, 60: (w) => { w.running = true; } },
    'suspended (signal file)': {
      59: (w, h) => { w.running = false; fs.writeFileSync(path.join(h.monitorDir, 'suspend-signal'), '{}'); },
      60: (w, h) => { w.running = true; fs.rmSync(path.join(h.monitorDir, 'suspend-signal')); },
    },
    'startup grace (no pane read)': { 59: (w, h) => { w.running = false; h.guardian.startupGrace = 1; }, 60: (w) => { w.running = true; } },
    'frozen process': { 59: (w) => { w.frozen = true; }, 60: (w) => { w.frozen = false; } },
    'the orchestrator tick threw': { 59: (w) => { w.activityThrows = true; }, 60: (w) => { w.activityThrows = false; } },
  };
  for (const [name, at] of Object.entries(skips)) {
    it(`${name} at t=59: alert at t=120`, async () => {
      const h = loop();
      await h.run(130, at);
      assert.deepEqual(composerAlerts(h).map((a) => a.t), [120]);
    });
  }

  it('a watch tick that threw resets only the composer observation', () => {
    let resets = 0;
    const logs = [];
    const watch = { tick: () => { throw new Error('boom'); }, resetComposer: () => { resets += 1; } };
    stepDialogWatch(watch, { lastState: 'idle', paneFrame: { inputState: 'has_content' }, runtimeId: 'claude', log: (l) => logs.push(l) });
    assert.equal(resets, 1);
    assert.deepEqual(logs, ['Dialog watch tick failed: boom']);
  });
});
