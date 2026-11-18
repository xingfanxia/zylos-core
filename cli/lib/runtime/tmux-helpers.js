/**
 * Shared tmux helper functions for runtime adapters.
 *
 * All child-process calls use execFileSync (no shell) with finite timeouts
 * to prevent event-loop hangs when the tmux server is unresponsive.
 */

import { execFileSync } from 'node:child_process';
import { sendTmuxKeys } from '../tmux-send-keys.js';
import { buildProcessTree, hasDescendantProcess } from './process-tree.js';
import { cellWidth } from './cell-width.js';

const CMD_TIMEOUT = 3000;
const LAUNCH_TIMEOUT = 10_000;

/**
 * Check whether a tmux session exists.
 * @param {string} session
 * @returns {boolean}
 */
export function tmuxHasSession(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux has-session', err);
    return false;
  }
}

/**
 * Get the pane PID for a tmux session.
 * @param {string} session
 * @returns {number} PID or 0
 */
export function tmuxGetPanePid(session) {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const lines = out.split('\n');
    const pid = parseInt(lines[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux list-panes', err);
    return 0;
  }
}

/**
 * Kill a tmux session.
 * @param {string} session
 */
export function tmuxKillSession(session) {
  try {
    execFileSync('tmux', ['kill-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* session may not exist */ }
}

/**
 * Send text to a tmux session via the buffer-paste technique.
 * Uses native bracketed paste and preserves LF so multiline messages remain
 * one input instead of becoming a burst of Enter-delimited fragments.
 *
 * @param {string} session
 * @param {string} tmpFile - Path to a temp file containing the text
 * @param {string} bufferName - Unique tmux buffer name
 */
export function tmuxPasteBuffer(session, tmpFile, bufferName) {
  execFileSync('tmux', ['load-buffer', '-b', bufferName, tmpFile], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  execFileSync('tmux', ['paste-buffer', '-p', '-r', '-b', bufferName, '-t', session], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  sendTmuxKeys(session, ['Enter'], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

// ── Retained-session launch: a verified shell prompt, bound to its pane ────
//
// Both runtime adapters (Claude, Codex) relaunch into an existing tmux
// session by typing a command line and Enter. That is safe only at an idle
// shell prompt: typed into a running engine, its composer or one of its
// dialogs, Enter could submit or approve something (DELIVER-1, 2026-11-18).
// Positive evidence, all on ONE pane resolved once (its immutable pane id):
//   - the pane is alive; tmux reports a shell as its foreground command; the
//     pane process is that shell and has no child process;
//   - the cursor sits at the end of the last non-empty row, which is short
//     (PROMPT_ROW_MAX) and, with the cursor, unchanged across two reads
//     PROMPT_SETTLE_MS apart.
// The text then goes to that pane id after one more read shows the same pane,
// pane process and shell in the foreground, and the cursor still on the
// checked prompt row (same row, same text) at its end; otherwise nothing is
// typed. Enter follows only after a read between paste and Enter shows the
// same pane, process and shell, and the line is taken at the cursor's
// coordinates: the logical line through the cursor's row (wrapped rows
// joined) must be exactly the verified prompt followed by the pasted text,
// and the cursor must sit at the end of its own row. Otherwise no Enter (the
// line is left as typed, no key is sent to clean it up) and the launch fails.
// Rows are measured in terminal cells, as cursor_x is (cell-width.js: wide
// characters 2, combining marks 0); a prompt, command or row with a character
// of uncertain width (East Asian ambiguous, emoji sequences) gets nothing. Not distinguished: a shell builtin waiting for
// input (`read`, a heredoc continuation) looks exactly like an idle prompt to
// tmux and /proc; the typed line would become that builtin's input. It cannot
// reach an engine or its dialog, because an engine in the foreground (or as a
// child of the shell) is rejected first.
const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish']);
const shellName = (name) => String(name || '').replace(/^-/, '').split('/').pop();
const PANE_FORMAT = '#{pane_id} #{pane_dead} #{pane_pid} #{cursor_x} #{cursor_y} #{pane_current_command}';
export const PROMPT_ROW_MAX = 80;
export const PROMPT_SETTLE_MS = 300;

function readPane(target, execFileSyncImpl) {
  try {
    const out = String(execFileSyncImpl('tmux', ['display-message', '-p', '-t', target, PANE_FORMAT], {
      encoding: 'utf8', timeout: CMD_TIMEOUT, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const m = /^(%\d+) (\d+) (\d+) (\d+) (\d+) (\S+)$/.exec(out);
    if (!m) return null;
    return { id: m[1], dead: m[2] !== '0', pid: Number(m[3]), cursorX: Number(m[4]), cursorY: Number(m[5]), command: shellName(m[6]) };
  } catch {
    return null;
  }
}

function lastRow(paneId, execFileSyncImpl) {
  let text;
  try {
    text = String(execFileSyncImpl('tmux', ['capture-pane', '-p', '-t', paneId], {
      encoding: 'utf8', timeout: CMD_TIMEOUT, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
  const rows = text.replace(/\n$/, '').split('\n').map((row) => row.replace(/\s+$/, ''));
  let y = rows.length - 1;
  while (y >= 0 && !rows[y]) y--;
  return y < 0 ? null : { y, text: rows[y] };
}

/**
 * Positive evidence that a session's pane sits at an idle shell prompt.
 * @param {string} session
 * @returns {Promise<{ ok: boolean, reason: string, pane?: { id: string, pid: number, command: string } }>}
 */
export async function tmuxPaneAtShellPrompt(session, { execFileSyncImpl = execFileSync, buildTree = buildProcessTree,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), settleMs = PROMPT_SETTLE_MS } = {}) {
  const first = readPane(session, execFileSyncImpl);
  if (!first) return { ok: false, reason: 'pane unreadable' };
  if (first.dead) return { ok: false, reason: 'pane is dead' };
  if (!SHELL_NAMES.has(first.command)) return { ok: false, reason: `foreground is ${first.command.slice(0, 32)}, not a shell` };
  const tree = buildTree();
  const own = tree.infoOf.get(first.pid);
  if (!own || !SHELL_NAMES.has(shellName(own.comm))) return { ok: false, reason: 'pane process is not a shell' };
  if ((tree.childrenOf.get(first.pid) || []).length > 0) return { ok: false, reason: 'shell is running a command' };
  const row = lastRow(first.id, execFileSyncImpl);
  // Cursor positions are terminal cells: a row whose width is not known with
  // confidence (cell-width.js) is refused, nothing is typed.
  const cells = row ? cellWidth(row.text) : null;
  if (row && cells === null) return { ok: false, reason: 'last row has a character of uncertain width' };
  const atRowEnd = (pane, r) => r && pane.cursorY === r.y && pane.cursorX >= cells && pane.cursorX <= cells + 1;
  if (!atRowEnd(first, row)) return { ok: false, reason: 'cursor is not at the end of the last row' };
  if (cells > PROMPT_ROW_MAX) return { ok: false, reason: 'last row is too long for a prompt' };
  await sleep(settleMs);
  const second = readPane(first.id, execFileSyncImpl);
  const again = lastRow(first.id, execFileSyncImpl);
  if (!second || second.dead || second.pid !== first.pid || second.command !== first.command
      || second.cursorX !== first.cursorX || second.cursorY !== first.cursorY || !again || again.y !== row.y || again.text !== row.text) {
    return { ok: false, reason: 'pane changed while it was checked' };
  }
  return { ok: true, reason: 'shell prompt', pane: { id: first.id, pid: first.pid, command: first.command, promptRow: row.text, promptY: row.y } };
}

/**
 * The retained-session launch of every runtime adapter calls this right
 * before typing. Resolves the verified pane, or throws (nothing typed); the
 * failed launch goes to the guardian's failed-start handling (retry once,
 * then hold and alert).
 * @returns {Promise<{ id: string, pid: number, command: string, promptRow: string, promptY: number }>}
 */
export async function requirePaneAtShellPrompt(session, deps) {
  const prompt = await tmuxPaneAtShellPrompt(session, deps);
  if (!prompt.ok) throw new Error(`existing tmux session ${session} is not at a shell prompt (${prompt.reason}); nothing typed`);
  return prompt.pane;
}

// Rows of a capture between visible rows `from` and `to` (negative: history),
// trailing blanks trimmed; null when unreadable.
function captureRows(paneId, extra, from, to, execFileSyncImpl) {
  try {
    const text = String(execFileSyncImpl('tmux', ['capture-pane', '-p', ...extra, '-S', String(from), '-E', String(to), '-t', paneId], {
      encoding: 'utf8', timeout: CMD_TIMEOUT, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    return text.replace(/\n$/, '').split('\n').map((row) => row.replace(/\s+$/, ''));
  } catch {
    return null;
  }
}

// The physical row at the cursor's y, and the logical line (wrapped rows
// joined) that ends at that row. Both are taken at the cursor's coordinates,
// never from "the last non-empty row".
const rowAt = (paneId, y, impl) => captureRows(paneId, [], y, y, impl)?.[0] ?? null;
function lineThroughRow(paneId, y, impl) {
  const rows = captureRows(paneId, ['-J'], -100, y, impl);
  return rows ? rows[rows.length - 1] : null;
}

const samePane = (now, pane) => Boolean(now) && now.id === pane.id && !now.dead && now.pid === pane.pid && now.command === pane.command;

/**
 * Paste `text` (from tmpFile) into the pane verified by
 * requirePaneAtShellPrompt, by its pane id, then submit it.
 * Before the paste one read must show the same pane alive with the same pane
 * process and shell in the foreground, the cursor on the checked prompt row
 * (same y) and that row, read at the cursor's y, still the checked prompt
 * with the cursor at its end. Before Enter another read must show the same
 * pane, process and shell; at the cursor's coordinates the logical line ending
 * on the cursor's row must be the verified prompt followed by `text`, and the
 * cursor must be at the end of its row. On any difference nothing more is
 * sent (before the paste: nothing at all; after it: no Enter, the line stays
 * as typed) and this throws.
 */
export async function tmuxPasteToVerifiedPane(pane, tmpFile, bufferName, text, { execFileSyncImpl = execFileSync,
  sendKeys = sendTmuxKeys, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), echoMs = 200 } = {}) {
  const typed = String(text).replace(/\s+$/, '');
  const promptCells = cellWidth(pane.promptRow);
  if (promptCells === null || cellWidth(typed) === null) {
    throw new Error(`the prompt or the command has a character of uncertain width; nothing typed`);
  }
  const before = readPane(pane.id, execFileSyncImpl);
  const promptNow = before && rowAt(pane.id, before.cursorY, execFileSyncImpl);
  if (!samePane(before, pane) || before.cursorY !== pane.promptY || promptNow !== pane.promptRow
      || before.cursorX < promptCells || before.cursorX > promptCells + 1) {
    throw new Error(`pane ${pane.id} is gone or changed since it was verified; nothing typed`);
  }
  execFileSyncImpl('tmux', ['load-buffer', '-b', bufferName, tmpFile], { timeout: CMD_TIMEOUT, stdio: 'ignore' });
  execFileSyncImpl('tmux', ['paste-buffer', '-p', '-r', '-b', bufferName, '-t', pane.id], { timeout: CMD_TIMEOUT, stdio: 'ignore' });
  await sleep(echoMs);
  const expected = [`${pane.promptRow} ${typed}`, `${pane.promptRow}${typed}`];
  const after = readPane(pane.id, execFileSyncImpl);
  const line = after && lineThroughRow(pane.id, after.cursorY, execFileSyncImpl);
  const cursorRow = after && rowAt(pane.id, after.cursorY, execFileSyncImpl);
  if (!samePane(after, pane) || !expected.includes(line) || cursorRow === null || !cursorRow
      || !line.endsWith(cursorRow) || after.cursorX !== cellWidth(cursorRow)) {
    throw new Error(`pane ${pane.id} changed or does not show the pasted line at the cursor after the paste; not submitted (the line is left as typed)`);
  }
  sendKeys(pane.id, ['Enter'], { timeout: CMD_TIMEOUT, stdio: 'ignore' });
}

/**
 * Delete a tmux buffer (best-effort).
 * @param {string} bufferName
 */
export function tmuxDeleteBuffer(bufferName) {
  try {
    execFileSync('tmux', ['delete-buffer', '-b', bufferName], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* best-effort */ }
}

/**
 * Capture tmux pane content.
 * @param {string} session
 * @returns {string|null}
 */
export function tmuxCapturePaneText(session) {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', session], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux capture-pane', err);
    return null;
  }
}

/**
 * Send keys to a tmux session.
 * @param {string} session
 * @param {...string} keys
 */
export function tmuxSendKeys(session, ...keys) {
  sendTmuxKeys(session, keys, {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

/**
 * Create a new tmux session.
 * @param {string[]} args - Full argument list for `tmux new-session`
 */
export function tmuxNewSession(args) {
  execFileSync('tmux', args, { timeout: LAUNCH_TIMEOUT });
}

/**
 * Get the process name for a PID.
 * @param {number} pid
 * @returns {string|null}
 */
export function getProcessName(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a PID has a DESCENDANT process matching `pattern` (runtime name).
 * Thin wrapper over the shared process-tree util so every runtime-detection
 * site handles the os_user nested-sudo launch identically — see
 * process-tree.js for why a direct-child check is insufficient.
 *
 * @param {number} parentPid
 * @param {string} pattern  runtime process name, e.g. 'claude' | 'codex'
 * @returns {boolean}
 */
export function hasChildProcess(parentPid, pattern) {
  return hasDescendantProcess(parentPid, pattern);
}

export function isTimeoutError(err) {
  return err?.code === 'ETIMEDOUT';
}

function _debugTimeout(label, err) {
  const signal = err.signal || 'unknown';
  process.stderr.write(`[tmux-helpers] ${label} timed out (code=${err?.code}, signal=${signal})\n`);
}
