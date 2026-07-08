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
import {
  isPrimaryInstance as isPrimaryInstancePolicy,
  isSchedulerInstance as isSchedulerInstancePolicy,
  isGroupInstance as isGroupInstancePolicy,
  validateMemoryWrite as validateMemoryWritePolicy,
} from '../../multi-session/memory-policy.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');

/**
 * Check whether the current instance is the scheduler instance.
 * The scheduler instance is allowed to write to shared/ for cross-instance
 * knowledge sync (shared-knowledge-sync task).
 *
 * @returns {boolean}
 */
export function isSchedulerInstance() {
  return isSchedulerInstancePolicy({
    instanceId: INSTANCE_ID,
    instancesFilePath: INSTANCES_FILE,
  });
}

/**
 * Check whether the current instance is the primary instance.
 * Returns true in legacy mode (no INSTANCE_ID set) or when instances.json
 * marks this instance as primary. Fails open if config cannot be read.
 *
 * @returns {boolean}
 */
export function isPrimary() {
  return isPrimaryInstancePolicy({
    instanceId: INSTANCE_ID,
    instancesFilePath: INSTANCES_FILE,
  });
}

/**
 * Check whether the current instance is the group instance (type:'group').
 * The group instance owns the memory/groups/** tier.
 *
 * @returns {boolean}
 */
export function isGroupInstance() {
  return isGroupInstancePolicy({
    instanceId: INSTANCE_ID,
    instancesFilePath: INSTANCES_FILE,
  });
}

/**
 * Validate whether a write to `filePath` is allowed for the current instance.
 *
 * @param {string} filePath - The target file path (absolute or relative)
 * @returns {string|null} A rejection reason string if blocked, or null if allowed
 */
export function validateMemoryWrite(filePath) {
  return validateMemoryWritePolicy(filePath, {
    zylosDir: ZYLOS_DIR,
    memoryDir: MEMORY_DIR,
    instanceId: INSTANCE_ID,
    instancesFilePath: INSTANCES_FILE,
    existsSync: fs.existsSync,
    realpathSync: fs.realpathSync,
    readFileSync: fs.readFileSync,
  });
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
// realpathSync handles symlinked invocation (e.g. ~/zylos -> /home/x_computelabs_ai/zylos).
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMainModule) {
  main();
}
