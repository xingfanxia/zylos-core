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
    'inst-a': { os_user: 'fake-a', state_dir: stateDir('inst-a'), tmux_session: 'claude-inst-a', chat_ids: ['chat-a-1'] },
    'inst-b': { os_user: 'fake-b', state_dir: stateDir('inst-b'), tmux_session: 'claude-inst-b' },
    'admin':  { primary: true, state_dir: stateDir('admin'), tmux_session: 'claude-main', chat_ids: ['owner-chat'] },
  },
}));

// Fake channels so opSend can exercise the spawn path without real creds.
//   web-console → exit 0 (allowlisted, always endpoint-authorized)
//   telegram    → exit 3 (allowlisted, endpoint-authorized via chat_ids)
//   shell       → exit 0 but NOT allowlisted (CRITICAL-1: must be rejected
//                 despite having a send.js)
function fakeChannel(name, exitCode) {
  const d = path.join(tmpDir, '.claude', 'skills', name, 'scripts');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'send.js'), `process.exit(${exitCode});\n`);
}
fakeChannel('web-console', 0);
fakeChannel('telegram', 3);
fakeChannel('shell', 0);

// ── Dynamic imports (now see the sandbox env) ───────────────────────
const broker = await import('../c4-broker.js');
const egress = await import('../egress-policy.js');
const client = await import('../c4-client.js');
const { close: closeDb, getDb } = await import('../c4-db.js');

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

  it('send: happy path via web-console (allowlisted, endpoint always authorized)', async () => {
    const ok = await broker.handleRequest({ op: 'send', params: { channel: 'web-console', endpoint: 'console-1', content: 'hello' } }, 'inst-a');
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.data.sent, true);
  });

  it('send: CRITICAL-1 — non-messaging channel (shell) is rejected despite having a send.js', async () => {
    const r = await broker.handleRequest({ op: 'send', params: { channel: 'shell', endpoint: '/tmp/x.sock', content: 'payload' } }, 'inst-a');
    assert.equal(r.ok, false);
    assert.match(r.error, /channel_not_allowed/);
  });

  it('send: HIGH-1 — endpoint must be authorized to the caller', async () => {
    // inst-a has chat_ids: ['chat-a-1'] → authorized; telegram send.js exits 3.
    const authed = await broker.handleRequest({ op: 'send', params: { channel: 'telegram', endpoint: 'chat-a-1', content: 'hi' } }, 'inst-a');
    assert.equal(authed.ok, false);
    assert.match(authed.error, /channel_send_failed/); // passed auth, reached the (failing) channel

    const denied = await broker.handleRequest({ op: 'send', params: { channel: 'telegram', endpoint: 'chat-someone-else', content: 'hi' } }, 'inst-a');
    assert.equal(denied.ok, false);
    assert.match(denied.error, /endpoint_not_authorized/);

    // Escalation to the operator (primary instance's chat) is always allowed.
    const toOwner = await broker.handleRequest({ op: 'send', params: { channel: 'telegram', endpoint: 'owner-chat', content: 'escalation' } }, 'inst-a');
    assert.equal(toOwner.ok, false);
    assert.match(toOwner.error, /channel_send_failed/); // passed auth, reached the (failing) channel
  });

  it('send: M3 — out-row is NULL-targeted (not replayed into the caller\'s unsummarized)', async () => {
    const before = (await broker.handleRequest({ op: 'unsummarized' }, 'inst-a')).data.count;
    await broker.handleRequest({ op: 'send', params: { channel: 'web-console', endpoint: 'console-1', content: 'reply text' } }, 'inst-a');
    const after = (await broker.handleRequest({ op: 'unsummarized' }, 'inst-a')).data.count;
    assert.equal(after, before, 'own outbound message must not count toward unsummarized');
  });
});

// ── broker void op (record-only, caller-scoped) ─────────────────────
describe('broker void op', () => {
  it('records a caller-scoped, delivered handoff row without needing a channel script', async () => {
    const r = await broker.handleRequest({ op: 'void', params: { endpoint: 'session-handoff', content: 'handoff summary A' } }, 'inst-a');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.recorded, true);
    assert.ok(Number.isInteger(r.data.conversation_id));
    // Void is scoped to the caller (target_instance = caller) and 'delivered', so
    // that instance's own next session-init reads the handoff back — unlike
    // real-channel out-rows which are NULL-targeted (M3). Assert the row shape
    // directly (immune to the sibling checkpoint's id boundary).
    const row = getDb().prepare('SELECT direction, channel, status, target_instance FROM conversations WHERE id = ?').get(r.data.conversation_id);
    assert.equal(row.channel, 'void');
    assert.equal(row.direction, 'out');
    assert.equal(row.status, 'delivered');
    assert.equal(row.target_instance, 'inst-a', 'void handoff must be scoped to the calling instance');
  });

  it('scopes each caller\'s handoff to itself (no cross-instance bleed)', async () => {
    const rb = await broker.handleRequest({ op: 'void', params: { endpoint: 'session-handoff', content: 'handoff for B' } }, 'inst-b');
    const row = getDb().prepare('SELECT target_instance FROM conversations WHERE id = ?').get(rb.data.conversation_id);
    assert.equal(row.target_instance, 'inst-b');
  });

  it('requires both endpoint and content', async () => {
    const noEp = await broker.handleRequest({ op: 'void', params: { content: 'x' } }, 'inst-a');
    assert.equal(noEp.ok, false);
    assert.match(noEp.error, /endpoint_required/);
    const noContent = await broker.handleRequest({ op: 'void', params: { endpoint: 'session-handoff' } }, 'inst-a');
    assert.equal(noContent.ok, false);
    assert.match(noContent.error, /content_required/);
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

describe('broker scheduler op', () => {
  const specFor = (prompt, overrides = {}) => ({
    prompt,
    name: prompt,
    type: 'one-time',
    next_run_at: Math.floor(Date.now() / 1000) + 3600,
    priority: 3,
    require_idle: 0,
    miss_threshold: 300,
    timezone: 'UTC',
    ...overrides,
  });

  it('add forces target_instance = caller (client-supplied target/id ignored)', async () => {
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('task for a', { target_instance: 'inst-b', id: 'task-evil-fixed-id' }) },
    }, 'inst-a');
    assert.equal(res.ok, true);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.task.target_instance, 'inst-a');
    assert.notEqual(res.data.task.id, 'task-evil-fixed-id');
  });

  it('list is scoped to the caller', async () => {
    const a = await broker.handleRequest({ op: 'scheduler', params: { action: 'list' } }, 'inst-a');
    const b = await broker.handleRequest({ op: 'scheduler', params: { action: 'list' } }, 'inst-b');
    assert.equal(a.ok, true);
    assert.ok(a.data.some(t => t.prompt === 'task for a'));
    assert.equal(b.ok, true);
    assert.equal(b.data.length, 0);
  });

  it('done refuses another instance\'s task, completes own', async () => {
    const added = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('ackable task') },
    }, 'inst-a');
    const id = added.data.task.id;

    const cross = await broker.handleRequest({ op: 'scheduler', params: { action: 'done', prefix: id } }, 'inst-b');
    assert.equal(cross.ok, true);
    assert.equal(cross.data.ok, false);
    assert.equal(cross.data.error, 'not_found');

    const own = await broker.handleRequest({ op: 'scheduler', params: { action: 'done', prefix: id } }, 'inst-a');
    assert.equal(own.ok, true);
    assert.equal(own.data.ok, true);
    assert.equal(own.data.task.id, id);
  });

  it('update cannot retarget a task', async () => {
    const added = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('retarget attempt') },
    }, 'inst-a');
    const id = added.data.task.id;
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'update', prefix: id, updates: { target_instance: 'inst-b' } },
    }, 'inst-a');
    assert.equal(res.ok, true);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.error, 'retarget_forbidden');
  });

  it('mutating actions require a prefix', async () => {
    const res = await broker.handleRequest({ op: 'scheduler', params: { action: 'done' } }, 'inst-a');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'prefix_required');
  });

  it('add without a usable spec is refused', async () => {
    const res = await broker.handleRequest({ op: 'scheduler', params: { action: 'add' } }, 'inst-a');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'spec_required');
  });

  it('unknown scheduler action is refused', async () => {
    const res = await broker.handleRequest({ op: 'scheduler', params: { action: 'drop-all' } }, 'inst-a');
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown_scheduler_action/);
  });

  it('add rejects a non-messaging reply_channel (shell → arbitrary socket)', async () => {
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('confused deputy', { reply_channel: 'shell', reply_endpoint: '/tmp/evil.sock' }) },
    }, 'inst-a');
    assert.equal(res.ok, false);
    assert.match(res.error, /reply_channel_not_allowed/);
  });

  it('add rejects an unauthorized reply_endpoint (cross-tenant chat)', async () => {
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('spam attempt', { reply_channel: 'telegram', reply_endpoint: 'someone-elses-chat' }) },
    }, 'inst-a');
    assert.equal(res.ok, false);
    assert.match(res.error, /reply_endpoint_not_authorized/);
  });

  it('add allows an authorized reply target (own bound chat)', async () => {
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('legit notify', { reply_channel: 'telegram', reply_endpoint: 'chat-a-1' }) },
    }, 'inst-a');
    assert.equal(res.ok, true);
    assert.equal(res.data.ok, true);
  });

  it('update rejects a shell reply_channel too', async () => {
    const added = await broker.handleRequest({ op: 'scheduler', params: { action: 'add', spec: specFor('to-hijack') } }, 'inst-a');
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'update', prefix: added.data.task.id, updates: { reply_channel: 'shell', reply_endpoint: '/tmp/x.sock' } },
    }, 'inst-a');
    assert.equal(res.ok, false);
    assert.match(res.error, /reply_channel_not_allowed/);
  });

  it('add floors sub-minute interval tasks', async () => {
    const res = await broker.handleRequest({
      op: 'scheduler',
      params: { action: 'add', spec: specFor('churn', { type: 'interval', interval_seconds: 1 }) },
    }, 'inst-a');
    assert.equal(res.ok, false);
    assert.match(res.error, /interval_too_small/);
  });

  it('empty caller is refused (scope invariant)', async () => {
    const res = await broker.handleRequest({ op: 'scheduler', params: { action: 'list' } }, '');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no_caller');
  });
});
