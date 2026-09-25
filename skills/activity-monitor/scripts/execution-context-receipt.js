// Runtime-produced metadata only. This proves successful startup hook
// processing to same-account workflow tools; it is not a security boundary
// against a process that can rewrite the runtime's own private files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function executionContextReceiptFile(zylosDir, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) throw new Error('Runtime session identity is missing or invalid');
  if (!path.isAbsolute(zylosDir)) throw new Error('Runtime root must be absolute');
  const key = createHash('sha256').update(sessionId).digest('hex');
  return path.join(zylosDir, 'activity-monitor', 'execution-context', `${key}.json`);
}

export function writeExecutionContextReceipt({ zylosDir, payload, healthy, roundId,
  shardNames = [], failures = [], nowIso = new Date().toISOString() }) {
  const sessionId = payload?.session_id;
  const file = executionContextReceiptFile(zylosDir, sessionId);
  const source = payload?.source;
  if (!['startup', 'resume', 'clear', 'compact'].includes(source)) throw new Error('Unknown runtime session-start source');
  if (healthy && (!roundId || shardNames.length === 0 || failures.length)) throw new Error('Healthy startup receipt requires a complete matching shard round');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Execution context receipt directory must be private');
  const root = fs.realpathSync(zylosDir);
  if (!fs.realpathSync(directory).startsWith(`${root}${path.sep}`)) throw new Error('Execution context receipt directory escapes the runtime root');
  const record = {
    schemaVersion: 1, producer: 'zylos-session-start', sessionId,
    // A compact, resume, or clear never invents a new session identity. A new
    // repository requires a new runtime thread, not a fresh file timestamp.
    contextGeneration: 1, source, freshness: source === 'startup' ? 'fresh' : 'continued',
    healthy: healthy === true, roundId: roundId || null,
    shardNames: [...shardNames], failures: [...failures], issuedAt: nowIso,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return record;
}
