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
});
