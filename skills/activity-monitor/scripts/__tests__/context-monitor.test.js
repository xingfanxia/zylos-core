import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

const tmpDirs = [];
const SCRIPT_PATH = path.resolve(process.cwd(), 'skills/activity-monitor/scripts/context-monitor.js');

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function runContextMonitor({ zylosDir, instanceId = 'admin', payload }) {
  const env = {
    ...process.env,
    ZYLOS_DIR: zylosDir,
    ZYLOS_INSTANCE_ID: instanceId,
  };
  return spawnSync('node', [SCRIPT_PATH], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

// Build a temp ZYLOS_DIR with a capturing c4-control stub, optional config.json,
// and optional pre-seeded monitor state (instance 'admin').
function setupZylos({ config, seedState } = {}) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-cm-'));
  tmpDirs.push(zylosDir);
  const c4Dir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
  fs.mkdirSync(c4Dir, { recursive: true });
  const captureFile = path.join(zylosDir, 'c4-args.json');
  fs.writeFileSync(path.join(c4Dir, 'c4-control.js'), `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2), null, 2));
console.log('OK: enqueued control 1');
`, 'utf8');
  if (config) {
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify(config), 'utf8');
  }
  if (seedState) {
    const stateDir = path.join(zylosDir, 'activity-monitor', 'admin');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'context-monitor-state.json'), JSON.stringify(seedState), 'utf8');
  }
  return { zylosDir, captureFile };
}

function enqueuedArgs(captureFile) {
  try { return JSON.parse(fs.readFileSync(captureFile, 'utf8')); } catch { return null; }
}

function enqueuedContent(captureFile) {
  const args = enqueuedArgs(captureFile);
  return args ? args[args.indexOf('--content') + 1] : null;
}

function payloadAt(pct, sessionId = 'sess') {
  return {
    session_id: sessionId,
    context_window: {
      used_percentage: pct,
      remaining_percentage: 100 - pct,
      context_window_size: 1000000,
    },
  };
}

describe('context-monitor', () => {
  it('writes normalized context-window state for Claude statusline payloads', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-context-monitor-test-'));
    tmpDirs.push(zylosDir);

    const result = runContextMonitor({
      zylosDir,
      payload: {
        session_id: 'claude-session-1',
        context_window: {
          used_percentage: 42,
          remaining_percentage: 58,
          context_window_size: 200000,
        },
        cost: {
          total_cost_usd: 1.23,
        },
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const stateDir = path.join(zylosDir, 'activity-monitor', 'admin');
    const statusline = JSON.parse(fs.readFileSync(path.join(stateDir, 'statusline.json'), 'utf8'));
    const contextWindow = JSON.parse(fs.readFileSync(path.join(stateDir, 'context-window.json'), 'utf8'));

    assert.equal(statusline.context_window.used_percentage, 42);
    assert.equal(contextWindow.runtime, 'claude');
    assert.equal(contextWindow.instance_id, 'admin');
    assert.equal(contextWindow.source, 'claude_statusline');
    assert.equal(contextWindow.percent_used, 42);
    assert.equal(contextWindow.percent_remaining, 58);
    assert.equal(contextWindow.ceiling_tokens, 200000);
    assert.equal(contextWindow.used_tokens, 84000);
    assert.equal(contextWindow.session_id, 'claude-session-1');
  });

  it('writes last-context-handoff and targets the current instance when threshold is exceeded', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-context-monitor-threshold-test-'));
    tmpDirs.push(zylosDir);

    const c4Dir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
    fs.mkdirSync(c4Dir, { recursive: true });
    const captureFile = path.join(zylosDir, 'c4-args.json');
    fs.writeFileSync(path.join(c4Dir, 'c4-control.js'), `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2), null, 2));
console.log('OK: enqueued control 1');
`, 'utf8');

    const result = runContextMonitor({
      zylosDir,
      payload: {
        session_id: 'claude-session-2',
        context_window: {
          used_percentage: 71,
          remaining_percentage: 29,
          context_window_size: 200000,
        },
        cost: {
          total_cost_usd: 4.56,
        },
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const stateDir = path.join(zylosDir, 'activity-monitor', 'admin');
    const handoff = JSON.parse(fs.readFileSync(path.join(stateDir, 'last-context-handoff.json'), 'utf8'));
    const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));

    assert.equal(handoff.runtime, 'claude');
    assert.equal(handoff.source, 'claude_statusline');
    assert.equal(handoff.percent_used, 71);
    assert.equal(handoff.ceiling_tokens, 200000);
    assert.equal(handoff.enqueue_ok, true);
    assert.ok(args.includes('--target-instance'));
    assert.equal(args[args.indexOf('--target-instance') + 1], 'admin');
    // Graceful band (71% < 88% hard ceiling): prompt the skill, do NOT force /clear.
    const content = args[args.indexOf('--content') + 1];
    assert.match(content, /new-session skill/);
    assert.notEqual(content, '/clear');
    assert.ok(!args.includes('--block-queue-until-idle'));
  });

  it('forces a direct /clear (no require_idle) at the hard ceiling', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-context-monitor-ceiling-test-'));
    tmpDirs.push(zylosDir);

    const c4Dir = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
    fs.mkdirSync(c4Dir, { recursive: true });
    const captureFile = path.join(zylosDir, 'c4-args.json');
    fs.writeFileSync(path.join(c4Dir, 'c4-control.js'), `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2), null, 2));
console.log('OK: enqueued control 1');
`, 'utf8');

    const result = runContextMonitor({
      zylosDir,
      payload: {
        session_id: 'claude-session-3',
        context_window: {
          used_percentage: 90,
          remaining_percentage: 10,
          context_window_size: 1000000,
        },
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const args = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    const content = args[args.indexOf('--content') + 1];

    // Forced reset: /clear delivered verbatim, with bypass-state, and crucially
    // WITHOUT --block-queue-until-idle (require_idle) so it cannot be starved.
    assert.equal(content, '/clear');
    assert.ok(args.includes('--bypass-state'));
    assert.ok(!args.includes('--block-queue-until-idle'));
    assert.ok(!args.includes('--require-idle'));
    assert.ok(args.includes('--target-instance'));
  });

  it('forces at the exact ceiling boundary and stays graceful one below', () => {
    // Default config: restart 70, ceiling 88.
    const { zylosDir, captureFile } = setupZylos({});
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(87) }).status, 0);
    assert.notEqual(enqueuedContent(captureFile), '/clear');
    fs.rmSync(captureFile, { force: true });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(88) }).status, 0);
    assert.equal(enqueuedContent(captureFile), '/clear');
  });

  it('clamps the hard ceiling strictly above the restart threshold', () => {
    // hard_ceiling_threshold 40 sits below new_session_threshold 50 → clamp to 51.
    const { zylosDir, captureFile } = setupZylos({
      config: { new_session_threshold: 50, hard_ceiling_threshold: 40 },
    });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(50) }).status, 0);
    assert.notEqual(enqueuedContent(captureFile), '/clear'); // 50 < clamped ceiling 51
    fs.rmSync(captureFile, { force: true });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(51) }).status, 0);
    assert.equal(enqueuedContent(captureFile), '/clear');    // 51 >= 51 forced
  });

  it('falls back to the default ceiling on a malformed hard_ceiling_threshold', () => {
    // Invalid value → default 88 (not NaN, which would force every band).
    const { zylosDir, captureFile } = setupZylos({ config: { hard_ceiling_threshold: 'abc' } });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(87) }).status, 0);
    assert.notEqual(enqueuedContent(captureFile), '/clear');
    fs.rmSync(captureFile, { force: true });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(88) }).status, 0);
    assert.equal(enqueuedContent(captureFile), '/clear');
  });

  it('fires the forced /clear even when a graceful trigger just fired (decoupled cooldown)', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { zylosDir, captureFile } = setupZylos({
      config: { new_session_threshold: 50 },
      seedState: { session_id: 'sess', last_trigger_at: nowSec }, // graceful cooldown active
    });
    const r = runContextMonitor({ zylosDir, payload: payloadAt(90, 'sess') });
    assert.equal(r.status, 0, r.stderr);
    // The graceful 300s cooldown must NOT suppress the first forced crossing.
    assert.equal(enqueuedContent(captureFile), '/clear');
  });

  it('respects its own re-assert cooldown for repeated forced triggers', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // Just forced → suppressed (within FORCED_REASSERT_SECONDS).
    const a = setupZylos({
      config: { new_session_threshold: 50 },
      seedState: { session_id: 'sess', last_forced_trigger_at: nowSec },
    });
    assert.equal(runContextMonitor({ zylosDir: a.zylosDir, payload: payloadAt(90, 'sess') }).status, 0);
    assert.equal(enqueuedArgs(a.captureFile), null); // no enqueue

    // Forced long ago → re-asserts so it re-wins c4-db's content-only supersede.
    const b = setupZylos({
      config: { new_session_threshold: 50 },
      seedState: { session_id: 'sess', last_forced_trigger_at: nowSec - 120 },
    });
    assert.equal(runContextMonitor({ zylosDir: b.zylosDir, payload: payloadAt(90, 'sess') }).status, 0);
    assert.equal(enqueuedContent(b.captureFile), '/clear');
  });

  it('disarms instead of re-firing when the session rotated after a forced /clear', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Forced fired long ago for session A; now we see a fresh session B still
    // reporting >= ceiling (e.g. a stale post-clear reading). Must NOT re-fire.
    const { zylosDir, captureFile } = setupZylos({
      config: { new_session_threshold: 50 },
      seedState: { session_id: 'A', last_forced_session_id: 'A', last_forced_trigger_at: nowSec - 120 },
    });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(90, 'B') }).status, 0);
    assert.equal(enqueuedArgs(captureFile), null); // disarmed, no /clear

    // And it disarmed: timer cleared, session pointer advanced to B.
    const state = JSON.parse(fs.readFileSync(
      path.join(zylosDir, 'activity-monitor', 'admin', 'context-monitor-state.json'), 'utf8'));
    assert.equal(state.last_forced_trigger_at, null);
    assert.equal(state.last_forced_session_id, 'B');
  });

  it('forces again once the rotated session itself climbs back to the ceiling', () => {
    // After disarm, the same fresh session B (timer cleared) at >= ceiling fires.
    const { zylosDir, captureFile } = setupZylos({
      config: { new_session_threshold: 50 },
      seedState: { session_id: 'B', last_forced_session_id: 'B', last_forced_trigger_at: null },
    });
    assert.equal(runContextMonitor({ zylosDir, payload: payloadAt(90, 'B') }).status, 0);
    assert.equal(enqueuedContent(captureFile), '/clear');
  });

  it('persists session/cost state on the usedPct == null path (save-on-every-path)', () => {
    // No context_window → usedPct is null → main returns early, but must still
    // persist trackSessionCost's session/cost mutation (single-save contract).
    const { zylosDir } = setupZylos({
      seedState: { session_id: 'old', last_cost: 5 },
    });
    const r = runContextMonitor({
      zylosDir,
      payload: { session_id: 'new', cost: { total_cost_usd: 0.2 } },
    });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(fs.readFileSync(
      path.join(zylosDir, 'activity-monitor', 'admin', 'context-monitor-state.json'), 'utf8'));
    assert.equal(state.session_id, 'new');
    assert.equal(state.last_cost, 0.2);
    assert.equal(state.last_logged_session_id, 'old');
  });
});
