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
import { SKILLS_DIR } from './c4-config.js';
import { renderOnboardingMessage, detectLang } from './onboarding-messages.js';

// ZY-UX-1: default daily token quota for a newly-approved user (notify-only).
export const DEFAULT_QUOTA_TOKENS_DAILY = 5_000_000;

/**
 * Best-effort: deliver an onboarding message to a user's channel via that
 * channel's send.js (the same script the reply path uses). Runs server-side as
 * the service user (holds channel creds). Never throws — onboarding UX must not
 * block approval/hold.
 * @returns {boolean} true if the send script ran successfully
 */
export function sendChannelMessage(channel, endpoint, message) {
  try {
    if (!channel || !endpoint || !message) return false;
    const script = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');
    if (!fs.existsSync(script)) return false;
    execFileSync('node', [script, endpoint, message], { stdio: 'pipe', timeout: 30000 });
    return true;
  } catch (err) {
    console.error(`Warning: onboarding message send failed (${channel}): ${err.message}`);
    return false;
  }
}

/**
 * Seed a new user's profile + state memory. Pure-ish (IO injectable for tests).
 * @returns {string} the profile path written
 */
export function seedUserProfile(chatId, name, {
  memoryDir = path.join(ZYLOS_DIR, 'memory'),
  firstMessage = '',
  now = '',
  writeFileSync = fs.writeFileSync,
  mkdirSync = fs.mkdirSync,
} = {}) {
  const userDir = path.join(memoryDir, 'users', String(chatId));
  mkdirSync(userDir, { recursive: true });
  const date = now || 'unknown';
  const excerpt = String(firstMessage).replace(/\s+/g, ' ').slice(0, 160);
  const profile = [
    `# User Profile — ${name || chatId}`,
    '',
    `- Chat ID: ${chatId}`,
    `- Approved: ${date}`,
    excerpt ? `- First message: "${excerpt}"` : '- First message: (none captured)',
    '',
    '## Notes',
    '- Onboarding pending — build this out as you learn about the user.',
    '',
  ].join('\n');
  const profilePath = path.join(userDir, 'profile.md');
  writeFileSync(profilePath, profile);
  return profilePath;
}

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

  // 1c-2. ZY-UX-1: seed a user profile skeleton (memory/users/<chat_id>/profile.md)
  try {
    const profilePath = seedUserProfile(chatId, instanceName, { now: new Date().toISOString().slice(0, 10) });
    console.log(`User profile seeded: ${profilePath}`);
  } catch (err) {
    console.error(`Warning: failed to seed user profile (${err.message})`);
  }

  // 1d. Set auto_suspend + idle_timeout (CLI doesn't have these flags).
  // Route through the router's atomic temp+rename writer — raw writeFileSync
  // on instances.json can be seen truncated by concurrent readers (dispatcher,
  // dashboard) and corrupts the routing source of truth on a mid-write crash.
  try {
    const { updateInstancesConfig } = await import('./c4-instance-router.js');
    updateInstancesConfig((config) => {
      if (!config?.instances?.[instanceName]) return null;
      config.instances[instanceName].type = 'user';
      config.instances[instanceName].auto_suspend = true;
      config.instances[instanceName].idle_timeout_min = 360;
      config.instances[instanceName].quota_tokens_daily = DEFAULT_QUOTA_TOKENS_DAILY; // ZY-UX-1 (notify-only)
      return config;
    });
    console.log(`Set auto_suspend=true, idle_timeout_min=360, quota_tokens_daily=${DEFAULT_QUOTA_TOKENS_DAILY} for ${instanceName}`);
  } catch (err) {
    console.error(`Warning: failed to set auto_suspend (${err.message})`);
  }

  // 1e. OS-level isolation: dedicated unix user for the new instance
  // (fork doc: docs/design/os-user-isolation.md; the provisioning script is
  // deployment-local, shipped under $ZYLOS_DIR/scripts/ops/). Idempotent.
  // Runs from the admin session (service user, passwordless sudo).
  try {
    const provisionScript = path.join(ZYLOS_DIR, 'scripts', 'ops', 'provision-agent-user.sh');
    if (fs.existsSync(provisionScript)) {
      execFileSync('bash', [provisionScript, instanceName], { stdio: 'pipe', timeout: 120_000 });
      const osUser = `zylos-${instanceName.replace(/^user-/, '')}`;
      const { updateInstancesConfig } = await import('./c4-instance-router.js');
      updateInstancesConfig((config) => {
        if (!config?.instances?.[instanceName]) return null;
        config.instances[instanceName].os_user = osUser;
        config.instances[instanceName].claude_config_dir = `/home/${osUser}/.claude`;
        return config;
      });
      console.log(`OS isolation: ${instanceName} -> ${osUser}`);

      // Nudge the C4 broker (ZY-ISO-2) to open a socket for the new isolated
      // instance immediately. Without this it appears on the next 30s re-scan;
      // a socketless isolated instance can't send/query until then. Non-fatal.
      try {
        execFileSync('pm2', ['sendSignal', 'SIGHUP', 'c4-broker'], { stdio: 'pipe', timeout: 15000 });
      } catch (err) {
        console.error(`Warning: could not SIGHUP c4-broker (${err.message}) — socket appears within 30s`);
      }
    } else {
      console.error('Warning: provision-agent-user.sh missing — instance will run as the service user');
    }
  } catch (err) {
    console.error(`Warning: OS-user provisioning failed (${err.message}) — instance will run as the service user`);
  }

  // 2. Release held messages: update pending_approval → pending with new target_instance
  let releasedCount = 0;
  let releaseError = null;
  let welcomeTarget = null; // {channel, endpoint, content} of the user's first held msg (ZY-UX-1)
  try {
    const db = getDb();
    if (!db) {
      console.error('Could not access database');
      process.exit(1);
    }

    // Find held messages for this chat_id
    const held = db.prepare(`
      SELECT id, endpoint_id, channel, content FROM conversations
      WHERE status = 'pending_approval'
        AND endpoint_id LIKE ?
      ORDER BY id ASC
    `).all(`${chatId}%`);
    if (held.length > 0 && held[0].endpoint_id) {
      welcomeTarget = { channel: held[0].channel, endpoint: held[0].endpoint_id, content: held[0].content || '' };
    }

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

  // 4. ZY-UX-1: welcome the newly-approved user in their language (best-effort).
  // Replaces the old "admin remembers to type a greeting" step. The agent still
  // runs its own Onboarding security-disclosure flow on the first real message.
  if (welcomeTarget?.endpoint) {
    try {
      const welcome = renderOnboardingMessage('welcome', { lang: detectLang(welcomeTarget.content) });
      if (sendChannelMessage(welcomeTarget.channel, welcomeTarget.endpoint, welcome)) {
        console.log(`Welcome message sent to ${chatId} via ${welcomeTarget.channel}`);
      }
    } catch (err) {
      console.error(`Warning: welcome send failed (${err.message})`);
    }
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
export function holdAndNotify(channel, endpoint, content, priority, targetInstance, { sendMessage = sendChannelMessage } = {}) {
  // 2. Extract chat_id for admin notification
  const chatId = endpoint ? endpoint.split('|')[0] : 'unknown';

  // ZY-UX-1: ack the user once, on first contact (before this insert there are
  // no prior pending_approval rows for the chat). Best-effort; never blocks hold.
  const db0 = getDb();
  const alreadyHeld = endpoint
    ? db0.prepare("SELECT 1 FROM conversations WHERE status='pending_approval' AND endpoint_id LIKE ? LIMIT 1").get(`${chatId}%`)
    : true;

  // 1. Insert message as pending_approval
  const record = insertConversation('in', channel, endpoint, content, 'pending_approval', priority, false, targetInstance);

  if (!alreadyHeld && endpoint) {
    try {
      const ack = renderOnboardingMessage('hold-ack', { lang: detectLang(content) });
      sendMessage(channel, endpoint, ack);
    } catch (err) {
      console.error(`Warning: hold-ack render/send failed: ${err.message}`);
    }
  }

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
