import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getInstanceRuntimeProfile,
  resolveRuntimeProfile,
} from '../../../skills/multi-session/runtime-files.js';

describe('runtime profile resolution', () => {
  it('keeps isolated Codex homes inside the instance unix home', () => {
    const result = resolveRuntimeProfile({
      document: {
        runtime_profiles: {
          sub: { runtime: 'codex', codex_home: '~/.codex-subscription' },
        },
        instances: {
          'user-pan': { runtime_profile: 'sub', os_user: 'zylos-pan' },
        },
      },
      instanceId: 'user-pan',
      homeDir: '/home/operator',
    });

    assert.equal(result.runtime, 'codex');
    assert.equal(result.runtimeHome, '/home/zylos-pan');
    assert.equal(result.codexHome, '/home/zylos-pan/.codex-subscription');
    assert.deepEqual(result.errors, []);
  });

  it('fails closed when an isolated profile tries to escape its unix home', () => {
    const result = resolveRuntimeProfile({
      document: {
        runtime_profiles: {
          bad: {
            runtime: 'codex',
            codex_home: '/home/operator/.codex',
            provider_env_key: 'AZURE_KEY;env',
            api_key: 'must-never-be-a-profile-field',
          },
        },
        instances: {
          'user-pan': { runtime_profile: 'bad', os_user: 'zylos-pan' },
        },
      },
      instanceId: 'user-pan',
      homeDir: '/home/operator',
    });

    assert.equal(result.codexHome, '/home/zylos-pan/.codex');
    assert.equal(result.providerEnvKey, null);
    assert.ok(result.errors.includes('codex_home_outside_runtime_home'));
    assert.ok(result.errors.includes('invalid_provider_env_key'));
    assert.ok(result.errors.includes('secret_field_not_allowed'));
    assert.equal(JSON.stringify(result).includes('must-never-be-a-profile-field'), false);
  });

  it('resolves an upstream single-session profile without instances.json', () => {
    const files = new Map([
      ['/srv/zylos/.zylos/config.json', JSON.stringify({ runtime: 'claude' })],
      ['/srv/zylos/.zylos/runtime-profiles.json', JSON.stringify({
        persona_id: 'bohe',
        active_profile: 'codex-subscription',
        runtime_profiles: {
          'codex-subscription': {
            runtime: 'codex',
            codex_home: '~/.codex-subscription',
            model: 'gpt-5.6-sol',
            reasoning_effort: 'high',
            usage_provider: 'codex',
          },
        },
      })],
    ]);
    const result = getInstanceRuntimeProfile({
      zylosDir: '/srv/zylos',
      homeDir: '/home/bohe',
      readFileSync: (filePath) => {
        if (!files.has(filePath)) throw new Error('ENOENT');
        return files.get(filePath);
      },
    });

    assert.equal(result.id, 'codex-subscription');
    assert.equal(result.runtime, 'codex');
    assert.equal(result.runtimeHome, '/home/bohe');
    assert.equal(result.codexHome, '/home/bohe/.codex-subscription');
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.reasoningEffort, 'high');
    assert.deepEqual(result.errors, []);
  });
});
