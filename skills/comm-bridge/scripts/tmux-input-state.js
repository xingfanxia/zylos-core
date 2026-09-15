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

export function findPromptY(capture) {
  const lines = String(capture || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯]/.test(lines[i])) {
      return i;
    }
  }
  return -1;
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
  execFileSyncImpl = execFileSync
} = {}) {
  if (!sessionName) {
    return {
      promptVisible: false,
      inputState: 'indeterminate',
      usageOverlay: false,
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
  const promptY = captureOk ? findPromptY(capture) : -1;
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
    inProgressCapture,
    captureOk,
    cursorX,
    cursorY,
    paneIdentity,
    capture,
  };
}
