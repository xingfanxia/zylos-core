import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));
const DB_MODULE = fileURLToPath(new URL('../c4-db.js', import.meta.url));
const CHECKPOINT_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// Seed a DELIVERED inbound conversation — the post-dispatch state session-init
// injects. A freshly-`receive`d message is correctly 'pending' until the
// dispatcher delivers it, and session-init counts only delivered rows, so
// delivered is the right precondition here.
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

function checkpoint(args, env = {}) {
  return spawnSync('node', [CHECKPOINT_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-session-init-'));
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

// -- basic behavior --

describe('c4-session-init', () => {
  it('reports no new conversations on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('No new conversations since last checkpoint'));
    });
  });

  it('outputs last checkpoint summary', () => {
    withTmpDir(({ env }) => {
      insertDelivered('msg1', env);
      checkpoint(['create', '1', '--summary', 'Synced first batch'], env);
      insertDelivered('msg2', env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== LAST CHECKPOINT SUMMARY ==='));
      assert.ok(stdout.includes('=== END LAST CHECKPOINT SUMMARY ==='));
      assert.ok(stdout.includes('Synced first batch'));
      assert.ok(stdout.includes('msg2'));
    });
  });

  it('emits a fallback block when the last checkpoint has no summary', () => {
    withTmpDir(({ env }) => {
      insertDelivered('msg1', env);
      // Checkpoint created without --summary → summary is null.
      checkpoint(['create', '1'], env);
      insertDelivered('msg2', env);

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      // The checkpoint block must still appear (not silently vanish).
      assert.ok(stdout.includes('=== LAST CHECKPOINT ==='));
      assert.ok(stdout.includes('no summary'));
      // And it must NOT masquerade as a summary block.
      assert.ok(!stdout.includes('=== LAST CHECKPOINT SUMMARY ==='));
    });
  });

  it('shows recent conversations when under threshold', () => {
    withTmpDir(({ env }) => {
      for (let i = 1; i <= 3; i++) {
        insertDelivered(`msg${i}`, env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('=== END RECENT CONVERSATIONS ==='));
      assert.ok(stdout.includes('msg1'));
      assert.ok(stdout.includes('msg2'));
      assert.ok(stdout.includes('msg3'));
      // Should NOT trigger Memory Sync instruction
      assert.ok(!stdout.includes('ACTION REQUIRED'));
    });
  });

  it('triggers Memory Sync instruction when over threshold', () => {
    withTmpDir(({ env }) => {
      // CHECKPOINT_THRESHOLD is 15; insert 31 messages (well over threshold)
      for (let i = 1; i <= 31; i++) {
        insertDelivered(`msg${i}`, env);
      }

      const { stdout, status } = cli([], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('=== ACTION REQUIRED ==='));
      assert.ok(stdout.includes('zylos-memory'));
      // Should show limited conversations (SESSION_INIT_RECENT_COUNT = 6)
      assert.ok(stdout.includes('msg31'));
      assert.ok(stdout.includes('msg26'));
      // msg1 should NOT be included (limited to recent)
      assert.ok(!stdout.match(/IN \(system\):\nmsg1\n/));
    });
  });
});
