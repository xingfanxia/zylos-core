#!/usr/bin/env node
/**
 * Startup context report: what one instance receives at session start.
 *
 * Renders every SessionStart shard exactly as the shard hooks would (same
 * emitters, same budgets, same composer) and prints, in emission order, each
 * labeled section with its size in characters and estimated tokens, whether
 * it is guaranteed (never trimmed), and how much of it is inline. It also
 * reports whether settings.json still runs the legacy no-argument
 * orchestrator (a second copy of the memory block) and how many hook
 * commands per event are duplicate spellings of one script, and the state
 * of the persona's standing rules file (present, bytes, within its bound,
 * delivered in the guaranteed block) without printing its content.
 *
 * Read-only: it reads memory/instruction files and settings.json, writes
 * nothing, and skips the C4 shards unless --with-c4 is given (they open the
 * conversation database).
 *
 * Usage:
 *   node startup-context-report.js --instance-dir <zylos>/instances/<id> [--json] [--with-c4]
 *   node startup-context-report.js --zylos-dir <zylos> --instance <id> [--json] [--with-c4]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECTION_RE = /^=== (?!END )(.+?) ===$/gm;
const C4_SHARDS = new Set(['c4-checkpoint', 'c4-conversations']);
// Claude Code persists hook stdout above this many chars and keeps only a
// short preview inline.
const CLAUDE_PERSIST_CHARS = 10_000;

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

export function parseReportArgs(argv) {
  const instanceDir = argValue(argv, '--instance-dir');
  let zylosDir = argValue(argv, '--zylos-dir');
  let instanceId = argValue(argv, '--instance');
  if (instanceDir) {
    const resolved = path.resolve(instanceDir);
    instanceId = instanceId || path.basename(resolved);
    zylosDir = zylosDir || path.dirname(path.dirname(resolved));
  }
  return {
    zylosDir: zylosDir ? path.resolve(zylosDir) : null,
    instanceId,
    json: argv.includes('--json'),
    withC4: argv.includes('--with-c4'),
    codeRoot: argValue(argv, '--code-root'),
  };
}

/**
 * Split a rendered block into its `=== LABEL === ... === END LABEL ===`
 * sections (anything outside a labeled section is reported as "(unlabeled)").
 */
export function splitLabeled(text) {
  const out = [];
  const source = String(text || '');
  const starts = [...source.matchAll(SECTION_RE)];
  if (starts.length === 0) return source.trim() ? [{ label: '(unlabeled)', text: source.trim() }] : [];
  for (const match of starts) {
    const label = match[1];
    const end = `=== END ${label} ===`;
    const endIndex = source.indexOf(end, match.index);
    const stop = endIndex === -1 ? source.length : endIndex + end.length;
    out.push({ label, text: source.slice(match.index, stop) });
  }
  return out;
}

function inlineStatus(sectionText, label, output) {
  if (output.includes(sectionText)) return { status: 'full', inlineChars: sectionText.length };
  const start = output.indexOf(`=== ${label} ===`);
  if (start === -1) return { status: 'cut', inlineChars: 0 };
  // Inline part runs to the trim marker (current or historical wording).
  const markers = ['\n[trimmed to fit the startup budget:', '\n[shard output truncated:']
    .map(marker => output.indexOf(marker, start))
    .filter(index => index !== -1);
  const markerIndex = markers.length ? Math.min(...markers) : -1;
  const inline = output.slice(start, markerIndex === -1 ? output.length : markerIndex);
  return { status: 'trimmed', inlineChars: inline.length };
}

function legacyOrchestratorRegistered(settings) {
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  const startup = groups.find(group => (group?.matcher ?? '') === 'startup') || groups[0];
  return (startup?.hooks || []).some(hook => /session-start-orchestrator\.js(?:["']|\s*$)/.test(String(hook?.command || '').trim())
    && !/--shard\b/.test(String(hook.command)));
}

function scriptIdentity(command) {
  const text = String(command || '');
  const script = text.match(/([^\s"']+\.(?:[cm]?js|sh|py))/)?.[1] || text;
  const shard = text.match(/--shard\s+(\S+)/)?.[1];
  return `${path.basename(script)}${shard ? `#${shard}` : ''}`;
}

export function hookDuplication(settings) {
  const rows = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = (group?.hooks || []).filter(hook => hook?.type === 'command');
      const unique = new Set(hooks.map(hook => scriptIdentity(hook.command)));
      rows.push({ event, matcher: group?.matcher ?? '', commands: hooks.length, unique: unique.size });
    }
  }
  return rows;
}

/**
 * Size-only facts about the standing rules file and whether shard 1
 * delivered it in its guaranteed block. Never returns the file's text.
 */
export function standingRulesFacts({ rulesPath, maxChars, rows }) {
  let stat = null;
  try {
    stat = fs.statSync(rulesPath);
  } catch { /* absent */ }
  if (!stat) return { path: rulesPath, present: false, maxChars };
  let chars = null;
  try {
    chars = fs.readFileSync(rulesPath, 'utf8').trim().length;
  } catch { /* unreadable: size only */ }
  const row = rows.find(item => item.section === 'STANDING RULES');
  return {
    path: rulesPath,
    present: true,
    bytes: stat.size,
    chars,
    maxChars,
    withinBound: chars == null ? null : chars <= maxChars,
    delivered: row ? `${row.guaranteed ? 'guaranteed' : 'not guaranteed'}, shard ${row.position}, ${row.status}` : 'not delivered',
  };
}

export async function buildStartupReport({ zylosDir, instanceId, withC4 = false, codeRoot = null }) {
  if (!zylosDir || !instanceId) throw new Error('need --instance-dir, or --zylos-dir and --instance');
  process.env.ZYLOS_DIR = zylosDir;
  process.env.ZYLOS_INSTANCE_ID = instanceId;
  const root = codeRoot
    ? pathToFileURL(`${path.resolve(codeRoot)}/`).href
    : new URL('../../', import.meta.url).href;
  const registry = await import(new URL('activity-monitor/scripts/shard-registry.js', root).href);
  const orchestrator = await import(new URL('activity-monitor/scripts/session-start-orchestrator.js', root).href);
  const memory = await import(new URL('zylos-memory/scripts/session-start-inject.js', root).href);
  const policy = await import(new URL('multi-session/memory-policy.js', root).href);
  const { chain } = registry.buildChain({ zylosDir });
  // Same budget selection as the shard hook (older renderers: dual budget).
  const runtime = orchestrator.resolveShardRuntime ? orchestrator.resolveShardRuntime({ zylosDir, instanceId }) : null;
  const budgetFor = shard => (orchestrator.shardBudgetForRuntime
    ? orchestrator.shardBudgetForRuntime(shard.budget, runtime)
    : shard.budget);

  const rows = [];
  const shards = [];
  for (const shard of chain) {
    const position = `${shard.chainIndex + 1}/${chain.length}`;
    if (C4_SHARDS.has(shard.name) && !withC4) {
      shards.push({ position, shard: shard.name, measured: false });
      continue;
    }
    const body = await shard.emit({ source: 'startup' });
    const header = orchestrator.shardHeader({ position: shard.chainIndex + 1, total: chain.length, name: shard.name });
    const composed = orchestrator.composeShardOutput({ header, body, budget: budgetFor(shard), spillPath: '(spill file)' });
    const structured = orchestrator.normalizeShardBody
      ? orchestrator.normalizeShardBody(body)
      : { guaranteed: '', sections: [{ text: String(body ?? '').trim() }] };
    const parts = [
      ...splitLabeled(structured.guaranteed).map(item => ({ ...item, guaranteed: true })),
      ...structured.sections.flatMap(item => splitLabeled(item.text)).map(item => ({ ...item, guaranteed: false })),
    ];
    for (const part of parts) {
      rows.push({
        position,
        shard: shard.name,
        section: part.label,
        chars: part.text.length,
        tokens: registry.estimateTokens(part.text),
        guaranteed: part.guaranteed,
        ...inlineStatus(part.text, part.label, composed.output),
      });
    }
    shards.push({
      position,
      shard: shard.name,
      measured: true,
      outputChars: composed.output.length,
      outputTokens: registry.estimateTokens(composed.output),
      truncated: composed.truncated,
      budget: budgetFor(shard),
    });
  }

  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8'));
  } catch { /* report without settings */ }
  const legacy = { registered: legacyOrchestratorRegistered(settings) };
  if (legacy.registered) {
    const text = memory.injectMemory();
    legacy.memoryChars = text.length;
    legacy.memoryTokens = registry.estimateTokens(text);
    legacy.persistedByClaude = text.length > CLAUDE_PERSIST_CHARS;
  }
  const rules = memory.standingRulesPath
    ? standingRulesFacts({ rulesPath: memory.standingRulesPath(zylosDir, instanceId), maxChars: policy.STANDING_RULES_MAX_CHARS, rows })
    : null;
  return { zylosDir, instanceId, runtime, rows, shards, legacy, rules, hooks: settings ? hookDuplication(settings) : [] };
}

export function formatReport(report) {
  const lines = [`Startup context for instance '${report.instanceId}' (${report.zylosDir}), runtime ${report.runtime || 'unknown (dual budget)'}`, ''];
  lines.push('shard | section | chars | ~tokens | guaranteed | inline');
  lines.push('---|---|---|---|---|---');
  for (const shard of report.shards) {
    const sectionRows = report.rows.filter(row => row.shard === shard.shard);
    if (!shard.measured) {
      lines.push(`${shard.position} ${shard.shard} | (not measured: reads the C4 database; --with-c4) | | | |`);
      continue;
    }
    for (const row of sectionRows) {
      const inline = row.status === 'trimmed' ? `trimmed (${row.inlineChars} chars inline)` : row.status;
      lines.push(`${row.position} ${row.shard} | ${row.section} | ${row.chars} | ${row.tokens} | ${row.guaranteed ? 'yes' : 'no'} | ${inline}`);
    }
    lines.push(`${shard.position} ${shard.shard} | = shard output | ${shard.outputChars} | ${shard.outputTokens} | | ${shard.truncated ? 'over budget, trimmed' : 'within budget'} (cap ${shard.budget.maxChars} chars${Number.isFinite(shard.budget.maxTokens) ? ` / ${shard.budget.maxTokens} tokens` : ', no token cap'})`);
  }
  lines.push('');
  const rules = report.rules;
  if (!rules) {
    lines.push('Standing rules file: not supported by this renderer.');
  } else if (!rules.present) {
    lines.push(`Standing rules file: absent (${rules.path}).`);
  } else {
    const bound = rules.withinBound == null
      ? 'unreadable'
      : `${rules.chars} chars, ${rules.withinBound ? 'within' : 'OVER'} the ${rules.maxChars}-char bound`;
    lines.push(`Standing rules file: present (${rules.path}), ${rules.bytes} bytes, ${bound}; delivered: ${rules.delivered}.`);
  }
  if (report.legacy.registered) {
    lines.push(`Legacy no-argument orchestrator: REGISTERED - injects a second memory block of ${report.legacy.memoryChars} chars / ~${report.legacy.memoryTokens} tokens${report.legacy.persistedByClaude ? ' (over 10,000 chars: Claude Code persists it to a file and keeps a short preview inline)' : ''}, plus a second C4 block.`);
  } else {
    lines.push('Legacy no-argument orchestrator: not registered (each block is injected once).');
  }
  const dup = report.hooks.filter(row => row.commands !== row.unique);
  if (report.hooks.length) {
    lines.push(dup.length
      ? `Duplicate hook spellings: ${dup.map(row => `${row.event}[${row.matcher}] ${row.commands} commands / ${row.unique} scripts`).join('; ')}`
      : 'Duplicate hook spellings: none (one command per script per event).');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseReportArgs(process.argv.slice(2));
  const report = await buildStartupReport(args);
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`startup-context-report: ${error.message}`);
    process.exitCode = 1;
  });
}
