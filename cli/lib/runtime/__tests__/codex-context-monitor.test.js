import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];
const originalHome = process.env.HOME;
const originalInstanceId = process.env.ZYLOS_INSTANCE_ID;

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalInstanceId === undefined) delete process.env.ZYLOS_INSTANCE_ID;
  else process.env.ZYLOS_INSTANCE_ID = originalInstanceId;
});

describe('CodexContextMonitor', () => {
  it('scopes thread queries by instance cwd suffix', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    const { CodexContextMonitor } = await import(`../codex-context-monitor.js?scope=${Date.now()}`);
    const monitor = new CodexContextMonitor();
    assert.equal(monitor._getThreadScopeSql(), "cwd LIKE '%/instances/admin'");
  });

  it('prefers model_context_window from config.toml over models_cache', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-context-test-'));
    tmpDirs.push(tmpHome);
    process.env.HOME = tmpHome;
    delete process.env.ZYLOS_INSTANCE_ID;

    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model_context_window = 1000000\n', 'utf8');
    fs.writeFileSync(path.join(codexDir, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.4', context_window: 272000, effective_context_window_percent: 95 }],
    }, null, 2));

    const { CodexContextMonitor } = await import(`../codex-context-monitor.js?ceiling=${Date.now()}`);
    const monitor = new CodexContextMonitor();
    assert.equal(monitor._getModelCeiling(), 1000000);
  });
});
