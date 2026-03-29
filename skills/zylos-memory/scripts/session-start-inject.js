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
import { MEMORY_DIR, resolveSharedFile, resolveInstanceFile } from './shared.js';

const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

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

/**
 * Resolve the per-instance CLAUDE.md override path.
 *
 * Resolution order:
 * 1. `claude_md` field in instances.json (absolute or ~/zylos-relative path)
 * 2. Convention path: ~/zylos/instances/<id>/CLAUDE.md
 *
 * Returns null if no override exists.
 */
function resolveInstanceClaudeMd(instanceId) {
  if (!instanceId) return null;

  // 1. Check instances.json for explicit claude_md path
  try {
    const config = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    const inst = config?.instances?.[instanceId];
    if (inst?.claude_md) {
      const resolved = inst.claude_md.replace(/^~/, os.homedir());
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // instances.json missing or malformed — fall through to convention
  }

  // 2. Convention path: ~/zylos/instances/<id>/CLAUDE.md
  const conventionPath = path.join(ZYLOS_DIR, 'instances', instanceId, 'CLAUDE.md');
  if (fs.existsSync(conventionPath)) return conventionPath;

  return null;
}

function main() {
  const parts = [
    section('BOT IDENTITY', resolveSharedFile('identity.md')),
    section('ACTIVE STATE', resolveInstanceFile(INSTANCE_ID, 'state.md')),
    section('REFERENCES', resolveSharedFile('references.md'))
  ];

  // Inject per-instance CLAUDE.md override (Phase 2 feature)
  const instanceClaudeMd = resolveInstanceClaudeMd(INSTANCE_ID);
  if (instanceClaudeMd) {
    parts.push(section('INSTANCE INSTRUCTIONS', instanceClaudeMd));
  }

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

// Exported for testing
export { resolveInstanceClaudeMd };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // Best-effort.
  });
}
