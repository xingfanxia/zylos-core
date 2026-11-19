import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.UPDATE_PROVIDER_USAGE_DISABLE_MAIN = '1';

const {
  fetchCodexNativeUsage,
  fetchClaudeNativeUsage,
  fetchProviderUsage,
  fetchClaudeAccountUsage,
  normalizeProviderPayload,
  normalizeNativeClaudeUsage,
  runProviderUsageOnce,
  runDaemon,
} = await import('../update-provider-usage.js');
const { providerUsageState } = await import('../runtime-failover.js');

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

    assert.equal(result.available, false);
    assert.equal(result.quota_authoritative, false);
    assert.equal(result.fetched_at, null);
    assert.equal(result.source, 'zylos-native-rollout');
    assert.equal(result.primary, null);
    assert.equal(result.secondary.used_percent, 8);
    assert.equal(result.secondary.left_percent, 92);
    assert.equal(result.secondary.window_minutes, 10080);
  });

  it('preserves the original rollout observation and marks old data unavailable for policy', () => {
    const result = fetchCodexNativeUsage({ now: '2026-09-07T13:19:23Z', readImpl: () => ({
      observedAt: '2026-09-05T01:02:20Z', weeklyAllPercent: 98, weeklyAllResetsAt: 1788978510,
    }) });
    assert.equal(result.observed_at, '2026-09-05T01:02:20.000Z');
    assert.equal(result.fetched_at, null);
    assert.equal(result.freshness, 'stale');
    assert.equal(result.available, false);
    assert.equal(result.quota_authoritative, false);
    assert.equal(result.secondary.used_percent, 98);
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

describe('fetchProviderUsage', () => {
  const now = '2026-09-24T22:00:00.000Z';
  it('marks a successful live CodexBar reading as a current authoritative observation', () => {
    const exec = () => JSON.stringify([{ provider: 'claude', source: 'claude',
      usage: { secondary: { usedPercent: 97, windowMinutes: 10080, resetsAt: '2026-09-26T02:00:00Z' } } }]);
    const usage = fetchProviderUsage('claude', { execFileSyncImpl: exec, codexbarBin: 'codexbar', now });
    assert.equal(usage.quota_authoritative, true);
    assert.equal(usage.observed_at, now);
    assert.equal(usage.secondary.used_percent, 97);
  });

  it('does not mark a failed or error probe authoritative', () => {
    const errored = fetchProviderUsage('claude', { now, codexbarBin: 'codexbar',
      execFileSyncImpl: () => JSON.stringify([{ provider: 'claude', error: { message: 'no auth' } }]) });
    const thrown = fetchProviderUsage('claude', { now, codexbarBin: 'codexbar',
      execFileSyncImpl: () => { throw new Error('timeout'); } });
    for (const usage of [errored, thrown]) {
      assert.equal(usage.available, false);
      assert.notEqual(usage.quota_authoritative, true);
    }
  });
});

describe('fetchClaudeAccountUsage', () => {
  const now = '2026-09-24T22:00:00.000Z';
  it('probes one account through a private config dir and removes it', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-usage-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const settings = path.join(dir, 'ax-cl.settings.json');
    fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' } }));
    let configDir;
    const exec = (_bin, args, opts) => {
      configDir = opts.env.CLAUDE_CONFIG_DIR;
      const creds = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'));
      assert.equal(creds.claudeAiOauth.accessToken, 'sk-ant-oat01-fixture');
      assert.equal(creds.claudeAiOauth.refreshToken, '');
      assert.ok(!args.join(' ').includes('sk-ant'), 'token must not reach argv');
      return JSON.stringify([{ provider: 'claude', usage: { secondary: { usedPercent: 15, windowMinutes: 10080, resetsAt: '2026-10-01T17:00:00Z' } } }]);
    };
    const usage = fetchClaudeAccountUsage('claude-ax-cl', settings, { execFileSyncImpl: exec, codexbarBin: 'codexbar', now, homeDir: dir });
    assert.equal(usage.provider, 'claude-ax-cl');
    assert.equal(usage.quota_authoritative, true);
    assert.equal(usage.secondary.used_percent, 15);
    assert.equal(fs.existsSync(configDir), false);
  });

  it('reports an unreadable account as unavailable', () => {
    const usage = fetchClaudeAccountUsage('claude-ax-cl', '/nonexistent/ax-cl.settings.json', { now });
    assert.equal(usage.available, false);
    assert.notEqual(usage.quota_authoritative, true);
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

describe('normalizeNativeClaudeUsage reset epochs', () => {
  it('converts raw reset epochs to ISO resets_at so stale windows can expire', () => {
    // Without resets_at the failover daemon can never zero a frozen window:
    // monitor files stop updating the moment the Claude session is replaced
    // by Codex, so a 100% weekly reading would block recovery forever.
    const normalized = normalizeNativeClaudeUsage({
      session: 0,
      sessionResets: '23:50 on Jul 14',
      sessionResetsAt: 1784073000,
      weeklyAll: 100,
      weeklyAllResets: '02:00 on Jul 18',
      weeklyAllResetsAt: 1784340000,
    }, '2026-07-16T15:00:00.000Z');

    assert.equal(normalized.primary.resets_at, new Date(1784073000 * 1000).toISOString());
    assert.equal(normalized.secondary.resets_at, new Date(1784340000 * 1000).toISOString());
  });

  it('keeps resets_at null when no epoch is known', () => {
    const normalized = normalizeNativeClaudeUsage({
      session: 1,
      weeklyAll: 99,
    }, '2026-07-16T15:00:00.000Z');
    assert.equal(normalized.primary.resets_at, null);
    assert.equal(normalized.secondary.resets_at, null);
  });
});

describe('fetchClaudeNativeUsage', () => {
  it('publishes the five-hour rate-limit window as primary with reset epochs (statusline Format B)', () => {
    // Format B statuslines report sessionPercent from context_window (not a
    // rate limit); the genuine 5h window arrives in fiveHourPercent. The
    // provider payload must carry the rate-limit window plus its reset epoch.
    const result = fetchClaudeNativeUsage({
      now: '2026-07-16T15:00:00.000Z',
      statImpl: () => ({ mtimeMs: Date.parse('2026-07-16T14:59:00.000Z') }),
      readImpl: () => ({
        sessionPercent: null,
        sessionResets: null,
        weeklyAllPercent: 100,
        weeklyAllResets: '02:00 on Jul 18',
        weeklyAllResetsAt: 1784340000,
        weeklySonnetPercent: null,
        fiveHourPercent: 0,
        fiveHourResets: '23:50 on Jul 14',
        fiveHourResetsAt: 1784073000,
        statusShape: 'statusline_rate_limits',
      }),
    });

    assert.equal(result.available, true);
    assert.equal(result.primary.used_percent, 0);
    assert.equal(result.primary.resets_at, new Date(1784073000 * 1000).toISOString());
    assert.equal(result.secondary.used_percent, 100);
    assert.equal(result.secondary.resets_at, new Date(1784340000 * 1000).toISOString());
  });

  it('returns native Claude provider data from monitor files', () => {
    // v0.4.13 reshaped the API: fetchClaudeNativeUsage now takes a readImpl that
    // returns { sessionPercent, weeklyAllPercent, weeklySonnetPercent, ... } (the
    // shape of readClaudeUsageFromMonitorFiles). The values are "used percent" so
    // weeklyAllPercent: 99 → secondary.left_percent: 1.
    const result = fetchClaudeNativeUsage({
      now: '2026-04-01T13:13:46.846Z',
      statImpl: () => ({ mtimeMs: Date.parse('2026-04-01T13:12:46.846Z') }),
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

describe('fetchClaudeNativeUsage observation time', () => {
  const now = '2026-11-18T18:44:13.587Z';
  const monitorDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-claude-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'activity-monitor'));
    return dir;
  };
  const writeAt = (file, data, iso) => {
    fs.writeFileSync(file, JSON.stringify(data));
    fs.utimesSync(file, new Date(iso), new Date(iso));
  };

  it('dates a statusline reading by the file, not by the poll (2026-11-18 ax-main at 53% from July)', (t) => {
    const dir = monitorDir(t);
    const epoch = iso => Date.parse(iso) / 1000;
    writeAt(path.join(dir, 'activity-monitor', 'statusline.json'), { rate_limits: {
      five_hour: { used_percentage: 10, resets_at: epoch('2026-07-01T11:00:00Z') },
      seven_day: { used_percentage: 53, resets_at: epoch('2026-07-02T17:00:00Z') },
    } }, '2026-07-01T06:32:14Z');
    const usage = fetchClaudeNativeUsage({ zylosDir: dir, now });
    assert.equal(usage.secondary.used_percent, 53);
    assert.equal(usage.observed_at, '2026-07-01T06:32:14.000Z');
    assert.equal(usage.fetched_at, '2026-07-01T06:32:14.000Z');
    assert.equal(usage.checked_at, now);
    assert.equal(usage.quota_authoritative, false);
  });

  it('dates a usage.json fallback by usage.json', (t) => {
    const dir = monitorDir(t);
    writeAt(path.join(dir, 'activity-monitor', 'usage.json'),
      { session: { percent: 4 }, weeklyAll: { percent: 30 } }, '2026-03-28T21:22:37Z');
    const usage = fetchClaudeNativeUsage({ zylosDir: dir, now });
    assert.equal(usage.secondary.used_percent, 30);
    assert.equal(usage.fetched_at, '2026-03-28T21:22:37.000Z');
  });

  it('reports a reading without a file time as unavailable', () => {
    const usage = fetchClaudeNativeUsage({ zylosDir: '/nonexistent', now,
      readImpl: () => ({ weeklyAllPercent: 53, statusShape: 'statusline_rate_limits' }),
      statImpl: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
    assert.equal(usage.available, false);
    assert.equal(usage.primary, null);
    assert.equal(usage.secondary, null);
  });
});

describe('runProviderUsageOnce', () => {
  it('falls back to native Claude probe when CodexBar Claude probe fails', async () => {
    const payload = await runProviderUsageOnce({
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
      fetchCodexAccountUsageImpl: async () => ({ provider: 'codex', available: true, quota_authoritative: true, source: 'codex-account-api' }),
      filePath: '/tmp/provider-usage-test.json',
    });

    assert.equal(payload.providers.codex.available, true);
    assert.equal(payload.providers.claude.available, true);
    assert.equal(payload.providers.claude.source, 'zylos-native');
    assert.equal(payload.providers.claude.secondary.left_percent, 1);
  });

  it('prefers fresh official 39% over retained 98%, without a CodexBar quota read', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-quota-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await runProviderUsageOnce({ filePath: path.join(dir, 'usage.json'), log: () => {},
      execFileSyncImpl: (_bin, args) => { assert.equal(args[2], 'claude'); return JSON.stringify([{ usage: {} }]); },
      fetchCodexAccountUsageImpl: async () => ({ available: true, quota_authoritative: true, source: 'codex-account-api',
        observed_at: '2026-09-07T13:19:23Z', fetched_at: '2026-09-07T13:19:23Z', secondary: { used_percent: 39 } }),
      fetchCodexNativeUsageImpl: () => { throw new Error('historical 98% must not override fresh official quota'); },
    });
    assert.equal(result.providers.codex.secondary.used_percent, 39);
    assert.equal(result.providers.codex.quota_authoritative, true);
  });

  it('API failure leaves historical data non-authoritative even if a fallback claims availability', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-quota-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const result = await runProviderUsageOnce({ filePath: path.join(dir, 'usage.json'), log: () => {},
      execFileSyncImpl: () => JSON.stringify([{ usage: {} }]),
      fetchCodexAccountUsageImpl: async () => ({ available: false, error: 'quota_probe_timeout' }),
      fetchCodexNativeUsageImpl: () => ({ available: true, fetched_at: '2026-09-07T13:19:23Z',
        observed_at: '2026-09-05T01:02:20Z', source: 'zylos-native-rollout', secondary: { used_percent: 98 } }),
    });
    assert.equal(result.providers.codex.available, false);
    assert.equal(result.providers.codex.quota_authoritative, false);
    assert.equal(result.providers.codex.fetched_at, null);
    assert.equal(result.providers.codex.observed_at, '2026-09-05T01:02:20Z');
    assert.equal(result.providers.codex.api_error, 'quota_probe_timeout');
  });
});

describe('runProviderUsageOnce: the claude provider is the account a launch without its own file uses', () => {
  const MAIN_ONLY = { runtime_profiles: { 'claude-ax-main': { runtime: 'claude', usage_provider: 'claude' } } };
  const hostDir = (t, { settings, instances } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-claude-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (settings) {
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(settings));
    }
    if (instances) fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify(instances));
    return dir;
  };
  const run = (dir, overrides) => runProviderUsageOnce({ zylosDir: dir, filePath: path.join(dir, 'provider-usage.json'),
    log: () => {}, refreshQuotaRecoveryProofsImpl: async () => ({}),
    fetchCodexAccountUsageImpl: async () => ({ provider: 'codex', available: true, quota_authoritative: true }),
    fetchCodexNativeUsageImpl: () => { throw new Error('unused'); },
    ...overrides });
  const probeOutput = used => JSON.stringify([{ provider: 'claude', source: 'claude',
    usage: { secondary: { usedPercent: used, windowMinutes: 10080, resetsAt: '2026-11-19T17:00:00Z' } } }]);

  it('reads ax-main through the account probe with the shared project token file', async (t) => {
    const dir = hostDir(t, { settings: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-main-fixture' } }, instances: MAIN_ONLY });
    const calls = [];
    const payload = await run(dir, {
      execFileSyncImpl: (_bin, args, opts) => {
        assert.ok(opts?.env?.CLAUDE_CONFIG_DIR, 'the operator default login must not be probed');
        const creds = JSON.parse(fs.readFileSync(path.join(opts.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'));
        assert.equal(creds.claudeAiOauth.accessToken, 'sk-ant-oat01-main-fixture');
        assert.ok(!args.join(' ').includes('sk-ant'), 'token must not reach argv');
        return probeOutput(61);
      },
      fetchClaudeAccountUsageImpl: (provider, settingsFile, options) => {
        calls.push([provider, settingsFile]);
        return fetchClaudeAccountUsage(provider, settingsFile, { ...options, homeDir: dir });
      },
      fetchClaudeNativeUsageImpl: () => { throw new Error('native files must not be read after a good probe'); },
    });
    assert.deepEqual(calls, [['claude', path.join(dir, '.claude', 'settings.local.json')]]);
    const claude = payload.providers.claude;
    assert.equal(claude.provider, 'claude');
    assert.equal(claude.secondary.used_percent, 61);
    assert.equal(claude.quota_authoritative, true);
    assert.ok(Date.parse(claude.observed_at) <= Date.parse(payload.updated_at));
  });

  it('runs no token-file probe when the shared project file holds no token', async (t) => {
    const dir = hostDir(t, { settings: { permissions: { allow: [] } } });
    const calls = [];
    const payload = await run(dir, {
      execFileSyncImpl: (_bin, args, opts) => {
        assert.deepEqual(args, ['usage', '--provider', 'claude', '--source', 'cli', '--json-only']);
        assert.equal(opts.env, undefined, 'the default probe runs with the daemon environment');
        return probeOutput(12);
      },
      fetchClaudeAccountUsageImpl: (...args) => { calls.push(args); throw new Error('no token-file probe'); },
    });
    assert.deepEqual(calls, []);
    assert.equal(payload.providers.claude.secondary.used_percent, 12);
  });

  it('never publishes top-level monitor files on a multi-instance host', async (t) => {
    const dir = hostDir(t, { settings: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-main-fixture' } }, instances: MAIN_ONLY });
    const payload = await run(dir, {
      execFileSyncImpl: () => { throw new Error('Claude usage probe timed out.'); },
      fetchClaudeAccountUsageImpl: (provider, settingsFile, options) =>
        fetchClaudeAccountUsage(provider, settingsFile, { ...options, homeDir: dir }),
      fetchClaudeNativeUsageImpl: () => { throw new Error('top-level monitor files belong to no instance'); },
    });
    const claude = payload.providers.claude;
    assert.equal(claude.available, false);
    assert.notEqual(claude.quota_authoritative, true);
    assert.match(claude.error, /timed out/);
    assert.match(claude.fallback_error, /Multi-instance host/);
  });

  it('keeps the dated native reading on a single-session host and records why the probe failed', async (t) => {
    const dir = hostDir(t);
    let nativeDir;
    const payload = await run(dir, {
      execFileSyncImpl: () => { throw new Error('Claude usage probe timed out.'); },
      fetchClaudeNativeUsageImpl: ({ zylosDir }) => {
        nativeDir = zylosDir;
        return { provider: 'claude', available: true, quota_authoritative: false, source: 'zylos-native',
          observed_at: '2026-11-18T18:40:00.000Z', fetched_at: '2026-11-18T18:40:00.000Z', secondary: { used_percent: 20 } };
      },
    });
    assert.equal(nativeDir, dir);
    assert.equal(payload.providers.claude.source, 'zylos-native');
    assert.equal(payload.providers.claude.fetched_at, '2026-11-18T18:40:00.000Z');
    assert.match(payload.providers.claude.probe_error, /timed out/);
  });
});

// A pass probes claude, codex, then each extra Claude account, one after
// another. Durations follow the devbox measurement of 2026-11-19 (three Claude
// probes of ~40 s). The clock is the mocked Date, so the updater's own default
// clock is what dates every reading.
describe('runProviderUsageOnce: each observation is dated by its own probe and published at once', () => {
  const T0 = Date.parse('2026-11-19T06:58:35.000Z');
  const RESETS = '2026-11-25T00:00:00.000Z';
  const EXTRA = ['claude-ax-backup', 'claude-ax-third'];
  const CLAUDE = ['claude', ...EXTRA];
  const iso = ms => new Date(ms).toISOString();
  const readDoc = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const good = (provider, at) => ({ provider, available: true, quota_authoritative: true, source: 'cli',
    fetched_at: at, observed_at: at, primary: null, secondary: { used_percent: 30, window_minutes: 10080, resets_at: RESETS },
    tertiary: null });

  function fixture(t, { durations = {}, fail = new Set(), disk, during = {} } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-publish-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture-main' } }));
    const profiles = { 'claude-ax-main': { runtime: 'claude', usage_provider: 'claude' } };
    for (const provider of EXTRA) {
      profiles[provider] = { runtime: 'claude', usage_provider: provider, claude_settings_file: path.join(dir, `${provider}.json`) };
    }
    fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify({ instances: {}, runtime_profiles: profiles }));
    const file = path.join(dir, 'activity-monitor', 'provider-usage.json');
    if (disk !== undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof disk === 'string' ? disk : JSON.stringify(disk));
    }
    const advance = ms => t.mock.timers.setTime(Date.now() + ms);
    // What the file held when each step began: writes happen only between steps.
    const boundaries = [];
    const snap = label => boundaries.push({ label, at: Date.now(), doc: readDoc(file) });
    const starts = {};
    let passes = 0;
    const opts = {
      zylosDir: dir, filePath: file, log: () => {},
      execFileSyncImpl: () => { throw new Error('no CodexBar in tests'); },
      fetchClaudeNativeUsageImpl: () => { throw new Error('multi-instance host reads no native files'); },
      fetchCodexNativeUsageImpl: () => { throw new Error('codex probe succeeds in these tests'); },
      // Like fetchClaudeAccountUsage: the reading carries the `now` it was given.
      fetchClaudeAccountUsageImpl: (provider, _settingsFile, options) => {
        snap(provider);
        starts[provider] = options.now;
        advance(durations[provider] ?? 40_000);
        during[provider]?.(file); // another writer, while this probe runs
        if (!fail.has(provider)) return good(provider, options.now);
        return { provider, available: false, fetched_at: options.now, source: 'cli', error: 'Claude usage probe timed out.',
          primary: null, secondary: null, tertiary: null, account_email: null, version: null };
      },
      // Like fetchCodexAccountUsage: dated by its own clock when the answer arrives.
      fetchCodexAccountUsageImpl: async () => {
        snap('codex');
        starts.codex = iso(Date.now());
        advance(durations.codex ?? 10_000);
        return { ...good('codex', iso(Date.now())), source: 'codex-account-api', account_key: 'a'.repeat(64) };
      },
      refreshQuotaRecoveryProofsImpl: async () => {
        snap('quota');
        advance(500);
        passes += 1;
        return { pass: passes };
      },
    };
    const run = async (extra = {}) => {
      const payload = await runProviderUsageOnce({ ...opts, ...extra });
      snap('end');
      return payload;
    };
    return { dir, file, boundaries, starts, run, advance, at: label => boundaries.find(b => b.label === label) };
  }

  const PREVIOUS = {
    updated_at: iso(T0 - 1_000), source_bin: 'codexbar', quota_recovery: { pass: 0 },
    providers: {
      claude: good('claude', iso(T0 - 131_000)),
      codex: { ...good('codex', iso(T0 - 81_000)), source: 'codex-account-api' },
      'claude-ax-backup': good('claude-ax-backup', iso(T0 - 81_000)),
      'claude-ax-third': good('claude-ax-third', iso(T0 - 41_000)),
    },
  };

  it('dates each reading by the start of its own probe, not the start of the pass', async (t) => {
    const f = fixture(t);
    const payload = await f.run();
    assert.deepEqual(f.starts, {
      claude: iso(T0), codex: iso(T0 + 40_000), 'claude-ax-backup': iso(T0 + 50_000), 'claude-ax-third': iso(T0 + 90_000),
    });
    for (const provider of CLAUDE) {
      assert.equal(payload.providers[provider].observed_at, f.starts[provider], provider);
      assert.equal(payload.providers[provider].fetched_at, f.starts[provider], provider);
    }
    for (const [provider, entry] of Object.entries(payload.providers)) {
      assert.ok(Date.parse(entry.observed_at) >= Date.parse(f.starts[provider]), `${provider} predates its probe`);
    }
    assert.equal(payload.updated_at, iso(T0 + 130_500), 'updated_at is the time of the last write');
  });

  it('rewrites the file after every observation and leaves every other entry as last published', async (t) => {
    const f = fixture(t, { disk: PREVIOUS });
    const payload = await f.run();
    const before = name => f.at(name).doc;
    // Written once the claude probe returned; the rest is still the previous pass.
    assert.equal(before('codex').updated_at, iso(T0 + 40_000));
    assert.deepEqual(before('codex').providers.claude, good('claude', iso(T0)));
    for (const provider of ['codex', ...EXTRA]) {
      assert.deepEqual(before('codex').providers[provider], PREVIOUS.providers[provider], provider);
    }
    assert.equal(before('claude-ax-backup').updated_at, iso(T0 + 50_000));
    assert.equal(before('claude-ax-backup').providers.codex.observed_at, iso(T0 + 50_000));
    assert.deepEqual(before('claude-ax-backup').providers.claude, before('codex').providers.claude);
    assert.deepEqual(before('claude-ax-backup').providers['claude-ax-third'], PREVIOUS.providers['claude-ax-third']);
    assert.deepEqual(before('claude-ax-third').providers['claude-ax-backup'], good('claude-ax-backup', iso(T0 + 50_000)));
    assert.deepEqual(before('claude-ax-third').providers['claude-ax-third'], PREVIOUS.providers['claude-ax-third']);
    assert.deepEqual(before('quota').providers['claude-ax-third'], good('claude-ax-third', iso(T0 + 90_000)));
    // quota_recovery is refreshed once per pass, at the end.
    for (const name of ['codex', 'claude-ax-backup', 'claude-ax-third', 'quota']) {
      assert.deepEqual(before(name).quota_recovery, PREVIOUS.quota_recovery, name);
    }
    assert.deepEqual(f.at('end').doc, payload);
    assert.deepEqual(payload.quota_recovery, { pass: 1 });
  });

  it('a failed probe replaces only its own entry and refreshes no other entry time', async (t) => {
    const f = fixture(t, { disk: PREVIOUS, fail: new Set(['claude-ax-backup']) });
    await f.run();
    const published = f.at('claude-ax-third').doc;
    const backup = published.providers['claude-ax-backup'];
    assert.equal(backup.available, false);
    assert.match(backup.error, /timed out/);
    assert.equal(backup.secondary, null, 'the previous good reading must not survive the failure');
    assert.equal(backup.observed_at, undefined);
    assert.equal(backup.fetched_at, iso(T0 + 50_000));
    assert.deepEqual(published.providers.claude, f.at('claude-ax-backup').doc.providers.claude);
    assert.deepEqual(published.providers.codex, f.at('claude-ax-backup').doc.providers.codex);
    assert.deepEqual(published.providers['claude-ax-third'], PREVIOUS.providers['claude-ax-third'],
      'an entry not probed yet keeps its own time');
    assert.equal(providerUsageState(published, 'claude-ax-backup', Date.now(), 180_000).available, false);
  });

  it('starts from an empty document when the file on disk does not parse, and drops unconfigured accounts at the end', async (t) => {
    const unreadable = fixture(t, { disk: '{not json' });
    await unreadable.run();
    assert.deepEqual(Object.keys(unreadable.at('codex').doc.providers), ['claude']);
    assert.equal(unreadable.at('codex').doc.quota_recovery, undefined, 'no proof is invented mid-pass');
    t.mock.timers.reset();

    const stale = fixture(t, { disk: { ...PREVIOUS, providers: { ...PREVIOUS.providers, 'claude-ax-gone': good('claude-ax-gone', iso(T0 - 600_000)) } } });
    const payload = await stale.run();
    assert.ok(stale.at('quota').doc.providers['claude-ax-gone'], 'kept as last published during the pass');
    assert.deepEqual(Object.keys(payload.providers).sort(), ['claude', 'claude-ax-backup', 'claude-ax-third', 'codex']);
    assert.deepEqual(Object.keys(readDoc(stale.file).providers).sort(), Object.keys(payload.providers).sort());
  });

  // The codex rotation handoff runs a one-shot pass after a credential change.
  // Its codex entry (new account) lands on disk while this pass probes backup;
  // this pass's next publish must not put its own earlier codex entry back.
  it('keeps an entry another writer published mid-pass byte-for-byte', async (t) => {
    const rotated = { ...good('codex', iso(T0 + 70_000)), source: 'codex-account-api', account_key: 'b'.repeat(64),
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: RESETS } };
    const f = fixture(t, { disk: PREVIOUS, during: { 'claude-ax-backup': file => {
      const doc = readDoc(file);
      doc.providers.codex = rotated;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    } } });
    const payload = await f.run();
    assert.equal(f.at('claude-ax-third').doc.providers['claude-ax-backup'].observed_at, iso(T0 + 50_000));
    assert.equal(JSON.stringify(f.at('claude-ax-third').doc.providers.codex), JSON.stringify(rotated));
    assert.equal(JSON.stringify(payload.providers.codex), JSON.stringify(rotated));
    assert.equal(JSON.stringify(readDoc(f.file).providers.codex), JSON.stringify(rotated));
  });

  // The failover's own freshness rule over a modelled daemon run: every
  // Claude reading must be current at every instant once all are published.
  it('with three 40 s Claude probes no Claude reading is ever older than usage_max_age_sec', async (t) => {
    const f = fixture(t);
    const MAX_AGE_MS = 180_000;
    const unknownInstants = boundaries => {
      const firstAll = boundaries.find(b => CLAUDE.every(p => b.doc?.providers?.[p]?.available));
      assert.ok(firstAll, 'every Claude account was published at least once');
      const horizon = firstAll.at + 3 * MAX_AGE_MS;
      const unknown = [];
      boundaries.forEach((b, i) => {
        if (b.at < firstAll.at || b.at >= horizon) return;
        // The file is constant until the next boundary; its oldest instant is just before that.
        const until = Math.min(boundaries[i + 1]?.at ?? horizon, horizon);
        for (const nowMs of [b.at, until - 1]) {
          for (const provider of CLAUDE) {
            if (!providerUsageState(b.doc, provider, nowMs, MAX_AGE_MS).available) {
              unknown.push(`${provider}@+${Math.round((nowMs - T0) / 1000)}s`);
            }
          }
        }
      });
      return [...new Set(unknown)];
    };

    // Production pacing (60 s interval); the seventh pass parks the daemon.
    let count = 0;
    runDaemon({
      intervalMs: 60_000, retryMs: 60_000, log: () => {}, error: () => {},
      sleepImpl: async ms => f.advance(ms),
      once: async args => (count++ === 6 ? new Promise(() => {}) : f.run(args)),
    });
    for (let turn = 0; turn < 500 && count <= 6; turn += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unknownInstants(f.boundaries), []);
    assert.ok(count > 6, `the daemon completed six passes (completed ${count})`);
    // Cycle: 3 x 40 s + 10 s + 0.5 s = 130.5 s, then the 1 s minimum gap.
    const passStarts = f.boundaries.filter(b => b.label === 'claude').map(b => b.at - T0);
    assert.deepEqual(passStarts.slice(0, 3), [0, 131_500, 263_000]);

    // Contrast: the same probes published the old way (one write at the end of
    // the pass, every reading dated by the pass start, 60 s sleep after it).
    const old = [];
    let start = T0;
    for (let pass = 0; pass < 6; pass += 1) {
      const end = start + 130_500;
      const doc = { providers: Object.fromEntries(CLAUDE.map(p => [p, good(p, iso(start))])) };
      old.push({ at: end, doc });
      start = end + 60_000;
    }
    assert.notDeepEqual(unknownInstants(old), [], 'the model detects the old publication gap');
  });
});

describe('runDaemon: passes are paced start to start', () => {
  it('starts each pass intervalMs after the previous start, 1 s after a long pass, retryMs after a throw', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const durations = [20_000, 130_000, 5_000, 60_000];
    const starts = [];
    const delays = [];
    let done = false;
    runDaemon({
      intervalMs: 60_000, retryMs: 30_000, log: () => {}, error: () => {},
      sleepImpl: async ms => { delays.push(ms); t.mock.timers.setTime(Date.now() + ms); },
      once: async () => {
        const pass = starts.length;
        if (pass === durations.length) { done = true; return new Promise(() => {}); }
        starts.push(Date.now());
        t.mock.timers.setTime(Date.now() + durations[pass]);
        if (pass === 2) throw new Error('pass failed');
        return { pass };
      },
    });
    for (let turn = 0; turn < 200 && !done; turn += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delays, [40_000, 1_000, 30_000, 1_000]);
    assert.deepEqual(starts, [0, 60_000, 191_000, 226_000]);
  });
});
