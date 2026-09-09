import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const read = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const label = id => ({ admin: '管理员助手', group: '群助手', scheduler: '定时任务助手' }[id] || id.replace(/^user-/, '').replace(/^./, c => c.toUpperCase()));
const profile = id => id === 'codex-azure' ? 'Azure' : id === 'codex-subscription' ? 'Codex 订阅' : id === 'claude-subscription' ? 'Claude 订阅' : '备用线路';
const money = value => `$${(value / 1e6).toFixed(2)}`;

export function formatBeijingReset(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `北京时间 ${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date)}`;
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function subscriptionLines(usage, nowMs) {
  const data = usage?.providers?.codex;
  const observed = Date.parse(data?.observed_at || data?.fetched_at || '');
  if (!data?.available || data.quota_authoritative !== true || !Number.isFinite(observed)
      || nowMs - observed > 180_000 || observed > nowMs + 30_000) return ['Codex 订阅的最新用量暂时取不到。'];
  const lines = [];
  for (const window of [data.primary, data.secondary, data.tertiary]) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    const reset = Date.parse(window.resets_at || '');
    if (Number.isFinite(reset) && reset <= nowMs) continue;
    const name = window.window_minutes >= 10080 ? '本周额度' : window.window_minutes === 300 ? '最近 5 小时额度' : '订阅额度';
    lines.push(`Codex ${name}已用 ${window.used_percent}%，剩余 ${Math.max(0, 100 - window.used_percent)}%。`);
    if (Number.isFinite(reset)) lines.push(`重置时间：${formatBeijingReset(new Date(reset).toISOString())}。`);
  }
  return lines.length ? lines : ['Codex 订阅的最新用量暂时取不到。'];
}

export function budgetLines(budget, nowMs) {
  const checked = Date.parse(budget?.checked_at || '');
  const numeric = ['limit_microusd', 'spent_microusd', 'pending_microusd', 'available_microusd'];
  if (!Number.isFinite(checked) || nowMs - checked > 180_000 || checked > nowMs + 30_000
      || numeric.some(key => !Number.isFinite(budget?.[key]) || budget[key] < 0)
      || !Array.isArray(budget?.members) || !budget.members.length
      || budget.billing_basis !== 'published_openai_token_equivalent') {
    return ['Azure 月额度暂时取不到，不能把未知用量当成零；原有额度限制继续生效。'];
  }
  return [
    `${budget.members.map(label).join('、')} 三人共用的本月 Azure 预算 ${money(budget.limit_microusd)}（${budget.month_utc}，每月 1 日北京时间 08:00 重置）。`,
    `已用 ${money(budget.spent_microusd)}，正在处理的请求预留 ${money(budget.pending_microusd)}，还可用 ${money(budget.available_microusd)}。`,
    '以上按用量折算。管理员、群助手和定时任务助手不计入这笔共享预算，暂无它们的独立花费读数。',
  ];
}

export async function readSwitchBudget(config, { fetchImpl = fetch } = {}) {
  if (!config?.budget_token_file) return null;
  try {
    const token = fs.readFileSync(config.budget_token_file.replace(/^~/, os.homedir()), 'utf8').trim();
    // Existing read-only observer only. No upstream model key or budget mutation.
    const response = await fetchImpl('http://127.0.0.1:18770/budget', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

export function formatSwitchNotice(event, phase, usage, budget, nowMs) {
  const names = event.changes.map(change => label(change.instanceId)).join('、');
  const routes = [...new Set(event.changes.map(change => `${profile(change.fromProfile)} → ${profile(change.toProfile)}`))].join('；');
  const reason = event.changes.some(change => change.reason.startsWith('usage_exhausted'))
    ? '订阅额度接近上限，为了让任务继续进行，系统开始切换线路。'
    : event.changes.every(change => change.reason.startsWith('preferred_provider_recovered'))
      ? '订阅额度已经恢复，系统开始切回订阅，减少 Azure 花费。'
      : '原来的线路没有正常回应，系统开始尝试另一条可用线路。';
  const outcome = phase === 'started' ? ['🔄 正在切换助手线路', reason, '正在启动并检查新线路；还没有确认恢复。']
    : phase === 'ready' ? ['✅ 助手线路切换完成', '新线路已经实际回应了检查，可以继续接收任务。']
      : phase === 'superseded' ? ['⚠️ 上一次线路切换已被后续切换替代', '原目标未完成全部恢复确认，请以后续线路检查结果为准。']
        : ['⚠️ 线路切换尚未恢复正常', '切换后仍未收到所有助手的正常回应，不能算恢复成功。系统会继续检查，确认恢复后再通知。'];
  return [...outcome, `涉及助手：${names}。`, `线路：${routes}。`,
    ...subscriptionLines(usage, nowMs), ...budgetLines(budget, nowMs)].join('\n');
}

export function switchReady(change, status, instance, nowMs) {
  return instance?.runtime_profile === change.toProfile
    && instance.runtime_profile_changed_at === change.changedAt
    && status?.runtime_profile === change.toProfile && status.health === 'ok'
    && ['idle', 'busy'].includes(status.state)
    && Number(status.runtime_launch_at) >= Date.parse(change.changedAt)
    && Number(status.functional_ack_at) >= Number(status.runtime_launch_at)
    && Number(status.functional_ack_at) <= nowMs
    && Number(status.last_check) * 1000 >= nowMs - 60_000
    && Number(status.last_check) * 1000 <= nowMs + 30_000;
}

export function sendToAdmin({ zylosDir, endpoint, message, phase }, { exec = execFileSync } = {}) {
  exec(process.execPath, [path.join(zylosDir, '.claude/skills/comm-bridge/scripts/c4-send.js'),
    `--delivery-action=runtime-switch-${phase}`, 'feishu', endpoint], {
    input: message, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
    env: { ...process.env, ZYLOS_DIR: zylosDir, ZYLOS_INSTANCE_ID: 'admin' },
  });
}

/** Single failover-daemon writer. Event discovery uses committed profile timestamps,
 * so a crash after the profile write cannot lose the notice. Initial enablement
 * establishes a watermark without replaying old incidents. Retries are durable
 * and bounded to one attempt per event/minute; no sends to persona/group routes. */
export async function processSwitchNotices({ zylosDir, nowMs = Date.now(), send = sendToAdmin,
  getBudget = readSwitchBudget, log = console.log } = {}) {
  const document = read(path.join(zylosDir, 'instances.json'));
  const config = document.runtime_failover?.notifications;
  if (config?.enabled !== true) return;
  const endpoint = document.instances?.admin?.chat_ids?.[0];
  if (!endpoint || endpoint !== config.admin_chat_id) {
    log('[runtime-switch-notices] verified admin route missing or changed; refusing delivery');
    return;
  }
  const file = path.join(zylosDir, '.zylos', 'runtime-switch-notices.json');
  const state = read(file, null);
  const current = Object.entries(document.instances || {}).filter(([, item]) => item.runtime_profile_changed_at);
  if (!state && fs.existsSync(file)) throw new Error('unreadable runtime switch notice state');
  if (!state) {
    save(file, { version: 1, seen: Object.fromEntries(current.map(([id, item]) => [id, { changedAt: item.runtime_profile_changed_at, profile: item.runtime_profile }])), events: [] });
    return;
  }
  if (state.version !== 1 || !state.seen || !Array.isArray(state.events)) throw new Error('invalid runtime switch notice state');
  const batches = new Map();
  for (const [id, instance] of current) {
    if (state.seen[id]?.changedAt === instance.runtime_profile_changed_at) continue;
    const at = instance.runtime_profile_changed_at;
    const reason = instance.runtime_profile_change_reason || '';
    if (!Number.isFinite(Date.parse(at))) continue;
    const event = batches.get(at) || { id: at, changes: [], sent: {}, nextAttemptAt: 0 };
    const fromProfile = state.seen[id]?.profile || null;
    event.changes.push({ instanceId: id, changedAt: at, toProfile: instance.runtime_profile, fromProfile, reason });
    batches.set(at, event);
    state.seen[id] = { changedAt: at, profile: instance.runtime_profile };
  }
  state.events.push(...batches.values());
  save(file, state);
  let budget;
  for (const event of state.events) {
    if (event.complete || nowMs < event.nextAttemptAt) continue;
    let phase = 'started';
    if (event.sent.started) {
      const superseded = event.changes.some(change => document.instances[change.instanceId]?.runtime_profile_changed_at !== change.changedAt);
      const ready = event.changes.every(change => {
        const instance = document.instances[change.instanceId];
        const dir = instance?.state_dir?.replace(/^~/, os.homedir()) || path.join(zylosDir, 'activity-monitor', change.instanceId);
        return switchReady(change, read(path.join(dir, 'agent-status.json')), instance, nowMs);
      });
      phase = superseded ? 'superseded' : ready ? 'ready' : nowMs - Date.parse(event.id) >= 300_000 ? 'delayed' : null;
      if (!phase || event.sent[phase]) continue;
    }
    event.nextAttemptAt = nowMs + 60_000;
    save(file, state); // Persist backoff before network I/O, including restart failures.
    if (budget === undefined) budget = await getBudget(config);
    try {
      const usage = read(path.join(zylosDir, 'activity-monitor/provider-usage.json'));
      await send({ zylosDir, endpoint, eventId: event.id, phase, message: formatSwitchNotice(event, phase, usage, budget, nowMs) });
      event.sent[phase] = new Date(nowMs).toISOString();
      if (phase === 'ready' || phase === 'superseded') event.complete = true;
    } catch { log(`[runtime-switch-notices] delivery failed; retry scheduled (${phase})`); }
    save(file, state);
  }
  state.events = state.events.filter(event => !event.complete || nowMs - Date.parse(event.id) < 7 * 86400_000);
  save(file, state);
}
