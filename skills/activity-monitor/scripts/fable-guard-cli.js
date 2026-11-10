#!/usr/bin/env node
/**
 * Fable guard operator command (docs/fable-allowance-guard.md).
 *
 *   node fable-guard-cli.js status [--json]
 *   node fable-guard-cli.js clear <account> <quota|stale|crash|all> [--reason <text>]
 *   node fable-guard-cli.js reconcile [--json]   # one guard pass now (used by --apply)
 *
 * `clear` edits only the guard state, under the same instances.json lock the
 * runtime-failover daemon holds. A hold whose cause is still present (for
 * example a reading at or above the threshold, or an expired lease) is
 * re-armed by the daemon on its next pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../../multi-session/file-lock.js';
import { fableGuardStatePath, fableUsagePath, readFableGuardConfig } from '../../multi-session/runtime-files.js';
import { clearFableHold, reconcileFableGuardNow, writeJsonAtomic } from './fable-guard.js';
import { FABLE_OBSERVATION_FILE, LEASE_ENFORCEMENT_FILE, UNCERTAIN_DELIVERIES_FILE } from './fable-monitor.js';
import { FABLE_LAUNCH_FILE } from '../../multi-session/runtime-files.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

function monitorDirOf(zylosDir, id, instance) {
  return typeof instance?.state_dir === 'string' && instance.state_dir
    ? instance.state_dir.replace(/^~/, os.homedir()) : path.join(zylosDir, 'activity-monitor', id);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

export function fableGuardStatus({ zylosDir = ZYLOS_DIR, nowMs = Date.now() } = {}) {
  const document = readJson(path.join(zylosDir, 'instances.json'), {});
  const state = readJson(fableGuardStatePath(zylosDir), {}) || {};
  const usage = readJson(fableUsagePath(zylosDir), {}) || {};
  const accounts = {};
  for (const account of new Set([...Object.keys(usage.accounts || {}), ...Object.keys(state.holds || {})])) {
    const entry = usage.accounts?.[account] || {};
    const obs = entry.last_valid || null;
    accounts[account] = {
      holds: state.holds?.[account] || {},
      observation: obs && {
        utilization: obs.utilization,
        resets_at: obs.resets_at,
        observed_at: obs.observed_at,
        age_sec: Math.round((nowMs - Date.parse(obs.observed_at)) / 1000),
        cli_version: obs.cli_version,
      },
      last_attempt: entry.last_attempt || null,
      next_probe_at: entry.next_probe_at || null,
    };
  }
  const personas = {};
  for (const [id, persona] of Object.entries(state.personas || {})) {
    const monitorDir = monitorDirOf(zylosDir, id, document.instances?.[id]);
    const launch = readJson(path.join(monitorDir, FABLE_LAUNCH_FILE), null);
    const enforcement = readJson(path.join(monitorDir, LEASE_ENFORCEMENT_FILE), null);
    const observation = readJson(path.join(monitorDir, FABLE_OBSERVATION_FILE), null);
    personas[id] = {
      fable_enabled: document.instances?.[id]?.fable_enabled === true,
      desired: persona.desired || null,
      verified: persona.verified || null,
      attempts: persona.attempts || 0,
      launch: launch && { launch_id: launch.launch_id, mode: launch.mode, runtime_profile: launch.runtime_profile,
        generation: launch.generation, reason: launch.reason, at: new Date(Number(launch.launched_at_ms)).toISOString() },
      ...(persona.unsupported ? { unsupported: persona.unsupported } : {}),
      ...(persona.executing ? { executing: persona.executing } : {}),
      ...(persona.gave_up ? { gave_up: persona.gave_up } : {}),
      ...(persona.safe_stop ? { safe_stop: persona.safe_stop } : {}),
      ...(enforcement ? { lease_enforcement: enforcement } : {}),
      ...(observation?.alert ? { observation_alert: observation.alert } : {}),
      ...(observation?.unknown_stops?.length ? { unknown_evidence_stops: observation.unknown_stops } : {}),
      uncertain_deliveries: (readJson(path.join(monitorDir, UNCERTAIN_DELIVERIES_FILE), {})?.records || []).slice(-5),
    };
  }
  return { config: readFableGuardConfig(document), accounts, personas, manual_clears: state.manual_clears || [] };
}

export function clearHoldCommand({ zylosDir = ZYLOS_DIR, account, kind, reason = 'manual', nowMs = Date.now() }) {
  const lockPath = `${path.join(zylosDir, 'instances.json')}.lock`;
  return withFileLock(lockPath, () => {
    const file = fableGuardStatePath(zylosDir);
    const result = clearFableHold(readJson(file, null), { account, kind, nowMs, reason });
    writeJsonAtomic(file, result.state);
    return result.cleared;
  });
}

function main(argv) {
  const [command = 'status', ...rest] = argv;
  if (command === 'status') {
    const status = fableGuardStatus();
    console.log(rest.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status));
    return 0;
  }
  if (command === 'clear') {
    const [account, kind] = rest;
    const reasonAt = rest.indexOf('--reason');
    if (!account || !kind) {
      console.error('usage: fable-guard-cli.js clear <account> <quota|stale|crash|all> [--reason <text>]');
      return 2;
    }
    const cleared = clearHoldCommand({ account, kind, reason: reasonAt >= 0 ? rest[reasonAt + 1] || 'manual' : 'manual' });
    console.log(cleared.length ? `cleared ${account}: ${cleared.join(', ')}` : `no ${kind} hold on ${account}`);
    return 0;
  }
  if (command === 'reconcile') {
    const lines = [];
    const result = reconcileFableGuardNow({ zylosDir: ZYLOS_DIR, log: line => lines.push(line) });
    const summary = { events: result.events, executed: result.executed.map(({ instanceId, generation, kind, mode, profileId, reason }) =>
      ({ instanceId, generation, kind, mode, profileId, reason })) };
    console.log(rest.includes('--json') ? JSON.stringify(summary, null, 2) : lines.join('\n') || 'fable guard: nothing to do');
    return 0;
  }
  console.error('usage: fable-guard-cli.js status [--json] | clear <account> <kind|all> [--reason <text>] | reconcile [--json]');
  return 2;
}

function formatStatus({ config, accounts, personas }) {
  const lines = [config ? `config: fable_model=${config.fable_model} threshold=${config.threshold}` : 'config: not configured (guard inert)'];
  for (const [account, item] of Object.entries(accounts)) {
    const obs = item.observation;
    const holds = Object.keys(item.holds);
    lines.push(`account ${account}: holds=${holds.length ? holds.join('+') : 'none'}`
      + (obs ? ` fable=${Math.round(obs.utilization * 100)}% resets=${obs.resets_at} age=${obs.age_sec}s` : ' no valid observation')
      + (item.last_attempt ? ` last=${item.last_attempt.outcome}` : ''));
  }
  for (const [id, item] of Object.entries(personas)) {
    const head = `persona ${id}: enabled=${item.fable_enabled} desired=${item.desired?.mode || '-'}@${item.desired?.account || '-'}`
      + ` g${item.desired?.generation ?? '-'}`;
    if (item.unsupported) {
      lines.push(`${head} UNSUPPORTED account ${item.desired?.account}: always Opus (no own settings file to probe)`);
      continue;
    }
    const verified = item.verified || {};
    const state = verified.ready_at ? 'ready' : verified.model_at ? `model ok, readiness ${verified.readiness || 'pending'}`
      : verified.not_running_at ? 'not running' : 'converging';
    lines.push(`${head} launch=${item.launch ? `${item.launch.mode}@${item.launch.runtime_profile} g${item.launch.generation ?? '-'}` : '-'}`
      + ` state=${state}`
      + (item.safe_stop?.confirmed_at
        ? ` SAFE-STOPPED (${item.safe_stop.why}, confirmed ${item.safe_stop.confirmed_at}); after checking: pm2 start activity-monitor-${id}`
        : item.safe_stop ? ` SAFE-STOP PENDING (${item.safe_stop.why}, attempt ${item.safe_stop.attempts || 1}`
          + `${item.safe_stop.last_error ? `: ${item.safe_stop.last_error}` : ''}); Fable may still be running` : '')
      + (item.gave_up && !item.safe_stop ? ` GAVE UP (${item.gave_up})` : '')
      + (item.observation_alert ? ` ALERT model observation unavailable since ${item.observation_alert.since}`
        + ` (session ${item.observation_alert.session_ref || '-'}): no process --model and no statusline model readable by the monitor;`
        + ' Fable not admitted, Opus launch kept, not recycled' : '')
      + (item.lease_enforcement ? ` lease-enforcement ${item.lease_enforcement.status || 'stopped'} ${item.lease_enforcement.at}`
        + (item.lease_enforcement.last_error && item.lease_enforcement.status === 'pending' ? ` (${item.lease_enforcement.last_error})` : '') : '')
      + item.uncertain_deliveries.map(entry => ` UNCERTAIN DELIVERY ${entry.item_type} #${entry.item_id}`
        + `${entry.preview ? ` "${entry.preview}"` : ''} at ${entry.detected_at}`
        + (entry.notified_at ? ` (operator notified ${entry.notified_at})`
          : ` (operator NOT notified${entry.notify_attempts ? ` after ${entry.notify_attempts} attempts: ${entry.last_notify_error}` : ''})`)).join(''));
  }
  return lines.join('\n');
}

if (process.env.FABLE_GUARD_CLI_DISABLE_MAIN !== '1') {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`fable-guard-cli: ${err.message}`);
    process.exitCode = 1;
  }
}
