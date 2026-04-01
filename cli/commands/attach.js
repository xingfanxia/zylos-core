/**
 * Attach to the active runtime's tmux session with a detach hint.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { bold } from '../lib/colors.js';
import { getActiveAdapter, getAdapterForInstance } from '../lib/runtime/index.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

function resolvePrimaryInstance() {
  const instancesFile = path.join(ZYLOS_DIR, 'instances.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
    const entries = Object.entries(cfg.instances || {});
    if (entries.length === 0) return null;
    const primary = entries.find(([, inst]) => inst.primary === true) || entries.find(([id]) => id === cfg.default_instance) || entries[0];
    return { id: primary[0], ...primary[1] };
  } catch {
    return null;
  }
}

let SESSION = 'claude-main';
let RUNTIME_LABEL = 'Claude';
let INSTANCE_ID = null;
try {
  const primaryInstance = resolvePrimaryInstance();
  const adapter = primaryInstance
    ? getAdapterForInstance({ instanceId: primaryInstance.id, zylosDir: ZYLOS_DIR })
    : getActiveAdapter();
  SESSION = adapter.sessionName;
  RUNTIME_LABEL = adapter.displayName;
  INSTANCE_ID = primaryInstance?.id || null;
} catch { /* config absent — use Claude defaults */ }

export function attachCommand() {
  // Check if tmux session exists
  try {
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {
    // No tmux session — check why and give appropriate advice
    let pm2Running = false;
    try {
      const pm2Out = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      pm2Running = procs.some(p => p.name === 'activity-monitor' && p.pm2_env?.status === 'online');
    } catch {}

    if (pm2Running) {
      console.error(`No active ${RUNTIME_LABEL} session yet. Activity monitor is running — ${RUNTIME_LABEL} should start shortly.`);
      console.error(`  Check status: ${bold('zylos status')}`);
    } else {
      console.error(`No active ${RUNTIME_LABEL} session found.`);
      if (INSTANCE_ID) {
        console.error(`  Resume the primary instance: ${bold(`zylos instance resume ${INSTANCE_ID}`)}`);
      } else {
        console.error(`  First time? Run ${bold('zylos init')}`);
        console.error(`  Otherwise:  Run ${bold('zylos start')}`);
      }
    }
    process.exit(1);
  }

  // Show detach hint inside tmux for 3 seconds on attach
  try {
    execSync(`tmux set-hook -t "${SESSION}" client-attached 'display-message -d 3000 " Tip: Ctrl+B d to detach "'`, { stdio: 'pipe' });
  } catch {}

  // Attach — hands over terminal to tmux
  try {
    execFileSync('tmux', ['attach', '-t', SESSION], { stdio: 'inherit' });
  } catch {
    // Normal exit when detaching
  }
}
