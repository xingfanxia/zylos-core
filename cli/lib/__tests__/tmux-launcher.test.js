import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const LAUNCHER_PATH = path.resolve(import.meta.dirname, '..', 'runtime', 'tmux-launcher.js');

const tmpFiles = [];
afterEach(() => {
  while (tmpFiles.length) {
    try { fs.unlinkSync(tmpFiles.pop()); } catch { }
  }
});

function writeSpec(spec) {
  const specPath = path.join(os.tmpdir(), `.zylos-test-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  tmpFiles.push(specPath);
  return specPath;
}

describe('tmux-launcher', () => {
  it('exits with code 0 when child exits 0', () => {
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    tmpFiles.pop(); // spec was deleted by launcher
    // If we get here without throw, exit code was 0
  });

  it('exits with child error code', () => {
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(42)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    try {
      execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
        timeout: 10_000,
        encoding: 'utf8',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.status, 42);
    }
    tmpFiles.pop(); // spec was deleted by launcher
  });

  it('deletes spec file before spawn', () => {
    // Use a child that checks if the spec file still exists
    const specPath = path.join(os.tmpdir(), `.zylos-test-spec-delete-${Date.now()}.json`);
    const checkScript = `
      const fs = require('fs');
      const exists = fs.existsSync(${JSON.stringify(specPath)});
      if (exists) {
        process.stderr.write('SPEC_STILL_EXISTS');
        process.exit(99);
      }
      process.exit(0);
    `;

    fs.writeFileSync(specPath, JSON.stringify({
      command: process.execPath,
      args: ['-e', checkScript],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    }), { mode: 0o600 });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    // If child exited 0, spec was deleted before spawn
  });

  it('exits with 128+signal when child is signaled', () => {
    // Spawn a child that kills itself with SIGTERM
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
    });

    try {
      execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
        timeout: 10_000,
        encoding: 'utf8',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      // SIGTERM = 15, so exit code should be 128 + 15 = 143
      assert.equal(err.status, 143, `Expected exit code 143 (128+SIGTERM), got ${err.status}`);
    }
    tmpFiles.pop();
  });

  it('writes exit log when exitLogFile is set', () => {
    const exitLog = path.join(os.tmpdir(), `.zylos-test-exit-log-${Date.now()}`);
    tmpFiles.push(exitLog);

    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      cwd: os.tmpdir(),
      exitLogFile: exitLog,
    });

    execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    tmpFiles.pop(); // spec deleted

    const logContent = fs.readFileSync(exitLog, 'utf8');
    assert.ok(logContent.includes('exit_code=0'), `Exit log should contain exit_code=0: ${logContent}`);
  });

  it('loads a persona-owned env while keeping runtime-controlled values authoritative', () => {
    const personaEnvFile = path.join(os.tmpdir(), `.zylos-persona-env-${Date.now()}`);
    fs.writeFileSync(personaEnvFile, 'PERSONA_SERVICE_TOKEN=persona-secret\nHOME=/persona/override\n', { mode: 0o600 });
    tmpFiles.push(personaEnvFile);
    const specPath = writeSpec({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ token: process.env.PERSONA_SERVICE_TOKEN, home: process.env.HOME }))'],
      env: { PATH: process.env.PATH, HOME: '/runtime/home' },
      cwd: os.tmpdir(),
      personaEnvFile,
    });

    const output = execFileSync(process.execPath, [LAUNCHER_PATH, specPath], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    tmpFiles.splice(tmpFiles.indexOf(specPath), 1);

    assert.deepEqual(JSON.parse(output), {
      token: 'persona-secret',
      home: '/runtime/home',
    });
  });
});

// SWITCH-1: the launcher reports its own launch so the Guardian can tell a
// local launch-path failure from an engine that came up and exited.
describe('tmux-launcher launch result', () => {
  const RUNTIME_DIR = path.dirname(LAUNCHER_PATH);
  const run = (launcher, args) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [launcher, ...args], { timeout: 10_000, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
  };
  const resultFor = (spec, launcher = LAUNCHER_PATH) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-launch-result-'));
    const file = path.join(dir, 'launch-result.json');
    const specPath = writeSpec({ cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: process.env.HOME },
      ...spec, launchResultFile: file, launchId: 'L1' });
    const outcome = run(launcher, [specPath]);
    tmpFiles.splice(tmpFiles.indexOf(specPath), 1);
    const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...outcome, record };
  };

  it('records the engine exit code of a launch whose engine came up and exited', () => {
    const { status, record } = resultFor({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
    assert.equal(status, 3);
    assert.equal(record.launch_id, 'L1');
    assert.equal(record.state, 'exited');
    assert.equal(record.exit_code, 3);
    assert.ok(Number.isFinite(record.ran_ms));
  });

  it('records a missing engine binary as spawn_failed', () => {
    const { status, record } = resultFor({ command: '/nonexistent/zylos-engine', args: [] });
    assert.equal(status, 1);
    assert.equal(record.state, 'spawn_failed');
    assert.equal(record.error_code, 'ENOENT');
  });

  it('records an unresolvable launcher module (2026-11-17 dotenv) as launcher_failed, and --check fails the same way', () => {
    // A copy of the launcher whose tmux-env.js imports a package the user cannot resolve.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-launcher-copy-'));
    for (const name of ['tmux-launcher.js', 'launch-result.js', 'upgrade-context.js']) {
      fs.copyFileSync(path.join(RUNTIME_DIR, name), path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, 'tmux-env.js'), "import { parse } from 'zylos-missing-package-for-test';\nexport { parse };\n");
    try {
      const { status, record } = resultFor({ command: process.execPath, args: ['-e', 'process.exit(0)'] }, path.join(dir, 'tmux-launcher.js'));
      assert.equal(status, 1);
      assert.equal(record.state, 'launcher_failed');
      assert.equal(record.stage, 'modules');
      assert.equal(record.error_code, 'ERR_MODULE_NOT_FOUND');
      assert.match(record.error, /zylos-missing-package-for-test/);

      const check = run(path.join(dir, 'tmux-launcher.js'), ['--check']);
      assert.equal(check.status, 1);
      assert.match(check.stderr, /ERR_MODULE_NOT_FOUND/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check loads the real module graph without a spec and starts nothing', () => {
    const check = run(LAUNCHER_PATH, ['--check']);
    assert.equal(check.status, 0);
    assert.match(check.stdout, /launcher modules ok/);
  });
});
