#!/usr/bin/env node
/**
 * C4 Communication Bridge - Checkpoint Interface
 *
 * Commands:
 *   create <end_conversation_id> [--summary "<summary>"]
 *   list [--limit <n>]
 *   latest
 *
 */

import { createCheckpoint, getCheckpoints, getLastCheckpoint, close } from './c4-db.js';
import { shouldUseBroker, brokerCall } from './c4-client.js';

const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// Instance-scoped checkpoint functions (optional)
let _createCheckpointForInstance = null;
let _getLastCheckpointForInstance = null;
try {
  const multiMod = await import('./c4-db-multi.js');
  _createCheckpointForInstance = multiMod.createCheckpointForInstance;
  _getLastCheckpointForInstance = multiMod.getLastCheckpointForInstance;
} catch {
  // c4-db-multi.js not available — use global functions
}

function usage() {
  console.error('Usage: c4-checkpoint.js <command> [options]');
  console.error('  create <end_conversation_id> [--summary "<summary>"]');
  console.error('  list [--limit <n>]');
  console.error('  latest');
}

function errorExit(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseStringArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value) errorExit(`missing value for ${flag}`);
  return value;
}

function parseNumberArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const raw = args[idx + 1];
  if (!raw) errorExit(`missing value for ${flag}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errorExit(`${flag} must be a number`);
  }
  return value;
}

async function handleCreate(args) {
  if (args.length < 1 || args[0].startsWith('--')) {
    errorExit('create requires <end_conversation_id>');
  }

  const endConversationId = parseInt(args[0]);
  if (isNaN(endConversationId)) {
    errorExit('end_conversation_id must be a number');
  }

  const summary = parseStringArg(args, '--summary');

  // Isolated agents route through the broker (checkpoint forced to caller).
  if (shouldUseBroker()) {
    const result = await brokerCall('checkpoint', { endId: endConversationId, summary });
    console.log('Checkpoint created:', JSON.stringify(result));
    return;
  }

  const targetInstance = parseStringArg(args, '--target-instance') || INSTANCE_ID;
  const result = (targetInstance && _createCheckpointForInstance)
    ? _createCheckpointForInstance(endConversationId, summary, targetInstance)
    : createCheckpoint(endConversationId, summary);
  console.log('Checkpoint created:', JSON.stringify(result));
}

function handleList(args) {
  // `list` reads ALL instances' checkpoints (no instance filter). Isolated
  // agents must not use it as an un-brokered cross-tenant read path (MEDIUM-1);
  // there is no broker op for the global list. shouldUseBroker() also throws
  // loudly (SPOF) if an isolated agent's broker is down.
  if (shouldUseBroker()) {
    errorExit('checkpoint list is not available for isolated instances (admin-only; use `latest`)');
  }
  const limit = parseNumberArg(args, '--limit');
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    errorExit('--limit must be a positive integer');
  }

  let rows = getCheckpoints();
  if (limit !== null) {
    rows = rows.slice(0, limit);
  }
  console.log(JSON.stringify(rows, null, 2));
}

async function handleLatest() {
  if (shouldUseBroker()) {
    const row = await brokerCall('checkpoint', { latest: true });
    if (!row) errorExit('no checkpoints found');
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  const targetInstance = INSTANCE_ID;
  const row = (targetInstance && _getLastCheckpointForInstance)
    ? _getLastCheckpointForInstance(targetInstance)
    : getLastCheckpoint();
  if (!row) {
    errorExit('no checkpoints found');
  }
  console.log(JSON.stringify(row, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  try {
    switch (command) {
      case 'create':
        await handleCreate(args.slice(1));
        break;
      case 'list':
        handleList(args.slice(1));
        break;
      case 'latest':
        await handleLatest();
        break;
      default:
        usage();
        errorExit(`unknown command: ${command}`);
    }
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
