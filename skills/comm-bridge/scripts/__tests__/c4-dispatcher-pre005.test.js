// DELIVER-1: while the dialog-binding schema is missing (a pre-005 database
// whose migration is blocked), the dispatcher delivers every row as it does
// with the schema: no row can carry a dialog binding, the claim queries select
// NULL for it, and the permission-prompt rule needs no column. Real C4 DB,
// real dispatcher tick and pane reader, a fake `tmux` that records keys and
// pastes (as in c4-delivery-guard-single.test.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import * as fx from './fixtures/claude-dialogs.js';
import { makePre005Blocked, schemaFacts } from './fixtures/pre005-db.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-pre005-'));
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

const db = await import('../c4-db.js');
db.getDb();
db.close();
const file = path.join(root, 'comm-bridge', 'c4.db');
makePre005Blocked(file);
const errors = [];
const consoleError = console.error;
console.error = (...args) => { errors.push(args.join(' ')); };
const { runDispatcherTick } = await import('../c4-dispatcher.js');
after(() => { console.error = consoleError; db.close(); fs.rmSync(root, { recursive: true, force: true }); });

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
async function tick() {
  fs.writeFileSync(path.join(root, 'activity-monitor/agent-status.json'), JSON.stringify({ state: 'idle', health: 'ok', idle_seconds: 30 }));
  return (await runDispatcherTick()).result;
}
const row = (table, id) => db.getDb().prepare(`SELECT status${table === 'control_queue' ? ', last_error' : ''} FROM ${table} WHERE id = ?`).get(id);

it('on a pre-005 database with a blocked migration the dispatcher delivers a message and a key as with the schema', async () => {
  resetLog();
  idleComposer();
  const { id: message } = db.insertConversation('in', 'feishu', null, 'hello while 005 is blocked');
  assert.equal((await tick()).delivered, true);
  assert.equal(row('conversations', message).status, 'delivered');
  assert.equal(pastes().length, 1);

  resetLog();
  idleComposer();
  const { id: key } = db.insertControl('[KEYSTROKE]Tab', { priority: 0, bypassState: true, appendAckSuffix: false });
  assert.equal((await tick()).delivered, true);
  assert.equal(row('control_queue', key).status, 'done');
  assert.match(keys()[0], /Tab$/);

  assert.deepEqual(errors.filter((l) => /Migration error/.test(l)), ['[c4-db] Migration error: migration 005 blocked'], 'logged once');
  assert.deepEqual(schemaFacts(file), { dialogRef: false, tables: [], capabilities: [] });
});

it('and still gives a permission prompt nothing but Escape', async () => {
  const promptRow = fx.DANGEROUS_RM_PROMPT.split('\n').findIndex((line) => line.includes('❯ 1. Yes'));
  resetLog();
  screen(fx.DANGEROUS_RM_PROMPT, [2, promptRow]);
  const { id: enter } = db.insertControl('[KEYSTROKE]Enter', { priority: 0, bypassState: true, appendAckSuffix: false });
  assert.equal((await tick()).delivered, false);
  assert.deepEqual(row('control_queue', enter), { status: 'superseded', last_error: 'PERMISSION_PROMPT' });
  const { id: escape } = db.insertControl('[KEYSTROKE]Escape', { priority: 0, bypassState: true, appendAckSuffix: false });
  assert.equal((await tick()).delivered, true);
  assert.equal(row('control_queue', escape).status, 'done');
  assert.deepEqual(keys().map((k) => k.split(' ').at(-1)), ['Escape']);
});
