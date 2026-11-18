/**
 * Shared tmux helper functions for runtime adapters.
 *
 * All child-process calls use execFileSync (no shell) with finite timeouts
 * to prevent event-loop hangs when the tmux server is unresponsive.
 */

import { execFileSync } from 'node:child_process';
import { sendTmuxKeys } from '../tmux-send-keys.js';
import { buildProcessTree, hasDescendantProcess } from './process-tree.js';

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

const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish']);
const shellName = (name) => String(name || '').replace(/^-/, '').split('/').pop();

/**
 * Positive evidence that a session's pane sits at an idle shell prompt, the
 * only state in which typing a command line and Enter into it is safe. All of:
 * the pane is alive, tmux reports a shell as its foreground command, the pane
 * process is that shell, and the shell has no child process at all. Anything
 * else (Claude or another program running, a dialog, a launcher, an unreadable
 * pane) is not a prompt, and the caller must type nothing.
 * @param {string} session
 * @returns {{ ok: boolean, reason: string }}
 */
export function tmuxPaneAtShellPrompt(session, { execFileSyncImpl = execFileSync, buildTree = buildProcessTree } = {}) {
  let out;
  try {
    out = String(execFileSyncImpl('tmux', ['display-message', '-p', '-t', session, '#{pane_dead} #{pane_pid} #{pane_current_command}'], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch {
    return { ok: false, reason: 'pane unreadable' };
  }
  const m = /^(\d+) (\d+) (\S+)$/.exec(out);
  if (!m) return { ok: false, reason: 'pane unreadable' };
  if (m[1] !== '0') return { ok: false, reason: 'pane is dead' };
  const pid = Number(m[2]);
  if (!SHELL_NAMES.has(shellName(m[3]))) return { ok: false, reason: `foreground is ${shellName(m[3]).slice(0, 32)}, not a shell` };
  const tree = buildTree();
  const own = tree.infoOf.get(pid);
  if (!own || !SHELL_NAMES.has(shellName(own.comm))) return { ok: false, reason: 'pane process is not a shell' };
  if ((tree.childrenOf.get(pid) || []).length > 0) return { ok: false, reason: 'shell is running a command' };
  return { ok: true, reason: 'shell prompt' };
}

/**
 * The retained-session launch of every runtime adapter (Claude, Codex) calls
 * this right before it types a command line and Enter into an existing pane:
 * it throws unless tmuxPaneAtShellPrompt() positively finds an idle shell
 * prompt, so nothing is typed into a running runtime, its composer or a
 * permission prompt (DELIVER-1, 2026-11-18). The thrown launch failure goes
 * to the guardian's failed-start handling (retry once, then hold and alert).
 */
export function requirePaneAtShellPrompt(session, deps) {
  const prompt = tmuxPaneAtShellPrompt(session, deps);
  if (!prompt.ok) throw new Error(`existing tmux session ${session} is not at a shell prompt (${prompt.reason}); nothing typed`);
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
