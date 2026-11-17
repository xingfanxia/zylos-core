import fs from 'node:fs';
import path from 'node:path';

/**
 * Daily rotation of a log file: `<log>` moves to `<log>.<the day before today>`
 * unless that file exists already (a restart later the same day). Rotated logs
 * older than keepDays, and the oldest beyond keepBytes together, are deleted.
 * @param {string} logFile
 * @param {string} today UTC date, YYYY-MM-DD
 */
export function rotateDailyLog(logFile, today, { keepDays, keepBytes, nowMs = Date.now() }) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().substring(0, 10);
  const rotated = `${logFile}.${yesterday}`;
  if (fs.existsSync(logFile) && !fs.existsSync(rotated)) fs.renameSync(logFile, rotated);

  const dir = path.dirname(logFile);
  const prefix = `${path.basename(logFile)}.`;
  const logs = fs.readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .map(name => ({ file: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const oldest = nowMs - keepDays * 86400_000;
  let bytes = 0;
  for (const { file, stat } of logs) {
    bytes += stat.size;
    if (stat.mtimeMs < oldest || bytes > keepBytes) fs.rmSync(file, { force: true });
  }
}
