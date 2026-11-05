import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readCodexTurnOutcomeFromLines, detectCodexQuotaFromLines } from '../heartbeat/codex-probe.js';

const started = ts => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started' } });
const complete = (ts, code) => JSON.stringify({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    last_agent_message: null,
    ...(code ? { error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: code } } : {}),
  },
});
const tokens = ts => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count' } });

describe('readCodexTurnOutcomeFromLines', () => {
  it('reports an overloaded turn from its terminal event', () => {
    const lines = [started('2026-11-05T16:03:18.832Z'), complete('2026-11-05T16:03:52.343Z', 'server_overloaded'), tokens('2026-11-05T16:03:52.400Z'), ''];
    assert.deepEqual(readCodexTurnOutcomeFromLines(lines), {
      outcome: 'overloaded', endedAtMs: Date.parse('2026-11-05T16:03:52.343Z'), code: 'server_overloaded',
    });
  });

  it('a later turn replaces the overload: running, then success', () => {
    const base = [complete('2026-11-05T16:03:52.343Z', 'server_overloaded'), started('2026-11-05T16:18:27.271Z')];
    assert.equal(readCodexTurnOutcomeFromLines(base).outcome, 'running');
    assert.equal(readCodexTurnOutcomeFromLines([...base, complete('2026-11-05T16:19:00.000Z')]).outcome, 'success');
  });

  it('ignores outcomes from before the foreground session was observed', () => {
    const lines = [complete('2026-11-05T16:03:52.343Z', 'server_overloaded')];
    assert.equal(readCodexTurnOutcomeFromLines(lines, { sinceMs: Date.parse('2026-11-05T16:10:00Z') }).outcome, 'none');
  });

  it('keeps other provider errors apart from overload and quota', () => {
    const lines = [complete('2026-11-05T16:03:52.343Z', 'usage_limit_exceeded')];
    assert.equal(readCodexTurnOutcomeFromLines(lines).outcome, 'error');
    assert.equal(detectCodexQuotaFromLines([complete('2026-11-05T16:03:52.343Z', 'server_overloaded')]).detected, false);
  });
});
