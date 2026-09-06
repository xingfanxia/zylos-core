import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContextMonitorBase } from '../context-monitor-base.js';

test('publishes explicit null for missing, invalid and failed samples without threshold callbacks', async () => {
  const monitor = new ContextMonitorBase();
  const samples = [];
  let handoffs = 0;
  for (const usage of [null, { used: -1, ceiling: 100 }, { used: Infinity, ceiling: 100 }, { used: 1, ceiling: 0 }]) {
    monitor.getUsage = async () => usage;
    await monitor.checkThreshold({ onSample: (sample) => samples.push(sample), onExceed: () => handoffs++ });
  }
  monitor.getUsage = async () => { throw new Error('unreadable rollout'); };
  await monitor.checkThreshold({ onSample: (sample) => samples.push(sample), onExceed: () => handoffs++ });
  assert.deepEqual(samples, [null, null, null, null, null]);
  assert.equal(handoffs, 0);
});

test('publishes every valid reading before threshold handling, including unchanged idle context', async () => {
  const monitor = new ContextMonitorBase();
  const order = [];
  monitor.getUsage = async () => ({ used: 80, ceiling: 100, source: 'rollout_token_count' });
  for (let i = 0; i < 2; i++) await monitor.checkThreshold({
    onSample: (sample) => order.push(['sample', sample.ratio]), onExceed: () => order.push(['handoff']),
  });
  assert.deepEqual(order, [['sample', 0.8], ['handoff'], ['sample', 0.8]]);
});
