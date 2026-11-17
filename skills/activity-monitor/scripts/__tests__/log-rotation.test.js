// activity.log rotation (log-rotation.js) in a temporary directory: the daily
// move to activity.log.<previous day>, no second move after a restart the same
// day, and deletion of rotated logs older than 30 days or beyond the size cap.
// Run for changes to the activity log's rotation; skip otherwise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { rotateDailyLog } from '../log-rotation.js';

const DAY = 86400_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotation-'));
const log = path.join(root, 'activity.log');
const now = Date.parse('2026-11-17T00:00:01Z');
const options = { keepDays: 30, keepBytes: 1000, nowMs: now };
const files = () => fs.readdirSync(root).sort();

function rotated(day, size, ageDays) {
  const file = `${log}.${day}`;
  fs.writeFileSync(file, 'x'.repeat(size));
  const at = new Date(now - ageDays * DAY);
  fs.utimesSync(file, at, at);
}

after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => { for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name)); });

describe('rotateDailyLog', () => {
  it('moves the log to the previous day and keeps a later restart from moving it again', () => {
    fs.writeFileSync(log, '[2026-11-16 03:00:00] line\n');
    rotateDailyLog(log, '2026-11-17', options);
    assert.deepEqual(files(), ['activity.log.2026-11-16']);

    fs.writeFileSync(log, '[2026-11-17 05:00:00] after a restart\n');
    rotateDailyLog(log, '2026-11-17', options);
    assert.deepEqual(files(), ['activity.log', 'activity.log.2026-11-16']);
    assert.equal(fs.readFileSync(log, 'utf8'), '[2026-11-17 05:00:00] after a restart\n');
  });

  it('crosses a month boundary', () => {
    fs.writeFileSync(log, 'x\n');
    rotateDailyLog(log, '2026-12-01', options);
    assert.deepEqual(files(), ['activity.log.2026-11-30']);
  });

  it('deletes rotated logs older than 30 days and the oldest beyond the size cap', () => {
    rotated('2026-10-10', 10, 38);
    rotated('2026-10-20', 400, 28);
    rotated('2026-10-21', 400, 27);
    rotated('2026-11-15', 400, 2);
    fs.writeFileSync(log, 'x'.repeat(100));
    rotateDailyLog(log, '2026-11-17', options);
    // Newest first: 11-16 (100) + 11-15 (400) + 10-21 (400) = 900 <= 1000; 10-20 would pass the cap; 10-10 is too old.
    assert.deepEqual(files(), ['activity.log.2026-10-21', 'activity.log.2026-11-15', 'activity.log.2026-11-16']);
  });
});
