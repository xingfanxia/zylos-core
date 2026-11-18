// DELIVER-1: on a database without the dialog-binding schema (pre-005, its
// migration blocked) the dialog watch stays observe-and-alert, exactly as
// when no capability is published: no Escape, no decline, no state read or
// written, and the prompt is still reported and counted as stuck. Real c4-db,
// real watch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-watch-pre005-'));
process.env.ZYLOS_DIR = root;
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });

const db = await import('../../../comm-bridge/scripts/c4-db.js');
const { makePre005Blocked, schemaFacts } = await import('../../../comm-bridge/scripts/__tests__/fixtures/pre005-db.js');
const { createDialogWatch, bindDialogWatchQueue } = await import('../dialog-watch.js');
const { detectModal } = await import('../../../comm-bridge/scripts/tmux-input-state.js');
const fx = await import('../../../comm-bridge/scripts/__tests__/fixtures/claude-dialogs.js');
const file = path.join(root, 'comm-bridge', 'c4.db');
db.getDb();
db.close();
makePre005Blocked(file);
after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); });

const PAN_PANE = '$5:1763400000:%7:4242';
const PROMPT = detectModal(fx.DANGEROUS_RM_PROMPT);
const T0 = Date.now();
const SEC = 1000;

it('on a pre-005 database with a blocked migration the watch only observes and alerts, as without a published capability', async () => {
  const logs = [];
  const alerts = [];
  const clock = { t: T0 };
  const watch = createDialogWatch({
    instanceId: 'user-pan',
    ...bindDialogWatchQueue({ instanceId: 'user-pan', db }),
    notifyOperator: async (message) => { alerts.push(message); return { ok: true }; },
    log: (line) => logs.push(line),
    now: () => clock.t,
  });
  db.insertConversation('in', 'feishu', 'chat', 'held behind the prompt', null, 3, false, null, 'user-pan');
  for (; clock.t <= T0 + 12 * 60 * SEC; clock.t += SEC) {
    watch.tick({ sessionState: 'idle', healthOk: true, modal: PROMPT, sessionRef: PAN_PANE });
    await watch.settled();
  }
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM control_queue').get().n, 0, 'no Escape, no decline');
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.match(alerts[0], /没有发送 Esc/);
  assert.ok(watch.deliveryStuck(), 'and the held message shows as stuck');
  assert.ok(logs.some((l) => /withheld \(binding not enforced\)/.test(l)));
  assert.ok(logs.every((l) => !/unreadable|failed|no such/i.test(l)), logs.join('\n'));
  assert.deepEqual(schemaFacts(file), { dialogRef: false, tables: [], capabilities: [] });
});
