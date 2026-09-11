import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  monitorDir,
  instanceId = null,
  nowMs = Date.now,
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

  const publishSample = (sample) => {
    if (!monitorDir) return;
    const valid = sample && Number.isFinite(sample.used) && sample.used >= 0 &&
      Number.isFinite(sample.ceiling) && sample.ceiling > 0;
    const percentUsed = valid ? Math.round(sample.used / sample.ceiling * 100) : null;
    const profile = activeAdapter.config?.runtimeProfile || {};
    const snapshot = {
      version: 1,
      runtime: activeAdapter.runtimeId,
      runtime_profile: profile.id || null,
      model: profile.model || null,
      instance_id: instanceId,
      observed_at: new Date(nowMs()).toISOString(), // poll time, including idle sessions
      available: !!valid,
      status: valid ? 'ok' : 'unknown',
      reason: valid ? null : 'sample_unavailable',
      used_tokens: valid ? sample.used : null,
      ceiling_tokens: valid ? sample.ceiling : null,
      percent_used: percentUsed,
      percent_remaining: valid ? Math.max(0, 100 - percentUsed) : null,
      threshold_percent: Math.round(monitor.threshold * 100),
      source: valid ? sample.source || null : null,
      rollout_path: valid ? sample.rolloutPath || null : null,
    };
    const file = path.join(monitorDir, 'context-window.json');
    try {
      fs.mkdirSync(monitorDir, { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (error) {
      // Observability must not disable the threshold/handoff safety mechanism.
      log(`Context snapshot write failed: ${error.message}`);
    }
  };
  publishSample(null); // invalidate an old engine's file before the first poll
  monitor.startPolling({
    intervalMs: 30_000,
    onSample: publishSample,
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
  env = process.env,
  zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  lstatSyncImpl = fs.lstatSync,
}) {
  // This is a legacy SINGLE-session migration helper. In multi-instance
  // installs, claude-main is often admin's stable Codex identity: another
  // persona must never infer a stale engine from that name and kill it.
  const legacySingleSession = () => {
    if (env.ZYLOS_INSTANCE_ID) return false;
    try { if (!fs.statSync(zylosDir).isDirectory()) return false; }
    catch { return false; } // unknown workspace/access is never permission to kill
    try {
      lstatSyncImpl(path.join(zylosDir, 'instances.json'));
      return false; // presence protects every persona, even malformed/symlink config
    } catch (error) {
      return error.code === 'ENOENT'; // unreadable/unknown configuration fails closed
    }
  };
  if (!legacySingleSession()) return;
  if (!['claude', 'codex'].includes(activeAdapter.runtimeId) ||
      activeAdapter.sessionName !== `${activeAdapter.runtimeId}-main`) return;
  const otherSession = activeAdapter.runtimeId === 'codex' ? 'claude-main' : 'codex-main';
  // Runtime failover deliberately preserves the persona's stable tmux name
  // (often `claude-main`) across providers. Never mistake that active stable
  // identity for a stale session and kill it ten seconds after every restart.
  if (otherSession === activeAdapter.sessionName) return;
  setTimeoutImpl(() => {
    // Configuration can change during the grace period. Re-check immediately
    // before the legacy destructive action instead of trusting startup state.
    if (!legacySingleSession()) return;
    try {
      execFileSyncImpl('tmux', ['kill-session', '-t', otherSession], { stdio: 'pipe', timeout: 3000 });
      log(`Startup cleanup: killed stale ${otherSession} session from previous runtime`);
    } catch { /* session didn't exist, normal startup no-op */ }
  }, 10_000);
}
