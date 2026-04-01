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
});
