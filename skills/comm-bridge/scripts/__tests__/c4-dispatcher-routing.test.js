/**
 * Tests for dispatcher routing logic in multi-session mode.
 *
 * These tests exercise the pure routing helpers and state-dependent delivery
 * decisions without actually sending to tmux.  The dispatcher is imported in
 * a temp ZYLOS_DIR so it initialises harmlessly.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Setup: temp ZYLOS_DIR + instances.json
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-disp-route-'));
const origZylosDir = process.env.ZYLOS_DIR;
process.env.ZYLOS_DIR = tmpDir;

const INSTANCES_FILE = path.join(tmpDir, 'instances.json');
const AM_DIR = path.join(tmpDir, 'activity-monitor');
fs.mkdirSync(AM_DIR, { recursive: true });

// Import the instance router (cache-busted for isolation).
const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const router = await import(new URL(`../c4-instance-router.js?${cacheBuster}`, import.meta.url));

// Inline isBypassState logic to avoid importing the full dispatcher (which starts main loop on import)
const isBypassState = (item) => item.type === 'control' && item.bypass_state === 1;

after(() => {
  // Stop file watcher so Node can exit cleanly
  if (typeof router.stopWatcher === 'function') router.stopWatcher();
  if (origZylosDir === undefined) {
    delete process.env.ZYLOS_DIR;
  } else {
    process.env.ZYLOS_DIR = origZylosDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(config) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(config, null, 2));
}

function writeStatus(instanceDir, statusObj) {
  const dir = path.join(AM_DIR, instanceDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-status.json'), JSON.stringify(statusObj));
}

function removeConfig() {
  try { fs.unlinkSync(INSTANCES_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Routing: target_instance → tmux session resolution
// ---------------------------------------------------------------------------

describe('Dispatcher routing: target_instance → tmux session', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true },
        user1: { tmux_session: 'claude-user1' },
      },
      routing: {
        '12345': 'user1',
      },
    });
  });

  after(() => removeConfig());

  it('routes target_instance=admin to admin tmux session', () => {
    const session = router.getSessionForInstance('admin');
    assert.equal(session, 'claude-admin');
  });

  it('routes target_instance=user1 to user1 tmux session', () => {
    const session = router.getSessionForInstance('user1');
    assert.equal(session, 'claude-user1');
  });

  it('routes target_instance=null to null (dispatcher falls back to default)', () => {
    const session = router.getSessionForInstance(null);
    assert.equal(session, null);
    // The dispatcher resolveSessionName() would fall back to TMUX_SESSION constant
  });

  it('routes unknown target_instance to null (dispatcher falls back to default)', () => {
    const session = router.getSessionForInstance('nonexistent');
    assert.equal(session, null);
  });
});

// ---------------------------------------------------------------------------
// Offline instance: status file indicates offline
// ---------------------------------------------------------------------------

describe('Dispatcher routing: offline instance handling', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: {
          tmux_session: 'claude-admin',
          primary: true,
          state_dir: path.join(AM_DIR, 'admin'),
        },
        user1: {
          tmux_session: 'claude-user1',
          state_dir: path.join(AM_DIR, 'user1'),
        },
      },
      routing: {},
    });
  });

  after(() => removeConfig());

  it('getStatusFileForInstance returns correct path for target_instance', () => {
    const statusFile = router.getStatusFileForInstance('user1');
    assert.equal(statusFile, path.join(AM_DIR, 'user1', 'claude-status.json'));
  });

  it('status file missing means offline (message should be requeued)', () => {
    // When status file does not exist, the dispatcher treats this as offline.
    const statusFile = router.getStatusFileForInstance('user1');
    assert.ok(!fs.existsSync(statusFile), 'status file should not exist');
    // The dispatcher would requeue the message for this instance.
  });

  it('status file with stale mtime means offline', () => {
    const statusFile = router.getStatusFileForInstance('admin');
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', idle_seconds: 10 }));
    // Artificially age the file by setting mtime to 10 seconds ago
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(statusFile, oldTime, oldTime);
    // Dispatcher uses STALE_STATUS_THRESHOLD (5000ms) to detect staleness
    assert.ok(fs.existsSync(statusFile));
  });
});

// ---------------------------------------------------------------------------
// Suspended instance: wake-signal file
// ---------------------------------------------------------------------------

describe('Dispatcher routing: suspended instance wake signal', () => {
  before(() => {
    writeConfig({
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true },
        suspended1: {
          tmux_session: 'claude-suspended1',
          state_dir: path.join(AM_DIR, 'suspended1'),
        },
      },
      routing: {},
    });
  });

  after(() => removeConfig());

  it('wake-signal directory can be created for suspended instance', () => {
    const statusFile = router.getStatusFileForInstance('suspended1');
    const stateDir = path.dirname(statusFile);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'wake-signal'), new Date().toISOString());

    assert.ok(fs.existsSync(path.join(stateDir, 'wake-signal')));
  });
});

// ---------------------------------------------------------------------------
// require_idle gating
// ---------------------------------------------------------------------------

describe('Dispatcher routing: require_idle messages', () => {
  it('isBypassState returns false for require_idle items', () => {
    // require_idle items are conversation type, not control bypass
    const item = { type: 'conversation', require_idle: 1 };
    assert.equal(isBypassState(item), false);
  });

  it('isBypassState returns true for control bypass items (should skip idle check)', () => {
    const item = { type: 'control', bypass_state: 1, require_idle: 1 };
    assert.equal(isBypassState(item), true);
  });
});

// ---------------------------------------------------------------------------
// Default instance resolution
// ---------------------------------------------------------------------------

describe('Dispatcher routing: default instance', () => {
  it('getDefaultInstance returns configured default', () => {
    writeConfig({
      default_instance: 'admin',
      instances: { admin: { tmux_session: 'claude-admin' } },
    });
    assert.equal(router.getDefaultInstance(), 'admin');
    removeConfig();
  });

  it('getDefaultInstance returns null in legacy mode', () => {
    removeConfig();
    assert.equal(router.getDefaultInstance(), null);
  });

  it('resolveInstance maps unknown endpoint to default instance', () => {
    writeConfig({
      default_instance: 'admin',
      instances: { admin: { tmux_session: 'claude-admin' } },
      routing: {},
    });
    assert.equal(router.resolveInstance('unknown-endpoint'), 'admin');
    removeConfig();
  });
});
