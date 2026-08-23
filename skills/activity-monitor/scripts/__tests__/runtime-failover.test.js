import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chooseRuntimeProfile,
  planRuntimeFailover,
  planSingleSessionRuntimeFailover,
} from '../runtime-failover.js';

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
