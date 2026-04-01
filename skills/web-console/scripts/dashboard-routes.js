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
import { execFileSync, execSync } from 'child_process';
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
import {
  annotateTokenCacheWithRuntimes,
  buildContextWindows,
  buildInstanceTokenBurnMap,
  buildLastContextHandoffs,
  buildUsageWindows,
  buildRuntimeUsage,
  enrichInstancesForDashboard,
  loadInstancesConfig,
  readProviderUsage,
} from './dashboard-data.js';

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

  const CONFIG_FILE = path.join(zylosDir, '.zylos', 'config.json');
  const ACTIVITY_MONITOR_SCRIPT = path.join(skillsDir, 'activity-monitor', 'scripts', 'activity-monitor.js');
  const SUPPORTED_RUNTIMES = new Set(['claude', 'codex']);
  const ZYLOS_PACKAGE_ROOT = (() => {
    if (process.env.ZYLOS_PACKAGE_ROOT) return process.env.ZYLOS_PACKAGE_ROOT;
    try {
      const zylosBin = execFileSync('bash', ['-lc', 'command -v zylos 2>/dev/null || true'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      }).trim();
      if (!zylosBin) return '';
      const realPath = fs.realpathSync(zylosBin);
      return path.dirname(path.dirname(realPath));
    } catch {
      return '';
    }
  })();

  function normalizeRuntime(raw) {
    const runtime = String(raw || '').trim().toLowerCase();
    return SUPPORTED_RUNTIMES.has(runtime) ? runtime : null;
  }

  function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmpPath, filePath);
  }

  function updateGlobalRuntime(runtime) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* empty config */ }
    cfg.runtime = runtime;
    writeJsonAtomic(CONFIG_FILE, cfg);
  }

  function getPm2ProcessStatus(name) {
    try {
      const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
      const list = JSON.parse(raw);
      const proc = list.find((entry) => entry.name === name);
      return proc?.pm2_env?.status || null;
    } catch {
      return null;
    }
  }

  function requestWake(instanceId, inst) {
    const stateDir = resolveTilde(inst?.state_dir) || path.join(zylosDir, 'activity-monitor', instanceId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'wake-signal'), new Date().toISOString());
  }

  function readStatusSnapshot(instanceId) {
    const statusFile = getStatusFileForInstance(instanceId);
    if (!statusFile || !fs.existsSync(statusFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function killTmuxSessionIfExists(session) {
    if (!session || !tmuxSessionExists(session)) return false;
    execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe', timeout: 15000 });
    return true;
  }

  function ensureInstanceMonitorRunning(instanceId, inst) {
    const pm2Name = `activity-monitor-${instanceId}`;
    const currentStatus = getPm2ProcessStatus(pm2Name);
    const env = {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      ZYLOS_INSTANCE_ID: instanceId,
      ZYLOS_TMUX_SESSION: inst.tmux_session || `claude-${instanceId}`,
      ...(ZYLOS_PACKAGE_ROOT ? { ZYLOS_PACKAGE_ROOT } : {}),
    };

    if (currentStatus === 'online' || currentStatus === 'launching') {
      execFileSync('pm2', ['restart', pm2Name], { stdio: 'pipe', timeout: 30000, env });
      return 'restarted';
    }

    execFileSync('pm2', [
      'start',
      ACTIVITY_MONITOR_SCRIPT,
      '--name',
      pm2Name,
      '--restart-delay',
      '5000',
      '--max-restarts',
      '10',
    ], { stdio: 'pipe', timeout: 30000, env });
    execFileSync('pm2', ['save'], { stdio: 'pipe', timeout: 15000, env });
    return 'started';
  }

  // ----- Root redirect -----
  app.get('/', (req, res) => res.redirect('/dashboard/'));

  // ----- System health snapshot -----
  app.get('/api/dashboard', (req, res) => {
    try {
      const health = getSystemHealth();
      const instancesConfig = loadInstancesConfig(zylosDir);

      // Enrich with per-instance conversation counts
      const DB_PATH = path.join(zylosDir, 'comm-bridge', 'c4.db');
      if (fs.existsSync(DB_PATH)) {
        try {
          const db = new Database(DB_PATH, { readonly: true });
          const counts = db.prepare(`
            SELECT target_instance, COUNT(*) as total,
              SUM(CASE WHEN date(timestamp) = date('now') THEN 1 ELSE 0 END) as today
            FROM conversations WHERE direction = 'in' AND status = 'delivered'
            GROUP BY target_instance
          `).all();
          db.close();

          const convMap = {};
          for (const row of counts) {
            convMap[row.target_instance || 'admin'] = { total: row.total, today: row.today };
          }
          // Merge null target into admin
          if (convMap['null']) {
            convMap['admin'] = convMap['admin'] || { total: 0, today: 0 };
            convMap['admin'].total += convMap['null'].total;
            convMap['admin'].today += convMap['null'].today;
            delete convMap['null'];
          }
          health.conversation_counts = convMap;
        } catch { /* best-effort */ }
      }

      health.usage_windows = buildUsageWindows(instancesConfig, zylosDir);
      health.context_windows = buildContextWindows(instancesConfig, zylosDir);
      health.last_context_handoffs = buildLastContextHandoffs(instancesConfig, zylosDir);
      health.provider_usage = readProviderUsage(zylosDir);
      health.runtime_usage = buildRuntimeUsage({
        instancesConfig,
        usageWindows: health.usage_windows,
        providerUsage: health.provider_usage,
      });

      const cacheFile = path.join(zylosDir, 'activity-monitor', 'token-cache.json');
      let enrichedTokenCache = null;
      if (fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          enrichedTokenCache = annotateTokenCacheWithRuntimes(cached, instancesConfig);
          health.token_burn = buildInstanceTokenBurnMap(enrichedTokenCache);
        } catch {
          health.token_burn = {};
        }
      } else {
        health.token_burn = {};
      }

      health.instances = enrichInstancesForDashboard(health.instances, {
        tokenCache: enrichedTokenCache,
        contextWindows: health.context_windows,
        lastContextHandoffs: health.last_context_handoffs,
      });

      res.json(health);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ----- Token usage (reads cached ccusage output) -----
  // Cache updated by: node skills/activity-monitor/scripts/update-token-cache.js
  app.get('/api/dashboard/tokens', (req, res) => {
    const cacheFile = path.join(zylosDir, 'activity-monitor', 'token-cache.json');
    try {
      if (!fs.existsSync(cacheFile)) {
        return res.json({ daily: [], totals: null, instances: {}, error: 'No token data yet (run: node update-token-cache.js)' });
      }
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const instancesConfig = loadInstancesConfig(zylosDir);
      const enriched = annotateTokenCacheWithRuntimes(cached, instancesConfig);
      const cacheAge = Math.floor((Date.now() - fs.statSync(cacheFile).mtimeMs) / 60000);
      res.json({ ...enriched, cache_age_minutes: cacheAge });
    } catch (err) {
      res.json({ daily: [], totals: null, instances: {}, error: err.message });
    }
  });

  // ----- Per-instance token usage -----
  app.get('/api/dashboard/tokens/:instanceId', (req, res) => {
    const cacheFile = path.join(zylosDir, 'activity-monitor', 'token-cache.json');
    try {
      if (!fs.existsSync(cacheFile)) {
        return res.json({ daily: [], totals: null, error: 'No token data yet' });
      }
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const instancesConfig = loadInstancesConfig(zylosDir);
      const enriched = annotateTokenCacheWithRuntimes(cached, instancesConfig);
      const instanceData = enriched.instances?.[req.params.instanceId];
      if (!instanceData) {
        return res.json({ daily: [], totals: null, error: `No data for instance "${req.params.instanceId}"` });
      }
      const cacheAge = Math.floor((Date.now() - fs.statSync(cacheFile).mtimeMs) / 60000);
      res.json({ ...instanceData, cache_age_minutes: cacheAge });
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

      const pm2Action = ensureInstanceMonitorRunning(id, inst);
      requestWake(id, inst);

      res.json({ ok: true, id, status: 'resume_requested', session: tmuxSession, pm2_action: pm2Action });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Change the runtime for a single instance */
  app.post('/api/dashboard/instances/:id/runtime', (req, res) => {
    const { id } = req.params;
    const runtime = normalizeRuntime(req.body?.runtime);
    if (!runtime) {
      return res.status(400).json({ error: 'runtime is required and must be "claude" or "codex"' });
    }

    try {
      const inst = getInstanceDef(id);
      if (!inst) return res.status(404).json({ error: `Instance "${id}" not found` });

      const currentRuntime = inst.runtime || 'claude';
      if (currentRuntime === runtime) {
        return res.json({ ok: true, id, runtime, changed: false });
      }

      updateInstancesConfig((cfg) => {
        if (!cfg) return null;
        cfg.instances[id] = { ...cfg.instances[id], runtime };
        return cfg;
      });

      const updatedInst = getInstanceDef(id) || { ...inst, runtime };
      const status = readStatusSnapshot(id);
      const isSuspended = status?.state === 'suspended';
      const tmuxSession = updatedInst.tmux_session || `claude-${id}`;

      try { killTmuxSessionIfExists(tmuxSession); } catch { /* best effort */ }

      let pm2Action = 'skipped';
      if (updatedInst.enabled !== false) {
        pm2Action = ensureInstanceMonitorRunning(id, updatedInst);
      }

      res.json({
        ok: true,
        id,
        runtime,
        changed: true,
        suspended: isSuspended,
        pm2_action: pm2Action,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Change the runtime for all configured instances and update the global default runtime */
  app.post('/api/dashboard/runtime/switch-all', (req, res) => {
    const runtime = normalizeRuntime(req.body?.runtime);
    if (!runtime) {
      return res.status(400).json({ error: 'runtime is required and must be "claude" or "codex"' });
    }

    try {
      const updates = [];
      updateInstancesConfig((cfg) => {
        if (!cfg) return null;
        for (const [id, inst] of Object.entries(cfg.instances || {})) {
          cfg.instances[id] = { ...inst, runtime };
          updates.push(id);
        }
        return cfg;
      });
      updateGlobalRuntime(runtime);

      const results = [];
      for (const id of updates) {
        const inst = getInstanceDef(id);
        if (!inst) continue;

        const status = readStatusSnapshot(id);
        const isSuspended = status?.state === 'suspended';
        const tmuxSession = inst.tmux_session || `claude-${id}`;

        try { killTmuxSessionIfExists(tmuxSession); } catch { /* best effort */ }

        let pm2Action = 'skipped';
        if (inst.enabled !== false) {
          pm2Action = ensureInstanceMonitorRunning(id, inst);
        }

        results.push({
          id,
          runtime,
          suspended: isSuspended,
          pm2_action: pm2Action,
        });
      }

      res.json({ ok: true, runtime, updated: results.length, results });
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

  // -------------------------------------------------------------------
  // Scheduler: task list + calendar data
  // -------------------------------------------------------------------

  app.get('/api/dashboard/scheduler', (req, res) => {
    const DB_PATH = path.join(zylosDir, 'scheduler', 'scheduler.db');
    if (!fs.existsSync(DB_PATH)) {
      return res.json({ tasks: [], calendar: [] });
    }
    try {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const tasks = db.prepare(`
          SELECT id, name, type, status, priority, cron_expression, interval_seconds,
                 next_run_at, last_run_at, target_instance, created_at, updated_at,
                 substr(prompt, 1, 120) as prompt_preview
          FROM tasks
          ORDER BY next_run_at ASC
        `).all();

        // Build calendar data: group completed tasks by day for the last 90 days
        const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
        const calendarRows = db.prepare(`
          SELECT date(updated_at, 'unixepoch') as date,
                 COUNT(*) as count,
                 GROUP_CONCAT(name, ', ') as names
          FROM tasks
          WHERE status = 'completed' AND updated_at > ?
          GROUP BY date(updated_at, 'unixepoch')
          ORDER BY date ASC
        `).all(ninetyDaysAgo);

        // Upcoming tasks (next 30 days)
        const thirtyDaysAhead = Math.floor(Date.now() / 1000) + 30 * 86400;
        const upcoming = tasks.filter(t =>
          t.status === 'pending' && t.next_run_at && t.next_run_at <= thirtyDaysAhead
        );

        // Build month calendar data for upcoming recurring tasks
        const monthCalendar = [];
        for (const task of tasks) {
          if (task.status !== 'pending') continue;
          if (task.type === 'one-time' && task.next_run_at) {
            monthCalendar.push({
              date: new Date(task.next_run_at * 1000).toISOString().slice(0, 10),
              time: new Date(task.next_run_at * 1000).toISOString().slice(11, 16),
              name: task.name,
              type: task.type,
              priority: task.priority,
              target_instance: task.target_instance,
            });
          } else if (task.type === 'recurring' && task.cron_expression) {
            // For recurring, show next 30 occurrences
            const nextRun = task.next_run_at;
            if (nextRun) {
              monthCalendar.push({
                date: new Date(nextRun * 1000).toISOString().slice(0, 10),
                time: new Date(nextRun * 1000).toISOString().slice(11, 16),
                name: task.name,
                type: task.type,
                cron: task.cron_expression,
                priority: task.priority,
                target_instance: task.target_instance,
              });
            }
          } else if (task.type === 'interval' && task.interval_seconds) {
            // Show next occurrence
            const nextRun = task.next_run_at;
            if (nextRun) {
              monthCalendar.push({
                date: new Date(nextRun * 1000).toISOString().slice(0, 10),
                time: new Date(nextRun * 1000).toISOString().slice(11, 16),
                name: task.name,
                type: task.type,
                interval: task.interval_seconds,
                priority: task.priority,
                target_instance: task.target_instance,
              });
            }
          }
        }

        res.json({
          tasks: tasks.map(t => ({
            ...t,
            next_run_human: t.next_run_at ? new Date(t.next_run_at * 1000).toISOString() : null,
            last_run_human: t.last_run_at ? new Date(t.last_run_at * 1000).toISOString() : null,
          })),
          history: calendarRows,
          upcoming: monthCalendar,
        });
      } finally {
        db.close();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ----- Dashboard static files -----
  app.use('/dashboard', express.static(path.join(skillRoot, 'public', 'dashboard')));
}
