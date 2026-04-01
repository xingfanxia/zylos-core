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
  });
});
