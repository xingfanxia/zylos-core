/**
 * c4-broker + egress-policy + c4-client — REAL module imports (no replica SQL,
 * no mocked DB). ZYLOS_DIR is pointed at a temp dir BEFORE the dynamic imports
 * so c4-config's module-level constants resolve to the sandbox.
 *
 * Covers: per-caller scoping (enqueue/get/ack/checkpoint/fetch/session-init),
 * egress policy, send happy-path via a fake channel, malformed/unknown ops, a
 * live socket round-trip, and the c4-client routing/SPOF decision.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// ── Sandbox scaffold (must precede the dynamic imports) ─────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-broker-'));
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_BROKER_DISABLE_MAIN = '1';
delete process.env.ZYLOS_INSTANCE_ID;

const stateDir = (id) => path.join(tmpDir, 'state', id);
for (const id of ['inst-a', 'inst-b', 'admin']) fs.mkdirSync(stateDir(id), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });

fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    'inst-a': { os_user: 'fake-a', state_dir: stateDir('inst-a'), tmux_session: 'claude-inst-a' },
    'inst-b': { os_user: 'fake-b', state_dir: stateDir('inst-b'), tmux_session: 'claude-inst-b' },
    'admin':  { primary: true, state_dir: stateDir('admin'), tmux_session: 'claude-main' },
  },
}));

// Fake channel so opSend can exercise the spawn path without real creds.
const chanDir = path.join(tmpDir, '.claude', 'skills', 'testchan', 'scripts');
fs.mkdirSync(chanDir, { recursive: true });
fs.writeFileSync(path.join(chanDir, 'send.js'), 'process.exit(0);\n');
const failChanDir = path.join(tmpDir, '.claude', 'skills', 'failchan', 'scripts');
fs.mkdirSync(failChanDir, { recursive: true });
fs.writeFileSync(path.join(failChanDir, 'send.js'), 'process.exit(3);\n');

// ── Dynamic imports (now see the sandbox env) ───────────────────────
const broker = await import('../c4-broker.js');
const egress = await import('../egress-policy.js');
const client = await import('../c4-client.js');
const { close: closeDb } = await import('../c4-db.js');

const openedSockets = [];
function open(id) { broker.ensureSocket(id); openedSockets.push(id); }

after(() => {
  for (const id of openedSockets) { try { broker.removeSocket(id); } catch { /* ignore */ } }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── egress-policy (pure) ────────────────────────────────────────────
describe('egress-policy', () => {
  const roots = ['/home/x/zylos/workspace/panpanmao-monorepo'];

  it('flags a path inside a source-tier root (textual fallback)', () => {
    const v = egress.checkPathViolation('workspace/panpanmao-monorepo/src/secret.ts', roots);
    assert.ok(v);
    assert.equal(v.root, 'panpanmao-monorepo');
  });

  it('passes a path outside any source-tier root', () => {
    assert.equal(egress.checkPathViolation('workspace/public-assets/logo.png', roots), null);
    assert.equal(egress.checkPathViolation('/tmp/chart.png', roots), null);
  });

  it('extracts a [MEDIA:...] path, null for plain text', () => {
    assert.equal(egress.mediaPathFromContent('[MEDIA:file]/tmp/a.pdf'), '/tmp/a.pdf');
    assert.equal(egress.mediaPathFromContent('[MEDIA:image]workspace/panpanmao-monorepo/x.png'),
      'workspace/panpanmao-monorepo/x.png');
    assert.equal(egress.mediaPathFromContent('hello world'), null);
  });
});

// ── broker.handleRequest — per-caller scoping ───────────────────────
describe('broker handleRequest', () => {
  it('enqueue forces target_instance to the caller and returns an id', async () => {
    const r = await broker.handleRequest({ op: 'enqueue', params: { content: 'hi-a', priority: 2 } }, 'inst-a');
    assert.equal(r.ok, true);
    assert.ok(Number.isInteger(r.data.id));
  });

  it('get/ack are forbidden across instances but allowed for the owner', async () => {
    const enq = await broker.handleRequest({ op: 'enqueue', params: { content: 'own-a' } }, 'inst-a');
    const id = enq.data.id;

    const cross = await broker.handleRequest({ op: 'get', params: { id } }, 'inst-b');
    assert.equal(cross.ok, false);
    assert.match(cross.error, /forbidden/);

    const ackCross = await broker.handleRequest({ op: 'ack', params: { id } }, 'inst-b');
    assert.equal(ackCross.ok, false);

    const own = await broker.handleRequest({ op: 'ack', params: { id } }, 'inst-a');
    assert.equal(own.ok, true);
    assert.equal(own.data.status, 'done');
  });

  it('checkpoint create + latest are caller-scoped', async () => {
    const created = await broker.handleRequest({ op: 'checkpoint', params: { endId: 5, summary: 's-a' } }, 'inst-a');
    assert.equal(created.ok, true);
    assert.equal(created.data.target_instance, 'inst-a');

    const latest = await broker.handleRequest({ op: 'checkpoint', params: { latest: true } }, 'inst-a');
    assert.equal(latest.ok, true);
    assert.equal(latest.data.summary, 's-a');
  });

  it('unsummarized + fetch return a range object', async () => {
    const u = await broker.handleRequest({ op: 'unsummarized' }, 'inst-a');
    assert.equal(u.ok, true);
    assert.ok('count' in u.data);

    const f = await broker.handleRequest({ op: 'fetch', params: { unsummarized: true } }, 'inst-a');
    assert.equal(f.ok, true);
    assert.ok('range' in f.data);
  });

  it('session-init returns a context string', async () => {
    const s = await broker.handleRequest({ op: 'session-init' }, 'inst-a');
    assert.equal(s.ok, true);
    assert.equal(typeof s.data.context, 'string');
  });

  it('rejects unknown ops and missing content', async () => {
    const unknown = await broker.handleRequest({ op: 'nope' }, 'inst-a');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown_op/);

    const noContent = await broker.handleRequest({ op: 'enqueue', params: {} }, 'inst-a');
    assert.equal(noContent.ok, false);
  });

  it('send: happy path via a fake channel, and channel failure surfaces', async () => {
    const ok = await broker.handleRequest({ op: 'send', params: { channel: 'testchan', endpoint: 'e1', content: 'hello' } }, 'inst-a');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.data.sent, true);

    const fail = await broker.handleRequest({ op: 'send', params: { channel: 'failchan', endpoint: 'e1', content: 'hello' } }, 'inst-a');
    assert.equal(fail.ok, false);
    assert.match(fail.error, /channel_send_failed/);

    const missing = await broker.handleRequest({ op: 'send', params: { channel: 'nochan', content: 'x' } }, 'inst-a');
    assert.equal(missing.ok, false);
  });
});

// ── Live socket round-trip ──────────────────────────────────────────
describe('broker socket round-trip', () => {
  function roundTrip(sockPath, req) {
    return new Promise((resolve, reject) => {
      const c = net.createConnection(sockPath);
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
      c.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, nl))); }
      });
      c.on('error', reject);
      setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 3000);
    });
  }

  it('serves ping + enqueue over the unix socket', async () => {
    open('inst-a');
    const sockPath = broker.socketPathFor('inst-a');
    assert.ok(fs.statSync(sockPath).isSocket());

    const pong = await roundTrip(sockPath, { id: 1, op: 'ping' });
    assert.equal(pong.ok, true);
    assert.equal(pong.data.instance, 'inst-a');
    assert.equal(pong.id, 1);

    const enq = await roundTrip(sockPath, { id: 2, op: 'enqueue', params: { content: 'via-socket' } });
    assert.equal(enq.ok, true);
    assert.ok(Number.isInteger(enq.data.id));
  });

  it('returns bad_json for malformed input', async () => {
    open('inst-b');
    const sockPath = broker.socketPathFor('inst-b');
    const res = await new Promise((resolve, reject) => {
      const c = net.createConnection(sockPath);
      let buf = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write('{not json\n'));
      c.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { c.destroy(); resolve(JSON.parse(buf.slice(0, nl))); } });
      c.on('error', reject);
      setTimeout(() => { c.destroy(); reject(new Error('timeout')); }, 3000);
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'bad_json');
  });
});

// ── c4-client routing / SPOF decision ───────────────────────────────
describe('c4-client shouldUseBroker', () => {
  it('non-isolated instance → false (legacy path)', () => {
    process.env.ZYLOS_INSTANCE_ID = 'admin';
    assert.equal(client.shouldUseBroker(), false);
    delete process.env.ZYLOS_INSTANCE_ID;
  });

  it('isolated + socket present → true', () => {
    process.env.ZYLOS_INSTANCE_ID = 'inst-a'; // socket opened above
    assert.equal(client.shouldUseBroker(), true);
    delete process.env.ZYLOS_INSTANCE_ID;
  });

  it('isolated + socket missing → throws (loud SPOF, never silent legacy)', () => {
    // inst-b is isolated (os_user) but we drop its socket to simulate a down broker.
    broker.removeSocket('inst-b');
    process.env.ZYLOS_INSTANCE_ID = 'inst-b';
    assert.throws(() => client.shouldUseBroker(), /socket missing/);
    delete process.env.ZYLOS_INSTANCE_ID;
  });
});
