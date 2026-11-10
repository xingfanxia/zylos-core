import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { HealthEngine } from '../health-engine.js';
import { DatabaseSync } from 'node:sqlite';
import { dropPendingKeystrokes, LIMIT_EVIDENCE_FILE, SESSION_FAILURES_FILE } from '../fable-guard.js';
import { createFableMonitor } from '../fable-monitor.js';
import { FABLE_LAUNCH_FILE } from '../../../multi-session/runtime-files.js';
import { classifyLimitDialog, readTmuxInputState } from '../../../comm-bridge/scripts/tmux-input-state.js';
import { canTreatPaneAsRecovered } from '../tool-pipeline.js';
import * as dialogs from '../../../comm-bridge/scripts/__tests__/fixtures/claude-dialogs.js';

function engineWith(extra = {}, options = {}) {
  const calls = { kill: 0, limit: [], restarts: [], log: [] };
  let now = 1_000_000;
  const deps = {
    enqueueHeartbeat: () => true,
    getHeartbeatStatus: () => deps._status,
    readHeartbeatPending: () => deps._pending,
    clearHeartbeatPending: () => { deps._pending = null; },
    killTmuxSession: () => { calls.kill += 1; },
    log: message => calls.log.push(message),
    detectRateLimit: () => ({ detected: false }),
    _pending: null,
    _status: 'pending',
    ...extra,
  };
  const engine = new HealthEngine(deps, { now: () => now, ...options });
  return { engine, deps, calls, advance: sec => { now += sec * 1000; }, nowSec: () => Math.floor(now / 1000) };
}

const DIALOG = { kind: 'fable_limit', text: "You've reached your Fable limit" };

describe('Fable limit dialog precedence over ordinary recovery (FG-4)', () => {
  it('a classified dialog on heartbeat failure records evidence and does not kill or count a restart', () => {
    const limit = [];
    const { engine, calls } = engineWith({ detectLimitDialog: () => DIALOG, onLimitDialog: item => limit.push(item) });
    engine.onHeartbeatFailure({ control_id: 1, phase: 'primary' }, 'timeout');
    assert.equal(calls.kill, 0);
    assert.equal(engine.restartCycleTimestamps.length, 0);
    assert.equal(engine.health, 'ok', 'never reported as rate_limited (no account failover)');
    assert.equal(limit.length, 1);
    assert.equal(limit[0].kind, 'fable_limit');
    assert.match(limit[0].source, /^heartbeat_primary_timeout$/);
  });

  it('a bare keyword elsewhere (classifier returns null) keeps ordinary recovery', () => {
    const { engine, calls } = engineWith({ detectLimitDialog: () => null, onLimitDialog: () => assert.fail('no evidence') });
    engine.onHeartbeatFailure({ control_id: 1, phase: 'primary' }, 'timeout');
    assert.equal(calls.kill, 1);
    assert.equal(engine.restartCycleTimestamps.length, 1);
  });

  it('without the Fable deps the engine behaves exactly as before', () => {
    const { engine, calls } = engineWith();
    engine.onHeartbeatFailure({ control_id: 1, phase: 'primary' }, 'timeout');
    assert.equal(calls.kill, 1);
    assert.equal(engine.health, 'unavailable');
  });

  it('falls back to ordinary recovery when the guard has not acted within the deferral window', () => {
    const { engine, calls, advance } = engineWith({ detectLimitDialog: () => DIALOG, onLimitDialog: () => {} });
    engine.onHeartbeatFailure({ control_id: 1, phase: 'primary' }, 'timeout');
    advance(14 * 60);
    engine.onHeartbeatFailure({ control_id: 2, phase: 'primary' }, 'timeout');
    assert.equal(calls.kill, 0);
    advance(2 * 60);
    engine.onHeartbeatFailure({ control_id: 3, phase: 'primary' }, 'timeout');
    assert.equal(calls.kill, 1);
  });

  it('scans a long-pending heartbeat for the dialog before the API-error scan', () => {
    const limit = [];
    const { engine, deps, nowSec } = engineWith({
      detectLimitDialog: () => DIALOG,
      onLimitDialog: item => limit.push(item),
      detectApiError: () => assert.fail('dialog wins this scan'),
    });
    deps._pending = { control_id: 7, phase: 'primary', created_at: nowSec() - 45 };
    engine.runMaintenanceCycle(true, nowSec());
    assert.equal(limit.length, 1);
    assert.equal(limit[0].source, 'pending_heartbeat');
    assert.ok(deps._pending, 'heartbeat stays pending; nothing is typed or killed');
  });

  it('checks the dialog after a delivered user message', async () => {
    const limit = [];
    const { engine } = engineWith({ detectLimitDialog: () => DIALOG, onLimitDialog: item => limit.push(item),
      detectRateLimit: () => assert.fail('dialog checked first') }, { userMessageCheckDelayMs: 0 });
    await engine.onUserMessageDelivered();
    assert.equal(limit[0].source, 'user_message');
  });

  it('defers recovery requested by the tool watchdog while the dialog is on screen', () => {
    const { engine, calls } = engineWith({ detectLimitDialog: () => DIALOG, onLimitDialog: () => {} });
    engine.triggerRecovery('tool_timeout_WebFetch');
    assert.equal(calls.kill, 0);
    assert.equal(engine.restartCycleTimestamps.length, 0);
    assert.equal(engine.limitDialogActive('watchdog_interrupt'), true);
  });

  it('reports each failure-driven kill+restart and records the functional ACK phase', () => {
    const restarts = [];
    const { engine } = engineWith({ onRecoveryRestart: reason => restarts.push(reason) });
    engine.onHeartbeatFailure({ control_id: 1, phase: 'primary' }, 'timeout');
    assert.deepEqual(restarts, ['primary_timeout']);
    engine.onHeartbeatSuccess('recovery');
    assert.equal(engine.lastFunctionalAckPhase, 'recovery');
  });
});

describe('Fable guard readiness probe (review #6)', () => {
  function readinessEngine() {
    const results = [];
    const enqueued = [];
    let id = 0;
    const harness = engineWith({
      guardReadiness: { phase: 'post_restart', onResult: result => results.push(result) },
      enqueueHeartbeat: phase => { enqueued.push(phase); harness.deps._pending = { control_id: ++id, phase, created_at: harness.nowSec() }; return true; },
    });
    return { ...harness, results, enqueued };
  }

  it('waits out the startup busy turn, then sends one end-to-end (non-auto-ACK) probe', () => {
    const { engine, enqueued, advance, nowSec } = readinessEngine();
    engine.notifyColdStart(30);
    advance(31);
    engine.setRuntimeBusy(true); // the startup turn is still running
    engine.runMaintenanceCycle(true, nowSec());
    assert.deepEqual(enqueued, [], 'never probed while the startup turn is busy');
    advance(60);
    engine.setRuntimeBusy(false);
    engine.runMaintenanceCycle(true, nowSec());
    assert.deepEqual(enqueued, ['post_restart'], 'recovery-class phases are never dispatcher auto-ACKed');
    engine.runMaintenanceCycle(true, nowSec());
    assert.equal(enqueued.length, 1, 'one probe per cold start');
  });

  it('is bounded by the startup grace even when the session stays busy', () => {
    const { engine, enqueued, advance, nowSec } = readinessEngine();
    engine.notifyColdStart(30);
    engine.setRuntimeBusy(true);
    advance(21 * 60);
    engine.runMaintenanceCycle(true, nowSec());
    assert.deepEqual(enqueued, ['post_restart']);
  });

  it('reports a real ACK, and a missing ACK without killing or restarting the session', () => {
    const ok = readinessEngine();
    ok.engine.notifyColdStart(30);
    ok.advance(31);
    ok.engine.runMaintenanceCycle(true, ok.nowSec());
    ok.deps._status = 'done';
    ok.engine.runMaintenanceCycle(true, ok.nowSec());
    assert.deepEqual(ok.results.map(item => [item.outcome, item.phase]), [['ack', 'post_restart']]);

    const missing = readinessEngine();
    missing.engine.notifyColdStart(30);
    missing.advance(31);
    missing.engine.runMaintenanceCycle(true, missing.nowSec());
    missing.deps._status = 'timeout';
    missing.engine.runMaintenanceCycle(true, missing.nowSec());
    assert.deepEqual(missing.results.map(item => [item.outcome, item.status]), [['missing', 'timeout']]);
    assert.equal(missing.calls.kill, 0, 'a correct model is not restarted for a missing ACK');
    assert.equal(missing.engine.health, 'ok');
    assert.ok(missing.calls.log.some(line => line.includes('readiness')));
  });

  it('keeps the auto-ACKable primary probe for everyone else', () => {
    const enqueued = [];
    const { engine, advance, nowSec } = engineWith({ enqueueHeartbeat: phase => { enqueued.push(phase); return true; } });
    engine.notifyColdStart(30);
    advance(31);
    engine.setRuntimeBusy(true);
    engine.runMaintenanceCycle(true, nowSec());
    assert.deepEqual(enqueued, ['primary']);
  });
});

describe('Fable monitor health deps', () => {
  function monitorWith({ mode = 'fable', capture = () => '', classify = classifyLimitDialog } = {}) {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-monitor-deps-'));
    fs.writeFileSync(path.join(monitorDir, FABLE_LAUNCH_FILE), JSON.stringify({ launch_id: 'L1', mode, generation: 4,
      runtime_profile: 'claude-ax-backup' }));
    const monitor = createFableMonitor({ zylosDir: monitorDir, instanceId: 'user-pan', monitorDir, sessionName: 'claude-user-pan',
      runtimeProfile: { id: 'claude-ax-backup', fable: { mode: 'fable', generation: 4 } }, stopSession: () => {},
      capturePane: capture, classifyLimitDialog: classify, now: () => Date.parse('2026-11-10T08:00:00Z') });
    return { monitor, monitorDir };
  }

  it('are absent for personas the guard does not track', () => {
    assert.equal(createFableMonitor({ zylosDir: '/x', instanceId: 'admin', monitorDir: '/x', runtimeProfile: { id: 'claude-ax-backup' } }), null);
  });

  it('record failures stamped with the current Fable launch only', () => {
    const { monitor, monitorDir } = monitorWith();
    try {
      monitor.healthDeps.onRecoveryRestart('heartbeat_primary_timeout');
      const failures = JSON.parse(fs.readFileSync(path.join(monitorDir, SESSION_FAILURES_FILE), 'utf8')).failures;
      assert.deepEqual(failures, [{ at: '2026-11-10T08:00:00.000Z', runtime_profile: 'claude-ax-backup', mode: 'fable',
        generation: 4, launch_id: 'L1', reason: 'heartbeat_primary_timeout' }]);
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
    const opus = monitorWith({ mode: 'opus' });
    try {
      opus.monitor.healthDeps.onRecoveryRestart('heartbeat_primary_timeout');
      assert.equal(fs.existsSync(path.join(opus.monitorDir, SESSION_FAILURES_FILE)), false, 'an Opus relaunch is not a Fable failure');
      assert.equal(opus.monitor.healthDeps.detectLimitDialog(), null);
    } finally {
      fs.rmSync(opus.monitorDir, { recursive: true, force: true });
    }
  });

  it('classify live panes with the REAL comm-bridge classifier (delivery fixtures)', () => {
    let pane = '';
    const { monitor, monitorDir } = monitorWith({ capture: () => pane });
    try {
      for (const [name, text, kind] of [
        ['live Fable limit', dialogs.FABLE_LIMIT_LIVE, 'fable_limit'],
        ['limit above composer', dialogs.FABLE_LIMIT_ABOVE_COMPOSER, 'fable_limit'],
        ['credits offer', dialogs.CREDITS_OFFER_LIVE, 'credits_offer'],
        ['quoted limit text', dialogs.QUOTED_LIMIT_TEXT, null],
        ['scrolled past', dialogs.SCROLLED_PAST_DIALOG, null],
        ['permission prompt', dialogs.PERMISSION_PROMPT_LIVE, null],
        ['plain composer', dialogs.PLAIN_COMPOSER, null],
      ]) {
        pane = text;
        assert.equal(monitor.healthDeps.detectLimitDialog()?.kind ?? null, kind, name);
      }
      pane = dialogs.FABLE_LIMIT_LIVE;
      monitor.healthDeps.onLimitDialog({ ...monitor.healthDeps.detectLimitDialog(), source: 'heartbeat' });
      const evidence = JSON.parse(fs.readFileSync(path.join(monitorDir, LIMIT_EVIDENCE_FILE), 'utf8'));
      assert.deepEqual([evidence.kind, evidence.runtime_profile, evidence.launch_id], ['fable_limit', 'claude-ax-backup', 'L1']);
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
  });

  it('monitor.js imports the classifier by name (a missing export fails at load)', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'monitor.js'), 'utf8');
    assert.match(source, /import \{ classifyLimitDialog, readTmuxInputState \} from '\.\.\/\.\.\/comm-bridge\/scripts\/tmux-input-state\.js';/);
    assert.doesNotMatch(source, /tmuxInputStateModule/);
    assert.match(source, /createFableMonitor\(\{[^}]*classifyLimitDialog,/);
  });
});

describe('Pane-read change that applies to every Claude persona (guard configured or not)', () => {
  // The real tmux snapshot shape: capture text, then the display-message cursor line.
  const paneState = (capture, x = 2, y = dialogs.PLAIN_COMPOSER_PROMPT_Y) => readTmuxInputState({
    sessionName: 'claude-admin', execFileSyncImpl: () => `${capture}\n${dialogs.cursorLine(x, y)}\n` });

  it('a live modal is never a recovered pane, so the tool watchdog does not treat it as one', () => {
    assert.equal(canTreatPaneAsRecovered(paneState(dialogs.PLAIN_COMPOSER)), true, 'baseline: an empty composer');
    for (const [name, capture] of [
      ['permission prompt', dialogs.PERMISSION_PROMPT_LIVE],
      ['unknown dialog', dialogs.UNKNOWN_DIALOG_LIVE],
      ['Fable limit', dialogs.FABLE_LIMIT_LIVE],
      ['limit above the composer', dialogs.FABLE_LIMIT_ABOVE_COMPOSER],
    ]) {
      const state = paneState(capture);
      assert.ok(state.modal, name);
      assert.equal(state.promptVisible, false, name);
      assert.equal(canTreatPaneAsRecovered(state), false, name);
    }
    assert.equal(paneState(dialogs.QUOTED_LIMIT_TEXT).modal, null, 'quoted limit text is not a modal');
  });
});

describe('Fable guard relaunch keystroke cleanup', () => {
  it('supersedes only pending keystroke controls of the relaunched persona', () => {
    // node:sqlite shares better-sqlite3's prepare().run() -> { changes } surface.
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE control_queue (id INTEGER PRIMARY KEY, content TEXT, status TEXT, target_instance TEXT,
      last_error TEXT, updated_at INTEGER)`);
    const insert = db.prepare('INSERT INTO control_queue (content, status, target_instance) VALUES (?, ?, ?)');
    insert.run('[KEYSTROKE]Escape', 'pending', 'user-pan');
    insert.run('[KEYSTROKE]Escape', 'running', 'user-pan');
    insert.run('[KEYSTROKE]Escape', 'pending', 'user-elaine');
    insert.run('Heartbeat check. [phase=primary]', 'pending', 'user-pan');
    assert.equal(dropPendingKeystrokes(db, 'user-pan', 42), 1);
    assert.deepEqual(db.prepare('SELECT status, last_error FROM control_queue ORDER BY id').all().map(row => ({ ...row })), [
      { status: 'superseded', last_error: 'FABLE_GUARD_RELAUNCH' },
      { status: 'running', last_error: null },
      { status: 'pending', last_error: null },
      { status: 'pending', last_error: null },
    ]);
    assert.equal(dropPendingKeystrokes(db, null), 0);
    db.close();
  });
});
