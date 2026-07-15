import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.UPDATE_PROVIDER_USAGE_DISABLE_MAIN = '1';

const {
  fetchCodexNativeUsage,
  fetchClaudeNativeUsage,
  normalizeProviderPayload,
  normalizeNativeClaudeUsage,
  runProviderUsageOnce,
} = await import('../update-provider-usage.js');

describe('fetchCodexNativeUsage', () => {
  it('publishes a weekly-only Codex subscription window from the selected profile rollout', () => {
    const result = fetchCodexNativeUsage({
      codexHome: '/home/persona/.codex-subscription',
      now: '2026-07-14T23:08:31.672Z',
      readImpl: ({ codexHome, instanceId }) => {
        assert.equal(codexHome, '/home/persona/.codex-subscription');
        assert.equal(instanceId, null);
        return {
          fiveHourPercent: null,
          fiveHourResetsAt: null,
          weeklyAllPercent: 8,
          weeklyAllResetsAt: 1784666236,
          weeklyAllResets: '21 Jul, 21:57',
        };
      },
    });

    assert.equal(result.available, true);
    assert.equal(result.source, 'zylos-native-rollout');
    assert.equal(result.primary, null);
    assert.equal(result.secondary.used_percent, 8);
    assert.equal(result.secondary.left_percent, 92);
    assert.equal(result.secondary.window_minutes, 10080);
  });
});

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

describe('normalizeNativeClaudeUsage', () => {
  it('normalizes zylos native Claude /usage probe output', () => {
    const normalized = normalizeNativeClaudeUsage({
      session: 1,
      weeklyAll: 99,
      weeklySonnet: 6,
      sessionResets: '3pm (UTC)',
      weeklyAllResets: 'Apr 3, 3am (UTC)',
      weeklySonnetResets: 'Apr 6, 6am (UTC)',
    }, '2026-04-01T13:13:46.846Z');

    assert.equal(normalized.available, true);
    assert.equal(normalized.source, 'zylos-native');
    assert.equal(normalized.primary.left_percent, 99);
    assert.equal(normalized.secondary.left_percent, 1);
    assert.equal(normalized.tertiary.left_percent, 94);
  });
});

describe('fetchClaudeNativeUsage', () => {
  it('returns native Claude provider data from monitor files', () => {
    // v0.4.13 reshaped the API: fetchClaudeNativeUsage now takes a readImpl that
    // returns { sessionPercent, weeklyAllPercent, weeklySonnetPercent, ... } (the
    // shape of readClaudeUsageFromMonitorFiles). The values are "used percent" so
    // weeklyAllPercent: 99 → secondary.left_percent: 1.
    const result = fetchClaudeNativeUsage({
      now: '2026-04-01T13:13:46.846Z',
      readImpl: () => ({
        sessionPercent: 1,
        weeklyAllPercent: 99,
        weeklySonnetPercent: 6,
        sessionResets: '3pm (UTC)',
        weeklyAllResets: 'Apr 3, 3am (UTC)',
        weeklySonnetResets: 'Apr 6, 6am (UTC)',
      }),
    });

    assert.equal(result.available, true);
    assert.equal(result.source, 'zylos-native');
    assert.equal(result.secondary.left_percent, 1);
  });
});

describe('runProviderUsageOnce', () => {
  it('falls back to native Claude probe when CodexBar Claude probe fails', () => {
    const payload = runProviderUsageOnce({
      log: () => {},
      execFileSyncImpl: (bin, args) => {
        if (String(args[1]) === '--provider' && String(args[2]) === 'claude') {
          const err = new Error('claude failed');
          err.stderr = Buffer.from('Claude usage probe timed out.');
          throw err;
        }
        return JSON.stringify([{
          provider: 'codex',
          source: 'codex-cli',
          usage: {
            primary: { usedPercent: 1, windowMinutes: 300, resetDescription: '6pm' },
            secondary: { usedPercent: 10, windowMinutes: 10080, resetDescription: 'Apr 8' },
          },
        }]);
      },
      fetchClaudeNativeUsageImpl: () => ({
        provider: 'claude',
        available: true,
        fetched_at: '2026-04-01T13:13:46.846Z',
        source: 'zylos-native',
        primary: { used_percent: 1, left_percent: 99, reset_description: '3pm (UTC)' },
        secondary: { used_percent: 99, left_percent: 1, reset_description: 'Apr 3' },
        tertiary: { used_percent: 6, left_percent: 94, reset_description: 'Apr 6' },
      }),
      filePath: '/tmp/provider-usage-test.json',
    });

    assert.equal(payload.providers.codex.available, true);
    assert.equal(payload.providers.claude.available, true);
    assert.equal(payload.providers.claude.source, 'zylos-native');
    assert.equal(payload.providers.claude.secondary.left_percent, 1);
  });
});
