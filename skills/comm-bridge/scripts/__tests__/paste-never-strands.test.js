// PASTE-STRAND-1 (2026-11-19, ax-devbox): user-pan from 03:03 UTC, user-elaine
// from 04:00 and the scheduler stopped receiving messages for hours. Their
// 80x24 windows scrolled the composer past its prompt row; the reader saw no
// prompt (`indeterminate`), the dispatcher never observed its own paste, left
// it in the composer and failed that row and every later one within seconds.
//
// The rule these tests hold the dispatcher to: no way to send Enter or to
// paste that the deployed head (2189c729) lacks, except one: Enter after the
// reader has identified the dispatcher's own complete draft in the composer.
// A row is pasted at most once and gets at most one Enter; whatever cannot be
// confirmed is recorded uncertain (durably) and waits for a person. Each test
// says what the deployed head does on the same schedule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
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

const { sendToTmux, isKeystrokeControl, parseKeystrokeKey } = await import('../c4-dispatcher.js');
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
const { readTmuxInputState, ownDraftOnScreen } = await import('../tmux-input-state.js');
const fx = await import('./fixtures/claude-composer.js');
const dialogs = await import('./fixtures/claude-dialogs.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const RULE = '─'.repeat(80);
const read = (frame, runtime = 'claude') => readTmuxInputState({ sessionName: 's', execFileSyncImpl: () => fx.snapshot(frame),
  detectModals: runtime === 'claude' });

describe('the reader and the own-draft identification', () => {
  it('CLI 2.1.327/2.1.328 at 80x24: a composer scrolled past its prompt row reads has_content (never empty, never a free composer)', () => {
    const state = read(fx.SCROLLED_COMPOSER);
    assert.equal(state.modal, null);
    assert.equal(state.promptVisible, false);
    assert.equal(state.composerScrolled, true);
    assert.equal(state.inputState, 'has_content');
    // base 2189c729: inputState 'indeterminate' (what the host showed)
  });

  it('a scrolled draft cannot be identified: neither the pasted text nor a same-width off-screen edit of it is "ours"', () => {
    const state = read(fx.SCROLLED_COMPOSER);
    // The reviewer's case: change only a hidden line to different text of the
    // same display width. The visible tail and the hidden-row count are equal.
    const edited = fx.MESSAGE_781.replace('[TG DM] tester said:', '[TG DM] tester SAID:');
    assert.equal(edited.length, fx.MESSAGE_781.length);
    assert.equal(ownDraftOnScreen(state, fx.MESSAGE_781, 'claude'), false);
    assert.equal(ownDraftOnScreen(state, edited, 'claude'), false);
  });

  it('the complete draft on screen equal to the pasted text is ours (Claude 200x60, Claude two lines, Codex); anything else is not', () => {
    const cases = [
      [fx.COMPOSER_781_AT_200x60, fx.MESSAGE_781, 'claude'],
      [fx.COMPOSER_TWO_LINES, fx.MESSAGE_TWO_LINES, 'claude'],
      [fx.CODEX_781, fx.MESSAGE_781, 'codex'],
    ];
    for (const [frame, text, runtime] of cases) {
      const state = read(frame, runtime);
      assert.equal(ownDraftOnScreen(state, text, runtime), true, runtime);
      assert.equal(ownDraftOnScreen(state, `${text} and more`, runtime), false);
      assert.equal(ownDraftOnScreen(state, text.slice(0, -5), runtime), false);
    }
    // Codex marks hidden lines with `↑` and keeps its prompt row: not complete, not ours.
    assert.equal(ownDraftOnScreen(read(fx.CODEX_SCROLLED, 'codex'), fx.MESSAGE_20_LINES, 'codex'), false);
    // Codex frames are not read with Claude's scrolled-composer structure.
    assert.equal(read(fx.CODEX_SCROLLED, 'codex').composerScrolled, false);
  });

  it('a collapsed paste placeholder is accepted as the deployed head accepts a non-empty prompt row; it shows presence, not whose', () => {
    const rows = [...fx.IDLE_COMPOSER.rows];
    rows[21] = '❯ [Pasted text #1 +29 lines]';
    const state = read({ rows, cursor: [28, 21] });
    assert.equal(ownDraftOnScreen(state, 'thirty\nlines\n...', 'claude'), true);
    rows[21] = '❯ [Pasted text #1 +29 lines] and typed text';
    assert.equal(ownDraftOnScreen(read({ rows, cursor: [44, 21] }), 'thirty\nlines\n...', 'claude'), false);
  });

  it('the idle composer reads empty; a cursor outside the box or a column-0 row inside it is no composer; a permission prompt stays a modal', () => {
    assert.equal(read(fx.IDLE_COMPOSER).inputState, 'empty');
    assert.equal(read({ rows: fx.SCROLLED_COMPOSER.rows, cursor: [10, 3] }).inputState, 'indeterminate');
    const rows = [...fx.SCROLLED_COMPOSER.rows];
    rows[17] = 'a transcript row at column 0';
    assert.equal(read({ rows, cursor: fx.SCROLLED_COMPOSER.cursor }).inputState, 'indeterminate');
    const prompt = dialogs.DANGEROUS_RM_PROMPT_COUNTDOWN.split('\n');
    const state = read({ rows: prompt, cursor: [4, prompt.length - 3] });
    assert.equal(state.modal?.kind, 'permission');
    assert.equal(state.inputState, 'indeterminate');
  });
});

// A tmux pane the dispatcher talks to. The composer is drawn from its state:
// Claude rule / `❯ <draft>` / rule / footer, or Codex `› <draft>`; `screen`
// overrides what the next reads show ('operator' a different draft,
// 'blank-panel' an empty panel between two rules, 'unreadable', 'modal',
// 'scrolled' the incident frame). A paste puts the text in; Enter submits
// whatever the composer holds and records it.
const TRANSCRIPT = ['⏺ Acknowledged.', ''];
function pane({ runtime = 'claude', identity = '$1:1000:%2:123' } = {}) {
  const p = { composer: '', buffer: '', screen: null, pastes: [], enters: [], submissions: [], identity };
  const own = () => {
    if (runtime === 'codex') {
      return p.composer ? { rows: ['', `› ${p.composer}`, '', '  ? for shortcuts'], cursor: [2 + p.composer.length, 1] }
        : { rows: ['', '› Ask Codex to do anything', '', '  ? for shortcuts'], cursor: [2, 1] };
    }
    return { rows: [...TRANSCRIPT, RULE, `❯ ${p.composer}`, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
      cursor: [2 + p.composer.length, TRANSCRIPT.length + 1] };
  };
  const shown = () => {
    switch (p.screen) {
      case 'operator': { const keep = p.composer; p.composer = 'a draft the operator typed'; const f = own(); p.composer = keep; return f; }
      case 'blank-panel': return { rows: [...TRANSCRIPT, RULE, '', '', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'], cursor: [2, 3] };
      case 'unreadable': return { rows: ['', '  ▒▒ a layout nobody knows yet ▒▒'], cursor: [5, 1] };
      case 'modal': return { rows: dialogs.UNKNOWN_DIALOG_LIVE.split('\n'), cursor: [2, 2] };
      case 'scrolled': return fx.SCROLLED_COMPOSER;
      default: return own();
    }
  };
  p.exec = (command, args) => {
    if (args[0] === 'set-buffer') p.buffer = args[args.length - 1];
    if (args[0] === 'paste-buffer') { p.composer = p.buffer; p.pastes.push(p.buffer); }
    if (args[0] === 'send-keys' && args.includes('Enter')) {
      // What the Enter is sent to: the draft the screen shows.
      const target = { operator: 'a draft the operator typed', 'blank-panel': '<blank panel>', unreadable: '<unreadable>',
        modal: '<modal>', scrolled: '<scrolled draft>' }[p.screen] ?? p.composer;
      p.enters.push(target);
      if (target && (p.screen === null || p.screen === 'operator')) {
        p.submissions.push(target);
        if (p.screen === 'operator') p.screen = null; else p.composer = '';
      }
    }
    if (args[0] === 'capture-pane') return fx.snapshot(shown(), p.identity);
    return '';
  };
  return p;
}

function options(p, extra = {}) {
  return { session: 'claude-user-pan', runtime: 'claude', execFileSyncImpl: p.exec, sleepImpl: async () => {},
    pendingSubmissions: new Map(), submissionReceipts: new Map(), recentSubmissions: new Map(),
    beginDelivery: () => ({ ok: true, recorded: false }), onUncertain: () => {}, ...extra };
}

describe('the incident frames', () => {
  it('80x24: the dispatcher\'s own text in a scrolled composer gets no Enter; the row is recorded uncertain (base: indeterminate, failed after 2 retries)', async () => {
    const p = pane();
    const records = [];
    const opts = options(p, { deliveryId: 'conversation:1', onUncertain: (r) => records.push(r) });
    // after the paste the pane shows the incident frame
    const exec = opts.execFileSyncImpl;
    opts.execFileSyncImpl = (c, a) => { const out = exec(c, a); if (a[0] === 'paste-buffer') p.screen = 'scrolled'; return out; };
    assert.equal(await sendToTmux(fx.MESSAGE_781, opts), 'uncertain');
    assert.equal(p.pastes.length, 1);
    assert.deepEqual(p.enters, []);
    assert.deepEqual(records.map((r) => [r.deliveryId, r.kind]), [['conversation:1', 'paste_unverified']]);
  });

  it('200x60: the same message is on screen whole: one paste, one Enter, verified', async () => {
    const p = pane();
    let frame = fx.IDLE_COMPOSER;
    const opts = options(p, { deliveryId: 'conversation:2', readInputStateImpl: undefined });
    opts.execFileSyncImpl = (c, a) => {
      if (a[0] === 'paste-buffer') { p.pastes.push(1); frame = fx.COMPOSER_781_AT_200x60; return ''; }
      if (a[0] === 'send-keys') { p.enters.push(frame === fx.COMPOSER_781_AT_200x60 ? 'own' : 'other'); frame = fx.IDLE_COMPOSER; return ''; }
      if (a[0] === 'capture-pane') return fx.snapshot(frame);
      return '';
    };
    assert.equal(await sendToTmux(fx.MESSAGE_781, opts), 'submitted');
    assert.equal(p.pastes.length, 1);
    assert.deepEqual(p.enters, ['own']);
  });
});

describe('the reviewer\'s schedules (base 2189c729 behaviour in each name)', () => {
  it('(i) 1: an operator replaces a held draft, then a different row runs, then the held row: no key (base: no key for the other row, Enter on the operator\'s draft for the held row)', async () => {
    const p = pane();
    const opts = options(p);
    // the held row: pasted, then a modal opens before its Enter
    p.screen = null;
    const exec = p.exec;
    let reads = 0;
    opts.execFileSyncImpl = (c, a) => { if (a[0] === 'capture-pane' && ++reads === 2) p.screen = 'modal'; return exec(c, a); };
    assert.equal(await sendToTmux('the held message', { ...opts, deliveryId: 'conversation:10' }), 'modal_deferred');
    p.screen = 'operator';
    assert.equal(await sendToTmux('another message', { ...opts, deliveryId: 'conversation:11' }), 'held');
    assert.equal(await sendToTmux('the held message', { ...opts, deliveryId: 'conversation:10' }), 'uncertain');
    assert.deepEqual(p.enters, [], 'no key at all');
    assert.equal(p.pastes.length, 1);
  });

  it('(i) 2: an operator submits an old paste the dispatcher could not see: it is submitted once (base: once)', async () => {
    const p = pane();
    const opts = options(p, { deliveryId: 'conversation:20' });
    const exec = p.exec;
    opts.execFileSyncImpl = (c, a) => { const out = exec(c, a); if (a[0] === 'paste-buffer') p.screen = 'unreadable'; return out; };
    assert.equal(await sendToTmux('an old paste', opts), 'uncertain');
    // the operator presses Enter on it 70 s later; the composer is empty again
    p.screen = null;
    p.exec('tmux', ['send-keys', '-t', '%2', 'Enter']);
    for (let i = 0; i < 3; i++) assert.equal(await sendToTmux('an old paste', opts), 'uncertain');
    assert.deepEqual(p.submissions, ['an old paste']);
    assert.equal(p.pastes.length, 1);
  });

  it('(i) 3: a blank panel between two rules after a paste gets no Enter, on the Claude and the Codex path (base: no key)', async () => {
    for (const runtime of ['claude', 'codex']) {
      const p = pane({ runtime });
      const opts = options(p, { runtime, deliveryId: 'conversation:30' });
      const exec = p.exec;
      opts.execFileSyncImpl = (c, a) => { const out = exec(c, a); if (a[0] === 'paste-buffer') p.screen = 'blank-panel'; return out; };
      assert.equal(await sendToTmux('a message', opts), 'uncertain', runtime);
      assert.deepEqual(p.enters, [], runtime);
    }
  });

  it('(ii): an idle-only row held while its session is busy is never submitted by another row (base: waited)', async () => {
    const p = pane();
    const queue = rowQueue([
      { id: 40, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'idle-only message', require_idle: 1 },
      { id: 41, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'normal message' },
    ]);
    let busy = false;
    let reads = 0;
    const exec = p.exec;
    const m = multi(queue, { 'claude-user-pan': { exec: (c, a) => { if (a[0] === 'capture-pane' && ++reads === 2) p.screen = 'modal'; return exec(c, a); } } },
      { getAgentState: () => ({ state: busy ? 'busy' : 'idle', health: 'ok', idleSeconds: busy ? 0 : 10, healthy: true }) });
    await m.run(); // the idle-only row is pasted; a modal defers its Enter
    p.screen = null;
    busy = true; // the session turns busy: the idle-only row is held by its gate
    for (let pass = 0; pass < 3; pass++) await m.run();
    assert.deepEqual(p.enters, [], 'no Enter for the idle-only text while busy');
    assert.equal(queue.byId.get(41).status, 'pending', 'the normal row waits behind the retained text');
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
    releaseItem: (item) => { if (byId.get(item.id).status === 'running') byId.get(item.id).status = 'pending'; },
    markDelivered: (id) => { byId.get(id).status = 'delivered'; q.delivered.push(id); },
    ackControl: (id) => { byId.get(id).status = 'done'; q.acked.push(id); },
    handleConversationDeliveryFailure: async (item) => { q.failures.push(item.id); byId.get(item.id).retry_count++; byId.get(item.id).status = 'pending'; },
    handleControlDeliveryFailure: async (item) => { q.failures.push(item.id); byId.get(item.id).retry_count++; byId.get(item.id).status = 'pending'; },
    notifyMessageDelivered: () => Promise.resolve(),
  });
  return q;
}

function multi(queue, panes, overrides = {}) {
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
      beginDelivery: () => ({ ok: true, recorded: false }),
      onUncertain: ({ deliveryId }) => { const row = queue.byId.get(Number(deliveryId.split(':')[1])); row.status = 'uncertain'; } }),
    ...overrides,
  };
  return { helpers, logs, run: () => processWithMultiSession(helpers) };
}

describe('a composer that is not free: nothing is sent, rows wait, nothing fails', () => {
  it('an operator draft: no key, every row stays pending with no retry consumed, the other persona is served; once emptied, the rows deliver normally (base: each row failed after 2 retries)', async () => {
    const pan = pane();
    pan.screen = 'operator';
    const elaine = pane();
    const queue = rowQueue([
      { id: 1, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'first for pan' },
      { id: 2, type: 'conversation', channel: 'telegram', target_instance: 'user-elaine', content: 'for elaine' },
      { id: 3, type: 'conversation', channel: 'telegram', target_instance: 'user-pan', content: 'second for pan' },
    ]);
    const m = multi(queue, { 'claude-user-pan': pan, 'claude-user-elaine': elaine });
    for (let pass = 0; pass < 4; pass++) await m.run();
    assert.deepEqual(pan.enters, []);
    assert.deepEqual(pan.pastes, []);
    assert.deepEqual(queue.failures, []);
    assert.equal(queue.byId.get(1).status, 'pending');
    assert.equal(queue.byId.get(3).status, 'pending');
    assert.deepEqual(queue.delivered, [2]);
    // the operator clears the composer
    pan.screen = null;
    for (let pass = 0; pass < 4; pass++) await m.run();
    assert.deepEqual(queue.delivered, [2, 1, 3]);
    assert.deepEqual(pan.submissions, ['first for pan', 'second for pan']);
  });
});

// The no-duplicate invariant over receipt and screen states: Enters are
// counted with the composer each was sent to. Every Enter goes to a composer
// holding exactly one row's own pasted text, and no row's text gets a second
// Enter, whatever the retained state of the row, what the screen shows on
// each attempt, and which row is delivered.
describe('Enter only on the dispatcher\'s own complete draft, at most once per row', () => {
  const screens = [null, 'operator', 'blank-panel', 'unreadable', 'modal', 'scrolled'];
  const retained = [
    null,
    { observed: false, enterSent: false, modalDeferred: true },
    { observed: true, enterSent: false, modalDeferred: true },
    { observed: true, enterSent: true, modalDeferred: false },
    { observed: true, enterSent: true, modalDeferred: true },
  ];

  it('over retained states x screen on each of two attempts x delivering row', async () => {
    let cases = 0;
    const X = 'retained payload x';
    const Y = 'payload y';
    for (const r of retained) for (const first of screens) for (const second of screens) for (const own of [true, false]) {
      cases++;
      const p = pane();
      const submissions = new Map();
      if (r) { submissions.set('claude-user-pan', { deliveryId: 'control:1', message: X, paneIdentity: p.identity, terminal: false, shutdown: false, ...r }); p.composer = X; }
      const opts = { ...options(p), pendingSubmissions: submissions };
      // A row is attempted while it stays pending; a submitted row is marked
      // delivered and an uncertain one is out of the queue (as in production).
      const done = new Set();
      const attempt = async (text, id) => {
        if (done.has(id)) return;
        const result = await sendToTmux(text, { ...opts, deliveryId: id });
        if (result === 'submitted' || result === 'uncertain' || result === 'verify_failed') done.add(id);
      };
      for (const screen of [first, second]) {
        p.screen = screen;
        if (!own) await attempt(Y, 'control:2');
        await attempt(X, 'control:1');
      }
      const label = JSON.stringify({ r, first, second, own });
      for (const target of p.enters) assert.ok(target === X || target === Y, `Enter on a composer that was not a row's own draft: ${label} -> ${target}`);
      assert.ok(p.enters.filter((t) => t === X).length <= 1, `two Enters for X: ${label}`);
      assert.ok(p.enters.filter((t) => t === Y).length <= 1, `two Enters for Y: ${label}`);
      assert.ok(p.pastes.filter((t) => t === X).length <= (r ? 0 : 1), `X pasted again: ${label}`);
      assert.ok(p.pastes.filter((t) => t === Y).length <= 1, `Y pasted twice: ${label}`);
    }
    assert.equal(cases, retained.length * screens.length * screens.length * 2);
  });
});

// Two real dispatcher processes on one disposable C4 database and one fake
// pane (fixtures/fake-tmux-pane.mjs on PATH): the first is killed right after
// the UI accepted an Enter, before it recorded anything; the second starts as
// main() does. A row is never pasted or submitted twice, and a row cut off
// after its paste comes back uncertain, named for the alert.
describe('restart: durable state keeps every row out of replay', () => {
  const run = (dir, mode, ticks) => spawnSync(process.execPath, [path.join(here, 'fixtures/dispatcher-process.mjs'), mode, String(ticks)], {
    env: { ...process.env, ZYLOS_DIR: dir, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, FAKE_PANE_STATE: path.join(dir, 'pane.json'),
      C4_DISPATCHER_DISABLE_MAIN: '1', ZYLOS_INSTANCE_ID: '' }, encoding: 'utf8', timeout: 60_000 });
  function setup(pane = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-restart-'));
    for (const sub of ['.zylos', 'activity-monitor', 'bin']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
    fs.writeFileSync(path.join(dir, 'bin/tmux'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures/fake-tmux-pane.mjs')}" "$@"\n`, { mode: 0o755 });
    const idle = [...TRANSCRIPT, RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
    fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify({ idleRows: idle, promptY: TRANSCRIPT.length + 1,
      modalRows: dialogs.UNKNOWN_DIALOG_LIVE.split('\n'), composer: '', buffer: '', pastes: [], enters: [], submissions: [], script: {}, ...pane }));
    return dir;
  }
  const paneState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'pane.json'), 'utf8'));
  const sql = (dir, query) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.ZYLOS_DIR = ${JSON.stringify(dir)};
    const db = await import(${JSON.stringify(path.join(here, '../c4-db.js'))});
    const out = (${query})(db);
    db.close();
    process.stdout.write(JSON.stringify(out));`], { encoding: 'utf8' });
  const insert = (dir, texts) => JSON.parse(sql(dir, `(db) => ${JSON.stringify(texts)}.map((t) => db.insertConversation('in', 'telegram', null, t).id)`).stdout);
  const rows = (dir) => JSON.parse(sql(dir, `(db) => ({
    rows: db.getDb().prepare("SELECT id, status FROM conversations ORDER BY id").all(),
    uncertain: db.getUncertainDeliveries({ unnotifiedOnly: false, kinds: db.PASTE_UNCERTAIN_KINDS }).map((r) => [r.item_id, r.dialog_kind]) })`).stdout);

  for (const [name, script] of [
    ['the first Enter after a fresh paste', {}],
    ['an Enter resumed after a modal held the first one back', { 2: 'modal' }],
    ['an Enter resumed after a modal, whose first read then failed', { 2: 'modal', 3: 'unreadable' }],
  ]) {
    it(`killed right after the UI accepted ${name}, before SQLite recorded success: uncertain after the restart, never pasted or submitted again`, () => {
      const dir = setup({ kill: 'enter', script });
      const [id] = insert(dir, ['the only message']);
      const first = run(dir, 'first', 4);
      assert.equal(first.signal, 'SIGKILL', first.stderr);
      const restart = run(dir, 'restart', 4);
      assert.equal(restart.status, 0, restart.stderr);
      const pane = paneState(dir);
      assert.deepEqual(pane.pastes, ['the only message']);
      assert.deepEqual(pane.submissions, ['the only message']);
      assert.deepEqual(rows(dir), { rows: [{ id, status: 'uncertain' }], uncertain: [[id, 'interrupted']] });
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('his schedule (i) 4: a retained paste and a second row across two processes: the retained text is never submitted by code, the second row once (base: no cross-row Enter)', () => {
    // The first row's paste is never seen (an unreadable frame); the second
    // row comes while its text is in the composer.
    const dir = setup({ script: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [String(i + 2), 'unreadable'])) });
    const [x, y] = insert(dir, ['the retained text', 'the second row']);
    assert.equal(run(dir, 'first', 3).status, 0);
    assert.equal(run(dir, 'restart', 3).status, 0);
    let pane = paneState(dir);
    assert.deepEqual(pane.enters, []);
    assert.deepEqual(rows(dir).rows, [{ id: x, status: 'uncertain' }, { id: y, status: 'pending' }]);
    // a person clears the composer (and resolves the uncertain row later)
    pane.composer = '';
    fs.writeFileSync(path.join(dir, 'pane.json'), JSON.stringify(pane));
    assert.equal(run(dir, 'restart', 3).status, 0);
    pane = paneState(dir);
    assert.deepEqual(pane.submissions, ['the second row']);
    assert.deepEqual(pane.pastes, ['the retained text', 'the second row']);
    assert.deepEqual(rows(dir), { rows: [{ id: x, status: 'uncertain' }, { id: y, status: 'delivered' }], uncertain: [[x, 'paste_unverified']] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a row delivered and recorded before the restart, and one never attempted: neither is replayed; the second is delivered once', () => {
    const dir = setup();
    const [a] = insert(dir, ['delivered before']);
    assert.equal(run(dir, 'first', 2).status, 0);
    const [b] = insert(dir, ['never attempted']);
    assert.equal(run(dir, 'restart', 3).status, 0);
    const pane = paneState(dir);
    assert.deepEqual(pane.submissions, ['delivered before', 'never attempted']);
    assert.deepEqual(rows(dir), { rows: [{ id: a, status: 'delivered' }, { id: b, status: 'delivered' }], uncertain: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
