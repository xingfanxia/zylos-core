import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { buildCleanEnv, buildCompatEnv, ensureInstanceTmpDir } from '../runtime/tmux-env.js';

const roots = [];
const home = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-runtime-temp-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('persona caches do not collide and stay private across repeated launches', () => {
  const runtimeHome = home();
  const first = ensureInstanceTmpDir({ HOME: runtimeHome, ZYLOS_INSTANCE_ID: 'admin', TMPDIR: '/tmp' });
  const second = ensureInstanceTmpDir({ HOME: runtimeHome, ZYLOS_INSTANCE_ID: 'scheduler', TMPDIR: first });
  assert.notEqual(first, second);
  fs.mkdirSync(path.join(first, 'gh-cli-cache'));
  fs.writeFileSync(path.join(first, 'gh-cli-cache', 'private-log'), 'admin log');
  assert.equal(fs.existsSync(path.join(second, 'gh-cli-cache')), false);
  assert.equal(ensureInstanceTmpDir({ HOME: runtimeHome, ZYLOS_INSTANCE_ID: 'admin' }), first);
  for (const dir of [path.dirname(first), first, second]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('temp setup rejects path traversal and existing symlink roots without modifying target', () => {
  const runtimeHome = home();
  const target = home();
  fs.chmodSync(target, 0o755);
  assert.throws(() => ensureInstanceTmpDir({ HOME: runtimeHome, ZYLOS_INSTANCE_ID: '../other' }), /identity/);
  fs.symlinkSync(target, path.join(runtimeHome, '.zylos-tmp'));
  assert.throws(() => ensureInstanceTmpDir({ HOME: runtimeHome, ZYLOS_INSTANCE_ID: 'group' }), /symlink/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(target, 'group')), false);
});

for (const clean of [true, false]) {
  test(`launcher creates writable isolated gh cache after env merge (${clean ? 'clean' : 'compat'})`, () => {
    const runtimeHome = home();
    const processEnv = { PATH: process.env.PATH, HOME: runtimeHome, TMPDIR: '/tmp' };
    const { env } = clean
      ? buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' })
      : buildCompatEnv({ processEnv, dotenvVars: {} });
    env.ZYLOS_INSTANCE_ID = 'group';
    const personaEnvFile = path.join(runtimeHome, '.env');
    fs.writeFileSync(personaEnvFile, 'TMPDIR=/not-owned/shared\nPERSONA_MARKER=retained\n');
    const spec = path.join(runtimeHome, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({
      command: process.execPath,
      args: ['-e', `
        const fs=require('fs'),path=require('path'),os=require('os');
        const cache=path.join(os.tmpdir(),'gh-cli-cache');
        fs.mkdirSync(cache);fs.writeFileSync(path.join(cache,'log'),'ok');
        console.log(JSON.stringify({tmp:os.tmpdir(),marker:process.env.PERSONA_MARKER}));
      `],
      cwd: runtimeHome, env, personaEnvFile,
    }));
    const result = JSON.parse(execFileSync(process.execPath,
      [path.resolve(import.meta.dirname, '../runtime/tmux-launcher.js'), spec],
      { encoding: 'utf8', timeout: 10000 }));
    assert.equal(result.tmp, path.join(runtimeHome, '.zylos-tmp', 'group'));
    assert.equal(result.marker, 'retained');
    assert.equal(fs.existsSync(spec), false);
    assert.equal(fs.readFileSync(path.join(result.tmp, 'gh-cli-cache', 'log'), 'utf8'), 'ok');
  });
}
