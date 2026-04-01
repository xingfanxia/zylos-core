import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

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

export function getInstanceRuntime({
  zylosDir = DEFAULT_ZYLOS_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!instanceId) {
    return getConfiguredRuntime({ zylosDir, readFileSync });
  }

  const instances = readJsonSafe(path.join(zylosDir, 'instances.json'), readFileSync);
  const runtime = instances?.instances?.[instanceId]?.runtime;
  if (typeof runtime === 'string' && runtime.length > 0) {
    return runtime;
  }

  return getConfiguredRuntime({ zylosDir, readFileSync });
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
    return path.resolve(realpathSync(filePath)) !== path.resolve(rootPath);
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
