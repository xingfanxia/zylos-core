import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyProbeOutput,
  parseCliVersion,
  probeArgs,
  probeDue,
  recordProbeResult,
  runFableProbe,
} from '../fable-probe.js';
import { FABLE_GUARD_DEFAULTS } from '../../../multi-session/runtime-files.js';

// Shapes from fable-signal-experiments.md (E1/E2/E6, CLI 2.1.322); ids removed.
const NOW = Date.parse('2026-11-10T07:22:00Z');
const RESET = 1794549600; // 2026-11-13T06:00:00Z
const config = { ...FABLE_GUARD_DEFAULTS, fable_model: 'claude-fable-5-2[1m]' };

function rateLimitEvent({ fable = { utilization: 0.02, resetsAt: RESET, status: 'allowed' }, status = 'allowed',
  rateLimitType = 'seven_day', isUsingOverage = false } = {}) {
  return { type: 'rate_limit_event', rate_limit_info: {
    status, resetsAt: RESET, rateLimitType, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage,
    unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: RESET, status: 'allowed' },
      ...(fable ? { seven_day_overage_included: fable } : {}) },
  } };
}
function stream(...events) { return events.map(event => JSON.stringify(event)).join('\n') + '\n'; }
const init = { type: 'system', subtype: 'init', model: 'claude-fable-5-2' };
const fableResult = { type: 'result', subtype: 'success', is_error: false, result: 'OK',
  modelUsage: { 'claude-fable-5-2': { inputTokens: 355, outputTokens: 4 } }, total_cost_usd: 0.003 };
const opusResult = { ...fableResult, modelUsage: { 'claude-opus-5-5': { inputTokens: 10 } } };
const base = { exitCode: 0, fableModel: 'claude-fable-5-2[1m]', nowMs: NOW, cliVersion: '2.1.322',
  account: 'claude-ax-backup', settingsFile: '/home/zylos-shared/auth/claude-ax-backup.settings.json' };

describe('Fable probe classification (FG-1 validity rules)', () => {
  it('accepts the lean Fable probe output as a valid observation', () => {
    const result = classifyProbeOutput({ ...base, stdout: stream(init, rateLimitEvent(), fableResult) });
    assert.equal(result.outcome, 'valid');
    assert.deepEqual(result.observation, {
      account: 'claude-ax-backup', utilization: 0.02, resets_at: '2026-11-13T06:00:00.000Z',
      observed_at: new Date(NOW).toISOString(), cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed',
    });
  });

  it('rejects an answer from another model (silent fallback canary)', () => {
    const result = classifyProbeOutput({ ...base, stdout: stream(rateLimitEvent({ fable: null }), opusResult) });
    assert.deepEqual(result, { outcome: 'invalid', reason: 'model_mismatch' });
  });

  it('treats a Fable answer without the Fable window as no observation', () => {
    const result = classifyProbeOutput({ ...base, stdout: stream(rateLimitEvent({ fable: null }), fableResult) });
    assert.deepEqual(result, { outcome: 'invalid', reason: 'fable_window_missing' });
  });

  for (const [name, fable, reason] of [
    ['utilization above 1', { utilization: 1.5, resetsAt: RESET, status: 'allowed' }, 'utilization_out_of_range'],
    ['negative utilization', { utilization: -0.1, resetsAt: RESET, status: 'allowed' }, 'utilization_out_of_range'],
    ['missing utilization', { resetsAt: RESET, status: 'allowed' }, 'utilization_out_of_range'],
    ['reset already passed', { utilization: 0.2, resetsAt: NOW / 1000 - 60, status: 'allowed' }, 'reset_out_of_range'],
    ['reset more than 8 days away', { utilization: 0.2, resetsAt: NOW / 1000 + 9 * 86400, status: 'allowed' }, 'reset_out_of_range'],
  ]) {
    it(`rejects ${name}`, () => {
      const result = classifyProbeOutput({ ...base, stdout: stream(rateLimitEvent({ fable }), fableResult) });
      assert.deepEqual(result, { outcome: 'invalid', reason });
    });
  }

  it('requires a recorded CLI version and a known account binding', () => {
    const stdout = stream(rateLimitEvent(), fableResult);
    assert.equal(classifyProbeOutput({ ...base, stdout, cliVersion: null }).reason, 'cli_version_unknown');
    assert.equal(classifyProbeOutput({ ...base, stdout, settingsFile: null }).reason, 'account_unbound');
  });

  it('reads an explicit Fable rejection as exhaustion even on a non-zero exit', () => {
    const stdout = stream(rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day_overage_included',
      fable: { utilization: 1, resetsAt: RESET, status: 'rejected' } }),
    { type: 'result', is_error: true, result: "You've reached your Fable limit." });
    const result = classifyProbeOutput({ ...base, stdout, exitCode: 1 });
    assert.deepEqual(result, { outcome: 'rejected', reason: 'fable_rejected', resets_at: '2026-11-13T06:00:00.000Z', account: 'claude-ax-backup' });
  });

  it('keeps an explicit Fable rejection when later fallback events and an Opus result follow (review #7)', () => {
    const LATER = RESET + 7 * 86400 - 3600; // a different window on the fallback event
    const rejection = rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day_overage_included',
      fable: { utilization: 1, resetsAt: RESET, status: 'rejected' } });
    const fallback = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: LATER, rateLimitType: 'seven_day',
      isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.1, resetsAt: LATER, status: 'allowed' } } } };
    const result = classifyProbeOutput({ ...base, stdout: stream(init, rejection, fallback, opusResult) });
    assert.deepEqual(result, { outcome: 'rejected', reason: 'fable_rejected', resets_at: '2026-11-13T06:00:00.000Z',
      account: 'claude-ax-backup' });
    const store = recordProbeResult({}, { account: 'claude-ax-backup', result, nowMs: NOW, config });
    assert.deepEqual(store.accounts['claude-ax-backup'].rejection,
      { at: new Date(NOW).toISOString(), resets_at: '2026-11-13T06:00:00.000Z', detail: 'fable_rejected' });
    assert.equal(store.accounts['claude-ax-backup'].last_valid, undefined, 'the Opus answer is never an observation');
  });

  it('reads the limit-reached error text as a rejection without a window', () => {
    const result = classifyProbeOutput({ ...base, exitCode: 1,
      stdout: stream({ type: 'result', is_error: true, result: 'API Error: model_requires_usage_credits' }) });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.resets_at, null);
  });

  it('treats a request served from usage credits as exhaustion', () => {
    const result = classifyProbeOutput({ ...base, stdout: stream(rateLimitEvent({ isUsingOverage: true }), fableResult) });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.reason, 'using_overage');
  });

  it('does not read Fable wording in a successful answer as a rejection', () => {
    const answer = { ...fableResult, result: "You've reached your Fable limit (quoted)" };
    assert.equal(classifyProbeOutput({ ...base, stdout: stream(rateLimitEvent(), answer) }).outcome, 'valid');
  });

  it('classifies a generic 429 as rate_limited, not exhaustion', () => {
    const generic = classifyProbeOutput({ ...base, exitCode: 1, stdout: '', stderr: 'API Error: 429 Too Many Requests' });
    assert.deepEqual(generic, { outcome: 'rate_limited', reason: 'rate_limited' });
    const weekly = classifyProbeOutput({ ...base, exitCode: 1,
      stdout: stream(rateLimitEvent({ status: 'rejected', rateLimitType: 'seven_day' }), { type: 'result', is_error: true, result: 'limit' }) });
    assert.equal(weekly.outcome, 'rate_limited');
  });

  it('treats other failures as no observation', () => {
    assert.deepEqual(classifyProbeOutput({ ...base, exitCode: 'timeout', stdout: '' }), { outcome: 'invalid', reason: 'exit_timeout' });
    assert.deepEqual(classifyProbeOutput({ ...base, stdout: 'not json' }), { outcome: 'invalid', reason: 'result_error' });
  });

  it('parses the CLI version banner', () => {
    assert.equal(parseCliVersion('2.1.322 (Claude Code)\n'), '2.1.322');
    assert.equal(parseCliVersion('garbage'), null);
  });
});

describe('Fable probe store', () => {
  const valid = utilization => ({ outcome: 'valid', observation: { account: 'a', utilization, resets_at: '2026-11-13T06:00:00.000Z',
    observed_at: new Date(NOW).toISOString(), cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed' } });

  it('backs off a generic 429 to at most 15 minutes and never refreshes the lease', () => {
    let store = recordProbeResult({}, { account: 'a', result: valid(0.3), nowMs: NOW, config });
    const leaseStart = store.accounts.a.last_valid.observed_at;
    const delays = [];
    let t = NOW;
    for (let i = 0; i < 4; i++) {
      t = Date.parse(store.accounts.a.next_probe_at);
      store = recordProbeResult(store, { account: 'a', result: { outcome: 'rate_limited', reason: 'rate_limited' }, nowMs: t, config });
      delays.push((Date.parse(store.accounts.a.next_probe_at) - t) / 60_000);
    }
    assert.deepEqual(delays, [10, 15, 15, 15]);
    assert.equal(store.accounts.a.last_valid.observed_at, leaseStart);
    store = recordProbeResult(store, { account: 'a', result: valid(0.31), nowMs: t + 60_000, config });
    assert.equal(store.accounts.a.failures, 0);
    assert.equal(Date.parse(store.accounts.a.next_probe_at) - (t + 60_000), 300_000);
  });

  it('keeps the recent attempt history bounded and records rejections separately', () => {
    let store = {};
    for (let i = 0; i < 12; i++) store = recordProbeResult(store, { account: 'a', result: valid(0.1), nowMs: NOW + i * 1000, config });
    store = recordProbeResult(store, { account: 'a', result: { outcome: 'rejected', reason: 'fable_rejected', resets_at: null }, nowMs: NOW + 20_000, config });
    assert.equal(store.accounts.a.recent.length, 8);
    assert.equal(store.accounts.a.rejection.detail, 'fable_rejected');
    assert.equal(store.accounts.a.last_valid.utilization, 0.1);
  });

  it('is due when never probed, when the schedule passed, or when the clock stepped back', () => {
    assert.equal(probeDue({}, 'a', NOW), true);
    const store = { accounts: { a: { next_probe_at: new Date(NOW + 60_000).toISOString() } } };
    assert.equal(probeDue(store, 'a', NOW), false);
    assert.equal(probeDue(store, 'a', NOW + 60_000), true);
    assert.equal(probeDue({ accounts: { a: { next_probe_at: new Date(NOW + 7_200_000).toISOString() } } }, 'a', NOW), true);
  });
});

describe('Fable probe execution', () => {
  it('runs the lean form in a private config dir without copying the token', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-probe-test-'));
    const calls = [];
    const run = async (command, args, options) => {
      calls.push({ command, args, options, cfgExists: fs.existsSync(options.env.CLAUDE_CONFIG_DIR) });
      if (args[0] === '--version') return { code: 0, stdout: '2.1.322 (Claude Code)\n', stderr: '' };
      return { code: 0, stdout: stream(init, rateLimitEvent(), fableResult), stderr: '' };
    };
    try {
      const result = await runFableProbe({ account: 'claude-ax-backup', settingsFile: base.settingsFile,
        fableModel: 'claude-fable-5-2[1m]', claudeBin: '/opt/claude', run, now: () => NOW, tmpRoot, homeDir: '/home/op' });
      assert.equal(result.outcome, 'valid');
      assert.equal(result.observation.cli_version, '2.1.322');
      const probe = calls[1];
      assert.deepEqual(probe.args, probeArgs({ model: 'claude-fable-5-2', settingsFile: base.settingsFile }));
      assert.ok(probe.args.includes('--system-prompt') && probe.args[probe.args.indexOf('--tools') + 1] === '');
      assert.equal(probe.args[probe.args.indexOf('--model') + 1], 'claude-fable-5-2');
      assert.deepEqual(Object.keys(probe.options.env).sort(), ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'PATH']);
      assert.ok(probe.options.env.CLAUDE_CONFIG_DIR.startsWith(tmpRoot));
      assert.ok(probe.options.cwd.startsWith(tmpRoot));
      assert.equal(probe.cfgExists, true);
      assert.deepEqual(fs.readdirSync(tmpRoot), [], 'temp dir removed after the probe');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reports no observation when the CLI version cannot be read', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-probe-test-'));
    const run = async (command, args) => args[0] === '--version'
      ? { code: 1, stdout: '', stderr: 'boom' }
      : { code: 0, stdout: stream(rateLimitEvent(), fableResult), stderr: '' };
    try {
      const result = await runFableProbe({ account: 'a', settingsFile: base.settingsFile, fableModel: 'claude-fable-5-2',
        claudeBin: 'claude', run, now: () => NOW, tmpRoot });
      assert.deepEqual(result, { outcome: 'invalid', reason: 'cli_version_unknown' });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
