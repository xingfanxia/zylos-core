import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planSingleSessionRuntimeFailover } from '../runtime-failover.js';

describe('single-session hold_profiles and ineligible_profiles (Claude -> Codex -> Azure)', () => {
  const nowMs = Date.parse('2026-09-29T22:00:00Z');
  const profiles = {
    'claude-subscription': { runtime: 'claude', usage_provider: 'claude' },
    'codex-subscription': { runtime: 'codex', usage_provider: 'codex', codex_home: '~/.codex-subscription' },
    'codex-azure': { runtime: 'codex', usage_provider: null, codex_home: '~/.codex-azure' },
  };
  const seen = value => ({ available: true, quota_authoritative: true, observed_at: new Date(nowMs).toISOString(),
    primary: { used_percent: value, resets_at: '2099-01-01T00:00:00Z' } });
  const plan = (active, { claude = 10, codex = 10, hold, ineligible, changedAgoMs = 600_000 } = {}) => planSingleSessionRuntimeFailover({
    document: {
      persona_id: 'bohe', active_profile: active, active_runtime: profiles[active].runtime, tmux_session: 'claude-main',
      runtime_profiles: profiles, runtime_profile_changed_at: new Date(nowMs - changedAgoMs).toISOString(),
      runtime_failover: { enabled: true, chain: Object.keys(profiles), switch_threshold: 95, recover_threshold: 90,
        min_dwell_sec: 300, auto_recover: true, ...(hold ? { hold_profiles: hold } : {}),
        ...(ineligible ? { ineligible_profiles: ineligible } : {}) },
    },
    providerUsage: { providers: { claude: seen(claude), codex: seen(codex) } },
    nowMs,
  }).changes;

  it('recovers from Codex to the Claude head when its usage is low', () => {
    assert.deepEqual(plan('codex-subscription').map(c => [c.toProfile, c.tmuxSession]), [['claude-subscription', 'claude-main']]);
  });

  it('skips a held Codex tier forward and keeps recovery to Claude open', () => {
    assert.equal(plan('claude-subscription', { claude: 97, hold: ['codex-subscription'] })[0].toProfile, 'codex-azure');
    assert.equal(plan('codex-azure', { hold: ['codex-subscription'] })[0].toProfile, 'claude-subscription');
    assert.equal(plan('codex-azure', { claude: 97, hold: ['codex-subscription'] }).length, 0);
  });

  it('leaves a lapsed Claude tier at once and never recovers into it until removed', () => {
    const [change] = plan('claude-subscription', { ineligible: ['claude-subscription'], changedAgoMs: 1000 });
    assert.deepEqual([change.toProfile, change.reason], ['codex-subscription', 'plan_ineligible:claude-subscription']);
    assert.equal(plan('codex-subscription', { ineligible: ['claude-subscription'] }).length, 0);
    assert.equal(plan('codex-subscription', { ineligible: [] })[0].toProfile, 'claude-subscription');
  });
});
