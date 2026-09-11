/** Durable progress watermarks per account and real quota window. A few seconds
 * of reset-time drift are not a new billing/usage cycle. */
const WINDOW_FIELDS = [
  ['weekly', 'weekly', 'weeklyAllResetsAt'],
  ['fiveHour', 'fiveHour', 'fiveHourResetsAt'],
];
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function planUsageMilestones(previous, reading, currentTime) {
  const old = record(previous?.milestones);
  const accounts = { ...record(old.accounts) };
  const account = /^[a-f0-9]{64}$/.test(reading?.accountKey || '') ? reading.accountKey : 'codex:unknown';
  const current = { ...record(accounts[account]) };
  const changed = [];
  const nowMs = currentTime * 1000;
  // Upgrade the existing already-notified state without sending the same high
  // percentage again. New installations still report their first reached band.
  const migrate = !previous?.milestones && Boolean(previous?.lastAlertedAt || previous?.lastNotifiedAt);
  for (const [name, percentField, resetField] of WINDOW_FIELDS) {
    const percent = reading?.[percentField], reset = Date.parse(reading?.[resetField] || '');
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isFinite(reset) || reset <= nowMs) continue;
    const before = record(current[name]);
    const oldReset = Number(before.resetAt);
    const validBefore = Number.isFinite(oldReset) && Number.isInteger(before.bucket) && before.bucket >= 0 && before.bucket <= 100;
    // Re-arm only after the previous cycle reaches its end AND the provider
    // supplies a genuinely later window. Keep the original anchor during jitter.
    const same = validBefore && (Math.abs(reset - oldReset) <= 300_000 || nowMs < oldReset - 30_000);
    const bucket = Math.floor(percent / 10) * 10;
    const notified = same ? before.bucket : migrate ? bucket : 0;
    if (bucket >= 10 && bucket > notified) changed.push(name);
    current[name] = { resetAt: same ? oldReset : reset, bucket: Math.max(notified, bucket) };
  }
  current.checkedAt = currentTime;
  accounts[account] = current;
  const keep = Object.entries(accounts).sort(([, a], [, b]) => (b?.checkedAt || 0) - (a?.checkedAt || 0)).slice(0, 12);
  return { changed, ledger: { version: 1, accounts: Object.fromEntries(keep) }, account };
}
