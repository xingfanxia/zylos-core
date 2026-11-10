import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getInstanceRuntimeProfile,
  readFableGuardConfig,
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

  it('accepts an extra Claude account settings file and usage provider', () => {
    const resolve = profile => getInstanceRuntimeProfile({
      zylosDir: '/srv/zylos', homeDir: '/home/bohe',
      readFileSync: (filePath) => {
        if (filePath === '/srv/zylos/.zylos/runtime-profiles.json') {
          return JSON.stringify({ active_profile: 'claude-ax-cl', runtime_profiles: { 'claude-ax-cl': { runtime: 'claude', ...profile } } });
        }
        throw new Error('ENOENT');
      },
    });
    const ok = resolve({ usage_provider: 'claude-ax-cl', claude_settings_file: '/home/zylos-shared/auth/claude-ax-cl.settings.json' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.claudeSettingsFile, '/home/zylos-shared/auth/claude-ax-cl.settings.json');
    assert.equal(ok.usageProvider, 'claude-ax-cl');
    for (const file of ['relative.json', '/tmp/../etc/x.json', "/tmp/a b.json", "/tmp/x';id;'.json", '/tmp/x.toml']) {
      assert.ok(resolve({ claude_settings_file: file }).errors.includes('invalid_claude_settings_file'), file);
    }
    assert.ok(resolve({ usage_provider: 'claude-AX' }).errors.includes('invalid_usage_provider'));
  });

  it('accepts a Claude 1M-context model id and rejects shell metacharacters', () => {
    const resolve = model => getInstanceRuntimeProfile({
      zylosDir: '/srv/zylos', homeDir: '/home/bohe',
      readFileSync: (filePath) => {
        if (filePath === '/srv/zylos/.zylos/runtime-profiles.json') {
          return JSON.stringify({ active_profile: 'claude-subscription', runtime_profiles: {
            'claude-subscription': { runtime: 'claude', usage_provider: 'claude', model, reasoning_effort: 'high' },
          } });
        }
        throw new Error('ENOENT');
      },
    });
    assert.equal(resolve('claude-opus-5-5[1m]').model, 'claude-opus-5-5[1m]');
    assert.deepEqual(resolve('claude-opus-5-5[1m]').errors, []);
    for (const model of ["opus'; id #", 'opus[2m]', 'opus [1m]']) {
      assert.ok(resolve(model).errors.includes('invalid_model'), model);
    }
  });
});

describe('Fable guard launch decision', () => {
  const settings = '/home/zylos-shared/auth/claude-ax-backup.settings.json';
  const document = (extra = {}) => ({
    fable_guard: { fable_model: 'claude-fable-5-2[1m]' },
    runtime_profiles: {
      'claude-ax-backup': { runtime: 'claude', claude_settings_file: settings, model: 'claude-opus-5-5[1m]' },
      'claude-ax-main': { runtime: 'claude', model: 'claude-opus-5-5[1m]' },
      'codex-subscription': { runtime: 'codex', model: 'gpt-6-astra' },
    },
    instances: { 'user-pan': { runtime_profile: 'claude-ax-backup', fable_enabled: true, ...extra } },
  });
  const state = (desired, holds = {}) => ({ version: 1, holds, personas: { 'user-pan': { desired } } });
  const NOW = Date.parse('2026-11-10T08:00:00Z');
  const usageAt = (ageMs, utilization = 0.1) => ({ version: 1, accounts: { 'claude-ax-backup': { last_valid: {
    utilization, resets_at: '2026-11-13T06:00:00.000Z', observed_at: new Date(NOW - ageMs).toISOString() } } } });
  const resolve = (doc, guardState, usage = usageAt(60_000)) => resolveRuntimeProfile({ document: doc, instanceId: 'user-pan',
    fableGuardState: guardState, fableUsage: usage, nowMs: NOW });
  const fable = { account: 'claude-ax-backup', mode: 'fable', generation: 2 };

  it('admits Fable only on a fresh lease below the threshold, whatever the committed state says (review #1)', () => {
    for (const [name, usage] of [
      ['no observation', null],
      ['lease expired', usageAt(13 * 60_000)],
      ['dated in the future', usageAt(-10 * 60_000)],
      ['over the threshold', usageAt(60_000, 0.75)],
    ]) {
      const result = resolve(document(), state(fable), usage);
      assert.equal(result.model, 'claude-opus-5-5[1m]', name);
      assert.equal(result.fable.mode, 'opus', name);
    }
  });

  it('launches Fable only for the committed account without holds', () => {
    assert.equal(resolve(document(), state(fable)).model, 'claude-fable-5-2[1m]');
    assert.deepEqual(resolve(document(), state(fable)).fable, { mode: 'fable', generation: 2, reason: 'admitted', instanceId: 'user-pan' });
    for (const [name, guardState] of [
      ['no state', null],
      ['opus committed', state({ ...fable, mode: 'opus' })],
      ['other account', state({ ...fable, account: 'claude-ax-cl' })],
      ['bad generation', state({ ...fable, generation: '2' })],
      ['account held', state(fable, { 'claude-ax-backup': { quota: { since: 'x' } } })],
    ]) {
      const result = resolve(document(), guardState);
      assert.equal(result.model, 'claude-opus-5-5[1m]', name);
      assert.equal(result.fable.mode, 'opus', name);
      assert.equal(result.launchEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1', name);
    }
  });

  it('never launches Fable on an account without its own settings file or on Codex', () => {
    const main = document({ runtime_profile: 'claude-ax-main' });
    assert.equal(resolve(main, state({ ...fable, account: 'claude-ax-main' })).model, 'claude-opus-5-5[1m]');
    const codex = resolve(document({ runtime_profile: 'codex-subscription' }), state({ ...fable, account: 'codex-subscription' }));
    assert.equal(codex.model, 'gpt-6-astra');
    assert.equal(codex.launchEnv, undefined);
  });

  it('is inert without fable_enabled or without a valid config', () => {
    const off = resolve(document({ fable_enabled: false }), state(fable));
    assert.equal(off.fable, undefined);
    assert.equal(off.launchEnv, undefined);
    const doc = document();
    doc.fable_guard.fable_model = 'claude fable';
    assert.equal(resolve(doc, state(fable)).launchEnv, undefined);
  });

  it('applies documented defaults and bounds', () => {
    const config = readFableGuardConfig({ fable_guard: { fable_model: 'claude-fable-5-2', threshold: 75, lease_sec: 30,
      probe_accounts: ['claude-ax-backup', 'bad id', 7] } });
    assert.equal(config.threshold, 0.75);
    assert.equal(config.lease_sec, 720);
    assert.equal(config.probe_interval_sec, 300);
    assert.equal(config.subagent_model, 'claude-opus-5-5');
    assert.deepEqual(config.probe_accounts, ['claude-ax-backup']);
    assert.equal(readFableGuardConfig({ fable_guard: { fable_model: 'claude-fable-5-2', enabled: false } }), null);
  });
});
