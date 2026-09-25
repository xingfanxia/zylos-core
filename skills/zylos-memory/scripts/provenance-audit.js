#!/usr/bin/env node
/**
 * Provenance audit — anti-confabulation guard for memory writes.
 *
 * Diffs durable memory files against the last git snapshot (the nested
 * memory/.git repo that daily-commit.js maintains) and flags newly-added
 * "high-risk" facts — clock times, money amounts, appointments/deadlines with
 * dates — that lack a provenance marker (`[src: ...]`) or an uncertainty
 * marker (`(unverified ...)`).
 *
 * Why this exists: a Memory Dream cycle once wrote a fabricated dental
 * appointment ("Dr. Wong, 2026-06-25, 3:20 PM") complete with a fake
 * "Confirmed via email" citation. Prose citations can be hallucinated; a
 * git-diff cannot. Every flag below is a fact a write-cycle introduced
 * without a checkable source — tag it, mark it unverified, or delete it.
 *
 * Advisory by design: always exits 0. The calling cycle (Sync/Dream) is
 * responsible for acting on the report before committing. Read the contract
 * in SKILL.md → "Provenance & Anti-Confabulation".
 *
 * Usage: node provenance-audit.js [--json]
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MEMORY_DIR } from './shared.js';

// Durable files only. Session logs (sessions/) and archive/ are ephemeral
// event logs full of legitimate times — auditing them would be pure noise.
// Confabulations that cause harm live in the always-loaded / on-demand
// durable surfaces.
const SCOPE = ['identity.md', 'state.md', 'references.md', 'users', 'reference'];

// A line is high-risk if it asserts a concrete, checkable datum.
const RISK_PATTERNS = [
  { kind: 'clock-time', re: /\b\d{1,2}:\d{2}\s?(?:[AaPp][Mm])\b/ },
  { kind: 'money', re: /\$\s?\d[\d,]*(?:\.\d+)?\b/ },
  {
    kind: 'appointment/deadline+date',
    re: /(?:appointment|appt|meeting|预约|牙医|dental|dentist|deadline|due\b|到期|expir|RSVP|flight|reservation|预订)/i,
    requireDate: true
  }
];
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

// Presence of any marker exempts the line — it is the agent declaring a source
// or explicitly flagging uncertainty, which is exactly the behavior we want.
const PROVENANCE_RE = /\[src:|\(src:|\(source:|\[源[:：]|unverified|未核实|待核实|\(basis:|needs human review/i;

function git(args) {
  return execFileSync('git', args, {
    cwd: MEMORY_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function inScope(file) {
  return SCOPE.some((s) => file === s || file.startsWith(s + '/'));
}

function isRisky(line) {
  for (const p of RISK_PATTERNS) {
    if (!p.re.test(line)) continue;
    if (p.requireDate && !DATE_RE.test(line)) continue;
    return p.kind;
  }
  return null;
}

/** Added lines (modified/new tracked files) from `git diff HEAD`. */
function addedFromDiff() {
  let diff;
  try {
    diff = git(['diff', 'HEAD', '--unified=0', '--', ...SCOPE]);
  } catch {
    // No HEAD yet (fresh repo) — nothing to diff against.
    return [];
  }
  const out = [];
  let file = null;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (file && inScope(file)) out.push({ file, text: raw.slice(1) });
    }
  }
  return out;
}

/** Every non-blank line of untracked (brand-new) in-scope files. */
function addedFromUntracked() {
  let listing = '';
  try {
    listing = git(['ls-files', '--others', '--exclude-standard', '--', ...SCOPE]);
  } catch {
    return [];
  }
  const out = [];
  for (const file of listing.split('\n').filter(Boolean)) {
    if (!inScope(file)) continue;
    const abs = path.join(MEMORY_DIR, file);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const text of content.split('\n')) {
      if (text.trim()) out.push({ file, text });
    }
  }
  return out;
}

function main() {
  const asJson = process.argv.includes('--json');
  const added = [...addedFromDiff(), ...addedFromUntracked()];

  const flags = [];
  for (const { file, text } of added) {
    const trimmed = text.trim();
    // Skip structural lines: markdown headers and table separators carry no
    // standalone fact (a date in a "## Countdown (2026-06-20)" heading is not
    // a confabulation risk).
    if (trimmed.startsWith('#') || /^\|?[\s:|-]+\|?$/.test(trimmed)) continue;
    if (PROVENANCE_RE.test(text)) continue; // sourced or explicitly uncertain
    const kind = isRisky(text);
    if (kind) flags.push({ file, kind, line: trimmed.slice(0, 240) });
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ flagged: flags.length, flags }, null, 2) + '\n');
    return;
  }

  if (flags.length === 0) {
    console.log('✓ provenance-audit: no unsourced high-risk facts in new memory edits.');
    return;
  }

  console.log(`⚠ provenance-audit: ${flags.length} new high-risk fact(s) WITHOUT a source.`);
  console.log('  Each one needs a [src: ...] tag, an (unverified — basis: ...) marker, or deletion.\n');
  for (const f of flags) {
    console.log(`  [${f.kind}] ${f.file}`);
    console.log(`     ${f.line}\n`);
  }
  console.log('Resolve all flags before the daily-commit snapshot. See SKILL.md → Provenance & Anti-Confabulation.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
