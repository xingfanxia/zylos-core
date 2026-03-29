import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate each import with a unique ZYLOS_DIR so the module reads our temp
// instances.json instead of the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-router-test-'));
const origZylosDir = process.env.ZYLOS_DIR;
process.env.ZYLOS_DIR = tmpDir;

const INSTANCES_FILE = path.join(tmpDir, 'instances.json');

// Cache-bust the import so each test run gets a fresh module instance.
const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const mod = await import(new URL(`../c4-instance-router.js?${cacheBuster}`, import.meta.url));

const {
  resolveInstance,
  getSessionForInstance,
  getStatusFileForInstance,
  getDefaultInstance,
  isMultiSession,
  getConfigDirForInstance,
} = mod;

after(() => {
  // Stop the file watcher so Node can exit cleanly
  if (typeof mod.stopWatcher === 'function') mod.stopWatcher();
  if (origZylosDir === undefined) {
    delete process.env.ZYLOS_DIR;
  } else {
    process.env.ZYLOS_DIR = origZylosDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: write a config to the temp instances.json
function writeConfig(config) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(config, null, 2));
}

function removeConfig() {
  try { fs.unlinkSync(INSTANCES_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// resolveInstance — legacy mode (no instances.json)
// ---------------------------------------------------------------------------

describe('resolveInstance — legacy mode', () => {
  beforeEach(() => removeConfig());

  it('returns null when no instances.json exists', () => {
    assert.equal(resolveInstance('12345|telegram'), null);
  });

  it('returns null with empty endpoint', () => {
    assert.equal(resolveInstance(''), null);
  });

  it('returns null with undefined endpoint', () => {
    assert.equal(resolveInstance(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// resolveInstance — routing map
// ---------------------------------------------------------------------------

describe('resolveInstance — routing map', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true },
        user1: { tmux_session: 'claude-user1' },
      },
      routing: {
        '12345': 'user1',
        '99999|telegram': 'admin',
      },
    });
  });

  after(() => removeConfig());

  it('resolves chat_id from routing map', () => {
    assert.equal(resolveInstance('12345|telegram'), 'user1');
  });

  it('resolves full endpoint_id from routing map', () => {
    assert.equal(resolveInstance('99999|telegram'), 'admin');
  });

  it('falls back to default_instance for unknown chat_id', () => {
    assert.equal(resolveInstance('unknown_id|telegram'), 'admin');
  });
});

// ---------------------------------------------------------------------------
// resolveInstance — chat_ids scan
// ---------------------------------------------------------------------------

describe('resolveInstance — chat_ids scan', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true, chat_ids: ['111'] },
        user1: { tmux_session: 'claude-user1', chat_ids: ['222', '333'] },
      },
      routing: {},
    });
  });

  after(() => removeConfig());

  it('resolves via chat_ids array when routing map has no match', () => {
    assert.equal(resolveInstance('222|feishu'), 'user1');
  });

  it('resolves admin via chat_ids', () => {
    assert.equal(resolveInstance('111|telegram'), 'admin');
  });

  it('resolves with full endpoint_id match in chat_ids', () => {
    assert.equal(resolveInstance('333'), 'user1');
  });
});

// ---------------------------------------------------------------------------
// resolveInstance — default fallback
// ---------------------------------------------------------------------------

describe('resolveInstance — default fallback', () => {
  before(() => {
    writeConfig({
      default_instance: 'fallback-inst',
      instances: {
        'fallback-inst': { tmux_session: 'claude-fallback' },
      },
      routing: {},
    });
  });

  after(() => removeConfig());

  it('returns default_instance when no routing or chat_ids match', () => {
    assert.equal(resolveInstance('no-match|telegram'), 'fallback-inst');
  });
});

// ---------------------------------------------------------------------------
// resolveInstance — edge cases
// ---------------------------------------------------------------------------

describe('resolveInstance — edge cases', () => {
  it('returns default_instance with empty routing map', () => {
    writeConfig({
      default_instance: 'admin',
      instances: { admin: { tmux_session: 'claude-admin' } },
      routing: {},
    });
    assert.equal(resolveInstance('anything'), 'admin');
  });

  it('returns null when config has no default_instance and no match', () => {
    writeConfig({
      instances: { admin: { tmux_session: 'claude-admin' } },
      routing: {},
    });
    assert.equal(resolveInstance('anything'), null);
  });

  it('returns null for disabled instance scenario (missing from routing)', () => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin' },
        disabled: { tmux_session: 'claude-disabled', enabled: false },
      },
      routing: {},
    });
    // disabled instance not in routing → falls through to default
    assert.equal(resolveInstance('some-id'), 'admin');
    removeConfig();
  });
});

// ---------------------------------------------------------------------------
// getSessionForInstance
// ---------------------------------------------------------------------------

describe('getSessionForInstance', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin' },
        user1: { tmux_session: 'claude-user1' },
      },
    });
  });

  after(() => removeConfig());

  it('returns tmux session name for known instance', () => {
    assert.equal(getSessionForInstance('admin'), 'claude-admin');
  });

  it('returns tmux session name for another instance', () => {
    assert.equal(getSessionForInstance('user1'), 'claude-user1');
  });

  it('returns null for unknown instance', () => {
    assert.equal(getSessionForInstance('nonexistent'), null);
  });

  it('returns null in legacy mode (no config)', () => {
    removeConfig();
    assert.equal(getSessionForInstance('admin'), null);
  });
});

// ---------------------------------------------------------------------------
// getStatusFileForInstance
// ---------------------------------------------------------------------------

describe('getStatusFileForInstance', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', state_dir: path.join(tmpDir, 'am-admin') },
        user1: { tmux_session: 'claude-user1' },
      },
    });
  });

  after(() => removeConfig());

  it('returns status file path using state_dir when configured', () => {
    const result = getStatusFileForInstance('admin');
    assert.equal(result, path.join(tmpDir, 'am-admin', 'claude-status.json'));
  });

  it('returns default status file path when state_dir is not configured', () => {
    const result = getStatusFileForInstance('user1');
    assert.equal(result, path.join(tmpDir, 'activity-monitor', 'user1', 'claude-status.json'));
  });

  it('returns null for unknown instance', () => {
    assert.equal(getStatusFileForInstance('nonexistent'), null);
  });

  it('returns null in legacy mode', () => {
    removeConfig();
    assert.equal(getStatusFileForInstance('admin'), null);
  });
});

// ---------------------------------------------------------------------------
// getDefaultInstance
// ---------------------------------------------------------------------------

describe('getDefaultInstance', () => {
  it('returns default_instance from config', () => {
    writeConfig({ default_instance: 'admin', instances: {} });
    assert.equal(getDefaultInstance(), 'admin');
  });

  it('returns null when default_instance is not set', () => {
    writeConfig({ instances: {} });
    assert.equal(getDefaultInstance(), null);
  });

  it('returns null in legacy mode (no instances.json)', () => {
    removeConfig();
    assert.equal(getDefaultInstance(), null);
  });
});

// ---------------------------------------------------------------------------
// isMultiSession
// ---------------------------------------------------------------------------

describe('isMultiSession', () => {
  it('returns true when more than one instance is defined', () => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin' },
        user1: { tmux_session: 'claude-user1' },
      },
    });
    assert.equal(isMultiSession(), true);
  });

  it('returns false with only one instance', () => {
    writeConfig({
      default_instance: 'admin',
      instances: { admin: { tmux_session: 'claude-admin' } },
    });
    assert.equal(isMultiSession(), false);
  });

  it('returns false in legacy mode', () => {
    removeConfig();
    assert.equal(isMultiSession(), false);
  });
});

// ---------------------------------------------------------------------------
// getConfigDirForInstance
// ---------------------------------------------------------------------------

describe('getConfigDirForInstance', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', config_dir: '~/.claude-admin' },
        user1: { tmux_session: 'claude-user1' },
      },
    });
  });

  after(() => removeConfig());

  it('returns expanded config_dir path', () => {
    const result = getConfigDirForInstance('admin');
    assert.equal(result, path.join(os.homedir(), '.claude-admin'));
  });

  it('returns null when config_dir is not set', () => {
    assert.equal(getConfigDirForInstance('user1'), null);
  });

  it('returns null for unknown instance', () => {
    assert.equal(getConfigDirForInstance('nonexistent'), null);
  });
});
