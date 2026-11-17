// SWITCH-1: a failed engine start moves the persona by the chain rules, and a
// block clears once a later success proves its profile works again.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failoverHealth, planRuntimeFailover, provenBlockedProfiles } from '../runtime-failover.js';

const nowMs = Date.parse('2026-11-17T03:00:00Z');
const at = offsetSec => new Date(nowMs + offsetSec * 1000).toISOString();
const ms = offsetSec => nowMs + offsetSec * 1000;

// The live ax-devbox chain (profile shapes from instances.json, no secrets).
const profiles = {
  'claude-ax-backup': { runtime: 'claude', usage_provider: 'claude-ax-backup', claude_settings_file: '/home/zylos-shared/auth/claude-ax-backup.settings.json' },
  'claude-ax-cl': { runtime: 'claude', usage_provider: 'claude-ax-cl', claude_settings_file: '/home/zylos-shared/auth/claude-ax-cl.settings.json' },
  'claude-ax-main': { runtime: 'claude', usage_provider: 'claude' },
  'codex-subscription': { runtime: 'codex', usage_provider: 'codex', codex_home: '~/.codex-subscription' },
  'codex-azure': { runtime: 'codex', usage_provider: null, codex_home: '~/.codex-azure', provider_env_key: 'AZURE_FOUNDRY_KEY' },
};
const chain = Object.keys(profiles);
const seen = used => ({ available: true, quota_authoritative: true, observed_at: at(0),
  primary: { used_percent: used, resets_at: '2099-01-01T00:00:00Z' } });
const providerUsage = { providers: { 'claude-ax-backup': seen(40), 'claude-ax-cl': seen(10), claude: seen(10), codex: seen(10) } };

function documentWith(instances) {
  return {
    runtime_profiles: profiles,
    runtime_failover: { enabled: true, chain, switch_threshold: 95, recover_threshold: 90, min_dwell_sec: 300,
      auto_recover: true, usage_max_age_sec: 180 },
    instances,
  };
}
const persona = (extra = {}) => ({ runtime: 'claude', runtime_profile: 'claude-ax-backup', runtime_failover_enabled: true, ...extra });

describe('start_failed health', () => {
  it('is what an account-class start failure on the current profile means, and nothing else is', () => {
    const instance = { runtime_profile: 'claude-ax-backup' };
    const failure = cls => ({ health: 'ok', start_failure: { class: cls, profile: 'claude-ax-backup' } });
    assert.equal(failoverHealth(failure('account'), instance), 'start_failed');
    assert.equal(failoverHealth(failure('local'), instance), 'ok', 'a local cause is held by the Guardian, never chained');
    assert.equal(failoverHealth(failure('fable'), instance), 'ok', 'a Fable-mode failure is the Fable guard\'s');
    assert.equal(failoverHealth(failure('account'), { runtime_profile: 'claude-ax-cl' }), 'ok', 'already moved');
  });

  it('moves to the next tier inside the dwell window and blocks the tier that would not start', () => {
    const document = documentWith({ 'user-sean': persona({ os_user: 'zylos-sean', runtime_profile_changed_at: at(-60) }) });
    const planned = planRuntimeFailover({ document, providerUsage, healthByInstance: { 'user-sean': 'start_failed' }, nowMs });
    assert.equal(planned.changes.length, 1);
    assert.equal(planned.changes[0].toProfile, 'claude-ax-cl');
    assert.equal(planned.changes[0].reason, 'health_start_failed:claude-ax-backup');
    assert.deepEqual(planned.document.instances['user-sean'].runtime_failover_blocked_profiles,
      { 'claude-ax-backup': { health: 'start_failed', blocked_at: at(0) } });
  });

  it('a broken tier that also fails to start is skipped in turn, never flapped back into', () => {
    const document = documentWith({ admin: persona({ runtime_profile: 'claude-ax-cl', runtime_profile_changed_at: at(-90),
      runtime_failover_blocked_profiles: { 'claude-ax-backup': { health: 'start_failed', blocked_at: at(-90) } } }) });
    const planned = planRuntimeFailover({ document, providerUsage, healthByInstance: { admin: 'start_failed' }, nowMs });
    assert.equal(planned.changes[0].toProfile, 'claude-ax-main');
    assert.deepEqual(Object.keys(planned.document.instances.admin.runtime_failover_blocked_profiles).sort(),
      ['claude-ax-backup', 'claude-ax-cl']);
  });
});

describe('blocks clear on fresh proof', () => {
  const blocked = (profileId, health, offsetSec = -600) => ({ [profileId]: { health, blocked_at: at(offsetSec) } });
  const clear = ({ instanceId = 'user-pan', blockedProfiles, successes = {}, fableValidAt = {}, instances, accountKeys = {} }) =>
    provenBlockedProfiles({ instanceId, blockedProfiles, profiles, successes, fableValidAt, accountKeys,
      instances: instances || { 'user-pan': { os_user: 'zylos-pan' }, 'user-elaine': { os_user: 'zylos-elaine' },
        admin: {}, scheduler: {} } }).map(item => item.profileId);

  it('a functional ACK on the profile after the block, by the persona itself, clears every block kind', () => {
    for (const health of ['auth_failed', 'degraded', 'down', 'start_failed', 'rate_limited']) {
      assert.deepEqual(clear({ blockedProfiles: blocked('codex-azure', health),
        successes: { 'user-pan': { profile: 'codex-azure', ackAt: ms(-10), startAt: 0 } } }), ['codex-azure'], health);
    }
  });

  it('an ACK older than the block proves nothing', () => {
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'degraded'),
      successes: { 'user-elaine': { profile: 'claude-ax-backup', ackAt: ms(-700), startAt: 0 } } }), []);
  });

  it('another persona on the same settings-file account proves it; a per-user Azure key proves only its own user', () => {
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'degraded'),
      successes: { 'user-elaine': { profile: 'claude-ax-backup', ackAt: ms(-10), startAt: 0 } } }), ['claude-ax-backup']);
    // 2026-09-21: admin worked on Azure while Pan's shared budget was spent.
    assert.deepEqual(clear({ blockedProfiles: blocked('codex-azure', 'degraded'),
      successes: { admin: { profile: 'codex-azure', ackAt: ms(-10), startAt: 0 } } }), []);
    assert.deepEqual(clear({ instanceId: 'scheduler', blockedProfiles: blocked('codex-azure', 'degraded'),
      successes: { admin: { profile: 'codex-azure', ackAt: ms(-10), startAt: 0 } } }), ['codex-azure'], 'admin and scheduler share a home');
  });

  it('a Codex subscription proves across personas only on the same account', () => {
    const successes = { 'user-elaine': { profile: 'codex-subscription', ackAt: ms(-10), startAt: 0 } };
    assert.deepEqual(clear({ blockedProfiles: blocked('codex-subscription', 'auth_failed'), successes,
      accountKeys: { 'user-pan': { 'codex-subscription': 'k1' }, 'user-elaine': { 'codex-subscription': 'k1' } } }), ['codex-subscription']);
    assert.deepEqual(clear({ blockedProfiles: blocked('codex-subscription', 'auth_failed'), successes,
      accountKeys: { 'user-pan': { 'codex-subscription': 'k1' }, 'user-elaine': { 'codex-subscription': 'k2' } } }), []);
  });

  it('a confirmed engine start clears a start_failed block, not a degraded one', () => {
    const successes = { 'user-elaine': { profile: 'claude-ax-backup', ackAt: 0, startAt: ms(-10) } };
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'start_failed'), successes }), ['claude-ax-backup']);
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'degraded'), successes }), []);
  });

  it('a valid Fable probe of the account clears an auth_failed block on that settings-file profile only', () => {
    const fableValidAt = { 'claude-ax-backup': ms(-10) };
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'auth_failed'), fableValidAt }), ['claude-ax-backup']);
    assert.deepEqual(clear({ blockedProfiles: blocked('claude-ax-backup', 'degraded'), fableValidAt }), []);
  });

  it('the planner removes a proven block for good even when nothing switches, then may recover into it', () => {
    const document = documentWith({
      'user-pan': persona({ os_user: 'zylos-pan', runtime_profile: 'claude-ax-cl', runtime_profile_changed_at: at(-3600),
        runtime_failover_blocked_profiles: blocked('claude-ax-backup', 'degraded') }),
      'user-elaine': persona({ os_user: 'zylos-elaine' }),
    });
    const successes = { 'user-elaine': { profile: 'claude-ax-backup', ackAt: ms(-5), startAt: 0 } };
    const planned = planRuntimeFailover({ document, providerUsage, healthByInstance: {}, successes, nowMs });
    assert.deepEqual(planned.cleared, [{ instanceId: 'user-pan', profileId: 'claude-ax-backup', health: 'degraded', proof: 'success:user-elaine' }]);
    assert.deepEqual(planned.document.instances['user-pan'].runtime_failover_blocked_profiles, {});
    assert.equal(planned.changes[0]?.toProfile, 'claude-ax-backup', 'preferred tier recovered under the usual rule');

    // Without proof the same block still holds, as before.
    const unproven = planRuntimeFailover({ document, providerUsage, healthByInstance: {}, nowMs });
    assert.deepEqual(unproven.cleared, []);
    assert.equal(unproven.changes.length, 0);
  });
});
