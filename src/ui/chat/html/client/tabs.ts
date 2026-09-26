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
  var cwdBtn = null;
  var usageBar = null;
  // [CUSTOM-20260925-058] 'drafts' are LOCAL tabs: a new session that does not
  // exist yet. They are client state on purpose — the host knows nothing about
  // them, so 'sessionsChanged' / 'boot' must never clear this list.
  var state = { sessions: [], focusedId: null, focusedAgent: null, drafts: [], focusedDraftId: null };
  // [CUSTOM-20260925-047] Set when a tab was moved to by ARROW KEY, so the next
  // render can put DOM focus back on it (see setFocus).
  var tabFocusExpected = false;

  /**
   * [CUSTOM-20260925-058] Ordered tab models: real sessions first, then drafts.
   *
   * One list so that roving tabindex and the arrow keys work across BOTH kinds —
   * otherwise a focused draft would leave every real tab at 'tabIndex = -1' and
   * Tab could not reach them.
   */
  function tabModels() {
    var out = [];
    var i;
    for (i = 0; i < state.sessions.length; i++) {
      out.push({ kind: 'session', id: state.sessions[i].sessionId, summary: state.sessions[i] });
    }
    for (i = 0; i < state.drafts.length; i++) {
      out.push({ kind: 'draft', id: state.drafts[i].draftId, draft: state.drafts[i] });
    }
    return out;
  }

  function isActiveModel(model) {
    return model.kind === 'session'
      ? model.id === state.focusedId
      : model.id === state.focusedDraftId;
  }

  function activateModel(model) {
    if (model.kind === 'draft') {
      if (NS.draft) { NS.draft.focus(model.id); }
      return;
    }
    if (model.id !== state.focusedId) {
      NS.bridge.post({ type: 'focusSession', sessionId: model.id });
    }
  }

  function closeModel(model) {
    if (model.kind === 'draft') {
      if (NS.draft) { NS.draft.drop(model.id); }
      return;
    }
    NS.bridge.post({ type: 'closeSession', sessionId: model.id });
  }

  function init() {
    tabsEl = NS.dom.qs('tabs');
    agentBar = NS.dom.qs('agentBar');
    agentSelect = NS.dom.qs('agentSelect');
    cwdBtn = NS.dom.qs('cwdBtn');
    usageBar = NS.dom.qs('usageBar');

    NS.dom.qs('newTab').addEventListener('click', function () {
      // [CUSTOM-20260925-058] '+' opens a LOCAL DRAFT instead of creating a
      // session immediately. The directory is chosen on that page, and creating
      // the session there and then would mean "change the directory" has to
      // close and recreate it — and 'session/close' does NOT remove a session
      // from the agent's history, so every change would leave an empty one
      // behind. The session is created on the first send instead.
      if (NS.draft) { NS.draft.start(); }
      // [CUSTOM-20260925-047] New session = the user wants to type. (focus() on
      // a disabled textarea is a harmless no-op.)
      if (NS.composer) { NS.composer.focusInput(); }
    });

    agentSelect.addEventListener('change', function () {
      var agentName = agentSelect.value;
      if (agentName) { NS.bridge.post({ type: 'focusAgent', agentName: agentName }); }
    });

    // [CUSTOM-20260925-047] The tablist keyboard contract: arrows move the
    // selection, Delete closes. Needed because the roving tabindex deliberately
    // leaves only the ACTIVE tab in the tab order.
    // [CUSTOM-20260925-058] …and it spans drafts too, hence 'tabModels()'.
    tabsEl.addEventListener('keydown', function (event) {
      var index = modelIndexOf(event.target);
      if (index < 0) { return; }
      var models = tabModels();
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        if (models.length < 2) { return; }
        var next = (index + (event.key === 'ArrowRight' ? 1 : -1) + models.length) % models.length;
        tabFocusExpected = true;
        activateModel(models[next]);
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        closeModel(models[index]);
      }
    });
  }

  function tabLabel(summary) {
    if (summary.title && summary.title.length > 0) { return summary.title; }
    if (summary.sessionId) { return summary.sessionId.slice(0, 8); }
    return 'session';
  }

  function dotClass(summary) {
    if (summary.loading) { return 'tab-dot loading'; }
    // running wins over unread: a streaming tab is already pulsing, and two signals
    // for one thing is worse than one (see CUSTOM-20260925-063).
    if (summary.running) { return 'tab-dot running'; }
    // [CUSTOM-20260925-063] Output arrived while this tab was in the background.
    if (summary.unread) { return 'tab-dot attention'; }
    return 'tab-dot';
  }

  /**
   * [CUSTOM-20260925-058] The index in the COMBINED tab list that a keydown
   * originated from, or -1. Replaces the session-only lookup: a focused draft
   * would otherwise make every real tab unreachable by arrow key.
   */
  function modelIndexOf(node) {
    while (node && node !== tabsEl) {
      if (node.getAttribute) {
        var id = node.getAttribute('data-session-id') || node.getAttribute('data-draft-id');
        if (id) {
          var models = tabModels();
          for (var i = 0; i < models.length; i++) {
            if (models[i].id === id) { return i; }
          }
          return -1;
        }
      }
      node = node.parentNode;
    }
    return -1;
  }

  function activeTabNode() {
    var nodes = tabsEl.querySelectorAll('.tab.active');
    return nodes.length > 0 ? nodes[0] : null;
  }

  function renderTabs() {
    NS.dom.clear(tabsEl);
    var models = tabModels();
    // Roving tabindex: exactly ONE tab in the tab order across both kinds (the
    // standard tablist pattern, and arrow keys move between them) so Tab does
    // not stop once per session on the way to the composer.
    var activeSeen = false;
    for (var i = 0; i < models.length; i++) { if (isActiveModel(models[i])) { activeSeen = true; break; } }

    for (var j = 0; j < models.length; j++) {
      (function (model, index) {
        var active = isActiveModel(model);
        var isDraft = model.kind === 'draft';
        var label = isDraft ? 'New session' : tabLabel(model.summary);
        // [CUSTOM-20260925-047] A real <button>, not a div with a click handler:
        // the strip was unreachable by keyboard before, and Enter/Space on a
        // button fires 'click' natively (no keydown branch needed).
        var tab = NS.dom.el('button', 'tab' + (isDraft ? ' tab-draft' : '') + (active ? ' active' : ''));
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute(isDraft ? 'data-draft-id' : 'data-session-id', model.id);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active || (!activeSeen && index === 0) ? 0 : -1;
        tab.title = isDraft
          ? (model.draft.cwd || 'Default directory') + '\\n(not created yet)'
          : label + '\\n' + model.id;

        tab.appendChild(NS.dom.el('span', isDraft ? 'tab-dot draft' : dotClass(model.summary)));
        tab.appendChild(NS.dom.el('span', 'tab-label', label));

        var close = NS.dom.el('button', 'tab-close', '\\u00d7');
        close.type = 'button';
        close.title = isDraft ? 'Discard this draft' : 'Close this session';
        close.setAttribute('aria-label', (isDraft ? 'Discard ' : 'Close ') + label);
        close.addEventListener('click', function (event) {
          event.stopPropagation();
          closeModel(model);
        });
        tab.appendChild(close);

        tab.addEventListener('click', function () {
          if (!active) { activateModel(model); }
        });
        tabsEl.appendChild(tab);
      })(models[j], j);
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
      cwdBtn.textContent = '';
      cwdBtn.title = 'Working directory';
      usageBar.hidden = true;
      return;
    }
    cwdBtn.textContent = summary.cwd || '';
    // The session id stays in the tooltip: it is what you paste into a bug report.
    cwdBtn.title = (summary.cwd || '') + '\\n' + summary.sessionId;
  }

  /** [CUSTOM-20260925-058] Header for a draft: it shows the directory it WILL use. */
  function renderDraftHeader(draft) {
    cwdBtn.textContent = draft && draft.cwd ? draft.cwd : 'Default directory';
    cwdBtn.title = 'This session will be created in this directory\\n(not created yet)';
    usageBar.hidden = true;
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
    if (summary) { state.focusedDraftId = null; }
    renderTabs();
    renderHeader(summary);
    restoreFocusIfExpected();
  }

  /**
   * [CUSTOM-20260925-058] Drafts are LOCAL, so the server-driven 'setSessions'
   * must leave them alone — that is the whole reason this is a separate entry
   * point rather than part of 'state.sessions'.
   */
  function setDrafts(drafts, focusedDraftId) {
    state.drafts = drafts || [];
    state.focusedDraftId = focusedDraftId || null;
    renderTabs();
  }

  /** Focus a draft (client-local, no host round-trip). */
  function setDraftFocus(draft) {
    state.focusedId = null;
    state.focusedDraftId = draft ? draft.draftId : null;
    renderTabs();
    renderDraftHeader(draft);
    restoreFocusIfExpected();
  }

  function restoreFocusIfExpected() {
    // [CUSTOM-20260925-047] Arrow navigation changed the selection, but the
    // re-render dropped DOM focus to <body>; put it back on the new active tab
    // so the next arrow key still works. Only done when the move came from the
    // keyboard — a mouse click should not steal focus.
    if (!tabFocusExpected) { return; }
    tabFocusExpected = false;
    var active = activeTabNode();
    if (active) { active.focus(); }
  }

  /** Let boot's draft path reuse the keyboard focus restore. */
  function expectTabFocus() { tabFocusExpected = true; }

  /**
   * [CUSTOM-20260925-058] Focus the first real session, if there is one.
   * Used when the last draft is discarded and something has to take over.
   */
  function focusFirstSession() {
    var models = tabModels();
    for (var i = 0; i < models.length; i++) {
      if (models[i].kind === 'session') {
        NS.bridge.post({ type: 'focusSession', sessionId: models[i].id });
        return true;
      }
    }
    return false;
  }

  NS.tabs = {
    init: init,
    setSessions: setSessions,
    setFocus: setFocus,
    setDrafts: setDrafts,
    setDraftFocus: setDraftFocus,
    expectTabFocus: expectTabFocus,
    focusFirstSession: focusFirstSession,
    renderUsage: renderUsage
  };
})(window.__acpc = window.__acpc || {});
`;
