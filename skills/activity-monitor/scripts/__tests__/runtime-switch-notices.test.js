import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { processSwitchNotices, switchReady, budgetLines, subscriptionLines, readSwitchBudget, sendToAdmin } from '../runtime-switch-notices.js';

const now = Date.parse('2026-09-09T04:00:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-notices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = { runtime_failover: { notifications: { enabled: true, admin_chat_id: 'oc_admin' } }, instances: {} };
  for (const id of ['admin', 'user-pan', 'user-elaine']) doc.instances[id] = { chat_ids: [id === 'admin' ? 'oc_admin' : 'oc_other'], runtime_profile: 'codex-subscription', runtime_profile_changed_at: new Date(now - 86400_000).toISOString() };
  const write = () => fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify(doc));
  write();
  const calls = [];
  const run = time => processSwitchNotices({ zylosDir: dir, nowMs: time, getBudget: async () => null, send: async x => calls.push(x) });
  const change = () => { for (const id of ['user-pan', 'user-elaine']) Object.assign(doc.instances[id], { runtime_profile: 'codex-azure', runtime_profile_changed_at: new Date(now).toISOString(), runtime_profile_change_reason: 'usage_exhausted:codex' }); write(); };
  return { dir, doc, calls, run, change, write };
}
it('batches two changes once, survives restart/retries, and waits for actual loaded-profile ACK', async t => {
  const f = fixture(t);
  await f.run(now - 1000); assert.equal(f.calls.length, 0);
  f.change(); await f.run(now); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].endpoint, 'oc_admin'); assert.equal(f.calls[0].phase, 'started');
  assert.match(f.calls[0].message, /Pan、Elaine/); assert.match(f.calls[0].message, /还没有确认恢复/);
  await f.run(now + 60001); assert.equal(f.calls.length, 1);
  for (const id of ['user-pan', 'user-elaine']) {
    fs.mkdirSync(path.join(f.dir, 'activity-monitor', id), { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'activity-monitor', id, 'agent-status.json'), JSON.stringify({ health: 'ok', runtime_profile: 'codex-azure', runtime_launch_at: now + 1, functional_ack_at: now - 1, last_check: (now + 60001) / 1000 }));
  }
  await f.run(now + 60001); assert.equal(f.calls.length, 1);
  await f.run(now + 300001); assert.equal(f.calls.at(-1).phase, 'delayed');
  await f.run(now + 360002); assert.equal(f.calls.length, 2);
  for (const id of ['user-pan', 'user-elaine']) fs.writeFileSync(path.join(f.dir, 'activity-monitor', id, 'agent-status.json'), JSON.stringify({ health: 'ok', runtime_profile: 'codex-azure', runtime_launch_at: now + 1, functional_ack_at: now + 380000, last_check: (now + 400000) / 1000 }));
  await f.run(now + 400000); assert.equal(f.calls.at(-1).phase, 'ready');
  await f.run(now + 500000); assert.equal(f.calls.length, 3);
});
it('failed sends retry after a persisted minute and never claim delivery', async t => {
  const f = fixture(t); await f.run(now - 1); f.change();
  await processSwitchNotices({ zylosDir: f.dir, nowMs: now, getBudget: async () => null, send: async () => { throw Error('offline'); }, log: () => {} });
  await f.run(now + 1); assert.equal(f.calls.length, 0);
  await f.run(now + 60001); assert.equal(f.calls.length, 1);
});
it('refuses changed/missing admin route without falling back to a user or group', async t => {
  const f = fixture(t); await f.run(now - 1); f.change(); f.doc.instances.admin.chat_ids = ['oc_wrong']; f.write();
  await f.run(now); assert.equal(f.calls.length, 0);
});
it('a newer switch retires unverified old intent and emits a separate return notice', async t => {
  const f = fixture(t); await f.run(now - 1); f.change(); await f.run(now);
  for (const id of ['user-pan', 'user-elaine']) Object.assign(f.doc.instances[id], { runtime_profile: 'codex-subscription', runtime_profile_changed_at: new Date(now + 60001).toISOString(), runtime_profile_change_reason: 'preferred_provider_recovered:codex' });
  f.write(); await f.run(now + 60001);
  assert.deepEqual(f.calls.map(x => x.phase), ['started', 'superseded', 'started']);
  assert.match(f.calls.at(-1).message, /Azure → Codex 订阅/);
});
it('does not confuse startup/process health with a functional ACK', () => {
  const change = { toProfile: 'codex-azure', changedAt: new Date(now).toISOString() };
  const instance = { runtime_profile: change.toProfile, runtime_profile_changed_at: change.changedAt };
  const status = { runtime_profile: change.toProfile, health: 'ok', runtime_launch_at: now + 1, functional_ack_at: now + 2, last_check: now / 1000 };
  assert.equal(switchReady(change, status, instance, now + 3), true);
  for (const patch of [{ functional_ack_at: 0 }, { runtime_profile: 'codex-subscription' }, { runtime_launch_at: now - 1 }, { health: 'degraded' }]) assert.equal(switchReady(change, { ...status, ...patch }, instance, now + 3), false);
});
it('reports one shared capped pool, reservations, exempt helpers, and unknown/stale safely', () => {
  const budget = { checked_at: new Date(now).toISOString(), month_utc: '2026-09', members: ['user-pan', 'user-elaine', 'user-sean'], limit_microusd: 1e9, spent_microusd: 1e8, pending_microusd: 1e7, available_microusd: 8.9e8, billing_basis: 'published_openai_token_equivalent' };
  const text = budgetLines(budget, now).join('\n');
  assert.match(text, /共用/); assert.match(text, /\$890.00/); assert.match(text, /不计入这笔共享预算/);
  assert.match(budgetLines(budget, now + 300000).join(''), /暂时取不到/);
  assert.match(subscriptionLines({}, now).join(''), /暂时取不到/);
  const usage = { providers: { codex: { available: true, quota_authoritative: true, observed_at: new Date(now).toISOString(), secondary: { window_minutes: 10080, used_percent: 98, resets_at: new Date(now + 100000).toISOString() } } } };
  const sub = subscriptionLines(usage, now).join('\n'); assert.match(sub, /剩余 2%/); assert.doesNotMatch(sub, /unknown|5 小时/);
});
it('budget reader only uses existing loopback observer and never exposes auth on failures', async t => {
  const f = fixture(t); const token = path.join(f.dir, 'token'); fs.writeFileSync(token, 'private\n');
  let calls = 0;
  const result = await readSwitchBudget({ budget_token_file: token }, { fetchImpl: async (url, opts) => { calls++; assert.equal(url, 'http://127.0.0.1:18770/budget'); assert.equal(opts.headers.Authorization, 'Bearer private'); throw Error('private'); } });
  assert.equal(result, null); assert.equal(calls, 1);
});

it('uses the existing C4 admin identity and explicit AX endpoint with stdin message', () => {
  let called = false;
  sendToAdmin({ zylosDir: '/tmp/zylos', endpoint: 'oc_admin', message: '测试', phase: 'started' }, { exec: (_bin, args, opts) => {
    called = true;
    assert.deepEqual(args, ['/tmp/zylos/.claude/skills/comm-bridge/scripts/c4-send.js', '--delivery-action=runtime-switch-started', 'feishu', 'oc_admin']);
    assert.equal(opts.env.ZYLOS_INSTANCE_ID, 'admin');
    assert.equal(opts.input, '测试');
  } });
  assert.equal(called, true);
});
