import { describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Test fixtures ──────────────────────────────────────────────────

const INSTANCES_FIXTURE = {
  default_instance: 'admin',
  scheduler_instance: 'admin',
  instances: {
    admin: {
      tmux_session: 'claude-admin',
      state_dir: '/tmp/zylos-test/state/admin',
      primary: true,
      enabled: true,
      default: true,
    },
    'user-betty': {
      tmux_session: 'claude-betty',
      state_dir: '/tmp/zylos-test/state/betty',
      os_user: 'zylos-betty',
      primary: false,
      enabled: true,
      default: false,
    },
    'disabled-one': {
      tmux_session: 'claude-disabled',
      state_dir: '/tmp/zylos-test/state/disabled',
      primary: false,
      enabled: false,
      default: false,
    },
  },
};

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir;
let cleanupFns = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-test-'));
  cleanupFns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeInstances(dir, data) {
  fs.writeFileSync(path.join(dir, 'instances.json'), JSON.stringify(data), 'utf8');
}

/**
 * Dynamically import instance-config.js with a fresh module (cache-bust).
 * Each call gets a unique query string so Node treats it as a new module,
 * which re-evaluates the top-level ZYLOS_DIR / INSTANCES_PATH constants.
 */
let importCounter = 0;
async function freshImport() {
  importCounter++;
  const mod = await import(
    `../skills/multi-session/instance-config.js?v=${importCounter}`
  );
  return mod;
}

// ── Test suites ────────────────────────────────────────────────────

describe('instance-config — with instances.json', () => {
  let mod;
  const savedEnv = {};

  beforeEach(async () => {
    // Save env
    savedEnv.ZYLOS_DIR = process.env.ZYLOS_DIR;
    savedEnv.ZYLOS_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID;

    tmpDir = makeTmpDir();
    writeInstances(tmpDir, INSTANCES_FIXTURE);

    process.env.ZYLOS_DIR = tmpDir;
    delete process.env.ZYLOS_INSTANCE_ID;

    mod = await freshImport();
  });

  afterEach(() => {
    // Restore env
    if (savedEnv.ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = savedEnv.ZYLOS_DIR;

    if (savedEnv.ZYLOS_INSTANCE_ID === undefined) delete process.env.ZYLOS_INSTANCE_ID;
    else process.env.ZYLOS_INSTANCE_ID = savedEnv.ZYLOS_INSTANCE_ID;
  });

  // ── getInstanceId ──────────────────────────────────────────────

  it('getInstanceId() returns null when ZYLOS_INSTANCE_ID is not set', () => {
    delete process.env.ZYLOS_INSTANCE_ID;
    expect(mod.getInstanceId()).toBeNull();
  });

  it('getInstanceId() returns value from ZYLOS_INSTANCE_ID', () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    expect(mod.getInstanceId()).toBe('admin');
  });

  // ── getAllInstances ────────────────────────────────────────────

  it('getAllInstances() returns parsed instances with injected id property', () => {
    const all = mod.getAllInstances();
    expect(all).toHaveLength(3);
    const ids = all.map(i => i.id);
    expect(ids).toContain('admin');
    expect(ids).toContain('user-betty');
    expect(ids).toContain('disabled-one');

    // Each entry has the id injected plus the original properties
    const admin = all.find(i => i.id === 'admin');
    expect(admin.tmux_session).toBe('claude-admin');
    expect(admin.primary).toBe(true);
  });

  // ── getInstanceDef ────────────────────────────────────────────

  it('getInstanceDef("admin") returns the correct definition', () => {
    const def = mod.getInstanceDef('admin');
    expect(def).not.toBeNull();
    expect(def.tmux_session).toBe('claude-admin');
    expect(def.primary).toBe(true);
    expect(def.state_dir).toBe('/tmp/zylos-test/state/admin');
  });

  it('getInstanceDef("nonexistent") returns null', () => {
    expect(mod.getInstanceDef('nonexistent')).toBeNull();
  });

  // ── getMonitorDir ─────────────────────────────────────────────

  it('getMonitorDir("admin") returns state_dir from definition', () => {
    expect(mod.getMonitorDir('admin')).toBe('/tmp/zylos-test/state/admin');
  });

  // ── getSessionName ────────────────────────────────────────────

  it('getSessionName("admin") returns tmux_session from definition', () => {
    expect(mod.getSessionName('admin')).toBe('claude-admin');
  });

  it('getSessionName() falls back to config-based session name', () => {
    // No ZYLOS_INSTANCE_ID set, no config.json → defaults to "claude-main"
    delete process.env.ZYLOS_INSTANCE_ID;
    expect(mod.getSessionName()).toBe('claude-main');
  });

  // ── resolveStatusFile ─────────────────────────────────────────

  it('resolveStatusFile("admin") returns correct path within monitor dir', () => {
    const expected = path.join('/tmp/zylos-test/state/admin', 'agent-status.json');
    expect(mod.resolveStatusFile('admin')).toBe(expected);
  });

  // ── isInstanceEnabled ─────────────────────────────────────────

  it('isInstanceEnabled("admin") returns true for enabled instance', () => {
    expect(mod.isInstanceEnabled('admin')).toBe(true);
  });

  it('isInstanceEnabled("disabled-one") returns false', () => {
    expect(mod.isInstanceEnabled('disabled-one')).toBe(false);
  });

  // ── isPrimary ─────────────────────────────────────────────────

  it('isPrimary("admin") returns true', () => {
    expect(mod.isPrimary('admin')).toBe(true);
  });

  it('isPrimary("user-betty") returns false', () => {
    expect(mod.isPrimary('user-betty')).toBe(false);
  });

  // ── getDefaultInstance ────────────────────────────────────────

  it('getDefaultInstance() returns instance with default:true', () => {
    const def = mod.getDefaultInstance();
    expect(def).not.toBeNull();
    expect(def.id).toBe('admin');
    expect(def.default).toBe(true);
  });

  // ── getSchedulerInstance ──────────────────────────────────────

  it('getSchedulerInstance() returns correct instance', () => {
    const sched = mod.getSchedulerInstance();
    expect(sched).not.toBeNull();
    expect(sched.id).toBe('admin');
    expect(sched.tmux_session).toBe('claude-admin');
  });

  it('ensureInstanceCwd exposes the same env, memory and Claude skill tree to both runtimes', () => {
    const cwd = mod.ensureInstanceCwd('admin');
    expect(cwd).toBe(path.join(tmpDir, 'instances', 'admin'));
    expect(fs.readlinkSync(path.join(cwd, '.env'))).toBe('../../.env');
    expect(fs.readlinkSync(path.join(cwd, 'memory'))).toBe('../../memory');
    expect(fs.readlinkSync(path.join(cwd, '.claude'))).toBe('../../.claude');
    expect(fs.readlinkSync(path.join(cwd, '.agents'))).toBe('../../.agents');
  });

  it('uses the persona-owned farm env for an OS-isolated workspace', () => {
    const cwd = mod.ensureInstanceCwd('user-betty');
    expect(fs.readlinkSync(path.join(cwd, '.env'))).toBe('/home/zylos-betty/zylos/.env');
  });

  it('preserves a persona-created workspace env across repeated setup', () => {
    const cwd = mod.ensureInstanceCwd('admin');
    fs.unlinkSync(path.join(cwd, '.env'));
    fs.writeFileSync(path.join(cwd, '.env'), 'PERSONA_SERVICE_TOKEN=owned\n');

    mod.ensureInstanceCwd('admin');

    expect(fs.lstatSync(path.join(cwd, '.env')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(cwd, '.env'), 'utf8')).toBe('PERSONA_SERVICE_TOKEN=owned\n');
  });

  // ── Cache TTL ─────────────────────────────────────────────────

  it('cache TTL — modifying instances.json is picked up after TTL', async () => {
    // Initial read
    const allBefore = mod.getAllInstances();
    expect(allBefore).toHaveLength(3);

    // Modify the file: add a 4th instance
    const updated = {
      ...INSTANCES_FIXTURE,
      instances: {
        ...INSTANCES_FIXTURE.instances,
        'new-instance': {
          tmux_session: 'claude-new',
          state_dir: '/tmp/zylos-test/state/new',
          primary: false,
          enabled: true,
          default: false,
        },
      },
    };

    // Bump mtime by writing with a small delay
    await new Promise(r => setTimeout(r, 50));
    writeInstances(tmpDir, updated);

    // Immediately after write — cache still holds old data (TTL not expired)
    const allCached = mod.getAllInstances();
    expect(allCached).toHaveLength(3);

    // Force TTL expiry by re-importing the module (fresh module = fresh cache).
    // This simulates the TTL expiring because the new module instance starts
    // with an empty cache and will re-read the file.
    const freshMod = await freshImport();
    const allAfterTTL = freshMod.getAllInstances();
    expect(allAfterTTL).toHaveLength(4);
    expect(allAfterTTL.map(i => i.id)).toContain('new-instance');
  });
});

describe('instance-config — without instances.json (single-session)', () => {
  let mod;
  const savedEnv = {};

  beforeEach(async () => {
    savedEnv.ZYLOS_DIR = process.env.ZYLOS_DIR;
    savedEnv.ZYLOS_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID;

    tmpDir = makeTmpDir();
    // No instances.json written — simulates single-session mode

    process.env.ZYLOS_DIR = tmpDir;
    delete process.env.ZYLOS_INSTANCE_ID;

    mod = await freshImport();
  });

  afterEach(() => {
    if (savedEnv.ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = savedEnv.ZYLOS_DIR;

    if (savedEnv.ZYLOS_INSTANCE_ID === undefined) delete process.env.ZYLOS_INSTANCE_ID;
    else process.env.ZYLOS_INSTANCE_ID = savedEnv.ZYLOS_INSTANCE_ID;
  });

  it('getAllInstances() returns empty array when no instances.json', () => {
    expect(mod.getAllInstances()).toEqual([]);
  });

  it('getMonitorDir() returns default ~/zylos/activity-monitor when no instance', () => {
    const expected = path.join(tmpDir, 'activity-monitor');
    expect(mod.getMonitorDir()).toBe(expected);
  });

  it('isPrimary() returns true in single-session mode', () => {
    expect(mod.isPrimary()).toBe(true);
  });
});

// ── c4-helpers ─────────────────────────────────────────────────────

describe('c4-helpers', () => {
  let appendInstanceArgs;
  let buildC4ControlArgs;

  beforeEach(async () => {
    const mod = await import('../skills/multi-session/c4-helpers.js');
    appendInstanceArgs = mod.appendInstanceArgs;
    buildC4ControlArgs = mod.buildC4ControlArgs;
  });

  // ── appendInstanceArgs ────────────────────────────────────────

  it('appendInstanceArgs appends when instanceId is truthy', () => {
    const args = ['--resume'];
    const result = appendInstanceArgs(args, 'admin');
    expect(result).toBe(args); // same reference — mutates in place
    expect(args).toEqual(['--resume', '--target-instance', 'admin']);
  });

  it('appendInstanceArgs is no-op when instanceId is null', () => {
    const args = ['--resume'];
    appendInstanceArgs(args, null);
    expect(args).toEqual(['--resume']);
  });

  it('appendInstanceArgs is no-op when instanceId is undefined', () => {
    const args = ['--resume'];
    appendInstanceArgs(args, undefined);
    expect(args).toEqual(['--resume']);
  });

  // ── buildC4ControlArgs ────────────────────────────────────────

  it('buildC4ControlArgs returns new array without mutation', () => {
    const base = ['--restart'];
    const result = buildC4ControlArgs(base, 'admin');

    // Original not mutated
    expect(base).toEqual(['--restart']);
    // New array has the appended args
    expect(result).toEqual(['--restart', '--target-instance', 'admin']);
    // Different reference
    expect(result).not.toBe(base);
  });

  it('buildC4ControlArgs returns same-value array when no instanceId', () => {
    const base = ['--restart'];
    const result = buildC4ControlArgs(base, null);

    expect(result).toEqual(['--restart']);
    // Still a new array (spread), not the same reference
    expect(result).not.toBe(base);
  });
});

afterAll(() => {
  cleanupFns.forEach(fn => fn());
});
