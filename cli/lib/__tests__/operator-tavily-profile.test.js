import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { operatorTavilyProfileArgs } from '../operator-tavily-profile.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-launch-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos'); const codexHome = path.join(root, '.codex-azure');
  fs.mkdirSync(path.join(zylosDir, 'instances/admin'), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, 'instances/scheduler')); fs.mkdirSync(path.join(zylosDir, 'instances/group'));
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const body = '[mcp_servers.tavily]\nurl = "https://mcp.tavily.com/mcp/?fixture=true"\n';
  fs.writeFileSync(path.join(codexHome, 'zylos-tavily.config.toml'), `# zylos-tavily-mcp-v1 ${hash(body)}\n# project-scope ${hash(zylosDir)}\n${body}`, { mode: 0o600 });
  return { root, zylosDir, codexHome, runtimeHome: root, instanceId: 'admin', osUser: null, instanceCwd: path.join(zylosDir, 'instances/admin') };
}
test('selects native overlay only for actual operator admin/scheduler CWDs', t => {
  const f = fixture(t);
  assert.deepEqual(operatorTavilyProfileArgs(f), ['-p', 'zylos-tavily']);
  assert.deepEqual(operatorTavilyProfileArgs({ ...f, instanceId: 'scheduler', instanceCwd: path.join(f.zylosDir, 'instances/scheduler') }), ['-p', 'zylos-tavily']);
  for (const change of [
    { osUser: 'zylos-group' }, { instanceId: 'group', instanceCwd: path.join(f.zylosDir, 'instances/group') },
    { instanceCwd: f.root }, { instanceId: undefined }, { runtimeHome: '/etc' },
  ]) assert.deepEqual(operatorTavilyProfileArgs({ ...f, ...change }), []);
});
test('preserves every existing explicit native profile selection and model arguments', t => {
  const f = fixture(t);
  for (const args of [['-p', 'custom'], ['--profile', 'custom'], ['--profile=custom'], ['-pcustom']]) {
    const before = [...args]; assert.deepEqual(operatorTavilyProfileArgs({ ...f, existingArgs: args }), []); assert.deepEqual(args, before);
  }
  const modelArgs = ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"'];
  assert.deepEqual(operatorTavilyProfileArgs({ ...f, existingArgs: modelArgs }), ['-p', 'zylos-tavily']);
  assert.equal(modelArgs[1], 'gpt-6-astra');
});
test('absent overlays are optional; public, redirected, tampered or wrong-scope overlays fail closed', t => {
  const f = fixture(t); const file = path.join(f.codexHome, 'zylos-tavily.config.toml'); const original = fs.readFileSync(file);
  fs.chmodSync(file, 0o644); assert.throws(() => operatorTavilyProfileArgs(f), /private/); fs.chmodSync(file, 0o600);
  fs.appendFileSync(file, '# edited'); assert.throws(() => operatorTavilyProfileArgs(f), /managed Zylos scope/);
  fs.writeFileSync(file, original.toString().replace(hash(f.zylosDir), hash('other-project'))); assert.throws(() => operatorTavilyProfileArgs(f), /scope/);
  fs.unlinkSync(file); assert.deepEqual(operatorTavilyProfileArgs(f), []);
  fs.symlinkSync('/etc/passwd', file); assert.throws(() => operatorTavilyProfileArgs(f), /private/);
});
