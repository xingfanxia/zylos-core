/**
 * c4-dispatcher — loop-level observability helpers (heartbeat + watchdog).
 *
 * The dispatcher loop's two liveness decisions are extracted as pure, exported
 * functions (injected `now`) so they can be unit-tested without the live loop.
 * Importing c4-dispatcher.js would otherwise auto-start the dispatcher inside
 * the test process; C4_DISPATCHER_DISABLE_MAIN=1 suppresses that (same guard as
 * c4-dispatcher-multi.test.js). ZYLOS_DIR points DB/config at a throwaway dir.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-disp-loop-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';

const {
  shouldEmitHeartbeat,
  isWatchdogExpired,
  formatHeartbeatLine,
  runDispatcherTick,
  getLastTickCompletedAt,
} = await import('../c4-dispatcher.js');

describe('shouldEmitHeartbeat', () => {
  it('emits at or past the interval so silence implies a dead loop', () => {
    assert.equal(shouldEmitHeartbeat(60000, 0, 60000), true);   // exactly one interval
    assert.equal(shouldEmitHeartbeat(60001, 0, 60000), true);   // past the interval
  });

  it('stays silent before the interval has elapsed', () => {
    assert.equal(shouldEmitHeartbeat(59999, 0, 60000), false);
    assert.equal(shouldEmitHeartbeat(1000, 1000, 60000), false); // same instant
  });
});

describe('isWatchdogExpired', () => {
  it('expires only after a tick has been silent LONGER than the max', () => {
    assert.equal(isWatchdogExpired(300001, 0, 300000), true);
  });

  it('does not expire at or under the threshold', () => {
    // Exactly at the max is not expired (strict >), so a healthy long
    // require_idle delivery is never falsely killed.
    assert.equal(isWatchdogExpired(300000, 0, 300000), false);
    // An alive-but-erroring loop keeps updating lastTickCompletedAt, so a
    // recent tick must read as healthy.
    assert.equal(isWatchdogExpired(1000, 900, 300000), false);
  });
});

describe('formatHeartbeatLine', () => {
  it('renders pending counts, held breakdown, and last state', () => {
    const line = formatHeartbeatLine({
      pendingConv: 3,
      pendingControl: 1,
      held: 3,
      heldReasons: { unhealthy: 2, offline: 1 },
      state: 'skip_exhausted',
    });
    assert.match(line, /^dispatcher alive:/);
    assert.match(line, /3 pending-conv/);
    assert.match(line, /1 pending-control/);
    assert.match(line, /held=3/);
    assert.match(line, /unhealthy:2/);
    assert.match(line, /offline:1/);
    assert.match(line, /state=skip_exhausted/);
  });

  it('omits the brace breakdown when nothing is held', () => {
    const line = formatHeartbeatLine({
      pendingConv: 0, pendingControl: 0, held: 0, heldReasons: {}, state: 'idle',
    });
    assert.match(line, /held=0/);
    assert.doesNotMatch(line, /[{}]/);
    assert.match(line, /state=idle/);
  });

  it('defaults held/heldReasons when omitted (legacy single-session result)', () => {
    const line = formatHeartbeatLine({ pendingConv: 0, pendingControl: 0, state: 'idle' });
    assert.match(line, /held=0/);
    assert.match(line, /state=idle/);
  });
});

describe('runDispatcherTick — watchdog-clock refresh (LOW-7)', () => {
  // `now` is injected so the assertion is deterministic (no wall-clock timing).
  it('refreshes lastTickCompletedAt on an ERRORING tick so an alive-but-erroring loop is not falsely killed', async () => {
    const FROZEN = 5_000_000_000; // arbitrary, well past import-time Date.now()
    const { errored, result } = await runDispatcherTick(
      async () => { throw new Error('simulated tick failure'); },
      () => FROZEN,
    );
    assert.equal(errored, true);
    assert.equal(result.state, 'error');
    // The catch branch MUST advance the watchdog clock — if it regresses, an
    // erroring-but-alive loop would go stale and pm2-kill within WATCHDOG_MAX_TICK_MS.
    assert.equal(getLastTickCompletedAt(), FROZEN);
    assert.equal(isWatchdogExpired(FROZEN + 1000, getLastTickCompletedAt(), 300000), false);
  });

  it('refreshes lastTickCompletedAt on a normal (non-erroring) tick and reports its result', async () => {
    const FROZEN = 6_000_000_000;
    const { errored, result } = await runDispatcherTick(
      async () => ({ delivered: false, state: 'idle', held: 2, heldReasons: { unhealthy: 2 } }),
      () => FROZEN,
    );
    assert.equal(errored, false);
    assert.equal(result.state, 'idle');
    assert.equal(getLastTickCompletedAt(), FROZEN);
  });
});
