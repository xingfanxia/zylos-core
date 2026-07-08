#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TEST_ROOTS = [
  path.join(ROOT, 'cli', 'lib', '__tests__'),
  path.join(ROOT, 'cli', 'lib', 'runtime', '__tests__'),
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'comm-bridge', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'web-console', 'scripts', '__tests__'),
  path.join(ROOT, 'skills', 'scheduler', 'scripts', '__tests__'),
];

// ZY-TEST-1 (2026-07-08): the previously-excluded comm-bridge CLI suites are
// fixed and re-enabled. c4-send-cli's broadcast form was a real regression
// (2-arg send unreachable under non-interactive stdin — fixed in c4-send.js);
// c4-fetch-cli / c4-session-init-cli were seeding 'pending' rows via c4-receive
// while those commands surface only 'delivered' history (correct behavior — the
// tests now seed delivered rows). A dup-column migration bug on fresh DBs was
// fixed alongside. Nothing is excluded now.
const COMM_BRIDGE_EXCLUDED_TESTS = new Set([]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isNodeTest(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (rel.startsWith('cli/lib/__tests__/')) return true;
  if (rel.startsWith('cli/lib/runtime/__tests__/')) return true;
  if (rel.startsWith('skills/activity-monitor/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/web-console/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/scheduler/scripts/__tests__/')) return true;
  if (rel.startsWith('skills/comm-bridge/scripts/__tests__/')) {
    return !COMM_BRIDGE_EXCLUDED_TESTS.has(path.basename(file));
  }
  return false;
}

const testFiles = TEST_ROOTS
  .flatMap((dir) => walk(dir))
  .filter(isNodeTest)
  .sort()
  .map((file) => path.relative(ROOT, file));

if (testFiles.length === 0) {
  console.error('No Node test files found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} Node test files`);
const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', ...testFiles], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
