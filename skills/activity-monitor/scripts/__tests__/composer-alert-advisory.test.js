// PASTE-STRAND-1 review (i) 1: the composer alert is advisory. It must not
// change what intake reads: with a healthy engine, 61 s of the incident frame
// and nothing waiting, agent-status.json is what the deployed monitor writes
// for that tick, and the real c4-receive (no monitor socket, so it reads that
// file) leaves a replyable inbound row pending, as on the deployed head.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createDialogWatch } from '../dialog-watch.js';
import { writeStatus } from '../status-writer.js';
import { readTmuxInputState } from '../../../comm-bridge/scripts/tmux-input-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-advisory-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SEC = 1000;
const T0 = Date.parse('2026-11-19T04:00:00Z');
const PANE = '$5:1763400000:%7:4242';
// The incident frame (CLI 2.1.327 at 80x24, harmless text), as the deployed reader reads it.
const RULE = '─'.repeat(80);
const FIXTURE = 'harmless fixture words harmless fixture words harmless fixture words';
const SCROLLED = [
  '', ' ▐▛███▛█   Claude Code v2.1.327', '▝▜██████▀  Opus 5.5 · API Usage Billing', ' ▝▝   ▝▝   /…/work', '',
  ...Array(8).fill(''), '                                                            ◐ medium · /effort',
  `─── ↑ 4 more ${'─'.repeat(67)}`, ...Array(6).fill(`  ${FIXTURE}`), `  ${FIXTURE} h`,
  RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
const frame = readTmuxInputState({ sessionName: 's', execFileSyncImpl: () =>
  `${SCROLLED.join('\n')}\n__ZYLOS_CURSOR__ 72 21 $5 1763400000 %7 4242\n` });

function watch() {
  const w = { t: T0, alerts: [] };
  w.watch = createDialogWatch({ instanceId: null, now: () => w.t, enqueueKey: () => ({ ok: true }), findOwnControl: () => null,
    withdrawOwnControl: () => false, enqueueNotice: () => ({ ok: true }),
    readHeld: () => ({ count: 0, oldestAt: null, conversations: 0, controls: 0 }),
    notifyOperator: async (message) => { w.alerts.push(message); return { ok: true }; }, log: () => {}, countFailedSince: () => 0 });
  return w;
}

describe('the composer alert is advisory: agent-status.json and intake are as on the deployed head', () => {
  it('61 s of the incident frame: the status file is byte-equal to the one the deployed monitor writes; the alert is sent', async () => {
    assert.equal(frame.inputState, 'indeterminate');
    const candidate = watch();
    const deployed = watch(); // the deployed monitor passed no composer state
    for (; candidate.t <= T0 + 61 * SEC; candidate.t += SEC, deployed.t += SEC) {
      candidate.watch.tick({ modal: frame.modal, sessionRef: PANE, captureOk: frame.captureOk, sessionState: 'idle', healthOk: true, composer: frame.inputState });
      deployed.watch.tick({ modal: frame.modal, sessionRef: PANE, captureOk: frame.captureOk, sessionState: 'idle', healthOk: true });
      await candidate.watch.settled();
    }
    assert.equal(candidate.alerts.length, 1, 'the operator alert stays');
    const statusObj = { state: 'idle', thinking: false, last_activity: 1763524800, active_tools: 0, last_check: 1763524861,
      last_check_human: '2026-11-19 04:01:01', idle_seconds: 61, inactive_seconds: 61, source: 'conversation', runtime_launch_at: 1763520000000 };
    const healthEngine = { health: 'ok' };
    const files = ['candidate', 'deployed'].map((name) => path.join(root, `${name}-agent-status.json`));
    writeStatus({ statusFile: files[0], statusObj, healthEngine, deliveryStuck: candidate.watch.deliveryStuck() });
    writeStatus({ statusFile: files[1], statusObj, healthEngine, deliveryStuck: deployed.watch.deliveryStuck() });
    fs.copyFileSync(files[0], path.join(root, 'candidate-status-for-intake.json'));
    assert.equal(fs.readFileSync(files[0], 'utf8'), fs.readFileSync(files[1], 'utf8'));
    const written = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(written.health, 'ok');
    assert.equal(written.unavailable_reason, undefined);
    assert.equal(written.delivery_stuck, undefined);
  });

  it('the real c4-receive against that status file, with no monitor socket, leaves a replyable row pending and sends no notice', () => {
    const zylos = path.join(root, 'zylos');
    for (const dir of ['activity-monitor', 'comm-bridge', 'home', 'bin']) fs.mkdirSync(path.join(zylos, dir), { recursive: true });
    fs.copyFileSync(path.join(root, 'candidate-status-for-intake.json'), path.join(zylos, 'activity-monitor', 'agent-status.json'));
    fs.symlinkSync(process.execPath, path.join(zylos, 'bin', 'node'));
    fs.writeFileSync(path.join(zylos, 'package.json'), '{"type":"module"}\n');
    // The channel's send script records any notice c4-receive would send the user.
    const scripts = path.join(zylos, '.claude', 'skills', 'telegram', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'send.js'), `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(zylos, 'notice-sent.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
    const cli = path.join(here, '../../../comm-bridge/scripts/c4-receive.js');
    const result = spawnSync(process.execPath, [cli, '--channel', 'telegram', '--endpoint', 'chat-1', '--json', '--content', 'a harmless message'], {
      cwd: zylos, encoding: 'utf8', timeout: 20_000,
      env: { ZYLOS_DIR: zylos, HOME: path.join(zylos, 'home'), PATH: path.join(zylos, 'bin'), TZ: 'UTC', LANG: 'C' },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(out.ok, true, result.stdout);
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.env.ZYLOS_DIR = ${JSON.stringify(zylos)};
      const db = await import(${JSON.stringify(path.join(here, '../../../comm-bridge/scripts/c4-db.js'))});
      process.stdout.write(JSON.stringify(db.getDb().prepare("SELECT direction, status, endpoint_id FROM conversations ORDER BY id").all()));
      db.close();`], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(probe.stdout), [{ direction: 'in', status: 'pending', endpoint_id: 'chat-1' }],
      'pending, not failed, and no outbound status notice');
    assert.equal(fs.existsSync(path.join(zylos, 'notice-sent.json')), false, 'no notice was sent to the user');
  });
});
