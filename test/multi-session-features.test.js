/**
 * Integration tests for multi-session features:
 *   1. Auto-start/stop (c4-dispatcher-multi.js)
 *   2. Group chat routing (c4-instance-router.js)
 *   3. c4-query-instance.js arg building
 *   4. --all-instances flag (c4-fetch.js)
 *   5. Memory guard scheduler exemption
 *   6. Delivery confirmation (c4-dispatcher.js)
 *
 * Uses inline replicas of the core logic (same pattern as
 * multi-session-comm-bridge.test.js) to avoid filesystem/exec dependencies
 * at module evaluation time.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Shared temp-dir infrastructure ────────────────────────────────────

const cleanupFns = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-msf-test-'));
  cleanupFns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterAll(() => {
  cleanupFns.forEach(fn => fn());
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Auto-start / auto-stop (c4-dispatcher-multi.js)
// ═══════════════════════════════════════════════════════════════════════

/**
 * We replicate the auto-start, auto-stop, and reapIdleInstances logic
 * inline because importing c4-dispatcher-multi.js pulls in
 * instance-config.js and c4-config.js which read the filesystem.
 */

describe('Auto-start / auto-stop (c4-dispatcher-multi logic)', () => {
  // ── autoStartInstance replica ──────────────────────────────────────

  function autoStartInstance(instDef, execMock) {
    const session = instDef.tmux_session;
    if (!session) return false;

    // Check if session already exists
    try {
      execMock('tmux', ['has-session', '-t', session], { stdio: 'pipe', timeout: 3000 });
      return true; // already running
    } catch {
      // Session doesn't exist — create it
    }

    try {
      const runtime = instDef.runtime || 'claude';
      const cmd = runtime === 'codex' ? 'codex' : 'claude';
      execMock('tmux', [
        'new-session', '-d', '-s', session, '-x', '220', '-y', '50',
        cmd,
      ], { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── autoStopInstance replica ───────────────────────────────────────

  function autoStopInstance(instanceId, session, execMock, lastDeliveryAt) {
    try {
      execMock('tmux', ['kill-session', '-t', session], { stdio: 'pipe', timeout: 5000 });
      lastDeliveryAt.delete(instanceId);
    } catch {
      // Session may already be dead
    }
  }

  // ── reapIdleInstances replica ─────────────────────────────────────

  const IDLE_REAP_TIMEOUT_MS = 30 * 60 * 1000;

  function reapIdleInstances(lastDeliveryAt, getInstanceDef, execMock) {
    const now = Date.now();
    const reaped = [];
    for (const [instanceId, lastTs] of lastDeliveryAt) {
      if (now - lastTs < IDLE_REAP_TIMEOUT_MS) continue;
      const def = getInstanceDef(instanceId);
      if (!def || def.primary) continue; // never reap primary
      const session = def.tmux_session;
      if (!session) continue;
      autoStopInstance(instanceId, session, execMock, lastDeliveryAt);
      reaped.push(instanceId);
    }
    return reaped;
  }

  // ── multiSessionDispatch replica (subset for auto-start tests) ────

  function multiSessionDispatch(item, helpers, instanceDefs = {}) {
    const { getClaudeState, isBypassState } = helpers;
    const targetInstance = item.target_instance || null;
    const bypass = isBypassState(item);

    if (targetInstance) {
      const def = instanceDefs[targetInstance] ?? null;
      if (def && def.enabled === false) {
        return { action: 'reject', reason: `instance '${targetInstance}' is disabled` };
      }
    }

    const claudeState = getClaudeState();

    // Offline/stopped + non-primary -> requeue (auto-start path)
    if ((claudeState.state === 'offline' || claudeState.state === 'stopped') && !bypass) {
      const def = targetInstance ? instanceDefs[targetInstance] : null;
      if (def && !def.primary) {
        return { action: 'requeue', reason: `auto-started instance '${targetInstance}', requeueing for delivery after boot` };
      }
      return { action: 'skip', reason: `instance target offline (state=${claudeState.state})` };
    }

    return { action: 'deliver', session: `claude-${targetInstance || 'main'}` };
  }

  // ── Tests ─────────────────────────────────────────────────────────

  it('autoStartInstance() calls execFileSync with tmux new-session', () => {
    const calls = [];
    const execMock = (cmd, args, opts) => {
      calls.push({ cmd, args });
      // has-session should throw (session doesn't exist)
      if (args.includes('has-session')) throw new Error('no session');
    };

    const instDef = { id: 'betty', tmux_session: 'claude-betty', runtime: 'claude' };
    const result = autoStartInstance(instDef, execMock);

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['has-session', '-t', 'claude-betty']);
    expect(calls[1].args).toContain('new-session');
    expect(calls[1].args).toContain('-s');
    expect(calls[1].args).toContain('claude-betty');
    expect(calls[1].args[calls[1].args.length - 1]).toBe('claude');
  });

  it('autoStartInstance() returns true without new-session if session already exists', () => {
    const calls = [];
    const execMock = (cmd, args) => {
      calls.push({ cmd, args });
      // has-session succeeds (session exists)
    };

    const instDef = { id: 'betty', tmux_session: 'claude-betty' };
    const result = autoStartInstance(instDef, execMock);

    expect(result).toBe(true);
    // Only has-session called, no new-session
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('has-session');
  });

  it('autoStartInstance() returns false when tmux_session is missing', () => {
    const execMock = () => {};
    const instDef = { id: 'betty', tmux_session: null };
    expect(autoStartInstance(instDef, execMock)).toBe(false);
  });

  it('autoStartInstance() uses codex runtime when configured', () => {
    const calls = [];
    const execMock = (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('has-session')) throw new Error('no session');
    };

    const instDef = { id: 'codex-inst', tmux_session: 'codex-main', runtime: 'codex' };
    autoStartInstance(instDef, execMock);

    expect(calls[1].args[calls[1].args.length - 1]).toBe('codex');
  });

  it('autoStopInstance() calls execFileSync with tmux kill-session', () => {
    const calls = [];
    const execMock = (cmd, args) => {
      calls.push({ cmd, args });
    };
    const lastDeliveryAt = new Map([['betty', Date.now()]]);

    autoStopInstance('betty', 'claude-betty', execMock, lastDeliveryAt);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['kill-session', '-t', 'claude-betty']);
    expect(lastDeliveryAt.has('betty')).toBe(false);
  });

  it('reapIdleInstances() stops instances idle past 30min threshold', () => {
    const thirtyOneMinAgo = Date.now() - (31 * 60 * 1000);
    const lastDeliveryAt = new Map([
      ['betty', thirtyOneMinAgo],
    ]);
    const calls = [];
    const execMock = (cmd, args) => calls.push({ cmd, args });
    const getInstanceDef = (id) => ({
      betty: { tmux_session: 'claude-betty', primary: false },
    }[id] || null);

    const reaped = reapIdleInstances(lastDeliveryAt, getInstanceDef, execMock);

    expect(reaped).toEqual(['betty']);
    expect(calls.length).toBe(1);
    expect(calls[0].args).toContain('kill-session');
  });

  it('reapIdleInstances() never stops primary instances', () => {
    const thirtyOneMinAgo = Date.now() - (31 * 60 * 1000);
    const lastDeliveryAt = new Map([
      ['admin', thirtyOneMinAgo],
    ]);
    const calls = [];
    const execMock = (cmd, args) => calls.push({ cmd, args });
    const getInstanceDef = (id) => ({
      admin: { tmux_session: 'claude-admin', primary: true },
    }[id] || null);

    const reaped = reapIdleInstances(lastDeliveryAt, getInstanceDef, execMock);

    expect(reaped).toEqual([]);
    expect(calls).toHaveLength(0);
    // The entry is NOT removed — primary instances are just skipped
    expect(lastDeliveryAt.has('admin')).toBe(true);
  });

  it('reapIdleInstances() does not stop instances within the threshold', () => {
    const fiveMinAgo = Date.now() - (5 * 60 * 1000);
    const lastDeliveryAt = new Map([
      ['betty', fiveMinAgo],
    ]);
    const calls = [];
    const execMock = (cmd, args) => calls.push({ cmd, args });
    const getInstanceDef = (id) => ({
      betty: { tmux_session: 'claude-betty', primary: false },
    }[id] || null);

    const reaped = reapIdleInstances(lastDeliveryAt, getInstanceDef, execMock);

    expect(reaped).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('multiSessionDispatch() returns {action: "requeue"} for offline non-primary instance (triggers auto-start)', () => {
    const item = { target_instance: 'betty', content: 'hello' };
    const helpers = {
      getClaudeState: () => ({ state: 'offline', health: 'ok' }),
      isBypassState: () => false,
    };
    const defs = { betty: { enabled: true, primary: false } };

    const result = multiSessionDispatch(item, helpers, defs);
    expect(result.action).toBe('requeue');
    expect(result.reason).toContain('auto-started');
  });

  it('multiSessionDispatch() returns {action: "skip"} for offline primary instance (no auto-start)', () => {
    const item = { target_instance: 'admin', content: 'hello' };
    const helpers = {
      getClaudeState: () => ({ state: 'offline', health: 'ok' }),
      isBypassState: () => false,
    };
    const defs = { admin: { enabled: true, primary: true } };

    const result = multiSessionDispatch(item, helpers, defs);
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('offline');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Group chat routing (c4-instance-router.js)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Inline replica of isGroupEndpoint and group routing logic from
 * c4-instance-router.js to avoid filesystem dependencies on import.
 */

describe('Group chat routing (c4-instance-router logic)', () => {
  // ── isGroupEndpoint replica ─────────────────────────────────────

  function isGroupEndpoint(chatId, endpointId) {
    // Feishu: only |type:group is reliable (oc_ prefix used for both groups and DMs)
    if (endpointId.includes('|type:group')) return true;
    // Telegram: negative numeric chat_id = group/supergroup
    const num = Number(chatId);
    if (!isNaN(num) && num < 0) return true;
    return false;
  }

  // ── Group instance finder replica ───────────────────────────────

  function getGroupInstance(instancesList) {
    return instancesList.find(inst => inst.type === 'group') || null;
  }

  function resolveInstance(endpointId, config) {
    if (!config) return null;
    const chatId = String(endpointId).split('|')[0];
    const isGroup = isGroupEndpoint(chatId, endpointId);
    if (isGroup) {
      const instances = Object.entries(config.instances || {}).map(
        ([id, def]) => ({ id, ...def })
      );
      const groupInst = getGroupInstance(instances);
      if (groupInst) return groupInst.id;
    }
    // Check routing table
    if (config.routing) {
      if (chatId && config.routing[chatId]) return config.routing[chatId];
      if (config.routing[endpointId]) return config.routing[endpointId];
    }
    return config.default_instance || null;
  }

  // ── isGroupEndpoint tests ──────────────────────────────────────

  it('isGroupEndpoint() does NOT detect oc_ prefix alone as group (Feishu uses oc_ for DMs too)', () => {
    expect(isGroupEndpoint('oc_abc123', 'oc_abc123|type:p2p')).toBe(false);
  });

  it('isGroupEndpoint() detects Feishu groups (|type:group in endpoint)', () => {
    expect(isGroupEndpoint('some_chat', 'some_chat|type:group')).toBe(true);
  });

  it('isGroupEndpoint() detects Telegram groups (negative numeric chat_id)', () => {
    expect(isGroupEndpoint('-1001234567890', '-1001234567890|telegram')).toBe(true);
  });

  it('isGroupEndpoint() returns false for positive Telegram DM ID', () => {
    expect(isGroupEndpoint('123456789', '123456789|telegram')).toBe(false);
  });

  it('isGroupEndpoint() returns false for Feishu DM (oc_ prefix with type:p2p)', () => {
    expect(isGroupEndpoint('oc_abc123', 'oc_abc123|type:p2p|msg:om_xyz')).toBe(false);
  });

  it('isGroupEndpoint() returns false for alphanumeric non-group IDs', () => {
    expect(isGroupEndpoint('user_abc', 'user_abc|slack')).toBe(false);
  });

  // ── Group routing tests ────────────────────────────────────────

  it('group endpoint routes to the instance with type="group"', () => {
    const config = {
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true, type: 'dedicated' },
        'group-handler': { tmux_session: 'claude-group', primary: false, type: 'group' },
      },
      routing: {},
    };

    // Telegram group
    const result1 = resolveInstance('-1001234567890|telegram', config);
    expect(result1).toBe('group-handler');

    // Feishu group
    const result2 = resolveInstance('oc_feishu123|type:group|msg:om_xyz', config);
    expect(result2).toBe('group-handler');
  });

  it('group endpoint falls back to default_instance when no group type instance exists', () => {
    const config = {
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', primary: true, type: 'dedicated' },
      },
      routing: {},
    };

    const result = resolveInstance('-1001234567890|telegram', config);
    expect(result).toBe('admin');
  });

  it('DM endpoint bypasses group routing and uses routing table', () => {
    const config = {
      default_instance: 'admin',
      instances: {
        admin: { tmux_session: 'claude-admin', type: 'dedicated' },
        'group-handler': { tmux_session: 'claude-group', type: 'group' },
        'user-betty': { tmux_session: 'claude-betty', type: 'dedicated' },
      },
      routing: { '123456789': 'user-betty' },
    };

    const result = resolveInstance('123456789|telegram', config);
    expect(result).toBe('user-betty');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. c4-query-instance.js — arg building logic
// ═══════════════════════════════════════════════════════════════════════

describe('c4-query-instance — arg building logic', () => {
  // ── parseArgs replica ──────────────────────────────────────────

  function parseArgs(args) {
    const result = { from: null, to: null, content: null, wait: 0 };
    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '--from':
          result.from = args[++i];
          break;
        case '--to':
          result.to = args[++i];
          break;
        case '--content':
          result.content = args[++i];
          break;
        case '--wait':
          result.wait = parseInt(args[++i], 10) || 0;
          break;
      }
    }
    return result;
  }

  // ── buildReceiveArgs replica ───────────────────────────────────

  function buildReceiveArgs(from, to, taggedContent, receivePath) {
    return [
      receivePath,
      '--channel', 'internal',
      '--endpoint', `instance-${from}`,
      '--target-instance', to,
      '--no-reply',
      '--content', taggedContent,
    ];
  }

  // ── Tests ─────────────────────────────────────────────────────

  it('validates required args (--from, --to, --content all required)', () => {
    const missing1 = parseArgs(['--to', 'admin', '--content', 'hello']);
    expect(missing1.from).toBeNull();

    const missing2 = parseArgs(['--from', 'betty', '--content', 'hello']);
    expect(missing2.to).toBeNull();

    const missing3 = parseArgs(['--from', 'betty', '--to', 'admin']);
    expect(missing3.content).toBeNull();

    // All present
    const complete = parseArgs(['--from', 'betty', '--to', 'admin', '--content', 'hello']);
    expect(complete.from).toBe('betty');
    expect(complete.to).toBe('admin');
    expect(complete.content).toBe('hello');
  });

  it('generates query tag in correct format [query:from:timestamp]', () => {
    const from = 'betty';
    const timestamp = 1700000000000;
    const queryTag = `[query:${from}:${timestamp}]`;

    expect(queryTag).toBe('[query:betty:1700000000000]');
    expect(queryTag).toMatch(/^\[query:[^:]+:\d+\]$/);
  });

  it('calls c4-receive.js with correct args', () => {
    const from = 'betty';
    const to = 'admin';
    const queryTag = `[query:betty:${Date.now()}]`;
    const content = 'What about the report?';
    const taggedContent = `${queryTag} ${content}`;
    const receivePath = '/path/to/c4-receive.js';

    const args = buildReceiveArgs(from, to, taggedContent, receivePath);

    expect(args).toEqual([
      receivePath,
      '--channel', 'internal',
      '--endpoint', 'instance-betty',
      '--target-instance', 'admin',
      '--no-reply',
      '--content', taggedContent,
    ]);
  });

  it('query tag is prepended to content for correlation', () => {
    const from = 'betty';
    const content = 'What about X?';
    const queryTag = `[query:${from}:1700000000000]`;
    const taggedContent = `${queryTag} ${content}`;

    expect(taggedContent).toBe('[query:betty:1700000000000] What about X?');
    expect(taggedContent.startsWith(queryTag)).toBe(true);
    expect(taggedContent.includes(content)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. --all-instances flag (c4-fetch.js)
// ═══════════════════════════════════════════════════════════════════════

describe('--all-instances flag (c4-fetch logic)', () => {
  /**
   * Replica of the instance-filter decision logic from c4-fetch.js.
   * The key question: should we use instance-filtered queries or unfiltered?
   */

  function shouldUseInstanceFilter({ allInstances, instanceId, multiAvailable }) {
    return !allInstances && !!instanceId && multiAvailable;
  }

  it('when --all-instances is set, uses unfiltered queries (no instance filter)', () => {
    const result = shouldUseInstanceFilter({
      allInstances: true,
      instanceId: 'admin',
      multiAvailable: true,
    });
    expect(result).toBe(false);
  });

  it('when not set and ZYLOS_INSTANCE_ID is set, uses instance-filtered queries', () => {
    const result = shouldUseInstanceFilter({
      allInstances: false,
      instanceId: 'admin',
      multiAvailable: true,
    });
    expect(result).toBe(true);
  });

  it('when not set and no ZYLOS_INSTANCE_ID, uses unfiltered queries (backward compat)', () => {
    const result = shouldUseInstanceFilter({
      allInstances: false,
      instanceId: null,
      multiAvailable: true,
    });
    expect(result).toBe(false);
  });

  it('when not set and multi module unavailable, uses unfiltered queries', () => {
    const result = shouldUseInstanceFilter({
      allInstances: false,
      instanceId: 'admin',
      multiAvailable: false,
    });
    expect(result).toBe(false);
  });

  it('--all-instances flag is correctly detected from argv', () => {
    const args1 = ['--unsummarized', '--all-instances'];
    expect(args1.includes('--all-instances')).toBe(true);

    const args2 = ['--unsummarized'];
    expect(args2.includes('--all-instances')).toBe(false);

    const args3 = ['--begin', '1', '--end', '100', '--all-instances'];
    expect(args3.includes('--all-instances')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Memory guard scheduler exemption
// ═══════════════════════════════════════════════════════════════════════

describe('Memory guard — scheduler exemption & write validation', () => {
  let tmpDir;
  let memoryDir;
  let instancesFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    memoryDir = path.join(tmpDir, 'memory');
    instancesFile = path.join(tmpDir, 'instances.json');

    // Create memory directory structure
    fs.mkdirSync(path.join(memoryDir, 'shared', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'instances', 'admin'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'instances', 'betty'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'instances', 'scheduler'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'users'), { recursive: true });
  });

  /**
   * Replica of the core validation logic from memory-guard.js.
   * Parameterized with zylosDir, instanceId, and instances config to
   * avoid process.env side effects between tests.
   */

  function isSchedulerInstance(instanceId, instancesFile) {
    if (!instanceId) return false;
    try {
      const config = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
      const schedulerId = config.scheduler_instance ?? config.default_instance;
      return schedulerId === instanceId;
    } catch {
      return false;
    }
  }

  function isPrimary(instanceId, instancesFile) {
    if (!instanceId) return true; // legacy mode = primary
    try {
      const config = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
      return config.instances?.[instanceId]?.primary === true;
    } catch {
      return true; // fail-open
    }
  }

  function validateMemoryWrite(filePath, { memDir, instanceId, instancesFilePath }) {
    const absPath = path.resolve(filePath);

    // Only guard writes to the memory directory
    if (!absPath.startsWith(memDir + path.sep) && absPath !== memDir) {
      return null; // not a memory write
    }

    const relPath = path.relative(memDir, absPath);
    const segments = relPath.split(path.sep);

    // Writing to instances/<id>/
    if (segments[0] === 'instances' && segments.length >= 2) {
      const targetInstanceId = segments[1];
      if (targetInstanceId !== instanceId && instanceId) {
        return `Cannot write to instance '${targetInstanceId}' memory from instance '${instanceId}'`;
      }
      return null;
    }

    // Writing to shared/
    if (segments[0] === 'shared') {
      if (!isPrimary(instanceId, instancesFilePath) && !isSchedulerInstance(instanceId, instancesFilePath)) {
        return `Non-primary instance '${instanceId}' cannot write to shared memory`;
      }
      return null;
    }

    // Writing to users/ — allow
    if (segments[0] === 'users') {
      return null;
    }

    // Legacy mode — allow everything
    if (!instanceId) return null;

    return null;
  }

  // ── Setup helper ───────────────────────────────────────────────

  function writeConfig(instances) {
    fs.writeFileSync(instancesFile, JSON.stringify(instances, null, 2));
  }

  const CONFIG = {
    default_instance: 'admin',
    scheduler_instance: 'scheduler',
    instances: {
      admin: { tmux_session: 'claude-admin', primary: true, enabled: true },
      betty: { tmux_session: 'claude-betty', primary: false, enabled: true },
      scheduler: { tmux_session: 'claude-scheduler', primary: false, enabled: true },
    },
  };

  // ── Tests ─────────────────────────────────────────────────────

  it('primary instance CAN write to shared/reference/products.md', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'shared', 'reference', 'products.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'admin',
      instancesFilePath: instancesFile,
    });
    expect(result).toBeNull();
  });

  it('scheduler instance CAN write to shared/reference/products.md', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'shared', 'reference', 'products.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'scheduler',
      instancesFilePath: instancesFile,
    });
    expect(result).toBeNull();
  });

  it('regular user instance CANNOT write to shared/reference/products.md', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'shared', 'reference', 'products.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'betty',
      instancesFilePath: instancesFile,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Non-primary');
    expect(result).toContain('betty');
    expect(result).toContain('shared memory');
  });

  it('regular user instance CAN write to their own instances/<id>/state.md', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'instances', 'betty', 'state.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'betty',
      instancesFilePath: instancesFile,
    });
    expect(result).toBeNull();
  });

  it('regular user instance CANNOT write to another instance directory', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'instances', 'admin', 'state.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'betty',
      instancesFilePath: instancesFile,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Cannot write to instance 'admin'");
    expect(result).toContain("from instance 'betty'");
  });

  it('single-session mode (no INSTANCE_ID) allows all writes (backward compat)', () => {
    writeConfig(CONFIG);

    // Can write to shared
    const result1 = validateMemoryWrite(path.join(memoryDir, 'shared', 'reference', 'products.md'), {
      memDir: memoryDir,
      instanceId: null,
      instancesFilePath: instancesFile,
    });
    expect(result1).toBeNull();

    // Can write to any instance dir
    const result2 = validateMemoryWrite(path.join(memoryDir, 'instances', 'admin', 'state.md'), {
      memDir: memoryDir,
      instanceId: null,
      instancesFilePath: instancesFile,
    });
    expect(result2).toBeNull();
  });

  it('writes outside memory directory are always allowed', () => {
    writeConfig(CONFIG);
    const filePath = path.join(tmpDir, 'some-other-file.txt');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'betty',
      instancesFilePath: instancesFile,
    });
    expect(result).toBeNull();
  });

  it('any instance can write to users/ directory', () => {
    writeConfig(CONFIG);
    const filePath = path.join(memoryDir, 'users', 'uid123', 'profile.md');
    const result = validateMemoryWrite(filePath, {
      memDir: memoryDir,
      instanceId: 'betty',
      instancesFilePath: instancesFile,
    });
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Delivery confirmation (c4-dispatcher.js)
// ═══════════════════════════════════════════════════════════════════════

describe('Delivery confirmation (c4-dispatcher logic)', () => {
  let tmpDir;
  let apiActivityFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    apiActivityFile = path.join(tmpDir, 'api-activity.json');
  });

  // ── readPreDeliveryTimestamp replica ────────────────────────────

  function readPreDeliveryTimestamp(statusFile) {
    const activityFile = path.join(path.dirname(statusFile), 'api-activity.json');
    try {
      if (!fs.existsSync(activityFile)) return null;
      const data = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
      return data.last_user_activity ?? null;
    } catch {
      return null;
    }
  }

  // ── confirmDelivery replica (with configurable timeout/poll) ───

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function confirmDelivery(preDeliveryTimestamp, statusFile, { timeoutMs = 500, pollMs = 50 } = {}) {
    const activityFile = path.join(path.dirname(statusFile), 'api-activity.json');

    // Fail-open: no baseline means hook isn't installed
    if (preDeliveryTimestamp === null) {
      return { confirmed: true };
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const data = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
        if (data.last_user_activity && data.last_user_activity > preDeliveryTimestamp) {
          return { confirmed: true };
        }
      } catch { /* file may not exist yet */ }
      await sleep(pollMs);
    }

    return { confirmed: false, reason: 'timeout' };
  }

  // ── readPreDeliveryTimestamp tests ─────────────────────────────

  it('readPreDeliveryTimestamp() reads last_user_activity from api-activity.json', () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    fs.writeFileSync(apiActivityFile, JSON.stringify({
      last_user_activity: 1700000000000,
      active_tools: 0,
      updated_at: Date.now(),
    }));

    const result = readPreDeliveryTimestamp(statusFile);
    expect(result).toBe(1700000000000);
  });

  it('readPreDeliveryTimestamp() returns null when file does not exist (fail-open)', () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    // No api-activity.json written
    const result = readPreDeliveryTimestamp(statusFile);
    expect(result).toBeNull();
  });

  it('readPreDeliveryTimestamp() returns null when last_user_activity is missing', () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    fs.writeFileSync(apiActivityFile, JSON.stringify({
      active_tools: 1,
      updated_at: Date.now(),
    }));

    const result = readPreDeliveryTimestamp(statusFile);
    expect(result).toBeNull();
  });

  // ── confirmDelivery tests ─────────────────────────────────────

  it('confirmDelivery() returns {confirmed: true} when last_user_activity increases', async () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    const preTs = 1700000000000;

    // Write initial state
    fs.writeFileSync(apiActivityFile, JSON.stringify({
      last_user_activity: preTs,
    }));

    // Simulate agent consuming the message after 100ms
    setTimeout(() => {
      fs.writeFileSync(apiActivityFile, JSON.stringify({
        last_user_activity: preTs + 5000,
      }));
    }, 100);

    const result = await confirmDelivery(preTs, statusFile, { timeoutMs: 500, pollMs: 50 });
    expect(result.confirmed).toBe(true);
  });

  it('confirmDelivery() returns {confirmed: true} when no baseline (fail-open)', async () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    const result = await confirmDelivery(null, statusFile, { timeoutMs: 100, pollMs: 50 });
    expect(result.confirmed).toBe(true);
  });

  it('confirmDelivery() returns {confirmed: false, reason: "timeout"} when timestamp does not change', async () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    const preTs = 1700000000000;

    // Write state that never changes
    fs.writeFileSync(apiActivityFile, JSON.stringify({
      last_user_activity: preTs,
    }));

    const result = await confirmDelivery(preTs, statusFile, { timeoutMs: 200, pollMs: 50 });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('confirmDelivery() returns timeout when api-activity.json does not exist at all', async () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    const preTs = 1700000000000;

    // No api-activity.json file exists — but preTs is non-null so we poll
    const result = await confirmDelivery(preTs, statusFile, { timeoutMs: 200, pollMs: 50 });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('confirmDelivery() detects activity even when file is created after polling starts', async () => {
    const statusFile = path.join(tmpDir, 'agent-status.json');
    const preTs = 1700000000000;

    // File doesn't exist yet — create it with a newer timestamp after 100ms
    setTimeout(() => {
      fs.writeFileSync(apiActivityFile, JSON.stringify({
        last_user_activity: preTs + 3000,
      }));
    }, 100);

    const result = await confirmDelivery(preTs, statusFile, { timeoutMs: 500, pollMs: 50 });
    expect(result.confirmed).toBe(true);
  });
});
