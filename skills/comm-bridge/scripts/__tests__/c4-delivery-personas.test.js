// The delivery guard is global for Claude: every persona's pane, whether or
// not the Fable allowance guard is configured (Astra #5, scope). With no modal
// on screen, each of six personas gets the base d16221a4 tmux call sequence for
// a conversation (session name normalized), and a [KEYSTROKE] key gets the
// base key call preceded by exactly one standard pane read — under an
// instances.json with the Fable guard configured and with it absent. The
// dispatcher resolves each session's runtime from that file (runtime not
// injected).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-personas-'));
process.env.ZYLOS_DIR = root;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;
fs.mkdirSync(path.join(root, '.zylos'));
fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));

const PERSONAS = ['admin', 'user-pan', 'user-elaine', 'user-ops', 'user-research', 'group'];
const FABLE = new Set(['user-pan', 'user-elaine']);
function writeInstances({ guard }) {
  const instances = {};
  for (const [i, id] of PERSONAS.entries()) {
    fs.mkdirSync(path.join(root, 'state', id), { recursive: true });
    instances[id] = { primary: i === 0, enabled: true, runtime: 'claude', tmux_session: `claude-${id}`,
      state_dir: path.join(root, 'state', id), runtime_profile: FABLE.has(id) ? 'ax-backup' : 'ax-main',
      ...(guard && FABLE.has(id) ? { fable_enabled: true } : {}) };
  }
  const document = { version: 1, instances,
    runtime_profiles: { 'ax-main': { runtime: 'claude' }, 'ax-backup': { runtime: 'claude' } } };
  if (guard) document.fable_guard = { fable_model: 'claude-fable-5-2', probe_accounts: ['ax-backup'] };
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify(document));
}

const dispatcher = await import('../c4-dispatcher.js');
const { processWithMultiSession } = await import('../c4-dispatcher-multi.js');
const model = await import('./fixtures/tmux-pane-model.js');
const base = JSON.parse(fs.readFileSync(new URL('./fixtures/base-delivery-calls.d16221a.json', import.meta.url), 'utf8'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const sessionNeutral = (calls, session) => calls.map((call) => call.map((arg) => (arg === session ? '<session>' : arg)));
const isRead = (call) => call[1] === 'capture-pane';

for (const guard of [true, false]) {
  describe(`six personas, Fable guard ${guard ? 'configured' : 'absent'}`, () => {
    for (const id of PERSONAS) {
      it(`${id}: conversation delivery is the base sequence`, async () => {
        writeInstances({ guard });
        const got = await model.runMultiConversation(dispatcher.sendToTmux, processWithMultiSession, {},
          { instance: id, runtime: null });
        assert.equal(got.delivered, true);
        assert.deepEqual(sessionNeutral(got.calls, `claude-${id}`),
          sessionNeutral(base.multi.conversation.calls, 'claude-user-pan'));
      });

      it(`${id}: a raw key is the base key call after exactly one pane read`, async () => {
        writeInstances({ guard });
        const got = await model.runMultiKeystroke(dispatcher, processWithMultiSession, { instance: id });
        assert.equal(got.delivered, true);
        const calls = sessionNeutral(got.calls, `claude-${id}`);
        const baseCalls = sessionNeutral(base.multi.keystroke.calls, 'claude-user-pan');
        assert.deepEqual(calls.filter((call) => !isRead(call)), baseCalls, 'key call bytes unchanged');
        assert.equal(calls.length, baseCalls.length + 1);
        assert.ok(isRead(calls[calls.length - 2]), 'the one read comes directly before the key');
        assert.deepEqual(calls[calls.length - 2], sessionNeutral(base.multi.conversation.calls, 'claude-user-pan')[0],
          'the read is the standard delivery frame read');
      });
    }
  });
}
