#!/usr/bin/env node
/**
 * Consolidation report for memory health.
 *
 * Scans ~/zylos/memory for sizes, ages, and budget compliance.
 * Outputs JSON report.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MEMORY_DIR, SESSIONS_DIR, BUDGETS, REFERENCE_FILES, walkFiles, loadTimezoneFromEnv, dateInTimeZone, resolveSharedFile, resolveInstanceFile, resolveSessionsDir, resolveReferenceFiles } from './shared.js';

const INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID || null;
const EFFECTIVE_SESSIONS_DIR = resolveSessionsDir(INSTANCE_ID);

export function parseSessionDate(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.md$/);
  return match ? match[1] : null;
}

function sessionArchiveCandidates(tz) {
  const candidates = [];

  if (!fs.existsSync(EFFECTIVE_SESSIONS_DIR)) {
    return candidates;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoffStr = dateInTimeZone(cutoffDate, tz);

  for (const fileName of fs.readdirSync(EFFECTIVE_SESSIONS_DIR)) {
    if (fileName === 'current.md' || fileName.startsWith('.')) {
      continue;
    }

    const sessionDate = parseSessionDate(fileName);
    if (!sessionDate) {
      continue;
    }

    if (sessionDate < cutoffStr) {
      candidates.push(fileName);
    }
  }

  candidates.sort();
  return candidates;
}

// Per-instance files use resolveInstanceFile; shared files use resolveSharedFile
const INSTANCE_BUDGET_FILES = new Set(['state.md']);

function coreBudgetChecks() {
  const checks = [];

  for (const [name, budget] of Object.entries(BUDGETS)) {
    const filePath = INSTANCE_BUDGET_FILES.has(name)
      ? resolveInstanceFile(INSTANCE_ID, name)
      : resolveSharedFile(name);
    if (!fs.existsSync(filePath)) {
      checks.push({ file: name, exists: false, budgetBytes: budget, overBudget: false });
      continue;
    }

    const stat = fs.statSync(filePath);
    checks.push({
      file: name,
      exists: true,
      sizeBytes: stat.size,
      budgetBytes: budget,
      overBudget: stat.size > budget,
      budgetUsagePct: Math.round((stat.size / budget) * 100),
      modifiedAt: stat.mtime.toISOString()
    });
  }

  return checks;
}

export function freshnessState(ageDays) {
  if (ageDays < 7) return 'active';
  if (ageDays < 30) return 'aging';
  if (ageDays <= 90) return 'fading';
  return 'stale';
}

function referenceFileFreshness() {
  const results = [];
  const resolvedPaths = resolveReferenceFiles();

  for (let i = 0; i < REFERENCE_FILES.length; i++) {
    const relPath = REFERENCE_FILES[i];
    const filePath = resolvedPaths[i];
    if (!fs.existsSync(filePath)) {
      results.push({ file: relPath, exists: false });
      continue;
    }

    const stat = fs.statSync(filePath);
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
    results.push({
      file: relPath,
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      ageDays,
      freshness: freshnessState(ageDays)
    });
  }

  return results;
}

function topLargest(files, count = 10) {
  return [...files]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, count);
}

function main() {
  const tz = loadTimezoneFromEnv();
  const files = walkFiles(MEMORY_DIR);
  const budgetChecks = coreBudgetChecks();
  const overBudget = budgetChecks.filter((item) => item.overBudget).map((item) => item.file);

  const report = {
    timestamp: new Date().toISOString(),
    memoryDir: MEMORY_DIR,
    totals: {
      files: files.length,
      sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0)
    },
    budgets: {
      rules: BUDGETS,
      checks: budgetChecks,
      overBudget
    },
    referenceFiles: referenceFileFreshness(),
    sessions: {
      archiveCandidatesOlderThan30Days: sessionArchiveCandidates(tz)
    },
    oldestFiles: [...files].sort((a, b) => b.ageDays - a.ageDays).slice(0, 10),
    largestFiles: topLargest(files)
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
