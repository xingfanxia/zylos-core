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
for (const id of ['inst-a', 'inst-b', 'inst-self', 'admin']) fs.mkdirSync(stateDir(id), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'activity-monitor'), { recursive: true });

// `inst-self` is an ISOLATED tenant whose os_user is the REAL test-runner user, so
// `id -u <user>` actually resolves and a file the test writes (owned by the runner)
// is owned-by-caller — the only way to exercise the REL-8 stageOwnedMedia happy path
// with real fs (we can't chown a fixture to a fake uid without root). `inst-a`
// (os_user 'fake-a', unresolvable) covers the fail-closed path.
const RUNNER_USER = os.userInfo().username;
const RUNNER_UID = typeof process.getuid === 'function' ? process.getuid() : null;

fs.writeFileSync(path.join(tmpDir, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    'inst-a': { os_user: 'fake-a', state_dir: stateDir('inst-a'), tmux_session: 'claude-inst-a', chat_ids: ['chat-a-1'] },
    'inst-b': { os_user: 'fake-b', state_dir: stateDir('inst-b'), tmux_session: 'claude-inst-b' },
    'inst-self': { os_user: RUNNER_USER, state_dir: stateDir('inst-self'), tmux_session: 'claude-inst-self', chat_ids: ['chat-self'] },
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

// feishu is an allowlisted MESSAGING_CHANNEL; this fake appends one byte per
// invocation to a log file so the attachment-readability tests (REL-5) can prove
// whether the child send.js was spawned. It always exits 0 when it IS reached.
const feishuSpawnLog = path.join(tmpDir, 'feishu-spawns.log');
const feishuContentLog = path.join(tmpDir, 'feishu-content.log');
(function fakeFeishuChannel() {
  const d = path.join(tmpDir, '.claude', 'skills', 'feishu', 'scripts');
  fs.mkdirSync(d, { recursive: true });
  // args are [channelScript, endpoint, content] → process.argv[3] is the delivered
  // content. Record it (overwrite) so a test can prove which path the child received.
  fs.writeFileSync(path.join(d, 'send.js'),
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(feishuSpawnLog)}, 'x');`
    + `fs.writeFileSync(${JSON.stringify(feishuContentLog)}, process.argv[3] || '');process.exit(0);\n`);
})();
function feishuSpawnCount() {
  try { return fs.readFileSync(feishuSpawnLog, 'utf8').length; }
  catch { return 0; }
}
function lastFeishuContent() {
  try { return fs.readFileSync(feishuContentLog, 'utf8'); }
  catch { return ''; }
}

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

  it('extracts only the first-line path when a caption follows (Elaine unreadable regression)', () => {
    // The documented "[MEDIA:type]path\n<caption>" form. The old dotAll `(.+)$/s`
    // swallowed "\n<caption>" into the path, so openSync got a non-existent
    // "path\ncaption" and every captioned attachment was rejected unreadable.
    assert.equal(
      egress.mediaPathFromContent('[MEDIA:image]/home/x_computelabs_ai/zylos/workspace/users/user-elaine/9shang-vocab-cover.png\n九上词汇封面👆'),
      '/home/x_computelabs_ai/zylos/workspace/users/user-elaine/9shang-vocab-cover.png');
    assert.equal(
      egress.mediaPathFromContent('[MEDIA:file]/tmp/外刊精读-No03.pdf\n跟读版(先用文件形式发)\n第二行说明'),
      '/tmp/外刊精读-No03.pdf');
    // a trailing newline with no caption is not a caption
    assert.equal(egress.mediaPathFromContent('[MEDIA:file]/tmp/a.pdf\n'), '/tmp/a.pdf');
    // caption BEFORE the directive (the /m case) — extract the path, not null
    assert.equal(
      egress.mediaPathFromContent('九上词汇封面来啦👇\n[MEDIA:image]/pub/cover.png'),
      '/pub/cover.png');
    // directive not at a line start is NOT a media message
    assert.equal(egress.mediaPathFromContent('see this [MEDIA:image]/pub/x.png'), null);
  });

  it('rewrites the media path to a staged copy, preserving token, position and caption', () => {
    assert.equal(
      egress.mediaContentWithStagedPath('[MEDIA:image]/pub/cover.png\n九上词汇封面👆', '/stage/uuid/cover.png'),
      '[MEDIA:image]/stage/uuid/cover.png\n九上词汇封面👆');
    // no caption — token + staged path only
    assert.equal(
      egress.mediaContentWithStagedPath('[MEDIA:file]/pub/doc.pdf', '/stage/uuid/doc.pdf'),
      '[MEDIA:file]/stage/uuid/doc.pdf');
    // multi-line caption preserved verbatim
    assert.equal(
      egress.mediaContentWithStagedPath('[MEDIA:image]/pub/x.png\nline1\nline2', '/stage/y.png'),
      '[MEDIA:image]/stage/y.png\nline1\nline2');
    // caption BEFORE the directive — replaced in place, lead-in preserved
    assert.equal(
      egress.mediaContentWithStagedPath('封面来啦👇\n[MEDIA:image]/pub/cover.png', '/stage/c.png'),
      '封面来啦👇\n[MEDIA:image]/stage/c.png');
    // non-media content is returned unchanged
    assert.equal(egress.mediaContentWithStagedPath('hello world', '/stage/z'), 'hello world');
  });
});

// ── REL-8 owner-validated attachment staging (pure) ─────────────────
describe('egress-policy stageOwnedMedia', () => {
  const CALLER_UID = 1001;
  // A fake fs whose fstat returns a configurable owner uid, capturing the staged
  // write so we can assert the bytes/path handed to send.js.
  function fakeFs({ uid = CALLER_UID, size = 4, isFile = true, openThrows = false,
                    writeThrows = false, readChunks = null } = {}) {
    const writes = [];
    const dirs = [];
    const removed = [];
    // readChunks: optional list of byte counts returned by successive readSync
    // calls (models a short-read filesystem); null → satisfy the whole request
    // in one call, honoring the offset/length the copy loop passes.
    let chunkIdx = 0;
    return {
      writes, dirs, removed,
      impl: {
        openSync: () => { if (openThrows) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return 7; },
        fstatSync: () => ({ uid, size, isFile: () => isFile }),
        readSync: (_fd, buf, offset, length) => {
          const n = readChunks ? (readChunks[chunkIdx++] ?? 0) : length;
          buf.fill(0x41, offset, offset + n);   // fill only the returned span with 'A'
          return n;
        },
        mkdirSync: (p) => dirs.push(p),
        writeFileSync: (p, data, opts) => {
          if (writeThrows) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          writes.push({ p, len: data.length, mode: opts?.mode });
        },
        rmSync: (p) => removed.push(p),
        closeSync: () => {},
      },
    };
  }

  it('stages a file the caller OWNS: reads bytes once, preserves basename, 0600', () => {
    const f = fakeFs({ uid: CALLER_UID, size: 9 });
    const r = egress.stageOwnedMedia('/home/user-a/report.pdf', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, true);
    assert.equal(r.stagingSubdir, '/hub/.c4/attach-staging/RID');
    assert.equal(r.stagingPath, '/hub/.c4/attach-staging/RID/report.pdf'); // display name preserved
    assert.equal(r.bytes, 9);
    assert.equal(f.writes[0].mode, 0o600);
    assert.equal(f.writes[0].len, 9);
  });

  it('preserves CJK/Unicode basenames (recipient-visible display name) verbatim', () => {
    // Regression (Elaine 2026-07-12): ASCII-only \w sanitization mangled
    // 「外刊精读练习册-No08-威尼斯-高考版.pdf」 into 「-No08--.pdf」.
    const f = fakeFs({ uid: CALLER_UID, size: 4 });
    const r = egress.stageOwnedMedia('/home/user-a/外刊精读练习册-No08-威尼斯-高考版.pdf',
      CALLER_UID, '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, true);
    assert.equal(r.stagingPath, '/hub/.c4/attach-staging/RID/外刊精读练习册-No08-威尼斯-高考版.pdf');
  });

  it('still strips path-hostile chars and never stages as "." or ".."', () => {
    const f = fakeFs({ uid: CALLER_UID, size: 4 });
    // shell-hostile punctuation → '_' (basename already stripped dirs; belt-and-braces)
    const hostile = egress.stageOwnedMedia('/home/user-a/a:b*c?.pdf', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(hostile.ok, true);
    assert.equal(hostile.stagingPath, '/hub/.c4/attach-staging/RID/a_b_c_.pdf');
    // '..' survives a pure char-class filter but must not escape the subdir
    const dots = egress.stageOwnedMedia('/home/user-a/..', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID2' });
    assert.equal(dots.ok, true);
    assert.equal(dots.stagingPath, '/hub/.c4/attach-staging/RID2/attachment');
  });

  it('REJECTS a file owned by ANOTHER uid — the confused-deputy exfil (c4.db / peer home)', () => {
    const f = fakeFs({ uid: 0 });               // hub/root-owned (e.g. world-readable c4.db)
    const r = egress.stageOwnedMedia('/hub/comm-bridge/c4.db', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_owned_by_caller');
    assert.equal(r.owner, 0);
    assert.equal(f.writes.length, 0);           // nothing staged → nothing to send
  });

  it('ownership is checked on the OPEN fd (fstat), so a post-check symlink swap cannot change the validated inode', () => {
    // fstatSync reports the inode actually opened; a peer-owned target is caught
    // regardless of what the path string looked like at any earlier moment.
    const f = fakeFs({ uid: 2002 });            // peer tenant
    const r = egress.stageOwnedMedia('/home/user-a/evil.png', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_owned_by_caller');
  });

  it('fails CLOSED when the caller uid is unresolved (null / non-integer)', () => {
    const f = fakeFs();
    assert.equal(egress.stageOwnedMedia('/x', null, '/s', { fs: f.impl }).error, 'caller_uid_unresolved');
    assert.equal(egress.stageOwnedMedia('/x', undefined, '/s', { fs: f.impl }).error, 'caller_uid_unresolved');
    assert.equal(f.writes.length, 0);
  });

  it('maps unreadable, non-regular-file, and too-large to distinct rejections', () => {
    const unreadable = egress.stageOwnedMedia('/x', CALLER_UID, '/s',
      { fs: fakeFs({ openThrows: true }).impl });
    assert.equal(unreadable.error, 'unreadable');

    const notFile = egress.stageOwnedMedia('/x', CALLER_UID, '/s',
      { fs: fakeFs({ isFile: false }).impl });
    assert.equal(notFile.error, 'not_regular_file');

    const tooBig = egress.stageOwnedMedia('/x', CALLER_UID, '/s',
      { fs: fakeFs({ size: 999 }).impl, maxBytes: 100 });
    assert.equal(tooBig.error, 'too_large');
    assert.equal(tooBig.size, 999);
  });

  it('cleans up and fails CLOSED when the staging write throws (ENOSPC/EROFS) — no orphan subdir, no delivered row', () => {
    const f = fakeFs({ uid: CALLER_UID, size: 12, writeThrows: true });
    const r = egress.stageOwnedMedia('/home/user-a/big.bin', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'stage_failed');            // caller maps → attachment_rejected + audit-failed
    assert.equal(f.writes.length, 0);                 // nothing persisted
    assert.deepEqual(f.removed, ['/hub/.c4/attach-staging/RID']); // subdir swept — no orphan left behind
  });

  it('assembles the whole file across a short-read filesystem (readSync returns partial chunks)', () => {
    const f = fakeFs({ uid: CALLER_UID, size: 9, readChunks: [4, 5] });
    const r = egress.stageOwnedMedia('/home/user-a/report.pdf', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 9);                          // 4 + 5 reassembled, not truncated at the first chunk
    assert.equal(f.writes[0].len, 9);
  });

  it('stages a 0-byte file (empty but owned) without error', () => {
    const f = fakeFs({ uid: CALLER_UID, size: 0 });
    const r = egress.stageOwnedMedia('/home/user-a/empty.txt', CALLER_UID,
      '/hub/.c4/attach-staging', { fs: f.impl, randomName: () => 'RID' });
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 0);
    assert.equal(f.writes[0].len, 0);                  // empty staged file still created
  });

  it('makeUidResolver caches successes only, retries after failure, and logs loudly', () => {
    const logs = [];
    let calls = 0;
    const resolver = egress.makeUidResolver((_cmd, args) => {
      calls++;
      if (args[1] === 'zylos-real') return '4242\n';
      throw new Error('id: no such user');
    }, (m) => logs.push(m));
    assert.equal(resolver('zylos-real'), 4242);
    assert.equal(resolver('zylos-real'), 4242);  // cached success
    assert.equal(calls, 1);
    assert.equal(resolver('zylos-missing'), null);
    assert.equal(resolver('zylos-missing'), null); // NOT cached → retried (self-heals)
    assert.equal(calls, 3);
    assert.ok(logs.some((m) => /uid resolve failed for zylos-missing/.test(m)));
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

  it('send: deliveryAction survives the broker hop into the audit row', async () => {
    // The status-notice tag must not be dropped by the broker path, or the
    // unhealthy auto-reply masks the very unanswered inbound it apologizes for.
    const ok = await broker.handleRequest({
      op: 'send',
      params: { channel: 'web-console', endpoint: 'console-1', content: 'please resend', deliveryAction: 'status-notice' },
    }, 'inst-a');
    assert.equal(ok.ok, true, ok.error);
    const row = getDb().prepare('SELECT delivery_action, status FROM conversations WHERE id = ?').get(ok.data.conversation_id);
    assert.equal(row.delivery_action, 'status-notice');
    assert.equal(row.status, 'delivered');
  });

  it('send: a failed channel send marks the audit out-row failed', async () => {
    // telegram send.js in this harness exits 3.
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'telegram', endpoint: 'chat-a-1', content: 'never arrives' },
    }, 'inst-a');
    assert.equal(r.ok, false);
    assert.match(r.error, /channel_send_failed/);
    const row = getDb().prepare('SELECT status FROM conversations WHERE id = ?').get(r.data.conversation_id);
    assert.equal(row.status, 'failed');
  });
});

// ── broker attachment gate — PRIMARY caller readability (REL-5) ──────
// Primary/trusted callers (admin, scheduler — no os_user) keep the up-front
// accessSync readability gate: an unreadable path is rejected cleanly instead of
// crashing the child's unguarded feishu ReadStream (the Elaine incident). No
// ownership scoping — a primary is trusted above the tenant boundary. `admin` is
// primary and authorized for feishu 'owner-chat'. The fake feishu send.js records
// each spawn so we can prove a doomed send is rejected BEFORE the child is spawned.
describe('broker attachment gate — primary caller readability (REL-5)', () => {
  it('rejects a [MEDIA] path the broker cannot read (ENOENT) before spawning send.js', async () => {
    const before = feishuSpawnCount();
    const missing = path.join(tmpDir, 'no-such-attachment.png');
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: `[MEDIA:image]${missing}` },
    }, 'admin');
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_unreadable/);
    assert.match(r.error, /publish it under/); // actionable, self-correcting message
    assert.equal(feishuSpawnCount(), before, 'send.js must NOT be spawned for an unreadable attachment');
    const row = getDb().prepare('SELECT status FROM conversations WHERE id = ?').get(r.data.conversation_id);
    assert.equal(row.status, 'failed', 'audit out-row must be marked failed');
  });

  it('does not leak the broker cwd for a relative [MEDIA] path (rev-security S3)', async () => {
    // A relative path resolves against the broker's cwd; path.resolve() would
    // prepend it, leaking the admin broker's cwd back to the caller.
    const rel = 'zzz-nonexistent-rel-dir/attachment.png';
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: `[MEDIA:image]${rel}` },
    }, 'admin');
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_unreadable/);
    assert.match(r.error, /publish it under/); // guidance text preserved
    assert.ok(r.error.includes(rel), 'error should echo the path as the agent sent it');
    assert.ok(!r.error.includes(process.cwd()), 'error must NOT contain the broker cwd');
    assert.ok(!r.error.includes(path.resolve(rel)), 'error must NOT contain the cwd-resolved absolute path');
    assert.equal(feishuSpawnCount(), before, 'send.js must NOT be spawned');
  });

  it('rejects a chmod-000 (EACCES) [MEDIA] file', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('running as root — DAC is bypassed, chmod-000 stays readable');
      return;
    }
    const denied = path.join(tmpDir, 'secret-000.pdf');
    fs.writeFileSync(denied, 'x');
    fs.chmodSync(denied, 0o000);
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: `[MEDIA:file]${denied}` },
    }, 'admin');
    fs.chmodSync(denied, 0o644); // restore for cleanup regardless of assertions
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_unreadable/);
    assert.equal(feishuSpawnCount(), before, 'send.js must NOT be spawned for an unreadable attachment');
  });

  it('regression: a readable attachment from a trusted primary still spawns + delivers', async () => {
    const readable = path.join(tmpDir, 'chart.png');
    fs.writeFileSync(readable, 'imgbytes');
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: `[MEDIA:image]${readable}` },
    }, 'admin');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.sent, true);
    assert.equal(feishuSpawnCount(), before + 1, 'readable attachment must reach the channel');
  });

  it('non-media content is unaffected by the readability gate', async () => {
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: 'plain text, no attachment' },
    }, 'admin');
    assert.equal(r.ok, true, r.error);
    assert.equal(feishuSpawnCount(), before + 1);
  });
});

// ── broker attachment staging — ISOLATED caller ownership (REL-8) ────
// The REL-8 confused-deputy fix: an isolated tenant may attach ONLY a file IT
// OWNS. The broker (hub user + supplementary groups + world-read) can otherwise
// READ peer-tenant homes and hub/service files — most dangerously the
// world-readable c4.db holding EVERY tenant's messages — and forward them to the
// caller's own chat. stageOwnedMedia fstat-validates ownership on the OPEN fd and
// hands send.js a broker-private byte-copy (default-deny + TOCTOU-safe).
//   inst-self: os_user = the REAL runner user, so `id -u` resolves and a file the
//              test writes is owned-by-caller → exercises the happy path.
//   inst-a:    os_user 'fake-a' (unresolvable) → exercises fail-closed.
describe('broker attachment staging — isolated caller ownership (REL-8)', () => {
  it('stages + delivers a file the isolated caller OWNS, rewriting to the broker copy', async (t) => {
    if (RUNNER_UID == null) { t.skip('no process.getuid — cannot exercise real uid ownership'); return; }
    const owned = path.join(tmpDir, 'owned-attach.png');
    fs.writeFileSync(owned, 'imgbytes'); // owned by the runner == inst-self's resolved uid
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-self', content: `[MEDIA:image]${owned}` },
    }, 'inst-self');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.data.sent, true);
    assert.equal(feishuSpawnCount(), before + 1, 'an owned attachment must reach the channel');
    // The child must receive the broker's staging COPY, never the caller-mutable
    // original (the TOCTOU fix) — path rewritten under attach-staging, basename kept.
    const delivered = lastFeishuContent();
    assert.ok(delivered.startsWith('[MEDIA:image]'), `media prefix preserved: ${delivered}`);
    assert.ok(delivered.includes('attach-staging'), `delivered path must be the staging copy: ${delivered}`);
    assert.ok(delivered.includes('owned-attach.png'), 'original basename (display name) preserved');
    assert.ok(!delivered.includes(owned), 'delivered path must NOT be the caller-mutable original');
    // After delivery the broker sweeps its per-send staging subdir (the `finally`
    // in opSend) so no tenant attachment bytes linger on disk (finding #6).
    const stagedPath = delivered.slice('[MEDIA:image]'.length);
    assert.ok(!fs.existsSync(path.dirname(stagedPath)), 'per-send staging subdir must be removed after delivery');
  });

  it('REL-8 HIGH-2: isolated caller CANNOT exfil a readable file it does NOT own (c4.db-style)', async (t) => {
    if (RUNNER_UID == null) { t.skip('no process.getuid'); return; }
    if (RUNNER_UID === 0) { t.skip('running as root — owns system files, cannot construct a cross-owner case'); return; }
    // A world-readable file owned by ANOTHER uid stands in for c4.db / a peer home:
    // readable by the broker, but not owned by the caller → must be blocked.
    const candidates = ['/etc/hosts', '/etc/passwd', '/etc/hostname', '/usr/bin/env', '/bin/sh'];
    let foreign = null;
    for (const c of candidates) {
      try { fs.accessSync(c, fs.constants.R_OK); if (fs.statSync(c).uid !== RUNNER_UID) { foreign = c; break; } }
      catch { /* not readable / missing — try next */ }
    }
    if (!foreign) { t.skip('no readable foreign-owned file available on this host'); return; }
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-self', content: `[MEDIA:file]${foreign}` },
    }, 'inst-self');
    assert.equal(r.ok, false, `a non-owned file (${foreign}) must be rejected`);
    assert.match(r.error, /egress_blocked/); // not_owned_by_caller → egress_blocked
    assert.equal(feishuSpawnCount(), before, 'a readable but non-owned file must NOT reach the channel');
    const row = getDb().prepare('SELECT status FROM conversations WHERE id = ?').get(r.data.conversation_id);
    assert.equal(row.status, 'failed', 'audit out-row must be marked failed');
  });

  it('isolated caller: a directory [MEDIA] path → attachment_invalid, audit-failed, no spawn (finding #8)', async (t) => {
    if (RUNNER_UID == null) { t.skip('no process.getuid'); return; }
    // A directory is openable + owned by the runner, but not a regular file →
    // stageOwnedMedia returns not_regular_file, which the broker maps to the
    // distinct caller-facing attachment_invalid reason (not a generic reject).
    const dir = path.join(tmpDir, 'a-directory-attachment');
    fs.mkdirSync(dir, { recursive: true });
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-self', content: `[MEDIA:file]${dir}` },
    }, 'inst-self');
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_invalid/);        // not_regular_file → distinct reason
    assert.equal(feishuSpawnCount(), before, 'a non-regular-file attachment must NOT be spawned');
    const row = getDb().prepare('SELECT status FROM conversations WHERE id = ?').get(r.data.conversation_id);
    assert.equal(row.status, 'failed', 'audit out-row must be marked failed for a rejected attachment');
  });

  it('isolated caller: unreadable path → attachment_unreadable, no spawn (Elaine-incident guard)', async (t) => {
    if (RUNNER_UID == null) { t.skip('no process.getuid'); return; }
    const missing = path.join(tmpDir, 'isolated-missing.png');
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-self', content: `[MEDIA:image]${missing}` },
    }, 'inst-self');
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_unreadable/);
    assert.equal(feishuSpawnCount(), before, 'send.js must NOT be spawned for an unreadable attachment');
  });

  it('REL-8 fail-closed: an isolated caller whose uid cannot be resolved is DENIED (never fails open)', async () => {
    // inst-a's os_user 'fake-a' does not exist → `id -u fake-a` fails → uid
    // unresolved → default-DENY. A send whose owner cannot be proven is blocked,
    // even though the file itself is perfectly readable.
    const readable = path.join(tmpDir, 'unresolved-caller.png');
    fs.writeFileSync(readable, 'imgbytes');
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-a-1', content: `[MEDIA:image]${readable}` },
    }, 'inst-a');
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_rejected/); // caller_uid_unresolved → generic reject
    assert.equal(feishuSpawnCount(), before, 'an unprovable-owner send must NOT spawn');
  });

  it('REL-8 fail-CLOSED classification: a caller with NO instance def (removed mid-connection) is treated as ISOLATED, not trusted-primary', async () => {
    // The scan/SIGHUP teardown race: an instance removed from instances.json still
    // holds a live authenticated socket for up to RESCAN_INTERVAL_MS. getInstanceDef
    // then returns undefined. The OLD classification (`!!getInstanceDef(caller)?.os_user`)
    // read that as FALSE → "trusted primary" → the readable-file path → and a ghost
    // instance could exfil ANY broker-readable file (c4.db, peer homes). The fix
    // classifies an unknown/undefined def as ISOLATED, so it routes through
    // stageOwnedMedia whose caller_uid_unresolved branch denies. This readable,
    // broker-owned file WOULD have been spawned under the old code.
    const readable = path.join(tmpDir, 'ghost-exfil.png');
    fs.writeFileSync(readable, 'imgbytes');            // perfectly readable by the broker
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'owner-chat', content: `[MEDIA:image]${readable}` },
    }, 'ghost-removed');                               // caller not in instances.json → def undefined
    assert.equal(r.ok, false);
    assert.match(r.error, /attachment_rejected/);      // isolated + unresolvable uid → default-deny
    assert.equal(feishuSpawnCount(), before, 'an unknown-def caller must NOT be trusted as primary → no spawn');
  });

  it('isolated caller: non-media content is unaffected by staging', async () => {
    const before = feishuSpawnCount();
    const r = await broker.handleRequest({
      op: 'send',
      params: { channel: 'feishu', endpoint: 'chat-self', content: 'plain text from an isolated tenant' },
    }, 'inst-self');
    assert.equal(r.ok, true, r.error);
    assert.equal(feishuSpawnCount(), before + 1);
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
