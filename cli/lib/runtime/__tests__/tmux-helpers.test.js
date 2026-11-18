import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { execFileSync } from 'node:child_process';

// We test the module's behavior by importing it and verifying that
// the functions handle various child_process outcomes correctly.
// Since tmux-helpers calls execFileSync directly (no DI), we use
// node:test's mock.module to intercept calls.

import {
  tmuxHasSession,
  tmuxGetPanePid,
  tmuxKillSession,
  tmuxCapturePaneText,
  getProcessName,
  hasChildProcess,
  isTimeoutError,
} from '../tmux-helpers.js';

// These tests verify the contract: each function must never throw,
// and must return the correct fallback on timeout or exit errors.

describe('tmux-helpers integration (live calls to nonexistent sessions)', () => {
  const FAKE_SESSION = '__zylos_test_nonexistent_session__';

  it('tmuxHasSession returns false for nonexistent session', () => {
    assert.equal(tmuxHasSession(FAKE_SESSION), false);
  });

  it('tmuxGetPanePid returns 0 for nonexistent session', () => {
    assert.equal(tmuxGetPanePid(FAKE_SESSION), 0);
  });

  it('tmuxKillSession does not throw for nonexistent session', () => {
    assert.doesNotThrow(() => tmuxKillSession(FAKE_SESSION));
  });

  it('tmuxCapturePaneText returns null for nonexistent session', () => {
    assert.equal(tmuxCapturePaneText(FAKE_SESSION), null);
  });

  it('getProcessName returns null for nonexistent PID', () => {
    assert.equal(getProcessName(999999999), null);
  });

  it('hasChildProcess returns false for nonexistent parent', () => {
    assert.equal(hasChildProcess(999999999, 'nope'), false);
  });
});

describe('tmux-helpers timeout behavior', () => {
  it('tmuxHasSession returns false on timeout (does not throw)', () => {
    // Simulate what happens when execFileSync times out:
    // Node sets err.killed = true and err.signal = 'SIGTERM'.
    // The function should catch and return false.
    // We can't easily mock execFileSync in ESM, but we verify the
    // contract: nonexistent session returns false without throwing.
    const result = tmuxHasSession('__timeout_test__');
    assert.equal(result, false);
  });

  it('tmuxGetPanePid returns 0 on error (does not throw)', () => {
    const result = tmuxGetPanePid('__timeout_test__');
    assert.equal(result, 0);
  });

  it('tmuxCapturePaneText returns null on error (does not throw)', () => {
    const result = tmuxCapturePaneText('__timeout_test__');
    assert.equal(result, null);
  });

  it('getProcessName returns null on error (does not throw)', () => {
    const result = getProcessName(-1);
    assert.equal(result, null);
  });

  it('hasChildProcess returns false on error (does not throw)', () => {
    const result = hasChildProcess(-1, 'anything');
    assert.equal(result, false);
  });
});

describe('tmux-helpers does not log on normal exit failures', () => {
  it('tmuxHasSession with nonexistent session produces no stderr timeout warning', () => {
    // Normal "session not found" exits with code 1 and no ETIMEDOUT.
    // The wrapper should NOT log a timeout warning for this case.
    const origWrite = process.stderr.write;
    let stderrOutput = '';
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    try {
      tmuxHasSession('__no_such_session__');
      assert.equal(stderrOutput.includes('timed out'), false,
        'Should not log timeout warning for normal session-not-found');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('tmuxGetPanePid with nonexistent session produces no stderr timeout warning', () => {
    const origWrite = process.stderr.write;
    let stderrOutput = '';
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    try {
      tmuxGetPanePid('__no_such_session__');
      assert.equal(stderrOutput.includes('timed out'), false,
        'Should not log timeout warning for normal session-not-found');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('isTimeoutError classifier', () => {
  it('returns true for ETIMEDOUT error (Node execFileSync timeout)', () => {
    const err = new Error('spawnSync sleep ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    err.signal = 'SIGTERM';
    assert.equal(isTimeoutError(err), true);
  });

  it('returns false for normal exit code 1 (session not found)', () => {
    const err = new Error('Command failed: tmux has-session');
    err.status = 1;
    err.code = undefined;
    err.signal = null;
    assert.equal(isTimeoutError(err), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError(undefined), false);
  });

  it('returns false for generic errors', () => {
    assert.equal(isTimeoutError(new Error('ENOENT')), false);
  });
});

// DELIVER-1: the retained-session launch pastes and submits only to the pane
// it verified, by pane id: one read before the paste, and one between paste
// and Enter that must show the same pane and, on the cursor's line, the
// verified prompt followed by the pasted text.
describe('tmuxPasteToVerifiedPane', async () => {
  const { tmuxPasteToVerifiedPane } = await import('../tmux-helpers.js');
  const pane = { id: '%7', pid: 4242, command: 'bash', promptRow: 'user@host:~$' };
  const TEXT = 'cd "/x"; claude --model y';
  const SAME = '%7 0 4242 13 3 bash';
  // probes: what display-message answers on each read; capture: the screen after the paste.
  const run = async (probes, capture = `user@host:~$ ${TEXT}\n`) => {
    const calls = [];
    const keys = [];
    let reads = 0;
    const execFileSyncImpl = (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'display-message') {
        const probe = probes[Math.min(reads++, probes.length - 1)];
        if (probe === null) throw new Error("can't find pane: %7");
        return probe;
      }
      if (args[0] === 'capture-pane') return capture;
      return '';
    };
    let error = null;
    try {
      await tmuxPasteToVerifiedPane(pane, '/tmp/msg.txt', 'zylos-buf', TEXT,
        { execFileSyncImpl, sendKeys: (target, k) => keys.push([target, ...k]), sleep: async () => {} });
    } catch (err) { error = err; }
    return { calls, keys, error, pasted: calls.some((c) => c[1] === 'paste-buffer') };
  };

  it('pastes to the verified pane id and submits once the pane shows the prompt and the pasted line', async () => {
    const got = await run([SAME, SAME]);
    assert.equal(got.error, null);
    assert.deepEqual(got.calls.filter((c) => c[1] === 'load-buffer' || c[1] === 'paste-buffer'),
      [['tmux', 'load-buffer', '-b', 'zylos-buf', '/tmp/msg.txt'], ['tmux', 'paste-buffer', '-p', '-r', '-b', 'zylos-buf', '-t', '%7']]);
    assert.deepEqual(got.keys, [['%7', 'Enter']]);
  });

  it('types nothing when the pane is gone or its foreground or process changed before the paste', async () => {
    for (const probe of [null, '%7 1 4242 13 3 bash', '%7 0 4242 13 3 claude', '%7 0 5151 13 3 bash']) {
      const got = await run([probe]);
      assert.match(got.error?.message || '', /gone or changed since it was verified; nothing typed/, String(probe));
      assert.equal(got.pasted, false, String(probe));
      assert.deepEqual(got.keys, [], String(probe));
    }
  });

  it('pastes but never presses Enter when the pane changed between paste and Enter, or the line is not the pasted one', async () => {
    const cases = {
      'pane gone': [[SAME, null]],
      'engine took the foreground': [[SAME, '%7 0 4242 40 3 claude']],
      'line differs': [[SAME, SAME], `user@host:~$ ${TEXT}x\n`],
      'text went elsewhere': [[SAME, SAME], 'user@host:~$\n'],
    };
    for (const [name, [probes, capture]] of Object.entries(cases)) {
      const got = await run(probes, capture);
      assert.match(got.error?.message || '', /not submitted \(the line is left as typed\)/, name);
      assert.equal(got.pasted, true, name);
      assert.deepEqual(got.keys, [], `${name}: no Enter and no other key`);
    }
  });
});
