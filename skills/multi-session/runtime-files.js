import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const VALID_OS_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_MODEL = /^[A-Za-z0-9._:-]+$/;
const VALID_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra']);

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

  const usageProvider = raw?.usage_provider === 'claude' || raw?.usage_provider === 'codex'
    ? raw.usage_provider
    : null;
  if (raw?.usage_provider != null && !usageProvider) errors.push('invalid_usage_provider');

  if (profileId && !raw) errors.push('unknown_runtime_profile');

  return {
    id: raw ? profileId : null,
    runtime,
    runtimeHome,
    codexHome,
    osUser,
    usageProvider,
    model,
    reasoningEffort,
    providerEnvKey,
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
    return resolveRuntimeProfile({
      document: document || {},
      instanceId,
      homeDir,
      configuredRuntime,
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
