// [CUSTOM-BEGIN] CUSTOM-20260924-021 - 会话大纲抽屉：新增客户端模块。
// 对话变长后唯一的回溯入口：标题栏的 ☰ 按钮拉出「用户消息」列表，点击跳转，当前项高亮。
//
// [CUSTOM-20260926-076] 新增钉住式右侧栏：下拉头部「固定到右侧」把大纲从临时下拉钉成
// 常驻右栏（宽度可调、可持久化）；内容从「只收 user」扩到「user + assistant」，每项带
// 类型图标 + hover 全文。两种形态并存。
// [CUSTOM-20260926-077] 持久化搬到扩展宿主 globalState（setUiPref/uiPrefs 消息）——webview
// 本地 setState 只活在同一实例 reload，窗口重载/编辑器面板重开就丢。
//
// 三个必须遵守的点：
//   1. **列表顺序来自 transcriptView.ordered()**（显式数组），不要用 Object.keys 的顺序。
//   2. **布局读取只发生在 rAF 回调里**（NS.dom.schedule）。scroll 事件本身只置脏位——
//      在 scroll 处理函数里读 offsetTop 会让每一帧都强制重排。
//   3. **跳转后必须 pinned = false**（scroll.jumpTo 已处理），否则流式分片会把视口拽回底部。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260924-021
export const outlineClient = `
(function (NS) {
  'use strict';

  var MAX_ITEMS = 200;
  var LABEL_MAX = 80;
  // [CUSTOM-20260926-076] 原生 tooltip 上限：全文可能到 64KB，巨型 tooltip 没有用。
  // 500 字足够「悬停看更多」，又不会糊一脸。
  var TITLE_MAX = 500;
  var MIN_WIDTH = 180;
  var MAX_WIDTH_RATIO = 0.5;

  var drawer = null;      // #outline 下拉浮层
  var sidebar = null;     // #outlineSidebar 右侧常驻栏
  var button = null;      // #outlineBtn ☰
  var pinBtn = null;      // #outlinePin 固定到右侧
  var unpinBtn = null;    // #outlineUnpin 取消固定
  var resizeEl = null;    // #outlineResize 调宽手柄
  var drawerHead = null;  // 下拉的 .outline-head
  var drawerList = null;  // 下拉的 .outline-list
  var sideHead = null;    // 侧栏的 .outline-head
  var sideList = null;    // 侧栏的 .outline-list
  var messagesEl = null;  // #messages 滚动容器
  var messageArea = null; // #messageArea（宽度钳制基准）

  var mode = 'popup';     // 'popup' | 'sidebar'（持久化）
  var isOpen = false;     // 当前形态是否可见
  var width = 240;        // 侧栏宽度 px（持久化）
  var dragging = false;   // 是否正在拖调宽手柄
  var dragStartX = 0;
  var dragStartW = 0;
  var tops = null;        // 缓存的 [{ id, top }]，DOM 变化后置 null 惰性重建

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function timeLabel(at) {
    if (!at) { return ''; }
    var d = new Date(at);
    // [CUSTOM-20260926-077] 显示到秒级；时间已移到每项最右，不再抢占正文左侧空间。
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function labelOf(entry) {
    var text = String((entry && entry.text) || '').replace(/\\s+/g, ' ').trim();
    if (text.length > LABEL_MAX) { text = text.slice(0, LABEL_MAX) + '\\u2026'; }
    return text || '(empty message)';
  }

  // [CUSTOM-20260926-076] 悬停时的全文（截到 TITLE_MAX）。
  function titleOf(entry) {
    var text = String((entry && entry.text) || '').replace(/\\s+/g, ' ').trim();
    if (text.length > TITLE_MAX) { text = text.slice(0, TITLE_MAX) + '\\u2026'; }
    return text || '';
  }

  /** Anchor entries, in transcript order. [CUSTOM-20260926-076] user + assistant。 */
  function anchors() {
    var out = [];
    if (!NS.transcriptView.ordered) { return out; }
    var ids = NS.transcriptView.ordered();
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (entry && (entry.kind === 'user' || entry.kind === 'assistant')) { out.push(entry); }
    }
    return out;
  }

  /**
   * [CUSTOM-20260926-081] "Is there anything to navigate?" — the precondition for
   * EVERY form of this outline.
   *
   * 045 applied it to the ☰ button only. That was fine while the popup was the only
   * form: with no button there was no outline. 076 made the outline pinnable, and the
   * docked column never learned the rule — so a panel with **no session at all** (or a
   * fresh session) showed a docked "OUTLINE / No messages yet" column beside the empty
   * state, squeezing it out of the middle of the panel.
   *
   * Cached rather than read per call: renderVisibility() runs on show/hide/pin/unpin
   * and must not walk the transcript. syncButton() (called from invalidate, i.e. on
   * every transcript change) is the only writer.
   */
  var anchorsPresent = false;

  /** The ☰ button only makes sense once there is something to navigate. */
  function syncButton() {
    // [CUSTOM-20260925-045 / 075] O(1)：计数由 transcriptView 维护（messageAnchorCount
    // 覆盖 user+assistant），不要在每次 append 上全量走 anchors()。
    anchorsPresent = NS.transcriptView.messageAnchorCount() > 0;
    if (button) { button.hidden = !anchorsPresent; }
    renderVisibility();
  }

  function renderInto(head, list) {
    var items = anchors();
    var hidden = 0;
    if (items.length > MAX_ITEMS) {
      hidden = items.length - MAX_ITEMS;
      items = items.slice(hidden);
    }
    NS.dom.clear(list);
    NS.dom.clear(head);
    head.appendChild(NS.dom.el('span', 'outline-count',
      items.length === 0 ? 'No messages yet' : items.length + (items.length === 1 ? ' message' : ' messages')));
    if (hidden > 0) {
      head.appendChild(NS.dom.el('span', 'outline-more', '\\u2026 ' + hidden + ' earlier hidden'));
    }
    for (var i = 0; i < items.length; i++) {
      var entry = items[i];
      // [CUSTOM-20260925-047] 真 <button>：Enter/Space 免费，且进入 tab 顺序。
      var row = NS.dom.el('button', 'outline-item');
      row.type = 'button';
      row.setAttribute('data-jump-id', entry.id);
      // [CUSTOM-20260926-076] 悬停显示更多：原生 title（截到 TITLE_MAX）。
      var title = titleOf(entry);
      if (title) { row.title = title; }
      // [CUSTOM-20260926-076/077] 类型图标（user/assistant）。加 kind 后缀类便于
      // 按类型着色（user 蓝 / assistant 灰，见 styles.ts .outline-kind-user/-assistant）。
      var icon = NS.icons.icon(entry.kind, 'outline-kind outline-kind-' + entry.kind);
      if (icon) { row.appendChild(icon); }
      // [CUSTOM-20260926-077] 时间移到最右：正文 flex:1 占满左侧，时间紧凑靠右。
      row.appendChild(NS.dom.el('span', 'outline-text', labelOf(entry)));
      row.appendChild(NS.dom.el('span', 'outline-time', timeLabel(entry.at)));
      list.appendChild(row);
    }
    tops = null;
  }

  /** Render the visible surface (dropdown or sidebar), if any. */
  function render() {
    if (!isOpen) { return; }
    if (mode === 'sidebar') { renderInto(sideHead, sideList); }
    else { renderInto(drawerHead, drawerList); }
  }

  /** Sync .hidden and the button's .on state to isOpen/mode/有没有可导航的东西。 */
  function renderVisibility() {
    // [CUSTOM-20260926-081] Nothing to navigate ⇒ no form of this outline is shown,
    // whichever it is (see anchorsPresent). The MODE is a preference and survives —
    // the pinned column comes back by itself with the first message.
    var live = isOpen && anchorsPresent;
    if (drawer) { drawer.hidden = !(live && mode === 'popup'); }
    if (sidebar) { sidebar.hidden = !(live && mode === 'sidebar'); }
    if (button) { button.classList.toggle('on', live); }
    // [CUSTOM-20260930-135] 写在 sidebar.hidden 之后：输入区的版心对齐要知道侧栏**此刻**
    // 是不是真的占着宽度（见 applyReserve）。
    applyReserve();
  }

  /** Measure each anchor's position. Only ever called from the rAF pass. */
  function measure() {
    var items = anchors();
    var next = [];
    for (var i = 0; i < items.length; i++) {
      var node = NS.transcriptView.node(items[i].id);
      if (node) { next.push({ id: items[i].id, top: node.offsetTop - messagesEl.offsetTop }); }
    }
    tops = next;
  }

  function setActiveIn(list, id) {
    if (!list) { return; }
    var rows = list.querySelectorAll('.outline-item');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var on = row.getAttribute('data-jump-id') === id;
      if (on) { row.classList.add('active'); } else { row.classList.remove('active'); }
    }
  }

  function setActive(id) {
    setActiveIn(drawerList, id);
    setActiveIn(sideList, id);
    revealActive();
  }

  /**
   * [CUSTOM-20260928-102] Keep the highlighted row inside its own scroll view.
   *
   * Reported: scrolling the conversation to the bottom highlighted the right row but
   * the list never followed it, so the mark sat off-screen and the outline looked
   * stuck. Only the outline's OWN scroll container is touched — 'scrollIntoView'
   * would walk up and scroll '#messages' too, yanking the conversation under the
   * reader. The move is the minimum needed (only when the row is out of view), so a
   * row the user just CLICKED never re-centres the list under the cursor.
   *
   * The two forms scroll different elements: the popup scrolls the drawer itself
   * ('.outline' carries the overflow), the pinned column scrolls its list
   * ('.outline-sidebar .outline-list' is the 'flex: 1; overflow-y: auto' box).
   */
  function revealActive() {
    var container = mode === 'sidebar' ? sideList : drawer;
    if (!container || !container.querySelector) { return; }
    var active = container.querySelector('.outline-item.active');
    if (!active || !active.getBoundingClientRect) { return; }
    var box = container.getBoundingClientRect();
    var row = active.getBoundingClientRect();
    if (row.top < box.top) {
      container.scrollTop -= box.top - row.top;
    } else if (row.bottom > box.bottom) {
      container.scrollTop += row.bottom - box.bottom;
    }
  }

  /** Highlight the anchor the viewport is currently inside (binary search). */
  function syncActive() {
    if (tops === null) { measure(); }
    if (!tops || tops.length === 0) { setActive(null); return; }
    // [CUSTOM-20260928-100] Scrolled to the very bottom ⇒ the LAST anchor is the
    // one being read. Reported: "我已经拉到底了，右侧选中的是倒数第二个" — the
    // top-of-viewport rule below stops at the second-to-last row whenever the last
    // message is shorter than the viewport (its top is above the fold, so the row
    // whose top is nearest the viewport top IS the second-to-last one).
    // 'clientHeight > 0' guards the un-measurable case (a hidden panel reports 0
    // for both, which would otherwise read as "at the bottom").
    if (messagesEl.clientHeight > 0
      && messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 4) {
      setActive(tops[tops.length - 1].id);
      return;
    }
    var y = messagesEl.scrollTop + 8;
    var lo = 0;
    var hi = tops.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tops[mid].top <= y) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    setActive(tops[found < 0 ? 0 : found].id);
  }

  /** Coalesced scroll pass: layout reads happen here, never in the handler. */
  function onScroll() {
    if (!isOpen) { return; }
    NS.dom.schedule(function () { if (isOpen) { syncActive(); } });
  }

  function jump(id) {
    var node = NS.transcriptView.node(id);
    if (!node) { return; }
    NS.scroll.jumpTo(node);
    setActive(id);
    // [CUSTOM-20260926-076] 侧栏是常驻导航：跳转后不关；下拉维持「跳完收起」。
    if (mode === 'popup') { hide(); }
  }

  function show() {
    isOpen = true;
    renderVisibility();
    render();
    NS.dom.schedule(function () { if (isOpen) { tops = null; syncActive(); } });
  }

  /** 隐藏当前可见形态（isOpen = false），形态（mode）不变。 */
  function hide() {
    if (!isOpen) { return; }
    isOpen = false;
    renderVisibility();
  }

  /** 关闭下拉浮层。会话切换（boot.ts 调 close）时的语义：只针对临时下拉；
      钉住的侧栏要保持常驻，所以 sidebar 模式下这是 no-op。 */
  function close() {
    if (mode === 'popup') { hide(); }
  }

  function toggle() { if (isOpen) { hide(); } else { show(); } }

  /** [CUSTOM-20260926-076] 钉住：下拉 → 常驻右栏。 */
  function pin() {
    mode = 'sidebar';
    isOpen = true;
    renderVisibility();
    render();
    persistPrefs();
    NS.dom.schedule(function () { if (isOpen) { tops = null; syncActive(); } });
  }

  /** [CUSTOM-20260926-076] 取消固定：收起侧栏，回到下拉形态（不自动展开下拉）。 */
  function unpin() {
    mode = 'popup';
    isOpen = false;
    renderVisibility();
    persistPrefs();
  }

  // [CUSTOM-20260926-077] 持久化搬到扩展宿主 globalState：webview 本地 setState 只在
  // 同一实例 reload 时存活，窗口重载 / 编辑器面板关闭重开都会丢。发一条非会话作用域的
  // 'setUiPref'，宿主存 globalState，boot 时通过 'uiPrefs' 消息带回。
  function persistPrefs() {
    if (NS.bridge && NS.bridge.post) {
      NS.bridge.post({ type: 'setUiPref', outlineMode: mode, outlineWidth: width });
    }
  }

  /** 应用宿主带回来的偏好（boot 后由 boot.ts 调一次，幂等）。 */
  function applyPrefs(prefs) {
    if (!prefs) { return; }
    mode = prefs.outlineMode === 'sidebar' ? 'sidebar' : 'popup';
    isOpen = mode === 'sidebar';
    if (typeof prefs.outlineWidth === 'number') { width = clamp(prefs.outlineWidth, MIN_WIDTH, 9999); }
    applyWidth();
    renderVisibility();
    if (isOpen) {
      render();
      NS.dom.schedule(function () { if (isOpen) { tops = null; syncActive(); } });
    }
  }

  function applyWidth() {
    if (sidebar) { sidebar.style.width = width + 'px'; }
    applyReserve();
  }

  /**
   * [CUSTOM-20260930-135 / 138 / 143] 把大纲栏宽度复述给 CSS（底部**预留功能区**的宽度用它）。
   *
   * 为什么非得由 JS 说一遍：CSS 读不到 flex 项的**实测**宽度，而右下角那块预留区的左边界要
   * 与钉住的大纲栏左边界落在同一条竖线上 —— 两个宽度必须是同一个来源（pitfall #19）。
   *
   * 语义演进：135 写的是"侧栏占用宽度"（给 .composer 的 padding-right 做中线补偿）；138 起
   * 底部栏改成两列 flex，主列宽度天然等于"面板宽 − 预留区宽"，中线自动对齐，于是直接写
   * **预留区宽度**；143 起**只在钉住且可见时**才给宽度，其余时候写 0 —— 没有大纲就没有那根
   * 竖线，输入卡随之居中（用户要求）。
   *
   * 幂等。两个调用点覆盖了"什么时候会变"的全部路径：宽度变化（applyWidth）与显示/隐藏变化
   * （renderVisibility，它是 sidebar.hidden 的唯一写者，所以钉住 / 取消钉住都会走到这里）。
   */
  function applyReserve() {
    // 桩 DOM（src/test/chat-client.test.ts）的 document.body.style 是普通对象、没有
    // setProperty ⇒ 这里必须判空跳过，否则一条新代码就能把整个客户端逻辑测试打红。
    if (!document.body || !document.body.style || !document.body.style.setProperty) { return; }
    var visible = !!(sidebar && !sidebar.hidden);
    document.body.style.setProperty('--acpc-aside-w', visible ? (width + 'px') : '0px');
  }

  /** [CUSTOM-20260926-076] 调宽手柄：拖左变宽、拖右变窄（负号决定方向）。 */
  function initResize() {
    if (!resizeEl || !sidebar) { return; }
    resizeEl.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      dragging = true;
      dragStartX = event.clientX;
      dragStartW = width;
      if (resizeEl.setPointerCapture) { resizeEl.setPointerCapture(event.pointerId); }
    });
    resizeEl.addEventListener('pointermove', function (event) {
      if (!dragging) { return; }
      var max = messageArea ? Math.floor(messageArea.clientWidth * MAX_WIDTH_RATIO) : 400;
      width = clamp(dragStartW - (event.clientX - dragStartX), MIN_WIDTH, max);
      applyWidth();
    });
    resizeEl.addEventListener('pointerup', function (event) {
      if (!dragging) { return; }
      dragging = false;
      if (resizeEl.releasePointerCapture) { resizeEl.releasePointerCapture(event.pointerId); }
      persistPrefs();
      // 宽度变化会改变 #messages 的折行 → 左 rail 圆点要重对齐。
      if (NS.rail && NS.rail.reflow) { NS.rail.reflow(); }
    });
  }

  /** Transcript mutated (append / revise / hydrate): positions are stale. */
  function invalidate() {
    tops = null;
    syncButton();
    if (isOpen) { render(); }
  }

  function onClick(event) {
    var row = event.target;
    while (row) {
      if (row.getAttribute && row.getAttribute('data-jump-id')) {
        event.preventDefault();
        jump(row.getAttribute('data-jump-id'));
        return;
      }
      row = row.parentNode;
    }
  }

  function init(messages, drawerEl, buttonEl) {
    messagesEl = messages;
    drawer = drawerEl;
    button = buttonEl;
    drawerList = drawer.querySelector('.outline-list');
    // [CUSTOM-20260926-077] 钉住按钮并进了 .outline-head（"N messages" 同一行），
    // 计数放 .outline-head-info 子容器里，这样 render() 清 head 不会抹掉钉住按钮。
    drawerHead = drawer.querySelector('.outline-head-info');
    sidebar = NS.dom.qs('outlineSidebar');
    if (sidebar) {
      sideList = sidebar.querySelector('.outline-list');
      sideHead = sidebar.querySelector('.outline-head');
    }
    pinBtn = NS.dom.qs('outlinePin');
    unpinBtn = NS.dom.qs('outlineUnpin');
    resizeEl = NS.dom.qs('outlineResize');
    messageArea = NS.dom.qs('messageArea');

    button.addEventListener('click', function (event) {
      event.preventDefault();
      toggle();
    });
    drawer.addEventListener('click', onClick);
    if (sidebar) { sidebar.addEventListener('click', onClick); }
    messages.addEventListener('scroll', onScroll);
    if (pinBtn) {
      pinBtn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        pin();
      });
    }
    if (unpinBtn) {
      unpinBtn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        unpin();
      });
    }
    initResize();

    // Capture + stopPropagation: Escape must close the surface instead of
    // cancelling the running turn (composer listens on the textarea).
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
    }, true);
    // [CUSTOM-20260926-076] 点击外部只关临时下拉；钉住的侧栏是常驻面板，
    // 在 transcript 里点来点去不该把它关掉。
    document.addEventListener('click', function (event) {
      if (!isOpen || mode !== 'popup') { return; }
      if (drawer.contains(event.target) || button.contains(event.target)) { return; }
      hide();
    });

    // [CUSTOM-20260926-077] 初始偏好不再从 webview 本地读：boot 后宿主通过
    // 'uiPrefs' 消息调 applyPrefs 带回（跨窗口重载 / 编辑器面板重开都存活）。
    renderVisibility();
  }

  NS.outline = {
    init: init,
    toggle: toggle,
    open: show,
    close: close,
    isOpen: function () { return isOpen; },
    invalidate: invalidate,
    applyPrefs: applyPrefs
  };
})(window.__acpc = window.__acpc || {});
`;
