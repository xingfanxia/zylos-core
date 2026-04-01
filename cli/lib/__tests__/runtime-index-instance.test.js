import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];

const {
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
});
