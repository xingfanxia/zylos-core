import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_SUMMARY_LENGTH = 500;
const KEEP_RECORDS = 30;
const RECORD_NAME = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Daily commit of the shared memory repository. Every instance's monitor has
 * this task, and one of them does the work: whichever reaches the hour first
 * creates that day's record `<recordDir>/<date>.json` (exclusive create), runs
 * zylos-memory's daily-commit.js and writes the outcome into the record. The
 * others find the record and neither run nor log anything. One try a day, also
 * when it fails: what makes a commit fail does not go away within the hour.
 * The last 30 records are kept.
 */
export function createDailyMemoryCommit({ recordDir, script, instanceId, getLocalDate, log }) {
  let attemptedDate = null;
  const recordFile = date => path.join(recordDir, `${date}.json`);

  function loadState() {
    const today = getLocalDate();
    if (attemptedDate === today || fs.existsSync(recordFile(today))) return { last_date: today };
    return null;
  }

  function prune() {
    const old = fs.readdirSync(recordDir).filter(name => RECORD_NAME.test(name)).sort().slice(0, -KEEP_RECORDS);
    for (const name of old) fs.rmSync(path.join(recordDir, name), { force: true });
  }

  /** @returns {boolean|null} null when another monitor owns today's commit. */
  function execute() {
    const date = getLocalDate();
    attemptedDate = date;
    const file = recordFile(date);
    const record = { date, instance: instanceId ?? null, status: 'running', started_at: new Date().toISOString() };
    try {
      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      log(`Daily memory commit: cannot create ${file} (${err.message}), next attempt tomorrow`);
      return false;
    }

    let ok = true;
    let summary;
    try {
      summary = execFileSync('node', [script], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    } catch (err) {
      ok = false;
      summary = err?.stderr?.toString?.().trim() || err.message;
    }
    log(ok ? `Daily memory commit: ${summary}` : `Daily memory commit failed: ${summary}`);

    try {
      fs.writeFileSync(file, `${JSON.stringify({
        ...record,
        status: ok ? 'ok' : 'failed',
        summary: summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH)}…` : summary,
        finished_at: new Date().toISOString()
      }, null, 2)}\n`);
      prune();
    } catch (err) {
      log(`Daily memory commit: failed to write ${file} (${err.message})`);
    }
    return ok;
  }

  return { loadState, execute };
}
