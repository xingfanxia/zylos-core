#!/usr/bin/env node
/**
 * ZY-UX-1 — daily notify-only token-quota check.
 *
 * Compares each instance's today token usage (activity-monitor/token-cache.json)
 * against its `quota_tokens_daily` (instances.json) and, on any breach, drops a
 * priority control notification to the admin instance. NO throttling in v1 —
 * this only surfaces the breach. Run daily via a scheduler task.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { checkQuotaBreaches } from '../../comm-bridge/scripts/onboarding-messages.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Run the quota check. IO + notifier injectable for tests.
 * @returns {Array<{instance,used,quota}>} the breaches found
 */
export function runQuotaCheck({
  tokenCache = readJson(path.join(ZYLOS_DIR, 'activity-monitor', 'token-cache.json')) || {},
  instancesConfig = readJson(path.join(ZYLOS_DIR, 'instances.json')) || {},
  notify = null,
} = {}) {
  const breaches = checkQuotaBreaches(tokenCache, instancesConfig.instances || {});
  if (breaches.length > 0 && typeof notify === 'function') notify(breaches);
  return breaches;
}

function formatBreaches(breaches) {
  return [
    '⚠️ Daily token quota breach:',
    ...breaches.map(b => `  ${b.instance}: ${b.used.toLocaleString()} / ${b.quota.toLocaleString()} tokens today`),
    '',
    '(notify-only — no throttling applied)',
  ].join('\n');
}

async function main() {
  let insertControl, close;
  try {
    ({ insertControl, close } = await import('../../comm-bridge/scripts/c4-db.js'));
  } catch (err) {
    console.error(`quota-check: cannot load c4-db (${err.message})`);
    return;
  }
  const breaches = runQuotaCheck({
    notify: (b) => {
      try {
        insertControl(formatBreaches(b), { priority: 2, appendAckSuffix: false, targetInstance: 'admin' });
      } catch (err) {
        console.error(`quota-check: notify failed (${err.message})`);
      }
    },
  });
  console.log(`quota-check: ${breaches.length} breach(es)${breaches.length ? ' → admin notified' : ''}`);
  try { close(); } catch { /* ignore */ }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
