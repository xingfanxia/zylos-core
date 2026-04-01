import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];
const originalDisableMain = process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN;

process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN = '1';

const {
  buildTokenCacheResult,
  classifyModelRuntime,
  mergeCodexSessionsIntoResult,
  splitEntryByRuntime,
  runUpdateOnce,
} = await import('../update-token-cache.js');

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

process.on('exit', () => {
  if (originalDisableMain === undefined) delete process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN;
  else process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN = originalDisableMain;
});

describe('buildTokenCacheResult', () => {
  it('aggregates per-instance and daily totals from ccusage project data', () => {
    const result = buildTokenCacheResult({
      projects: {
        '-home-user-zylos-instances-admin': [
          {
            date: '2026-04-01',
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            totalCost: 1.5,
            modelBreakdowns: [
              { modelName: 'claude-opus-4-6', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1.5 },
            ],
          },
        ],
        '-home-user-zylos-instances-user-betty': [
          {
            date: '2026-04-01',
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
            totalCost: 0.9,
            modelBreakdowns: [
              { modelName: 'gpt-5.4', inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.9 },
            ],
          },
        ],
      },
    }, new Date('2026-04-01T12:00:00.000Z'));

    assert.equal(result.instances.admin.totals.total_tokens, 15);
    assert.equal(result.instances['user-betty'].totals.total_tokens, 10);
    assert.equal(result.instances.admin.runtimes.claude.totals.total_tokens, 15);
    assert.equal(result.instances['user-betty'].runtimes.codex.totals.total_tokens, 10);
    assert.equal(result.runtimes.claude.totals.total_tokens, 15);
    assert.equal(result.runtimes.codex.totals.total_tokens, 10);
    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].total_tokens, 25);
    assert.equal(result.totals.cost_usd, 2.4);
  });
});

describe('runtime split helpers', () => {
  it('classifies claude and codex model names', () => {
    assert.equal(classifyModelRuntime('claude-opus-4-6'), 'claude');
    assert.equal(classifyModelRuntime('gpt-5.4'), 'codex');
    assert.equal(classifyModelRuntime('o3'), 'codex');
    assert.equal(classifyModelRuntime('something-else'), 'other');
  });

  it('splits mixed model breakdowns by runtime', () => {
    const split = splitEntryByRuntime({
      date: '2026-04-01',
      modelBreakdowns: [
        { modelName: 'claude-opus-4-6', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1.5 },
        { modelName: 'gpt-5.4', inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0.9 },
      ],
    });

    assert.equal(split.claude.total_tokens, 15);
    assert.equal(split.codex.total_tokens, 10);
  });
});

describe('mergeCodexSessionsIntoResult', () => {
  it('attributes codex sessions to instances via rollout session metadata', () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-token-cache-test-'));
    tmpDirs.push(codexDir);
    const sessionsDir = path.join(codexDir, '2026', '04', '01');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const rolloutPath = path.join(sessionsDir, 'rollout-admin.jsonl');
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/admin' } })}\n`,
      'utf8'
    );

    const result = buildTokenCacheResult({ projects: {} }, new Date('2026-04-01T12:00:00.000Z'));
    mergeCodexSessionsIntoResult(result, [
      {
        directory: '2026/04/01',
        sessionFile: 'rollout-admin',
        lastActivity: '2026-04-01T10:00:00.000Z',
        inputTokens: 100,
        cachedInputTokens: 25,
        outputTokens: 10,
        costUSD: 1.23,
      },
    ], {
      codexSessionsDir: codexDir,
    });

    assert.equal(result.instances.admin.totals.input_tokens, 100);
    assert.equal(result.instances.admin.totals.cache_read, 25);
    assert.equal(result.instances.admin.totals.output_tokens, 10);
    assert.equal(result.instances.admin.runtimes.codex.totals.total_tokens, 135);
    assert.equal(result.runtimes.codex.totals.total_tokens, 135);
  });
});

describe('runUpdateOnce', () => {
  it('writes the cache file from ccusage JSON output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-token-cache-test-'));
    tmpDirs.push(tmpDir);
    const cacheFile = path.join(tmpDir, 'token-cache.json');

    const result = runUpdateOnce({
      cacheFile,
      now: new Date('2026-04-01T12:00:00.000Z'),
      execFileSyncImpl: () => JSON.stringify({
        projects: {
          '-home-user-zylos-instances-admin': [
            {
              date: '2026-04-01',
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15,
              totalCost: 1.5,
              modelBreakdowns: [
                { modelName: 'claude-opus-4-6', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 1.5 },
              ],
            },
          ],
        },
      }),
      log: () => {},
    });

    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(result.totals.total_tokens, 15);
    assert.equal(written.instances.admin.totals.total_tokens, 15);
    assert.equal(written.runtimes.claude.totals.total_tokens, 15);
    assert.equal(written.updated_at, '2026-04-01T12:00:00.000Z');
  });

  it('merges codex session history into the cache', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-token-cache-test-'));
    tmpDirs.push(tmpDir);
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
      instances: {
        'user-pan': { runtime: 'codex' },
      },
    }), 'utf8');
    const codexSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-sessions-test-'));
    tmpDirs.push(codexSessionsDir);
    const todayDir = path.join(codexSessionsDir, '2026', '04', '01');
    fs.mkdirSync(todayDir, { recursive: true });
    fs.writeFileSync(
      path.join(todayDir, 'rollout-user-pan.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/user-pan' } })}\n`,
      'utf8'
    );

    const result = runUpdateOnce({
      cacheFile,
      codexSessionsDir,
      zylosDir: tmpDir,
      now: new Date('2026-04-01T12:00:00.000Z'),
      execFileSyncImpl: (cmd) => {
        if (cmd === 'ccusage') {
          return JSON.stringify({ projects: {} });
        }
        if (cmd === 'npx') {
          return JSON.stringify({
            sessions: [
              {
                directory: '2026/04/01',
                sessionFile: 'rollout-user-pan',
                lastActivity: '2026-04-01T09:00:00.000Z',
                inputTokens: 500,
                cachedInputTokens: 50,
                outputTokens: 25,
                costUSD: 2.5,
              },
            ],
          });
        }
        throw new Error(`unexpected command ${cmd}`);
      },
      log: () => {},
    });

    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(result.instances['user-pan'].runtimes.codex.totals.total_tokens, 575);
    assert.equal(written.runtimes.codex.totals.total_tokens, 575);
    assert.equal(written.instances['user-pan'].totals.total_tokens, 575);
  });

  it('skips codex sessions that do not map to configured instances', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-token-cache-test-'));
    tmpDirs.push(tmpDir);
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
      instances: {
        admin: { runtime: 'codex' },
      },
    }), 'utf8');

    const codexSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-sessions-test-'));
    tmpDirs.push(codexSessionsDir);
    const todayDir = path.join(codexSessionsDir, '2026', '04', '01');
    fs.mkdirSync(todayDir, { recursive: true });
    fs.writeFileSync(
      path.join(todayDir, 'rollout-probe.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/probe-codex' } })}\n`,
      'utf8'
    );

    const result = runUpdateOnce({
      cacheFile,
      codexSessionsDir,
      zylosDir: tmpDir,
      now: new Date('2026-04-01T12:00:00.000Z'),
      execFileSyncImpl: (cmd) => {
        if (cmd === 'ccusage') return JSON.stringify({ projects: {} });
        if (cmd === 'npx') {
          return JSON.stringify({
            sessions: [
              {
                directory: '2026/04/01',
                sessionFile: 'rollout-probe',
                lastActivity: '2026-04-01T09:00:00.000Z',
                inputTokens: 100,
                cachedInputTokens: 10,
                outputTokens: 5,
                costUSD: 1,
              },
            ],
          });
        }
        throw new Error(`unexpected command ${cmd}`);
      },
      log: () => {},
    });

    assert.equal(result.runtimes.codex.totals.total_tokens, 0);
    assert.equal(result.instances['probe-codex'], undefined);
  });
});
