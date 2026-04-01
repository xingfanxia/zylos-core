/**
 * Zylos Dashboard — frontend application.
 * Vanilla JS, no dependencies. Auto-refreshes every 5 seconds.
 * Geist/Vercel design system.
 */

class Dashboard {
  constructor() {
    this.data = null;
    this.tokenData = null;
    this.scheduleData = null;
    this.scheduleMonth = new Date(); // current month view
    this.tokenDays = 7;
    this.tokenRuntimeFilter = 'all';
    this.showSystem = false;
    this.activeTab = 'overview';
    this.refreshInterval = null;
    this.tokenRefreshInterval = null;
    this.sortColumn = null;
    this.sortAsc = true;

    this.init();
  }

  async init() {
    this.bindActions();
    await this.fetchAll();
    this.refreshInterval = setInterval(() => { this.fetchDashboard(); this.fetchPendingUsers(); }, 5000);
    this.tokenRefreshInterval = setInterval(() => this.fetchTokens(), 30000);
    this.scheduleRefreshInterval = setInterval(() => this.fetchSchedule(), 60000);
  }

  async fetchAll() {
    await Promise.all([
      this.fetchDashboard(),
      this.fetchTokens(),
      this.fetchPendingUsers(),
      this.fetchSchedule(),
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
      <div class="pending-card">
        <div class="pending-info">
          <div class="pending-name">${this.esc(p.user_name || p.chat_id)}</div>
          <div class="pending-detail">${this.esc(p.channel)} &middot; ${this.esc(p.chat_id)} &middot; ${p.msg_count || '?'} held message(s)</div>
          <div class="pending-preview">"${this.esc((p.preview || '').substring(0, 100))}"</div>
        </div>
        <div class="pending-actions">
          <input type="text" placeholder="instance name" value="${this.esc(p.suggested_id || (p.user_name ? 'user-' + p.user_name.toLowerCase().replace(/\s+/g, '') : ''))}"
            data-chat-id="${this.esc(p.chat_id)}" class="approve-name-input">
          <button class="btn-approve" data-action="approve" data-chat-id="${this.esc(p.chat_id)}">Approve</button>
          <button class="btn-deny" data-action="deny" data-chat-id="${this.esc(p.chat_id)}">Deny</button>
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
      const res = await fetch(`/api/dashboard/tokens?days=90`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.tokenData = await res.json();
      this.renderTokens();
    } catch (err) {
      console.error('Token fetch error:', err);
    }
  }

  async fetchSchedule() {
    try {
      const res = await fetch('/api/dashboard/scheduler');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.scheduleData = await res.json();
      if (this.activeTab === 'schedule') this.renderSchedule();
    } catch (err) {
      console.error('Schedule fetch error:', err);
    }
  }

  bindActions() {
    // Tab navigation
    const tabBar = document.getElementById('tab-bar');
    if (tabBar) {
      tabBar.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        this.switchTab(tab.dataset.tab);
      });
    }

    // Token tab clicks (day filter)
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
        this.renderTokens();
      });
    }

    const runtimeTabs = document.getElementById('token-runtime-tabs');
    if (runtimeTabs) {
      runtimeTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.token-tab');
        if (!tab) return;
        const runtime = tab.dataset.runtime;
        if (!runtime || runtime === this.tokenRuntimeFilter) return;

        runtimeTabs.querySelectorAll('.token-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.tokenRuntimeFilter = runtime;

        const systemCheckbox = document.getElementById('include-system');
        if (systemCheckbox && runtime !== 'all') {
          systemCheckbox.checked = false;
          this.showSystem = false;
        }
        if (systemCheckbox) systemCheckbox.disabled = runtime !== 'all';

        this.renderTokens();
      });
    }

    // System toggle
    const systemCheckbox = document.getElementById('include-system');
    if (systemCheckbox) {
      systemCheckbox.addEventListener('change', () => {
        this.showSystem = systemCheckbox.checked;
        this.renderTokens();
      });
    }

    // Instance action buttons (delegated)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const runtime = btn.dataset.runtime;

      // Handle approve/deny for pending users
      const chatId = btn.dataset.chatId;
      if (chatId && (action === 'approve' || action === 'deny')) {
        btn.disabled = true;
        btn.textContent = '...';
        await this.handleApproval(chatId, action);
        return;
      }

      if (action === 'switch-all-runtime' && runtime) {
        btn.disabled = true;
        btn.textContent = '...';
        try {
          const res = await fetch('/api/dashboard/runtime/switch-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runtime: runtime }),
          });
          const result = await res.json();
          if (!res.ok) {
            alert(result.error || 'Action failed');
          }
          await this.fetchDashboard();
        } catch (err) {
          alert('Request failed: ' + err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = runtime === 'codex' ? 'All Codex' : 'All Claude';
        }
        return;
      }

      const id = btn.dataset.id;
      if (!action || !id) return;

      btn.disabled = true;
      btn.textContent = '...';

      try {
        var url = `/api/dashboard/instances/${encodeURIComponent(id)}/${action}`;
        var body = null;
        if (action === 'set-runtime' && runtime) {
          url = `/api/dashboard/instances/${encodeURIComponent(id)}/runtime`;
          body = JSON.stringify({ runtime: runtime });
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const result = await res.json();
        if (!res.ok) {
          alert(result.error || 'Action failed');
        }
        await this.fetchDashboard();
      } catch (err) {
        alert('Request failed: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  switchTab(tabId) {
    this.activeTab = tabId;

    // Update tab bar
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabId);
    });

    // Update panels
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.id === `panel-${tabId}`);
    });

    // Render content for the active tab
    this.renderActiveTab();
  }

  renderActiveTab() {
    switch (this.activeTab) {
      case 'overview':
        if (this.data) this.renderOverview();
        break;
      case 'instances':
        if (this.data) this.renderInstances();
        break;
      case 'usage':
        this.renderTokens();
        break;
      case 'schedule':
        this.renderSchedule();
        break;
      case 'processes':
        if (this.data) this.renderPm2();
        break;
    }
  }

  renderSkeleton(count) {
    if (count === undefined) count = 3;
    return Array(count).fill('').map(function() {
      return '<div class="skeleton" style="height: 20px; margin-bottom: 8px;"></div>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Render methods
  // ---------------------------------------------------------------------------

  renderDashboard() {
    if (!this.data) return;

    this.renderSubtitle();

    switch (this.activeTab) {
      case 'overview':
        this.renderOverview();
        break;
      case 'instances':
        this.renderInstances();
        break;
      case 'processes':
        this.renderPm2();
        break;
      case 'usage':
        this.renderTokens();
        break;
    }
  }

  renderSubtitle() {
    const el = document.getElementById('system-subtitle');
    if (!el || !this.data.system) return;
    const s = this.data.system;
    el.textContent = `${s.hostname} | ${s.platform} | ${s.cpu.cores} cores | uptime ${this.formatHours(s.uptime_hours)}`;
  }

  // ---------------------------------------------------------------------------
  // Overview tab
  // ---------------------------------------------------------------------------

  renderOverview() {
    if (!this.data || !this.data.system) return;

    this.renderStatCards();
    this.renderOverviewInstances();
  }

  renderStatCards() {
    const el = document.getElementById('system-stats');
    if (!el || !this.data.system) return;

    const { memory, disk, cpu } = this.data.system;

    const cpuPct = Math.min(100, Math.round((cpu.load_1m / cpu.cores) * 100));
    const memPct = memory.used_percent;
    const diskPct = disk ? (parseInt(disk.used_percent) || 0) : 0;

    el.innerHTML = `
      ${this._statCard('CPU Load', cpuPct + '%', cpu.load_1m.toFixed(2) + ' / ' + cpu.cores + ' cores', cpuPct)}
      ${this._statCard('Memory', memPct + '%', memory.used_mb + ' / ' + memory.total_mb + ' MB', memPct)}
      ${this._statCard('Disk', diskPct + '%', disk ? disk.used + ' / ' + disk.total : 'N/A', diskPct)}
    `;
  }

  _statCard(label, value, detail, percent) {
    var level = percent > 85 ? 'high' : percent > 60 ? 'medium' : 'low';
    return '<div class="stat-card">' +
      '<div class="stat-label">' + this.esc(label) + '</div>' +
      '<div class="stat-value">' + this.esc(value) + '</div>' +
      '<div class="stat-detail">' + this.esc(detail) + '</div>' +
      '<div class="progress-bar"><div class="progress-fill ' + level + '" style="width: ' + percent + '%"></div></div>' +
    '</div>';
  }

  renderOverviewInstances() {
    const el = document.getElementById('overview-instances');
    if (!el) return;

    const instances = this.data.instances || [];
    if (instances.length === 0) {
      el.innerHTML = '<div class="empty-state">No instances configured</div>';
      return;
    }

    var convCounts = this.data.conversation_counts || {};

    var rows = instances.map(function(inst) {
      var statusClass = this.getStatusClass(inst.status);
      var statusLabel = inst.status || 'unknown';
      var typeClass = inst.type === 'on_demand' ? 'on_demand' : 'dedicated';
      var typeLabel = inst.type || 'dedicated';
      var lastActivity = inst.last_activity ? this.formatTime(inst.last_activity) : '-';
      var idle = inst.idle_seconds != null ? this.formatDuration(inst.idle_seconds * 1000) : '-';
      var primaryMark = inst.primary ? ' <span style="color: var(--warning); font-size: 11px;">(primary)</span>' : '';
      var conv = convCounts[inst.id] || { total: 0, today: 0 };
      var convLabel = this.formatNum(conv.total) + (conv.today > 0 ? ' <span style="color:var(--accent)">(' + conv.today + ' today)</span>' : '');

      return '<tr>' +
        '<td style="width:20px"><span class="status-dot ' + statusClass + '"></span></td>' +
        '<td class="instance-name-cell">' + this.esc(inst.id) + primaryMark + '</td>' +
        '<td><span class="type-badge ' + typeClass + '">' + this.esc(typeLabel) + '</span></td>' +
        '<td>' + this.esc(statusLabel) + '</td>' +
        '<td class="mono">' + convLabel + '</td>' +
        '<td>' + lastActivity + '</td>' +
        '<td>' + idle + '</td>' +
      '</tr>';
    }.bind(this)).join('');

    el.innerHTML = '<table class="overview-table">' +
      '<thead><tr>' +
        '<th></th>' +
        '<th>Name</th>' +
        '<th>Type</th>' +
        '<th>Status</th>' +
        '<th>Conversations</th>' +
        '<th>Last Activity</th>' +
        '<th>Idle</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
  }

  // ---------------------------------------------------------------------------
  // Instances tab
  // ---------------------------------------------------------------------------

  renderInstances() {
    const grid = document.getElementById('instances-grid');
    if (!grid) return;

    const instances = this.data.instances || [];

    if (instances.length === 0) {
      grid.innerHTML = '<div class="empty-state">No instances configured</div>';
      return;
    }

    var runtimeSummary = instances.reduce(function(out, inst) {
      var runtime = inst.runtime || 'claude';
      out[runtime] = (out[runtime] || 0) + 1;
      return out;
    }, {});

    var toolbar = '<div class="runtime-toolbar">' +
      '<div class="runtime-toolbar-copy">' +
        '<div class="runtime-toolbar-title">Runtime Controls</div>' +
        '<div class="runtime-toolbar-meta">Claude: ' + (runtimeSummary.claude || 0) + ' &middot; Codex: ' + (runtimeSummary.codex || 0) + '</div>' +
      '</div>' +
      '<div class="runtime-toolbar-actions">' +
        '<button class="btn" data-action="switch-all-runtime" data-runtime="claude">All Claude</button>' +
        '<button class="btn" data-action="switch-all-runtime" data-runtime="codex">All Codex</button>' +
      '</div>' +
    '</div>';

    grid.innerHTML = toolbar + instances.map(function(inst) { return this.renderInstanceCard(inst); }.bind(this)).join('');
  }

  renderInstanceCard(inst) {
    var statusClass = this.getStatusClass(inst.status);
    var statusLabel = inst.status || 'unknown';
    var typeClass = inst.type === 'on_demand' ? 'on_demand' : 'dedicated';
    var primaryBadge = inst.primary ? ' <span style="color: var(--warning); font-size: 11px;">(primary)</span>' : '';
    var convCounts = this.data.conversation_counts || {};
    var conv = convCounts[inst.id] || { total: 0, today: 0 };
    var runtime = inst.runtime || 'claude';

    // Determine available actions
    var actions = '';
    if (inst.enabled) {
      actions += '<button class="btn" data-action="set-runtime" data-id="' + this.esc(inst.id) + '" data-runtime="' + this.esc(runtime === 'codex' ? 'claude' : 'codex') + '">Use ' + (runtime === 'codex' ? 'Claude' : 'Codex') + '</button>';
      if (inst.status === 'suspended') {
        actions += '<button class="btn btn-success" data-action="resume" data-id="' + this.esc(inst.id) + '">Resume</button>';
      } else if (inst.status === 'running' || inst.status === 'idle' || inst.status === 'busy') {
        if (!inst.primary) {
          actions += '<button class="btn btn-warning" data-action="suspend" data-id="' + this.esc(inst.id) + '">Suspend</button>';
        }
      }
      if (!inst.primary) {
        actions += '<button class="btn btn-danger" data-action="disable" data-id="' + this.esc(inst.id) + '">Disable</button>';
      }
    } else {
      actions += '<button class="btn btn-success" data-action="enable" data-id="' + this.esc(inst.id) + '">Enable</button>';
    }

    return '<div class="instance-card">' +
      '<div class="instance-header">' +
        '<div class="instance-name">' +
          '<span class="status-dot ' + statusClass + '"></span>' +
          this.esc(inst.id) + primaryBadge +
        '</div>' +
        '<span class="type-badge ' + typeClass + '">' + this.esc(inst.type || 'dedicated') + '</span>' +
      '</div>' +
      '<div class="instance-meta">' +
        '<span class="label">Status</span><span class="value">' + this.esc(statusLabel) + '</span>' +
        '<span class="label">Runtime</span><span class="value runtime-badge">' + this.esc(runtime) + '</span>' +
        '<span class="label">Enabled</span><span class="value">' + (inst.enabled ? 'Yes' : 'No') + '</span>' +
        '<span class="label">Conversations</span><span class="value mono">' + this.formatNum(conv.total) + (conv.today > 0 ? ' <span style="color:var(--accent)">(' + conv.today + ' today)</span>' : '') + '</span>' +
        '<span class="label">Tmux</span><span class="value">' + (inst.tmux_alive ? 'alive' : 'dead') + '</span>' +
        (inst.last_activity ? '<span class="label">Last Activity</span><span class="value">' + this.formatTime(inst.last_activity) + '</span>' : '') +
        (inst.uptime_ms ? '<span class="label">Uptime</span><span class="value">' + this.formatDuration(inst.uptime_ms) + '</span>' : '') +
        (inst.idle_seconds != null ? '<span class="label">Idle</span><span class="value">' + this.formatDuration(inst.idle_seconds * 1000) + '</span>' : '') +
      '</div>' +
      '<div class="instance-actions">' + actions + '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------------------
  // Token/Usage tab
  // ---------------------------------------------------------------------------

  renderTokens() {
    if (this.activeTab !== 'usage') return;
    var systemCheckbox = document.getElementById('include-system');
    if (systemCheckbox) systemCheckbox.disabled = this.tokenRuntimeFilter !== 'all';
    this.renderUsageWindows();
    this.renderTokenChart();
    this.renderTokenCalendar();
    this.renderTokenDonut();
    this.renderTokenTable();
  }

  // ---------------------------------------------------------------------------
  // Token helpers: date filtering and instance color assignment
  // ---------------------------------------------------------------------------

  /** Return a cutoff date string (YYYY-MM-DD) for the last N days. */
  _tokenCutoffDate(days) {
    var d = new Date();
    d.setDate(d.getDate() - (days || this.tokenDays));
    return d.toISOString().slice(0, 10);
  }

  /** Filter an array of {date, ...} rows to only those within the window. */
  _filterDaily(rows, days) {
    if (!rows) return [];
    var cutoff = this._tokenCutoffDate(days);
    return rows.filter(function(r) { return r.date > cutoff; });
  }

  /** Sum token fields across an array of daily rows. */
  _sumRows(rows) {
    var out = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.input_tokens += r.input_tokens || 0;
      out.output_tokens += r.output_tokens || 0;
      out.cache_read += r.cache_read || 0;
      out.cache_write += r.cache_write || 0;
      out.cost_usd += r.cost_usd || 0;
    }
    out.total_tokens = out.input_tokens + out.output_tokens + out.cache_read + out.cache_write;
    return out;
  }

  /** Consistent color palette for instance IDs. */
  _instanceColor(id) {
    var named = {
      admin: '#3b82f6',
      scheduler: '#8b5cf6',
      group: '#f59e0b',
      system: '#6b7280',
    };
    if (named[id]) return named[id];
    var cycle = ['#10b981', '#ec4899', '#06b6d4', '#f97316', '#a855f7', '#14b8a6', '#e11d48', '#84cc16'];
    var hash = 0;
    for (var i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return cycle[Math.abs(hash) % cycle.length];
  }

  _matchesRuntimeFilter(runtime) {
    return this.tokenRuntimeFilter === 'all' || (runtime || 'claude') === this.tokenRuntimeFilter;
  }

  _canShowSystemUsage() {
    return this.showSystem && this.tokenRuntimeFilter === 'all';
  }

  _aggregateDailyRows(instances) {
    var byDate = new Map();
    var ids = Object.keys(instances || {});
    for (var i = 0; i < ids.length; i++) {
      var rows = instances[ids[i]]?.daily || [];
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        if (!byDate.has(row.date)) {
          byDate.set(row.date, {
            date: row.date,
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 0,
            cost_usd: 0,
          });
        }
        var target = byDate.get(row.date);
        target.input_tokens += row.input_tokens || 0;
        target.output_tokens += row.output_tokens || 0;
        target.cache_read += row.cache_read || 0;
        target.cache_write += row.cache_write || 0;
        target.total_tokens += row.total_tokens || 0;
        target.cost_usd += row.cost_usd || 0;
      }
    }
    return Array.from(byDate.values()).sort(function(a, b) { return a.date.localeCompare(b.date); });
  }

  _getTokenView() {
    var allInstances = this.tokenData?.instances || {};
    var runtimeBuckets = this.tokenData?.runtimes || {};
    if (this.tokenRuntimeFilter !== 'all') {
      var filteredInstances = {};
      var ids = Object.keys(allInstances);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var instanceData = allInstances[id];
        var runtimeData = instanceData?.runtimes?.[this.tokenRuntimeFilter];
        if (!runtimeData || !runtimeData.daily || runtimeData.daily.length === 0) continue;
        filteredInstances[id] = {
          ...instanceData,
          daily: runtimeData.daily,
          totals: runtimeData.totals,
        };
      }

      var runtimeDaily = runtimeBuckets[this.tokenRuntimeFilter]?.daily || this._aggregateDailyRows(filteredInstances);
      return {
        instances: filteredInstances,
        visibleDaily: runtimeDaily,
        allDaily: this.tokenData?.daily || [],
      };
    }

    var visibleInstances = {};
    var ids = Object.keys(allInstances);

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var instanceData = allInstances[id];
      visibleInstances[id] = instanceData;
    }

    return {
      instances: visibleInstances,
      visibleDaily: this._aggregateDailyRows(visibleInstances),
      allDaily: this.tokenData?.daily || [],
    };
  }

  _getInstanceTokenWindows(instanceId) {
    var instanceData = this.tokenData?.instances?.[instanceId] || {};
    var rows = this.tokenRuntimeFilter !== 'all'
      ? (instanceData.runtimes?.[this.tokenRuntimeFilter]?.daily || [])
      : (instanceData.daily || []);
    var todayStr = new Date().toISOString().slice(0, 10);
    var todayRows = rows.filter(function(r) { return r.date === todayStr; });
    var weekRows = this._filterDaily(rows, 7);
    return {
      today: this._sumRows(todayRows),
      week: this._sumRows(weekRows),
    };
  }

  _getRuntimeTokenWindows(runtime) {
    var rows = this.tokenData?.runtimes?.[runtime]?.daily || [];
    var todayStr = new Date().toISOString().slice(0, 10);
    var todayRows = rows.filter(function(r) { return r.date === todayStr; });
    var weekRows = this._filterDaily(rows, 7);
    return {
      today: this._sumRows(todayRows),
      week: this._sumRows(weekRows),
    };
  }

  _getRuntimeUsageWindow(runtime) {
    var providerUsage = this.data?.provider_usage?.providers?.[runtime];
    if (providerUsage && providerUsage.available) {
      return {
        usage: {
          runtime: runtime,
          available: providerUsage.available,
          session: runtime === 'claude' && providerUsage.primary ? {
            percent: providerUsage.primary.used_percent,
            resets: providerUsage.primary.reset_description,
          } : null,
          fiveHour: runtime === 'codex' && providerUsage.primary ? {
            percent: providerUsage.primary.used_percent,
            resets: providerUsage.primary.reset_description,
          } : null,
          weeklyAll: providerUsage.secondary ? {
            percent: providerUsage.secondary.used_percent,
            resets: providerUsage.secondary.reset_description,
          } : null,
          weeklySonnet: runtime === 'claude' && providerUsage.tertiary ? {
            percent: providerUsage.tertiary.used_percent,
            resets: providerUsage.tertiary.reset_description,
          } : null,
          tier: null,
          lastCheck: providerUsage.fetched_at || this.data?.provider_usage?.updated_at || null,
        },
        instanceCount: (this.data?.instances || []).filter(function(inst) {
          return (inst.runtime || 'claude') === runtime;
        }).length,
      };
    }

    var instances = this.data?.instances || [];
    var usageWindows = this.data?.usage_windows || {};
    var matching = instances.filter(function(inst) {
      return (inst.runtime || 'claude') === runtime;
    });

    for (var i = 0; i < matching.length; i++) {
      var usage = usageWindows[matching[i].id];
      if (usage && usage.available) {
        return {
          usage: usage,
          instanceCount: matching.length,
        };
      }
    }

    return {
      usage: {
        runtime: runtime,
        available: false,
        session: null,
        fiveHour: null,
        weeklyAll: null,
        weeklySonnet: null,
        tier: null,
        lastCheck: null,
      },
      instanceCount: matching.length,
    };
  }

  _formatUsagePrimary(metric) {
    if (!metric || metric.percent === null || metric.percent === undefined) return 'n/a';
    return metric.percent + '%';
  }

  _formatUsageMeta(metric) {
    if (!metric || !metric.resets) return '';
    return 'resets ' + metric.resets;
  }

  renderUsageWindows() {
    var el = document.getElementById('usage-windows');
    if (!el) return;

    var runtimes = this.tokenRuntimeFilter === 'all'
      ? ['claude', 'codex']
      : [this.tokenRuntimeFilter];

    var cards = runtimes.map(function(runtime) {
      var summary = this._getRuntimeUsageWindow(runtime);
      var usage = summary.usage || {};
      var tokenWindows = this._getRuntimeTokenWindows(runtime);
      var sessionPrimary = this._formatUsagePrimary(usage.session);
      var fiveHourPrimary = this._formatUsagePrimary(usage.fiveHour);
      var weeklyPrimary = this._formatUsagePrimary(usage.weeklyAll);
      var sonnetPrimary = this._formatUsagePrimary(usage.weeklySonnet);
      var tierClass = usage.tier ? ' usage-tier-' + usage.tier : '';
      var lastCheck = usage.lastCheck ? this.formatTime(usage.lastCheck) : 'no live sample';
      var todayPrimary = this.formatUsd(tokenWindows.today.cost_usd || 0);
      var todayMeta = this.formatTokens(tokenWindows.today.total_tokens || 0);
      var weeklyMeta = this.esc(this._formatUsageMeta(usage.weeklyAll));
      var runtimeLabel = runtime === 'claude' ? 'Claude' : 'Codex';
      var primaryMetric = runtime === 'codex'
        ? '<div class="usage-metric">' +
            '<div class="usage-metric-label">5h</div>' +
            '<div class="usage-metric-value">' + fiveHourPrimary + '</div>' +
            '<div class="usage-metric-meta">' + this.esc(this._formatUsageMeta(usage.fiveHour)) + '</div>' +
          '</div>'
        : '<div class="usage-metric">' +
            '<div class="usage-metric-label">Session</div>' +
            '<div class="usage-metric-value">' + sessionPrimary + '</div>' +
            '<div class="usage-metric-meta">' + this.esc(this._formatUsageMeta(usage.session)) + '</div>' +
          '</div>';

      var secondaryMetric = runtime === 'codex'
        ? ''
        : '<div class="usage-metric">' +
            '<div class="usage-metric-label">Opus Week</div>' +
            '<div class="usage-metric-value">' + sonnetPrimary + '</div>' +
            '<div class="usage-metric-meta">' + this.esc(this._formatUsageMeta(usage.weeklySonnet)) + '</div>' +
          '</div>';

      var footerMeta = runtime === 'codex'
        ? 'CodexBar CLI'
        : 'CodexBar CLI';

      return '<div class="usage-window-card' + tierClass + '">' +
        '<div class="usage-window-header">' +
          '<div>' +
            '<div class="usage-window-name">' + runtimeLabel + '</div>' +
            '<div class="usage-window-runtime">' + summary.instanceCount + ' active instance' + (summary.instanceCount === 1 ? '' : 's') + '</div>' +
          '</div>' +
          (usage.tier ? '<div class="usage-window-tier">' + this.esc(usage.tier) + '</div>' : '') +
        '</div>' +
        '<div class="usage-metrics-grid">' +
          primaryMetric +
          '<div class="usage-metric">' +
            '<div class="usage-metric-label">Week</div>' +
            '<div class="usage-metric-value">' + weeklyPrimary + '</div>' +
            '<div class="usage-metric-meta">' + weeklyMeta + '</div>' +
          '</div>' +
          '<div class="usage-metric">' +
            '<div class="usage-metric-label">Day Usage</div>' +
            '<div class="usage-metric-value">' + todayPrimary + '</div>' +
            '<div class="usage-metric-meta">' + this.esc(todayMeta) + '</div>' +
          '</div>' +
          secondaryMetric +
        '</div>' +
        '<div class="usage-window-footer">Last check: ' + this.esc(lastCheck) + (footerMeta ? ' · ' + this.esc(footerMeta) : '') + '</div>' +
      '</div>';
    }.bind(this)).join('');

    el.innerHTML = '<div class="usage-window-grid">' + cards + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Token chart — stacked bars with Y-axis gridlines
  // ---------------------------------------------------------------------------

  renderTokenChart() {
    var el = document.getElementById('token-chart');
    if (!el || !this.tokenData) return;

    var tokenView = this._getTokenView();
    var visibleDaily = this._filterDaily(tokenView.visibleDaily);
    var totalDaily = this._canShowSystemUsage() ? this._filterDaily(tokenView.allDaily) : visibleDaily;
    if (visibleDaily.length === 0) {
      el.innerHTML = '<div class="empty-state">No token usage data</div>';
      return;
    }

    var instances = tokenView.instances || {};
    var instanceIds = Object.keys(instances).sort();

    // Build per-date totals from aggregate daily
    var dateTotals = new Map();
    for (var i = 0; i < totalDaily.length; i++) {
      var row = totalDaily[i];
      var t = (row.input_tokens || 0) + (row.output_tokens || 0) +
              (row.cache_read || 0) + (row.cache_write || 0);
      dateTotals.set(row.date, (dateTotals.get(row.date) || 0) + t);
    }

    // Build per-date per-instance totals
    var dateInstanceTotals = new Map();
    for (var j = 0; j < instanceIds.length; j++) {
      var id = instanceIds[j];
      var instDaily = this._filterDaily(instances[id]?.daily);
      for (var k = 0; k < instDaily.length; k++) {
        var r = instDaily[k];
        if (!dateInstanceTotals.has(r.date)) dateInstanceTotals.set(r.date, new Map());
        var tt = (r.input_tokens || 0) + (r.output_tokens || 0) +
                (r.cache_read || 0) + (r.cache_write || 0);
        var m = dateInstanceTotals.get(r.date);
        m.set(id, (m.get(id) || 0) + tt);
      }
    }

    var sortedDates = Array.from(dateTotals.keys()).sort();
    var self = this;
    var maxVal = Math.max.apply(null, sortedDates.map(function(d) {
      var total = dateTotals.get(d) || 0;
      if (self._canShowSystemUsage()) return total;
      var instMap = dateInstanceTotals.get(d);
      if (!instMap) return 0;
      var sum = 0;
      instMap.forEach(function(v) { sum += v; });
      return sum;
    }).concat([1]));

    // Y-axis labels (4 gridlines)
    var yLabels = [];
    for (var g = 0; g < 5; g++) {
      yLabels.push(this.formatTokens(Math.round(maxVal * (1 - g / 4))));
    }

    var showEveryOther = sortedDates.length > 14;

    var barsHtml = sortedDates.map(function(date, idx) {
      var dayTotal = dateTotals.get(date) || 0;
      var instMap = dateInstanceTotals.get(date) || new Map();

      var instanceSum = 0;
      var segments = [];
      for (var n = 0; n < instanceIds.length; n++) {
        var iid = instanceIds[n];
        var val = instMap.get(iid) || 0;
        if (val <= 0) continue;
        instanceSum += val;
        segments.push({ id: iid, val: val });
      }

      var systemVal = Math.max(0, dayTotal - instanceSum);
      if (self._canShowSystemUsage() && systemVal > 0) {
        segments.push({ id: 'system', val: systemVal });
      }

      var barTotal = self._canShowSystemUsage() ? dayTotal : instanceSum;
      var pct = maxVal > 0 ? Math.max(1, (barTotal / maxVal) * 100) : 1;
      var label = date.substring(5);

      var segmentsHtml = '';
      if (barTotal > 0) {
        for (var s = 0; s < segments.length; s++) {
          var seg = segments[s];
          var segPct = (seg.val / barTotal) * 100;
          if (segPct < 0.1) continue;
          var isLast = s === segments.length - 1;
          segmentsHtml += '<div class="bar-segment" style="height: ' + segPct + '%; background: ' + self._instanceColor(seg.id) + ';' + (isLast ? ' border-radius: 2px 2px 0 0;' : '') + '" title="' + self.esc(seg.id) + ': ' + self.formatTokens(seg.val) + '"></div>';
        }
      }

      var showLabel = !showEveryOther || idx % 2 === 0;

      // Build tooltip content
      var tooltipLines = segments.map(function(seg) {
        return '<span style="color:' + self._instanceColor(seg.id) + '">●</span> ' + self.esc(seg.id) + ': ' + self.formatTokens(seg.val);
      });
      tooltipLines.unshift('<strong>' + date + '</strong> — ' + self.formatTokens(barTotal));
      if (!self._canShowSystemUsage() && systemVal > 0) {
        tooltipLines.push('<span style="color:#666">+ ' + self.formatTokens(systemVal) + ' system</span>');
      }
      var tooltipHtml = '<div class="bar-tooltip">' + tooltipLines.join('<br>') + '</div>';

      return '<div class="bar-group">' +
        tooltipHtml +
        '<div class="bar" style="height: ' + pct + '%;">' + segmentsHtml + '</div>' +
        '<div class="bar-label">' + (showLabel ? label : '') + '</div>' +
      '</div>';
    }).join('');

    // Legend
    var legendHtml = instanceIds.map(function(iid) {
      return '<span class="legend-item"><span class="legend-swatch" style="background: ' + self._instanceColor(iid) + '"></span>' + self.esc(iid) + '</span>';
    });
    if (this._canShowSystemUsage()) {
      legendHtml.push('<span class="legend-item"><span class="legend-swatch" style="background: ' + this._instanceColor('system') + '"></span>system</span>');
    }

    // Y-axis HTML
    var yAxisHtml = '<div class="bar-chart-y-axis">' +
      yLabels.map(function(l) { return '<span class="y-label">' + l + '</span>'; }).join('') +
    '</div>';

    var gridlinesHtml = '<div class="bar-chart-gridlines">' +
      '<div class="gridline"></div><div class="gridline"></div><div class="gridline"></div><div class="gridline"></div><div class="gridline"></div>' +
    '</div>';

    el.innerHTML =
      '<div class="chart-legend">' + legendHtml.join('') + '</div>' +
      '<div class="bar-chart-wrapper">' +
        yAxisHtml +
        '<div class="bar-chart-area">' +
          gridlinesHtml +
          '<div class="bar-chart">' + barsHtml + '</div>' +
        '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------------------
  // Calendar heatmap — 90-day GitHub-style contribution grid
  // ---------------------------------------------------------------------------

  renderTokenCalendar() {
    var el = document.getElementById('token-calendar');
    if (!el || !this.tokenData) return;

    var tokenView = this._getTokenView();
    var daily = this._canShowSystemUsage() ? (tokenView.allDaily || []) : [];
    var instances = tokenView.instances || {};

    // Build date->cost map for the last 90 days
    var costByDate = new Map();
    var tokensByDate = new Map();

    if (this._canShowSystemUsage()) {
      for (var i = 0; i < daily.length; i++) {
        var r = daily[i];
        costByDate.set(r.date, (costByDate.get(r.date) || 0) + (r.cost_usd || 0));
        var tok = (r.input_tokens || 0) + (r.output_tokens || 0) + (r.cache_read || 0) + (r.cache_write || 0);
        tokensByDate.set(r.date, (tokensByDate.get(r.date) || 0) + tok);
      }
    } else {
      var instanceIds = Object.keys(instances);
      for (var j = 0; j < instanceIds.length; j++) {
        var instDaily = instances[instanceIds[j]]?.daily || [];
        for (var k = 0; k < instDaily.length; k++) {
          var ir = instDaily[k];
          costByDate.set(ir.date, (costByDate.get(ir.date) || 0) + (ir.cost_usd || 0));
          var itok = (ir.input_tokens || 0) + (ir.output_tokens || 0) + (ir.cache_read || 0) + (ir.cache_write || 0);
          tokensByDate.set(ir.date, (tokensByDate.get(ir.date) || 0) + itok);
        }
      }
    }

    // Generate last 90 days
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var days = [];
    for (var d = 89; d >= 0; d--) {
      var dt = new Date(today);
      dt.setDate(dt.getDate() - d);
      var dateStr = dt.toISOString().slice(0, 10);
      days.push({
        date: dateStr,
        day: dt.getDay(),
        cost: costByDate.get(dateStr) || 0,
        tokens: tokensByDate.get(dateStr) || 0,
        monthDay: dt.getDate(),
        month: dt.getMonth(),
        dateObj: dt,
      });
    }

    // Compute percentile thresholds for intensity levels
    var nonZeroCosts = days.filter(function(x) { return x.cost > 0; }).map(function(x) { return x.cost; }).sort(function(a, b) { return a - b; });

    var thresholds = [0, 0, 0, 0];
    if (nonZeroCosts.length > 0) {
      thresholds[0] = nonZeroCosts[Math.floor(nonZeroCosts.length * 0.01)] || nonZeroCosts[0];
      thresholds[1] = nonZeroCosts[Math.floor(nonZeroCosts.length * 0.25)] || nonZeroCosts[0];
      thresholds[2] = nonZeroCosts[Math.floor(nonZeroCosts.length * 0.50)] || nonZeroCosts[0];
      thresholds[3] = nonZeroCosts[Math.floor(nonZeroCosts.length * 0.75)] || nonZeroCosts[0];
    }

    var self = this;
    function getLevel(cost) {
      if (cost <= 0) return 0;
      if (cost <= thresholds[1]) return 1;
      if (cost <= thresholds[2]) return 2;
      if (cost <= thresholds[3]) return 3;
      return 4;
    }

    // Organize into weeks (columns)
    // Pad the first week to start on Monday (day 1)
    var weeks = [];
    var currentWeek = [];

    // Pad first week
    var firstDay = days[0].day;
    var mondayOffset = (firstDay + 6) % 7; // convert Sun=0 to Mon=0
    for (var p = 0; p < mondayOffset; p++) {
      currentWeek.push(null);
    }

    for (var di = 0; di < days.length; di++) {
      var dayItem = days[di];
      var mondayIdx = (dayItem.day + 6) % 7;
      if (mondayIdx === 0 && currentWeek.length > 0) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push(dayItem);
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) currentWeek.push(null);
      weeks.push(currentWeek);
    }

    // Month labels
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var monthLabels = [];
    var lastMonth = -1;
    for (var wi = 0; wi < weeks.length; wi++) {
      var firstRealDay = null;
      for (var ci = 0; ci < weeks[wi].length; ci++) {
        if (weeks[wi][ci]) { firstRealDay = weeks[wi][ci]; break; }
      }
      if (firstRealDay && firstRealDay.month !== lastMonth) {
        monthLabels.push({ weekIdx: wi, label: monthNames[firstRealDay.month] });
        lastMonth = firstRealDay.month;
      }
    }

    // Build month header (positioned above week columns)
    var monthHeaderHtml = '<div class="calendar-months" style="position: relative; height: 14px; margin-bottom: 4px; padding-left: 28px;">';
    for (var mi = 0; mi < monthLabels.length; mi++) {
      var ml = monthLabels[mi];
      var leftPos = ml.weekIdx * 14; // 12px cell + 2px gap
      monthHeaderHtml += '<span style="position: absolute; left: ' + leftPos + 'px;">' + ml.label + '</span>';
    }
    monthHeaderHtml += '</div>';

    // Day labels
    var dayLabelsHtml = '<div class="calendar-day-labels">' +
      '<div class="calendar-day-label">Mon</div>' +
      '<div class="calendar-day-label"></div>' +
      '<div class="calendar-day-label">Wed</div>' +
      '<div class="calendar-day-label"></div>' +
      '<div class="calendar-day-label">Fri</div>' +
      '<div class="calendar-day-label"></div>' +
      '<div class="calendar-day-label"></div>' +
    '</div>';

    // Build weeks
    var weeksHtml = weeks.map(function(week) {
      var cellsHtml = week.map(function(dayData) {
        if (!dayData) return '<div class="calendar-day" style="visibility: hidden;"></div>';
        var level = getLevel(dayData.cost);
        var tooltipText = dayData.date.slice(5) + ': $' + dayData.cost.toFixed(2) + ' (' + self.formatTokens(dayData.tokens) + ' tokens)';
        return '<div class="calendar-day" data-level="' + level + '">' +
          '<div class="calendar-tooltip">' + tooltipText + '</div>' +
        '</div>';
      }).join('');
      return '<div class="calendar-week">' + cellsHtml + '</div>';
    }).join('');

    // Color scale legend
    var scaleHtml = '<div class="calendar-scale">' +
      '<span>Less</span>' +
      '<div class="calendar-scale-cell" style="background: var(--bg-200);"></div>' +
      '<div class="calendar-scale-cell" style="background: #0c2d48;"></div>' +
      '<div class="calendar-scale-cell" style="background: #0a4a7a;"></div>' +
      '<div class="calendar-scale-cell" style="background: #0070f3;"></div>' +
      '<div class="calendar-scale-cell" style="background: #3291ff;"></div>' +
      '<span>More</span>' +
    '</div>';

    el.innerHTML = '<div class="calendar-container">' +
      '<div class="calendar-header">' +
        '<span></span>' +
        scaleHtml +
      '</div>' +
      monthHeaderHtml +
      '<div class="calendar-body">' +
        dayLabelsHtml +
        '<div class="calendar-heatmap">' + weeksHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  // ---------------------------------------------------------------------------
  // Token donut chart — cost breakdown by instance
  // ---------------------------------------------------------------------------

  renderTokenDonut() {
    var el = document.getElementById('token-pie');
    if (!el || !this.tokenData) return;

    var tokenView = this._getTokenView();
    var instances = tokenView.instances || {};
    var instanceIds = Object.keys(instances).sort();
    var visibleDaily = this._filterDaily(tokenView.visibleDaily);
    var totalDaily = this._canShowSystemUsage() ? this._filterDaily(tokenView.allDaily) : visibleDaily;
    var filteredTotals = this._sumRows(totalDaily);

    if (filteredTotals.cost_usd <= 0) {
      el.innerHTML = '';
      return;
    }

    // Compute per-instance costs
    var slices = [];
    var instanceCostSum = 0;
    for (var i = 0; i < instanceIds.length; i++) {
      var id = instanceIds[i];
      var instData = instances[id];
      var t = this._sumRows(this._filterDaily(instData?.daily));
      if (t.cost_usd > 0.001) {
        slices.push({ id: id, cost: t.cost_usd });
        instanceCostSum += t.cost_usd;
      }
    }

    // System slice
    var systemCost = Math.max(0, filteredTotals.cost_usd - instanceCostSum);
    if (this._canShowSystemUsage() && systemCost > 0.001) {
      slices.push({ id: 'system', cost: systemCost });
    }

    var totalCost = this._canShowSystemUsage() ? filteredTotals.cost_usd : instanceCostSum;
    if (totalCost <= 0) { el.innerHTML = ''; return; }

    // Sort by cost descending
    slices.sort(function(a, b) { return b.cost - a.cost; });

    // Build conic-gradient stops
    var angle = 0;
    var gradientStops = [];
    for (var s = 0; s < slices.length; s++) {
      var slice = slices[s];
      var pct = (slice.cost / totalCost) * 100;
      var color = this._instanceColor(slice.id);
      gradientStops.push(color + ' ' + angle + 'deg ' + (angle + pct * 3.6) + 'deg');
      slice.pct = pct;
      angle += pct * 3.6;
    }

    var gradient = 'conic-gradient(' + gradientStops.join(', ') + ')';

    // Legend with mini bars
    var self = this;
    var maxSlicePct = slices.length > 0 ? slices[0].pct : 1;
    var legendHtml = slices.map(function(sl) {
      var barWidth = Math.max(2, (sl.pct / maxSlicePct) * 100);
      return '<div class="donut-legend-item">' +
        '<span class="donut-legend-swatch" style="background: ' + self._instanceColor(sl.id) + '"></span>' +
        '<span class="donut-legend-name">' + self.esc(sl.id) + '</span>' +
        '<span class="donut-legend-value">' + self.formatUsd(sl.cost) + '</span>' +
        '<span class="donut-legend-pct">' + sl.pct.toFixed(1) + '%</span>' +
        '<div class="donut-legend-bar-track"><div class="donut-legend-bar-fill" style="width: ' + barWidth + '%; background: ' + self._instanceColor(sl.id) + '"></div></div>' +
      '</div>';
    }).join('');

    el.innerHTML = '<div class="section-title">Cost breakdown (' + this.tokenDays + 'd)</div>' +
      '<div class="donut-container">' +
        '<div class="donut-ring" style="background: ' + gradient + ';">' +
          '<div class="donut-hole">' +
            '<div class="donut-total">' + this.formatUsd(totalCost) + '</div>' +
            '<div class="donut-total-label">' + this.tokenDays + ' days</div>' +
          '</div>' +
        '</div>' +
        '<div class="donut-legend">' + legendHtml + '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------------------
  // Token table — sortable columns
  // ---------------------------------------------------------------------------

  renderTokenTable() {
    var el = document.getElementById('token-table');
    if (!el || !this.tokenData) return;

    var tokenView = this._getTokenView();
    var instances = tokenView.instances || {};
    var instanceIds = Object.keys(instances).sort();

    if (instanceIds.length === 0 && (!tokenView.visibleDaily || tokenView.visibleDaily.length === 0)) {
      el.innerHTML = '<div class="empty-state">No usage data for this period</div>';
      return;
    }

    // Filtered aggregate totals
    var filteredDaily = this._filterDaily(tokenView.visibleDaily);
    var totalDaily = this._canShowSystemUsage() ? this._filterDaily(tokenView.allDaily) : filteredDaily;
    var filteredTotals = this._sumRows(totalDaily);

    // Per-instance filtered totals
    var instanceRows = [];
    var instanceSumTotals = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0, total_tokens: 0 };
    for (var i = 0; i < instanceIds.length; i++) {
      var id = instanceIds[i];
      var instFiltered = this._filterDaily(instances[id]?.daily);
      var t = this._sumRows(instFiltered);
      instanceRows.push({ id: id, input_tokens: t.input_tokens, output_tokens: t.output_tokens, cache_read: t.cache_read, cache_write: t.cache_write, cost_usd: t.cost_usd, total_tokens: t.total_tokens });
      instanceSumTotals.input_tokens += t.input_tokens;
      instanceSumTotals.output_tokens += t.output_tokens;
      instanceSumTotals.cache_read += t.cache_read;
      instanceSumTotals.cache_write += t.cache_write;
      instanceSumTotals.cost_usd += t.cost_usd;
      instanceSumTotals.total_tokens += t.total_tokens;
    }

    // System row
    var systemRow = {
      id: 'system',
      input_tokens: Math.max(0, filteredTotals.input_tokens - instanceSumTotals.input_tokens),
      output_tokens: Math.max(0, filteredTotals.output_tokens - instanceSumTotals.output_tokens),
      cache_read: Math.max(0, filteredTotals.cache_read - instanceSumTotals.cache_read),
      cache_write: Math.max(0, filteredTotals.cache_write - instanceSumTotals.cache_write),
      cost_usd: Math.max(0, filteredTotals.cost_usd - instanceSumTotals.cost_usd),
    };
    systemRow.total_tokens = systemRow.input_tokens + systemRow.output_tokens + systemRow.cache_read + systemRow.cache_write;
    var hasSystem = systemRow.cost_usd > 0.001 || systemRow.total_tokens > 0;

    // Sort rows if a column is selected
    if (this.sortColumn) {
      var sortCol = this.sortColumn;
      var sortAsc = this.sortAsc;
      instanceRows.sort(function(a, b) {
        var aVal = sortCol === 'id' ? a.id : (a[sortCol] || 0);
        var bVal = sortCol === 'id' ? b.id : (b[sortCol] || 0);
        if (sortCol === 'id') {
          return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        return sortAsc ? aVal - bVal : bVal - aVal;
      });
    }

    // Display totals
    var displayTotals = this._canShowSystemUsage() ? filteredTotals : instanceSumTotals;

    var self = this;

    // Build header with sort arrows
    var columns = [
      { key: 'id', label: 'Instance', cls: '' },
      { key: 'input_tokens', label: 'Input', cls: 'num' },
      { key: 'output_tokens', label: 'Output', cls: 'num' },
      { key: 'cache_read', label: 'Cache Read', cls: 'num' },
      { key: 'cache_write', label: 'Cache Write', cls: 'num' },
      { key: 'total_tokens', label: 'Total', cls: 'num' },
      { key: 'cost_usd', label: 'Cost', cls: 'num' },
    ];

    var headerHtml = columns.map(function(col) {
      var arrow = '';
      if (self.sortColumn === col.key) {
        arrow = ' <span class="sort-arrow active">' + (self.sortAsc ? '\u25B2' : '\u25BC') + '</span>';
      } else {
        arrow = ' <span class="sort-arrow">\u25B2</span>';
      }
      return '<th class="' + col.cls + '" data-sort="' + col.key + '">' + col.label + arrow + '</th>';
    }).join('');

    // Build rows
    var rowsHtml = instanceRows.map(function(row) {
      return '<tr>' +
        '<td><span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ' + self._instanceColor(row.id) + '; margin-right: 6px; vertical-align: middle;"></span>' + self.esc(row.id) + '</td>' +
        '<td class="num">' + self.formatNum(row.input_tokens) + '</td>' +
        '<td class="num">' + self.formatNum(row.output_tokens) + '</td>' +
        '<td class="num">' + self.formatNum(row.cache_read) + '</td>' +
        '<td class="num">' + self.formatNum(row.cache_write) + '</td>' +
        '<td class="num">' + self.formatNum(row.total_tokens) + '</td>' +
        '<td class="num">' + self.formatUsd(row.cost_usd) + '</td>' +
      '</tr>';
    }).join('');

    // System row
    if (hasSystem && this._canShowSystemUsage()) {
      rowsHtml += '<tr style="color: var(--text-muted); font-style: italic;">' +
        '<td><span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ' + this._instanceColor('system') + '; margin-right: 6px; vertical-align: middle;"></span>system</td>' +
        '<td class="num">' + this.formatNum(systemRow.input_tokens) + '</td>' +
        '<td class="num">' + this.formatNum(systemRow.output_tokens) + '</td>' +
        '<td class="num">' + this.formatNum(systemRow.cache_read) + '</td>' +
        '<td class="num">' + this.formatNum(systemRow.cache_write) + '</td>' +
        '<td class="num">' + this.formatNum(systemRow.total_tokens) + '</td>' +
        '<td class="num">' + this.formatUsd(systemRow.cost_usd) + '</td>' +
      '</tr>';
    }

    // Totals row
    rowsHtml += '<tr class="total-row">' +
      '<td>Total</td>' +
      '<td class="num">' + this.formatNum(displayTotals.input_tokens) + '</td>' +
      '<td class="num">' + this.formatNum(displayTotals.output_tokens) + '</td>' +
      '<td class="num">' + this.formatNum(displayTotals.cache_read) + '</td>' +
      '<td class="num">' + this.formatNum(displayTotals.cache_write) + '</td>' +
      '<td class="num">' + this.formatNum(displayTotals.total_tokens) + '</td>' +
      '<td class="num">' + this.formatUsd(displayTotals.cost_usd) + '</td>' +
    '</tr>';

    el.innerHTML = '<div class="section-title">Token breakdown (' + this.tokenDays + 'd)</div>' +
      '<table class="data-table">' +
        '<thead><tr>' + headerHtml + '</tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>';

    // Bind sort clicks
    var ths = el.querySelectorAll('th[data-sort]');
    for (var si = 0; si < ths.length; si++) {
      ths[si].addEventListener('click', function(e) {
        var col = e.currentTarget.dataset.sort;
        if (self.sortColumn === col) {
          self.sortAsc = !self.sortAsc;
        } else {
          self.sortColumn = col;
          self.sortAsc = col === 'id' ? true : false; // default descending for numbers
        }
        self.renderTokenTable();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Schedule tab — calendar view + task list
  // ---------------------------------------------------------------------------

  renderSchedule() {
    this.renderScheduleCalendar();
    this.renderScheduleTable();
  }

  renderScheduleCalendar() {
    var el = document.getElementById('schedule-calendar');
    if (!el) return;
    if (!this.scheduleData) {
      el.innerHTML = this.renderSkeleton(5);
      return;
    }

    var month = this.scheduleMonth;
    var year = month.getFullYear();
    var m = month.getMonth();
    var monthName = month.toLocaleString('en', { month: 'long', year: 'numeric' });

    // Build map of date → tasks
    var tasksByDate = {};
    var tasks = this.scheduleData.tasks || [];
    var upcoming = this.scheduleData.upcoming || [];

    // Map upcoming scheduled events to dates (convert UTC date to local)
    upcoming.forEach(function(t) {
      if (!t.date || !t.time) return;
      // t.date and t.time are UTC — convert to local
      var utcDate = new Date(t.date + 'T' + t.time + ':00Z');
      var localDate = utcDate.getFullYear() + '-' + String(utcDate.getMonth() + 1).padStart(2, '0') + '-' + String(utcDate.getDate()).padStart(2, '0');
      var localTime = String(utcDate.getHours()).padStart(2, '0') + ':' + String(utcDate.getMinutes()).padStart(2, '0');
      var localEntry = Object.assign({}, t, { date: localDate, time: localTime });
      if (!tasksByDate[localDate]) tasksByDate[localDate] = [];
      tasksByDate[localDate].push(localEntry);
    });

    // Also map pending one-time tasks by their next_run date (local time)
    tasks.forEach(function(t) {
      if (t.status !== 'pending' || !t.next_run_human) return;
      // Convert UTC ISO to local date/time
      var local = new Date(t.next_run_human);
      var date = local.getFullYear() + '-' + String(local.getMonth() + 1).padStart(2, '0') + '-' + String(local.getDate()).padStart(2, '0');
      var time = String(local.getHours()).padStart(2, '0') + ':' + String(local.getMinutes()).padStart(2, '0');
      if (!tasksByDate[date]) tasksByDate[date] = [];
      var exists = tasksByDate[date].some(function(x) { return x.name === t.name; });
      if (!exists) {
        tasksByDate[date].push({
          date: date,
          time: time,
          name: t.name,
          type: t.type,
          priority: t.priority,
          target_instance: t.target_instance,
        });
      }
    });

    // Calendar grid (local time)
    var firstDay = new Date(year, m, 1).getDay(); // 0=Sun
    var daysInMonth = new Date(year, m + 1, 0).getDate();
    var now = new Date();
    var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

    var dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var headerHtml = dayHeaders.map(function(d) {
      return '<div class="cal-header">' + d + '</div>';
    }).join('');

    var cellsHtml = '';
    // Empty cells before first day
    for (var i = 0; i < firstDay; i++) {
      cellsHtml += '<div class="cal-cell cal-empty"></div>';
    }

    var self = this;
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = year + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var dayTasks = tasksByDate[dateStr] || [];
      var isToday = dateStr === today;
      var hasRecurring = dayTasks.some(function(t) { return t.type === 'recurring' || t.type === 'interval'; });
      var hasOneTime = dayTasks.some(function(t) { return t.type === 'one-time'; });

      var dotHtml = '';
      if (hasRecurring) dotHtml += '<span class="cal-dot cal-dot-recurring"></span>';
      if (hasOneTime) dotHtml += '<span class="cal-dot cal-dot-onetime"></span>';

      var tooltipLines = dayTasks.map(function(t) {
        return t.time + ' ' + self.esc(t.name) + (t.target_instance ? ' [' + t.target_instance + ']' : '');
      });
      var tooltip = tooltipLines.join('&#10;');

      cellsHtml += '<div class="cal-cell' + (isToday ? ' cal-today' : '') + (dayTasks.length ? ' cal-has-tasks' : '') + '"'
        + (tooltip ? ' title="' + tooltip + '"' : '') + '>'
        + '<span class="cal-day-num">' + d + '</span>'
        + (dotHtml ? '<div class="cal-dots">' + dotHtml + '</div>' : '')
        + '</div>';
    }

    el.innerHTML = '<div class="schedule-calendar-wrap">'
      + '<div class="cal-nav">'
      + '<button class="btn cal-prev" data-cal-nav="prev">&larr;</button>'
      + '<span class="cal-month">' + monthName + '</span>'
      + '<button class="btn cal-next" data-cal-nav="next">&rarr;</button>'
      + '</div>'
      + '<div class="cal-grid">' + headerHtml + cellsHtml + '</div>'
      + '<div class="cal-legend">'
      + '<span class="cal-legend-item"><span class="cal-dot cal-dot-recurring"></span> Recurring</span>'
      + '<span class="cal-legend-item"><span class="cal-dot cal-dot-onetime"></span> One-time</span>'
      + '</div>'
      + '</div>';

    // Bind nav buttons
    el.querySelectorAll('[data-cal-nav]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var dir = btn.dataset.calNav === 'prev' ? -1 : 1;
        self.scheduleMonth = new Date(year, m + dir, 1);
        self.renderScheduleCalendar();
      });
    });
  }

  renderScheduleTable() {
    var el = document.getElementById('schedule-table');
    if (!el) return;
    if (!this.scheduleData) {
      el.innerHTML = this.renderSkeleton(4);
      return;
    }

    var tasks = this.scheduleData.tasks || [];
    // Show pending + recent completed (last 10)
    var pending = tasks.filter(function(t) { return t.status === 'pending'; });
    var completed = tasks.filter(function(t) { return t.status === 'completed'; }).slice(-10).reverse();
    var display = pending.concat(completed);

    if (!display.length) {
      el.innerHTML = '<div class="empty-state">No scheduled tasks</div>';
      return;
    }

    var self = this;
    var rows = display.map(function(t) {
      var statusClass = t.status === 'pending' ? 'sched-pending' : 'sched-completed';
      var typeLabel = t.type === 'recurring' ? t.cron_expression || 'cron'
        : t.type === 'interval' ? self.formatInterval(t.interval_seconds)
        : 'one-time';
      var nextRun = t.next_run_human ? self.formatDateTime(t.next_run_human) : '-';
      var target = t.target_instance || 'admin';

      return '<tr>'
        + '<td><span class="sched-status ' + statusClass + '">' + t.status + '</span></td>'
        + '<td>' + self.esc(t.name) + '</td>'
        + '<td class="mono">' + self.esc(typeLabel) + '</td>'
        + '<td class="mono">' + nextRun + '</td>'
        + '<td>' + self.esc(target) + '</td>'
        + '<td>P' + (t.priority || 3) + '</td>'
        + '</tr>';
    }).join('');

    el.innerHTML = '<table class="data-table">'
      + '<thead><tr>'
      + '<th>Status</th><th>Name</th><th>Schedule</th><th>Next Run</th><th>Target</th><th>Pri</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  formatInterval(seconds) {
    if (!seconds) return '-';
    if (seconds >= 3600) return Math.floor(seconds / 3600) + 'h';
    return Math.floor(seconds / 60) + 'm';
  }

  formatDateTime(isoStr) {
    if (!isoStr) return '-';
    var d = new Date(isoStr);
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    var h = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return month + '-' + day + ' ' + h + ':' + min;
  }

  // ---------------------------------------------------------------------------
  // PM2 Processes tab
  // ---------------------------------------------------------------------------

  renderPm2() {
    var tableEl = document.getElementById('pm2-table');
    if (!tableEl) return;

    var processes = this.data.pm2_processes || [];

    if (processes.length === 0) {
      tableEl.innerHTML = '<div class="empty-state">No PM2 processes</div>';
      return;
    }

    var self = this;
    var rows = processes.map(function(proc) {
      var statusClass = 'pm2-' + proc.status;
      return '<tr>' +
        '<td>' + self.esc(proc.name) + '</td>' +
        '<td><span class="' + statusClass + '">' + proc.status + '</span></td>' +
        '<td>' + (proc.uptime_ms ? self.formatDuration(proc.uptime_ms) : '-') + '</td>' +
        '<td class="num">' + proc.restarts + '</td>' +
        '<td class="num">' + self.formatBytes(proc.memory) + '</td>' +
        '<td class="num">' + proc.cpu + '%</td>' +
      '</tr>';
    }).join('');

    tableEl.innerHTML = '<table class="data-table">' +
      '<thead><tr>' +
        '<th>Name</th>' +
        '<th>Status</th>' +
        '<th>Uptime</th>' +
        '<th class="num">Restarts</th>' +
        '<th class="num">Memory</th>' +
        '<th class="num">CPU</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
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
      var d = new Date(isoStr);
      return d.toLocaleString();
    } catch {
      return isoStr;
    }
  }

  formatDuration(ms) {
    if (!ms || ms < 0) return '-';
    var secs = Math.floor(ms / 1000);
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ' + (mins % 60) + 'm';
    var days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
  }

  formatHours(h) {
    if (!h) return '-';
    if (h < 1) return Math.round(h * 60) + 'm';
    if (h < 24) return h.toFixed(1) + 'h';
    var days = Math.floor(h / 24);
    var rem = (h % 24).toFixed(0);
    return days + 'd ' + rem + 'h';
  }

  formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  formatNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
  }

  formatTokens(n) {
    if (!n) return '0';
    if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  formatUsd(n) {
    if (n == null) return '$0.00';
    return '$' + Number(n).toFixed(2);
  }

  esc(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  new Dashboard();
});
