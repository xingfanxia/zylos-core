// Review-3 #1: a claim's age does not prove that its executor stopped.
// Ownership is the executor process (pid + start identity + host); a claim is
// taken over only when that process is provably gone, and every executor
// re-checks that it still holds the claim right before each irreversible
// effect (tmux kill, pm2 restart / stop).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { executeFableRestarts } from '../fable-guard.js';
import { executionClaimPath } from '../fable-exec-claim.js';
import { createFableMonitor } from '../fable-monitor.js';
import { fableGuardStatePath, fableUsagePath, prepareFableLaunch, resolveRuntimeProfile } from '../../../multi-session/runtime-files.js';

const T0 = Date.parse('2026-11-10T08:00:00Z');
const MIN = 60_000;
const BACKUP = 'claude-ax-backup';
const FABLE = 'claude-fable-5-2[1m]';
const OPUS = 'claude-opus-5-5[1m]';
const GUARD_MODULE = new URL('../fable-guard.js', import.meta.url).href;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });

function tempZylos(generation = 5) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-exec-claim-'));
  cleanup.push(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
  writeGeneration(zylosDir, generation);
  return zylosDir;
}

function writeGeneration(zylosDir, generation) {
  const file = fableGuardStatePath(zylosDir);
  let state = { version: 1, personas: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
  state.personas['user-pan'] = { ...(state.personas['user-pan'] || {}), desired: { generation, mode: 'opus', account: BACKUP } };
  fs.writeFileSync(file, JSON.stringify(state));
}

const restart = (generation, extra = {}) => ({ instanceId: 'user-pan', generation, attempt: 1, kind: 'restart', mode: 'opus',
  profileId: BACKUP, reason: 'x', tmuxSession: 'claude-user-pan', ...extra });
const readClaim = zylosDir => JSON.parse(fs.readFileSync(executionClaimPath(zylosDir, 'user-pan'), 'utf8'));
const effects = calls => calls.filter(call => /^(tmux kill-session|pm2 )/.test(call));

/** Another live process on this host (a stand-in for a second executor). */
function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child.pid;
}

/** The start identity the claim records for `pid`, as read by a fresh process. */
function startIdentityOf(pid) {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { processStartIdentity } from ${JSON.stringify(new URL('../fable-exec-claim.js', import.meta.url).href)};`
    + `process.stdout.write(String(processStartIdentity(${pid})));`], { encoding: 'utf8' });
  return out.stdout;
}

function writeRunningClaim(zylosDir, executor, atMs) {
  const file = executionClaimPath(zylosDir, 'user-pan');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ current: { owner: 'daemon', kind: 'restart', generation: 4, attempt: 1,
    key: 'restart:g4:a1:-:-:-:-', token: 'held-by-other', status: 'running', at: new Date(atMs).toISOString(), at_ms: atMs,
    ...(executor ? { executor } : {}) }, history: [], deferred: [] }));
}

describe('Fable execution claim: owner liveness, not age (review-3 #1)', () => {
  it('pause old execution, grant newer generation at +91 s, resume old: only one executor reaches pm2 restart', () => {
    const zylosDir = tempZylos(5);
    const childCalls = path.join(zylosDir, 'child-calls.txt');
    // Execution B runs in ANOTHER process, 91 s later, for the newer generation g6.
    const childScript = `
      import fs from 'node:fs';
      import { executeFableRestarts } from ${JSON.stringify(GUARD_MODULE)};
      const [zylosDir, out] = process.argv.slice(1);
      const exec = (file, args) => { fs.appendFileSync(out, [file, ...args].join(' ') + '\\n'); return ''; };
      executeFableRestarts({ zylosDir, nowMs: ${T0 + 91_000}, now: () => ${T0 + 91_000}, owner: 'daemon', log: () => {},
        execFileSyncImpl: exec, restarts: [{ instanceId: 'user-pan', generation: 6, attempt: 1, kind: 'restart', mode: 'opus',
          profileId: '${BACKUP}', reason: 'y', tmuxSession: 'claude-user-pan' }] });`;
    const calls = [];
    let paused = false;
    const exec = (file, args) => {
      const call = [file, ...args].join(' ');
      calls.push(call);
      if (!paused && call === 'tmux kill-session -t claude-user-pan') {
        // Execution A is paused here, between its kill and its pm2 restart; meanwhile
        // a newer generation is committed and another executor runs it 91 s later.
        paused = true;
        writeGeneration(zylosDir, 6);
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, zylosDir, childCalls],
          { encoding: 'utf8', cwd: HERE });
        assert.equal(child.status, 0, child.stderr);
      }
      return '';
    };
    executeFableRestarts({ zylosDir, restarts: [restart(5)], nowMs: T0, now: () => T0, execFileSyncImpl: exec, log: () => {},
      owner: 'reconcile' });
    assert.equal(paused, true);
    const other = fs.existsSync(childCalls) ? fs.readFileSync(childCalls, 'utf8').trim().split('\n').filter(Boolean) : [];
    const restarts = [...effects(calls), ...effects(other)].filter(call => call.startsWith('pm2 restart'));
    assert.equal(restarts.length, 1, `two executors restarted the persona: A=${effects(calls)} B=${effects(other)}`);
    assert.deepEqual(effects(other), [], 'the newer executor waits while the live owner holds the claim');
  });

  it('a running claim of a live executor is never taken over, however old', () => {
    const zylosDir = tempZylos(5);
    const pid = liveProcess();
    writeRunningClaim(zylosDir, { pid, start: startIdentityOf(pid), host: os.hostname() }, T0 - 30 * MIN);
    const calls = [];
    const logs = [];
    executeFableRestarts({ zylosDir, restarts: [restart(5)], nowMs: T0, execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; },
      log: line => logs.push(line) });
    assert.deepEqual(effects(calls), []);
    assert.equal(readClaim(zylosDir).current.token, 'held-by-other');
    assert.ok(logs.some(line => /busy:daemon:restart/.test(line)), logs.join('\n'));
  });

  it('executor crash: a claim whose owner process is gone is recovered at once', () => {
    const zylosDir = tempZylos(5);
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // exited
    writeRunningClaim(zylosDir, { pid: dead, start: 'ps:gone', host: os.hostname() }, T0);
    const calls = [];
    executeFableRestarts({ zylosDir, restarts: [restart(5)], nowMs: T0 + 1000, execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; },
      log: () => {} });
    assert.deepEqual(effects(calls), ['tmux kill-session -t claude-user-pan', 'pm2 restart activity-monitor-user-pan --update-env']);
    const doc = readClaim(zylosDir);
    assert.equal(doc.history[0].token, 'held-by-other');
    assert.equal(doc.history[0].status, 'interrupted');
    assert.equal(doc.current.status, 'done');
  });

  it('reboot / pid reuse: a live pid with a different start identity is not the owner', () => {
    const zylosDir = tempZylos(5);
    const pid = liveProcess(); // the pid now belongs to an unrelated process
    writeRunningClaim(zylosDir, { pid, start: 'linux:0d1e-previous-boot:4242', host: os.hostname() }, T0);
    const calls = [];
    executeFableRestarts({ zylosDir, restarts: [restart(5)], nowMs: T0 + 1000, execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; },
      log: () => {} });
    assert.equal(effects(calls).length, 2);
    assert.equal(readClaim(zylosDir).history[0].status, 'interrupted');
  });

  it('a claim recorded by another host is not judged from here', () => {
    const zylosDir = tempZylos(5);
    writeRunningClaim(zylosDir, { pid: process.ppid, start: startIdentityOf(process.ppid), host: `${os.hostname()}-other` }, T0 - 30 * MIN);
    const calls = [];
    executeFableRestarts({ zylosDir, restarts: [restart(5)], nowMs: T0, execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; },
      log: () => {} });
    assert.deepEqual(effects(calls), []);
  });

  it('an unrecorded (pre-upgrade) running claim is still recovered after the stale age', () => {
    const zylosDir = tempZylos(5);
    writeRunningClaim(zylosDir, null, Date.now() - 5 * MIN);
    const calls = [];
    executeFableRestarts({ zylosDir, restarts: [restart(5)], execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; },
      log: () => {} });
    assert.equal(effects(calls).length, 2);
  });

  for (const kind of ['restart', 'stop']) {
    it(`an executor that lost its claim stops before the irreversible ${kind} effects`, () => {
      const zylosDir = tempZylos(5);
      // Right after A acquired the claim and left the fenced section, the claim
      // passes to someone else (an operator, or a recovery that judged A gone).
      const lock = (lockPath, fn) => {
        const result = fn();
        const doc = JSON.parse(fs.readFileSync(executionClaimPath(zylosDir, 'user-pan'), 'utf8'));
        doc.current = { ...doc.current, token: 'someone-else', owner: 'monitor' };
        fs.writeFileSync(executionClaimPath(zylosDir, 'user-pan'), JSON.stringify(doc));
        return result;
      };
      const calls = [];
      const logs = [];
      const done = executeFableRestarts({ zylosDir, restarts: [kind === 'stop' ? { ...restart(5), kind: 'stop' } : restart(5)], nowMs: T0,
        execFileSyncImpl: (f, a) => { calls.push([f, ...a].join(' ')); return ''; }, log: line => logs.push(line), lock });
      assert.deepEqual(effects(calls), []);
      assert.deepEqual(done, []);
      assert.ok(logs.some(line => /lost its execution claim/.test(line)), logs.join('\n'));
    });
  }

  it('stamps the claim with the time it was acquired, not the pass start', () => {
    const zylosDir = tempZylos(5);
    const state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8'));
    state.personas['user-elaine'] = { desired: { generation: 7, mode: 'opus', account: BACKUP } };
    fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(state));
    const clock = { now: T0 };
    // pan's restart takes 40 s; elaine's claim is acquired after it.
    const exec = (file, args) => { if (file === 'pm2' && args[1] === 'activity-monitor-user-pan') clock.now += 40_000; return ''; };
    executeFableRestarts({ zylosDir, nowMs: T0, now: () => clock.now, execFileSyncImpl: exec, log: () => {},
      restarts: [restart(5), { ...restart(7), instanceId: 'user-elaine', tmuxSession: 'claude-user-elaine' }] });
    const elaine = JSON.parse(fs.readFileSync(executionClaimPath(zylosDir, 'user-elaine'), 'utf8')).current;
    assert.equal(elaine.at_ms, T0 + 40_000);
    const persona = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')).personas['user-elaine'];
    assert.equal(persona.executing.at, new Date(T0 + 40_000).toISOString());
  });
});

describe('Fable lease enforcement re-checks its claim before the stop (review-3 #1)', () => {
  it('a monitor whose claim was taken after acquisition does not kill the session', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-exec-monitor-'));
    cleanup.push(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
    const document = { fable_guard: { fable_model: FABLE },
      runtime_profiles: { [BACKUP]: { runtime: 'claude', usage_provider: BACKUP, model: OPUS, reasoning_effort: 'high',
        claude_settings_file: '/home/zylos-shared/auth/claude-ax-backup.settings.json' } },
      instances: { 'user-pan': { runtime: 'claude', runtime_profile: BACKUP, fable_enabled: true } } };
    const monitorDir = path.join(zylosDir, 'activity-monitor', 'user-pan');
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(document));
    fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify({ version: 1, generation_seq: 3, holds: {},
      personas: { 'user-pan': { desired: { account: BACKUP, mode: 'fable', generation: 3 } } } }));
    fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify({ version: 1, accounts: { [BACKUP]: { last_valid: { utilization: 0.1,
      resets_at: '2026-11-13T06:00:00.000Z', observed_at: new Date(T0).toISOString() } } } }));
    const profile = resolveRuntimeProfile({ document, instanceId: 'user-pan',
      fableGuardState: JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')),
      fableUsage: JSON.parse(fs.readFileSync(fableUsagePath(zylosDir), 'utf8')), nowMs: T0 });
    prepareFableLaunch({ profile, instanceId: 'user-pan', zylosDir, monitorDir, nowMs: T0 });
    const ref = '$3:1762790000:%12:48211';
    const stops = [];
    const logs = [];
    let hijacked = false;
    const lock = (lockPath, fn) => {
      const result = fn();
      if (!hijacked && lockPath.includes('fable-exec')) {
        hijacked = true; // the claim passes to someone else right after the monitor acquired it
        const file = executionClaimPath(zylosDir, 'user-pan');
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.current = { ...doc.current, token: 'someone-else', owner: 'daemon' };
        fs.writeFileSync(file, JSON.stringify(doc));
      }
      return result;
    };
    const clock = { now: T0 + 13 * MIN };
    const monitor = createFableMonitor({ zylosDir, instanceId: 'user-pan', monitorDir, runtimeProfile: profile,
      readSessionRef: () => ref, probeSession: () => 'present', readProcessModel: () => ({ model: 'claude-fable-5-2' }),
      stopSession: target => stops.push(target), now: () => clock.now, log: line => logs.push(line), lock });
    monitor.tick();
    clock.now += 3 * MIN;
    monitor.tick();
    assert.equal(hijacked, true);
    assert.deepEqual(stops, [], logs.join('\n'));
    assert.ok(logs.some(line => /lost its execution claim/.test(line)), logs.join('\n'));
  });
});
