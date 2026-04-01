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
    this.calendarPinnedDate = null;
    this.calendarHoverDate = null;

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
      var lastActivity = inst.last_user_message
        ? this.formatTime(inst.last_user_message)
        : (inst.last_activity ? this.formatTime(inst.last_activity) : '-');
      var idleSeconds = inst.user_idle_seconds != null ? inst.user_idle_seconds : inst.idle_seconds;
      var idle = idleSeconds != null ? this.formatDuration(idleSeconds * 1000) : '-';
      var primaryMark = inst.primary ? ' <span style="color: var(--warning); font-size: 11px;">(primary)</span>' : '';
      var conv = convCounts[inst.id] || { total: 0, today: 0 };
      var convLabel = this.formatNum(conv.total) + (conv.today > 0 ? ' <span style="color:var(--accent)">(' + conv.today + ' today)</span>' : '');
      var burnToday = this._formatBurnCell(inst.token_burn?.today);
      var burnWeek = this._formatBurnCell(inst.token_burn?.week);
      var contextLabel = this._formatContextCell(inst.context_window);
      var handoffLabel = this._formatHandoffCell(inst.last_context_handoff);

      return '<tr>' +
        '<td style="width:20px"><span class="status-dot ' + statusClass + '"></span></td>' +
        '<td class="instance-name-cell">' + this.esc(inst.id) + primaryMark + '</td>' +
        '<td><span class="type-badge ' + typeClass + '">' + this.esc(typeLabel) + '</span></td>' +
        '<td>' + this.esc(statusLabel) + '</td>' +
        '<td class="mono">' + convLabel + '</td>' +
        '<td class="mono">' + burnToday + '</td>' +
        '<td class="mono">' + burnWeek + '</td>' +
        '<td class="mono">' + contextLabel + '</td>' +
        '<td class="mono">' + handoffLabel + '</td>' +
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
        '<th>Today</th>' +
        '<th>7d</th>' +
        '<th>Context</th>' +
        '<th>Last Handoff</th>' +
        '<th>Last User Msg</th>' +
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
    var contextWindow = inst.context_window || null;
    var lastContextHandoff = inst.last_context_handoff || null;
    var tokenBurn = inst.token_burn || {};

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
        '<span class="label">Today Burn</span><span class="value mono">' + this._formatBurnCell(tokenBurn.today) + '</span>' +
        '<span class="label">7d Burn</span><span class="value mono">' + this._formatBurnCell(tokenBurn.week) + '</span>' +
        '<span class="label">Context</span><span class="value mono">' + this._formatContextCell(contextWindow) + '</span>' +
        '<span class="label">Last Handoff</span><span class="value mono">' + this._formatHandoffCell(lastContextHandoff) + '</span>' +
        '<span class="label">Tmux</span><span class="value">' + (inst.tmux_alive ? 'alive' : 'dead') + '</span>' +
        ((inst.last_user_message || inst.last_activity) ? '<span class="label">Last User Msg</span><span class="value">' + this.formatTime(inst.last_user_message || inst.last_activity) + '</span>' : '') +
        (inst.uptime_ms ? '<span class="label">Uptime</span><span class="value">' + this.formatDuration(inst.uptime_ms) + '</span>' : '') +
        ((inst.user_idle_seconds != null || inst.idle_seconds != null) ? '<span class="label">Idle</span><span class="value">' + this.formatDuration((inst.user_idle_seconds != null ? inst.user_idle_seconds : inst.idle_seconds) * 1000) + '</span>' : '') +
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
    this.renderAggregateTrendChart();
    this.renderInstanceTrendChart();
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

  _rowTotalTokens(row) {
    if (!row) return 0;
    if (row.total_tokens != null) return row.total_tokens;
    return (row.input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read || 0) + (row.cache_write || 0);
  }

  _buildDailyBreakdown(days) {
    var tokenView = this._getTokenView();
    var instances = tokenView.instances || {};
    var includeSystem = this._canShowSystemUsage();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    var startStr = start.toISOString().slice(0, 10);
    var endStr = today.toISOString().slice(0, 10);
    var map = new Map();

    function ensure(date) {
      if (!map.has(date)) {
        map.set(date, {
          date: date,
          total_tokens: 0,
          cost_usd: 0,
          runtimes: { claude: 0, codex: 0, other: 0 },
          runtimeCost: { claude: 0, codex: 0, other: 0 },
          instances: {},
          instanceCost: {},
          system_tokens: 0,
          system_cost: 0,
        });
      }
      return map.get(date);
    }

    for (var cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      ensure(cursor.toISOString().slice(0, 10));
    }

    var ids = Object.keys(instances).sort();
    for (var i = 0; i < ids.length; i++) {
      var instanceId = ids[i];
      var inst = instances[instanceId];
      var runtimeBuckets = this.tokenRuntimeFilter === 'all'
        ? Object.keys(inst.runtimes || {})
        : [this.tokenRuntimeFilter];

      for (var r = 0; r < runtimeBuckets.length; r++) {
        var runtime = runtimeBuckets[r];
        var rows = inst.runtimes?.[runtime]?.daily || [];
        for (var j = 0; j < rows.length; j++) {
          var row = rows[j];
          if (!row.date || row.date < startStr || row.date > endStr) continue;
          var day = ensure(row.date);
          var tokens = this._rowTotalTokens(row);
          var cost = row.cost_usd || 0;
          day.total_tokens += tokens;
          day.cost_usd += cost;
          day.runtimes[runtime] = (day.runtimes[runtime] || 0) + tokens;
          day.runtimeCost[runtime] = (day.runtimeCost[runtime] || 0) + cost;
          day.instances[instanceId] = (day.instances[instanceId] || 0) + tokens;
          day.instanceCost[instanceId] = (day.instanceCost[instanceId] || 0) + cost;
        }
      }
    }

    if (includeSystem && this.tokenRuntimeFilter === 'all') {
      var allDaily = this.tokenData?.daily || [];
      for (var k = 0; k < allDaily.length; k++) {
        var totalRow = allDaily[k];
        if (!totalRow.date || totalRow.date < startStr || totalRow.date > endStr) continue;
        var totalTokens = this._rowTotalTokens(totalRow);
        var totalCost = totalRow.cost_usd || 0;
        var aggregate = ensure(totalRow.date);
        var systemTokens = Math.max(0, totalTokens - aggregate.total_tokens);
        var systemCost = Math.max(0, totalCost - aggregate.cost_usd);
        if (systemTokens > 0 || systemCost > 0) {
          aggregate.total_tokens += systemTokens;
          aggregate.cost_usd += systemCost;
          aggregate.system_tokens += systemTokens;
          aggregate.system_cost += systemCost;
          aggregate.instances.system = (aggregate.instances.system || 0) + systemTokens;
          aggregate.instanceCost.system = (aggregate.instanceCost.system || 0) + systemCost;
        }
      }
    }

    var daysArr = Array.from(map.values()).sort(function(a, b) { return a.date.localeCompare(b.date); });
    var nonZero = daysArr.map(function(day) { return day.total_tokens; }).filter(function(v) { return v > 0; });
    var stats = {
      min: nonZero.length ? Math.min.apply(null, nonZero) : 0,
      max: nonZero.length ? Math.max.apply(null, nonZero) : 0,
      avg: nonZero.length ? (nonZero.reduce(function(sum, v) { return sum + v; }, 0) / nonZero.length) : 0,
    };

    return { days: daysArr, map: map, stats: stats };
  }

  _calendarHeatAlpha(value, stats) {
    if (!value || !stats || !stats.max) return 0;
    var min = stats.min || 0;
    var avg = stats.avg || 0;
    var max = stats.max || 0;
    if (max <= 0) return 0;
    if (avg <= min) avg = min + (max - min) / 2;
    if (value <= avg) {
      var lowerSpan = Math.max(1, avg - min);
      return 0.18 + 0.42 * ((value - min) / lowerSpan);
    }
    var upperSpan = Math.max(1, max - avg);
    return 0.62 + 0.33 * ((value - avg) / upperSpan);
  }

  _calendarHeatStyle(day, stats) {
    if (!day || !day.total_tokens) {
      return { background: 'var(--bg-200)', color: 'var(--text-muted)', borderColor: 'var(--border)' };
    }
    var alpha = Math.max(0.18, Math.min(0.95, this._calendarHeatAlpha(day.total_tokens, stats)));
    return {
      background: 'rgba(50, 145, 255, ' + alpha.toFixed(3) + ')',
      color: alpha > 0.55 ? '#ffffff' : 'var(--text-primary)',
      borderColor: alpha > 0.75 ? 'rgba(255,255,255,0.18)' : 'rgba(50, 145, 255, 0.25)',
    };
  }

  _renderPieCard(title, slices, total, colorFn) {
    var usable = (slices || []).filter(function(slice) { return slice.value > 0; });
    if (!usable.length || !total) {
      return '<div class="usage-detail-card"><div class="usage-detail-title">' + this.esc(title) + '</div><div class="empty-state" style="padding:24px 12px">No usage</div></div>';
    }

    usable.sort(function(a, b) { return b.value - a.value; });
    var angle = 0;
    var stops = [];
    for (var i = 0; i < usable.length; i++) {
      var slice = usable[i];
      var pct = slice.value / total;
      slice.pct = pct * 100;
      var color = colorFn(slice.key, i);
      stops.push(color + ' ' + angle + 'deg ' + (angle + pct * 360) + 'deg');
      angle += pct * 360;
    }

    var legend = usable.map(function(slice, idx) {
      return '<div class="usage-detail-legend-item">' +
        '<span class="usage-detail-legend-swatch" style="background:' + colorFn(slice.key, idx) + '"></span>' +
        '<span class="usage-detail-legend-name">' + this.esc(slice.label || slice.key) + '</span>' +
        '<span class="usage-detail-legend-value">' + this.formatTokens(slice.value) + '</span>' +
        '<span class="usage-detail-legend-pct">' + slice.pct.toFixed(1) + '%</span>' +
      '</div>';
    }.bind(this)).join('');

    return '<div class="usage-detail-card">' +
      '<div class="usage-detail-title">' + this.esc(title) + '</div>' +
      '<div class="usage-detail-pie-wrap">' +
        '<div class="usage-detail-pie" style="background:conic-gradient(' + stops.join(', ') + ')">' +
          '<div class="usage-detail-pie-hole">' +
            '<div class="usage-detail-pie-total">' + this.formatTokens(total) + '</div>' +
            '<div class="usage-detail-pie-label">tokens</div>' +
          '</div>' +
        '</div>' +
        '<div class="usage-detail-legend">' + legend + '</div>' +
      '</div>' +
    '</div>';
  }

  _renderTrendSvg(seriesList, opts) {
    var width = opts.width || 980;
    var height = opts.height || 240;
    var padLeft = 56;
    var padRight = 18;
    var padTop = 18;
    var padBottom = 30;
    var innerWidth = width - padLeft - padRight;
    var innerHeight = height - padTop - padBottom;

    var dates = (opts.dates || []);
    if (!dates.length) {
      return '<div class="empty-state">No usage data</div>';
    }

    var maxVal = Math.max.apply(null, seriesList.reduce(function(acc, series) {
      return acc.concat(series.values);
    }, []).concat([1]));

    var yTicks = [];
    for (var i = 0; i < 5; i++) {
      var ratio = i / 4;
      yTicks.push({
        value: Math.round(maxVal * (1 - ratio)),
        y: padTop + innerHeight * ratio,
      });
    }

    function xFor(index) {
      if (dates.length === 1) return padLeft + innerWidth / 2;
      return padLeft + (innerWidth * index) / (dates.length - 1);
    }

    function yFor(value) {
      if (maxVal <= 0) return padTop + innerHeight;
      return padTop + innerHeight - (value / maxVal) * innerHeight;
    }

    var grid = yTicks.map(function(tick) {
      return '<line x1="' + padLeft + '" y1="' + tick.y + '" x2="' + (width - padRight) + '" y2="' + tick.y + '" class="trend-gridline"></line>' +
        '<text x="' + (padLeft - 10) + '" y="' + (tick.y + 4) + '" text-anchor="end" class="trend-axis-label">' + this.formatTokens(tick.value) + '</text>';
    }.bind(this)).join('');

    var xLabels = dates.map(function(date, index) {
      var show = dates.length <= 10 || index === 0 || index === dates.length - 1 || index % Math.ceil(dates.length / 6) === 0;
      if (!show) return '';
      return '<text x="' + xFor(index) + '" y="' + (height - 8) + '" text-anchor="middle" class="trend-axis-label">' + date.slice(5) + '</text>';
    }).join('');

    var seriesSvg = seriesList.map(function(series, seriesIndex) {
      var color = series.color;
      var points = series.values.map(function(value, index) {
        return xFor(index) + ',' + yFor(value);
      }).join(' ');
      var circles = series.values.map(function(value, index) {
        var cx = xFor(index);
        var cy = yFor(value);
        var cost = series.costValues ? (series.costValues[index] || 0) : 0;
        return '<g class="trend-point-group">' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="3" fill="' + color + '"></circle>' +
          '<circle class="trend-hit" cx="' + cx + '" cy="' + cy + '" r="11" fill="transparent" ' +
            'data-series="' + this.esc(series.label) + '" ' +
            'data-date="' + this.esc(dates[index]) + '" ' +
            'data-tokens="' + value + '" ' +
            'data-cost="' + cost + '"' +
          '></circle>' +
        '</g>';
      }.bind(this)).join('');

      var area = '';
      if (seriesIndex === 0 && opts.area) {
        var areaPoints = points + ' ' + xFor(dates.length - 1) + ',' + (padTop + innerHeight) + ' ' + xFor(0) + ',' + (padTop + innerHeight);
        area = '<polygon points="' + areaPoints + '" fill="' + color + '" opacity="0.12"></polygon>';
      }

      return area +
        '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="' + (series.strokeWidth || 2.5) + '" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
        circles;
    }.bind(this)).join('');

    var legend = seriesList.map(function(series) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' + series.color + '"></span>' + this.esc(series.label) + '</span>';
    }.bind(this)).join('');

    return '<div class="trend-chart-card">' +
      '<div class="trend-tooltip" hidden></div>' +
      '<div class="chart-legend">' + legend + '</div>' +
      '<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-svg" role="img" aria-label="' + this.esc(opts.ariaLabel || 'Usage trend') + '">' +
        grid +
        seriesSvg +
        xLabels +
      '</svg>' +
    '</div>';
  }

  _renderStackedAreaSvg(seriesList, breakdownDays, opts) {
    var width = opts.width || 980;
    var height = opts.height || 280;
    var padLeft = 56;
    var padRight = 18;
    var padTop = 18;
    var padBottom = 32;
    var innerWidth = width - padLeft - padRight;
    var innerHeight = height - padTop - padBottom;
    var dates = breakdownDays.map(function(day) { return day.date; });
    if (!dates.length || !seriesList.length) {
      return '<div class="empty-state">No usage data</div>';
    }

    var totals = breakdownDays.map(function(day) { return day.total_tokens || 0; });
    var maxVal = Math.max.apply(null, totals.concat([1]));

    function xFor(index) {
      if (dates.length === 1) return padLeft + innerWidth / 2;
      return padLeft + (innerWidth * index) / (dates.length - 1);
    }

    function yFor(value) {
      if (maxVal <= 0) return padTop + innerHeight;
      return padTop + innerHeight - (value / maxVal) * innerHeight;
    }

    var yTicks = [];
    for (var i = 0; i < 5; i++) {
      var ratio = i / 4;
      yTicks.push({
        value: Math.round(maxVal * (1 - ratio)),
        y: padTop + innerHeight * ratio,
      });
    }

    var grid = yTicks.map(function(tick) {
      return '<line x1="' + padLeft + '" y1="' + tick.y + '" x2="' + (width - padRight) + '" y2="' + tick.y + '" class="trend-gridline"></line>' +
        '<text x="' + (padLeft - 10) + '" y="' + (tick.y + 4) + '" text-anchor="end" class="trend-axis-label">' + this.formatTokens(tick.value) + '</text>';
    }.bind(this)).join('');

    var xLabels = dates.map(function(date, index) {
      var show = dates.length <= 10 || index === 0 || index === dates.length - 1 || index % Math.ceil(dates.length / 6) === 0;
      if (!show) return '';
      return '<text x="' + xFor(index) + '" y="' + (height - 8) + '" text-anchor="middle" class="trend-axis-label">' + date.slice(5) + '</text>';
    }).join('');

    var cumulative = new Array(dates.length).fill(0);
    var layers = '';
    for (var s = 0; s < seriesList.length; s++) {
      var series = seriesList[s];
      var topPoints = [];
      var bottomPoints = [];
      for (var index = 0; index < dates.length; index++) {
        var bottom = cumulative[index];
        var top = bottom + (series.values[index] || 0);
        cumulative[index] = top;
        topPoints.push(xFor(index) + ',' + yFor(top));
        bottomPoints.push(xFor(index) + ',' + yFor(bottom));
      }

      var polygon = topPoints.join(' ') + ' ' + bottomPoints.reverse().join(' ');
      layers += '<polygon points="' + polygon + '" fill="' + series.color + '" opacity="0.26"></polygon>';
      layers += '<polyline points="' + topPoints.join(' ') + '" fill="none" stroke="' + series.color + '" stroke-width="1.8" stroke-linejoin="round"></polyline>';
    }

    var bandWidth = dates.length > 1 ? innerWidth / (dates.length - 1) : innerWidth;
    var hoverBands = dates.map(function(date, index) {
      var x = xFor(index) - bandWidth / 2;
      if (index === 0) x = padLeft;
      if (index === dates.length - 1) x = width - padRight - bandWidth / 2;
      return '<rect class="trend-stack-hit" x="' + x + '" y="' + padTop + '" width="' + Math.max(18, bandWidth) + '" height="' + innerHeight + '" ' +
        'data-index="' + index + '"></rect>';
    }).join('');

    var legend = seriesList.map(function(series) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' + series.color + '"></span>' + this.esc(series.label) + '</span>';
    }.bind(this)).join('');

    return '<div class="trend-chart-card trend-chart-card-stacked">' +
      '<div class="trend-tooltip" hidden></div>' +
      '<div class="chart-legend">' + legend + '</div>' +
      '<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-svg" role="img" aria-label="' + this.esc(opts.ariaLabel || 'Per-instance usage trend') + '">' +
        grid +
        layers +
        hoverBands +
        xLabels +
      '</svg>' +
    '</div>';
  }

  renderAggregateTrendChart() {
    var el = document.getElementById('token-trend-total');
    if (!el || !this.tokenData) return;
    var breakdown = this._buildDailyBreakdown(this.tokenDays);
    var dates = breakdown.days.map(function(day) { return day.date; });
    var values = breakdown.days.map(function(day) { return day.total_tokens; });
    if (!dates.length || !values.some(function(v) { return v > 0; })) {
      el.innerHTML = '<div class="empty-state">No usage data</div>';
      return;
    }

    el.innerHTML = this._renderTrendSvg([
      {
        label: this.tokenRuntimeFilter === 'all' ? 'All usage' : (this.tokenRuntimeFilter === 'claude' ? 'Claude' : 'Codex'),
        values: values,
        costValues: breakdown.days.map(function(day) { return day.cost_usd || 0; }),
        color: '#3291ff',
        strokeWidth: 3,
      }
    ], {
      dates: dates,
      area: true,
      ariaLabel: 'Aggregate token usage trend',
    });
    this._bindTrendTooltips(el);
  }

  renderInstanceTrendChart() {
    var el = document.getElementById('token-trend-instances');
    if (!el || !this.tokenData) return;
    var breakdown = this._buildDailyBreakdown(this.tokenDays);
    var dates = breakdown.days.map(function(day) { return day.date; });
    var tokenView = this._getTokenView();
    var instanceIds = Object.keys(tokenView.instances || {}).sort();
    var series = instanceIds.map(function(instanceId) {
      return {
        key: instanceId,
        label: instanceId,
        color: this._instanceColor(instanceId),
        values: breakdown.days.map(function(day) { return day.instances[instanceId] || 0; }),
        costValues: breakdown.days.map(function(day) { return day.instanceCost[instanceId] || 0; }),
      };
    }.bind(this)).filter(function(series) {
      return series.values.some(function(v) { return v > 0; });
    });

    if (!dates.length || !series.length) {
      el.innerHTML = '<div class="empty-state">No per-instance usage data</div>';
      return;
    }

    el.innerHTML = this._renderStackedAreaSvg(series, breakdown.days, {
      ariaLabel: 'Per-instance token usage trend',
    });
    this._bindStackedAreaTooltips(el, breakdown.days, series);
  }

  _bindTrendTooltips(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.trend-chart-card');
    cards.forEach(function(card) {
      var tooltip = card.querySelector('.trend-tooltip');
      if (!tooltip) return;
      var hits = card.querySelectorAll('.trend-hit');
      hits.forEach(function(hit) {
        function showTooltip(evt) {
          var series = hit.dataset.series || '';
          var date = hit.dataset.date || '';
          var tokens = Number(hit.dataset.tokens || 0);
          var cost = Number(hit.dataset.cost || 0);
          tooltip.innerHTML =
            '<div class="trend-tooltip-date">' + this.esc(date) + '</div>' +
            '<div class="trend-tooltip-series">' + this.esc(series) + '</div>' +
            '<div class="trend-tooltip-line">' + this.formatTokens(tokens) + ' tokens</div>' +
            '<div class="trend-tooltip-line">' + this.formatUsd(cost) + '</div>';
          tooltip.hidden = false;

          var cardRect = card.getBoundingClientRect();
          var x = evt.clientX - cardRect.left + 12;
          var y = evt.clientY - cardRect.top - 12;
          tooltip.style.left = x + 'px';
          tooltip.style.top = y + 'px';
        }

        hit.addEventListener('mouseenter', showTooltip.bind(this));
        hit.addEventListener('mousemove', showTooltip.bind(this));
        hit.addEventListener('mouseleave', function() {
          tooltip.hidden = true;
        });
      }.bind(this));
    }.bind(this));
  }

  _bindStackedAreaTooltips(root, breakdownDays, seriesList) {
    if (!root) return;
    var card = root.querySelector('.trend-chart-card-stacked');
    if (!card) return;
    var tooltip = card.querySelector('.trend-tooltip');
    if (!tooltip) return;
    var hits = card.querySelectorAll('.trend-stack-hit');
    hits.forEach(function(hit) {
      function showTooltip(evt) {
        var index = Number(hit.dataset.index || 0);
        var day = breakdownDays[index];
        if (!day) return;
        var total = day.total_tokens || 0;
        var totalCost = day.cost_usd || 0;
        var rows = seriesList.map(function(series) {
          var value = series.values[index] || 0;
          if (!value) return '';
          var pct = total > 0 ? (value / total) * 100 : 0;
          return '<div class="trend-tooltip-breakdown-row">' +
            '<span class="trend-tooltip-breakdown-name"><span class="legend-swatch" style="background:' + series.color + '"></span>' + this.esc(series.label) + '</span>' +
            '<span class="trend-tooltip-breakdown-value">' + this.formatTokens(value) + '</span>' +
            '<span class="trend-tooltip-breakdown-pct">' + pct.toFixed(1) + '%</span>' +
          '</div>';
        }.bind(this)).filter(Boolean).join('');

        tooltip.innerHTML =
          '<div class="trend-tooltip-date">' + this.esc(day.date) + '</div>' +
          '<div class="trend-tooltip-series">Total · ' + this.formatTokens(total) + ' tokens · ' + this.formatUsd(totalCost) + '</div>' +
          rows;
        tooltip.hidden = false;

        var cardRect = card.getBoundingClientRect();
        tooltip.style.left = (evt.clientX - cardRect.left + 12) + 'px';
        tooltip.style.top = (evt.clientY - cardRect.top - 12) + 'px';
      }

      hit.addEventListener('mouseenter', showTooltip.bind(this));
      hit.addEventListener('mousemove', showTooltip.bind(this));
      hit.addEventListener('mouseleave', function() {
        tooltip.hidden = true;
      });
    }.bind(this));
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
    var instances = this.data?.instances || [];
    var matching = instances.filter(function(inst) {
      return (inst.runtime || 'claude') === runtime;
    });
    var runtimeUsage = this.data?.runtime_usage?.[runtime];

    if (runtimeUsage) {
      return {
        usage: {
          runtime: runtime,
          available: true,
          session: runtimeUsage.session || null,
          fiveHour: runtimeUsage.fiveHour || null,
          weeklyAll: runtimeUsage.weeklyAll || null,
          weeklySonnet: runtimeUsage.weeklySonnet || null,
          tier: null,
          lastCheck: runtimeUsage.lastCheck || null,
        },
        instanceCount: matching.length,
      };
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

  _contextSourceLabel(source) {
    if (!source) return 'n/a';
    if (source === 'claude_statusline') return 'statusline';
    if (source === 'rollout_token_count') return 'rollout';
    if (source === 'sqlite_fallback') return 'sqlite';
    return source;
  }

  _formatBurnCell(burn) {
    if (!burn || (!burn.total_tokens && !burn.cost_usd)) return '-';
    return this.formatUsd(burn.cost_usd || 0) + ' · ' + this.formatTokens(burn.total_tokens || 0);
  }

  _formatContextCell(contextWindow) {
    if (!contextWindow || !contextWindow.available || contextWindow.percent_used === null || contextWindow.percent_used === undefined) {
      return '-';
    }
    var used = this.formatTokens(contextWindow.used_tokens || 0);
    var ceiling = this.formatTokens(contextWindow.ceiling_tokens || 0);
    var source = this._contextSourceLabel(contextWindow.source);
    var age = contextWindow.age_minutes === null || contextWindow.age_minutes === undefined || contextWindow.age_minutes < 2
      ? ''
      : ' · ' + contextWindow.age_minutes + 'm';
    return contextWindow.percent_used + '% · ' + used + ' / ' + ceiling + ' · ' + source + age;
  }

  _formatHandoffCell(handoff) {
    if (!handoff || !handoff.available || !handoff.triggered_at) return '-';
    var enqueue = handoff.enqueue_ok === false ? ' failed' : '';
    var used = this.formatTokens(handoff.used_tokens || 0);
    var ceiling = this.formatTokens(handoff.ceiling_tokens || 0);
    return handoff.percent_used + '% · ' + used + ' / ' + ceiling + ' · ' + this._contextSourceLabel(handoff.source) + ' · ' + this.formatTime(handoff.triggered_at) + enqueue;
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
    var self = this;
    var breakdown = this._buildDailyBreakdown(90);
    var stats = breakdown.stats;
    var dayMap = breakdown.map;
    var days = breakdown.days;
    if (!days.length) {
      el.innerHTML = '<div class="empty-state">No usage data</div>';
      this.renderCalendarBreakdown(null, breakdown);
      return;
    }

    var defaultDate = this.calendarPinnedDate || this.calendarHoverDate;
    if (!defaultDate || !dayMap.has(defaultDate)) {
      for (var di = days.length - 1; di >= 0; di--) {
        if (days[di].total_tokens > 0) {
          defaultDate = days[di].date;
          break;
        }
      }
      if (!defaultDate) defaultDate = days[days.length - 1].date;
      if (!this.calendarPinnedDate) this.calendarHoverDate = defaultDate;
    }

    var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var firstDate = new Date(days[0].date + 'T00:00:00Z');
    var lastDate = new Date(days[days.length - 1].date + 'T00:00:00Z');
    var cursor = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), 1));
    var monthsHtml = '';

    while (cursor <= lastDate) {
      var year = cursor.getUTCFullYear();
      var month = cursor.getUTCMonth();
      var monthKey = year + '-' + String(month + 1).padStart(2, '0');
      var firstOfMonth = new Date(Date.UTC(year, month, 1));
      var lastOfMonth = new Date(Date.UTC(year, month + 1, 0));
      var firstWeekday = (firstOfMonth.getUTCDay() + 6) % 7;
      var cells = [];
      var monthHasData = false;

      for (var blank = 0; blank < firstWeekday; blank++) {
        cells.push('<div class="calendar-month-cell is-empty"></div>');
      }

      for (var dayNum = 1; dayNum <= lastOfMonth.getUTCDate(); dayNum++) {
        var dateObj = new Date(Date.UTC(year, month, dayNum));
        var dateKey = dateObj.toISOString().slice(0, 10);
        var dayData = dayMap.get(dateKey);
        if (!dayData) {
          cells.push('<div class="calendar-month-cell is-outside"><span class="calendar-month-date">' + dayNum + '</span></div>');
          continue;
        }
        if (dayData.total_tokens > 0) monthHasData = true;

        var style = this._calendarHeatStyle(dayData, stats);
        var tokenLabel = dayData.total_tokens > 0 ? this.formatTokens(dayData.total_tokens) : '0';
        var costLabel = dayData.cost_usd > 0 ? this.formatUsd(dayData.cost_usd) : '$0.00';
        var selected = dateKey === this.calendarPinnedDate || (!this.calendarPinnedDate && dateKey === this.calendarHoverDate);
        cells.push(
          '<button class="calendar-month-cell' + (selected ? ' is-selected' : '') + '" ' +
            'data-date="' + dateKey + '" ' +
            'style="background:' + style.background + ';color:' + style.color + ';border-color:' + style.borderColor + ';">' +
            '<span class="calendar-month-date">' + dayNum + '</span>' +
            '<span class="calendar-month-metrics">' +
              '<span class="calendar-month-tokens">' + tokenLabel + '</span>' +
              '<span class="calendar-month-cost">' + costLabel + '</span>' +
            '</span>' +
          '</button>'
        );
      }

      while (cells.length % 7 !== 0) {
        cells.push('<div class="calendar-month-cell is-empty"></div>');
      }

      if (!monthHasData) {
        cursor = new Date(Date.UTC(year, month + 1, 1));
        continue;
      }

      monthsHtml += '<section class="calendar-month-card" data-month="' + monthKey + '">' +
        '<div class="calendar-month-card-header">' +
          '<div class="calendar-month-card-title">' + monthNames[month] + ' ' + year + '</div>' +
        '</div>' +
        '<div class="calendar-month-weekdays">' +
          '<span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>' +
        '</div>' +
        '<div class="calendar-month-grid">' + cells.join('') + '</div>' +
      '</section>';

      cursor = new Date(Date.UTC(year, month + 1, 1));
    }

    el.innerHTML = '<div class="calendar-shell">' +
      '<div class="calendar-shell-header">' +
        '<div class="calendar-shell-copy">' +
          '<div class="calendar-shell-title">Last 90 days</div>' +
          '<div class="calendar-shell-meta">Adaptive intensity from min ' + this.formatTokens(stats.min) + ' · avg ' + this.formatTokens(Math.round(stats.avg || 0)) + ' · max ' + this.formatTokens(stats.max) + '</div>' +
        '</div>' +
        '<div class="calendar-shell-scale">' +
          '<span>Low</span>' +
          '<span class="calendar-scale-chip" style="background:rgba(50,145,255,0.18)"></span>' +
          '<span class="calendar-scale-chip" style="background:rgba(50,145,255,0.40)"></span>' +
          '<span class="calendar-scale-chip" style="background:rgba(50,145,255,0.65)"></span>' +
          '<span class="calendar-scale-chip" style="background:rgba(50,145,255,0.92)"></span>' +
          '<span>High</span>' +
        '</div>' +
      '</div>' +
      '<div class="calendar-months-grid">' + monthsHtml + '</div>' +
    '</div>';

    var cellsEls = el.querySelectorAll('.calendar-month-cell[data-date]');
    cellsEls.forEach(function(cell) {
      cell.addEventListener('mouseenter', function() {
        if (self.calendarPinnedDate) return;
        self.calendarHoverDate = cell.dataset.date;
        self.renderTokenCalendar();
      });
      cell.addEventListener('click', function() {
        var date = cell.dataset.date;
        self.calendarPinnedDate = self.calendarPinnedDate === date ? null : date;
        self.calendarHoverDate = date;
        self.renderTokenCalendar();
      });
    });

    this.renderCalendarBreakdown(this.calendarPinnedDate || this.calendarHoverDate, breakdown);
  }

  renderCalendarBreakdown(selectedDate, breakdown) {
    var el = document.getElementById('calendar-breakdown');
    if (!el) return;
    if (!breakdown || !selectedDate || !breakdown.map.has(selectedDate)) {
      el.innerHTML = '<div class="empty-state">Hover or click a day to inspect its breakdown.</div>';
      return;
    }

    var day = breakdown.map.get(selectedDate);
    var runtimeSlices = Object.keys(day.runtimes).map(function(runtime) {
      return {
        key: runtime,
        label: runtime,
        value: day.runtimes[runtime] || 0,
      };
    }).filter(function(slice) { return slice.value > 0; });

    var instanceSlices = Object.keys(day.instances).map(function(instanceId) {
      return {
        key: instanceId,
        label: instanceId,
        value: day.instances[instanceId] || 0,
      };
    }).filter(function(slice) { return slice.value > 0; }).sort(function(a, b) { return b.value - a.value; });

    var runtimeColor = function(key) {
      if (key === 'claude') return '#f5a623';
      if (key === 'codex') return '#3291ff';
      if (key === 'system') return '#6b7280';
      return '#14b8a6';
    };

    el.innerHTML = '<div class="usage-breakdown-shell">' +
      '<div class="usage-breakdown-header">' +
        '<div>' +
          '<div class="usage-breakdown-date">' + this.esc(selectedDate) + '</div>' +
          '<div class="usage-breakdown-meta">' + this.formatTokens(day.total_tokens) + ' tokens · ' + this.formatUsd(day.cost_usd || 0) + '</div>' +
        '</div>' +
        '<div class="usage-breakdown-hint">' + (this.calendarPinnedDate ? 'Pinned selection' : 'Hover preview') + '</div>' +
      '</div>' +
      '<div class="usage-breakdown-grid">' +
        this._renderPieCard('By Runtime', runtimeSlices, day.total_tokens, runtimeColor) +
        this._renderPieCard('By Instance', instanceSlices, day.total_tokens, this._instanceColor.bind(this)) +
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
