import fs from 'node:fs';
import path from 'node:path';

const SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;
const VALID_SIGNAL_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function signalKey(instanceId) {
  const key = instanceId || 'single';
  if (!VALID_SIGNAL_KEY.test(key)) throw new Error('invalid runtime switch signal key');
  return key;
}

export function runtimeSwitchSignalPath({ zylosDir, instanceId } = {}) {
  if (!zylosDir) throw new Error('runtime switch signal requires zylosDir');
  return path.join(zylosDir, '.zylos', 'runtime-switches', `${signalKey(instanceId)}.json`);
}

export function writeRuntimeSwitchSignal({
  zylosDir,
  change,
  nowMs = Date.now(),
  graceSec = 30,
} = {}) {
  if (!change?.toProfile) throw new Error('runtime switch signal requires target profile');
  const instanceId = change.singleSession ? 'single' : change.instanceId;
  const signalPath = runtimeSwitchSignalPath({ zylosDir, instanceId });
  const signalDir = path.dirname(signalPath);
  fs.mkdirSync(signalDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(signalDir, 0o700);
  const tmp = `${signalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: 1,
    instance_id: change.instanceId,
    from_profile: change.fromProfile,
    to_profile: change.toProfile,
    reason: change.reason,
    switched_at: new Date(nowMs).toISOString(),
    grace_sec: graceSec,
  }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, signalPath);
  return signalPath;
}

export function consumeRuntimeSwitchSignal({
  zylosDir,
  instanceId,
  activeProfile,
  nowMs = Date.now(),
} = {}) {
  const signalPath = runtimeSwitchSignalPath({ zylosDir, instanceId });
  let signal;
  try { signal = JSON.parse(fs.readFileSync(signalPath, 'utf8')); } catch { return null; }

  const switchedAtMs = Date.parse(signal?.switched_at || '');
  const valid = signal?.version === 1
    && typeof signal?.to_profile === 'string'
    && signal.to_profile === activeProfile
    && Number.isFinite(switchedAtMs)
    && nowMs >= switchedAtMs
    && nowMs - switchedAtMs <= SIGNAL_MAX_AGE_MS;
  try { fs.unlinkSync(signalPath); } catch { /* already consumed */ }
  if (!valid) return null;

  return {
    ...signal,
    grace_sec: Math.min(300, Math.max(5, Number(signal.grace_sec) || 30)),
  };
}
