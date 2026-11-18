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
 * The database is the authority. Whether an Escape or a decline message
 * exists, its id and status always come from the queue, through reads and
 * withdrawals scoped in SQL to this persona, pane, prompt and control kind
 * (bindDialogWatchQueue); at most one of each exists per persona, pane and
 * prompt (c4-db insertDialogControl). What the queue cannot hold (first-seen
 * time, next alert time, the prompt's title and notice rows) is kept in the
 * service-owned table dialog_watch_state, which personas cannot write; even
 * that is re-validated (shapes, times clamped, the dialog must match the live
 * pane). Nothing is read from a persona-writable directory.
 * Capability gate: nothing is queued until the running dispatcher (and, for an
 * isolated persona, the broker) have published that they understand the
 * prompt binding (c4_process_capabilities), which they do only once the
 * dialog-binding schema (migrations/005, 006) is verified. Until then, and
 * whenever that schema is missing, the watch only observes and alerts: its
 * state is neither read nor saved and it queues nothing.
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
    withheld: '没有发送 Esc：c4-dispatcher / c4-broker 还没有确认对话框绑定（尚未重启，或数据库迁移 005/006 未完成，见它们的日志）。',
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

const SESSION_REF_RE = /^\$\d+:\d+:%\d+:\d+$/;
const PROMPT_ID_RE = /^[0-9a-f]{16}$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const time = (v, now) => (Number.isFinite(v) && v > 0 && v <= now ? v : 0);

// The saved state, re-validated field by field: only shapes the watch itself
// writes, times not in the future (next alert at most one repeat ahead), and
// no Escape facts at all (those come from the queue).
function restoredState(state, now, timing) {
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.declines)) return null;
  const restoreDialog = (d) => {
    if (!d || typeof d !== 'object' || !SESSION_REF_RE.test(d.sessionRef || '') || typeof d.kind !== 'string') return null;
    const permission = d.kind === 'permission';
    if (permission && !PROMPT_ID_RE.test(d.id || '')) return null;
    const since = time(d.since, now);
    // The key is rebuilt from the validated fields (the same form dialogKey
    // gives a live modal), never taken as written.
    const other = /^[a-z_]{1,32}:([0-9a-f]{16}):/.exec(typeof d.key === 'string' ? d.key : '')?.[1];
    if (!since || !/^[a-z_]{1,32}$/.test(d.kind) || (!permission && !other)) return null;
    const key = `${d.kind}:${permission ? d.id : other}:${d.sessionRef}`;
    return { key, kind: d.kind, id: permission ? d.id : null,
      title: permission ? str(d.title, 400) : null, notice: permission ? str(d.notice, 800) : null,
      sessionRef: d.sessionRef, since, escape: permission ? 'pending' : 'none', escapeAt: 0, escapeId: null,
      escapeSentAt: 0, savedEscapeSentAt: time(d.escapeSentAt, now), escapeEnded: null,
      heldSince: time(d.heldSince, now), alertDueAt: Math.min(Number(d.alertDueAt) || 0, now + timing.alertRepeatMs),
      alerted: d.alerted === true };
  };
  const dialog = state.dialog == null ? null : restoreDialog(state.dialog);
  const declines = state.declines.slice(0, 10).map((d) => {
    if (!d || !SESSION_REF_RE.test(d.sessionRef || '') || !PROMPT_ID_RE.test(d.id || '')) return null;
    return { sessionRef: d.sessionRef, id: d.id, title: str(d.title, 400), notice: str(d.notice, 800),
      since: time(d.since, now), goneAt: time(d.goneAt, now) || now };
  }).filter(Boolean);
  return { dialog, declines };
}

/**
 * The dialog watch's queue access for one instance, every read and write
 * scoped in SQL to that instance, the pane, the prompt and the control kind
 * (c4-db.js findDialogControl / withdrawDialogControl). `db` holds the c4-db
 * functions.
 */
export function bindDialogWatchQueue({ instanceId = null, isolated = false, routesUntargeted = () => false, db }) {
  // The dispatcher always delivers; the broker writes rows for isolated
  // personas only, so only their watch also needs a capable broker.
  const required = isolated ? ['c4-dispatcher', 'c4-broker'] : ['c4-dispatcher'];
  // Every insert is authorized inside its own transaction (requires).
  const insert = (kind, content, priority, bypassState, sessionRef, dialogRef) => {
    try {
      const row = db.insertDialogControl({ instanceId, sessionRef, dialogRef, kind, content, priority, bypassState, requires: required });
      if (row.refused) return { ok: false, refused: row.refused, output: `${row.refused} does not enforce the binding` };
      return { ok: true, id: row.id, existing: row.existing };
    } catch (err) {
      return { ok: false, output: err.message };
    }
  };
  return {
    enqueueKey: (key, sessionRef, dialogRef) => insert('escape', `[KEYSTROKE]${key}`, 0, true, sessionRef, dialogRef),
    enqueueNotice: (text, sessionRef, dialogRef) => insert('notice', text, 1, false, sessionRef, dialogRef),
    findOwnControl: ({ sessionRef, dialogRef, kind }) => db.findDialogControl({ instanceId, sessionRef, dialogRef, kind }),
    withdrawOwnControl: ({ id, sessionRef, dialogRef, kind }) => db.withdrawDialogControl({ id, instanceId, sessionRef, dialogRef, kind,
      reason: 'DIALOG_GONE' }),
    deliveryCapable: () => required.every((name) => db.hasLiveCapability(name, 'dialog_ref')),
    readHeld: () => db.getHeldWorkSummary(instanceId, { includeUntargeted: routesUntargeted() }),
    loadState: () => db.loadDialogWatchState(instanceId),
    saveState: (state) => db.saveDialogWatchState(instanceId, state),
  };
}

/**
 * @param {object} deps
 * @param {string|null} deps.instanceId
 * @param {(key: string, sessionRef: string, dialogId: string) => {ok: boolean, id?: number, output?: string}} deps.enqueueKey
 *   queue a plain `[KEYSTROKE]<key>` bound to the pane (session_ref) and prompt (dialog_ref)
 * @param {(scope: {sessionRef: string, dialogRef: string, kind: 'escape'|'notice'}) => {id: number, status: string}|null} deps.findOwnControl
 *   this instance's newest control of that kind for that pane and prompt (scoped in SQL)
 * @param {(scope: {id: number, sessionRef: string, dialogRef: string, kind: string}) => boolean} deps.withdrawOwnControl
 *   supersede that control if it is still pending and matches the whole scope
 * @param {(text: string, sessionRef: string, dialogId: string) => {ok: boolean, id?: number, output?: string}} deps.enqueueNotice
 *   queue a control message bound the same way
 * @param {() => {count: number, oldestAt: number|null, conversations: number, controls: number}} deps.readHeld
 *   every row waiting for this persona except the watch's own (getHeldWorkSummary)
 * @param {(message: string) => Promise<{ok: boolean, output?: string}>} deps.notifyOperator
 * @param {(message: string) => void} deps.log
 * @param {() => object|null} [deps.loadState] - the saved state, read once at start
 * @param {(state: object|null) => void} [deps.saveState] - persist (null: nothing active)
 * @param {() => boolean} [deps.deliveryCapable] - the running dispatcher (and broker) enforce the binding
 * @param {() => number} [deps.now]
 * @param {object} [deps.timing]
 */
export function createDialogWatch({ instanceId = null, enqueueKey, findOwnControl, withdrawOwnControl, enqueueNotice,
  readHeld, notifyOperator, log, loadState = () => null, saveState = () => {}, deliveryCapable = () => true,
  now = Date.now, timing = DIALOG_WATCH_TIMING }) {
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
    const saved = restoredState(loadState(), now(), timing);
    if (saved) {
      dialog = saved.dialog;
      declines = saved.declines;
      if (dialog || declines.length) log(`Dialog watch: resumed ${dialog ? `${dialog.kind} dialog state` : 'no dialog'}, ${declines.length} decline(s) unresolved`);
    }
  } catch (err) {
    log(`Dialog watch: saved state unreadable (${clip(err?.message, 160)}); starting clean`);
  }

  // Whether to try an insert at all. Only a negative answer is remembered
  // (10 s, observe-only); a positive one is never cached and never authorizes
  // anything: each insert checks the capability rows inside its own
  // transaction and is refused when they no longer hold.
  let refusedAt = -Infinity;
  let capableNoted = null;
  function noteCapable(value) {
    if (value === capableNoted) return;
    capableNoted = value;
    log(value ? 'Dialog watch: dispatcher (and broker) enforce the prompt binding; Escapes may be queued'
      : 'Dialog watch: the running dispatcher or broker does not enforce the prompt binding; nothing is queued, only alerts');
  }
  function mayQueue(t) {
    if (t - refusedAt < 10_000) return false;
    let value = false;
    try { value = deliveryCapable() === true; } catch { value = false; }
    if (!value) { refusedAt = t; noteCapable(false); }
    return value;
  }
  function refused(t, res) {
    if (!res?.refused) return false;
    refusedAt = t;
    noteCapable(false);
    return true;
  }

  // This instance's own control of `kind` for that pane and prompt, from the
  // queue (scoped in SQL); null when there is none or the scope is invalid.
  function ownControl(sessionRef, dialogRef, kind) {
    try { return findOwnControl({ sessionRef, dialogRef, kind }); } catch { return null; }
  }

  const describe = (d) => (isPermission(d) ? `permission prompt "${clip(d.title)}"` : `${d.kind} dialog`);
  const changed = () => { dirty = true; };

  // A failed save (a busy database gives up after a short wait) is tried
  // again on a later tick, at most every pendingCheckMs; logged once a minute.
  let saveFailedAt = -Infinity;
  let saveFailLoggedAt = -Infinity;
  function persist(t = now()) {
    if (!dirty || t - saveFailedAt < timing.pendingCheckMs) return;
    try {
      saveState(dialog || declines.length ? { version: STATE_VERSION, dialog, declines } : null);
      dirty = false;
    } catch (err) {
      saveFailedAt = t;
      if (t - saveFailLoggedAt >= 60_000) {
        saveFailLoggedAt = t;
        log(`Dialog watch: state not saved (${clip(err?.message, 160)}); tried again later`);
      }
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
    if (d.escape === 'queued') declines.push({ sessionRef: d.sessionRef, id: d.id, title: d.title, notice: d.notice,
      since: d.since, goneAt: t });
  }

  // A decline is announced only once its Escape is acknowledged as sent to
  // that prompt (`done`) and the prompt is gone; a still-pending Escape is
  // withdrawn instead, a claimed one waited for.
  function resolveDeclines(sessionRef, t) {
    const before = declines.length;
    declines = declines.filter((d) => {
      // The Escape, its id and status come from the queue, scoped to this
      // persona, pane and prompt; never from saved state.
      const own = ownControl(d.sessionRef, d.id, 'escape');
      if (!own) {
        log('Dialog watch: a decline\'s Escape is not confirmed by the queue (kind escape); ignored');
        return false;
      }
      const { id: escapeId, status } = own;
      if (status === 'running' || (status === 'pending' && !withdrawOwnControl({ id: escapeId, sessionRef: d.sessionRef, dialogRef: d.id, kind: 'escape' }))) {
        if (t - d.goneAt < timing.declineResolveMs) return true;
        log(`Dialog watch: Escape control ${escapeId} still ${status} ${seconds(t - d.goneAt)}s after its prompt closed; no decline message`);
        return false;
      }
      if (status === 'pending') {
        log(`Dialog watch: permission prompt closed by itself after ${seconds(d.goneAt - d.since)}s; Escape control ${escapeId} withdrawn`);
        return false;
      }
      if (status !== 'done') {
        log(`Dialog watch: Escape control ${escapeId} ended ${status}; no decline message`);
        return false;
      }
      // Only the session whose prompt was declined is told; the message is
      // bound to it through delivery. Not before the binding is enforced.
      const notEnforced = () => {
        if (t - d.goneAt < timing.declineResolveMs) return true;
        log(`Dialog watch: decline of control ${escapeId} not announced: the binding is not enforced by the running processes`);
        return false;
      };
      if (!mayQueue(t)) return notEnforced();
      if (sessionRef !== d.sessionRef) {
        log(`Dialog watch: session replaced after the decline of control ${escapeId}; no decline message`);
        return false;
      }
      const res = enqueueNotice(formatDeclinedNotice({ title: d.title, notice: d.notice }), d.sessionRef, d.id);
      if (refused(t, res)) return notEnforced();
      if (res?.ok) noteCapable(true);
      log(!res?.ok ? `Dialog watch: decline message not queued (${clip(res?.output, 160)})`
        : res.existing ? `Dialog watch: decline already announced (control ${res.id})`
          : `Dialog watch: session told its tool call was declined (control ${res.id ?? '?'})`);
      return false;
    });
    if (declines.length !== before) changed();
  }

  function maybeEscape(t) {
    if (dialog.escape !== 'pending' || !dialog.sessionRef || !dialog.id) return;
    // One Escape per prompt, decided by the queue: an Escape already queued
    // for this persona, pane and prompt (before a monitor restart) is adopted.
    const existing = ownControl(dialog.sessionRef, dialog.id, 'escape');
    if (existing) {
      Object.assign(dialog, { escape: 'queued', escapeId: existing.id, escapeAt: dialog.escapeAt || t });
      changed();
      log(`Dialog watch: ${describe(dialog)}: Escape control ${existing.id} already queued; not queued again`);
      return;
    }
    if (t - dialog.since < timing.permissionGraceMs) return;
    const withhold = () => {
      if (!dialog.withheld) { dialog.withheld = true; changed(); log(`Dialog watch: Escape for ${describe(dialog)} withheld (binding not enforced)`); }
    };
    if (!mayQueue(t)) return withhold();
    // One attempt per prompt. A failed enqueue is not repeated; the alert
    // says so if the prompt stays. The queue keeps at most one Escape per
    // persona, pane and prompt: an existing one is adopted, never doubled.
    // A refusal (the binding no longer enforced at insert time) is not a
    // failure: the Escape stays withheld and is tried again later.
    const res = enqueueKey('Escape', dialog.sessionRef, dialog.id);
    if (refused(t, res)) return withhold();
    if (res?.ok) noteCapable(true);
    dialog.escape = res?.ok ? 'queued' : 'failed';
    dialog.withheld = false;
    dialog.escapeAt = t;
    dialog.escapeId = res?.ok ? res.id ?? null : null;
    changed();
    log(!res?.ok ? `Dialog watch: Escape for ${describe(dialog)} not queued (${clip(res?.output, 160)})`
      : res.existing ? `Dialog watch: ${describe(dialog)}: Escape control ${res.id} already queued; not queued again`
        : `Dialog watch: ${describe(dialog)} on screen ${seconds(t - dialog.since)}s; Escape queued (control ${dialog.escapeId ?? '?'})`);
  }

  // Whether the queued Escape went out, while its prompt is still up (from
  // the queue, scoped). A sent time saved before a restart is kept only once
  // the queue confirms the Escape was sent.
  function trackEscape(t) {
    if (dialog.escape !== 'queued' || dialog.escapeSentAt || dialog.escapeEnded) return;
    const own = ownControl(dialog.sessionRef, dialog.id, 'escape');
    const status = own?.status ?? 'missing';
    if (status === 'done') {
      dialog.escapeSentAt = dialog.savedEscapeSentAt && dialog.savedEscapeSentAt >= dialog.since ? dialog.savedEscapeSentAt : t;
      changed();
    } else if (status !== 'pending' && status !== 'running') { dialog.escapeEnded = status; changed(); }
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
    // A permission prompt blocks the session even with nothing queued: alert
    // 5 min after its Escape went out (or was queued, or, when none could be
    // queued, would have been).
    if (isPermission(d)) due.push((d.escapeSentAt || d.escapeAt || d.since + timing.permissionGraceMs) + timing.heldAlertAfterMs);
    if (!due.length || t < Math.min(...due) || (d.alertDueAt || 0) > t) return;
    const escape = d.escape === 'queued' ? (d.escapeSentAt ? 'sent' : 'queued')
      : d.escape === 'pending' && d.withheld ? 'withheld' : d.escape;
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
