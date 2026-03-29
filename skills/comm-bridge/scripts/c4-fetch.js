#!/usr/bin/env node
/**
 * C4 Communication Bridge - Fetch Conversations
 * Returns checkpoint summary + conversations.
 *
 * Usage:
 *   node c4-fetch.js --unsummarized           Fetch all unsummarized conversations
 *   node c4-fetch.js --begin <id> --end <id>  Fetch conversations in a specific range
 */

import {
  getLastCheckpoint,
  getUnsummarizedRange,
  getUnsummarizedRangeForInstance,
  getConversationsByRange,
  getConversationsByRangeForInstance,
  formatConversations,
  close
} from './c4-db.js';

// Instance-aware mode: when ZYLOS_INSTANCE_ID is set, only fetch conversations
// targeting this instance (or legacy NULL target_instance).
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

function usage() {
  console.error('Usage:\n  c4-fetch.js --unsummarized\n  c4-fetch.js --begin <id> --end <id>');
  console.error('\nEnvironment:\n  ZYLOS_INSTANCE_ID  When set, filters to conversations for this instance only');
  process.exit(1);
}

function outputConversations(beginId, endId) {
  const checkpoint = getLastCheckpoint();
  const conversations = INSTANCE_ID
    ? getConversationsByRangeForInstance(beginId, endId, INSTANCE_ID)
    : getConversationsByRange(beginId, endId);
  const lines = [];

  if (checkpoint?.summary) {
    lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
    lines.push('');
  }

  lines.push(`[Conversations] (id ${beginId} ~ ${endId})${INSTANCE_ID ? ` [instance=${INSTANCE_ID}]` : ''}`);

  if (conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(formatConversations(conversations));
  }

  console.log(lines.join('\n'));
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--unsummarized')) {
    try {
      const range = INSTANCE_ID
        ? getUnsummarizedRangeForInstance(INSTANCE_ID)
        : getUnsummarizedRange();
      if (!range || range.count === 0) {
        console.log('No unsummarized conversations.');
        return;
      }
      console.log(`[Unsummarized Range] end_id=${range.end_id} count=${range.count}${INSTANCE_ID ? ` instance=${INSTANCE_ID}` : ''}`);
      outputConversations(range.begin_id, range.end_id);
    } catch (err) {
      console.error(`Error fetching unsummarized conversations: ${err.stack}`);
      process.exit(1);
    } finally {
      close();
    }
    return;
  }

  let beginId = null;
  let endId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--begin') {
      beginId = parseInt(args[++i]);
    } else if (args[i] === '--end') {
      endId = parseInt(args[++i]);
    }
  }

  if (beginId == null || endId == null || isNaN(beginId) || isNaN(endId)) {
    usage();
  }

  try {
    outputConversations(beginId, endId);
  } catch (err) {
    console.error(`Error fetching conversations: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main();
