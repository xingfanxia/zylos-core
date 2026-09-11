import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planUsageMilestones } from '../usage-milestones.js';
const now = Date.parse('2026-09-13T00:00:00Z') / 1000;
const reset = now + 86400 * 6;
const reading = (weekly, extra = {}) => ({ accountKey: 'a'.repeat(64), weekly,
  weeklyAllResetsAt: new Date(reset * 1000).toISOString(), ...extra });
const saved = plan => ({ milestones: plan.ledger });

test('seconds of reset jitter and 90→91→92 produce one notice, then 100 produces one', () => {
  let state = {};
  for (const [percent, seconds, expected] of [[90, 0, 1], [91, 22, 0], [91, -12, 0], [92, 50, 0], [95, 25, 0], [100, 40, 1]]) {
    const plan = planUsageMilestones(state, reading(percent, { weeklyAllResetsAt: new Date((reset + seconds) * 1000).toISOString() }), now + 60);
    assert.equal(plan.changed.length, expected); state = saved(plan);
  }
});
test('progress persists across return to an account, falling readings and monitor restarts', () => {
  let state = saved(planUsageMilestones({}, reading(90), now));
  const other = planUsageMilestones(state, reading(20, { accountKey: 'b'.repeat(64) }), now + 1);
  assert.deepEqual(other.changed, ['weekly']); state = saved(other);
  for (const percent of [91, 80, 90, 99]) {
    const plan = planUsageMilestones(JSON.parse(JSON.stringify(state)), reading(percent), now + 2);
    assert.deepEqual(plan.changed, []); state = saved(plan);
  }
});
test('only real later cycles re-arm, not a moved deadline before previous cycle ends', () => {
  let state = saved(planUsageMilestones({}, reading(90), now));
  const next = { weeklyAllResetsAt: new Date((reset + 86400 * 7) * 1000).toISOString() };
  assert.deepEqual(planUsageMilestones(state, reading(90, next), now + 60).changed, []);
  const plan = planUsageMilestones(state, reading(10, next), reset + 60);
  assert.deepEqual(plan.changed, ['weekly']);
  assert.deepEqual(planUsageMilestones(saved(plan), reading(11, next), reset + 120).changed, []);
});
test('migration seeds already-notified level without a duplicate and windows are independent', () => {
  const plan = planUsageMilestones({ lastAlertedAt: '2026-09-13T00:00:00Z' }, reading(92), now);
  assert.deepEqual(plan.changed, []);
  const next = planUsageMilestones(saved(plan), reading(92, { fiveHour: 10, fiveHourResetsAt: new Date((now + 3600) * 1000).toISOString() }), now);
  assert.deepEqual(next.changed, ['fiveHour']);
});
test('missing, expired, invalid quota never creates a crossed milestone', () => {
  for (const weekly of [null, undefined, -1, 101, '90', NaN]) assert.deepEqual(planUsageMilestones({}, reading(weekly), now).changed, []);
  assert.deepEqual(planUsageMilestones({}, reading(90, { weeklyAllResetsAt: new Date(now * 1000).toISOString() }), now).changed, []);
});
