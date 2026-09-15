import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-eligibility-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const dbModule = await import('../c4-db.js');
const { claimNextItem } = await import('../c4-dispatcher.js');
const db = dbModule.getDb();
const busy = { allowRequireIdle: false };

beforeEach(() => {
  db.exec('DELETE FROM conversations; DELETE FROM control_queue');
});
after(() => {
  dbModule.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mention(content = 'Please check this PR', priority = 3, requireIdle = false) {
  return dbModule.insertConversation('in', 'slack', 'channel|type:group|msg:123', content, 'pending', priority, requireIdle);
}

describe('single-session eligibility before priority', () => {
  it('delivers a mention past an idle-gated release without touching the running release', () => {
    const active = dbModule.insertControl('Continue authorized release', { priority: 1 });
    dbModule.claimControl(active.id);
    const activeBefore = dbModule.getControlById(active.id);
    const waiting = dbModule.insertControl('Later release', { priority: 3, requireIdle: true });
    const waitingBefore = dbModule.getControlById(waiting.id);
    const incoming = mention();

    const claimed = claimNextItem(null, busy);
    assert.equal(claimed.type, 'conversation');
    assert.equal(claimed.id, incoming.id);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id = ?').get(incoming.id).status, 'running');
    assert.deepEqual(dbModule.getControlById(active.id), activeBefore);
    assert.deepEqual(dbModule.getControlById(waiting.id), waitingBefore);

    // Once eligible, the waiting release retains control priority.
    const next = claimNextItem(null, { allowRequireIdle: true });
    assert.equal(next.type, 'control');
    assert.equal(next.id, waiting.id);
    assert.deepEqual(dbModule.getControlById(active.id), activeBefore);
  });

  it('retains priority for eligible controls behind an ineligible control', () => {
    dbModule.insertControl('Wait for idle', { priority: 0, requireIdle: true });
    const eligible = dbModule.insertControl('Eligible control', { priority: 1 });
    mention('Urgent mention', 1);
    const claimed = claimNextItem(null, busy);
    assert.equal(claimed.type, 'control');
    assert.equal(claimed.id, eligible.id);
  });

  it('skips idle-gated conversations too and keeps eligible conversation priority', () => {
    const waiting = mention('Wait for idle', 1, true);
    mention('Ordinary mention', 3);
    const urgent = mention('Urgent mention', 2);
    assert.equal(claimNextItem(null, busy).id, urgent.id);
    assert.equal(db.prepare('SELECT status FROM conversations WHERE id = ?').get(waiting.id).status, 'pending');
  });

  it('does not deliver a future control or an idle-gated item while busy', () => {
    dbModule.insertControl('Future', { availableAt: Math.floor(Date.now() / 1000) + 3600 });
    const waiting = dbModule.insertControl('Idle only', { requireIdle: true, bypassState: true });
    assert.equal(claimNextItem(null, busy), null);
    assert.equal(dbModule.getControlById(waiting.id).status, 'pending');
  });

  it('preserves the default selector contract for existing callers', () => {
    const waiting = dbModule.insertControl('Idle only', { requireIdle: true });
    const incoming = mention('Idle conversation', 1, true);
    assert.equal(dbModule.getNextPending().id, incoming.id);
    assert.equal(dbModule.getNextPendingControl().id, waiting.id);
    const claimed = claimNextItem();
    assert.equal(claimed.type, 'control');
    assert.equal(claimed.id, waiting.id);
  });
});
