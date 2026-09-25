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
    container.addEventListener('scroll', onScroll);
    jumpBtn.addEventListener('click', function () {
      pinned = true;
      hideJump();
      restoreTarget = null;
      container.scrollTop = container.scrollHeight;
    });
    // [CUSTOM-20260924-022] 位置记忆跨面板开关存活（每个文档各存各的：
    // 侧边栏与编辑区的视口本来就不一样，共用一份反而会互相干扰）。
    if (NS.boot && NS.boot.recallUi) {
      var ui = NS.boot.recallUi();
      if (ui && ui.scroll) { offsets = ui.scroll; }
    }
  }

  function onScroll() {
    if (!container) { return; }
    var distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinned = distance < PIN_THRESHOLD;
    if (pinned) { hideJump(); } else { showJump(); }
    // 用户接管了视口：放弃待恢复的位置，不要跟他抢。
    if (restoreTarget !== null && Math.abs(container.scrollTop - expectedTop) > 2) {
      restoreTarget = null;
    }
  }

  function showJump() { if (jumpBtn) { jumpBtn.hidden = false; } }
  function hideJump() { if (jumpBtn) { jumpBtn.hidden = true; } }

  /** Scroll to the bottom, but only when the user has not scrolled away. */
  function follow() {
    if (!container || !pinned || followPending) { return; }
    followPending = true;
    NS.dom.schedule(function () {
      followPending = false;
      if (!container || !pinned) { return; }
      container.scrollTop = container.scrollHeight;
    });
  }

  /** Unconditional jump — used when switching sessions or after a replay. */
  function toBottom() {
    if (!container) { return; }
    pinned = true;
    hideJump();
    restoreTarget = null;
    container.scrollTop = container.scrollHeight;
  }

  /**
   * [CUSTOM-20260924-021] Jump to a specific node (conversation outline).
   *
   * pinned = false is set *before* writing scrollTop: the scroll event that
   * follows recomputes it from the real distance to the bottom, so a jump near
   * the end re-pins correctly. Without this, an append landing between the
   * click and the scroll event would yank the viewport back down — the exact
   * "I jumped up and it dragged me back" complaint the outline exists to fix.
   */
  function jumpTo(node) {
    if (!container || !node) { return; }
    var top = node.offsetTop - container.offsetTop;
    pinned = false;
    showJump();
    container.scrollTop = top;
    onScroll();
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
    container.scrollTop = saved.top;
    expectedTop = container.scrollTop;
  }

  /**
   * Re-apply the restored position after content height changed (markdown
   * arriving for a hydrated session grows the transcript and would otherwise
   * leave the viewport somewhere else). No-op once the user has scrolled.
   */
  function reassert() {
    if (!container || restoreTarget === null) { return; }
    container.scrollTop = restoreTarget;
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
    remember: remember,
    restore: restore,
    reassert: reassert,
    forget: forget
  };
})(window.__acpc = window.__acpc || {});
`;
