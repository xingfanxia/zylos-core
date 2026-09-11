import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];

const {
  getActiveAdapter,
  getAdapterForInstance,
} = await import('../runtime/index.js');

function makeZylosDir({ configRuntime = 'claude', instances = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-index-test-'));
  tmpDirs.push(dir);

  fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.zylos', 'config.json'),
    JSON.stringify({ runtime: configRuntime }, null, 2) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'instances.json'),
    JSON.stringify({ version: 1, instances }, null, 2) + '\n',
    'utf8'
  );

  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('getAdapterForInstance', () => {
  it('uses the instance runtime when present', () => {
    const zylosDir = makeZylosDir({
      configRuntime: 'claude',
      instances: {
        admin: { runtime: 'claude' },
        'user-codex': { runtime: 'codex' },
      },
    });

    const adapter = getAdapterForInstance({
      instanceId: 'user-codex',
      config: { runtime: 'claude' },
      zylosDir,
    });

    assert.equal(adapter.runtimeId, 'codex');
  });

  it('falls back to the configured runtime when the instance has no explicit runtime', () => {
    const zylosDir = makeZylosDir({
      configRuntime: 'codex',
      instances: {
        admin: {},
      },
    });

    const adapter = getAdapterForInstance({
      instanceId: 'admin',
      config: { runtime: 'codex' },
      zylosDir,
    });

    assert.equal(adapter.runtimeId, 'codex');
  });

  it('resolves an instance runtime profile and passes it to the adapter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-index-test-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zylos', 'config.json'), '{"runtime":"claude"}\n');
    fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify({
      version: 1,
      runtime_profiles: {
        'codex-azure': {
          runtime: 'codex',
          usage_provider: null,
          codex_home: '~/.codex-azure',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'medium',
          provider_env_key: 'AZURE_FOUNDRY_KEY',
        },
      },
      instances: {
        admin: { runtime: 'claude', runtime_profile: 'codex-azure' },
      },
    }, null, 2));

    const adapter = getAdapterForInstance({
      instanceId: 'admin',
      config: { runtime: 'claude' },
      zylosDir: dir,
      homeDir: '/home/operator',
    });

    assert.equal(adapter.runtimeId, 'codex');
    assert.equal(adapter.config.runtimeProfile.id, 'codex-azure');
    assert.equal(adapter.config.runtimeProfile.codexHome, '/home/operator/.codex-azure');
    assert.equal(adapter.config.runtimeProfile.reasoningEffort, 'medium');
  });

  it('getActiveAdapter honors ZYLOS_INSTANCE_ID instead of the global runtime', () => {
    const zylosDir = makeZylosDir({
      configRuntime: 'claude',
      instances: {
        admin: { runtime: 'claude' },
        'user-codex': { runtime: 'codex' },
      },
    });

    const adapter = getActiveAdapter(
      { runtime: 'claude' },
      { instanceId: 'user-codex', zylosDir }
    );

    assert.equal(adapter.runtimeId, 'codex');
  });

  it('getActiveAdapter honors a single-session sidecar profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-index-single-test-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zylos', 'config.json'), '{"runtime":"claude"}\n');
    fs.writeFileSync(path.join(dir, '.zylos', 'runtime-profiles.json'), JSON.stringify({
      persona_id: 'bohe',
      active_profile: 'codex-subscription',
      runtime_profiles: {
        'codex-subscription': {
          runtime: 'codex',
          codex_home: '~/.codex-subscription',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'high',
        },
      },
    }));

    const adapter = getActiveAdapter(
      { runtime: 'claude' },
      { zylosDir: dir, homeDir: '/home/operator' },
    );

    assert.equal(adapter.runtimeId, 'codex');
    assert.equal(adapter.config.runtimeProfile.id, 'codex-subscription');
    assert.equal(adapter.config.runtimeProfile.reasoningEffort, 'high');
  });
});
