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

// Tracks the Claude Code CLI text of the usage-credits consent dialog and its
// follow-up states, extracted from the shipped 2.1.322 binary. CLI auto-update
// can change this wording at any time. A miss is safe: the dialog still reads as
// kind 'unknown' in detectModal(), which keeps paste, Enter and raw keys
// deferred; only the quota-hold classification is lost.
export const LIMIT_DIALOG_WORDING = Object.freeze({
  fable_limit: Object.freeze([
    /You['’]ve reached your Fable limit/,
    /You['’]ve used your included Fable usage for this week/,
  ]),
  credits_offer: Object.freeze([
    /\S now uses usage credits/,
    /\S runs on usage credits/,
    /Usage credits are turned off\. Re-enable to use/,
    /You don['’]t have usage credits yet\./,
    /Yes, re-enable and continue/,
    /(?:Yes, buy|Buy) usage credits/,
    /(?:Set up|Manage) usage credits on claude\.ai/,
    /Request (?:usage credits|more) from your admin/,
    /This will send a request to your organization['’]s admins/,
    /(?:Checking|Turning on|Setting up|Opening) usage credits…/,
  ]),
});

// Permission prompts are the one modal the [KEYSTROKE] auto-approve path is
// meant to answer; recognizing them keeps that path working.
const PERMISSION_DIALOG_WORDING = [
  /Do you want to proceed\?/,
  /Do you want to allow\b/,
  /and tell Claude what to do differently/,
];

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

// Returns the rows of the live dialog (or bare select list) that owns the
// bottom of the screen, or null.
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
  if (bounded && (hasSelect || rows.some((line) => GUIDE_RE.test(line)))) return rows;
  // Without a composer on screen nothing else can own the keyboard, so a bare
  // select list at the bottom is a modal even without the pane divider.
  if (composerTop < 0 && hasSelect) return rows;
  return null;
}

function dialogText(rows) {
  return rows.map((line) => line.trim()).join(' ').replace(/\s+/g, ' ');
}

function dialogTitle(rows) {
  return rows[0].trim().replace(/^❯\s*/, '');
}

/**
 * Detect any modal (dialog or select list) that owns the keyboard.
 * @returns {null | { kind: 'fable_limit'|'credits_offer'|'permission'|'usage_overlay'|'unknown', text: string }}
 */
export function detectModal(paneText) {
  if (!paneText) return null;
  const lines = String(paneText).split('\n').map(trimRight);
  const rows = findLiveDialogRows(lines);
  if (!rows) {
    return isUsageOverlayCapture(paneText) ? { kind: 'usage_overlay', text: 'usage overlay' } : null;
  }
  const text = dialogText(rows);
  const title = dialogTitle(rows);
  for (const kind of ['fable_limit', 'credits_offer']) {
    if (LIMIT_DIALOG_WORDING[kind].some((pattern) => pattern.test(text))) return { kind, text: title };
  }
  if (PERMISSION_DIALOG_WORDING.some((pattern) => pattern.test(text))) return { kind: 'permission', text: title };
  return { kind: 'unknown', text: title };
}

/**
 * Classify a live Fable-limit / usage-credits dialog at the bottom of the
 * current pane. The same words quoted in conversation output or scrollback
 * never classify.
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
