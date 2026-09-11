import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const emitterPath = fileURLToPath(new URL('../c4-session-init.js', import.meta.url));

async function fixture(t, response) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-shard-client-'));
  const state = path.join(root, 'state-a');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(root, 'instances.json'), JSON.stringify({ instances: {
    'inst-a': { os_user: os.userInfo().username, state_dir: state },
    'inst-b': { os_user: 'someone-else', state_dir: path.join(root, 'state-b') },
  } }));
  // Any accidental direct C4 DB open would fail; the shard must use the socket.
  fs.writeFileSync(path.join(root, 'comm-bridge'), 'NOT_A_DATABASE_DIRECTORY');
  const requests = [];
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (part) => {
      data += part;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]);
      requests.push(request);
      socket.end(JSON.stringify({ id: request.id, ...response(request) }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(path.join(state, 'c4-broker.sock'), resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  async function emit(section) {
    const script = `const m=await import(${JSON.stringify(emitterPath)});try {const text = ${section === 'checkpoint'
      ? "await m.emitC4Checkpoint(null,{instanceId:'inst-b'})"
      : "await m.emitC4Conversations(null,{maxChars:3000,maxTokens:700},{instanceId:'inst-b'})"};console.log(JSON.stringify({text}));}
      catch(error){console.log(JSON.stringify({error:error.message}));process.exitCode=1;}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ZYLOS_DIR: root, ZYLOS_INSTANCE_ID: 'inst-a' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => { stdout += s; });
    child.stderr.on('data', (s) => { stderr += s; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, data: JSON.parse(stdout), stderr };
  }
  return { emit, requests };
}

test('isolated startup shard emitters use their own broker before importing the DB', async (t) => {
  const f = await fixture(t, (req) => ({ ok: true, data: { section: req.params.section, context: 'OWN_' + req.params.section } }));
  for (const section of ['checkpoint', 'conversations']) {
    const result = await f.emit(section);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.data.text, 'OWN_' + section);
  }
  assert.deepEqual(f.requests.map((r) => r.op), ['session-init', 'session-init']);
  assert.ok(f.requests.every((r) => !('instanceId' in r.params) && !('target_instance' in r.params)));
  assert.deepEqual(f.requests[1].params.budget, { maxChars: 3000, maxTokens: 700 });
});

test('broker failures reject the shard with no direct/global database fallback', async (t) => {
  const f = await fixture(t, () => ({ ok: false, error: 'fixture_broker_failure' }));
  const result = await f.emit('checkpoint');
  assert.equal(result.code, 1);
  assert.match(result.data.error, /fixture_broker_failure/);
  assert.equal(result.data.text, undefined);
});

test('old combined broker responses cannot masquerade as a successful requested shard', async (t) => {
  const f = await fixture(t, () => ({ ok: true, data: { context: 'COMBINED_CONTEXT' } }));
  const result = await f.emit('conversations');
  assert.equal(result.code, 1);
  assert.match(result.data.error, /requested conversations startup shard/);
});
