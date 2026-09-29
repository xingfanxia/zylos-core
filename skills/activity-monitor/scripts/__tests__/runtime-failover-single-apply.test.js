import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// runtime-failover.js resolves its files from ZYLOS_DIR at import time.
const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-single-apply-'));
process.env.ZYLOS_DIR = zylosDir;
const { applyRuntimeFailover } = await import('../runtime-failover.js');

describe('single-session apply restarts the dispatcher only on a runtime change', () => {
  const nowMs = Date.parse('2026-09-29T22:00:00Z');
  const seen = value => ({ available: true, quota_authoritative: true, observed_at: new Date(nowMs).toISOString(),
    primary: { used_percent: value, resets_at: '2099-01-01T00:00:00Z' } });
  const run = (active, chain, profiles, usage) => {
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: profiles[active].runtime }));
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'runtime-profiles.json'), JSON.stringify({
      persona_id: 'bohe', active_profile: active, tmux_session: 'claude-main', monitor_name: 'activity-monitor',
      state_dir: path.join(zylosDir, 'activity-monitor'), runtime_profiles: profiles,
      runtime_profile_changed_at: new Date(nowMs - 600_000).toISOString(),
      runtime_failover: { enabled: true, chain, switch_threshold: 95, recover_threshold: 90, min_dwell_sec: 300, auto_recover: true },
    }));
    const calls = [];
    applyRuntimeFailover({ providerUsage: { providers: usage }, nowMs, log: () => {},
      execFileSyncImpl: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return ''; } });
    return { calls, config: JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8')) };
  };

  it('Codex -> Claude recovery restarts monitor and dispatcher', () => {
    const profiles = { 'claude-subscription': { runtime: 'claude', usage_provider: 'claude' },
      'codex-subscription': { runtime: 'codex', usage_provider: 'codex' } };
    const { calls, config } = run('codex-subscription', Object.keys(profiles), profiles, { claude: seen(10), codex: seen(10) });
    assert.equal(config.runtime, 'claude');
    assert.deepEqual(calls, ['tmux kill-session -t claude-main', 'pm2 restart activity-monitor --update-env', 'pm2 restart c4-dispatcher']);
  });

  it('Codex -> Azure keeps the dispatcher running', () => {
    const profiles = { 'codex-subscription': { runtime: 'codex', usage_provider: 'codex' },
      'codex-azure': { runtime: 'codex', usage_provider: null } };
    const { calls } = run('codex-subscription', Object.keys(profiles), profiles, { codex: seen(99) });
    assert.deepEqual(calls, ['tmux kill-session -t claude-main', 'pm2 restart activity-monitor --update-env']);
  });
});
