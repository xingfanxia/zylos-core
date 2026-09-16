import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-heartbeat-interval-'));
process.env.ZYLOS_DIR = root;
const personas = ['admin', 'scheduler', 'group', 'user-pan', 'user-elaine', 'user-sean'];
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({
  instances: Object.fromEntries(personas.map(id => [id, {
    runtime: 'codex', ...(id === 'scheduler' ? { heartbeat_interval: 7200 } : {}),
  }])),
}));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { getInstanceDef } = await import('../../../multi-session/instance-config.js');
const { createHealthEngine } = await import('../adapters/runtime-components.js');

function fixture(t, heartbeatInterval, initialHealth = 'ok') {
  const probes = [], logs = [];
  const engine = createHealthEngine({
    getHeartbeatDeps: () => ({
      enqueueHeartbeat: phase => { probes.push(phase); return true; },
      readHeartbeatPending: () => null,
      clearHeartbeatPending: () => {},
    }),
    stop: () => assert.fail('interval configuration must not kill the runtime'),
  }, { health: initialHealth }, {
    heartbeatInterval,
    log: message => logs.push(message),
  });
  t.after(() => engine.destroy());
  engine.lastHeartbeatAt = 10000;
  return { engine, probes, logs };
}

test('scheduler setting changes primary cadence without changing any other persona', t => {
  for (const id of personas) {
    const { engine, probes, logs } = fixture(t, getInstanceDef(id)?.heartbeat_interval);
    const seconds = id === 'scheduler' ? 7200 : 1800;
    assert.equal(engine.heartbeatInterval, seconds, id);
    engine.runMaintenanceCycle(true, 10000 + 1799);
    assert.deepEqual(probes, [], id);
    engine.runMaintenanceCycle(true, 10000 + 1800);
    assert.deepEqual(probes, id === 'scheduler' ? [] : ['primary'], id);
    if (id === 'scheduler') {
      engine.runMaintenanceCycle(true, 10000 + 7199);
      assert.deepEqual(probes, []);
      engine.runMaintenanceCycle(true, 10000 + 7200);
      assert.deepEqual(probes, ['primary']);
    }
    assert.ok(logs.includes(`Primary heartbeat interval: ${seconds}s`));
  }
});

test('absent and invalid intervals retain the safe 1800-second default', t => {
  for (const value of [undefined, null, 0, -1, 1.5, '7200', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { engine } = fixture(t, value);
    assert.equal(engine.heartbeatInterval, 1800, String(value));
  }
});

test('scheduler override retains recovery and down-state probe timing', t => {
  const recovery = fixture(t, 7200, 'recovering');
  recovery.engine.lastRecoveryAt = 10000;
  recovery.engine.restartFailureCount = 1;
  recovery.engine.runMaintenanceCycle(true, 10059);
  assert.deepEqual(recovery.probes, []);
  recovery.engine.runMaintenanceCycle(true, 10060);
  assert.deepEqual(recovery.probes, ['recovery']);

  const down = fixture(t, 7200, 'down');
  down.engine.lastDownCheckAt = 10000;
  down.engine.runMaintenanceCycle(true, 13599);
  assert.deepEqual(down.probes, []);
  down.engine.runMaintenanceCycle(true, 13600);
  assert.deepEqual(down.probes, ['down-check']);
});

test('scheduler override retains degraded and rate-limit recovery probe timing', t => {
  const degraded = fixture(t, 7200, 'degraded');
  degraded.engine.lastDegradedProbeAt = 10000;
  degraded.engine.runMaintenanceCycle(true, 11199);
  assert.deepEqual(degraded.probes, []);
  degraded.engine.runMaintenanceCycle(true, 11200);
  assert.deepEqual(degraded.probes, ['recovery']);

  const limited = fixture(t, 7200, 'rate_limited');
  limited.engine.lastRecoveryAt = 10000;
  limited.engine.runMaintenanceCycle(true, 10899);
  assert.deepEqual(limited.probes, []);
  limited.engine.runMaintenanceCycle(true, 10900);
  assert.deepEqual(limited.probes, ['recovery']);
});

test('scheduler override retains startup verification at the end of the grace period', t => {
  const { engine, probes } = fixture(t, 7200);
  engine.now = () => 10000 * 1000;
  engine.notifyColdStart(30);
  engine.runMaintenanceCycle(true, 10029);
  assert.deepEqual(probes, []);
  engine.runMaintenanceCycle(true, 10030);
  assert.deepEqual(probes, ['primary']);
});
