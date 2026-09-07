import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  chooseRuntimeProfile,
  planRuntimeFailover,
  planSingleSessionRuntimeFailover,
} from '../runtime-failover.js';
import { writeRuntimeSwitchSignal } from '../runtime-switch-signal.js';

const profiles = {
  'claude-subscription': { runtime: 'claude', usage_provider: 'claude' },
  'codex-subscription': { runtime: 'codex', usage_provider: 'codex' },
  'codex-azure': { runtime: 'codex', usage_provider: null },
};

function usage({ claude = null, codex = null } = {}) {
  const provider = (used) => used == null ? { available: false } : {
    available: true,
    primary: { used_percent: used, resets_at: '2099-01-01T00:00:00Z' },
    secondary: { used_percent: used },
  };
  return { providers: { claude: provider(claude), codex: provider(codex) } };
}

describe('model and authoritative quota policy', () => {
  const nowMs = Date.parse('2026-09-07T13:00:00Z');
  const pinnedProfiles = {
    'codex-subscription': { runtime: 'codex', usage_provider: 'codex', model: 'gpt-6-astra', reasoning_effort: 'high' },
    'codex-azure': { runtime: 'codex', usage_provider: null, model: 'gpt-6-astra', reasoning_effort: 'high' },
  };
  const policy = {
    enabled: true,
    chain: Object.keys(pinnedProfiles),
    required_model: 'gpt-6-astra',
    required_reasoning_effort: 'high',
    usage_max_age_sec: 180,
    auto_recover: true,
    min_dwell_sec: 0,
  };
  function authoritative(used, extra = {}) {
    const value = usage({ codex: used });
    Object.assign(value.providers.codex, {
      quota_authoritative: true,
      observed_at: new Date(nowMs).toISOString(),
      fetched_at: new Date(nowMs).toISOString(),
      ...extra,
    });
    return value;
  }
  function choose(extra = {}) {
    return chooseRuntimeProfile({
      currentProfile: 'codex-subscription', chain: policy.chain, profiles: pinnedProfiles,
      providerUsage: authoritative(98), requiredModel: policy.required_model,
      requiredReasoningEffort: policy.required_reasoning_effort, usageMaxAgeMs: 180_000,
      nowMs, minDwellMs: 0, ...extra,
    });
  }

  it('switches providers at the same required model and effort', () => {
    assert.equal(choose().profile, 'codex-azure');
    assert.equal(choose({ currentHealth: 'auth_failed', providerUsage: authoritative(30) }).profile, 'codex-azure');
  });

  it('does not switch to Sol, lower effort, or an unpinned fallback', () => {
    for (const override of [
      { model: 'gpt-5.6-sol' }, { reasoning_effort: 'medium' }, { reasoning_effort: 'xhigh' },
      { model: undefined }, { reasoning_effort: undefined },
    ]) {
      const result = choose({ profiles: {
        ...pinnedProfiles, 'codex-azure': { ...pinnedProfiles['codex-azure'], ...override },
      } });
      assert.deepEqual(result, { profile: 'codex-subscription', reason: 'fallback_chain_exhausted' });
    }
  });

  it('does not recover or wrap into a different model', () => {
    const changedProfiles = { ...pinnedProfiles, 'codex-subscription': {
      ...pinnedProfiles['codex-subscription'], model: 'gpt-5.6-sol',
    } };
    for (const extra of [{}, { currentHealth: 'down', wrapOnExhausted: true }]) {
      assert.equal(choose({ currentProfile: 'codex-azure', profiles: changedProfiles,
        providerUsage: authoritative(1), ...extra }).profile, 'codex-azure');
    }
  });

  it('rejects absent matching profiles and respects quarantine during policy convergence', () => {
    assert.equal(choose({ requiredModel: 'unavailable-model' }).reason, 'model_policy_has_no_eligible_profile');
    assert.equal(choose({ currentProfile: 'removed-profile', blockedProfiles: ['codex-subscription'] }).profile, 'codex-azure');
    assert.equal(choose({ currentProfile: 'removed-profile', blockedProfiles: policy.chain }).reason,
      'model_policy_has_no_eligible_profile');
  });

  it('ignores rollout observations, stale or future samples for quota switching and recovery', () => {
    const invalidSamples = [
      { quota_authoritative: false }, { quota_authoritative: undefined },
      { observed_at: new Date(nowMs - 181_000).toISOString() },
      { observed_at: new Date(nowMs + 31_000).toISOString() },
      { observed_at: 'invalid-date' }, { observed_at: undefined, fetched_at: undefined },
    ];
    for (const extra of invalidSamples) {
      assert.equal(choose({ providerUsage: authoritative(98, extra) }).profile, 'codex-subscription');
      assert.equal(choose({ currentProfile: 'codex-azure', providerUsage: authoritative(39, extra) }).profile, 'codex-azure');
    }
    assert.equal(choose({ currentProfile: 'codex-azure', providerUsage: authoritative(39) }).profile, 'codex-subscription');
  });

  it('requires a new observation after a window resets instead of inventing zero usage', () => {
    const value = authoritative(98);
    value.providers.codex.primary.resets_at = new Date(nowMs - 1).toISOString();
    assert.equal(choose({ currentProfile: 'codex-azure', providerUsage: value }).profile, 'codex-azure');
    assert.equal(choose({ providerUsage: value }).profile, 'codex-subscription');
  });

  it('wires the same policy through both multi-persona and single-session planners', () => {
    const document = {
      runtime_profiles: pinnedProfiles, runtime_failover: policy,
      instances: { group: { runtime: 'codex', runtime_profile: 'codex-azure', runtime_failover_enabled: true,
        tmux_session: 'claude-group', marker: 'preserve-me' } },
    };
    const multi = planRuntimeFailover({ document, providerUsage: authoritative(39), nowMs });
    assert.equal(multi.document.instances.group.runtime_profile, 'codex-subscription');
    assert.equal(multi.document.instances.group.marker, 'preserve-me');
    assert.equal(planRuntimeFailover({ document, providerUsage: authoritative(1, { quota_authoritative: false }), nowMs }).changes.length, 0);
    const single = { runtime_profiles: pinnedProfiles, runtime_failover: policy, active_profile: 'codex-azure',
      persona_id: 'single', tmux_session: 'claude-main' };
    assert.equal(planSingleSessionRuntimeFailover({ document: single, providerUsage: authoritative(39), nowMs }).document.active_profile, 'codex-subscription');
    assert.equal(planSingleSessionRuntimeFailover({ document: single, providerUsage: authoritative(1, { quota_authoritative: false }), nowMs }).changes.length, 0);
  });
});

describe('runtime failover selection', () => {
  it('moves Claude subscription to Codex subscription when Claude is full', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'claude-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 99, codex: 20 }),
      switchThreshold: 98,
      recoverThreshold: 80,
    });
    assert.deepEqual(result, {
      profile: 'codex-subscription',
      reason: 'usage_exhausted:claude',
    });
  });

  it('moves Codex subscription to unmetered Azure after Codex fills', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 99, codex: 100 }),
      switchThreshold: 98,
      recoverThreshold: 80,
    });
    assert.equal(result.profile, 'codex-azure');
    assert.equal(result.reason, 'usage_exhausted:codex');
  });

  it('uses health rate_limited as an immediate failover signal', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 99 }),
      currentHealth: 'rate_limited',
      switchThreshold: 98,
      recoverThreshold: 80,
    });
    assert.equal(result.profile, 'codex-azure');
    assert.equal(result.reason, 'health_rate_limited:codex-subscription');
  });

  for (const health of ['auth_failed', 'degraded', 'down']) {
    it(`moves to the next provider when runtime health is ${health}`, () => {
      const result = chooseRuntimeProfile({
        currentProfile: 'claude-subscription',
        chain: Object.keys(profiles),
        profiles,
        providerUsage: usage({ claude: 10, codex: 20 }),
        currentHealth: health,
      });

      assert.deepEqual(result, {
        profile: 'codex-subscription',
        reason: `health_${health}:claude-subscription`,
      });
    });
  }

  it('does not auto-recover into a quarantined provider', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 10, codex: 20 }),
      blockedProfiles: ['claude-subscription'],
      changedAtMs: 1_000,
      nowMs: 10_000,
      minDwellMs: 1_000,
    });

    assert.deepEqual(result, { profile: 'codex-subscription', reason: 'no_change' });
  });

  it('skips a quarantined fallback tier when moving forward', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'claude-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 10, codex: 20 }),
      currentHealth: 'degraded',
      blockedProfiles: ['codex-subscription'],
    });

    assert.deepEqual(result, {
      profile: 'codex-azure',
      reason: 'health_degraded:claude-subscription',
    });
  });

  it('respects dwell before chaining a new profile through another health failure', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 10, codex: 20 }),
      currentHealth: 'degraded',
      changedAtMs: 9_500,
      nowMs: 10_000,
      minDwellMs: 1_000,
    });

    assert.deepEqual(result, { profile: 'codex-subscription', reason: 'no_change' });
  });

  it('fails back to the preferred subscription only after recovery and dwell', () => {
    const tooSoon = chooseRuntimeProfile({
      currentProfile: 'codex-azure',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 20, codex: 30 }),
      switchThreshold: 98,
      recoverThreshold: 80,
      changedAtMs: 9_900,
      nowMs: 10_000,
      minDwellMs: 1_000,
    });
    assert.equal(tooSoon.profile, 'codex-azure');

    const recovered = chooseRuntimeProfile({
      currentProfile: 'codex-azure',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 20, codex: 30 }),
      switchThreshold: 98,
      recoverThreshold: 80,
      changedAtMs: 1_000,
      nowMs: 10_000,
      minDwellMs: 1_000,
    });
    assert.deepEqual(recovered, {
      profile: 'claude-subscription',
      reason: 'preferred_provider_recovered:claude',
    });
  });

  it('recovers off a frozen exhausted window once its reset time passes', () => {
    // Monitor files stop refreshing the moment the persona runs Codex, so the
    // Claude reading can stay frozen at 100%. The published reset epoch is the
    // only signal that the weekly window has actually rolled over.
    const frozenClaude = {
      providers: {
        claude: {
          available: true,
          secondary: { used_percent: 100, resets_at: '2026-07-18T02:00:00.000Z' },
        },
        codex: {
          available: true,
          secondary: { used_percent: 24, resets_at: '2026-07-23T04:15:56.000Z' },
        },
      },
    };
    const base = {
      currentProfile: 'codex-subscription',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: frozenClaude,
      switchThreshold: 98,
      recoverThreshold: 80,
      changedAtMs: Date.parse('2026-07-14T23:56:37.904Z'),
      minDwellMs: 300_000,
    };

    const beforeReset = chooseRuntimeProfile({ ...base, nowMs: Date.parse('2026-07-16T15:00:00Z') });
    assert.deepEqual(beforeReset, { profile: 'codex-subscription', reason: 'no_change' });

    const afterReset = chooseRuntimeProfile({ ...base, nowMs: Date.parse('2026-07-18T02:00:01Z') });
    assert.deepEqual(afterReset, {
      profile: 'claude-subscription',
      reason: 'preferred_provider_recovered:claude',
    });
  });

  it('keeps a manually selected API profile active when auto recovery is disabled', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-azure',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 20, codex: 30 }),
      changedAtMs: 1_000,
      nowMs: 10_000,
      minDwellMs: 1_000,
      autoRecover: false,
    });

    assert.deepEqual(result, { profile: 'codex-azure', reason: 'no_change' });
  });

  it('wraps an unhealthy active API profile to an available subscription tier', () => {
    const result = chooseRuntimeProfile({
      currentProfile: 'codex-azure',
      chain: Object.keys(profiles),
      profiles,
      providerUsage: usage({ claude: 99, codex: 30 }),
      currentHealth: 'rate_limited',
      wrapOnExhausted: true,
    });

    assert.deepEqual(result, {
      profile: 'codex-subscription',
      reason: 'health_rate_limited_wrap:codex-azure',
    });
  });

  it('plans only opted-in instances and preserves stable tmux identities', () => {
    const document = {
      runtime_profiles: profiles,
      runtime_failover: {
        enabled: true,
        chain: Object.keys(profiles),
        switch_threshold: 98,
        recover_threshold: 80,
        min_dwell_sec: 0,
      },
      instances: {
        admin: {
          runtime: 'claude',
          runtime_profile: 'claude-subscription',
          runtime_failover_enabled: true,
          tmux_session: 'claude-main',
        },
        scheduler: {
          runtime: 'claude',
          runtime_profile: 'claude-subscription',
          runtime_failover_enabled: false,
          tmux_session: 'claude-scheduler',
        },
      },
    };

    const plan = planRuntimeFailover({
      document,
      providerUsage: usage({ claude: 99, codex: 10 }),
      healthByInstance: { admin: 'ok', scheduler: 'ok' },
      nowMs: 10_000,
    });

    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].instanceId, 'admin');
    assert.equal(plan.changes[0].tmuxSession, 'claude-main');
    assert.equal(plan.document.instances.admin.runtime, 'codex');
    assert.equal(plan.document.instances.admin.runtime_profile, 'codex-subscription');
    assert.equal(plan.document.instances.scheduler.runtime, 'claude');
  });

  it('quarantines a functionally broken profile across later planning cycles', () => {
    const document = {
      runtime_profiles: profiles,
      runtime_failover: {
        enabled: true,
        chain: Object.keys(profiles),
        switch_threshold: 98,
        recover_threshold: 80,
        min_dwell_sec: 0,
      },
      instances: {
        admin: {
          runtime: 'claude',
          runtime_profile: 'claude-subscription',
          runtime_failover_enabled: true,
          tmux_session: 'claude-main',
        },
      },
    };

    const failed = planRuntimeFailover({
      document,
      providerUsage: usage({ claude: 10, codex: 20 }),
      healthByInstance: { admin: 'auth_failed' },
      nowMs: 10_000,
    });

    assert.equal(failed.document.instances.admin.runtime_profile, 'codex-subscription');
    assert.deepEqual(failed.document.instances.admin.runtime_failover_blocked_profiles, {
      'claude-subscription': {
        health: 'auth_failed',
        blocked_at: '1970-01-01T00:00:10.000Z',
      },
    });

    const stable = planRuntimeFailover({
      document: failed.document,
      providerUsage: usage({ claude: 10, codex: 20 }),
      healthByInstance: { admin: 'ok' },
      nowMs: 20_000,
    });

    assert.equal(stable.changes.length, 0);
    assert.equal(stable.document.instances.admin.runtime_profile, 'codex-subscription');
  });

  it('switches only engine metadata for upstream single-session Zylos', () => {
    const document = {
      persona_id: 'bohe',
      active_profile: 'claude-subscription',
      tmux_session: 'claude-main',
      monitor_name: 'activity-monitor',
      workspace: '/home/xingfanxia/zylos',
      runtime_profiles: profiles,
      runtime_failover: {
        enabled: true,
        chain: Object.keys(profiles),
        switch_threshold: 98,
        recover_threshold: 80,
        min_dwell_sec: 0,
      },
    };

    const plan = planSingleSessionRuntimeFailover({
      document,
      providerUsage: usage({ claude: 100, codex: 8 }),
      nowMs: 10_000,
    });

    assert.equal(plan.changes.length, 1);
    assert.deepEqual(plan.changes[0], {
      instanceId: 'bohe',
      fromProfile: 'claude-subscription',
      toProfile: 'codex-subscription',
      runtime: 'codex',
      reason: 'usage_exhausted:claude',
      tmuxSession: 'claude-main',
      monitorName: 'activity-monitor',
      singleSession: true,
    });
    assert.equal(plan.document.workspace, document.workspace);
    assert.equal(plan.document.persona_id, document.persona_id);
    assert.equal(plan.document.active_runtime, 'codex');
    assert.equal(plan.document.active_profile, 'codex-subscription');
    assert.deepEqual(document, {
      persona_id: 'bohe',
      active_profile: 'claude-subscription',
      tmux_session: 'claude-main',
      monitor_name: 'activity-monitor',
      workspace: '/home/xingfanxia/zylos',
      runtime_profiles: profiles,
      runtime_failover: {
        enabled: true,
        chain: Object.keys(profiles),
        switch_threshold: 98,
        recover_threshold: 80,
        min_dwell_sec: 0,
      },
    });
  });

  it('quarantines an unhealthy profile in single-session mode too', () => {
    const document = {
      persona_id: 'bohe',
      active_profile: 'claude-subscription',
      runtime_profiles: profiles,
      runtime_failover: {
        enabled: true,
        chain: Object.keys(profiles),
        min_dwell_sec: 0,
      },
    };

    const failed = planSingleSessionRuntimeFailover({
      document,
      providerUsage: usage({ claude: 10, codex: 20 }),
      currentHealth: 'degraded',
      nowMs: 10_000,
    });

    assert.equal(failed.document.active_profile, 'codex-subscription');
    assert.deepEqual(failed.document.runtime_failover_blocked_profiles, {
      'claude-subscription': {
        health: 'degraded',
        blocked_at: '1970-01-01T00:00:10.000Z',
      },
    });
  });
});

describe('runtime switch signaling', () => {
  it('writes a private cold-start signal for the replacement profile', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-switch-'));
    let signalPath;

    try {
      signalPath = writeRuntimeSwitchSignal({
        zylosDir,
        change: {
          instanceId: 'user-elaine',
          fromProfile: 'claude-subscription',
          toProfile: 'codex-subscription',
          reason: 'health_degraded:claude-subscription',
        },
        nowMs: 10_000,
        graceSec: 30,
      });

      assert.equal(signalPath, path.join(zylosDir, '.zylos', 'runtime-switches', 'user-elaine.json'));
      assert.deepEqual(JSON.parse(fs.readFileSync(signalPath, 'utf8')), {
        version: 1,
        instance_id: 'user-elaine',
        from_profile: 'claude-subscription',
        to_profile: 'codex-subscription',
        reason: 'health_degraded:claude-subscription',
        switched_at: '1970-01-01T00:00:10.000Z',
        grace_sec: 30,
      });
      assert.equal(fs.statSync(signalPath).mode & 0o777, 0o600);
    } finally {
      assert.equal(fs.statSync(path.dirname(signalPath)).mode & 0o777, 0o700);
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});
