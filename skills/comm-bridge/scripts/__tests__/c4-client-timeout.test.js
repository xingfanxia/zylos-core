import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// A send's broker reply arrives only after the channel finishes uploading the
// attachment. On 2026-11-06 an image send outlived the 8 s client timeout, was
// reported as failed, still landed, and the agent's retry duplicated it.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-client-timeout-'));
const state = path.join(root, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ instances: {
  'inst-a': { os_user: os.userInfo().username, state_dir: state },
} }));
process.env.ZYLOS_DIR = root;
process.env.ZYLOS_INSTANCE_ID = 'inst-a';
const { brokerCall, BROKER_OP_TIMEOUT_MS } = await import('../c4-client.js');

async function broker(t, delayMs) {
  const server = net.createServer((socket) => {
    socket.on('data', (part) => {
      const request = JSON.parse(String(part).split('\n')[0]);
      setTimeout(() => socket.end(JSON.stringify({ id: request.id, ok: true, data: { sent: true } }) + '\n'), delayMs);
    });
  });
  await new Promise((resolve) => server.listen(path.join(state, 'c4-broker.sock'), resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('send waits far longer than the 8 s default for an attachment upload', () => {
  assert.ok(BROKER_OP_TIMEOUT_MS.send >= 60000);
});

test('a timeout is a typed unknown outcome, not a broker error', async (t) => {
  await broker(t, 500);
  await assert.rejects(brokerCall('send', {}, 'inst-a', { timeoutMs: 50 }),
    (err) => err.code === 'BROKER_TIMEOUT' && err.message === 'broker: timeout');
});
