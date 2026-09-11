import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('six-persona controller persists exhaustion, Azure fallback and fresh subscription recovery without touching live state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbox-quota-cycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.ZYLOS_DIR = root;
  const { applyRuntimeFailover } = await import('../runtime-failover.js');
  const { HealthEngine } = await import('../health-engine.js');
  const { detectCodexQuotaFromLines } = await import('../../../../cli/lib/heartbeat/codex-probe.js');
  let nowMs = Date.now();
  const ids = ['admin', 'scheduler', 'user-pan', 'group', 'user-elaine', 'user-sean'];
  const authHome = path.join(root, 'subscription'); fs.mkdirSync(authHome, { mode: 0o700 });
  const claims = Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url');
  fs.writeFileSync(path.join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'fixture-account', id_token: `e30.${claims}.sig` } }), { mode: 0o600 });
  const { readSubscriptionAccountKey } = await import('../codex-account-usage.js');
  const accountKey = readSubscriptionAccountKey(authHome);
  const document = { runtime_profiles: {
    'codex-subscription': { runtime: 'codex', usage_provider: 'codex', codex_home: authHome, model: 'gpt-6-astra', reasoning_effort: 'medium' },
    'codex-azure': { runtime: 'codex', usage_provider: null, model: 'gpt-6-astra', reasoning_effort: 'medium' },
  }, runtime_failover: { enabled: true, chain: ['codex-subscription', 'codex-azure'], auto_recover: true,
    min_dwell_sec: 300, usage_max_age_sec: 180, required_model: 'gpt-6-astra', required_reasoning_effort: 'medium' },
  routing: { sample: 'user-pan' }, instances: Object.fromEntries(ids.map(id => [id, {
    runtime: 'codex', runtime_profile: 'codex-subscription', runtime_failover_enabled: true,
    state_dir: path.join(root, 'activity-monitor', id), tmux_session: `fixture-${id}`, preserve: `${id}-context`,
  }])) };
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify(document), { mode: 0o640 });
  const observations = (used, observedMs = nowMs) => ({ providers: { codex: { available: true,
    account_key: accountKey, quota_authoritative: true, observed_at: new Date(observedMs).toISOString(), source: 'codex-account-api',
    primary: { used_percent: used, resets_at: new Date(nowMs + 3600000).toISOString() }, } } });
  const terminal = JSON.stringify({ type: 'event_msg', timestamp: new Date(nowMs).toISOString(),
    payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } } });
  const engine = new HealthEngine({ detectStructuredRateLimit: () => detectCodexQuotaFromLines([terminal]),
    readHeartbeatPending: () => null, clearHeartbeatPending() {}, log() {} }, { heartbeatEnabled: false, now: () => nowMs });
  t.after(() => engine.destroy());
  engine.runMaintenanceCycle(true, Math.floor(nowMs / 1000));
  assert.equal(engine.health, 'rate_limited');
  for (const id of ids) {
    const dir = document.instances[id].state_dir; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-status.json'), JSON.stringify({ health: engine.health }));
  }
  const effects = [];
  const apply = providerUsage => applyRuntimeFailover({ providerUsage, nowMs, log() {},
    execFileSyncImpl: (command, args) => effects.push({ command, args }) });
  const down = apply(observations(60)); // terminal quota beats a still-low numeric sample
  assert.equal(down.length, 6);
  assert(down.every(x => x.toProfile === 'codex-azure'));
  assert.equal(effects.filter(x => x.command === 'pm2').length, 6);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'instances.json')));
  assert.deepEqual(onDisk.routing, document.routing);
  for (const id of ids) {
    assert.equal(onDisk.instances[id].preserve, `${id}-context`);
    fs.writeFileSync(path.join(document.instances[id].state_dir, 'agent-status.json'), JSON.stringify({ health: 'ok' }));
  }
  nowMs += 301000;
  assert.equal(apply(observations(0, nowMs - 181000)).length, 0, 'stale low usage must not recover');
  assert.equal(apply(observations(100)).length, 0, 'exhausted account must stay on Azure');
  assert.equal(apply(observations(20)).length, 0, 'fresh generic low quota alone cannot clear a model quota failure');
  const proof = observations(20); proof.quota_recovery = { 'codex-subscription': { profile_id: 'codex-subscription', account_key: accountKey, model: 'gpt-6-astra', reasoning_effort: 'medium', ok: true, started_at: new Date(nowMs - 1).toISOString(), observed_at: new Date(nowMs).toISOString() } };
  const recovered = apply(proof);
  assert.equal(recovered.length, 6);
  assert(recovered.every(x => x.toProfile === 'codex-subscription' && x.reason === 'preferred_provider_recovered:codex'));
  assert.equal(effects.filter(x => x.command === 'pm2').length, 12);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'instances.json')));
  for (const id of ids) assert.equal(after.instances[id].preserve, `${id}-context`);
});
