#!/usr/bin/env node
/**
 * C4 Broker — ZY-ISO-2
 *
 * Per-instance unix-socket server (runs as the service user under PM2). It is
 * the structural fix for the two isolation holes the OS-user work left open:
 * cross-user conversation reads in the shared sqlite, and channel-bot
 * impersonation via creds shipped in each agent's .env.
 *
 * How it closes them:
 *  - AUTH BY SOCKET OWNERSHIP. Each isolated instance (os_user in
 *    instances.json) gets its own socket `<state_dir>/c4-broker.sock`, created
 *    in the instance's setgid state_dir so the socket's group is `zylos-<id>`,
 *    then chmod 0660. Only that agent user (+ admin, who owns/ACLs the dir) can
 *    connect. The listener→instanceId map is server-side; the caller id is
 *    NEVER read from the request. This mirrors the existing per-instance
 *    `am.sock` precedent.
 *  - SCOPING IN CODE. Every query/mutation forces `target_instance = <caller>`.
 *    An agent cannot read another instance's conversations or ack another
 *    instance's controls.
 *  - SERVER-SIDE SENDS + EGRESS POLICY. Channel API calls run here with the
 *    ROOT .env creds (agents no longer carry them after B3), and source-tier
 *    files are rejected before any send — enforcement the agent can't bypass.
 *
 * c4-db.js stays a pure library (the broker imports it); routing lives only at
 * the entry/CLI layer (c4-client.js + the migrated entry scripts). Mirrors the
 * c4-dispatcher singleton-pidfile + PM2 fork-mode patterns.
 *
 * ESM-only, Node 20+.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { DATA_DIR, SKILLS_DIR } from './c4-config.js';
import {
  insertConversation,
  insertControl,
  getControlById,
  ackControl,
  formatConversations,
  expireTimedOutControls,
  close as closeDb,
} from './c4-db.js';
import {
  getUnsummarizedRangeForInstance,
  getConversationsByRangeForInstance,
  getLastCheckpointForInstance,
  createCheckpointForInstance,
} from './c4-db-multi.js';
import { initC4Session } from './c4-session-init.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { sourceTierRoots, checkPathViolation, mediaPathFromContent } from './egress-policy.js';
import { getAllInstances, getMonitorDir } from '../../multi-session/instance-config.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const WORKSPACE_DIR = path.join(ZYLOS_DIR, 'workspace');
const SOCKET_NAME = 'c4-broker.sock';
const PID_PATH = path.join(DATA_DIR, 'c4-broker.pid');
const SOCKET_MODE = 0o660;
const RESCAN_INTERVAL_MS = 30_000;

let isShuttingDown = false;
/** @type {Map<string, net.Server>} instanceId -> server */
const servers = new Map();

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Socket lifecycle ────────────────────────────────────────────────

function socketPathFor(instanceId) {
  return path.join(getMonitorDir(instanceId), SOCKET_NAME);
}

function ensureSocket(instanceId) {
  if (servers.has(instanceId)) return;
  const sockPath = socketPathFor(instanceId);
  const dir = path.dirname(sockPath);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* provisioned already */ }
  // Unlink a stale socket before bind (avoids EADDRINUSE across restarts).
  try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); }
  catch (err) { log(`WARN could not unlink stale socket for ${instanceId}: ${err.message}`); }

  const server = net.createServer((conn) => handleConnection(conn, instanceId));
  // SPOF guard: a socket the broker can't serve means that agent loses DB +
  // creds. Fail loud in the log; keep the other instances' sockets alive.
  server.on('error', (err) => log(`FATAL socket server error for ${instanceId}: ${err.message}`));
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, SOCKET_MODE); }
    catch (err) { log(`WARN chmod socket ${instanceId}: ${err.message}`); }
    log(`listening for ${instanceId} at ${sockPath}`);
  });
  servers.set(instanceId, server);
}

function removeSocket(instanceId) {
  const server = servers.get(instanceId);
  if (!server) return;
  try { server.close(); } catch { /* best effort */ }
  servers.delete(instanceId);
  try { fs.unlinkSync(socketPathFor(instanceId)); } catch { /* already gone */ }
  log(`removed socket for ${instanceId}`);
}

/**
 * Re-derive the set of isolated instances from instances.json and reconcile
 * sockets. Idempotent: ensureSocket() no-ops for already-served instances.
 * Fired at startup, on SIGHUP (from c4-approve after provisioning a new user),
 * and on a slow mtime poll as a belt-and-braces fallback.
 */
function scanInstances() {
  let isolatedIds = [];
  try {
    isolatedIds = getAllInstances().filter((i) => i.os_user).map((i) => i.id);
  } catch (err) {
    log(`FATAL cannot read instances.json during scan: ${err.message}`);
    return;
  }
  const wanted = new Set(isolatedIds);
  for (const id of isolatedIds) ensureSocket(id);
  for (const id of [...servers.keys()]) {
    if (!wanted.has(id)) removeSocket(id);
  }
  if (servers.size === 0) log('WARN no isolated instances (os_user) found — broker idle');
}

// ── Connection handling (newline-delimited JSON) ────────────────────

function writeRes(conn, obj) {
  try { conn.write(JSON.stringify(obj) + '\n'); } catch { /* client closed */ }
}

function handleConnection(conn, instanceId) {
  conn.setEncoding('utf8');
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); }
      catch { writeRes(conn, { id: null, ok: false, error: 'bad_json' }); continue; }
      const reqId = (req && req.id != null) ? req.id : null;
      Promise.resolve()
        .then(() => handleRequest(req, instanceId))
        .then((r) => writeRes(conn, { id: reqId, ...r }))
        .catch((err) => writeRes(conn, { id: reqId, ok: false, error: String(err?.message || err) }));
    }
  });
  conn.on('error', () => { /* client vanished — nothing to clean up */ });
}

/**
 * Dispatch one request. `caller` is the server-authenticated instance id
 * (which socket the connection arrived on) — never taken from the payload.
 */
async function handleRequest(req, caller) {
  const op = req?.op;
  const p = (req && typeof req.params === 'object' && req.params) || {};
  switch (op) {
    case 'ping':         return { ok: true, data: { pong: true, instance: caller } };
    case 'send':         return await opSend(p, caller);
    case 'fetch':        return opFetch(p, caller);
    case 'unsummarized': return opUnsummarized(caller);
    case 'checkpoint':   return opCheckpoint(p, caller);
    case 'enqueue':      return opEnqueue(p, caller);
    case 'ack':          return opAck(p, caller);
    case 'get':          return opGet(p, caller);
    case 'session-init': return await opSessionInit(caller);
    default:             return { ok: false, error: `unknown_op:${op ?? '(none)'}` };
  }
}

// ── Ops ─────────────────────────────────────────────────────────────

async function opSend(p, caller) {
  const channel = p.channel;
  const endpoint = p.endpoint ?? null;
  const content = p.content;
  const attachments = Array.isArray(p.attachments)
    ? p.attachments
    : (p.attachments ? [p.attachments] : []);

  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'content_required' };
  try { validateChannel(channel, true); } catch (e) { return { ok: false, error: `invalid_channel:${e.message}` }; }
  if (endpoint != null) {
    try { validateEndpoint(endpoint); } catch (e) { return { ok: false, error: `invalid_endpoint:${e.message}` }; }
  }

  // Egress policy — the confused-deputy fix. Reject any source-tier path,
  // whether it arrives as an explicit attachment or a [MEDIA:...] prefix on
  // the message (the feishu send.js media convention).
  const roots = sourceTierRoots(WORKSPACE_DIR);
  const mediaPath = mediaPathFromContent(content);
  const candidates = [...attachments.map(String), ...(mediaPath ? [mediaPath] : [])];
  for (const c of candidates) {
    const v = checkPathViolation(c, roots);
    if (v) {
      log(`EGRESS BLOCKED ${caller}: ${v.path} (root ${v.root})`);
      return { ok: false, error: `egress_blocked: source-tier files are never sent through chat channels (${v.path})` };
    }
  }

  // Durable out-message audit row, scoped to caller (parity with c4-send).
  let conversationId = null;
  try {
    const row = insertConversation('out', channel, endpoint, content, null, 3, false, null, caller);
    conversationId = row.id;
  } catch (e) {
    log(`WARN audit insert failed (${caller}): ${e.message}`);
  }

  const channelScript = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');
  if (!fs.existsSync(channelScript)) return { ok: false, error: `channel_script_missing:${channelScript}` };

  const code = await spawnSend(channelScript, endpoint, content);
  if (code === 0) return { ok: true, data: { sent: true, conversation_id: conversationId, channel } };
  return { ok: false, error: `channel_send_failed:exit_${code}`, data: { conversation_id: conversationId } };
}

function spawnSend(channelScript, endpoint, content) {
  return new Promise((resolve) => {
    // Same arg shape c4-send uses: [endpoint, message] or [message].
    const args = endpoint != null ? [channelScript, endpoint, content] : [channelScript, content];
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && stderr) log(`channel send stderr: ${stderr.trim().slice(0, 500)}`);
      resolve(code == null ? 1 : code);
    });
    child.on('error', (err) => { log(`channel spawn error: ${err.message}`); resolve(1); });
  });
}

function opFetch(p, caller) {
  const checkpoint = getLastCheckpointForInstance(caller);
  let conversations;
  let range;
  if (p.unsummarized) {
    range = getUnsummarizedRangeForInstance(caller);
    if (!range || range.count === 0) {
      return { ok: true, data: { checkpoint, range: { begin_id: null, end_id: null, count: 0 }, conversations: [], formatted: '' } };
    }
    conversations = getConversationsByRangeForInstance(range.begin_id, range.end_id, caller);
  } else {
    const begin = Number(p.begin);
    const end = Number(p.end);
    if (!Number.isFinite(begin) || !Number.isFinite(end)) return { ok: false, error: 'begin_end_required' };
    conversations = getConversationsByRangeForInstance(begin, end, caller);
    range = { begin_id: begin, end_id: end, count: conversations.length };
  }
  return { ok: true, data: { checkpoint, range, conversations, formatted: formatConversations(conversations) } };
}

function opUnsummarized(caller) {
  return { ok: true, data: getUnsummarizedRangeForInstance(caller) };
}

function opCheckpoint(p, caller) {
  if (p.latest) return { ok: true, data: getLastCheckpointForInstance(caller) };
  const endId = Number(p.endId ?? p.end_conversation_id);
  if (!Number.isInteger(endId)) return { ok: false, error: 'endId_required' };
  const summary = p.summary ?? null;
  return { ok: true, data: createCheckpointForInstance(endId, summary, caller) };
}

function opEnqueue(p, caller) {
  const content = p.content;
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'content_required' };
  const row = insertControl(content, {
    priority: Number.isInteger(p.priority) ? p.priority : 3,
    requireIdle: Boolean(p.requireIdle),
    bypassState: Boolean(p.bypassState),
    appendAckSuffix: p.appendAckSuffix !== false,
    ackDeadlineAt: p.ackDeadlineAt ?? null,
    availableAt: p.availableAt ?? null,
    targetInstance: caller, // forced — the client cannot target another instance
  });
  return { ok: true, data: { id: row.id, superseded_count: row.superseded_count } };
}

/** Controls belonging to another instance are off-limits; NULL-target (legacy/global) are allowed. */
function callerOwnsControl(row, caller) {
  return row.target_instance == null || row.target_instance === caller;
}

function opAck(p, caller) {
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id_required' };
  const row = getControlById(id);
  if (!row) return { ok: false, error: 'not_found' };
  if (!callerOwnsControl(row, caller)) return { ok: false, error: 'forbidden: control belongs to another instance' };
  return { ok: true, data: ackControl(id) };
}

function opGet(p, caller) {
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'id_required' };
  expireTimedOutControls();
  const row = getControlById(id);
  if (!row) return { ok: false, error: 'not_found' };
  if (!callerOwnsControl(row, caller)) return { ok: false, error: 'forbidden' };
  return { ok: true, data: { status: row.status } };
}

async function opSessionInit(caller) {
  // closeDb:false — keep the broker's shared connection open across requests.
  const context = await initC4Session(caller, { closeDb: false });
  return { ok: true, data: { context } };
}

// ── Singleton lock (mirrors c4-dispatcher) ──────────────────────────

function acquireSingletonLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(PID_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', () => { try { fs.unlinkSync(PID_PATH); } catch { /* best effort */ } });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') { log(`Singleton lock error: ${err.message} — continuing without lock`); return true; }
      let holderPid = 0;
      try { holderPid = Number.parseInt(fs.readFileSync(PID_PATH, 'utf8'), 10); } catch { /* unreadable */ }
      let holderAlive = false;
      if (Number.isInteger(holderPid) && holderPid > 0 && holderPid !== process.pid) {
        try { process.kill(holderPid, 0); holderAlive = true; }
        catch (e) { holderAlive = e?.code === 'EPERM'; }
      }
      if (holderAlive) { log(`Another broker is running (pid ${holderPid}) — exiting.`); return false; }
      try { fs.unlinkSync(PID_PATH); } catch { /* reclaim stale */ }
    }
  }
  log('Could not acquire singleton lock after stale-cleanup retry — exiting.');
  return false;
}

// ── Lifecycle ───────────────────────────────────────────────────────

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Shutting down...');
  for (const id of [...servers.keys()]) {
    try { servers.get(id).close(); } catch { /* best effort */ }
    try { fs.unlinkSync(socketPathFor(id)); } catch { /* already gone */ }
  }
  try { closeDb(); } catch { /* best effort */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', () => { log('SIGHUP — re-scanning instances'); scanInstances(); });

function main() {
  if (!acquireSingletonLock()) process.exit(1);
  log('=== C4 Broker Started ===');
  scanInstances();
  // Fallback re-scan (SIGHUP from c4-approve is primary; this also keeps the
  // event loop alive when zero isolated instances exist yet).
  setInterval(scanInstances, RESCAN_INTERVAL_MS);
}

// PM2 sets argv[1] to its ProcessContainerFork.js, so classic isMainModule
// checks are unreliable. Auto-start unless a test disables it.
if (process.env.C4_BROKER_DISABLE_MAIN !== '1') {
  main();
}

export { handleRequest, scanInstances, ensureSocket, removeSocket, socketPathFor };
