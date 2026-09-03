#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage:
 *   Recommended (stdin — safe for any content):
 *     node c4-send.js <channel> <endpoint_id> <<'EOF'
 *     message with "quotes", $vars, and special chars
 *     EOF
 *
 *   Simple messages (CLI arg — backward compatible):
 *     node c4-send.js <channel> [endpoint_id] "short message"
 *
 * When no message argument is provided, the message is read from stdin.
 * This avoids shell escaping issues with quotes and special characters.
 *
 * Special channel 'void' (#689): internal-only messages (e.g. session
 * handoffs). The message is recorded in c4.db like any other conversation
 * row — so session-init context injection and Memory Sync pick it up — but
 * it is never dispatched to a channel send script. The endpoint carries the
 * purpose/topic and is mandatory, e.g.:
 *   node c4-send.js void session-handoff <<'EOF'
 *   ...handoff summary...
 *   EOF
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { insertConversation, markFailed, close } from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { shouldUseBroker, brokerCall } from './c4-client.js';

function printUsage() {
  console.log('Usage: node c4-send.js <channel> <endpoint_id> <<\'EOF\'');
  console.log('       message content');
  console.log('       EOF');
  console.log('       node c4-send.js <channel> [endpoint_id] "message"');
  console.log('Example: node c4-send.js telegram 8101553026 "Hello!"');
  process.exit(1);
}

/**
 * Read all data from stdin.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
  }

  // Flags are removed from the positional args:
  //  --stdin                  force stdin mode (backward compat)
  //  --delivery-action=<tag>  tag the out-row audit record (e.g. c4-receive's
  //                           unhealthy auto-reply uses 'status-notice' so the
  //                           unanswered-message re-surface ignores it)
  const hasStdinFlag = args.includes('--stdin');
  let deliveryAction = null;
  const cleanArgs = args.filter((a) => {
    if (a === '--stdin') return false;
    if (a.startsWith('--delivery-action=')) {
      deliveryAction = a.slice('--delivery-action='.length) || null;
      return false;
    }
    return true;
  });
  const stdinAvailable = !process.stdin.isTTY;

  const channel = cleanArgs[0];
  let endpoint = null;
  let message = null;

  if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
    // 2 args (channel + endpoint) with piped stdin or --stdin flag: read from stdin.
    // But a non-interactive stdin (cron, spawn) may simply be empty — in that case
    // fall back to the documented 2-arg CLI form (channel + message, no endpoint /
    // broadcast) instead of erroring, so the [endpoint_id]-optional contract works
    // outside a TTY too.
    const stdinData = (await readStdin()).trimEnd();
    if (stdinData) {
      endpoint = cleanArgs[1];
      message = stdinData;
    } else {
      message = cleanArgs[1].replace(/\\n/g, '\n');
    }
  } else if (cleanArgs.length === 1 && (stdinAvailable || hasStdinFlag)) {
    // 1 arg (channel only) with piped stdin: read from stdin
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 2) {
    // 2 args, no stdin: channel + message (no endpoint)
    process.stderr.write('[c4-send] Deprecated: passing message as CLI argument. Use stdin/heredoc mode instead.\n');
    message = cleanArgs[1];
    // Unescape literal \n sequences that shell may have preserved when passing
    // multi-line content as a CLI argument (defense-in-depth; prefer stdin mode)
    message = message.replace(/\\n/g, '\n');
  } else {
    // 3+ args: channel + endpoint + message
    process.stderr.write('[c4-send] Deprecated: passing message as CLI argument. Use stdin/heredoc mode instead.\n');
    endpoint = cleanArgs[1];
    message = cleanArgs[2];
    // Same defense for the 3-arg form
    message = message.replace(/\\n/g, '\n');
  }

  if (!message) {
    console.error('Error: Message is required');
    process.exit(1);
  }

  // Determine broker routing up front — the void channel gate below needs it
  // too. Isolated agents route sends + audit through the broker (which holds
  // channel creds, enforces egress policy, and owns the DB). Admin/scheduler
  // fall through to the legacy direct path. A missing broker socket for an
  // isolated agent is a loud failure, never a silent legacy fallback.
  let useBroker;
  try {
    useBroker = shouldUseBroker();
  } catch (err) {
    console.error(`[C4] ${err.message}`);
    process.exit(1);
  }

  // Virtual 'void' channel (#689): record-only, never dispatched. It is
  // agent-facing (new-session / session-handoff skills write handoff summaries
  // here), so isolated agents MUST be able to use it — but NEVER via a direct
  // DB write: post-isolation they have no DB access, so a direct
  // insertConversation would EACCES-crash, and a NULL-scoped row would not be
  // picked up by that instance's own instance-scoped session-init. Route it
  // through the broker, which records the row scoped to the calling instance.
  if (channel === 'void') {
    if (!endpoint) {
      console.error('Error: Endpoint is required for the void channel (e.g. c4-send.js void session-handoff)');
      process.exit(1);
    }

    try {
      validateEndpoint(endpoint);
    } catch (err) {
      console.error(`[C4] Invalid endpoint: ${err.stack}`);
      process.exit(1);
    }

    if (useBroker) {
      try {
        await brokerCall('void', { endpoint, content: message });
        console.log('[C4] Message recorded on void channel (broker, not dispatched)');
        process.exit(0);
      } catch (err) {
        console.error(`[C4] Broker void record failed: ${err.message}`);
        process.exit(1);
      }
    }

    // Admin/scheduler direct path: scope the handoff to this identity's own
    // instance (ZYLOS_INSTANCE_ID) so its next session-init reads it back; NULL
    // for an unscoped admin is the global surface, which its global session-init
    // reads. Unlike real channels (audit only), the DB write IS the delivery for
    // void — fail loudly.
    try {
      insertConversation('out', 'void', endpoint, message, null, 3, false, null, process.env.ZYLOS_INSTANCE_ID || null);
    } catch (err) {
      console.error(`[C4] Failed to record void message: ${err.stack}`);
      process.exit(1);
    } finally {
      close();
    }

    console.log('[C4] Message recorded on void channel (not dispatched)');
    process.exit(0);
  }

  try {
    validateChannel(channel, true);
  } catch (err) {
    console.error(`[C4] Invalid channel: ${err.stack}`);
    process.exit(1);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      console.error(`[C4] Invalid endpoint: ${err.stack}`);
      process.exit(1);
    }
  }

  if (useBroker) {
    try {
      await brokerCall('send', { channel, endpoint, content: message, deliveryAction });
      console.log(`[C4] Message sent via ${channel} (broker)`);
      process.exit(0);
    } catch (err) {
      console.error(`[C4] Broker send failed: ${err.message}`);
      process.exit(1);
    }
  }

  let outRecord = null;
  try {
    // Preserve single-session compatibility (NULL when no instance identity is
    // configured), but keep both sides of an identified instance's conversation
    // visible to its own strictly-scoped history readers.
    outRecord = insertConversation(
      'out', channel, endpoint, message, null, 3, false, deliveryAction,
      process.env.ZYLOS_INSTANCE_ID || null,
    );
  } catch (err) {
    console.error(`[C4] Warning: DB audit write failed: ${err.stack}`);
  } finally {
    close();
  }

  // Mark the audit row failed on any non-delivery: the user never received
  // this, so it must not count as an answer for the unanswered-message
  // re-surface. This is defined before channel resolution so a missing script
  // is handled the same as a non-zero exit or spawn failure.
  const markAuditFailed = () => {
    if (outRecord?.id == null) return;
    try { markFailed(outRecord.id); } catch { /* audit-only, best effort */ }
    try { close(); } catch { /* reopened by markFailed */ }
  };

  const channelScript = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');

  if (!fs.existsSync(channelScript)) {
    console.error(`Error: Channel script not found: ${channelScript}`);
    console.error('Channels must provide scripts/send.js (Node.js standard)');
    markAuditFailed();
    process.exit(1);
  }

  const scriptArgs = endpoint ? [endpoint, message] : [message];

  const child = spawn('node', [channelScript, ...scriptArgs], {
    stdio: 'inherit'
  });

  child.on('error', (err) => {
    console.error(`[C4] Failed to spawn channel script: ${err.message}`);
    markAuditFailed();
    process.exit(1);
  });

  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[C4] Message sent via ${channel}`);
    } else {
      console.log(`[C4] Failed to send message via ${channel} (exit code: ${code})`);
      markAuditFailed();
    }
    process.exit(code);
  });

  child.on('error', (err) => {
    console.error(`[C4] Error executing channel script: ${err.stack}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`[C4] ${err?.message || err}`);
  process.exit(1);
});
