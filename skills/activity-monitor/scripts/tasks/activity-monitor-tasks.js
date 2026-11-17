import { TaskScheduler } from '../task-scheduler.js';

export function createActivityMonitorTaskScheduler({
  usageMonitor,
  dailyUpgradeHour,
  dailyMemoryCommitHour,
  dailyUpgradeCheckHour,
  healthCheckInterval,
  usageCheckInterval,
  usageAlertInterval,
  usageFleetAlertInterval,
  contentErrorAlert = null,
  contentErrorAlertInterval = 300,
  readDailyUpgradeEnabled,
  readHealthCheckEnabled,
  loadDailyUpgradeState,
  writeDailyUpgradeState,
  enqueueDailyUpgradeControl,
  loadMemoryCommitState,
  executeDailyMemoryCommit,
  loadUpgradeCheckState,
  writeUpgradeCheckState,
  executeUpgradeCheck,
  loadHealthCheckState,
  enqueueHealthCheck,
  getLocalHour,
  getLocalDate,
  nowEpoch,
  log,
}) {
  return new TaskScheduler([
    {
      id: 'daily-upgrade',
      type: 'daily',
      hour: dailyUpgradeHour,
      enabled: () => readDailyUpgradeEnabled(),
      gate: (snapshot) => snapshot.health === 'ok',
      loadState: loadDailyUpgradeState,
      writeState: writeDailyUpgradeState,
      execute: enqueueDailyUpgradeControl,
    },
    {
      id: 'daily-memory-commit',
      type: 'daily',
      hour: dailyMemoryCommitHour,
      // One monitor commits the shared memory repository, once a day; the
      // task's own record says whether today's run happened (see
      // daily-memory-commit.js).
      loadState: loadMemoryCommitState,
      execute: executeDailyMemoryCommit,
    },
    {
      id: 'daily-upgrade-check',
      type: 'daily',
      hour: dailyUpgradeCheckHour,
      gate: (snapshot) => snapshot.health === 'ok',
      loadState: loadUpgradeCheckState,
      writeState: writeUpgradeCheckState,
      execute: executeUpgradeCheck,
    },
    {
      id: 'health-check',
      type: 'interval',
      intervalSec: healthCheckInterval,
      // PM2 and the shared health log are owner-only resources on OS-isolated
      // installs. A per-instance monitor still runs for every user, so without
      // this primary gate each user-tier agent receives a task it cannot
      // execute. Keep one fleet-wide checker on the primary instance.
      enabled: () => readHealthCheckEnabled() && usageMonitor.isPrimaryInstance(),
      gate: (snapshot) => snapshot.agentRunning === true && snapshot.health === 'ok',
      getLastRunAt: () => loadHealthCheckState()?.last_check_at ?? 0,
      execute: enqueueHealthCheck,
    },
    {
      id: 'usage-monitor',
      type: 'interval',
      intervalSec: usageCheckInterval,
      enabled: () => usageMonitor.isMonitorEnabled(),
      gate: (snapshot) => snapshot.health === 'ok' && usageMonitor.canRunTask({
        claudeState: snapshot.state,
        idleSeconds: snapshot.idleSeconds,
        currentTime: snapshot.currentTime,
        apiActivity: snapshot.apiActivity,
      }),
      getLastRunAt: () => usageMonitor.getLastMonitorRunAt(),
      execute: (snapshot) => usageMonitor.runMonitor(snapshot),
    },
    {
      id: 'usage-alert',
      type: 'interval',
      intervalSec: usageAlertInterval,
      enabled: () => usageMonitor.isAlertEnabled(),
      gate: (snapshot) => snapshot.health === 'ok' && usageMonitor.canRunTask({
        claudeState: snapshot.state,
        idleSeconds: snapshot.idleSeconds,
        currentTime: snapshot.currentTime,
        apiActivity: snapshot.apiActivity,
        activeHoursOnly: true,
      }),
      getLastRunAt: () => usageMonitor.getLastAlertRunAt(),
      execute: (snapshot) => usageMonitor.runAlert(snapshot),
    },
    {
      // Fleet-level near-full alert. Admin-only single-alerter; NOT idle/
      // active-hours/pending-queue gated — a safety alert must fire during the
      // busy/kill-loop window that produced the incident. Only skipped when the
      // admin AM itself is auth_failed (can't send anyway).
      id: 'usage-fleet-alert',
      type: 'interval',
      intervalSec: usageFleetAlertInterval,
      enabled: () => usageMonitor.isAlertEnabled() && usageMonitor.isPrimaryInstance(),
      gate: (snapshot) => snapshot.health !== 'auth_failed',
      getLastRunAt: () => usageMonitor.getLastFleetAlertRunAt(),
      execute: (snapshot) => usageMonitor.runFleetAlert(snapshot),
    },
    {
      // Undelivered user messages whose content could not be built (spill
      // could not be handed to its recipient): one admin alert per new batch
      // of failed ids. Primary only, like the fleet alert; not health-gated,
      // because the send does not go through this instance's model.
      id: 'content-error-alert',
      type: 'interval',
      intervalSec: contentErrorAlertInterval,
      enabled: () => Boolean(contentErrorAlert) && usageMonitor.isPrimaryInstance(),
      getLastRunAt: () => contentErrorAlert.getLastRunAt(),
      execute: (snapshot) => contentErrorAlert.run(snapshot),
    },
  ], {
    getLocalHour,
    getLocalDate,
    nowEpoch,
    log,
  });
}
