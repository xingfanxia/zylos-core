/**
 * Operator alert for user messages that were never delivered because their
 * content could not be built (the dispatcher's CONTENT_ERROR: today a long
 * message whose spill file could not be handed to its recipient). The
 * dispatcher marks such a row `delivery_action = content-error:<code>` and,
 * after its bounded retry, `failed` (c4-dispatcher.js handleContentFailure).
 *
 * The primary instance's monitor runs this as an interval task. It sends one
 * health alert per batch of new failed ids to the admin chat, through the same
 * direct send as the degraded and start-held alerts, and records the highest
 * notified id only after that send succeeded; a failed send is retried at the
 * next interval. Nothing is requeued here: recovery is the maintainer's.
 */
import fs from 'fs';
import path from 'path';

export const CONTENT_ERROR_ALERT_FILE = 'content-error-alert.json';

export function formatContentErrorAlert(rows) {
  const lines = rows.map((r) => {
    const who = String(r.target_instance || 'unrouted').replace(/^user-/, '');
    const code = String(r.delivery_action || '').replace(/^content-error:/, '');
    return `- #${r.id} ${who}：${code}（${r.timestamp} UTC）`;
  });
  return [
    `🔴 ${rows.length} 条用户消息没有送达：长消息附件无法交给收件人，已标记为失败，不会自动重试`,
    ...lines,
    '修复原因后按 SAFE-1 R1 逐条重新投递。',
  ].join('\n');
}

/**
 * @param {{ monitorDir: string, list: (afterId: number) => object[],
 *   send: (message: string) => Promise<{ ok: boolean, output?: string }>,
 *   log: (msg: string) => void }} deps
 */
export function createContentErrorAlert({ monitorDir, list, send, log }) {
  const stateFile = path.join(monitorDir, CONTENT_ERROR_ALERT_FILE);
  let lastRunAt = 0;
  let inFlight = null;

  const readLastId = () => {
    try { return Number(JSON.parse(fs.readFileSync(stateFile, 'utf8')).last_id) || 0; }
    catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
  };
  const writeLastId = (id) => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ last_id: id, notified_at: new Date().toISOString() }));
    fs.renameSync(tmp, stateFile);
  };

  async function runOnce() {
    const rows = list(readLastId());
    if (!rows.length) return;
    const result = await send(formatContentErrorAlert(rows));
    if (!result?.ok) {
      log(`Content-error alert for id(s) ${rows.map((r) => r.id).join(',')} not sent: ${result?.output || 'no result'}; retrying next interval`);
      return;
    }
    writeLastId(rows[rows.length - 1].id);
    log(`Content-error alert sent for id(s) ${rows.map((r) => r.id).join(',')}`);
  }

  return {
    getLastRunAt: () => lastRunAt,
    /** Task-scheduler entry point: starts one check, never overlaps, never throws. */
    run(snapshot) {
      lastRunAt = snapshot?.currentTime ?? Math.floor(Date.now() / 1000);
      if (inFlight) return true;
      inFlight = runOnce()
        .catch((err) => log(`Content-error alert failed: ${err.message}`))
        .finally(() => { inFlight = null; });
      return true;
    },
    /** For tests: the current check, if any. */
    settled: () => inFlight || Promise.resolve(),
  };
}
