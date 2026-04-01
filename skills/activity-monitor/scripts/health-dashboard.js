/**
 * Health Dashboard — system-wide health data for web console or CLI consumption.
 *
 * Exports getSystemHealth() which returns a JSON-serializable snapshot of:
 * - All instances: name, status, uptime, last_activity
 * - Token usage summary (from token-tracker)
 * - System resources: memory, disk, CPU load
 * - PM2 process list
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { getAllUsageSummary } from './token-tracker.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadInstancesConfig() {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) return null;
    return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function tmuxSessionExists(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function readStatusFile(statusPath) {
  try {
    if (!fs.existsSync(statusPath)) return null;
    const stat = fs.statSync(statusPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const data = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return { ...data, age_ms: ageMs };
  } catch {
    return null;
  }
}

function getPm2Processes() {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(raw).map(proc => ({
      name: proc.name,
      status: proc.pm2_env?.status || 'unknown',
      uptime_ms: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
      restarts: proc.pm2_env?.restart_time || 0,
      memory: proc.monit?.memory || 0,
      cpu: proc.monit?.cpu || 0,
    }));
  } catch {
    return [];
  }
}

function getDiskUsage() {
  try {
    const output = execSync('df -h / --output=size,used,avail,pcent 2>/dev/null | tail -1', {
      encoding: 'utf8',
      timeout: 15000,
    }).trim();
    const parts = output.split(/\s+/);
    return {
      total: parts[0] || 'unknown',
      used: parts[1] || 'unknown',
      available: parts[2] || 'unknown',
      used_percent: parts[3] || 'unknown',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a complete system health snapshot.
 *
 * @returns {object} JSON-serializable health data
 */
export function getSystemHealth() {
  const config = loadInstancesConfig();
  const pm2Processes = getPm2Processes();
  const timestamp = new Date().toISOString();

  // --- Instances ---
  const instances = [];

  if (config && config.instances) {
    for (const [id, inst] of Object.entries(config.instances)) {
      const tmuxSession = inst.tmux_session || `claude-${id}`;
      const stateDir = inst.state_dir
        ? inst.state_dir.replace(/^~/, os.homedir())
        : path.join(ZYLOS_DIR, 'activity-monitor', id);

      const tmuxAlive = tmuxSessionExists(tmuxSession);
      const statusFile = path.join(stateDir, 'agent-status.json');
      const statusData = readStatusFile(statusFile);

      // Determine effective status
      let status;
      if (tmuxAlive) {
        status = statusData?.state || 'running';
      } else if (statusData?.state === 'suspended') {
        status = 'suspended';
      } else {
        status = 'stopped';
      }

      // Read last user activity (UserPromptSubmit only, not heartbeats)
      let lastActivity = null;
      try {
        const apiFile = path.join(stateDir, 'api-activity.json');
        if (fs.existsSync(apiFile)) {
          const api = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
          const ts = api.last_user_activity || api.updated_at;
          if (ts) lastActivity = new Date(ts).toISOString();
        }
      } catch { /* best-effort */ }

      // Find matching PM2 process uptime
      const pm2Name = `activity-monitor-${id}`;
      const pm2Proc = pm2Processes.find(p => p.name === pm2Name);

      instances.push({
        id,
        runtime: inst.runtime || 'claude',
        type: inst.type || 'dedicated',
        primary: inst.primary || false,
        enabled: inst.enabled !== false,
        status,
        tmux_session: tmuxSession,
        tmux_alive: tmuxAlive,
        auto_suspend: inst.auto_suspend || false,
        idle_timeout_min: inst.idle_timeout_min || null,
        last_activity: lastActivity,
        uptime_ms: pm2Proc?.uptime_ms || null,
        agent_state: statusData?.state || null,
        health: statusData?.health || null,
        idle_seconds: statusData?.idle_seconds || null,
      });
    }
  }

  // --- Token usage ---
  let tokenUsage = [];
  try {
    tokenUsage = getAllUsageSummary();
  } catch { /* best-effort */ }

  // --- System resources ---
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const loadAvg = os.loadavg();

  const system = {
    memory: {
      total_mb: Math.round(memTotal / 1024 / 1024),
      used_mb: Math.round(memUsed / 1024 / 1024),
      free_mb: Math.round(memFree / 1024 / 1024),
      used_percent: Math.round((memUsed / memTotal) * 100),
    },
    disk: getDiskUsage(),
    cpu: {
      cores: os.cpus().length,
      load_1m: loadAvg[0],
      load_5m: loadAvg[1],
      load_15m: loadAvg[2],
    },
    uptime_hours: Math.round(os.uptime() / 3600 * 10) / 10,
    platform: os.platform(),
    hostname: os.hostname(),
  };

  return {
    timestamp,
    instances,
    token_usage: tokenUsage,
    system,
    pm2_processes: pm2Processes,
  };
}

// ---------------------------------------------------------------------------
// CLI: run directly for quick checks
// ---------------------------------------------------------------------------

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const health = getSystemHealth();
  console.log(JSON.stringify(health, null, 2));
}
