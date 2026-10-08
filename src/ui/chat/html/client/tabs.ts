// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 多会话标签行 + agent 选择器 + 会话头（标题 / usage 条）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const tabsClient = `
(function (NS) {
  'use strict';

  var tabsEl = null;
  var stripEl = null;
  var agentBar = null;
  var agentSelect = null;
  var cwdBtn = null;

  // [CUSTOM-20260925-058] 'drafts' are LOCAL tabs: a new session that does not
  // exist yet. They are client state on purpose — the host knows nothing about
  // them, so 'sessionsChanged' / 'boot' must never clear this list.
  var state = { sessions: [], focusedId: null, focusedAgent: null, drafts: [], focusedDraftId: null };
  // [CUSTOM-20261007-198] 手工 tab 顺序（会话 id 数组）：宿主 globalState 里那份的本地副本
  // （uiPrefs 消息带回，见 applyPrefs）。**不在表里的会话按原顺序排在其后** —— 新会话永远
  // 不会因为"你没拖过它"而消失或跑到最前。
  var tabOrder = [];
  // 拖动中的会话 id 与落点（'before' | 'after'，相对 dropId）。
  var dragId = null;
  var dropId = null;
  var dropAt = null;
  // [CUSTOM-20261008-199] 宿主解析出的默认目录（随 boot 到达）。**没有聚焦会话**时地址栏
  // 显示它 —— 连接适配器（npx 下载）那几十秒里面板正是"已连接、还没有会话"，那时整格空着
  // 会看着像坏了（090 当初把这一格隐藏，代价就是这个）。它同时是草稿页地址栏的兜底文案。
  var defaultCwd = '';
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
    // [CUSTOM-20261007-198] 会话按**手工顺序**排（tabOrder 里没有的按原顺序接在后面）；
    // 草稿永远在最后 —— 它们是本地页，还没有 id 可排。
    var sessions = state.sessions;
    if (tabOrder.length > 0) {
      var rank = {};
      for (i = 0; i < tabOrder.length; i++) { rank[tabOrder[i]] = i; }
      var known = [], unknown = [];
      for (i = 0; i < sessions.length; i++) {
        if (rank[sessions[i].sessionId] === undefined) { unknown.push(sessions[i]); }
        else { known.push(sessions[i]); }
      }
      known.sort(function (a, b) { return rank[a.sessionId] - rank[b.sessionId]; });
      sessions = known.concat(unknown);
    }
    for (i = 0; i < sessions.length; i++) {
      out.push({ kind: 'session', id: sessions[i].sessionId, summary: sessions[i] });
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
    // [CUSTOM-20261008-201] 整条标签栏（含最后一个 tab 右边的空白）才是落点容器，见 installDrag。
    stripEl = NS.dom.qs('tabStrip');
    agentBar = NS.dom.qs('agentBar');
    agentSelect = NS.dom.qs('agentSelect');
    cwdBtn = NS.dom.qs('cwdBtn');

    NS.dom.qs('newTab').addEventListener('click', function () {
      // [CUSTOM-20260925-058] '+' opens a LOCAL DRAFT instead of creating a
      // session immediately. The directory is chosen on that page, and creating
      // the session there and then would mean "change the directory" has to
      // close and recreate it — and 'session/close' does NOT remove a session
      // from the agent's history, so every change would leave an empty one
      // behind. The session is created on the first send instead.
      //
      // [CUSTOM-20260930-123] …but only once the agent is up. Opening a draft while
      // offline produced a page whose composer was still disabled (nothing can be sent
      // without a process), which reads as "I clicked + and cannot type". So an offline
      // '+' connects first and leaves its intent behind: boot opens the draft when the
      // connection lands. Already connected = unchanged, immediate draft.
      if (NS.stateCard && !NS.stateCard.isConnected()) {
        NS.stateCard.beginConnect(true);
        return;
      }
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

    // [CUSTOM-20261008-201] 拖拽排序的落点监听挂在**条带**上，不挂在每个 tab 上（见 installDrag）。
    installDrag();
  }

  function tabLabel(summary) {
    if (summary.title && summary.title.length > 0) { return summary.title; }
    if (summary.sessionId) { return summary.sessionId.slice(0, 8); }
    return 'session';
  }

  function dotClass(summary) {
    // [CUSTOM-20260930-130] 两个**互相独立**的信号，按分工使用（用户指定）：
    //   · 圆点的**颜色**说"这个会话处在什么状态"；
    //   · 圆点外的**圈**说"它正在做事"。
    // 它们必须独立：一个卡在权限提示上的轮次两件事同时为真（在跑 + 在等人），
    // 而早先把 running 映射成"颜色 + 整体脉动"时，两件事被挤进了同一个信号里。
    var cls = 'tab-dot';
    // 优先级：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > 平常。
    // 「等人回答」排最前是因为只有它**没有任何东西会自己往前走**。
    if (summary.waiting) { cls += ' waiting'; }
    else if (summary.running) { cls += ' running'; }
    else if (summary.loading) { cls += ' loading'; }
    else if (summary.unread) { cls += ' attention'; }
    // 外圈：轮次在跑，或正在 replay 载入——都算"这个会话正在做事"。
    if (summary.running || summary.loading) { cls += ' busy'; }
    return cls;
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

  // [CUSTOM-20261007-198] 手工排序：按住左键把一个 tab 拖到目标位置上。
  //
  // 用原生 HTML5 拖拽（不需要自定义"长按"计时器），并在落点那一侧画一条 2px 指示线
  // （styles.ts 的 .drop-before / .drop-after）。顺序落盘走宿主的 setUiPref
  // （globalState，与大纲偏好同一条记录）⇒ 两个面看到同一条顺序。
  //
  // [CUSTOM-20261008-201] 落点从"命中了哪个 tab 元素"改成**指针在条带上的横坐标**。
  // 198 把 dragover/drop 挂在每个 .tab 自己身上，而 '.tabs' 是 'flex: 0 0 auto'：
  // 最后一个 tab 右边的空白属于 .tab-strip、tab 之间还有 2px 的缝，指针一旦落在这些地方
  // 就**没有 drop 目标**（松手即复位），而指示线又没有 dragleave 清除 —— 现场就是
  // "线还在、松手却没插进去"。现在条带里的任何位置都是落点。
  function sessionTabNodes() {
    var nodes = stripEl ? stripEl.querySelectorAll('.tab') : [];
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      // 草稿 tab 没有 data-session-id。草稿永远排在所有会话**之后**，所以指针落在它上面
      // （或它右边的空白）就等于"插到最后一条会话之后" —— 正是用户拖到末尾时会做的事。
      var id = nodes[i].getAttribute ? nodes[i].getAttribute('data-session-id') : null;
      if (id) { out.push({ node: nodes[i], id: id }); }
    }
    return out;
  }

  /** 指针的横坐标；拿不到（合成的/老事件）返回 null —— 没有坐标就别猜落点。 */
  function pointerX(event) {
    var x = event && event.clientX;
    return (typeof x === 'number' && isFinite(x)) ? x : null;
  }

  /** 横坐标对应的插入位（0..n，n = 插到最后）与此刻屏幕上的会话 id 顺序。 */
  function boundaryFor(x) {
    var tabs = sessionTabNodes();
    var ids = [];
    var index = 0;
    for (var i = 0; i < tabs.length; i++) {
      ids.push(tabs[i].id);
      var rect = tabs[i].node.getBoundingClientRect ? tabs[i].node.getBoundingClientRect() : null;
      var mid = (rect && typeof rect.left === 'number' && typeof rect.width === 'number')
        ? rect.left + rect.width / 2
        : null;
      // 量不出中点时按"已经过了它"算，落点只会往右偏、不会是随机的。
      if (mid === null || x > mid) { index += 1; }
    }
    return { index: index, ids: ids };
  }

  /** 落点指示线：第 index 个 tab 的左侧；index === n 时画在最后一个的右侧。 */
  function markBoundary(index) {
    var tabs = sessionTabNodes();
    if (tabs.length === 0) { return; }
    var side = index >= tabs.length ? 'after' : 'before';
    var id = tabs[Math.min(index, tabs.length - 1)].id;
    if (dropId === id && dropAt === side) { return; }
    dropId = id;
    dropAt = side;
    for (var i = 0; i < tabs.length; i++) {
      var cls = String(tabs[i].node.className || '').replace(/ drop-(before|after)/g, '');
      if (tabs[i].id === id) { cls += ' drop-' + side; }
      tabs[i].node.className = cls;
    }
  }

  /** 只清指示线（指针离开条带用）；拖动本身还在 —— 松手前回来仍然能落。 */
  function clearIndicator() {
    dropId = null;
    dropAt = null;
    var tabs = sessionTabNodes();
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].node.className = String(tabs[i].node.className || '').replace(/ drop-(before|after)/g, '');
    }
  }

  function endDrag() {
    dragId = null;
    dropId = null;
    dropAt = null;
    var tabs = sessionTabNodes();
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].node.className = String(tabs[i].node.className || '').replace(/ (dragging|drop-before|drop-after)/g, '');
    }
  }

  /**
   * 把 'fromId' 搬到 'ids' 里的第 'index' 位，即"插在当前位置为 index 的那条之前"
   * （index === ids.length 表示插到最后）。搬完原地不动时返回 false —— 判据是**搬动前后
   * 的数组内容**，所以"插到自己原来的位置"不会白白重渲染一次、也不会白写一次 globalState。
   */
  function moveTo(fromId, index, ids) {
    var from = ids.indexOf(fromId);
    if (from < 0) { return false; }
    var before = ids.slice();
    ids.splice(from, 1);
    // 摘掉自己之后，原来在它右边的那些都左移了一位 —— 目标下标要跟着挪。
    var to = from < index ? index - 1 : index;
    if (to < 0) { to = 0; }
    if (to > ids.length) { to = ids.length; }
    ids.splice(to, 0, fromId);
    for (var i = 0; i < ids.length; i++) { if (ids[i] !== before[i]) { return true; } }
    return false;
  }

  function dropOn(x) {
    var fromId = dragId;
    var boundary = boundaryFor(x);
    var index = boundary.index;
    var ids = boundary.ids;
    endDrag();
    // 诊断常驻（本仓库的既有风格，见 scroll# / markdownRendered）：真机若仍"松手复位"，
    // 这一行与 dragStart 那一行合起来就能区分三种断法 —— dragstart 没跑 / drop 没到 /
    // 落了但顺序被别的东西覆盖（那就看日志里这条之后的 uiPrefs 回话）。
    console.warn('[acpc] tabdrag drop from=' + String(fromId) + ' to=' + index + ' order=' + ids.join(','));
    if (!fromId) { return; }
    if (!moveTo(fromId, index, ids)) { return; }
    tabOrder = ids;
    // 先落盘再重渲染：渲染若抛错，顺序也已经交上去了（两件事没有共享的失败点）。
    NS.bridge.post({ type: 'setUiPref', tabOrder: ids });
    renderTabs();
  }

  /** 宿主 globalState 里那份顺序（随 boot 的 uiPrefs 到达；空表 = 保持原顺序）。 */
  function applyPrefs(prefs) {
    var order = prefs && prefs.tabOrder;
    if (!order || !order.length) { return; }
    tabOrder = order.slice();
    renderTabs();
  }

  /**
   * [CUSTOM-20261008-201] 落点容器是整条标签栏：dragover / drop / dragleave 都挂在它身上。
   * 每个 tab 自己只留 dragstart（谁被拖）与 dragend（拖动结束归位清理）。
   */
  function installDrag() {
    if (!stripEl) { return; }
    stripEl.addEventListener('dragover', function (event) {
      if (!dragId) { return; }
      var x = pointerX(event);
      if (x === null) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
      markBoundary(boundaryFor(x).index);
    });
    stripEl.addEventListener('drop', function (event) {
      if (!dragId) { return; }
      var x = pointerX(event);
      if (x === null) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      dropOn(x);
    });
    stripEl.addEventListener('dragleave', function (event) {
      // 子节点之间移动也会冒上来（relatedTarget 仍在条带内）—— 只有真离开条带才清指示线。
      if (!dragId) { return; }
      var to = event.relatedTarget;
      if (to && stripEl.contains && stripEl.contains(to)) { return; }
      clearIndicator();
    });
  }

  function dragStart(tab, model, event) {
    // 从关闭按钮起拖不该搬走整个 tab（用户点的是 ×）。
    if (event.target && event.target.closest && event.target.closest('.tab-close')) {
      if (event.preventDefault) { event.preventDefault(); }
      return;
    }
    dragId = model.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不给 dataTransfer 挂数据就取消整次拖拽 —— 写个占位值最稳。
      try { event.dataTransfer.setData('text/plain', model.id); } catch (e) { /* 桩 DOM 没有它 */ }
    }
    tab.className = String(tab.className || '') + ' dragging';
    console.warn('[acpc] tabdrag start=' + model.id);
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
        // [CUSTOM-20260927-089] OUT of the tab order. The × lives inside the tab button,
        // so with the default tabindex every session's close button was its own tab stop
        // — ten sessions meant ten extra stops on the way to the composer, defeating the
        // roving tabindex the strip is built around (and a stray Enter on the way closed
        // a session). Delete/Backspace already closes the focused tab.
        close.tabIndex = -1;
        close.addEventListener('click', function (event) {
          event.stopPropagation();
          closeModel(model);
        });
        tab.appendChild(close);

        tab.addEventListener('click', function () {
          if (!active) { activateModel(model); }
        });
        // [CUSTOM-20261007-198] 手工排序。只有会话 tab 能排：草稿的 id 是本地的临时号，
        // 排它没有意义（它连会话都不是）。
        // [CUSTOM-20261008-201] 这里只留"谁被拖"与"拖完清理"；落点（dragover/drop/dragleave）
        // 在条带上，见 installDrag。
        if (!isDraft) {
          tab.setAttribute('draggable', 'true');
          tab.addEventListener('dragstart', function (event) { dragStart(tab, model, event); });
          tab.addEventListener('dragend', function () { endDrag(); });
        }
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

  /**
   * [CUSTOM-20261008-199] 没有聚焦会话/草稿时地址栏显示的那一份内容：宿主解析出的默认目录，
   * 宿主值到达前先给一句文案（与 058 草稿页原本的兜底同一句）。单点函数是为了让
   * 'renderHeader(null)' / 'renderDraftHeader' / 'currentCwd' 三处**同源**（pitfalls #19）。
   */
  function defaultCwdLabel() {
    return defaultCwd || 'Default directory';
  }

  function renderHeader(summary) {
    if (!summary) {
      // [CUSTOM-20261008-199] 这一格**不再隐藏**（090 的相反决定）。那时面板是"已连接、
      // 还没有会话"—— 连接适配器（npx 下载）那几十秒正是这个状态：整格空着像坏了，而且
      // 这一行唯一的弹性项就是它（.session-title 是 flex: 1），隐藏它会把 Times 那一组
      // 右侧控件整组拽到左边。090 的顾虑是"能点开目录抽屉、抽屉却在讲一个没有会话的面板"
      // —— 改用 disabled 解决：按钮在事件层面点不动，抽屉根本打不开。
      cwdBtn.hidden = false;
      cwdBtn.disabled = true;
      cwdBtn.textContent = defaultCwdLabel();
      cwdBtn.title = defaultCwd
        ? defaultCwd + '\\nThe next session will be created here'
        : 'Working directory';
      return;
    }
    cwdBtn.hidden = false;
    cwdBtn.disabled = false;
    cwdBtn.textContent = summary.cwd || '';
    // The session id stays in the tooltip: it is what you paste into a bug report.
    cwdBtn.title = (summary.cwd || '') + '\\n' + summary.sessionId;
  }

  /**
   * [CUSTOM-20261001-155] The directory the header (the "address bar") is showing
   * right now, or null when it shows none.
   *
   * Read off the same state renderHeader/renderDraftHeader render from, so "what
   * the history filter defaults to" cannot drift away from "what the user sees up
   * there" (pitfalls #19). A DRAFT's directory is client-local (058), so this is
   * also the only side that can answer for a draft page at all.
   */
  function currentCwd() {
    var i;
    for (i = 0; i < state.drafts.length; i++) {
      if (state.drafts[i].draftId === state.focusedDraftId) { return state.drafts[i].cwd || null; }
    }
    for (i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].sessionId === state.focusedId) { return state.sessions[i].cwd || null; }
    }
    // [CUSTOM-20261008-199] 空态现在**也显示**一个目录（默认目录），所以这里跟着答它 ——
    // 否则"用户看到的"与"历史默认筛的"就分家了，而 155 整条规则建立在这两者同源上。
    return defaultCwd || null;
  }

  /** [CUSTOM-20260925-058] Header for a draft: it shows the directory it WILL use. */
  function renderDraftHeader(draft) {
    // [CUSTOM-20260927-090] A draft HAS a directory to show (and to pick), so the button
    // comes back even though there is no session yet.
    cwdBtn.hidden = false;
    cwdBtn.disabled = false;
    // [CUSTOM-20261008-199] 还没选过目录时显示**真正的默认目录**（宿主值），与空态那一格
    // 同一份文案 —— 草稿的抽屉收到 choices 后也会把 defaultCwd 采用成自己的 cwd（058）。
    cwdBtn.textContent = draft && draft.cwd ? draft.cwd : defaultCwdLabel();
    cwdBtn.title = 'This session will be created in this directory\\n(not created yet)';
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

  /**
   * [CUSTOM-20261008-199] The host's resolved default directory (rides on 'boot').
   * Only the state that actually shows it needs a repaint: with a session or a draft
   * focused the address bar is showing something else, and the next render will pick
   * the new value up anyway (it is read, never copied).
   */
  function setDefaultCwd(value) {
    var next = typeof value === 'string' ? value : '';
    if (next === defaultCwd) { return; }
    defaultCwd = next;
    if (!state.focusedId && !state.focusedDraftId) { renderHeader(null); }
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
    // [CUSTOM-20261001-155] The history picker's filter default comes from here.
    currentCwd: currentCwd,
    // [CUSTOM-20261007-198] 手工 tab 顺序：宿主 globalState 那份，随 uiPrefs 消息到达。
    applyPrefs: applyPrefs,
    // [CUSTOM-20261008-199] 空态地址栏显示的那份默认目录（随 boot 消息到达）。
    setDefaultCwd: setDefaultCwd
  };
})(window.__acpc = window.__acpc || {});
`;
