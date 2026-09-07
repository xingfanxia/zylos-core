import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executionContextReceiptFile, writeExecutionContextReceipt, resolveExecutionContextRoot } from '../execution-context-receipt.js';
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

test('instance workspace/farm resolution agrees with cwd readers and preserves standalone paths', t => {
  const f = fixture(t);
  const shared = path.join(f.root, 'shared');
  const instance = path.join(shared, 'instances/group');
  fs.mkdirSync(instance, { recursive: true });
  const farm = path.join(f.root, 'farm');
  fs.mkdirSync(farm);
  fs.symlinkSync(path.join(shared, 'instances'), path.join(farm, 'instances'));
  const root = resolveExecutionContextRoot({ zylosDir: farm, instanceId: 'group', cwd: instance });
  assert.equal(root, fs.realpathSync(instance));
  assert.equal(executionContextReceiptFile(root, 'session-c'), executionContextReceiptFile(fs.realpathSync(instance), 'session-c'));
  writeExecutionContextReceipt({ zylosDir: root, payload: { session_id: 'session-c', source: 'startup' }, healthy: false });
  assert.equal(fs.existsSync(executionContextReceiptFile(instance, 'session-c')), true);
  assert.equal(fs.existsSync(path.join(shared, 'activity-monitor/execution-context')), false);
  assert.equal(resolveExecutionContextRoot({ zylosDir: shared }), shared);
  assert.ok(executionContextReceiptFile(shared, 'standalone').startsWith(path.join(shared, 'activity-monitor/execution-context')));
  assert.throws(() => resolveExecutionContextRoot({ zylosDir: shared, instanceId: '../peer' }), /invalid/);
  assert.throws(() => resolveExecutionContextRoot({ zylosDir: shared, instanceId: 'group', cwd: shared }), /does not match/);
});

test('optional receipt failure remains visible but cannot suppress healthy startup or a blocked notice', async t => {
  for (const healthy of [true, false]) {
    const f = fixture(t);
    let prompted = 0;
    await runSessionStartShard('start-prompt', { session_id: 'session-d', source: 'startup' }, {
      requireHealthyContext: true, tmpdir: f.root, stdout: { fd: f.fd },
      resolveShardImpl: () => ({ kind: 'side-effect', chain: [{ name: 'identity' }] }),
      waitForFlagImpl: async () => ({ ok: true, waitedMs: 0 }),
      readFlagStatusImpl: () => healthy ? { ok: true, roundId: 'fixture' } : { ok: false, reason: 'missing' },
      recordContextReceipt: () => { throw new Error('fixture permission denied'); },
      actions: { startupPrompt: async () => { prompted++; } },
    });
    const output = fs.readFileSync(path.join(f.root, 'stdout'), 'utf8');
    assert.ok(output.includes('EXECUTION CONTEXT RECEIPT UNAVAILABLE'));
    assert.ok(output.includes('No new receipt is available'));
    assert.equal(output.includes('STARTUP CONTEXT BLOCKED'), !healthy);
    assert.equal(prompted, healthy ? 1 : 0);
    assert.equal(fs.existsSync(executionContextReceiptFile(f.root, 'session-d')), false);
  }
});
