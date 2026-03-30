/**
 * Instance management commands
 *
 * zylos instance list
 * zylos instance create <id> [--type dedicated|shared] [--user <chat_id>] [--group <group_id>] [--auto-suspend] [--idle-timeout <min>]
 * zylos instance start <id>
 * zylos instance stop <id> [--kill-tmux]
 * zylos instance destroy <id>
 * zylos instance status <id>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { bold, dim, green, red, yellow, cyan, heading } from '../lib/colors.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadInstances() {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) return null;
    return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic instances.json write: write-to-temp-then-rename to prevent corruption.
 */
function saveInstances(config) {
  const tmp = `${INSTANCES_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, INSTANCES_FILE);
}

function tmuxSessionExists(session) {
  try {
    execSync(`tmux has-session -t "${session}" 2>/dev/null`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function pm2ProcessStatus(name) {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const list = JSON.parse(raw);
    const proc = list.find(p => p.name === name);
    return proc ? proc.pm2_env?.status || 'unknown' : null;
  } catch {
    return null;
  }
}

function resolveDir(dir) {
  if (!dir) return dir;
  return dir.replace(/^~/, os.homedir());
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--type' && i + 1 < argv.length) {
      flags.type = argv[++i];
    } else if (arg === '--user' && i + 1 < argv.length) {
      flags.user = argv[++i];
    } else if (arg === '--group' && i + 1 < argv.length) {
      flags.group = argv[++i];
    } else if (arg === '--idle-timeout' && i + 1 < argv.length) {
      flags.idleTimeout = parseInt(argv[++i], 10);
    } else if (arg === '--auto-suspend') {
      flags.autoSuspend = true;
    } else if (arg === '--kill-tmux') {
      flags.killTmux = true;
    } else if (arg === '--daily' && i + 1 < argv.length) {
      flags.daily = parseInt(argv[++i], 10);
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    } else {
      console.warn('Unknown flag: ' + arg);
    }
    i++;
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function listInstances() {
  const config = loadInstances();
  if (!config || !config.instances || Object.keys(config.instances).length === 0) {
    console.log(dim('No instances configured.'));
    return;
  }

  console.log(heading('Instances'));
  console.log('');

  // Header
  const cols = [
    { key: 'name',       label: 'NAME',       width: 14 },
    { key: 'type',       label: 'TYPE',       width: 10 },
    { key: 'tmux',       label: 'TMUX',       width: 18 },
    { key: 'enabled',    label: 'ENABLED',    width: 9 },
    { key: 'suspend',    label: 'SUSPEND',    width: 9 },
    { key: 'status',     label: 'STATUS',     width: 12 },
  ];

  const header = cols.map(c => c.label.padEnd(c.width)).join('  ');
  console.log(dim(header));
  console.log(dim('─'.repeat(header.length)));

  for (const [id, inst] of Object.entries(config.instances)) {
    const tmuxSession = inst.tmux_session || `claude-${id}`;
    const tmuxAlive = tmuxSessionExists(tmuxSession);
    const pm2Name = `activity-monitor-${id}`;
    const pm2Status = pm2ProcessStatus(pm2Name);

    let status;
    if (tmuxAlive) {
      status = green('running');
    } else if (pm2Status === 'online') {
      status = yellow('starting');
    } else {
      // Check for suspended state
      const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
      const statusFile = path.join(stateDir, 'agent-status.json');
      try {
        const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        status = s.state === 'suspended' ? yellow('suspended') : red('stopped');
      } catch {
        status = red('stopped');
      }
    }

    const row = [
      (inst.primary ? bold(id) : id).padEnd(id.length + (cols[0].width - id.length)),
      (inst.type || 'dedicated').padEnd(cols[1].width),
      tmuxSession.padEnd(cols[2].width),
      (inst.enabled ? green('yes') : red('no')).padEnd(cols[3].width + 10), // ansi compensation
      (inst.auto_suspend ? yellow('yes') : dim('no')).padEnd(cols[4].width + 10),
      status,
    ];

    console.log(row.join('  '));
  }

  console.log('');
  console.log(dim(`Default instance: ${config.default_instance || 'none'}`));
  const routingCount = Object.keys(config.routing || {}).length;
  if (routingCount > 0) {
    console.log(dim(`Routing rules: ${routingCount}`));
  }
}

const VALID_INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

function createInstance(id, flags) {
  if (!id) {
    console.error(red('Usage: zylos instance create <id> [--type dedicated|shared] [--user <chat_id>] [--group <group_id>] [--auto-suspend] [--idle-timeout <min>]'));
    process.exit(1);
  }

  if (!VALID_INSTANCE_ID.test(id)) {
    console.error(red(`Invalid instance ID "${id}". Must match /^[a-zA-Z0-9_-]+$/.`));
    process.exit(1);
  }

  let config = loadInstances();
  if (!config) {
    config = { version: 1, default_instance: id, instances: {}, routing: {} };
  }

  if (config.instances[id]) {
    console.error(red(`Instance "${id}" already exists.`));
    process.exit(1);
  }

  const type = flags.type || 'dedicated';
  const autoSuspend = flags.autoSuspend || false;
  const idleTimeout = flags.idleTimeout || 30;

  const stateDir = `~/zylos/activity-monitor/${id}`;
  const configDir = `~/zylos/.claude-${id}`;

  config.instances[id] = {
    tmux_session: `claude-${id}`,
    runtime: 'claude',
    enabled: true,
    type,
    primary: false,
    auto_suspend: autoSuspend,
    idle_timeout_min: idleTimeout,
    config_dir: configDir,
    state_dir: stateDir,
    description: `Instance ${id} (${type})`
  };

  // Create directories
  const resolvedStateDir = resolveDir(stateDir);
  const resolvedConfigDir = resolveDir(configDir);
  fs.mkdirSync(resolvedStateDir, { recursive: true });
  fs.mkdirSync(resolvedConfigDir, { recursive: true });

  // Add routing entries if --user or --group specified
  if (flags.user) {
    config.routing[flags.user] = id;
    console.log(dim(`  Routing: user ${flags.user} -> ${id}`));
  }
  if (flags.group) {
    config.routing[flags.group] = id;
    console.log(dim(`  Routing: group ${flags.group} -> ${id}`));
  }

  saveInstances(config);
  console.log(green(`Instance "${id}" created.`));
  console.log(dim(`  State dir: ${resolvedStateDir}`));
  console.log(dim(`  Config dir: ${resolvedConfigDir}`));
  console.log(dim(`  Use "zylos instance start ${id}" to launch.`));
}

function startInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance start <id>'));
    process.exit(1);
  }

  if (!VALID_INSTANCE_ID.test(id)) {
    console.error(red(`Invalid instance ID "${id}". Must match /^[a-zA-Z0-9_-]+$/.`));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];
  const pm2Name = `activity-monitor-${id}`;

  // Check if already running
  const pm2Status = pm2ProcessStatus(pm2Name);
  if (pm2Status === 'online') {
    console.log(yellow(`Instance "${id}" is already running (PM2 process: ${pm2Name}).`));
    return;
  }

  // Resolve paths for AM script
  const amScript = path.join(ZYLOS_DIR, '.claude', 'skills', 'activity-monitor', 'scripts', 'activity-monitor.js');
  if (!fs.existsSync(amScript)) {
    console.error(red(`Activity monitor script not found: ${amScript}`));
    process.exit(1);
  }

  const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  fs.mkdirSync(stateDir, { recursive: true });

  // Start PM2 process with instance-specific env: delete-if-exists + start with env vars
  try {
    // Delete if exists but stopped
    try { execSync(`pm2 delete "${pm2Name}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* ignore */ }

    const startCmd = `ZYLOS_INSTANCE_ID=${id} ZYLOS_DIR=${ZYLOS_DIR} pm2 start "${amScript}" --name "${pm2Name}" --restart-delay 5000 --max-restarts 10`;
    execSync(startCmd, { encoding: 'utf8', stdio: 'pipe' });
    execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });

    // Ensure instance is marked as enabled
    if (!inst.enabled) {
      const freshConfig = loadInstances();
      if (freshConfig && freshConfig.instances[id]) {
        freshConfig.instances[id] = { ...freshConfig.instances[id], enabled: true };
        saveInstances(freshConfig);
      }
    }

    console.log(green(`Instance "${id}" started (PM2 process: ${pm2Name}).`));
  } catch (err) {
    console.error(red(`Failed to start instance "${id}": ${err.message}`));
    process.exit(1);
  }
}

function stopInstance(id, flags) {
  if (!id) {
    console.error(red('Usage: zylos instance stop <id> [--kill-tmux]'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];
  const pm2Name = `activity-monitor-${id}`;
  const tmuxSession = inst.tmux_session || `claude-${id}`;

  // Stop PM2 process
  try {
    execSync(`pm2 stop "${pm2Name}" 2>/dev/null`, { stdio: 'pipe' });
    console.log(dim(`  PM2 process "${pm2Name}" stopped.`));
  } catch {
    console.log(dim(`  PM2 process "${pm2Name}" was not running.`));
  }

  // Optionally kill tmux session
  if (flags.killTmux) {
    try {
      execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { stdio: 'pipe' });
      console.log(dim(`  tmux session "${tmuxSession}" killed.`));
    } catch {
      console.log(dim(`  tmux session "${tmuxSession}" was not active.`));
    }
  }

  // Mark instance as disabled so the guardian won't auto-restart it
  config.instances[id] = { ...inst, enabled: false };
  saveInstances(config);
  console.log(dim(`  Instance "${id}" marked as disabled in instances.json.`));

  console.log(green(`Instance "${id}" stopped.`));
}

function destroyInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance destroy <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];

  if (inst.primary) {
    console.error(red(`Cannot destroy primary instance "${id}".`));
    process.exit(1);
  }

  const pm2Name = `activity-monitor-${id}`;
  const tmuxSession = inst.tmux_session || `claude-${id}`;

  // Stop PM2
  try {
    execSync(`pm2 delete "${pm2Name}" 2>/dev/null`, { stdio: 'pipe' });
    console.log(dim(`  PM2 process "${pm2Name}" deleted.`));
  } catch {
    console.log(dim(`  PM2 process "${pm2Name}" was not running.`));
  }

  // Kill tmux
  try {
    execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { stdio: 'pipe' });
    console.log(dim(`  tmux session "${tmuxSession}" killed.`));
  } catch {
    console.log(dim(`  tmux session "${tmuxSession}" was not active.`));
  }

  // Archive state_dir
  const stateDir = resolveDir(inst.state_dir);
  if (stateDir && fs.existsSync(stateDir)) {
    const archiveDir = `${stateDir}.archived`;
    try {
      fs.renameSync(stateDir, archiveDir);
      console.log(dim(`  State dir archived: ${archiveDir}`));
    } catch (err) {
      console.log(yellow(`  Warning: failed to archive state dir: ${err.message}`));
    }
  }

  // Archive config_dir
  const configDir = resolveDir(inst.config_dir);
  if (configDir && fs.existsSync(configDir)) {
    const archiveDir = `${configDir}.archived`;
    try {
      fs.renameSync(configDir, archiveDir);
      console.log(dim(`  Config dir archived: ${archiveDir}`));
    } catch (err) {
      console.log(yellow(`  Warning: failed to archive config dir: ${err.message}`));
    }
  }

  // Remove routing entries pointing to this instance
  if (config.routing) {
    for (const [key, target] of Object.entries(config.routing)) {
      if (target === id) {
        delete config.routing[key];
        console.log(dim(`  Routing entry "${key}" removed.`));
      }
    }
  }

  // Remove from instances
  delete config.instances[id];

  // If we removed the default instance, pick a new one
  if (config.default_instance === id) {
    const remaining = Object.keys(config.instances);
    config.default_instance = remaining.length > 0 ? remaining[0] : null;
    if (config.default_instance) {
      console.log(dim(`  Default instance changed to "${config.default_instance}".`));
    }
  }

  saveInstances(config);
  console.log(green(`Instance "${id}" destroyed.`));
}

function showInstanceStatus(id) {
  if (!id) {
    console.error(red('Usage: zylos instance status <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];
  const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  const tmuxSession = inst.tmux_session || `claude-${id}`;

  console.log(heading(`Instance: ${id}`));
  console.log('');

  // Instance config
  console.log(bold('Config:'));
  console.log(`  Type:          ${inst.type || 'dedicated'}`);
  console.log(`  Runtime:       ${inst.runtime || 'claude'}`);
  console.log(`  Enabled:       ${inst.enabled ? green('yes') : red('no')}`);
  console.log(`  Auto-suspend:  ${inst.auto_suspend ? yellow('yes') : dim('no')}`);
  if (inst.auto_suspend && inst.idle_timeout_min) {
    console.log(`  Idle timeout:  ${inst.idle_timeout_min} min`);
  }
  console.log(`  tmux session:  ${tmuxSession}`);
  console.log('');

  // Live status
  console.log(bold('Status:'));
  const tmuxAlive = tmuxSessionExists(tmuxSession);
  console.log(`  tmux alive:    ${tmuxAlive ? green('yes') : red('no')}`);

  const pm2Name = `activity-monitor-${id}`;
  const pm2Status = pm2ProcessStatus(pm2Name);
  console.log(`  PM2 process:   ${pm2Status ? (pm2Status === 'online' ? green(pm2Status) : yellow(pm2Status)) : dim('not registered')}`);

  // Read agent-status.json
  const statusFile = path.join(stateDir, 'agent-status.json');
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    console.log(`  Agent state:   ${status.state || 'unknown'}`);
    console.log(`  Health:        ${status.health || 'unknown'}`);
    if (status.idle_seconds) {
      console.log(`  Idle:          ${status.idle_seconds}s`);
    }
    if (status.last_check_human) {
      console.log(`  Last check:    ${status.last_check_human}`);
    }
  } catch {
    console.log(dim('  No status data available.'));
  }

  // Read api-activity.json
  const apiFile = path.join(stateDir, 'api-activity.json');
  try {
    const api = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
    if (api.updated_at) {
      const ago = Math.floor((Date.now() - api.updated_at) / 1000);
      console.log(`  Last activity: ${ago}s ago (event: ${api.event || '?'})`);
    }
  } catch { /* no api data */ }
}

function readStatusState(stateDir) {
  const statusFile = path.join(stateDir, 'agent-status.json');
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    return status.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

function enableInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance enable <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  config.instances[id] = { ...config.instances[id], enabled: true };
  saveInstances(config);
  console.log(green(`Instance "${id}" enabled.`));
}

function disableInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance disable <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  config.instances[id] = { ...config.instances[id], enabled: false };
  saveInstances(config);
  console.log(green(`Instance "${id}" disabled.`));
}

function suspendInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance suspend <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];
  const tmuxSession = inst.tmux_session || `claude-${id}`;

  if (!tmuxSessionExists(tmuxSession)) {
    console.error(red(`Instance "${id}" is not running (tmux session "${tmuxSession}" not found).`));
    process.exit(1);
  }

  try {
    execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { encoding: 'utf8' });
  } catch (err) {
    console.error(red(`Failed to kill tmux session: ${err.message}`));
    process.exit(1);
  }

  // Write suspended status
  const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  fs.mkdirSync(stateDir, { recursive: true });
  const statusFile = path.join(stateDir, 'agent-status.json');
  fs.writeFileSync(statusFile, JSON.stringify({
    state: 'suspended',
    suspended_at: Date.now(),
    suspended_by: 'cli',
    last_check_human: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log(green(`Instance "${id}" suspended.`));
}

function resumeInstance(id) {
  if (!id) {
    console.error(red('Usage: zylos instance resume <id>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  const inst = config.instances[id];
  const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  const state = readStatusState(stateDir);

  if (state !== 'suspended') {
    console.error(red(`Instance "${id}" is not suspended (current state: ${state}).`));
    process.exit(1);
  }

  const tmuxSession = inst.tmux_session || `claude-${id}`;
  if (tmuxSessionExists(tmuxSession)) {
    console.error(red(`tmux session "${tmuxSession}" already exists.`));
    process.exit(1);
  }

  const configDir = resolveDir(inst.config_dir);
  const envPrefix = configDir ? `CLAUDE_CONFIG_DIR='${configDir}' ` : '';
  const runtime = inst.runtime || 'claude';
  const launchCmd = `${envPrefix}${runtime}`;

  try {
    execSync(`tmux new-session -d -s "${tmuxSession}" -x 220 -y 50 '${launchCmd}'`, { encoding: 'utf8' });
  } catch (err) {
    console.error(red(`Failed to start tmux session: ${err.message}`));
    process.exit(1);
  }

  // Clear suspended status
  const statusFile = path.join(stateDir, 'agent-status.json');
  try {
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'idle',
      resumed_at: Date.now(),
      resumed_by: 'cli',
      last_check_human: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch { /* best-effort */ }

  console.log(green(`Instance "${id}" resumed (tmux session "${tmuxSession}").`));
}

function suspendAllInstances() {
  const config = loadInstances();
  if (!config || !config.instances) {
    console.log(dim('No instances configured.'));
    return;
  }

  let count = 0;
  for (const [id, inst] of Object.entries(config.instances)) {
    if (inst.primary) {
      console.log(dim(`  Skipped "${id}": primary instance`));
      continue;
    }

    const tmuxSession = inst.tmux_session || `claude-${id}`;
    if (!tmuxSessionExists(tmuxSession)) {
      console.log(dim(`  Skipped "${id}": not running`));
      continue;
    }

    try {
      execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { encoding: 'utf8' });
    } catch {
      console.log(yellow(`  Failed to suspend "${id}"`));
      continue;
    }

    const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    fs.mkdirSync(stateDir, { recursive: true });
    const statusFile = path.join(stateDir, 'agent-status.json');
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'suspended',
      suspended_at: Date.now(),
      suspended_by: 'cli-bulk',
      last_check_human: new Date().toISOString(),
    }, null, 2) + '\n');

    console.log(green(`  Suspended "${id}"`));
    count++;
  }

  if (count === 0) {
    console.log(dim('No instances to suspend.'));
  } else {
    console.log(green(`Suspended ${count} instance(s).`));
  }
}

function resumeAllInstances() {
  const config = loadInstances();
  if (!config || !config.instances) {
    console.log(dim('No instances configured.'));
    return;
  }

  let count = 0;
  for (const [id, inst] of Object.entries(config.instances)) {
    const stateDir = resolveDir(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    const state = readStatusState(stateDir);

    if (state !== 'suspended') {
      console.log(dim(`  Skipped "${id}": ${state}`));
      continue;
    }

    const tmuxSession = inst.tmux_session || `claude-${id}`;
    if (tmuxSessionExists(tmuxSession)) {
      console.log(dim(`  Skipped "${id}": tmux session already exists`));
      continue;
    }

    const configDir = resolveDir(inst.config_dir);
    const envPrefix = configDir ? `CLAUDE_CONFIG_DIR='${configDir}' ` : '';
    const runtime = inst.runtime || 'claude';
    const launchCmd = `${envPrefix}${runtime}`;

    try {
      execSync(`tmux new-session -d -s "${tmuxSession}" -x 220 -y 50 '${launchCmd}'`, { encoding: 'utf8' });
    } catch {
      console.log(yellow(`  Failed to resume "${id}"`));
      continue;
    }

    // Clear suspended status
    const statusFile = path.join(stateDir, 'agent-status.json');
    try {
      fs.writeFileSync(statusFile, JSON.stringify({
        state: 'idle',
        resumed_at: Date.now(),
        resumed_by: 'cli-bulk',
        last_check_human: new Date().toISOString(),
      }, null, 2) + '\n');
    } catch { /* best-effort */ }

    console.log(green(`  Resumed "${id}"`));
    count++;
  }

  if (count === 0) {
    console.log(dim('No suspended instances to resume.'));
  } else {
    console.log(green(`Resumed ${count} instance(s).`));
  }
}

function setQuota(id, flags) {
  if (!id) {
    console.error(red('Usage: zylos instance set-quota <id> --daily <tokens>'));
    process.exit(1);
  }

  const config = loadInstances();
  if (!config || !config.instances[id]) {
    console.error(red(`Instance "${id}" not found.`));
    process.exit(1);
  }

  if (flags.daily === undefined || isNaN(flags.daily) || flags.daily < 0) {
    console.error(red('--daily <tokens> is required. Use 0 for unlimited.'));
    process.exit(1);
  }

  config.instances[id] = { ...config.instances[id], quota_tokens_daily: flags.daily };
  saveInstances(config);

  const display = flags.daily === 0 ? 'unlimited' : `${flags.daily} tokens`;
  console.log(green(`Quota for "${id}" set to ${display} per day.`));
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function instanceCommand(argv) {
  const subcommand = argv[0] || 'list';
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'list':
    case 'ls':
      listInstances();
      break;
    case 'create': {
      const { flags, positional } = parseArgs(rest);
      createInstance(positional[0], flags);
      break;
    }
    case 'start': {
      const { positional } = parseArgs(rest);
      startInstance(positional[0]);
      break;
    }
    case 'stop': {
      const { flags, positional } = parseArgs(rest);
      stopInstance(positional[0], flags);
      break;
    }
    case 'destroy':
    case 'rm': {
      const { positional } = parseArgs(rest);
      destroyInstance(positional[0]);
      break;
    }
    case 'status': {
      const { positional } = parseArgs(rest);
      showInstanceStatus(positional[0]);
      break;
    }
    case 'enable': {
      const { positional } = parseArgs(rest);
      enableInstance(positional[0]);
      break;
    }
    case 'disable': {
      const { positional } = parseArgs(rest);
      disableInstance(positional[0]);
      break;
    }
    case 'suspend': {
      const { positional } = parseArgs(rest);
      suspendInstance(positional[0]);
      break;
    }
    case 'resume': {
      const { positional } = parseArgs(rest);
      resumeInstance(positional[0]);
      break;
    }
    case 'suspend-all':
      suspendAllInstances();
      break;
    case 'resume-all':
      resumeAllInstances();
      break;
    case 'set-quota': {
      const { flags, positional } = parseArgs(rest);
      setQuota(positional[0], flags);
      break;
    }
    default:
      console.error(red(`Unknown subcommand: ${subcommand}`));
      showInstanceHelp();
      process.exit(1);
  }
}

function showInstanceHelp() {
  console.log(`
Instance Management

Usage: zylos instance <subcommand> [options]

Subcommands:
  list                        List all instances
  create <id> [options]       Create a new instance
  start <id>                  Start an instance (PM2 + activity monitor)
  stop <id> [--kill-tmux]     Stop an instance
  enable <id>                 Enable an instance
  disable <id>                Disable an instance
  suspend <id>                Suspend an instance (kill tmux session)
  resume <id>                 Resume a suspended instance
  suspend-all                 Suspend all non-primary instances
  resume-all                  Resume all suspended instances
  set-quota <id> --daily <n>  Set daily token quota (0 = unlimited)
  destroy <id>                Remove instance and archive state
  status <id>                 Show detailed instance status

Create options:
  --type <dedicated|shared>   Instance type (default: dedicated)
  --user <chat_id>            Add routing rule for a user
  --group <group_id>          Add routing rule for a group
  --auto-suspend              Enable auto-suspend when idle
  --idle-timeout <min>        Idle timeout in minutes (default: 30)
`);
}
