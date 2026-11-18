/**
 * Dialog watch: in an unattended persona session a dialog nobody can answer
 * does not stay, and delivery that does not happen is visible.
 *
 * 2026-11-18, user-pan: Claude Code 2.1.326 asked "Do you want to proceed?"
 * about the session's own `rm -f $D/*` ("Dangerous rm operation on possibly-
 * empty variable path"), even with --dangerously-skip-permissions. Nobody is at
 * that keyboard; the dialog stayed 4 h 48 min, every message for Pan was held,
 * agent-status.json said ok/idle, and no one was told.
 *
 * The monitor ticks this with the pane read it already makes every second
 * (readTmuxInputState: modal, paneIdentity), so it costs no extra tmux call.
 *   - permission prompt on screen for 60 s: one Escape, the cancel key the
 *     prompt names ("Esc to cancel"), never "Yes" or an option number. Once the
 *     prompt is gone the session is told, once, that its command was declined
 *     and to rewrite it as the prompt advised (the prompt's title and notice
 *     rows are quoted: Claude Code's own text).
 *   - any other dialog on screen for 2 min: one Escape. The Fable guard's
 *     dialogs (fable_limit, credits_offer, usage_overlay) get no key here.
 *   - a dialog still on screen 5 min after it first held a message: one
 *     operator alert (persona, dialog kind, title, how long, how many waiting),
 *     repeated at most once an hour while it lasts.
 *   - inbound messages undelivered for more than 10 min while the session is
 *     idle or held by a dialog: agent-status.json shows health 'unavailable',
 *     unavailable_reason 'delivery_stuck' (deliveryStuck, status-writer.js)
 *     instead of ok, and the operator gets the same alert, once.
 * Keys and the session notice go through the C4 control queue
 * ([KEYSTROKE]Escape bound to the judged pane, like the tool watchdog's
 * interrupt); the dispatcher delivers them. An Escape still queued when its
 * dialog closes by itself is withdrawn, so it can never interrupt the work that
 * follows. Alerts use the direct admin send of the degraded and start-held
 * alerts; a failed send is tried again a minute later. Logs and alerts carry
 * ids, counts, kinds, ages and the dialog's title row only, never message
 * content.
 */

export const DIALOG_WATCH_TIMING = Object.freeze({
  permissionGraceMs: 60_000,
  otherGraceMs: 120_000,
  heldAlertAfterMs: 5 * 60_000,
  alertRepeatMs: 60 * 60_000,
  stuckAfterMs: 10 * 60_000,
  pendingCheckMs: 30_000,
  alertRetryMs: 60_000,
});

// Owned by the Fable guard (fable-guard.js / health-engine limitDialogActive).
const GUARD_OWNED_KINDS = new Set(['fable_limit', 'credits_offer', 'usage_overlay']);
const MAX_TITLE = 120;

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.round(ms / 1000);
const clip = (text, max = MAX_TITLE) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const personaName = (instanceId) => String(instanceId || 'primary').replace(/^user-/, '');
const controlId = (output) => Number(/enqueued control (\d+)/.exec(String(output ?? ''))?.[1]) || null;

/** The one notice a session gets after its permission prompt was declined. */
export function formatDeclinedNotice({ title, notice }) {
  const quoted = notice ? `"${clip(title)}" / "${clip(notice, 400)}"` : `"${clip(title)}"`;
  return `your last tool call was declined. Claude Code asked for permission (${quoted}) `
    + 'and nobody can answer prompts in this session, so the prompt was cancelled after 60 seconds. '
    + 'Rewrite the command as the prompt advised, or do the step another way that needs no approval, and continue. '
    + 'Do not repeat it unchanged.';
}

/** Operator alert: a dialog holds the session's delivery. */
export function formatDialogAlert({ instanceId, kind, title, onScreenMs, heldMs, pending, oldestAgeMs, escape }) {
  const action = {
    queued: '已自动按过一次 Esc，对话框仍在。',
    failed: 'Esc 未能放入队列。',
    pending: '还没到自动按 Esc 的时间。',
    guard: '这是 Fable 额度对话框，按键由 Fable 守护处理，这里不发送按键。',
  }[escape] || '';
  return [
    `🔴 ${personaName(instanceId)} 的会话被对话框卡住，消息无法送达`,
    `对话框：${kind}「${clip(title)}」，已在屏幕上 ${minutes(onScreenMs)} 分钟，挡住投递 ${minutes(heldMs)} 分钟。`,
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
 * @param {(key: string, sessionRef: string) => {ok: boolean, output?: string}} deps.enqueueKey
 *   queue a [KEYSTROKE] control bound to the pane (c4-control enqueue output)
 * @param {(id: number) => boolean} deps.withdrawKey - supersede a still-queued key; false once sent
 * @param {(text: string) => {ok: boolean, output?: string}} deps.enqueueNotice
 * @param {() => {count: number, oldestAt: number|null}} deps.readUndelivered
 * @param {(message: string) => Promise<{ok: boolean, output?: string}>} deps.notifyOperator
 * @param {(message: string) => void} deps.log
 * @param {() => number} [deps.now]
 * @param {object} [deps.timing]
 */
export function createDialogWatch({ instanceId = null, enqueueKey, withdrawKey, enqueueNotice, readUndelivered,
  notifyOperator, log, now = Date.now, timing = DIALOG_WATCH_TIMING }) {
  let dialog = null;
  let undelivered = { count: 0, oldestAt: null, checkedAt: -Infinity };
  // Undelivered messages older than stuckAfterMs: one episode (one alert)
  // until none is that old any more.
  let overdue = null;
  let stuckNow = false;
  let alertInFlight = null;

  const describe = (d) => `${d.kind} dialog "${clip(d.title)}"`;

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

  function endDialog(sessionRef, t) {
    const d = dialog;
    dialog = null;
    if (d.escape !== 'queued') return;
    // Closed before the dispatcher sent our Escape (answered or auto-blocked
    // by the CLI): withdraw the key, nothing was declined by us.
    if (d.escapeId && withdrawKey(d.escapeId)) {
      log(`Dialog watch: ${describe(d)} closed by itself after ${seconds(t - d.since)}s; Escape control ${d.escapeId} withdrawn`);
      return;
    }
    log(`Dialog watch: ${describe(d)} gone ${seconds(t - d.escapeAt)}s after its Escape`);
    // Only the session whose prompt was declined is told; a replacement
    // session never ran that command.
    if (d.kind !== 'permission' || sessionRef !== d.sessionRef) return;
    const res = enqueueNotice(formatDeclinedNotice({ title: d.title, notice: d.notice }));
    log(res?.ok ? `Dialog watch: session told its command was declined (${clip(res.output, 80)})`
      : `Dialog watch: decline notice not queued (${clip(res?.output, 160)})`);
  }

  function maybeEscape(t) {
    if (dialog.escape !== 'pending' || !dialog.sessionRef) return;
    const grace = dialog.kind === 'permission' ? timing.permissionGraceMs : timing.otherGraceMs;
    if (t - dialog.since < grace) return;
    // One attempt per dialog. A failed enqueue is not repeated; the alert
    // says so if the dialog then holds delivery.
    const res = enqueueKey('Escape', dialog.sessionRef);
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
        const key = modal ? `${modal.kind}\0${modal.text}\0${sessionRef}` : null;
        if (dialog && dialog.key !== key) endDialog(sessionRef, t);
        if (modal && !dialog) {
          dialog = { key, kind: modal.kind, title: modal.text, notice: modal.notice || null, sessionRef, since: t,
            escape: GUARD_OWNED_KINDS.has(modal.kind) ? 'guard' : 'pending', escapeAt: 0, escapeId: null,
            heldSince: 0, alertDueAt: 0, alerted: false };
          log(`Dialog watch: ${describe(dialog)} on screen`);
        }
        if (dialog) maybeEscape(t);
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
