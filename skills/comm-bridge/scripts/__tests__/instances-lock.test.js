/**
 * ZY-LOCK-1 — advisory lock on instances.json. REAL module imports:
 *  - withFileLock (skills/multi-session/file-lock.js): happy path, release,
 *    stale-pid reclaim.
 *  - updateInstancesConfig under true cross-process concurrency: two child
 *    processes each add a distinct instance; with the lock, neither update is
 *    lost (without it, the second rename would clobber the first).
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { withFileLock } from '../../../multi-session/file-lock.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(SCRIPT_DIR, '../c4-instance-router.js');

describe('withFileLock', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('runs the critical section, returns its value, and releases the lock', () => {
    const lockDir = path.join(tmp, 'a.lock');
    const result = withFileLock(lockDir, () => 42);
    assert.equal(result, 42);
    assert.equal(fs.existsSync(lockDir), false); // released
  });

  it('releases the lock even when the critical section throws', () => {
    const lockDir = path.join(tmp, 'b.lock');
    assert.throws(() => withFileLock(lockDir, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lockDir), false);
  });

  it('reclaims a stale lock left by a dead pid', () => {
    const lockDir = path.join(tmp, 'c.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '999999'); // almost certainly dead
    let ran = false;
    withFileLock(lockDir, () => { ran = true; }, { retries: 3, sleepMs: 5 });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockDir), false);
  });
});

describe('updateInstancesConfig — concurrent writers keep both updates', () => {
  let tmp;
  const instancesFile = () => path.join(tmp, 'instances.json');

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instances-lock-'));
    fs.writeFileSync(instancesFile(), JSON.stringify({ version: 1, instances: { base: {} } }, null, 2));
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // Child holds the lock ~80ms inside the mutator, widening the race window so
  // an unlocked read-modify-write would deterministically lose one update.
  function child(key) {
    const code = `
      process.env.ZYLOS_DIR = ${JSON.stringify(tmp)};
      const { updateInstancesConfig } = await import(${JSON.stringify(ROUTER)});
      updateInstancesConfig((cfg) => {
        cfg = cfg || { version: 1, instances: {} };
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        cfg.instances[${JSON.stringify(key)}] = { added: ${JSON.stringify(key)} };
        return cfg;
      });
    `;
    return new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
      cp.on('exit', (codeNum) => (codeNum === 0 ? resolve() : reject(new Error(`child ${key} exit ${codeNum}`))));
      cp.on('error', reject);
    });
  }

  it('does not lose an update when two processes mutate concurrently', async () => {
    await Promise.all([child('k0'), child('k1')]);
    const final = JSON.parse(fs.readFileSync(instancesFile(), 'utf8'));
    assert.ok(final.instances.base, 'pre-existing instance survived');
    assert.ok(final.instances.k0, 'k0 update survived');
    assert.ok(final.instances.k1, 'k1 update survived');
  });
});
