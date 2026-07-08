/**
 * c4-approve — REAL module imports (previously zero coverage). Exercises the
 * approval decision (checkAndHoldForApproval) and the hold+notify write path
 * (holdAndNotify) against a temp c4.db + instances.json.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-approve-'));
process.env.ZYLOS_DIR = tmpDir;
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });
const instancesFile = path.join(tmpDir, 'instances.json');
// Multi-session (>1 instance) so approval logic is active; user-betty owns a
// known chat id, so an unknown chat id is what triggers a hold.
fs.writeFileSync(instancesFile, JSON.stringify({
  version: 1,
  instances: {
    admin: { primary: true, enabled: true, tmux_session: 'claude-admin' },
    'user-betty': { primary: false, enabled: true, tmux_session: 'claude-betty', chat_ids: ['betty-chat'] },
  },
}));

const approve = await import('../c4-approve.js');
const dbMod = await import('../c4-db.js');
const db = dbMod.getDb();

after(() => {
  try { dbMod.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('checkAndHoldForApproval', () => {
  it('does not hold explicitly-targeted messages', async () => {
    assert.equal(await approve.checkAndHoldForApproval('x', 'admin', false, true), false);
  });
  it('does not hold no-reply (system/scheduler) messages', async () => {
    assert.equal(await approve.checkAndHoldForApproval('x', 'admin', true, false), false);
  });
  it('does not hold a known/routed endpoint', async () => {
    assert.equal(await approve.checkAndHoldForApproval('betty-chat', 'admin', false, false), false);
  });
  it('holds an unknown endpoint for approval', async () => {
    assert.equal(await approve.checkAndHoldForApproval('stranger-chat', 'admin', false, false), true);
  });
});

describe('holdAndNotify', () => {
  it('inserts the message as pending_approval and notifies admin', () => {
    const record = approve.holdAndNotify('feishu', 'stranger|type:p2p', 'hi there ---- reply via foo', 3, 'admin');
    const row = db.prepare('SELECT status, channel FROM conversations WHERE id=?').get(record.id);
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.channel, 'feishu');
    // Admin gets a control-queue notification mentioning the pending user.
    const note = db.prepare(
      "SELECT content FROM control_queue WHERE target_instance='admin' ORDER BY id DESC LIMIT 1"
    ).get();
    assert.ok(note && /pending approval/i.test(note.content));
    assert.ok(note.content.includes('stranger')); // chat id surfaced to admin
  });
});

describe('checkAndHoldForApproval — single-session', () => {
  it('never holds when there is no multi-session config', async () => {
    fs.rmSync(instancesFile, { force: true }); // → isMultiSession() false
    assert.equal(await approve.checkAndHoldForApproval('stranger-chat', 'admin', false, false), false);
  });
});
