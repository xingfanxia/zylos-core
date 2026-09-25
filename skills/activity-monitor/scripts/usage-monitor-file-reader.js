import fs from 'node:fs';

function parseJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatResetTime(epochSeconds) {
  if (!epochSeconds) return null;

  try {
    const resetAt = new Date(epochSeconds * 1000);
    const now = new Date();
    const sameDay =
      resetAt.getFullYear() === now.getFullYear() &&
      resetAt.getMonth() === now.getMonth() &&
      resetAt.getDate() === now.getDate();

    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(resetAt);

    if (sameDay) return time;

    const date = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short'
    }).format(resetAt);

    return `${time} on ${date}`;
  } catch {
    return null;
  }
}

function normalizePersistedUsage(snapshot, statusShape = 'persisted_usage') {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const sessionPercent = snapshot.session?.percent;
  const weeklyAllPercent = snapshot.weeklyAll?.percent;
  const weeklySonnetPercent = snapshot.weeklySonnet?.percent;
  const fiveHourPercent = snapshot.fiveHour?.percent;

  if (
    sessionPercent == null &&
    weeklyAllPercent == null &&
    weeklySonnetPercent == null &&
    fiveHourPercent == null
  ) {
    return null;
  }

  return {
    sessionPercent: sessionPercent ?? null,
    sessionResets: snapshot.session?.resets ?? null,
    sessionResetsAt: snapshot.session?.resets_at ?? null,
    weeklyAllPercent: weeklyAllPercent ?? null,
    weeklyAllResets: snapshot.weeklyAll?.resets ?? null,
    weeklyAllResetsAt: snapshot.weeklyAll?.resets_at ?? null,
    weeklySonnetPercent: weeklySonnetPercent ?? null,
    weeklySonnetResets: snapshot.weeklySonnet?.resets ?? null,
    fiveHourPercent: fiveHourPercent ?? null,
    fiveHourResets: snapshot.fiveHour?.resets ?? null,
    // Raw reset epoch — persisted usage.json stores only formatted strings, so
    // this is usually null here; the statusline path below carries the real epoch.
    fiveHourResetsAt: snapshot.fiveHour?.resets_at ?? null,
    statusShape
  };
}

function normalizeClaudeStatusline(status) {
  if (!status || typeof status !== 'object') return null;

  if (status.usage && typeof status.usage === 'object') {
    const normalized = normalizePersistedUsage(status.usage, 'statusline_usage');
    if (normalized) return normalized;
  }

  const rateLimits = status.rate_limits;
  if (rateLimits && typeof rateLimits === 'object') {
    const primary = rateLimits.primary;
    const secondary = rateLimits.secondary;
    const sonnet = rateLimits.sonnet;

    const sessionPercent = primary?.used_percent ?? null;
    const weeklyAllPercent = secondary?.used_percent ?? null;
    const weeklySonnetPercent = sonnet?.used_percent ?? null;

    if (
      sessionPercent != null ||
      weeklyAllPercent != null ||
      weeklySonnetPercent != null
    ) {
      return {
        sessionPercent,
        sessionResets: formatResetTime(primary?.resets_at ?? null),
        sessionResetsAt: primary?.resets_at ?? null,
        weeklyAllPercent,
        weeklyAllResets: formatResetTime(secondary?.resets_at ?? null),
        weeklyAllResetsAt: secondary?.resets_at ?? null,
        weeklySonnetPercent,
        weeklySonnetResets: formatResetTime(sonnet?.resets_at ?? null),
        fiveHourPercent: null,
        fiveHourResets: null,
        fiveHourResetsAt: null,
        statusShape: 'statusline_rate_limits'
      };
    }

    // Format B: five_hour/seven_day keys with used_percentage (Claude Code 2.1.x+)
    const fiveHour = rateLimits.five_hour;
    const sevenDay = rateLimits.seven_day;
    const fiveHourPercent = fiveHour?.used_percentage ?? null;
    const weeklyAllPercentB = sevenDay?.used_percentage ?? null;

    if (fiveHourPercent != null || weeklyAllPercentB != null) {
      return {
        sessionPercent: status.context_window?.used_percentage ?? null,
        sessionResets: null,
        sessionResetsAt: null,
        weeklyAllPercent: weeklyAllPercentB,
        weeklyAllResets: formatResetTime(sevenDay?.resets_at ?? null),
        weeklyAllResetsAt: sevenDay?.resets_at ?? null,
        weeklySonnetPercent: null,
        weeklySonnetResets: null,
        fiveHourPercent,
        fiveHourResets: formatResetTime(fiveHour?.resets_at ?? null),
        fiveHourResetsAt: fiveHour?.resets_at ?? null,
        statusShape: 'statusline_rate_limits'
      };
    }
  }

  return normalizePersistedUsage(status, 'statusline_persisted_usage');
}

/**
 * Read + normalize a single statusline.json with an explicit error code, so
 * callers can degrade LOUDLY. Unlike readClaudeUsageFromMonitorFiles (which
 * swallows every failure to null), this distinguishes:
 *   - 'ENOENT'  file never written (benign — instance idle/new)
 *   - 'EACCES'  permission denied (actionable — frozen supplementary groups)
 *   - 'EPARSE'  unparseable JSON
 *   - 'EINVALID' parsed but no recognizable usage shape
 * On success returns { error: null, reading }.
 * @returns {{ error: string | null, reading: object | null }}
 */
export function readStatuslineWithDiagnostics(statuslineFile) {
  let raw;
  try {
    raw = fs.readFileSync(statuslineFile, 'utf8');
  } catch (err) {
    return { error: err.code || 'EREAD', reading: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'EPARSE', reading: null };
  }
  const reading = normalizeClaudeStatusline(parsed);
  if (!reading) return { error: 'EINVALID', reading: null };
  return { error: null, reading };
}

export function readClaudeUsageFromMonitorFiles({ statuslineFile, usageStateFile }) {
  const statusline = parseJsonFile(statuslineFile);
  const fromStatusline = normalizeClaudeStatusline(statusline);
  if (fromStatusline) return fromStatusline;

  const usageState = parseJsonFile(usageStateFile);
  return normalizePersistedUsage(usageState, 'usage_json');
}

export function readCodexUsageFromMonitorFile({ usageStateFile }) {
  const usageState = parseJsonFile(usageStateFile);
  return normalizePersistedUsage(usageState, 'usage_codex_json');
}
