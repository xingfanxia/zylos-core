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

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

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
    personas[id] = {
      fable_enabled: document.instances?.[id]?.fable_enabled === true,
      desired: persona.desired || null,
      verified: persona.verified || null,
      attempts: persona.attempts || 0,
      ...(persona.gave_up ? { gave_up: persona.gave_up } : {}),
      ...(persona.possible_dropped_message ? { possible_dropped_message: persona.possible_dropped_message } : {}),
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
    lines.push(`persona ${id}: enabled=${item.fable_enabled} desired=${item.desired?.mode || '-'}@${item.desired?.account || '-'}`
      + ` g${item.desired?.generation ?? '-'} verified=${item.verified ? Object.keys(item.verified).join('+') : 'pending'}`
      + (item.possible_dropped_message ? ` POSSIBLE DROPPED MESSAGE near ${item.possible_dropped_message.at}` : ''));
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
