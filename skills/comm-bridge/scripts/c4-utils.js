import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  FILE_SIZE_THRESHOLD,
  PASTE_CHAR_THRESHOLD,
  DATA_DIR,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS
} from './c4-config.js';
import { assertOwnedEntry, assertServiceDir, recipientUser, setFinalAccess } from './c4-recipient-access.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildReplyViaSuffix(channel, endpointId) {
  if (!channel || !endpointId) return '';
  return ` ---- reply via: node ${path.join(__dirname, 'c4-send.js')} "${channel}" "${endpointId}"`;
}

export function hasLegacyReplyViaSuffix(content = '') {
  return /---- reply via: node\b.*\bc4-send\.js\b/.test(content);
}

// Fallback counter for spills without a conversation id: two spills within
// the same millisecond (e.g. a renderer looping over several long messages)
// must never resolve to the same directory and silently overwrite each other.
let spillSeq = 0;

// Strip control chars tmux paste-buffer can't carry cleanly (keeps \t and \n).
export function sanitizeMessage(message) {
  return message.replace(/[\x00-\x08\x0B-\x1F]/g, '');
}

/**
 * Write a spill: `<ATTACHMENTS_DIR>/<msgId>/message.txt`, readable by the
 * service user and `user` only (c4-recipient-access.js). The directory goes to
 * its final access first; the text goes to a fresh 0600 temp file that gets
 * the same final access and then replaces message.txt by rename. So the path
 * never exists with partial content, and a reader who already had it is
 * never revoked while it is re-rendered.
 * @returns {string} the message.txt path
 * @throws on an unsafe parent or entry, or a recipient grant that fails
 */
function writeSpill(msgId, text, user) {
  if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o750 });
  assertServiceDir(DATA_DIR);
  assertServiceDir(ATTACHMENTS_DIR);
  const messageDir = path.join(ATTACHMENTS_DIR, msgId);
  try {
    fs.mkdirSync(messageDir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  assertOwnedEntry(messageDir, 'dir');
  setFinalAccess(messageDir, true, user);
  const filePath = path.join(messageDir, 'message.txt');
  const tmpPath = path.join(messageDir, `.message.txt.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const fd = fs.openSync(tmpPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try { fs.writeFileSync(fd, text, 'utf8'); } finally { fs.closeSync(fd); }
    setFinalAccess(tmpPath, false, user);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* already renamed or gone */ }
    throw err;
  }
  return filePath;
}

// recipientInstance is the row's stored target_instance: the spill is readable
// by the service user and that instance's os_user only. An unknown instance or
// a failed grant throws, so the caller keeps the row recoverable instead of
// handing out a path nobody can open.
export function truncateForDelivery(content, replyViaSuffix = '', convId, recipientInstance = null) {
  const fullMessage = content + replyViaSuffix;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');
  // Measure what actually reaches the input box (the dispatcher sanitizes
  // before pasting), the same way Claude Code does: String length > 800.
  const pasteLength = sanitizeMessage(fullMessage).length;

  if (byteLength <= FILE_SIZE_THRESHOLD && pasteLength <= PASTE_CHAR_THRESHOLD) {
    return fullMessage;
  }

  // Prefer the conversation id: globally unique (DB primary key), directly
  // traceable back to the row, and re-rendering the same message becomes an
  // idempotent overwrite of one directory instead of piling up copies.
  const msgId = (convId !== undefined && convId !== null)
    ? `conv-${convId}`
    : `${Date.now()}-${process.pid}-${spillSeq++}`;
  const filePath = writeSpill(msgId, fullMessage, recipientUser(recipientInstance));

  const preview = content.substring(0, CONTENT_PREVIEW_CHARS);
  const ellipsis = preview.length < content.length ? '...' : '';
  const sizeKB = (byteLength / 1024).toFixed(1);
  const previewKB = (Buffer.byteLength(preview, 'utf8') / 1024).toFixed(1);
  // The notice must be an instruction, not metadata: weaker models otherwise
  // reply from the preview alone while claiming to have read everything (#748).
  return `${preview}${ellipsis}\n\n[C4] ⚠️ TRUNCATED — the text above is only a preview (${previewKB}KB of ${sizeKB}KB). Before acting or replying you MUST read the complete message file: ${filePath}${replyViaSuffix}`;
}
