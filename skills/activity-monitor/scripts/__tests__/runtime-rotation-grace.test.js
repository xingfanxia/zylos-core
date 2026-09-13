import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { planRuntimeFailover, planSingleSessionRuntimeFailover } from '../runtime-failover.js';
import { readSubscriptionRotationMarkers } from '../codex-quota-recovery.js';
const profiles = {
 'codex-subscription': { runtime: 'codex', usage_provider: 'codex' },
 'codex-azure': { runtime: 'codex', usage_provider: null },
};
function usage({ codex = null } = {}) {
 return { providers: { codex: codex == null ? {available:false} : {available:true,
 primary:{used_percent:codex,resets_at:'2099-01-01T00:00:00Z'}} } };
}
describe('managed account rotation gets first chance before usage fallback', () => {
  const now = Date.parse('2026-09-13T02:00:00Z');
  function doc() { return { runtime_profiles: profiles,
    runtime_failover: { enabled: true, chain: ['codex-subscription', 'codex-azure'], switch_threshold: 95, min_dwell_sec: 300 },
    instances: { admin: { enabled: true, runtime_failover_enabled: true, runtime_profile: 'codex-subscription' } } }; }
  const markers = (at, extra = {}) => ({ admin: { 'codex-subscription': {
    generation: 'a'.repeat(64), available: true, checked_at: at / 1000, ...extra } } });
  const plan = (document, at, extra = {}) => planRuntimeFailover({ document, nowMs: at,
    providerUsage: usage({ codex: 95 }), rotationMarkers: markers(at), ...extra });
  it('waits across daemon restarts and refreshed generations but falls back at the original deadline', () => {
    const first = plan(doc(), now);
    assert.deepEqual(first.changes, []); assert.equal(first.stateChanged, true);
    const saved = JSON.parse(JSON.stringify(first.document));
    const second = plan(saved, now + 90_000, { rotationMarkers: markers(now + 90_000, { generation: 'b'.repeat(64) }) });
    assert.deepEqual(second.changes, []); assert.equal(second.stateChanged, false);
    const last = plan(second.document, now + 120_000);
    assert.equal(last.changes[0].toProfile, 'codex-azure'); assert.equal(last.changes[0].reason, 'usage_exhausted:codex');
    assert.equal(last.document.instances.admin.runtime_usage_rotation_wait, undefined);
  });
  it('successful fresh low-usage handoff cancels the pending fallback', () => {
    const first = plan(doc(), now);
    const next = plan(first.document, now + 60_000, { providerUsage: usage({ codex: 1 }) });
    assert.deepEqual(next.changes, []); assert.equal(next.stateChanged, true);
    assert.equal(next.document.instances.admin.runtime_usage_rotation_wait, undefined);
  });
  it('missing, stale, malformed, future or exhausted pool evidence never defers fallback', () => {
    for (const rotationMarkers of [{}, markers(now - 91_000), markers(now, { generation: 'bad' }),
      markers(now + 31_000), markers(now, { available: false })]) {
      assert.equal(plan(doc(), now, { rotationMarkers }).changes[0].toProfile, 'codex-azure');
    }
  });
  it('actual native health failures bypass usage grace and preserve existing account-bound holds', () => {
    for (const health of ['rate_limited', 'auth_failed', 'degraded', 'down']) {
      const next = plan(doc(), now, { healthByInstance: { admin: health } });
      assert.equal(next.changes[0].toProfile, 'codex-azure'); assert.match(next.changes[0].reason, /^health_/);
    }
  });
  it('an unknown quota poll cannot re-arm a pending grace period', () => {
    const first = plan(doc(), now);
    const unknown = plan(first.document, now + 60_000, { providerUsage: usage({ codex: null }) });
    assert.deepEqual(unknown.changes, []);
    assert.equal(plan(unknown.document, now + 120_000).changes[0].toProfile, 'codex-azure');
  });
  it('simultaneous rotation-marker and quota gaps cannot renew an expired deadline', () => {
    const first = plan(doc(), now);
    const gap = plan(first.document, now + 100_000, { providerUsage: usage({ codex: null }), rotationMarkers: {} });
    assert.deepEqual(gap.changes, []);
    assert.equal(plan(gap.document, now + 130_000).changes[0].toProfile, 'codex-azure');
  });
  it('single-session planning persists the same bounded wait without changing its route', () => {
    const multi = doc();
    const document = { runtime_profiles: multi.runtime_profiles, runtime_failover: multi.runtime_failover, active_profile: 'codex-subscription' };
    const first = planSingleSessionRuntimeFailover({ document, providerUsage: usage({ codex: 95 }),
      rotationMarkers: markers(now).admin, nowMs: now });
    assert.equal(first.stateChanged, true); assert.deepEqual(first.changes, []);
    const next = planSingleSessionRuntimeFailover({ document: first.document, providerUsage: usage({ codex: 95 }),
      rotationMarkers: markers(now + 120_000).admin, nowMs: now + 120_000 });
    assert.equal(next.changes[0].toProfile, 'codex-azure');
  });
});


it('reads rotation evidence from each configured subscription home, failing closed on missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-markers-'));
  try {
    const home = path.join(root, '.codex-subscription'); fs.mkdirSync(home);
    const marker = { generation: 'a'.repeat(64), available: true, checked_at: 123 };
    fs.writeFileSync(path.join(home, 'rotation-generation.json'), JSON.stringify(marker));
    const document = { runtime_profiles: { sub: { usage_provider: 'codex', codex_home: '~/.codex-subscription' } },
      instances: { admin: {}, tenant: { os_user: 'tenant' } } };
    assert.deepEqual(readSubscriptionRotationMarkers(document, { homeForUser: user => user ? path.join(root, 'missing') : root }),
      { admin: { sub: marker }, tenant: { sub: null } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
