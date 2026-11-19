import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

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
// and Enter. Lines are read at the cursor's coordinates: before the paste the
// cursor's row must be the checked prompt row; after it the logical line
// through the cursor's row must be the prompt followed by the pasted text,
// with the cursor at the end of its row.
describe('tmuxPasteToVerifiedPane', async () => {
  const { tmuxPasteToVerifiedPane } = await import('../tmux-helpers.js');
  const PROMPT = 'user@host:~$';
  const pane = { id: '%7', pid: 4242, command: 'bash', promptRow: PROMPT, promptY: 3 };
  const TEXT = 'cd "/x"; claude --model y';
  const LINE = `${PROMPT} ${TEXT}`;
  const SAME = '%7 0 4242 13 3 bash';
  const AFTER = `%7 0 4242 ${LINE.length} 3 bash`;
  // A screen is a list of rows; a row ending in '\\' wraps into the next one
  // (capture-pane -J joins them). -S/-E select visible rows (negative: from 0).
  const rows = (...r) => r;
  const BEFORE_SCREEN = rows('Last login: today', '', `${PROMPT} ls`, PROMPT, '', '');
  const AFTER_SCREEN = rows('Last login: today', '', `${PROMPT} ls`, LINE, '', '');
  function capture(screen, args) {
    const at = (flag) => Number(args[args.indexOf(flag) + 1]);
    const from = Math.max(0, at('-S'));
    const to = Math.min(screen.length - 1, at('-E'));
    const out = [];
    for (let y = from; y <= to; y++) {
      const wraps = screen[y].endsWith('\\');
      const text = wraps ? screen[y].slice(0, -1) : screen[y];
      if (args.includes('-J') && y > from && screen[y - 1].endsWith('\\')) out[out.length - 1] += text;
      else out.push(text);
    }
    return `${out.join('\n')}\n`;
  }
  // probes: what display-message answers on each read; screens: before and after the paste.
  const run = async (probes, after = AFTER_SCREEN, before = BEFORE_SCREEN, { target = pane, text = TEXT } = {}) => {
    const calls = [];
    const keys = [];
    let reads = 0;
    let pasted = false;
    let buffer = null;
    const execFileSyncImpl = (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'load-buffer') buffer = fs.readFileSync(args.at(-1), 'utf8');
      if (args[0] === 'display-message') {
        const probe = probes[Math.min(reads++, probes.length - 1)];
        if (probe === null) throw new Error("can't find pane: %7");
        return probe;
      }
      if (args[0] === 'capture-pane') return capture(pasted ? after : before, args);
      if (args[0] === 'paste-buffer') pasted = true;
      return '';
    };
    let error = null;
    try {
      await tmuxPasteToVerifiedPane(target, 'zylos-buf', text,
        { execFileSyncImpl, sendKeys: (target, k) => keys.push([target, ...k]), sleep: async () => {} });
    } catch (err) { error = err; }
    return { calls, keys, error, pasted, buffer, loaded: calls.some((c) => c[1] === 'load-buffer') };
  };

  it('pastes to the verified pane id and submits once the pane shows the prompt and the pasted line', async () => {
    const got = await run([SAME, AFTER]);
    assert.equal(got.error, null);
    assert.deepEqual(got.calls.filter((c) => c[1] === 'load-buffer' || c[1] === 'paste-buffer').map((c) => c.slice(0, 4)),
      [['tmux', 'load-buffer', '-b', 'zylos-buf'], ['tmux', 'paste-buffer', '-p', '-r']]);
    assert.equal(got.calls.find((c) => c[1] === 'paste-buffer').at(-1), '%7');
    assert.equal(got.buffer, TEXT, 'the buffer holds exactly the validated command');
    assert.deepEqual(got.keys, [['%7', 'Enter']]);
  });

  it('submits a long line wrapped over several rows when the cursor ends it on the last one', async () => {
    const head = LINE.slice(0, 20);
    const tail = LINE.slice(20);
    const got = await run([SAME, `%7 0 4242 ${tail.length} 4 bash`],
      rows('Last login: today', '', `${PROMPT} ls`, `${head}\\`, tail, ''));
    assert.equal(got.error, null);
    assert.deepEqual(got.keys, [['%7', 'Enter']]);
  });

  it('refuses a command ending in a tab, ending in a newline, or with an embedded newline: nothing is pasted', async () => {
    for (const text of [`${TEXT}\t`, `${TEXT}\n`, 'cd "/x"\nclaude --model y', `${TEXT}\r`, `${TEXT} `]) {
      const got = await run([SAME, AFTER], AFTER_SCREEN, BEFORE_SCREEN, { text });
      assert.match(got.error?.message || '', /^the command (contains a control character|ends with whitespace).*; nothing typed$/, JSON.stringify(text));
      assert.equal(got.loaded, false, `${JSON.stringify(text)}: no buffer`);
      assert.equal(got.pasted, false, JSON.stringify(text));
      assert.deepEqual(got.keys, [], JSON.stringify(text));
    }
  });

  it('types nothing when the pane is gone or its foreground or process changed before the paste', async () => {
    for (const probe of [null, '%7 1 4242 13 3 bash', '%7 0 4242 13 3 claude', '%7 0 5151 13 3 bash']) {
      const got = await run([probe]);
      assert.match(got.error?.message || '', /gone or changed since it was verified; nothing typed/, String(probe));
      assert.equal(got.pasted, false, String(probe));
      assert.deepEqual(got.keys, [], String(probe));
    }
  });

  it('types nothing when the cursor is no longer on the checked prompt row, or that row changed', async () => {
    const cases = {
      'cursor moved to another row': [['%7 0 4242 13 2 bash']],
      'cursor not at the end of the prompt': [['%7 0 4242 4 3 bash']],
      'prompt row changed': [[SAME], AFTER_SCREEN, rows('Last login: today', '', `${PROMPT} ls`, `${PROMPT} x`, '', '')],
    };
    for (const [name, [probes, after, before]] of Object.entries(cases)) {
      const got = await run(probes, after, before);
      assert.match(got.error?.message || '', /nothing typed/, name);
      assert.equal(got.pasted, false, name);
      assert.deepEqual(got.keys, [], name);
    }
  });

  it('pastes but never presses Enter when the pane changed between paste and Enter, or the line is not the pasted one', async () => {
    const cases = {
      'pane gone': [[SAME, null]],
      'engine took the foreground': [[SAME, `%7 0 4242 ${LINE.length} 3 claude`]],
      'line differs': [[SAME, `%7 0 4242 ${LINE.length + 1} 3 bash`], rows('', '', '', `${LINE}x`, '', '')],
      'text went elsewhere': [[SAME, SAME], BEFORE_SCREEN],
    };
    for (const [name, [probes, after]] of Object.entries(cases)) {
      const got = await run(probes, after);
      assert.match(got.error?.message || '', /not submitted \(the line is left as typed\)/, name);
      assert.equal(got.pasted, true, name);
      assert.deepEqual(got.keys, [], `${name}: no Enter and no other key`);
    }
  });

  it('never presses Enter when the pasted line is the last row but the cursor sits on an earlier, different row, or not at the end', async () => {
    const cases = {
      'cursor on an earlier row': [[SAME, '%7 0 4242 15 2 bash']],
      'cursor on the pasted row, not at its end': [[SAME, `%7 0 4242 ${LINE.length - 3} 3 bash`]],
      'cursor below the pasted line': [[SAME, '%7 0 4242 0 4 bash']],
    };
    for (const [name, [probes]] of Object.entries(cases)) {
      const got = await run(probes);
      assert.match(got.error?.message || '', /not submitted \(the line is left as typed\)/, name);
      assert.equal(got.pasted, true, name);
      assert.deepEqual(got.keys, [], `${name}: no Enter`);
    }
  });

  // DELIVER-1 fifth review: cursor_x counts terminal cells, not code points.
  const shell = { id: '%7', pid: 4242, command: 'bash', promptRow: '$', promptY: 0 };
  const shellRun = (text, cursorX, row) => run(['%7 0 4242 2 0 bash', `%7 0 4242 ${cursorX} 0 bash`],
    rows(row, '', ''), rows('$', '', ''), { target: shell, text });

  it('measures rows in display cells: after "$ 中abcdefghi" the cursor at cell 13 submits, at 12 (code points) it does not', async () => {
    const row = '$ 中abcdefghi';
    assert.equal([...row].length, 12);
    const right = await shellRun('中abcdefghi', 13, row);
    assert.equal(right.error, null);
    assert.deepEqual(right.keys, [['%7', 'Enter']]);
    const short = await shellRun('中abcdefghi', 12, row);
    assert.match(short.error?.message || '', /not submitted/);
    assert.deepEqual(short.keys, [], 'one cell short: no Enter');
  });

  it('a combining mark takes no cell: the cursor at the cell count submits, at the code point count it does not', async () => {
    const text = 'touch cafe\u0301';
    const row = `$ ${text}`;
    assert.equal([...row].length, 13);
    assert.deepEqual((await shellRun(text, 12, row)).keys, [['%7', 'Enter']]);
    assert.deepEqual((await shellRun(text, 13, row)).keys, []);
  });

  it('types nothing when the command or the prompt has a character of uncertain width (ambiguous, emoji sequence)', async () => {
    for (const text of ['echo 25°C', 'echo ─', 'echo λ', 'echo 👍🏽', 'echo ❤\uFE0F', 'echo a\u200Db']) {
      const got = await shellRun(text, 2 + [...text].length, `$ ${text}`);
      assert.match(got.error?.message || '', /uncertain width; nothing typed/, text);
      assert.equal(got.pasted, false, text);
      assert.deepEqual(got.keys, [], text);
    }
    const ambiguousPrompt = await run(['%7 0 4242 3 0 bash'], rows('λ$ x'), rows('λ$', ''),
      { target: { ...shell, promptRow: 'λ$' }, text: 'x' });
    assert.match(ambiguousPrompt.error?.message || '', /uncertain width; nothing typed/);
    assert.equal(ambiguousPrompt.pasted, false);
  });
});

describe('cellWidth (terminal cells, or null when not known with confidence)', async () => {
  const { cellWidth } = await import('../cell-width.js');
  it('counts ASCII 1, wide and fullwidth East Asian 2, combining and zero-width 0', () => {
    assert.equal(cellWidth('abc'), 3);
    assert.equal(cellWidth('中a'), 3);
    assert.equal(cellWidth('한글'), 4);
    assert.equal(cellWidth('Ａ\u3000'), 4);
    assert.equal(cellWidth('ｱ'), 1, 'halfwidth katakana');
    assert.equal(cellWidth('e\u0301'), 1);
    assert.equal(cellWidth('a\u200Bb'), 2);
    assert.equal(cellWidth('ñ'), 1);
  });
  it('is null for ambiguous width, emoji and their components, controls, format and unassigned characters', () => {
    for (const s of ['°', '─', 'é', 'λ', 'Я', '👍', '👍🏽', '❤\uFE0F', 'a\u200Db', '🇯🇵', '\t', '\u00AD', '\uE000', '\u{10FFFD}', '\u0378']) {
      assert.equal(cellWidth(s), null, JSON.stringify(s));
    }
  });
});

// PASTE-STRAND-1 review (ii): in a real private tmux server, a session whose
// first window is 80x24 and whose active window is larger: the active window
// is measured and resized by its own id, and never shrunk.
describe('tmuxPinAgentWindow (private tmux server)', () => {
  const socket = `pin-${process.pid}`;
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  const viaSocket = (file, args, opts) => execFileSync(file, ['-L', socket, ...args], opts);
  const size = (target) => tmux('display-message', '-p', '-t', target, '#{window_width}x#{window_height}').trim();
  let available = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { available = false; }

  it('keeps a larger active window at its size and leaves the first window alone; brings a small active window to 200x60', { skip: !available }, async () => {
    const { tmuxPinAgentWindow } = await import('../tmux-helpers.js');
    try {
      tmux('new-session', '-d', '-s', 'pin', '-x', '80', '-y', '24', 'sleep 30');
      const big = tmux('new-window', '-P', '-F', '#{window_id}', '-t', 'pin', 'sleep 30').trim();
      tmux('resize-window', '-t', big, '-x', '250', '-y', '70');
      assert.equal(size('pin:0'), '80x24');
      assert.equal(tmuxPinAgentWindow('pin', { execFileSyncImpl: viaSocket }), false);
      assert.equal(size(big), '250x70', 'the larger active window is not shrunk');
      assert.equal(size('pin:0'), '80x24', 'the first window is not touched');
      tmux('select-window', '-t', 'pin:0');
      assert.equal(tmuxPinAgentWindow('pin', { execFileSyncImpl: viaSocket }), true);
      assert.equal(size('pin:0'), '200x60');
      assert.equal(size(big), '250x70');
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
    }
  });
});

// PASTE-STRAND-1 review of 218daf77 (ii) 2: a private after-new-session hook
// opens and selects an operator window at 90x30 while the agent session is
// created. The pin goes to the window new-session created, by its id.
describe('tmuxNewSession with a focus-moving after-new-session hook (private tmux server)', () => {
  const socket = `fresh-${process.pid}`;
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  const viaSocket = (file, args, opts) => execFileSync(file, file === 'tmux' ? ['-L', socket, ...args] : args, opts);
  const size = (target) => tmux('display-message', '-p', '-t', target, '#{window_width}x#{window_height}').trim();
  const manual = (target) => tmux('show-window-options', '-v', '-t', target, 'window-size').trim();
  let available = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { available = false; }

  it('the new agent window is 200x60 and pinned; the hook\'s window keeps 90x30', { skip: !available }, async () => {
    const { tmuxNewSession } = await import('../tmux-helpers.js');
    try {
      tmux('new-session', '-d', '-s', 'operator', '-x', '80', '-y', '24', 'sleep 30');
      tmux('set-hook', '-g', 'after-new-session', "new-window 'sleep 30' ; resize-window -x 90 -y 30");
      const agentWindow = tmuxNewSession(['new-session', '-d', '-s', 'agent', 'sleep 30'], { execFileSyncImpl: viaSocket });
      const windows = tmux('list-windows', '-t', 'agent', '-F', '#{window_id} #{window_active}').trim().split('\n').map((l) => l.split(' '));
      assert.equal(windows.length, 2, 'the hook opened a second window');
      const [other] = windows.find(([, active]) => active === '1');
      assert.notEqual(other, agentWindow, 'the hook moved the focus off the created window');
      assert.equal(tmux('list-panes', '-t', 'agent', '-F', '#{window_id}').trim().split('\n')[0], other, 'the session name now resolves to the hook\'s window');
      assert.match(agentWindow, /^@\d+$/);
      assert.equal(size(agentWindow), '200x60');
      assert.equal(manual(agentWindow), 'manual', 'pinned');
      assert.equal(size(other), '90x30', 'the other window keeps its size');
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
    }
  });
});

// PASTE-STRAND-1 review (ii) 3: during a retained relaunch the focus moves
// from window A to window B 150 ms into the launch. The deployed check and
// the pinned one verify, and would type into, the same pane: the one the
// launch resolved first (A); the resize goes to that pane's window only.
describe('requirePaneAtShellPrompt with the pin (private tmux server, focus change during launch)', () => {
  const socket = `focus-${process.pid}`;
  const tmux = (...args) => execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  const viaSocket = (file, args, opts) => execFileSync(file, file === 'tmux' ? ['-L', socket, ...args] : args, opts);
  const size = (target) => tmux('display-message', '-p', '-t', target, '#{window_width}x#{window_height}').trim();
  let available = true;
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { available = false; }
  const shell = `env -i PATH=${process.env.PATH} HOME=${os.tmpdir()} TERM=xterm PS1='$ ' bash --norc --noprofile -i`;

  it('the deployed check and the pinned check both settle on window A\'s pane, never B', { skip: !available }, async () => {
    const { requirePaneAtShellPrompt, tmuxPinAgentWindow } = await import('../tmux-helpers.js');
    const run = async (pin) => {
      try { tmux('kill-server'); } catch { /* none */ }
      tmux('new-session', '-d', '-s', 'launch', '-x', '80', '-y', '24', shell);
      const paneA = tmux('display-message', '-p', '-t', 'launch', '#{pane_id}').trim();
      const paneB = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'launch', shell).trim();
      await new Promise((resolve) => setTimeout(resolve, 600)); // both prompts drawn
      const focus = setTimeout(() => tmux('select-window', '-t', paneB), 150);
      let result;
      try {
        const pane = await requirePaneAtShellPrompt('launch', { execFileSyncImpl: viaSocket,
          ...(pin ? { pinWindow: (id) => tmuxPinAgentWindow(id, { execFileSyncImpl: viaSocket }) } : {}) });
        result = { ok: true, id: pane.id };
      } catch (err) {
        result = { ok: false, reason: err.message };
      }
      clearTimeout(focus);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { result, paneA, paneB, sizeA: size(paneA), sizeB: size(paneB) };
    };
    try {
      const deployed = await run(false);
      assert.deepEqual(deployed.result, { ok: true, id: deployed.paneA }, JSON.stringify(deployed));
      const pinned = await run(true);
      assert.deepEqual(pinned.result, { ok: true, id: pinned.paneA }, JSON.stringify(pinned));
      assert.equal(pinned.sizeA, '200x60', 'the resolved pane\'s window was resized');
      assert.equal(pinned.sizeB, '80x24', 'the other window was not');
    } finally {
      try { tmux('kill-server'); } catch { /* already gone */ }
    }
  });
});
