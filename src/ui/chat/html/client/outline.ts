// [CUSTOM-BEGIN] CUSTOM-20260924-021 - 会话大纲抽屉：新增客户端模块。
// 对话变长后唯一的回溯入口：标题栏的 ☰ 按钮拉出「用户消息」列表，点击跳转，当前项高亮。
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

  var drawer = null;
  var button = null;
  var headEl = null;
  var listEl = null;
  var messagesEl = null;
  var isOpen = false;
  /** Cached [{ id, top }] for user anchors, rebuilt lazily after DOM changes. */
  var tops = null;

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function timeLabel(at) {
    if (!at) { return ''; }
    var d = new Date(at);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function labelOf(entry) {
    var text = String((entry && entry.text) || '').replace(/\\s+/g, ' ').trim();
    if (text.length > LABEL_MAX) { text = text.slice(0, LABEL_MAX) + '\\u2026'; }
    return text || '(empty message)';
  }

  /** Anchor entries, in transcript order. */
  function anchors() {
    var out = [];
    if (!NS.transcriptView.ordered) { return out; }
    var ids = NS.transcriptView.ordered();
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (entry && entry.kind === 'user') { out.push(entry); }
    }
    return out;
  }

  /** The ☰ button only makes sense once there is something to navigate. */
  function syncButton() {
    if (!button) { return; }
    // [CUSTOM-20260925-045] O(1): this runs on every append/revise, and the
    // former 'anchors().length' walked the whole entry list each time. The
    // counter lives in transcriptView because that is the only place entries
    // are added.
    button.hidden = NS.transcriptView.userAnchorCount() === 0;
  }

  function render() {
    if (!drawer) { return; }
    var items = anchors();
    var hidden = 0;
    if (items.length > MAX_ITEMS) {
      hidden = items.length - MAX_ITEMS;
      items = items.slice(hidden);
    }
    NS.dom.clear(listEl);
    NS.dom.clear(headEl);
    headEl.appendChild(NS.dom.el('span', 'outline-count',
      items.length === 0 ? 'No messages yet' : items.length + (items.length === 1 ? ' message' : ' messages')));
    if (hidden > 0) {
      headEl.appendChild(NS.dom.el('span', 'outline-more', '\\u2026 ' + hidden + ' earlier hidden'));
    }
    for (var i = 0; i < items.length; i++) {
      var entry = items[i];
      // [CUSTOM-20260925-047] A real <button>: Enter/Space work for free and the
      // row joins the tab order (it was click-only before).
      var row = NS.dom.el('button', 'outline-item');
      row.type = 'button';
      row.setAttribute('data-jump-id', entry.id);
      row.appendChild(NS.dom.el('span', 'outline-time', timeLabel(entry.at)));
      row.appendChild(NS.dom.el('span', 'outline-text', labelOf(entry)));
      listEl.appendChild(row);
    }
    tops = null;
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

  function setActive(id) {
    if (!listEl) { return; }
    var rows = listEl.querySelectorAll('.outline-item');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var on = row.getAttribute('data-jump-id') === id;
      if (on) { row.classList.add('active'); } else { row.classList.remove('active'); }
    }
  }

  /** Highlight the anchor the viewport is currently inside (binary search). */
  function syncActive() {
    if (tops === null) { measure(); }
    if (!tops || tops.length === 0) { setActive(null); return; }
    var y = messagesEl.scrollTop + 8;
    var lo = 0;
    var hi = tops.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tops[mid].top <= y) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    // Above the first anchor (session preamble / loaded history): highlight the
    // first one rather than nothing, so the list never looks "unhooked".
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
    close();
  }

  function show() {
    isOpen = true;
    drawer.hidden = false;
    button.classList.add('on');
    render();
    // Offsets can only be measured once the list has been painted; the rAF pass
    // also covers "opened while streaming" (positions change every chunk).
    NS.dom.schedule(function () { if (isOpen) { tops = null; syncActive(); } });
  }

  function close() {
    if (!isOpen) { return; }
    isOpen = false;
    drawer.hidden = true;
    button.classList.remove('on');
  }

  function toggle() { if (isOpen) { close(); } else { show(); } }

  /** Transcript mutated (append / revise / hydrate): positions are stale. */
  function invalidate() {
    tops = null;
    syncButton();
    if (isOpen) { render(); }
  }

  function onClick(event) {
    var row = event.target;
    while (row && row !== drawer) {
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
    listEl = drawer.querySelector('.outline-list');
    headEl = drawer.querySelector('.outline-head');
    button.addEventListener('click', function (event) {
      event.preventDefault();
      toggle();
    });
    drawer.addEventListener('click', onClick);
    messages.addEventListener('scroll', onScroll);
    // Capture + stopPropagation: Escape must close the drawer instead of
    // cancelling the running turn (composer listens on the textarea).
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);
    document.addEventListener('click', function (event) {
      if (!isOpen) { return; }
      if (drawer.contains(event.target) || button.contains(event.target)) { return; }
      close();
    });
    close();
  }

  NS.outline = {
    init: init,
    toggle: toggle,
    open: show,
    close: close,
    isOpen: function () { return isOpen; },
    invalidate: invalidate
  };})(window.__acpc = window.__acpc || {});
`;
