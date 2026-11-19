import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-submit-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ instances: {
  group: { runtime: 'codex', tmux_session: 'claude-group' },
} }));
const { sendToTmux, runtimeForSession, retireSubmission, isSessionEndingControl } = await import('../c4-dispatcher.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const state = (inputState, extra = {}) => ({ inputState, paneIdentity: 'pane-one', inProgressCapture: false, usageOverlay: false, ...extra });

function harness(states) {
  let i = 0;
  const calls = [];
  const options = { session: 'claude-group', pendingSubmissions: new Map(), submissionReceipts: new Map(), sleepImpl: async () => {},
    readInputStateImpl: () => states[Math.min(i++, states.length - 1)],
    // Synthetic frames carry no capture: `has_content` stands for the pasted
    // draft (own-draft identification is tested on real frames).
    ownDraftImpl: (state) => state.inputState === 'has_content' && !state.usageOverlay && state.draft !== 'other',
    execFileSyncImpl: (command, args) => { calls.push({ command, args }); return ''; } };
  return { options, calls, count: (name) => calls.filter((c) => c.args[0] === name).length,
    useStates: (next) => { states = next; i = 0; } };
}

test('target runtime is resolved independently of the root Claude config', () => {
  assert.equal(runtimeForSession('claude-group'), 'codex');
});

test('native paste preserves LF and waits through stale empty frames before one submit', async () => {
  const h = harness([state('empty'), state('empty'), state('empty'), state('has_content'), state('empty')]);
  assert.equal(await sendToTmux('first\nsecond\n', h.options), 'submitted');
  assert.equal(h.count('paste-buffer'), 1);
  const paste = h.calls.find((c) => c.args[0] === 'paste-buffer');
  assert.ok(paste.args.includes('-p'));
  assert.ok(paste.args.includes('-r'));
  assert.equal(h.count('send-keys'), 1);
});

test('stale empty frames cannot verify controls; a paste never seen is uncertain and never repeated', async () => {
  const h = harness([state('empty')]);
  assert.equal(await sendToTmux('owned message', { ...h.options, strictVerify: false }), 'uncertain');
  assert.equal(h.count('send-keys'), 0);
  assert.equal(h.count('paste-buffer'), 1);
  // PASTE-STRAND-1: the base kept the paste and sent Enter once its text
  // showed up; now the row is uncertain and nothing more is sent.
  h.useStates([state('has_content'), state('empty')]);
  assert.equal(await sendToTmux('owned message', h.options), 'uncertain');
  assert.equal(h.count('paste-buffer'), 1);
  assert.equal(h.count('send-keys'), 0);
});

test('working model receives no extra Enter or duplicate paste during observation retry', async () => {
  const h = harness([state('empty'), state('has_content'), state('has_content', { inProgressCapture: true })]);
  assert.equal(await sendToTmux('owned message', h.options), 'held');
  assert.equal(h.count('send-keys'), 1);
  h.useStates([state('has_content', { inProgressCapture: true })]);
  assert.equal(await sendToTmux('owned message', h.options), 'held');
  assert.equal(h.count('send-keys'), 1);
  assert.equal(h.count('paste-buffer'), 1);
  h.useStates([state('empty')]);
  assert.equal(await sendToTmux('owned message', h.options), 'submitted');
  assert.equal(h.count('send-keys'), 1);
});

test('unknown submission cannot inject Escape or be treated as submitted merely because controls are permissive', async () => {
  const h = harness([state('empty'), state('has_content'), state('indeterminate', { usageOverlay: true })]);
  assert.equal(await sendToTmux('owned message', { ...h.options, strictVerify: false }), 'uncertain');
  assert.equal(h.count('send-keys'), 1);
});

test('pre-existing composer text is never overwritten or submitted by a new delivery', async () => {
  const h = harness([state('has_content')]);
  assert.equal(await sendToTmux('new message', h.options), 'held', 'not attempted, no retry consumed');
  assert.equal(h.calls.length, 0);
});

test('replacement pane releases old ownership without replaying the old payload', async () => {
  const h = harness([state('empty')]);
  assert.equal(await sendToTmux('old payload', { ...h.options, deliveryId: 'control:1' }), 'uncertain');
  h.useStates([state('empty', { paneIdentity: 'pane-two' })]);
  assert.equal(await sendToTmux('old payload', { ...h.options, deliveryId: 'control:1' }), 'uncertain');
  assert.equal(h.count('paste-buffer'), 1);
  h.useStates([state('empty', { paneIdentity: 'pane-two' }), state('has_content', { paneIdentity: 'pane-two' }), state('empty', { paneIdentity: 'pane-two' })]);
  assert.equal(await sendToTmux('new payload', { ...h.options, deliveryId: 'control:2' }), 'submitted');
  assert.equal(h.count('paste-buffer'), 2);
});

test('an Enter that is not confirmed makes its row uncertain; the next delivery proceeds, the old row is never retried', async () => {
  const h = harness([state('empty'), state('has_content'), state('indeterminate')]);
  assert.equal(await sendToTmux('same text', { ...h.options, deliveryId: 'conversation:1' }), 'uncertain');
  h.useStates([state('empty'), state('empty'), state('has_content'), state('empty')]);
  assert.equal(await sendToTmux('same text', { ...h.options, deliveryId: 'conversation:2' }), 'submitted');
  assert.equal(h.count('paste-buffer'), 2);
  assert.equal(await sendToTmux('same text', { ...h.options, deliveryId: 'conversation:1' }), 'uncertain');
  assert.equal(h.count('paste-buffer'), 2);
});

test('terminal retries release confirmed empty input but never erase occupied text', async () => {
  const h = harness([state('empty')]);
  assert.equal(await sendToTmux('old', { ...h.options, deliveryId: 'control:1' }), 'uncertain');
  retireSubmission('control:1', h.options);
  h.useStates([state('has_content')]);
  assert.equal(await sendToTmux('new', { ...h.options, deliveryId: 'control:2' }), 'held');
  assert.equal(h.count('paste-buffer'), 1);
  h.useStates([state('empty'), state('empty'), state('has_content'), state('empty')]);
  assert.equal(await sendToTmux('new', { ...h.options, deliveryId: 'control:2' }), 'submitted');
  assert.equal(h.count('paste-buffer'), 2);
});

test('/exit consumed before guardian replacement is never sent into the replacement pane', async () => {
  const h = harness([state('empty'), state('has_content'), state('empty', { paneIdentity: 'replacement' })]);
  const options = { ...h.options, deliveryId: 'control:exit', runtime: 'codex' };
  assert.equal(await sendToTmux('/exit', options), 'submitted');
  assert.equal(await sendToTmux('/exit', options), 'submitted');
  assert.equal(h.count('paste-buffer'), 1);
  assert.equal(h.count('send-keys'), 1);
});

// 2026-11-17 user-sean restart (control 147021, the restart-claude skill's
// enqueue, so the content carries its ack suffix): the Claude session took
// /exit and was gone before the monitor wrote offline; the Guardian started a
// new session 4 s later. The control must end submitted, with nothing sent to
// the new session.
const EXIT_WITH_ACK = "/exit ---- ack via: '/usr/bin/node' '/home/x/zylos/.claude/skills/comm-bridge/scripts/c4-control.js' ack --id 147021";
test('Claude /exit that ended its session is a success, never retried into the new session', async () => {
  const statusFile = path.join(root, 'sean-agent-status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', health: 'ok' }));
  const gone = state('unknown', { paneIdentity: null, captureOk: false });
  const h = harness([state('empty'), state('has_content'), gone]);
  const options = { ...h.options, deliveryId: 'control:147021', runtime: 'claude', statusFile };
  assert.equal(await sendToTmux(EXIT_WITH_ACK, options), 'held', 'first try: the status file still says idle');
  h.useStates([state('empty', { paneIdentity: 'replacement' })]);
  assert.equal(await sendToTmux(EXIT_WITH_ACK, options), 'submitted');
  assert.equal(await sendToTmux(EXIT_WITH_ACK, options), 'submitted');
  assert.equal(h.count('paste-buffer'), 1);
  assert.equal(h.count('send-keys'), 1, 'no key reaches the replacement session');
});

test('Claude /exit is submitted once the monitor reports the session gone', async () => {
  const statusFile = path.join(root, 'offline-agent-status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'offline', health: 'ok' }));
  const h = harness([state('empty'), state('has_content'), state('unknown', { paneIdentity: null, captureOk: false })]);
  assert.equal(await sendToTmux('/exit', { ...h.options, deliveryId: 'control:exit-claude', runtime: 'claude', statusFile }), 'submitted');
});

test('only /exit itself, with or without its ack suffix, is a session-ending control', () => {
  assert.equal(isSessionEndingControl('/exit'), true);
  assert.equal(isSessionEndingControl(EXIT_WITH_ACK), true);
  assert.equal(isSessionEndingControl('/exit now please'), false);
  assert.equal(isSessionEndingControl('Meanwhile, /exit'), false);
  assert.equal(isSessionEndingControl('/clear ---- ack via: node c4-control.js ack --id 3'), false);
});

test('/exit without observed paste or Enter remains unsubmitted after replacement', async () => {
  const h = harness([state('empty'), state('empty', { paneIdentity: 'replacement' })]);
  const options = { ...h.options, deliveryId: 'control:exit', runtime: 'codex' };
  assert.equal(await sendToTmux('/exit', options), 'uncertain');
  assert.equal(await sendToTmux('/exit', options), 'uncertain');
  assert.equal(h.count('paste-buffer'), 1);
  assert.equal(h.count('send-keys'), 0);
});
