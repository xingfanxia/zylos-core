#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 */

import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { insertConversation, getDb, close } from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { resolveInstance, getDefaultInstance, getSchedulerInstance, isEndpointRouted } from './c4-instance-router.js';
import {
  FILE_SIZE_THRESHOLD,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS,
  AGENT_STATUS_FILE,
  PENDING_CHANNELS_FILE,
  USER_MESSAGE_SIGNAL_FILE,
  DATA_DIR
} from './c4-config.js';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] [--target-instance <id>] [--json] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply                  Do not append "reply via" suffix (use for system messages)');
  console.log('  --require-idle              Only deliver when Claude is idle');
  console.log('  --target-instance <id>      Override instance routing (deliver to specific instance)');
  console.log('  --json                      Output structured JSON');
  console.log('');
  console.log('Priority levels:');
  console.log('  1 = Urgent (system messages)');
  console.log('  2 = High (important user messages)');
  console.log('  3 = Normal (default)');
}

function parseArgs(args) {
  const result = {
    channel: null,
    endpoint: null,
    content: null,
    priority: 3,
    noReply: false,
    requireIdle: false,
    json: false,
    targetInstance: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        result.channel = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i];
        break;
      case '--priority':
        result.priority = parseInt(args[++i], 10);
        break;
      case '--no-reply':
        result.noReply = true;
        break;
      case '--require-idle':
        result.requireIdle = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--target-instance':
        result.targetInstance = args[++i];
        break;
      case '--content':
        result.content = args[++i];
        break;
      default:
        if (args[i].startsWith('--')) {
          return { error: `Unknown option: ${args[i]}` };
        }
        return { error: `Unexpected argument: ${args[i]}` };
    }
  }

  return result;
}

function readHealthStatus() {
  try {
    if (!fs.existsSync(AGENT_STATUS_FILE)) {
      return { health: 'ok' };
    }
    let status = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        status = JSON.parse(fs.readFileSync(AGENT_STATUS_FILE, 'utf8'));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!status && lastErr) throw lastErr;
    if (status && typeof status.health === 'string') {
      return status;
    }
    return { health: 'ok' };
  } catch {
    // Fail-open by design: status read failures do not block intake.
    return { health: 'ok' };
  }
}

function loadPendingChannelKeys() {
  if (!fs.existsSync(PENDING_CHANNELS_FILE)) {
    return new Set();
  }

  const keys = new Set();
  const content = fs.readFileSync(PENDING_CHANNELS_FILE, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.channel && record.endpoint) {
        keys.add(`${record.channel}::${record.endpoint}`);
      }
    } catch {
      // Ignore broken lines and keep appending new records.
    }
  }
  return keys;
}

function recordPendingChannel(channel, endpoint) {
  if (!channel || !endpoint) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Strip |msg:xxx and |req:xxx from endpoint so same chat deduplicates correctly.
    // Recovery notices should go to the chat, not reply to a specific message.
    const normalizedEndpoint = endpoint.replace(/\|(msg|req):[^|]+/g, '');
    const key = `${channel}::${normalizedEndpoint}`;
    const keys = loadPendingChannelKeys();
    if (keys.has(key)) return;
    const line = `${JSON.stringify({ channel, endpoint: normalizedEndpoint })}\n`;
    fs.appendFileSync(PENDING_CHANNELS_FILE, line, 'utf8');
  } catch (err) {
    console.error(`[C4] Warning: failed to record pending channel (${err.message})`);
  }
}

function emitSuccess(json, recordId) {
  if (json) {
    console.log(JSON.stringify({ ok: true, action: 'queued', id: recordId }));
    return;
  }
  console.log(`[C4] Message queued (id=${recordId})`);
}

/**
 * Check if an unknown endpoint has already been notified by querying the DB
 * for existing approval request system messages containing the chat_id.
 * If not found, inject an approval request to the admin instance.
 *
 * Returns true if this is the first contact (triggers holding reply + approval request).
 * Returns false if already tracked (subsequent messages just queue as pending_approval).
 *
 * @param {string} channel - The message channel (telegram, lark, etc.)
 * @param {string} endpoint - The full endpoint identifier
 * @param {string} chatId - The chat ID portion
 * @param {string} content - The message content
 * @returns {boolean} true if first contact, false if already known
 */
function recordUnknownEndpoint(channel, endpoint, chatId, content) {
  try {
    const db = getDb();

    // DB-backed dedup: check for existing approval request or resolved messages for this chat_id.
    // Also check if there are already pending_approval messages from this endpoint (prior message held).
    const existing = db.prepare(`
      SELECT id FROM conversations
      WHERE direction = 'in' AND channel = 'system'
        AND content LIKE '%[Instance Approval Required]%'
        AND content LIKE ?
      LIMIT 1
    `).get(`%${chatId}%`);

    if (existing) {
      return false; // already notified admin — don't spam
    }

    // Also check if this chat_id already has pending_approval messages (from a previous c4-receive run)
    const heldMsg = db.prepare(`
      SELECT id FROM conversations
      WHERE status = 'pending_approval' AND endpoint_id LIKE ?
      LIMIT 1
    `).get(`${chatId}%`);

    if (heldMsg) {
      return false; // messages already held, admin already notified in a prior invocation
    }

    // Extract sender name from message format: "[Channel DM] Name said:" or "[Channel Group] Name said:"
    const nameMatch = content.match(/\]\s+(.+?)\s+said:/);
    const senderName = nameMatch ? nameMatch[1] : null;
    const asciiName = senderName ? senderName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const suggestedId = asciiName
      ? `user-${asciiName.substring(0, 20)}`
      : `user-${chatId.slice(-8)}`;

    // Inject an approval request to the admin instance
    const userPreview = content.substring(0, 200);
    const replyPath = `node ${path.join(__dirname, 'c4-send.js')} "${channel}" "${chatId}"`;
    const notification = `[Instance Approval Required] ${senderName || 'Unknown user'} from ${channel} (chat_id: ${chatId}) sent their first message. Their messages are held as pending_approval.\n\n` +
      `User's message: "${userPreview}"\n\n` +
      `Suggested instance name: ${suggestedId}\n` +
      `Reply path: ${replyPath}\n\n` +
      `1. Reply to the user (in their language) via the reply path — tell them their environment is being set up.\n` +
      `2. Then ask AX to approve: "approve ${chatId}" or "deny ${chatId}".`;

    const defaultInstance = getDefaultInstance();
    insertConversation('in', 'system', null, notification, 'pending', 2, false, defaultInstance);
    return true;
  } catch (err) {
    console.error(`[C4] Warning: failed to record unknown endpoint (${err.message})`);
    return false;
  }
}

function emitError(json, code, message, exitCode = 1) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      error: { code, message }
    }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    const asJson = process.argv.slice(2).includes('--json');
    emitError(asJson, 'INVALID_ARGS', parsed.error);
  }

  const { channel: rawChannel, endpoint, content, priority, noReply, requireIdle, json, targetInstance: targetInstanceOverride } = parsed;
  let channel = rawChannel;

  if (!channel && noReply) {
    channel = 'system';
  }

  if (!channel && !noReply) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--channel is required unless --no-reply is set');
  }

  if (!content) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--content is required');
  }

  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--priority must be an integer 1, 2, or 3');
  }

  try {
    validateChannel(channel, !noReply);
  } catch (err) {
    emitError(json, 'INVALID_ARGS', `invalid channel: ${err.message}`);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid endpoint: ${err.message}`);
    }
  }

  const status = readHealthStatus();
  if (status.health !== 'ok') {
    recordPendingChannel(channel, endpoint);
    // Signal activity-monitor that a user message arrived — may trigger or accelerate recovery
    try {
      fs.writeFileSync(USER_MESSAGE_SIGNAL_FILE, JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), channel, endpoint }));
    } catch { /* best-effort */ }

    if (status.health === 'down') {
      emitError(json, 'HEALTH_DOWN', "I'm currently offline and unable to recover on my own. Please let the admin know so they can take a look!");
    } else if (status.health === 'rate_limited') {
      const resetInfo = status.rate_limit_reset ? ` I should be back around ${status.rate_limit_reset}.` : ' I should be back within an hour.';
      emitError(json, 'HEALTH_RATE_LIMITED', `I've hit my usage limit.${resetInfo} Please send your message again after I'm back!`);
    } else if (status.health === 'auth_failed') {
      emitError(json, 'HEALTH_AUTH_FAILED', "I'm having authentication issues — please check the API credentials. Your message has been queued and I'll process it once authentication is restored.");
    } else {
      emitError(json, 'HEALTH_RECOVERING', "I'm temporarily unavailable but should be back shortly. Please try again in a moment!");
    }
  }

  let replyViaSuffix = '';
  if (!noReply) {
    const scriptDir = __dirname;
    const replyViaBase = `reply via: node ${path.join(scriptDir, 'c4-send.js')} "${channel}"`;
    replyViaSuffix = endpoint ? ` ---- ${replyViaBase} "${endpoint}"` : ` ---- ${replyViaBase}`;
  }

  const fullMessage = content + replyViaSuffix;
  let dbContent = fullMessage;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');

  if (byteLength > FILE_SIZE_THRESHOLD) {
    const msgId = `${Date.now()}-${process.pid}`;
    const messageDir = path.join(ATTACHMENTS_DIR, msgId);
    fs.mkdirSync(messageDir, { recursive: true });
    const filePath = path.join(messageDir, 'message.txt');
    fs.writeFileSync(filePath, fullMessage, 'utf8');

    const preview = content.substring(0, CONTENT_PREVIEW_CHARS);
    const ellipsis = preview.length < content.length ? '...' : '';
    const sizeKB = (byteLength / 1024).toFixed(1);
    dbContent = `${preview}${ellipsis}\n\n[C4] Full message (${sizeKB}KB) at: ${filePath}${replyViaSuffix}`;
  }

  // Resolve target instance from endpoint routing (null = legacy single-instance).
  // --target-instance flag overrides all routing logic (used by scheduler for multi-session dispatch).
  // For system/scheduler messages (no endpoint), explicitly target the default instance
  // so they don't rely on NULL fallback behavior in the dispatcher.
  let targetInstance;
  if (targetInstanceOverride) {
    targetInstance = targetInstanceOverride;
  } else {
    targetInstance = resolveInstance(endpoint);
    if (targetInstance === null && (channel === 'system' || channel === 'scheduler')) {
      targetInstance = getSchedulerInstance();
    }
  }

  // Detect unknown endpoints routed to default instance by fallback.
  // Hold the message as pending_approval, reply to user, and notify admin.
  if (endpoint && !noReply && !targetInstanceOverride && targetInstance === getDefaultInstance()) {
    const chatId = String(endpoint).split('|')[0];
    if (!isEndpointRouted(chatId, endpoint)) {
      const isFirstContact = recordUnknownEndpoint(channel, endpoint, chatId, content);

      // Store the user's message as pending_approval — dispatcher won't deliver it
      // The admin instance will handle the reply in the user's language
      try {
        const record = insertConversation('in', channel, endpoint, dbContent, 'pending_approval', priority, requireIdle, targetInstance);
        emitSuccess(json, record.id);
      } catch (err) {
        emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
      } finally {
        close();
      }
      return;
    }
  }

  try {
    const record = insertConversation('in', channel, endpoint, dbContent, 'pending', priority, requireIdle, targetInstance);
    emitSuccess(json, record.id);
  } catch (err) {
    emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
  } finally {
    close();
  }
}

main();
