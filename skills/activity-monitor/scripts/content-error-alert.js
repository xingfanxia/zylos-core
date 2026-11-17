/**
 * Operator alert for user messages that were never delivered because their
 * content could not be built (the dispatcher's CONTENT_ERROR: today a long
 * message whose spill file could not be handed to its recipient). When such a
 * failure is the one that ends a row `failed`, the dispatcher tags it
 * `delivery_action = content-error:<code>` in the same statement
 * (c4-dispatcher.js handleContentFailure, c4-db.js markFailed).
 *
 * The primary instance's monitor runs this as an interval task. It sends one
 * health alert per batch of not-yet-notified rows to the admin chat, through
 * the same direct send as the degraded and start-held alerts. Only after that
 * send succeeded is each row marked notified in the database
 * (content-error-notified:<code>), so a restart neither repeats nor loses one,
 * and a row with a lower id that fails later is still found (no id cursor).
 * A failed send is retried at the next interval. Nothing is requeued here:
 * recovery is the maintainer's.
 */
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
 * @param {{ list: () => object[], markNotified: (id: number) => boolean,
 *   send: (message: string) => Promise<{ ok: boolean, output?: string }>,
 *   log: (msg: string) => void }} deps
 */
export function createContentErrorAlert({ list, markNotified, send, log }) {
  let lastRunAt = 0;
  let inFlight = null;

  async function runOnce() {
    const rows = list();
    if (!rows.length) return;
    const ids = rows.map((r) => r.id).join(',');
    const result = await send(formatContentErrorAlert(rows));
    if (!result?.ok) {
      log(`Content-error alert for id(s) ${ids} not sent: ${result?.output || 'no result'}; retrying next interval`);
      return;
    }
    for (const r of rows) markNotified(r.id);
    log(`Content-error alert sent for id(s) ${ids}`);
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
