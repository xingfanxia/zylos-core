#!/usr/bin/env node
/**
 * C4 Inter-Instance Query Helper
 *
 * Convenience CLI for sending a query from one instance to another
 * via the C4 internal channel. Fire-and-forget by default; use --wait
 * to poll for a correlated reply.
 *
 * Usage:
 *   node c4-query-instance.js --from <source> --to <target> --content "question"
 *   node c4-query-instance.js --from betty --to group --content "What about X?" --wait 30
 *
 * Under the hood:
 *   1. Generates a query tag: [query:<from>:<timestamp>]
 *   2. Prepends the tag to content for reply correlation
 *   3. Calls c4-receive.js via execFileSync with channel=internal
 *   4. If --wait is set, polls c4.db for a reply matching the tag
 *
 * ESM module -- Node 20+.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -- Arg parsing -------------------------------------------------------------

function parseArgs(args) {
  const result = { from: null, to: null, content: null, wait: 0 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--from':
        result.from = args[++i];
        break;
      case '--to':
        result.to = args[++i];
        break;
      case '--content':
        result.content = args[++i];
        break;
      case '--wait':
        result.wait = parseInt(args[++i], 10) || 0;
        break;
      default:
        if (args[i].startsWith('--')) {
          console.error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  return result;
}

function printUsage() {
  console.log('Usage: node c4-query-instance.js --from <source-instance> --to <target-instance> --content "question" [--wait <seconds>]');
}

// -- Main --------------------------------------------------------------------

async function main() {
  const { from, to, content, wait } = parseArgs(process.argv.slice(2));

  if (!from || !to || !content) {
    printUsage();
    console.error('Error: --from, --to, and --content are all required.');
    process.exit(1);
  }

  // Generate a unique query tag for reply correlation
  const queryTag = `[query:${from}:${Date.now()}]`;
  const taggedContent = `${queryTag} ${content}`;

  // Dispatch via c4-receive.js
  const receivePath = path.join(__dirname, 'c4-receive.js');
  const receiveArgs = [
    receivePath,
    '--channel', 'internal',
    '--endpoint', `instance-${from}`,
    '--target-instance', to,
    '--no-reply',
    '--content', taggedContent
  ];

  try {
    execFileSync(process.execPath, receiveArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000
    });
    console.log(`[query] Sent to ${to}: ${queryTag}`);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    console.error(`[query] Failed to send to ${to}: ${stderr}`);
    process.exit(1);
  }

  // If --wait is not set, we're done (fire-and-forget)
  if (!wait || wait <= 0) {
    process.exit(0);
  }

  // Poll c4.db for a reply containing the query tag
  console.log(`[query] Waiting up to ${wait}s for reply...`);

  const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  const DB_PATH = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');

  if (!fs.existsSync(DB_PATH)) {
    console.error('[query] Database not found, cannot poll for reply.');
    process.exit(1);
  }

  // Dynamic import for better-sqlite3 (may not be available in all envs)
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    console.error('[query] better-sqlite3 not available, cannot poll for reply.');
    process.exit(1);
  }

  const pollInterval = 2_000; // 2 seconds
  const deadline = Date.now() + (wait * 1000);

  while (Date.now() < deadline) {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = WAL');
      const row = db.prepare(`
        SELECT content, timestamp FROM conversations
        WHERE direction = 'in'
          AND target_instance = ?
          AND content LIKE ?
        ORDER BY timestamp DESC
        LIMIT 1
      `).get(from, `%${queryTag}%`);
      db.close();

      if (row) {
        // Strip the query tag from the reply content for cleaner output
        const replyContent = row.content.replace(queryTag, '').trim();
        console.log(`[query] Reply received (${row.timestamp}):`);
        console.log(replyContent);
        process.exit(0);
      }
    } catch {
      // DB busy or unavailable — retry on next poll
    }

    // Sleep for poll interval
    const remaining = deadline - Date.now();
    const sleepMs = Math.min(pollInterval, Math.max(0, remaining));
    if (sleepMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }

  console.log('[query] No reply received within timeout.');
  process.exit(0);
}

main();
