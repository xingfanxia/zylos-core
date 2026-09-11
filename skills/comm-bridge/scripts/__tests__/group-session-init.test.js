/**
 * ZY-GRP-1 end-to-end — initC4Session for a type:'group' instance emits ONE
 * `=== GROUP <key> ===` section per chat (segmented), while a normal instance
 * still gets the flat `=== RECENT CONVERSATIONS ===` block. REAL module imports
 * against a temp c4.db; ZYLOS_DIR is pointed at a sandbox before the imports so
 * c4-config / instance-config resolve there.
 */

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Sandbox (must precede dynamic imports) ──────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-init-'));
process.env.ZYLOS_DIR = tmpDir;
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(tmpDir, 'comm-bridge'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    admin: { primary: true, type: 'dedicated', tmux_session: 'claude-main' },
    group: { type: 'group', tmux_session: 'claude-group', display_name: 'Group Chat Handler' },
  },
}));

const db = await import('../c4-db.js');
const { initC4Session } = await import('../c4-session-init.js');

// Seed delivered inbound rows targeting the group instance across two chats + a
// system row (null endpoint). insertConversation(dir, channel, endpoint, content,
// status, priority, requireIdle, deliveryAction, targetInstance).
const ins = (endpoint, content) =>
  db.insertConversation('in', endpoint ? 'feishu' : 'system', endpoint, content, 'delivered', 3, false, null, 'group');

ins('oc_A|type:group|msg:1', 'A-hello');
ins('oc_B|type:group|msg:1', 'B-hello');
ins(null, 'system notice');
ins('oc_A|type:group|msg:2', 'A-second');
ins('oc_B|type:group|msg:2', 'B-second');
ins('oc_B|type:group|msg:3', 'B-third');
// A normal-instance row so we can prove the flat path is unaffected.
db.insertConversation('in', 'telegram', '555', 'admin-msg', 'delivered', 3, false, null, 'admin');

after(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('initC4Session — group instance segmentation', () => {
  it('emits one GROUP section per chat, most-recent chat first, system last', async () => {
    const out = await initC4Session('group', { closeDb: false });

    assert.match(out, /=== GROUP oc_A ===/);
    assert.match(out, /=== GROUP oc_B ===/);
    assert.match(out, /=== GROUP \(system \/ ungrouped\) ===/);
    // No flat block for the group instance.
    assert.doesNotMatch(out, /=== RECENT CONVERSATIONS ===/);
    // oc_B (lastId 6) appears before oc_A (lastId 4); system sinks last.
    assert.ok(out.indexOf('=== GROUP oc_B ===') < out.indexOf('=== GROUP oc_A ==='));
    assert.ok(out.indexOf('=== GROUP oc_A ===') < out.indexOf('(system / ungrouped)'));
    // Each chat's own content is under its section, not blended into one list.
    assert.match(out, /A-second/);
    assert.match(out, /B-third/);
  });

  it('leaves a normal instance on the flat RECENT CONVERSATIONS path', async () => {
    const out = await initC4Session('admin', { closeDb: false });
    assert.match(out, /=== RECENT CONVERSATIONS ===/);
    assert.doesNotMatch(out, /=== GROUP /);
    assert.match(out, /admin-msg/);
  });
});
