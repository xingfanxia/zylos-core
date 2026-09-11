import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createActivityMonitorTaskScheduler } from '../tasks/activity-monitor-tasks.js';

function createScheduler({ primary, healthCheckEnabled = true }) {
  let healthChecks = 0;
  const usageMonitor = {
    isMonitorEnabled: () => false,
    isAlertEnabled: () => false,
    isPrimaryInstance: () => primary,
  };

  const scheduler = createActivityMonitorTaskScheduler({
    usageMonitor,
    dailyUpgradeHour: 1,
    dailyMemoryCommitHour: 2,
    dailyUpgradeCheckHour: 3,
    healthCheckInterval: 60,
    usageCheckInterval: 60,
    usageAlertInterval: 60,
    usageFleetAlertInterval: 60,
    readDailyUpgradeEnabled: () => false,
    readHealthCheckEnabled: () => healthCheckEnabled,
    loadDailyUpgradeState: () => null,
    writeDailyUpgradeState: () => {},
    enqueueDailyUpgradeControl: () => true,
    loadMemoryCommitState: () => null,
    writeMemoryCommitState: () => {},
    executeDailyMemoryCommit: () => true,
    loadUpgradeCheckState: () => null,
    writeUpgradeCheckState: () => {},
    executeUpgradeCheck: () => true,
    loadHealthCheckState: () => null,
    enqueueHealthCheck: () => {
      healthChecks++;
      return true;
    },
    getLocalHour: () => 12,
    getLocalDate: () => '2026-09-05',
    nowEpoch: () => 1000,
    log: () => {},
  });

  return { scheduler, healthChecks: () => healthChecks };
}

describe('activity-monitor task routing', () => {
  it('runs the fleet health check on the primary instance', () => {
    const test = createScheduler({ primary: true });

    assert.equal(test.scheduler.tick({ agentRunning: true, health: 'ok' }), 1);
    assert.equal(test.healthChecks(), 1);
  });

  it('does not run the fleet health check on a non-primary instance', () => {
    const test = createScheduler({ primary: false });

    assert.equal(test.scheduler.tick({ agentRunning: true, health: 'ok' }), 0);
    assert.equal(test.healthChecks(), 0);
  });

  it('keeps the health-check feature toggle effective on the primary instance', () => {
    const test = createScheduler({ primary: true, healthCheckEnabled: false });

    assert.equal(test.scheduler.tick({ agentRunning: true, health: 'ok' }), 0);
    assert.equal(test.healthChecks(), 0);
  });
});
