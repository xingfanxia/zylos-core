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
