import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Spills readable by the service user and the row's recipient only
// (c4-recipient-access.js). The real-recipient cases need Linux with setfacl
// and the persona users; set SPILL_TEST_PERSONAS to run them, e.g.
//   SPILL_TEST_PERSONAS=user-pan=zylos-pan,user-elaine=zylos-elaine,user-sean=zylos-sean,group=zylos-group
// Each check then runs `sudo -n -u <persona> test ...` on the throwaway files.
const PERSONAS = (process.env.SPILL_TEST_PERSONAS || '').split(',').filter(Boolean)
  .map((pair) => { const [id, user] = pair.split('='); return { id, user }; });
const HAS_SETFACL = process.platform === 'linux'
  && spawnSync('setfacl', ['--version'], { stdio: 'ignore' }).status === 0;
const REAL = HAS_SETFACL && PERSONAS.length > 0;

// Temp ZYLOS_DIR with instances.json BEFORE the modules load (c4-config and
// instance-config read ZYLOS_DIR at import).
const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-recipient-spills-'));
const instances = {
  admin: { enabled: true, type: 'dedicated', primary: true },
  'user-a': { enabled: true, type: 'user', os_user: 'zylos-a' },
  'user-root': { enabled: true, type: 'user', os_user: 'root' },
  'user-bad': { enabled: true, type: 'user', os_user: 'Bad User' },
};
for (const p of PERSONAS) instances[p.id] = { enabled: true, type: 'user', os_user: p.user };
fs.writeFileSync(path.join(TMP_DIR, 'instances.json'), JSON.stringify({ default_instance: 'admin', instances }));
process.env.ZYLOS_DIR = TMP_DIR;
const access = await import(new URL('../c4-recipient-access.js', import.meta.url));
const { truncateForDelivery } = await import(new URL('../c4-utils.js', import.meta.url));
const { FILE_SIZE_THRESHOLD, DATA_DIR, ATTACHMENTS_DIR } = await import(new URL('../c4-config.js', import.meta.url));
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const disp = await import(new URL('../c4-dispatcher.js', import.meta.url));
const db = await import(new URL('../c4-db.js', import.meta.url));
if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;
process.on('exit', () => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

// Production-like parents: 0750, personas traverse only (named entries, so
// the group bits are the mask --x and carry no write bit).
fs.chmodSync(TMP_DIR, 0o711);
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
for (const d of [DATA_DIR, ATTACHMENTS_DIR]) {
  fs.chmodSync(d, 0o750);
  if (REAL) spawnSync('setfacl', ['-m', PERSONAS.map((p) => `u:${p.user}:--x`).join(','), d], { stdio: 'inherit' });
}

const modeOf = (p) => fs.lstatSync(p).mode & 0o7777;
const big = (tag = 'S') => tag.repeat(FILE_SIZE_THRESHOLD + 100);
const spillPathOf = (delivered) => delivered.match(/read the complete message file: (\S+)/)[1];
const aclOf = (p) => spawnSync('getfacl', ['-cp', '--', p], { encoding: 'utf8' }).stdout;
const as = (user, op, p) => spawnSync('sudo', ['-n', '-u', user, '--', 'test', `-${op}`, p]).status === 0;
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'scratch-'));
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'x', { mode: 0o644 });
  fs.chmodSync(dir, 0o755);
  return { dir, file };
};

describe('recipientUser', () => {
  it('maps an isolated instance to its os_user and service instances or no target to owner-only', () => {
    assert.equal(access.recipientUser('user-a'), 'zylos-a');
    assert.equal(access.recipientUser('admin'), null);
    assert.equal(access.recipientUser(null), null);
    assert.equal(access.recipientUser(undefined), null);
  });

  it('throws for an unknown instance or an unusable os_user (that recipient could not read the file)', () => {
    assert.throws(() => access.recipientUser('nobody-here'), /recipient_unknown/);
    assert.throws(() => access.recipientUser('user-root'), /recipient_unresolvable/);
    assert.throws(() => access.recipientUser('user-bad'), /recipient_unresolvable/);
  });
});

describe('assertServiceDir', () => {
  it('accepts the intended 0750 parent and rejects group, other or world write and symlinks', () => {
    const { dir } = scratch();
    fs.chmodSync(dir, 0o750);
    assert.doesNotThrow(() => access.assertServiceDir(dir));
    for (const mode of [0o770, 0o752, 0o777, 0o2770]) {
      fs.chmodSync(dir, mode);
      assert.throws(() => access.assertServiceDir(dir), /unsafe_parent/, `mode ${mode.toString(8)}`);
    }
    fs.chmodSync(dir, 0o750);
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    assert.throws(() => access.assertServiceDir(link), /unsafe_parent/);
    assert.throws(() => access.assertServiceDir(path.join(dir, 'missing')), /ENOENT/);
  });

  it('rejects a parent where a named user can write through the ACL', { skip: !HAS_SETFACL && 'needs Linux setfacl' }, () => {
    const { dir } = scratch();
    fs.chmodSync(dir, 0o750);
    assert.equal(spawnSync('setfacl', ['-m', 'u:nobody:rwx', dir]).status, 0);
    assert.throws(() => access.assertServiceDir(dir), /unsafe_parent/, 'mask rwx shows as group write');
    assert.equal(spawnSync('setfacl', ['-m', 'u:nobody:--x', dir]).status, 0);
    assert.doesNotThrow(() => access.assertServiceDir(dir), 'a traverse-only named entry is fine');
  });
});

describe('setFinalAccess', () => {
  it('sets the recipient ACL in one absolute call per path, never via owner-only first', () => {
    const { dir, file } = scratch();
    const calls = [];
    const run = (p, acl) => calls.push([p, acl, modeOf(p)]);
    access.setFinalAccess(dir, true, 'zylos-a', { run });
    access.setFinalAccess(file, false, 'zylos-a', { run });
    assert.deepEqual(calls, [
      [dir, 'u::rwx,u:zylos-a:--x,g::---,m::--x,o::---', 0o755],
      [file, 'u::rw-,u:zylos-a:r--,g::---,m::r--,o::---', 0o644],
    ], 'the old modes were untouched until the single replacement');
  });

  it('owner-only targets get chmod 0700/0600 and no ACL call', () => {
    const { dir, file } = scratch();
    const calls = [];
    access.setFinalAccess(dir, true, null, { run: (...a) => calls.push(a) });
    access.setFinalAccess(file, false, null, { run: (...a) => calls.push(a) });
    assert.deepEqual(calls, []);
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(file), 0o600);
  });

  it('a failing grant throws recipient_acl_failed and leaves the path as it was', () => {
    const { file } = scratch();
    assert.throws(
      () => access.setFinalAccess(file, false, 'zylos-a', { run: () => { throw new Error('EPERM'); } }),
      /recipient_acl_failed: zylos-a on .*: EPERM/,
    );
    assert.equal(modeOf(file), 0o644);
  });
});

describe('truncateForDelivery spill access', () => {
  it('a spill for no target or a service instance is owner-only', () => {
    for (const [id, target] of [[42, null], [43, 'admin']]) {
      const p = spillPathOf(truncateForDelivery(big(), '', id, target));
      assert.equal(modeOf(p), 0o600);
      assert.equal(modeOf(path.dirname(p)), 0o700);
      assert.equal(fs.readFileSync(p, 'utf8'), big());
      assert.deepEqual(fs.readdirSync(path.dirname(p)), ['message.txt'], 'no temp file left');
    }
  });

  it('re-rendering an old world-readable spill replaces it with a new private inode', () => {
    const p = spillPathOf(truncateForDelivery(big(), '', 44));
    fs.chmodSync(p, 0o644);
    fs.chmodSync(path.dirname(p), 0o755);
    const oldIno = fs.statSync(p).ino;
    truncateForDelivery(big('T'), '', 44);
    assert.notEqual(fs.statSync(p).ino, oldIno, 'the old (wide) inode is never rewritten in place');
    assert.equal(modeOf(p), 0o600);
    assert.equal(modeOf(path.dirname(p)), 0o700);
    assert.equal(fs.readFileSync(p, 'utf8'), big('T'));
    assert.deepEqual(fs.readdirSync(path.dirname(p)), ['message.txt']);
  });

  it('an unknown recipient throws before anything is written', () => {
    assert.throws(() => truncateForDelivery(big(), '', 45, 'nobody-here'), /recipient_unknown/);
    assert.equal(fs.existsSync(path.join(ATTACHMENTS_DIR, 'conv-45')), false);
  });

  it('a failed recipient grant throws, leaves no temp file and does not touch an earlier delivered file', () => {
    // zylos-a does not exist (and macOS has no setfacl), so the grant fails.
    const dir = path.join(ATTACHMENTS_DIR, 'conv-46');
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'message.txt'), 'earlier render', { mode: 0o600 });
    const ino = fs.statSync(path.join(dir, 'message.txt')).ino;
    assert.throws(() => truncateForDelivery(big(), '', 46, 'user-a'), /recipient_acl_failed/);
    assert.deepEqual(fs.readdirSync(dir), ['message.txt'], 'no temp file left');
    assert.equal(fs.statSync(path.join(dir, 'message.txt')).ino, ino);
    assert.equal(fs.readFileSync(path.join(dir, 'message.txt'), 'utf8'), 'earlier render');
  });

  it('a grant to a user that does not exist fails loudly on Linux', { skip: !HAS_SETFACL && 'needs Linux setfacl' }, () => {
    assert.throws(() => truncateForDelivery(big(), '', 47, 'user-a'), /recipient_acl_failed: zylos-a/);
    const dir = path.join(ATTACHMENTS_DIR, 'conv-47');
    assert.deepEqual(fs.readdirSync(dir), [], 'no message file and no temp file');
  });

  it('refuses a symlinked spill directory and an unsafe attachments parent', () => {
    const elsewhere = fs.mkdtempSync(path.join(TMP_DIR, 'elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(ATTACHMENTS_DIR, 'conv-48'));
    assert.throws(() => truncateForDelivery(big(), '', 48), /unsafe_path/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    const mode = modeOf(ATTACHMENTS_DIR);
    fs.chmodSync(ATTACHMENTS_DIR, 0o770);
    try {
      assert.throws(() => truncateForDelivery(big(), '', 49), /unsafe_parent/);
      assert.equal(fs.existsSync(path.join(ATTACHMENTS_DIR, 'conv-49')), false);
    } finally { fs.chmodSync(ATTACHMENTS_DIR, mode); }
  });

  it('a short message is returned inline and writes nothing', () => {
    assert.equal(truncateForDelivery('short', '', 50, 'user-a'), 'short');
    assert.equal(fs.existsSync(path.join(ATTACHMENTS_DIR, 'conv-50')), false);
  });
});

describe('dispatcher: a conversation whose spill cannot be granted', () => {
  it('is never pasted: two attempts, then failed, with its id and reason in delivery-failures.log', async () => {
    const row = db.insertConversation('in', 'telegram', 'chat-x', big(), 'pending', 3, false, null, 'user-a');
    const statusFile = path.join(TMP_DIR, 'agent-status.json');
    const read = () => db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(row.id);
    for (let attempt = 1; attempt <= 2; attempt++) {
      fs.writeFileSync(statusFile, '{}'); // fresh status: the channel is healthy, retries count
      assert.equal(db.claimConversation(row.id), true, `claim ${attempt}`);
      const item = { ...read(), type: 'conversation' };
      let err = null;
      try { disp.getDeliveryContent(item); } catch (e) { err = e; }
      assert.match(String(err?.message), /^recipient_acl_failed: zylos-a on /);
      await disp.handleContentFailure(item, err, statusFile);
      assert.equal(read().status, attempt === 1 ? 'pending' : 'failed');
      assert.equal(read().delivery_action, attempt === 1 ? null : 'content-error:recipient_acl_failed',
        'tagged only by the failure that ends the row');
    }
    const lines = fs.readFileSync(path.join(TMP_DIR, 'activity-monitor', 'delivery-failures.log'), 'utf8')
      .split('\n').filter((l) => l.includes(` id=${row.id} `));
    assert.equal(lines.filter((l) => / reason=CONTENT_ERROR detail=recipient_acl_failed:_?zylos-a$/.test(l)).length, 2, lines.join('\n'));
    assert.equal(lines.filter((l) => / reason=MAX_RETRIES /.test(l)).length, 1, lines.join('\n'));
    assert.deepEqual(fs.readdirSync(path.join(ATTACHMENTS_DIR, `conv-${row.id}`)), [], 'no message file, no temp file');
    assert.deepEqual(db.getContentErrorFailures().map((r) => r.id), [row.id], 'the primary monitor alert finds it');
    db.markContentErrorNotified(row.id);
  });

  it('a content failure, then a built content whose paste fails, is not reported as a content error', async () => {
    const row = db.insertConversation('in', 'telegram', 'chat-y', big(), 'pending', 3, false, null, 'user-a');
    const statusFile = path.join(TMP_DIR, 'agent-status.json');
    const read = () => db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(row.id);
    fs.writeFileSync(statusFile, '{}');
    assert.equal(db.claimConversation(row.id), true);
    let err = null;
    try { disp.getDeliveryContent({ ...read(), type: 'conversation' }); } catch (e) { err = e; }
    await disp.handleContentFailure({ ...read(), type: 'conversation' }, err, statusFile);
    // Attempt 2: the content was built (the grant was repaired) and the paste
    // failed, which the dispatcher hands to the plain conversation failure path.
    fs.writeFileSync(statusFile, '{}');
    assert.equal(db.claimConversation(row.id), true);
    await disp.handleConversationDeliveryFailure({ ...read(), type: 'conversation' }, statusFile);
    assert.equal(read().status, 'failed');
    assert.equal(read().delivery_action, null);
    assert.deepEqual(db.getContentErrorFailures().map((r) => r.id), [], 'no content-error alert for a paste failure');
  });
});

describe('real recipients (Linux, persona users)', { skip: !REAL && 'set SPILL_TEST_PERSONAS on Linux with setfacl' }, () => {
  it('each persona reads its own spill by path and no other persona can reach it', () => {
    const files = PERSONAS.map((p, i) => ({ ...p, f: spillPathOf(truncateForDelivery(big(), '', 900 + i, p.id)) }));
    for (const { user, f } of files) {
      assert.match(aclOf(f), new RegExp(`^user:${user}:r--$`, 'm'));
      assert.match(aclOf(path.dirname(f)), new RegExp(`^user:${user}:--x$`, 'm'));
      for (const t of [f, path.dirname(f)]) {
        assert.match(aclOf(t), /^group::---$/m);
        assert.match(aclOf(t), /^other::---$/m);
      }
    }
    for (const reader of PERSONAS) {
      for (const { user, f } of files) {
        const mine = reader.user === user;
        assert.equal(as(reader.user, 'r', f), mine, `${reader.user} -r ${user}'s spill`);
        assert.equal(as(reader.user, 'x', path.dirname(f)), mine, `${reader.user} -x ${user}'s spill dir`);
        assert.equal(as(reader.user, 'r', path.dirname(f)), false, `${reader.user} cannot list ${user}'s spill dir`);
        assert.equal(as(reader.user, 'w', f), false);
      }
    }
  });

  it('a service-instance spill is readable by no persona', () => {
    const f = spillPathOf(truncateForDelivery(big(), '', 950, 'admin'));
    for (const p of PERSONAS) assert.equal(as(p.user, 'r', f), false, p.user);
  });

  it('the recipient never loses access while its spill is re-rendered over and over', async (t) => {
    const p = PERSONAS[0];
    const f = spillPathOf(truncateForDelivery(big(), '', 960, p.id));
    // A reader loop as the recipient (cat, so a real open+read) runs while
    // this process re-renders the same conversation 200 times.
    const reader = spawn('sudo', ['-n', '-u', p.user, '--', 'sh', '-c',
      `n=0; bad=0; while [ ! -e "${f}.stop" ]; do n=$((n+1)); cat "${f}" > /dev/null 2>&1 || bad=$((bad+1)); done; echo "$n $bad"`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    reader.stdout.on('data', (d) => { out += d; });
    for (let i = 0; i < 200; i++) truncateForDelivery(big(i % 2 ? 'A' : 'B'), '', 960, p.id);
    fs.writeFileSync(`${f}.stop`, '');
    await new Promise((resolve) => reader.on('close', resolve));
    const [reads, failures] = out.trim().split(' ').map(Number);
    assert.ok(reads > 0, 'the reader ran');
    t.diagnostic(`${reads} reads by ${p.user} during 200 re-renders, ${failures} failed`);
    assert.equal(failures, 0, `${failures} of ${reads} reads failed during re-render`);
    assert.deepEqual(fs.readdirSync(path.dirname(f)).sort(), ['message.txt', 'message.txt.stop'].sort());
  });
});
