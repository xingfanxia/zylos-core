import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.UPDATE_PROVIDER_USAGE_DISABLE_MAIN = '1';

const {
  normalizeProviderPayload,
} = await import('../update-provider-usage.js');

describe('normalizeProviderPayload', () => {
  it('normalizes successful Claude/CodexBar CLI usage output', () => {
    const payload = [{
      provider: 'claude',
      source: 'claude',
      version: '2.1.89',
      usage: {
        identity: { accountEmail: 'test@example.com' },
        primary: { usedPercent: 8, windowMinutes: 300, resetDescription: 'Apr 1, 11am', resetsAt: '2026-04-01T11:00:00Z' },
        secondary: { usedPercent: 99, windowMinutes: 10080, resetDescription: 'Apr 3, 3am', resetsAt: '2026-04-03T03:00:00Z' },
        tertiary: { usedPercent: 6, windowMinutes: 10080, resetDescription: 'Apr 6, 6am', resetsAt: '2026-04-06T06:00:00Z' },
      },
    }];

    const normalized = normalizeProviderPayload('claude', payload, '2026-04-01T07:29:03Z');
    assert.equal(normalized.available, true);
    assert.equal(normalized.primary.used_percent, 8);
    assert.equal(normalized.primary.left_percent, 92);
    assert.equal(normalized.secondary.used_percent, 99);
    assert.equal(normalized.tertiary.used_percent, 6);
    assert.equal(normalized.account_email, 'test@example.com');
  });

  it('normalizes provider errors', () => {
    const normalized = normalizeProviderPayload('codex', [{
      provider: 'codex',
      source: 'cli',
      error: { message: 'not available' },
    }], '2026-04-01T07:29:03Z');

    assert.equal(normalized.available, false);
    assert.equal(normalized.error, 'not available');
    assert.equal(normalized.primary, null);
  });
});
