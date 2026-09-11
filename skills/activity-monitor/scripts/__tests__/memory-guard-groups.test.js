/**
 * ZY-GRP-1 memory/groups enforcement — REAL module imports of the memory-policy
 * used by the memory-guard PreToolUse hook. No filesystem: existsSync/realpathSync
 * are injected so path resolution is deterministic, and readFileSync feeds a fake
 * instances.json so instance-type lookups are hermetic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';

import {
  isGroupInstance,
  validateMemoryWrite,
} from '../../../multi-session/memory-policy.js';

const ZYLOS_DIR = '/tmp/zylos-grp-test';
const MEMORY_DIR = path.join(ZYLOS_DIR, 'memory');

const CONFIG = {
  instances: {
    admin: { primary: true, type: 'dedicated' },
    group: { type: 'group', primary: false },
    'user-pan': { type: 'user', primary: false },
  },
};

// existsSync=true stops ancestor-walk at the path itself; realpathSync is identity
// so resolution never touches the real filesystem.
function opts(instanceId, { readThrows = false } = {}) {
  return {
    zylosDir: ZYLOS_DIR,
    memoryDir: MEMORY_DIR,
    instanceId,
    instancesFilePath: path.join(ZYLOS_DIR, 'instances.json'),
    existsSync: () => true,
    realpathSync: (p) => p,
    readFileSync: () => {
      if (readThrows) throw new Error('unreadable');
      return JSON.stringify(CONFIG);
    },
  };
}

const groupPath = path.join(MEMORY_DIR, 'groups', 'oc_A', 'context.md');

describe('isGroupInstance', () => {
  const base = { instancesFilePath: '/x', readFileSync: () => JSON.stringify(CONFIG) };
  it('is true only for the type:group instance', () => {
    assert.equal(isGroupInstance({ ...base, instanceId: 'group' }), true);
    assert.equal(isGroupInstance({ ...base, instanceId: 'user-pan' }), false);
    assert.equal(isGroupInstance({ ...base, instanceId: 'admin' }), false);
  });
  it('fails closed (false) when config is unreadable or instance is unset', () => {
    assert.equal(isGroupInstance({ ...base, instanceId: 'group', readFileSync: () => { throw new Error('x'); } }), false);
    assert.equal(isGroupInstance({ ...base, instanceId: null }), false);
  });
});

describe('validateMemoryWrite — memory/groups tier', () => {
  it('allows the group instance to write memory/groups/<key>/...', () => {
    assert.equal(validateMemoryWrite(groupPath, opts('group')), null);
  });

  it('denies a non-group user instance', () => {
    const rej = validateMemoryWrite(groupPath, opts('user-pan'));
    assert.match(rej, /cannot write group memory/);
  });

  it('denies the primary/admin instance too (group tier is group-only)', () => {
    const rej = validateMemoryWrite(groupPath, opts('admin'));
    assert.match(rej, /cannot write group memory/);
  });

  it('requires a <group_key> segment', () => {
    const rej = validateMemoryWrite(path.join(MEMORY_DIR, 'groups'), opts('group'));
    assert.match(rej, /group_key/);
  });

  it('fails closed: group write denied when instances.json is unreadable', () => {
    const rej = validateMemoryWrite(groupPath, opts('group', { readThrows: true }));
    assert.match(rej, /cannot write group memory/);
  });

  it('does not regress existing tiers: group can still write its own instance dir; user-pan cannot touch groups', () => {
    assert.equal(
      validateMemoryWrite(path.join(MEMORY_DIR, 'instances', 'group', 'state.md'), opts('group')),
      null,
    );
    // user-pan writing its own instance dir stays allowed
    assert.equal(
      validateMemoryWrite(path.join(MEMORY_DIR, 'instances', 'user-pan', 'state.md'), opts('user-pan')),
      null,
    );
  });
});
