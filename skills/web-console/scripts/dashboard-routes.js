/**
 * Dashboard Routes — extracted from server.js v1 additions.
 *
 * Registers all /dashboard and /api/dashboard/* routes on the given Express app.
 * Auth is inherited from server.js's authMiddleware applied to /api/*.
 *
 * @module dashboard-routes
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

// Peer imports — resolved relative to skills/ tree
import { getSystemHealth } from '../../activity-monitor/scripts/health-dashboard.js';
import {
  updateInstancesConfig,
  getInstanceDef,
  getStatusFileForInstance,
  startWatcher,
} from '../../comm-bridge/scripts/c4-instance-router.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the current user's home directory.
 * @param {string} p - file path
 * @returns {string}
 */
function resolveTilde(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

/**
 * Check whether a tmux session with the given name exists.
 * @param {string} session - tmux session name
 * @returns {boolean}
 */
function tmuxSessionExists(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Register all dashboard-related routes on the Express app.
 *
 * @param {import('express').Express} app - Express application
 * @param {object} options
 * @param {string} options.zylosDir - path to ~/zylos runtime data directory
 * @param {string} options.skillRoot - path to web-console skill root (parent of scripts/)
 * @param {string} options.skillsDir - path to skills directory (e.g. ~/zylos/.claude/skills)
 */
export function registerDashboardRoutes(app, { zylosDir, skillRoot, skillsDir }) {
  // Start instance config watcher for hot-reload
  startWatcher();

  // ----- Root redirect -----
  app.get('/', (req, res) => res.redirect('/dashboard/'));

  // ----- System health snapshot -----
  app.get('/api/dashboard', (req, res) => {
    try {
      const health = getSystemHealth();
      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ----- Token usage (reads cached ccusage output) -----
  app.get('/api/dashboard/tokens', (req, res) => {
    // ccusage is too slow for real-time (6K+ JSONL files). Read from a cached
    // JSON file that's updated hourly by a scheduled task:
    //   ccusage daily --json --since YYYYMMDD > ~/zylos/activity-monitor/token-cache.json
    const cacheFile = path.join(zylosDir, 'activity-monitor', 'token-cache.json');
    try {
      if (!fs.existsSync(cacheFile)) {
        return res.json({ daily: [], totals: null, error: 'No token data yet (run: ccusage daily --json > token-cache.json)' });
      }
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const cacheAge = Math.floor((Date.now() - fs.statSync(cacheFile).mtimeMs) / 60000);
      res.json({ ...cached, cache_age_minutes: cacheAge });
    } catch (err) {
      res.json({ daily: [], totals: null, error: err.message });
    }
  });

  // -------------------------------------------------------------------
  // Instance action endpoints
  // -------------------------------------------------------------------

  /** Enable an instance */
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

  /** Disable an instance (cannot disable primary) */
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

  /** Suspend an instance (kill tmux session, write suspended status) */
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
      const stateDir = resolveTilde(inst.state_dir) || path.join(zylosDir, 'activity-monitor', id);
      const statusFile = path.join(stateDir, 'agent-status.json');
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

  /** Resume a suspended instance (create tmux session, clear suspended status) */
  app.post('/api/dashboard/instances/:id/resume', (req, res) => {
    const { id } = req.params;
    try {
      const inst = getInstanceDef(id);
      if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });

      const tmuxSession = inst.tmux_session || `claude-${id}`;

      // Verify instance is actually suspended
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
      const stateDir = resolveTilde(inst.state_dir) || path.join(zylosDir, 'activity-monitor', id);
      const stateStatusFile = path.join(stateDir, 'agent-status.json');
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

  // -------------------------------------------------------------------
  // Approval flow: pending users + approve/deny actions
  // -------------------------------------------------------------------

  /** List users awaiting approval */
  app.get('/api/dashboard/pending-users', (req, res) => {
    try {
      // Open the comm-bridge DB readonly for the query
      const DB_PATH = path.join(zylosDir, 'comm-bridge', 'c4.db');
      if (!fs.existsSync(DB_PATH)) {
        return res.json({ pending: [] });
      }
      const db = new Database(DB_PATH, { readonly: true });

      try {
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
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Approve a pending user */
  app.post('/api/dashboard/approve/:chatId', (req, res) => {
    const { chatId } = req.params;
    const instanceName = req.body?.name || `user-${chatId.substring(0, 12)}`;
    try {
      const approveScript = path.join(skillsDir, 'comm-bridge', 'scripts', 'c4-approve.js');
      const result = execFileSync('node', [approveScript, 'approve', chatId, '--name', instanceName], {
        encoding: 'utf8', timeout: 60000, stdio: 'pipe',
      });
      res.json({ ok: true, instance: instanceName, output: result.trim() });
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      res.status(500).json({ error: stderr });
    }
  });

  /** Deny a pending user */
  app.post('/api/dashboard/deny/:chatId', (req, res) => {
    const { chatId } = req.params;
    try {
      const approveScript = path.join(skillsDir, 'comm-bridge', 'scripts', 'c4-approve.js');
      const result = execFileSync('node', [approveScript, 'deny', chatId], {
        encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      });
      res.json({ ok: true, output: result.trim() });
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      res.status(500).json({ error: stderr });
    }
  });

  // ----- Dashboard static files -----
  app.use('/dashboard', express.static(path.join(skillRoot, 'public', 'dashboard')));
}
