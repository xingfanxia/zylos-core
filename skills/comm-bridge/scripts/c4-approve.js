#!/usr/bin/env node
/**
 * C4 Instance Approval — creates an instance for a pending user and releases
 * their held messages.
 *
 * Usage:
 *   node c4-approve.js approve <chat_id> [--name <instance_name>]
 *   node c4-approve.js deny <chat_id>
 *
 * Called by the admin Claude instance when the owner approves/denies a new user.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

function resolvePackageRoot() {
  if (process.env.ZYLOS_PACKAGE_ROOT) return process.env.ZYLOS_PACKAGE_ROOT;
  try {
    const zylosBin = execSync('command -v zylos 2>/dev/null || true', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!zylosBin) return '';
    const realPath = fs.realpathSync(zylosBin);
    return path.dirname(path.dirname(realPath));
  } catch {
    return '';
  }
}

// Import DB functions
import { getDb, close, insertConversation, insertControl } from './c4-db.js';

function usage() {
  console.log('Usage:');
  console.log('  node c4-approve.js approve <chat_id> [--name <name>]');
  console.log('  node c4-approve.js deny <chat_id>');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const action = args[0];
  const chatId = args[1];
  let instanceName = null;

  // Parse optional --name flag
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    instanceName = args[nameIdx + 1];
  }

  if (action === 'approve') {
    await approveUser(chatId, instanceName);
  } else if (action === 'deny') {
    denyUser(chatId);
  } else {
    usage();
  }
}

async function approveUser(chatId, name) {
  // Generate instance name from chat_id if not provided
  const instanceName = name || `user-${chatId.substring(0, 12)}`;

  console.log(`Creating instance "${instanceName}" for chat_id "${chatId}"...`);

  // 1. Create the instance via CLI
  // No CLAUDE_CONFIG_DIR — all instances share ~/.claude/ for auth/settings/skills.
  // Conversation isolation is enforced at the DB level (c4-session-init filtering).
  try {
    const cliPath = path.join(ZYLOS_DIR, 'cli', 'instance.js');
    const result = execFileSync('node', [
      cliPath, 'create', instanceName,
      '--chat-ids', chatId,
      '--type', 'on_demand',
      '--description', `Auto-provisioned for ${chatId}`,
      '--json'
    ], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    console.log(`Instance created: ${result.trim()}`);
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    console.error(`Failed to create instance: ${stderr}`);
    process.exit(1);
  }

  // 1b. Create per-instance working directory with symlinks (token tracking isolation)
  try {
    const { ensureInstanceCwd } = await import('../../multi-session/instance-config.js');
    const cwdPath = ensureInstanceCwd(instanceName);
    console.log(`Instance cwd created: ${cwdPath}`);
  } catch (err) {
    console.error(`Warning: failed to create instance cwd (${err.message})`);
  }

  // 1c. Create per-instance memory directory with bootstrap files
  try {
    const memDir = path.join(ZYLOS_DIR, 'memory', 'instances', instanceName);
    const sessDir = path.join(memDir, 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'state.md'), `# ${instanceName} Instance State\n\n## Active Work\n- None\n\n## Pending Tasks\n- None\n`);
    fs.writeFileSync(path.join(sessDir, 'current.md'), `# Session Log — ${instanceName}\n\n## ${new Date().toISOString().slice(0, 10)}\n- Instance created via approval flow\n`);
    console.log(`Memory directory created: ${memDir}`);
  } catch (err) {
    console.error(`Warning: failed to create memory directory (${err.message})`);
  }

  // 1d. Set auto_suspend + idle_timeout (CLI doesn't have these flags)
  try {
    const instancesFile = path.join(ZYLOS_DIR, 'instances.json');
    const config = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
    if (config.instances[instanceName]) {
      config.instances[instanceName].type = 'user';
      config.instances[instanceName].auto_suspend = true;
      config.instances[instanceName].idle_timeout_min = 360;
      fs.writeFileSync(instancesFile, JSON.stringify(config, null, 2) + '\n');
      console.log(`Set auto_suspend=true, idle_timeout_min=360 for ${instanceName}`);
    }
  } catch (err) {
    console.error(`Warning: failed to set auto_suspend (${err.message})`);
  }

  // 2. Release held messages: update pending_approval → pending with new target_instance
  let releasedCount = 0;
  let releaseError = null;
  try {
    const db = getDb();
    if (!db) {
      console.error('Could not access database');
      process.exit(1);
    }

    // Find held messages for this chat_id
    const held = db.prepare(`
      SELECT id, endpoint_id FROM conversations
      WHERE status = 'pending_approval'
        AND endpoint_id LIKE ?
    `).all(`${chatId}%`);

    if (held.length === 0) {
      console.log('No held messages to release.');
    } else {
      const stmt = db.prepare(`
        UPDATE conversations SET status = 'pending', target_instance = ?
        WHERE id = ?
      `);
      for (const msg of held) {
        stmt.run(instanceName, msg.id);
      }
      releasedCount = held.length;
      console.log(`Released ${held.length} held message(s) → instance "${instanceName}"`);
    }
  } catch (err) {
    releaseError = err.message;
    console.error(`Failed to release messages: ${err.message}`);
  }

  // 3. Start ONLY the new instance's AM process (don't restart everything)
  // Note: user notification is handled by the admin Claude instance (in the user's language)
  try {
    const amScript = path.join(os.homedir(), 'zylos', '.claude', 'skills', 'activity-monitor', 'scripts', 'activity-monitor.js');
    execFileSync('pm2', [
      'start', amScript,
      '--name', `activity-monitor-${instanceName}`,
    ], {
      timeout: 30000,
      stdio: 'pipe',
      env: {
        ...process.env,
        ZYLOS_INSTANCE_ID: instanceName,
        ZYLOS_TMUX_SESSION: `claude-${instanceName}`,
        ...(resolvePackageRoot() ? { ZYLOS_PACKAGE_ROOT: resolvePackageRoot() } : {}),
      },
    });
    execFileSync('pm2', ['save'], { timeout: 15000, stdio: 'pipe' });
    console.log(`PM2: started activity-monitor-${instanceName}`);
  } catch (err) {
    console.error(`Warning: PM2 start failed (${err.message}). Run manually: ZYLOS_INSTANCE_ID=${instanceName} pm2 start <am-script> --name activity-monitor-${instanceName}`);
  }

  close();

  // Emit structured result for callers (dashboard, admin Claude) to parse
  const summary = {
    instance: instanceName,
    chat_id: chatId,
    released: releasedCount,
    release_error: releaseError,
  };
  console.log(`RESULT: ${JSON.stringify(summary)}`);

  if (releaseError) {
    console.error('Approval finished but message release failed — see above.');
    process.exit(2);
  }
  if (releasedCount === 0) {
    console.log('Approval complete (no held messages to release — possibly already delivered or denied).');
    process.exit(0);
  }
  console.log('Approval complete.');
  process.exit(0);
}

function denyUser(chatId) {
  console.log(`Denying and dropping held messages for chat_id "${chatId}"...`);

  try {
    const db = getDb();
    if (db) {
      const result = db.prepare(`
        UPDATE conversations SET status = 'rejected'
        WHERE status = 'pending_approval' AND endpoint_id LIKE ?
      `).run(`${chatId}%`);
      console.log(`Rejected ${result.changes} held message(s).`);
    }
  } catch (err) {
    console.error(`Failed to reject messages: ${err.message}`);
  }

  // Note: user notification is handled by the admin Claude instance (in the user's language)

  close();
  console.log('Denial complete.');
  process.exit(0);
}

/**
 * Check if a message from an unknown endpoint should be held for approval.
 * Called by c4-receive.js during message ingestion.
 *
 * @param {string} endpoint - The sender's endpoint ID
 * @param {string|null} targetInstance - Resolved target instance
 * @param {boolean} noReply - Whether this is a no-reply message
 * @param {string|null} explicitTarget - Explicitly specified target instance
 * @returns {boolean} true if the message was held (caller should not insert normally)
 */
export async function checkAndHoldForApproval(endpoint, targetInstance, noReply, explicitTarget) {
  // Don't hold if explicitly targeted (admin/scheduler/system messages)
  if (explicitTarget) return false;
  // Don't hold no-reply messages (system, scheduler)
  if (noReply) return false;
  // Don't hold if endpoint is in the routing table (known user)
  try {
    const { isEndpointRouted, isMultiSession } = await import('./c4-instance-router.js');
    // Approval is a multi-session feature. In single-instance mode (no instances.json
    // or only admin/scheduler instances), every endpoint is implicitly trusted —
    // there's no per-user routing to approve into.
    if (!isMultiSession()) return false;
    const chatId = endpoint ? endpoint.split('|')[0] : endpoint;
    if (isEndpointRouted(chatId, endpoint)) return false;
  } catch {
    return false; // instance router not available, don't hold
  }
  // Unknown endpoint — hold for admin approval and notify
  try {
    // Insert the held message into DB with pending_approval status
    // (caller passes content separately via holdAndNotify)
    return true;
  } catch {
    return false;
  }
}

/**
 * Hold an unknown user's message and notify admin for approval.
 * Called by c4-receive.js when checkAndHoldForApproval() returns true.
 *
 * @param {string} channel - Message channel
 * @param {string} endpoint - Sender endpoint
 * @param {string} content - Full message content (with reply-via suffix)
 * @param {number} priority - Message priority
 * @param {string|null} targetInstance - Resolved target (fallback default)
 */
export function holdAndNotify(channel, endpoint, content, priority, targetInstance) {
  // 1. Insert message as pending_approval
  const record = insertConversation('in', channel, endpoint, content, 'pending_approval', priority, false, targetInstance);

  // 2. Extract chat_id for admin notification
  const chatId = endpoint ? endpoint.split('|')[0] : 'unknown';

  // 3. Notify admin via control queue
  const preview = content.substring(0, 200).replace(/----.*$/, '').trim();
  const notification = [
    `🔔 New user pending approval:`,
    `  Chat ID: ${chatId}`,
    `  Channel: ${channel}`,
    `  Message preview: "${preview}"`,
    ``,
    `To approve: node ${path.join(__dirname, 'c4-approve.js')} approve ${chatId} --name user-<name>`,
    `To deny:    node ${path.join(__dirname, 'c4-approve.js')} deny ${chatId}`,
    `Or use the dashboard Pending Users section.`,
  ].join('\n');

  try {
    insertControl(notification, {
      priority: 2,
      appendAckSuffix: false,
      targetInstance: 'admin',
    });
  } catch { /* best effort — admin will see it on dashboard regardless */ }

  return record;
}

// Only run main() when executed directly, not when imported as a module.
// realpathSync handles symlinked invocation (e.g. ~/zylos -> /home/x_computelabs_ai/zylos):
// Node resolves import.meta.url to the realpath but leaves argv[1] as-passed, so without
// realpath the two never matched and main() silently did nothing.
const isDirectRun = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
