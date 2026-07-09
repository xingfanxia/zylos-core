import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-fetch.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));
const DB_MODULE = fileURLToPath(new URL('../c4-db.js', import.meta.url));

// Seed a DELIVERED inbound conversation — the state that exists AFTER the
// dispatcher has delivered a message to the agent. `--unsummarized` counts only
// delivered rows (undelivered/pending messages the agent hasn't seen yet are not
// conversation history to summarize), so a freshly-`receive`d message (which is
// correctly 'pending' until dispatched) is the wrong precondition for it.
function insertDelivered(content, env = {}) {
  // Tagged with the fixture instance — scoped reads are strict (NULL-target
  // rows are excluded to prevent cross-instance bleed), same as dispatcher rows.
  const code = `const { insertConversation, close } = await import(${JSON.stringify(DB_MODULE)});`
    + ` insertConversation('in','system',null,${JSON.stringify(content)},'delivered',3,false,null,'test-instance'); close();`;
  return spawnSync('node', ['--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-fetch-cli-'));
  // Explicit instance scope: checkpoint create/latest refuse to run unscoped,
  // and pinning it here keeps results identical across runner environments.
  const env = { ZYLOS_DIR: tmpDir, ZYLOS_INSTANCE_ID: 'test-instance' };
  // Warm up DB
  checkpoint(['latest'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// -- --unsummarized --

describe('c4-fetch --unsummarized', () => {
  it('reports no unsummarized conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No unsummarized conversations'));
    });
  });

  it('fetches unsummarized conversations', () => {
    withTmpDir(({ env }) => {
      insertDelivered('msg1', env);
      insertDelivered('msg2', env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Unsummarized Range'));
      assert.ok(stdout.includes('count=2'));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('keeps inbound endpoint content clean without reply routing', () => {
    withTmpDir(({ tmpDir, env }) => {
      fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
      receive(['--channel', 'telegram', '--endpoint', '123', '--content', 'clean msg'], env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('clean msg'));
      assert.ok(!stdout.includes('reply via:'));
    });
  });

  it('includes last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      insertDelivered('old msg', env);
      checkpoint(['create', '1', '--summary', 'First sync done'], env);
      insertDelivered('new msg', env);

      const { stdout, status } = cli(['--unsummarized'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('First sync done'));
      assert.ok(stdout.includes('new msg'));
      assert.ok(!stdout.includes('old msg'));
    });
  });
});

// -- --begin / --end --

describe('c4-fetch --begin --end', () => {
  it('fetches conversations in range', () => {
    withTmpDir(({ env }) => {
      // Rows must carry the fixture instance tag — scoped range reads are
      // strict, and bare c4-receive rows (no instances.json in tmpdir) are
      // untagged and thus invisible to a scoped fetch.
      insertDelivered('msg1', env);
      insertDelivered('msg2', env);
      insertDelivered('msg3', env);

      const { stdout, status } = cli(['--begin', '1', '--end', '2'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(!stdout.includes('msg3'));
    });
  });

  it('reports no conversations for empty range', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['--begin', '100', '--end', '200'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No conversations in this range'));
    });
  });
});

// -- validation --

describe('c4-fetch validation', () => {
  it('errors with no arguments', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('errors with incomplete --begin/--end', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['--begin', '1'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });
});
