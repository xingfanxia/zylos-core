#!/usr/bin/env node

/**
 * Auth Prompt Hook — logs PermissionRequest events. It never answers them.
 *
 * Registered as a PermissionRequest hook. Claude Code fires this only
 * when a tool call requires user permission (not for auto-allowed tools).
 *
 * It used to auto-approve by queueing a [KEYSTROKE]Enter. On 2026-11-18 that
 * Enter was queued for Claude Code 2.1.326's dangerous-command prompt about
 * user-pan's own `rm -f $D/*` (asked even with --dangerously-skip-permissions)
 * and was only held back because the prompt was misread; read correctly, it
 * would have selected "1. Yes". An unattended session's permission prompt is
 * now only ever cancelled: the activity monitor's dialog watch sends Escape
 * after 60 s and tells the session why, and the dispatcher sends no other key
 * to a permission prompt. The `auto_approve_permission` config key no longer
 * has any effect.
 *
 * Log file: ~/zylos/activity-monitor/hook-timing.log (shared with other hooks)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-timing.log');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return; // malformed input, skip
  }

  const tool = hookData.tool_name || '(unknown)';
  const inputKeys = hookData.tool_input ? Object.keys(hookData.tool_input).join(',') : '';
  const mode = typeof hookData.permission_mode === 'string' ? hookData.permission_mode.replace(/[^\w-]/g, '').slice(0, 32) : 'unknown';
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] hook=auth-prompt event=PermissionRequest tool=${tool} input_keys=[${inputKeys}] mode=${mode}\n`;

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort — don't crash hook pipeline
  }
}

main().catch(() => {});
