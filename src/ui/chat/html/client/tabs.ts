// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 多会话标签行 + agent 选择器 + 会话头（标题 / usage 条）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const tabsClient = `
(function (NS) {
  'use strict';

  var tabsEl = null;
  var agentBar = null;
  var agentSelect = null;
  var sessionTitle = null;
  var usageBar = null;
  var state = { sessions: [], focusedId: null, focusedAgent: null };

  function init() {
    tabsEl = NS.dom.qs('tabs');
    agentBar = NS.dom.qs('agentBar');
    agentSelect = NS.dom.qs('agentSelect');
    sessionTitle = NS.dom.qs('sessionTitle');
    usageBar = NS.dom.qs('usageBar');

    NS.dom.qs('newTab').addEventListener('click', function () {
      if (state.focusedAgent) {
        NS.bridge.post({ type: 'newSession', agentName: state.focusedAgent });
      }
    });

    agentSelect.addEventListener('change', function () {
      var agentName = agentSelect.value;
      if (agentName) { NS.bridge.post({ type: 'focusAgent', agentName: agentName }); }
    });
  }

  function tabLabel(summary) {
    if (summary.title && summary.title.length > 0) { return summary.title; }
    if (summary.sessionId) { return summary.sessionId.slice(0, 8); }
    return 'session';
  }

  function dotClass(summary) {
    if (summary.loading) { return 'tab-dot loading'; }
    if (summary.running) { return 'tab-dot running'; }
    return 'tab-dot';
  }

  function renderTabs() {
    NS.dom.clear(tabsEl);
    for (var i = 0; i < state.sessions.length; i++) {
      (function (summary) {
        var active = summary.sessionId === state.focusedId;
        var tab = NS.dom.el('div', 'tab' + (active ? ' active' : ''));
        tab.setAttribute('role', 'tab');
        tab.title = tabLabel(summary) + '\\n' + summary.sessionId;

        tab.appendChild(NS.dom.el('span', dotClass(summary)));
        tab.appendChild(NS.dom.el('span', 'tab-label', tabLabel(summary)));

        var close = NS.dom.el('button', 'tab-close', '\\u00d7');
        close.title = 'Close this session';
        close.addEventListener('click', function (event) {
          event.stopPropagation();
          NS.bridge.post({ type: 'closeSession', sessionId: summary.sessionId });
        });
        tab.appendChild(close);

        tab.addEventListener('click', function () {
          if (!active) { NS.bridge.post({ type: 'focusSession', sessionId: summary.sessionId }); }
        });
        tabsEl.appendChild(tab);
      })(state.sessions[i]);
    }
  }

  /** The agent bar is only worth showing when more than one agent is live. */
  function renderAgentBar() {
    var agents = [];
    var seen = {};
    for (var i = 0; i < state.sessions.length; i++) {
      var name = state.sessions[i].agentName;
      if (!seen[name]) { seen[name] = true; agents.push(name); }
    }
    if (agents.length <= 1) {
      agentBar.hidden = true;
      return;
    }
    agentBar.hidden = false;
    NS.dom.clear(agentSelect);
    for (var j = 0; j < agents.length; j++) {
      var opt = document.createElement('option');
      opt.value = agents[j];
      opt.textContent = agents[j];
      if (agents[j] === state.focusedAgent) { opt.selected = true; }
      agentSelect.appendChild(opt);
    }
  }

  function renderHeader(summary) {
    if (!summary) {
      sessionTitle.textContent = '';
      usageBar.hidden = true;
      return;
    }
    sessionTitle.textContent = summary.cwd || '';
    sessionTitle.title = summary.sessionId;
  }

  function renderUsage(meta) {
    if (!meta || !meta.usage || !meta.usage.size) {
      usageBar.hidden = true;
      return;
    }
    var usage = meta.usage;
    var pct = Math.max(0, Math.min(1, usage.used / usage.size));
    usageBar.hidden = false;
    NS.dom.clear(usageBar);

    var fillClass = 'usage-fill' + (pct > 0.9 ? ' hot' : (pct > 0.7 ? ' warn' : ''));
    var track = NS.dom.el('span', 'usage-track');
    var fill = NS.dom.el('span', fillClass);
    fill.style.width = Math.round(pct * 100) + '%';
    track.appendChild(fill);
    usageBar.appendChild(track);

    var label = Math.round(usage.used / 1000) + 'k / ' + Math.round(usage.size / 1000) + 'k tokens';
    if (usage.costAmount !== undefined && usage.costAmount !== null) {
      label += '  ' + usage.costAmount + ' ' + (usage.costCurrency || '');
    }
    usageBar.appendChild(document.createTextNode(label));
  }

  function setSessions(sessions) {
    state.sessions = sessions || [];
    renderTabs();
    renderAgentBar();
  }

  function setFocus(summary) {
    state.focusedId = summary ? summary.sessionId : null;
    state.focusedAgent = summary ? summary.agentName : null;
    renderTabs();
    renderHeader(summary);
  }

  NS.tabs = {
    init: init,
    setSessions: setSessions,
    setFocus: setFocus,
    renderUsage: renderUsage
  };
})(window.__acpc = window.__acpc || {});
`;
