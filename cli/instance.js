#!/usr/bin/env node
/**
 * Instance Management CLI — standalone script for CRUD operations on instances.json.
 *
 * Usage: node instance.js <command> [options]
 *
 * Commands:
 *   create <id>       Create a new instance
 *   list              List all instances
 *   show <id>         Show instance details
 *   enable <id>       Enable an instance
 *   disable <id>      Disable an instance
 *   suspend <id>      Suspend an instance (stop the tmux session)
 *   resume <id>       Resume a suspended instance
 *   remove <id>       Remove an instance (must be disabled first)
 *   suspend-all       Suspend all non-primary instances
 *   resume-all        Resume all suspended instances
 *   set-quota <id>    Set daily token quota for an instance
 *
 * ESM module. Imports from c4-instance-router.js for atomic config updates.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import instance router for atomic config operations
// Try deployed path first (.claude/skills/), then repo path (skills/)
const candidatePaths = [
  path.join(__dirname, '..', '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-instance-router.js'),
  path.join(__dirname, '..', 'skills', 'comm-bridge', 'scripts', 'c4-instance-router.js'),
];
const routerPath = candidatePaths.find(p => fs.existsSync(p)) || candidatePaths[0];
const {
  updateInstancesConfig,
  getInstanceDef,
  getAllInstanceIds,
  getStatusFileForInstance,
  stopWatcher,
} = await import(routerPath);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTilde(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function errorExit(msg) {
  if (jsonMode) {
    console.log(JSON.stringify({ error: msg }));
  } else {
    console.error(`Error: ${msg}`);
  }
  stopWatcher();
  process.exit(1);
}

function tmuxSessionExists(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function writeWakeSignal(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'wake-signal'), new Date().toISOString());
}

/**
 * Read the status from an instance's agent-status.json file.
 * Returns a string: 'running', 'suspended', 'stopped', or 'unknown'.
 */
function readInstanceStatus(instanceId) {
  const statusFile = getStatusFileForInstance(instanceId);
  if (!statusFile) return 'unknown';

  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    const status = JSON.parse(raw);

    // Suspended is a persistent state — not subject to staleness checks
    if (status.state === 'suspended') return 'suspended';

    // For active states, check staleness (30s threshold)
    const stat = fs.statSync(statusFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 30_000) return 'stopped';

    if (status.state === 'idle' || status.state === 'busy') return 'running';
    return status.state || 'unknown';
  } catch {
    return 'stopped';
  }
}

/**
 * Load instances.json directly (for read-only operations that don't need atomic update).
 */
function loadConfig() {
  try {
    if (!fs.existsSync(INSTANCES_FILE)) return null;
    return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let jsonMode = false;

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json') {
      jsonMode = true;
    } else if (arg === '--tmux-session' && i + 1 < argv.length) {
      flags.tmuxSession = argv[++i];
    } else if (arg === '--type' && i + 1 < argv.length) {
      flags.type = argv[++i];
    } else if (arg === '--config-dir' && i + 1 < argv.length) {
      flags.configDir = argv[++i];
    } else if (arg === '--description' && i + 1 < argv.length) {
      flags.description = argv[++i];
    } else if (arg === '--chat-ids' && i + 1 < argv.length) {
      flags.chatIds = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--claude-md' && i + 1 < argv.length) {
      flags.claudeMd = argv[++i];
    } else if (arg === '--quota-daily' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (isNaN(val) || val < 0) errorExit('--quota-daily must be a non-negative integer');
      flags.quotaDaily = val;
    } else if (arg === '--daily' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (isNaN(val) || val < 0) errorExit('--daily must be a non-negative integer');
      flags.daily = val;
    } else if (arg.startsWith('--')) {
      errorExit(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
    i++;
  }

  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdCreate(id, flags) {
  if (!id) errorExit('Usage: node instance.js create <id> [options]');
  if (!VALID_ID.test(id)) errorExit(`Invalid instance ID "${id}". Must match /^[a-zA-Z0-9_-]+$/.`);

  const existing = getInstanceDef(id);
  if (existing) errorExit(`Instance "${id}" already exists.`);

  const type = flags.type || 'dedicated';
  if (type !== 'dedicated' && type !== 'on_demand') {
    errorExit(`Invalid type "${type}". Must be "dedicated" or "on_demand".`);
  }

  const tmuxSession = flags.tmuxSession || `claude-${id}`;
  const stateDir = `~/zylos/activity-monitor/${id}`;
  const memoryDir = `~/zylos/memory/instances/${id}`;

  const instanceDef = {
    tmux_session: tmuxSession,
    runtime: 'claude',
    enabled: true,
    type,
    primary: false,
    state_dir: stateDir,
  };

  if (flags.description) instanceDef.description = flags.description;
  if (flags.claudeMd) instanceDef.claude_md = flags.claudeMd;
  if (flags.chatIds) instanceDef.chat_ids = flags.chatIds;
  if (flags.quotaDaily !== undefined) instanceDef.quota_tokens_daily = flags.quotaDaily;

  // Atomic config update
  updateInstancesConfig((cfg) => {
    if (!cfg) {
      cfg = { version: 1, default_instance: id, instances: {}, routing: {} };
    }
    cfg.instances[id] = instanceDef;

    // Add routing entries from chat_ids
    if (flags.chatIds) {
      if (!cfg.routing) cfg.routing = {};
      for (const chatId of flags.chatIds) {
        cfg.routing[chatId] = id;
      }
    }

    return cfg;
  });

  // Create directories
  const resolvedStateDir = resolveTilde(stateDir);
  const resolvedMemoryDir = resolveTilde(memoryDir);

  fs.mkdirSync(resolvedStateDir, { recursive: true });
  fs.mkdirSync(resolvedMemoryDir, { recursive: true });

  // Create per-instance working directory with symlinks (token tracking isolation)
  let instanceCwdPath = null;
  try {
    const instanceConfigPath = candidatePaths.find(p =>
      fs.existsSync(p.replace('comm-bridge/scripts/c4-instance-router.js', 'multi-session/instance-config.js'))
    );
    if (instanceConfigPath) {
      const configModPath = instanceConfigPath.replace('comm-bridge/scripts/c4-instance-router.js', 'multi-session/instance-config.js');
      const { ensureInstanceCwd } = await import(configModPath);
      instanceCwdPath = ensureInstanceCwd(id);
    }
  } catch { /* best effort */ }

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, instance: { id, ...instanceDef } }, null, 2));
  } else {
    console.log(`Created instance "${id}"`);
    console.log(`  Type:       ${type}`);
    console.log(`  Session:    ${tmuxSession}`);
    console.log(`  State dir:  ${resolvedStateDir}`);
    console.log(`  Memory dir: ${resolvedMemoryDir}`);
    if (instanceCwdPath) console.log(`  Instance cwd: ${instanceCwdPath}`);
    if (flags.chatIds) {
      console.log(`  Chat IDs:   ${flags.chatIds.join(', ')}`);
    }
    if (flags.description) {
      console.log(`  Description: ${flags.description}`);
    }
    if (flags.quotaDaily !== undefined) {
      console.log(`  Daily quota: ${flags.quotaDaily === 0 ? 'unlimited' : flags.quotaDaily + ' tokens'}`);
    }
  }
}

function cmdList() {
  const config = loadConfig();
  if (!config || !config.instances || Object.keys(config.instances).length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ instances: [] }));
    } else {
      console.log('No instances configured.');
    }
    return;
  }

  const instances = Object.entries(config.instances).map(([id, inst]) => {
    const tmuxSession = inst.tmux_session || `claude-${id}`;
    const tmuxAlive = tmuxSessionExists(tmuxSession);
    const stateStatus = readInstanceStatus(id);

    let status;
    if (tmuxAlive) {
      status = stateStatus === 'suspended' ? 'suspended' : 'running';
    } else {
      status = stateStatus === 'suspended' ? 'suspended' : 'stopped';
    }

    return {
      id,
      type: inst.type || 'dedicated',
      enabled: inst.enabled !== false,
      session: tmuxSession,
      status,
      primary: inst.primary || false,
      quota_tokens_daily: inst.quota_tokens_daily ?? null,
    };
  });

  if (jsonMode) {
    console.log(JSON.stringify({ instances }, null, 2));
    return;
  }

  // Table output
  const colWidths = { id: 12, type: 12, enabled: 9, session: 20, status: 12 };

  const header = [
    'ID'.padEnd(colWidths.id),
    'Type'.padEnd(colWidths.type),
    'Enabled'.padEnd(colWidths.enabled),
    'Session'.padEnd(colWidths.session),
    'Status'.padEnd(colWidths.status),
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const inst of instances) {
    const row = [
      inst.id.padEnd(colWidths.id),
      inst.type.padEnd(colWidths.type),
      (inst.enabled ? 'yes' : 'no').padEnd(colWidths.enabled),
      inst.session.padEnd(colWidths.session),
      inst.status.padEnd(colWidths.status),
    ].join('  ');
    console.log(row);
  }
}

function cmdShow(id) {
  if (!id) errorExit('Usage: node instance.js show <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);

  const tmuxSession = inst.tmux_session || `claude-${id}`;
  const stateDir = inst.state_dir || `~/zylos/activity-monitor/${id}`;
  const configDir = inst.config_dir || null;
  const status = readInstanceStatus(id);

  const details = {
    id,
    type: inst.type || 'dedicated',
    enabled: inst.enabled !== false,
    primary: inst.primary || false,
    tmux_session: tmuxSession,
    config_dir: configDir,
    state_dir: stateDir,
    status,
    chat_ids: inst.chat_ids || [],
    description: inst.description || null,
    claude_md: inst.claude_md || null,
    quota_tokens_daily: inst.quota_tokens_daily ?? null,
  };

  if (jsonMode) {
    console.log(JSON.stringify(details, null, 2));
    return;
  }

  console.log(`Instance: ${id}`);
  console.log(`Type: ${details.type}`);
  console.log(`Enabled: ${details.enabled ? 'yes' : 'no'}`);
  console.log(`Primary: ${details.primary ? 'yes' : 'no'}`);
  console.log(`Session: ${tmuxSession}`);
  console.log(`Config Dir: ${configDir || '(default)'}`);
  console.log(`State Dir: ${stateDir}`);
  console.log(`Status: ${status}`);
  if (details.chat_ids.length > 0) {
    console.log(`Chat IDs: ${details.chat_ids.join(', ')}`);
  }
  if (details.description) {
    console.log(`Description: ${details.description}`);
  }
  if (details.claude_md) {
    console.log(`CLAUDE.md: ${details.claude_md}`);
  }
  if (details.quota_tokens_daily !== null) {
    console.log(`Daily Quota: ${details.quota_tokens_daily === 0 ? 'unlimited' : details.quota_tokens_daily + ' tokens'}`);
  }
}

function cmdEnable(id) {
  if (!id) errorExit('Usage: node instance.js enable <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);

  updateInstancesConfig((cfg) => {
    if (!cfg) return null;
    cfg.instances[id] = { ...cfg.instances[id], enabled: true };
    return cfg;
  });

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, enabled: true }));
  } else {
    console.log(`Instance "${id}" enabled.`);
  }
}

function cmdDisable(id) {
  if (!id) errorExit('Usage: node instance.js disable <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);
  if (inst.primary) errorExit(`Cannot disable primary instance "${id}". Demote it first.`);

  updateInstancesConfig((cfg) => {
    if (!cfg) return null;
    cfg.instances[id] = { ...cfg.instances[id], enabled: false };
    return cfg;
  });

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, enabled: false }));
  } else {
    console.log(`Instance "${id}" disabled.`);
  }
}

function cmdSuspend(id) {
  if (!id) errorExit('Usage: node instance.js suspend <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);
  if (inst.primary) errorExit(`Cannot suspend primary instance "${id}".`);

  const tmuxSession = inst.tmux_session || `claude-${id}`;

  // Check tmux session exists
  if (!tmuxSessionExists(tmuxSession)) {
    errorExit(`Instance "${id}" is not running (tmux session "${tmuxSession}" not found).`);
  }

  // Kill the tmux session
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'pipe', timeout: 15000 });
  } catch (err) {
    errorExit(`Failed to kill tmux session "${tmuxSession}": ${err.message}`);
  }

  // Write suspended status to state file
  const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  const statusFile = path.join(stateDir, 'agent-status.json');
  fs.mkdirSync(stateDir, { recursive: true });

  const statusData = {
    state: 'suspended',
    suspended_at: Date.now(),
    suspended_by: 'cli',
    last_check_human: new Date().toISOString(),
  };
  fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2) + '\n');

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, status: 'suspended' }));
  } else {
    console.log(`Instance "${id}" suspended (tmux session "${tmuxSession}" killed).`);
  }
}

function cmdResume(id) {
  if (!id) errorExit('Usage: node instance.js resume <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);

  // Check it's actually suspended
  const status = readInstanceStatus(id);
  if (status !== 'suspended') {
    errorExit(`Instance "${id}" is not suspended (current status: ${status}).`);
  }

  const tmuxSession = inst.tmux_session || `claude-${id}`;

  // Check tmux session doesn't already exist
  if (tmuxSessionExists(tmuxSession)) {
    errorExit(`tmux session "${tmuxSession}" already exists.`);
  }

  const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
  try {
    writeWakeSignal(stateDir);
  } catch (err) {
    errorExit(`Failed to request resume for "${id}": ${err.message}`);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, status: 'resume_requested', session: tmuxSession }));
  } else {
    console.log(`Instance "${id}" resume requested.`);
  }
}

function cmdRemove(id) {
  if (!id) errorExit('Usage: node instance.js remove <id>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);

  if (inst.enabled !== false) {
    errorExit(`Instance "${id}" must be disabled before removal. Run: node instance.js disable ${id}`);
  }

  if (inst.primary) {
    errorExit(`Cannot remove primary instance "${id}".`);
  }

  updateInstancesConfig((cfg) => {
    if (!cfg) return null;
    delete cfg.instances[id];

    // Remove routing entries pointing to this instance
    if (cfg.routing) {
      for (const [key, target] of Object.entries(cfg.routing)) {
        if (target === id) {
          delete cfg.routing[key];
        }
      }
    }

    // Update default_instance if it was this one
    if (cfg.default_instance === id) {
      const remaining = Object.keys(cfg.instances);
      cfg.default_instance = remaining.length > 0 ? remaining[0] : null;
    }

    return cfg;
  });

  const stateDir = resolveTilde(inst.state_dir);
  const configDir = resolveTilde(inst.config_dir);

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, removed: true }));
  } else {
    console.log(`Instance "${id}" removed from instances.json.`);
    console.log(`Note: data directories were NOT deleted:`);
    if (stateDir) console.log(`  State:  ${stateDir}`);
    if (configDir) console.log(`  Config: ${configDir}`);
    console.log(`Delete them manually if no longer needed.`);
  }
}

function cmdSuspendAll() {
  const allIds = getAllInstanceIds();
  if (allIds.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, suspended: [] }));
    } else {
      console.log('No instances configured.');
    }
    return;
  }

  const suspended = [];
  const skipped = [];

  for (const id of allIds) {
    const inst = getInstanceDef(id);
    if (!inst) continue;

    // Skip primary instances
    if (inst.primary) {
      skipped.push({ id, reason: 'primary' });
      continue;
    }

    // Skip already-stopped or suspended instances
    const tmuxSession = inst.tmux_session || `claude-${id}`;
    if (!tmuxSessionExists(tmuxSession)) {
      skipped.push({ id, reason: 'not running' });
      continue;
    }

    // Kill tmux session
    try {
      execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'pipe', timeout: 15000 });
    } catch {
      skipped.push({ id, reason: 'kill failed' });
      continue;
    }

    // Write suspended status
    const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    const statusFile = path.join(stateDir, 'agent-status.json');
    fs.mkdirSync(stateDir, { recursive: true });
    const statusData = {
      state: 'suspended',
      suspended_at: Date.now(),
      suspended_by: 'cli-bulk',
      last_check_human: new Date().toISOString(),
    };
    fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2) + '\n');

    suspended.push(id);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, suspended, skipped }, null, 2));
  } else {
    if (suspended.length > 0) {
      console.log(`Suspended ${suspended.length} instance(s): ${suspended.join(', ')}`);
    }
    if (skipped.length > 0) {
      for (const { id, reason } of skipped) {
        console.log(`  Skipped "${id}": ${reason}`);
      }
    }
    if (suspended.length === 0) {
      console.log('No instances to suspend.');
    }
  }
}

function cmdResumeAll() {
  const allIds = getAllInstanceIds();
  if (allIds.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, resumed: [] }));
    } else {
      console.log('No instances configured.');
    }
    return;
  }

  const resumed = [];
  const skipped = [];

  for (const id of allIds) {
    const inst = getInstanceDef(id);
    if (!inst) continue;

    // Only resume suspended instances
    const status = readInstanceStatus(id);
    if (status !== 'suspended') {
      skipped.push({ id, reason: `status is ${status}` });
      continue;
    }

    const tmuxSession = inst.tmux_session || `claude-${id}`;

    // Don't start if tmux session already exists
    if (tmuxSessionExists(tmuxSession)) {
      skipped.push({ id, reason: 'tmux session already exists' });
      continue;
    }

    const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    try {
      writeWakeSignal(stateDir);
    } catch {
      skipped.push({ id, reason: 'resume request failed' });
      continue;
    }

    resumed.push(id);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, resumed, skipped }, null, 2));
  } else {
    if (resumed.length > 0) {
      console.log(`Resumed ${resumed.length} instance(s): ${resumed.join(', ')}`);
    }
    if (skipped.length > 0) {
      for (const { id, reason } of skipped) {
        console.log(`  Skipped "${id}": ${reason}`);
      }
    }
    if (resumed.length === 0) {
      console.log('No suspended instances to resume.');
    }
  }
}

function cmdSetQuota(id, flags) {
  if (!id) errorExit('Usage: node instance.js set-quota <id> --daily <tokens>');

  const inst = getInstanceDef(id);
  if (!inst) errorExit(`Instance "${id}" not found.`);

  if (flags.daily === undefined) {
    errorExit('--daily <tokens> is required. Use 0 for unlimited.');
  }

  updateInstancesConfig((cfg) => {
    if (!cfg) return null;
    cfg.instances[id] = { ...cfg.instances[id], quota_tokens_daily: flags.daily };
    return cfg;
  });

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id, quota_tokens_daily: flags.daily }));
  } else {
    const display = flags.daily === 0 ? 'unlimited' : `${flags.daily} tokens`;
    console.log(`Quota for "${id}" set to ${display} per day.`);
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function showUsage() {
  console.log(`Instance Management CLI

Usage: node instance.js <command> [options]

Commands:
  create <id>       Create a new instance
  list              List all instances
  show <id>         Show instance details
  enable <id>       Enable an instance
  disable <id>      Disable an instance
  suspend <id>      Suspend an instance (stop the tmux session)
  resume <id>       Resume a suspended instance
  remove <id>       Remove an instance (must be disabled first)
  suspend-all       Suspend all non-primary instances
  resume-all        Resume all suspended instances
  set-quota <id>    Set daily token quota for an instance

Create options:
  --tmux-session <name>   Tmux session name (default: claude-<id>)
  --type <type>           Instance type: dedicated|on_demand (default: dedicated)
  --config-dir <path>     CLAUDE_CONFIG_DIR path (default: ~/.claude-instances/<id>)
  --description <text>    Instance description
  --chat-ids <ids>        Comma-separated chat IDs to route to this instance
  --claude-md <path>      Path to per-instance CLAUDE.md file
  --quota-daily <tokens>  Daily token usage quota (0 = unlimited)

Set-quota options:
  --daily <tokens>        Daily token usage quota (0 = unlimited)

Global options:
  --json                  Output in JSON format
  --help, -h              Show this help
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Check for --json anywhere in args (before parsing command)
  if (args.includes('--json')) {
    jsonMode = true;
  }

  const command = args.find(a => !a.startsWith('--'));
  const rest = args.filter(a => a !== command);

  if (!command || command === 'help' || command === '-h' || args.includes('--help') || args.includes('-h')) {
    showUsage();
    stopWatcher();
    process.exit(0);
  }

  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'create':
      await cmdCreate(positional[0], flags);
      break;
    case 'list':
    case 'ls':
      cmdList();
      break;
    case 'show':
      cmdShow(positional[0]);
      break;
    case 'enable':
      cmdEnable(positional[0]);
      break;
    case 'disable':
      cmdDisable(positional[0]);
      break;
    case 'suspend':
      cmdSuspend(positional[0]);
      break;
    case 'resume':
      cmdResume(positional[0]);
      break;
    case 'remove':
      cmdRemove(positional[0]);
      break;
    case 'suspend-all':
      cmdSuspendAll();
      break;
    case 'resume-all':
      cmdResumeAll();
      break;
    case 'set-quota':
      cmdSetQuota(positional[0], flags);
      break;
    default:
      errorExit(`Unknown command: ${command}. Run with --help for usage.`);
  }

  stopWatcher();
  process.exit(0);
}

await main();
