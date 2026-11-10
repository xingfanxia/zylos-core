import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  clearFableHold,
  executeFableRestarts,
  fableGuardOwnsInstance,
  fableProbeAccounts,
  planFableGuard,
  reconcileFableGuardNow,
  scheduleFableProbes,
} from '../fable-guard.js';
import { baseModel, recordProbeResult } from '../fable-probe.js';
import { writeRuntimeSwitchSignal } from '../runtime-switch-signal.js';
import {
  FABLE_GUARD_DEFAULTS,
  fableGuardStatePath,
  fableUsagePath,
  prepareFableLaunch,
  readFableGuardConfig,
  resolveFableLaunch,
  resolveRuntimeProfile,
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
    this.launches = {};
    this.cached = {};
    this.readiness = {};
    this.now = T0;
    this.restarts = [];
    for (const id of PERSONAS) this.monitorStart(id, { at: T0 - 3_600_000 });
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
      launchByInstance: this.launches, readinessByInstance: this.readiness,
      failoverInstanceIds: new Set(failover), nowMs: this.now,
    });
    this.state = JSON.parse(JSON.stringify(result.state)); // what the daemon persists
    this.restarts.push(...result.restarts);
    return result;
  }
  // Files as the launcher reads them on the host.
  read(file) {
    if (file.endsWith('instances.json')) return JSON.stringify(this.document);
    if (file.endsWith('fable-guard.json') && this.state) return JSON.stringify(this.state);
    if (file.endsWith('fable-usage.json')) return JSON.stringify(this.usage);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }
  // A cold restart (pm2 restart activity-monitor-<id>): the monitor resolves
  // its profile once, then the Guardian launches it.
  monitorStart(id, options = {}) {
    this.cached[id] = resolveRuntimeProfile({ document: this.document, instanceId: id, fableGuardState: this.state,
      fableUsage: this.usage, nowMs: this.now });
    return this.launch(id, options);
  }
  // A Guardian relaunch: the real adapter path re-evaluates the CACHED profile.
  launch(id, { at = this.now, model = null } = {}) {
    const profile = prepareFableLaunch({ profile: this.cached[id], instanceId: id, zylosDir: '/sim', nowMs: at,
      readFileSync: file => this.read(file), writeRecord: (_file, record) => { this.launches[id] = record; } });
    const launched = model || profile.model;
    this.status[id] = { state: 'idle', health: 'ok', active_tools: 0, last_check: Math.floor(this.now / 1000), runtime_launch_at: at };
    this.models[id] = { model: baseModel(launched), observed_at_ms: at + 1000 };
    return { decision: profile.fable || null, launched, profile };
  }
  launchAll(restarts) { for (const item of restarts) this.monitorStart(item.instanceId); }
  mode(id) { return this.state?.personas?.[id]?.desired?.mode; }
  holds(account = BACKUP) { return Object.keys(this.state?.holds?.[account] || {}).sort(); }
  // Enable both Fable personas and bring them onto Fable through the normal path.
  toFable() {
    this.launchAll(this.pass().restarts); // commit the launch policy (subagent env) on Opus
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
      [['user-elaine', 'opus', 'resume:stale_launch'], ['user-pan', 'opus', 'resume:stale_launch']]);
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
    assert.deepEqual(sim.pass().restarts, [], 'the subagent pin waits for an idle persona');
    assert.equal(sim.mode('user-pan'), 'opus');
    sim.setState('user-pan', 'idle');
    const on = sim.pass();
    // Idle with a fresh lease and no dwell pending: one restart brings the pin and Fable together.
    assert.deepEqual(on.restarts.map(item => [item.instanceId, item.mode, item.reason]), [['user-pan', 'fable', 'fable_allowed']]);
    sim.launchAll(on.restarts);
    assert.equal(sim.launches['user-pan'].mode, 'fable');
    assert.match(sim.launches['user-pan'].key, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
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
    // pan's engine fell back to Opus inside a Fable launch: it gets a clean Opus launch.
    assert.deepEqual(tripped.restarts.map(item => item.instanceId).sort(), ['user-elaine', 'user-pan']);
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
    assert.ok(result.events.some(event => event.startsWith('user-pan: limit dialog classified')));
    assert.equal(sim.state.personas['user-pan'].possible_dropped_message, undefined,
      'message outcomes come from C4 delivery_uncertain, named by the monitor');
    assert.equal(sim.state.personas['user-elaine'].evidence_seen_at, undefined, 'stale evidence is ignored');
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
      const OLD = '$3:1762790000:%12:48211';
      const exec = (file, args) => { calls.push([file, ...args]); return file === 'tmux' && args[0] === 'display-message' ? `${OLD}\n` : ''; };
      const restart = generation => ({ instanceId: 'user-pan', generation, mode: 'opus', profileId: BACKUP, reason: 'x', tmuxSession: 'claude-user-pan' });
      assert.deepEqual(executeFableRestarts({ zylosDir, restarts: [restart(4)], execFileSyncImpl: exec, log: () => {} }), []);
      assert.deepEqual(calls.filter(([, verb]) => verb !== 'display-message'), []);
      calls.length = 0;
      executeFableRestarts({ zylosDir, restarts: [restart(5)], execFileSyncImpl: exec, log: () => {}, nowMs: T0 });
      assert.deepEqual(calls, [
        ['tmux', 'display-message', '-p', '-t', 'claude-user-pan', '#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}'],
        ['tmux', 'kill-session', '-t', 'claude-user-pan'], ['pm2', 'restart', 'activity-monitor-user-pan', '--update-env']]);
      const signal = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'runtime-switches', 'user-pan.json'), 'utf8'));
      assert.equal(signal.to_profile, BACKUP, 'same profile: the monitor takes the cold-start path');
      assert.equal(signal.reason, 'fable_guard:opus:g5');
      assert.equal(signal.session_ref, OLD, 'the session the guard is about to kill, for the C4 key fence');
      calls.length = 0;
      executeFableRestarts({ zylosDir, restarts: [{ ...restart(5), kind: 'stop' }], execFileSyncImpl: exec, log: () => {}, nowMs: T0 });
      assert.deepEqual(calls, [['pm2', 'stop', 'activity-monitor-user-pan'], ['tmux', 'kill-session', '-t', 'claude-user-pan'],
        ['tmux', 'has-session', '-t', '=claude-user-pan']],
      'a safe stop stops the monitor before the pane, then observes whether the session is gone');
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});

describe('Fable guard account + model + generation journal (review #2)', () => {
  function onAccounts() {
    const sim = new Sim();
    sim.toFable();
    sim.advance(MIN);
    sim.observe(CL, 0.1); // account B is allowed Fable too: the mode does not change
    sim.observe(BACKUP, 0.1);
    return sim;
  }

  it('an account commit whose failover restart never ran is restarted, never verified on the old session', () => {
    const sim = onAccounts();
    sim.document.instances['user-pan'].runtime_profile = CL; // instances.json committed B
    const hop = sim.pass({ failover: ['user-pan'] }); // ...and the failover's kill/pm2 restart never happened
    assert.deepEqual(hop.restarts, []);
    assert.equal(sim.state.personas['user-pan'].desired.account, CL);
    // Account A's Fable process and status are still up.
    sim.advance(MIN);
    assert.deepEqual(sim.pass().restarts, []);
    assert.equal(sim.state.personas['user-pan'].verified?.model_at, undefined, 'A\'s Fable session is not B');
    sim.advance(3 * MIN);
    const resumed = sim.pass();
    assert.deepEqual(resumed.restarts.map(item => [item.instanceId, item.profileId, item.reason]),
      [['user-pan', CL, 'resume:stale_launch']]);
    sim.launchAll(resumed.restarts);
    sim.advance(MIN);
    sim.pass();
    assert.ok(sim.state.personas['user-pan'].verified.model_at);
    assert.equal(sim.launches['user-pan'].runtime_profile, CL);
  });

  it('a crash between the instances.json and guard-state commits still restarts the persona', () => {
    const sim = onAccounts();
    const before = JSON.parse(JSON.stringify(sim.state));
    sim.document.instances['user-pan'].runtime_profile = CL;
    sim.pass({ failover: ['user-pan'] });
    sim.state = before; // the guard file write never landed; instances.json did
    sim.advance(10_000);
    const result = sim.pass(); // daemon restarted: the failover sees nothing left to do
    assert.deepEqual(result.restarts.map(item => [item.instanceId, item.profileId]), [['user-pan', CL]]);
    assert.equal(sim.state.personas['user-pan'].verified, undefined);
  });

  it('a guard-state commit whose instances.json write was lost launches Opus meanwhile and re-adopts the running launch', () => {
    const sim = onAccounts();
    const runningLaunch = sim.launches['user-pan'].launch_id;
    sim.document.instances['user-pan'].runtime_profile = CL;
    sim.pass({ failover: ['user-pan'] }); // guard file says CL ...
    sim.document.instances['user-pan'].runtime_profile = BACKUP; // ... instances.json still says BACKUP
    // What a Guardian relaunch inside the torn window would launch (the running session is left alone).
    const torn = prepareFableLaunch({ profile: sim.cached['user-pan'], instanceId: 'user-pan', zylosDir: '/sim', nowMs: sim.now,
      readFileSync: file => sim.read(file), writeRecord: () => {} });
    assert.equal(torn.model, OPUS, 'the committed account is not the instance account: Opus only');
    assert.equal(torn.fable.reason, 'account_mismatch');
    assert.equal(sim.launches['user-pan'].launch_id, runningLaunch);
    sim.advance(MIN);
    const result = sim.pass();
    assert.equal(sim.state.personas['user-pan'].desired.account, BACKUP);
    assert.deepEqual(result.restarts, [], 'the running BACKUP launch already has the recommitted policy');
    assert.equal(sim.state.personas['user-pan'].desired.adopted_launch_id, runningLaunch);
    sim.advance(MIN);
    sim.pass();
    assert.ok(sim.state.personas['user-pan'].verified.model_at);
  });

  it('a Guardian relaunch that read the old generation does not verify the new one', () => {
    const sim = onAccounts();
    const old = JSON.parse(JSON.stringify(sim.state));
    sim.observe(BACKUP, 0.9);
    const committed = sim.pass();
    assert.equal(committed.restarts.length, 2);
    const realState = sim.state;
    sim.state = old; // the relaunch read the guard file just before the commit
    sim.launch('user-pan');
    sim.state = realState;
    assert.equal(sim.launches['user-pan'].generation, old.personas['user-pan'].desired.generation);
    sim.advance(MIN);
    sim.pass();
    assert.equal(sim.state.personas['user-pan'].verified?.model_at, undefined);
  });
});

describe('Fable guard interrupted restarts keep reconciling (review #3)', () => {
  it('an offline persona after a commit (kill landed, pm2 restart did not) is restarted again', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    assert.equal(sim.pass().restarts.length, 2);
    sim.advance(10_000);
    sim.setState('user-pan', 'offline'); // tmux killed; the monitor never came back
    sim.launchAll([{ instanceId: 'user-elaine' }]);
    sim.advance(4 * MIN);
    const resumed = sim.pass();
    assert.deepEqual(resumed.restarts.map(item => [item.instanceId, item.reason]), [['user-pan', 'resume:not_running:offline']]);
    sim.launchAll(resumed.restarts);
    sim.advance(MIN);
    sim.pass();
    assert.ok(sim.state.personas['user-pan'].verified.model_at);
  });

  it('a stale status (dead monitor) is not taken for a running engine', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    sim.pass();
    sim.launchAll([{ instanceId: 'user-elaine' }]);
    const frozen = sim.status['user-pan'].last_check;
    sim.advance(4 * MIN);
    sim.status['user-pan'].last_check = frozen; // monitor process gone; its last status still says idle
    assert.deepEqual(sim.pass().restarts.map(item => [item.instanceId, item.reason]), [['user-pan', 'resume:not_running:idle']]);
  });

  it('missing model evidence is bounded: a Fable launch is restarted, an Opus launch is surfaced', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    const down = sim.pass();
    sim.launchAll(down.restarts);
    sim.models['user-pan'] = { model: 'claude-fable-5-2', observed_at_ms: sim.now - 60_000 }; // statusline never refreshed
    sim.advance(11 * MIN);
    const result = sim.pass();
    assert.deepEqual(result.restarts.filter(item => item.instanceId === 'user-pan'), [], 'the launcher passed Opus');
    assert.ok(sim.state.personas['user-pan'].verified.model_unknown_at);
    assert.ok(result.events.some(event => event.includes('user-pan') && event.includes('ALERT') && event.includes('model')));

    const up = new Sim();
    up.toFable();
    up.models['user-pan'] = { model: 'claude-fable-5-2', observed_at_ms: up.launches['user-pan'].launched_at_ms - 1 };
    up.advance(11 * MIN);
    up.observe(BACKUP, 0.1);
    assert.deepEqual(up.pass().restarts.map(item => [item.instanceId, item.reason]), [['user-pan', 'resume:model_unknown']]);
  });

  it('downgrade retry exhaustion stops the Fable persona with an actionable alert instead of leaving it live', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    sim.pass();
    sim.launchAll([{ instanceId: 'user-elaine' }]);
    // Every restart of pan fails: its old Fable launch keeps running.
    const reasons = [];
    for (let i = 0; i < 6; i++) {
      sim.advance(4 * MIN);
      for (const item of sim.pass().restarts) reasons.push(`${item.instanceId}:${item.kind}:${item.reason}`);
    }
    // The stop is an intent: never confirmed here (nothing executes it), so it is planned again after its backoff.
    assert.deepEqual(reasons.slice(0, 3), ['user-pan:restart:resume:stale_launch', 'user-pan:restart:resume:stale_launch', 'user-pan:stop:safe_stop:stale_launch']);
    assert.ok(reasons.slice(3).every(reason => reason === 'user-pan:stop:safe_stop:stale_launch'), reasons.join(', '));
    const pan = sim.state.personas['user-pan'];
    assert.ok(pan.safe_stop.at);
    assert.ok(pan.gave_up);
    assert.equal(sim.state.personas['user-elaine'].safe_stop, undefined);
  });

  it('a Fable persona failed over to a Codex profile is never restarted or stopped by the guard', () => {
    const sim = new Sim();
    sim.toFable();
    sim.document.instances['user-pan'].runtime_profile = 'codex-subscription';
    const hop = sim.pass({ failover: ['user-pan'] });
    assert.deepEqual(hop.restarts, []);
    // The Codex engine writes no Claude launch record; the old Fable record remains on disk.
    sim.status['user-pan'] = { state: 'idle', health: 'ok', active_tools: 0, last_check: Math.floor(sim.now / 1000), runtime_launch_at: sim.now };
    sim.models['user-pan'] = null;
    const kinds = [];
    for (let i = 0; i < 6; i++) {
      sim.advance(4 * MIN);
      sim.status['user-pan'].last_check = Math.floor(sim.now / 1000);
      for (const item of sim.pass().restarts) if (item.instanceId === 'user-pan') kinds.push(item.kind);
    }
    assert.deepEqual(kinds, []);
    assert.equal(sim.state.personas['user-pan'].safe_stop, undefined);
    assert.equal(sim.state.personas['user-pan'].desired.reason, 'unsupported_account');
  });

  it('an exhausted upgrade is only surfaced (the launch gate keeps any Fable launch admitted)', () => {
    const sim = new Sim();
    sim.toFable();
    sim.launch('user-pan', { model: 'claude-opus-5-5' });
    sim.document.fable_guard.crash_failures = 20;
    const kinds = [];
    for (let i = 0; i < 6; i++) {
      sim.advance(4 * MIN);
      sim.observe(BACKUP, 0.1);
      const result = sim.pass();
      for (const item of result.restarts) { kinds.push(item.kind); sim.launch(item.instanceId, { model: 'claude-opus-5-5' }); }
    }
    assert.ok(!kinds.includes('stop'));
    assert.ok(sim.state.personas['user-pan'].gave_up);
  });
});

describe('Fable guard generation fencing and --apply protocol (review #4)', () => {
  function tempZylos(sim) {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-fence-'));
    fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(sim.document));
    return zylosDir;
  }
  const persist = (sim, zylosDir) => {
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(sim.document));
    fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(sim.state));
    fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify(sim.usage));
    for (const [id, record] of Object.entries(sim.launches)) {
      fs.mkdirSync(path.join(zylosDir, 'activity-monitor', id), { recursive: true });
      fs.writeFileSync(path.join(zylosDir, 'activity-monitor', id, 'fable-launch.json'), JSON.stringify(record));
    }
  };
  const load = (sim, zylosDir) => { sim.state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')); };

  it('checks the generation per restart under the instances.json lock, not once per batch', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    const batch = sim.pass().restarts;
    assert.equal(batch.length, 2);
    const zylosDir = tempZylos(sim);
    try {
      persist(sim, zylosDir);
      const locks = [];
      const lock = (lockPath, fn) => { locks.push(lockPath); return fn(); };
      const calls = [];
      const exec = (file, args) => {
        calls.push([file, ...args].join(' '));
        // While the first persona restarts, another writer commits a newer generation for the second.
        if (file === 'pm2' && args[1] === `activity-monitor-${batch[0].instanceId}`) {
          const state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8'));
          state.personas[batch[1].instanceId].desired.generation += 10;
          fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(state));
        }
        return '';
      };
      const done = executeFableRestarts({ zylosDir, restarts: batch, nowMs: sim.now, execFileSyncImpl: exec, log: () => {}, lock });
      assert.deepEqual(done.map(item => item.instanceId), [batch[0].instanceId]);
      assert.equal(calls.filter(call => call.includes(batch[1].instanceId) && !call.includes('display-message')).length, 0,
        'the superseded restart never ran');
      assert.deepEqual(locks, [path.join(zylosDir, 'instances.json.lock'), path.join(zylosDir, 'instances.json.lock')]);
      const executing = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')).personas[batch[0].instanceId].executing;
      assert.equal(executing.generation, batch[0].generation);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  it('a newer commit for a persona whose restart is still landing reuses that restart', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    const first = sim.pass().restarts.find(item => item.instanceId === 'user-pan');
    const zylosDir = tempZylos(sim);
    try {
      persist(sim, zylosDir);
      const calls = [];
      const exec = (file, args) => { if (args[0] !== 'display-message') calls.push(`${file} ${args[0]}`); return ''; };
      executeFableRestarts({ zylosDir, restarts: [first], nowMs: sim.now, execFileSyncImpl: exec, log: () => {} });
      load(sim, zylosDir);
      // --apply moves pan to another account 5 s later, before the restarted monitor launched.
      sim.advance(5000);
      sim.document.instances['user-pan'].runtime_profile = CL;
      const second = sim.pass().restarts.find(item => item.instanceId === 'user-pan');
      assert.ok(second && second.generation > first.generation);
      persist(sim, zylosDir);
      const logs = [];
      calls.length = 0;
      executeFableRestarts({ zylosDir, restarts: [second], nowMs: sim.now, execFileSyncImpl: exec, log: line => logs.push(line) });
      assert.deepEqual(calls, [], 'the in-flight restart launches from the newest commit');
      assert.ok(logs.some(line => line.includes('in flight')));
      load(sim, zylosDir);
      sim.monitorStart('user-pan'); // the first restart's monitor comes up and reads the newest commit
      sim.advance(MIN);
      sim.pass();
      assert.equal(sim.launches['user-pan'].runtime_profile, CL);
      assert.ok(sim.state.personas['user-pan'].verified.model_at);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });

  for (const boundary of ['signal', 'kill', 'pm2']) {
    it(`converges to Opus when the restart fails at the ${boundary} boundary (real cached-adapter lifecycle)`, () => {
      const sim = new Sim();
      sim.toFable();
      const zylosDir = tempZylos(sim);
      try {
        sim.observe(BACKUP, 0.8);
        let failOnce = boundary;
        const world = (file, args) => {
          const step = file === 'tmux' ? 'kill' : 'pm2';
          if (failOnce === step) { failOnce = null; throw new Error(`injected ${step} failure`); }
          const id = file === 'tmux' ? args[2].replace(/^claude-/, '') : args[1].replace(/^activity-monitor-/, '');
          if (step === 'kill') { sim.setState(id, 'offline'); sim.launch(id); } // the old monitor's Guardian relaunches
          else sim.monitorStart(id);
          return '';
        };
        const writeSignal = args => {
          if (failOnce === 'signal') { failOnce = null; throw new Error('injected signal failure'); }
          return writeRuntimeSwitchSignal(args);
        };
        for (let i = 0; i < 5; i++) {
          const result = sim.pass();
          persist(sim, zylosDir);
          executeFableRestarts({ zylosDir, restarts: result.restarts, nowMs: sim.now, execFileSyncImpl: world, writeSignal, log: () => {} });
          load(sim, zylosDir);
          sim.advance(4 * MIN);
          sim.observe(BACKUP, 0.8);
        }
        for (const id of ['user-pan', 'user-elaine']) {
          assert.equal(sim.launches[id].mode, 'opus', id);
          assert.ok(sim.state.personas[id].verified?.model_at, id);
          assert.equal(sim.state.personas[id].safe_stop, undefined, id);
        }
      } finally {
        fs.rmSync(zylosDir, { recursive: true, force: true });
      }
    });
  }

  it('disabling a persona while it is on Opus drops the subagent pin through one restart', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.9);
    sim.launchAll(sim.pass().restarts); // both on Opus, pinned
    assert.match(sim.launches['user-pan'].key, /SUBAGENT/);
    delete sim.document.instances['user-pan'].fable_enabled;
    sim.setState('user-pan', 'busy');
    assert.deepEqual(sim.pass().restarts, [], 'waits for idle');
    sim.setState('user-pan', 'idle');
    const off = sim.pass();
    assert.deepEqual(off.restarts.map(item => [item.instanceId, item.reason]), [['user-pan', 'resume:policy_change']]);
    sim.launchAll(off.restarts);
    assert.doesNotMatch(sim.launches['user-pan'].key, /SUBAGENT/);
    sim.advance(MIN);
    sim.pass();
    assert.equal(sim.state.personas['user-pan'], undefined, 'converged and released');
  });

  it('reconcileFableGuardNow is the generation-aware entry point --apply uses after writing instances.json', () => {
    const sim = new Sim();
    sim.toFable();
    const zylosDir = tempZylos(sim);
    try {
      persist(sim, zylosDir);
      const doc = JSON.parse(fs.readFileSync(path.join(zylosDir, 'instances.json'), 'utf8'));
      assert.equal(fableGuardOwnsInstance({ document: doc, state: sim.state, instanceId: 'user-pan' }), true);
      assert.equal(fableGuardOwnsInstance({ document: doc, state: sim.state, instanceId: 'admin' }), false);
      // --apply: pan moves to ax-cl (no reading there yet) under the lock; it does NOT restart pan itself.
      doc.instances['user-pan'].runtime_profile = CL;
      fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(doc));
      for (const id of PERSONAS) {
        fs.mkdirSync(path.join(zylosDir, 'activity-monitor', id), { recursive: true });
        fs.writeFileSync(path.join(zylosDir, 'activity-monitor', id, 'agent-status.json'), JSON.stringify({ ...sim.status[id],
          last_check: Math.floor(sim.now / 1000), runtime_launch_at: sim.launches[id]?.launched_at_ms ?? 0 }));
      }
      const calls = [];
      const exec = (file, args) => { if (args[0] !== 'display-message') calls.push([file, ...args].join(' ')); return ''; };
      const first = reconcileFableGuardNow({ zylosDir, nowMs: sim.now, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(first.executed.map(item => [item.instanceId, item.profileId, item.mode]), [['user-pan', CL, 'opus']]);
      assert.deepEqual(calls, ['tmux kill-session -t claude-user-pan', 'pm2 restart activity-monitor-user-pan --update-env']);
      const again = reconcileFableGuardNow({ zylosDir, nowMs: sim.now + 1000, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(again.executed, [], 'a second call never restarts the same commit again');
      const state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8'));
      assert.equal(state.personas['user-pan'].desired.account, CL);
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});

describe('Fable guard readiness and crash contracts (review #6)', () => {
  it('model convergence and verified readiness are separate; an auto-ACKable ACK is not readiness', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    sim.launchAll(sim.pass().restarts);
    sim.status['user-pan'].functional_ack_at = sim.now + 2000;
    sim.status['user-pan'].functional_ack_phase = 'primary';
    sim.advance(MIN);
    sim.pass();
    const pan = () => sim.state.personas['user-pan'].verified;
    assert.ok(pan().model_at, 'model converged');
    assert.equal(pan().ready_at, undefined, 'the auto-ACKable primary probe is not readiness');
    sim.readiness['user-pan'] = { launch_id: sim.launches['user-pan'].launch_id, outcome: 'ack', phase: 'post_restart', at: iso(sim.now) };
    sim.readiness['user-elaine'] = { launch_id: sim.launches['user-elaine'].launch_id, outcome: 'missing', status: 'timeout', at: iso(sim.now) };
    sim.advance(MIN);
    const result = sim.pass();
    assert.equal(pan().ready_at, iso(sim.now - MIN));
    assert.equal(sim.state.personas['user-elaine'].verified.readiness, 'ack_missing');
    assert.ok(result.events.some(event => event.startsWith('user-elaine: ALERT') && event.includes('ACK')));
    assert.deepEqual(result.restarts, [], 'a correct model is never restarted for a missing ACK');
    sim.advance(MIN);
    assert.equal(sim.pass().events.filter(event => event.includes('ACK')).length, 0, 'surfaced once');
  });

  it('two unexpected foreground exits of a Fable session within 30 min trip the crash hold', () => {
    const sim = new Sim();
    sim.toFable();
    const exit = minutesAgo => ({ at: iso(sim.now - minutesAgo * MIN), reason: 'unexpected_exit', mode: 'fable',
      runtime_profile: BACKUP, launch_id: sim.launches['user-pan'].launch_id });
    sim.failures['user-pan'] = { failures: [exit(10)] };
    sim.pass();
    assert.deepEqual(sim.holds(), []);
    sim.failures['user-pan'].failures.push(exit(1));
    sim.launchAll(sim.pass().restarts);
    assert.deepEqual(sim.holds(), ['crash']);
    assert.equal(sim.mode('user-pan'), 'opus');
  });
});

describe('Fable guard on an account without its own settings file (verdict e)', () => {
  it('claude-ax-main is explicitly unsupported: always Opus, shown as such, never recovering', () => {
    const sim = new Sim();
    sim.document.instances['user-pan'].runtime_profile = 'claude-ax-main';
    sim.cached['user-pan'] = null;
    sim.monitorStart('user-pan');
    sim.observe(BACKUP, 0.1);
    sim.launchAll(sim.pass().restarts);
    sim.advance(MIN);
    sim.pass();
    const pan = sim.state.personas['user-pan'];
    assert.equal(pan.desired.mode, 'opus');
    assert.equal(pan.desired.reason, 'unsupported_account');
    assert.equal(pan.unsupported, 'account_without_settings_file');
    assert.equal(sim.launches['user-pan'].reason, 'unsupported_account');
    assert.ok(!fableProbeAccounts(sim.document).has('claude-ax-main'), 'never probed');
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-main-'));
    try {
      fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
      fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(sim.document));
      fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(sim.state));
      const cli = path.resolve(import.meta.dirname, '..', 'fable-guard-cli.js');
      const env = { ...process.env, ZYLOS_DIR: zylosDir };
      const text = spawnSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' }).stdout;
      const line = text.split('\n').find(row => row.startsWith('persona user-pan'));
      assert.match(line, /UNSUPPORTED account claude-ax-main: always Opus/);
      assert.doesNotMatch(text, /recover/i);
      const json = JSON.parse(spawnSync(process.execPath, [cli, 'status', '--json'], { env, encoding: 'utf8' }).stdout);
      assert.equal(json.personas['user-pan'].unsupported, 'account_without_settings_file');
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
      applyRuntimeFailover({ providerUsage, nowMs, log: () => {},
        execFileSyncImpl: (...args) => { if (args[1]?.[0] !== 'display-message') calls.push(args); return ''; } });
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
      // `reconcile` on an unconfigured directory is a no-op (never runs tmux/pm2 here).
      const inert = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-cli-inert-'));
      try {
        fs.writeFileSync(path.join(inert, 'instances.json'), JSON.stringify({ instances: {} }));
        const noop = spawnSync(process.execPath, [cli, 'reconcile', '--json'], { env: { ...env, ZYLOS_DIR: inert }, encoding: 'utf8' });
        assert.equal(noop.status, 0, noop.stderr);
        assert.deepEqual(JSON.parse(noop.stdout), { events: [], executed: [] });
        assert.equal(fs.existsSync(fableGuardStatePath(inert)), false);
      } finally {
        fs.rmSync(inert, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
    }
  });
});

// ── Review #2 (astra-review-2.md): an attempt record is not a completion receipt ──
function guardTemp(sim) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-r2-'));
  fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
  const persist = () => {
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(sim.document));
    fs.writeFileSync(fableGuardStatePath(zylosDir), JSON.stringify(sim.state));
    fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify(sim.usage));
    for (const [id, record] of Object.entries(sim.launches)) {
      fs.mkdirSync(path.join(zylosDir, 'activity-monitor', id), { recursive: true });
      fs.writeFileSync(path.join(zylosDir, 'activity-monitor', id, 'fable-launch.json'), JSON.stringify(record));
    }
  };
  const load = () => { sim.state = JSON.parse(fs.readFileSync(fableGuardStatePath(zylosDir), 'utf8')); };
  return { zylosDir, persist, load, cleanup: () => fs.rmSync(zylosDir, { recursive: true, force: true }) };
}

// Drive a downgrade whose restarts never land until the guard decides to stop pan.
function toSafeStop(sim) {
  sim.toFable();
  sim.observe(BACKUP, 0.8);
  sim.pass();
  sim.launchAll([{ instanceId: 'user-elaine' }]);
  for (let i = 0; i < 6; i++) {
    sim.advance(4 * MIN);
    const stop = sim.pass().restarts.find(item => item.kind === 'stop');
    if (stop) return stop;
  }
  throw new Error('no safe stop planned');
}

// tmux/pm2 world for the executor: has-session tells whether the session still exists.
function stopWorld({ pm2StopFails = 0, killLeavesSession = false } = {}) {
  const world = { alive: new Set(PERSONAS.map(id => `claude-${id}`)), calls: [] };
  world.exec = (file, args) => {
    world.calls.push([file, ...args].join(' '));
    if (file === 'pm2' && args[0] === 'stop' && pm2StopFails > 0) { pm2StopFails -= 1; throw new Error('pm2 stop: connect ECONNREFUSED'); }
    if (file === 'tmux' && args[0] === 'kill-session' && !killLeavesSession) world.alive.delete(args[2].replace(/^=/, ''));
    if (file === 'tmux' && args[0] === 'has-session' && !world.alive.has(args[2].replace(/^=/, ''))) {
      throw Object.assign(new Error('exit 1'), { status: 1, stderr: `can't find session: ${args[2]}` });
    }
    return '';
  };
  return world;
}

describe('Fable guard safe stop is completed only by observed evidence (review-2 #1)', () => {
  it('failed stop then retry: a failed pm2 stop is not reported STOPPED, stays pending and is retried until confirmed', () => {
    const sim = new Sim();
    const stop = toSafeStop(sim);
    const tmp = guardTemp(sim);
    try {
      tmp.persist();
      const logs = [];
      const failing = stopWorld({ pm2StopFails: 1 });
      executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: [stop], nowMs: sim.now, execFileSyncImpl: failing.exec, log: line => logs.push(line) });
      assert.ok(!logs.some(line => /: STOPPED/.test(line)), `not reported STOPPED: ${logs.join(' | ')}`);
      assert.ok(logs.some(line => /ALERT/.test(line) && /not confirmed/.test(line)));
      tmp.load();
      assert.equal(sim.state.personas['user-pan'].safe_stop.confirmed_at, undefined);
      sim.advance(2 * MIN);
      const retry = sim.pass().restarts.filter(item => item.instanceId === 'user-pan');
      assert.deepEqual(retry.map(item => [item.kind, item.attempt]), [['stop', 2]], 'the stop is retried');
      tmp.persist();
      const working = stopWorld();
      logs.length = 0;
      executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: retry, nowMs: sim.now, execFileSyncImpl: working.exec, log: line => logs.push(line) });
      assert.ok(logs.some(line => /: STOPPED/.test(line)));
      tmp.load();
      assert.ok(sim.state.personas['user-pan'].safe_stop.confirmed_at, 'confirmed by pm2 stop + the session being gone');
      for (let i = 0; i < 5; i++) {
        sim.advance(5 * MIN);
        assert.deepEqual(sim.pass().restarts.filter(item => item.instanceId === 'user-pan'), [], 'a confirmed stop is final');
      }
    } finally { tmp.cleanup(); }
  });

  it('a kill that leaves the session running is not a stop', () => {
    const sim = new Sim();
    const stop = toSafeStop(sim);
    const tmp = guardTemp(sim);
    try {
      tmp.persist();
      const world = stopWorld({ killLeavesSession: true });
      executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: [stop], nowMs: sim.now, execFileSyncImpl: world.exec, log: () => {} });
      tmp.load();
      assert.equal(sim.state.personas['user-pan'].safe_stop.confirmed_at, undefined);
      assert.ok(sim.state.personas['user-pan'].safe_stop.last_error);
    } finally { tmp.cleanup(); }
  });

  it('crash after safe_stop commit: an interrupted stop is planned again after the daemon restarts', () => {
    const sim = new Sim();
    const stop = toSafeStop(sim);
    assert.equal(stop.instanceId, 'user-pan');
    // The daemon died after persisting safe_stop and before the stop effect ran.
    const persisted = JSON.parse(JSON.stringify(sim.state));
    sim.state = persisted;
    sim.advance(10_000);
    assert.deepEqual(sim.pass().restarts.filter(item => item.kind === 'stop'), [], 'backoff, not a hot loop');
    sim.advance(2 * MIN);
    const again = sim.pass().restarts.filter(item => item.kind === 'stop');
    assert.deepEqual(again.map(item => item.instanceId), ['user-pan']);
    assert.ok(sim.state.personas['user-pan'].safe_stop);
  });

  it('a session confirmed on Opus resolves a pending safe stop without stopping it', () => {
    const sim = new Sim();
    toSafeStop(sim);
    sim.monitorStart('user-pan'); // the persona came back on Opus (launch + model report)
    sim.advance(MIN);
    sim.pass();
    assert.ok(sim.state.personas['user-pan'].safe_stop.confirmed_at);
    sim.advance(10 * MIN);
    assert.deepEqual(sim.pass().restarts.filter(item => item.kind === 'stop'), []);
  });
});

describe('Fable guard execution claim per generation/attempt (review-2 #4)', () => {
  it('same-generation concurrent execution: the same generation/attempt executes once', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    const item = sim.pass().restarts.find(entry => entry.instanceId === 'user-pan');
    const tmp = guardTemp(sim);
    try {
      tmp.persist();
      const calls = [];
      let nested = false;
      const exec = (file, args) => {
        if (args[0] === 'display-message' || args[0] === 'has-session') return '';
        calls.push([file, ...args].join(' '));
        // A second executor (--apply's reconcile, or a duplicate submission) runs the same item mid-flight.
        if (file === 'tmux' && args[0] === 'kill-session' && !nested) {
          nested = true;
          executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: [item], nowMs: sim.now, execFileSyncImpl: exec, log: () => {} });
        }
        return '';
      };
      executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: [item], nowMs: sim.now, execFileSyncImpl: exec, log: () => {} });
      executeFableRestarts({ zylosDir: tmp.zylosDir, restarts: [item], nowMs: sim.now + 1000, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(calls, ['tmux kill-session -t claude-user-pan', 'pm2 restart activity-monitor-user-pan --update-env']);
    } finally { tmp.cleanup(); }
  });

  it('policy restart still landing: no further policy restart is scheduled within the landing grace', () => {
    const sim = new Sim();
    sim.launchAll(sim.pass().restarts); // both Fable personas on Opus with the subagent pin
    sim.advance(MIN);
    sim.pass();
    sim.document.runtime_profiles[BACKUP].reasoning_effort = 'medium'; // Opus -> Opus policy change
    sim.advance(MIN);
    const first = sim.pass().restarts.filter(item => item.instanceId === 'user-pan');
    assert.deepEqual(first.map(item => item.attempt), [1]);
    // The restart is landing: the old launch record still describes its predecessor.
    sim.advance(1000);
    assert.deepEqual(sim.pass().restarts.filter(item => item.instanceId === 'user-pan'), [], 'no second attempt one second later');
    sim.advance(MIN);
    assert.deepEqual(sim.pass().restarts.filter(item => item.instanceId === 'user-pan'), []);
    sim.advance(3 * MIN); // the restart never landed: resumed once the grace is over
    assert.deepEqual(sim.pass().restarts.filter(item => item.instanceId === 'user-pan').map(item => item.attempt), [2]);
  });
});

describe('daemon / account failover / --apply share one executor (review-2 #4)', () => {
  async function failoverFixture() {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fable-guard-owners-'));
    const nowMs = Date.now();
    const document = documentFixture();
    document.runtime_failover = { enabled: true, chain: [BACKUP, CL], switch_threshold: 95, recover_threshold: 90, min_dwell_sec: 300 };
    fs.mkdirSync(path.join(zylosDir, 'activity-monitor'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify(document, null, 2) + '\n', { mode: 0o640 });
    const config = readFableGuardConfig(document);
    let usage = {};
    for (const account of [BACKUP, CL]) {
      for (let i = 3; i >= 1; i--) {
        usage = recordProbeResult(usage, { account, nowMs: nowMs - i * MIN, config, result: { outcome: 'valid',
          observation: { account, utilization: 0.1, resets_at: iso(nowMs + 2 * 86_400_000), observed_at: iso(nowMs - i * MIN),
            cli_version: '2.1.322', model: 'claude-fable-5-2', status: 'allowed' } } });
      }
    }
    fs.writeFileSync(fableUsagePath(zylosDir), JSON.stringify(usage));
    for (const id of PERSONAS) {
      fs.mkdirSync(path.join(zylosDir, 'activity-monitor', id), { recursive: true });
      fs.writeFileSync(path.join(zylosDir, 'activity-monitor', id, 'agent-status.json'), JSON.stringify({
        state: 'idle', health: 'ok', active_tools: 0, last_check: Math.floor(nowMs / 1000), runtime_launch_at: nowMs - 3_600_000 }));
    }
    const saved = process.env.ZYLOS_DIR;
    process.env.ZYLOS_DIR = zylosDir;
    const { applyRuntimeFailover } = await import(`../runtime-failover.js?owners=${nowMs}-${Math.random()}`);
    const restore = () => {
      if (saved === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = saved;
      fs.rmSync(zylosDir, { recursive: true, force: true });
    };
    const exhausted = { providers: { [BACKUP]: { available: true, primary: { used_percent: 99 } },
      [CL]: { available: true, primary: { used_percent: 10 } } } };
    return { zylosDir, nowMs, applyRuntimeFailover, restore, exhausted };
  }
  const effects = (calls, id) => calls.filter(call => call.includes(`claude-${id}`) || call.includes(`activity-monitor-${id}`))
    .filter(call => !/display-message|has-session/.test(call));

  it('an account failover never kills/restarts a persona whose --apply guard restart is in flight', async () => {
    const fx = await failoverFixture();
    try {
      const calls = [];
      const inner = [];
      let fired = false;
      const exec = (file, args) => {
        const call = [file, ...args].join(' ');
        calls.push(call);
        if (fired === false && call === 'tmux kill-session -t claude-user-pan') {
          fired = true; // the daemon's account failover runs while --apply's restart of pan is mid-flight
          fx.applyRuntimeFailover({ providerUsage: fx.exhausted, nowMs: fx.nowMs + 1000, log: () => {},
            execFileSyncImpl: (f, a) => { inner.push([f, ...a].join(' ')); return exec(f, a); } });
        }
        if (args[0] === 'has-session') throw Object.assign(new Error('exit 1'), { stderr: "can't find session" });
        return '';
      };
      reconcileFableGuardNow({ zylosDir: fx.zylosDir, nowMs: fx.nowMs, execFileSyncImpl: exec, log: () => {} });
      assert.equal(fired, true);
      assert.ok(effects(inner, 'admin').length > 0, 'the failover still restarts the personas the guard does not own');
      assert.deepEqual(effects(inner, 'user-pan'), [], 'no overlapping kill/pm2 for pan');
      assert.deepEqual(effects(calls, 'user-pan'), ['tmux kill-session -t claude-user-pan', 'pm2 restart activity-monitor-user-pan --update-env']);
      assert.equal(effects(calls, 'user-elaine').filter(call => call.startsWith('tmux kill-session')).length, 1, 'elaine restarted once');
    } finally { fx.restore(); }
  });

  it('--apply during an account failover restart of an owned persona does not restart it again', async () => {
    const fx = await failoverFixture();
    try {
      // First pass: the guard upgrades both Fable personas (restarts land), so the next failover is the only change.
      fx.applyRuntimeFailover({ providerUsage: { providers: { [BACKUP]: { available: true, primary: { used_percent: 10 } },
        [CL]: { available: true, primary: { used_percent: 10 } } } }, nowMs: fx.nowMs, log: () => {},
      execFileSyncImpl: (f, a) => (a[0] === 'has-session' ? (() => { throw Object.assign(new Error('x'), { stderr: "can't find session" }); })() : '') });
      const calls = [];
      let fired = false;
      const exec = (file, args) => {
        const call = [file, ...args].join(' ');
        calls.push(call);
        if (!fired && call === 'tmux kill-session -t claude-user-pan') {
          fired = true;
          reconcileFableGuardNow({ zylosDir: fx.zylosDir, nowMs: fx.nowMs + 31 * MIN, execFileSyncImpl: exec, log: () => {} });
        }
        return '';
      };
      fx.applyRuntimeFailover({ providerUsage: fx.exhausted, nowMs: fx.nowMs + 31 * MIN, log: () => {}, execFileSyncImpl: exec });
      assert.equal(fired, true);
      assert.equal(effects(calls, 'user-pan').filter(call => call.startsWith('tmux kill-session')).length, 1);
      assert.equal(effects(calls, 'user-pan').filter(call => call.startsWith('pm2 restart')).length, 1);
    } finally { fx.restore(); }
  });

  it('an account-failover suspend of an owned persona waits for the in-flight restart, then runs once', async () => {
    // The failover suspends a persona only after a Codex model downshift with no usable tier; the
    // executor item it builds for a guard-owned persona is driven here directly.
    const fx = await failoverFixture();
    try {
      const { claimExecution, completeExecution } = await import('../fable-exec-claim.js');
      const { drainDeferredFableEffects } = await import('../fable-guard.js');
      const held = claimExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', nowMs: fx.nowMs,
        op: { owner: 'reconcile', kind: 'restart', generation: 99, attempt: 1 } });
      assert.equal(held.ok, true);
      const at = iso(fx.nowMs);
      const doc = JSON.parse(fs.readFileSync(path.join(fx.zylosDir, 'instances.json'), 'utf8'));
      doc.instances['user-pan'].runtime_failover_suspended = { reason: 'model_downshift:gpt-mini', profile: BACKUP, at };
      fs.writeFileSync(path.join(fx.zylosDir, 'instances.json'), JSON.stringify(doc));
      const suspend = { instanceId: 'user-pan', owner: 'failover', kind: 'suspend', generation: null, attempt: null, profileId: null,
        suspendedAt: at, tmuxSession: 'claude-user-pan', reason: 'account_failover:model_downshift:gpt-mini' };
      const calls = [];
      const exec = (file, args) => { calls.push([file, ...args].join(' ')); return ''; };
      executeFableRestarts({ zylosDir: fx.zylosDir, restarts: [suspend], nowMs: fx.nowMs + 1000, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(calls, [], 'not while the restart is in flight');
      drainDeferredFableEffects({ zylosDir: fx.zylosDir, nowMs: fx.nowMs + 2000, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(calls, [], 'still deferred while the claim is held');
      completeExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', token: held.token, outcome: 'done', nowMs: fx.nowMs + 3000 });
      drainDeferredFableEffects({ zylosDir: fx.zylosDir, nowMs: fx.nowMs + 4000, execFileSyncImpl: exec, log: () => {} });
      assert.deepEqual(calls, ['tmux kill-session -t claude-user-pan', 'pm2 stop activity-monitor-user-pan']);
      drainDeferredFableEffects({ zylosDir: fx.zylosDir, nowMs: fx.nowMs + 5000, execFileSyncImpl: exec, log: () => {} });
      assert.equal(calls.length, 2, 'and only once');
      // A deferred suspend the failover has since lifted is dropped, not run.
      const lifted = { ...suspend, suspendedAt: iso(fx.nowMs + 60_000) };
      const again = claimExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', nowMs: fx.nowMs + 61_000,
        op: { owner: 'reconcile', kind: 'restart', generation: 100, attempt: 1 } });
      executeFableRestarts({ zylosDir: fx.zylosDir, restarts: [lifted], nowMs: fx.nowMs + 61_000, execFileSyncImpl: exec, log: () => {} });
      completeExecution({ zylosDir: fx.zylosDir, instanceId: 'user-pan', token: again.token, outcome: 'done', nowMs: fx.nowMs + 62_000 });
      drainDeferredFableEffects({ zylosDir: fx.zylosDir, nowMs: fx.nowMs + 63_000, execFileSyncImpl: exec, log: () => {} });
      assert.equal(calls.length, 2, 'a suspend that no longer matches instances.json is not executed');
    } finally { fx.restore(); }
  });
});

describe('Fable guard readiness accepts a late genuine ACK (review-2 #6)', () => {
  it('late real ACK: ack_missing / no_probe_result move to ready when a real ACK from the launch arrives', () => {
    const sim = new Sim();
    sim.toFable();
    sim.observe(BACKUP, 0.8);
    sim.launchAll(sim.pass().restarts);
    sim.advance(MIN);
    sim.pass();
    sim.readiness['user-pan'] = { launch_id: sim.launches['user-pan'].launch_id, outcome: 'missing', status: 'timeout', at: iso(sim.now) };
    sim.advance(MIN);
    sim.pass();
    assert.equal(sim.state.personas['user-pan'].verified.readiness, 'ack_missing');
    sim.readiness['user-pan'] = { launch_id: sim.launches['user-pan'].launch_id, outcome: 'ack', phase: 'post_restart', at: iso(sim.now) };
    sim.advance(MIN);
    const result = sim.pass();
    assert.equal(sim.state.personas['user-pan'].verified.ready_at, iso(sim.now - MIN));
    assert.equal(sim.state.personas['user-pan'].verified.readiness, undefined);
    assert.ok(result.events.some(event => event.includes('user-pan') && /readiness recovered/.test(event)));

    sim.advance(31 * MIN); // elaine never got a probe result
    sim.pass();
    assert.equal(sim.state.personas['user-elaine'].verified.readiness, 'no_probe_result');
    sim.status['user-elaine'].functional_ack_at = sim.now;
    sim.status['user-elaine'].functional_ack_phase = 'recovery';
    sim.advance(MIN);
    sim.pass();
    assert.ok(sim.state.personas['user-elaine'].verified.ready_at);
    assert.equal(sim.state.personas['user-elaine'].verified.readiness, undefined);
  });
});

