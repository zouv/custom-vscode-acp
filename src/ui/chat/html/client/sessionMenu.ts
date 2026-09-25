// [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的「连接」与「历史会话」入口：新增客户端模块。
// 两个入口的存在意义相同：**不再依赖侧边栏**。
//   · 连接按钮：面板空着时（没连接 / 没聚焦会话）一键连上，不必先去 Agents 视图；
//   · 历史会话：标题栏的 ↺ 拉出该 agent 的历史会话列表（agent 侧 session/list，或本地缓存），
//     点一条即打开（`session/load` 重放，退化为 resume）。
//
// 列表样式复用会话大纲（021）的 `.outline*` 类：两者都是"标题栏下沿的浮层"，外观应当一致。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260925-032/033
export const sessionMenuClient = `
(function (NS) {
  'use strict';

  // The modern panel is Claude-Code-only by design (panelContract.MODERN_AGENTS),
  // so the empty-state label can name it. If a second modern agent ever lands,
  // this string should come from the host instead.
  var CONNECT_LABEL = 'Connect Claude Code';

  var button = null;
  var drawer = null;
  var headEl = null;
  var listEl = null;
  var connectBtn = null;
  var open = false;
  var pending = false;

  function fmtTime(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function labelOf(item) {
    var title = String(item.title || '').replace(/\\s+/g, ' ').trim();
    if (title) { return title.length > 80 ? title.slice(0, 80) + '\\u2026' : title; }
    return String(item.sessionId || '').slice(0, 8);
  }

  /** Last path segment, for the compact per-row directory hint. */
  function folderName(path) {
    var s = String(path || '').replace(/[\\\\/]+$/, '');
    if (!s) { return ''; }
    var parts = s.split(/[\\\\/]/);
    return parts[parts.length - 1] || s;
  }

  function render() {
    if (!drawer) { return; }
    NS.dom.clear(headEl);
    NS.dom.clear(listEl);
    headEl.appendChild(NS.dom.el('span', 'outline-count', pending ? 'Loading\\u2026' : ''));
    if (pending) { return; }
    // Filled in by setHistory().
  }

  function renderList(message) {
    NS.dom.clear(headEl);
    NS.dom.clear(listEl);
    var items = (message && message.sessions) || [];
    var origin = message && message.source === 'agent' ? 'from the agent' : 'from the local cache';
    headEl.appendChild(NS.dom.el('span', 'outline-count',
      items.length === 0 ? 'No previous sessions' : items.length + (items.length === 1 ? ' session' : ' sessions') + ' \\u00b7 ' + origin));
    if (message && message.error) {
      headEl.appendChild(NS.dom.el('span', 'outline-more', message.error));
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      // [CUSTOM-20260925-047] A real <button> — see outline.ts.
      var row = NS.dom.el('button', 'outline-item');
      row.type = 'button';
      row.setAttribute('data-open-session', item.sessionId);
      row.setAttribute('data-open-agent', (message && message.agentName) || '');
      // [CUSTOM-20260925-057] Carry the session's OWN directory back to the host.
      // The list spans directories (it is the agent's, not this workspace's), and
      // without this the host had nothing to tell the agent but the current
      // workspace — which is the wrong answer for a session from elsewhere.
      if (item.cwd) { row.setAttribute('data-open-cwd', item.cwd); }
      row.appendChild(NS.dom.el('span', 'outline-time', fmtTime(item.updatedAt)));
      row.appendChild(NS.dom.el('span', 'outline-text', labelOf(item)));
      // [CUSTOM-20260925-057/058] Show WHICH directory each session belongs to.
      // This list spans directories (it is the agent's, not this workspace's),
      // and until now the only way to tell was the row tooltip — 245 rows with
      // no visible directory is exactly how you open the wrong one.
      var dirName = folderName(item.cwd);
      if (dirName) { row.appendChild(NS.dom.el('span', 'outline-cwd', dirName)); }
      if (item.cwd) { row.title = item.cwd + '\\n' + item.sessionId; }
      listEl.appendChild(row);
    }
  }

  function show() {
    open = true;
    drawer.hidden = false;
    button.classList.add('on');
    pending = true;
    render();
    NS.bridge.post({ type: 'listHistory' });
  }

  function close() {
    if (!open) { return; }
    open = false;
    pending = false;
    drawer.hidden = true;
    button.classList.remove('on');
  }

  function toggle() { if (open) { close(); } else { show(); } }

  /** Reply to listHistory. Ignored when the drawer was closed meanwhile. */
  function setHistory(message) {
    if (!open) { return; }
    pending = false;
    renderList(message);
  }

  function onClick(event) {
    var row = event.target;
    while (row && row !== drawer) {
      if (row.getAttribute && row.getAttribute('data-open-session')) {
        event.preventDefault();
        NS.bridge.post({
          type: 'openHistorySession',
          agentName: row.getAttribute('data-open-agent'),
          sessionId: row.getAttribute('data-open-session'),
          cwd: row.getAttribute('data-open-cwd') || undefined
        });
        close();
        return;
      }
      row = row.parentNode;
    }
  }

  function init() {
    button = NS.dom.qs('historyBtn');
    drawer = NS.dom.qs('history');
    connectBtn = NS.dom.qs('emptyConnect');
    if (drawer) {
      headEl = drawer.querySelector('.outline-head');
      listEl = drawer.querySelector('.outline-list');
      drawer.addEventListener('click', onClick);
    }
    if (button) {
      // [CUSTOM-20260925-035] Swap the placeholder glyph for the clock icon.
      // The markup ships a text glyph so the button is never empty if scripts
      // fail; here we replace it with the real icon.
      var icon = NS.icons && NS.icons.historyIcon ? NS.icons.historyIcon() : null;
      if (icon) {
        NS.dom.clear(button);
        button.appendChild(icon);
      }
      button.addEventListener('click', function (event) { event.preventDefault(); toggle(); });
    }
    if (connectBtn) {
      connectBtn.textContent = CONNECT_LABEL;
      connectBtn.addEventListener('click', function (event) {
        event.preventDefault();
        // [CUSTOM-20260925-058] Open a DRAFT straight away, then ask the host to
        // make sure the process is up. The draft is what gives "nothing to show"
        // a usable meaning (a page whose directory you can pick and whose first
        // message creates the session) instead of an empty session created
        // eagerly — which, since 'session/close' never removes a session from
        // the agent's history, would pile up a junk entry per click.
        // If the agent already has sessions the host focuses the newest one; the
        // draft stays in the strip and the user can come back to it.
        if (NS.draft) { NS.draft.start(); }
        NS.bridge.post({ type: 'connectAgent' });
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);
    document.addEventListener('click', function (event) {
      if (!open) { return; }
      if (drawer.contains(event.target) || button.contains(event.target)) { return; }
      close();
    });
    close();
  }

  /** Focus changed: the history list belongs to the previous agent. */
  function reset() { close(); }

  NS.sessionMenu = {
    init: init,
    reset: reset,
    setHistory: setHistory
  };
})(window.__acpc = window.__acpc || {});
`;
