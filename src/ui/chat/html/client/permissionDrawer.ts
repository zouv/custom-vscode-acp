// [CUSTOM-BEGIN] CUSTOM-20261001-158 - 权限请求的悬浮抽屉：新增客户端模块。
//
// 用户要求（原话："询问权限的弹框…需改为跟选项弹框类似，在输入框上面弹出"）：权限的作答界面
// 从记录区内联的卡片搬到**输入框上方的浮层**，形状照抄表单抽屉（CUSTOM-20260930-152 的
// #elicDrawer）——两者都是"agent 被挂住、等你点一下"的东西，理应长成同一个样子。
//
// 与表单抽屉**逐条同构**的三条：
//   · 记录区只留一行（⏳ + 标题 + Review 按钮），本体进浮层；
//   · 显示是**记录驱动**的（`sync()` 从转录算 pending，按聚焦会话过滤），宿主不需要知道有抽屉；
//   · 高度写在 CSS 变量上让消息区让位（`--acpc-perm-h`，避免盖住最后一条记录）。
//
// 三处**刻意不同**：
//   · 不 import vscode（客户端本来就不），也**没有** collapsed/dismissed：权限请求是阻塞的，
//     收起它没有意义；记录行上的 Review 是唯一的"主动打开"入口。
//   · 作答的发送与"发送中"守卫**不在本模块**，而在 `permissionView.answer()` —— 按钮在两个
//     宿主（抽屉与只读卡）里都存在，两处各自发送就是两份知识（pitfall #19）。
//   · 两个抽屉可以**同时**存在（同一会话先来表单又来权限）：各自高度变量相加，
//     权限抽屉贴在表单抽屉上面（见 styles.ts 的 .perm-drawer）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20261001-158
export const permissionDrawerClient = `
(function (NS) {
  'use strict';

  var drawer = null;
  var activeId = null;
  var sessionId = null;

  function el(tag, cls, text) { return NS.dom.el(tag, cls, text); }

  function closestAttr(node, attr) {
    var cur = node;
    while (cur && cur.getAttribute) {
      if (cur.getAttribute(attr) !== null) { return cur; }
      cur = cur.parentNode;
    }
    return null;
  }

  /**
   * Pending permission prompts in the record, in order. The DOM holds only the focused
   * session's records, so this list is already session-scoped — the explicit sessionId
   * check below is the belt to that suspenders (a record for another session must never
   * be answered from here).
   */
  function pendingPrompts() {
    var out = [];
    if (!sessionId) { return out; }
    if (!NS.transcriptView || !NS.transcriptView.ordered || !NS.transcriptView.entry) { return out; }
    var ids = NS.transcriptView.ordered() || [];
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (!entry || entry.kind !== 'permission') { continue; }
      var state = entry.permission || {};
      if (state.status !== 'pending' || !state.promptId) { continue; }
      if (state.sessionId && state.sessionId !== sessionId) { continue; }
      out.push(state);
    }
    return out;
  }

  function promptOf(promptId, list) {
    for (var i = 0; i < list.length; i++) { if (list[i].promptId === promptId) { return list[i]; } }
    return null;
  }

  function build(state) {
    NS.dom.clear(drawer);
    drawer.className = 'perm-drawer';
    drawer.setAttribute('data-perm-id', state.promptId || '');
    drawer.setAttribute('data-perm-status', 'pending');
    var card = el('div', 'perm-drawer-card');
    // Head and buttons come from permissionView so the drawer and the read-only card
    // can never disagree about the labels (or about the send guard's disabled state).
    card.appendChild(NS.permissionView.buildHead(state));
    card.appendChild(NS.permissionView.buildActions(state));
    card.appendChild(el('div', 'perm-drawer-hint', 'This blocks the agent until you answer.'));
    drawer.appendChild(card);
  }

  function show(state) {
    if (!drawer) { return; }
    drawer.hidden = false;
    build(state);
    applyDrawerHeight();
  }

  function hide() {
    if (!drawer) { return; }
    drawer.hidden = true;
    drawer.className = 'perm-drawer';
    NS.dom.clear(drawer);
    applyDrawerHeight();
  }

  /**
   * Reconcile the drawer with the record. Called by boot after boot/focus and after any
   * append/revise that carried a permission — the drawer tracks the truth without the
   * host having to know a drawer exists.
   */
  function sync() {
    if (!drawer) { return; }
    var pending = pendingPrompts();
    if (pending.length === 0) { activeId = null; hide(); return; }
    // Keep showing the one the user opened if it is still pending; otherwise the first.
    var active = promptOf(activeId, pending) || pending[0];
    activeId = active.promptId;
    // Rebuilt unconditionally: a permission prompt has no half-filled state (a click
    // sends), and the disabled buttons survive a rebuild via permissionView.isSending.
    show(active);
  }

  /** Open the prompt the record row's Review button points at. */
  function open(promptId) {
    if (!drawer) { return; }
    var state = promptOf(promptId, pendingPrompts());
    if (!state) { return; }
    activeId = promptId;
    show(state);
    // An explicit open is a user action, so it MAY take the caret.
    var first = drawer.querySelector('.perm-btn');
    if (first && first.focus) { first.focus(); }
  }

  /**
   * The floating drawer is a layer, so the message area has to make room for it —
   * measured, never inferred (pitfall #27), and poked explicitly by the callers because
   * a ResizeObserver callback is delivered at the end of a frame and is not guaranteed
   * to run in every host.
   */
  function applyDrawerHeight() {
    if (!drawer || !document.body || !document.body.style || !document.body.style.setProperty) { return; }
    var height = drawer.hidden ? 0 : drawer.offsetHeight;
    document.body.style.setProperty('--acpc-perm-h', height + 'px');
    // [CUSTOM-20261005-192] 高度变了就进滚动诊断（与表单抽屉、输入卡同一条链）。
    if (NS.scroll && NS.scroll.noteGeometry) { NS.scroll.noteGeometry('perm', height); }
    // [CUSTOM-20261003-176] 同表单抽屉：留白变了要重算视口判定（见 scroll.ts 的 reflow）。
    if (NS.scroll && NS.scroll.reflowNow) { NS.scroll.reflowNow(); }
  }

  function watchHeight() {
    if (!drawer || !document.body || !document.body.style || !document.body.style.setProperty) { return; }
    applyDrawerHeight();
    if (typeof window.ResizeObserver === 'function') {
      var observer = new window.ResizeObserver(applyDrawerHeight);
      observer.observe(drawer);
    } else {
      window.addEventListener('resize', applyDrawerHeight);
    }
  }

  function onDocumentClick(event) {
    var openBtn = closestAttr(event.target, 'data-perm-open');
    if (openBtn) { open(openBtn.getAttribute('data-perm-open')); }
  }

  function init() {
    // Idempotent (same reason as elicitationView.init): boot wires this once, but the
    // preview harness and any future second caller must not double-register.
    var found = NS.dom.qs('permDrawer');
    if (!found || drawer) { return; }
    drawer = found;
    document.addEventListener('click', onDocumentClick);
    watchHeight();
  }

  /** Tell the drawer which session is on screen (boot calls this on every focus change). */
  function setSession(id) { sessionId = id || null; }

  NS.permissionDrawer = {
    init: init,
    setSession: setSession,
    sync: sync,
    open: open,
    hide: hide
  };
})(window.__acpc = window.__acpc || {});
`;
