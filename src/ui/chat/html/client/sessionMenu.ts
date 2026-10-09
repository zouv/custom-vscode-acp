// [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的「连接」与「历史会话」入口：新增客户端模块。
// [CUSTOM-20260930-123] 本文件现在只剩「历史会话」那一半：连接按钮（含它的标签、相位与
// 自动连接开关）已整体移交 client/stateCard.ts。原先"标签归 boot、动作归这里、相位归第三个
// 地方"是同一份知识的三份拷贝，正是 pitfall #19 描述的那种迟早只改一边的结构。
//
// 历史会话：标题栏的 ↺ 拉出该 agent 的历史会话列表（agent 侧 session/list，或本地缓存），
// 点一条即打开（`session/load` 重放，退化为 resume）。
//
// 列表样式复用会话大纲（021）的 `.outline*` 类：两者都是"标题栏下沿的浮层"，外观应当一致。
//
// [CUSTOM-20260926-079] 列表可能横跨几十个仓库（实测 232 条），所以 header 上多了一个
// **按工作目录过滤**的 chip（`All folders` / `<目录名>`）。两点设计约束写在这里：
//   · 过滤是**纯客户端的 key 比较**——列表本来就在客户端，换目录不该再问一次 agent；
//   · key 由宿主算好（目录同一性依赖平台：win32/darwin 折叠大小写，linux 不折叠）。
//
// [CUSTOM-20261001-155] 过滤的**默认目录改为来自地址栏**（用户要求：地址栏已经选好地址时，
// 打开历史就默认筛到那个目录）。宿主原先自己猜（聚焦会话属于该 agent 就用它的 cwd，否则用
// 第一个工作区文件夹）——草稿页猜不到（草稿在客户端，058），所以改由客户端把地址栏**当前
// 显示的那个目录**随请求送上去。**开关的默认值同时翻转为开**（`historyFolderFilter !== false`）：
// 打开历史看到的是当前目录的会话，而不是全部；用户手动选过一次 `All folders` 就记住
// （用户选定），此后打开不再自动筛。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260925-032/033
export const sessionMenuClient = `
(function (NS) {
  'use strict';

  var button = null;
  var drawer = null;
  var headEl = null;
  var listEl = null;
  var open = false;
  var pending = false;

  // [CUSTOM-20260926-079] Working-directory filter.
  var filterChip = null;
  var filterMenu = null;
  var menuOpen = false;
  // The last reply, so switching the filter re-renders without asking the agent again.
  var lastMessage = null;
  var dirOptions = [];
  // null = every folder. Reset on every open (the default comes from the reply).
  var filterKey = null;
  // The on/off PREFERENCE, persisted (vscode.setState, same as Times/Sub-agents).
  // Only the toggle survives; the directory is re-derived on each open — a remembered
  // directory would filter by a folder that has nothing to do with where the user is.
  // [CUSTOM-20261001-155] Defaults to ON: unless the user explicitly chose 'All folders',
  // opening the list means "the sessions here" (see setHistory).
  var filterOn = true;
  // [CUSTOM-20261001-155] The directory the ADDRESS BAR showed when this open asked for
  // the list (null = it showed none). It is what gates the default filter: the match
  // itself is still the host's 'current' mark, never a client-side path comparison.
  var askedCwd = null;
  // [CUSTOM-20260928-095] Directories whose disk supplement has already been requested
  // (keyed by dirKey), so filtering back and forth does not re-scan the same folder.
  var supplementedDirs = {};

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

  // --- Directory filter (CUSTOM-20260926-079) ------------------------------

  /**
   * [CUSTOM-20260927-093] The bucket for rows whose directory the agent never reported.
   *
   * They are not "some other folder" — nothing is known about them — so hiding them
   * silently under a folder filter is a guess dressed up as a rule. They get their own
   * candidate instead, and the count line says how many are hidden when a real folder is
   * selected. The sentinel cannot collide with a real key: those always contain a
   * separator.
   */
  var UNKNOWN_KEY = '~unknown';

  function unknownRows(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (!items[i].dirKey) { out.push(items[i]); }
    }
    return out;
  }

  /** Candidates shown in the menu: the host's folders, plus the unknown bucket. */
  function menuOptions() {
    var out = [];
    for (var i = 0; i < dirOptions.length; i++) { out.push(dirOptions[i]); }
    var all = (lastMessage && lastMessage.sessions) || [];
    var n = unknownRows(all).length;
    if (n > 0) {
      out.push({ key: UNKNOWN_KEY, cwd: '', name: 'Unknown folder', label: 'Unknown folder', count: n, current: false });
    }
    return out;
  }

  /** The option the filter is currently on, or null for "all folders". */
  function activeOption() {
    var options = menuOptions();
    for (var i = 0; i < options.length; i++) {
      if (options[i].key === filterKey) { return options[i]; }
    }
    return null;
  }

  /**
   * [CUSTOM-20260926-079] What to show for a directory: the host grows the label
   * leftwards when two folders share a basename ('git/UniverseEditor' vs
   * 'zdev/UniverseEditor'), and the fallback keeps an older host working.
   */
  function optionLabel(option) { return option.label || option.name; }

  /** Rows that pass the filter ('all folders' / a folder / the unknown bucket). */
  function visibleRows(items) {
    if (!filterKey) { return items; }
    if (filterKey === UNKNOWN_KEY) { return unknownRows(items); }
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].dirKey === filterKey) { out.push(items[i]); }
    }
    return out;
  }

  function plural(n) { return n + (n === 1 ? ' session' : ' sessions'); }

  /**
   * The chip: shows the active directory AND opens the picker — "turn it on" and
   * "choose a folder" are the same act, so one control does both and "All folders"
   * is the off switch.
   */
  function renderChip() {
    if (!filterChip) { return; }
    var option = activeOption();
    // A single directory means filtering has nothing to do — but an ACTIVE filter
    // must always be reachable, or the user could never turn it off.
    filterChip.hidden = !option && menuOptions().length < 2;
    NS.dom.clear(filterChip);
    var icon = NS.icons && NS.icons.icon ? NS.icons.icon('folder', 'filter-icon') : null;
    if (icon) { filterChip.appendChild(icon); }
    filterChip.appendChild(NS.dom.el('span', 'picker-label', option ? optionLabel(option) : 'All folders'));
    filterChip.appendChild(NS.dom.el('span', 'filter-caret', '\\u25be'));
    filterChip.className = option ? 'picker-btn filter-chip on' : 'picker-btn filter-chip';
    // The unknown bucket has no path to show, so its tooltip is just the count.
    filterChip.title = option
      ? (option.cwd ? option.cwd + '\\n' : '') + plural(option.count) + ' here'
      : 'Filter the list by working directory';
    filterChip.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
  }

  function makeFilterRow(option, label, countText) {
    var active = option ? option.key === filterKey : filterKey === null;
    var row = NS.dom.el('button', 'picker-item filter-item' + (active ? ' active' : ''));
    row.type = 'button';
    // The empty string is the "all folders" key: getAttribute returns '' (present but
    // falsy) while a missing attribute returns null, and the delegated click handler
    // relies on that difference.
    row.setAttribute('data-filter-key', option ? option.key : '');
    row.setAttribute('aria-pressed', active ? 'true' : 'false');
    row.appendChild(NS.dom.el('span', 'filter-item-label', label));
    if (countText) { row.appendChild(NS.dom.el('span', 'picker-count', countText)); }
    row.title = option
      ? (option.cwd || 'Sessions whose directory the agent did not report')
      : 'Show sessions from every directory';
    return row;
  }

  function renderMenu() {
    if (!filterMenu) { return; }
    NS.dom.clear(filterMenu);
    var total = (lastMessage && lastMessage.sessions ? lastMessage.sessions.length : 0);
    filterMenu.appendChild(makeFilterRow(null, 'All folders', total ? plural(total) : ''));
    var options = menuOptions();
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      filterMenu.appendChild(makeFilterRow(option, optionLabel(option), plural(option.count)));
    }
    // NOTE: a class, not the 'hidden' attribute — '.picker-menu' carries an author
    // 'display: none', and '[hidden]' is not the mechanism this component uses.
    filterMenu.className = menuOpen ? 'picker-menu down open' : 'picker-menu down';
  }

  function toggleFilterMenu() {
    menuOpen = !menuOpen;
    renderMenu();
    renderChip();
  }

  function inMenu(node) { return !!(filterMenu && filterMenu.contains && filterMenu.contains(node)); }

  /** Switch the filter (null = all folders), remember the toggle, re-render locally. */
  function applyFilter(key) {
    filterKey = key || null;
    filterOn = filterKey !== null;
    if (NS.boot && NS.boot.persistUi) { NS.boot.persistUi({ historyFolderFilter: filterOn }); }
    // [CUSTOM-20260926-079] The menu STAYS OPEN. Picking a folder is usually the first
    // of several (compare two folders, or try the next one), and closing on every pick
    // turned that into "re-open, pick, re-open, pick". Everything else still refreshes
    // underneath it: the count line, the rows, and the active mark in this menu.
    renderMenu();
    renderChip();
    renderList(lastMessage);
    focusActiveRow();
    // [CUSTOM-20260928-095] A concrete folder is now showing: make sure its disk-only
    // sessions are present too (the initial list only scanned the first workspace folder).
    if (filterKey && filterKey !== UNKNOWN_KEY) { requestSupplement(filterKey); }
  }

  /**
   * Keep the keyboard where it was. Rebuilding the rows destroys the button that was
   * just clicked, so focus would fall back to the document and the next Tab would
   * start over from the top of the panel.
   */
  function focusActiveRow() {
    if (!menuOpen || !filterMenu || !filterMenu.querySelector) { return; }
    var active = filterMenu.querySelector('.picker-item.active');
    if (active && active.focus) { active.focus(); }
  }

  // [CUSTOM-20260928-095] Per-directory disk supplement. The host scans the transcript
  // directory of the folder the picker filter selected and returns the disk-only rows;
  // the client MERGES them in (a full history reply would reset the filter).

  /** Original path of the option whose normalized key matches, or null. */
  function cwdForKey(key) {
    for (var i = 0; i < dirOptions.length; i++) {
      if (dirOptions[i].key === key) { return dirOptions[i].cwd; }
    }
    return null;
  }

  /** Ask the host to scan one directory's transcript folder (once per open). */
  function requestSupplement(key) {
    if (supplementedDirs[key]) { return; }
    supplementedDirs[key] = true;
    var cwd = cwdForKey(key);
    if (!cwd) { return; }
    NS.bridge.post({ type: 'supplementHistory', cwd: cwd });
  }

  /** Merge a supplement into the list already shown (does not reset the filter). */
  function applySupplement(message) {
    if (!open || !lastMessage || !message) { return; }
    var existing = lastMessage.sessions || [];
    var byId = {};
    for (var i = 0; i < existing.length; i++) { byId[existing[i].sessionId] = existing[i]; }
    var add = message.sessions || [];
    for (var j = 0; j < add.length; j++) {
      if (!byId[add[j].sessionId]) { byId[add[j].sessionId] = add[j]; }
    }
    lastMessage.sessions = Object.keys(byId).map(function (id) { return byId[id]; });
    // [CUSTOM-20260928-095] The supplement arrives unordered; re-sort so the appended
    // rows land in their time slot instead of piling up at the bottom.
    lastMessage.sessions.sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    renderList(lastMessage);
  }

  function render() {
    // The head/list lookups are the markup's contract: '.outline-head-info' is where
    // the count goes (the filter chip is its sibling, so it survives a re-render).
    if (!drawer || !headEl || !listEl) { return; }
    NS.dom.clear(headEl);
    NS.dom.clear(listEl);
    headEl.appendChild(NS.dom.el('span', 'outline-count', pending ? 'Loading\\u2026' : ''));
    renderChip();
    renderMenu();
    if (pending) { return; }
    // Filled in by setHistory().
  }

  function renderList(message) {
    lastMessage = message;
    if (!headEl || !listEl) { return; }
    NS.dom.clear(headEl);
    NS.dom.clear(listEl);
    var all = (message && message.sessions) || [];
    var items = visibleRows(all);
    // [CUSTOM-20260927-092] Three sources now: the agent's list, the local cache, or the
    // union of both (the default once connected). The label has to say which, because
    // "the agent did not list this session" is exactly the difference a reader cares about.
    var origin = message && message.source === 'agent' ? 'from the agent'
      : message && message.source === 'merged' ? 'from the agent + local sources'
      : 'from the local cache';
    // [CUSTOM-20260927-093] Filtered by a real folder: rows with no directory are hidden,
    // so say how many instead of letting them vanish (they are not "elsewhere" — they are
    // simply unplaced). They stay reachable through the Unknown folder candidate.
    var hidden = filterKey && filterKey !== UNKNOWN_KEY ? unknownRows(all).length : 0;
    // Filtered: "12 of 232 sessions" — the total is what makes the filter legible
    // (a bare "12 sessions" would read like the agent lost the rest).
    var count = filterKey ? items.length + ' of ' + all.length : String(all.length);
    headEl.appendChild(NS.dom.el('span', 'outline-count',
      all.length === 0 ? 'No previous sessions'
        : count + (all.length === 1 ? ' session' : ' sessions') + ' \\u00b7 ' + origin
          + (hidden > 0 ? ' \\u00b7 ' + hidden + ' without a folder' : '')));
    if (message && message.error) {
      headEl.appendChild(NS.dom.el('span', 'outline-more', message.error));
    }
    // Nothing in this folder: say so, and leave a way back (the chip is easy to miss).
    if (items.length === 0 && filterKey) {
      listEl.appendChild(NS.dom.el('div', 'outline-group', 'No sessions in this folder'));
      var showAll = NS.dom.el('button', 'outline-item', 'Show all folders');
      showAll.type = 'button';
      showAll.setAttribute('data-filter-key', '');
      listEl.appendChild(showAll);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      // [CUSTOM-20261009-212] 行外面套一层 .session-row：悬停时的 Archive / Rename 图标
      // **不能放进行按钮里**（button 嵌套 button 是无效 HTML，浏览器解析时会把里层弹出去；
      // 而且行的点击语义会被搅乱）。图标层是行的**兄弟**，绝对定位浮在行的右端，
      // 默认透明且不接事件（CSS 见 styles.ts 的 .row-actions）。
      var wrap = NS.dom.el('div', 'session-row');
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
      // [CUSTOM-20260928-098] The title travels with the row so the tab can show it.
      if (item.title) { row.setAttribute('data-open-title', item.title); }
      row.appendChild(NS.dom.el('span', 'outline-time', fmtTime(item.updatedAt)));
      row.appendChild(NS.dom.el('span', 'outline-text', labelOf(item)));
      // [CUSTOM-20260925-057/058] Show WHICH directory each session belongs to.
      // This list spans directories (it is the agent's, not this workspace's),
      // and until now the only way to tell was the row tooltip — 245 rows with
      // no visible directory is exactly how you open the wrong one.
      // [CUSTOM-20261009-212 修] 2026-10-09 用户报：它原来落在行的最右端，被悬停的
      // Archive/Rename 图标盖住（图里就是"图标压在 aki_work 上"）。改成**会话名后面的括号
      // 后缀**（"(aki_work)"，跟着标题靠左）——右端从此留给悬停动作；配合 styles.ts 里
      // .session-row .outline-text 的 flex 调整（标题不再吃满整行）。
      var dirName = folderName(item.cwd);
      if (dirName) { row.appendChild(NS.dom.el('span', 'outline-cwd', '(' + dirName + ')')); }
      var tooltip = (item.cwd ? item.cwd + '\\n' : '') + item.sessionId;
      // [CUSTOM-20260927-092] A row only the local cache knows about may no longer exist
      // agent-side. Saying so in the tooltip keeps the picker honest without adding noise
      // to the row itself.
      if (item.fromCache) { tooltip += '\\n(not listed by the agent — from the local cache)'; }
      // [CUSTOM-20260927-094] Recovered from the transcript folder: the agent did not
      // report it (it may still be open in another window), so say that too.
      // No apostrophes in this string on purpose: in the RAW template text an escaped
      // quote reads as "escaped backslash + string end" to check-webview-client.mjs
      // (same class of trap as the regex rule in chat-panel.md 5.2).
      if (item.fromDisk) { tooltip += '\\n(read from the transcript folder — the agent did not list it)'; }
      row.title = tooltip;
      wrap.appendChild(row);
      wrap.appendChild(buildRowActions(item));
      listEl.appendChild(wrap);
    }
  }

  // [CUSTOM-BEGIN] CUSTOM-20261009-212 - 行右端的悬停动作（Archive / Rename）。
  // 两个都是真 <button>（047 的规矩），但**不进 tab 序**（tabIndex -1）：这一格是悬停才现的
  // 冗余入口，键盘用户走右键菜单（contextMenu.itemsFor 的同名两项，Shift+F10 可达），
  // 与 tab 上 × 出 tab 序是同一条先例（089）。
  // 动作本身只发消息，等宿主做完再回 sessionAction 来找齐（见 applyAction）—— 不做乐观更新，
  // 免得"宿主没做成、界面却变了"（pitfall #29 的那类不一致）。
  function buildRowActions(item) {
    var actions = NS.dom.el('span', 'row-actions');
    var specs = [
      { action: 'archive', icon: 'archive', label: 'Archive' },
      { action: 'rename', icon: 'rename', label: 'Rename' }
    ];
    for (var i = 0; i < specs.length; i++) {
      (function (spec) {
        var btn = NS.dom.el('button', 'row-action');
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.setAttribute('data-session-action', spec.action);
        btn.setAttribute('data-action-id', item.sessionId);
        btn.title = spec.label;
        btn.setAttribute('aria-label', spec.label);
        var icon = NS.icons && NS.icons.icon ? NS.icons.icon(spec.icon, 'row-action-icon') : null;
        if (icon) { btn.appendChild(icon); } else { btn.textContent = spec.label; }
        actions.appendChild(btn);
      })(specs[i]);
    }
    return actions;
  }

  /**
   * [CUSTOM-20261009-212] 宿主做完归档/改名后的对账（boot 转发的 sessionAction 消息）。
   * 就地改 lastMessage.sessions 再走一遍 renderList —— 计数行/过滤都跟着重算，而且
   * **不重置用户手动选的目录过滤**（重发一次 listHistory 会重置它：setHistory 用 askedCwd
   * 重派生 filterKey）。
   */
  function applyAction(message) {
    if (!message || !lastMessage || !lastMessage.sessions) { return; }
    var id = message.sessionId;
    var sessions = lastMessage.sessions;
    if (message.action === 'archive') {
      var kept = [];
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i].sessionId !== id) { kept.push(sessions[i]); }
      }
      lastMessage.sessions = kept;
      renderList(lastMessage);
      return;
    }
    if (message.action === 'rename' && typeof message.title === 'string') {
      for (var j = 0; j < sessions.length; j++) {
        if (sessions[j].sessionId === id) { sessions[j].title = message.title; }
      }
      renderList(lastMessage);
    }
  }
  // [CUSTOM-END] CUSTOM-20261009-212

  function show() {
    open = true;
    drawer.hidden = false;
    button.classList.add('on');
    pending = true;
    // A fresh list: drop the previous run's rows, candidates AND the directory choice
    // (the default is re-derived from the reply — see setHistory).
    lastMessage = null;
    dirOptions = [];
    filterKey = null;
    supplementedDirs = {};
    menuOpen = false;
    // [CUSTOM-20261001-155] Ask the ADDRESS BAR for the filter's default directory. The
    // host cannot guess it: a draft's directory is client-local (058), and even for a
    // session it is the button up there — not the host's bookkeeping — that says which
    // directory the user is looking at.
    askedCwd = NS.tabs && NS.tabs.currentCwd ? NS.tabs.currentCwd() : null;
    render();
    NS.bridge.post({ type: 'listHistory', cwd: askedCwd || undefined });
  }

  function close() {
    if (!open) { return; }
    open = false;
    pending = false;
    drawer.hidden = true;
    button.classList.remove('on');
    menuOpen = false;
    if (filterMenu) { filterMenu.className = 'picker-menu down'; }
  }

  function toggle() { if (open) { close(); } else { show(); } }

  /** Reply to listHistory. Ignored when the drawer was closed meanwhile. */
  function setHistory(message) {
    if (!open) { return; }
    pending = false;
    dirOptions = (message && message.directories) || [];
    // [CUSTOM-20261001-155] The filter defaults to the directory the ADDRESS BAR was
    // showing when we asked — the client sent it along, so the host marked the matching
    // candidate 'current' (the match itself stays a host-computed key: see the file
    // header). Two gates, both deliberate:
    //   · 'filterOn' — the persisted preference; ON unless the user once chose
    //     'All folders', which is a decision and sticks;
    //   · 'askedCwd' — a default folder is only claimed when the address bar actually
    //     showed one. With nothing focused (or a session whose directory is unknown) the
    //     honest answer is the unfiltered list, not a folder picked on the user's behalf.
    filterKey = null;
    if (filterOn && askedCwd) {
      for (var i = 0; i < dirOptions.length; i++) {
        if (dirOptions[i].current) { filterKey = dirOptions[i].key; break; }
      }
    }
    renderChip();
    renderMenu();
    renderList(message);
    // [CUSTOM-20261001-155] A folder can now be filtering by default, so its disk
    // supplement has to be asked for HERE too (applyFilter's call only covers manual
    // picks). Otherwise a default folder that is not the first workspace folder — a
    // draft elsewhere, say — shows a list missing exactly the disk-only sessions 094
    // was built for.
    if (filterKey && filterKey !== UNKNOWN_KEY) { requestSupplement(filterKey); }
  }

  function onClick(event) {
    // [CUSTOM-20260926-079] A click anywhere else in the drawer dismisses the picker
    // (standard dropdown behaviour). The chip stops propagation, so its own toggle is
    // never seen here; a click on a menu row must of course not dismiss its own menu.
    if (menuOpen && !inMenu(event.target)) {
      menuOpen = false;
      renderMenu();
      renderChip();
    }
    // [CUSTOM-20261009-212] 行右端的悬停动作（Archive / Rename）在这里处理：按钮是行按钮的
    // **兄弟**（见 buildRowActions），下面那圈上行查找从它出发找不到 data-open-session，
    // 点击会落空。动作只发消息，等宿主的 sessionAction 回来再改列表（不做乐观更新）。
    var actionBtn = event.target && event.target.closest
      ? event.target.closest('[data-session-action]') : null;
    if (actionBtn) {
      event.preventDefault();
      var actionKind = actionBtn.getAttribute('data-session-action');
      var actionId = actionBtn.getAttribute('data-action-id');
      if (actionKind && actionId) {
        if (actionKind === 'rename') {
          var rowWrap = actionBtn.closest ? actionBtn.closest('.session-row') : null;
          var rowBtn = rowWrap && rowWrap.querySelector ? rowWrap.querySelector('[data-open-title]') : null;
          NS.bridge.post({
            type: 'renameSession',
            sessionId: actionId,
            currentTitle: rowBtn ? (rowBtn.getAttribute('data-open-title') || '') : ''
          });
        } else if (actionKind === 'archive') {
          NS.bridge.post({ type: 'archiveSession', sessionId: actionId });
        }
      }
      return;
    }
    var row = event.target;
    while (row && row !== drawer) {
      // Filter first: the menu rows and the empty state's "Show all folders" both
      // carry this attribute and neither opens a session.
      if (row.getAttribute && row.getAttribute('data-filter-key') !== null) {
        event.preventDefault();
        applyFilter(row.getAttribute('data-filter-key'));
        return;
      }
      if (row.getAttribute && row.getAttribute('data-open-session')) {
        event.preventDefault();
        // [CUSTOM-20260928-100] On a draft page, the DRAFT is what gives way — not the
        // session the host still has focused (drafts are client-local, 058). The flag
        // tells the host to skip the replace step, and the draft is retired here. Long
        // form on purpose: a draft consumed by the pick must not leave its text behind.
        var fromDraft = false;
        if (NS.draft && NS.draft.focusedId) {
          var draftId = NS.draft.focusedId();
          if (draftId) {
            fromDraft = true;
            NS.draft.resolve(draftId);
          }
        }
        NS.bridge.post({
          type: 'openHistorySession',
          agentName: row.getAttribute('data-open-agent'),
          sessionId: row.getAttribute('data-open-session'),
          cwd: row.getAttribute('data-open-cwd') || undefined,
          // [CUSTOM-20260928-098] Carry the title so the tab shows the same name
          // the list does, immediately — the replay does not always re-send it.
          title: row.getAttribute('data-open-title') || undefined,
          fromDraft: fromDraft
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
    filterChip = NS.dom.qs('historyFilter');
    filterMenu = NS.dom.qs('historyFilterMenu');
    if (drawer) {
      // [CUSTOM-20260926-079] The DYNAMIC container, not '.outline-head': render()
      // clears what it gets, and it must not take the filter chip with it (the 077
      // shape: a static control is a sibling of the info span).
      headEl = drawer.querySelector('.outline-head-info');
      listEl = drawer.querySelector('.outline-list');
      drawer.addEventListener('click', onClick);
    }
    if (filterChip) {
      filterChip.addEventListener('click', function (event) {
        // Both, deliberately: preventDefault keeps the button from acting like a
        // submit, and stopPropagation keeps the document-level outside-click from
        // treating this as "clicked away" and closing the drawer under the menu.
        event.preventDefault();
        event.stopPropagation();
        toggleFilterMenu();
      });
    }
    // The on/off preference survives a reload of this webview (the same mechanism
    // Times / Sub-agents use). The DIRECTORY deliberately does not — see show().
    // [CUSTOM-20261001-155] Only an EXPLICIT 'All folders' (false) turns it off now;
    // never having touched it means ON (the default flip described in the file header).
    var ui = NS.boot && NS.boot.recallUi ? NS.boot.recallUi() : {};
    filterOn = ui.historyFolderFilter !== false;
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
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        // [CUSTOM-20260926-079] Layered: the menu is the innermost open thing, so
        // Escape closes IT first — otherwise Escape would throw away the whole list
        // (and the user's position in it) just because the picker was open.
        if (menuOpen) {
          menuOpen = false;
          renderMenu();
          renderChip();
          return;
        }
        close();
      }
    }, true);
    document.addEventListener('click', function (event) {
      if (!open) { return; }
      // [CUSTOM-20260926-079] Ask the DISPATCH-TIME path, NOT contains(event.target).
      //
      // Picking a filter re-renders the menu, which DETACHES the button that is still
      // bubbling — and contains() is false for a detached node, so the click that
      // had just filtered the list also looked like a click outside it and closed the
      // whole drawer (the reported bug). composedPath() is fixed when the event is
      // dispatched, so it still answers "was this inside the drawer?".
      var path = event.composedPath ? event.composedPath() : null;
      if (path) {
        for (var i = 0; i < path.length; i++) {
          if (path[i] === drawer || path[i] === button) { return; }
        }
      } else if (drawer.contains(event.target) || button.contains(event.target)) {
        return;
      }
      close();
    });
    close();
  }

  /** Focus changed: the history list belongs to the previous agent. */
  function reset() { close(); }

  NS.sessionMenu = {
    init: init,
    reset: reset,
    setHistory: setHistory,
    applySupplement: applySupplement,
    // [CUSTOM-20261009-212] 宿主做完归档/改名后的对账（boot 转发 sessionAction）。
    applyAction: applyAction
  };
})(window.__acpc = window.__acpc || {});
`;
