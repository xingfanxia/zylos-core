import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DEFAULT_MEMORY_DIR = path.join(DEFAULT_ZYLOS_DIR, 'memory');
const DEFAULT_INSTANCES_FILE = path.join(DEFAULT_ZYLOS_DIR, 'instances.json');

function readInstancesConfig(instancesFilePath, readFileSync = fs.readFileSync) {
  try {
    return JSON.parse(readFileSync(instancesFilePath, 'utf8'));
  } catch {
    return null;
  }
}

export function isSchedulerInstance({
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  instancesFilePath = DEFAULT_INSTANCES_FILE,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!instanceId) return false;
  const config = readInstancesConfig(instancesFilePath, readFileSync);
  if (!config) return false;
  const schedulerId = config.scheduler_instance ?? config.default_instance;
  return schedulerId === instanceId;
}

export function isPrimaryInstance({
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  instancesFilePath = DEFAULT_INSTANCES_FILE,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!instanceId) return true;
  const config = readInstancesConfig(instancesFilePath, readFileSync);
  if (!config) return true;
  return config.instances?.[instanceId]?.primary === true;
}

function isInside(basePath, targetPath) {
  return targetPath === basePath || targetPath.startsWith(basePath + path.sep);
}

function resolveThroughExistingAncestor(absPath, {
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  let current = absPath;
  const suffix = [];

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return absPath;
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }

  try {
    return path.join(realpathSync(current), ...suffix);
  } catch {
    return absPath;
  }
}

function validateSharedLikePath(segments, {
  instanceId,
  instancesFilePath,
  readFileSync,
} = {}) {
  if (!isPrimaryInstance({ instanceId, instancesFilePath, readFileSync }) &&
      !isSchedulerInstance({ instanceId, instancesFilePath, readFileSync })) {
    return `Non-primary instance '${instanceId}' cannot write to shared memory`;
  }
  return null;
}

function validateUserProfilePath(segments) {
  const offset = segments[0] === 'shared' ? 1 : 0;
  if (segments[offset] !== 'users') return null;

  const userId = segments[offset + 1] || '';
  const fileName = segments[offset + 2] || '';
  const hasExtraSegments = segments.length !== offset + 3;

  if (!userId || fileName !== 'profile.md' || hasExtraSegments) {
    return 'Only users/<id>/profile.md may be written in shared user memory';
  }

  return null;
}

function validateResolvedMemoryPath(resolvedPath, {
  memoryDir,
  instanceId,
  instancesFilePath,
  readFileSync,
} = {}) {
  const relPath = path.relative(memoryDir, resolvedPath);
  const segments = relPath.split(path.sep).filter(Boolean);

  if (segments.length === 0) {
    return 'Direct writes to the memory root are not allowed';
  }

  if (segments[0] === 'instances') {
    const targetInstanceId = segments[1];
    if (!targetInstanceId) {
      return 'Use instances/<id>/... when writing instance memory';
    }
    if (targetInstanceId !== instanceId && instanceId) {
      return `Cannot write to instance '${targetInstanceId}' memory from instance '${instanceId}'`;
    }
    return null;
  }

  if (segments[0] === 'shared' && segments[1] === 'users') {
    return validateUserProfilePath(segments);
  }

  if (segments[0] === 'users') {
    return validateUserProfilePath(segments);
  }

  if (segments[0] === 'shared') {
    return validateSharedLikePath(segments, { instanceId, instancesFilePath, readFileSync });
  }

  if (segments[0] === 'archive' || segments[0] === 'reference') {
    return validateSharedLikePath(segments, { instanceId, instancesFilePath, readFileSync });
  }

  return `Direct writes to top-level memory path '${segments[0]}' are not allowed in multi-session mode`;
}

export function validateMemoryWrite(filePath, {
  zylosDir = DEFAULT_ZYLOS_DIR,
  memoryDir = DEFAULT_MEMORY_DIR,
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  instancesFilePath = path.join(zylosDir, 'instances.json'),
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const absPath = path.resolve(filePath);

  if (!isInside(memoryDir, absPath)) {
    return null;
  }

  if (!instanceId) {
    return null;
  }

  const resolvedPath = resolveThroughExistingAncestor(absPath, { existsSync, realpathSync });
  if (!isInside(memoryDir, resolvedPath)) {
    return `Memory write path escapes the memory directory: ${filePath}`;
  }

  return validateResolvedMemoryPath(resolvedPath, {
    memoryDir,
    instanceId,
    instancesFilePath,
    readFileSync,
  });
}

export function describeMemoryWritePolicy({
  instanceId = process.env.ZYLOS_INSTANCE_ID || null,
  instancesFilePath = DEFAULT_INSTANCES_FILE,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!instanceId) {
    return [
      'Single-session mode: memory writes follow the legacy flat layout under ~/zylos/memory/.',
      'Prefer identity.md, state.md, references.md, users/<id>/profile.md, reference/*.md, and sessions/current.md.',
    ].join('\n');
  }

  const isPrimary = isPrimaryInstance({ instanceId, instancesFilePath, readFileSync });
  const isScheduler = isSchedulerInstance({ instanceId, instancesFilePath, readFileSync });

  if (isPrimary) {
    return [
      `Instance '${instanceId}' is primary.`,
      `Allowed writes: memory/instances/${instanceId}/..., memory/shared/..., memory/archive/..., and memory/users/<id>/profile.md.`,
      'Never write another instance\'s memory directory.',
    ].join('\n');
  }

  if (isScheduler) {
    return [
      `Instance '${instanceId}' is the scheduler instance.`,
      `Allowed writes: memory/instances/${instanceId}/..., memory/shared/... for cross-instance sync, memory/archive/..., and memory/users/<id>/profile.md.`,
      'Never write another instance\'s memory directory.',
    ].join('\n');
  }

  return [
    `Instance '${instanceId}' is a non-primary worker/user instance.`,
    `Allowed writes: memory/instances/${instanceId}/... and memory/users/<id>/profile.md only.`,
    'Do not write memory/shared/..., memory/archive/..., top-level memory/*.md, or another instance\'s memory directory.',
  ].join('\n');
}
