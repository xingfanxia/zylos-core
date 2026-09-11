import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { CodexContextMonitor } from '../codex-context-monitor.js';

const started = Date.parse('2026-09-06T12:00:00Z');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-codex-context-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex-subscription');
  const cwd = path.join(root, 'zylos/instances/admin');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(codexHome);
  let tmuxStarted = started;
  let engineStarted = started;
  let enginePid = 600;
  const commands = [];
  const monitor = new CodexContextMonitor({ codexHome, cwd, tmuxSession: 'claude-main',
    buildProcessTree: () => ({ childrenOf: new Map([[500, [enginePid]]]),
      infoOf: new Map([[500, { comm: 'bash' }], [enginePid, { comm: 'codex' }]]) }),
    execFileSync: (command, args, options) => {
      commands.push({ command, args });
      if (command === 'tmux') {
        assert.deepEqual(args, ['list-panes', '-t', 'claude-main', '-F', '#{pane_pid}']);
        if (!tmuxStarted) throw new Error('no server running');
        return '500\n';
      }
      if (command === 'ps') return new Date(engineStarted).toUTCString().replace(' GMT', '');
      return execFileSync(command, args, options);
    } });
  monitor._openRollouts = () => [];
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const meta = (id, source = 'cli', time = tmuxStarted + 800, instanceCwd = cwd) =>
    ({ type: 'session_meta', payload: { id, source, timestamp: new Date(time).toISOString(), cwd: instanceCwd } });
  const count = (tokens, total = 99000000) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: tokens, cached_input_tokens: tokens - 100 },
    total_token_usage: { input_tokens: total }, model_context_window: 1000000,
  } } });
  const rollout = ({ id = 'root', source = 'cli', time = tmuxStarted + 800,
    instanceCwd = cwd, home = codexHome, tokens = 77931, rows } = {}) =>
    write(path.join(home, 'sessions/2026/09/06', `rollout-${id}.jsonl`),
      [meta(id, source, time, instanceCwd), ...(rows || [count(tokens)])].map(JSON.stringify).join('\n') + '\n');
  return { root, codexHome, cwd, monitor, commands, write, meta, count, rollout,
    setStart: (value) => { tmuxStarted = value; engineStarted = value; },
    setEngine: (pid, time) => { enginePid = pid; engineStarted = time; } };
}

test('reads active CODEX_HOME and latest context without adding cache or cumulative costs', async (t) => {
  const f = fixture(t);
  const file = f.rollout({ rows: [f.count(60000), f.count(77931)] });
  f.rollout({ home: path.join(f.root, '.codex'), tokens: 999999 });
  assert.deepEqual(await f.monitor.getUsage(), { used: 77931, ceiling: 1000000,
    source: 'rollout_token_count', rolloutPath: file });
});

test('filesystem fallback rejects stale roots, other cwd, exec, and child with cloned parent meta', async (t) => {
  const f = fixture(t);
  const file = f.rollout();
  f.rollout({ id: 'old', time: started - 3600000, tokens: 999999 });
  f.rollout({ id: 'foreign', instanceCwd: f.cwd.replace('admin', 'group'), tokens: 999999 });
  f.rollout({ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } },
    rows: [f.meta('root'), f.count(999999)] });
  f.rollout({ id: 'exec', source: 'exec', tokens: 999999 });
  assert.equal((await f.monitor.getUsage()).rolloutPath, file);
});

test('valid SQLite index query executes with AND and validates selected metadata', async (t) => {
  const f = fixture(t);
  const file = f.rollout();
  const db = path.join(f.codexHome, 'state_5.sqlite');
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  execFileSync('sqlite3', [db, `CREATE TABLE threads (rollout_path TEXT, archived INTEGER, cwd TEXT, created_at INTEGER, tokens_used INTEGER);
    INSERT INTO threads VALUES (${quote(file)},0,${quote(f.cwd)},${started / 1000},99000000);`]);
  f.monitor._getRolloutsFromFilesystem = () => { throw new Error('valid SQL must not need filesystem fallback'); };
  assert.equal((await f.monitor.getUsage()).used, 77931);
  const query = f.commands.find((c) => c.command === 'sqlite3');
  assert.equal(query.args[0], '-readonly');
  assert.equal(fileURLToPath(query.args[1]), db);
  assert.equal(new URL(query.args[1]).searchParams.get('immutable'), '1');
  assert.equal(new URL(query.args[1]).searchParams.get('mode'), 'ro');
  assert.match(query.args[2], /archived = 0\s+AND cwd =/);
});

test('never interprets SQLite cumulative tokens as current context when token_count is absent', async (t) => {
  const f = fixture(t);
  const file = f.rollout({ rows: [] });
  execFileSync('sqlite3', [path.join(f.codexHome, 'state_5.sqlite'), `CREATE TABLE threads (rollout_path TEXT, archived INTEGER, cwd TEXT, created_at INTEGER, tokens_used INTEGER);
    INSERT INTO threads VALUES ('${file}',0,'${f.cwd}',${started / 1000},99000000);`]);
  assert.equal(await f.monitor.getUsage(), null);
});

test('operator index reads of a WAL-mode database create no sidecars or database changes', async (t) => {
  const f = fixture(t);
  const file = f.rollout();
  const db = path.join(f.codexHome, 'state_5.sqlite');
  execFileSync('sqlite3', [db, `PRAGMA journal_mode=WAL;
    CREATE TABLE threads (rollout_path TEXT, archived INTEGER, cwd TEXT, created_at INTEGER);
    INSERT INTO threads VALUES ('${file}',0,'${f.cwd}',${started / 1000});`]);
  assert.equal(fs.existsSync(`${db}-wal`), false);
  assert.equal(fs.existsSync(`${db}-shm`), false);
  const before = fs.readFileSync(db);
  assert.equal((await f.monitor.getUsage()).used, 77931);
  assert.equal(fs.existsSync(`${db}-wal`), false);
  assert.equal(fs.existsSync(`${db}-shm`), false);
  assert.deepEqual(fs.readFileSync(db), before);
});

test('uncheckpointed WAL index entries do not hide the live filesystem rollout', async (t) => {
  const f = fixture(t);
  const file = f.rollout();
  const db = path.join(f.codexHome, 'state_5.sqlite');
  execFileSync('sqlite3', [db, `PRAGMA journal_mode=WAL;
    CREATE TABLE threads (rollout_path TEXT, archived INTEGER, cwd TEXT, created_at INTEGER);`]);
  const writer = spawn('sqlite3', [db], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture writer timed out')), 3000);
    writer.stdout.on('data', (chunk) => { if (String(chunk).includes('AX268_READY')) { clearTimeout(timer); resolve(); } });
    writer.on('error', reject);
  });
  try {
    writer.stdin.write(`INSERT INTO threads VALUES ('${file}',0,'${f.cwd}',${started / 1000});\n.print AX268_READY\n`);
    await ready;
    assert.ok(fs.statSync(`${db}-wal`).size > 0);
    let fallback = false;
    const original = f.monitor._getRolloutsFromFilesystem.bind(f.monitor);
    f.monitor._getRolloutsFromFilesystem = (time) => { fallback = true; return original(time); };
    assert.equal((await f.monitor.getUsage()).used, 77931);
    assert.equal(fallback, true);
  } finally {
    const exited = once(writer, 'exit');
    writer.stdin.end('.quit\n');
    await exited;
  }
});

test('tmux unavailable and retired-only data return null; live idle context is retained', async (t) => {
  const f = fixture(t);
  f.rollout({ id: 'old', time: started - 3600000 });
  assert.equal(await f.monitor.getUsage(), null);
  const file = f.rollout();
  fs.utimesSync(file, started / 1000, started / 1000);
  assert.equal((await f.monitor.getUsage()).used, 77931);
  f.setStart(null);
  assert.equal(await f.monitor.getUsage(), null);
});

test('new tmux session invalidates cached rollout and does not sample a cycled-away session', async (t) => {
  const f = fixture(t);
  f.rollout({ tokens: 700000 });
  assert.equal((await f.monitor.getUsage()).used, 700000);
  f.setStart(started + 3600000);
  assert.equal(await f.monitor.getUsage(), null);
  f.rollout({ id: 'new', tokens: 50000 });
  assert.equal((await f.monitor.getUsage()).used, 50000);
});

test('same-pane engine restart replaces cached rollout without changing tmux creation', async (t) => {
  const f = fixture(t);
  f.rollout({ tokens: 700000 });
  assert.equal((await f.monitor.getUsage()).used, 700000);
  f.setEngine(601, started + 3600000);
  assert.equal(await f.monitor.getUsage(), null);
  f.rollout({ id: 'new', time: started + 3601000, tokens: 50000 });
  assert.equal((await f.monitor.getUsage()).used, 50000);
});

test('slow startup is matched to engine start; resumed roots require an open descriptor', async (t) => {
  const f = fixture(t);
  const file = f.rollout({ time: started + 300000 });
  assert.equal((await f.monitor.getUsage()).used, 77931);
  f.setEngine(601, started + 3600000);
  assert.equal(await f.monitor.getUsage(), null);
  f.monitor._openRollouts = () => [file];
  assert.equal((await f.monitor.getUsage()).used, 77931);
});

test('same-process thread change follows its active descriptor instead of the previous sample', async (t) => {
  const f = fixture(t);
  const before = f.rollout({ tokens: 700000 });
  f.monitor._openRollouts = () => [before];
  assert.equal((await f.monitor.getUsage()).used, 700000);
  const after = f.rollout({ id: 'new-thread', time: started + 300000, tokens: 50000 });
  f.monitor._openRollouts = () => [after];
  assert.equal((await f.monitor.getUsage()).used, 50000);
});

test('multiple unrelated CLI roots cannot be guessed from latest mtime', async (t) => {
  const f = fixture(t);
  f.rollout();
  f.rollout({ id: 'later-cli', time: started + 300000 });
  assert.equal(await f.monitor.getUsage(), null);
});

test('ambiguous roots and invalid token usage return null', async (t) => {
  const f = fixture(t);
  f.rollout({ rows: [f.count(-1), f.count(NaN)] });
  assert.equal(await f.monitor.getUsage(), null);
  f.rollout({ id: 'second' });
  f.monitor._cachedRollout = null;
  assert.equal(await f.monitor.getUsage(), null);
});

test('ceiling fallback reads the active profile config and exact selected model', (t) => {
  const f = fixture(t);
  f.write(path.join(f.codexHome, 'config.toml'), 'model_context_window = 1000000\n');
  f.write(path.join(f.codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'wrong', context_window: 5000 }, { slug: 'current', context_window: 272000, effective_context_window_percent: 95 },
  ] }));
  assert.equal(f.monitor._getModelCeiling(), 1000000);
  fs.unlinkSync(path.join(f.codexHome, 'config.toml'));
  f.monitor._model = 'current';
  assert.equal(f.monitor._getModelCeiling(), 258400);
  f.monitor._model = 'unknown-model';
  assert.equal(f.monitor._getModelCeiling(), null);
});

test('missing effective event ceiling and unknown profile window yield no sample', async (t) => {
  const f = fixture(t);
  const event = f.count(700000);
  delete event.payload.info.model_context_window;
  f.rollout({ rows: [event] });
  assert.equal(await f.monitor.getUsage(), null);
});
