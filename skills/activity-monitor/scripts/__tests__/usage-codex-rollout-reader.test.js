import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  extractRolloutCwdFromLines,
  getActiveRolloutPath,
  parseCodexUsageFromRolloutLines,
} from '../usage-codex-rollout-reader.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('usage-codex-rollout-reader', () => {
  it('parses primary and secondary rate limits from token_count events', () => {
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 36, window_minutes: 300, resets_at: 1774530477 },
            secondary: { used_percent: 49, window_minutes: 10080, resets_at: 1775026972 }
          }
        }
      })
    ];

    const result = parseCodexUsageFromRolloutLines(lines);
    assert.equal(result.sessionPercent, 36);
    assert.equal(result.fiveHourPercent, 36);
    assert.equal(result.weeklyAllPercent, 49);
    assert.equal(result.statusShape, 'rollout');
    assert.match(result.fiveHourResets, /^\d{2}:\d{2}( on (?:\d{1,2} \w{3}|\w{3} \d{1,2}))?$/);
    assert.match(result.weeklyAllResets, /^\d{2}:\d{2}( on (?:\d{1,2} \w{3}|\w{3} \d{1,2}))?$/);
  });

  it('prefers the latest token_count event in the rollout tail', () => {
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 12, resets_at: 1774530000 },
            secondary: { used_percent: 20, resets_at: 1775026000 }
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 36, resets_at: 1774530477 },
            secondary: { used_percent: 49, resets_at: 1775026972 }
          }
        }
      })
    ];

    const result = parseCodexUsageFromRolloutLines(lines);
    assert.equal(result.sessionPercent, 36);
    assert.equal(result.weeklyAllPercent, 49);
  });

  it('returns null when no usable rate limits are present', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { foo: 'bar' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    ];

    assert.equal(parseCodexUsageFromRolloutLines(lines), null);
  });

  it('extracts cwd from rollout session metadata', () => {
    const cwd = extractRolloutCwdFromLines([
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/home/xingfanxia/zylos/instances/admin' },
      }),
    ]);

    assert.equal(cwd, '/home/xingfanxia/zylos/instances/admin');
  });

  it('scopes filesystem fallback rollout lookup to the requested instance', () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-rollout-test-'));
    tmpDirs.push(sessionsDir);

    const todayDir = path.join(sessionsDir, '2026', '04', '01');
    fs.mkdirSync(todayDir, { recursive: true });

    const adminPath = path.join(todayDir, 'rollout-admin.jsonl');
    const bettyPath = path.join(todayDir, 'rollout-betty.jsonl');

    fs.writeFileSync(adminPath, `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/admin' } })}\n`);
    fs.writeFileSync(bettyPath, `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/xingfanxia/zylos/instances/user-betty' } })}\n`);

    const earlier = new Date('2026-04-01T08:00:00.000Z');
    const later = new Date('2026-04-01T09:00:00.000Z');
    fs.utimesSync(adminPath, earlier, earlier);
    fs.utimesSync(bettyPath, later, later);

    const chosen = getActiveRolloutPath({
      instanceId: 'admin',
      sessionsDir,
      execFileSyncImpl: () => {
        throw new Error('sqlite unavailable');
      },
    });

    assert.equal(chosen, adminPath);
  });
});
