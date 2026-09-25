// Unified single-session dispatcher: shared background settlement/eligibility
// (CL SWE/auto-reviewer fix, now on every agent), and herdr's verified terminal
// delivery behind config.json `verified_terminal_delivery`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-single-session-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_TMUX_SESSION;

const dbModule = await import('../c4-db.js');
const config = await import('../c4-config.js');
const dispatcher = await import('../c4-dispatcher.js');
const db = dbModule.getDb();

const busy = { state: 'busy', health: 'ok', idleSeconds: 0 };
const idle = { state: 'idle', health: 'ok', idleSeconds: config.REQUIRE_IDLE_MIN_SECONDS };

function mention(content = 'Please check this PR', priority = 3, requireIdle = false) {
  return dbModule.insertConversation('in', 'slack', 'channel|type:group|msg:1', content, 'pending', priority, requireIdle);
}

beforeEach(() => {
  db.exec('DELETE FROM conversations; DELETE FROM control_queue');
  dispatcher.claimNextSingleSessionItem(idle, Number.MAX_SAFE_INTEGER); // clear any settlement
  db.exec('DELETE FROM conversations; DELETE FROM control_queue');
});
after(() => {
  dbModule.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('eligibility before priority (shared)', () => {
  it('lets an ordinary message past an idle-gated control while the agent is busy', () => {
    const waiting = dbModule.insertControl('Idle-only maintenance', { priority: 1, requireIdle: true });
    const incoming = mention();
    const claimed = dispatcher.claimNextSingleSessionItem(busy);
    assert.equal(claimed.type, 'conversation');
    assert.equal(claimed.id, incoming.id);
    assert.equal(dbModule.getControlById(waiting.id).status, 'pending');
  });

  it('keeps control priority once the idle gate is satisfied', () => {
    const waiting = dbModule.insertControl('Idle-only maintenance', { priority: 1, requireIdle: true });
    mention();
    const claimed = dispatcher.claimNextSingleSessionItem(idle);
    assert.equal(claimed.type, 'control');
    assert.equal(claimed.id, waiting.id);
  });

  it('keeps the default selector contract for other callers', () => {
    const waiting = dbModule.insertControl('Idle only', { requireIdle: true });
    const incoming = mention('Idle conversation', 1, true);
    assert.equal(dbModule.getNextPending().id, incoming.id);
    assert.equal(dbModule.getNextPendingControl().id, waiting.id);
  });
});

describe('background settlement after an idle-gated item (shared)', () => {
  it('holds everything briefly, then admits ordinary messages but not controls until idle', () => {
    const t0 = 1_000_000;
    dispatcher.beginSingleSessionSettlement(42, t0);
    const control = dbModule.insertControl('Next control');
    const incoming = mention();

    assert.equal(dispatcher.claimNextSingleSessionItem(busy, t0 + config.REQUIRE_IDLE_POST_SEND_HOLD_MS - 1), null);

    const first = dispatcher.claimNextSingleSessionItem(busy, t0 + config.REQUIRE_IDLE_POST_SEND_HOLD_MS);
    assert.equal(first.type, 'conversation');
    assert.equal(first.id, incoming.id);
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, t0 + config.REQUIRE_IDLE_POST_SEND_HOLD_MS + 1), null);
    assert.equal(dbModule.getControlById(control.id).status, 'pending');

    const next = dispatcher.claimNextSingleSessionItem(idle, t0 + config.REQUIRE_IDLE_POST_SEND_HOLD_MS + 2);
    assert.equal(next.type, 'control');
    assert.equal(next.id, control.id);
  });

  it('releases the settlement at the execution deadline even if the agent stays busy', () => {
    const t0 = 2_000_000;
    dispatcher.beginSingleSessionSettlement(43, t0);
    const control = dbModule.insertControl('Next control');
    const deadline = t0 + config.REQUIRE_IDLE_POST_SEND_HOLD_MS + config.REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
    assert.equal(dispatcher.claimNextSingleSessionItem(busy, deadline - 1), null);
    const claimed = dispatcher.claimNextSingleSessionItem(busy, deadline);
    assert.equal(claimed.type, 'control');
    assert.equal(claimed.id, control.id);
  });
});

describe('verified terminal delivery gate', () => {
  const empty = { captureOk: true, modal: false, inputState: 'empty' };
  const content = { ...empty, inputState: 'has_content' };
  const hooks = { captureOk: true, modal: true, inputState: 'indeterminate', dismissibleOverlay: 'hooks' };
  const approval = { ...hooks, dismissibleOverlay: null };
  const run = (states, keys) => ({ readState: () => states.shift() ?? empty, sendKey: key => keys.push(key), wait: async () => {} });
  const heartbeat = {
    item: { content: 'Heartbeat check. [phase=primary]' },
    agentState: { state: 'idle', health: 'ok', healthy: true, idleSeconds: 30 },
    procState: { alive: true },
    confirmedActive: true,
  };

  it('is off by default (no config key): upstream heartbeat shortcut ignores the terminal', () => {
    assert.equal(config.VERIFIED_TERMINAL_DELIVERY, false);
    for (const terminalState of [hooks, approval, content, { ...empty, captureOk: false }]) {
      assert.equal(dispatcher.shouldAutoAckHeartbeat({ ...heartbeat, terminalState, deliveryFailed: true }), true);
    }
  });

  it('when on, denies the heartbeat shortcut on dialogs, drafts, unreadable panes or a failed send', () => {
    for (const terminalState of [hooks, approval, content, { ...empty, captureOk: false }]) {
      assert.equal(dispatcher.shouldAutoAckHeartbeat({ ...heartbeat, terminalState, verifiedTerminal: true }), false);
    }
    assert.equal(dispatcher.shouldAutoAckHeartbeat({ ...heartbeat, terminalState: empty, deliveryFailed: true, verifiedTerminal: true }), false);
    assert.equal(dispatcher.shouldAutoAckHeartbeat({ ...heartbeat, procState: { alive: true, frozen: true }, terminalState: empty, deliveryFailed: false, verifiedTerminal: true }), false);
    assert.equal(dispatcher.shouldAutoAckHeartbeat({ ...heartbeat, terminalState: empty, deliveryFailed: false, verifiedTerminal: true }), true);
  });

  it('cancels a stuck Hooks menu and rechecks the empty prompt before paste', async () => {
    const keys = [];
    assert.equal(await dispatcher.prepareInputForPaste('bohe', run([hooks, empty], keys)), true);
    assert.deepEqual(keys, ['Escape']);
  });

  it('refuses approval dialogs, unreadable panes and existing drafts without sending keys', async () => {
    for (const state of [approval, { ...empty, captureOk: false }, content]) {
      const keys = [];
      assert.equal(await dispatcher.prepareInputForPaste('bohe', run([state], keys)), false);
      assert.deepEqual(keys, []);
    }
  });

  it('never presses Enter into an approval dialog before or after paste', async () => {
    const keys = [];
    assert.equal((await dispatcher.submitAndVerify('bohe', run([approval], keys))).verified, false);
    assert.deepEqual(keys, []);
    assert.equal((await dispatcher.submitAndVerify('bohe', run([content, approval], keys))).verified, false);
    assert.deepEqual(keys, ['Enter']);
  });
});

describe('per-instance delivery configuration (c4-config)', () => {
  const configModule = fileURLToPath(new URL('../c4-config.js', import.meta.url));
  function resolve(configJson, env = {}) {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-config-role-'));
    try {
      fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
      fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify(configJson));
      const childEnv = { ...process.env, ZYLOS_DIR: zylosDir, ...env };
      if (!('ZYLOS_TMUX_SESSION' in env)) delete childEnv.ZYLOS_TMUX_SESSION;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `const c = await import(${JSON.stringify(configModule)}); console.log(JSON.stringify({ session: c.TMUX_SESSION, verified: c.VERIFIED_TERMINAL_DELIVERY }));`,
      ], { env: childEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim());
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  }

  it('CL agents (codex, no overrides) keep codex-main and upstream delivery', () => {
    assert.deepEqual(resolve({ runtime: 'codex', heartbeat_interval: '7200' }), { session: 'codex-main', verified: false });
  });

  it('herdr Bohe keeps claude-main under Codex and opts into verified delivery', () => {
    assert.deepEqual(resolve({ runtime: 'codex', tmux_session: 'claude-main', verified_terminal_delivery: true }),
      { session: 'claude-main', verified: true });
    assert.equal(resolve({ runtime: 'codex' }, { ZYLOS_TMUX_SESSION: 'claude-main' }).session, 'claude-main');
  });
});
