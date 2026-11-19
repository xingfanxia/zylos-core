// PASTE-STRAND-1 (2026-11-19, ax-devbox): user-pan from 03:03 UTC, user-elaine
// from 04:00 and the scheduler stopped receiving messages for hours. Their
// 80x24 windows scrolled the composer past its prompt row, the reader saw no
// prompt (`indeterminate`), the dispatcher never observed its own paste
// (`paste_unobserved`), left it in the composer and failed that row and every
// later one within seconds (`composer not empty`), with nothing pending long
// enough for the 10-minute stuck rule. Each test below fails on 2189c729.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-strand-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
const stateDir = (id) => path.join(root, 'state', id);
for (const id of ['admin', 'user-pan', 'user-elaine']) fs.mkdirSync(stateDir(id), { recursive: true });
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ version: 1, instances: {
  admin: { primary: true, enabled: true, runtime: 'claude', tmux_session: 'claude-admin', state_dir: stateDir('admin') },
  'user-pan': { enabled: true, runtime: 'claude', tmux_session: 'claude-user-pan', state_dir: stateDir('user-pan') },
  'user-elaine': { enabled: true, runtime: 'claude', tmux_session: 'claude-user-elaine', state_dir: stateDir('user-elaine') },
} }));

const { sendToTmux, RETAINED_PASTE_STALE_MS, isKeystrokeControl, parseKeystrokeKey } = await import('../c4-dispatcher.js');
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
const { readTmuxInputState } = await import('../tmux-input-state.js');
const { IDLE_COMPOSER, SCROLLED_COMPOSER, snapshot } = await import('./fixtures/claude-composer.js');
const fx = await import('./fixtures/claude-dialogs.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (frame) => readTmuxInputState({ sessionName: 's', execFileSyncImpl: () => snapshot(frame) });
const RULE = '─'.repeat(80);

describe('the reader recognises a composer scrolled past its prompt row', () => {
  it('CLI 2.1.327/2.1.328 at 80x24: the scrolled composer reads has_content (cursor inside its rules)', () => {
    const state = read(SCROLLED_COMPOSER);
    assert.equal(state.modal, null);
    assert.equal(state.promptVisible, false, 'the prompt row is off screen');
    assert.equal(state.composerScrolled, true);
    assert.equal(state.inputState, 'has_content');
  });

  it('by structure, not by the label: a plain top rule, a blank first row, a transcript prompt row above', () => {
    const rows = [...SCROLLED_COMPOSER.rows];
    rows[14] = RULE;
    assert.equal(read({ rows, cursor: SCROLLED_COMPOSER.cursor }).inputState, 'has_content', 'plain top rule');
    rows[15] = '';
    assert.equal(read({ rows, cursor: SCROLLED_COMPOSER.cursor }).inputState, 'has_content', 'blank first box row');
    rows[2] = '❯ an earlier message in the transcript';
    const withTranscript = read({ rows, cursor: [2, 21] });
    assert.equal(withTranscript.composerScrolled, true);
    assert.equal(withTranscript.inputState, 'has_content', 'never empty, even at column 2');
  });

  it('the idle composer still reads empty; text the cursor is not inside, or a column-0 row in the box, is no composer', () => {
    assert.equal(read(IDLE_COMPOSER).inputState, 'empty');
    assert.equal(read({ rows: SCROLLED_COMPOSER.rows, cursor: [10, 3] }).inputState, 'indeterminate', 'cursor on the banner');
    const rows = [...SCROLLED_COMPOSER.rows];
    rows[17] = 'a transcript row at column 0';
    assert.equal(read({ rows, cursor: SCROLLED_COMPOSER.cursor }).inputState, 'indeterminate');
    const below = [...SCROLLED_COMPOSER.rows];
    below[23] = 'column-0 text below the bottom rule';
    assert.equal(read({ rows: below, cursor: SCROLLED_COMPOSER.cursor }).inputState, 'indeterminate');
  });

  it('a permission prompt stays a modal and never reads as a composer', () => {
    const rows = fx.DANGEROUS_RM_PROMPT_COUNTDOWN.split('\n');
    const state = read({ rows, cursor: [4, rows.length - 3] });
    assert.equal(state.modal?.kind, 'permission');
    assert.equal(state.composerScrolled, false);
    assert.equal(state.inputState, 'indeterminate');
  });
});

// A tmux pane the dispatcher talks to: the composer is drawn as `frames`
// gives it; a paste puts the text in, Enter submits it.
function pane({ frames = { empty: IDLE_COMPOSER, text: SCROLLED_COMPOSER }, identity = '$1:1000:%2:123' } = {}) {
  const p = { composer: '', buffer: '', pastes: [], submitted: [], enters: 0, frames, identity, readable: true };
  p.exec = (command, args) => {
    if (args[0] === 'set-buffer') p.buffer = args[args.length - 1];
    if (args[0] === 'paste-buffer') { p.composer = p.buffer; p.pastes.push(p.buffer); }
    if (args[0] === 'send-keys' && args.includes('Enter')) {
      p.enters++;
      if (p.composer) { p.submitted.push(p.composer); p.composer = ''; }
    }
    if (args[0] === 'capture-pane') {
      if (!p.composer) return snapshot(p.frames.empty, p.identity);
      return p.readable ? snapshot(p.frames.text, p.identity) : snapshot({ rows: ['', '  ▒▒ a layout nobody knows yet ▒▒'], cursor: [5, 1] }, p.identity);
    }
    return '';
  };
  return p;
}

describe('the dispatcher sees its own paste in a scrolled composer', () => {
  it('the incident frame: one paste, one Enter, submitted', async () => {
    const p = pane();
    const result = await sendToTmux('[TG DM] tester said: hello', { session: 'claude-user-pan', runtime: 'claude',
      deliveryId: 'conversation:1', execFileSyncImpl: p.exec, sleepImpl: async () => {},
      pendingSubmissions: new Map(), submissionReceipts: new Map(), recentSubmissions: new Map() });
    assert.equal(result, 'submitted');
    assert.equal(p.pastes.length, 1);
    assert.equal(p.enters, 1);
  });

  it('a scrolled composer is never read as empty by the Claude fallback parser: nothing is pasted onto it', async () => {
    // An earlier column-0 rule and a blank row above the box would make the
    // fallback read "the box" as starting on that blank row.
    const rows = [...SCROLLED_COMPOSER.rows];
    rows[10] = RULE;
    rows[15] = '';
    const p = pane({ frames: { empty: { rows, cursor: SCROLLED_COMPOSER.cursor }, text: SCROLLED_COMPOSER } });
    const result = await sendToTmux('another message', { session: 'claude-user-pan', runtime: 'claude',
      deliveryId: 'conversation:2', execFileSyncImpl: p.exec, sleepImpl: async () => {},
      pendingSubmissions: new Map(), submissionReceipts: new Map() });
    assert.equal(result, 'held');
    assert.deepEqual(p.pastes, []);
    assert.equal(p.enters, 0);
  });
});

// The multi-session pass with the real sendToTmux, one pane per persona.
function rowQueue(rows) {
  const byId = new Map(rows.map((row) => [row.id, { ...row, status: 'pending', retry_count: 0 }]));
  const q = { byId, delivered: [], acked: [], failures: [] };
  Object.assign(q, {
    claimNextItem: () => {
      const row = [...byId.values()].find((r) => r.status === 'pending');
      if (!row) return null;
      row.status = 'running';
      return { ...row };
    },
    releaseItem: (item) => { byId.get(item.id).status = 'pending'; },
    markDelivered: (id) => { byId.get(id).status = 'delivered'; q.delivered.push(id); },
    ackControl: (id) => { byId.get(id).status = 'done'; q.acked.push(id); },
    handleConversationDeliveryFailure: async (item) => { q.failures.push(item.id); byId.get(item.id).retry_count++; byId.get(item.id).status = 'pending'; },
    handleControlDeliveryFailure: async (item) => { q.failures.push(item.id); byId.get(item.id).retry_count++; byId.get(item.id).status = 'pending'; },
    notifyMessageDelivered: () => Promise.resolve(),
    open: (deliveryId) => {
      const row = byId.get(Number(deliveryId.split(':')[1]));
      return !!row && (row.status === 'pending' || row.status === 'running');
    },
  });
  return q;
}

function multi(queue, panes) {
  const submissions = new Map();
  const receipts = new Map();
  const logs = [];
  const helpers = {
    getAgentState: () => ({ state: 'idle', health: 'ok', idleSeconds: 10, healthy: true }),
    isStatusFresh: () => true,
    isBypassState: () => false,
    shouldAutoAckHeartbeat: () => false,
    waitForRequireIdleSettlement: async () => {},
    readProcState: () => ({ alive: true }),
    isAgentConfirmedActive: () => false,
    log: (line) => logs.push(line),
    sleep: async () => {},
    nowSeconds: () => 0,
    getDeliveryContent: (item) => item.content,
    markRejected: () => {},
    markControlRejected: () => {},
    getNextPendingForInstances: () => null,
    getPendingTargetInstancesNeedingWake: () => [],
    getNextPendingControlForInstances: () => null,
    isKeystrokeControl, parseKeystrokeKey,
    supersedeControl: () => true,
    ...queue,
    sendToTmux: (message, opts) => sendToTmux(message, { ...opts, runtime: 'claude', execFileSyncImpl: panes[opts.session].exec,
      sleepImpl: async () => {}, pendingSubmissions: submissions, submissionReceipts: receipts, recentSubmissions: new Map(),
      isOpenDelivery: queue.open }),
  };
  return { helpers, logs, submissions, run: () => processWithMultiSession(helpers) };
}

describe('an unverified paste is never abandoned and never fails a message', () => {
  it('a paste that is never observed holds its row (pending, no retry consumed); a second message for that persona is held, not failed; the other persona is served', async () => {
    const pan = pane();
    pan.readable = false; // a composer the reader cannot place
    const elaine = pane();
    const queue = rowQueue([
      { id: 1, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'first for pan' },
      { id: 2, type: 'conversation', channel: 'telegram', target_instance: 'user-elaine', content: 'for elaine' },
      { id: 3, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'second for pan' },
    ]);
    const m = multi(queue, { 'claude-user-pan': pan, 'claude-user-elaine': elaine });
    for (let pass = 0; pass < 4; pass++) await m.run();
    assert.deepEqual(queue.failures, [], 'nothing failed, no retry consumed');
    assert.deepEqual(queue.delivered, [2], 'the other persona is served');
    assert.equal(queue.byId.get(1).status, 'pending');
    assert.equal(queue.byId.get(3).status, 'pending');
    assert.deepEqual(pan.pastes, ['first for pan'], 'pasted once, nothing pasted over it');
    assert.equal(pan.enters, 0, 'no key into a composer the reader cannot see');
    assert.ok(m.logs.some((l) => /Held conversation id=3 for user-pan/.test(l)));
  });

  it('a later attempt resumes the retained submission (Enter, verify): no second paste, then the next message', async () => {
    const pan = pane();
    pan.readable = false;
    const queue = rowQueue([
      { id: 1, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'first for pan' },
      { id: 3, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'second for pan' },
    ]);
    const m = multi(queue, { 'claude-user-pan': pan });
    await m.run();
    await m.run();
    pan.readable = true; // e.g. the window was resized
    for (let pass = 0; pass < 3; pass++) await m.run();
    assert.deepEqual(queue.delivered, [1, 3]);
    assert.deepEqual(pan.pastes, ['first for pan', 'second for pan']);
    assert.deepEqual(pan.submitted, ['first for pan', 'second for pan']);
    assert.deepEqual(queue.failures, []);
  });

  it('a row claimed before the retained one submits the retained text first; each row is delivered once', async () => {
    const pan = pane();
    pan.readable = false;
    const queue = rowQueue([
      { id: 5, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'retained text' },
    ]);
    const m = multi(queue, { 'claude-user-pan': pan });
    await m.run();
    // A control for the same persona arrives and is claimed first from now on.
    const control = { id: 4, type: 'control', target_instance: 'user-pan', content: '/compact', status: 'pending', retry_count: 0 };
    const rows = new Map([[4, control], ...queue.byId]);
    queue.byId.clear();
    for (const [id, row] of rows) queue.byId.set(id, row);
    pan.readable = true;
    for (let pass = 0; pass < 3; pass++) await m.run();
    assert.deepEqual(pan.submitted, ['retained text', '/compact'], 'the retained text first, by the control\'s attempt');
    assert.deepEqual(pan.pastes, ['retained text', '/compact'], 'never pasted twice');
    assert.deepEqual(queue.delivered, [5]);
    assert.deepEqual(queue.acked, [4]);
    assert.deepEqual(queue.failures, []);
  });
});

describe('a stale receipt never makes a row undeliverable', () => {
  const statusFile = path.join(root, 'pan-status.json');
  const status = (idleSinceSecondsAgo) => fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', health: 'ok',
    last_check: Math.floor(Date.now() / 1000), idle_seconds: idleSinceSecondsAgo }));
  function retained(p, { age = RETAINED_PASTE_STALE_MS + 1000, observed = false } = {}) {
    const submissions = new Map([['claude-user-pan', { deliveryId: 'conversation:7', message: 'the message', paneIdentity: p.identity,
      pastedAt: Date.now() - age, observed, enterSent: false, terminal: false }]]);
    const options = { session: 'claude-user-pan', runtime: 'claude', deliveryId: 'conversation:7', statusFile,
      execFileSyncImpl: p.exec, sleepImpl: async () => {}, pendingSubmissions: submissions, submissionReceipts: new Map(),
      recentSubmissions: new Map(), isOpenDelivery: () => true };
    return options;
  }

  it('our paste left the composer, no Enter went out, the session took no prompt since: the delivery starts fresh', async () => {
    status(3600);
    const p = pane(); // composer empty: someone cleared it
    assert.equal(await sendToTmux('the message', retained(p)), 'submitted');
    assert.deepEqual(p.pastes, ['the message']);
    assert.equal(p.enters, 1);
  });

  it('too recent, or a status that cannot show nothing was submitted: held, not pasted, not failed', async () => {
    status(3600);
    const young = pane();
    assert.equal(await sendToTmux('the message', retained(young, { age: 5000 })), 'held');
    fs.rmSync(statusFile, { force: true });
    const unknown = pane();
    assert.equal(await sendToTmux('the message', retained(unknown)), 'held');
    assert.deepEqual([...young.pastes, ...unknown.pastes], []);
  });

  it('the session took a prompt since the paste (a person may have submitted it): never pasted again', async () => {
    status(1);
    const p = pane();
    const options = retained(p, { observed: true });
    assert.equal(await sendToTmux('the message', options), 'verify_failed');
    assert.equal(await sendToTmux('the message', options), 'verify_failed', 'its receipt stays');
    assert.deepEqual(p.pastes, []);
  });
});

// The no-duplicate invariant over every retained-paste state: the retained
// row's text is pasted again only when no Enter from here went out for it and
// either the pane was replaced while the text was held by a modal or seen in
// the composer (not a session-ending control), or the same pane's composer is
// verifiably empty and the session took no prompt since a paste old enough;
// a modal-deferred paste keeps its existing release on an empty composer.
// Never twice.
describe('a submitted message is never pasted twice', () => {
  const statusFile = path.join(root, 'property-status.json');
  const evidence = { no: 3600, yes: 1, unknown: null };
  const screens = [
    { name: 'empty', composer: '', replaced: false },
    { name: 'text', composer: 'someone typing', replaced: false },
    { name: 'unreadable', composer: 'x', replaced: false, readable: false },
    { name: 'empty, replaced', composer: '', replaced: true },
    { name: 'text, replaced', composer: 'someone typing', replaced: true },
  ];
  const flagSets = [];
  for (const [observed, enterSent] of [[false, false], [true, false], [true, true]]) {
    for (const modalDeferred of [false, true]) for (const terminal of [false, true]) for (const shutdown of [false, true]) {
      flagSets.push({ observed, enterSent, modalDeferred, terminal, shutdown });
    }
  }
  const allowed = (f, screen, ev, old) => {
    if (f.enterSent || f.terminal) return false;
    if (screen.replaced) return f.modalDeferred || (f.observed && !f.shutdown);
    if (screen.composer) return false;
    return f.modalDeferred || (ev === 'no' && old);
  };

  it('over all receipt states, screens, session evidence, paste ages and the delivering row', async () => {
    let cases = 0;
    for (const f of flagSets) for (const screen of screens) for (const ev of Object.keys(evidence)) for (const old of [false, true]) {
      for (const own of [true, false]) {
        cases++;
        if (evidence[ev] === null) fs.rmSync(statusFile, { force: true });
        else fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', last_check: Math.floor(Date.now() / 1000), idle_seconds: evidence[ev] }));
        const X = f.shutdown ? '/exit' : 'retained payload';
        const p = pane({ identity: screen.replaced ? '$9:2000:%9:999' : '$1:1000:%2:123' });
        p.composer = screen.composer;
        if (screen.readable === false) p.readable = false;
        const submissions = new Map([['claude-user-pan', { deliveryId: 'control:1', message: X, paneIdentity: '$1:1000:%2:123',
          pastedAt: Date.now() - (old ? RETAINED_PASTE_STALE_MS + 1000 : 1000), ...f }]]);
        const receipts = new Map(f.terminal ? [['claude-user-pan\0control:1', 'verify_failed']] : []);
        const base = { session: 'claude-user-pan', runtime: 'claude', statusFile, execFileSyncImpl: p.exec, sleepImpl: async () => {},
          pendingSubmissions: submissions, submissionReceipts: receipts, recentSubmissions: new Map(), isOpenDelivery: () => true,
          onUncertain: () => {}, readInputStateImpl: undefined };
        if (!own) await sendToTmux('other row', { ...base, deliveryId: 'control:2' });
        // The row is attempted again while it stays pending (held, deferred)
        // or is retried after a failure; a submitted row is marked delivered.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await sendToTmux(X, { ...base, deliveryId: 'control:1' }) === 'submitted') break;
        }
        const pastedX = p.pastes.filter((text) => text === X).length;
        const label = JSON.stringify({ ...f, screen: screen.name, ev, old, own });
        assert.ok(pastedX <= 1, `pasted twice: ${label}`);
        assert.ok(pastedX === 0 || allowed(f, screen, ev, old), `pasted without proof that nothing was submitted: ${label}`);
        if (allowed(f, screen, ev, old) && !screen.composer && own) assert.equal(pastedX, 1, `not delivered although free: ${label}`);
      }
    }
    assert.equal(cases, 24 * 5 * 3 * 2 * 2);
  });
});
