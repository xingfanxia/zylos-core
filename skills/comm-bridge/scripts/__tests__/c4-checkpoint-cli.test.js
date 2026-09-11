import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../c4-checkpoint.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    // Clear ZYLOS_INSTANCE_ID from the runner's env so tests are deterministic
    // everywhere (agent sessions export it; CI does not). Tests opt in via env.
    env: { ...process.env, ZYLOS_INSTANCE_ID: '', ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Create a fresh tmpDir and initialize the DB by running a harmless command.
 * This avoids "[C4-DB] Database initialized" polluting stdout in later calls.
 * env carries a default instance scope — create/latest refuse to run unscoped.
 */
function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-checkpoint-cli-'));
  const env = { ZYLOS_DIR: tmpDir, ZYLOS_INSTANCE_ID: 'test-instance' };
  // Warm up: initialize DB so subsequent calls have clean stdout.
  cli(['list'], env);
  try {
    return fn({ tmpDir, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Note: init-db.sql inserts an "initial" checkpoint (id=1, summary='initial').
// All tests account for this seed record.

// -- create --

describe('c4-checkpoint create', () => {
  it('creates a checkpoint and prints result', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['create', '10', '--summary', 'First batch'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Checkpoint created:'));
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.start_conversation_id, 1);
      assert.equal(json.end_conversation_id, 10);
      assert.equal(json.target_instance, 'test-instance');
    });
  });

  it('auto-computes start_conversation_id from previous checkpoint', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      const { stdout, status } = cli(['create', '25', '--summary', 'Second'], env);
      assert.equal(status, 0);
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.start_conversation_id, 11);
      assert.equal(json.end_conversation_id, 25);
    });
  });

  it('creates checkpoint without --summary', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['create', '5'], env);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Checkpoint created:'));
    });
  });
});

// -- create validation --

describe('c4-checkpoint create validation', () => {
  it('errors when end_conversation_id is missing', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['create'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('end_conversation_id'));
    });
  });

  it('errors when end_conversation_id is not a number', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['create', 'abc'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('number'));
    });
  });
});

// -- list --

describe('c4-checkpoint list', () => {
  it('returns seed checkpoint on fresh DB', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['list'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].summary, 'initial');
    });
  });

  it('lists checkpoints in reverse chronological order', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);
      cli(['create', '30', '--summary', 'Third'], env);

      const { stdout, status } = cli(['list'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      // 3 created + 1 seed = 4
      assert.equal(rows.length, 4);
      assert.equal(rows[0].summary, 'Third');
      assert.equal(rows[1].summary, 'Second');
      assert.equal(rows[2].summary, 'First');
      assert.equal(rows[3].summary, 'initial');
    });
  });

  it('respects --limit', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);
      cli(['create', '30', '--summary', 'Third'], env);

      const { stdout, status } = cli(['list', '--limit', '2'], env);
      assert.equal(status, 0);
      const rows = JSON.parse(stdout);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].summary, 'Third');
      assert.equal(rows[1].summary, 'Second');
    });
  });

  it('errors on invalid --limit', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['list', '--limit', '-1'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('positive integer'));
    });
  });
});

// -- latest --

describe('c4-checkpoint latest', () => {
  it('returns the most recent checkpoint', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'First'], env);
      cli(['create', '20', '--summary', 'Second'], env);

      const { stdout, status } = cli(['latest'], env);
      assert.equal(status, 0);
      const row = JSON.parse(stdout);
      assert.equal(row.summary, 'Second');
      assert.equal(row.end_conversation_id, 20);
    });
  });

  it('does not see the unscoped seed checkpoint (strict instance scoping)', () => {
    withTmpDir(({ env }) => {
      // The init-db.sql seed row has NULL target_instance — scoped readers
      // must never surface it (that global fallback was the bleed source).
      const { stderr, status } = cli(['latest'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('no checkpoints found'));
    });
  });
});

// -- instance scoping (checkpoints must never be written unscoped) --

describe('c4-checkpoint instance scoping', () => {
  it('create refuses to run without an instance scope and writes nothing', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['create', '10', '--summary', 'orphan'], { ...env, ZYLOS_INSTANCE_ID: '' });
      assert.equal(status, 1);
      assert.ok(stderr.includes('--target-instance'));
      // No NULL-target row was written: global list still shows only the seed.
      const { stdout } = cli(['list'], env);
      assert.equal(JSON.parse(stdout).length, 1);
    });
  });

  it('create honors --target-instance without ZYLOS_INSTANCE_ID', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(
        ['create', '10', '--summary', 'flagged', '--target-instance', 'flag-inst'],
        { ...env, ZYLOS_INSTANCE_ID: '' }
      );
      assert.equal(status, 0);
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.target_instance, 'flag-inst');
    });
  });

  it('--target-instance overrides ZYLOS_INSTANCE_ID', () => {
    withTmpDir(({ env }) => {
      const { stdout, status } = cli(['create', '10', '--target-instance', 'other-inst'], env);
      assert.equal(status, 0);
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      assert.equal(json.target_instance, 'other-inst');
    });
  });

  it('keeps start_conversation_id chains independent per instance', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'A1'], env);
      const { stdout } = cli(['create', '20', '--summary', 'B1', '--target-instance', 'other-inst'], env);
      const json = JSON.parse(stdout.replace('Checkpoint created: ', ''));
      // other-inst has no prior checkpoint — its chain starts at 1, not 11.
      assert.equal(json.start_conversation_id, 1);
      assert.equal(json.end_conversation_id, 20);
    });
  });

  it('latest refuses to run without an instance scope', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['latest'], { ...env, ZYLOS_INSTANCE_ID: '' });
      assert.equal(status, 1);
      assert.ok(stderr.includes('--target-instance'));
    });
  });

  it('latest honors --target-instance and stays scoped', () => {
    withTmpDir(({ env }) => {
      cli(['create', '10', '--summary', 'mine'], env);
      const ok = cli(['latest', '--target-instance', 'test-instance'], { ...env, ZYLOS_INSTANCE_ID: '' });
      assert.equal(ok.status, 0);
      assert.equal(JSON.parse(ok.stdout).summary, 'mine');
      // A different instance sees nothing — no cross-instance fallback.
      const other = cli(['latest', '--target-instance', 'other-inst'], env);
      assert.equal(other.status, 1);
      assert.ok(other.stderr.includes('no checkpoints found'));
    });
  });
});

// -- unknown command --

describe('c4-checkpoint unknown command', () => {
  it('rejects unknown subcommand', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['foobar'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('unknown command'));
    });
  });

  it('rejects bare number (no legacy fallback)', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['50'], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('unknown command'));
    });
  });
});

// -- help --

describe('c4-checkpoint help', () => {
  it('--help shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['--help'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('-h shows usage and exits 0', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli(['-h'], env);
      assert.equal(status, 0);
      assert.ok(stderr.includes('Usage'));
    });
  });

  it('no arguments shows usage and exits 1', () => {
    withTmpDir(({ env }) => {
      const { stderr, status } = cli([], env);
      assert.equal(status, 1);
      assert.ok(stderr.includes('Usage'));
    });
  });
});
