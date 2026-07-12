#!/usr/bin/env node
/**
 * C4 Communication Bridge - Session Init
 * Emits uniform `=== LABEL ===` blocks (see session-format.js), shared with the
 * memory injection step so the combined session-start context reads
 * consistently:
 * - Last checkpoint (summary if present, else a `(no summary …)` fallback so
 *   the block never silently disappears when a checkpoint has a null summary)
 * - Unsummarized conversations (all if ≤ threshold, last N if > threshold)
 * - Memory Sync instruction (only if > threshold)
 *
 * Two consumption paths:
 * - Shard emitters (emitC4Checkpoint / emitC4Conversations) for the
 *   session-start shard orchestrator — each section gets its own hook stdout
 *   budget, with over-budget conversations packed at MESSAGE granularity.
 * - initC4Session(instanceId, { closeDb }) — the legacy single-stdout path,
 *   also called by the C4 broker with the authenticated caller so isolated
 *   agents get their context without opening c4.db directly.
 *
 * Multi-session aware (fork): when an instance id is in play (argument or
 * ZYLOS_INSTANCE_ID), checkpoint / range / conversation queries are scoped to
 * that instance. If the instance-scoped query layer is unavailable,
 * conversation injection is SKIPPED rather than falling back to unfiltered
 * global queries — injecting nothing is strictly safer than bleeding other
 * instances' conversations into this session.
 *
 * Usage: node c4-session-init.js
 */

import { logHookTiming } from './c4-diagnostic.js';
import { formatSection } from './session-format.js';
import { withinBudget } from '../../activity-monitor/scripts/shard-registry.js';
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
 * Instance-scoped query overrides (loaded lazily, graceful degradation).
 * multiLoadFailed distinguishes "single-session mode" from "scoped layer
 * broken" — the latter must never silently widen to global queries.
 */
async function loadInstanceQueries(instanceId) {
  if (!instanceId) return { multi: null, multiLoadFailed: false };
  try {
    return { multi: await import('./c4-db-multi.js'), multiLoadFailed: false };
  } catch (err) {
    console.error(`[c4-session-init] WARN: c4-db-multi.js import failed: ${err.message}`);
    return { multi: null, multiLoadFailed: true };
  }
}

/**
 * closeDb:false keeps the shared c4-db connection open — the broker reuses one
 * handle across requests; standalone shard emitters close per call.
 */
async function withC4Db(label, action, { closeDb = true } = {}) {
  let close = () => {};
  try {
    const db = await import('./c4-db.js');
    if (closeDb) close = db.close;
    return await action(db);
  } catch (err) {
    const wrapped = new Error(`Error in ${label}: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    close();
  }
}

/**
 * Emit the last-checkpoint section, or '' when no checkpoint exists yet.
 * Standalone emitter for the session-start shard orchestrator (payload-first
 * signature); also composed into initC4Session() for the legacy path.
 */
export async function emitC4Checkpoint(_payload = null, { instanceId = ENV_INSTANCE_ID, closeDb = true } = {}) {
  const { multi } = await loadInstanceQueries(instanceId);
  return withC4Db('c4 checkpoint init', ({ getLastCheckpoint }) => {
    const checkpoint = (instanceId && multi?.getLastCheckpointForInstance)
      ? multi.getLastCheckpointForInstance(instanceId)
      : getLastCheckpoint();

    // Always surface the last checkpoint. Summary present → show it; summary
    // null → emit a fallback so the block never silently disappears.
    if (!checkpoint) return '';
    if (checkpoint.summary) {
      return formatSection('LAST CHECKPOINT SUMMARY', checkpoint.summary);
    }
    return formatSection(
      'LAST CHECKPOINT',
      `(no summary — checkpoint #${checkpoint.id}, ${checkpoint.timestamp})`,
    );
  }, { closeDb });
}

/**
 * Emit the unsummarized-conversations section (including the "no new
 * conversations" fallback and, above threshold, the Memory Sync instruction).
 *
 * In shard mode the orchestrator passes the shard's budget, and over-budget
 * output is packed at MESSAGE granularity: whole oldest messages are dropped
 * until the newest ones fit inline. This shard must never rely on the generic
 * tail-trim + spill fallback — that would cut the NEWEST messages (the text
 * is chronological) and depend on the agent following a read-this-file
 * pointer. Dropped messages are not lost: Memory Sync reads c4.db directly,
 * so they are covered by the next checkpoint summary. Without a budget
 * (legacy single-stdout path) the output is byte-identical to before.
 *
 * Fork: instance-scoped queries when an instance id is in play; the group
 * instance gets per-chat segmentation instead (bounded by the per-group /
 * max-group caps, so message packing is not applied there).
 */
export async function emitC4Conversations(_payload = null, budget = null, { instanceId = ENV_INSTANCE_ID, closeDb = true } = {}) {
  const { multi, multiLoadFailed } = await loadInstanceQueries(instanceId);
  return withC4Db('c4 conversations init', async ({
    getUnsummarizedRange,
    getUnsummarizedConversations,
    formatConversationsForAgent,
  }) => {
    const {
      CHECKPOINT_THRESHOLD,
      SESSION_INIT_RECENT_COUNT,
      SESSION_INIT_GROUP_PER_GROUP,
      SESSION_INIT_GROUP_MAX_GROUPS,
    } = await import('./c4-config.js');

    // Guard: in multi-session mode, never fall back to unfiltered global queries.
    // Injecting nothing is strictly safer than injecting all instances' conversations.
    if (instanceId && multiLoadFailed) {
      console.error(`[c4-session-init] Instance ${instanceId}: instance-scoped queries unavailable, skipping conversation injection`);
      return formatSection(
        'RECENT CONVERSATIONS',
        '(instance-scoped query unavailable — skipped to prevent cross-instance bleed)',
      );
    }

    // Delivered-but-unanswered user messages (lost to an interruption — restart,
    // not-logged-in, frozen) get an explicit ACTION-REQUIRED flag so a fresh
    // session actually replies instead of treating them as passive history.
    // Built once here; appended to whichever delivery path returns below.
    let unansweredSection = null;
    if (instanceId && multi?.getUnansweredDeliveredForInstance) {
      try {
        const unanswered = multi.getUnansweredDeliveredForInstance(instanceId);
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

    const range = (instanceId && multi?.getUnsummarizedRangeForInstance)
      ? multi.getUnsummarizedRangeForInstance(instanceId)
      : getUnsummarizedRange();
    if (range.count === 0) {
      return formatSection('RECENT CONVERSATIONS', 'No new conversations since last checkpoint.');
    }

    const needsSync = range.count > CHECKPOINT_THRESHOLD;

    // Group instance: segment injected history by chat so one busy group can't
    // crowd out others and cross-group context never blends. Each chat gets its
    // own labeled section (most-recently-active first), capped per group.
    if (instanceId && isGroupInstanceId(instanceId)
      && multi?.getUnsummarizedConversationsForInstance && multi?.groupConversationsByGroup) {
      const sections = [];
      const allConvos = multi.getUnsummarizedConversationsForInstance(instanceId);
      const { buckets, omittedGroups } = multi.groupConversationsByGroup(allConvos, {
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
      return sections.join('\n\n');
    }

    // Get conversations: all if under threshold, last N if over
    const getConvos = (instanceId && multi?.getUnsummarizedConversationsForInstance)
      ? (limit) => multi.getUnsummarizedConversationsForInstance(instanceId, limit != null ? { limit } : undefined)
      : getUnsummarizedConversations;
    const conversations = needsSync
      ? getConvos(SESSION_INIT_RECENT_COUNT)
      : getConvos();

    const assemble = kept => {
      // Informational only — no file to read. Kept within the section so it
      // survives exactly as long as the section does.
      const note = kept.length < conversations.length
        ? `(showing the newest ${kept.length} of ${range.count} unsummarized messages inline; older ones are covered by the next Memory Sync checkpoint)\n\n`
        : '';
      const sections = [formatSection('RECENT CONVERSATIONS', note + formatConversationsForAgent(kept))];

      // If over threshold, append Memory Sync instruction
      if (needsSync) {
        sections.push(formatSection(
          'ACTION REQUIRED',
          `There are ${range.count} unsummarized conversations (conversation id ${range.begin_id} ~ ${range.end_id}). Please use zylos-memory skill to process them.`,
        ));
      }

      return sections.join('\n\n');
    };

    let kept = conversations;
    let body = assemble(kept);
    if (budget) {
      // Reserve room for the [k/N] shard header the orchestrator prepends.
      const packBudget = {
        maxChars: Math.max(0, budget.maxChars - 200),
        maxTokens: Math.max(0, budget.maxTokens - 60),
      };
      while (kept.length > 1 && !withinBudget(body, packBudget)) {
        kept = kept.slice(1); // drop the oldest whole message
        body = assemble(kept);
      }
    }
    // The unanswered flag rides outside packing: it is small, and dropping it
    // to fit budget would defeat its whole purpose (never lose a waiting user).
    return unansweredSection ? `${body}\n\n${unansweredSection}` : body;
  }, { closeDb });
}

/**
 * Build the SessionStart context string for one instance (legacy single-stdout
 * path, composed from the shard emitters).
 *
 * @param {string|null} [instanceId] - target instance; defaults to the env
 *   (standalone hook use). The C4 broker passes the authenticated caller so it
 *   can serve isolated agents that no longer open the DB directly.
 * @param {{ closeDb?: boolean }} [opts] - closeDb:false keeps the shared c4-db
 *   connection open (the broker reuses one handle across requests).
 */
export async function initC4Session(instanceId = ENV_INSTANCE_ID, { closeDb: closeDbAfter = true } = {}) {
  try {
    const sections = [
      await emitC4Checkpoint(null, { instanceId, closeDb: false }),
      await emitC4Conversations(null, null, { instanceId, closeDb: closeDbAfter }),
    ].filter(Boolean);
    return `${sections.join('\n\n')}\n`;
  } catch (err) {
    if (err.cause) throw err;
    const wrapped = new Error(`Error in session init: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
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
