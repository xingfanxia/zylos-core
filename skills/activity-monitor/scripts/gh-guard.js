#!/usr/bin/env node
/**
 * gh Guard — PreToolUse hook that blocks `gh` CLI use in non-primary instances.
 *
 * The host machine's `gh` CLI is authenticated to the user's personal GitHub
 * account. Only the primary (admin) instance is allowed to use it; all other
 * Zylos instances must NOT act under the user's GitHub identity.
 *
 * Rules:
 *   - ZYLOS_INSTANCE_ID unset                         -> allow (user's own CLI)
 *   - ZYLOS_INSTANCE_ID = primary instance (admin)    -> allow
 *   - ZYLOS_INSTANCE_ID = anything else               -> block any Bash
 *                                                       command that invokes
 *                                                       `gh` as a command word
 *   - instances.json unreadable while ID is set       -> block (fail closed)
 *
 * Detection covers:
 *   gh, /usr/bin/gh, cmd | gh, cmd && gh, $(gh ...), `gh ...`,
 *   env GITHUB_TOKEN=... gh, multi-line shell separators.
 *
 * Hook protocol: reads JSON from stdin, outputs JSON to stdout when blocking.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const INSTANCES_FILE = path.join(ZYLOS_DIR, 'instances.json');
const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;

// Match `gh` (or a path-prefixed `gh`) as a standalone command word.
// Allows an optional env-prefix (e.g. `env GH_TOKEN=x gh ...`).
const GH_COMMAND = /(?:^|[\s;&|`(\n]|\$\()(?:env\s+\S+=\S*\s+)*(?:[a-zA-Z0-9_./-]+\/)?gh(?=$|[\s;&|`)\n])/;

export function commandUsesGh(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  return GH_COMMAND.test(cmd);
}

export function isAdminInstance({
  instanceId = INSTANCE_ID,
  instancesFilePath = INSTANCES_FILE,
} = {}) {
  // No instance id -> user's own CLI session, not a Zylos sub-agent.
  if (!instanceId) return true;
  try {
    const raw = fs.readFileSync(instancesFilePath, 'utf8');
    const config = JSON.parse(raw);
    return config?.instances?.[instanceId]?.primary === true;
  } catch {
    // Fail closed inside Zylos: if we can't verify, deny.
    return false;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return; // malformed event -> fail open
  }

  if (event.tool_name !== 'Bash') return;

  const cmd = event.tool_input?.command;
  if (!commandUsesGh(cmd)) return;

  if (isAdminInstance()) return;

  const reason =
    `gh CLI is restricted to the primary (admin) Zylos instance. ` +
    `This instance (${INSTANCE_ID ?? 'unknown'}) cannot use the user's ` +
    `GitHub credentials. Use a public unauthenticated path or ask the ` +
    `admin to handle the GitHub action.`;

  console.log(JSON.stringify({ decision: 'block', reason }));
}

function _isMainModule() {
  if (!process.argv[1]) return false;
  const here = fileURLToPath(import.meta.url);
  if (process.argv[1] === here) return true;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(here);
  } catch {
    return false;
  }
}
if (_isMainModule()) main();
