// A fake tmux pane for delivery tests: it answers the dispatcher's real
// capture-pane/display-message read with a Claude Code screen rendered from
// its own state, and applies set-buffer / paste-buffer / send-keys to that
// state. Every tmux call is recorded verbatim, so a test can compare the whole
// call sequence (reads included) byte for byte.
import { RULE } from './claude-dialogs.js';

const TRANSCRIPT = ['❯ Heartbeat check. [phase=primary]', '', '⏺ Acknowledged.', ''];

export function paneModel({
  pane = '%2', sessionId = '$1', created = 1000, pid = 123,
  enterTakesAfter = 1, // the Nth Enter clears the composer
  pasteVisibleAfterReads = 0, // reads after the paste that still show an empty composer
} = {}) {
  let composer = '';
  let buffer = '';
  let hiddenReads = 0;
  let enters = 0;
  const calls = [];
  const render = () => {
    const shown = hiddenReads > 0 ? '' : composer;
    if (hiddenReads > 0) hiddenReads--;
    const lines = [...TRANSCRIPT, RULE, `❯ ${shown}`, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
    const promptY = TRANSCRIPT.length + 1;
    const cursorX = 2 + Array.from(shown).length;
    return `${lines.join('\n')}\n__ZYLOS_CURSOR__ ${cursorX} ${promptY} ${sessionId} ${created} ${pane} ${pid}\n`;
  };
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command !== 'tmux') return '';
    if (args[0] === 'capture-pane') return render();
    if (args[0] === 'set-buffer') buffer = args[args.length - 1];
    if (args[0] === 'paste-buffer') { composer = buffer; hiddenReads = pasteVisibleAfterReads; }
    if (args[0] === 'send-keys' && args[args.length - 1] === 'Enter') {
      enters++;
      if (enters >= enterTakesAfter) composer = '';
    }
    return '';
  };
  return { exec, calls, sessionRef: `${sessionId}:${created}:${pane}:${pid}` };
}

// Buffer names carry the pid and a timestamp; everything else is compared as is.
export function normalizeCalls(calls) {
  return calls.map((call) => call.map((arg) => String(arg).replace(/^c4-msg-\d+-\d+$/, 'c4-msg-<pid>-<ms>')));
}

export const DELIVERY_SCENARIOS = Object.freeze({
  plain: { model: {}, messages: ['hello from feishu'] },
  enter_retry: { model: { enterTakesAfter: 2 }, messages: ['hello from feishu'] },
  slow_paste: { model: { pasteVisibleAfterReads: 2 }, messages: ['hello from feishu'] },
  two_messages: { model: {}, messages: ['first message', 'second message'] },
});

// Scenario runners shared by the base-sequence recorder and the D test, so the
// recorded base sequence and the checked one come from the same driver.
export async function runSingleScenario(sendToTmux, scenario) {
  const model = paneModel(scenario.model);
  const options = { session: 'claude-user-pan', runtime: 'claude', execFileSyncImpl: model.exec, sleepImpl: async () => {},
    pendingSubmissions: new Map(), submissionReceipts: new Map() };
  const results = [];
  for (const [i, message] of scenario.messages.entries()) {
    results.push(await sendToTmux(message, { ...options, deliveryId: `conversation:${i + 1}` }));
  }
  return { results, calls: normalizeCalls(model.calls) };
}

function multiHelpers(rows, delivered, extraHelpers) {
  return {
    getAgentState: () => ({ state: 'idle', health: 'ok', idleSeconds: 10, healthy: true }),
    isStatusFresh: () => true, isAgentStatusFresh: () => true, isBypassState: (item) => item.bypass_state === 1,
    shouldAutoAckHeartbeat: () => false, waitForRequireIdleSettlement: async () => {},
    readProcState: () => ({ alive: true }), isAgentConfirmedActive: () => false, log: () => {}, sleep: async () => {},
    nowSeconds: () => 0, getDeliveryContent: (item) => item.content, markRejected: () => {}, markControlRejected: () => {},
    getNextPendingForInstances: () => null, getPendingTargetInstancesNeedingWake: () => [],
    getNextPendingControlForInstances: () => null,
    claimNextItem: () => {
      const row = rows.find((r) => r.status === 'pending');
      if (!row) return null;
      row.status = 'running';
      return { ...row };
    },
    releaseItem: (item) => { rows.find((r) => r.id === item.id).status = 'pending'; },
    markDelivered: (id) => { delivered.push(id); rows.find((r) => r.id === id).status = 'delivered'; },
    ackControl: (id) => { delivered.push(id); rows.find((r) => r.id === id).status = 'done'; },
    handleConversationDeliveryFailure: async () => {}, handleControlDeliveryFailure: async () => {},
    notifyMessageDelivered: () => Promise.resolve(),
    ...extraHelpers,
  };
}

// A [KEYSTROKE] control through processWithMultiSession, wired with the given
// dispatcher module's own helpers. sendKeystroke issues exactly the
// dispatcher's call (`send-keys -t <session> <key>`). When the dispatcher
// reads the pane before a key (readKeystrokeTarget), that read goes to the same
// fake pane; the DB binding is stubbed as "bound to the pane on screen".
export async function runMultiKeystroke(dispatcher, processWithMultiSession, { instance = 'user-pan', key = 'Escape' } = {}) {
  const model = paneModel();
  const rows = [{ id: 8, type: 'control', priority: 0, bypass_state: 1, target_instance: instance,
    content: `[KEYSTROKE]${key}`, status: 'pending', created_at: 2000 }];
  const delivered = [];
  const fenced = typeof dispatcher.readKeystrokeTarget === 'function' ? {
    readKeystrokeTarget: (session) => dispatcher.readKeystrokeTarget(session, { execFileSyncImpl: model.exec }),
    fenceKeystrokeControl: (item, target) => dispatcher.fenceKeystrokeControl(item, target,
      { bind: () => ({ sessionRef: target.sessionRef, stamped: false }) }),
    supersedeControl: () => true,
  } : {};
  const helpers = multiHelpers(rows, delivered, {
    isKeystrokeControl: dispatcher.isKeystrokeControl, parseKeystrokeKey: dispatcher.parseKeystrokeKey,
    sendKeystroke: (target, k) => model.exec('tmux', ['send-keys', '-t', target, k]),
    sendToTmux: async () => { throw new Error('a keystroke is never pasted'); },
    ...fenced,
  });
  const result = await processWithMultiSession(helpers);
  return { delivered: result.delivered, rows: delivered, calls: normalizeCalls(model.calls) };
}

export async function runMultiConversation(sendToTmux, processWithMultiSession, extraHelpers = {},
  { instance = 'user-pan', runtime = 'claude' } = {}) {
  const model = paneModel();
  const rows = [{ id: 42, type: 'conversation', channel: 'feishu', endpoint_id: 'chat-1', target_instance: instance,
    content: 'hello from feishu', status: 'pending' }];
  const delivered = [];
  const submissions = new Map();
  const receipts = new Map();
  const helpers = multiHelpers(rows, delivered, {
    sendToTmux: (message, opts) => sendToTmux(message, { ...opts, ...(runtime ? { runtime } : {}), execFileSyncImpl: model.exec,
      sleepImpl: async () => {}, pendingSubmissions: submissions, submissionReceipts: receipts }),
    ...extraHelpers,
  });
  const result = await processWithMultiSession(helpers);
  return { delivered: result.delivered, rows: delivered, calls: normalizeCalls(model.calls) };
}
