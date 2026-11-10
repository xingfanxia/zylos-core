// FG-5 delivery guard, single-session dispatcher end to end: real C4 DB rows,
// the real dispatcher tick and pane reader, and a fake `tmux` on PATH that
// serves pane fixtures and records every key and paste.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as fx from './fixtures/claude-dialogs.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-guard-single-'));
const fake = path.join(root, 'fake-tmux');
fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
fs.writeFileSync(path.join(fake, 'bin', 'tmux'), `#!/bin/sh
d="$FAKE_TMUX_DIR"
[ "$1" = "-V" ] && { echo "tmux 3.4"; exit 0; }
echo "$*" >> "$d/log"
case "$*" in
  *capture-pane*) cat "$d/screen"; printf '\\n'; cat "$d/cursor"; printf '\\n' ;;
  *paste-buffer*) [ -f "$d/on-paste" ] && mv "$d/on-paste" "$d/screen" && mv "$d/on-paste-cursor" "$d/cursor" ;;
  *send-keys*Enter*) [ -f "$d/on-enter" ] && mv "$d/on-enter" "$d/screen" && mv "$d/on-enter-cursor" "$d/cursor" ;;
esac
exit 0
`, { mode: 0o755 });
process.env.FAKE_TMUX_DIR = fake;
process.env.PATH = `${path.join(fake, 'bin')}:${process.env.PATH}`;
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
fs.mkdirSync(path.join(root, 'activity-monitor'), { recursive: true });

const { runDispatcherTick } = await import('../c4-dispatcher.js');
const db = await import('../c4-db.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const promptY = fx.PLAIN_COMPOSER_PROMPT_Y;
function screen(capture, [x, y], { onPaste, onEnter } = {}) {
  fs.writeFileSync(path.join(fake, 'screen'), capture);
  fs.writeFileSync(path.join(fake, 'cursor'), fx.cursorLine(x, y));
  for (const [name, next] of [['on-paste', onPaste], ['on-enter', onEnter]]) {
    fs.rmSync(path.join(fake, name), { force: true });
    if (next) {
      fs.writeFileSync(path.join(fake, name), next[0]);
      fs.writeFileSync(path.join(fake, `${name}-cursor`), fx.cursorLine(...next[1]));
    }
  }
}
const idleComposer = () => screen(fx.PLAIN_COMPOSER, [2, promptY], {
  onPaste: [fx.COMPOSER_WITH_TEXT, [19, promptY]],
  onEnter: [fx.PLAIN_COMPOSER, [2, promptY]],
});
const log = () => { try { return fs.readFileSync(path.join(fake, 'log'), 'utf8'); } catch { return ''; } };
const resetLog = () => fs.rmSync(path.join(fake, 'log'), { force: true });
const keys = () => log().split('\n').filter((line) => line.includes('send-keys'));
const pastes = () => log().split('\n').filter((line) => line.includes('paste-buffer'));
const agentIdle = () => fs.writeFileSync(path.join(root, 'activity-monitor/agent-status.json'),
  JSON.stringify({ state: 'idle', health: 'ok', idle_seconds: 30 }));
async function tick() { agentIdle(); return (await runDispatcherTick()).result; }
const conversation = (id) => db.getDb().prepare('SELECT status, retry_count FROM conversations WHERE id = ?').get(id);
const control = (id) => db.getDb().prepare('SELECT status, retry_count FROM control_queue WHERE id = ?').get(id);

describe('single-session dispatcher delivery guard', () => {
  it('defers a queued message while the limit dialog is up, then delivers it once', async () => {
    resetLog();
    screen(fx.FABLE_LIMIT_LIVE, [2, 10]);
    const { id } = db.insertConversation('in', 'feishu', null, 'hello from feishu');
    for (let i = 0; i < 2; i++) assert.equal((await tick()).delivered, false);
    assert.deepEqual(conversation(id), { status: 'pending', retry_count: 0 });
    assert.deepEqual(pastes(), []);
    assert.deepEqual(keys(), []);

    idleComposer();
    assert.equal((await tick()).delivered, true);
    assert.deepEqual(conversation(id), { status: 'delivered', retry_count: 0 });
    assert.equal((await tick()).delivered, false, 'nothing left: no duplicate delivery');
    assert.equal(pastes().length, 1);
    assert.equal(keys().length, 1);
    assert.match(keys()[0], /Enter$/);
  });

  it('a quoted limit text above a plain composer does not block delivery', async () => {
    resetLog();
    screen(fx.QUOTED_LIMIT_TEXT, [2, fx.QUOTED_LIMIT_TEXT.split('\n').length - 3], {
      onPaste: [fx.COMPOSER_WITH_TEXT, [19, promptY]],
      onEnter: [fx.PLAIN_COMPOSER, [2, promptY]],
    });
    const { id } = db.insertConversation('in', 'feishu', null, 'second message');
    assert.equal((await tick()).delivered, true);
    assert.equal(conversation(id).status, 'delivered');
    assert.equal(pastes().length, 1);
  });

  it('withholds [KEYSTROKE] raw keys while a modal is up and sends them once it is gone', async () => {
    resetLog();
    screen(fx.CREDITS_OFFER_LIVE, [2, 10]);
    const { id } = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false });
    assert.equal((await tick()).delivered, false);
    assert.equal(control(id).status, 'pending');
    assert.equal(control(id).retry_count, 0);
    assert.deepEqual(keys(), []);

    idleComposer();
    assert.equal((await tick()).delivered, true);
    assert.equal(control(id).status, 'done');
    assert.equal(keys().length, 1);
    assert.match(keys()[0], /Escape$/);
  });

  it('still sends the auto-approve Enter to a permission prompt', async () => {
    resetLog();
    screen(fx.PERMISSION_PROMPT_LIVE, [2, 12]);
    const { id } = db.insertControl('[KEYSTROKE]Enter', { priority: 0, bypassState: true, appendAckSuffix: false });
    assert.equal((await tick()).delivered, true);
    assert.equal(control(id).status, 'done');
    assert.equal(keys().length, 1);
  });
});

// ── B: [KEYSTROKE] controls are fenced to the session they were meant for ──
// sessionRef = `${session_id}:${session_created}:${pane_id}:${pane_pid}`, the
// same pane identity the dispatcher reads with every frame.
function onPane(ref, [x, y]) {
  const [sid, created, pane, pid] = ref.split(':');
  fs.writeFileSync(path.join(fake, 'cursor'), `__ZYLOS_CURSOR__ ${x} ${y} ${sid} ${created} ${pane} ${pid}`);
}
const nowSec = () => Math.floor(Date.now() / 1000);
const fenced = (id) => db.getDb().prepare('SELECT status, last_error, session_ref FROM control_queue WHERE id = ?').get(id);

describe('single-session keystroke session fence (Astra #5)', () => {
  const OLD = '$1:1000:%2:123';
  const NEW = `$7:${nowSec() - 5}:%9:777`;

  it('a key bound to the old session is superseded, never sent into the replacement', async () => {
    resetLog();
    idleComposer();
    onPane(NEW, [2, promptY]);
    const { id } = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false, sessionRef: OLD });
    await tick();
    assert.deepEqual(keys(), []);
    assert.equal(fenced(id).status, 'superseded');
    assert.equal(fenced(id).last_error, 'SESSION_REPLACED');
  });

  it('an already-claimed key held back by a modal is not delivered to the replacement after a restart', async () => {
    resetLog();
    screen(fx.UNKNOWN_DIALOG_LIVE, [2, 10]);
    const { id } = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false });
    await tick(); // claimed in the old session, bound to it, released back to pending
    assert.deepEqual(keys(), []);
    assert.equal(fenced(id).status, 'pending');
    assert.equal(fenced(id).session_ref, OLD);

    idleComposer(); // --apply-style restart: replacement session, idle composer
    onPane(NEW, [2, promptY]);
    await tick();
    assert.deepEqual(keys(), [], 'the old session key never reaches the replacement');
    assert.equal(fenced(id).status, 'superseded');
  });

  it('an unbound key queued before the replacement session started is superseded', async () => {
    resetLog();
    idleComposer();
    onPane(`$8:${nowSec() + 60}:%10:888`, [2, promptY]);
    const { id } = db.insertControl('[KEYSTROKE]Enter', { priority: 0, bypassState: true, appendAckSuffix: false });
    await tick();
    assert.deepEqual(keys(), []);
    assert.equal(fenced(id).status, 'superseded');
    assert.equal(fenced(id).last_error, 'SESSION_PREDATES');
  });

  it('a key for the current session (bound or not) is delivered, and an unreadable pane gets no key', async () => {
    resetLog();
    idleComposer();
    onPane(NEW, [2, promptY]);
    const bound = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false, sessionRef: NEW });
    await tick();
    assert.equal(fenced(bound.id).status, 'done');
    const unbound = db.insertControl('[KEYSTROKE]Tab', { priority: 0, bypassState: true, appendAckSuffix: false });
    await tick();
    assert.equal(fenced(unbound.id).status, 'done');
    assert.equal(fenced(unbound.id).session_ref, NEW, 'bound at claim to the session it was sent to');
    assert.equal(keys().length, 2);

    fs.writeFileSync(path.join(fake, 'cursor'), 'garbage'); // capture parses as failed
    const blind = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false });
    await tick();
    assert.equal(keys().length, 2, 'no key without a successful read of the target pane');
    assert.equal(fenced(blind.id).status, 'pending');
    assert.equal(fenced(blind.id).last_error, 'KEYSTROKE_PANE_UNREADABLE');
    db.getDb().prepare("UPDATE control_queue SET status = 'failed' WHERE id = ?").run(blind.id);
  });
});

// ── E: the uncertain record, end to end through the real DB ───────────────
describe('single-session: limit dialog right after Enter (Astra (h))', () => {
  it('records the message identity as uncertain, never delivered or replayed, and exposes it', async () => {
    resetLog();
    screen(fx.PLAIN_COMPOSER, [2, promptY], {
      onPaste: [fx.COMPOSER_WITH_TEXT, [19, promptY]],
      onEnter: [fx.FABLE_LIMIT_LIVE, [2, 10]],
    });
    const { id } = db.insertConversation('in', 'feishu', 'chat-42', 'please run the report');
    assert.equal((await tick()).delivered, false);
    assert.equal(conversation(id).status, 'uncertain');
    assert.equal(keys().length, 1);

    const records = db.getUncertainDeliveries();
    assert.equal(records.length, 1);
    const [rec] = records;
    assert.deepEqual({ item_type: rec.item_type, item_id: rec.item_id, channel: rec.channel, endpoint_id: rec.endpoint_id,
      dialog_kind: rec.dialog_kind, outcome: rec.outcome, session_ref: rec.session_ref, notified_at: rec.notified_at },
    { item_type: 'conversation', item_id: Number(id), channel: 'feishu', endpoint_id: 'chat-42',
      dialog_kind: 'fable_limit', outcome: 'uncertain', session_ref: '$1:1000:%2:123', notified_at: null });
    assert.match(rec.preview, /^please run the report/);

    idleComposer();
    for (let i = 0; i < 2; i++) await tick();
    assert.equal(pastes().length, 1, 'never replayed');
    assert.equal(conversation(id).status, 'uncertain');

    assert.equal(db.markUncertainDeliveryNotified(rec.id), true);
    assert.deepEqual(db.getUncertainDeliveries(), [], 'unnotified only by default');
    assert.equal(db.getUncertainDeliveries({ unnotifiedOnly: false }).length, 1);
  });
});
