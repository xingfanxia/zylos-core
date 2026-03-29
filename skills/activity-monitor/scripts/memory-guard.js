#!/usr/bin/env node
/**
 * Memory Guard -- PreToolUse hook that enforces per-instance memory isolation.
 *
 * Blocks writes to memory paths that don't belong to the current instance.
 * Registered as a PreToolUse hook for Write and Edit tools.
 *
 * Rules:
 * - Primary instance: can write to shared/ and its own instances/<id>/
 * - Non-primary instance: can only write to its own instances/<id>/ and users/<uid>/profile.md
 * - No instance can write to another instance's instances/<other-id>/ directory
 *
 * Hook protocol: reads JSON from stdin, outputs JSON to stdout.
 * Output { "decision": "block", "reason": "..." } to block, or empty/no output to allow.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

/**
 * Check whether the current instance is the primary instance.
 * Returns true in legacy mode (no INSTANCE_ID set) or when instances.json
 * marks this instance as primary. Fails open if config cannot be read.
 *
 * @returns {boolean}
 */
export function isPrimary() {
  if (!INSTANCE_ID) return true; // legacy mode = primary
  try {
    const config = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    return config.instances?.[INSTANCE_ID]?.primary === true;
  } catch {
    return true; // fail-open: if can't read config, assume primary
  }
}

/**
 * Validate whether a write to `filePath` is allowed for the current instance.
 *
 * @param {string} filePath - The target file path (absolute or relative)
 * @returns {string|null} A rejection reason string if blocked, or null if allowed
 */
export function validateMemoryWrite(filePath) {
  // Resolve to absolute path
  const absPath = path.resolve(filePath);

  // Only guard writes to the memory directory
  if (!absPath.startsWith(MEMORY_DIR + path.sep) && absPath !== MEMORY_DIR) {
    return null; // not a memory write -- allow
  }

  const relPath = path.relative(MEMORY_DIR, absPath);
  const segments = relPath.split(path.sep);

  // Check: writing to instances/<id>/
  if (segments[0] === 'instances' && segments.length >= 2) {
    const targetInstanceId = segments[1];
    if (targetInstanceId !== INSTANCE_ID && INSTANCE_ID) {
      return `Cannot write to instance '${targetInstanceId}' memory from instance '${INSTANCE_ID}'`;
    }
    return null; // writing to own instance dir -- allow
  }

  // Check: writing to shared/
  if (segments[0] === 'shared') {
    if (!isPrimary()) {
      return `Non-primary instance '${INSTANCE_ID}' cannot write to shared memory`;
    }
    return null; // primary can write to shared
  }

  // Check: writing to users/ -- allow for user profile writes
  if (segments[0] === 'users') {
    return null; // any instance can write user profiles
  }

  // Check: writing to archive/ -- allow
  if (segments[0] === 'archive') {
    return null;
  }

  // Legacy flat files (identity.md, state.md, etc at top level)
  // In legacy mode (no INSTANCE_ID), allow everything
  if (!INSTANCE_ID) return null;

  // In multi-session mode, top-level files should go through shared/ or instances/
  // But symlinks exist for backward compat, so allow writes to symlinked files
  try {
    const realPath = fs.realpathSync(absPath);
    // If the real path resolves to shared/, re-validate
    if (realPath.startsWith(path.join(MEMORY_DIR, 'shared') + path.sep)) {
      if (!isPrimary()) {
        return `Non-primary instance '${INSTANCE_ID}' cannot write to shared memory (via symlink)`;
      }
      return null;
    }
    // If the real path resolves to instances/, re-validate
    if (realPath.startsWith(path.join(MEMORY_DIR, 'instances') + path.sep)) {
      const realRel = path.relative(path.join(MEMORY_DIR, 'instances'), realPath);
      const realInstanceId = realRel.split(path.sep)[0];
      if (realInstanceId !== INSTANCE_ID) {
        return `Cannot write to instance '${realInstanceId}' memory from instance '${INSTANCE_ID}' (via symlink)`;
      }
      return null;
    }
  } catch {
    // File doesn't exist yet (new file creation) -- check path heuristically
  }

  return null; // default: allow
}

/**
 * Main hook entry point. Reads JSON from stdin, validates the write,
 * and outputs a block decision to stdout if unauthorized.
 */
async function main() {
  // Read hook event from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const event = JSON.parse(input);
    const toolName = event.tool_name || '';

    // Only guard Write and Edit tools
    if (toolName !== 'Write' && toolName !== 'Edit') {
      return; // allow -- empty output means proceed
    }

    // Extract file path from tool input
    const filePath = event.tool_input?.file_path;
    if (!filePath) return; // no file path -- allow

    const rejection = validateMemoryWrite(filePath);
    if (rejection) {
      console.log(JSON.stringify({ decision: 'block', reason: rejection }));
    }
    // else: empty output = allow
  } catch {
    // Parse error -- fail-open, allow the write
  }
}

// Only run main() when executed directly (not when imported for testing)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
