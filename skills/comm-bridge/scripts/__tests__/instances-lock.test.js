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

  it('does not reclaim a lock whose ownership record is incomplete', () => {
    const lockDir = path.join(tmp, 'd.lock');
    fs.mkdirSync(lockDir);
    assert.throws(
      () => withFileLock(lockDir, () => {}, { retries: 1, sleepMs: 1 }),
      /could not acquire/,
    );
    assert.equal(fs.existsSync(lockDir), true);
  });
});

describe('updateInstancesConfig — concurrent writers keep both updates', () => {
  let tmp;
  const instancesFile = () => path.join(tmp, 'instances.json');

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instances-lock-'));
    fs.writeFileSync(instancesFile(), JSON.stringify({ version: 1, instances: { base: {} } }, null, 2));
    fs.chmodSync(instancesFile(), 0o640);
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // Child holds the lock ~80ms inside the mutator, widening the race window so
  // an unlocked read-modify-write would deterministically lose one update.
  function child(key) {
    const code = `
      process.umask(0o077);
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
    const beforeMetadata = fs.statSync(instancesFile());
    await Promise.all([child('k0'), child('k1')]);
    const final = JSON.parse(fs.readFileSync(instancesFile(), 'utf8'));
    const afterMetadata = fs.statSync(instancesFile());
    assert.ok(final.instances.base, 'pre-existing instance survived');
    assert.ok(final.instances.k0, 'k0 update survived');
    assert.ok(final.instances.k1, 'k1 update survived');
    assert.equal(afterMetadata.uid, beforeMetadata.uid, 'owner uid survived atomic rename');
    assert.equal(afterMetadata.gid, beforeMetadata.gid, 'group gid survived atomic rename');
    assert.equal(afterMetadata.mode & 0o777, 0o640, '0640 survived a writer umask of 0077');
    assert.deepEqual(
      fs.readdirSync(tmp).filter(name => name.startsWith('instances.json.tmp')),
      [],
      'no temporary file was left behind',
    );
  });

  it('keeps the original file when metadata restoration fails', async () => {
    const original = fs.readFileSync(instancesFile(), 'utf8');
    const code = `
      process.env.ZYLOS_DIR = ${JSON.stringify(tmp)};
      const fs = (await import('node:fs')).default;
      fs.chownSync = () => { throw new Error('forced metadata failure'); };
      const { updateInstancesConfig } = await import(${JSON.stringify(ROUTER)});
      try {
        updateInstancesConfig((cfg) => {
          cfg.instances.must_not_commit = {};
          return cfg;
        });
        process.exit(2);
      } catch (err) {
        if (!String(err.message).includes('forced metadata failure')) process.exit(3);
      }
    `;
    await new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
      cp.on('exit', (codeNum) => (codeNum === 0 ? resolve() : reject(new Error(`failure child exit ${codeNum}`))));
      cp.on('error', reject);
    });
    assert.equal(fs.readFileSync(instancesFile(), 'utf8'), original);
    assert.deepEqual(
      fs.readdirSync(tmp).filter(name => name.startsWith('instances.json.tmp')),
      [],
      'failed write cleaned up its temporary file',
    );
  });
});
