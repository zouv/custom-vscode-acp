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

  function init(messagesEl, jumpButton) {
    container = messagesEl;
    jumpBtn = jumpButton;
    container.addEventListener('scroll', onScroll);
    jumpBtn.addEventListener('click', function () {
      pinned = true;
      hideJump();
      container.scrollTop = container.scrollHeight;
    });
  }

  function onScroll() {
    if (!container) { return; }
    var distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinned = distance < PIN_THRESHOLD;
    if (pinned) { hideJump(); } else { showJump(); }
  }

  function showJump() { if (jumpBtn) { jumpBtn.hidden = false; } }
  function hideJump() { if (jumpBtn) { jumpBtn.hidden = true; } }

  /** Scroll to the bottom, but only when the user has not scrolled away. */
  function follow() {
    if (!container || !pinned) { return; }
    container.scrollTop = container.scrollHeight;
  }

  /** Unconditional jump — used when switching sessions or after a replay. */
  function toBottom() {
    if (!container) { return; }
    pinned = true;
    hideJump();
    container.scrollTop = container.scrollHeight;
  }

  function remember(sessionId) {
    if (!container || !sessionId) { return; }
    offsets[sessionId] = container.scrollTop;
  }

  function restore(sessionId) {
    if (!container) { return; }
    var saved = sessionId ? offsets[sessionId] : undefined;
    if (saved === undefined) {
      toBottom();
      return;
    }
    container.scrollTop = saved;
    onScroll();
  }

  NS.scroll = {
    init: init,
    follow: follow,
    toBottom: toBottom,
    remember: remember,
    restore: restore
  };
})(window.__acpc = window.__acpc || {});
`;
