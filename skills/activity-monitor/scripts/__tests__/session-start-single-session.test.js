// Per-role startup behaviour of the unified single-session tree:
// - CL SWE/auto-reviewer: ZYLOS_REQUIRE_STARTUP_CONTEXT=1 + config
//   `execution_context_receipts: true` (receipts, compaction validated).
// - CL QA: ZYLOS_REQUIRE_STARTUP_CONTEXT=1, no receipts (compaction skips at once).
// - herdr Bohe: neither (upstream fail-open startup prompt).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DEFAULT_SHARD_BUDGET } from '../shard-registry.js';
import {
  contextReceiptRecorder,
  executionContextReceiptsEnabled,
  runSessionStartShard,
} from '../session-start-orchestrator.js';
import { executionContextReceiptFile } from '../execution-context-receipt.js';
import { writeFlag } from '../shard-sequencer.js';

const tmpDirs = [];
function makeTmpdir(prefix = 'single-session-start-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempStdout() {
  const filePath = path.join(makeTmpdir('single-session-stdout-'), 'stdout.txt');
  const fd = fs.openSync(filePath, 'w+');
  return { stdout: { fd }, read: () => fs.readFileSync(filePath, 'utf8') };
}

function zylosDirWithConfig(config) {
  const zylosDir = makeTmpdir('single-session-zylos-');
  if (config) {
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify(config));
  }
  return zylosDir;
}

const chain = [
  { name: 'identity', emit: async () => 'A' },
  { name: 'references', emit: async () => 'B' },
].map((entry, index) => ({ budget: { ...DEFAULT_SHARD_BUDGET }, chainIndex: index, ...entry }));
const resolveShardImpl = name => (name === 'fg' || name === 'start-prompt'
  ? { kind: 'side-effect', name, chain, warnings: [] }
  : null);

async function startPrompt(source, { requireHealthyContext, recordContextReceipt, tmpdir, linkMs = 2000 }) {
  const out = tempStdout();
  const prompts = [];
  const startMs = Date.now();
  await runSessionStartShard('start-prompt', { session_id: 'sess-single', source }, {
    stdout: out.stdout,
    tmpdir,
    linkMs,
    resolveShardImpl,
    requireHealthyContext,
    recordContextReceipt,
    actions: { foreground: async () => {}, startupPrompt: async () => prompts.push(source) },
  });
  return { prompts, stdout: out.read(), elapsedMs: Date.now() - startMs };
}

function writeHealthyRound(tmpdir) {
  for (const shard of chain) writeFlag('sess-single', shard.name, { tmpdir, roundId: 'round-1', status: 'ok' });
}

describe('execution-context receipt gate', () => {
  it('is off without config, with unrelated keys, or with a false value', () => {
    assert.equal(executionContextReceiptsEnabled(zylosDirWithConfig(null)), false);
    assert.equal(executionContextReceiptsEnabled(zylosDirWithConfig({ runtime: 'codex', heartbeat_interval: '7200' })), false);
    assert.equal(executionContextReceiptsEnabled(zylosDirWithConfig({ execution_context_receipts: false })), false);
    assert.equal(contextReceiptRecorder(zylosDirWithConfig({ runtime: 'codex' })), undefined);
  });

  it('is on for config true (boolean or string)', () => {
    assert.equal(executionContextReceiptsEnabled(zylosDirWithConfig({ execution_context_receipts: true })), true);
    assert.equal(executionContextReceiptsEnabled(zylosDirWithConfig({ execution_context_receipts: 'true' })), true);
  });

  it('writes a private healthy receipt through the configured recorder (SWE/auto-reviewer)', async () => {
    const zylosDir = zylosDirWithConfig({ runtime: 'codex', execution_context_receipts: true });
    const tmpdir = makeTmpdir();
    writeHealthyRound(tmpdir);

    const { prompts } = await startPrompt('startup', {
      requireHealthyContext: true, recordContextReceipt: contextReceiptRecorder(zylosDir), tmpdir,
    });

    assert.deepEqual(prompts, ['startup']);
    const file = executionContextReceiptFile(fs.realpathSync(zylosDir), 'sess-single');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(receipt.healthy, true);
    assert.equal(receipt.roundId, 'round-1');
    assert.equal(receipt.freshness, 'fresh');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('compaction handling (session-start-orchestrator merge resolution)', () => {
  it('QA/herdr: compaction without a receipt recorder skips at once, without waiting on the chain tail', async () => {
    const { prompts, stdout, elapsedMs } = await startPrompt('compact', {
      requireHealthyContext: true, recordContextReceipt: undefined, tmpdir: makeTmpdir(), linkMs: 5000,
    });
    assert.deepEqual(prompts, []);
    assert.equal(stdout, '');
    assert.ok(elapsedMs < 1000, `compaction waited ${elapsedMs}ms for the chain tail`);
  });

  it('SWE/auto-reviewer: compaction validates the round and records a continued receipt', async () => {
    const tmpdir = makeTmpdir();
    writeHealthyRound(tmpdir);
    const receipts = [];
    const { prompts, stdout } = await startPrompt('compact', {
      requireHealthyContext: true, recordContextReceipt: async input => receipts.push(input), tmpdir,
    });
    assert.deepEqual(prompts, []);
    assert.equal(stdout, '');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].healthy, true);
    assert.equal(receipts[0].roundId, 'round-1');
  });

  it('SWE/auto-reviewer: compaction with a broken round blocks and records an unhealthy receipt', async () => {
    const receipts = [];
    const { prompts, stdout } = await startPrompt('compact', {
      requireHealthyContext: true, recordContextReceipt: async input => receipts.push(input), tmpdir: makeTmpdir(), linkMs: 40,
    });
    assert.deepEqual(prompts, []);
    assert.match(stdout, /STARTUP CONTEXT BLOCKED/);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].healthy, false);
  });
});

describe('startup-context gate (ZYLOS_REQUIRE_STARTUP_CONTEXT)', () => {
  it('CL (gate on): a missing shard result withholds the work prompt', async () => {
    const { prompts, stdout } = await startPrompt('startup', {
      requireHealthyContext: true, recordContextReceipt: undefined, tmpdir: makeTmpdir(), linkMs: 40,
    });
    assert.deepEqual(prompts, []);
    assert.match(stdout, /STARTUP CONTEXT BLOCKED/);
  });

  it('herdr (gate off): a missing shard result still fails open to the work prompt', async () => {
    const { prompts, stdout } = await startPrompt('startup', {
      requireHealthyContext: false, recordContextReceipt: undefined, tmpdir: makeTmpdir(), linkMs: 40,
    });
    assert.deepEqual(prompts, ['startup']);
    assert.doesNotMatch(stdout, /STARTUP CONTEXT BLOCKED/);
  });
});
