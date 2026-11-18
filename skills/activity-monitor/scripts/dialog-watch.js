/**
 * Dialog watch: in an unattended persona session a permission prompt nobody
 * can answer does not stay, any dialog that holds the session is reported, and
 * delivery that does not happen is visible.
 *
 * 2026-11-18, user-pan: Claude Code 2.1.326 asked "Do you want to proceed?"
 * about the session's own `rm -f $D/*` ("Dangerous rm operation on possibly-
 * empty variable path"), even with --dangerously-skip-permissions. Nobody is at
 * that keyboard; the dialog stayed 4 h 48 min, every message for Pan was held,
 * agent-status.json said ok/idle, and no one was told.
 *
 * The monitor ticks this with the pane read it already makes every second
 * (readTmuxInputState: modal, paneIdentity), so it costs no extra tmux call.
 *   - a positively identified permission prompt (detectModal kind
 *     'permission', with its id) on screen for 60 s: one Escape, the cancel
 *     key the prompt names, queued as a plain `[KEYSTROKE]Escape` bound out of
 *     band to the pane (session_ref) and to the prompt (dialog_ref). The
 *     dispatcher sends it only while that very prompt is still on that pane,
 *     and sends no other key to a permission prompt.
 *   - the decline is announced to the session once, and only when it is
 *     certain: the Escape control is `done` and the prompt is gone. The message
 *     quotes the prompt's title and notice rows (Claude Code's own text) and is
 *     bound the same way (a relaunched session never gets it). An Escape still
 *     pending when the prompt closes by itself is withdrawn; one already
 *     claimed is waited for.
 *   - any other dialog (unknown, the Fable guard's fable_limit / credits_offer
 *     / usage_overlay) gets no key from here.
 *   - one operator alert, repeated at most once an hour while the dialog lasts,
 *     when a dialog of any kind has held work for 5 min (every row waiting for
 *     that persona: inbound messages and controls, except the watch's own), or
 *     a permission prompt is still on screen 5 min after its Escape was sent
 *     (or queued, if it never went out), even with nothing queued behind it:
 *     the session cannot work until someone looks.
 *   - work waiting more than 10 min while the session is idle or held by a
 *     dialog: agent-status.json shows health 'unavailable', unavailable_reason
 *     'delivery_stuck' (deliveryStuck, status-writer.js) instead of ok, and the
 *     operator gets the same alert, once per backlog.
 * The active dialog's state (prompt id, pane, first seen, Escape queued / sent,
 * next alert time) and unresolved declines are saved through `saveState` and
 * resumed on start, so a monitor restart sends no second Escape to the same
 * prompt and no alert within the hour. It is cleared once the dialog is gone.
 * Alerts use the direct admin send of the degraded and start-held alerts; a
 * failed send is tried again a minute later. Logs and alerts carry ids,
 * counts, kinds and ages; a dialog's title row only for a permission prompt;
 * never message content or other pane rows.
 */
import { createHash } from 'node:crypto';

export const DIALOG_WATCH_TIMING = Object.freeze({
  permissionGraceMs: 60_000,
  heldAlertAfterMs: 5 * 60_000,
  alertRepeatMs: 60 * 60_000,
  stuckAfterMs: 10 * 60_000,
  pendingCheckMs: 30_000,
  alertRetryMs: 60_000,
  // A claimed Escape is acknowledged within seconds; give up waiting after this.
  declineResolveMs: 5 * 60_000,
});

const STATE_VERSION = 1;
const MAX_TITLE = 120;

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.round(ms / 1000);
const clip = (text, max = MAX_TITLE) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const personaName = (instanceId) => String(instanceId || 'primary').replace(/^user-/, '');
const isPermission = (d) => d.kind === 'permission';
const hash16 = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
// A dialog's identity on one pane; never raw pane text (it is persisted).
const dialogKey = (modal, sessionRef) =>
  `${modal.kind}:${modal.kind === 'permission' ? modal.id : hash16(modal.text)}:${sessionRef}`;

/** The one notice a session gets after its permission prompt was declined. */
export function formatDeclinedNotice({ title, notice }) {
  const quoted = notice ? `"${clip(title)}" / "${clip(notice, 400)}"` : `"${clip(title)}"`;
  return `your last tool call was declined. Claude Code asked for permission (${quoted}) `
    + 'and nobody can answer prompts in this session, so the prompt was cancelled after 60 seconds. '
    + 'Rewrite the command as the prompt advised, or do the step another way that needs no approval, and continue. '
    + 'Do not repeat it unchanged.';
}

/** Operator alert: a dialog holds the session. Title only for a permission prompt. */
export function formatDialogAlert({ instanceId, kind, title, onScreenMs, held, oldestAgeMs, escape, escapeSentMs }) {
  const action = {
    sent: `已自动按过一次 Esc（${minutes(escapeSentMs)} 分钟前送达），权限确认框仍在。`,
    queued: 'Esc 已排队但还没有送达。',
    failed: 'Esc 未能放入队列。',
    pending: '还没到自动按 Esc 的时间。',
    none: '这类对话框不会自动按键。',
  }[escape] || '';
  const named = kind === 'permission' ? `${kind}「${clip(title)}」` : kind;
  const waiting = held.count > 0
    ? `等待送达：${held.count} 条（消息 ${held.conversations}，控制 ${held.controls}），最早一条已等 ${minutes(oldestAgeMs)} 分钟。`
    : '没有排队的消息，但会话在对话框关闭前无法继续工作。';
  return [
    `🔴 ${personaName(instanceId)} 的会话被对话框卡住`,
    `对话框：${named}，已在屏幕上 ${minutes(onScreenMs)} 分钟。`,
    waiting,
    `${action}需要人工到该会话处理。对话框仍在时每小时提醒一次。`,
  ].join('\n');
}

/** Operator alert: work waiting while the session is free. */
export function formatStuckAlert({ instanceId, held, oldestAgeMs }) {
  return [
    `🔴 ${personaName(instanceId)} 有 ${held.count} 条待送达（消息 ${held.conversations}，控制 ${held.controls}）超过 ${minutes(DIALOG_WATCH_TIMING.stuckAfterMs)} 分钟没有送达`,
    `会话空闲，屏幕上没有对话框，最早一条已等 ${minutes(oldestAgeMs)} 分钟。投递没有自行恢复，需要检查 c4-dispatcher。`,
  ].join('\n');
}

function validState(state) {
  if (!state || state.version !== STATE_VERSION) return null;
  const d = state.dialog;
  const dialogOk = d === null || (d && typeof d.key === 'string' && typeof d.kind === 'string' && Number.isFinite(d.since));
  if (!dialogOk || !Array.isArray(state.declines)) return null;
  return state;
}

/**
 * @param {object} deps
 * @param {string|null} deps.instanceId
 * @param {(key: string, sessionRef: string, dialogId: string) => {ok: boolean, id?: number, output?: string}} deps.enqueueKey
 *   queue a plain `[KEYSTROKE]<key>` bound to the pane (session_ref) and prompt (dialog_ref)
 * @param {(id: number) => string|null} deps.controlStatus - the control row's status now
 * @param {(id: number) => boolean} deps.withdrawKey - supersede the key if still pending; false otherwise
 * @param {(text: string, sessionRef: string, dialogId: string) => {ok: boolean, id?: number, output?: string}} deps.enqueueNotice
 *   queue a control message bound the same way
 * @param {() => {count: number, oldestAt: number|null, conversations: number, controls: number}} deps.readHeld
 *   every row waiting for this persona except the watch's own (getHeldWorkSummary)
 * @param {(message: string) => Promise<{ok: boolean, output?: string}>} deps.notifyOperator
 * @param {(message: string) => void} deps.log
 * @param {() => object|null} [deps.loadState] - the saved state, read once at start
 * @param {(state: object|null) => void} [deps.saveState] - persist (null: nothing active)
 * @param {() => number} [deps.now]
 * @param {object} [deps.timing]
 */
export function createDialogWatch({ instanceId = null, enqueueKey, controlStatus, withdrawKey, enqueueNotice,
  readHeld, notifyOperator, log, loadState = () => null, saveState = () => {}, now = Date.now,
  timing = DIALOG_WATCH_TIMING }) {
  let dialog = null;
  // Declines whose prompt is gone, waiting for their Escape control to be final.
  let declines = [];
  let held = { count: 0, oldestAt: null, conversations: 0, controls: 0, checkedAt: -Infinity };
  // Work older than stuckAfterMs: one episode (one alert) until none is that old.
  let overdue = null;
  let stuckNow = false;
  let alertInFlight = null;
  let dirty = false;

  try {
    const saved = validState(loadState());
    if (saved) {
      dialog = saved.dialog;
      declines = saved.declines;
      if (dialog || declines.length) log(`Dialog watch: resumed ${dialog ? `${dialog.kind} dialog state` : 'no dialog'}, ${declines.length} decline(s) unresolved`);
    }
  } catch (err) {
    log(`Dialog watch: saved state unreadable (${clip(err?.message, 160)}); starting clean`);
  }

  const describe = (d) => (isPermission(d) ? `permission prompt "${clip(d.title)}"` : `${d.kind} dialog`);
  const changed = () => { dirty = true; };

  function persist() {
    if (!dirty) return;
    dirty = false;
    try {
      saveState(dialog || declines.length ? { version: STATE_VERSION, dialog, declines } : null);
    } catch (err) {
      log(`Dialog watch: state not saved (${clip(err?.message, 160)})`);
    }
  }

  // Sends at most one alert at a time; `onSent` runs only after a verified send.
  function send(message, onSent, what) {
    if (alertInFlight) return false;
    alertInFlight = Promise.resolve()
      .then(() => notifyOperator(message))
      .then((res) => {
        if (res?.ok) { onSent(); changed(); persist(); log(`Dialog watch: ${what} alert sent`); }
        else log(`Dialog watch: ${what} alert not sent (${clip(res?.output || 'no result', 160)}); next try in ${seconds(timing.alertRetryMs)}s`);
      })
      .catch((err) => log(`Dialog watch: ${what} alert failed (${clip(err?.message, 160)}); next try in ${seconds(timing.alertRetryMs)}s`))
      .finally(() => { alertInFlight = null; });
    return true;
  }

  function endDialog(t) {
    const d = dialog;
    dialog = null;
    changed();
    if (d.escape === 'queued' && d.escapeId) declines.push({ escapeId: d.escapeId, sessionRef: d.sessionRef, id: d.id,
      title: d.title, notice: d.notice, since: d.since, goneAt: t });
  }

  // A decline is announced only once its Escape is acknowledged as sent to
  // that prompt (`done`) and the prompt is gone; a still-pending Escape is
  // withdrawn instead, a claimed one waited for.
  function resolveDeclines(sessionRef, t) {
    const before = declines.length;
    declines = declines.filter((d) => {
      let status;
      try { status = controlStatus(d.escapeId); } catch { return true; }
      if (status === 'running' || (status === 'pending' && !withdrawKey(d.escapeId))) {
        if (t - d.goneAt < timing.declineResolveMs) return true;
        log(`Dialog watch: Escape control ${d.escapeId} still ${status} ${seconds(t - d.goneAt)}s after its prompt closed; no decline message`);
        return false;
      }
      if (status === 'pending') {
        log(`Dialog watch: permission prompt closed by itself after ${seconds(d.goneAt - d.since)}s; Escape control ${d.escapeId} withdrawn`);
        return false;
      }
      if (status !== 'done') {
        log(`Dialog watch: Escape control ${d.escapeId} ended ${status || 'missing'}; no decline message`);
        return false;
      }
      // Only the session whose prompt was declined is told; the message is
      // bound to it through delivery.
      if (sessionRef !== d.sessionRef) {
        log(`Dialog watch: session replaced after the decline of control ${d.escapeId}; no decline message`);
        return false;
      }
      const res = enqueueNotice(formatDeclinedNotice({ title: d.title, notice: d.notice }), d.sessionRef, d.id);
      log(res?.ok ? `Dialog watch: session told its tool call was declined (control ${res.id ?? '?'})`
        : `Dialog watch: decline message not queued (${clip(res?.output, 160)})`);
      return false;
    });
    if (declines.length !== before) changed();
  }

  function maybeEscape(t) {
    if (dialog.escape !== 'pending' || !dialog.sessionRef || !dialog.id) return;
    if (t - dialog.since < timing.permissionGraceMs) return;
    // One attempt per prompt. A failed enqueue is not repeated; the alert
    // says so if the prompt stays.
    const res = enqueueKey('Escape', dialog.sessionRef, dialog.id);
    dialog.escape = res?.ok ? 'queued' : 'failed';
    dialog.escapeAt = t;
    dialog.escapeId = res?.ok ? res.id ?? null : null;
    changed();
    log(res?.ok
      ? `Dialog watch: ${describe(dialog)} on screen ${seconds(t - dialog.since)}s; Escape queued (control ${dialog.escapeId ?? '?'})`
      : `Dialog watch: Escape for ${describe(dialog)} not queued (${clip(res?.output, 160)})`);
  }

  // Whether the queued Escape went out, while its prompt is still up.
  function trackEscape(t) {
    if (dialog.escape !== 'queued' || !dialog.escapeId || dialog.escapeSentAt || dialog.escapeEnded) return;
    let status;
    try { status = controlStatus(dialog.escapeId); } catch { return; }
    if (status === 'done') { dialog.escapeSentAt = t; changed(); }
    else if (status && status !== 'pending' && status !== 'running') { dialog.escapeEnded = status; changed(); }
  }

  function refreshHeld(t) {
    if (t - held.checkedAt < timing.pendingCheckMs) return;
    try {
      const r = readHeld();
      held = { count: r.count, oldestAt: r.count > 0 ? r.oldestAt : null, conversations: r.conversations || 0,
        controls: r.controls || 0, checkedAt: t };
    } catch (err) {
      held = { ...held, checkedAt: t };
      log(`Dialog watch: waiting work unreadable (${clip(err?.message, 160)})`);
    }
  }

  function maybeAlertDialog(t) {
    const d = dialog;
    if (held.count > 0 && !d.heldSince) { d.heldSince = Math.max(d.since, held.oldestAt ?? t); changed(); }
    const due = [];
    if (d.heldSince) due.push(d.heldSince + timing.heldAlertAfterMs);
    // A permission prompt that survived its Escape blocks the session even
    // with nothing queued: alert 5 min after the Escape went out (or was
    // queued, if it never went out).
    if (isPermission(d) && d.escape === 'queued') due.push((d.escapeSentAt || d.escapeAt) + timing.heldAlertAfterMs);
    if (!due.length || t < Math.min(...due) || (d.alertDueAt || 0) > t) return;
    const escape = d.escape === 'queued' ? (d.escapeSentAt ? 'sent' : 'queued') : d.escape;
    const sent = send(formatDialogAlert({
      instanceId, kind: d.kind, title: d.title, onScreenMs: t - d.since, held,
      oldestAgeMs: held.oldestAt ? t - held.oldestAt : 0, escape, escapeSentMs: d.escapeSentAt ? t - d.escapeSentAt : 0,
    }), () => { d.alertDueAt = t + timing.alertRepeatMs; d.alerted = true; }, `${d.kind} dialog`);
    if (sent || alertInFlight) { d.alertDueAt = Math.max(d.alertDueAt || 0, t + timing.alertRetryMs); changed(); }
  }

  function updateOverdue(t, sessionState, healthOk) {
    const oldestAge = held.oldestAt ? t - held.oldestAt : 0;
    const free = sessionState === 'idle' || !!dialog;
    // Another health state (rate limit, auth, degraded) holds delivery on
    // purpose and has its own notices.
    if (!healthOk || held.count === 0 || oldestAge <= timing.stuckAfterMs) {
      if (overdue) log('Dialog watch: waiting work cleared');
      overdue = null;
      stuckNow = false;
      return;
    }
    stuckNow = free;
    if (!overdue && !free) return;
    if (!overdue) {
      overdue = { alerted: false, retryAt: 0 };
      log(`Dialog watch: ${held.count} row(s) waiting (${held.conversations} message(s), ${held.controls} control(s)), oldest ${Math.round(oldestAge / 60_000)} min, session ${dialog ? `held by a ${dialog.kind} dialog` : 'idle'}`);
    }
    if (overdue.alerted || overdue.retryAt > t || !free) return;
    // A dialog alert already named the counts and the oldest age; while the
    // dialog is up and not yet alerted, its own alert comes first.
    if (dialog?.alerted) { overdue.alerted = true; return; }
    if (dialog) return;
    const episode = overdue;
    if (send(formatStuckAlert({ instanceId, held, oldestAgeMs: oldestAge }),
      () => { episode.alerted = true; }, 'waiting-work')) episode.retryAt = t + timing.alertRetryMs;
  }

  return {
    /**
     * One monitor tick with the pane read of this tick.
     * @param {{ modal: object|null, sessionRef: string|null, captureOk?: boolean,
     *   sessionState: string, healthOk?: boolean }} frame
     */
    tick({ modal = null, sessionRef = null, captureOk = true, sessionState = 'idle', healthOk = true } = {}) {
      const t = now();
      // An unreadable frame neither starts nor ends a dialog.
      if (captureOk !== false) {
        const key = modal ? dialogKey(modal, sessionRef) : null;
        if (dialog && dialog.key !== key) endDialog(t);
        if (modal && !dialog) {
          const permission = modal.kind === 'permission';
          dialog = { key, kind: modal.kind, id: modal.id || null, title: permission ? modal.text : null,
            notice: permission ? modal.notice || null : null, sessionRef, since: t,
            escape: permission ? 'pending' : 'none', escapeAt: 0, escapeId: null, escapeSentAt: 0, escapeEnded: null,
            heldSince: 0, alertDueAt: 0, alerted: false };
          changed();
          log(`Dialog watch: ${describe(dialog)} on screen`);
        }
        if (dialog && isPermission(dialog)) { maybeEscape(t); trackEscape(t); }
        if (declines.length) resolveDeclines(sessionRef, t);
      }
      refreshHeld(t);
      if (dialog) maybeAlertDialog(t);
      updateOverdue(t, sessionState, healthOk);
      persist();
    },

    /**
     * While work is stuck: what holds it (status-writer publishes this as
     * health 'unavailable', reason delivery_stuck); null otherwise.
     * @returns {null | { cause: string, pending: number, oldest_age_seconds: number }}
     */
    deliveryStuck() {
      if (!stuckNow) return null;
      return {
        cause: dialog ? `dialog:${dialog.kind}` : 'session_idle',
        pending: held.count,
        oldest_age_seconds: held.oldestAt ? seconds(now() - held.oldestAt) : 0,
      };
    },

    /** For tests: the alert send in flight, if any. */
    settled: () => alertInFlight || Promise.resolve(),
  };
}
