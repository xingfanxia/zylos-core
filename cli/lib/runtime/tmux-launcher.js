#!/usr/bin/env node

/**
 * tmux-launcher.js — Minimal CLI entry point for launching agent runtimes.
 *
 * Usage: node tmux-launcher.js <spec.json>
 *        node tmux-launcher.js --check    (load the launcher's modules, then exit 0)
 *
 * Reads the spec file, deletes it (unlink-before-spawn), spawns the agent
 * process with the spec's env, and transparently forwards the exit code.
 *
 * Everything that can fail to resolve is imported dynamically below, so a
 * broken module graph (2026-11-17: `dotenv` behind an untraversable
 * node_modules for the persona users) becomes a launch-result record the
 * Guardian can read, instead of an exit in a pane that disappears with it.
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { launchErrorText, writeLaunchResult } from './launch-result.js';

const SIGNAL_NUMBERS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGKILL: 9,
};

async function loadModules() {
  const [upgrade, tmuxEnv] = await Promise.all([import('./upgrade-context.js'), import('./tmux-env.js')]);
  return { ...upgrade, ...tmuxEnv };
}

// The deploy canary: as each persona's Unix user, prove this launcher's module
// graph loads, without reading a spec or starting a session.
if (process.argv[2] === '--check') {
  try {
    await loadModules();
    process.stdout.write('launcher modules ok\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`launcher modules failed: ${err.code || 'error'} ${launchErrorText(err)}\n`);
    process.exit(1);
  }
}

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write('Usage: node tmux-launcher.js <spec.json>\n');
  process.exit(1);
}

// 1. Read spec
let spec;
try {
  const content = fs.readFileSync(specPath, 'utf8');
  // 2. Delete before spawn
  fs.unlinkSync(specPath);
  spec = JSON.parse(content);
} catch (err) {
  process.stderr.write(`Failed to read/parse spec: ${err.message}\n`);
  process.exit(1);
}

const report = record => writeLaunchResult(spec.launchResultFile, spec.launchId, record);
const launcherFailed = (stage, err) => {
  process.stderr.write(`Launcher failed (${stage}): ${err.message}\n`);
  report({ state: 'launcher_failed', stage, error_code: err.code || null, error: launchErrorText(err), at: new Date().toISOString() });
  process.exit(1);
};

let modules;
try {
  modules = await loadModules();
} catch (err) {
  launcherFailed('modules', err);
}
const { applyUpgradePrompt, resumeUpgradeForStartup, ensureInstanceTmpDir, readMergedDotenvVars } = modules;

let runtimeEnv;
try {
  // File-only recovery must precede normal runtime SessionStart/C4 imports.
  const recovery = resumeUpgradeForStartup(spec.cwd || process.cwd());
  if (recovery.blocked || (recovery.active && !recovery.controllerAlive)) {
    spec.args = applyUpgradePrompt(spec.args || [], recovery.prompt, spec.promptIndex, {
      append: !recovery.blocked,
    });
  }

  // 3. Read the persona-owned workspace env only after the launcher has dropped
  // to that persona's OS user. Runtime-controlled spec values win, preventing a
  // workspace env from changing HOME, CODEX_HOME, identity, or engine settings.
  const personaEnv = spec.personaEnvFile
    ? readMergedDotenvVars([spec.personaEnvFile])
    : {};
  runtimeEnv = { ...personaEnv, ...(spec.env || {}) };
} catch (err) {
  launcherFailed('environment', err);
}
try {
  // This process already runs as the persona; never create its private cache
  // as the service user, and never inherit another persona's temporary path.
  if (runtimeEnv.ZYLOS_INSTANCE_ID) runtimeEnv.TMPDIR = ensureInstanceTmpDir(runtimeEnv);
} catch (error) {
  launcherFailed('temp_dir', error);
}

// 4. Spawn child
const spawnedAt = Date.now();
const child = spawn(spec.command, spec.args || [], {
  env: runtimeEnv,
  cwd: spec.cwd || process.cwd(),
  stdio: 'inherit',
});
child.on('spawn', () => report({ state: 'spawned', pid: child.pid, at: new Date(spawnedAt).toISOString() }));

// Signal forwarding
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}

// 5. Exit code transparency
child.on('exit', (code, signal) => {
  // Write exit log if configured
  if (spec.exitLogFile) {
    try {
      const ts = new Date().toISOString();
      const line = `[${ts}] exit_code=${code ?? 'null'} signal=${signal ?? 'null'}\n`;
      fs.appendFileSync(spec.exitLogFile, line);
    } catch { /* non-fatal */ }
  }
  report({ state: 'exited', exit_code: code ?? null, signal: signal ?? null, ran_ms: Date.now() - spawnedAt,
    at: new Date(spawnedAt).toISOString(), exited_at: new Date().toISOString() });

  if (signal) {
    const sigNum = SIGNAL_NUMBERS[signal] || 1;
    process.exit(128 + sigNum);
  }
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  process.stderr.write(`Failed to spawn: ${err.message}\n`);
  report({ state: 'spawn_failed', error_code: err.code || null, error: launchErrorText(err), at: new Date().toISOString() });
  process.exit(1);
});
