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
import { getInstanceDef } from '../../multi-session/instance-config.js';
import { fileURLToPath } from 'node:url';

const ENV_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

/** Whether an instance is the group instance (type:'group'); fails safe to false. */
function isGroupInstanceId(instanceId) {
  try {
    return getInstanceDef(instanceId)?.type === 'group';
  } catch {
    return false;
  }
}

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
      formatConversationsForAgent,
      close: closeDbFn,
    } = await import('./c4-db.js');
    close = closeDbFn;
    const {
      CHECKPOINT_THRESHOLD,
      SESSION_INIT_RECENT_COUNT,
      SESSION_INIT_GROUP_PER_GROUP,
      SESSION_INIT_GROUP_MAX_GROUPS,
    } = await import('./c4-config.js');

    // Instance-scoped query overrides (loaded lazily, graceful degradation).
    let getLastCheckpointForInstance = null;
    let getUnsummarizedRangeForInstance = null;
    let getUnsummarizedConversationsForInstance = null;
    let groupConversationsByGroup = null;
    let getUnansweredDeliveredForInstance = null;
    let multiLoadFailed = false;
    if (INSTANCE_ID) {
      try {
        const multiMod = await import('./c4-db-multi.js');
        getLastCheckpointForInstance = multiMod.getLastCheckpointForInstance;
        getUnsummarizedRangeForInstance = multiMod.getUnsummarizedRangeForInstance;
        getUnsummarizedConversationsForInstance = multiMod.getUnsummarizedConversationsForInstance;
        groupConversationsByGroup = multiMod.groupConversationsByGroup;
        getUnansweredDeliveredForInstance = multiMod.getUnansweredDeliveredForInstance;
      } catch (err) {
        multiLoadFailed = true;
        console.error(`[c4-session-init] WARN: c4-db-multi.js import failed: ${err.message}`);
      }
    }

    const isGroup = INSTANCE_ID ? isGroupInstanceId(INSTANCE_ID) : false;

    // Delivered-but-unanswered user messages (lost to an interruption — restart,
    // not-logged-in, frozen) get an explicit ACTION-REQUIRED flag so a fresh
    // session actually replies instead of treating them as passive history.
    // Built once here; appended to whichever delivery path returns below.
    let unansweredSection = null;
    if (INSTANCE_ID && getUnansweredDeliveredForInstance) {
      try {
        const unanswered = getUnansweredDeliveredForInstance(INSTANCE_ID);
        if (unanswered && unanswered.length > 0) {
          const MAX = 5;
          const lines = unanswered.slice(-MAX).map((m) => {
            const chat = String(m.endpoint_id || '').split('|')[0];
            // Strip any reply-routing suffix from the preview: this section is a
            // pointer, not a second copy of the routing (the full message with
            // its reply path is in the conversation sections above).
            const preview = String(m.content || '')
              .replace(/----\s*reply via:.*$/is, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 100);
            return `- [${m.channel} ${chat}] "${preview}" (${m.timestamp})`;
          });
          const more = unanswered.length > MAX ? `\n(+${unanswered.length - MAX} more earlier)` : '';
          unansweredSection = formatSection(
            'ACTION REQUIRED — POSSIBLY UNANSWERED',
            'These user message(s) were delivered but have NO reply yet — likely delivered during an '
            + 'interruption (restart / not-logged-in / frozen) and never processed. Read the full text in '
            + 'the conversation sections above and REPLY if still relevant, using the reply path shown '
            + `with each message above:\n${lines.join('\n')}${more}`,
          );
        }
      } catch (err) {
        console.error(`[c4-session-init] WARN: unanswered-delivered check failed: ${err.message}`);
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

    // Group instance: segment injected history by chat so one busy group can't
    // crowd out others and cross-group context never blends. Each chat gets its
    // own labeled section (most-recently-active first), capped per group.
    if (isGroup && getUnsummarizedConversationsForInstance && groupConversationsByGroup) {
      const allConvos = getUnsummarizedConversationsForInstance(INSTANCE_ID);
      const { buckets, omittedGroups } = groupConversationsByGroup(allConvos, {
        perGroupLimit: SESSION_INIT_GROUP_PER_GROUP,
        maxGroups: SESSION_INIT_GROUP_MAX_GROUPS,
      });

      for (const bucket of buckets) {
        const label = bucket.count > bucket.conversations.length
          ? `GROUP ${bucket.label} (showing ${bucket.conversations.length} of ${bucket.count})`
          : `GROUP ${bucket.label}`;
        sections.push(formatSection(label, formatConversationsForAgent(bucket.conversations)));
      }
      if (omittedGroups > 0) {
        sections.push(formatSection(
          'MORE GROUPS',
          `${omittedGroups} less-recently-active group(s) omitted from this injection.`,
        ));
      }
      if (needsSync) {
        sections.push(formatSection(
          'ACTION REQUIRED',
          `There are ${range.count} unsummarized conversations across all groups (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them, keeping each chat's memory under memory/groups/<group_key>/.`,
        ));
      }
      if (unansweredSection) sections.push(unansweredSection);
      return `${sections.join('\n\n')}\n`;
    }

    // Get conversations: all if under threshold, last N if over.
    const getConvos = (INSTANCE_ID && getUnsummarizedConversationsForInstance)
      ? (limit) => getUnsummarizedConversationsForInstance(INSTANCE_ID, limit != null ? { limit } : undefined)
      : getUnsummarizedConversations;
    const conversations = needsSync
      ? getConvos(SESSION_INIT_RECENT_COUNT)
      : getConvos();

    sections.push(formatSection('RECENT CONVERSATIONS', formatConversationsForAgent(conversations)));

    // If over threshold, append Memory Sync instruction.
    if (needsSync) {
      sections.push(formatSection(
        'ACTION REQUIRED',
        `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
      ));
    }

    if (unansweredSection) sections.push(unansweredSection);
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
