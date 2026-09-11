import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findDescendantPid,
  hasDescendantProcess,
  findRuntimePidUnderPane,
} from '../process-tree.js';

// Build a synthetic process tree so the tests are deterministic (no live ps).
// entries: [pid, ppid, comm, args?]
function tree(entries) {
  const childrenOf = new Map();
  const infoOf = new Map();
  for (const [pid, ppid, comm, args = ''] of entries) {
    infoOf.set(pid, { comm, args });
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  return { childrenOf, infoOf };
}

// The exact os_user shape: pane(sudo) -> sudo -> node -> claude(+threads).
const osUserTree = tree([
  [100, 1, 'sudo', 'sudo -n -u zylos-pan -H -- node tmux-launcher.js /tmp/spec'],
  [101, 100, 'sudo', 'sudo -n -u zylos-pan -H -- node tmux-launcher.js /tmp/spec'],
  [102, 101, 'node', 'node /home/.../tmux-launcher.js /tmp/spec'],
  [103, 102, 'claude', 'claude'],
  [104, 103, 'claude', 'claude (worker)'],
]);

// Non-os_user shape: pane IS claude directly.
const directTree = tree([
  [200, 1, 'claude', 'claude'],
  [201, 200, 'node', 'node worker'],
]);

describe('process-tree util', () => {
  it('findDescendantPid finds a great-grandchild runtime (os_user nested sudo)', () => {
    assert.equal(findDescendantPid(100, 'claude', osUserTree), 103);
  });

  it('findDescendantPid returns 0 when nothing matches', () => {
    assert.equal(findDescendantPid(100, 'codex', osUserTree), 0);
  });

  it('findDescendantPid does NOT match the root itself (descendants only)', () => {
    // pane 200 IS claude, but findDescendantPid only searches descendants.
    assert.equal(findDescendantPid(200, 'claude', directTree), 0);
  });

  it('hasDescendantProcess reflects presence', () => {
    assert.equal(hasDescendantProcess(100, 'claude', osUserTree), true);
    assert.equal(hasDescendantProcess(100, 'codex', osUserTree), false);
  });

  it('findRuntimePidUnderPane returns the pane itself when it IS the runtime', () => {
    assert.equal(findRuntimePidUnderPane(200, 'claude', directTree), 200);
  });

  it('findRuntimePidUnderPane returns the nested runtime for os_user launches', () => {
    assert.equal(findRuntimePidUnderPane(100, 'claude', osUserTree), 103);
  });

  it('matches by comm, and falls back to command-line substring', () => {
    const t = tree([
      [300, 1, 'wrapper', 'some-wrapper --run codex'],
      [301, 300, 'codex', 'codex'],
    ]);
    // comm exact:
    assert.equal(findDescendantPid(300, 'codex', t), 301);
    // args fallback (comm != pattern, args contains it): the wrapper root would
    // match via args, but it's the root (not a descendant of itself), so from a
    // grandparent the wrapper is found by args.
    const t2 = tree([
      [400, 1, 'sh', 'sh'],
      [401, 400, 'wrapper', 'node run-codex.js'],
    ]);
    assert.equal(findDescendantPid(400, 'codex', t2), 401);
  });

  it('guards invalid input', () => {
    assert.equal(findDescendantPid(0, 'claude', osUserTree), 0);
    assert.equal(findDescendantPid(100, '', osUserTree), 0);
    assert.equal(findRuntimePidUnderPane(-1, 'claude', osUserTree), 0);
  });
});
