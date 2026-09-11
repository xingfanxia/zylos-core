import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import { Guardian } from '../guardian.js';
import { HealthEngine } from '../health-engine.js';
import { ProcSampler } from '../proc-sampler.js';
import { ToolPipeline } from '../tool-pipeline.js';
import { UsageMonitor } from '../usage-monitor.js';
import { getToolRules } from '../tool-rules.js';
import {
  createMemorySyncControlPrompt,
  markMemorySyncRequested,
  shouldTriggerMemorySync,
} from '../memory-sync-gate.js';

export function createUsageMonitor(activeAdapter, options) {
  return new UsageMonitor(activeAdapter, options);
}

export function createProcSampler(activeAdapter, { log, findRuntimePidUnderPane }) {
  return new ProcSampler({ sessionName: activeAdapter.sessionName, log, findRuntimePidUnderPane });
}

export function createToolPipeline(activeAdapter, config, {
  files,
  getRuntimeLaunchAtMs,
  isPidAlive,
  log,
}) {
  const rules = getToolRules({ runtimeId: activeAdapter.runtimeId, config });
  return {
    pipeline: new ToolPipeline({
      files,
      toolRules: rules,
      runtimeLaunchAtMs: getRuntimeLaunchAtMs,
      isPidAlive,
      log,
    }),
    toolRules: rules,
  };
}

export function createHealthEngine(activeAdapter, initialStatus, {
  log,
  rateLimitDefaultCooldown,
  userMessageRecoveryCooldown,
  flapCeilingPerHour,
  degradedProbeInterval,
  rateLimitProbeInterval,
  notifyDegraded,
}) {
  return new HealthEngine({
    ...(activeAdapter.getHeartbeatDeps() ?? {}),
    killTmuxSession: () => activeAdapter.stop(),
    checkAuth: (options) => activeAdapter.checkAuth
      ? activeAdapter.checkAuth(options)
      : { status: 'success', reason: 'no_checkAuth' },
    notifyDegraded, // REL-3: out-of-band admin alert on the flap-ceiling transition
    log,
  }, {
    initialHealth: initialStatus.health,
    initialReason: initialStatus.unavailable_reason || '',
    rateLimitDefaultCooldown,
    userMessageRecoveryCooldown,
    flapCeilingPerHour,
    degradedProbeInterval,
    rateLimitProbeInterval,
  });
}

export function createGuardian(activeAdapter, activeToolPipeline, initialRuntimeLaunchAtMs, {
  apiActivityFile,
  hookStateFile,
  monitorDir,
  signalTtlSec,
  log,
}) {
  return new Guardian(activeAdapter, {
    log,
    monitorDir, // ZY-LIFE-1: enables the auto-suspend gate
    signalTtlSec, // REL-6: orphaned suspend/wake signals are ignored + deleted
    initialRuntimeLaunchAtMs,
    resetToolLifecycleState: () => {
      activeToolPipeline.reset({ clearFiles: true });
      fs.writeFileSync(apiActivityFile, JSON.stringify({
        version: 3,
        active: false,
        active_tools: 0,
        in_prompt: false,
        updated_at: Date.now(),
      }));
      fs.writeFileSync(hookStateFile, JSON.stringify({ active_tools: 0 }));
    },
  });
}

export function startContextMonitor(activeAdapter, {
  getUnsummarizedCount,
  checkpointThreshold,
  loadContextMonitorState,
  saveContextMonitorState,
  memorySyncCooldownSeconds,
  memorySyncInFlightTtlSeconds,
  c4ControlPath,
  enqueueContextRotationHandoff,
  log,
}) {
  // Start context monitor if the adapter provides one (Codex polling-based monitor).
  // Claude uses the statusLine hook instead — no adapter-provided monitor.
  const monitor = activeAdapter.getContextMonitor?.() ?? null;
  if (!monitor) return null;

  monitor.startPolling({
    intervalMs: 30_000,
    onExceed: async ({ used, ceiling, ratio }) => {
      const pct = Math.round(ratio * 100);
      log(`Context at ${pct}% (${used}/${ceiling}), requesting new-session handoff`);
      enqueueContextRotationHandoff({ ratio, used, ceiling });
    },
    onEarlyThreshold: async ({ used, ceiling, ratio }) => {
      const pct = Math.round(ratio * 100);
      const thresholdPct = Math.round(monitor.threshold * 100);
      const now = Math.floor(Date.now() / 1000);
      const unsummarizedCount = getUnsummarizedCount();
      const state = loadContextMonitorState();
      const gate = shouldTriggerMemorySync({
        state,
        now,
        unsummarizedCount,
        checkpointThreshold,
        cooldownSeconds: memorySyncCooldownSeconds,
        inFlightTtlSeconds: memorySyncInFlightTtlSeconds,
      });

      if (!gate.shouldEnqueue) {
        if (gate.nextState !== state) {
          saveContextMonitorState(gate.nextState);
        }
        log(`Early memory sync skipped at ${pct}%: ${gate.reason} (unsummarized=${unsummarizedCount}, threshold=${checkpointThreshold})`);
        return;
      }
      log(`Context at ${pct}% (approaching ${thresholdPct}% threshold), triggering early memory sync (unsummarized=${unsummarizedCount})`);
      try {
        execFileSync('node', [c4ControlPath, 'enqueue',
          '--content', createMemorySyncControlPrompt({ pct, thresholdPct }),
          '--priority', '2',
          '--no-ack-suffix',
        ], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
        saveContextMonitorState(markMemorySyncRequested({
          state,
          now,
          unsummarizedCount,
          pct,
          thresholdPct,
          inFlightTtlSeconds: memorySyncInFlightTtlSeconds,
        }));
        log(`Early memory sync enqueued at ${pct}%`);
      } catch (err) {
        log(`Failed to enqueue early memory sync: ${err.message}`);
      }
    },
  });
  log(`Context monitor started (${activeAdapter.displayName})`);
  return monitor;
}

export function scheduleStaleRuntimeCleanup(activeAdapter, {
  log,
  setTimeoutImpl = setTimeout,
  execFileSyncImpl = execFileSync,
}) {
  // Runs on every startup (not just runtime switches). If the other session is
  // absent, the kill fails silently. The delay gives a running agent time to
  // finish its current response before being terminated.
  const otherSession = activeAdapter.runtimeId === 'codex' ? 'claude-main' : 'codex-main';
  // Runtime failover deliberately preserves the persona's stable tmux name
  // (often `claude-main`) across providers. Never mistake that active stable
  // identity for a stale session and kill it ten seconds after every restart.
  if (otherSession === activeAdapter.sessionName) return;
  setTimeoutImpl(() => {
    try {
      execFileSyncImpl('tmux', ['kill-session', '-t', otherSession], { stdio: 'pipe', timeout: 3000 });
      log(`Startup cleanup: killed stale ${otherSession} session from previous runtime`);
    } catch { /* session didn't exist, normal startup no-op */ }
  }, 10_000);
}
