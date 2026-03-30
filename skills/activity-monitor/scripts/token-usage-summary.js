#!/usr/bin/env node

/**
 * Token Usage Summary — generates a markdown report of token usage
 * from the token-tracker SQLite database.
 *
 * Usage:
 *   node token-usage-summary.js [--days N] [--output <path>]
 *
 *   --days N         Number of days to include in the report (default: 7)
 *   --output <path>  Write report to file instead of stdout
 *
 * Reads the same DB as token-tracker.js:
 *   ~/zylos/activity-monitor/token-usage.db
 *
 * Designed to be run as a scheduled task. Exits cleanly with code 0
 * on success, 1 on failure.
 *
 * ESM module.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DB_PATH = path.join(ZYLOS_DIR, 'activity-monitor', 'token-usage.db');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { days: 7, output: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isNaN(n) || n < 1) {
        console.error(`Invalid --days value: ${args[i + 1]}`);
        process.exit(1);
      }
      opts.days = n;
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.output = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node token-usage-summary.js [--days N] [--output <path>]');
      console.log('  --days N         Number of days to report (default: 7)');
      console.log('  --output <path>  Write report to file instead of stdout');
      process.exit(0);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Resolve better-sqlite3 (same strategy as token-tracker.js)
// ---------------------------------------------------------------------------

function loadDatabase() {
  const candidates = [
    path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge'),
    path.join(ZYLOS_DIR, '.claude', 'skills', 'scheduler'),
    path.join(__dirname, '..', '..', 'comm-bridge'),
    path.join(__dirname, '..', '..', 'scheduler'),
  ];

  for (const base of candidates) {
    try {
      const require = createRequire(path.join(base, 'package.json'));
      return require('better-sqlite3');
    } catch {
      // Try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

function fmt(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('en-US');
}

function fmtUsd(n) {
  if (n == null) return '$0.00';
  return '$' + Number(n).toFixed(2);
}

// ---------------------------------------------------------------------------
// Markdown table helpers
// ---------------------------------------------------------------------------

function mdRow(cells) {
  return '| ' + cells.join(' | ') + ' |';
}

function mdSep(count) {
  return '|' + Array(count).fill('---').map(s => ` ${s} `).join('|') + '|';
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function queryPerInstancePeriod(db, days) {
  return db.prepare(`
    SELECT
      instance_id,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM token_usage
    WHERE date > date('now', ? || ' days')
    GROUP BY instance_id
    ORDER BY instance_id
  `).all(`-${days}`);
}

function queryDailyBreakdown(db, days) {
  return db.prepare(`
    SELECT
      date,
      instance_id,
      COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
        COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(cache_write_tokens), 0) AS total_tokens
    FROM token_usage
    WHERE date > date('now', ? || ' days')
    GROUP BY date, instance_id
    ORDER BY date DESC, instance_id
  `).all(`-${days}`);
}

function queryMonthlyPerInstance(db) {
  return db.prepare(`
    SELECT
      instance_id,
      COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) +
        COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(cache_write_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM token_usage
    WHERE date > date('now', '-30 days')
    GROUP BY instance_id
    ORDER BY instance_id
  `).all();
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(db, days) {
  const today = new Date().toISOString().substring(0, 10);
  const lines = [];

  lines.push(`# Token Usage Report — ${today}`);
  lines.push('');

  // ----- Weekly / N-day Summary -----
  const periodLabel = days === 7 ? 'Weekly Summary (last 7 days)' : `Summary (last ${days} days)`;
  lines.push(`## ${periodLabel}`);
  lines.push('');

  const perInstance = queryPerInstancePeriod(db, days);

  if (perInstance.length === 0) {
    lines.push('_No token usage data found for this period._');
    lines.push('');
  } else {
    const headers = ['Instance', 'Input Tokens', 'Output Tokens', 'Cache Read', 'Cache Write', 'Total', 'Cost'];
    lines.push(mdRow(headers));
    lines.push(mdSep(headers.length));

    let totInput = 0, totOutput = 0, totCacheRead = 0, totCacheWrite = 0, totCost = 0;

    for (const row of perInstance) {
      const total = row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
      totInput += row.input_tokens;
      totOutput += row.output_tokens;
      totCacheRead += row.cache_read_tokens;
      totCacheWrite += row.cache_write_tokens;
      totCost += row.cost_usd;

      lines.push(mdRow([
        row.instance_id,
        fmt(row.input_tokens),
        fmt(row.output_tokens),
        fmt(row.cache_read_tokens),
        fmt(row.cache_write_tokens),
        fmt(total),
        fmtUsd(row.cost_usd),
      ]));
    }

    const grandTotal = totInput + totOutput + totCacheRead + totCacheWrite;
    lines.push(mdRow([
      '**Total**',
      `**${fmt(totInput)}**`,
      `**${fmt(totOutput)}**`,
      `**${fmt(totCacheRead)}**`,
      `**${fmt(totCacheWrite)}**`,
      `**${fmt(grandTotal)}**`,
      `**${fmtUsd(totCost)}**`,
    ]));
    lines.push('');
  }

  // ----- Daily Breakdown -----
  lines.push(`## Daily Breakdown (last ${days} days)`);
  lines.push('');

  const dailyRows = queryDailyBreakdown(db, days);

  if (dailyRows.length === 0) {
    lines.push('_No daily data found._');
    lines.push('');
  } else {
    // Pivot: rows = dates, columns = instances
    const instances = [...new Set(perInstance.map(r => r.instance_id))].sort();
    const dateMap = new Map();

    for (const row of dailyRows) {
      if (!dateMap.has(row.date)) dateMap.set(row.date, {});
      dateMap.get(row.date)[row.instance_id] = row.total_tokens;
    }

    const dateHeaders = ['Date', ...instances, 'Total'];
    lines.push(mdRow(dateHeaders));
    lines.push(mdSep(dateHeaders.length));

    for (const [date, instanceData] of dateMap) {
      let dayTotal = 0;
      const cells = [date];
      for (const inst of instances) {
        const val = instanceData[inst] || 0;
        dayTotal += val;
        cells.push(fmt(val));
      }
      cells.push(fmt(dayTotal));
      lines.push(mdRow(cells));
    }
    lines.push('');
  }

  // ----- Monthly Summary (always last 30 days) -----
  lines.push('## Monthly Summary (last 30 days)');
  lines.push('');

  const monthlyRows = queryMonthlyPerInstance(db);

  if (monthlyRows.length === 0) {
    lines.push('_No monthly data found._');
    lines.push('');
  } else {
    const monthHeaders = ['Instance', 'Total Tokens', 'Cost'];
    lines.push(mdRow(monthHeaders));
    lines.push(mdSep(monthHeaders.length));

    let monthTotalTokens = 0, monthTotalCost = 0;

    for (const row of monthlyRows) {
      monthTotalTokens += row.total_tokens;
      monthTotalCost += row.cost_usd;
      lines.push(mdRow([
        row.instance_id,
        fmt(row.total_tokens),
        fmtUsd(row.cost_usd),
      ]));
    }

    lines.push(mdRow([
      '**Total**',
      `**${fmt(monthTotalTokens)}**`,
      `**${fmtUsd(monthTotalCost)}**`,
    ]));
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);

  // Verify DB exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[token-usage-summary] Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  // Load better-sqlite3
  const Database = loadDatabase();
  if (!Database) {
    console.error('[token-usage-summary] better-sqlite3 not found — cannot generate report');
    process.exit(1);
  }

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  } catch (err) {
    console.error(`[token-usage-summary] Failed to open database: ${err.message}`);
    process.exit(1);
  }

  try {
    const report = generateReport(db, opts.days);

    if (opts.output) {
      const outDir = path.dirname(opts.output);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`Report written to ${opts.output}`);
    } else {
      console.log(report);
    }
  } catch (err) {
    console.error(`[token-usage-summary] Failed to generate report: ${err.message}`);
    process.exit(1);
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

main();
