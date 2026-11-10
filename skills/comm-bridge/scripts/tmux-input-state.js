import { execFileSync } from 'node:child_process';

const CURSOR_EMPTY_THRESHOLD = 2;
const IN_PROGRESS_CAPTURE_PATTERNS = [
  /\bFetching(?:\.\.\.|…)\s*$/i,
  /\bProofing(?:\.\.\.|…)\s*$/i,
  /\bThinking(?:\.\.\.|…)\s*$/i,
  /\bSearching(?:\.\.\.|…)\s*$/i,
  /\bRunning(?:\.\.\.|…)\s*$/i,
  /\bExecuting(?:\.\.\.|…)\s*$/i,
  /\bAnaly(?:zing|sing)(?:\.\.\.|…)\s*$/i,
  /\bReading(?:\.\.\.|…)\s*$/i,
  /\bSketching(?:\.\.\.|…)\s*$/i,
  /\bCascading(?:\.\.\.|…)\s*$/i,
  /\bPlanning(?:\.\.\.|…)\s*$/i,
  /\bDrafting(?:\.\.\.|…)\s*$/i,
  /\bComposing(?:\.\.\.|…)\s*$/i,
  /\bReflecting(?:\.\.\.|…)\s*$/i,
  /\bRetrying(?:\.\.\.|…)\s*$/i,
  /\besc to interrupt\b/i,
];

// Claude Code draws its composer prompt `❯` at column 0. A select list (any
// dialog's options) draws its focused row as `❯ label` inside the dialog's
// horizontal padding, so an indented `❯` is a select row, never the composer.
function isSelectRow(line) {
  return /^\s+❯/.test(line);
}

export function findPromptY(capture) {
  const lines = String(capture || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯]/.test(lines[i]) && !isSelectRow(lines[i])) {
      return i;
    }
  }
  return -1;
}

// ── Modal / limit-dialog detection ──────────────────────────────────────
//
// Claude Code CLI 2.1.322 renders a dialog as a Pane: a blank row, a full-width
// `─` divider at column 0, then the content indented by the pane padding
// (title, body, select options with the focused one as `❯ label`), ending with
// a dim input guide such as `Esc to cancel`. While it is open the dialog owns
// the keyboard. A dialog is live only when it is the last thing on screen, or
// the last thing directly above the composer box; text quoted in conversation
// output is bounded by transcript rows at column 0, not by a divider.

const RULE_RE = /^─{10,}$/;
const GUIDE_RE = /\b(?:Esc|Enter) to (?:cancel|close|go back|exit|select|confirm|continue)\b|↑\/↓ to navigate/i;
const MAX_DIALOG_ROWS = 40;

// Dialog IDENTITY, not wording. Text such as "You've reached your Fable limit"
// can be CONTENT of any dialog: a quoted command in a permission prompt, a
// diff line, a question or option label, tool output. Only the structural
// positions below decide a dialog's kind:
//   - title: the first row after the pane divider;
//   - option set: the select rows (`❯ label` focused, the others two columns
//     further right); the limit dialog hides indexes, a permission prompt and
//     an AskUserQuestion number their options (`1. Yes`);
//   - question: the row directly above the option block.
// Tracks the Claude Code CLI 2.1.322 text, extracted from the shipped binary;
// CLI auto-update can change it. A miss is safe: the dialog still reads as kind
// 'unknown' in detectModal(), which keeps paste, Enter and raw keys deferred;
// only the quota-hold classification (or the permission auto-approve) is lost.
export const LIMIT_DIALOG_TITLES = Object.freeze({
  fable_limit: Object.freeze([/^You['’]ve reached your Fable limit$/]),
  credits_offer: Object.freeze([/^\S.* now uses usage credits$/, /^Switch to \S.*\?$/]),
});
export const LIMIT_DIALOG_OPTIONS = Object.freeze([
  /^Switch to \S.* and continue$/,
  /^Not now$/,
  /^No, keep my current model$/,
  /^Continue with \S.*$/,
  /^Yes, re-enable and continue$/,
  /^(?:Yes, buy|Buy) usage credits$/,
  /^Request (?:usage credits|more) from your admin$/,
  /^(?:Set up|Manage) usage credits on claude\.ai$/,
  /^Upgrade to \S.*$/,
]);

// Permission prompts are the one modal the [KEYSTROKE] auto-approve path is
// meant to answer: a numbered option list whose question row asks for consent,
// or whose options include the fixed "No, and tell Claude …" answer.
const PERMISSION_QUESTION_RE = /^Do you want to .+\?$/;
const PERMISSION_DECLINE_OPTION_RE = /^\d+\. No, and tell Claude what to do differently\b/;
const NUMBERED_OPTION_RE = /^\d+\.\s/;

function trimRight(line) {
  return String(line).replace(/\s+$/, '');
}

// The composer box: a rule row directly above a column-0 `❯` prompt.
function findComposerTop(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^❯/.test(lines[i]) && RULE_RE.test(lines[i - 1])) return i - 1;
  }
  return -1;
}

// Returns the live dialog (or bare select list) that owns the bottom of the
// screen as { rows, bounded } — bounded: drawn in a pane under a divider — or
// null.
function findLiveDialogRows(lines) {
  const composerTop = findComposerTop(lines);
  let bottom = composerTop >= 0 ? composerTop - 1 : lines.length - 1;
  while (bottom >= 0 && !lines[bottom]) bottom--;
  if (bottom < 0) return null;

  let top = bottom;
  let bounded = false;
  while (top >= 0 && bottom - top < MAX_DIALOG_ROWS) {
    const line = lines[top];
    if (RULE_RE.test(line)) { bounded = true; break; }
    if (line && !/^\s/.test(line)) break; // transcript row at column 0
    top--;
  }
  const rows = lines.slice(top + 1, bottom + 1).filter(Boolean);
  const hasSelect = rows.some(isSelectRow);
  if (bounded && (hasSelect || rows.some((line) => GUIDE_RE.test(line)))) return { rows, bounded };
  // Without a composer on screen nothing else can own the keyboard, so a bare
  // select list at the bottom is a modal even without the pane divider.
  if (composerTop < 0 && hasSelect) return { rows, bounded: false };
  return null;
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function dialogTitle(rows) {
  return rows[0].trim().replace(/^❯\s*/, '');
}

// The dialog's structural parts: title, the option block around the focused
// select row, and the question row directly above that block.
function dialogStructure(rows) {
  const title = dialogTitle(rows);
  const focused = rows.findIndex(isSelectRow);
  if (focused < 0) return { title, options: [], question: null };
  const optionIndent = indentOf(rows[focused]) + 2;
  const isOption = (line) => indentOf(line) === optionIndent && !GUIDE_RE.test(line);
  let first = focused;
  while (first - 1 > 0 && indentOf(rows[first - 1]) >= optionIndent) first--;
  const block = [];
  for (let i = first; i < rows.length; i++) {
    if (i !== focused && indentOf(rows[i]) < optionIndent) break;
    if (i === focused || isOption(rows[i])) block.push(rows[i].trim().replace(/^❯\s*/, ''));
  }
  const question = first > 0 && first - 1 !== 0 ? rows[first - 1].trim() : null;
  return { title, options: block, question };
}

function limitKind({ title, options }, rows) {
  const kind = Object.keys(LIMIT_DIALOG_TITLES).find((name) => LIMIT_DIALOG_TITLES[name].some((re) => re.test(title)));
  if (!kind) return null;
  if (options.length) {
    // The limit dialog hides indexes and offers its own fixed answers.
    if (options.some((label) => NUMBERED_OPTION_RE.test(label))) return null;
    if (!options.some((label) => LIMIT_DIALOG_OPTIONS.some((re) => re.test(label)))) return null;
    return kind;
  }
  // Loading / follow-up states draw no select list, only the input guide.
  return rows.some((line) => GUIDE_RE.test(line)) ? kind : null;
}

function isPermissionPrompt({ options, question }) {
  if (!options.length || !NUMBERED_OPTION_RE.test(options[0])) return false;
  return (question !== null && PERMISSION_QUESTION_RE.test(question))
    || options.some((label) => PERMISSION_DECLINE_OPTION_RE.test(label));
}

/**
 * Detect any modal (dialog or select list) that owns the keyboard.
 * @returns {null | { kind: 'fable_limit'|'credits_offer'|'permission'|'usage_overlay'|'unknown', text: string }}
 */
export function detectModal(paneText) {
  if (!paneText) return null;
  const lines = String(paneText).split('\n').map(trimRight);
  const live = findLiveDialogRows(lines);
  if (!live) {
    return isUsageOverlayCapture(paneText) ? { kind: 'usage_overlay', text: 'usage overlay' } : null;
  }
  const { rows, bounded } = live;
  const title = dialogTitle(rows);
  // A bare select list (no pane divider) has no title row: it can be neither
  // the limit dialog nor a permission prompt, both of which are panes.
  if (!bounded) return { kind: 'unknown', text: title };
  const structure = dialogStructure(rows);
  if (isPermissionPrompt(structure)) return { kind: 'permission', text: title };
  const kind = limitKind(structure, rows);
  return { kind: kind || 'unknown', text: title };
}

/**
 * Classify a live Fable-limit / usage-credits dialog at the bottom of the
 * current pane by its identity (title row + unnumbered limit option set). The
 * same words quoted in conversation output, scrollback, a command, a diff, a
 * question or tool output never classify.
 * @returns {null | { kind: 'fable_limit'|'credits_offer', text: string }}
 */
export function classifyLimitDialog(paneText) {
  const modal = detectModal(paneText);
  return modal && (modal.kind === 'fable_limit' || modal.kind === 'credits_offer')
    ? { kind: modal.kind, text: modal.text }
    : null;
}

export function isUsageOverlayCapture(capture) {
  if (!capture) return false;
  const hasUsageHeader = /Settings:\s+Status\s+Config\s+Usage/i.test(capture);
  const hasEscHint = /Esc to cancel/i.test(capture);
  return hasUsageHeader && hasEscHint;
}

export function hasInProgressCapture(capture) {
  if (!capture) return false;
  const recentLines = String(capture)
    .split('\n')
    .slice(-12)
    .map((line) => line.trim())
    .filter(Boolean);
  return recentLines.some((line) => IN_PROGRESS_CAPTURE_PATTERNS.some((pattern) => pattern.test(line)));
}

/**
 * The session reference (`sessionRef`) of the pane a tmux target resolves to:
 * `${session_id}:${session_created}:${pane_id}:${pane_pid}`, e.g.
 * `$3:1762790000:%12:48211` — identical to readTmuxInputState().paneIdentity.
 * A Guardian/Fable-guard relaunch kills the tmux session and creates a new one,
 * so every relaunch gets a new sessionRef. Bind [KEYSTROKE] controls with it
 * (insertControl({ sessionRef }), `c4-control.js enqueue --session-ref`) and
 * fence a replaced session with c4-db supersedeControlsForSession().
 * @returns {string|null} null when tmux cannot resolve the target
 */
export function readSessionRef(sessionName, { execFileSyncImpl = execFileSync } = {}) {
  if (!sessionName) return null;
  try {
    const out = String(execFileSyncImpl('tmux', ['display-message', '-p', '-t', sessionName,
      '#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 })).trim();
    return /^\$\d+:\d+:%\d+:\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

function readPaneSnapshot(sessionName, execFileSyncImpl) {
  try {
    // One tmux command queue captures matching geometry and text. Separate
    // subprocesses can sample opposite sides of a TUI render.
    const out = execFileSyncImpl('tmux', ['capture-pane', '-p', '-t', sessionName,
      ';', 'display-message', '-p', '-t', sessionName,
      '__ZYLOS_CURSOR__ #{cursor_x} #{cursor_y} #{session_id} #{session_created} #{pane_id} #{pane_pid}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    const match = String(out).match(/\n__ZYLOS_CURSOR__ (\d+) (\d+) (\S+) (\d+) (\S+) (\d+)\s*$/);
    if (!match) return { capture: null, cursorX: -1, cursorY: -1 };
    return { capture: String(out).slice(0, match.index), cursorX: Number(match[1]), cursorY: Number(match[2]),
      paneIdentity: match.slice(3, 7).join(':') };
  } catch {
    return { capture: null, cursorX: -1, cursorY: -1 };
  }
}

export function readTmuxInputState({
  sessionName,
  execFileSyncImpl = execFileSync,
  // Modal detection reads Claude Code's TUI; other runtimes opt out.
  detectModals = true
} = {}) {
  if (!sessionName) {
    return {
      promptVisible: false,
      inputState: 'indeterminate',
      usageOverlay: false,
      modal: null,
      captureOk: false,
      cursorX: -1,
      cursorY: -1,
      capture: null
    };
  }

  const { cursorX, cursorY, capture, paneIdentity = null } = readPaneSnapshot(sessionName, execFileSyncImpl);
  const captureOk = typeof capture === 'string';
  const usageOverlay = isUsageOverlayCapture(capture);
  const inProgressCapture = captureOk ? hasInProgressCapture(capture) : false;
  const modal = captureOk && detectModals ? detectModal(capture) : null;
  // While a modal owns the keyboard no composer is usable, even if a prompt
  // row (a transcript message or a hidden-behind composer) is on screen.
  const promptY = captureOk && !modal ? findPromptY(capture) : -1;
  const promptVisible = promptY >= 0;

  let inputState = 'indeterminate';
  if (cursorX >= 0 && cursorY >= 0 && promptVisible) {
    if (cursorX > CURSOR_EMPTY_THRESHOLD) {
      inputState = 'has_content';
    } else {
      inputState = cursorY === promptY ? 'empty' : 'has_content';
    }
  }

  return {
    promptVisible,
    inputState,
    usageOverlay,
    modal,
    inProgressCapture,
    captureOk,
    cursorX,
    cursorY,
    paneIdentity,
    capture,
  };
}
