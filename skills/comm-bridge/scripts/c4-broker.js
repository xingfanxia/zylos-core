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
  getDb,
  markFailed,
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
import { sourceTierRoots, checkPathViolation, mediaPathFromContent, makeUidResolver, stageOwnedMedia } from './egress-policy.js';
import { getAllInstances, getMonitorDir, getInstanceDef } from '../../multi-session/instance-config.js';
import * as taskOps from '../../scheduler/scripts/task-ops.js';
import { getDb as getSchedulerDb, generateId as generateTaskId, now as taskNow } from '../../scheduler/scripts/database.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const WORKSPACE_DIR = path.join(ZYLOS_DIR, 'workspace');
const SOCKET_NAME = 'c4-broker.sock';
const PID_PATH = path.join(DATA_DIR, 'c4-broker.pid');
const SOCKET_MODE = 0o660;
const RESCAN_INTERVAL_MS = 30_000;
const CONN_IDLE_MS = 30_000;
const MAX_LINE_BYTES = 1_000_000;

// Real outbound messaging channels the broker will spawn on an agent's behalf.
// The existence of a `<channel>/scripts/send.js` is NOT authorization
// (security CRITICAL-1): internal skills like `shell` also ship a send.js that
// writes arbitrary bytes to an arbitrary unix socket — routed through the
// privileged broker that becomes a cross-instance impersonation / SSRF
// primitive. Default-deny; extend this set deliberately when adding a channel.
const MESSAGING_CHANNELS = new Set(['feishu', 'telegram', 'wechat', 'web-console']);

// sourceTierRoots() shells out getent + does a readdir/stat sweep; cache it so a
// long-lived singleton broker doesn't stall its event loop on every send (M4).
let _rootsCache = { at: 0, roots: null };
const ROOTS_TTL_MS = 60_000;
function cachedSourceTierRoots() {
  const nowMs = Date.now();
  if (_rootsCache.roots && (nowMs - _rootsCache.at) < ROOTS_TTL_MS) return _rootsCache.roots;
  const roots = sourceTierRoots(WORKSPACE_DIR);
  _rootsCache = { at: nowMs, roots };
  return roots;
}

// REL-8: memoized caller os_user→uid resolver for attachment ownership checks
// (only the CALLER's uid is ever resolved). Failures are logged loudly and treated
// fail-closed by stageOwnedMedia.
const resolveCallerUid = makeUidResolver(undefined, (m) => log(m));

// REL-8: broker-private staging root for validated attachment bytes. 0700 and
// under the broker's own DATA_DIR, so no tenant can write, traverse, or swap a
// staged file. Created lazily on first media send.
const ATTACH_STAGING_DIR = path.join(DATA_DIR, 'attach-staging');
let _stagingReady = false;
function ensureStagingDir() {
  if (_stagingReady) return;
  fs.mkdirSync(ATTACH_STAGING_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ATTACH_STAGING_DIR, 0o700); } catch { /* best effort */ }
  _stagingReady = true;
}

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
  // creds. Fail loud in the log; keep the other instances' sockets alive. Drop
  // the dead server from the map so the next scan/SIGHUP retries the bind (M2)
  // — otherwise a transient bind failure is permanent until a full restart.
  server.on('error', (err) => {
    log(`FATAL socket server error for ${instanceId}: ${err.message}`);
    if (servers.get(instanceId) === server) servers.delete(instanceId);
    try { server.close(); } catch { /* best effort */ }
  });
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
  // Idle/oversize hardening (L2): drop a client that connects and never sends a
  // newline (fd/buffer leak). Threat is local-only (0660 socket), so this is
  // belt-and-braces, but a long-lived singleton shouldn't accumulate them.
  conn.setTimeout(CONN_IDLE_MS, () => { try { conn.destroy(); } catch { /* gone */ } });
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      writeRes(conn, { id: null, ok: false, error: 'request_too_large' });
      try { conn.destroy(); } catch { /* gone */ }
      return;
    }
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
    case 'void':         return opVoid(p, caller);
    case 'fetch':        return opFetch(p, caller);
    case 'unsummarized': return opUnsummarized(caller);
    case 'checkpoint':   return opCheckpoint(p, caller);
    case 'enqueue':      return opEnqueue(p, caller);
    case 'ack':          return opAck(p, caller);
    case 'get':          return opGet(p, caller);
    case 'session-init': return await opSessionInit(caller);
    case 'scheduler':    return opScheduler(p, caller);
    default:             return { ok: false, error: `unknown_op:${op ?? '(none)'}` };
  }
}

// ── Ops ─────────────────────────────────────────────────────────────

function endpointChatId(endpoint) {
  return String(endpoint ?? '').split('|')[0];
}

/** Chat ids of the operator/owner (primary instances) — always a valid destination. */
function ownerChatIds() {
  try {
    return getAllInstances().filter((i) => i.primary).flatMap((i) => i.chat_ids || []);
  } catch { return []; }
}

/**
 * HIGH-1: an isolated agent may only send to endpoints it is authorized for —
 * its own bound chat_ids, the operator's chat (escalation is always allowed),
 * the controlled web-console channel, or a chat that has previously messaged it
 * (the reply flow, and the group instance's dynamically discovered groups).
 * Blocks one tenant messaging ANOTHER tenant's end users with the centralized
 * bot creds; it deliberately does NOT block notifying the owner.
 */
function endpointAuthorized(channel, endpoint, caller) {
  if (channel === 'web-console') return true; // controlled admin/console channel
  const chatId = endpointChatId(endpoint);
  if (!chatId) return false;
  const def = getInstanceDef(caller);
  if (Array.isArray(def?.chat_ids) && def.chat_ids.includes(chatId)) return true;
  if (ownerChatIds().includes(chatId)) return true; // any instance may escalate to the operator
  try {
    const row = getDb().prepare(
      "SELECT 1 FROM conversations WHERE target_instance = ? AND direction = 'in' AND (endpoint_id = ? OR endpoint_id LIKE ?) LIMIT 1"
    ).get(caller, chatId, `${chatId}|%`);
    return Boolean(row);
  } catch { return false; }
}

async function opSend(p, caller) {
  const channel = p.channel;
  const endpoint = p.endpoint ?? null;
  let content = p.content;   // reassigned below when an isolated caller's [MEDIA:] path is rewritten to the broker staging copy (REL-8)
  // Audit tag (e.g. 'status-notice' from c4-receive's unhealthy auto-reply) —
  // must survive the broker hop or getUnansweredDeliveredForInstance counts the
  // auto-reply as a real answer. Coerced to a short string; it only ever lands
  // in the delivery_action audit column, never in routing decisions.
  const deliveryAction = typeof p.deliveryAction === 'string' && p.deliveryAction
    ? p.deliveryAction.slice(0, 64)
    : null;
  const attachments = Array.isArray(p.attachments)
    ? p.attachments
    : (p.attachments ? [p.attachments] : []);

  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'content_required' };
  // CRITICAL-1: allowlist real messaging channels before anything else.
  if (!MESSAGING_CHANNELS.has(channel)) return { ok: false, error: `channel_not_allowed:${channel}` };
  try { validateChannel(channel, true); } catch (e) { return { ok: false, error: `invalid_channel:${e.message}` }; }
  if (endpoint != null) {
    try { validateEndpoint(endpoint); } catch (e) { return { ok: false, error: `invalid_endpoint:${e.message}` }; }
    // HIGH-1: bind the endpoint to the caller.
    if (!endpointAuthorized(channel, endpoint, caller)) {
      log(`ENDPOINT BLOCKED ${caller} -> ${channel}:${endpoint}`);
      return { ok: false, error: `endpoint_not_authorized: ${caller} may not send to that endpoint` };
    }
  }

  // Egress policy — the confused-deputy fix. Reject any source-tier path,
  // whether it arrives as an explicit attachment or a [MEDIA:...] prefix on
  // the message (the feishu send.js media convention). Note: the current
  // send.js path forwards only [MEDIA:] content, not `attachments` — the
  // attachments check is defense for a future channel that reads them (INFO-1).
  const roots = cachedSourceTierRoots();
  const mediaPath = mediaPathFromContent(content);
  const candidates = [...attachments.map(String), ...(mediaPath ? [mediaPath] : [])];
  // Trust classification MUST fail CLOSED (REL-8 rev-security HIGH). `caller` is
  // socket-bound at connect time; if its instances.json entry has since been
  // removed/renamed (decommission/rename — the socket + os_user linger up to
  // RESCAN_INTERVAL_MS or a SIGHUP), getInstanceDef returns undefined. Treating
  // that as a trusted PRIMARY would skip stageOwnedMedia and re-enable c4.db
  // egress. So: primary ONLY when positively proven (a def with no os_user);
  // an unresolved def is an untrusted tenant and routes through owner-staging
  // (whose caller_uid_unresolved path then denies). Preserves the exact os_user
  // semantics for known instances; only changes the undefined-def case.
  const callerDef = getInstanceDef(caller);
  const callerIsolated = !callerDef || !!callerDef.os_user;
  for (const c of candidates) {
    const v = checkPathViolation(c, roots);
    if (v) {
      log(`EGRESS BLOCKED ${caller}: ${v.path} (root ${v.root})`);
      return { ok: false, error: `egress_blocked: source-tier files are never sent through chat channels (${v.path})` };
    }
  }

  // Durable out-message audit row. target_instance = NULL (parity with c4-send):
  // scoping out-rows to the caller would replay the agent's own replies into its
  // SessionStart injection and inflate its unsummarized count (M3).
  let conversationId = null;
  try {
    const row = insertConversation('out', channel, endpoint, content, null, 3, false, deliveryAction, null);
    conversationId = row.id;
  } catch (e) {
    log(`WARN audit insert failed (${caller}): ${e.message}`);
  }

  // On any send failure, mark the audit row failed: the user never received
  // it, so it must not count as an answer for the unanswered-message re-surface
  // (and the audit trail stays truthful).
  const markAuditFailed = () => {
    if (conversationId == null) return;
    try { markFailed(conversationId); } catch (e) { log(`WARN audit markFailed(${conversationId}) failed: ${e.message}`); }
  };

  const channelScript = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');
  if (!fs.existsSync(channelScript)) {
    markAuditFailed();
    return { ok: false, error: `channel_script_missing:${channelScript}` };
  }

  // Attachment handling. The spawned send.js child inherits the broker's
  // uid/gid/supplementary groups and re-reads the [MEDIA:] path by name at a
  // LATER time than any check here, so a bare accessSync would be both (a)
  // insufficient (readable ≠ allowed: c4.db is world-readable) and (b) racy
  // (the child re-resolves a caller-mutable path). Two regimes:
  let stagingSubdir = null;
  if (mediaPath) {
    if (callerIsolated) {
      // REL-8: an isolated tenant may attach ONLY a file it owns. stageOwnedMedia
      // fstat-validates ownership on the OPEN fd (symlink-swap-proof) and hands
      // send.js the broker's own byte-copy, so peer/hub files (owned by another
      // uid) are structurally unreachable and the child never re-resolves the
      // original path. Fail-closed if the caller's uid can't be resolved.
      // A synchronous fs error (ensureStagingDir mkdir, or an unforeseen throw)
      // must NOT unwind opSend past markAuditFailed — otherwise the audit out-row
      // stays 'delivered' for a never-sent message and mis-counts as an answer
      // (rev crash-correctness MEDIUM). stageOwnedMedia itself already cleans its
      // own subdir and returns {ok:false} on write failure; this catch covers the
      // ensureStagingDir path and any residual throw.
      let staged;
      try {
        ensureStagingDir();
        const callerUid = resolveCallerUid(callerDef?.os_user);
        staged = stageOwnedMedia(mediaPath, callerUid, ATTACH_STAGING_DIR);
      } catch (err) {
        markAuditFailed();
        log(`ATTACHMENT STAGE ERROR ${caller}: ${err && err.message}`);
        return { ok: false, error: 'attachment_rejected: broker could not stage the file', data: { conversation_id: conversationId } };
      }
      if (!staged.ok) {
        markAuditFailed();
        log(`ATTACHMENT REJECTED ${caller}: ${staged.error} (path ${mediaPath}` +
          `${staged.owner != null ? `, owner uid ${staged.owner}` : ''}` +
          `${staged.size != null ? `, size ${staged.size}` : ''})`);
        // Generic, path/uid-free caller-facing reason (no cross-tenant layout or
        // ownership oracle); server log above keeps the detail for ops.
        const reason = staged.error === 'unreadable'
          ? `attachment_unreadable: broker cannot read the file; publish it under ~/zylos/workspace/users/${caller}/ and resend`
          : staged.error === 'not_owned_by_caller'
            ? `egress_blocked: you can only attach files you own — publish it under ~/zylos/workspace/users/${caller}/ and resend`
            : staged.error === 'too_large'
              ? 'attachment_too_large: file exceeds the send size limit'
              : staged.error === 'not_regular_file'
                ? 'attachment_invalid: not a regular file'
                : 'attachment_rejected: broker could not stage the file';
        return { ok: false, error: reason, data: { conversation_id: conversationId } };
      }
      stagingSubdir = staged.stagingSubdir;
      // Rewrite the [MEDIA:type] path to the broker-owned staging copy the child
      // will read (preserves the type token; the [\s\S] class handles multi-line).
      const m = content.match(/^(\[MEDIA:\w+\])[\s\S]+$/);
      if (m) content = `${m[1]}${staged.stagingPath}`;
    } else {
      // Primary/trusted caller (admin, scheduler): keep the up-front readability
      // gate so an unreadable path is rejected cleanly instead of crashing the
      // child's unguarded ReadStream. No ownership scoping — trusted above tenants.
      const resolved = path.resolve(mediaPath);
      try {
        fs.accessSync(resolved, fs.constants.R_OK);
      } catch {
        log(`ATTACHMENT UNREADABLE ${caller}: ${resolved}`);
        markAuditFailed();
        const shown = path.isAbsolute(mediaPath) ? resolved : mediaPath;
        return {
          ok: false,
          error: `attachment_unreadable: broker cannot read ${shown}; publish it under ~/zylos/workspace/users/${caller}/ and resend`,
          data: { conversation_id: conversationId },
        };
      }
    }
  }

  let code;
  try {
    code = await spawnSend(channelScript, endpoint, content);
  } finally {
    if (stagingSubdir) {
      try { fs.rmSync(stagingSubdir, { recursive: true, force: true }); }
      catch (e) { log(`WARN staging cleanup failed (${caller}): ${e.message}`); }
    }
  }
  if (code === 0) return { ok: true, data: { sent: true, conversation_id: conversationId, channel } };
  markAuditFailed();
  return { ok: false, error: `channel_send_failed:exit_${code}`, data: { conversation_id: conversationId } };
}

/**
 * Record-only 'void' channel (#689) for isolated agents. The void endpoint is a
 * topic label (e.g. 'session-handoff'), never a real chat, so it deliberately
 * skips MESSAGING_CHANNELS / endpointAuthorized / egress-policy — none apply to
 * a message that is never dispatched. Unlike real out-rows (NULL target_instance
 * to avoid replaying replies), the void row is SCOPED TO THE CALLER: its whole
 * purpose is to be read back by that same instance's next session-init.
 */
function opVoid(p, caller) {
  const endpoint = p.endpoint ?? null;
  const content = p.content;
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'content_required' };
  if (!endpoint) return { ok: false, error: 'endpoint_required' };
  try { validateEndpoint(endpoint); } catch (e) { return { ok: false, error: `invalid_endpoint:${e.message}` }; }
  try {
    const row = insertConversation('out', 'void', endpoint, content, null, 3, false, null, caller);
    return { ok: true, data: { recorded: true, conversation_id: row.id } };
  } catch (e) {
    log(`WARN void record failed (${caller}): ${e.message}`);
    return { ok: false, error: `void_record_failed:${e.message}` };
  }
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

/**
 * Scheduler surface for isolated agents (scheduler.db is service-user-only
 * post ISO-2 follow-up; agents lost the interim group-rw). Every action runs
 * the SAME task-ops the CLI uses, with scope forced to the socket-derived
 * caller — an agent can only see/ack/mutate its own tasks, `add` can only
 * target itself, and `update` cannot retarget (that would be a controlled
 * cross-instance message primitive we deliberately don't grant).
 * Domain outcomes ({ok:false,error:'not_found'|...}) are returned as data;
 * transport-level failures use the broker's ok:false envelope.
 */
// Per-instance guards on the agent-facing scheduler surface (availability).
const MAX_ACTIVE_TASKS_PER_INSTANCE = 200;
const MIN_INTERVAL_SECONDS = 60;

/**
 * A scheduled task's reply_channel/reply_endpoint are later handed to the
 * scheduler DAEMON (service user, root creds), which spawns
 * `<reply_channel>/scripts/send.js <reply_endpoint> ...` OUTSIDE the broker's
 * opSend guards — `shell/scripts/send.js` writes bytes to an arbitrary unix
 * socket, and channel sends bypass endpointAuthorized. So apply the SAME
 * CRITICAL-1 (channel allowlist) + HIGH-1 (endpoint bound to caller) controls
 * here, at ingestion. Returns an error string or null.
 */
function validateReplyTarget(obj, caller) {
  if (obj.reply_channel != null && !MESSAGING_CHANNELS.has(obj.reply_channel)) {
    return `reply_channel_not_allowed:${obj.reply_channel}`;
  }
  if (obj.reply_endpoint != null && !endpointAuthorized(obj.reply_channel, obj.reply_endpoint, caller)) {
    return 'reply_endpoint_not_authorized';
  }
  return null;
}

function opScheduler(p, caller) {
  // LOW-1: the entire tenant filter rests on a truthy scope — a falsy caller
  // would silently drop every `AND target_instance = ?`. Not reachable today
  // (caller is a socket-bound instance id) but make the invariant explicit.
  if (typeof caller !== 'string' || caller.length === 0) {
    return { ok: false, error: 'no_caller' };
  }

  const action = p.action;
  let sdb;
  try {
    sdb = getSchedulerDb();
  } catch (e) {
    return { ok: false, error: `scheduler_db_unavailable:${e.message}` };
  }

  const needsPrefix = new Set(['done', 'remove', 'pause', 'resume', 'update']);
  if (needsPrefix.has(action) && (typeof p.prefix !== 'string' || p.prefix.length === 0)) {
    return { ok: false, error: 'prefix_required' };
  }
  const scoped = { scope: caller };

  switch (action) {
    case 'list':    return { ok: true, data: taskOps.listTasks(sdb, scoped) };
    case 'next':    return { ok: true, data: taskOps.nextTasks(sdb, scoped) };
    case 'running': return { ok: true, data: taskOps.runningTasks(sdb, scoped) };
    case 'history': return { ok: true, data: taskOps.taskHistory(sdb, { scope: caller, prefix: typeof p.prefix === 'string' && p.prefix ? p.prefix : null }) };
    case 'done':    return { ok: true, data: taskOps.completeTask(sdb, p.prefix, scoped) };
    case 'remove':  return { ok: true, data: taskOps.removeTask(sdb, p.prefix, scoped) };
    case 'pause':   return { ok: true, data: taskOps.pauseTask(sdb, p.prefix, scoped) };
    case 'resume':  return { ok: true, data: taskOps.resumeTask(sdb, p.prefix, scoped) };
    case 'update': {
      const updates = (p.updates && typeof p.updates === 'object' && !Array.isArray(p.updates)) ? p.updates : {};
      const replyErr = validateReplyTarget(updates, caller);
      if (replyErr) return { ok: false, error: replyErr };
      return { ok: true, data: taskOps.applyTaskUpdates(sdb, p.prefix, updates, { scope: caller, allowRetarget: false }) };
    }
    case 'add': {
      const spec = (p.spec && typeof p.spec === 'object' && !Array.isArray(p.spec)) ? { ...p.spec } : null;
      if (!spec || typeof spec.prompt !== 'string' || spec.prompt.length === 0) {
        return { ok: false, error: 'spec_required' };
      }
      // HIGH-1: gate the daemon-executed reply target (channel allowlist +
      // endpoint bound to caller) at ingestion.
      const replyErr = validateReplyTarget(spec, caller);
      if (replyErr) return { ok: false, error: replyErr };
      // MEDIUM-1: per-instance active-task cap (shared daemon + shared disk).
      if (taskOps.countActiveTasks(sdb, scoped) >= MAX_ACTIVE_TASKS_PER_INSTANCE) {
        return { ok: false, error: `task_cap_reached:${MAX_ACTIVE_TASKS_PER_INSTANCE}` };
      }
      // MEDIUM-1: floor sub-minute intervals (constant daemon churn).
      if (spec.type === 'interval' && Number(spec.interval_seconds) < MIN_INTERVAL_SECONDS) {
        return { ok: false, error: `interval_too_small:min=${MIN_INTERVAL_SECONDS}s` };
      }
      // Server-side authority: id, timestamps, and above all the target.
      const t = taskNow();
      spec.id = generateTaskId();
      spec.created_at = t;
      spec.updated_at = t;
      spec.target_instance = caller;
      // next_run_at has no CHECK constraint; a non-numeric value would store
      // as text and never dispatch (self-DoS via raw socket payload) — coerce
      // and reject instead of persisting junk.
      spec.next_run_at = Number(spec.next_run_at);
      if (!Number.isFinite(spec.next_run_at) || spec.next_run_at < 0) {
        return { ok: false, error: 'invalid_spec:next_run_at must be a unix timestamp' };
      }
      try {
        return { ok: true, data: taskOps.insertTask(sdb, spec) };
      } catch (e) {
        // DB CHECK constraints are the validation backstop (type/priority/status).
        return { ok: false, error: `invalid_spec:${e.message}` };
      }
    }
    default: return { ok: false, error: `unknown_scheduler_action:${action ?? '(none)'}` };
  }
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
