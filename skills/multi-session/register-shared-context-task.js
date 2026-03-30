#!/usr/bin/env node
/**
 * Register the shared-context-digest scheduled task.
 *
 * Run once during `zylos init` or manually to register the digest
 * generator as a recurring scheduler task (every 30 minutes).
 *
 * Usage:
 *   node skills/multi-session/register-shared-context-task.js
 *
 * ESM module — Node 20+.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const CLI_PATH = path.join(ZYLOS_DIR, '.claude', 'skills', 'scheduler', 'scripts', 'cli.js');
const SCRIPT_PATH = path.join(ZYLOS_DIR, '.claude', 'skills', 'multi-session', 'shared-context.js');

const args = [
  CLI_PATH,
  'add',
  '--name', 'shared-context-digest',
  '--description', 'Generate cross-instance activity digest',
  '--every', '1800',
  '--require-idle',
  '--priority', '3',
  '--prompt', `Run: node ${SCRIPT_PATH}`
];

try {
  const result = execFileSync('node', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000
  });
  console.log('[register-shared-context] Task registered successfully.');
  if (result.trim()) console.log(result.trim());
} catch (err) {
  console.error(`[register-shared-context] Failed to register task: ${err.message}`);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
}
