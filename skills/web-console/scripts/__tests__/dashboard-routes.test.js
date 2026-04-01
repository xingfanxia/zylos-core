import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];

const {
  annotateTokenCacheWithRuntimes,
  buildRuntimeUsage,
  readUsageWindowSnapshot,
} = await import('../dashboard-data.js');

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('annotateTokenCacheWithRuntimes', () => {
  it('adds runtime metadata to cached instance and per-instance rows', () => {
    const result = annotateTokenCacheWithRuntimes({
      daily: [],
      totals: {},
      instances: {
        admin: { daily: [], totals: {} },
        'user-codex': { daily: [], totals: {} },
      },
      per_instance: [
        { instance_id: 'admin', total_tokens: 10 },
        { instance_id: 'user-codex', total_tokens: 20 },
      ],
    }, {
      instances: {
        admin: { runtime: 'claude' },
        'user-codex': { runtime: 'codex' },
      },
    });

    assert.equal(result.instances.admin.runtime, 'claude');
    assert.equal(result.instances['user-codex'].runtime, 'codex');
    assert.equal(result.per_instance[0].runtime, 'claude');
    assert.equal(result.per_instance[1].runtime, 'codex');
  });
});

describe('readUsageWindowSnapshot', () => {
  it('reads codex usage snapshot from usage-codex.json', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-usage-test-'));
    tmpDirs.push(zylosDir);
    const stateDir = path.join(zylosDir, 'activity-monitor', 'user-codex');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'usage-codex.json'), JSON.stringify({
      session: { percent: 12, resets: '11:00' },
      fiveHour: { percent: 34, resets: '14:00' },
      weeklyAll: { percent: 56, resets: 'Friday' },
      tier: 'warning',
      statusShape: 'panel',
      lastCheck: '2026-04-01T06:00:00.000Z',
    }, null, 2));

    const snapshot = readUsageWindowSnapshot({
      instanceId: 'user-codex',
      instanceDef: { runtime: 'codex', state_dir: stateDir },
      zylosDir,
    });

    assert.equal(snapshot.runtime, 'codex');
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.source_file, 'usage-codex.json');
    assert.equal(snapshot.fiveHour.percent, 34);
    assert.equal(snapshot.weeklyAll.percent, 56);
  });

  it('returns unavailable when the runtime-specific usage file is missing', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-usage-test-'));
    tmpDirs.push(zylosDir);

    const snapshot = readUsageWindowSnapshot({
      instanceId: 'admin',
      instanceDef: { runtime: 'claude', state_dir: path.join(zylosDir, 'activity-monitor', 'admin') },
      zylosDir,
    });

    assert.equal(snapshot.runtime, 'claude');
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.source_file, 'usage.json');
  });
});

describe('buildRuntimeUsage', () => {
  it('prefers CodexBar for Claude and local rollout snapshots for Codex', () => {
    const result = buildRuntimeUsage({
      instancesConfig: {
        instances: {
          admin: { runtime: 'codex' },
          betty: { runtime: 'codex' },
          claudeAdmin: { runtime: 'claude' },
        },
      },
      usageWindows: {
        admin: {
          available: true,
          runtime: 'codex',
          fiveHour: { percent: 18, resets: '10:15' },
          weeklyAll: { percent: 9, resets: 'Apr 7' },
          lastCheck: '2026-04-01T08:00:00.000Z',
        },
        betty: {
          available: true,
          runtime: 'codex',
          fiveHour: { percent: 24, resets: '10:15' },
          weeklyAll: { percent: 11, resets: 'Apr 7' },
          lastCheck: '2026-04-01T08:00:03.000Z',
        },
      },
      providerUsage: {
        updated_at: '2026-04-01T08:20:00.000Z',
        providers: {
          claude: {
            available: true,
            fetched_at: '2026-04-01T08:20:00.000Z',
            primary: { left_percent: 92, reset_description: '11am' },
            secondary: { left_percent: 1, reset_description: 'Apr 3' },
            tertiary: { left_percent: 94, reset_description: 'Apr 6' },
          },
          codex: {
            available: true,
            account_email: 'test@example.com',
            primary: { left_percent: 99, reset_description: '1pm' },
            secondary: { left_percent: 100, reset_description: 'Apr 8' },
          },
        },
      },
    });

    assert.equal(result.claude.session.percent, 92);
    assert.equal(result.claude.weeklyAll.percent, 1);
    assert.equal(result.codex.fiveHour.percent, 76);
    assert.equal(result.codex.weeklyAll.percent, 89);
    assert.equal(result.codex.source, 'local_rollout');
  });
});
