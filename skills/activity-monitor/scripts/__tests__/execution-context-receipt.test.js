import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executionContextReceiptFile, writeExecutionContextReceipt } from '../execution-context-receipt.js';
import { runSessionStartShard } from '../session-start-orchestrator.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-context-'));
  const fd = fs.openSync(path.join(root, 'stdout'), 'w');
  t.after(() => { fs.closeSync(fd); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, fd };
}

test('successful strict shard round publishes private metadata; compact preserves the session identity', async t => {
  const f = fixture(t);
  let prompted = 0;
  const options = {
    requireHealthyContext: true, tmpdir: f.root, stdout: { fd: f.fd },
    resolveShardImpl: () => ({ kind: 'side-effect', chain: [{ name: 'identity' }, { name: 'references' }] }),
    waitForFlagImpl: async () => ({ ok: true, waitedMs: 0 }),
    readFlagStatusImpl: () => ({ ok: true, roundId: 'fixture-round' }),
    recordContextReceipt: input => writeExecutionContextReceipt({ ...input, zylosDir: f.root }),
    actions: { startupPrompt: async () => { prompted++; } },
  };
  await runSessionStartShard('start-prompt', { session_id: 'session-a', source: 'startup' }, options);
  const file = executionContextReceiptFile(f.root, 'session-a');
  const startup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(startup.healthy, true);
  assert.equal(startup.freshness, 'fresh');
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(prompted, 1);
  await runSessionStartShard('start-prompt', { session_id: 'session-a', source: 'compact' }, options);
  const compact = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(compact.sessionId, startup.sessionId);
  assert.equal(compact.contextGeneration, startup.contextGeneration);
  assert.equal(compact.freshness, 'continued');
  assert.equal(prompted, 1);
});

test('missing or mixed-round startup context records an unhealthy receipt and withholds work', async t => {
  for (const mode of ['missing', 'mixed']) {
    const f = fixture(t);
    let prompted = false;
    await runSessionStartShard('start-prompt', { session_id: 'session-b', source: 'startup' }, {
      requireHealthyContext: true, tmpdir: f.root, stdout: { fd: f.fd },
      resolveShardImpl: () => ({ kind: 'side-effect', chain: [{ name: 'identity' }, { name: 'references' }] }),
      waitForFlagImpl: async () => ({ ok: true, waitedMs: 0 }),
      readFlagStatusImpl: (_session, shard) => shard === 'references' ? { ok: true, roundId: 'new' }
        : mode === 'missing' ? { ok: false, reason: 'missing' } : { ok: true, roundId: 'old' },
      recordContextReceipt: input => writeExecutionContextReceipt({ ...input, zylosDir: f.root }),
      actions: { startupPrompt: async () => { prompted = true; } },
    });
    const record = JSON.parse(fs.readFileSync(executionContextReceiptFile(f.root, 'session-b'), 'utf8'));
    assert.equal(record.healthy, false);
    assert.ok(record.failures.length);
    assert.equal(prompted, false);
  }
});

test('receipt producer rejects path escapes and cannot mint healthy state without shard proof', t => {
  const f = fixture(t);
  assert.throws(() => executionContextReceiptFile(f.root, '../other'), /invalid/);
  assert.throws(() => writeExecutionContextReceipt({ zylosDir: f.root, payload: { session_id: 'a', source: 'startup' }, healthy: true }), /complete matching shard/);
  assert.throws(() => writeExecutionContextReceipt({ zylosDir: f.root, payload: { session_id: 'a', source: 'invented' }, healthy: false }), /Unknown runtime/);
});
