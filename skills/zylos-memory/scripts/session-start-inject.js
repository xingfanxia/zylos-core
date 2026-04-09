#!/usr/bin/env node
/**
 * Session Start Injection
 *
 * Reads core memory files and prints plain text sections for hook injection.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { describeMemoryWritePolicy } from '../../multi-session/memory-policy.js';
import {
  getInstanceInstructionFiles,
  getInstanceRuntime,
} from '../../multi-session/runtime-files.js';

const startMs = Date.now();
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
  const lines = [`=== ${label} ===`];

  if (result.ok) {
    const text = (result.content || '').trim();
    lines.push(text.length > 0 ? text : '(empty)');
  } else {
    lines.push(`(${result.reason})`);
  }

  return lines.join('\n');
}

function inlineSection(label, content) {
  return `=== ${label} ===\n${(content || '').trim()}`;
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

export function getStartupMemoryContextParts({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  runtime = null,
} = {}) {
  const activeRuntime = runtime || getInstanceRuntime({ zylosDir, instanceId });
  const parts = [
    section('BOT IDENTITY', resolveSharedMemoryFile(zylosDir, 'identity.md')),
    section('ACTIVE STATE', instanceId
      ? resolveInstanceMemoryFile(zylosDir, instanceId, 'state.md')
      : path.join(getMemoryDir(zylosDir), 'state.md')),
    section('REFERENCES', resolveSharedMemoryFile(zylosDir, 'references.md'))
  ];

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

    for (const entry of getInstanceInstructionFiles({ zylosDir, instanceId, runtime: activeRuntime })) {
      const result = readFileSafe(entry.path);
      if (result.ok && result.content && result.content.trim().length > 0) {
        parts.push(inlineSection(entry.label, result.content));
      }
    }
  }

  return parts;
}

function main() {
  const parts = getStartupMemoryContextParts();
  process.stdout.write(`${parts.join('\n\n')}\n`);
}

async function runCli() {
  try {
    main();
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
