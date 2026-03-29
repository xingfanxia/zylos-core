#!/usr/bin/env node
/**
 * Web Console Server with WebSocket
 * Provides HTTP API + WebSocket for real-time browser-based Claude communication
 *
 * Run with PM2: pm2 start server.js --name web-console
 * Default port: 3456
 */

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn, execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Health dashboard for system-wide data aggregation
import { getSystemHealth } from '../../activity-monitor/scripts/health-dashboard.js';

// Instance router for multi-session management
import {
  updateInstancesConfig,
  getInstanceDef,
  getStatusFileForInstance,
  startWatcher,
} from '../../comm-bridge/scripts/c4-instance-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.WEB_CONSOLE_PORT || 3456;

// Paths
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = path.join(os.homedir(), 'zylos', '.claude', 'skills');
const DB_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const DB_PATH = path.join(DB_DIR, 'c4.db');
const STATUS_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');

// Paths - __dirname is scripts/, public/ is one level up
const SKILL_ROOT = path.join(__dirname, '..');

// --- Authentication ---
import { parse as parseDotenv } from 'dotenv';

function readEnvPassword() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    const env = parseDotenv(fs.readFileSync(envPath, 'utf8'));
    return env.ZYLOS_WEB_PASSWORD || env.WEB_CONSOLE_PASSWORD || '';
  } catch {
    return '';
  }
}

const AUTH_PASSWORD = readEnvPassword();
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const sessions = new Set(); // Active session tokens

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.wc_session && sessions.has(cookies.wc_session);
}

function authMiddleware(req, res, next) {
  // Auth endpoints are always accessible
  if (req.path === '/auth') return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Middleware
app.use(express.json());

// Root redirect to dashboard
app.get('/', (req, res) => res.redirect('/dashboard/'));

app.use(express.static(path.join(SKILL_ROOT, 'public')));
app.use('/api', authMiddleware);

// Initialize database connection
let db;
try {
  // Verify database file exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    console.error('Make sure comm-bridge is initialized first (run c4-db.js init)');
    process.exit(1);
  }

  db = new Database(DB_PATH, { readonly: false });

  // Verify schema exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get();
  if (!tableCheck) {
    console.error('Database schema not initialized');
    console.error('Run: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js init');
    process.exit(1);
  }
} catch (err) {
  console.error(`Failed to open database: ${err.message}`);
  console.error('Make sure comm-bridge is initialized first');
  process.exit(1);
}

// Track connected WebSocket clients
const clients = new Set();

// Last known state for change detection
let lastStatus = null;
let lastMessageId = 0;

/**
 * Read current Claude status
 */
function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
    return { state: 'unknown', message: 'Status file not found' };
  } catch (err) {
    return { state: 'error', message: err.message };
  }
}

/**
 * Strip internal routing info from message content for display
 */
function stripReplyVia(content) {
  // Remove "---- reply via: ..." suffix
  const idx = content.indexOf(' ---- reply via:');
  if (idx !== -1) {
    return content.substring(0, idx);
  }
  return content;
}

/**
 * Clean message for display (strip internal routing info)
 */
function cleanMessageForDisplay(msg) {
  return {
    ...msg,
    content: stripReplyVia(msg.content)
  };
}

/**
 * Get new messages since given ID
 */
function getNewMessages(sinceId) {
  try {
    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console' AND id > ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(sinceId).map(cleanMessageForDisplay);
  } catch (err) {
    return [];
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

/**
 * Check for status changes and new messages
 */
function checkUpdates() {
  // Check status changes
  const currentStatus = readStatus();
  if (!lastStatus || currentStatus.state !== lastStatus.state) {
    lastStatus = currentStatus;
    broadcast('status', currentStatus);
  }

  // Check for new messages
  const newMessages = getNewMessages(lastMessageId);
  if (newMessages.length > 0) {
    lastMessageId = Math.max(...newMessages.map(m => m.id));
    broadcast('messages', newMessages);
  }
}

// Start update checker (every 500ms for responsiveness)
setInterval(checkUpdates, 500);

// Initialize lastMessageId
try {
  const stmt = db.prepare(`SELECT MAX(id) as maxId FROM conversations WHERE channel = 'web-console'`);
  const result = stmt.get();
  lastMessageId = result?.maxId || 0;
} catch (err) {
  // Ignore
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  // Check auth for WebSocket connections
  if (AUTH_ENABLED) {
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.wc_session || !sessions.has(cookies.wc_session)) {
      ws.close(4001, 'Authentication required');
      return;
    }
  }

  clients.add(ws);
  console.log(`WebSocket client connected (${clients.size} total)`);

  // Send current status immediately
  const status = readStatus();
  ws.send(JSON.stringify({ type: 'status', data: status }));

  // Handle client messages
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'send' && msg.content) {
        // Send message to Claude
        const c4Receive = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');
        const tempId = msg.tempId; // Track client's temp ID

        const child = spawn('node', [
          c4Receive,
          '--channel', 'web-console',
          '--endpoint', 'console',
          '--content', msg.content.trim()
        ], { stdio: 'pipe' });

        child.on('close', (code) => {
          if (code === 0) {
            ws.send(JSON.stringify({ type: 'sent', success: true, tempId }));
          } else {
            ws.send(JSON.stringify({ type: 'sent', success: false, error: 'Failed to send', tempId }));
          }
        });

        child.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'sent', success: false, error: err.message, tempId }));
        });
      }
    } catch (err) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected (${clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(ws);
  });
});

/**
 * Get Claude status (HTTP fallback)
 */
app.get('/api/status', (req, res) => {
  res.json(readStatus());
});

/**
 * Get conversation history
 */
app.get('/api/conversations', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const channel = req.query.channel || 'web-console';

    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(channel, limit);
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all recent conversations (for display)
 */
app.get('/api/conversations/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console'
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(limit).map(cleanMessageForDisplay);
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send message to Claude (HTTP fallback)
 */
app.post('/api/send', (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const c4Receive = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-receive.js');

  const child = spawn('node', [
    c4Receive,
    '--channel', 'web-console',
    '--endpoint', 'console',
    '--content', message.trim()
  ], {
    stdio: 'pipe'
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    if (code === 0) {
      res.json({ success: true, message: 'Message sent to Claude' });
    } else {
      res.status(500).json({
        success: false,
        error: stderr || 'Failed to send message',
        code
      });
    }
  });

  child.on('error', (err) => {
    res.status(500).json({ success: false, error: err.message });
  });
});

/**
 * Poll for new messages since given ID (HTTP fallback)
 */
app.get('/api/poll', (req, res) => {
  try {
    const sinceId = parseInt(req.query.since_id) || 0;
    res.json(getNewMessages(sinceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check auth status
 */
app.get('/api/auth', (req, res) => {
  res.json({
    required: AUTH_ENABLED,
    authenticated: isAuthenticated(req)
  });
});

/**
 * Login
 */
app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ success: true });
  }

  const { password } = req.body;
  if (password !== AUTH_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Wrong password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `wc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ success: true });
});

/**
 * Logout
 */
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.wc_session) sessions.delete(cookies.wc_session);
  res.setHeader('Set-Cookie', 'wc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    websocket_clients: clients.size
  });
});

// ---------------------------------------------------------------------------
// Dashboard API routes
// ---------------------------------------------------------------------------

// Start instance config watcher for hot-reload (long-running process)
startWatcher();

/**
 * Dashboard: full system health snapshot
 */
app.get('/api/dashboard', (req, res) => {
  try {
    const health = getSystemHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Token usage: per-instance daily breakdown for the last N days
 */
app.get('/api/dashboard/tokens', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);

  const TOKEN_DB_PATH = path.join(ZYLOS_DIR, 'activity-monitor', 'token-usage.db');

  // Open token DB readonly — resolve better-sqlite3 from sibling skills
  let tokenDb = null;
  try {
    if (!fs.existsSync(TOKEN_DB_PATH)) {
      return res.json({ daily: [], per_instance: [], totals: null });
    }

    // Resolve better-sqlite3 — try multiple paths
    let DbCtor = null;
    const candidates = [
      path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge'),
      path.join(ZYLOS_DIR, '.claude', 'skills', 'scheduler'),
      path.join(__dirname, '..', '..', 'comm-bridge'),
      path.join(__dirname, '..', '..', 'scheduler'),
    ];
    for (const base of candidates) {
      try {
        const require = createRequire(path.join(base, 'package.json'));
        DbCtor = require('better-sqlite3');
        break;
      } catch { /* try next */ }
    }

    // Fall back to the already-imported Database constructor
    if (!DbCtor) DbCtor = Database;

    tokenDb = new DbCtor(TOKEN_DB_PATH, { readonly: true });

    // Daily per-instance breakdown
    const daily = tokenDb.prepare(`
      SELECT date, instance_id,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      WHERE date > date('now', ? || ' days')
      GROUP BY date, instance_id
      ORDER BY date DESC, instance_id
    `).all(`-${days}`);

    // Per-instance totals for the period
    const per_instance = tokenDb.prepare(`
      SELECT instance_id,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      WHERE date > date('now', ? || ' days')
      GROUP BY instance_id
      ORDER BY instance_id
    `).all(`-${days}`);

    // Grand totals
    const totals = tokenDb.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM token_usage
      WHERE date > date('now', ? || ' days')
    `).get(`-${days}`);

    res.json({ daily, per_instance, totals, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (tokenDb) {
      try { tokenDb.close(); } catch { /* best-effort */ }
    }
  }
});

// ---------------------------------------------------------------------------
// Instance action helpers
// ---------------------------------------------------------------------------

function resolveTilde(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function tmuxSessionExists(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Instance action endpoints
// ---------------------------------------------------------------------------

/**
 * Enable an instance
 */
app.post('/api/dashboard/instances/:id/enable', (req, res) => {
  const { id } = req.params;
  try {
    const inst = getInstanceDef(id);
    if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });

    updateInstancesConfig((cfg) => {
      if (!cfg) return null;
      cfg.instances[id] = { ...cfg.instances[id], enabled: true };
      return cfg;
    });

    res.json({ ok: true, id, enabled: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Disable an instance (cannot disable primary)
 */
app.post('/api/dashboard/instances/:id/disable', (req, res) => {
  const { id } = req.params;
  try {
    const inst = getInstanceDef(id);
    if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });
    if (inst.primary) return res.status(400).json({ error: `Cannot disable primary instance "${id}"` });

    updateInstancesConfig((cfg) => {
      if (!cfg) return null;
      cfg.instances[id] = { ...cfg.instances[id], enabled: false };
      return cfg;
    });

    res.json({ ok: true, id, enabled: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Suspend an instance (kill tmux session, write suspended status)
 */
app.post('/api/dashboard/instances/:id/suspend', (req, res) => {
  const { id } = req.params;
  try {
    const inst = getInstanceDef(id);
    if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });
    if (inst.primary) return res.status(400).json({ error: `Cannot suspend primary instance "${id}"` });

    const tmuxSession = inst.tmux_session || `claude-${id}`;
    if (!tmuxSessionExists(tmuxSession)) {
      return res.status(400).json({ error: `Instance "${id}" is not running (tmux session not found)` });
    }

    // Kill tmux session
    try {
      execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'pipe', timeout: 15000 });
    } catch (err) {
      return res.status(500).json({ error: `Failed to kill tmux session: ${err.message}` });
    }

    // Write suspended status
    const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    const statusFile = path.join(stateDir, 'claude-status.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'suspended',
      suspended_at: Date.now(),
      suspended_by: 'dashboard',
      last_check_human: new Date().toISOString(),
    }, null, 2) + '\n');

    res.json({ ok: true, id, status: 'suspended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resume a suspended instance (create tmux session, clear suspended status)
 */
app.post('/api/dashboard/instances/:id/resume', (req, res) => {
  const { id } = req.params;
  try {
    const inst = getInstanceDef(id);
    if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });

    const tmuxSession = inst.tmux_session || `claude-${id}`;

    // Check it's suspended (read status file)
    const statusFile = getStatusFileForInstance(id);
    if (statusFile && fs.existsSync(statusFile)) {
      try {
        const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (statusData.state !== 'suspended') {
          return res.status(400).json({ error: `Instance "${id}" is not suspended (status: ${statusData.state})` });
        }
      } catch { /* proceed anyway */ }
    }

    if (tmuxSessionExists(tmuxSession)) {
      return res.status(400).json({ error: `tmux session "${tmuxSession}" already exists` });
    }

    // Launch Claude Code in new tmux session
    const configDir = inst.config_dir ? resolveTilde(inst.config_dir) : null;
    const runtime = inst.runtime || 'claude';
    const tmuxArgs = ['new-session', '-d', '-s', tmuxSession, '-x', '220', '-y', '50'];
    if (configDir) tmuxArgs.push('-e', `CLAUDE_CONFIG_DIR=${configDir}`);
    tmuxArgs.push(runtime);

    try {
      execFileSync('tmux', tmuxArgs, { stdio: 'pipe', timeout: 15000 });
    } catch (err) {
      return res.status(500).json({ error: `Failed to create tmux session: ${err.message}` });
    }

    // Clear suspended status
    const stateDir = resolveTilde(inst.state_dir) || path.join(ZYLOS_DIR, 'activity-monitor', id);
    const stateStatusFile = path.join(stateDir, 'claude-status.json');
    try {
      fs.writeFileSync(stateStatusFile, JSON.stringify({
        state: 'idle',
        resumed_at: Date.now(),
        resumed_by: 'dashboard',
        last_check_human: new Date().toISOString(),
      }, null, 2) + '\n');
    } catch { /* best-effort */ }

    res.json({ ok: true, id, status: 'resumed', session: tmuxSession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Approval flow: pending users + approve/deny actions
// ---------------------------------------------------------------------------

// GET /api/dashboard/pending-users — list users awaiting approval
// Source of truth: DB (pending_approval messages), NOT the tracking file
app.get('/api/dashboard/pending-users', (req, res) => {
  try {
    // Query distinct chat_ids with pending_approval messages directly from DB
    const rows = db.prepare(`
      SELECT endpoint_id, channel, content, MIN(id) as first_id, COUNT(*) as msg_count
      FROM conversations
      WHERE status = 'pending_approval' AND direction = 'in'
      GROUP BY substr(endpoint_id, 1, instr(endpoint_id || '|', '|') - 1)
      ORDER BY first_id ASC
    `).all();

    const pending = rows.map(row => {
      const chatId = row.endpoint_id?.split('|')[0] || '';

      // Extract user name and preview from message content
      let userName = '';
      let preview = '';
      if (row.content) {
        const nameMatch = row.content.match(/\]\s+(.+?)\s+said:/);
        if (nameMatch) userName = nameMatch[1];
        const contentMatch = row.content.match(/<current-message>\n([\s\S]*?)\n<\/current-message>/);
        preview = contentMatch ? contentMatch[1].substring(0, 200) : '';
      }

      // Generate suggested_id from name
      const asciiName = userName ? userName.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      const suggestedId = asciiName
        ? `user-${asciiName.substring(0, 20)}`
        : `user-${chatId.slice(-8)}`;

      return {
        channel: row.channel,
        chat_id: chatId,
        sender_name: userName,
        suggested_id: suggestedId,
        msg_count: row.msg_count,
        preview,
      };
    });

    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/approve/:chatId — approve a pending user
app.post('/api/dashboard/approve/:chatId', (req, res) => {
  const { chatId } = req.params;
  const instanceName = req.body?.name || `user-${chatId.substring(0, 12)}`;
  try {
    const approveScript = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-approve.js');
    const result = execFileSync('node', [approveScript, 'approve', chatId, '--name', instanceName], {
      encoding: 'utf8', timeout: 60000, stdio: 'pipe'
    });
    res.json({ ok: true, instance: instanceName, output: result.trim() });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    res.status(500).json({ error: stderr });
  }
});

// POST /api/dashboard/deny/:chatId — deny a pending user
app.post('/api/dashboard/deny/:chatId', (req, res) => {
  const { chatId } = req.params;
  try {
    const approveScript = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-approve.js');
    const result = execFileSync('node', [approveScript, 'deny', chatId], {
      encoding: 'utf8', timeout: 30000, stdio: 'pipe'
    });
    res.json({ ok: true, output: result.trim() });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    res.status(500).json({ error: stderr });
  }
});

// ---------------------------------------------------------------------------
// Serve dashboard static files
// ---------------------------------------------------------------------------
app.use('/dashboard', express.static(path.join(SKILL_ROOT, 'public', 'dashboard')));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(SKILL_ROOT, 'public', 'index.html'));
});

// Start server (bind to localhost only for security)
const BIND_HOST = process.env.WEB_CONSOLE_BIND || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`Web Console server running on http://${BIND_HOST}:${PORT}`);
  console.log(`Dashboard available at http://${BIND_HOST}:${PORT}/dashboard`);
  console.log(`WebSocket available at ws://${BIND_HOST}:${PORT}`);
  console.log(`Authentication: ${AUTH_ENABLED ? 'enabled' : 'disabled (no password set)'}`);
  console.log(`Database: ${DB_PATH}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close();
  if (db) db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  wss.close();
  if (db) db.close();
  process.exit(0);
});
