import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];
const originalDisableMain = process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN;

process.env.UPDATE_TOKEN_CACHE_DISABLE_MAIN = '1';

const {
  buildCodexProfileHomes,
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
        cacheReadTokens: 25,
        cacheCreationTokens: 5,
        outputTokens: 10,
        costUSD: 1.23,
      },
    ], {
      codexSessionsDir: codexDir,
      runtimeProfileId: 'codex-azure',
    });

    assert.equal(result.instances.admin.totals.input_tokens, 100);
    assert.equal(result.instances.admin.totals.cache_read, 25);
    assert.equal(result.instances.admin.totals.cache_write, 5);
    assert.equal(result.instances.admin.totals.output_tokens, 10);
    assert.equal(result.instances.admin.runtimes.codex.totals.total_tokens, 140);
    assert.equal(result.runtimes.codex.totals.total_tokens, 140);
    assert.equal(result.instances.admin.profiles['codex-azure'].totals.total_tokens, 140);
    assert.equal(result.instances.admin.profiles['codex-azure'].totals.cost_usd, 1.23);
    assert.equal(result.instances.admin.profiles['codex-azure'].cost_basis, 'litellm_equivalent_api_estimate');
  });

  it('attributes sessions whose session_meta line is larger than 16 KiB', () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-large-meta-test-'));
    tmpDirs.push(codexDir);
    const sessionsDir = path.join(codexDir, '2026', '04', '01');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-large.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: { instructions: 'x'.repeat(32_768), cwd: '/home/xingfanxia/zylos/instances/admin' },
      })}\n`,
      'utf8'
    );

    const result = buildTokenCacheResult({ projects: {} });
    mergeCodexSessionsIntoResult(result, [{
      directory: '2026/04/01',
      sessionFile: 'rollout-large',
      lastActivity: '2026-04-01T10:00:00.000Z',
      inputTokens: 100,
      outputTokens: 10,
      costUSD: 1,
    }], {
      codexSessionsDir: codexDir,
      runtimeProfileId: 'codex-azure',
    });

    assert.equal(result.instances.admin.profiles['codex-azure'].totals.total_tokens, 110);
  });

  it('attributes an upstream single-session rollout to its unchanged workspace persona', () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-single-test-'));
    tmpDirs.push(codexDir);
    const sessionsDir = path.join(codexDir, '2026', '04', '01');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-bohe.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos' } })}\n`,
      'utf8',
    );

    const result = buildTokenCacheResult({ projects: {} });
    mergeCodexSessionsIntoResult(result, [{
      directory: '2026/04/01',
      sessionFile: 'rollout-bohe',
      lastActivity: '2026-04-01T10:00:00.000Z',
      inputTokens: 200,
      outputTokens: 20,
      costUSD: 2,
    }], {
      codexSessionsDir: codexDir,
      knownInstanceIds: new Set(['bohe']),
      runtimeProfileId: 'codex-azure',
      defaultInstanceId: 'bohe',
      defaultInstanceCwd: '/home/xingfanxia/zylos',
    });

    assert.equal(result.instances.bohe.profiles['codex-azure'].totals.total_tokens, 220);
    assert.equal(result.instances.bohe.profiles['codex-azure'].totals.cost_usd, 2);
  });
});

describe('buildCodexProfileHomes', () => {
  it('resolves subscription and Azure Codex homes for each isolated OS user', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-profile-homes-test-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify({
      runtime_profiles: {
        'claude-subscription': { runtime: 'claude' },
        'codex-subscription': { runtime: 'codex', codex_home: '~/.codex-subscription' },
        'codex-azure': { runtime: 'codex', codex_home: '~/.codex-azure' },
      },
      instances: {
        admin: { enabled: true },
        pan: { enabled: true, os_user: 'zylos-pan' },
      },
    }));

    const homes = buildCodexProfileHomes(dir);
    assert.ok(homes.some(x => x.profile_id === 'codex-azure' && x.codex_home === path.join(os.homedir(), '.codex-azure')));
    assert.ok(homes.some(x => x.profile_id === 'codex-subscription'
      && x.codex_home === '/home/zylos-pan/.codex-subscription'
      && x.os_user === 'zylos-pan'));
    assert.equal(homes.length, 4);
  });

  it('resolves Codex homes for upstream single-session Zylos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-single-profile-homes-test-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zylos', 'runtime-profiles.json'), JSON.stringify({
      persona_id: 'bohe',
      workspace: dir,
      runtime_profiles: {
        'claude-subscription': { runtime: 'claude' },
        'codex-subscription': { runtime: 'codex', codex_home: '~/.codex-subscription' },
        'codex-azure': { runtime: 'codex', codex_home: '~/.codex-azure' },
      },
    }));

    const homes = buildCodexProfileHomes(dir);
    assert.equal(homes.length, 2);
    assert.ok(homes.every(x => x.instance_id === 'bohe' && x.instance_cwd === dir));
    assert.ok(homes.some(x => x.profile_id === 'codex-azure'
      && x.codex_home === path.join(os.homedir(), '.codex-azure')));
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
        if (String(cmd).endsWith('ccusage')) {
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
        if (String(cmd).endsWith('ccusage')) return JSON.stringify({ projects: {} });
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

  it('continues Azure profile accounting when Claude transcript reads fail', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-token-cache-degrade-test-'));
    tmpDirs.push(tmpDir);
    const cacheFile = path.join(tmpDir, 'token-cache.json');
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({ instances: { admin: {} } }));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-azure-home-'));
    tmpDirs.push(codexHome);
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '04', '01');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'rollout-admin.jsonl'), `${JSON.stringify({
      type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/admin' },
    })}\n`);

    const result = runUpdateOnce({
      cacheFile,
      zylosDir: tmpDir,
      codexProfileHomes: [{ profile_id: 'codex-azure', codex_home: codexHome }],
      now: new Date('2026-04-01T12:00:00.000Z'),
      execFileSyncImpl: (cmd) => {
        if (String(cmd).endsWith('ccusage')) {
          const err = new Error('EACCES');
          err.stderr = Buffer.from('EACCES transcript');
          throw err;
        }
        return JSON.stringify({ sessions: [{
          directory: '2026/04/01', sessionFile: 'rollout-admin',
          lastActivity: '2026-04-01T09:00:00Z', inputTokens: 100,
          cacheReadTokens: 25, outputTokens: 10, costUSD: 1.23,
        }] });
      },
      log: () => {},
    });

    assert.match(result.warnings[0], /claude:.*EACCES/);
    assert.equal(result.instances.admin.profiles['codex-azure'].totals.total_tokens, 135);
    assert.equal(result.instances.admin.profiles['codex-azure'].totals.cost_usd, 1.23);
  });

  it('runs ccusage as the isolated profile OS user', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-token-cache-os-user-test-'));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({ instances: { pan: {} } }));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-os-user-home-'));
    tmpDirs.push(codexHome);
    let sudoArgs;

    runUpdateOnce({
      cacheFile: path.join(tmpDir, 'token-cache.json'),
      zylosDir: tmpDir,
      codexProfileHomes: [{
        profile_id: 'codex-azure', codex_home: codexHome, os_user: 'zylos-pan',
      }],
      execFileSyncImpl: (cmd, args) => {
        if (String(cmd).endsWith('ccusage')) return JSON.stringify({ projects: {} });
        if (cmd === 'sudo') {
          sudoArgs = args;
          return JSON.stringify({ sessions: [] });
        }
        throw new Error(`unexpected command ${cmd}`);
      },
      log: () => {},
    });

    assert.deepEqual(sudoArgs.slice(0, 7), [
      '-n', '-u', 'zylos-pan', '-H', '--', '/usr/bin/env', `CODEX_HOME=${codexHome}`,
    ]);
    assert.ok(sudoArgs.includes('ccusage@20.0.17'));
  });
});
