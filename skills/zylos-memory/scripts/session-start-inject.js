#!/usr/bin/env node
/**
 * Session Start Injection
 *
 * Reads core memory files and prints plain text sections for hook injection.
 *
 * Two consumption paths:
 * - emitMemoryPart(part) — per-section shard emitters for the session-start
 *   shard orchestrator, so each memory file gets its own hook stdout budget.
 * - injectMemory() — the legacy single-stdout path (standalone CLI + older
 *   orchestrators), composing every part in one string.
 *
 * Multi-session aware (fork): identity/references resolve from the shared
 * memory tier, state from the per-instance tier.
 *
 * Persona block: an instance's own instruction files (who it is, whom it
 * serves) and its memory write policy are small, operator-owned and must be
 * present on every start. In shard mode they are the GUARANTEED part of the
 * first shard ('identity'), emitted before the shared bot identity, so no
 * later or larger section can push them out of the shard budget. Mutable
 * content (shared identity, active state, the cross-instance digest) is
 * returned as labeled sections that the shard composer trims from the end,
 * least important last section first, with a marker naming the full files.
 */

import { isCliEntry } from '../../multi-session/cli-entry.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { formatSection } from '../../comm-bridge/scripts/session-format.js';
import { describeMemoryWritePolicy } from '../../multi-session/memory-policy.js';
import {
  getInstanceInstructionFiles,
  getInstanceRuntime,
} from '../../multi-session/runtime-files.js';

let diagnosticModule;
let diagnosticLoadAttempted = false;

async function getDiagnosticModule() {
  if (!diagnosticLoadAttempted) {
    diagnosticLoadAttempted = true;
    try {
      diagnosticModule = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    } catch {
      diagnosticModule = null;
    }
  }
  return diagnosticModule;
}

async function logHookTimingSafe(name, durationMs) {
  const module = await getDiagnosticModule();
  if (module?.logHookTiming) {
    module.logHookTiming(name, durationMs);
  }
}

function readFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: 'missing' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: `read error: ${err.message}` };
  }
}

function section(label, filePath) {
  const result = readFileSafe(filePath);
  const content = result.ok ? (result.content || '') : `(${result.reason})`;
  return formatSection(label, content);
}

function inlineSection(label, content) {
  return formatSection(label, content);
}

function getMemoryDir(zylosDir) {
  return path.join(zylosDir, 'memory');
}

function resolveSharedMemoryFile(zylosDir, filename) {
  const memoryDir = getMemoryDir(zylosDir);
  const sharedDir = fs.existsSync(path.join(memoryDir, 'shared'))
    ? path.join(memoryDir, 'shared')
    : memoryDir;
  const sharedPath = path.join(sharedDir, filename);
  if (fs.existsSync(sharedPath)) return sharedPath;
  return path.join(memoryDir, filename);
}

function resolveInstanceMemoryFile(zylosDir, instanceId, filename) {
  return path.join(getMemoryDir(zylosDir), 'instances', instanceId, filename);
}

/**
 * Check if an instance should receive the cross-instance activity digest.
 * User-type instances should NOT see other users' activity to prevent identity confusion.
 * Returns true for admin (primary), scheduler, group, and unknown/single-session mode.
 */
function _isDigestEligible(instanceId, zylosDir) {
  if (!instanceId) return true; // single-session mode
  try {
    const instancesFile = path.join(zylosDir, 'instances.json');
    const config = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
    const inst = config?.instances?.[instanceId];
    if (!inst) return true; // unknown instance, allow by default
    return inst.primary === true ||
           inst.type === 'group' ||
           config.scheduler_instance === instanceId;
  } catch {
    return true; // can't read config, allow by default
  }
}

function defaultZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

/**
 * The persona block: per-instance instruction files (identity and scope)
 * followed by the memory write policy. Empty in single-session mode. Shared
 * by the legacy full-context path and the 'identity' shard.
 */
function personaParts({ zylosDir, instanceId, runtime = null }) {
  if (!instanceId) return [];
  const parts = [];
  const activeRuntime = runtime || getInstanceRuntime({ zylosDir, instanceId });
  for (const entry of getInstanceInstructionFiles({ zylosDir, instanceId, runtime: activeRuntime })) {
    const result = readFileSafe(entry.path);
    if (result.ok && result.content && result.content.trim().length > 0) {
      parts.push(inlineSection(entry.label, result.content));
    }
  }
  parts.push(inlineSection(
    'MEMORY WRITE POLICY',
    describeMemoryWritePolicy({ instanceId, instancesFilePath: path.join(zylosDir, 'instances.json') })
  ));
  return parts;
}

/**
 * Cross-instance digest, only for admin/scheduler/group (user instances don't
 * need other users' activity, and cross-user references can cause identity
 * confusion). Returns a labeled section or null.
 */
function digestSection({ zylosDir, instanceId }) {
  if (!_isDigestEligible(instanceId, zylosDir)) return null;
  const digestPath = resolveSharedMemoryFile(zylosDir, 'recent-activity.md');
  const digestResult = readFileSafe(digestPath);
  if (!digestResult.ok || !digestResult.content.trim()) return null;
  return {
    label: 'CROSS-INSTANCE CONTEXT',
    text: inlineSection('CROSS-INSTANCE CONTEXT', digestResult.content),
    path: digestPath,
  };
}

function fileSection(label, filePath) {
  return { label, text: section(label, filePath), path: filePath };
}

function stateFilePath(zylosDir, instanceId) {
  return instanceId
    ? resolveInstanceMemoryFile(zylosDir, instanceId, 'state.md')
    : path.join(getMemoryDir(zylosDir), 'state.md');
}

export const MEMORY_PARTS = Object.freeze({
  identity: Object.freeze({ label: 'BOT IDENTITY', file: 'identity.md' }),
  state: Object.freeze({ label: 'ACTIVE STATE', file: 'state.md' }),
  references: Object.freeze({ label: 'REFERENCES', file: 'references.md' }),
});

/**
 * Emit a single memory shard body. Used by the session-start shard
 * orchestrator so each memory file gets its own hook stdout budget.
 *
 * 'identity' and 'state' return the structured shard body understood by
 * composeShardOutput: `{ guaranteed, sections }`. `guaranteed` (the persona
 * block, identity shard only) is never trimmed; `sections` are in importance
 * order and are trimmed from the last one backwards, each carrying the path
 * of the file that holds its full text. 'references' stays a plain string.
 */
export function emitMemoryPart(part, _payload = null, {
  zylosDir = defaultZylosDir(),
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  runtime = null,
} = {}) {
  const spec = MEMORY_PARTS[part];
  if (!spec) throw new Error(`unknown memory part "${part}"`);

  if (part === 'references') {
    return section(spec.label, resolveSharedMemoryFile(zylosDir, spec.file));
  }
  if (part === 'identity') {
    return {
      guaranteed: personaParts({ zylosDir, instanceId, runtime }).join('\n\n'),
      sections: [fileSection(spec.label, resolveSharedMemoryFile(zylosDir, spec.file))],
    };
  }
  return {
    guaranteed: '',
    sections: [
      fileSection(spec.label, stateFilePath(zylosDir, instanceId)),
      digestSection({ zylosDir, instanceId }),
    ].filter(Boolean),
  };
}

export function getStartupMemoryContextParts({
  zylosDir = defaultZylosDir(),
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  runtime = null,
} = {}) {
  // Persona block first: this legacy single-stdout block is persisted by
  // Claude Code above 10,000 chars with only a ~2KB inline preview, so
  // whatever comes first is all that is reliably seen.
  return [
    ...personaParts({ zylosDir, instanceId, runtime }),
    section('BOT IDENTITY', resolveSharedMemoryFile(zylosDir, 'identity.md')),
    section('ACTIVE STATE', stateFilePath(zylosDir, instanceId)),
    section('REFERENCES', resolveSharedMemoryFile(zylosDir, 'references.md')),
    digestSection({ zylosDir, instanceId })?.text,
  ].filter(Boolean);
}

/**
 * Assemble the session-start memory context. Returns a string terminated by a
 * trailing newline. Invoked by the SessionStart orchestrator (writeStdout step)
 * and by the standalone CLI below.
 */
export function injectMemory() {
  const parts = getStartupMemoryContextParts();
  return `${parts.join('\n\n')}\n`;
}

async function runCli() {
  const startMs = Date.now();
  try {
    process.stdout.write(injectMemory());
  } catch (err) {
    console.error(`session-start-inject error: ${err.message}`);
  } finally {
    await logHookTimingSafe('session-start-inject', Date.now() - startMs);
  }
}

if (isCliEntry(import.meta.url)) {
  runCli().catch(() => {
    // Best-effort.
  });
}
