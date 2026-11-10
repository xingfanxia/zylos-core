import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  clearFableHold,
  executeFableRestarts,
  fableProbeAccounts,
  planFableGuard,
  scheduleFableProbes,
} from '../fable-guard.js';
import { baseModel, recordProbeResult } from '../fable-probe.js';
import {
  FABLE_GUARD_DEFAULTS,
  fableGuardStatePath,
  fableUsagePath,
  readFableGuardConfig,
  resolveFableLaunch,
} from '../../../multi-session/runtime-files.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T08:00:00Z');
const W1 = '2026-11-13T06:00:00.000Z';
const W2 = '2026-11-20T06:00:00.000Z';
const BACKUP = 'claude-ax-backup';
const CL = 'claude-ax-cl';
const FABLE = 'claude-fable-5-2[1m]';
const OPUS = 'claude-opus-5-5[1m]';
const PERSONAS = ['admin', 'scheduler', 'user-pan', 'group', 'user-elaine', 'user-sean'];
const iso = ms => new Date(ms).toISOString();

function documentFixture({ enabled = ['user-pan', 'user-elaine'], guard = {} } = {}) {
  const runtime_profiles = {
    [BACKUP]: { runtime: 'claude', usage_provider: BACKUP, claude_settings_file: '/home/zylos-shared/auth/claude-ax-backup.settings.json', model: OPUS, reasoning_effort: 'high' },
    [CL]: { runtime: 'claude', usage_provider: CL, claude_settings_file: '/home/zylos-shared/auth/claude-ax-cl.settings.json', model: OPUS, reasoning_effort: 'high' },
    'claude-ax-main': { runtime: 'claude', usage_provider: 'claude', model: OPUS, reasoning_effort: 'high' },
    'codex-subscription': { runtime: 'codex', usage_provider: 'codex', model: 'gpt-6-astra', reasoning_effort: 'medium' },
  };
  const instances = Object.fromEntries(PERSONAS.map(id => [id, {
    enabled: true, runtime: 'claude', runtime_profile: BACKUP, runtime_failover_enabled: true, tmux_session: `claude-${id}`,
    ...(enabled.includes(id) ? { fable_enabled: true } : {}),
  }]));
  return { runtime_profiles, instances, fable_guard: { fable_model: FABLE, threshold: 0.75, probe_accounts: [], ...guard } };
}

class Sim {
  constructor(document = documentFixture(), state = null) {
    this.document = document;
    this.state = state;
    this.usage = {};
    this.status = {};
    this.models = {};
    this.evidence = {};
    this.failures = {};
    this.now = T0;
    this.restarts = [];
    for (const id of PERSONAS) this.launch(id, { at: T0 - 3_600_000 });
  }
  get config() { return readFableGuardConfig(this.document); }
  observe(account, utilization, resetsAt = W1, at = this.now) {
    this.usage = recordProbeResult(this.usage, { account, nowMs: at, config: this.config || FABLE_GUARD_DEFAULTS, result: {
      outcome: 'valid', observation: { account, utilization, resets_at: resetsAt, observed_at: iso(at),
        cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed' } } });
  }
  attempt(account, outcome, extra = {}) {
    this.usage = recordProbeResult(this.usage, { account, nowMs: this.now, config: this.config || FABLE_GUARD_DEFAULTS,
      result: { outcome, reason: outcome, ...extra } });
  }
  setState(id, state, extra = {}) {
    this.status[id] = { ...this.status[id], state, health: 'ok', active_tools: 0, ...extra };
  }
  advance(ms) {
    this.now += ms;
    for (const status of Object.values(this.status)) status.last_check = Math.floor(this.now / 1000);
  }
  pass({ failover = [] } = {}) {
    const result = planFableGuard({
      document: this.document, state: this.state, usage: this.usage, statusByInstance: this.status,
      modelByInstance: this.models, evidenceByInstance: this.evidence, failuresByInstance: this.failures,
      failoverInstanceIds: new Set(failover), nowMs: this.now,
    });
    this.state = JSON.parse(JSON.stringify(result.state)); // what the daemon persists
    this.restarts.push(...result.restarts);
    return result;
  }
  // A (re)launch reads the committed state through the real launcher decision.
  launch(id, { at = this.now, model = null } = {}) {
    const profileId = this.document.instances[id].runtime_profile;
    const decision = resolveFableLaunch({ document: this.document, instanceId: id, profileId, guardState: this.state,
      usage: this.usage, nowMs: this.now });
    const launched = model || decision?.model || this.document.runtime_profiles[profileId].model;
    this.status[id] = { state: 'idle', health: 'ok', active_tools: 0, last_check: Math.floor(this.now / 1000), runtime_launch_at: at };
    this.models[id] = { model: baseModel(launched), observed_at_ms: at + 1000 };
    return { decision, launched };
  }
  launchAll(restarts) { for (const item of restarts) this.launch(item.instanceId); }
  mode(id) { return this.state?.personas?.[id]?.desired?.mode; }
  holds(account = BACKUP) { return Object.keys(this.state?.holds?.[account] || {}).sort(); }
  // Enable both Fable personas and bring them onto Fable through the normal path.
  toFable() {
    this.pass();
    for (let i = 0; i < 3; i++) {
      this.advance(5 * MIN);
      this.observe(BACKUP, 0.1);
      const result = this.pass();
      if (i < 2) assert.deepEqual(result.restarts, []);
      else this.launchAll(result.restarts);
    }
    this.pass();
    assert.equal(this.mode('user-pan'), 'fable');
    assert.equal(this.mode('user-elaine'), 'fable');
    this.restarts.length = 0;
  }
}

describe('Fable guard inert defaults', () => {
  it('does nothing when fable_guard is not configured', () => {
    const document = documentFixture();
    delete document.fable_guard;
    const result = planFableGuard({ document, state: null, nowMs: T0 });
    assert.equal(result.changed, false);
    assert.deepEqual(result.restarts, []);
    assert.equal(fableProbeAccounts(document).size, 0);
    for (const id of PERSONAS) assert.equal(resolveFableLaunch({ document, instanceId: id, profileId: BACKUP, guardState: result.state }), null);
  });

  it('with only probe_accounts set, probes without touching any persona', () => {
    const sim = new Sim(documentFixture({ enabled: [], guard: { probe_accounts: [BACKUP] } }));
    assert.deepEqual([...fableProbeAccounts(sim.document).keys()], [BACKUP]);
    const result = sim.pass();
    assert.deepEqual(result.restarts, []);
    assert.deepEqual(sim.state.personas, {});
    for (const id of PERSONAS) assert.equal(resolveFableLaunch({ document: sim.document, instanceId: id, profileId: BACKUP, guardState: sim.state }), null);
  });

  it('treats an invalid fable_model as not configured', () => {
    const document = documentFixture({ guard: { fable_model: 'bad model; rm -rf' } });
    assert.equal(readFableGuardConfig(document), null);
    assert.equal(planFableGuard({ document, state: null, nowMs: T0 }).changed, false);
  });

  it('never adds the other four personas to the guard state', () => {
    const sim = new Sim();
    sim.toFable();
    assert.deepEqual(Object.keys(sim.state.personas).sort(), ['user-elaine', 'user-pan']);
  });
});

describe('Fable guard fake-clock sequences', () => {
  it('outage -> fresh 65%: downgrade at once, upgrade only after 3 valid readings, dwell and idle', () => {
    const sim = new Sim();
    sim.toFable();
    sim.setState('user-pan', 'busy');
    sim.advance(13 * MIN); // lease is 12 minutes; no probe answered
    const down = sim.pass();
    assert.deepEqual(sim.holds(), ['stale']);
    assert.deepEqual(down.restarts.map(item => [item.instanceId, item.mode]).sort(),
      [['user-elaine', 'opus'], ['user-pan', 'opus']]);
    sim.launchAll(down.restarts);
    const downgradedAt = sim.now;
    for (let i = 0; i < 3; i++) {
      sim.advance(5 * MIN);
      sim.observe(BACKUP, 0.65);
      assert.deepEqual(sim.pass().restarts, []);
    }
    assert.deepEqual(sim.holds(), []);
    assert.equal(sim.mode('user-pan'), 'opus', 'dwell not yet elapsed');
    sim.advance(downgradedAt + 30 * MIN - sim.now);
    sim.observe(BACKUP, 0.65);
    sim.setState('user-pan', 'busy');
    const blocked = sim.pass();
    assert.deepEqual(blocked.restarts.map(item => item.instanceId), ['user-elaine'], 'a busy persona is not upgraded');
    sim.setState('user-pan', 'idle');
    assert.deepEqual(sim.pass().restarts.map(item => [item.instanceId, item.mode]), [['user-pan', 'fable']]);
  });

  it('74% stays on Fable; 75% holds the account and downgrades immediately even when busy', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.74);
    assert.deepEqual(sim.pass().restarts, []);
    sim.setState('user-pan', 'busy', { active_tools: 2 });
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.75);
    const result = sim.pass();
    assert.deepEqual(sim.holds(), ['quota']);
    assert.equal(sim.state.holds[BACKUP].quota.reset_window, W1);
    assert.deepEqual(result.restarts.map(item => item.instanceId).sort(), ['user-elaine', 'user-pan']);
    sim.launchAll(result.restarts);
    assert.equal(sim.launch('user-pan').launched, OPUS);
  });

  it('reset -> 55%: a quota hold clears only on a valid reading from a later window', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.8);
    sim.launchAll(sim.pass().restarts);
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.55, W1);
    sim.pass();
    assert.deepEqual(sim.holds(), ['quota'], 'same window never releases the latch');
    sim.advance(40 * MIN);
    sim.observe(BACKUP, 0.55, W2);
    const result = sim.pass();
    assert.deepEqual(sim.holds(), []);
    assert.deepEqual(result.restarts.map(item => [item.instanceId, item.mode]).sort(),
      [['user-elaine', 'fable'], ['user-pan', 'fable']]);
  });

  it('rejected -> missing: the quota hold survives later stale evidence', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(2 * MIN);
    sim.attempt(BACKUP, 'rejected', { resets_at: W1 });
    const result = sim.pass();
    assert.deepEqual(sim.holds(), ['quota']);
    assert.equal(sim.state.holds[BACKUP].quota.detail.source, 'probe_rejection');
    sim.launchAll(result.restarts);
    for (let i = 0; i < 4; i++) { sim.advance(5 * MIN); sim.attempt(BACKUP, 'invalid'); sim.pass(); }
    assert.deepEqual(sim.holds(), ['quota', 'stale']);
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.2, W1);
    sim.pass();
    assert.ok(sim.holds().includes('quota'));
    for (let i = 0; i < 3; i++) { sim.advance(5 * MIN); sim.observe(BACKUP, 0.1, W2); sim.pass(); }
    assert.deepEqual(sim.holds(), []);
    assert.equal(sim.mode('user-pan'), 'fable');
  });

  it('clock skew: a future-dated reading or a passed reset never extends the lease', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(5 * MIN);
    sim.observe(BACKUP, 0.1, W1, sim.now + 10 * MIN); // local clock stepped back 10 minutes
    sim.pass();
    assert.deepEqual(sim.holds(), ['stale'], 'a reading dated in the future is not a lease');
    assert.equal(sim.mode('user-pan'), 'opus');
    const late = new Sim();
    late.toFable();
    late.advance(Date.parse(W1) - late.now + 1000); // window reset passed, no newer reading
    late.observe(BACKUP, 0.1, W1, Date.parse(W1) - 60_000);
    late.pass();
    assert.deepEqual(late.holds(), ['stale']);
    assert.equal(late.mode('user-pan'), 'opus');
  });

  it('repeated generic 429s back off without extending the lease', () => {
    const sim = new Sim();
    sim.toFable();
    const leaseStart = Date.parse(sim.usage.accounts[BACKUP].last_valid.observed_at);
    sim.advance(5 * MIN);
    sim.attempt(BACKUP, 'rate_limited');
    assert.equal(Date.parse(sim.usage.accounts[BACKUP].next_probe_at), sim.now + 10 * MIN);
    sim.pass();
    assert.equal(sim.mode('user-pan'), 'fable');
    sim.advance(leaseStart + 12 * MIN - sim.now);
    const result = sim.pass();
    assert.deepEqual(sim.holds(), ['stale']);
    assert.deepEqual(result.restarts.map(item => item.instanceId).sort(), ['user-elaine', 'user-pan']);
  });

  it('keeps probing the account while every eligible persona is on Opus', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.9);
    sim.launchAll(sim.pass().restarts);
    assert.equal(sim.mode('user-pan'), 'opus');
    assert.equal(sim.mode('user-elaine'), 'opus');
    assert.deepEqual([...fableProbeAccounts(sim.document).keys()], [BACKUP]);
  });

  it('a daemon restart mid-state resumes an interrupted transition exactly once', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(MIN);
    sim.observe(BACKUP, 0.8);
    const committed = sim.pass();
    assert.equal(committed.restarts.length, 2);
    // The daemon died after committing, before any kill: Fable still runs.
    const restarted = new Sim(sim.document, JSON.parse(JSON.stringify(sim.state)));
    Object.assign(restarted, { usage: sim.usage, status: sim.status, models: sim.models, now: sim.now });
    restarted.advance(MIN);
    assert.deepEqual(restarted.pass().restarts, [], 'within the grace a restart may still be landing');
    restarted.advance(3 * MIN);
    const resumed = restarted.pass();
    assert.deepEqual(resumed.restarts.map(item => [item.instanceId, item.mode, item.reason]).sort(),
      [['user-elaine', 'opus', 'resume:no_new_launch'], ['user-pan', 'opus', 'resume:no_new_launch']]);
    restarted.launchAll(resumed.restarts);
    restarted.advance(5 * MIN);
    assert.deepEqual(restarted.pass().restarts, []);
    assert.ok(restarted.state.personas['user-pan'].verified.model_at);
  });
});

describe('Fable guard interleavings', () => {
  it('A -> B -> A account hop keeps A\'s hold and never carries it to B', () => {
    const sim = new Sim();
    sim.toFable();
    // Account failover moves pan to ax-cl in the same locked pass.
    sim.document.instances['user-pan'].runtime_profile = CL;
    const hop = sim.pass({ failover: ['user-pan'] });
    assert.deepEqual(hop.restarts, [], 'the failover restart carries the guard commit');
    assert.deepEqual([sim.state.personas['user-pan'].desired.account, sim.mode('user-pan')], [CL, 'opus']);
    assert.equal(sim.mode('user-elaine'), 'fable');
    sim.launch('user-pan');
    assert.equal(sim.models['user-pan'].model, 'claude-opus-5-5');
    sim.observe(BACKUP, 0.9);
    sim.launchAll(sim.pass().restarts);
    assert.deepEqual(sim.holds(BACKUP), ['quota']);
    for (let i = 0; i < 6; i++) { sim.advance(5 * MIN); sim.observe(CL, 0.1); sim.observe(BACKUP, 0.9); sim.launchAll(sim.pass().restarts); }
    assert.deepEqual(sim.holds(CL), []);
    assert.equal(sim.mode('user-pan'), 'fable', 'B is judged on its own readings');
    assert.equal(sim.launch('user-pan').launched, FABLE);
    sim.document.instances['user-pan'].runtime_profile = BACKUP;
    sim.pass({ failover: ['user-pan'] });
    assert.deepEqual(sim.holds(BACKUP), ['quota']);
    assert.equal(sim.mode('user-pan'), 'opus');
    assert.equal(sim.launch('user-pan').launched, OPUS);
  });

  it('a Fable persona whose account the launcher has not seen committed launches Opus', () => {
    const sim = new Sim();
    sim.toFable();
    sim.document.instances['user-pan'].runtime_profile = CL; // e.g. --apply moved it outside this lock
    assert.equal(sim.launch('user-pan').launched, OPUS);
  });

  it('--apply disabling and re-enabling a persona feeds the same reconciler', () => {
    const sim = new Sim();
    sim.toFable();
    delete sim.document.instances['user-pan'].fable_enabled;
    const off = sim.pass();
    assert.deepEqual(off.restarts.map(item => [item.instanceId, item.mode, item.reason]), [['user-pan', 'opus', 'fable_disabled']]);
    const { decision, launched } = sim.launch('user-pan');
    assert.equal(decision, null);
    assert.equal(launched, OPUS);
    sim.advance(MIN);
    sim.pass();
    assert.equal(sim.state.personas['user-pan'], undefined, 'verified disabled persona leaves the guard state');
    sim.document.instances['user-pan'].fable_enabled = true;
    sim.setState('user-pan', 'busy');
    sim.observe(BACKUP, 0.1);
    assert.deepEqual(sim.pass().restarts, []);
    assert.equal(sim.mode('user-pan'), 'opus');
  });

  it('a restart interrupted between kill and pm2 restart converges without an obsolete second restart', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    const committed = sim.pass();
    // Kill landed; the guardian relaunched from the committed state before pm2 restarted the monitor.
    sim.advance(10_000);
    sim.launchAll(committed.restarts);
    sim.advance(5 * MIN);
    assert.deepEqual(sim.pass().restarts, []);
    // The monitor restart for the same generation relaunches once more: still converged.
    sim.launchAll(committed.restarts);
    sim.advance(5 * MIN);
    assert.deepEqual(sim.pass().restarts, []);
    assert.equal(sim.restarts.length, 2);
  });

  it('a consent fallback to Opus counts as a Fable failure and trips the crash rule without a relaunch loop', () => {
    const sim = new Sim();
    sim.toFable();
    sim.advance(MIN);
    sim.launch('user-pan', { model: 'claude-opus-5-5' }); // engine answered the dialog's default "switch"
    const first = sim.pass();
    assert.deepEqual(first.restarts.map(item => item.reason), ['resume:model_mismatch:claude-opus-5-5']);
    sim.advance(MIN);
    sim.launch('user-pan', { model: 'claude-opus-5-5' });
    assert.deepEqual(sim.pass().restarts, [], 'second failure: no Fable relaunch');
    const tripped = sim.pass();
    assert.deepEqual(sim.holds(), ['crash']);
    assert.deepEqual(tripped.restarts.map(item => item.instanceId), ['user-elaine'], 'pan already runs Opus');
    assert.equal(sim.mode('user-pan'), 'opus');
  });

  it('crash rule: probation allows one retry, the second trip holds until the next window', () => {
    const sim = new Sim();
    sim.toFable();
    const failure = (offset, reason) => ({ at: iso(sim.now - offset), reason, mode: 'fable', runtime_profile: BACKUP });
    sim.failures['user-pan'] = { failures: [failure(20 * MIN, 'heartbeat_primary_timeout')] };
    sim.pass();
    assert.deepEqual(sim.holds(), []);
    sim.failures['user-pan'].failures.push(failure(MIN, 'heartbeat_recovery_timeout'));
    sim.launchAll(sim.pass().restarts);
    assert.deepEqual(sim.holds(), ['crash']);
    assert.equal(sim.state.holds[BACKUP].crash.trip, 1);
    for (let t = 0; t < 120; t += 5) { sim.advance(5 * MIN); sim.observe(BACKUP, 0.1); sim.launchAll(sim.pass().restarts); }
    assert.deepEqual(sim.holds(), []);
    assert.equal(sim.mode('user-pan'), 'fable', 'one retry after probation');
    sim.failures['user-pan'].failures.push(failure(2 * MIN, 'a'), failure(MIN, 'b'));
    sim.launchAll(sim.pass().restarts);
    assert.equal(sim.state.holds[BACKUP].crash.trip, 2);
    sim.advance(3 * 3_600_000);
    sim.observe(BACKUP, 0.1, W1);
    sim.pass();
    assert.deepEqual(sim.holds(), ['crash'], 'second trip is not released by probation');
    sim.observe(BACKUP, 0.1, W2);
    sim.pass();
    assert.deepEqual(sim.holds(), []);
  });

  it('a classified limit dialog holds the account once; a manual clear is not re-applied', () => {
    const sim = new Sim();
    sim.toFable();
    sim.evidence['user-pan'] = { at: iso(sim.now), kind: 'fable_limit', runtime_profile: BACKUP, mode: 'fable' };
    sim.evidence['user-elaine'] = { at: iso(sim.now - 2 * 3_600_000), kind: 'fable_limit', runtime_profile: BACKUP };
    const result = sim.pass();
    assert.deepEqual(sim.holds(), ['quota']);
    assert.deepEqual(sim.state.holds[BACKUP].quota.detail, { source: 'limit_ui', persona: 'user-pan', kind: 'fable_limit' });
    assert.equal(sim.state.holds[BACKUP].quota.reset_window, W1);
    assert.deepEqual(result.restarts.map(item => item.instanceId).sort(), ['user-elaine', 'user-pan']);
    assert.ok(result.events.some(event => event.startsWith('user-pan: ALERT limit dialog classified')));
    assert.equal(sim.state.personas['user-pan'].possible_dropped_message.kind, 'fable_limit');
    assert.equal(sim.state.personas['user-elaine'].possible_dropped_message, undefined, 'stale evidence is ignored');
    sim.launchAll(result.restarts);
    sim.state = clearFableHold(sim.state, { account: BACKUP, kind: 'quota', nowMs: sim.now }).state;
    sim.pass();
    assert.deepEqual(sim.holds(), []);
  });

  it('skips a restart whose generation was superseded and restarts the live one through the cold-start path', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-exec-'));
    try {
      fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
      fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify({ version: 1, personas: { 'user-pan': { desired: { generation: 5 } } } }));
      const calls = [];
      const exec = (file, args) => { calls.push([file, ...args]); return ''; };
      const restart = generation => ({ instanceId: 'user-pan', generation, mode: 'opus', profileId: BACKUP, reason: 'x', tmuxSession: 'claude-user-pan' });
      assert.deepEqual(executeFableRestarts({ zylosDir, restarts: [restart(4)], execFileSyncImpl: exec, log: () => {} }), []);
      assert.deepEqual(calls, []);
      executeFableRestarts({ zylosDir, restarts: [restart(5)], execFileSyncImpl: exec, log: () => {}, nowMs: T0 });
      assert.deepEqual(calls, [['tmux', 'kill-session', '-t', 'claude-user-pan'], ['pm2', 'restart', 'activity-monitor-user-pan', '--update-env']]);
      const signal = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'runtime-switches', 'user-pan.json'), 'utf8'));
      assert.equal(signal.to_profile, BACKUP, 'same profile: the monitor takes the cold-start path');
      assert.equal(signal.reason, 'fable_guard:opus:g5');
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});

describe('Fable guard daemon integration', () => {
  function writeFixture(zylosDir, document) {
    fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(document, null, 2) + '\n', { mode: 0o640 });
  }

  it('probes in the background, deduplicates in-flight probes and respects the cadence', async () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-probe-'));
    try {
      writeFixture(zylosDir, documentFixture());
      const seen = [];
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const probe = async args => {
        seen.push(args);
        await gate;
        return { outcome: 'valid', observation: { account: args.account, utilization: 0.1, resets_at: W1,
          observed_at: iso(Date.now()), cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed' } };
      };
      const pending = new Set();
      const first = scheduleFableProbes({ zylosDir, probe, pending, log: () => {} });
      assert.equal(scheduleFableProbes({ zylosDir, probe, pending, log: () => {} }).length, 0, 'in flight');
      release();
      await Promise.all(first);
      assert.deepEqual(seen.map(item => [item.account, item.fableModel]), [[BACKUP, FABLE]]);
      assert.equal(seen[0].settingsFile, '/home/zylos-shared/auth/claude-ax-backup.settings.json');
      const store = JSON.parse(fs.readFileSync(fableUsagePath(zylosDir), 'utf8'));
      assert.equal(store.accounts[BACKUP].last_valid.utilization, 0.1);
      assert.equal(scheduleFableProbes({ zylosDir, probe, pending, log: () => {} }).length, 0, 'not due yet');
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('runs under the failover lock without changing instances.json, quarantine or permissions', async () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-apply-'));
    const saved = process.env.ZYLOS_DIR;
    try {
      const document = documentFixture();
      document.runtime_failover = { enabled: true, chain: [BACKUP, CL], switch_threshold: 95, recover_threshold: 90, min_dwell_sec: 300 };
      document.instances['user-pan'].runtime_failover_blocked_profiles = { 'codex-subscription': { health: 'degraded' } };
      writeFixture(zylosDir, document);
      const instancesFile = path.join(zylosDir, 'instances.json');
      const before = { bytes: fs.readFileSync(instancesFile, 'utf8'), mode: fs.statSync(instancesFile).mode };
      const nowMs = Date.now();
      const config = readFableGuardConfig(document);
      let usage = {};
      for (let i = 3; i >= 1; i--) {
        usage = recordProbeResult(usage, { account: BACKUP, nowMs: nowMs - i * MIN, config, result: { outcome: 'valid',
          observation: { account: BACKUP, utilization: 0.1, resets_at: iso(nowMs + 2 * 86_400_000), observed_at: iso(nowMs - i * MIN),
            cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed' } } });
      }
      fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify(usage));
      for (const id of PERSONAS) {
        fs.mkdirSync(path.join(zylosDir, 'activity-monitor', id), { recursive: true });
        fs.writeFileSync(path.join(zylosDir, 'activity-monitor', id, 'agent-status.json'), JSON.stringify({
          state: 'idle', health: 'ok', active_tools: 0, last_check: Math.floor(nowMs / 1000), runtime_launch_at: nowMs - 3_600_000 }));
      }
      process.env.ZYLOS_DIR = zylosDir;
      const { applyRuntimeFailover } = await import(`../runtime-failover.js?fable=${Date.now()}`);
      const calls = [];
      const providerUsage = { providers: { [BACKUP]: { available: true, primary: { used_percent: 10 } },
        [CL]: { available: true, primary: { used_percent: 10 } } } };
      // A fresh lease and idle personas: the first pass upgrades both Fable personas.
      applyRuntimeFailover({ providerUsage, nowMs, execFileSyncImpl: (...args) => { calls.push(args); return ''; }, log: () => {} });
      const state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8'));
      assert.deepEqual(Object.keys(state.personas).sort(), ['user-elaine', 'user-pan']);
      assert.deepEqual(calls.map(([file, args]) => [file, ...args]).sort(), [
        ['pm2', 'restart', 'activity-monitor-user-elaine', '--update-env'],
        ['pm2', 'restart', 'activity-monitor-user-pan', '--update-env'],
        ['tmux', 'kill-session', '-t', 'claude-user-elaine'],
        ['tmux', 'kill-session', '-t', 'claude-user-pan'],
      ]);
      assert.equal(fs.readFileSync(instancesFile, 'utf8'), before.bytes, 'instances.json untouched (incl. blocked profiles)');
      assert.equal(fs.statSync(instancesFile).mode, before.mode);
      assert.ok(fs.existsSync(path.join(zylosDir, '.zylos', 'runtime-switches', 'user-pan.json')));
      assert.ok(!fs.existsSync(path.join(zylosDir, '.zylos', 'runtime-switches', 'admin.json')));
    } finally {
      if (saved === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = saved;
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('drill teardown: restoring the threshold keeps the latch; the manual clear releases it', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-cli-'));
    try {
      const sim = new Sim(documentFixture({ guard: { threshold: 0.01 } }));
      sim.pass(); // drill threshold 0.01 is below the current 2% reading
      for (let i = 0; i < 3; i++) { sim.advance(5 * MIN); sim.observe(BACKUP, 0.02); sim.pass(); }
      assert.deepEqual(sim.holds(), ['quota', 'stale']);
      sim.document.fable_guard.threshold = 0.75;
      sim.advance(5 * MIN);
      sim.observe(BACKUP, 0.02);
      sim.pass();
      assert.ok(sim.holds().includes('quota'), 'restoring the threshold alone does not release the latch');
      writeFixture(zylosDir, sim.document);
      fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(sim.state));
      fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify(sim.usage));
      const cli = path.resolve(import.meta.dirname, '..', 'fable-guard-cli.js');
      const env = { ...process.env, ZYLOS_DIR: zylosDir };
      const cleared = spawnSync(process.execPath, [cli, 'clear', BACKUP, 'quota', '--reason', 'drill teardown'], { env, encoding: 'utf8' });
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.match(cleared.stdout, /cleared claude-ax-backup: quota/);
      const status = JSON.parse(spawnSync(process.execPath, [cli, 'status', '--json'], { env, encoding: 'utf8' }).stdout);
      assert.deepEqual(status.accounts[BACKUP].holds, {});
      assert.equal(status.manual_clears.at(-1).reason, 'drill teardown');
      sim.state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8'));
      sim.advance(5 * MIN);
      sim.observe(BACKUP, 0.02);
      const result = sim.pass();
      assert.deepEqual(sim.holds(), []);
      assert.deepEqual(result.restarts.map(item => [item.instanceId, item.mode]).sort(),
        [['user-elaine', 'fable'], ['user-pan', 'fable']]);
      const bad = spawnSync(process.execPath, [cli, 'clear', BACKUP, 'bogus'], { env, encoding: 'utf8' });
      assert.equal(bad.status, 1);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});
