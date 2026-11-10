import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const VALID_OS_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Optional Claude Code context suffix, e.g. claude-opus-5-5[1m].
const VALID_MODEL = /^[A-Za-z0-9._:-]+(?:\[1m\])?$/;
const VALID_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);
// Extra Claude subscription accounts publish usage as claude-<account>.
const VALID_USAGE_PROVIDER = /^(?:codex|claude(?:-[a-z0-9][a-z0-9-]{0,30})?)$/;
// Absolute, shell-safe path to a Claude --settings file carrying one account's
// setup-token; the path (never the token) reaches the launch command.
const VALID_SETTINGS_FILE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/;

function readJsonSafe(filePath, readFileSync = fs.readFileSync) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function getConfiguredRuntime({
  zylosDir = DEFAULT_ZYLOS_DIR,
  readFileSync = fs.readFileSync,
} = {}) {
  const cfg = readJsonSafe(path.join(zylosDir, '.zylos', 'config.json'), readFileSync);
  return cfg?.runtime === 'codex' ? 'codex' : 'claude';
}

// ── Fable allowance guard (FG) ──────────────────────────────────────────────
// Contract: docs/fable-allowance-guard.md. Inert unless instances.json carries
// `fable_guard.fable_model`; a persona opts in with `fable_enabled: true`. The
// runtime-failover daemon owns the state file; launches only read it.
export const FABLE_GUARD_DEFAULTS = Object.freeze({
  threshold: 0.75,
  subagent_model: 'claude-opus-5-5',
  probe_interval_sec: 300,
  lease_sec: 720,
  probe_backoff_max_sec: 900,
  upgrade_min_dwell_sec: 1800,
  stale_clear_observations: 3,
  crash_window_sec: 1800,
  crash_failures: 2,
  crash_probation_sec: 7200,
});
const FABLE_NUMERIC_BOUNDS = {
  probe_interval_sec: [60, 3600],
  lease_sec: [120, 7200],
  probe_backoff_max_sec: [60, 3600],
  upgrade_min_dwell_sec: [0, 86_400],
  stale_clear_observations: [1, 20],
  crash_window_sec: [60, 86_400],
  crash_failures: [1, 20],
  crash_probation_sec: [60, 7 * 86_400],
};
const VALID_PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function fableGuardStatePath(zylosDir = DEFAULT_ZYLOS_DIR) {
  return path.join(zylosDir, 'activity-monitor', 'fable-guard.json');
}

export function fableUsagePath(zylosDir = DEFAULT_ZYLOS_DIR) {
  return path.join(zylosDir, 'activity-monitor', 'fable-usage.json');
}

/** Normalized guard config, or null when the feature is not configured. */
export function readFableGuardConfig(document) {
  const raw = document?.fable_guard;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.enabled === false) return null;
  if (typeof raw.fable_model !== 'string' || !VALID_MODEL.test(raw.fable_model)) return null;
  const config = { ...FABLE_GUARD_DEFAULTS, fable_model: raw.fable_model };
  const threshold = Number(raw.threshold);
  if (Number.isFinite(threshold) && threshold > 0 && threshold <= 1) config.threshold = threshold;
  if (typeof raw.subagent_model === 'string' && VALID_MODEL.test(raw.subagent_model)) {
    config.subagent_model = raw.subagent_model;
  }
  for (const [key, [min, max]] of Object.entries(FABLE_NUMERIC_BOUNDS)) {
    const value = Number(raw[key]);
    if (raw[key] != null && Number.isInteger(value) && value >= min && value <= max) config[key] = value;
  }
  config.probe_accounts = Array.isArray(raw.probe_accounts)
    ? [...new Set(raw.probe_accounts.filter(id => typeof id === 'string' && VALID_PROFILE_ID.test(id)))]
    : [];
  return config;
}

/** Settings file of a probe-able Fable account (a Claude profile), else null. */
export function fableAccountSettingsFile(document, profileId) {
  const raw = document?.runtime_profiles?.[profileId];
  if (raw?.runtime !== 'claude' || typeof raw.claude_settings_file !== 'string') return null;
  return VALID_SETTINGS_FILE.test(raw.claude_settings_file) && !raw.claude_settings_file.split('/').includes('..')
    ? raw.claude_settings_file : null;
}

/**
 * Launch decision for one persona. null = feature inert for this persona (not
 * configured or not fable_enabled): the launch is byte-for-byte unchanged.
 * Fable is chosen only when the guard committed it for this exact account and
 * that account has no hold; anything else launches the profile's own model.
 */
export function resolveFableLaunch({ document, instanceId, profileId, guardState = null } = {}) {
  const config = readFableGuardConfig(document);
  const instance = instanceId ? document?.instances?.[instanceId] : null;
  if (!config || instance?.fable_enabled !== true) return null;
  const desired = guardState?.personas?.[instanceId]?.desired;
  const holds = guardState?.holds?.[profileId];
  const fable = Boolean(fableAccountSettingsFile(document, profileId))
    && desired?.mode === 'fable' && desired.account === profileId
    && Number.isInteger(desired.generation)
    && !(holds && typeof holds === 'object' && Object.keys(holds).length > 0);
  return {
    mode: fable ? 'fable' : 'opus',
    model: fable ? config.fable_model : null,
    generation: Number.isInteger(desired?.generation) ? desired.generation : null,
    env: {
      CLAUDE_CODE_SUBAGENT_MODEL: config.subagent_model,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    },
  };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve a named per-instance runtime profile without ever returning raw
 * credentials. Profile documents may reference a Codex home and the NAME of a
 * provider env var; secret values remain in that Codex home's auth.json.
 *
 * Isolated instances are fail-closed: their Codex home must stay beneath the
 * dedicated unix user's home even if instances.json is corrupted or edited by
 * the wrong actor.
 */
export function resolveRuntimeProfile({
  document,
  instanceId = null,
  homeDir = os.homedir(),
  configuredRuntime = 'claude',
  fableGuardState = null,
} = {}) {
  const instance = instanceId ? document?.instances?.[instanceId] || {} : {};
  const profileId = typeof instance.runtime_profile === 'string'
    ? instance.runtime_profile
    : null;
  const raw = profileId ? document?.runtime_profiles?.[profileId] : null;
  const errors = [];

  const osUser = typeof instance.os_user === 'string' && VALID_OS_USER.test(instance.os_user)
    ? instance.os_user
    : null;
  if (instance.os_user && !osUser) errors.push('invalid_os_user');

  const runtimeHome = osUser ? `/home/${osUser}` : path.resolve(homeDir);
  const fallbackRuntime = instance.runtime === 'codex' || instance.runtime === 'claude'
    ? instance.runtime
    : configuredRuntime === 'codex' ? 'codex' : 'claude';
  const runtime = raw?.runtime === 'codex' || raw?.runtime === 'claude'
    ? raw.runtime
    : fallbackRuntime;
  if (raw && raw.runtime !== 'codex' && raw.runtime !== 'claude') {
    errors.push('invalid_runtime');
  }

  for (const key of Object.keys(raw || {})) {
    if (key === 'provider_env_key') continue;
    if (/(?:^|_)(?:api_?key|token|secret|credential|password)(?:$|_)/i.test(key)) {
      errors.push('secret_field_not_allowed');
      break;
    }
  }

  let codexHome = path.join(runtimeHome, '.codex');
  if (runtime === 'codex' && typeof raw?.codex_home === 'string' && raw.codex_home.trim()) {
    const requested = raw.codex_home.startsWith('~/')
      ? path.resolve(runtimeHome, raw.codex_home.slice(2))
      : path.resolve(raw.codex_home);
    if (osUser && !isInside(runtimeHome, requested)) {
      errors.push('codex_home_outside_runtime_home');
    } else {
      codexHome = requested;
    }
  }

  let providerEnvKey = null;
  if (raw?.provider_env_key != null) {
    if (typeof raw.provider_env_key === 'string' && VALID_ENV_KEY.test(raw.provider_env_key)) {
      providerEnvKey = raw.provider_env_key;
    } else {
      errors.push('invalid_provider_env_key');
    }
  }

  const model = typeof raw?.model === 'string' && VALID_MODEL.test(raw.model)
    ? raw.model
    : null;
  if (raw?.model != null && !model) errors.push('invalid_model');

  const reasoningEffort = typeof raw?.reasoning_effort === 'string'
    && VALID_REASONING.has(raw.reasoning_effort)
    ? raw.reasoning_effort
    : null;
  if (raw?.reasoning_effort != null && !reasoningEffort) errors.push('invalid_reasoning_effort');

  const usageProvider = typeof raw?.usage_provider === 'string' && VALID_USAGE_PROVIDER.test(raw.usage_provider)
    ? raw.usage_provider
    : null;
  if (raw?.usage_provider != null && !usageProvider) errors.push('invalid_usage_provider');

  const claudeSettingsFile = runtime === 'claude' && typeof raw?.claude_settings_file === 'string'
    && VALID_SETTINGS_FILE.test(raw.claude_settings_file) && !raw.claude_settings_file.split('/').includes('..')
    ? raw.claude_settings_file
    : null;
  if (raw?.claude_settings_file != null && !claudeSettingsFile) errors.push('invalid_claude_settings_file');

  if (profileId && !raw) errors.push('unknown_runtime_profile');

  const fable = runtime === 'claude' && raw
    ? resolveFableLaunch({ document, instanceId, profileId, guardState: fableGuardState })
    : null;

  return {
    id: raw ? profileId : null,
    runtime,
    runtimeHome,
    codexHome,
    osUser,
    usageProvider,
    model: fable?.model || model,
    reasoningEffort,
    providerEnvKey,
    claudeSettingsFile,
    ...(fable ? { fable: { mode: fable.mode, generation: fable.generation }, launchEnv: fable.env } : {}),
    errors: [...new Set(errors)],
  };
}

export function getInstanceRuntimeProfile({
  zylosDir = DEFAULT_ZYLOS_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  readFileSync = fs.readFileSync,
  homeDir = os.homedir(),
} = {}) {
  const configuredRuntime = getConfiguredRuntime({ zylosDir, readFileSync });
  const document = readJsonSafe(path.join(zylosDir, 'instances.json'), readFileSync);
  if (document || instanceId) {
    const fableGuardState = readFableGuardConfig(document)
      ? readJsonSafe(fableGuardStatePath(zylosDir), readFileSync)
      : null;
    return resolveRuntimeProfile({
      document: document || {},
      instanceId,
      homeDir,
      configuredRuntime,
      fableGuardState,
    });
  }

  // Upstream/public Zylos is deliberately single-session and has no
  // instances.json. A small sidecar owns only the active engine profile; the
  // persona still runs directly from zylosDir and therefore keeps the same
  // identity, memory, skills, .env, C4 database and chat routing.
  const single = readJsonSafe(
    path.join(zylosDir, '.zylos', 'runtime-profiles.json'),
    readFileSync,
  );
  if (single?.active_profile && single?.runtime_profiles) {
    const singleId = '__single_session__';
    const synthetic = {
      runtime_profiles: single.runtime_profiles,
      instances: {
        [singleId]: {
          runtime: configuredRuntime,
          runtime_profile: single.active_profile,
        },
      },
    };
    return resolveRuntimeProfile({
      document: synthetic,
      instanceId: singleId,
      homeDir,
      configuredRuntime,
    });
  }

  return resolveRuntimeProfile({ document: {}, instanceId: null, homeDir, configuredRuntime });
}

export function getInstanceRuntime({
  zylosDir = DEFAULT_ZYLOS_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  readFileSync = fs.readFileSync,
} = {}) {
  return getInstanceRuntimeProfile({ zylosDir, instanceId, readFileSync }).runtime;
}

export function getInstanceStateFile({
  zylosDir = DEFAULT_ZYLOS_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  existsSync = fs.existsSync,
} = {}) {
  const memoryDir = path.join(zylosDir, 'memory');
  if (!instanceId) {
    return path.join(memoryDir, 'state.md');
  }

  const instancesDir = path.join(memoryDir, 'instances');
  const instanceState = path.join(instancesDir, instanceId, 'state.md');
  if (existsSync(instancesDir) || existsSync(instanceState)) {
    return instanceState;
  }

  return path.join(memoryDir, 'state.md');
}

function isCustomInstanceInstructionFile(filePath, rootPath, {
  existsSync = fs.existsSync,
  lstatSync = fs.lstatSync,
  realpathSync = fs.realpathSync,
} = {}) {
  if (!existsSync(filePath)) return false;

  try {
    if (!rootPath || !existsSync(rootPath)) return true;
    const stat = lstatSync(filePath);
    if (!stat.isSymbolicLink()) return true;
    return path.resolve(realpathSync(filePath)) !== path.resolve(realpathSync(rootPath));
  } catch {
    return true;
  }
}

export function getInstanceInstructionFiles({
  zylosDir = DEFAULT_ZYLOS_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  runtime = null,
  existsSync = fs.existsSync,
  lstatSync = fs.lstatSync,
  realpathSync = fs.realpathSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!instanceId) return [];

  const activeRuntime = runtime || getInstanceRuntime({ zylosDir, instanceId, readFileSync });
  const instanceDir = path.join(zylosDir, 'instances', instanceId);
  const results = [];

  const genericPath = path.join(instanceDir, 'ZYLOS.md');
  const rootGeneric = path.join(zylosDir, 'ZYLOS.md');
  if (isCustomInstanceInstructionFile(genericPath, rootGeneric, { existsSync, lstatSync, realpathSync })) {
    results.push({ label: 'INSTANCE INSTRUCTIONS', path: genericPath });
  }

  const preferredName = activeRuntime === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const preferredPath = path.join(instanceDir, preferredName);
  const rootPreferred = path.join(zylosDir, preferredName);
  if (isCustomInstanceInstructionFile(preferredPath, rootPreferred, { existsSync, lstatSync, realpathSync })) {
    results.push({ label: 'INSTANCE RUNTIME INSTRUCTIONS', path: preferredPath });
    return results;
  }

  if (activeRuntime === 'codex') {
    const legacyClaudePath = path.join(instanceDir, 'CLAUDE.md');
    const rootClaude = path.join(zylosDir, 'CLAUDE.md');
    if (isCustomInstanceInstructionFile(legacyClaudePath, rootClaude, { existsSync, lstatSync, realpathSync })) {
      results.push({ label: 'LEGACY INSTANCE RUNTIME INSTRUCTIONS', path: legacyClaudePath });
    }
  }

  return results;
}
