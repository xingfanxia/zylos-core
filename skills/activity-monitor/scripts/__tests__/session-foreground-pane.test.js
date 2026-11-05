import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-foreground-pane-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// Fork: a pane named by ZYLOS_TMUX_SESSION or tmux_session is the managed one,
// not upstream's fixed claude-main.
it('checks the configured tmux session, not claude-main', async () => {
  process.env.ZYLOS_DIR = tmpDir;
  process.env.ZYLOS_TMUX_SESSION = 'agent-pane';
  const { handleSessionForeground } = await import('../session-foreground.js');
  const sessions = [];
  const record = handleSessionForeground({ session_id: 's1' }, {
    platform: 'linux', claudePid: 4242, verifyManagedPane: true,
    managedProcess: (pid, { session }) => { sessions.push(session); return true; },
  });
  assert.equal(record.session_id, 's1');
  assert.deepEqual(sessions, ['agent-pane']);
});

// Fork: an OS-isolated persona cannot query the service user's tmux server, so
// with #835 evidence off the hook records without the managed-pane check.
it('records without a tmux query while health evidence is off', async () => {
  process.env.ZYLOS_DIR = tmpDir;
  const { handleSessionForeground } = await import('../session-foreground.js');
  let queried = 0;
  const record = handleSessionForeground({ session_id: 'isolated' }, {
    platform: 'linux', claudePid: 4242, managedProcess: () => { queried++; return false; },
  });
  assert.equal(record.session_id, 'isolated');
  assert.equal(queried, 0);
});
