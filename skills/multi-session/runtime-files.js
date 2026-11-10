import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'node:crypto';

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

const FABLE_CLOCK_SKEW_MS = 30_000;
export const FABLE_LAUNCH_FILE = 'fable-launch.json';

/** The account's last valid observation, unless the local clock says it is from the future. */
export function fableLastObservation(entry, nowMs) {
  const obs = entry?.last_valid;
  const observedMs = Date.parse(obs?.observed_at || '');
  if (!obs || !Number.isFinite(observedMs) || observedMs > nowMs + FABLE_CLOCK_SKEW_MS) return null;
  if (!Number.isFinite(Number(obs.utilization)) || !Number.isFinite(Date.parse(obs.resets_at || ''))) return null;
  return obs;
}

/** Lease: a valid observation younger than lease_sec whose window has not reset. */
export function fableLeaseObservation(entry, nowMs, config) {
  const obs = fableLastObservation(entry, nowMs);
  if (!obs) return null;
  return nowMs - Date.parse(obs.observed_at) < config.lease_sec * 1000 && Date.parse(obs.resets_at) > nowMs ? obs : null;
}

/**
 * Fable admission for one launch of one persona, re-evaluated on every launch
 * and by the persona's monitor (lease enforcement). null = the feature is inert
 * for this persona. Fable needs ALL of: an account with its own settings file,
 * the guard's committed Fable for exactly this account, no hold, and a fresh
 * lease below the threshold. The committed state alone is never enough: it
 * can be arbitrarily old when the guard daemon is dead or hung.
 */
export function fableAdmission({ document, instanceId, profileId, guardState = null, usage = null, nowMs = Date.now() } = {}) {
  const config = readFableGuardConfig(document);
  const instance = instanceId ? document?.instances?.[instanceId] : null;
  if (!config || instance?.fable_enabled !== true) return null;
  const desired = guardState?.personas?.[instanceId]?.desired;
  const generation = Number.isInteger(desired?.generation) ? desired.generation : null;
  const holds = guardState?.holds?.[profileId];
  const holdKinds = holds && typeof holds === 'object' ? Object.keys(holds).sort() : [];
  const lease = fableLeaseObservation(usage?.accounts?.[profileId], nowMs, config);
  let reason = 'admitted';
  if (!fableAccountSettingsFile(document, profileId)) reason = 'unsupported_account';
  else if (desired?.mode !== 'fable' || generation === null) reason = 'not_committed';
  else if (desired.account !== profileId || instance.runtime_profile !== profileId) reason = 'account_mismatch';
  else if (holdKinds.length) reason = `hold:${holdKinds.join('+')}`;
  else if (!lease) reason = 'lease_expired';
  else if (!(Number(lease.utilization) < config.threshold)) reason = 'threshold';
  return { admitted: reason === 'admitted', reason, generation, config };
}

/**
 * Launch decision for one persona. null = feature inert for this persona (not
 * configured or not fable_enabled): the launch is byte-for-byte unchanged.
 */
export function resolveFableLaunch({ document, instanceId, profileId, guardState = null, usage = null, nowMs = Date.now() } = {}) {
  const admission = fableAdmission({ document, instanceId, profileId, guardState, usage, nowMs });
  if (!admission) return null;
  return {
    mode: admission.admitted ? 'fable' : 'opus',
    model: admission.admitted ? admission.config.fable_model : null,
    generation: admission.generation,
    reason: admission.reason,
    env: {
      CLAUDE_CODE_SUBAGENT_MODEL: admission.config.subagent_model,
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    },
  };
}

/**
 * Identity of a launch policy: account, mode, main model, effort, settings
 * file and the launch env. The launcher records it for every launch of a
 * guard-tracked persona; the guard compares it with the committed policy.
 */
export function fableLaunchKey({ account = null, mode = 'opus', model = null, effort = null, settings = null, env = {} } = {}) {
  const entries = Object.entries(env || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([account, mode, model, effort, settings, entries]);
}

function launchKeyOfProfile(profile) {
  return fableLaunchKey({ account: profile.id || null, mode: profile.fable?.mode === 'fable' ? 'fable' : 'opus',
    model: profile.model || null, effort: profile.reasoningEffort || null, settings: profile.claudeSettingsFile || null,
    env: profile.launchEnv || {} });
}

/** The launch the guard expects for a persona in `mode` under the current document. */
export function expectedFableLaunch({ document, instanceId, mode, homeDir = os.homedir() } = {}) {
  const profile = resolveRuntimeProfile({ document, instanceId, homeDir });
  const config = readFableGuardConfig(document);
  const enabled = Boolean(profile.fable);
  const model = mode === 'fable' && config ? config.fable_model : (profile.baseModel ?? profile.model);
  const launched = { ...profile, model, fable: enabled ? { mode } : undefined, launchEnv: enabled ? profile.launchEnv : {} };
  return { account: profile.id, mode, model, key: launchKeyOfProfile(launched) };
}

function instanceMonitorDir(zylosDir, instanceId, instance) {
  if (typeof instance?.state_dir === 'string' && instance.state_dir) return instance.state_dir.replace(/^~/, os.homedir());
  return path.join(zylosDir, 'activity-monitor', instanceId);
}

export function fableLaunchRecordPath({ zylosDir = DEFAULT_ZYLOS_DIR, instanceId, instance = null, monitorDir = null } = {}) {
  return path.join(monitorDir || instanceMonitorDir(zylosDir, instanceId, instance), FABLE_LAUNCH_FILE);
}

/**
 * Called by the Claude adapter on EVERY launch (including Guardian relaunches
 * that reuse the profile resolved when the monitor started). For a persona the
 * guard does not track it returns `profile` itself and writes nothing. For a
 * tracked persona whose monitor started with a Fable decision it re-evaluates
 * admission now; a stale lease, a new hold or a newer Opus commit launches the
 * profile's own model (the safe direction only). It then records the launch
 * (fable-launch.json in the persona's monitor dir) for the guard to verify.
 */
export function prepareFableLaunch({
  profile,
  instanceId = null,
  zylosDir = DEFAULT_ZYLOS_DIR,
  monitorDir = null,
  nowMs = Date.now(),
  readFileSync = fs.readFileSync,
  writeRecord = writeLaunchRecord,
} = {}) {
  const id = instanceId || profile?.fable?.instanceId || null;
  if (!profile || !id || (profile.runtime && profile.runtime !== 'claude')) return profile;
  const document = readJsonSafe(path.join(zylosDir, 'instances.json'), readFileSync);
  const config = readFableGuardConfig(document);
  const guardState = readJsonSafe(fableGuardStatePath(zylosDir), readFileSync);
  const tracked = Boolean(profile.fable)
    || (Boolean(config) && document?.instances?.[id]?.fable_enabled === true)
    || Boolean(guardState?.personas?.[id]);
  if (!tracked) return profile;
  let launched = profile;
  if (profile.fable) {
    const usage = config ? readJsonSafe(fableUsagePath(zylosDir), readFileSync) : null;
    const decision = document
      ? resolveFableLaunch({ document, instanceId: id, profileId: profile.id, guardState, usage, nowMs })
      : null;
    const { fable: _fable, launchEnv: _env, baseModel = profile.model, ...rest } = profile;
    launched = decision
      ? { ...rest, baseModel, model: decision.model || baseModel, launchEnv: decision.env,
        fable: { mode: decision.mode, generation: decision.generation, reason: decision.reason, instanceId: id } }
      : { ...rest, model: baseModel }; // disabled or unconfigured since the monitor started
  }
  const record = {
    version: 1,
    launch_id: randomUUID(),
    instance_id: id,
    launched_at_ms: nowMs,
    runtime_profile: launched.id || null,
    mode: launched.fable?.mode === 'fable' ? 'fable' : 'opus',
    model: launched.model || null,
    generation: Number.isInteger(guardState?.personas?.[id]?.desired?.generation)
      ? guardState.personas[id].desired.generation : null,
    reason: launched.fable?.reason || (launched.fable ? null : 'not_enabled'),
    key: launchKeyOfProfile(launched),
    pid: process.pid,
  };
  try {
    writeRecord(fableLaunchRecordPath({ zylosDir, instanceId: id, instance: document?.instances?.[id], monitorDir }), record);
  } catch { /* the guard treats a missing record as an unverified launch */ }
  return launched;
}

function writeLaunchRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, filePath);
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
  fableUsage = null,
  nowMs = Date.now(),
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
    ? resolveFableLaunch({ document, instanceId, profileId, guardState: fableGuardState, usage: fableUsage, nowMs })
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
    ...(fable ? { baseModel: model, launchEnv: fable.env,
      fable: { mode: fable.mode, generation: fable.generation, reason: fable.reason, instanceId } } : {}),
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
    const guarded = Boolean(readFableGuardConfig(document));
    return resolveRuntimeProfile({
      document: document || {},
      instanceId,
      homeDir,
      configuredRuntime,
      fableGuardState: guarded ? readJsonSafe(fableGuardStatePath(zylosDir), readFileSync) : null,
      fableUsage: guarded ? readJsonSafe(fableUsagePath(zylosDir), readFileSync) : null,
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
