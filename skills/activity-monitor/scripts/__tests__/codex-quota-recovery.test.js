import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { refreshQuotaRecoveryProofs, probeCodexQuotaRecovery, verifiedQuotaRecoveries, readCurrentSubscriptionAccountKeys } from '../codex-quota-recovery.js';
import { planSingleSessionRuntimeFailover, planRuntimeFailover } from '../runtime-failover.js';

const start = Date.parse('2026-09-09T13:24:00Z');
const profiles = { sub: { runtime: 'codex', usage_provider: 'codex', codex_home: '/fixture', model: 'gpt-6-astra', reasoning_effort: 'medium' }, azure: { runtime: 'codex', usage_provider: null } };
const policy = { enabled: true, chain: ['sub', 'azure'], auto_recover: true, min_dwell_sec: 300 };
const quota = { providers: { codex: { account_key: 'account-a', available: true, secondary: { used_percent: 60, resets_at: '2026-09-15T18:52:07Z' } } } };
const initial = { active_profile: 'sub', runtime_profiles: profiles, runtime_failover: policy };
function proof(hold, now = start + 301000) { return { profile_id: 'sub', blocked_at: hold.blocked_at, account_key: 'account-a', model: 'gpt-6-astra', reasoning_effort: 'medium', ok: true, started_at: new Date(now - 1000).toISOString(), observed_at: new Date(now).toISOString() }; }

test('actual QA stale 60% cannot bounce after structured quota failure; newer same-model success allows recovery', () => {
  const failed = planSingleSessionRuntimeFailover({ currentSubscriptionAccountKeys: { sub: 'account-a' }, document: initial, providerUsage: quota, currentHealth: 'rate_limited', nowMs: start });
  assert.equal(failed.document.active_profile, 'azure');
  const hold = failed.document.runtime_failover_blocked_profiles.sub;
  assert.equal(hold.health, 'rate_limited');
  for (const nowMs of [start + 301000, start + 86400000]) {
    assert.equal(planSingleSessionRuntimeFailover({ currentSubscriptionAccountKeys: { sub: 'account-a' }, document: failed.document, providerUsage: quota, nowMs }).changes.length, 0);
  }
  const verified = { ...quota, quota_recovery: { sub: proof(hold) } };
  const recovered = planSingleSessionRuntimeFailover({ currentSubscriptionAccountKeys: { sub: 'account-a' }, document: failed.document, providerUsage: verified, nowMs: start + 302000 });
  assert.equal(recovered.document.active_profile, 'sub');
  assert.deepEqual(recovered.document.runtime_failover_blocked_profiles, {});
});

test('old, failed, wrong-account/model/effort proofs and earlier failure receipts cannot clear quota holds', () => {
  const hold = { health: 'rate_limited', blocked_at: new Date(start).toISOString() };
  const good = proof(hold);
  for (const delta of [{ account_key: 'other' }, { model: 'other' }, { reasoning_effort: 'high' }, { ok: false }, { observed_at: new Date(start - 1).toISOString() }, { started_at: new Date(start - 1).toISOString() }]) {
    assert.deepEqual(verifiedQuotaRecoveries({ currentAccountKeys: { sub: 'account-a' }, blockedProfiles: { sub: hold }, profiles, providerUsage: { ...quota, quota_recovery: { sub: { ...good, ...delta } } }, nowMs: start + 302000 }), []);
  }
  assert.deepEqual(verifiedQuotaRecoveries({ currentAccountKeys: { sub: 'account-a' }, blockedProfiles: { sub: hold }, profiles, providerUsage: { ...quota, quota_recovery: { sub: good } }, nowMs: start + 1000000 }), []);
  assert.deepEqual(verifiedQuotaRecoveries({ currentAccountKeys: { sub: 'account-a' }, blockedProfiles: { sub: { ...hold, health: 'auth_failed' } }, profiles, providerUsage: { ...quota, quota_recovery: { sub: good } }, nowMs: start + 302000 }), []);
});

test('multi-instance holds remain separate and preserve functional quarantine', () => {
  const document = { runtime_profiles: profiles, runtime_failover: policy, instances: { one: { runtime_profile: 'sub', runtime_failover_enabled: true }, two: { runtime_profile: 'azure', runtime_failover_enabled: true, runtime_failover_blocked_profiles: { sub: { health: 'auth_failed', blocked_at: '2026-09-09T12:00:00Z' } } } } };
  const failed = planRuntimeFailover({ currentSubscriptionAccountKeys: { one: { sub: 'account-a' }, two: { sub: 'account-a' } }, document, providerUsage: quota, healthByInstance: { one: 'rate_limited', two: 'ok' }, nowMs: start });
  const held = failed.document.instances.one.runtime_failover_blocked_profiles.sub;
  const recovered = planRuntimeFailover({ currentSubscriptionAccountKeys: { one: { sub: 'account-a' }, two: { sub: 'account-a' } }, document: failed.document, providerUsage: { ...quota, quota_recovery: { sub: proof(held) } }, nowMs: start + 302000 });
  assert.equal(recovered.document.instances.one.runtime_profile, 'sub');
  assert.equal(recovered.document.instances.two.runtime_profile, 'azure');
  assert.equal(recovered.document.instances.two.runtime_failover_blocked_profiles.sub.health, 'auth_failed');
});

test('only held profiles run probes, failures throttle, new account prompts new proof', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0, account = 'account-a', nowMs = start + 301000;
  const opts = { zylosDir: root, now: () => nowMs, identityImpl: () => ({ accountKey: account }), probeImpl: async () => { calls++; return { ok: false, account_key: account }; } };
  await refreshQuotaRecoveryProofs({ ...opts, document: initial }); assert.equal(calls, 0);
  const held = { ...initial, active_profile: 'azure', runtime_failover_blocked_profiles: { sub: { health: 'rate_limited', blocked_at: new Date(start).toISOString() } } };
  await refreshQuotaRecoveryProofs({ ...opts, document: held }); assert.equal(calls, 1);
  nowMs += 300000;
  await refreshQuotaRecoveryProofs({ ...opts, document: held }); assert.equal(calls, 1);
  account = 'account-b';
  await refreshQuotaRecoveryProofs({ ...opts, document: held }); assert.equal(calls, 2);
  nowMs += 601000;
  await refreshQuotaRecoveryProofs({ ...opts, document: held }); assert.equal(calls, 3);
});

function fixtureAuth(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-auth-')); fs.chmodSync(root, 0o700);
  const token = Buffer.from(JSON.stringify({ sub: 'test-subject' })).toString('base64url');
  fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'test-account', id_token: `x.${token}.x` } }), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fakeChild(onSpawn, lines) {
  return (bin, args, options) => {
    onSpawn(bin, args, options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => child.emit('exit', 1);
    queueMicrotask(() => { for (const line of lines) child.stdout.write(JSON.stringify(line) + '\n'); child.emit('exit', 0); });
    return child;
  };
}
const success = [{ type: 'item.completed', item: { type: 'agent_message', text: 'SUBSCRIPTION_RECOVERED' } }, { type: 'turn.completed' }];

test('functional probe isolates user config/tools, uses exact model/effort and removes temporary credentials', async t => {
  const home = fixtureAuth(t); let temporary;
  const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', effort: 'medium', codexBin: '/raw/codex', spawnImpl: fakeChild((bin, args, options) => {
    assert.equal(bin, '/raw/codex'); assert.ok(args.includes('gpt-6-astra')); assert.ok(args.includes('model_reasoning_effort="medium"'));
    temporary = options.env.CODEX_HOME; assert.notEqual(temporary, home); assert.equal(options.cwd, temporary); assert.equal(options.env.HOME, temporary);
    assert.equal(options.env.AZURE_FOUNDRY_KEY, undefined);
    const config = fs.readFileSync(path.join(temporary, 'config.toml'), 'utf8'); assert.match(config, /shell_tool = false/); assert.match(config, /plugins = false/);
  }, success) });
  assert.equal(result.ok, true); assert.equal(fs.existsSync(temporary), false);
});

test('tool execution, provider errors or account rotation cannot create a success proof', async t => {
  const home = fixtureAuth(t);
  for (const extra of [{ type: 'item.started', item: { type: 'command_execution' } }, { type: 'turn.failed' }]) {
    const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', spawnImpl: fakeChild(() => {}, [extra, ...success]) });
    assert.equal(result.ok, false);
  }
  const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', spawnImpl: fakeChild(() => {
    const file = path.join(home, 'auth.json'), auth = JSON.parse(fs.readFileSync(file)); auth.tokens.account_id = 'other'; fs.writeFileSync(file, JSON.stringify(auth));
  }, success) });
  assert.equal(result.ok, false);
});


test('current per-persona account metadata prevents reuse of a global proof after divergence', t => {
  const keys = readCurrentSubscriptionAccountKeys({ ...initial, instances: { one: { os_user: 'alice' }, two: { os_user: 'bob' } }, runtime_profiles: { ...profiles, sub: { ...profiles.sub, codex_home: '~/.codex-subscription' } } }, {
    homeForUser: user => `/home/${user}`, readAccountKey: home => home.includes('alice') ? 'account-a' : 'account-b',
  });
  assert.deepEqual(keys, { one: { sub: 'account-a' }, two: { sub: 'account-b' } });
  const failed = planSingleSessionRuntimeFailover({ document: initial, providerUsage: quota, currentSubscriptionAccountKeys: { sub: 'account-a' }, currentHealth: 'rate_limited', nowMs: start });
  const recovered = planSingleSessionRuntimeFailover({ document: failed.document, providerUsage: { ...quota, quota_recovery: { sub: proof(failed.document.runtime_failover_blocked_profiles.sub) } }, currentSubscriptionAccountKeys: { sub: 'account-b' }, nowMs: start + 302000 });
  assert.equal(recovered.document.active_profile, 'azure');
});

test('one newer same-account proof can clear older holds while a failure during the probe remains held', () => {
  const old = { health: 'rate_limited', blocked_at: new Date(start - 1000).toISOString() };
  const newer = { health: 'rate_limited', blocked_at: new Date(start + 500).toISOString() };
  const p = { ...proof(old), started_at: new Date(start).toISOString() };
  const args = { currentAccountKeys: { sub: 'account-a' }, profiles, providerUsage: { ...quota, quota_recovery: { sub: p } }, nowMs: start + 302000 };
  assert.deepEqual(verifiedQuotaRecoveries({ ...args, blockedProfiles: { sub: old } }), ['sub']);
  assert.deepEqual(verifiedQuotaRecoveries({ ...args, blockedProfiles: { sub: newer } }), []);
});

test('recovery probe timeout is bounded and always removes private credentials', async t => {
  const home = fixtureAuth(t); let temporary, killed = false;
  const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', timeoutMs: 5, spawnImpl: (_bin, _args, options) => {
    temporary = options.cwd;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { killed = true; };
    return child;
  } });
  assert.equal(result.ok, false); assert.equal(killed, true); assert.equal(fs.existsSync(temporary), false);
});

test('canary OAuth refresh is retained in original auth inode without exposing tokens', async t => {
  const home = fixtureAuth(t), authFile = path.join(home, 'auth.json');
  const before = fs.statSync(authFile);
  const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', spawnImpl: fakeChild((_bin, _args, options) => {
    const file = path.join(options.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file)); auth.tokens.refresh_token = 'synthetic-rotated-token'; fs.writeFileSync(file, JSON.stringify(auth));
  }, success) });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(authFile)).tokens.refresh_token, 'synthetic-rotated-token');
  assert.equal(fs.statSync(authFile).ino, before.ino); assert.equal(fs.statSync(authFile).mode, before.mode);
  assert.equal(JSON.stringify(result).includes('synthetic-rotated-token'), false);
});

test('canary token refresh never overwrites a concurrent operator credential update', async t => {
  const home = fixtureAuth(t), authFile = path.join(home, 'auth.json');
  const result = await probeCodexQuotaRecovery({ codexHome: home, model: 'gpt-6-astra', spawnImpl: fakeChild((_bin, _args, options) => {
    const file = path.join(options.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file)); auth.tokens.refresh_token = 'synthetic-canary-refresh'; fs.writeFileSync(file, JSON.stringify(auth));
    auth.tokens.refresh_token = 'synthetic-operator-update'; fs.writeFileSync(authFile, JSON.stringify(auth));
  }, success) });
  assert.equal(result.ok, false); assert.equal(result.error, 'concurrent_change');
  assert.equal(JSON.parse(fs.readFileSync(authFile)).tokens.refresh_token, 'synthetic-operator-update');
});


test('disabled automatic recovery never runs background model probes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const document = { ...initial, active_profile: 'azure', runtime_failover: { ...policy, auto_recover: false }, runtime_failover_blocked_profiles: { sub: { health: 'rate_limited', blocked_at: new Date(start).toISOString() } } };
  assert.deepEqual(await refreshQuotaRecoveryProofs({ zylosDir: root, document, probeImpl: () => { throw Error('must not call'); } }), {});
});

test('unhealthy Azure can return to a proven recovered subscription without enabling wrap', () => {
  const failed = planSingleSessionRuntimeFailover({ document: initial, providerUsage: quota, currentSubscriptionAccountKeys: { sub: 'account-a' }, currentHealth: 'rate_limited', nowMs: start });
  const result = planSingleSessionRuntimeFailover({ document: failed.document, providerUsage: { ...quota, quota_recovery: { sub: proof(failed.document.runtime_failover_blocked_profiles.sub) } }, currentSubscriptionAccountKeys: { sub: 'account-a' }, currentHealth: 'degraded', nowMs: start + 302000 });
  assert.equal(result.document.active_profile, 'sub');
  assert.equal(result.document.runtime_failover_blocked_profiles.azure.health, 'degraded');
});
