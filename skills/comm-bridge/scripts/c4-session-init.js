#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Called by session start hook. Outputs context prompt for Claude Code:
 * - Last checkpoint summary (always)
 * - Unsummarized conversations (all if ≤ threshold, last N if > threshold)
 * - Memory Sync instruction (only if > threshold)
 *
 * Usage: node c4-session-init.js
 */

import {
  getLastCheckpoint,
  getUnsummarizedRange,
  getUnsummarizedConversations,
  formatConversations,
  close
} from './c4-db.js';
import { CHECKPOINT_THRESHOLD, SESSION_INIT_RECENT_COUNT } from './c4-config.js';
import { logHookTiming } from './c4-diagnostic.js';

const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// Instance-scoped query overrides (loaded lazily, graceful degradation)
let _getUnsummarizedRangeForInstance = null;
let _getUnsummarizedConversationsForInstance = null;
let _getLastCheckpointForInstance = null;
let _multiLoadFailed = false;
try {
  const multiMod = await import('./c4-db-multi.js');
  _getUnsummarizedRangeForInstance = multiMod.getUnsummarizedRangeForInstance;
  _getUnsummarizedConversationsForInstance = multiMod.getUnsummarizedConversationsForInstance;
  _getLastCheckpointForInstance = multiMod.getLastCheckpointForInstance;
} catch (err) {
  _multiLoadFailed = true;
  console.error(`[c4-session-init] WARN: c4-db-multi.js import failed: ${err.message}`);
}

const startMs = Date.now();

function main() {
  try {
    const checkpoint = (INSTANCE_ID && _getLastCheckpointForInstance)
      ? _getLastCheckpointForInstance(INSTANCE_ID)
      : getLastCheckpoint();
    const lines = [];

    // Guard: in multi-session mode, never fall back to unfiltered global queries.
    // Injecting nothing is strictly safer than injecting all instances' conversations.
    if (INSTANCE_ID && _multiLoadFailed) {
      console.error(`[c4-session-init] Instance ${INSTANCE_ID}: instance-scoped queries unavailable, skipping conversation injection`);
      if (checkpoint?.summary) {
        lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
        lines.push('');
      }
      lines.push('[Recent Conversations]');
      lines.push('(instance-scoped query unavailable — skipped to prevent cross-instance bleed)');
      console.log(lines.join('\n'));
      return;
    }

    const range = (INSTANCE_ID && _getUnsummarizedRangeForInstance)
      ? _getUnsummarizedRangeForInstance(INSTANCE_ID)
      : getUnsummarizedRange();

    // Always output last checkpoint summary
    if (checkpoint?.summary) {
      lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
      lines.push('');
    }

    if (range.count === 0) {
      lines.push('No new conversations since last checkpoint.');
      console.log(lines.join('\n'));
      return;
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Get conversations: all if under threshold, last N if over
    const getConvos = (INSTANCE_ID && _getUnsummarizedConversationsForInstance)
      ? (limit) => _getUnsummarizedConversationsForInstance(INSTANCE_ID, limit != null ? { limit } : undefined)
      : getUnsummarizedConversations;
    const conversations = needsSync
      ? getConvos(SESSION_INIT_RECENT_COUNT)
      : getConvos();

    lines.push('[Recent Conversations]');
    lines.push(formatConversations(conversations));

    // If over threshold, append Memory Sync instruction
    if (needsSync) {
      lines.push(`[Action Required] There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`);
    }

    console.log(lines.join('\n'));
  } catch (err) {
    console.error(`Error in session init: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
    logHookTiming('c4-session-init', Date.now() - startMs);
  }
}

main();
