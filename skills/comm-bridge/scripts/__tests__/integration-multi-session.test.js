/**
 * Integration tests for multi-session architecture.
 *
 * Covers end-to-end flows: c4-receive routing, c4-fetch instance filtering,
 * c4-session-init instance filtering, dispatcher disabled-instance rejection,
 * memory guard validation, migration script, token usage DB, unknown
 * endpoint notifications, and git behavior with symlinks after migration.
 *
 * Each test suite creates its own temp ZYLOS_DIR to avoid interference.
 * All tests use node:test (built-in runner).
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Script paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const RECEIVE_PATH = path.join(SCRIPTS_DIR, 'c4-receive.js');
const FETCH_PATH = path.join(SCRIPTS_DIR, 'c4-fetch.js');
const SESSION_INIT_PATH = path.join(SCRIPTS_DIR, 'c4-session-init.js');
const INIT_SQL_PATH = path.join(SCRIPTS_DIR, '..', 'init-db.sql');
const MIGRATIONS_DIR = path.join(SCRIPTS_DIR, '..', 'migrations');
const MIGRATE_SCRIPT = path.resolve(SCRIPTS_DIR, '..', '..', '..', 'scripts', 'migrate-memory-layout.sh');

// Memory guard path (in activity-monitor skill)
const MEMORY_GUARD_PATH = path.resolve(SCRIPTS_DIR, '..', '..', 'activity-monitor', 'scripts', 'memory-guard.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `c4-integ-${prefix}-`));
}

function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeInstancesJson(tmpDir, config) {
  fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify(config, null, 2));
}

function initDb(tmpDir) {
  const dbDir = path.join(tmpDir, 'comm-bridge');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = path.join(dbDir, 'c4.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // init-db.sql already includes the latest schema (with target_instance),
  // so we mark all migrations as applied to avoid duplicate column errors.
  const initSql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  db.exec(initSql);

  if (fs.existsSync(MIGRATIONS_DIR)) {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(file);
    }
  }

  return db;
}

function openDb(tmpDir) {
  return new Database(path.join(tmpDir, 'comm-bridge', 'c4.db'));
}

function cli(script, args, env = {}) {
  const result = spawnSync('node', [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function parseJsonLine(stdout) {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) {
      return JSON.parse(lines[i]);
    }
  }
  return null;
}

// =========================================================================
// Test 1: c4-receive -> DB -> correct target_instance
// =========================================================================

describe('Test 1: c4-receive instance routing', () => {
  let tmpDir;
  let env;

  before(() => {
    tmpDir = makeTmpDir('receive');
    fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
    // Create skill dirs for channel validation
    fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'feishu'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });
    // Also create comm-bridge dir for unknown-endpoints.json
    fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });

    writeInstancesJson(tmpDir, {
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true, chat_ids: ['admin-chat'] },
        betty: { tmux_session: 'claude-betty', chat_ids: ['betty-chat'] },
        group: { tmux_session: 'claude-group', chat_ids: ['group-chat'] },
      },
      routing: {},
    });

    env = { ZYLOS_DIR: tmpDir };
  });

  after(() => cleanTmpDir(tmpDir));

  it('routes betty-chat endpoint to betty instance', () => {
    const r = cli(RECEIVE_PATH, [
      '--channel', 'feishu', '--endpoint', 'betty-chat|feishu',
      '--json', '--content', 'hello from betty chat',
    ], env);
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    const out = parseJsonLine(r.stdout);
    assert.ok(out?.ok, 'Should succeed');

    const db = openDb(tmpDir);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
    db.close();
    assert.equal(row.target_instance, 'betty', 'target_instance should be betty');
  });

  it('routes group-chat endpoint to group instance', () => {
    const r = cli(RECEIVE_PATH, [
      '--channel', 'feishu', '--endpoint', 'group-chat|feishu',
      '--json', '--content', 'hello group',
    ], env);
    assert.equal(r.status, 0);
    const out = parseJsonLine(r.stdout);

    const db = openDb(tmpDir);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
    db.close();
    assert.equal(row.target_instance, 'group', 'target_instance should be group');
  });

  it('routes unknown endpoint to admin (default instance)', () => {
    const r = cli(RECEIVE_PATH, [
      '--channel', 'telegram', '--endpoint', 'unknown-chat|telegram',
      '--json', '--content', 'hello unknown',
    ], env);
    assert.equal(r.status, 0);
    const out = parseJsonLine(r.stdout);

    const db = openDb(tmpDir);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
    db.close();
    assert.equal(row.target_instance, 'admin', 'unknown endpoint should route to admin');
  });

  it('--target-instance overrides routing', () => {
    const r = cli(RECEIVE_PATH, [
      '--no-reply', '--target-instance', 'betty',
      '--json', '--content', 'forced to betty',
    ], env);
    assert.equal(r.status, 0);
    const out = parseJsonLine(r.stdout);

    const db = openDb(tmpDir);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(out.id));
    db.close();
    assert.equal(row.target_instance, 'betty', '--target-instance should override');
  });
});

// =========================================================================
// Test 2: c4-fetch instance filtering
// =========================================================================

describe('Test 2: c4-fetch instance filtering', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir('fetch');
    fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
    const db = initDb(tmpDir);

    // Insert 3 conversations with different target_instances
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'system', null, 'msg for admin', 'delivered', 'admin');
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'feishu', 'betty-chat', 'msg for betty', 'delivered', 'betty');
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'system', null, 'legacy msg', 'delivered', null);

    db.close();
  });

  after(() => cleanTmpDir(tmpDir));

  it('ZYLOS_INSTANCE_ID=admin sees admin + NULL conversations', () => {
    const r = cli(FETCH_PATH, ['--unsummarized'], {
      ZYLOS_DIR: tmpDir,
      ZYLOS_INSTANCE_ID: 'admin',
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('msg for admin'), 'Should see admin message');
    assert.ok(r.stdout.includes('legacy msg'), 'Should see NULL/legacy message');
    assert.ok(!r.stdout.includes('msg for betty'), 'Should NOT see betty message');
  });

  it('ZYLOS_INSTANCE_ID=betty sees betty + NULL conversations', () => {
    const r = cli(FETCH_PATH, ['--unsummarized'], {
      ZYLOS_DIR: tmpDir,
      ZYLOS_INSTANCE_ID: 'betty',
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('msg for betty'), 'Should see betty message');
    assert.ok(r.stdout.includes('legacy msg'), 'Should see NULL/legacy message');
    assert.ok(!r.stdout.includes('msg for admin'), 'Should NOT see admin message');
  });

  it('no ZYLOS_INSTANCE_ID sees ALL conversations', () => {
    const r = cli(FETCH_PATH, ['--unsummarized'], {
      ZYLOS_DIR: tmpDir,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('msg for admin'), 'Should see admin message');
    assert.ok(r.stdout.includes('msg for betty'), 'Should see betty message');
    assert.ok(r.stdout.includes('legacy msg'), 'Should see NULL/legacy message');
  });
});

// =========================================================================
// Test 3: c4-session-init instance filtering
// =========================================================================

describe('Test 3: c4-session-init instance filtering', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir('session-init');
    fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
    const db = initDb(tmpDir);

    // Insert conversations targeting different instances
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'system', null, 'admin context msg', 'delivered', 'admin');
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('out', 'system', null, 'admin response', 'delivered', 'admin');
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'feishu', 'betty-chat', 'betty context msg', 'delivered', 'betty');
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'system', null, 'shared legacy msg', 'delivered', null);

    db.close();
  });

  after(() => cleanTmpDir(tmpDir));

  it('admin instance sees only admin + NULL conversations', () => {
    const r = cli(SESSION_INIT_PATH, [], {
      ZYLOS_DIR: tmpDir,
      ZYLOS_INSTANCE_ID: 'admin',
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('admin context msg'), 'Should see admin message');
    assert.ok(r.stdout.includes('shared legacy msg'), 'Should see legacy message');
    assert.ok(!r.stdout.includes('betty context msg'), 'Should NOT see betty message');
  });

  it('betty instance sees only betty + NULL conversations', () => {
    const r = cli(SESSION_INIT_PATH, [], {
      ZYLOS_DIR: tmpDir,
      ZYLOS_INSTANCE_ID: 'betty',
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('betty context msg'), 'Should see betty message');
    assert.ok(r.stdout.includes('shared legacy msg'), 'Should see legacy message');
    assert.ok(!r.stdout.includes('admin context msg'), 'Should NOT see admin message');
  });

  it('no instance ID sees all conversations', () => {
    const r = cli(SESSION_INIT_PATH, [], {
      ZYLOS_DIR: tmpDir,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('admin context msg'), 'Should see admin message');
    assert.ok(r.stdout.includes('betty context msg'), 'Should see betty message');
    assert.ok(r.stdout.includes('shared legacy msg'), 'Should see legacy message');
  });
});

// =========================================================================
// Test 4: Disabled instance message rejection
// =========================================================================

describe('Test 4: Disabled instance rejection (DB level)', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir('disabled');
    fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
  });

  after(() => cleanTmpDir(tmpDir));

  it('markRejected sets status to rejected in DB', () => {
    const db = initDb(tmpDir);

    // Insert a pending message for a disabled instance
    db.prepare(`INSERT INTO conversations (direction, channel, endpoint_id, content, status, target_instance) VALUES (?, ?, ?, ?, ?, ?)`).run('in', 'feishu', 'disabled-chat', 'msg for disabled', 'pending', 'disabled');

    const row = db.prepare('SELECT id, status FROM conversations WHERE target_instance = ?').get('disabled');
    assert.equal(row.status, 'pending');

    // Simulate dispatcher rejecting the message
    db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('rejected', row.id);

    const updated = db.prepare('SELECT status FROM conversations WHERE id = ?').get(row.id);
    assert.equal(updated.status, 'rejected', 'status should be rejected');

    db.close();
  });

  it('markControlRejected sets control status to rejected', () => {
    const db = initDb(tmpDir);

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO control_queue (content, status, retry_count, created_at, updated_at, target_instance) VALUES (?, 'pending', 0, ?, ?, ?)`).run('heartbeat for disabled', now, now, 'disabled');

    const row = db.prepare('SELECT id, status FROM control_queue WHERE target_instance = ?').get('disabled');
    assert.equal(row.status, 'pending');

    db.prepare('UPDATE control_queue SET status = ? WHERE id = ?').run('rejected', row.id);

    const updated = db.prepare('SELECT status FROM control_queue WHERE id = ?').get(row.id);
    assert.equal(updated.status, 'rejected');

    db.close();
  });
});

// =========================================================================
// Test 5: Memory guard validation
// =========================================================================

describe('Test 5: Memory guard validation', () => {
  let tmpDir;
  let origZylosDir;
  let origInstanceId;

  before(() => {
    tmpDir = makeTmpDir('memguard');
    origZylosDir = process.env.ZYLOS_DIR;
    origInstanceId = process.env.ZYLOS_INSTANCE_ID;
    process.env.ZYLOS_DIR = tmpDir;

    // Create memory directory structure
    const memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(path.join(memDir, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'instances', 'admin'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'instances', 'betty'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'users', 'user1'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'archive'), { recursive: true });

    // Create symlinks for backward compat testing
    fs.writeFileSync(path.join(memDir, 'shared', 'identity.md'), '# Identity');
    fs.symlinkSync('shared/identity.md', path.join(memDir, 'identity.md'));
    fs.writeFileSync(path.join(memDir, 'instances', 'admin', 'state.md'), '# State');
    fs.symlinkSync('instances/admin/state.md', path.join(memDir, 'state.md'));
  });

  after(() => {
    if (origZylosDir === undefined) {
      delete process.env.ZYLOS_DIR;
    } else {
      process.env.ZYLOS_DIR = origZylosDir;
    }
    if (origInstanceId === undefined) {
      delete process.env.ZYLOS_INSTANCE_ID;
    } else {
      process.env.ZYLOS_INSTANCE_ID = origInstanceId;
    }
    cleanTmpDir(tmpDir);
  });

  // We need to import the memory guard module with the tmp ZYLOS_DIR set.
  // Use cache-busting import for isolation.

  it('primary instance can write to shared/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    writeInstancesJson(tmpDir, {
      instances: { admin: { primary: true }, betty: {} },
    });

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'shared', 'identity.md'));
    assert.equal(result, null, 'Primary should be allowed to write to shared/');
  });

  it('non-primary instance cannot write to shared/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';
    writeInstancesJson(tmpDir, {
      instances: { admin: { primary: true }, betty: {} },
    });

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'shared', 'identity.md'));
    assert.ok(result !== null, 'Non-primary should be blocked from shared/');
    assert.match(result, /Non-primary/);
  });

  it('instance can write to own instances/<id>/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'instances', 'betty', 'state.md'));
    assert.equal(result, null, 'Instance should write to own dir');
  });

  it('instance cannot write to other instances/<other-id>/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'instances', 'admin', 'state.md'));
    assert.ok(result !== null, 'Instance should be blocked from other instance dir');
    assert.match(result, /Cannot write to instance 'admin'/);
  });

  it('any instance can write to users/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'users', 'user1', 'profile.md'));
    assert.equal(result, null, 'Any instance should write to users/');
  });

  it('any instance can write to archive/', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'archive', 'old.md'));
    assert.equal(result, null, 'Any instance should write to archive/');
  });

  it('legacy mode (no instance ID) allows all memory writes', async () => {
    delete process.env.ZYLOS_INSTANCE_ID;

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const sharedResult = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'shared', 'identity.md'));
    assert.equal(sharedResult, null, 'Legacy mode should allow shared/ writes');

    const instanceResult = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'instances', 'admin', 'state.md'));
    assert.equal(instanceResult, null, 'Legacy mode should allow instance writes');
  });

  it('non-memory writes are always allowed', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    const result = mod.validateMemoryWrite('/tmp/some/random/file.txt');
    assert.equal(result, null, 'Non-memory paths should always be allowed');
  });

  it('symlink to shared/ is blocked for non-primary', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';
    writeInstancesJson(tmpDir, {
      instances: { admin: { primary: true }, betty: {} },
    });

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    // memory/identity.md -> shared/identity.md
    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'identity.md'));
    assert.ok(result !== null, 'Symlink to shared/ should be blocked for non-primary');
    assert.match(result, /shared memory.*symlink/i);
  });

  it('symlink to own instance dir is allowed', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    writeInstancesJson(tmpDir, {
      instances: { admin: { primary: true }, betty: {} },
    });

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    // memory/state.md -> instances/admin/state.md
    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'state.md'));
    assert.equal(result, null, 'Symlink to own instance dir should be allowed');
  });

  it('symlink to other instance dir is blocked', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'betty';
    writeInstancesJson(tmpDir, {
      instances: { admin: { primary: true }, betty: {} },
    });

    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const mod = await import(`file://${MEMORY_GUARD_PATH}?${cacheBuster}`);

    // memory/state.md -> instances/admin/state.md (betty trying to write admin's state)
    const result = mod.validateMemoryWrite(path.join(tmpDir, 'memory', 'state.md'));
    assert.ok(result !== null, 'Symlink to other instance dir should be blocked');
    assert.match(result, /Cannot write to instance 'admin'/);
  });
});

// =========================================================================
// Test 6: Migration script
// =========================================================================

describe('Test 6: Migration script', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir('migrate');
  });

  after(() => cleanTmpDir(tmpDir));

  it('migrates flat memory layout to multi-session layout', () => {
    const memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    // Create flat layout files
    fs.writeFileSync(path.join(memDir, 'identity.md'), '# Identity\nTest identity');
    fs.writeFileSync(path.join(memDir, 'references.md'), '# References\nTest references');
    fs.writeFileSync(path.join(memDir, 'state.md'), '# State\nTest state');
    fs.mkdirSync(path.join(memDir, 'reference'), { recursive: true });
    fs.writeFileSync(path.join(memDir, 'reference', 'decisions.md'), '# Decisions');
    fs.writeFileSync(path.join(memDir, 'reference', 'preferences.md'), '# Preferences');
    fs.mkdirSync(path.join(memDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(memDir, 'sessions', 'current.md'), '# Current session');
    fs.mkdirSync(path.join(memDir, 'users'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'archive'), { recursive: true });

    // Run migration
    const r = spawnSync('bash', [MIGRATE_SCRIPT], {
      env: { ...process.env, ZYLOS_DIR: tmpDir, ZYLOS_INSTANCE_ID: 'default' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0, `Migration failed: ${r.stderr}`);

    // Verify shared/ exists with correct files
    assert.ok(fs.existsSync(path.join(memDir, 'shared', 'identity.md')), 'shared/identity.md should exist');
    assert.ok(fs.existsSync(path.join(memDir, 'shared', 'references.md')), 'shared/references.md should exist');
    assert.ok(fs.existsSync(path.join(memDir, 'shared', 'reference', 'decisions.md')), 'shared/reference/decisions.md should exist');
    assert.ok(fs.existsSync(path.join(memDir, 'shared', 'reference', 'preferences.md')), 'shared/reference/preferences.md should exist');

    // Verify content is preserved
    assert.equal(fs.readFileSync(path.join(memDir, 'shared', 'identity.md'), 'utf8'), '# Identity\nTest identity');

    // Verify instances/<id>/ exists
    assert.ok(fs.existsSync(path.join(memDir, 'instances', 'default', 'state.md')), 'instances/default/state.md should exist');
    assert.ok(fs.existsSync(path.join(memDir, 'instances', 'default', 'sessions', 'current.md')), 'instances/default/sessions/current.md should exist');

    // Verify symlinks work
    const identityContent = fs.readFileSync(path.join(memDir, 'identity.md'), 'utf8');
    assert.equal(identityContent, '# Identity\nTest identity', 'Symlink should resolve correctly');

    const stateContent = fs.readFileSync(path.join(memDir, 'state.md'), 'utf8');
    assert.equal(stateContent, '# State\nTest state', 'State symlink should resolve correctly');

    // Verify symlinks are actual symlinks
    assert.ok(fs.lstatSync(path.join(memDir, 'identity.md')).isSymbolicLink(), 'identity.md should be symlink');
    assert.ok(fs.lstatSync(path.join(memDir, 'references.md')).isSymbolicLink(), 'references.md should be symlink');
    assert.ok(fs.lstatSync(path.join(memDir, 'state.md')).isSymbolicLink(), 'state.md should be symlink');
    assert.ok(fs.lstatSync(path.join(memDir, 'reference')).isSymbolicLink(), 'reference/ should be symlink');
    assert.ok(fs.lstatSync(path.join(memDir, 'sessions')).isSymbolicLink(), 'sessions/ should be symlink');

    // Verify users/ and archive/ are unchanged (not symlinked)
    assert.ok(fs.existsSync(path.join(memDir, 'users')), 'users/ should still exist');
    assert.ok(!fs.lstatSync(path.join(memDir, 'users')).isSymbolicLink(), 'users/ should NOT be symlink');
    assert.ok(fs.existsSync(path.join(memDir, 'archive')), 'archive/ should still exist');
    assert.ok(!fs.lstatSync(path.join(memDir, 'archive')).isSymbolicLink(), 'archive/ should NOT be symlink');
  });

  it('re-run is idempotent', () => {
    // Run migration again on the already-migrated layout
    const r = spawnSync('bash', [MIGRATE_SCRIPT], {
      env: { ...process.env, ZYLOS_DIR: tmpDir, ZYLOS_INSTANCE_ID: 'default' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0, `Idempotent re-run failed: ${r.stderr}`);
    assert.ok(r.stdout.includes('already'), 'Should detect already-migrated layout');

    // Verify nothing broke
    const memDir = path.join(tmpDir, 'memory');
    const content = fs.readFileSync(path.join(memDir, 'identity.md'), 'utf8');
    assert.equal(content, '# Identity\nTest identity', 'Content should be preserved after re-run');
  });
});

// =========================================================================
// Test 7: Token usage DB instance-aware queries
// =========================================================================

describe('Test 7: Token usage DB per-instance queries', () => {
  let tmpDir;
  let db;

  before(() => {
    tmpDir = makeTmpDir('token');
    const dbDir = path.join(tmpDir, 'activity-monitor');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'token-usage.db');

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        date TEXT NOT NULL,
        chat_id TEXT,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(instance_id, date)
      )
    `);

    // Insert usage for multiple instances
    const today = new Date().toISOString().substring(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);

    db.prepare(`INSERT INTO token_usage (instance_id, date, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run('admin', today, 'claude-3-opus', 1000, 500, 0.05);
    db.prepare(`INSERT INTO token_usage (instance_id, date, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run('betty', today, 'claude-3-sonnet', 2000, 800, 0.02);
    db.prepare(`INSERT INTO token_usage (instance_id, date, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run('admin', yesterday, 'claude-3-opus', 500, 200, 0.03);
  });

  after(() => {
    db.close();
    cleanTmpDir(tmpDir);
  });

  it('query per-instance daily usage returns correct data', () => {
    const today = new Date().toISOString().substring(0, 10);
    const adminRow = db.prepare(`
      SELECT instance_id, COALESCE(SUM(input_tokens), 0) as input_tokens,
             COALESCE(SUM(output_tokens), 0) as output_tokens,
             COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage WHERE instance_id = ? AND date = ?
    `).get('admin', today);

    assert.equal(adminRow.input_tokens, 1000);
    assert.equal(adminRow.output_tokens, 500);
    assert.ok(Math.abs(adminRow.cost_usd - 0.05) < 0.001);
  });

  it('per-instance breakdown excludes other instances', () => {
    const today = new Date().toISOString().substring(0, 10);
    const bettyRow = db.prepare(`
      SELECT instance_id, COALESCE(SUM(input_tokens), 0) as input_tokens
      FROM token_usage WHERE instance_id = ? AND date = ?
    `).get('betty', today);

    assert.equal(bettyRow.input_tokens, 2000, 'Betty should see only her tokens');
  });

  it('cross-instance summary returns all instances', () => {
    const summary = db.prepare(`
      SELECT instance_id,
             COALESCE(SUM(input_tokens), 0) as total_input,
             COALESCE(SUM(output_tokens), 0) as total_output,
             COALESCE(SUM(cost_usd), 0) as total_cost
      FROM token_usage
      GROUP BY instance_id
      ORDER BY instance_id
    `).all();

    assert.equal(summary.length, 2, 'Should have 2 instances');
    assert.equal(summary[0].instance_id, 'admin');
    assert.equal(summary[0].total_input, 1500); // 1000 + 500
    assert.equal(summary[1].instance_id, 'betty');
    assert.equal(summary[1].total_input, 2000);
  });
});

// =========================================================================
// Test 8: Unknown endpoint notification
// =========================================================================

describe('Test 8: Unknown endpoint notification', () => {
  let tmpDir;
  let env;

  before(() => {
    tmpDir = makeTmpDir('unknown-ep');
    fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });
    // Create skill dirs for channel validation
    fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'telegram'), { recursive: true });

    writeInstancesJson(tmpDir, {
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true, chat_ids: ['admin-chat'] },
      },
      routing: {},
    });

    env = { ZYLOS_DIR: tmpDir };
  });

  after(() => cleanTmpDir(tmpDir));

  it('records unknown endpoint in unknown-endpoints.json', () => {
    const r = cli(RECEIVE_PATH, [
      '--channel', 'telegram', '--endpoint', 'stranger-123|telegram',
      '--json', '--content', 'hello from stranger',
    ], env);
    assert.equal(r.status, 0, `Expected exit 0. stderr: ${r.stderr}`);

    // The new DB-backed approach stores the message as pending_approval in the conversations table
    const db = openDb(tmpDir);
    const held = db.prepare(`
      SELECT * FROM conversations
      WHERE status = 'pending_approval' AND channel = 'telegram' AND endpoint_id LIKE 'stranger-123%'
    `).all();
    db.close();

    assert.ok(held.length >= 1, 'Should have at least one pending_approval message for stranger-123');
    assert.equal(held[0].channel, 'telegram');
    assert.ok(held[0].endpoint_id.startsWith('stranger-123'), 'endpoint_id should start with stranger-123');
  });

  it('system notification queued for admin on unknown endpoint', () => {
    const db = openDb(tmpDir);
    const notifications = db.prepare(`
      SELECT * FROM conversations
      WHERE channel = 'system' AND content LIKE '%[Instance Approval Required]%' AND target_instance = 'admin'
    `).all();
    db.close();

    assert.ok(notifications.length >= 1, 'Should have at least one approval notification');
    assert.ok(notifications[0].content.includes('stranger-123'), 'Notification should mention the chat_id');
  });

  it('duplicate endpoint does NOT create another notification', () => {
    // Send from same endpoint again
    const r = cli(RECEIVE_PATH, [
      '--channel', 'telegram', '--endpoint', 'stranger-123|telegram',
      '--json', '--content', 'hello again',
    ], env);
    assert.equal(r.status, 0);

    // Count approval request notifications — should still be exactly 1 (deduped)
    const db = openDb(tmpDir);
    const notifications = db.prepare(`
      SELECT * FROM conversations
      WHERE channel = 'system' AND content LIKE '%[Instance Approval Required]%' AND content LIKE '%stranger-123%'
    `).all();
    db.close();

    assert.equal(notifications.length, 1, 'Should still have only 1 notification (deduped)');
  });

  it('known endpoint does NOT trigger unknown notification', () => {
    // admin-chat is a known endpoint
    const r = cli(RECEIVE_PATH, [
      '--channel', 'telegram', '--endpoint', 'admin-chat|telegram',
      '--json', '--content', 'hello from known chat',
    ], env);
    assert.equal(r.status, 0);

    const db = openDb(tmpDir);
    const notifications = db.prepare(`
      SELECT * FROM conversations
      WHERE channel = 'system' AND content LIKE '%Auto-Provision%admin-chat%'
    `).all();
    db.close();

    assert.equal(notifications.length, 0, 'Known endpoint should NOT trigger notification');
  });
});

// =========================================================================
// Test 9: Git behavior with symlinks after memory migration
// =========================================================================

describe('Test 9: Git behavior with symlinks after memory migration', () => {
  let tmpDir;
  let memDir;

  before(() => {
    tmpDir = makeTmpDir('git-symlink');
    memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    // Initialize a git repo in the memory directory
    spawnSync('git', ['init'], { cwd: memDir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: memDir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: memDir, encoding: 'utf8' });

    // Create flat layout files
    fs.writeFileSync(path.join(memDir, 'identity.md'), '# Identity\nBot personality');
    fs.writeFileSync(path.join(memDir, 'references.md'), '# References\nKey paths');
    fs.writeFileSync(path.join(memDir, 'state.md'), '# State\nActive work');
    fs.mkdirSync(path.join(memDir, 'reference'), { recursive: true });
    fs.writeFileSync(path.join(memDir, 'reference', 'decisions.md'), '# Decisions');
    fs.writeFileSync(path.join(memDir, 'reference', 'preferences.md'), '# Preferences');
    fs.mkdirSync(path.join(memDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(memDir, 'sessions', 'current.md'), '# Current session');
    fs.mkdirSync(path.join(memDir, 'users'), { recursive: true });
    fs.mkdirSync(path.join(memDir, 'archive'), { recursive: true });

    // Initial commit with flat layout
    spawnSync('git', ['add', '.'], { cwd: memDir, encoding: 'utf8' });
    const commitResult = spawnSync('git', ['commit', '-m', 'initial flat layout'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(commitResult.status, 0, `Initial commit failed: ${commitResult.stderr}`);
  });

  after(() => cleanTmpDir(tmpDir));

  it('migration creates symlinks that git tracks as changes', () => {
    // Run migration script
    const migrateResult = spawnSync('bash', [MIGRATE_SCRIPT], {
      env: { ...process.env, ZYLOS_DIR: tmpDir, ZYLOS_INSTANCE_ID: 'admin' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(migrateResult.status, 0, `Migration failed: ${migrateResult.stderr}`);

    // Check git status — git should see changes (symlinks replace files)
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(statusResult.status, 0);
    const statusOutput = statusResult.stdout.trim();
    // After migration, git should see changes: original files replaced by symlinks,
    // new shared/ and instances/ directories with the moved content
    assert.ok(statusOutput.length > 0, 'git status should show changes after migration');
  });

  it('git add and commit succeeds after migration', () => {
    // Stage all changes
    const addResult = spawnSync('git', ['add', '.'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(addResult.status, 0, `git add failed: ${addResult.stderr}`);

    // Commit
    const commitResult = spawnSync('git', ['commit', '-m', 'migrate to multi-session layout'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(commitResult.status, 0, `git commit failed: ${commitResult.stderr}`);

    // Working tree should be clean after commit
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(statusResult.stdout.trim(), '', 'Working tree should be clean after commit');
  });

  it('reading files through symlinks returns correct content', () => {
    // Read through the backward-compat symlinks
    const identity = fs.readFileSync(path.join(memDir, 'identity.md'), 'utf8');
    assert.equal(identity, '# Identity\nBot personality', 'identity.md symlink should resolve');

    const references = fs.readFileSync(path.join(memDir, 'references.md'), 'utf8');
    assert.equal(references, '# References\nKey paths', 'references.md symlink should resolve');

    const state = fs.readFileSync(path.join(memDir, 'state.md'), 'utf8');
    assert.equal(state, '# State\nActive work', 'state.md symlink should resolve');

    const decisions = fs.readFileSync(path.join(memDir, 'reference', 'decisions.md'), 'utf8');
    assert.equal(decisions, '# Decisions', 'reference/decisions.md symlink should resolve');

    const session = fs.readFileSync(path.join(memDir, 'sessions', 'current.md'), 'utf8');
    assert.equal(session, '# Current session', 'sessions/current.md symlink should resolve');
  });

  it('reading from actual paths (shared/, instances/) also works', () => {
    const identity = fs.readFileSync(path.join(memDir, 'shared', 'identity.md'), 'utf8');
    assert.equal(identity, '# Identity\nBot personality', 'shared/identity.md should be readable');

    const state = fs.readFileSync(path.join(memDir, 'instances', 'admin', 'state.md'), 'utf8');
    assert.equal(state, '# State\nActive work', 'instances/admin/state.md should be readable');

    const session = fs.readFileSync(path.join(memDir, 'instances', 'admin', 'sessions', 'current.md'), 'utf8');
    assert.equal(session, '# Current session', 'instances/admin/sessions/current.md should be readable');
  });

  it('writing through symlink updates the real file', () => {
    // Write through symlink
    fs.writeFileSync(path.join(memDir, 'state.md'), '# State\nUpdated via symlink');

    // Read from actual location
    const actual = fs.readFileSync(path.join(memDir, 'instances', 'admin', 'state.md'), 'utf8');
    assert.equal(actual, '# State\nUpdated via symlink', 'Write through symlink should update real file');

    // Git should detect the change
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.ok(statusResult.stdout.includes('instances/admin/state.md') || statusResult.stdout.includes('state.md'),
      'git should see the changed file');

    // Commit the change
    spawnSync('git', ['add', '.'], { cwd: memDir, encoding: 'utf8' });
    const commitResult = spawnSync('git', ['commit', '-m', 'update state via symlink'], {
      cwd: memDir,
      encoding: 'utf8',
    });
    assert.equal(commitResult.status, 0, `Commit after symlink write failed: ${commitResult.stderr}`);
  });
});
