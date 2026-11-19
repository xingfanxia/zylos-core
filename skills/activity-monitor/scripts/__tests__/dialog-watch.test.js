// Dialog watch (2026-11-18, user-pan; DELIVER-1 review decisions): a
// permission prompt nobody can answer is cancelled (Escape bound to that
// prompt, never an approving key), any dialog that holds delivery is reported,
// and delivery that does not happen is visible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDialogWatch, formatDeclinedNotice, DIALOG_WATCH_TIMING } from '../dialog-watch.js';
import { detectModal, readTmuxInputState } from '../../../comm-bridge/scripts/tmux-input-state.js';
import * as fx from '../../../comm-bridge/scripts/__tests__/fixtures/claude-dialogs.js';

const PANE = '$5:1763400000:%7:4242';
const OTHER_PANE = '$6:1763409999:%9:5151';
const SEC = 1000;
const MIN = 60 * SEC;
// The incident prompt, as the monitor's pane read classifies it.
const RM_PROMPT = detectModal(fx.DANGEROUS_RM_PROMPT_COUNTDOWN);
const UNKNOWN = detectModal(fx.UNKNOWN_DIALOG_LIVE);
const FABLE = detectModal(fx.FABLE_LIMIT_LIVE);
const T0 = Date.parse('2026-11-18T04:16:35Z');

// `statusOf(id)`: what the dispatcher has done with an Escape control by now.
// `store`: the saved state, and `queue`: the Escape rows (pane|prompt → id),
// both shared across watches to simulate a monitor restart.
function harness({ sendOk = true, keyOk = true, statusOf = () => 'done', store = { state: null }, queue = new Map(),
  t = T0, startId = 900, countFailedSince } = {}) {
  const h = {
    t, keys: [], withdrawn: [], notices: [], alerts: [], logs: [], store, queue,
    undelivered: { count: 0, oldestAt: null, conversations: 0, controls: 0 },
  };
  let nextId = startId;
  h.watch = createDialogWatch({
    instanceId: 'user-pan',
    now: () => h.t,
    enqueueKey: (key, sessionRef, dialogId) => {
      h.keys.push({ key, sessionRef, dialogId });
      if (!keyOk) return { ok: false, output: 'database is locked' };
      const id = ++nextId;
      queue.set(`${sessionRef}|${dialogId}`, id);
      return { ok: true, id };
    },
    findOwnControl: ({ sessionRef, dialogRef, kind }) => {
      const id = kind === 'escape' ? queue.get(`${sessionRef}|${dialogRef}`) : undefined;
      return id ? { id, status: statusOf(id, h) } : null;
    },
    withdrawOwnControl: ({ id, sessionRef, dialogRef, kind }) => {
      if (kind !== 'escape' || queue.get(`${sessionRef}|${dialogRef}`) !== id || statusOf(id, h) !== 'pending') return false;
      h.withdrawn.push(id);
      return true;
    },
    enqueueNotice: (text, sessionRef, dialogId) => { h.notices.push({ text, sessionRef, dialogId }); return { ok: true, id: ++nextId }; },
    readHeld: () => ({ conversations: 0, controls: 0, ...h.undelivered }),
    loadState: () => (store.state ? JSON.parse(JSON.stringify(store.state)) : null),
    saveState: (state) => { store.state = state ? JSON.parse(JSON.stringify(state)) : null; },
    notifyOperator: async (message) => { h.alerts.push(message); return { ok: typeof sendOk === 'function' ? sendOk() : sendOk }; },
    log: (line) => h.logs.push(line),
    countFailedSince: countFailedSince || (() => h.failed ?? null),
  });
  // One monitor tick per second from now up to `until` (ms after T0).
  h.run = async (until, frame) => {
    for (; h.t <= T0 + until; h.t += SEC) {
      h.watch.tick({ sessionState: 'idle', healthOk: true, sessionRef: PANE, ...frame });
      await h.watch.settled();
    }
  };
  return h;
}

describe('dialog watch: a permission prompt nobody can answer', () => {
  it('the incident prompt is positively identified, with its own advice and an id', () => {
    assert.equal(RM_PROMPT.kind, 'permission');
    assert.equal(RM_PROMPT.text, 'Bash command');
    assert.match(RM_PROMPT.notice, /rewrite it as "\$\{D:\?\}"\/\* or use a literal path/);
    assert.match(RM_PROMPT.id, /^[0-9a-f]{16}$/);
  });

  it('is cancelled after 60 s with one Escape bound to its pane and to that prompt; never any other key', async () => {
    const h = harness();
    await h.run(59 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.keys, [], 'nothing before the grace');
    await h.run(10 * MIN, { modal: RM_PROMPT });
    assert.deepEqual(h.keys, [{ key: 'Escape', sessionRef: PANE, dialogId: RM_PROMPT.id }]);
    assert.ok(h.logs.some((l) => /permission prompt "Bash command" on screen 60s; Escape queued \(control 901\)/.test(l)));
  });

  it('announces the decline once, bound to the same session, only after the Escape was sent and the prompt is gone', async () => {
    const h = harness();
    await h.run(61 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.notices, [], 'not while the prompt is still up');
    await h.run(2 * MIN, { modal: null });
    assert.deepEqual(h.withdrawn, [], 'the Escape was sent: nothing to withdraw');
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.notices[0], { text: formatDeclinedNotice({ title: 'Bash command', notice: fx.DANGEROUS_RM_NOTICE }),
      sessionRef: PANE, dialogId: RM_PROMPT.id });
    assert.match(h.notices[0].text, /"Bash command" \/ "Dangerous rm operation on possibly-empty variable path: .*use a literal path\)"/);
  });

  it('a prompt that closes by itself while its Escape is still pending: the Escape is withdrawn and nothing is said', async () => {
    const h = harness({ statusOf: () => 'pending' });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(70 * SEC, { modal: null });
    assert.deepEqual(h.withdrawn, [901]);
    assert.deepEqual(h.notices, []);
  });

  it('an Escape already claimed is waited for; announced only once it is done', async () => {
    let status = 'running';
    const h = harness({ statusOf: () => status });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(90 * SEC, { modal: null });
    assert.deepEqual(h.withdrawn, []);
    assert.deepEqual(h.notices, [], 'not while the dispatcher is still sending it');
    status = 'done';
    await h.run(95 * SEC, { modal: null });
    assert.equal(h.notices.length, 1);
  });

  it('an Escape the dispatcher superseded (its prompt was no longer on the pane) announces nothing', async () => {
    const h = harness({ statusOf: () => 'superseded' });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(70 * SEC, { modal: null });
    assert.deepEqual(h.notices, []);
  });

  it('a replaced session is never told about the old session\'s command', async () => {
    const h = harness();
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(70 * SEC, { modal: null, sessionRef: OTHER_PANE });
    assert.deepEqual(h.notices, []);
  });

  it('a different prompt on the same pane is a new prompt with its own grace and Escape', async () => {
    const h = harness();
    const other = detectModal(fx.DANGEROUS_RM_PROMPT.replaceAll('rm -f $D/*', 'rm -f $E/*'));
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(100 * SEC, { modal: other });
    assert.equal(h.keys.length, 1, 'the second prompt is 39 s old');
    await h.run(125 * SEC, { modal: other });
    assert.deepEqual(h.keys.map((k) => k.dialogId), [RM_PROMPT.id, other.id]);
  });

  it('a prompt answered within the grace gets no key and no notice', async () => {
    const h = harness();
    await h.run(5 * SEC, { modal: RM_PROMPT });
    await h.run(3 * MIN, { modal: null });
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.notices, []);
  });

  it('a failed enqueue is not repeated', async () => {
    const h = harness({ keyOk: false });
    await h.run(5 * MIN, { modal: RM_PROMPT });
    assert.equal(h.keys.length, 1);
    assert.ok(h.logs.some((l) => /Escape for permission prompt "Bash command" not queued \(database is locked\)/.test(l)));
  });

  it('an unreadable frame neither ends the prompt nor restarts its clock', async () => {
    const h = harness();
    await h.run(30 * SEC, { modal: RM_PROMPT });
    await h.run(40 * SEC, { modal: null, captureOk: false });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    assert.equal(h.keys.length, 1, '60 s after it first appeared');
  });
});

describe('dialog watch: no key to any other dialog', () => {
  it('an unknown dialog, the Fable guard\'s dialogs and the usage overlay get no key, ever', async () => {
    for (const modal of [UNKNOWN, FABLE, { kind: 'credits_offer', text: 'Claude Fable 5.2 now uses usage credits' }, { kind: 'usage_overlay', text: 'usage overlay' }]) {
      const h = harness();
      await h.run(30 * MIN, { modal });
      assert.deepEqual(h.keys, [], modal.kind);
      await h.run(31 * MIN, { modal: null });
      assert.deepEqual(h.notices, [], modal.kind);
    }
  });

  it('the benign menu printed above a composer is no dialog at all', () => {
    assert.equal(detectModal(fx.BENIGN_MENU_ABOVE_COMPOSER), null);
  });
});

describe('dialog watch: operator alert while a dialog holds delivery', () => {
  it('5 min after the dialog first held a message, once, then at most hourly; an unknown dialog\'s rows never quoted', async () => {
    const h = harness();
    const secret = { kind: 'unknown', text: 'Private Menu Heading' };
    await h.run(2 * MIN, { modal: secret });
    h.undelivered = { count: 3, oldestAt: T0 + 2 * MIN, conversations: 3 };
    await h.run(7 * MIN - 2 * SEC, { modal: secret });
    assert.deepEqual(h.alerts, [], 'not 5 min after the dialog appeared: 5 min after it first held a message');
    await h.run(7 * MIN + 30 * SEC, { modal: secret });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /^🔴 pan 的会话被对话框卡住/);
    assert.match(h.alerts[0], /对话框：unknown，已在屏幕上 7 分钟。/);
    assert.match(h.alerts[0], /等待送达：3 条（消息 3，控制 0）/);
    assert.match(h.alerts[0], /这类对话框不会自动按键/);
    await h.run(67 * MIN - 2 * SEC, { modal: secret });
    assert.equal(h.alerts.length, 1, 'no repeat within the hour');
    await h.run(68 * MIN, { modal: secret });
    assert.equal(h.alerts.length, 2, 'repeated once an hour while it lasts');
    for (const text of [...h.alerts, ...h.logs]) assert.doesNotMatch(text, /Private Menu Heading/, text);
  });

  it('a permission prompt\'s alert names its title row, never its notice', async () => {
    const h = harness();
    h.undelivered = { count: 1, oldestAt: T0, conversations: 1 };
    await h.run(6 * MIN, { modal: RM_PROMPT });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /permission「Bash command」/);
    assert.match(h.alerts[0], /已自动按过一次 Esc/);
    assert.doesNotMatch(h.alerts[0], /Dangerous|rm -f/);
  });

  it('a failed send is tried again a minute later, then stops once sent', async () => {
    let calls = 0;
    const h = harness({ sendOk: () => ++calls > 1 });
    h.undelivered = { count: 1, oldestAt: T0 };
    await h.run(9 * MIN, { modal: FABLE });
    assert.equal(h.alerts.length, 2, 'one failed send, one retry a minute later');
  });

  it('a dialog that held nothing raises no alert', async () => {
    const h = harness();
    await h.run(30 * MIN, { modal: UNKNOWN });
    assert.deepEqual(h.alerts, []);
  });
});

describe('dialog watch: stuck delivery is visible', () => {
  it('messages undelivered > 10 min while the session is idle: status not ok, one alert with count and oldest age', async () => {
    const h = harness();
    h.undelivered = { count: 13, oldestAt: T0, conversations: 13 };
    await h.run(10 * MIN, { modal: null });
    assert.equal(h.watch.deliveryStuck(), null, 'not before 10 min');
    await h.run(12 * MIN, { modal: null });
    assert.deepEqual(h.watch.deliveryStuck(), { cause: 'session_idle', pending: 13, oldest_age_seconds: Math.round((h.t - T0) / SEC) });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /^🔴 pan 有 13 条待送达（消息 13，控制 0）超过 10 分钟没有送达/);
    assert.match(h.alerts[0], /最早一条已等 10 分钟/);

    // The session goes busy and idle again over the same backlog: no new alert.
    await h.run(13 * MIN, { modal: null, sessionState: 'busy' });
    assert.equal(h.watch.deliveryStuck(), null, 'a busy session is not stuck');
    await h.run(20 * MIN, { modal: null });
    assert.equal(h.alerts.length, 1);

    h.undelivered = { count: 0, oldestAt: null };
    await h.run(21 * MIN, { modal: null });
    assert.equal(h.watch.deliveryStuck(), null);
    assert.ok(h.logs.includes('Dialog watch: waiting work cleared'));
  });

  it('a dialog holding the backlog: one alert (the dialog\'s), and the status names the dialog kind', async () => {
    const h = harness();
    h.undelivered = { count: 10, oldestAt: T0 };
    await h.run(15 * MIN, { modal: UNKNOWN });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /被对话框卡住/);
    assert.equal(h.watch.deliveryStuck().cause, 'dialog:unknown');
  });

  it('not while another health state holds delivery on purpose', async () => {
    const h = harness();
    h.undelivered = { count: 2, oldestAt: T0 };
    await h.run(20 * MIN, { modal: null, healthOk: false });
    assert.equal(h.watch.deliveryStuck(), null);
    assert.deepEqual(h.alerts, []);
  });

  it('logs carry kinds, a permission prompt\'s title, counts and ages only', async () => {
    const h = harness();
    h.undelivered = { count: 4, oldestAt: T0 };
    await h.run(20 * MIN, { modal: RM_PROMPT });
    await h.run(21 * MIN, { modal: null });
    for (const line of h.logs) assert.doesNotMatch(line, /rm -f|Dangerous|\$D/, line);
  });
});

// 2026-11-19 (PASTE-STRAND-1): an 80x24 window scrolled Claude Code's
// composer past its prompt row. The deployed reader reads that frame as
// `indeterminate`; the dispatcher pasted nothing more into it and every
// message to user-pan, user-elaine and the scheduler failed for hours, with
// nothing pending long enough for the 10-minute rule and no one told.
// The frame as CLI 2.1.327 / 2.1.328 drew it (fixture text harmless).
const RULE = '─'.repeat(80);
const FIXTURE = 'harmless fixture words harmless fixture words harmless fixture words';
const SCROLLED = [
  '', ' ▐▛███▛█   Claude Code v2.1.327', '▝▜██████▀  Opus 5.5 · API Usage Billing', ' ▝▝   ▝▝   /…/work', '',
  ...Array(8).fill(''), '                                                            ◐ medium · /effort',
  `─── ↑ 4 more ${'─'.repeat(67)}`, ...Array(6).fill(`  ${FIXTURE}`), `  ${FIXTURE} h`,
  RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const incidentFrame = readTmuxInputState({ sessionName: 's', execFileSyncImpl: () =>
  `${SCROLLED.join('\n')}\n__ZYLOS_CURSOR__ 72 21 $5 1763400000 %7 4242\n` });

describe('dialog watch: an idle composer that is not empty', () => {
  it('the incident frame, read by the deployed reader, is not empty', () => {
    assert.equal(incidentFrame.modal, null);
    assert.equal(incidentFrame.inputState, 'indeterminate');
  });

  it('the incident frame with nothing pending: delivery_stuck after a minute and one alert with what a person does', async () => {
    const h = harness();
    h.failed = 0;
    await h.run(59 * SEC, { modal: null, composer: incidentFrame.inputState });
    assert.equal(h.watch.deliveryStuck(), null, 'not within the first minute');
    assert.deepEqual(h.alerts, []);
    await h.run(90 * SEC, { modal: null, composer: incidentFrame.inputState });
    assert.deepEqual(h.watch.deliveryStuck(), { cause: 'composer:indeterminate', pending: 0, oldest_age_seconds: 0 });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /^🔴 pan 的输入框 1 分钟没有清空（画面无法识别（例如窗口太小，输入框被卷动）），会话空闲，屏幕上没有对话框/);
    assert.match(h.alerts[0], /不会往有内容的输入框里粘贴，也不会按键清空它；这期间到达的消息重试两次后标记为失败。这段时间到达、目前标记为失败的消息有 0 条/);
    assert.match(h.alerts[0], /至少 200x60/);
    assert.match(h.alerts[0], /清空输入框（按两次 Esc），不要按回车/);
    assert.match(h.alerts[0], /重新投递 2026-11-18 04:15:35 UTC 之后到达、目前标记为失败的消息/);
    await h.run(10 * MIN, { modal: null, composer: 'has_content' });
    assert.equal(h.alerts.length, 1, 'one alert per episode');
    assert.equal(h.watch.deliveryStuck().cause, 'composer:has_content');
  });

  it('the alert counts the inbound rows of that persona that failed since the episode began (from a minute earlier)', async () => {
    const asked = [];
    const h = harness({ countFailedSince: (sec) => { asked.push(sec); return 3; } });
    await h.run(61 * SEC, { modal: null, composer: 'has_content' });
    assert.match(h.alerts[0], /这段时间到达、目前标记为失败的消息有 3 条（发给 pan/);
    assert.deepEqual(asked, [Math.floor((T0 - MIN) / SEC)]);
  });

  it('a second episode alerts again, even while a backlog episode is open; an unreadable count is left out', async () => {
    const h = harness({ countFailedSince: () => { throw new Error('database is locked'); } });
    h.undelivered = { count: 1, oldestAt: T0, conversations: 1 };
    await h.run(11 * MIN, { modal: null, composer: 'empty' });
    assert.equal(h.alerts.length, 1, 'the 10-minute backlog alert');
    await h.run(13 * MIN, { modal: null, composer: 'indeterminate' });
    await h.run(13 * MIN + 2 * SEC, { modal: null, composer: 'empty' });
    await h.run(16 * MIN, { modal: null, composer: 'has_content' });
    const composerAlerts = h.alerts.filter((a) => /的输入框/.test(a));
    assert.equal(composerAlerts.length, 2, 'one per composer episode, independent of the backlog episode');
    assert.doesNotMatch(composerAlerts[0], /目前标记为失败的消息有/);
  });

  it('no alert for a dialog, a busy session, or a composer that empties within the minute', async () => {
    const dialog = harness();
    await dialog.run(3 * MIN, { modal: UNKNOWN, composer: 'indeterminate' });
    const busy = harness();
    await busy.run(5 * MIN, { modal: null, composer: 'indeterminate', sessionState: 'busy' });
    const typing = harness();
    for (let i = 0; i < 4; i++) {
      await typing.run((i * 50 + 45) * SEC, { modal: null, composer: 'has_content' });
      await typing.run((i * 50 + 50) * SEC, { modal: null, composer: 'empty' });
    }
    for (const h of [dialog, busy, typing]) assert.equal(h.watch.deliveryStuck(), null);
    assert.deepEqual([...dialog.alerts.filter((a) => /的输入框/.test(a)), ...busy.alerts, ...typing.alerts], []);
  });
});

// DELIVER-1 second review.
describe('dialog watch: a prompt that Escape does not dismiss', () => {
  it('only a queued control held behind the prompt: alert after 5 min, and the status counts it', async () => {
    const h = harness();
    h.undelivered = { count: 1, oldestAt: T0, conversations: 0, controls: 1 };
    await h.run(65 * MIN, { modal: RM_PROMPT });
    assert.equal(h.keys.length, 1, 'still one Escape');
    assert.ok(h.alerts.length >= 1);
    assert.match(h.alerts[0], /等待送达：1 条（消息 0，控制 1）/);
    assert.deepEqual(h.watch.deliveryStuck(), { cause: 'dialog:permission', pending: 1, oldest_age_seconds: Math.round((h.t - T0) / SEC) });
  });

  it('nothing queued at all: a permission prompt still up 5 min after its Escape was sent alerts', async () => {
    const h = harness();
    await h.run(6 * MIN - 2 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.alerts, [], 'Escape sent at 60 s; not yet 5 min later');
    await h.run(6 * MIN + 5 * SEC, { modal: RM_PROMPT });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /没有排队的消息，但会话在对话框关闭前无法继续工作/);
    assert.match(h.alerts[0], /已自动按过一次 Esc（5 分钟前送达），权限确认框仍在/);
    await h.run(66 * MIN - 2 * SEC, { modal: RM_PROMPT });
    assert.equal(h.alerts.length, 1, 'then at most hourly');
    await h.run(67 * MIN, { modal: RM_PROMPT });
    assert.equal(h.alerts.length, 2);
  });
});

describe('dialog watch: a monitor restart keeps one Escape per prompt and one alert per hour', () => {
  it('resumes the saved prompt state: no second Escape, no alert within the hour', async () => {
    const store = { state: null };
    const first = harness({ store });
    await first.run(10 * MIN, { modal: RM_PROMPT });
    assert.equal(first.keys.length, 1);
    assert.equal(first.alerts.length, 1, 'alerted 5 min after the Escape went out');
    assert.equal(store.state.dialog.escape, 'queued');
    assert.ok(store.state.dialog.escapeSentAt > 0);

    // The monitor restarts with the same prompt still on the same pane.
    const second = harness({ store, queue: first.queue, t: first.t + 30 * SEC, startId: 950 });
    await second.run(40 * MIN, { modal: RM_PROMPT });
    assert.deepEqual(second.keys, [], 'no second Escape for the same prompt');
    assert.deepEqual(second.alerts, [], 'no alert within the hour of the last one');
    assert.ok(second.logs.some((l) => /resumed permission dialog state/.test(l)));
    await second.run(67 * MIN, { modal: RM_PROMPT });
    assert.equal(second.alerts.length, 1, 'the hourly reminder comes on time');

    // The prompt goes: the decline is announced once and the state cleared.
    await second.run(68 * MIN, { modal: null });
    assert.equal(second.notices.length, 1);
    assert.equal(store.state, null);
  });

  it('an unknown dialog\'s saved state holds no pane text', async () => {
    const store = { state: null };
    const h = harness({ store });
    await h.run(2 * MIN, { modal: { kind: 'unknown', text: 'Private Menu Heading' } });
    assert.ok(store.state.dialog);
    assert.doesNotMatch(JSON.stringify(store.state), /Private Menu Heading/);
  });
});

describe('dialog watch timing', () => {
  it('is the designed timing', () => {
    assert.equal(DIALOG_WATCH_TIMING.permissionGraceMs, 60 * SEC);
    assert.equal(DIALOG_WATCH_TIMING.heldAlertAfterMs, 5 * MIN);
    assert.equal(DIALOG_WATCH_TIMING.alertRepeatMs, 60 * MIN);
    assert.equal(DIALOG_WATCH_TIMING.stuckAfterMs, 10 * MIN);
  });
});
