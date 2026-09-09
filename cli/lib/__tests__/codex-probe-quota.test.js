import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectCodexQuotaFromLines, readCodexQuotaFailure } from '../heartbeat/codex-probe.js';

const sessionId = '01a081b5-cf24-7142-89bd-9aff17199579';
const failedAt = Date.parse('2026-09-09T13:00:03.908Z');
const terminal = (error, at = failedAt) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'task_complete', error } });
const quota = terminal({ codex_error_info: 'usage_limit_exceeded' });

test('actual premium null-window failure is detected from terminal error', () => {
  const numeric = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null } } });
  assert.deepEqual(detectCodexQuotaFromLines([numeric]), { detected: false });
  assert.deepEqual(detectCodexQuotaFromLines([numeric, quota], { sessionId }), {
    detected: true, structured: true, source: 'codex_terminal_error', sessionId, failedAtMs: failedAt,
  });
});

test('user/tool text, auth failures and old launch errors are not quota signals', () => {
  const quote = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: quota } });
  assert.equal(detectCodexQuotaFromLines([quote]).detected, false);
  assert.equal(detectCodexQuotaFromLines([terminal({ codex_error_info: 'unauthorized' })]).detected, false);
  assert.equal(detectCodexQuotaFromLines([quota], { sinceMs: failedAt + 1 }).detected, false);
  assert.equal(detectCodexQuotaFromLines(['truncated invalid json']).detected, false);
});

test('a later completed success or different terminal error clears quota', () => {
  assert.equal(detectCodexQuotaFromLines([quota, terminal(null, failedAt + 1)]).detected, false);
  assert.equal(detectCodexQuotaFromLines([quota, terminal({ codex_error_info: 'network_error' }, failedAt + 1)]).detected, false);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authFile = path.join(root, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
  fs.utimesSync(authFile, (failedAt - 5000) / 1000, (failedAt - 5000) / 1000);
  const foregroundFile = path.join(root, 'foreground-session.json');
  const foreground = { session_id: sessionId, claude_pid: 42, observed_at: failedAt - 1000 };
  fs.writeFileSync(foregroundFile, JSON.stringify(foreground));
  const dir = path.join(root, 'sessions', '2026', '09', '09');
  fs.mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-2026-09-09T13-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(rollout, `${quota}\n`);
  return { root, authFile, foregroundFile, foreground, rollout, readProcessEnvironment: pid => {
    assert.equal(pid, 42);
    return { CODEX_HOME: root };
  } };
}

test('reads exact foreground session; ignores a different newer CLI rollout', t => {
  const f = fixture(t);
  fs.writeFileSync(f.rollout.replace(sessionId, '01a081b5-cf24-7142-89bd-9aff17199999'), terminal(null, failedAt + 1000));
  assert.equal(readCodexQuotaFailure(f).detected, true);
  fs.appendFileSync(f.rollout, `${terminal(null, failedAt + 1000)}\n`);
  assert.equal(readCodexQuotaFailure(f).detected, false);
});

test('new foreground session and rotated credentials invalidate old error', t => {
  const f = fixture(t);
  fs.utimesSync(f.authFile, (failedAt + 1000) / 1000, (failedAt + 1000) / 1000);
  assert.equal(readCodexQuotaFailure(f).detected, false);
  fs.utimesSync(f.authFile, (failedAt - 5000) / 1000, (failedAt - 5000) / 1000);
  fs.writeFileSync(f.foregroundFile, JSON.stringify({ ...f.foreground, observed_at: failedAt + 1000 }));
  assert.equal(readCodexQuotaFailure(f).detected, false);
  fs.writeFileSync(f.foregroundFile, JSON.stringify({ ...f.foreground, session_id: '01a081b5-cf24-7142-89bd-9aff17199999' }));
  assert.equal(readCodexQuotaFailure(f).detected, false);
});

test('Azure credentials, dead process and missing evidence do not reuse subscription error', t => {
  const f = fixture(t);
  assert.equal(readCodexQuotaFailure({ ...f, readProcessEnvironment() { throw Error('process gone'); } }).detected, false);
  fs.writeFileSync(f.authFile, JSON.stringify({ auth_mode: 'apikey' }));
  assert.equal(readCodexQuotaFailure(f).detected, false);
  fs.unlinkSync(f.foregroundFile);
  assert.equal(readCodexQuotaFailure(f).detected, false);
});
