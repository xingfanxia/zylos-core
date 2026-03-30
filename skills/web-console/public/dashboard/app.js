/**
 * Zylos Dashboard — frontend application.
 * Vanilla JS, no dependencies. Auto-refreshes every 5 seconds.
 */

class Dashboard {
  constructor() {
    this.data = null;
    this.tokenData = null;
    this.tokenDays = 7;
    this.refreshInterval = null;
    this.tokenRefreshInterval = null;

    this.init();
  }

  async init() {
    this.bindActions();
    await this.fetchAll();
    this.refreshInterval = setInterval(() => { this.fetchDashboard(); this.fetchPendingUsers(); }, 5000);
    this.tokenRefreshInterval = setInterval(() => this.fetchTokens(), 30000);
  }

  async fetchAll() {
    await Promise.all([
      this.fetchDashboard(),
      this.fetchTokens(),
      this.fetchPendingUsers(),
    ]);
  }

  async fetchPendingUsers() {
    try {
      const res = await fetch('/api/dashboard/pending-users');
      if (!res.ok) return;
      const data = await res.json();
      this.renderPendingUsers(data.pending || []);
    } catch { /* best-effort */ }
  }

  renderPendingUsers(pending) {
    const section = document.getElementById('pending-section');
    const container = document.getElementById('pending-users');
    const badge = document.getElementById('pending-count');
    if (!pending.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    badge.textContent = pending.length;

    // Don't re-render if user is editing an input (prevents losing typed text)
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('approve-name-input')) return;
    container.innerHTML = pending.map(p => `
      <div class="pending-card" style="display: flex; justify-content: space-between; align-items: flex-start; padding: 1rem; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.75rem;">
        <div style="flex: 1;">
          <div style="font-weight: 600; margin-bottom: 0.25rem;">${this.esc(p.user_name || p.chat_id)}</div>
          <div style="font-size: 0.85rem; color: var(--text-secondary);">${this.esc(p.channel)} &middot; ${this.esc(p.chat_id)} &middot; ${p.msg_count || '?'} held message(s)</div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem; font-style: italic;">"${this.esc((p.preview || '').substring(0, 100))}"</div>
        </div>
        <div style="display: flex; gap: 0.5rem; margin-left: 1rem;">
          <input type="text" placeholder="instance name" value="${this.esc(p.suggested_id || (p.user_name ? 'user-' + p.user_name.toLowerCase().replace(/\s+/g, '') : ''))}"
            style="padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); width: 140px; font-size: 0.85rem;"
            data-chat-id="${this.esc(p.chat_id)}" class="approve-name-input">
          <button class="btn btn-approve" data-action="approve" data-chat-id="${this.esc(p.chat_id)}"
            style="padding: 0.4rem 0.8rem; background: #16a34a; color: white; border: none; border-radius: 4px; cursor: pointer;">Approve</button>
          <button class="btn btn-deny" data-action="deny" data-chat-id="${this.esc(p.chat_id)}"
            style="padding: 0.4rem 0.8rem; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer;">Deny</button>
        </div>
      </div>
    `).join('');
  }

  async handleApproval(chatId, action) {
    const nameInput = document.querySelector(`.approve-name-input[data-chat-id="${chatId}"]`);
    const name = nameInput?.value?.trim() || undefined;
    try {
      const res = await fetch(`/api/dashboard/${action}/${encodeURIComponent(chatId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
      });
      const data = await res.json();
      if (data.ok) {
        alert(`${action === 'approve' ? 'Approved' : 'Denied'}: ${data.instance || chatId}`);
        this.fetchPendingUsers();
        this.fetchDashboard();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert(`Failed: ${err.message}`);
    }
  }

  async fetchDashboard() {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = '/';
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      this.data = await res.json();
      this.renderDashboard();
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    }
  }

  async fetchTokens() {
    try {
      const res = await fetch(`/api/dashboard/tokens?days=${this.tokenDays}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.tokenData = await res.json();
      this.renderTokens();
    } catch (err) {
      console.error('Token fetch error:', err);
    }
  }

  bindActions() {
    // Token tab clicks
    const tabs = document.getElementById('token-tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.token-tab');
        if (!tab) return;
        const days = parseInt(tab.dataset.days, 10);
        if (days === this.tokenDays) return;

        tabs.querySelectorAll('.token-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.tokenDays = days;
        this.fetchTokens();
      });
    }

    // Instance action buttons (delegated)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;

      // Handle approve/deny for pending users
      const chatId = btn.dataset.chatId;
      if (chatId && (action === 'approve' || action === 'deny')) {
        btn.disabled = true;
        btn.textContent = '...';
        await this.handleApproval(chatId, action);
        return;
      }

      const id = btn.dataset.id;
      if (!action || !id) return;

      btn.disabled = true;
      btn.textContent = '...';

      try {
        const res = await fetch(`/api/dashboard/instances/${encodeURIComponent(id)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const result = await res.json();
        if (!res.ok) {
          alert(result.error || 'Action failed');
        }
        // Refresh immediately
        await this.fetchDashboard();
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render methods
  // ---------------------------------------------------------------------------

  renderDashboard() {
    if (!this.data) return;

    this.renderSubtitle();
    this.renderSystemResources();
    this.renderSystemInfo();
    this.renderInstances();
    this.renderPm2();
  }

  renderSubtitle() {
    const el = document.getElementById('system-subtitle');
    if (!el || !this.data.system) return;
    const s = this.data.system;
    el.textContent = `${s.hostname} | ${s.platform} | ${s.cpu.cores} cores | uptime ${this.formatHours(s.uptime_hours)}`;
  }

  renderSystemResources() {
    const el = document.getElementById('system-resources');
    if (!el || !this.data.system) return;

    const { memory, disk, cpu } = this.data.system;

    let html = '';

    // Memory
    html += this.renderResourceBar(
      'Memory',
      `${memory.used_mb} MB / ${memory.total_mb} MB`,
      memory.used_percent
    );

    // Disk
    if (disk) {
      const diskPct = parseInt(disk.used_percent) || 0;
      html += this.renderResourceBar(
        'Disk',
        `${disk.used} / ${disk.total}`,
        diskPct
      );
    }

    // CPU Load
    const loadPct = Math.min(100, Math.round((cpu.load_1m / cpu.cores) * 100));
    html += this.renderResourceBar(
      'CPU Load (1m)',
      `${cpu.load_1m.toFixed(2)} / ${cpu.cores} cores`,
      loadPct
    );

    el.innerHTML = html;
  }

  renderResourceBar(name, value, percent) {
    const level = percent > 85 ? 'high' : percent > 60 ? 'medium' : 'low';
    return `
      <div class="resource-item">
        <div class="resource-label">
          <span class="name">${this.esc(name)}</span>
          <span class="value">${this.esc(value)} (${percent}%)</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${level}" style="width: ${percent}%"></div>
        </div>
      </div>
    `;
  }

  renderSystemInfo() {
    const el = document.getElementById('system-info');
    if (!el || !this.data.system) return;

    const s = this.data.system;
    const { cpu } = s;

    el.innerHTML = `
      <div class="instance-meta" style="font-size: 0.85rem;">
        <span class="label">Hostname</span>
        <span>${s.hostname}</span>
        <span class="label">Platform</span>
        <span>${s.platform}</span>
        <span class="label">CPU Cores</span>
        <span>${cpu.cores}</span>
        <span class="label">Load (1m/5m/15m)</span>
        <span>${cpu.load_1m.toFixed(2)} / ${cpu.load_5m.toFixed(2)} / ${cpu.load_15m.toFixed(2)}</span>
        <span class="label">Uptime</span>
        <span>${this.formatHours(s.uptime_hours)}</span>
        <span class="label">Memory</span>
        <span>${s.memory.used_mb} MB used / ${s.memory.total_mb} MB total</span>
        <span class="label">Disk</span>
        <span>${s.disk ? `${s.disk.used} / ${s.disk.total} (${s.disk.used_percent})` : 'N/A'}</span>
        <span class="label">Timestamp</span>
        <span>${this.formatTime(this.data.timestamp)}</span>
      </div>
    `;
  }

  renderInstances() {
    const grid = document.getElementById('instances-grid');
    const countBadge = document.getElementById('instance-count');
    if (!grid) return;

    const instances = this.data.instances || [];
    if (countBadge) countBadge.textContent = instances.length;

    if (instances.length === 0) {
      grid.innerHTML = '<div class="empty-state">No instances configured</div>';
      return;
    }

    grid.innerHTML = instances.map(inst => this.renderInstanceCard(inst)).join('');
  }

  renderInstanceCard(inst) {
    const statusClass = this.getStatusClass(inst.status);
    const statusLabel = inst.status || 'unknown';
    const typeClass = inst.type === 'on_demand' ? 'on_demand' : 'dedicated';
    const primaryBadge = inst.primary ? ' <span style="color: var(--yellow); font-size: 0.7rem;">(primary)</span>' : '';

    // Determine available actions
    let actions = '';
    if (inst.enabled) {
      if (inst.status === 'suspended') {
        actions += `<button class="btn btn-success" data-action="resume" data-id="${this.esc(inst.id)}">Resume</button>`;
      } else if (inst.status === 'running' || inst.status === 'idle' || inst.status === 'busy') {
        if (!inst.primary) {
          actions += `<button class="btn btn-warning" data-action="suspend" data-id="${this.esc(inst.id)}">Suspend</button>`;
        }
      }
      if (!inst.primary) {
        actions += `<button class="btn btn-danger" data-action="disable" data-id="${this.esc(inst.id)}">Disable</button>`;
      }
    } else {
      actions += `<button class="btn btn-success" data-action="enable" data-id="${this.esc(inst.id)}">Enable</button>`;
    }

    return `
      <div class="instance-card">
        <div class="instance-header">
          <div class="instance-name">
            <span class="status-dot ${statusClass}"></span>
            ${this.esc(inst.id)}${primaryBadge}
          </div>
          <span class="instance-type ${typeClass}">${this.esc(inst.type || 'dedicated')}</span>
        </div>
        <div class="instance-meta">
          <span class="label">Status</span>
          <span>${this.esc(statusLabel)}</span>
          <span class="label">Enabled</span>
          <span>${inst.enabled ? 'Yes' : 'No'}</span>
          <span class="label">Tmux</span>
          <span>${inst.tmux_alive ? 'alive' : 'dead'}</span>
          ${inst.last_activity ? `<span class="label">Last Activity</span><span>${this.formatTime(inst.last_activity)}</span>` : ''}
          ${inst.uptime_ms ? `<span class="label">Uptime</span><span>${this.formatDuration(inst.uptime_ms)}</span>` : ''}
          ${inst.idle_seconds != null ? `<span class="label">Idle</span><span>${this.formatDuration(inst.idle_seconds * 1000)}</span>` : ''}
        </div>
        <div class="instance-actions">
          ${actions}
        </div>
      </div>
    `;
  }

  renderTokens() {
    this.renderTokenChart();
    this.renderTokenTable();
  }

  renderTokenChart() {
    const el = document.getElementById('token-chart');
    if (!el || !this.tokenData) return;

    const { daily } = this.tokenData;
    if (!daily || daily.length === 0) {
      el.innerHTML = '<div class="empty-state">No token usage data</div>';
      return;
    }

    // Group by date, sum per date
    const dateMap = new Map();
    for (const row of daily) {
      const total = (row.input_tokens || 0) + (row.output_tokens || 0) +
                    (row.cache_read || 0) + (row.cache_write || 0);
      dateMap.set(row.date, (dateMap.get(row.date) || 0) + total);
    }

    // Sort chronologically
    const sortedDates = [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const maxVal = Math.max(...sortedDates.map(([, v]) => v), 1);

    let barsHtml = sortedDates.map(([date, total], i) => {
      const pct = Math.max(2, (total / maxVal) * 100);
      const label = date.substring(5); // MM-DD
      const colorIdx = i % 5;
      return `
        <div class="bar-group">
          <div class="bar-value">${this.formatTokens(total)}</div>
          <div class="bar color-${colorIdx}" style="height: ${pct}%"></div>
          <div class="bar-label">${label}</div>
        </div>
      `;
    }).join('');

    el.innerHTML = `<div class="bar-chart">${barsHtml}</div>`;
  }

  renderTokenTable() {
    const el = document.getElementById('token-table');
    if (!el || !this.tokenData) return;

    const { per_instance, totals } = this.tokenData;
    if (!per_instance || per_instance.length === 0) {
      el.innerHTML = '<div class="empty-state">No usage data for this period</div>';
      return;
    }

    let rows = per_instance.map(row => {
      const total = (row.input_tokens || 0) + (row.output_tokens || 0) +
                    (row.cache_read || 0) + (row.cache_write || 0);
      return `
        <tr>
          <td>${this.esc(row.instance_id)}</td>
          <td class="num">${this.formatNum(row.input_tokens)}</td>
          <td class="num">${this.formatNum(row.output_tokens)}</td>
          <td class="num">${this.formatNum(row.cache_read)}</td>
          <td class="num">${this.formatNum(row.cache_write)}</td>
          <td class="num">${this.formatNum(total)}</td>
          <td class="num">${this.formatUsd(row.cost_usd)}</td>
        </tr>
      `;
    }).join('');

    // Totals row
    if (totals) {
      const grandTotal = (totals.input_tokens || 0) + (totals.output_tokens || 0) +
                         (totals.cache_read || 0) + (totals.cache_write || 0);
      rows += `
        <tr class="total-row">
          <td>Total</td>
          <td class="num">${this.formatNum(totals.input_tokens)}</td>
          <td class="num">${this.formatNum(totals.output_tokens)}</td>
          <td class="num">${this.formatNum(totals.cache_read)}</td>
          <td class="num">${this.formatNum(totals.cache_write)}</td>
          <td class="num">${this.formatNum(grandTotal)}</td>
          <td class="num">${this.formatUsd(totals.cost_usd)}</td>
        </tr>
      `;
    }

    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Instance</th>
            <th class="num">Input</th>
            <th class="num">Output</th>
            <th class="num">Cache Read</th>
            <th class="num">Cache Write</th>
            <th class="num">Total</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  renderPm2() {
    const tableEl = document.getElementById('pm2-table');
    const countBadge = document.getElementById('pm2-count');
    if (!tableEl) return;

    const processes = this.data.pm2_processes || [];
    if (countBadge) countBadge.textContent = processes.length;

    if (processes.length === 0) {
      tableEl.innerHTML = '<div class="empty-state">No PM2 processes</div>';
      return;
    }

    const rows = processes.map(proc => {
      const statusClass = `pm2-${proc.status}`;
      return `
        <tr>
          <td>${this.esc(proc.name)}</td>
          <td><span class="${statusClass}">${proc.status}</span></td>
          <td>${proc.uptime_ms ? this.formatDuration(proc.uptime_ms) : '-'}</td>
          <td class="num">${proc.restarts}</td>
          <td class="num">${this.formatBytes(proc.memory)}</td>
          <td class="num">${proc.cpu}%</td>
        </tr>
      `;
    }).join('');

    tableEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Uptime</th>
            <th class="num">Restarts</th>
            <th class="num">Memory</th>
            <th class="num">CPU</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  getStatusClass(status) {
    switch (status) {
      case 'running': case 'idle': return 'running';
      case 'busy': return 'busy';
      case 'stopped': return 'stopped';
      case 'suspended': return 'suspended';
      case 'errored': return 'errored';
      default: return 'unknown';
    }
  }

  formatTime(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString();
    } catch {
      return isoStr;
    }
  }

  formatDuration(ms) {
    if (!ms || ms < 0) return '-';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  formatHours(h) {
    if (!h) return '-';
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    const days = Math.floor(h / 24);
    const rem = (h % 24).toFixed(0);
    return `${days}d ${rem}h`;
  }

  formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  formatNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
  }

  formatTokens(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  formatUsd(n) {
    if (n == null) return '$0.00';
    return '$' + Number(n).toFixed(2);
  }

  esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  new Dashboard();
});
