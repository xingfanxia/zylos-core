// Dialog watch (2026-11-18, user-pan): a dialog nobody can answer does not stay
// in an unattended session, and delivery that does not happen is visible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDialogWatch, formatDeclinedNotice, DIALOG_WATCH_TIMING } from '../dialog-watch.js';
import { detectModal } from '../../../comm-bridge/scripts/tmux-input-state.js';
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

function harness({ sendOk = true, keyOk = true, keySent = true } = {}) {
  const h = {
    t: T0, keys: [], withdrawn: [], notices: [], alerts: [], logs: [],
    undelivered: { count: 0, oldestAt: null },
  };
  let nextId = 900;
  h.watch = createDialogWatch({
    instanceId: 'user-pan',
    now: () => h.t,
    enqueueKey: (key, sessionRef) => {
      h.keys.push({ key, sessionRef });
      return keyOk ? { ok: true, output: `OK: enqueued control ${++nextId}` } : { ok: false, output: 'database is locked' };
    },
    withdrawKey: (id) => { h.withdrawn.push(id); return !keySent; },
    enqueueNotice: (text) => { h.notices.push(text); return { ok: true, output: `OK: enqueued control ${++nextId}` }; },
    readUndelivered: () => h.undelivered,
    notifyOperator: async (message) => { h.alerts.push(message); return { ok: typeof sendOk === 'function' ? sendOk() : sendOk }; },
    log: (line) => h.logs.push(line),
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
  it('the incident prompt reads as a permission prompt with its own advice', () => {
    assert.equal(RM_PROMPT.kind, 'permission');
    assert.equal(RM_PROMPT.text, 'Bash command');
    assert.match(RM_PROMPT.notice, /rewrite it as "\$\{D:\?\}"\/\* or use a literal path/);
  });

  it('is declined with one Escape bound to its pane after 60 s; never Enter, never an option number', async () => {
    const h = harness();
    await h.run(59 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.keys, [], 'nothing before the grace');
    await h.run(10 * MIN, { modal: RM_PROMPT });
    assert.deepEqual(h.keys, [{ key: 'Escape', sessionRef: PANE }]);
    assert.ok(h.logs.some((l) => /permission dialog "Bash command" on screen 60s; Escape queued \(control 901\)/.test(l)));
  });

  it('tells the session once, after the prompt is gone, quoting only the prompt\'s own rows', async () => {
    const h = harness();
    await h.run(61 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.notices, [], 'not while the prompt is still up');
    await h.run(2 * MIN, { modal: null });
    assert.deepEqual(h.withdrawn, [901], 'the Escape was already sent: nothing to withdraw');
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0], formatDeclinedNotice({ title: 'Bash command', notice: fx.DANGEROUS_RM_NOTICE }));
    assert.match(h.notices[0], /"Bash command" \/ "Dangerous rm operation on possibly-empty variable path: .*use a literal path\)"/);
    assert.match(h.notices[0], /Rewrite the command as the prompt advised/);
  });

  it('a prompt that closes by itself before the Escape went out: the Escape is withdrawn and nothing is said', async () => {
    const h = harness({ keySent: false });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(70 * SEC, { modal: null });
    assert.deepEqual(h.withdrawn, [901]);
    assert.deepEqual(h.notices, []);
  });

  it('a replaced session is never told about the old session\'s command', async () => {
    const h = harness();
    await h.run(61 * SEC, { modal: RM_PROMPT });
    await h.run(70 * SEC, { modal: null, sessionRef: OTHER_PANE });
    assert.deepEqual(h.notices, []);
  });

  it('a prompt answered within the grace (an auto-approve elsewhere) gets no key and no notice', async () => {
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
    assert.ok(h.logs.some((l) => /Escape for permission dialog "Bash command" not queued \(database is locked\)/.test(l)));
  });

  it('an unreadable frame neither ends the prompt nor restarts its clock', async () => {
    const h = harness();
    await h.run(30 * SEC, { modal: RM_PROMPT });
    await h.run(40 * SEC, { modal: null, captureOk: false });
    await h.run(61 * SEC, { modal: RM_PROMPT });
    assert.deepEqual(h.keys, [{ key: 'Escape', sessionRef: PANE }], '60 s after it first appeared');
  });
});

describe('dialog watch: other dialogs', () => {
  it('an unknown dialog gets one Escape after 2 min and no session notice', async () => {
    const h = harness();
    await h.run(119 * SEC, { modal: UNKNOWN });
    assert.deepEqual(h.keys, []);
    await h.run(30 * MIN, { modal: UNKNOWN });
    assert.deepEqual(h.keys, [{ key: 'Escape', sessionRef: PANE }]);
    await h.run(31 * MIN, { modal: null });
    assert.deepEqual(h.notices, []);
  });

  it('the Fable guard\'s dialogs get no key from here', async () => {
    for (const modal of [FABLE, { kind: 'credits_offer', text: 'Claude Fable 5.2 now uses usage credits' }, { kind: 'usage_overlay', text: 'usage overlay' }]) {
      const h = harness();
      await h.run(30 * MIN, { modal });
      assert.deepEqual(h.keys, [], modal.kind);
    }
  });
});

describe('dialog watch: operator alert while a dialog holds delivery', () => {
  it('5 min after the dialog first held a message, once, then at most hourly; persona, kind, title, ages, no content', async () => {
    const h = harness();
    await h.run(2 * MIN, { modal: FABLE });
    h.undelivered = { count: 3, oldestAt: T0 + 2 * MIN };
    await h.run(7 * MIN - 2 * SEC, { modal: FABLE });
    assert.deepEqual(h.alerts, [], 'not 5 min after the dialog appeared: 5 min after it first held a message');
    await h.run(7 * MIN + 30 * SEC, { modal: FABLE });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /^🔴 pan 的会话被对话框卡住/);
    assert.match(h.alerts[0], /fable_limit「You've reached your Fable limit」/);
    assert.match(h.alerts[0], /等待送达：3 条/);
    assert.match(h.alerts[0], /Fable 守护处理/);
    await h.run(67 * MIN - 2 * SEC, { modal: FABLE });
    assert.equal(h.alerts.length, 1, 'no repeat within the hour');
    await h.run(68 * MIN, { modal: FABLE });
    assert.equal(h.alerts.length, 2, 'repeated once an hour while it lasts');
  });

  it('a failed send is tried again a minute later, then stops once sent', async () => {
    let calls = 0;
    const h = harness({ sendOk: () => ++calls > 1 });
    h.undelivered = { count: 1, oldestAt: T0 };
    await h.run(9 * MIN, { modal: UNKNOWN });
    assert.equal(h.alerts.length, 2, 'one failed send, one retry a minute later');
    assert.match(h.alerts[1], /已自动按过一次 Esc/);
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
    h.undelivered = { count: 13, oldestAt: T0 };
    await h.run(10 * MIN, { modal: null });
    assert.equal(h.watch.deliveryStuck(), null, 'not before 10 min');
    await h.run(12 * MIN, { modal: null });
    assert.deepEqual(h.watch.deliveryStuck(), { cause: 'session_idle', pending: 13, oldest_age_seconds: Math.round((h.t - T0) / SEC) });
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /^🔴 pan 有 13 条消息超过 10 分钟没有送达/);
    assert.match(h.alerts[0], /最早一条已等 10 分钟/);

    // The session goes busy and idle again over the same backlog: no new alert.
    await h.run(13 * MIN, { modal: null, sessionState: 'busy' });
    assert.equal(h.watch.deliveryStuck(), null, 'a busy session is not stuck');
    await h.run(20 * MIN, { modal: null });
    assert.equal(h.alerts.length, 1);

    h.undelivered = { count: 0, oldestAt: null };
    await h.run(21 * MIN, { modal: null });
    assert.equal(h.watch.deliveryStuck(), null);
    assert.ok(h.logs.includes('Dialog watch: undelivered backlog cleared'));
  });

  it('a dialog holding the backlog: one alert (the dialog\'s), and the status names the dialog', async () => {
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

  it('logs carry kinds, titles, counts and ages only', async () => {
    const h = harness();
    h.undelivered = { count: 4, oldestAt: T0 };
    await h.run(20 * MIN, { modal: RM_PROMPT });
    await h.run(21 * MIN, { modal: null });
    for (const line of h.logs) assert.doesNotMatch(line, /rm -f|Dangerous|\$D/, line);
  });
});

describe('dialog watch timing', () => {
  it('is the designed timing', () => {
    assert.equal(DIALOG_WATCH_TIMING.permissionGraceMs, 60 * SEC);
    assert.equal(DIALOG_WATCH_TIMING.otherGraceMs, 2 * MIN);
    assert.equal(DIALOG_WATCH_TIMING.heldAlertAfterMs, 5 * MIN);
    assert.equal(DIALOG_WATCH_TIMING.alertRepeatMs, 60 * MIN);
    assert.equal(DIALOG_WATCH_TIMING.stuckAfterMs, 10 * MIN);
  });
});
