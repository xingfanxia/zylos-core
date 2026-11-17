#!/usr/bin/env node
/**
 * Remove duplicate core hook registrations from one settings.json, and
 * nothing else.
 *
 * This is the targeted alternative to a full `sync-settings-hooks.js` run for
 * hosts where a full sync must not run (it would also add hooks the host has
 * deliberately left out, such as hook-health.js, and enqueue a restart). It
 * only removes: see pruneDuplicateHookRegistrations() for the exact rules.
 *
 * Usage:
 *   ZYLOS_DIR=<install> node cli/lib/prune-duplicate-hooks.js [--settings <path>]          # dry run (default)
 *   ZYLOS_DIR=<install> node cli/lib/prune-duplicate-hooks.js [--settings <path>] --apply  # write, with a .bak.<ts> copy
 *
 * Running Claude sessions keep the hooks they started with; the change takes
 * effect for each session at its next start.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneDuplicateHookRegistrations } from './sync-settings-hooks.js';

function countCommands(settings) {
  const counts = {};
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    counts[event] = groups.reduce((sum, group) => sum + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0);
  }
  return counts;
}

export function pruneSettingsFile({
  settingsPath,
  zylosDir,
  apply = false,
  now = Date.now(),
  log = console.log,
} = {}) {
  const original = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(original);
  const before = countCommands(settings);
  const removed = pruneDuplicateHookRegistrations(settings, { zylosDir });
  const after = countCommands(settings);

  for (const item of removed) {
    log(`  - ${item.event}[${item.matcher}]: ${item.command}  (${item.reason})`);
  }
  for (const event of Object.keys(before)) {
    if (before[event] !== after[event]) log(`  ${event}: ${before[event]} -> ${after[event]} commands`);
  }
  if (removed.length === 0) {
    log(`No duplicate hook registrations in ${settingsPath}.`);
    return { removed, written: false, backupPath: null };
  }
  if (!apply) {
    log(`Dry run: ${removed.length} registration(s) would be removed from ${settingsPath}. Re-run with --apply to write.`);
    return { removed, written: false, backupPath: null };
  }

  const backupPath = `${settingsPath}.bak.${now}`;
  fs.copyFileSync(settingsPath, backupPath);
  // writeFileSync on the existing path keeps its owner and mode.
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`Removed ${removed.length} registration(s) from ${settingsPath}; backup at ${backupPath}.`);
  log('Running sessions keep their current hooks until their next start.');
  return { removed, written: true, backupPath };
}

function parseArgs(argv) {
  const index = argv.indexOf('--settings');
  return {
    apply: argv.includes('--apply'),
    settingsPath: index === -1 ? null : argv[index + 1],
  };
}

export function main(argv = process.argv.slice(2)) {
  const zylosDir = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  const args = parseArgs(argv);
  const settingsPath = path.resolve(args.settingsPath || path.join(zylosDir, '.claude', 'settings.json'));
  pruneSettingsFile({ settingsPath, zylosDir, apply: args.apply });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
