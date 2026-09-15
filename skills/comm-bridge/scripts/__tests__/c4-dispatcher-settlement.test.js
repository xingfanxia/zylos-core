import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-settlement-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
let now = Date.now();
const realNow = Date.now.bind(Date);
mock.method(Date, 'now', () => now);
const tmuxCalls = [];
// Exercise the real delivery/verification path without touching a live pane.
mock.method(childProcess, 'execFileSync', (command, args) => {
  assert.equal(command, 'tmux');
  tmuxCalls.push(args);
  if (args[0] === 'display-message') return '0\n';
  if (args[0] === 'capture-pane') return '❯ \n';
  return '';
});
syncBuiltinESMExports();
const dbModule = await import('../c4-db.js');
const dispatcher = await import('../c4-dispatcher.js');
const db = dbModule.getDb();
const statusDir = path.join(tmpDir, 'activity-monitor');
fs.mkdirSync(statusDir, { recursive: true });
const busy = { state: 'busy', health: 'ok', idleSeconds: 0 };
const idle = { state: 'idle', health: 'ok', idleSeconds: 3 };

function writeState(agentState) {
  const file = path.join(statusDir, 'agent-status.json');
  fs.writeFileSync(file, JSON.stringify({ ...agentState, idle_seconds: agentState.idleSeconds }));
  fs.utimesSync(file, new Date(now), new Date(now));
}
function mention(requireIdle = false) {
  return dbModule.insertConversation('in', 'slack', 'channel|type:group|msg:123', 'Please check this PR', 'pending', 3, requireIdle);
}
function conversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}
beforeEach(() => {
  db.exec('DELETE FROM conversations; DELETE FROM control_queue');
  dispatcher.claimNextSingleSessionItem(idle, Infinity); // settle any prior test
  now = realNow();
  tmuxCalls.length = 0;
});
after(() => {
  dbModule.close();
  mock.restoreAll();
  syncBuiltinESMExports();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('single-session background settlement', () => {
  it('delivers and verifies a mention while busy after startup, without redispatching the idle control', async () => {
    const active = dbModule.insertControl('Start background release', { requireIdle: true });
    writeState(idle);
    assert.equal((await dispatcher.runDispatcherTick()).result.delivered, true);
    const activeBefore = dbModule.getControlById(active.id);
    assert.equal(activeBefore.status, 'running');
    const waiting = dbModule.insertControl('Next background task');
    const incoming = mention();
    const before = conversation(incoming.id);

    now += 4999;
    writeState(busy);
    assert.equal((await dispatcher.runDispatcherTick()).result.delivered, false);
    assert.equal(conversation(incoming.id).status, 'pending');
    assert.equal(tmuxCalls.filter(args => args[0] === 'paste-buffer').length, 1);

    now += 1;
    writeState(busy);
    assert.equal((await dispatcher.runDispatcherTick()).result.delivered, true);
    const delivered = conversation(incoming.id);
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.content, before.content);
    assert.equal(delivered.endpoint_id, before.endpoint_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
    assert.deepEqual(dbModule.getControlById(active.id), activeBefore);
    assert.equal(dbModule.getControlById(waiting.id).status, 'pending');
    assert.equal(tmuxCalls.filter(args => args[0] === 'paste-buffer').length, 2);
    assert.equal(tmuxCalls.filter(args => args[0] === 'send-keys' && args.at(-1) === 'Enter').length, 2);
    assert.equal(tmuxCalls.filter(args => args[0] === 'capture-pane').length, 2);
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 1000), null);
  });

  it('keeps idle-only conversations and all later controls pending during settlement', () => {
    dispatcher.beginSingleSessionSettlement(100, now);
    const gated = mention(true);
    const waiting = dbModule.insertControl('Later control', { priority: 0, bypassState: true });
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 5000), null);
    assert.equal(conversation(gated.id).status, 'pending');
    assert.equal(dbModule.getControlById(waiting.id).status, 'pending');
  });

  for (const state of ['idle', 'offline', 'stopped']) {
    it(`ends settlement on ${state}, after preserving the startup hold`, () => {
      dispatcher.beginSingleSessionSettlement(100, now);
      const waiting = dbModule.insertControl('Later control');
      const agentState = { ...idle, state };
      assert.equal(dispatcher.claimNextSingleSessionItem(agentState, now + 4999), null);
      assert.equal(dispatcher.claimNextSingleSessionItem(agentState, now + 5000).id, waiting.id);
      // Claiming still uses the existing state/health gate before actual delivery.
    });
  }

  it('ends at the original deadline without resetting the wait when messages arrive', () => {
    dispatcher.beginSingleSessionSettlement(100, now);
    const waiting = dbModule.insertControl('Later control');
    const incoming = mention();
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 124000).id, incoming.id);
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 124999), null);
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 125000).id, waiting.id);
  });

  it('still requires sustained idle for a later idle-only control after timeout', () => {
    dispatcher.beginSingleSessionSettlement(100, now);
    const waiting = dbModule.insertControl('Idle only', { requireIdle: true });
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, now + 125000), null);
    assert.equal(dispatcher.claimNextSingleSessionItem({ ...idle, idleSeconds: 2 }, now + 125001), null);
    assert.equal(dispatcher.claimNextSingleSessionItem(idle, now + 125002).id, waiting.id);
  });

  it('does not bypass the existing unhealthy gate for an ordinary message', async () => {
    dispatcher.beginSingleSessionSettlement(100, now);
    const incoming = mention();
    now += 5000;
    writeState({ ...busy, health: 'down' });
    assert.equal((await dispatcher.runDispatcherTick()).result.delivered, false);
    assert.equal(conversation(incoming.id).status, 'pending');
    assert.equal(tmuxCalls.length, 0);
  });
});
