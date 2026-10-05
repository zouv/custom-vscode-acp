// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 「贴底」滚动策略。旧面板无条件 `scrollTop = scrollHeight`，用户往上翻看历史会被反复拽回底部；
// 这里只在用户本来就贴着底部时才自动滚动，否则显示「回到最新」按钮。
// 每个会话各自记住自己的滚动位置。
// [CUSTOM-END] CUSTOM-20260923-011
export const scrollClient = `
(function (NS) {
  'use strict';

  var PIN_THRESHOLD = 32;
  var pinned = true;
  var container = null;
  var jumpBtn = null;
  var offsets = {};
  // [CUSTOM-20260924-022]
  // 合帧：follow() 只置脏位，真正的布局读取与 scrollTop 写入发生在 rAF 回调里。
  // 逐条 chunk 直接读写 scrollHeight 会在一次回复里触发上百次强制重排。
  var followPending = false;
  // 滚动记忆的「再对齐」状态：切回一个会话时先按记录恢复位置，随后 markdown 回填
  // 会改变高度、把位置冲掉，所以要在收到渲染结果后再对齐一次。
  // 只在**用户自己滚动**时放弃（expectedTop 用来区分程序写入与用户滚动）。
  var restoreTarget = null;
  var expectedTop = 0;

  function init(messagesEl, jumpButton) {
    container = messagesEl;
    jumpBtn = jumpButton;
    // [CUSTOM-20261005-192] 滚动事件的**来源**要分得清：用户拖的 vs 我们自己写的
    // （程序写 scrollTop 也会派发 scroll）。分开记，读的时候才不会把"我们跟到底了"
    // 看成"用户自己滚到底了"。判据沿用 restore 那套记账（写完之后回读一次）。
    container.addEventListener('scroll', function () {
      var fromProgram = lastProgrammaticTop >= 0
        && Math.abs(container.scrollTop - lastProgrammaticTop) <= 2;
      logScrollState(fromProgram ? 'scroll-after-program' : 'user-scroll');
      onScroll();
    });
    jumpBtn.addEventListener('click', function () {
      pinned = true;
      hideJump();
      restoreTarget = null;
      writeTop(container.scrollHeight);
    });
    // [CUSTOM-20260924-022] 位置记忆跨面板开关存活（每个文档各存各的：
    // 侧边栏与编辑区的视口本来就不一样，共用一份反而会互相干扰）。
    if (NS.boot && NS.boot.recallUi) {
      var ui = NS.boot.recallUi();
      if (ui && ui.scroll) { offsets = ui.scroll; }
    }
  }

  function onScroll() {
    recompute();
    // 用户接管了视口：放弃待恢复的位置，不要跟他抢。
    if (restoreTarget !== null && container && Math.abs(container.scrollTop - expectedTop) > 2) {
      restoreTarget = null;
    }
  }

  /**
   * [CUSTOM-20261005-192] 「滚动条到底了、面板却不在底部」的**自检**。
   *
   * 用户报过两次（2026-10-03 的 176、2026-10-05 的这次），而 176 那条链在预览档里是健康的
   * （#elicbottomstuckprobe：atMax / pinned / distance 三者自洽），说明还有另一条路。既然它
   * **可复现但当时读不到数字**，就把数字打出来：宿主日志是落盘的（~/.claude/acp-client-custom.log），
   * 下次它一出现，一行日志就能定案，不需要用户做任何事。
   *
   * 只在**状态翻转**时打（pinned 变一次算一次），不做逐帧上报 —— 173 立过规矩：诊断通道自己
   * 有配额，噪声先到会把有用的信号挤掉（pitfalls #42）。
   *
   * 判据里那四个量是"一张必须自洽的账"：
   *   distance = scrollHeight − padBottom − scrollTop − clientHeight
   *   pinned   = distance < 32
   * 所以 atMax（scrollTop 到顶）时 distance 必然是 −padBottom < 0 ⇒ 必然 pinned。**出现
   * "atMax 却不 pinned"，或者 "刚跟过底 distance 仍 ≥ 32"，就说明某个量在说谎** ——
   * scrollTop 被夹住了、padBottom 读不到、或者内容是在写入之后才长出来的。
   */
  /** 读 body 上的 CSS 变量。桩 DOM 的 body 没有 style（滚动那套测试就是这么搭的），判空返回 '-'。 */
  function bodyVar(name) {
    var style = document.body && document.body.style;
    return (style && style.getPropertyValue) ? (style.getPropertyValue(name) || '-') : '-';
  }

  // [CUSTOM-20261005-192] 诊断自身的账：序号 + 节流 + 被压掉的条数。
  //
  // 三件事都不能省：①**序号**让"日志里少了一条"与"这件事没发生"区分开（174/#42 的教训）；
  // ②**节流**（同一个原因 500ms 一条）让流式期间的密集事件不会把日志桥的配额（10s/30 条，
  // 见 boot.ts 的 installLogBridge）烧光；③**sup=** 报出这期间压掉了多少条 —— 被节流掉的是
  // 噪声还是关键那一条，读日志的人必须能看出来。
  var diagSeq = 0;
  var diagSuppressed = 0;
  var diagLastAt = 0;
  var lastScrollHeight = -1;
  // [CUSTOM-20261005-192] 我们最后一次**程序**写下的 scrollTop（写完之后回读的夹紧值）。
  // 滚动事件分不清来源，用它来分（见 init 里的监听器）。
  var lastProgrammaticTop = -1;

  /** 所有程序写 scrollTop 的唯一入口：顺手记下"这是我们写的"，并回读真实落点（可能被夹住）。 */
  function writeTop(value) {
    if (!container) { return; }
    container.scrollTop = value;
    lastProgrammaticTop = container.scrollTop;
  }

  /**
   * [CUSTOM-20261005-192] 三个几何写入方（输入卡 / 表单抽屉 / 权限抽屉）的**变化点**。
   *
   * 它们改的都是 #messages 的 padding-bottom —— 本 bug 的第一嫌疑（176 就是这条链）。只在
   * **数值真的变了**时报（同一高度被反复写很常见，那不是事件），且强制打（不受 700ms 节流），
   * 因为每一个都是"可能把视口顶掉一次"的瞬间。
   */
  var geometryVars = {};
  function noteGeometry(what, value) {
    var text = typeof value === 'number' ? value + 'px' : String(value);
    if (geometryVars[what] === text) { return; }
    var from = geometryVars[what] === undefined ? '(init)' : geometryVars[what];
    geometryVars[what] = text;
    logScrollState('geom:' + what + ' ' + from + '->' + text, true);
  }
  // 自带一层**总量上限**：日志桥是 10s/30 条全客户端共享（boot.ts），这套诊断不能把它吃光，
  // 否则"日志里没有"又会被读成"没发生"（173/#42）。最多占 12 条/10s，其余计入 sup=。
  var DIAG_WINDOW_MS = 10000;
  var DIAG_MAX_PER_WINDOW = 12;
  var diagWindowStart = 0;
  var diagInWindow = 0;

  function logScrollState(reason, force) {
    if (!container) { return; }
    var now = Date.now();
    if (now - diagWindowStart >= DIAG_WINDOW_MS) { diagWindowStart = now; diagInWindow = 0; }
    if (diagInWindow >= DIAG_MAX_PER_WINDOW || (!force && now - diagLastAt < 700)) {
      // 同一个原因连续来很多次（流式里每次 append 都会走一遍 follow）时只记一次，其余计数。
      diagSuppressed++;
      return;
    }
    diagSeq++;
    diagInWindow++;
    diagLastAt = now;
    var pad = 0;
    if (window.getComputedStyle) { pad = parseFloat(window.getComputedStyle(container).paddingBottom) || 0; }
    var max = container.scrollHeight - container.clientHeight;
    var distance = container.scrollHeight - pad - container.scrollTop - container.clientHeight;
    var composer = NS.dom && NS.dom.qs ? NS.dom.qs('composer') : null;
    var last = container.lastElementChild;
    var lastRect = last && last.getBoundingClientRect ? last.getBoundingClientRect() : null;
    var composerRect = composer && composer.getBoundingClientRect ? composer.getBoundingClientRect() : null;
    // 字段名压到最短：整行必须**远小于** 400 字符，否则会被日志桥从尾巴上截掉
    // （被截掉的恰好是 last/comp 这两个"谁盖住了谁"的关键量）。
    console.warn('[acpc] scroll#' + diagSeq + ' ' + reason
      + ' st=' + Math.round(container.scrollTop) + '/' + Math.round(max)
      + ' atmax=' + (container.scrollTop >= max - 1 ? 1 : 0)
      + ' pad=' + Math.round(pad)
      + ' dist=' + Math.round(distance)
      + ' pin=' + (pinned ? 1 : 0)
      + ' jump=' + (jumpBtn ? (jumpBtn.hidden ? 0 : 1) : '?')
      + ' sh=' + Math.round(container.scrollHeight) + ' ch=' + Math.round(container.clientHeight)
      + ' cv=' + bodyVar('--acpc-composer-h')
      + ' ev=' + bodyVar('--acpc-elic-h')
      + ' pv=' + bodyVar('--acpc-perm-h')
      + ' last=' + (lastRect ? Math.round(lastRect.bottom) : '-')
      + ' comp=' + (composerRect ? Math.round(composerRect.top) : '-')
      + ' kind=' + (last ? String(last.getAttribute('data-kind') || 'x') : '-')
      + (diagSuppressed > 0 ? ' sup=' + diagSuppressed : ''));
    diagSuppressed = 0;
  }

  /** 重算「是否贴底」与 Jump 按钮。scroll 事件之外的路径也要能调（见 reflow）。 */
  function recompute() {
    if (!container) { return; }
    // [CUSTOM-20260930-144] distance 用**内容末尾**算（减掉底部那段留白）：留白是给悬浮的输入卡
    // 让位的，它不是内容。这样"内容末尾进入视口"与"判定为到底"就是同一件事 —— 不会出现
    // "Jump 还说没到底、下面却已经是空白"的灰色地带（140~143 被反复报的就是那个区间：
    // 留白 108px 进了可视区，而 32px 的阈值说"还没到底"）。
    // 留白本身是一贯存在的（见 styles.ts 的 .messages），所以这里不需要任何切类/位置补偿。
    var pad = 0;
    if (window.getComputedStyle) {
      pad = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;
    }
    var distance = container.scrollHeight - pad - container.scrollTop - container.clientHeight;
    var wasPinned = pinned;
    pinned = distance < PIN_THRESHOLD;
    // [CUSTOM-20261005-192] 贴底状态翻转 = 一次"视口归属"的交接，正是这个 bug 唯一会留下痕迹的地方。
    if (wasPinned !== pinned) { logScrollState(pinned ? 'pinned' : 'unpinned'); }
    if (pinned) { hideJump(); } else { showJump(); }
  }

  /**
   * [CUSTOM-20261003-176] 几何变了之后的**再判定**。
   *
   * 为什么需要它：pinned 与 Jump 按钮原先只在 scroll 事件里更新，而**内容高度或底部留白**
   * （输入卡 / 表单抽屉 / 权限抽屉的高度都进 #messages 的 padding-bottom）变化时，浏览器
   * **不会**派发 scroll 事件 —— 于是视口停在旧判定上：
   *   · 本来贴底的人，抽屉/输入卡长高后内容被挤到浮层后面，而他看到的 Jump 状态还是旧的，
   *     滚动条也已经在头（残留是"没到底"的错觉，实际滚不动）—— 用户 2026-10-03 报的就是这个；
   *   · 反过来，内容被压缩到不再需要滚动时，Jump 还挂在屏幕上。
   * 所以三个写高度的模块（composer / elicitationView / permissionDrawer）改完变量就喊一声。
   *
   * 贴底时**顺手跟到底**（含刚长出来的那段留白）：这正是「贴着底部」该有的样子，
   * 也是用户明确要过的语义（"消息区的触底判断保持在输入框上面"）。上翻看历史的人不受影响 ——
   * keepBottom 取的是变化**之前**的 pinned。
   */
  function reflow() {
    if (!container) { return; }
    var keepBottom = pinned;
    recompute();
    if (keepBottom) {
      container.scrollTop = container.scrollHeight;
      recompute();
      // [CUSTOM-20261005-192] 刚"跟到底"却又判成没到底 ⇒ 这次跟随**没到位**：要么 scrollTop
      // 被夹在一个更小的 max 上（内容还没落地就写），要么留白在写入之后又长了一截。
      // 这正是"滚动条到底了、面板却不在底部"最可能的机械成因，所以让它自己喊出来。
      if (!pinned) { logScrollState('follow-fell-short'); }
    }
  }

  function showJump() { if (jumpBtn) { jumpBtn.hidden = false; } }
  function hideJump() { if (jumpBtn) { jumpBtn.hidden = true; } }

  /** Scroll to the bottom, but only when the user has not scrolled away. */
  function follow() {
    if (!container || followPending) { return; }
    if (!pinned) {
      // [CUSTOM-20261005-192] 用户在往上翻：**不跟是对的**（不该抢他的视口）。但"面板没到底"
      // 的正当来源就是这里，而本 bug 的嫌疑正是"他其实在底部、我们却判成不在" —— 所以每次
      // append 记一笔（有节流 + 序号，流式期间不会刷屏）。内容是否同时长高也一并记下。
      var now = container.scrollHeight;
      var grew = lastScrollHeight >= 0 && now > lastScrollHeight + 40;
      lastScrollHeight = now;
      logScrollState(grew ? 'grew-unpinned' : 'skip-unpinned');
      return;
    }
    followPending = true;
    NS.dom.schedule(function () {
      followPending = false;
      if (!container) { return; }
      if (!pinned) { logScrollState('unpinned-before-frame'); return; }
      var height = container.scrollHeight;
      lastScrollHeight = height;
      var max = height - container.clientHeight;
      writeTop(height);
      // 写完立刻读回：被夹住（内容还没落地 / max 变了）会在这里显形 —— 这正是"滚动条到底了、
      // 面板却不在底部"最可能的机械成因。读的是刚写过的那个值，不额外触发重排。
      if (container.scrollTop < max - 1) { logScrollState('clamped-short', true); }
    });
  }

  /** Unconditional jump — used when switching sessions or after a replay. */
  function toBottom() {
    if (!container) { return; }
    pinned = true;
    hideJump();
    restoreTarget = null;
    writeTop(container.scrollHeight);
    logScrollState('toBottom', true);
  }

  /**
   * [CUSTOM-20260924-021] Jump to a specific node (conversation outline).
   *
   * pinned = false is set *before* writing scrollTop: the scroll event that
   * follows recomputes it from the real distance to the bottom, so a jump near
   * the end re-pins correctly. Without this, an append landing between the
   * click and the scroll event would yank the viewport back down — the exact
   * "I jumped up and it dragged me back" complaint the outline exists to fix.
   *
   * [CUSTOM-20260928-104] 'clearance' lands the node that many pixels BELOW the scrollport
   * top instead of exactly on it. The pinned-question bar takes a message over as soon as its
   * top reaches that edge, so landing exactly on it would hand the message straight back to
   * the bar and the click would look like it did nothing — the caller passes the bar's own
   * inset. Default 0 keeps every existing caller exact.
   */
  function jumpTo(node, clearance) {
    if (!container || !node) { return; }
    var top = node.offsetTop - container.offsetTop - (clearance || 0);
    if (top < 0) { top = 0; }
    pinned = false;
    showJump();
    writeTop(top);
    onScroll();
    logScrollState('jumpTo', true);
  }

  /** True while the view sticks to the bottom (diagnostics/tests). */
  function isPinned() { return pinned; }



  // [CUSTOM-20260924-022] 位置记忆：连「是否贴底」一起记。
  // 只记 top 的话，一个本来贴底的会话切回来会停在半空；只记 pinned 又会丢掉阅读位置。
  function remember(sessionId) {
    if (!container || !sessionId) { return; }
    offsets[sessionId] = { top: container.scrollTop, pinned: pinned };
    persistSoon();
  }

  function restore(sessionId) {
    if (!container) { return; }
    var saved = sessionId ? offsets[sessionId] : undefined;
    if (saved === undefined) {
      toBottom();
      return;
    }
    if (saved.pinned) {
      toBottom();
      return;
    }
    pinned = false;
    showJump();
    restoreTarget = saved.top;
    writeTop(saved.top);
    expectedTop = container.scrollTop;
    logScrollState('restore:' + saved.top, true);
  }

  /**
   * Re-apply the restored position after content height changed (markdown
   * arriving for a hydrated session grows the transcript and would otherwise
   * leave the viewport somewhere else). No-op once the user has scrolled.
   */
  function reassert() {
    if (!container || restoreTarget === null) { return; }
    writeTop(restoreTarget);
    expectedTop = container.scrollTop;
  }

  function forget(sessionId) {
    if (!sessionId) { return; }
    delete offsets[sessionId];
    persistSoon();
  }

  // 位置记忆落盘（webview 本地 state，跨面板关闭/重开存活）。防抖：切会话时
  // remember 会被连着调用几次，没必要每次都写。
  var persistTimer = null;
  function persistSoon() {
    if (persistTimer) { return; }
    persistTimer = window.setTimeout(function () {
      persistTimer = null;
      if (NS.boot && NS.boot.persistUi) { NS.boot.persistUi({ scroll: offsets }); }
    }, 300);
  }

  NS.scroll = {
    init: init,
    follow: follow,
    toBottom: toBottom,
    jumpTo: jumpTo,
    isPinned: isPinned,
    // [CUSTOM-20261005-192] 几何写入方（输入卡 / 表单抽屉 / 权限抽屉）改完高度后喊一声。
    // 这三个变量都进 #messages 的 padding-bottom，是这个 bug 的第一嫌疑：它们变了而视口判定
    // 没跟着重算，就会表现成"到底了却看不全"（176 修过一次）。同一条诊断、同一个节流。
    noteGeometry: noteGeometry,
    // [CUSTOM-20261003-176] 几何（内容高度 / 底部留白）变化后由写入方调用，见 reflow。
    reflowNow: reflow,
    remember: remember,
    restore: restore,
    reassert: reassert,
    forget: forget
  };
})(window.__acpc = window.__acpc || {});
`;
