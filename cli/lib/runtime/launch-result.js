/**
 * launch-result.js — the launcher's own report of one engine launch.
 *
 * The tmux launcher runs as the persona's Unix user inside a pane that closes
 * when it exits, so its stderr is gone by the time anyone looks. It writes one
 * small JSON record instead, into the persona's monitor dir (writable by both
 * the monitor and the persona user). The Guardian reads it to tell why a start
 * failed. The record holds only the launcher's own facts: a stage, an error
 * code and the first line of the launcher's error, the engine's exit code and
 * signal. Never engine output or user content.
 *
 * Node built-ins only: the launcher imports this module before anything that
 * could fail to resolve.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LAUNCH_RESULT_FILE = 'launch-result.json';
const MAX_ERROR_CHARS = 300;

/** First line of an error message, bounded. */
export function launchErrorText(err) {
  const text = String(err?.message ?? err ?? '').split('\n')[0].trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

/**
 * Before a launch: remove the previous record and name the new one.
 * @param {string|null} monitorDir
 * @returns {{file: string, launchId: string}|null}
 */
export function prepareLaunchResult(monitorDir, nowMs = Date.now()) {
  if (!monitorDir) return null;
  const file = path.join(monitorDir, LAUNCH_RESULT_FILE);
  try { fs.rmSync(file, { force: true }); } catch { /* the launcher overwrites it */ }
  return { file, launchId: `${nowMs}-${process.pid}` };
}

/** Launcher side: replace the record (best effort; a failed write leaves no record). */
export function writeLaunchResult(file, launchId, record) {
  if (!file || !launchId) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ launch_id: launchId, ...record })}\n`, { mode: 0o660 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

/**
 * Monitor side. undefined: no launcher record is expected for this launch;
 * null: one was expected and none (or another launch's) is there.
 */
export function readLaunchResult(prepared) {
  if (!prepared?.file) return undefined;
  try {
    const record = JSON.parse(fs.readFileSync(prepared.file, 'utf8'));
    return record?.launch_id === prepared.launchId ? record : null;
  } catch {
    return null;
  }
}
