import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createCodexProbe } from '../heartbeat/codex-probe.js';

let tmpDir;
let originalPath;
let originalInstance;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-probe-'));
  originalPath = process.env.PATH;
  originalInstance = process.env.ZYLOS_INSTANCE_ID;

  const fakeNode = path.join(tmpDir, 'node');
  fs.writeFileSync(fakeNode, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$CODEX_PROBE_CAPTURE"',
    'printf "OK: enqueued control 42\\n"',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${tmpDir}:${originalPath}`;
  process.env.CODEX_PROBE_CAPTURE = path.join(tmpDir, 'args.txt');
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalInstance === undefined) delete process.env.ZYLOS_INSTANCE_ID;
  else process.env.ZYLOS_INSTANCE_ID = originalInstance;
  delete process.env.CODEX_PROBE_CAPTURE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Codex heartbeat routing', () => {
  it('targets the active persona in multi-session mode', () => {
    process.env.ZYLOS_INSTANCE_ID = 'scheduler';
    const probe = createCodexProbe({ pendingFile: path.join(tmpDir, 'pending.json') });

    assert.equal(probe.enqueueHeartbeat('recovery'), true);

    const args = fs.readFileSync(process.env.CODEX_PROBE_CAPTURE, 'utf8').trim().split('\n');
    const targetIndex = args.indexOf('--target-instance');
    assert.ok(targetIndex >= 0);
    assert.equal(args[targetIndex + 1], 'scheduler');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'pending.json'), 'utf8')).control_id, 42);
  });
});
