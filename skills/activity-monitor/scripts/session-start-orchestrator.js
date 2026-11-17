#!/usr/bin/env node
/**
 * SessionStart orchestrator.
 *
 * Two modes:
 * - `--shard <name>`: emit a single injection shard (or run a single
 *   side-effect step). Hook sync installs one command per shard so each
 *   shard gets its own hook stdout budget; the shard sequencer pins the
 *   injection order to chain order (see shard-sequencer.js).
 * - no arguments (legacy): run every startup step in-process with a single
 *   combined stdout. Kept for installs whose settings.json still points at
 *   the un-sharded command.
 *
 * Stdout is reserved for context injection payloads in both modes.
 */

import { isCliEntry } from '../../multi-session/cli-entry.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { formatSection } from '../../comm-bridge/scripts/session-format.js';
import { getInstanceRuntimeProfile } from '../../multi-session/runtime-files.js';
import {
  SIDE_EFFECT_NAMES,
  estimateTokens,
  fitToBudget,
  resolveShard,
  withinBudget,
} from './shard-registry.js';
import {
  ladderDeadlineMs,
  perUserSuffix,
  readFlagStatus,
  sweepStaleFlags,
  tLinkMs,
  waitForFlag,
  writeFlag,
} from './shard-sequencer.js';

export const DEFAULT_TOTAL_BUDGET_MS = 17_000;
export const STEP_BUDGETS_MS = {
  memoryInject: 5_500,
  c4SessionInit: 5_500,
  foreground: 3_000,
  startupPrompt: 3_000,
};
export const SHARD_EMIT_BUDGET_MS = 5_500;
// Per-user root for the same reason as the flag root (see perUserSuffix in
// shard-sequencer.js): a fixed name under shared /tmp is unwritable for the
// second zylos user on a multi-user host.
const SPILL_ROOT_NAME = `zylos-shard-spill-${perUserSuffix()}`;

export function startupContextRequired(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.ZYLOS_REQUIRE_STARTUP_CONTEXT || ''));
}

export function installProcessBackstop({
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  exit = process.exit,
} = {}) {
  const timer = setTimeout(() => {
    console.error(`[session-start-orchestrator] total budget ${totalBudgetMs}ms exceeded; exiting`);
    exit(0);
  }, totalBudgetMs);
  timer.unref?.();
  return timer;
}

export function writeAllSync(fd, text, {
  writeSync = fs.writeSync,
} = {}) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`writeSync made no progress at offset ${offset}`);
      }
      offset += written;
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      throw error;
    }
  }
  return offset;
}

export function readStdinPayload({
  stdin = process.stdin,
  timeoutMs = 500,
} = {}) {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off?.('data', onData);
      stdin.off?.('end', onEnd);
      stdin.pause?.();
      stdin.unref?.();
      resolve(payload);
    };
    const onData = chunk => { input += chunk; };
    const onEnd = () => {
      try {
        finish(JSON.parse(input || '{}'));
      } catch {
        finish({});
      }
    };
    // Ref'd on purpose: finish() always clears it, so it can't outlive the read.
    // If unref'd, a stdin that never emits 'end' would let the loop drain before
    // the timeout fires, so readStdinPayload would hang instead of timing out.
    const timer = setTimeout(() => finish({}), timeoutMs);
    stdin.setEncoding?.('utf8');
    stdin.on?.('data', onData);
    stdin.on?.('end', onEnd);
  });
}

async function logStep({ name, source, status, durationMs, stdoutBytes = 0, extra, error }) {
  try {
    const { logHookTiming } = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    const detail = [
      `session-start-orchestrator:${name}`,
      source ? `[${source}]` : '',
      `status=${status}`,
      `stdout=${stdoutBytes}`,
      extra || '',
      error ? `error=${String(error.message || error).replace(/\s+/g, '_').slice(0, 120)}` : '',
    ].filter(Boolean).join(':');
    logHookTiming(detail, durationMs);
  } catch {
    // Diagnostics are best-effort.
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    // Do NOT unref: this timer is always cleared in .finally() once the race
    // settles, so it can never outlive the step. It must stay ref'd so it can
    // actually fire and enforce the budget when the action hangs — an unref'd
    // timeout would let the event loop drain before firing (the timeout would
    // silently never enforce, and node:test cancels the pending step).
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runStep({
  name,
  source,
  budgetMs,
  action,
  writeStdout = false,
  extra,
  stdout = process.stdout,
  writeSync = fs.writeSync,
}) {
  const startMs = Date.now();
  try {
    const output = await withTimeout(Promise.resolve().then(action), budgetMs, name);
    const text = output == null ? '' : String(output);
    if (writeStdout && text.length > 0) {
      writeAllSync(stdout.fd ?? 1, text, { writeSync });
    }
    await logStep({
      name,
      source,
      status: 'ok',
      durationMs: Date.now() - startMs,
      stdoutBytes: writeStdout ? Buffer.byteLength(text) : 0,
      extra,
    });
    return { ok: true, output: text };
  } catch (error) {
    const timedOut = /timed out/.test(String(error?.message || error));
    console.error(`[session-start-orchestrator] step "${name}" ${timedOut ? 'timed out' : 'failed'} (${Date.now() - startMs}ms): ${error?.message || error}`);
    // For context-producing steps, make the failure visible in the injected
    // stream instead of silently dropping the section — otherwise a failed
    // step reads as "this context simply doesn't exist".
    if (writeStdout) {
      const notice = formatSection(
        `${name.toUpperCase()} UNAVAILABLE`,
        `session-start step "${name}" ${timedOut ? 'timed out' : 'failed'}: ${error?.message || error}`,
      );
      writeAllSync(stdout.fd ?? 1, `${notice}\n`, { writeSync });
    }
    await logStep({
      name,
      source,
      status: timedOut ? 'timeout' : 'failed',
      durationMs: Date.now() - startMs,
      extra,
      error,
    });
    return { ok: false, error };
  }
}

async function runMemoryInject(payload) {
  const { injectMemory } = await import('../../zylos-memory/scripts/session-start-inject.js');
  return injectMemory(payload);
}

async function runC4SessionInit() {
  const { initC4Session } = await import('../../comm-bridge/scripts/c4-session-init.js');
  // initC4Session takes an INSTANCE ID, not the SessionStart payload — let it
  // default to ZYLOS_INSTANCE_ID from the env. (Passing the payload object here
  // bound an object as a SQL param → "too few parameter values".)
  return initC4Session();
}

async function runForeground(payload) {
  const { handleSessionForeground } = await import('./session-foreground.js');
  handleSessionForeground(payload);
}

async function runStartupPrompt(payload) {
  const { enqueueStartupPrompt } = await import('./session-start-prompt.js');
  return enqueueStartupPrompt(payload?.source || null);
}

export async function runSessionStartOrchestrator(payload = {}, {
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  budgets = STEP_BUDGETS_MS,
  stdout = process.stdout,
  hardBackstopTimer = null,
  requireHealthyContext = startupContextRequired(),
  actions = {
    memoryInject: runMemoryInject,
    c4SessionInit: runC4SessionInit,
    foreground: runForeground,
    startupPrompt: runStartupPrompt,
  },
} = {}) {
  const source = payload?.source || null;
  const totalTimer = hardBackstopTimer || installProcessBackstop({ totalBudgetMs });

  try {
    const memoryResult = await runStep({
      name: 'memory-inject',
      source,
      budgetMs: budgets.memoryInject,
      action: () => actions.memoryInject(payload),
      writeStdout: true,
      stdout,
    });

    const c4Result = await runStep({
      name: 'c4-session-init',
      source,
      budgetMs: budgets.c4SessionInit,
      action: () => actions.c4SessionInit(payload),
      writeStdout: true,
      stdout,
    });

    const contextFailures = [
      ['memory-inject', memoryResult],
      ['c4-session-init', c4Result],
    ].filter(([, result]) => !result.ok).map(([name]) => `${name}: failed`);
    if (requireHealthyContext && contextFailures.length > 0) {
      const notice = formatSection(
        'STARTUP CONTEXT BLOCKED',
        [
          'Required startup context did not load cleanly.',
          ...contextFailures.map(failure => `- ${failure}`),
          'Do not continue work or answer external messages. Wait for an operator to repair the runtime and start a fresh session.',
        ].join('\n'),
      );
      writeAllSync(stdout.fd ?? 1, `${notice}\n`);
    }

    const sideEffects = [
      runStep({
        name: 'session-foreground',
        source,
        budgetMs: budgets.foreground,
        action: () => actions.foreground(payload),
      }),
    ];

    if (source === 'compact' || (requireHealthyContext && contextFailures.length > 0)) {
      await logStep({
        name: 'session-start-prompt',
        source,
        status: source === 'compact' ? 'skipped' : 'blocked',
        durationMs: 0,
        extra: contextFailures.length > 0 ? `context=${contextFailures.join('|')}` : '',
      });
    } else {
      sideEffects.push(runStep({
        name: 'session-start-prompt',
        source,
        budgetMs: budgets.startupPrompt,
        action: () => actions.startupPrompt(payload),
      }));
    }

    await Promise.all(sideEffects);
  } finally {
    if (!hardBackstopTimer) clearTimeout(totalTimer);
  }
}

/**
 * Numbered self-describing shard header. This is the fail-safe half of the
 * ordering design: a crashed shard leaves no trace in context at all (only a
 * transcript-level hook error), so a missing [k/N] number is the ONLY
 * in-context signal that a shard was lost. The header sits within the first
 * 2KB, so it survives the persisted-output preview if a budget is ever blown.
 */
export function shardHeader({ position, total, name, waitNote = '' }) {
  return `=== ZYLOS STARTUP CONTEXT [${position}/${total}] ${name}${waitNote ? ` (${waitNote})` : ''} ===`;
}

/**
 * The engine this session runs under, from the same runtime profile the
 * launcher uses to start it (instances.json active profile → instance
 * runtime → .zylos/config.json). null when it cannot be resolved.
 */
export function resolveShardRuntime({ zylosDir, instanceId = process.env.ZYLOS_INSTANCE_ID || null } = {}) {
  try {
    const profile = getInstanceRuntimeProfile({ ...(zylosDir ? { zylosDir } : {}), instanceId });
    if (profile?.errors?.length) return null;
    return profile?.runtime === 'claude' || profile?.runtime === 'codex' ? profile.runtime : null;
  } catch {
    return null;
  }
}

/**
 * Each limit applies only to the runtime it protects: Claude Code persists
 * hook stdout above maxChars (no token cap), Codex elides above its per-hook
 * token cap (maxTokens; the char cap is kept as an outer bound). Unknown
 * runtime keeps both.
 */
export function shardBudgetForRuntime(budget, runtime) {
  return runtime === 'claude' ? { ...budget, maxTokens: Number.POSITIVE_INFINITY } : { ...budget };
}

export function shardSpillPath(sessionId, shardName, { tmpdir = os.tmpdir() } = {}) {
  const cleaned = String(sessionId || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(tmpdir, SPILL_ROOT_NAME, cleaned, `${shardName}.txt`);
}

/**
 * Normalize an emitter's return value to the structured shard body.
 * A plain string is one unlabeled trimmable section (the historical
 * contract every component emitter still uses). A structured body is
 * `{ guaranteed?: string, sections?: [{ text, label?, path? }] }`.
 */
export function normalizeShardBody(body) {
  if (body != null && typeof body === 'object' && !Array.isArray(body)) {
    const sections = (Array.isArray(body.sections) ? body.sections : [])
      .filter(item => item && String(item.text ?? '').trim())
      .map(item => ({
        text: String(item.text).trim(),
        label: item.label || null,
        path: item.path || null,
      }));
    return { guaranteed: String(body.guaranteed ?? '').trim(), sections };
  }
  const text = (body == null ? '' : String(body)).trim();
  return { guaranteed: '', sections: text ? [{ text, label: null, path: null }] : [] };
}

function joinBody(parts) {
  return parts.filter(Boolean).join('\n\n');
}

// Cut a fitted slice back to its last line break so a trimmed section never
// ends mid-line (or mid-character run of a list item).
function fitAtLineBoundary(text, budget) {
  const fit = fitToBudget(text, budget);
  if (!fit.truncated) return fit.text;
  const lastBreak = fit.text.lastIndexOf('\n');
  return lastBreak > 0 ? fit.text.slice(0, lastBreak) : fit.text;
}

function cost(text) {
  return { chars: text.length, tokens: estimateTokens(text) };
}

function budgetLeft(budget, used) {
  return {
    maxChars: Math.max(0, budget.maxChars - used.chars),
    maxTokens: Math.max(0, budget.maxTokens - used.tokens),
  };
}

function addCost(used, text) {
  // estimateTokens is subadditive (sum of ceilings >= ceiling of sum), so a
  // running sum never under-counts the concatenated output.
  const next = cost(text);
  return { chars: used.chars + next.chars, tokens: used.tokens + next.tokens };
}

// Markdown headings that start inside the cut tail, so the agent knows which
// named sections (e.g. a standing-rules section at the end of state.md) it
// must open the file to read. keptChars 0 lists every heading (worst case).
function cutHeadings(text, keptChars) {
  return [...text.slice(keptChars).matchAll(/^#{1,4} .+$/gm)].map(match => match[0].trim().slice(0, 80));
}

function trimNotice({ trimmed, omitted, sections, spillPath, totalChars, keptChars, guaranteedTrimmed }) {
  if (sections.every(item => !item.label)) {
    // Unlabeled (plain string) body: historical wording.
    return `[shard output truncated: first ${keptChars} of ${totalChars} chars inline; full section saved to: ${spillPath}]`;
  }
  const parts = [];
  if (guaranteedTrimmed) parts.push('persona section exceeded the shard budget and was cut (fix the instance instruction files)');
  if (trimmed) {
    const headings = cutHeadings(trimmed.text, trimmed.worstCase ? 0 : trimmed.keptChars);
    parts.push(`${trimmed.label || 'section'} kept its first ${trimmed.keptChars} of ${trimmed.text.length} chars; the rest of it was cut from its end${headings.length ? ` (cut headings: ${headings.join(' | ')})` : ''}`);
  }
  if (omitted.length) parts.push(`omitted: ${omitted.map(item => item.label || 'section').join(', ')}`);
  const files = [trimmed, ...omitted].filter(item => item?.path).map(item => item.path);
  if (files.length) parts.push(`read the full text in: ${[...new Set(files)].join(', ')}`);
  parts.push(`full shard copy: ${spillPath}`);
  return `[trimmed to fit the startup budget: ${parts.join('; ')}]`;
}

/**
 * Compose a shard's stdout under its dual budget (chars for Claude's 10K
 * persist threshold, estimated tokens for Codex's elision threshold).
 *
 * Emission order is header, then the guaranteed part, then the trimmable
 * sections in importance order. The guaranteed part is never trimmed by a
 * later section: over budget, sections are kept whole while they fit, the
 * first one that does not fit is cut from its end at a line boundary, and
 * the rest are omitted. A visible marker names what was cut and the files
 * that hold the full text; the whole body is also spilled to `spillPath`.
 */
export function composeShardOutput({ header, body, budget, spillPath }) {
  const { guaranteed, sections } = normalizeShardBody(body);
  const fullBody = joinBody([guaranteed, ...sections.map(item => item.text)]);
  const full = fullBody ? `${header}\n${fullBody}\n` : `${header}\n`;
  if (withinBudget(full, budget)) {
    return { output: full, truncated: false, guaranteedChars: guaranteed.length };
  }

  // Reserve room for the longest marker any trim point could produce, before
  // placing anything (every possible "first section cut" plus "all omitted").
  const noticeFor = (index) => trimNotice({
    trimmed: index < sections.length ? { ...sections[index], keptChars: sections[index].text.length, worstCase: true } : null,
    omitted: sections.slice(index < sections.length ? index + 1 : 0),
    sections,
    spillPath,
    totalChars: fullBody.length,
    keptChars: fullBody.length,
    guaranteedTrimmed: true,
  });
  const notices = Array.from({ length: sections.length + 1 }, (_, index) => cost(noticeFor(index)));
  const reserve = {
    chars: header.length + 3 + Math.max(...notices.map(item => item.chars)),
    tokens: estimateTokens(header) + 1 + Math.max(...notices.map(item => item.tokens)),
  };

  let guaranteedText = guaranteed;
  let guaranteedTrimmed = false;
  if (guaranteed && !withinBudget(guaranteed, budgetLeft(budget, reserve))) {
    guaranteedText = fitAtLineBoundary(guaranteed, budgetLeft(budget, reserve));
    guaranteedTrimmed = true;
  }

  const kept = [];
  const omitted = [];
  let trimmed = null;
  let used = addCost(reserve, guaranteedText);
  for (const item of sections) {
    if (trimmed || omitted.length) {
      omitted.push(item);
      continue;
    }
    const withSeparator = addCost(used, '\n\n');
    if (withinBudget(item.text, budgetLeft(budget, withSeparator))) {
      kept.push(item.text);
      used = addCost(withSeparator, item.text);
      continue;
    }
    const keptText = fitAtLineBoundary(item.text, budgetLeft(budget, withSeparator));
    if (keptText.trim()) {
      kept.push(keptText);
      used = addCost(withSeparator, keptText);
      trimmed = { ...item, keptChars: keptText.length };
    } else {
      omitted.push(item);
    }
  }

  const inlineBody = joinBody([guaranteedText, ...kept]);
  const notice = trimNotice({
    trimmed,
    omitted,
    sections,
    spillPath,
    totalChars: fullBody.length,
    keptChars: inlineBody.length,
    guaranteedTrimmed,
  });
  return {
    output: `${header}\n${inlineBody ? `${inlineBody}\n` : ''}${notice}\n`,
    truncated: true,
    fullBody,
    guaranteedChars: guaranteedText.length,
    guaranteedTrimmed,
    trimmedLabel: trimmed?.label || null,
    omittedLabels: omitted.map(item => item.label || 'section'),
  };
}

async function runShardSideEffect(name, payload, {
  source,
  budgets,
  actions,
  chain,
  sessionId,
  linkMs,
  stdout,
  waitForFlagImpl,
  readFlagStatusImpl,
  requireHealthyContext,
  sequencerOptions = {},
}) {
  if (name === SIDE_EFFECT_NAMES.foreground) {
    await runStep({
      name: 'session-foreground',
      source,
      budgetMs: budgets.foreground,
      action: () => actions.foreground(payload),
    });
    return;
  }

  // start-prompt: the startup prompt must be enqueued only after the
  // injection chain has finished, or the agent starts acting with no memory
  // in context. Wait on the last in-chain shard's flag; fail open past the
  // chain-tail deadline so the prompt is never permanently withheld.
  if (source === 'compact') {
    await logStep({ name: 'session-start-prompt', source, status: 'skipped', durationMs: 0 });
    return;
  }

  let waitExtra = '';
  const tail = chain.at(-1);
  if (tail && sessionId) {
    const wait = await waitForFlagImpl(sessionId, tail.name, {
      deadlineMs: ladderDeadlineMs(chain.length, linkMs),
      ...sequencerOptions,
    });
    waitExtra = `wait=${wait.ok ? 'ok' : 'timeout'}:${wait.waitedMs}`;
  }

  if (requireHealthyContext) {
    const failures = [];
    if (!sessionId) {
      failures.push('session_id: missing');
    } else {
      const tailResult = tail
        ? readFlagStatusImpl(sessionId, tail.name, sequencerOptions)
        : { ok: false, reason: 'missing', roundId: null };
      const roundId = tailResult.roundId || null;
      for (const shard of chain) {
        const result = readFlagStatusImpl(sessionId, shard.name, sequencerOptions);
        if (!result.ok) {
          failures.push(`${shard.name}: ${result.reason}`);
        } else if (!result.roundId) {
          failures.push(`${shard.name}: round missing`);
        } else if (roundId && result.roundId !== roundId) {
          failures.push(`${shard.name}: round mismatch`);
        }
      }
    }
    if (failures.length > 0) {
      const notice = formatSection(
        'STARTUP CONTEXT BLOCKED',
        [
          'Required startup context did not load cleanly.',
          ...failures.map(failure => `- ${failure}`),
          'Do not continue work or answer external messages. Wait for an operator to repair the runtime and start a fresh session.',
        ].join('\n'),
      );
      writeAllSync(stdout.fd ?? 1, `${notice}\n`);
      console.error(`[session-start-orchestrator] startup prompt blocked: ${failures.join(', ')}`);
      await logStep({
        name: 'session-start-prompt',
        source,
        status: 'blocked',
        durationMs: 0,
        extra: `${waitExtra}:context=${failures.join('|')}`,
      });
      return;
    }
  }
  await runStep({
    name: 'session-start-prompt',
    source,
    budgetMs: budgets.startupPrompt,
    extra: waitExtra,
    action: () => actions.startupPrompt(payload),
  });
}

/**
 * `--shard <name>` entry point: emit one content shard (predecessor wait →
 * emit → budgeted stdout → completion flag) or run one side-effect step.
 * Every failure path is fail-open — a shard-mode process must never block
 * session start or exit non-zero.
 */
export async function runSessionStartShard(name, payload = {}, {
  budgets = STEP_BUDGETS_MS,
  emitBudgetMs = SHARD_EMIT_BUDGET_MS,
  stdout = process.stdout,
  zylosDir,
  tmpdir,
  linkMs = tLinkMs(),
  resolveShardImpl = resolveShard,
  waitForFlagImpl = waitForFlag,
  readFlagStatusImpl = readFlagStatus,
  writeFlagImpl = writeFlag,
  requireHealthyContext = startupContextRequired(),
  runtime,
  registerExitFlagImpl = fn => process.once('exit', fn),
  actions = {
    foreground: runForeground,
    startupPrompt: runStartupPrompt,
  },
} = {}) {
  const source = payload?.source || null;
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const sequencerOptions = tmpdir ? { tmpdir } : {};

  try {
    sweepStaleFlags(sequencerOptions);
  } catch { /* best-effort janitor */ }

  const resolved = resolveShardImpl(name, zylosDir ? { zylosDir } : {});
  if (!resolved) {
    console.error(`[session-start-orchestrator] unknown shard "${name}"; emitting nothing (fail-open)`);
    await logStep({ name: `shard-${name}`, source, status: 'unknown-shard', durationMs: 0 });
    return;
  }
  for (const warning of resolved.warnings || []) {
    console.error(`[session-start-orchestrator] shard declaration warning: ${warning}`);
  }

  if (resolved.kind === 'side-effect') {
    await runShardSideEffect(name, payload, {
      source,
      budgets,
      actions,
      chain: resolved.chain,
      sessionId,
      linkMs,
      stdout,
      waitForFlagImpl,
      readFlagStatusImpl,
      requireHealthyContext,
      sequencerOptions,
    });
    return;
  }

  const { shard, chain } = resolved;
  const startMs = Date.now();

  // Serialize: wait for the predecessor's flag with this shard's ladder
  // deadline. No session id means no isolation key, so skip serialization
  // entirely rather than risk cross-session flag poisoning.
  let waitNote = '';
  let waitExtra = 'wait=none';
  let roundId = null;
  const predecessor = shard.chainIndex > 0 ? chain[shard.chainIndex - 1] : null;
  if (predecessor && sessionId) {
    const wait = await waitForFlagImpl(sessionId, predecessor.name, {
      deadlineMs: ladderDeadlineMs(shard.chainIndex, linkMs),
      ...sequencerOptions,
    });
    waitExtra = `wait=${wait.ok ? 'ok' : 'timeout'}:${wait.waitedMs}`;
    if (!wait.ok) waitNote = `predecessor "${predecessor.name}" not ready after ${wait.waitedMs}ms, continued`;
    if (wait.ok) {
      roundId = readFlagStatusImpl(sessionId, predecessor.name, sequencerOptions).roundId || null;
    }
  } else if (!sessionId) {
    console.error(`[session-start-orchestrator] shard "${name}": no session_id in hook payload; emitting without serialization`);
  }
  if (sessionId && !roundId) roundId = randomUUID();

  let body = '';
  let status = 'ok';
  let error = null;
  try {
    const output = await withTimeout(Promise.resolve().then(() => shard.emit(payload)), emitBudgetMs, name);
    // Structured bodies ({ guaranteed, sections }) go to the composer as-is.
    body = output == null ? '' : (typeof output === 'object' ? output : String(output));
  } catch (err) {
    // Keep the failure visible in the injected stream (and keep the [k/N]
    // numbering intact) instead of silently dropping the section.
    error = err;
    status = /timed out/.test(String(err?.message || err)) ? 'timeout' : 'failed';
    body = formatSection(
      `${name.toUpperCase()} UNAVAILABLE`,
      `session-start shard "${name}" ${status === 'timeout' ? 'timed out' : 'failed'}: ${err?.message || err}`,
    );
  }

  const header = shardHeader({
    position: shard.chainIndex + 1,
    total: chain.length,
    name: shard.name,
    waitNote,
  });
  const spillPath = shardSpillPath(sessionId, shard.name, sequencerOptions);
  const activeRuntime = runtime === undefined ? resolveShardRuntime(zylosDir ? { zylosDir } : {}) : runtime;
  const budget = shardBudgetForRuntime(shard.budget, activeRuntime);
  const composed = composeShardOutput({ header, body, budget, spillPath });
  if (composed.truncated) {
    try {
      fs.mkdirSync(path.dirname(spillPath), { recursive: true });
      fs.writeFileSync(spillPath, composed.fullBody);
    } catch (spillError) {
      console.error(`[session-start-orchestrator] shard "${name}": failed to spill full output: ${spillError.message}`);
    }
  }

  writeAllSync(stdout.fd ?? 1, composed.output);

  // The flag is the "injected" signal successors serialize on, and it must
  // mark this PROCESS's completion, not its stdout write: the runtime
  // attaches hook output in process-exit order, and after stdout there is
  // still a tail (diagnostics below, event-loop drain of whatever the
  // emitter imported). An ultra-cheap successor can detect an early flag,
  // emit, and exit inside that tail, deterministically inverting the link
  // (observed: the 3-line custom emitter overtaking identity in every
  // sandbox run). Deferring the flag to the exit hook shrinks the
  // predecessor's post-flag tail to ~0ms, while a successor's post-detect
  // path always includes at least its emitter import + emit + diagnostics.
  // An emitter failure still flags: the failure notice was emitted in this
  // shard's slot, so successors must not burn their ladder deadline waiting
  // for a shard that already spoke.
  if (sessionId) {
    registerExitFlagImpl(() => writeFlagImpl(sessionId, shard.name, {
      ...sequencerOptions,
      roundId,
      status,
    }));
  }

  await logStep({
    name: `shard-${shard.name}`,
    source,
    status,
    durationMs: Date.now() - startMs,
    stdoutBytes: Buffer.byteLength(composed.output),
    extra: [
      waitExtra,
      `runtime=${activeRuntime || 'unknown'}`,
      composed.truncated ? 'truncated=1' : '',
      composed.trimmedLabel ? `trimmed=${composed.trimmedLabel.replace(/\s+/g, '_')}` : '',
      composed.omittedLabels?.length ? `omitted=${composed.omittedLabels.join(',').replace(/\s+/g, '_')}` : '',
      composed.guaranteedTrimmed ? 'persona_cut=1' : '',
    ].filter(Boolean).join(':'),
    error,
  });
}

export function parseShardArg(argv) {
  const index = argv.indexOf('--shard');
  if (index === -1) return null;
  return argv[index + 1] || null;
}

async function main() {
  const hardBackstopTimer = installProcessBackstop();
  const shardName = parseShardArg(process.argv.slice(2));
  const payload = await readStdinPayload();
  try {
    if (shardName) {
      await runSessionStartShard(shardName, payload);
    } else {
      await runSessionStartOrchestrator(payload, {
        totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS,
        hardBackstopTimer,
      });
    }
  } finally {
    clearTimeout(hardBackstopTimer);
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`[session-start-orchestrator] fatal: ${error?.stack || error?.message || error}`);
    process.exitCode = 0;
  });
}
