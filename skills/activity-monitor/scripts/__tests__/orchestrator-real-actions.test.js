/**
 * ZY-DEPLOY-1 regression — the orchestrator's DEFAULT (real) actions must wire
 * their args correctly. The main suite uses fake actions, so it missed that
 * runC4SessionInit passed the SessionStart payload where initC4Session expects
 * an instance id ("too few parameter values"). This spawns the real orchestrator
 * against a temp ZYLOS_DIR and asserts c4-session-init actually runs.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCH = fileURLToPath(new URL('../session-start-orchestrator.js', import.meta.url));
let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-real-'));
  fs.mkdirSync(path.join(tmp, 'comm-bridge'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'memory', 'instances', 'admin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'instances.json'), JSON.stringify({
    version: 1,
    instances: { admin: { primary: true, enabled: true, tmux_session: 'claude-admin' } },
  }));
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('orchestrator real actions', () => {
  it('runs c4-session-init with the env instance id (no payload-as-id SQL error)', () => {
    const r = spawnSync('node', [ORCH], {
      input: JSON.stringify({ source: 'startup', session_id: 't' }),
      env: { ...process.env, ZYLOS_DIR: tmp, ZYLOS_INSTANCE_ID: 'admin' },
      encoding: 'utf8',
      timeout: 25_000,
    });
    assert.equal(r.status, 0);
    // The bug printed this to stderr and emitted a C4-SESSION-INIT UNAVAILABLE notice.
    assert.doesNotMatch(r.stderr || '', /too few parameter values/i);
    assert.doesNotMatch(r.stdout || '', /C4-SESSION-INIT UNAVAILABLE/);
    // c4-session-init produced its section (empty temp DB → the no-conversations line).
    assert.match(r.stdout || '', /=== RECENT CONVERSATIONS ===/);
  });
});
