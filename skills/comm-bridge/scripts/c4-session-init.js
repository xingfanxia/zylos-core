#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Called by the SessionStart orchestrator via initC4Session(), which returns
 * the context string. Emits uniform `=== LABEL ===` blocks (see session-format.js),
 * shared with the memory injection step so the combined session-start context
 * reads consistently:
 * - Last checkpoint (summary if present, else a `(no summary …)` fallback so
 *   the block never silently disappears when a checkpoint has a null summary)
 * - Unsummarized conversations (all if ≤ threshold, last N if > threshold)
 * - Memory Sync instruction (only if > threshold)
 *
 * Multi-session aware: when ZYLOS_INSTANCE_ID is set, the checkpoint / range /
 * conversation queries are scoped to that instance. If the instance-scoped query
 * layer is unavailable, conversation injection is SKIPPED rather than falling
 * back to unfiltered global queries — injecting nothing is strictly safer than
 * bleeding other instances' conversations into this session.
 *
 * Usage: node c4-session-init.js
 */

import { logHookTiming } from './c4-diagnostic.js';
import { formatSection } from './session-format.js';
import { shouldUseBroker, brokerCall } from './c4-client.js';
import { fileURLToPath } from 'node:url';

const ENV_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

/**
 * Build the SessionStart context string for one instance.
 *
 * @param {string|null} [instanceId] - target instance; defaults to the env
 *   (standalone hook use). The C4 broker passes the authenticated caller so it
 *   can serve isolated agents that no longer open the DB directly.
 * @param {{ closeDb?: boolean }} [opts] - closeDb:false keeps the shared c4-db
 *   connection open (the broker reuses one handle across requests).
 */
export async function initC4Session(instanceId = ENV_INSTANCE_ID, { closeDb: closeDbAfter = true } = {}) {
  const INSTANCE_ID = instanceId;
  let close = () => {};
  try {
    const {
      getLastCheckpoint,
      getUnsummarizedRange,
      getUnsummarizedConversations,
      formatConversations,
      close: closeDbFn,
    } = await import('./c4-db.js');
    close = closeDbFn;
    const { CHECKPOINT_THRESHOLD, SESSION_INIT_RECENT_COUNT } = await import('./c4-config.js');

    // Instance-scoped query overrides (loaded lazily, graceful degradation).
    let getLastCheckpointForInstance = null;
    let getUnsummarizedRangeForInstance = null;
    let getUnsummarizedConversationsForInstance = null;
    let multiLoadFailed = false;
    if (INSTANCE_ID) {
      try {
        const multiMod = await import('./c4-db-multi.js');
        getLastCheckpointForInstance = multiMod.getLastCheckpointForInstance;
        getUnsummarizedRangeForInstance = multiMod.getUnsummarizedRangeForInstance;
        getUnsummarizedConversationsForInstance = multiMod.getUnsummarizedConversationsForInstance;
      } catch (err) {
        multiLoadFailed = true;
        console.error(`[c4-session-init] WARN: c4-db-multi.js import failed: ${err.message}`);
      }
    }

    const checkpoint = (INSTANCE_ID && getLastCheckpointForInstance)
      ? getLastCheckpointForInstance(INSTANCE_ID)
      : getLastCheckpoint();
    const sections = [];

    // Always surface the last checkpoint. Summary present → show it; summary
    // null → emit a fallback so the block never silently disappears.
    if (checkpoint) {
      if (checkpoint.summary) {
        sections.push(formatSection('LAST CHECKPOINT SUMMARY', checkpoint.summary));
      } else {
        sections.push(formatSection(
          'LAST CHECKPOINT',
          `(no summary — checkpoint #${checkpoint.id}, ${checkpoint.timestamp})`,
        ));
      }
    }

    // Guard: in multi-session mode, never fall back to unfiltered global queries.
    // Injecting nothing is strictly safer than injecting all instances' conversations.
    if (INSTANCE_ID && multiLoadFailed) {
      console.error(`[c4-session-init] Instance ${INSTANCE_ID}: instance-scoped queries unavailable, skipping conversation injection`);
      sections.push(formatSection(
        'RECENT CONVERSATIONS',
        '(instance-scoped query unavailable — skipped to prevent cross-instance bleed)',
      ));
      return `${sections.join('\n\n')}\n`;
    }

    const range = (INSTANCE_ID && getUnsummarizedRangeForInstance)
      ? getUnsummarizedRangeForInstance(INSTANCE_ID)
      : getUnsummarizedRange();

    if (range.count === 0) {
      sections.push(formatSection('RECENT CONVERSATIONS', 'No new conversations since last checkpoint.'));
      return `${sections.join('\n\n')}\n`;
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Get conversations: all if under threshold, last N if over.
    const getConvos = (INSTANCE_ID && getUnsummarizedConversationsForInstance)
      ? (limit) => getUnsummarizedConversationsForInstance(INSTANCE_ID, limit != null ? { limit } : undefined)
      : getUnsummarizedConversations;
    const conversations = needsSync
      ? getConvos(SESSION_INIT_RECENT_COUNT)
      : getConvos();

    sections.push(formatSection('RECENT CONVERSATIONS', formatConversations(conversations)));

    // If over threshold, append Memory Sync instruction.
    if (needsSync) {
      sections.push(formatSection(
        'ACTION REQUIRED',
        `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
      ));
    }

    return `${sections.join('\n\n')}\n`;
  } catch (err) {
    const wrapped = new Error(`Error in session init: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    if (closeDbAfter) close();
  }
}

function main() {
  const startMs = Date.now();
  (async () => {
    try {
      // Isolated agents fetch their session context from the broker (they no
      // longer open c4.db directly). Admin/scheduler compute it in-process.
      const output = shouldUseBroker()
        ? (await brokerCall('session-init')).context
        : await initC4Session();
      process.stdout.write(output);
    } catch (err) {
      console.error(err.cause?.stack || err.stack || err.message);
      process.exitCode = 1;
    } finally {
      logHookTiming('c4-session-init', Date.now() - startMs);
    }
  })().catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
    logHookTiming('c4-session-init', Date.now() - startMs);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
