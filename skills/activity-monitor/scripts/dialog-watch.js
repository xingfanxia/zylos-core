/**
 * Dialog watch: in an unattended persona session a permission prompt nobody
 * can answer does not stay, any dialog that holds delivery is reported, and
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
 *     key the prompt names, queued as `[KEYSTROKE]Escape dialog=<id>` bound to
 *     the pane. The dispatcher sends it only while that very prompt is still
 *     on that pane (otherwise it supersedes it), and sends no other key to a
 *     permission prompt. Never "Yes", an option number or text.
 *   - the decline is announced to the session once, and only when it is
 *     certain: the Escape control is `done` (sent to that prompt) and the
 *     prompt is gone. The message quotes the prompt's title and notice rows
 *     (Claude Code's own text) and is bound to the same session through
 *     delivery. An Escape still pending when the prompt closes by itself is
 *     withdrawn; one already claimed is waited for.
 *   - any other dialog (unknown, the Fable guard's fable_limit / credits_offer
 *     / usage_overlay) gets no key from here.
 *   - a dialog of any kind still on screen 5 min after it first held an
 *     inbound message: one operator alert (persona, kind, minutes, counts; the
 *     title row only for a permission prompt), repeated at most once an hour.
 *   - inbound messages undelivered for more than 10 min while the session is
 *     idle or held by a dialog: agent-status.json shows health 'unavailable',
 *     unavailable_reason 'delivery_stuck' (deliveryStuck, status-writer.js)
 *     instead of ok, and the operator gets the same alert, once per backlog.
 * Alerts use the direct admin send of the degraded and start-held alerts; a
 * failed send is tried again a minute later. Logs and alerts carry ids,
 * counts, kinds and ages; a dialog's title row only for a permission prompt;
 * never message content or other pane rows.
 */

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

const MAX_TITLE = 120;

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.round(ms / 1000);
const clip = (text, max = MAX_TITLE) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const personaName = (instanceId) => String(instanceId || 'primary').replace(/^user-/, '');
const controlId = (output) => Number(/enqueued control (\d+)/.exec(String(output ?? ''))?.[1]) || null;
const isPermission = (d) => d.kind === 'permission';

/** The one notice a session gets after its permission prompt was declined. */
export function formatDeclinedNotice({ title, notice }) {
  const quoted = notice ? `"${clip(title)}" / "${clip(notice, 400)}"` : `"${clip(title)}"`;
  return `your last tool call was declined. Claude Code asked for permission (${quoted}) `
    + 'and nobody can answer prompts in this session, so the prompt was cancelled after 60 seconds. '
    + 'Rewrite the command as the prompt advised, or do the step another way that needs no approval, and continue. '
    + 'Do not repeat it unchanged.';
}

/** Operator alert: a dialog holds the session's delivery. Title only for a permission prompt. */
export function formatDialogAlert({ instanceId, kind, title, onScreenMs, heldMs, pending, oldestAgeMs, escape }) {
  const action = {
    queued: '已自动按过一次 Esc，权限确认框仍在。',
    failed: 'Esc 未能放入队列。',
    pending: '还没到自动按 Esc 的时间。',
    none: '这类对话框不会自动按键。',
  }[escape] || '';
  const named = kind === 'permission' ? `${kind}「${clip(title)}」` : kind;
  return [
    `🔴 ${personaName(instanceId)} 的会话被对话框卡住，消息无法送达`,
    `对话框：${named}，已在屏幕上 ${minutes(onScreenMs)} 分钟，挡住投递 ${minutes(heldMs)} 分钟。`,
    `等待送达：${pending} 条，最早一条已等 ${minutes(oldestAgeMs)} 分钟。`,
    `${action}需要人工到该会话处理。对话框仍在时每小时提醒一次。`,
  ].join('\n');
}

/** Operator alert: messages undelivered while the session is free. */
export function formatStuckAlert({ instanceId, pending, oldestAgeMs }) {
  return [
    `🔴 ${personaName(instanceId)} 有 ${pending} 条消息超过 ${minutes(DIALOG_WATCH_TIMING.stuckAfterMs)} 分钟没有送达`,
    `会话空闲，屏幕上没有对话框，最早一条已等 ${minutes(oldestAgeMs)} 分钟。投递没有自行恢复，需要检查 c4-dispatcher。`,
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {string|null} deps.instanceId
 * @param {(key: string, sessionRef: string, dialogId: string) => {ok: boolean, output?: string}} deps.enqueueKey
 *   queue `[KEYSTROKE]<key> dialog=<id>` bound to the pane (c4-control enqueue output)
 * @param {(id: number) => string|null} deps.controlStatus - the control row's status now
 * @param {(id: number) => boolean} deps.withdrawKey - supersede the key if still pending; false otherwise
 * @param {(text: string, sessionRef: string) => {ok: boolean, output?: string}} deps.enqueueNotice
 *   queue a control message bound to that session
 * @param {() => {count: number, oldestAt: number|null}} deps.readUndelivered
 * @param {(message: string) => Promise<{ok: boolean, output?: string}>} deps.notifyOperator
 * @param {(message: string) => void} deps.log
 * @param {() => number} [deps.now]
 * @param {object} [deps.timing]
 */
export function createDialogWatch({ instanceId = null, enqueueKey, controlStatus, withdrawKey, enqueueNotice,
  readUndelivered, notifyOperator, log, now = Date.now, timing = DIALOG_WATCH_TIMING }) {
  let dialog = null;
  // Declines whose prompt is gone, waiting for their Escape control to be final.
  let declines = [];
  let undelivered = { count: 0, oldestAt: null, checkedAt: -Infinity };
  // Undelivered messages older than stuckAfterMs: one episode (one alert)
  // until none is that old any more.
  let overdue = null;
  let stuckNow = false;
  let alertInFlight = null;

  // Log/alert name of a dialog: the title row only for a permission prompt.
  const describe = (d) => (isPermission(d) ? `permission prompt "${clip(d.title)}"` : `${d.kind} dialog`);

  // Sends at most one alert at a time; `onSent` runs only after a verified send.
  function send(message, onSent, what) {
    if (alertInFlight) return false;
    alertInFlight = Promise.resolve()
      .then(() => notifyOperator(message))
      .then((res) => {
        if (res?.ok) { onSent(); log(`Dialog watch: ${what} alert sent`); }
        else log(`Dialog watch: ${what} alert not sent (${clip(res?.output || 'no result', 160)}); next try in ${seconds(timing.alertRetryMs)}s`);
      })
      .catch((err) => log(`Dialog watch: ${what} alert failed (${clip(err?.message, 160)}); next try in ${seconds(timing.alertRetryMs)}s`))
      .finally(() => { alertInFlight = null; });
    return true;
  }

  function endDialog(t) {
    const d = dialog;
    dialog = null;
    if (d.escape === 'queued' && d.escapeId) declines.push({ ...d, goneAt: t });
  }

  // A decline is announced only once its Escape is acknowledged as sent to
  // that prompt (`done`) and the prompt is gone; a still-pending Escape is
  // withdrawn instead, a claimed one waited for.
  function resolveDeclines(sessionRef, t) {
    declines = declines.filter((d) => {
      let status;
      try { status = controlStatus(d.escapeId); } catch { return true; }
      if (status === 'running' || (status === 'pending' && !withdrawKey(d.escapeId))) {
        if (t - d.goneAt < timing.declineResolveMs) return true;
        log(`Dialog watch: Escape control ${d.escapeId} still ${status} ${seconds(t - d.goneAt)}s after its prompt closed; no decline message`);
        return false;
      }
      if (status === 'pending') {
        log(`Dialog watch: ${describe(d)} closed by itself after ${seconds(d.goneAt - d.since)}s; Escape control ${d.escapeId} withdrawn`);
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
      const res = enqueueNotice(formatDeclinedNotice({ title: d.title, notice: d.notice }), d.sessionRef);
      log(res?.ok ? `Dialog watch: session told its tool call was declined (control ${controlId(res.output) ?? '?'})`
        : `Dialog watch: decline message not queued (${clip(res?.output, 160)})`);
      return false;
    });
  }

  function maybeEscape(t) {
    if (dialog.escape !== 'pending' || !dialog.sessionRef || !dialog.id) return;
    if (t - dialog.since < timing.permissionGraceMs) return;
    // One attempt per prompt. A failed enqueue is not repeated; the alert
    // says so if the prompt then holds delivery.
    const res = enqueueKey('Escape', dialog.sessionRef, dialog.id);
    dialog.escape = res?.ok ? 'queued' : 'failed';
    dialog.escapeAt = t;
    dialog.escapeId = res?.ok ? controlId(res.output) : null;
    log(res?.ok
      ? `Dialog watch: ${describe(dialog)} on screen ${seconds(t - dialog.since)}s; Escape queued (control ${dialog.escapeId ?? '?'})`
      : `Dialog watch: Escape for ${describe(dialog)} not queued (${clip(res?.output, 160)})`);
  }

  function refreshUndelivered(t) {
    if (t - undelivered.checkedAt < timing.pendingCheckMs) return;
    try {
      const { count, oldestAt } = readUndelivered();
      undelivered = { count, oldestAt: count > 0 ? oldestAt : null, checkedAt: t };
    } catch (err) {
      undelivered = { ...undelivered, checkedAt: t };
      log(`Dialog watch: undelivered count unreadable (${clip(err?.message, 160)})`);
    }
  }

  function maybeAlertDialog(t) {
    const d = dialog;
    if (undelivered.count > 0 && !d.heldSince) d.heldSince = Math.max(d.since, undelivered.oldestAt ?? t);
    if (!d.heldSince || t - d.heldSince < timing.heldAlertAfterMs || d.alertDueAt > t) return;
    const sent = send(formatDialogAlert({
      instanceId, kind: d.kind, title: d.title, onScreenMs: t - d.since, heldMs: t - d.heldSince,
      pending: undelivered.count, oldestAgeMs: undelivered.oldestAt ? t - undelivered.oldestAt : 0, escape: d.escape,
    }), () => { d.alertDueAt = t + timing.alertRepeatMs; d.alerted = true; }, `${d.kind} dialog`);
    if (sent || alertInFlight) d.alertDueAt = Math.max(d.alertDueAt, t + timing.alertRetryMs);
  }

  function updateOverdue(t, sessionState, healthOk) {
    const oldestAge = undelivered.oldestAt ? t - undelivered.oldestAt : 0;
    const free = sessionState === 'idle' || !!dialog;
    // Another health state (rate limit, auth, degraded) holds delivery on
    // purpose and has its own notices.
    if (!healthOk || undelivered.count === 0 || oldestAge <= timing.stuckAfterMs) {
      if (overdue) log('Dialog watch: undelivered backlog cleared');
      overdue = null;
      stuckNow = false;
      return;
    }
    stuckNow = free;
    if (!overdue && !free) return;
    if (!overdue) {
      overdue = { alerted: false, retryAt: 0 };
      log(`Dialog watch: ${undelivered.count} inbound message(s) undelivered, oldest ${Math.round(oldestAge / 60_000)} min, session ${dialog ? `held by a ${dialog.kind} dialog` : 'idle'}`);
    }
    if (overdue.alerted || overdue.retryAt > t || !free) return;
    // A dialog alert already named the count and the oldest age; while the
    // dialog is up and not yet alerted, its own alert comes first.
    if (dialog?.alerted) { overdue.alerted = true; return; }
    if (dialog) return;
    const episode = overdue;
    if (send(formatStuckAlert({ instanceId, pending: undelivered.count, oldestAgeMs: oldestAge }),
      () => { episode.alerted = true; }, 'undelivered-messages')) episode.retryAt = t + timing.alertRetryMs;
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
        const key = modal ? `${modal.kind}\0${modal.kind === 'permission' ? modal.id : modal.text}\0${sessionRef}` : null;
        if (dialog && dialog.key !== key) endDialog(t);
        if (modal && !dialog) {
          dialog = { key, kind: modal.kind, title: modal.text, notice: modal.notice || null, id: modal.id || null,
            sessionRef, since: t, escape: modal.kind === 'permission' ? 'pending' : 'none', escapeAt: 0, escapeId: null,
            heldSince: 0, alertDueAt: 0, alerted: false };
          log(`Dialog watch: ${describe(dialog)} on screen`);
        }
        if (dialog && isPermission(dialog)) maybeEscape(t);
        if (declines.length) resolveDeclines(sessionRef, t);
      }
      refreshUndelivered(t);
      if (dialog) maybeAlertDialog(t);
      updateOverdue(t, sessionState, healthOk);
    },

    /**
     * While delivery is stuck: what holds it (status-writer publishes this as
     * health 'unavailable', reason delivery_stuck); null otherwise.
     * @returns {null | { cause: string, pending: number, oldest_age_seconds: number }}
     */
    deliveryStuck() {
      if (!stuckNow) return null;
      return {
        cause: dialog ? `dialog:${dialog.kind}` : 'session_idle',
        pending: undelivered.count,
        oldest_age_seconds: undelivered.oldestAt ? seconds(now() - undelivered.oldestAt) : 0,
      };
    },

    /** For tests: the alert send in flight, if any. */
    settled: () => alertInFlight || Promise.resolve(),
  };
}
