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
  getConversationsByRange,
  formatConversations,
  close
} from './c4-db.js';
import { shouldUseBroker, brokerCall } from './c4-client.js';

const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// Instance-scoped query overrides (loaded lazily, graceful degradation)
let _getUnsummarizedRangeForInstance = null;
let _getConversationsByRangeForInstance = null;
let _getLastCheckpointForInstance = null;
try {
  const multiMod = await import('./c4-db-multi.js');
  _getUnsummarizedRangeForInstance = multiMod.getUnsummarizedRangeForInstance;
  _getConversationsByRangeForInstance = multiMod.getConversationsByRangeForInstance;
  _getLastCheckpointForInstance = multiMod.getLastCheckpointForInstance;
} catch {
  // c4-db-multi.js not available — instance-scoped queries disabled
}

function usage() {
  console.error([
    'Usage:',
    '  c4-fetch.js --unsummarized                 Fetch unsummarized conversations for this instance',
    '  c4-fetch.js --unsummarized --all-instances  Fetch unsummarized conversations across ALL instances',
    '  c4-fetch.js --begin <id> --end <id>         Fetch conversations in a specific range',
    '  c4-fetch.js --begin <id> --end <id> --all-instances  Fetch range across ALL instances',
  ].join('\n'));
  process.exit(1);
}

function outputConversations(beginId, endId, { allInstances = false } = {}) {
  const checkpoint = (!allInstances && INSTANCE_ID && _getLastCheckpointForInstance)
    ? _getLastCheckpointForInstance(INSTANCE_ID)
    : getLastCheckpoint();
  const useInstanceFilter = !allInstances && INSTANCE_ID && _getConversationsByRangeForInstance;
  const conversations = useInstanceFilter
    ? _getConversationsByRangeForInstance(beginId, endId, INSTANCE_ID)
    : getConversationsByRange(beginId, endId);
  const lines = [];

  if (checkpoint?.summary) {
    lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
    lines.push('');
  }

  lines.push(`[Conversations] (id ${beginId} ~ ${endId})`);

  if (conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(formatConversations(conversations));
  }

  console.log(lines.join('\n'));
}

/** Print a broker fetch response ({checkpoint, range, conversations, formatted}). */
function printBrokerFetch(data, { unsummarized }) {
  if (unsummarized) {
    if (!data.range || data.range.count === 0) {
      console.log('No unsummarized conversations.');
      return;
    }
    console.log(`[Unsummarized Range] end_id=${data.range.end_id} count=${data.range.count}`);
  }
  const lines = [];
  if (data.checkpoint?.summary) {
    lines.push(`[Last Checkpoint Summary] ${data.checkpoint.summary}`);
    lines.push('');
  }
  lines.push(`[Conversations] (id ${data.range.begin_id} ~ ${data.range.end_id})`);
  if (!data.conversations || data.conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(data.formatted);
  }
  console.log(lines.join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const allInstances = args.includes('--all-instances');

  // Isolated agents route through the broker (always self-scoped;
  // --all-instances is an admin/debug flag that stays on the legacy path).
  let useBroker = false;
  try { useBroker = !allInstances && shouldUseBroker(); }
  catch (err) { console.error(err.message); process.exit(1); }

  if (useBroker) {
    if (args.includes('--unsummarized')) {
      const data = await brokerCall('fetch', { unsummarized: true });
      printBrokerFetch(data, { unsummarized: true });
      return;
    }
    let b = null, e = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--begin') b = parseInt(args[++i]);
      else if (args[i] === '--end') e = parseInt(args[++i]);
    }
    if (b == null || e == null || isNaN(b) || isNaN(e)) usage();
    const data = await brokerCall('fetch', { begin: b, end: e });
    printBrokerFetch(data, { unsummarized: false });
    return;
  }

  if (args.includes('--unsummarized')) {
    try {
      const useInstanceFilter = !allInstances && INSTANCE_ID && _getUnsummarizedRangeForInstance;
      const range = useInstanceFilter
        ? _getUnsummarizedRangeForInstance(INSTANCE_ID)
        : getUnsummarizedRange();
      if (!range || range.count === 0) {
        console.log('No unsummarized conversations.');
        return;
      }
      console.log(`[Unsummarized Range] end_id=${range.end_id} count=${range.count}`);
      outputConversations(range.begin_id, range.end_id, { allInstances });
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
    outputConversations(beginId, endId, { allInstances });
  } catch (err) {
    console.error(`Error fetching conversations: ${err.stack}`);
    process.exit(1);
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
