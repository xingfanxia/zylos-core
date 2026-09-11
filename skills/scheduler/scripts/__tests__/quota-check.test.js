/**
 * ZY-UX-1 — quota-check runQuotaCheck (REAL import, injected IO + notifier).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runQuotaCheck } from '../quota-check.js';

describe('runQuotaCheck', () => {
  const tokenCache = { instances: { 'user-a': { daily: 7_000_000 }, 'user-b': { daily: 100 } } };
  const instancesConfig = {
    instances: {
      'user-a': { quota_tokens_daily: 5_000_000 }, // breach
      'user-b': { quota_tokens_daily: 5_000_000 }, // ok
    },
  };

  it('returns breaches and fires the notifier when a quota is exceeded', () => {
    const seen = [];
    const breaches = runQuotaCheck({ tokenCache, instancesConfig, notify: (b) => seen.push(b) });
    assert.deepEqual(breaches, [{ instance: 'user-a', used: 7_000_000, quota: 5_000_000 }]);
    assert.equal(seen.length, 1);
  });

  it('does not fire the notifier when there are no breaches', () => {
    let fired = false;
    const breaches = runQuotaCheck({
      tokenCache: { instances: { 'user-b': { daily: 1 } } },
      instancesConfig,
      notify: () => { fired = true; },
    });
    assert.equal(breaches.length, 0);
    assert.equal(fired, false);
  });
});
