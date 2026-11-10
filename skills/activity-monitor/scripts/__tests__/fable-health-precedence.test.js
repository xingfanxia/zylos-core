import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { HealthEngine } from '../health-engine.js';
import { DatabaseSync } from 'node:sqlite';
import { createFableMonitorDeps, dropPendingKeystrokes, LIMIT_EVIDENCE_FILE, SESSION_FAILURES_FILE } from '../fable-guard.js';

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

describe('Fable monitor deps', () => {
  it('are absent for personas not launched on Fable', () => {
    assert.deepEqual(createFableMonitorDeps({ runtimeProfile: { id: 'claude-ax-backup' } }), {});
    assert.deepEqual(createFableMonitorDeps({ runtimeProfile: { id: 'claude-ax-backup', fable: { mode: 'opus' } },
      classifyLimitDialog: () => DIALOG }), {});
  });

  it('record crash evidence even before the delivery side ships its classifier', () => {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-monitor-deps-'));
    try {
      const deps = createFableMonitorDeps({ runtimeProfile: { id: 'claude-ax-backup', fable: { mode: 'fable', generation: 4 } },
        monitorDir, sessionName: 'claude-user-pan', now: () => Date.parse('2026-11-10T08:00:00Z') });
      assert.deepEqual(Object.keys(deps), ['onRecoveryRestart']);
      deps.onRecoveryRestart('heartbeat_primary_timeout');
      const failures = JSON.parse(fs.readFileSync(path.join(monitorDir, SESSION_FAILURES_FILE), 'utf8')).failures;
      assert.deepEqual(failures, [{ at: '2026-11-10T08:00:00.000Z', runtime_profile: 'claude-ax-backup', mode: 'fable',
        generation: 4, reason: 'heartbeat_primary_timeout' }]);
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
  });

  it('classify the captured pane with the injected classifier and write limit evidence', () => {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-monitor-deps-'));
    try {
      const panes = [];
      const deps = createFableMonitorDeps({ runtimeProfile: { id: 'claude-ax-backup', fable: { mode: 'fable', generation: 4 } },
        monitorDir, sessionName: 'claude-user-pan', capturePane: session => { panes.push(session); return 'pane'; },
        classifyLimitDialog: text => (text === 'pane' ? { kind: 'credits_offer', text: 'Continue with usage credits' } : null) });
      const result = deps.detectLimitDialog();
      assert.deepEqual(panes, ['claude-user-pan']);
      deps.onLimitDialog({ ...result, source: 'heartbeat' });
      const evidence = JSON.parse(fs.readFileSync(path.join(monitorDir, LIMIT_EVIDENCE_FILE), 'utf8'));
      assert.equal(evidence.kind, 'credits_offer');
      assert.equal(evidence.runtime_profile, 'claude-ax-backup');
      const other = createFableMonitorDeps({ runtimeProfile: { id: 'x', fable: { mode: 'fable' } }, monitorDir,
        capturePane: () => 'pane', classifyLimitDialog: () => ({ kind: 'something_else' }) });
      assert.equal(other.detectLimitDialog(), null);
    } finally {
      fs.rmSync(monitorDir, { recursive: true, force: true });
    }
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
