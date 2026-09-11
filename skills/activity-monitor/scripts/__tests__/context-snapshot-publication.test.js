import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-context-publication-'));
process.env.ZYLOS_DIR = root;
process.env.ZYLOS_INSTANCE_ID = 'group';
const stateDir = path.join(root, 'instances/group');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ instances: {
  group: { runtime: 'codex', runtime_profile: 'codex-azure', state_dir: stateDir },
} }));
const { startContextMonitor } = await import('../adapters/runtime-components.js');
const { getMonitorDir } = await import('../../../multi-session/instance-config.js');
const { ContextMonitorBase } = await import('../../../../cli/lib/runtime/context-monitor-base.js');
const { readContextWindowSnapshot } = await import('../../../web-console/scripts/dashboard-data.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('publishes current Codex context to getMonitorDir and invalidates stale engine data', async () => {
  const file = path.join(stateDir, 'context-window.json');
  fs.writeFileSync(file, JSON.stringify({ runtime: 'claude', percent_used: 17 }));
  let clock = Date.now();
  let usage = { used: 210000, ceiling: 258400, source: 'rollout_token_count', rolloutPath: '/profile/sessions/2026/01/01/rollout-idle.jsonl' };
  const monitor = new ContextMonitorBase();
  monitor.getUsage = async () => usage;
  monitor.startPolling = (options) => { monitor.options = options; };
  const handoffs = [];
  const adapter = { runtimeId: 'codex', displayName: 'Codex', config: {
    runtimeProfile: { id: 'codex-azure', model: 'gpt-6-astra' },
  }, getContextMonitor: () => monitor };
  startContextMonitor(adapter, { monitorDir: getMonitorDir(), instanceId: 'group', nowMs: () => clock,
    enqueueContextRotationHandoff: (reading) => { handoffs.push(reading); assert.equal(JSON.parse(fs.readFileSync(file)).used_tokens, reading.used); },
    log: () => {},
  });
  assert.equal(JSON.parse(fs.readFileSync(file)).available, false);
  await monitor.checkThreshold(monitor.options);
  let snapshot = JSON.parse(fs.readFileSync(file));
  assert.equal(snapshot.runtime, 'codex');
  assert.equal(snapshot.instance_id, 'group');
  assert.equal(snapshot.runtime_profile, 'codex-azure');
  assert.equal(snapshot.used_tokens, 210000);
  assert.equal(snapshot.percent_used, 81);
  assert.equal(handoffs.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'activity-monitor/group/context-window.json')), false);
  clock += 180000;
  await monitor.checkThreshold(monitor.options);
  snapshot = JSON.parse(fs.readFileSync(file));
  assert.equal(snapshot.observed_at, new Date(clock).toISOString());
  fs.utimesSync(file, 0, 0); // publication time, not old rollout/file mtime, owns freshness
  assert.equal(readContextWindowSnapshot({ instanceId: 'group', instanceDef: {
    runtime: 'codex', runtime_profile: 'codex-azure', state_dir: stateDir,
  }, runtimeProfile: { model: 'gpt-6-astra' }, zylosDir: root, nowMs: clock }).available, true);
  usage = null;
  await monitor.checkThreshold(monitor.options);
  snapshot = JSON.parse(fs.readFileSync(file));
  assert.equal(snapshot.status, 'unknown');
  assert.equal(snapshot.used_tokens, null);
  assert.equal(snapshot.percent_used, null);
});

test('snapshot I/O failure does not suppress the real threshold handoff', async () => {
  const blocked = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocked, 'fixture');
  const monitor = new ContextMonitorBase();
  monitor.getUsage = async () => ({ used: 80, ceiling: 100, source: 'rollout_token_count', rolloutPath: '/profile/rollout.jsonl' });
  monitor.startPolling = (options) => { monitor.options = options; };
  let handoffs = 0;
  const messages = [];
  startContextMonitor({ runtimeId: 'codex', getContextMonitor: () => monitor }, {
    monitorDir: blocked, instanceId: 'group', enqueueContextRotationHandoff: () => handoffs++,
    log: (line) => messages.push(line),
  });
  await monitor.checkThreshold(monitor.options);
  assert.equal(handoffs, 1);
  assert.ok(messages.some((line) => line.includes('snapshot write failed')));
});
