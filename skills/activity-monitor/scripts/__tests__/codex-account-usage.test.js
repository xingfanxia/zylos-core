import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { fetchCodexAccountUsage, normalizeCodexAccountUsage, readCodexAccountRateLimits } from '../codex-account-usage.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-account-quota-'));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-07T13:19:23Z');
  const account = (id = 'account-a', subject = 'subject-a') => {
    const body = Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      account_id: id, id_token: `header.${body}.signature`,
    } }), { mode: 0o600 });
  };
  account();
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n', { mode: 0o600 });
  const limits = (percent = 39) => ({ limitId: 'codex', spendControlReached: false, rateLimitReachedType: null,
    primary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: clock / 1000 + 7 * 86400 }, secondary: null });
  const response = (percent = 39) => ({ accountId: 'account-a', rateLimits: limits(percent), rateLimitsByLimitId: {
    codex: limits(percent), codex_bengalfox: { limitId: 'codex_bengalfox', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: clock / 1000 + 1000 } },
  } });
  const options = { codexHome: home, now: () => new Date(clock).toISOString(), readImpl: async () => response() };
  return { home, account, response, limits, options, now: () => new Date(clock).toISOString(), advance: (ms) => { clock += ms; } };
}

test('official default codex window wins over bengalfox and retains its declared weekly duration', (t) => {
  const f = fixture(t);
  const result = normalizeCodexAccountUsage(f.response(), { observedAt: f.now(), accountKey: 'hashed-account' });
  assert.equal(result.secondary.used_percent, 39);
  assert.equal(result.primary, null);
  assert.equal(result.secondary.window_minutes, 10080);
  assert.equal(result.quota_authoritative, true);
  assert.equal(result.observed_at, f.now());
  assert.equal(JSON.stringify(result).includes('"account-a"'), false);
});

test('unknown bucket, missing windows, invalid and expired windows fail closed', (t) => {
  const f = fixture(t), opts = { observedAt: f.now(), accountKey: 'key' };
  assert.throws(() => normalizeCodexAccountUsage({ rateLimits: { limitId: 'codex_bengalfox' } }, opts), /codex_limit_missing/);
  assert.throws(() => normalizeCodexAccountUsage({ rateLimits: { limitId: 'codex' } }, opts), /quota_windows_missing/);
  const old = f.limits(); old.primary.resetsAt = Date.parse(f.now()) / 1000 - 1;
  assert.throws(() => normalizeCodexAccountUsage({ rateLimits: old }, opts), /quota_window_expired/);
  const unknown = f.limits(); unknown.primary.windowDurationMins = null;
  assert.throws(() => normalizeCodexAccountUsage({ rateLimits: unknown }, opts), /quota_window_invalid/);
});

test('short-lived API cache retains original observation timestamps and never edits auth/config', async (t) => {
  const f = fixture(t);
  const auth = fs.readFileSync(path.join(f.home, 'auth.json')), config = fs.readFileSync(path.join(f.home, 'config.toml'));
  const first = await fetchCodexAccountUsage(f.options);
  f.advance(60000);
  const second = await fetchCodexAccountUsage({ ...f.options, readImpl: async () => { throw new Error('cache must avoid RPC'); } });
  assert.equal(second.available, true);
  assert.equal(second.cache_used, true);
  assert.equal(second.observed_at, first.observed_at);
  assert.equal(second.fetched_at, first.fetched_at);
  assert.notEqual(second.checked_at, first.checked_at);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'auth.json')), auth);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'config.toml')), config);
  assert.equal(fs.statSync(path.join(f.home, 'zylos-rate-limits-cache.json')).mode & 0o777, 0o600);
});

test('expired cache plus API failure cannot be republished as fresh quota', async (t) => {
  const f = fixture(t);
  await fetchCodexAccountUsage(f.options);
  f.advance(180000);
  const result = await fetchCodexAccountUsage({ ...f.options, readImpl: async () => { throw Object.assign(new Error('timeout'), { code: 'quota_probe_timeout' }); } });
  assert.equal(result.available, false);
  assert.equal(result.quota_authoritative, false);
  assert.equal(result.observed_at, null);
  assert.equal(result.fetched_at, null);
  assert.equal(result.error, 'quota_probe_timeout');
});

test('account change invalidates the cache and response account mismatch is refused', async (t) => {
  const f = fixture(t);
  const initial = await fetchCodexAccountUsage(f.options);
  f.account('account-b');
  const result = await fetchCodexAccountUsage(f.options);
  assert.equal(result.available, false);
  assert.equal(result.error, 'quota_account_mismatch');
  assert.notEqual(result.account_key, initial.account_key);
});

test('operator cannot launch native app-server against a differently owned profile', async (t) => {
  const f = fixture(t), original = fs.statSync;
  let called = false;
  fs.statSync = (...args) => { const result = original(...args); if (args[0] === f.home) result.uid += 1; return result; };
  try {
    const result = await fetchCodexAccountUsage({ ...f.options, readImpl: async () => { called = true; return f.response(); } });
    assert.equal(result.error, 'profile_owner_mismatch');
    assert.equal(called, false);
    await assert.rejects(readCodexAccountRateLimits({ codexHome: f.home, codexBin: 'unused' }), /profile_owner_mismatch/);
  } finally { fs.statSync = original; }
});

function fakeNative(f, mode = 'success') {
  const bin = path.join(f.home, 'codex'), requests = path.join(f.home, 'requests'), pid = path.join(f.home, 'pid');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));
${mode === 'timeout' ? "process.on('SIGTERM',()=>{});" : ''}
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},m.method+'\\n');
if(m.method==='initialize')reply(m.id,{});
if(m.method==='account/rateLimits/read'){
${mode === 'success' ? `reply(m.id,${JSON.stringify(f.response())});` : mode === 'invalid' ? "process.stdout.write('not json\\n');" : mode === 'error' ? "process.stdout.write(JSON.stringify({id:m.id,error:{code:-32000,message:'SECRET_RPC_BODY token-should-never-escape'}})+'\\n');" : ''}
}});setInterval(()=>{},1000);
`, { mode: 0o700 });
  return { bin, requests, pid };
}

test('native probe performs only account reads and reaps the private process', async (t) => {
  const f = fixture(t), fake = fakeNative(f);
  const result = await readCodexAccountRateLimits({ codexHome: f.home, codexBin: fake.bin, timeoutMs: 2000 });
  assert.equal(result.rateLimits.primary.usedPercent, 39);
  assert.deepEqual(fs.readFileSync(fake.requests, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.throws(() => process.kill(Number(fs.readFileSync(fake.pid)), 0), { code: 'ESRCH' });
});

test('timeout and malformed native responses remain unknown and clean up their process', async (t) => {
  for (const mode of ['timeout', 'invalid']) {
    const f = fixture(t), fake = fakeNative(f, mode), start = Date.now();
    await assert.rejects(readCodexAccountRateLimits({ codexHome: f.home, codexBin: fake.bin, timeoutMs: 200 }),
      new RegExp(mode === 'timeout' ? 'quota_probe_timeout' : 'quota_response_invalid'));
    assert.ok(Date.now() - start < 2500);
    assert.throws(() => process.kill(Number(fs.readFileSync(fake.pid)), 0), { code: 'ESRCH' });
  }
});


test('native RPC failures publish a controlled code without credential-bearing response text', async (t) => {
  const f = fixture(t), fake = fakeNative(f, 'error');
  const result = await fetchCodexAccountUsage({ ...f.options, codexBin: fake.bin, cacheFile: null,
    readImpl: readCodexAccountRateLimits });
  assert.equal(result.available, false);
  assert.equal(result.quota_authoritative, false);
  assert.equal(result.error, 'quota_rpc_error');
  assert.equal(result.observed_at, null);
  assert.equal(result.fetched_at, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_RPC_BODY|token-should-never-escape/);
  assert.throws(() => process.kill(Number(fs.readFileSync(fake.pid)), 0), { code: 'ESRCH' });
});


test('cleanup kills a surviving private-group child after its wrapper leader exits', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t), bin = path.join(f.home, 'wrapper');
  const leaderFile = path.join(f.home, 'leader-pid'), descendantFile = path.join(f.home, 'descendant-pid');
  const descendantCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},1000);`;
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process'),readline=require('node:readline');
fs.writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));
spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});
process.on('SIGTERM',()=>process.exit(0));
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',m=>{m=JSON.parse(m);
if(m.method==='initialize')reply(m.id,{});
if(m.method==='account/rateLimits/read'){const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendantFile)})){clearInterval(ready);reply(m.id,${JSON.stringify(f.response())});}},10);}
});setInterval(()=>{},1000);
`, { mode: 0o700 });
  // Capture ownership in memory so cleanup works even after fixture-file removal.
  let testGroupPid;
  t.after(() => { if (testGroupPid) { try { process.kill(-testGroupPid, 'SIGKILL'); } catch {} } });
  const start = Date.now();
  const result = await readCodexAccountRateLimits({ codexHome: f.home, codexBin: bin, timeoutMs: 2000,
    spawnImpl: (...args) => { const child = spawn(...args); testGroupPid = child.pid; return child; } });
  assert.equal(result.rateLimits.primary.usedPercent, 39);
  assert.ok(Date.now() - start < 2500);
  assert.throws(() => process.kill(Number(fs.readFileSync(leaderFile)), 0), { code: 'ESRCH' });
  const descendantPid = Number(fs.readFileSync(descendantFile));
  const running = () => {
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return state && !state.startsWith('Z'); // OS owns reaping this orphan, never this collector.
    } catch { return false; }
  };
  const deadline = Date.now() + 500;
  while (running() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(Boolean(running()), false, 'TERM-ignoring descendant must not survive leader exit');
});

test('quota probe uses the raw CLI beside Node, never the active profile wrapper', async () => {
  const { rawCodexQuotaProbeBin } = await import('../codex-account-usage.js');
  const saved = process.env.CODEX_QUOTA_PROBE_BIN;
  const wrapper = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_QUOTA_PROBE_BIN; process.env.CODEX_BIN = '/profile/wrapper';
    assert.equal(rawCodexQuotaProbeBin(), path.join(path.dirname(process.execPath), 'codex'));
    process.env.CODEX_QUOTA_PROBE_BIN = '/explicit/raw/codex';
    assert.equal(rawCodexQuotaProbeBin(), '/explicit/raw/codex');
  } finally {
    if (saved === undefined) delete process.env.CODEX_QUOTA_PROBE_BIN; else process.env.CODEX_QUOTA_PROBE_BIN = saved;
    if (wrapper === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = wrapper;
  }
});
