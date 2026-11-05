#!/usr/bin/env node

import { isCliEntry } from '../../multi-session/cli-entry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClaudePid } from './claude-pid.js';
import { isManagedClaudeProcess } from './runtime-generation.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
// Multi-session: write to the per-instance state dir — monitor.js reads
// foreground-session.json from getMonitorDir(), so a shared-dir write here
// leaves every instance's monitor reading a file nothing writes.
let MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
// Fork: the managed pane is the instance's own tmux session, not claude-main.
let MANAGED_SESSION = process.env.ZYLOS_TMUX_SESSION || 'claude-main';
try {
  const { getMonitorDir, getSessionName } = await import('../../multi-session/instance-config.js');
  MONITOR_DIR = getMonitorDir(process.env.ZYLOS_INSTANCE_ID || undefined);
  if (!process.env.ZYLOS_TMUX_SESSION) MANAGED_SESSION = getSessionName(process.env.ZYLOS_INSTANCE_ID || undefined) || MANAGED_SESSION;
} catch { /* single-session fallback */ }
const FOREGROUND_SESSION_FILE = path.join(MONITOR_DIR, 'foreground-session.json');

// Fork: upstream's managed-pane check runs a tmux client from this hook, which
// an OS-isolated persona cannot reach (the server belongs to the service user).
// While #835 evidence is off the hook records as in 0.9.1; the monitor still
// validates the PID and foreground identity it reads.
function healthEvidenceEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ZYLOS_DIR, '.zylos', 'config.json'), 'utf8'));
    return config.runtime_health_evidence === true || config.runtime_health_evidence === 'true';
  } catch { return false; }
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function handleSessionForeground(payload, {
  observedAt = Date.now(),
  claudePid = getClaudePid(),
  managedProcess = isManagedClaudeProcess,
  platform = process.platform,
  session = MANAGED_SESSION,
  verifyManagedPane = healthEvidenceEnabled(),
} = {}) {
  const sessionId = payload?.session_id || process.env.CLAUDE_SESSION_ID || null;
  if (!sessionId) return null;
  if (payload?.agent_id || (verifyManagedPane && !managedProcess(claudePid, { platform, session }))) return null;

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }

  const record = {
    version: 1,
    session_id: sessionId,
    claude_pid: claudePid,
    runtime: 'claude',
    source: 'session_start',
    session_start_source: payload?.source || null,
    observed_at: observedAt
  };
  atomicWriteJson(FOREGROUND_SESSION_FILE, record);
  return record;
}

function runCli() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input || '{}');
      handleSessionForeground(payload);
    } catch {
      // Best-effort.
    }
  });
}

if (isCliEntry(import.meta.url)) {
  runCli();
}
