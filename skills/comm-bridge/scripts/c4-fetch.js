#!/usr/bin/env node
/**
 * C4 Communication Bridge - Fetch Conversations
 * Returns checkpoint summary + conversations.
 *
 * Usage:
 *   node c4-fetch.js --unsummarized           Fetch all unsummarized conversations
 *   node c4-fetch.js --begin <id> --end <id>  Fetch conversations in a specific range
 *   node c4-fetch.js --since <time>           Fetch conversations from a point in time
 *                                             (all-instance reads only in multi-session)
 */

import {
  getLastCheckpoint,
  getUnsummarizedRange,
  getConversationsByRange,
  getConversationsSince,
  formatConversations,
  close
} from './c4-db.js';
import { shouldUseBroker, brokerCall, instanceIsIsolated } from './c4-client.js';

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

const DURATION_UNITS_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const DURATION_PATTERN = /^(\d+)([mhd])$/;
const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function usage() {
  console.error([
    'Usage:',
    '  c4-fetch.js --unsummarized                 Fetch unsummarized conversations for this instance',
    '  c4-fetch.js --unsummarized --all-instances  Fetch unsummarized conversations across ALL instances',
    '  c4-fetch.js --begin <id> --end <id>         Fetch conversations in a specific range',
    '  c4-fetch.js --begin <id> --end <id> --all-instances  Fetch range across ALL instances',
    '  c4-fetch.js --since <duration|datetime>    Fetch from a point in time (all-instance reads only)',
  ].join('\n'));
  process.exit(1);
}

/**
 * Format a Date as UTC 'YYYY-MM-DD HH:MM:SS', the format of the timestamp column.
 */
function toDbTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a --since value into a UTC timestamp string.
 * Accepts a relative duration (30m, 6h, 1d) or a datetime (YYYY-MM-DD,
 * YYYY-MM-DD HH:MM[:SS[.sss]], optionally with T, Z or a ±HH:MM offset). A
 * datetime without an offset is UTC, like the timestamps c4-fetch prints.
 * Fractional seconds are dropped, as the timestamp column has none.
 * @returns {string|null} - timestamp, or null when the value is invalid
 */
function parseSince(value) {
  const duration = DURATION_PATTERN.exec(value);
  if (duration) {
    const start = new Date(Date.now() - Number(duration[1]) * DURATION_UNITS_MS[duration[2]]);
    // Durations reaching before year 0000 do not fit the timestamp format.
    return start.getUTCFullYear() >= 0 ? toDbTimestamp(start) : null;
  }

  const datetime = DATETIME_PATTERN.exec(value);
  if (!datetime) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', offset = 'Z'] = datetime;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  // Date.UTC rolls over out-of-range fields (Feb 30 -> Mar 2); reject those.
  if (Number.isNaN(utcMs) || new Date(utcMs).toISOString().slice(0, 19) !== local) return null;

  let offsetMs = 0;
  if (offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = Number(digits.slice(2));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  }
  return toDbTimestamp(new Date(utcMs - offsetMs));
}

function printConversations(label, conversations, checkpoint) {
  const lines = [];

  if (checkpoint?.summary) {
    lines.push(`[Last Checkpoint Summary] ${checkpoint.summary}`);
    lines.push('');
  }

  lines.push(`[Conversations] (${label})`);

  if (conversations.length === 0) {
    lines.push('No conversations in this range.');
  } else {
    lines.push(formatConversations(conversations));
  }

  console.log(lines.join('\n'));
}

function outputConversations(beginId, endId, { allInstances = false } = {}) {
  const checkpoint = (!allInstances && INSTANCE_ID && _getLastCheckpointForInstance)
    ? _getLastCheckpointForInstance(INSTANCE_ID)
    : getLastCheckpoint();
  const useInstanceFilter = !allInstances && INSTANCE_ID && _getConversationsByRangeForInstance;
  const conversations = useInstanceFilter
    ? _getConversationsByRangeForInstance(beginId, endId, INSTANCE_ID)
    : getConversationsByRange(beginId, endId);
  printConversations(`id ${beginId} ~ ${endId}`, conversations, checkpoint);
}

// Upstream --since reads every tenant's rows, so it is served only to unscoped
// callers; an instance-scoped read keeps --begin/--end (fork, 0.9.5 catch-up).
function outputConversationsSince(since) {
  const conversations = getConversationsSince(since);
  // Rows come in timestamp order; report the full id span for --begin/--end.
  let minId = Infinity;
  let maxId = -Infinity;
  for (const { id } of conversations) {
    minId = Math.min(minId, id);
    maxId = Math.max(maxId, id);
  }
  const label = conversations.length === 0
    ? `since ${since} UTC`
    : `since ${since} UTC, id ${minId} ~ ${maxId}`;
  printConversations(label, conversations, getLastCheckpoint());
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

  // MEDIUM-1: --all-instances is an un-instance-filtered cross-tenant read.
  // Isolated agents must never reach it (it would silently drop to the legacy
  // direct-DB path, bypassing the broker + the loud SPOF discipline).
  if (allInstances && instanceIsIsolated()) {
    console.error('--all-instances is not available for isolated instances');
    process.exit(1);
  }

  // Isolated agents route through the broker (always self-scoped).
  let useBroker = false;
  try { useBroker = !allInstances && shouldUseBroker(); }
  catch (err) { console.error(err.message); process.exit(1); }

  const sinceRequested = args.includes('--since');
  if (sinceRequested && (useBroker || (INSTANCE_ID && !allInstances))) {
    console.error('--since is not available for instance-scoped fetch; use --begin/--end');
    process.exit(1);
  }

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

  if (sinceRequested && args.includes('--unsummarized')) {
    usage();
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

  const sinceIndex = args.indexOf('--since');
  if (sinceIndex !== -1) {
    const since = parseSince(args[sinceIndex + 1] ?? '');
    if (since == null || args.includes('--begin') || args.includes('--end')) {
      usage();
    }
    try {
      outputConversationsSince(since);
    } catch (err) {
      console.error(`Error fetching conversations: ${err.stack}`);
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
