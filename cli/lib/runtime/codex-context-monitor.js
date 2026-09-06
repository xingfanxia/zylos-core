/**
 * Current Codex context from the live parent rollout in its active CODEX_HOME.
 * last_token_usage.input_tokens includes cached input; total_token_usage and
 * SQLite threads.tokens_used are cumulative cost, never a context fallback.
 * SQLite is only an index of rollout paths. Without a matching live session
 * and a valid token_count event, return null rather than fabricate a sample.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ContextMonitorBase } from './context-monitor-base.js';
import { buildProcessTree } from './process-tree.js';

const TAIL_BYTES = 65_536;

export class CodexContextMonitor extends ContextMonitorBase {
  constructor(opts = {}) {
    super(opts);
    this._model = opts.model ?? null;
    this._codexDir = opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this._cwd = canonical(opts.cwd || process.cwd());
    this._tmuxSession = opts.tmuxSession || process.env.ZYLOS_TMUX_SESSION || 'codex-main';
    this._execFileSync = opts.execFileSync || execFileSync;
    this._buildProcessTree = opts.buildProcessTree || buildProcessTree;
    this._cachedRollout = null;
  }

  async getUsage() {
    return this._readFromJsonl();
  }

  _liveSession() {
    try {
      const out = this._execFileSync('tmux', ['list-panes', '-t', this._tmuxSession, '-F', '#{pane_pid}'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
      });
      const panes = String(out).trim().split('\n').map(Number);
      if (panes.length !== 1 || !Number.isInteger(panes[0]) || panes[0] <= 0) return null;
      const tree = this._buildProcessTree();
      const roots = [];
      const seen = new Set();
      const visit = (pid) => {
        if (seen.has(pid)) return;
        seen.add(pid);
        if (path.basename(tree.infoOf.get(pid)?.comm || '') === 'codex') {
          roots.push(pid);
          return; // Nested Codex workers do not replace their parent runtime.
        }
        for (const child of tree.childrenOf.get(pid) || []) visit(child);
      };
      visit(panes[0]);
      if (roots.length !== 1) return null;
      const pid = roots[0];
      const date = this._execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      });
      const started = Date.parse(`${String(date).trim()} UTC`);
      return Number.isFinite(started) ? { pid, started, key: `${pid}:${started}` } : null;
    } catch { return null; }
  }

  _readFromJsonl() {
    const rolloutPath = this._getActiveRolloutPath();
    if (!rolloutPath) return null;
    try {
      const stat = fs.statSync(rolloutPath);
      if (!stat.size) return null;
      const readBytes = Math.min(TAIL_BYTES, stat.size);
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(rolloutPath, 'r');
      try { fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes); }
      finally { fs.closeSync(fd); }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
          const info = event.payload.info;
          const used = info?.last_token_usage?.input_tokens;
          if (!Number.isFinite(used) || used < 0) continue;
          const ceiling = info.model_context_window ?? this._getModelCeiling();
          if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
          return { used, ceiling, source: 'rollout_token_count', rolloutPath };
        } catch { /* partial tail boundary or incomplete JSONL write */ }
      }
    } catch { /* missing/unreadable session is not a zero reading */ }
    return null;
  }

  _getActiveRolloutPath() {
    const live = this._liveSession();
    if (!live) {
      this._cachedRollout = null;
      return null;
    }
    // Open files tie resumed sessions (whose metadata predates this process)
    // directly to the live engine. Other OS users may hide /proc fd entries;
    // their fresh launches can still be matched by process start and metadata.
    const open = this._openRollouts(live.pid).filter((p) => this._rolloutMatchesSession(p, null));
    if (open.length > 1) return null;
    if (open.length === 1) {
      this._cachedRollout = { key: live.key, path: canonical(open[0]) };
      return this._cachedRollout.path;
    }
    // Re-resolve rather than reusing a PID-only cache: /new or /resume may
    // replace the active thread without replacing either tmux or the engine.
    const { started } = live;
    let candidates = [];
    try {
      // Every condition is joined with AND. Validate metadata even if SQLite
      // returns a path: old indexes and cloned child metadata can be stale.
      const sql = `SELECT rollout_path FROM threads WHERE archived = 0
        AND ${this._getThreadScopeSql()}
        AND created_at >= ${Math.floor(started / 1000)}
        ORDER BY created_at ASC;`;
      const out = this._execFileSync('sqlite3', ['-readonly', path.join(this._codexDir, 'state_5.sqlite'), sql], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
      });
      candidates = String(out).trim().split('\n').filter((p) => p && this._rolloutMatchesSession(p, started));
    } catch { /* CLI unavailable/schema drift: inspect rollout metadata */ }
    if (!candidates.length) candidates = this._getRolloutsFromFilesystem(started);
    const unique = [...new Set(candidates.map(canonical))];
    if (unique.length !== 1) return null;
    this._cachedRollout = { key: live.key, path: unique[0] };
    return unique[0];
  }

  _openRollouts(pid) {
    const paths = new Set();
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const file = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (path.basename(file).startsWith('rollout-') && file.endsWith('.jsonl')) paths.add(file);
        } catch { /* descriptor closed or hidden */ }
      }
    } catch { /* non-Linux or isolated OS user: metadata fallback */ }
    return [...paths];
  }

  _getRolloutsFromFilesystem(started) {
    const found = [];
    const walk = (dir, depth) => {
      for (const item of readdirSafe(dir)) {
        const file = path.join(dir, item.name);
        if (item.isDirectory() && depth > 0) walk(file, depth - 1);
        else if (item.isFile() && item.name.startsWith('rollout-') && item.name.endsWith('.jsonl') && this._rolloutMatchesSession(file, started)) found.push(file);
      }
    };
    walk(path.join(this._codexDir, 'sessions'), 3);
    return found;
  }

  _getThreadScopeSql() {
    return `cwd = '${this._cwd.replace(/'/g, "''")}'`;
  }

  _rolloutMatchesSession(rolloutPath, started) {
    try {
      const sessionsDir = canonical(path.join(this._codexDir, 'sessions'));
      const relative = path.relative(sessionsDir, canonical(rolloutPath));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const fd = fs.openSync(rolloutPath, 'r');
      let event;
      try {
        const buf = Buffer.alloc(65536);
        const size = fs.readSync(fd, buf, 0, buf.length, 0);
        // FIRST metadata only. Child rollouts may contain a cloned parent
        // session_meta on line 2; that never makes the child the main session.
        event = JSON.parse(buf.toString('utf8', 0, size).split('\n')[0]);
      } finally { fs.closeSync(fd); }
      const meta = event.payload;
      if (event.type !== 'session_meta' || meta?.source !== 'cli' || typeof meta.cwd !== 'string') return false;
      if (canonical(meta.cwd) !== this._cwd) return false;
      if (!meta.id || !path.basename(rolloutPath).endsWith(`${meta.id}.jsonl`)) return false;
      const created = Date.parse(meta.timestamp);
      return Number.isFinite(created) && (started === null || created >= started);
    } catch { return false; }
  }

  /** Event effective ceiling wins; otherwise read the active profile only. */
  _getModelCeiling() {
    try {
      const config = fs.readFileSync(path.join(this._codexDir, 'config.toml'), 'utf8');
      const match = config.match(/^\s*model_context_window\s*=\s*(\d+)\s*$/m);
      if (match?.[1]) {
        const parsed = parseInt(match[1], 10);
        if (!Number.isNaN(parsed) && parsed > 0) return parsed;
      }
    } catch { /* config.toml missing or unreadable */ }
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(this._codexDir, 'models_cache.json'), 'utf8'));
      const models = cache.models ?? [];
      const model = this._model ? models.find((m) => m.slug === this._model) : models[0];
      if (Number.isFinite(model?.context_window) && model.context_window > 0) {
        const pct = model.effective_context_window_percent ?? 100;
        if (Number.isFinite(pct) && pct > 0 && pct <= 100) return Math.round(model.context_window * (pct / 100));
      }
    } catch { /* models_cache.json missing or malformed */ }
    return null;
  }
}

function canonical(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function readdirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
