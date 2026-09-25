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

// Only these informational/settings overlays may be cancelled automatically.
// Approval dialogs take precedence, even if a settings title remains visible.
export function getModalCapture(capture) {
  const text = String(capture || '');
  const tail = text.split('\n').slice(-24).join('\n');
  // A footer above the last composer belongs to transcript/history. Only a
  // modal's current footer (after its selected row) is evidence of blocked UI.
  const lines = tail.split('\n');
  const promptY = findPromptY(tail);
  const footer = lines.slice(promptY >= 0 ? promptY : 0).join('\n');
  const cancelHint = /esc(?:ape)?(?: to)? (?:cancel|close|go back|back|dismiss)/i.test(footer);
  const selection = /(?:enter to (?:select|confirm)|[↑↓].*(?:navigate|select)|use (?:the )?arrow keys|^\s*[›❯]\s*\d+\.\s*(?:Yes|No|Allow|Approve)\b)/im.test(footer);
  if (!cancelHint && !selection) return { modal: false, dismissibleOverlay: null };
  const permission = /(?:would you like to (?:run|allow|proceed)|do you (?:want to|trust)|allow (?:once|always)|approval required|permission required)/i.test(tail);
  if (permission) return { modal: true, dismissibleOverlay: null };
  if (isUsageOverlayCapture(tail)) return { modal: true, dismissibleOverlay: 'usage' };
  const hooks = /^\s*(?:[│┃]\s*)?(?:Hooks|Hooks settings|Settings:?[^\n]*\bHooks)\s*(?:[│┃])?$/im.test(tail);
  if (hooks && cancelHint) return { modal: true, dismissibleOverlay: 'hooks' };
  return { modal: true, dismissibleOverlay: null };
}

export function hasInProgressCapture(capture) {
  if (!capture) return false;
  const recentLines = String(capture)
    .split('\n')
    .slice(-12)
    .map((line) => line.trim())
    .filter(Boolean);
  return recentLines.some((line) => /esc to interrupt/i.test(line) || IN_PROGRESS_CAPTURE_PATTERNS.some((pattern) => pattern.test(line)));
}

function readCursorCoord(sessionName, format, execFileSyncImpl) {
  try {
    const out = execFileSyncImpl('tmux', ['display-message', '-p', '-t', sessionName, format], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return Number.parseInt(String(out).trim(), 10);
  } catch {
    return -1;
  }
}

function readPaneCapture(sessionName, execFileSyncImpl) {
  try {
    return execFileSyncImpl('tmux', ['capture-pane', '-p', '-t', sessionName], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
  } catch {
    return null;
  }
}

export function readTmuxInputState({
  sessionName,
  runtime,
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

  const cursorX = readCursorCoord(sessionName, '#{cursor_x}', execFileSyncImpl);
  const cursorY = readCursorCoord(sessionName, '#{cursor_y}', execFileSyncImpl);
  const capture = readPaneCapture(sessionName, execFileSyncImpl);
  const captureOk = typeof capture === 'string';
  const usageOverlay = isUsageOverlayCapture(capture);
  const { modal, dismissibleOverlay } = getModalCapture(capture);
  const inProgressCapture = captureOk ? hasInProgressCapture(capture) : false;
  const promptY = captureOk ? findPromptY(capture) : -1;
  const promptVisible = promptY >= 0 && !modal;
  const promptLine = captureOk && promptY >= 0 ? capture.split('\n')[promptY] : '';
  const promptColumn = promptLine.search(/[›❯]/);
  // Codex may indent its composer; the insertion position follows its chevron.
  const emptyThreshold = (runtime === 'codex' || promptLine.includes('›'))
    ? promptColumn + 2 : CURSOR_EMPTY_THRESHOLD;

  let inputState = 'indeterminate';
  if (cursorX >= 0 && cursorY >= 0 && promptVisible) {
    if (cursorX > emptyThreshold) {
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
    dismissibleOverlay,
    inProgressCapture,
    captureOk,
    cursorX,
    cursorY,
    capture,
  };
}
