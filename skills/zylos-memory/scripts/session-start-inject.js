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
 * memory tier, state from the per-instance tier; instances additionally get
 * the cross-instance digest (eligibility-gated), the memory write policy, and
 * per-instance instruction files — in shard mode these ride with the 'state'
 * part so no fork context is lost.
 */

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
 * The per-instance tail: cross-instance digest (eligibility-gated), memory
 * write policy, and per-instance instruction files. Shared by the legacy
 * full-context path and the 'state' shard so both carry identical fork context.
 */
function instanceTailParts({ zylosDir, instanceId, runtime = null }) {
  const parts = [];

  // Shared context digest (cross-instance awareness)
  // Only inject for admin/scheduler/group — user instances don't need other users' activity,
  // and the cross-user references can cause identity confusion.
  if (_isDigestEligible(instanceId, zylosDir)) {
    const digestPath = resolveSharedMemoryFile(zylosDir, 'recent-activity.md');
    const digestResult = readFileSafe(digestPath);
    if (digestResult.ok && digestResult.content.trim()) {
      parts.push(section('CROSS-INSTANCE CONTEXT', digestPath));
    }
  }

  if (instanceId) {
    parts.push(inlineSection(
      'MEMORY WRITE POLICY',
      describeMemoryWritePolicy({ instanceId, instancesFilePath: path.join(zylosDir, 'instances.json') })
    ));

    const activeRuntime = runtime || getInstanceRuntime({ zylosDir, instanceId });
    for (const entry of getInstanceInstructionFiles({ zylosDir, instanceId, runtime: activeRuntime })) {
      const result = readFileSafe(entry.path);
      if (result.ok && result.content && result.content.trim().length > 0) {
        parts.push(inlineSection(entry.label, result.content));
      }
    }
  }

  return parts;
}

export const MEMORY_PARTS = Object.freeze({
  identity: Object.freeze({ label: 'BOT IDENTITY', file: 'identity.md' }),
  state: Object.freeze({ label: 'ACTIVE STATE', file: 'state.md' }),
  references: Object.freeze({ label: 'REFERENCES', file: 'references.md' }),
});

/**
 * Emit a single memory section. Used by the session-start shard orchestrator
 * so each memory file gets its own hook stdout budget instead of sharing one.
 * Instance-aware: identity/references come from the shared tier, state from
 * the per-instance tier — and the state shard carries the per-instance tail
 * (digest / write policy / instruction files) so shard mode loses nothing.
 */
export function emitMemoryPart(part, _payload = null) {
  const spec = MEMORY_PARTS[part];
  if (!spec) throw new Error(`unknown memory part "${part}"`);
  const zylosDir = defaultZylosDir();
  const instanceId = process.env.ZYLOS_INSTANCE_ID || null;

  if (part === 'identity' || part === 'references') {
    return section(spec.label, resolveSharedMemoryFile(zylosDir, spec.file));
  }

  const stateSection = section(spec.label, instanceId
    ? resolveInstanceMemoryFile(zylosDir, instanceId, spec.file)
    : path.join(getMemoryDir(zylosDir), spec.file));
  return [stateSection, ...instanceTailParts({ zylosDir, instanceId })].join('\n\n');
}

export function getStartupMemoryContextParts({
  zylosDir = defaultZylosDir(),
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  runtime = null,
} = {}) {
  const parts = [
    section('BOT IDENTITY', resolveSharedMemoryFile(zylosDir, 'identity.md')),
    section('ACTIVE STATE', instanceId
      ? resolveInstanceMemoryFile(zylosDir, instanceId, 'state.md')
      : path.join(getMemoryDir(zylosDir), 'state.md')),
    section('REFERENCES', resolveSharedMemoryFile(zylosDir, 'references.md')),
    ...instanceTailParts({ zylosDir, instanceId, runtime }),
  ];

  return parts;
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  runCli().catch(() => {
    // Best-effort.
  });
}
