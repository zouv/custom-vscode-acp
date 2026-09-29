// [CUSTOM-BEGIN] CUSTOM-20260928-102 - 最近一条用户消息「悬浮置顶」：新增客户端模块。
//
// **为什么**：长会话往下翻之后，读者会忘记这一轮到底在回答什么问题，而滚回上一条用户
// 消息要重新找位置。把当前这一轮的用户消息以**克隆节点**的形式挂在消息列顶部，点击跳回原处。
//
// **保持一样的渲染**（用户明确要求）：直接 `cloneNode(true)` 那个条目节点，而不是重写一份
// 摘要 —— 折叠态、图标、时刻、markdown 结构全都跟着走，不会出现"悬浮版和本体长得不一样"。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260928-102
//
// [CUSTOM-BEGIN] CUSTOM-20260928-103 - 判定规则收紧：视口里出现更晚的用户消息就不置顶。
//
// **为什么**（用户复验 102 后报的）：往上滑回去看某条用户消息时，102 的判据会**越过它**去
// 钉住更旧的那一条 —— 读者眼前明明摆着这一问，顶上却钉着上一问。规则改成：只要有更晚的
// 用户消息在视口里，就不置顶。判据只依赖当前画面、不依赖滚动方向与历史，来回滚动完全对称。
//
// 排版一致性（同一轮）：host 照抄 `.messages` 的排布条件（flex 列 + 相同的水平内边距），
// 克隆体那份 align-self / max-width 才落到和列表同一个基数上。
// 另外把列表的 `show-times` 状态抄到 host（克隆体不在 `#messages` 里，CSS 选择器够不着）。
// [CUSTOM-END] CUSTOM-20260928-103
//
// [CUSTOM-BEGIN] CUSTOM-20260928-104 - 吸顶式交棒 + 悬浮卡片 + 收缩按钮。
//
// **交棒**（用户复验 103 后从两个方案里选的）：判据从"完全离开视口"提前到"**顶边到达视口顶**"
// —— 消息的顶边一碰到那条线，它就成为"本轮提问"：本体隐藏、副本接管。能提前而不出现同屏两份，
// 靠两件事：①副本**落在本体当时所在的位置上**（TOP_GAP 那个窗口之内），所以交棒那一帧画面上
// 的内容没有位移；②本体用 `visibility: hidden` 让位（保住几何，rail 测量与 jumpTo 都不受影响）。
//
// 代价写在明处：悬浮条会**长时间盖住下方内容**（这正是收缩按钮存在的理由），
// 而且"消息滚走"这个动作在视觉上不再发生 —— 它变成"消息停住、下方内容从它下面流过"。
//
// **悬浮卡片**：底色/描边/阴影移到内层 `.sticky-card`，描边用 box-shadow 画（不占布局，
// 否则内容盒会窄 1px、克隆体就对不上原位）。
//
// **收缩按钮**：只对可折叠（多行）的消息显示 —— 单行气泡本来就是一行，给它一个按下去没变化
// 的按钮比没有按钮更糟（本仓库对"点了没反应"的态度见 pitfalls #5/#23）。
// [CUSTOM-END] CUSTOM-20260928-104
//
// [CUSTOM-BEGIN] CUSTOM-20260928-105 - 与消息列横向对齐：让开滚动条那几像素。
//
// **为什么**：用户报"悬浮面板还是没有对齐"。卡片的内容盒与 .messages 的内边距已经一致，但
// **.messages 是滚动容器**——细滚动条照样占布局宽度，于是消息的内容盒比消息列窄那么几像素，
// 而悬浮条不是滚动容器。不补偿的话，卡片右缘会比它所代表的那条消息**右出滚动条那么宽**，
// 正是"看起来差一点又说不清差在哪"的那种错位。
//
// 修法是量出来的、不是猜的：`offsetWidth - clientWidth` 就是滚动条宽度（没有滚动条时为 0），
// 写进 host 的 right。它随滚动条出现/消失自动跟着变，不引入任何常量（pitfall #24 的反面：
// 这里锚的是元素自己的真实几何）。
// [CUSTOM-END] CUSTOM-20260928-105
export const stickyUserClient = `
(function (NS) {
  'use strict';

  // [CUSTOM-20260928-104] The bar's top gap, in pixels. It is BOTH:
  //   · the layout — written into the host below, so the copy comes to rest exactly this
  //     far below the scrollport top, and
  //   · the handoff window in pinnedEntry() — the source gives way while its top is still
  //     within this many pixels of where the copy lands, so the swap itself moves nothing.
  // They have to be the same number or every handoff would carry a visible jump, so there
  // is one source for both (pitfall #19: one fact, one place).
  var TOP_GAP = 8;

  var host = null;         // #stickyUser — positioning layer (transparent, click-through)
  var body = null;         // #stickyBody — holds the clone
  var toggle = null;       // #stickyToggle — collapse / expand
  var messagesEl = null;
  // Which message the bar stands in for. The clone is only rebuilt when this CHANGES —
  // cloning a markdown-heavy bubble on every frame would be the most expensive thing the
  // panel does.
  var shownId = null;
  var hiddenNode = null;   // the ORIGINAL node the bar has taken over
  var collapsed = false;
  var lastRight = -1;      // [CUSTOM-20260928-105] last value written to host.style.right

  /** User entries in transcript order (the same accessor the outline uses). */
  function userEntries() {
    var out = [];
    if (!NS.transcriptView.ordered) { return out; }
    var ids = NS.transcriptView.ordered();
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (entry && entry.kind === 'user') { out.push(entry); }
    }
    return out;
  }

  /**
   * [CUSTOM-BEGIN] CUSTOM-20260928-104 - 谁是「本轮提问」。
   *
   * Sticky semantics: the last question whose TOP has reached the top edge is the turn
   * being answered. The window is strict (< TOP_GAP) so that a question scrolled to rest
   * at the very top is *not* yet taken over — nothing would be gained by it.
   *
   * 103's rule still ends the walk: the first question whose top has NOT reached the window
   * either is on screen — the reader is looking at a question already, so pin nothing — or
   * is below the viewport, and everything after it is further down still.
   */
  function pinnedEntry() {
    var items = userEntries();
    var found = null;
    var scrollTop = messagesEl.scrollTop;
    var viewBottom = scrollTop + messagesEl.clientHeight;
    for (var i = 0; i < items.length; i++) {
      var node = NS.transcriptView.node(items[i].id);
      if (!node) { continue; }
      if (node.offsetTop - scrollTop < TOP_GAP) {
        found = items[i];
        continue;
      }
      if (node.offsetTop < viewBottom) { return null; }
      break;
    }
    return found;
  }
  // [CUSTOM-END] CUSTOM-20260928-104

  /**
   * [CUSTOM-20260928-104] Keep exactly one node standing back: the one the bar replaces.
   * Cheap and idempotent (an identity compare), so sync() runs it on every pass — a node
   * rebuilt by the record layer would otherwise silently lose the class and leave the
   * original sitting next to its own copy.
   */
  function markSource(node) {
    if (hiddenNode === node) { return; }
    if (hiddenNode && hiddenNode.classList) { hiddenNode.classList.remove('sticky-source'); }
    hiddenNode = node;
    if (node && node.classList) { node.classList.add('sticky-source'); }
  }

  function hide() {
    if (!host) { return; }
    host.hidden = true;
    if (body) { NS.dom.clear(body); }
  }

  /** The collapse state and the button's face. Re-applied after every render (className is rewritten there). */
  function applyToggle() {
    if (host) {
      if (collapsed) { host.classList.add('collapsed'); } else { host.classList.remove('collapsed'); }
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.title = collapsed ? 'Expand' : 'Collapse';
      toggle.textContent = collapsed ? '\\u25BE' : '\\u25B4';
    }
  }

  function setCollapsed(on) {
    collapsed = !!on;
    applyToggle();
  }

  function render(entry) {
    var node = NS.transcriptView.node(entry.id);
    if (!node || !body) { hide(); return; }
    NS.dom.clear(body);
    // [CUSTOM-20260928-103] The clone lives outside '#messages', so the list's rendering
    // toggles have to be mirrored here — otherwise times would show in the list but not in
    // the pinned copy (the CSS keys off '.messages.show-times').
    host.className = 'sticky-user' +
      (messagesEl.classList && messagesEl.classList.contains('show-times') ? ' show-times' : '');
    var copy = node.cloneNode(true);
    // A picture of the message, not a second instance of it: duplicate ids would be
    // invalid, and the anchor is addressed by 'data-entry-id' on the ORIGINAL.
    copy.removeAttribute('data-entry-id');
    // [CUSTOM-20260928-104] The source carries the class that hides it, and cloneNode copies
    // class attributes — so a RE-render (Times, a new pin) would clone a hidden node and the
    // bar would come up invisible. The CSS is scoped to '.messages' for the same reason; this
    // is the second line of defence, because that failure is silent and looks like the bar
    // simply stopped working.
    if (copy.classList) { copy.classList.remove('sticky-source'); }
    if (copy.removeAttribute) { copy.removeAttribute('id'); }
    if (copy.querySelectorAll) {
      var withIds = copy.querySelectorAll('[id]');
      for (var i = 0; i < withIds.length; i++) { withIds[i].removeAttribute('id'); }
      // Buttons inside the clone (a code Copy, a fold caret) must not act on the copy.
      var buttons = copy.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        if (btn.getAttribute('data-code-copy') !== null) { btn.parentNode.removeChild(btn); }
      }
    }
    body.appendChild(copy);
    // [CUSTOM-20260928-104] Only a folded (multi-line) message has anything to shrink;
    // a one-line bubble is already one line. [CUSTOM-20260928-113] Since every user
    // record is now a <details>, the test is no longer "is it a details" (that would
    // offer shrinking on every message, including ones where it does nothing) but "is
    // there a remainder hidden behind the caret" - which is what .fold-body means.
    if (toggle) {
      toggle.hidden = !(copy.querySelector && copy.querySelector('.fold-body'));
    }
    applyToggle();
    host.hidden = false;
    host.setAttribute('data-jump-target', entry.id);
    host.title = 'Jump back to this message';
  }

  /**
   * [CUSTOM-20260928-105] Put the bar's right edge exactly where the messages' content box
   * ends. The messages live inside a scroll container, so a scrollbar (thin, but real) is
   * part of the layout and pushes their content box left; the bar itself never scrolls.
   * Measured rather than assumed, and 0 whenever there is no scrollbar.
   */
  function alignToContent() {
    if (!host || !host.style) { return; }
    var gap = (messagesEl.offsetWidth || 0) - (messagesEl.clientWidth || 0);
    if (gap === lastRight) { return; }
    lastRight = gap;
    host.style.right = gap > 0 ? gap + 'px' : '0px';
  }

  /** One coalesced pass per frame (the scroll handler itself only marks the work). */
  function sync() {
    if (!host || !messagesEl) { return; }
    var entry = pinnedEntry();
    var id = entry ? entry.id : null;
    if (id !== shownId) {
      shownId = id;
      if (entry) { render(entry); } else { hide(); }
    }
    alignToContent();
    markSource(entry ? NS.transcriptView.node(entry.id) : null);
  }

  /** Transcript replaced (session switch / hydrate): nothing is pinned yet. */
  function reset() {
    shownId = null;
    markSource(null);
    hide();
  }

  /**
   * [CUSTOM-20260928-103] Re-render the pinned message even though it did not change — for
   * the times the SAME message must look different (the Times toggle). Forcing the rebuild
   * through shownId keeps one code path for rendering; it is a user-initiated toggle, so
   * paying for a clone here is fine (the guard exists to keep SCROLL cheap).
   */
  function refresh() {
    shownId = null;
    sync();
  }

  function init() {
    host = NS.dom.qs('stickyUser');
    body = NS.dom.qs('stickyBody');
    toggle = NS.dom.qs('stickyToggle');
    messagesEl = NS.dom.qs('messages');
    if (!host || !messagesEl) { return; }
    // The gap is layout AND handoff window (TOP_GAP) — written here so the two cannot drift.
    if (host.style) { host.style.paddingTop = TOP_GAP + 'px'; }
    messagesEl.addEventListener('scroll', function () { NS.dom.schedule(sync); });
    if (toggle) {
      toggle.addEventListener('click', function (event) {
        event.preventDefault();
        // The host's own click jumps back to the message; this button is not that click.
        if (event.stopPropagation) { event.stopPropagation(); }
        setCollapsed(!collapsed);
      });
    }
    host.addEventListener('click', function (event) {
      event.preventDefault();
      var id = host.getAttribute('data-jump-target');
      var node = id ? NS.transcriptView.node(id) : null;
      // Land the original just BELOW the handoff window: jumping exactly onto it would
      // give the message straight back to the bar, and a click that visibly does nothing
      // is worse than no click at all — this keeps 102's "click to go back to it".
      if (node) { NS.scroll.jumpTo(node, TOP_GAP + 1); }
    });
  }

  NS.stickyUser = { init: init, sync: sync, reset: reset, refresh: refresh };
})(window.__acpc = window.__acpc || {});
`;
