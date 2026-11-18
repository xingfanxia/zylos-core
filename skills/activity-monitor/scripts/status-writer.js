import fs from 'node:fs';
import path from 'node:path';
import { HOOK_ERRORS } from './health-evidence.js';
import { DELIVERY_STUCK_REASON } from '../../comm-bridge/scripts/c4-config.js';

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function readInitialStatus({ statusFile }) {
  try {
    if (!fs.existsSync(statusFile)) return { health: 'ok' };
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // A delivery backlog was reported over a healthy engine: start healthy.
    if (status?.unavailable_reason === DELIVERY_STUCK_REASON) {
      const { unavailable_reason: _reason, delivery_stuck: _stuck, ...rest } = status;
      return { ...rest, health: 'ok' };
    }
    if (status && typeof status.health === 'string') {
      return status;
    }
  } catch {
    // Fall through to fail-open health.
  }
  return { health: 'ok' };
}

export function publicHealth(health) {
  // The dispatcher holds delivery on any health !== 'ok'; 'degraded' passes
  // through verbatim so held-reason logs and the dashboard show the real state.
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed' || health === 'degraded') {
    return health;
  }
  return 'unavailable';
}

export function buildStatusPayload({ statusObj, healthEngine, deliveryStuck = null }) {
  const health = publicHealth(healthEngine.health);
  const extra = {};
  const evidence=healthEngine.evidence?.store.read();
  if (evidence) {
    extra.health_episode = `${healthEngine.evidence.store.runtime}:${evidence.episode}`;
    extra.health_revision = evidence.revision;
    const notice = healthEngine.evidence.notice?.() ?? evidence.notice;
    if (notice && evidence.health === health) {
      extra.health_notice = { noticeCode:notice.noticeCode, resetAt:notice.resetAt };
    }
    const hook = evidence.last_hook;
    if (hook && hook.session_id === evidence.session_id && hook.claude_pid === evidence.hook_pid &&
      typeof hook.session_id === 'string' && hook.session_id.length > 0 && ['stop', 'stop_failure'].includes(hook.event) &&
      typeof hook.event_id === 'string' && hook.event_id.length <= 200 &&
      Number.isSafeInteger(hook.claude_pid) && hook.claude_pid > 0 &&
      Number.isSafeInteger(hook.observed_at)) {
      extra.last_hook = {
        event_id: hook.event_id,
        event: hook.event,
        error: hook.event === 'stop_failure' ? (HOOK_ERRORS.has(hook.error) ? hook.error : 'unknown') : null,
        observed_at: hook.observed_at,
      };
    }
  }
  if (health === 'rate_limited') {
    extra.rate_limit_reset = healthEngine.rateLimitResetTime || null;
    extra.cooldown_until = healthEngine.cooldownUntil || null;
  }
  if (healthEngine.healthReason) {
    extra.unavailable_reason = evidence?.reason ?? healthEngine.healthReason;
  }
  if (health === 'unavailable' && healthEngine.unavailableSince) {
    extra.unavailable_since = healthEngine.unavailableSince;
  }
  // Inbound messages undelivered for > 10 min while the session is free
  // (dialog-watch.js): a healthy engine is not reported as ok. Only over 'ok',
  // so an engine state with its own handling is never masked. The dispatcher
  // does not hold delivery on this reason (c4-config DELIVERY_STUCK_REASON).
  if (health === 'ok' && deliveryStuck) {
    delete extra.health_notice;
    return { ...statusObj, ...extra, health: 'unavailable', unavailable_reason: DELIVERY_STUCK_REASON,
      delivery_stuck: deliveryStuck };
  }
  return { ...statusObj, ...extra, health };
}

export function writeStatus({ statusFile, statusObj, healthEngine, deliveryStuck = null }) {
  try {
    ensureParentDir(statusFile);
    atomicWriteJson(statusFile, buildStatusPayload({ statusObj, healthEngine, deliveryStuck }));
    return true;
  } catch {
    return false;
  }
}
