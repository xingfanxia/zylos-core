#!/usr/bin/env node
/**
 * C4 Client — broker shim for the comm-bridge entry scripts (ZY-ISO-2).
 *
 * Isolated agents (os_user in instances.json) route send/query/enqueue/
 * session-init through the per-instance c4-broker unix socket instead of
 * opening c4.db or carrying channel creds. Admin/scheduler (no os_user, no
 * socket) fall through to each script's legacy direct path automatically —
 * zero behavior change for them.
 *
 * SPOF discipline: when an instance HAS os_user but the broker socket is
 * missing/unreachable, routing fails LOUD (throws + logs to hook-timing.log)
 * rather than silently degrading. After B3 an isolated agent has no DB access,
 * so a silent "fall back to direct" would crash opaquely or no-op a hook — a
 * dead broker must be visible.
 *
 * ESM-only, Node 20+.
 */

import { isCliEntry } from '../../multi-session/cli-entry.js';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getInstanceDef, getMonitorDir, getInstanceId } from '../../multi-session/instance-config.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const HOOK_LOG = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-timing.log');
const SOCKET_NAME = 'c4-broker.sock';
const BROKER_TIMEOUT_MS = 8000;

/** Isolated tier = this instance declares an os_user in instances.json. */
export function instanceIsIsolated(instanceId = getInstanceId()) {
  if (!instanceId) return false;
  const def = getInstanceDef(instanceId);
  return Boolean(def?.os_user);
}

export function brokerSocketPath(instanceId = getInstanceId()) {
  return path.join(getMonitorDir(instanceId), SOCKET_NAME);
}

export function brokerSocketExists(instanceId = getInstanceId()) {
  try { return fs.statSync(brokerSocketPath(instanceId)).isSocket(); } catch { return false; }
}

function logSpof(instanceId) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(HOOK_LOG, `[${ts}] hook=c4-client SPOF broker_socket_missing instance=${instanceId}\n`);
  } catch { /* best effort */ }
}

/**
 * Route decision.
 *  - not isolated (admin/scheduler, single-session) → false (legacy direct path)
 *  - isolated + socket present → true (broker path)
 *  - isolated + socket MISSING → throw (SPOF; never silent legacy fallback)
 */
export function shouldUseBroker(instanceId = getInstanceId()) {
  if (!instanceIsIsolated(instanceId)) return false;
  if (brokerSocketExists(instanceId)) return true;
  logSpof(instanceId);
  throw new Error(
    `c4-broker socket missing for isolated instance ${instanceId} (${brokerSocketPath(instanceId)}); broker down?`,
  );
}

let _reqSeq = 0;

/**
 * One request/response round-trip over the broker socket (newline-delimited
 * JSON). Resolves the broker's `data`; rejects on transport or broker error.
 *
 * @param {string} op
 * @param {object} [params]
 * @param {string} [instanceId]
 * @returns {Promise<any>}
 */
export function brokerCall(op, params = {}, instanceId = getInstanceId()) {
  const sockPath = brokerSocketPath(instanceId);
  const id = ++_reqSeq;
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = '';
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { conn.destroy(); } catch { /* already gone */ }
      fn(arg);
    };
    conn.setTimeout(BROKER_TIMEOUT_MS);
    conn.setEncoding('utf8');
    conn.on('connect', () => { conn.write(JSON.stringify({ id, op, params }) + '\n'); });
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let res;
      try { res = JSON.parse(buf.slice(0, nl)); }
      catch { return done(reject, new Error('broker: bad response json')); }
      if (res.ok) done(resolve, res.data);
      else done(reject, new Error(`broker: ${res.error || 'unknown_error'}`));
    });
    conn.on('timeout', () => done(reject, new Error('broker: timeout')));
    conn.on('error', (err) => done(reject, err));
    conn.on('close', () => done(reject, new Error('broker: closed without response')));
  });
}

// ── Minimal CLI (routing-aware) ─────────────────────────────────────
// Used by subprocess callers that must respect broker routing but only need a
// tiny surface (e.g. context-monitor's unsummarized-count read, which must not
// touch c4-db.js directly for isolated agents).

async function cli() {
  const op = process.argv[2];
  if (op === 'unsummarized') {
    let range;
    if (shouldUseBroker()) {
      range = await brokerCall('unsummarized');
    } else {
      const { getUnsummarizedRange, close } = await import('./c4-db.js');
      let getForInstance = null;
      try { ({ getUnsummarizedRangeForInstance: getForInstance } = await import('./c4-db-multi.js')); } catch { /* single-session */ }
      const iid = getInstanceId();
      range = (iid && getForInstance) ? getForInstance(iid) : getUnsummarizedRange();
      close();
    }
    process.stdout.write(JSON.stringify(range));
    return;
  }
  if (op === 'ping') {
    const data = await brokerCall('ping');
    process.stdout.write(JSON.stringify(data));
    return;
  }
  console.error(`c4-client: unknown CLI op '${op ?? ''}' (supported: unsummarized, ping)`);
  process.exit(1);
}

if (isCliEntry(import.meta.url)) {
  cli().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
