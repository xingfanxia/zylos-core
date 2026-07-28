/**
 * ClaudeAdapter — RuntimeAdapter implementation for Claude Code.
 *
 * Encapsulates all Claude Code-specific logic:
 *   - tmux session management
 *   - Auth detection (credentials.json, claude auth status, .env tokens)
 *   - Onboarding/trust pre-acceptance
 *   - Instruction file generation (CLAUDE.md)
 *
 * This adapter is the clean interface that callers should use.
 * activity-monitor.js still contains its own parallel implementation
 * (to be migrated in Phase 7).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { RuntimeAdapter } from './base.js';
import { assertInstructionReady, buildInstructionFile } from './instruction-builder.js';
import { ClaudeContextMonitor } from './claude-context-monitor.js';
import { createClaudeProbe } from '../heartbeat/claude-probe.js';
import { ZYLOS_DIR } from '../config.js';
import {
  tmuxHasSession,
  tmuxGetPanePid,
  tmuxKillSession,
  tmuxPasteBuffer,
  tmuxDeleteBuffer,
  tmuxNewSession,
  getProcessName,
  hasChildProcess,
} from './tmux-helpers.js';
import {
  buildCleanEnv,
  buildCompatEnv,
  ensureInstanceGhConfigDir,
  loadRuntimeEnvManifest,
  readMergedDotenvVars,
  resolvePersonaDotenvPath,
  writeLaunchSpec,
} from './tmux-env.js';

// Multi-session: heartbeat pending state must be per-instance. With the shared
// path, two instances' health engines overwrite each other's pending pointer,
// each polls the other's control id, and both kill healthy sessions on the
// resulting false timeouts (2026-07-09 scheduler/user-elaine heartbeat storm).
// getMonitorDir() honors ZYLOS_INSTANCE_ID + instances.json state_dir and falls
// back to the shared dir for single-session deployments.
const { getMonitorDir: _getMonitorDir } =
  await import('../../../skills/multi-session/instance-config.js').catch(() => ({}));

// ── Constants ────────────────────────────────────────────────────────────────

// Multi-session: allow ZYLOS_TMUX_SESSION env var to override the default
const SESSION = process.env.ZYLOS_TMUX_SESSION || 'claude-main';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// When CLAUDE_BYPASS_PERMISSIONS=false, skip --dangerously-skip-permissions.
// Defaults to enabled for unattended server operation.
const DEFAULT_BYPASS = process.env.CLAUDE_BYPASS_PERMISSIONS !== 'false';

// Claude Code sets these env vars at runtime to mark "I'm running".
// Strip them before launching to prevent child-process inheritance causing
// Claude to refuse startup ("already running" detection).
const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
const ENV_CLEAN_PREFIX = 'env ' + ENV_VARS_TO_STRIP.map(v => `-u ${v}`).join(' ');

const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const C4_CONTROL_PATH = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');

/**
 * Parse a value from a .env file, tolerating common formatting variations:
 *   - Spaces/tabs around key and `=`  (e.g. `KEY = value`)
 *   - Single/double quotes around value (e.g. `KEY="value"`)
 *   - Trailing whitespace
 *
 * @param {string} content - Full .env file content
 * @param {string} key     - Variable name to extract
 * @returns {string}       - Trimmed, unquoted value, or empty string if not found
 */
function _parseEnvValue(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = content.match(re);
  if (!m) return '';
  return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Resolve whether a usable Claude credential is INSTALLED, by reading the same
 * locations Claude Code reads — with NO subprocess and NO API round-trip.
 *
 * On this fleet auth is a long-lived, non-rotating setup-token (`sk-ant-oat01-…`,
 * ~1yr expiry, no refresh token). Its validity is a STATIC property of the
 * stored credential. The former auth signal — `claude -p ping --max-turns 1` —
 * is flaky by construction: SessionStart hooks provoke tool use so a one-word
 * ping hits "Reached max turns", quota pressure returns 429/overload, and MCP/
 * hook hiccups produce unknown non-zero exits. NONE of those are auth failures,
 * yet they drove the recurring false `auth_failed` wedges. Checking the
 * credential directly removes that flake: a present, well-formed token IS auth.
 *
 * The SAME setup-token is installed in `settings.local.json` `env` (no expiry
 * metadata) AND `~/.claude/.credentials.json` `claudeAiOauth` (with `expiresAt`).
 * `.credentials.json` is therefore checked FIRST and its expiry is AUTHORITATIVE:
 * if that token is expired we do NOT let the expiry-less env/settings copies of
 * the same token mask it — we fall through to the live probe so a genuine token
 * expiry surfaces as a clean `auth_failed`, not a masked `success`.
 *
 * Accepted tradeoff: a token that is present + unexpired but REVOKED server-side
 * still resolves `success` here (no API round-trip). That is not silent — a dead
 * token can't ACK heartbeats, so the session still surfaces via heartbeat-timeout
 * → restart → degraded + admin alert. Detecting revocation directly requires the
 * live API call whose flake this change exists to remove.
 *
 * @param {string} [homeDir]
 * @returns {{ found: boolean, kind?: string }}
 */
function _resolveInstalledCredential(homeDir = os.homedir()) {
  // A usable credential is any Anthropic token/key form: OAuth/setup tokens
  // (`sk-ant-oat01-…`) and API keys (`sk-ant-api03-…`) all share the `sk-ant-`
  // prefix and are ≥ ~100 chars. The length floor rejects placeholder/test
  // strings ("oauth-test", "sk-ant-test") without a network call.
  const usable = (v) =>
    typeof v === 'string' && /^sk-ant-/.test(v.trim()) && v.trim().length >= 40;

  // 0. Expiry-authoritative source: ~/.claude/.credentials.json `claudeAiOauth`
  //    (the only source carrying `expiresAt`). Checked before the env/settings
  //    copies so an EXPIRED token cannot be masked by its expiry-less mirror.
  let credExpired = false;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', '.credentials.json'), 'utf8'));
    const oauth = creds && creds.claudeAiOauth;
    if (oauth && usable(oauth.accessToken)) {
      const raw = oauth.expiresAt;
      const exp = Number(raw);
      if (raw === undefined || raw === null || exp === 0) {
        // No expiry recorded → cannot expiry-check; accept the well-formed token.
        return { found: true, kind: 'credentials.json' };
      }
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > Date.now()) return { found: true, kind: 'credentials.json' };
        credExpired = true; // present but past-expiry → known-bad, block the mirror
      } else {
        // Malformed expiry (NaN / negative) on a well-formed token — don't trust
        // it; let the live probe adjudicate rather than accept indefinitely.
        credExpired = true;
      }
    }
  } catch { /* absent / malformed JSON — no expiry verdict, continue */ }

  if (credExpired) return { found: false };

  // 1. Process env (shell / pm2 / applied settings `env`).
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (usable(process.env[k])) return { found: true, kind: `env:${k}` };
  }

  // 2. ZYLOS `.env` file.
  try {
    const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      if (usable(_parseEnvValue(envContent, k))) return { found: true, kind: `dotenv:${k}` };
    }
  } catch { /* no .env — fall through */ }

  // 3. settings.local.json `env` (project ZYLOS dir, then user home) — the
  //    fleet-wide long-lived setup-token (mirror of the creds-file token above,
  //    but WITHOUT expiry metadata, hence checked after the expiry verdict).
  for (const base of [path.join(ZYLOS_DIR, '.claude'), path.join(homeDir, '.claude')]) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(base, 'settings.local.json'), 'utf8'));
      const env = (settings && settings.env) || {};
      for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
        if (usable(env[k])) return { found: true, kind: `settings:${k}` };
      }
    } catch { /* absent / malformed — fall through */ }
  }

  return { found: false };
}

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter extends RuntimeAdapter {
  get displayName() { return 'Claude Code'; }
  get runtimeId() { return 'claude'; }
  get sessionName()  { return SESSION; }

  // ── Instruction file ───────────────────────────────────────────────────────

  /**
   * Build CLAUDE.md from the activated split instruction layers.
   * @returns {Promise<string>} Path to the generated CLAUDE.md
   */
  async buildInstructionFile() {
    return buildInstructionFile('claude');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Auth check. Primary signal is the INSTALLED credential (deterministic, no
   * subprocess): a well-formed long-lived token/key present in any location
   * Claude Code reads IS authentication → success. Only when NO credential is
   * installed do we fall through to the live `claude -p ping --max-turns 1`
   * probe for a definitive "genuinely logged out" answer.
   *
   * Rationale: the probe is a full agentic round-trip that flakes on
   * SessionStart-hook "Reached max turns", quota 429/overload, and unknown
   * non-zero exits — none of which are auth failures. Letting those drive
   * health was the entire source of the recurring false `auth_failed` wedges.
   *
   * Return values:
   *   { status: 'success' }   — authenticated (credential present, or probe OK)
   *   { status: 'failure' }   — explicit auth failure (no credential / logged out)
   *   { status: 'uncertain' } — probe could not confirm either way
   *
   * @returns {Promise<{status: 'success'|'failure'|'uncertain', reason: string}>}
   */
  async checkAuth() {
    // Fast path: a well-formed long-lived credential is installed → auth is
    // valid. Deterministic, flake-proof, and the case that holds ~100% of the
    // time on a setup-token fleet.
    const cred = _resolveInstalledCredential();
    if (cred.found) return { status: 'success', reason: `credential_present:${cred.kind}` };

    // No credential found in any known location — genuinely unconfigured/logged
    // out. Fall through to the live probe for a definitive signal (and so
    // `zylos doctor` still surfaces a real not-logged-in state).
    // Build subprocess env: inherit current env, inject .env API keys (same as launch()).
    const injectedEnv = { ...process.env };
    let envApiKey = '';
    let envOauthToken = '';
    let envBaseUrl = '';
    try {
      const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
      envApiKey = _parseEnvValue(envContent, 'ANTHROPIC_API_KEY');
      envOauthToken = _parseEnvValue(envContent, 'CLAUDE_CODE_OAUTH_TOKEN');
      envBaseUrl = _parseEnvValue(envContent, 'ANTHROPIC_BASE_URL');
      if (envApiKey) injectedEnv.ANTHROPIC_API_KEY = envApiKey;
      if (envOauthToken) injectedEnv.CLAUDE_CODE_OAUTH_TOKEN = envOauthToken;
      if (envBaseUrl) injectedEnv.ANTHROPIC_BASE_URL = envBaseUrl;
    } catch { /* .env absent — no keys to inject */ }

    // Strip vars that would make Claude refuse to start ("already running" guard).
    for (const v of ENV_VARS_TO_STRIP) delete injectedEnv[v];

    // Live CLI probe — `claude -p ping --max-turns 1`.
    // End-to-end validation: works with all credential types (API keys, setup tokens,
    // OAuth tokens) without needing to know the correct HTTP header format.
    // Claude Code handles credential routing internally.
    // Use async execFile — spawnSync would block the event loop for up to 30s.
    try {
      const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p', 'ping', '--max-turns', '1'], {
        env: injectedEnv,
        timeout: 30_000,
        encoding: 'utf8',
      });
      // Safety net: some Claude versions exit 0 with "Not logged in" on stdout.
      if (stdout.includes('Not logged in')) {
        return { status: 'failure', reason: 'cli_probe_not_logged_in' };
      }
      return { status: 'success', reason: 'cli_probe' };
    } catch (err) {
      const output = (err.stdout ?? '') + (err.stderr ?? '');
      if (output.includes('authentication_error')) {
        return { status: 'failure', reason: 'cli_probe_authentication_error' };
      }
      const isTransient =
        output.includes('rate_limit_error') ||
        output.includes('api_error') ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.killed;
      if (isTransient) {
        return { status: 'uncertain', reason: 'cli_probe_uncertain' };
      }
      // Explicit unauthenticated signals — the only outputs that prove auth is broken.
      if (
        output.includes('Not logged in') ||
        output.includes('Please run /login') ||
        output.includes('Invalid API key')
      ) {
        return { status: 'failure', reason: 'cli_probe_not_authenticated', output: output.slice(0, 500) };
      }
      // `claude -p ping --max-turns 1` exits non-zero with "Reached max turns" when the
      // probe runs inside the full project context (SessionStart hooks provoke tool use,
      // so a one-word "ping" needs >1 turn). Reaching a turn at all proves an
      // authenticated API round-trip happened -> success, NOT an auth failure.
      if (output.includes('Reached max turns')) {
        return { status: 'success', reason: 'cli_probe_max_turns' };
      }
      // Unknown non-zero exit: could not confirm auth either way. Do NOT assert
      // auth_failed (it gates message routing) — report uncertain so the live agent
      // heals via heartbeat ACK and the next probe re-checks.
      return { status: 'uncertain', reason: 'cli_probe_unknown_exit', output: output.slice(0, 500) };
    }
  }

  // ── Process / tmux ────────────────────────────────────────────────────────

  /**
   * @returns {Promise<boolean>}
   */
  async isRunning() {
    if (!tmuxHasSession(SESSION)) return false;

    const panePid = tmuxGetPanePid(SESSION);
    if (!panePid) return false;

    const name = getProcessName(panePid);
    if (name === 'claude') return true;

    return hasChildProcess(panePid, 'claude');
  }

  /**
   * Kill the tmux session for this runtime.
   * Synchronous — HeartbeatEngine calls this without await.
   */
  stop() {
    tmuxKillSession(SESSION);
  }

  /**
   * Inject a message into the running Claude session via tmux.
   * Uses the buffer paste technique to handle special characters safely.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendMessage(text) {
    const msgId = `${Date.now()}-${process.pid}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-'));
    const tmpFile = path.join(tmpDir, 'msg.txt');
    const bufferName = `zylos-${msgId}`;

    try {
      fs.writeFileSync(tmpFile, text);
      tmuxPasteBuffer(SESSION, tmpFile, bufferName);
    } finally {
      try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { }
      tmuxDeleteBuffer(bufferName);
    }
  }

  clearStaleState() {
    try {
      this.getHeartbeatDeps()?.clearHeartbeatPending?.();
    } catch { }
    try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch { }
    try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch { }
  }

  enqueueStartupPrompt() {
    if (_hasStartupHook()) return;

    const content = 'reply to your human partner if they are waiting for your reply, then continue your ongoing tasks using the startup memory and C4 context already injected in this session, and do not query c4.db for recent conversations unless explicitly required.';
    try {
      execFileSync('node', [
        C4_CONTROL_PATH,
        'enqueue',
        '--content', content,
        '--priority', '3',
        '--available-in', '3',
        '--no-ack-suffix'
      ], { encoding: 'utf8', timeout: 10_000 });
    } catch { }
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  /**
   * Start Claude Code in the tmux session. Guardian prepares instructions first.
   *
   * New session: builds env via launcher pipeline (clean or compat mode).
   * Existing session: sends command via sendMessage (no env rebuild).
   *
   * @param {object} [opts]
   * @param {boolean} [opts.bypassPermissions] - Override default bypass setting
   * @returns {Promise<void>}
   */
  async launch(opts = {}) {
    const bypassPermissions = opts.bypassPermissions ?? DEFAULT_BYPASS;
    assertInstructionReady('claude');
    const profile = this.config.runtimeProfile || {};
    const reasoningEffort = profile.reasoningEffort || null;

    // Guardian has already built and validated the split instruction files.
    // Resolve the per-instance working directory for memory, token, and GitHub
    // CLI isolation before preparing the runtime.
    const instanceId = process.env.ZYLOS_INSTANCE_ID || null;
    let instanceCwd = ZYLOS_DIR;
    let osUser = null;
    if (instanceId) {
      try {
        const { ensureInstanceCwd, getInstanceDef } = await import('../../../skills/multi-session/instance-config.js');
        instanceCwd = ensureInstanceCwd(instanceId);
        // OS-level isolation (docs/design/agent-os-isolation.md): instances with
        // an os_user run Claude as that dedicated unix user instead of the
        // service user. Provisioned by scripts/ops/provision-agent-user.sh.
        const candidate = getInstanceDef(instanceId)?.os_user || null;
        if (candidate) {
          if (/^[a-z_][a-z0-9_-]{0,31}$/.test(candidate)) {
            osUser = candidate;
          } else {
            console.error(`[ClaudeAdapter] ignoring invalid os_user "${candidate}" for "${instanceId}"`);
          }
        }
      } catch (err) {
        console.error(`[ClaudeAdapter] ensureInstanceCwd failed for "${instanceId}": ${err.message}`);
      }
    }

    // 2. Pre-accept onboarding/trust dialogs (all auth methods).
    // os_user instances: provisioning owns /home/<os_user>/.claude.json — the
    // service user cannot (and must not) write into the agent home.
    if (!osUser) {
      _ensureOnboardingComplete(ZYLOS_DIR);
      if (instanceCwd !== ZYLOS_DIR) _ensureOnboardingComplete(instanceCwd);
    }
    const ghConfigDir = instanceId ? ensureInstanceGhConfigDir(instanceCwd) : null;

    // 3. Detect auth method to avoid "Auth conflict" errors
    const useCredentialsFile = _hasCredentialsFile();
    let hasNativeAuth = useCredentialsFile;
    let apiKeyValue = '';
    let oauthTokenValue = '';
    let baseUrlValue = '';

    if (!hasNativeAuth) {
      try {
        const out = execFileSync(CLAUDE_BIN, ['auth', 'status'], {
          encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const status = JSON.parse(out);
        if (status?.loggedIn === true && status?.authMethod === 'claude.ai') {
          hasNativeAuth = true;
        }
      } catch { }
    }

    if (!hasNativeAuth) {
      try {
        const envContent = fs.readFileSync(path.join(ZYLOS_DIR, '.env'), 'utf8');
        apiKeyValue = _parseEnvValue(envContent, 'ANTHROPIC_API_KEY');
        oauthTokenValue = _parseEnvValue(envContent, 'CLAUDE_CODE_OAUTH_TOKEN');
        baseUrlValue = _parseEnvValue(envContent, 'ANTHROPIC_BASE_URL');
      } catch { }

      if (apiKeyValue) _approveApiKey(apiKeyValue);
      if (oauthTokenValue) _approveApiKey(oauthTokenValue);
    }

    // 4. Build the claude command string (for existing-session path)
    const bypassFlag = bypassPermissions ? ' --dangerously-skip-permissions' : '';
    const envStripFlags = hasNativeAuth
      ? ' -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY'
      : '';

    // No --continue: CC's resume locks model to original session and double-injects
    // context (zylos's c4-session-init hook already restores conversation history).
    const claudeCmd = `${ENV_CLEAN_PREFIX}${envStripFlags} ${CLAUDE_BIN}${bypassFlag}`;

    const monitorDir = path.join(ZYLOS_DIR, 'activity-monitor');
    const exitLogFile = path.join(monitorDir, 'claude-exit.log');
    const exitLogSnippet = `_ec=$?; echo "[$(date -Iseconds)] exit_code=$_ec" >> "${exitLogFile}"`;

    // os_user instances: a leftover pane belongs to the agent user (or is a
    // stale service-user shell) — neither can be reused for a privileged
    // relaunch. Kill and rebuild through the clean new-session pipeline.
    if (osUser && tmuxHasSession(SESSION)) {
      tmuxKillSession(SESSION);
    }

    if (tmuxHasSession(SESSION)) {
      // Existing session — send command via sendMessage, no env rebuild.
      // Multi-session: re-export instance env so subsequent in-session restarts inherit identity.
      const envExports = [
        process.env.ZYLOS_INSTANCE_ID ? `export ZYLOS_INSTANCE_ID='${process.env.ZYLOS_INSTANCE_ID}'` : '',
        process.env.ZYLOS_TMUX_SESSION ? `export ZYLOS_TMUX_SESSION='${process.env.ZYLOS_TMUX_SESSION}'` : '',
        reasoningEffort ? `export CLAUDE_EFFORT='${reasoningEffort}'` : '',
        ghConfigDir ? `export GH_CONFIG_DIR='${ghConfigDir}'` : '',
        ghConfigDir ? 'export GH_PROMPT_DISABLED=1' : '',
      ].filter(Boolean).join('; ');
      const envPrefix = envExports ? `${envExports}; ` : '';
      const cmd = `${envPrefix}cd "${instanceCwd}"; ${claudeCmd}; ${exitLogSnippet}`;
      await this.sendMessage(cmd);
    } else {
      // New session — launcher pipeline
      const dotenvVars = readMergedDotenvVars([path.join(ZYLOS_DIR, '.env')]);
      const personaEnvFile = resolvePersonaDotenvPath(ZYLOS_DIR, instanceCwd);
      const useCleanEnv = dotenvVars.ZYLOS_CLEAN_ENV !== 'false';
      const manifest = useCleanEnv ? loadRuntimeEnvManifest(ZYLOS_DIR) : undefined;

      const { env } = useCleanEnv
        ? buildCleanEnv({ processEnv: process.env, dotenvVars, manifest, uid: process.getuid?.() })
        : buildCompatEnv({ processEnv: process.env, dotenvVars });

      // Strip vars that cause Claude to refuse startup ("already running" detection)
      for (const v of ENV_VARS_TO_STRIP) delete env[v];

      // Multi-session: propagate instance identity into the launched Claude process
      // so its hooks/skills write to the correct per-instance paths.
      if (process.env.ZYLOS_INSTANCE_ID) env.ZYLOS_INSTANCE_ID = process.env.ZYLOS_INSTANCE_ID;
      if (process.env.ZYLOS_TMUX_SESSION) env.ZYLOS_TMUX_SESSION = process.env.ZYLOS_TMUX_SESSION;
      if (ghConfigDir) env.GH_CONFIG_DIR = ghConfigDir;
      if (reasoningEffort) env.CLAUDE_EFFORT = reasoningEffort;

      // Inject auth tokens
      if (hasNativeAuth) {
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        if (apiKeyValue) env.ANTHROPIC_API_KEY = apiKeyValue;
        if (oauthTokenValue) env.CLAUDE_CODE_OAUTH_TOKEN = oauthTokenValue;
        if (baseUrlValue) env.ANTHROPIC_BASE_URL = baseUrlValue;
      }

      // os_user instances: the agent process gets the agent's own HOME so its
      // ~/zylos farm dir (per-instance .env + symlinks), credentials symlink,
      // transcripts, and hook `~` expansion all resolve inside the agent home.
      if (osUser) {
        env.HOME = `/home/${osUser}`;
        env.USER = osUser;
        env.LOGNAME = osUser;
      }

      // Build launch spec
      const args = [];
      if (bypassPermissions) args.push('--dangerously-skip-permissions');

      const launcherPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'tmux-launcher.js');
      const specPath = writeLaunchSpec({
        command: CLAUDE_BIN,
        args,
        env,
        cwd: instanceCwd,
        personaEnvFile,
        exitLogFile,
      });

      // Spec is 0600 in /tmp (sticky): hand it to the agent user so the
      // launcher (running as os_user) can read + unlink it.
      if (osUser) {
        try {
          execFileSync('sudo', ['-n', 'chown', `${osUser}:${osUser}`, specPath], { timeout: 10_000 });
        } catch (e) {
          try { fs.unlinkSync(specPath); } catch { }
          throw new Error(`Failed to chown launch spec to ${osUser}: ${e.message}`);
        }
      }

      const launchCmd = osUser
        ? `sudo -n -u ${osUser} -H -- "${process.execPath}" "${launcherPath}" "${specPath}"`
        : `"${process.execPath}" "${launcherPath}" "${specPath}"`;

      // tmux args — only pass minimal env for launcher itself to start
      const tmuxArgs = [
        'new-session', '-d', '-E', '-s', SESSION,
        '-e', `PATH=${env.PATH}`,
        '-e', `HOME=${env.HOME}`,
        '-e', `TERM=${env.TERM || 'xterm-256color'}`,
        '--', launchCmd,
      ];

      try {
        tmuxNewSession(tmuxArgs);
      } catch (e) {
        try { fs.unlinkSync(specPath); } catch { }
        throw new Error(`Failed to create tmux session: ${e.message}`);
      }
    }
  }

  // ── Heartbeat / context (Phase 5) ─────────────────────────────────────────

  /**
   * Returns runtime-specific HeartbeatEngine deps for Claude Code.
   * Includes: enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
   *           readHeartbeatPending, clearHeartbeatPending.
   *
   * @returns {object}
   */
  getHeartbeatDeps() {
    const monitorDir = _getMonitorDir
      ? _getMonitorDir()
      : path.join(ZYLOS_DIR, 'activity-monitor');
    const pendingFile = path.join(monitorDir, 'heartbeat-pending.json');
    return createClaudeProbe({ pendingFile, tmuxSession: SESSION });
  }

  /**
   * Claude uses the statusLine hook (context-monitor.js) for context monitoring,
   * which enqueues a new-session control message for a graceful handoff.
   * Return null here so the activity-monitor does not activate the generic
   * polling + stop/launch rotation path, which would kill the session abruptly.
   *
   * @returns {null}
   */
  getContextMonitor() {
    return null;
  }
}

// ── Private helpers ────────────────────────────────────────────────────────

function _hasCredentialsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    return !!(data.claudeAiOauth && data.claudeAiOauth.refreshToken);
  } catch {
    return false;
  }
}

function _hasStartupHook() {
  try {
    const settingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const matchers = settings?.hooks?.SessionStart;
    if (!Array.isArray(matchers)) return false;
    return matchers.some(m =>
      Array.isArray(m?.hooks) && m.hooks.some(
        h => h?.type === 'command' && typeof h.command === 'string'
          && /(?:^|[\\/])session-start-prompt\.js(?:["'\s]|$)/.test(h.command)
      )
    );
  } catch {
    return false;
  }
}

/**
 * Pre-accept onboarding, workspace trust, and settings dialogs so Claude
 * starts without interactive prompts in the tmux session.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 */
function _ensureOnboardingComplete(projectDir) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { }

    let changed = false;
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        config.lastOnboardingVersion = execFileSync(
          CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 5000 }
        ).trim();
      } catch {
        config.lastOnboardingVersion = '2.1.59';
      }
      changed = true;
    }
    if (!config.effortCalloutDismissed) {
      config.effortCalloutDismissed = true;
      changed = true;
    }
    if (!config.projects) config.projects = {};
    const abs = path.resolve(projectDir);
    if (!config.projects[abs]) config.projects[abs] = {};
    if (!config.projects[abs].hasTrustDialogAccepted) {
      config.projects[abs].hasTrustDialogAccepted = true;
      config.projects[abs].hasCompletedProjectOnboarding = true;
      changed = true;
    }
    if (changed) fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch { }

  // ~/.claude/settings.json — skip dangerous-mode permission prompt
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { }
    if (!settings.skipDangerousModePermissionPrompt) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      settings.skipDangerousModePermissionPrompt = true;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch { }
}

/**
 * Pre-approve an API key in ~/.claude.json so Claude skips the
 * interactive "Detected a custom API key" confirmation prompt.
 *
 * @param {string} apiKey
 */
function _approveApiKey(apiKey) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { }
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const suffix = apiKey.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(suffix)) {
      config.customApiKeyResponses.approved.push(suffix);
      fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
    }
  } catch { }
}
