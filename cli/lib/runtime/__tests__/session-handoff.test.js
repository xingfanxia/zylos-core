import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const originalInstanceId = process.env.ZYLOS_INSTANCE_ID;

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.ZYLOS_INSTANCE_ID;
  else process.env.ZYLOS_INSTANCE_ID = originalInstanceId;
});

describe('enqueueNewSession', () => {
  it('targets the current instance in multi-session mode', async () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    const mod = await import(`../session-handoff.js?instance=${Date.now()}`);

    const calls = [];
    const ok = mod.enqueueNewSession({
      ratio: 0.9,
      used: 900000,
      ceiling: 1000000,
      runtime: 'codex',
      execFileSyncImpl: (cmd, args) => {
        calls.push({ cmd, args });
        return 'OK';
      },
    });

    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'node');
    assert.ok(calls[0].args.includes('--target-instance'));
    const idx = calls[0].args.indexOf('--target-instance');
    assert.equal(calls[0].args[idx + 1], 'admin');
  });

  it('does not add a target-instance in single-session mode', async () => {
    delete process.env.ZYLOS_INSTANCE_ID;
    const mod = await import(`../session-handoff.js?single=${Date.now()}`);

    const calls = [];
    const ok = mod.enqueueNewSession({
      ratio: 0.8,
      used: 800000,
      ceiling: 1000000,
      runtime: 'claude',
      instanceId: null,
      execFileSyncImpl: (cmd, args) => {
        calls.push({ cmd, args });
        return 'OK';
      },
    });

    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes('--target-instance'), false);
  });
});
