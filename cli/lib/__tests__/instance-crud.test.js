/**
 * cli instance CRUD — REAL invocation of instanceCommand() (previously zero
 * coverage on 800+ LOC of live instances.json CRUD). Runs the command in child
 * processes against a temp ZYLOS_DIR so its error-path process.exit(1) calls
 * don't tear down the test runner. Pure-CRUD subcommands only (create / disable
 * / list) — start/stop/destroy drive tmux/filesystem and are out of scope here.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_MOD = fileURLToPath(new URL('../../commands/instance.js', import.meta.url));

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-crud-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function run(args, zylosDir) {
  const code = `const { instanceCommand } = await import(${JSON.stringify(CLI_MOD)}); await instanceCommand(${JSON.stringify(args)});`;
  const r = spawnSync('node', ['--input-type=module', '-e', code], {
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readInstances(zylosDir) {
  return JSON.parse(fs.readFileSync(path.join(zylosDir, 'instances.json'), 'utf8'));
}

describe('zylos instance create', () => {
  it('creates a new instance entry in instances.json', () => {
    withTmp((dir) => {
      const r = run(['create', 'test-x', '--type', 'dedicated'], dir);
      assert.equal(r.status, 0);
      const cfg = readInstances(dir);
      assert.ok(cfg.instances['test-x']);
      assert.equal(cfg.instances['test-x'].type, 'dedicated');
      assert.equal(cfg.instances['test-x'].enabled, true);
      assert.equal(cfg.instances['test-x'].primary, false);
    });
  });

  it('rejects a duplicate id (exit 1, config unchanged)', () => {
    withTmp((dir) => {
      assert.equal(run(['create', 'dup'], dir).status, 0);
      const before = fs.readFileSync(path.join(dir, 'instances.json'), 'utf8');
      assert.notEqual(run(['create', 'dup'], dir).status, 0);
      assert.equal(fs.readFileSync(path.join(dir, 'instances.json'), 'utf8'), before);
    });
  });

  it('rejects an invalid id (exit 1)', () => {
    withTmp((dir) => {
      assert.notEqual(run(['create', 'bad id!'], dir).status, 0);
    });
  });
});

describe('zylos instance disable', () => {
  it('marks an existing instance disabled', () => {
    withTmp((dir) => {
      run(['create', 'test-y'], dir);
      const r = run(['disable', 'test-y'], dir);
      assert.equal(r.status, 0);
      assert.equal(readInstances(dir).instances['test-y'].enabled, false);
    });
  });
});

describe('zylos instance list', () => {
  it('lists without error after a create', () => {
    withTmp((dir) => {
      run(['create', 'test-z'], dir);
      const r = run(['list'], dir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /test-z/);
    });
  });
});
