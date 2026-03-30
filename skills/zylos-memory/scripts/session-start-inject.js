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

function main() {
  const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

  const parts = [
    section('BOT IDENTITY', resolveSharedFile('identity.md')),
    section('ACTIVE STATE', INSTANCE_ID
      ? resolveInstanceFile(INSTANCE_ID, 'state.md')
      : path.join(MEMORY_DIR, 'state.md')),
    section('REFERENCES', resolveSharedFile('references.md'))
  ];

  // Shared context digest (cross-instance awareness)
  const digestPath = resolveSharedFile('recent-activity.md');
  const digestResult = readFileSafe(digestPath);
  if (digestResult.ok && digestResult.content.trim()) {
    parts.push(section('CROSS-INSTANCE CONTEXT', digestPath));
  }

  // Per-instance CLAUDE.md injection (multi-session)
  if (INSTANCE_ID) {
    const instanceClaudeMd = path.join(
      process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
      'instances', INSTANCE_ID, 'CLAUDE.md'
    );
    const result = readFileSafe(instanceClaudeMd);
    if (result.ok && result.content && result.content.trim().length > 0) {
      parts.push(`=== INSTANCE INSTRUCTIONS ===\n${result.content.trim()}`);
    }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // Best-effort.
  });
}
