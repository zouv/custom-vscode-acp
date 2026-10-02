// [CUSTOM-BEGIN] CUSTOM-20260924-020 - 面板内权限卡：新增客户端模块。
// 替代窗口级 QuickPick：卡片落在它所属工具卡之后，两个 surface 同时可见。
//
// 安全：标题与选项名都是 **agent 可控字符串**（`toolCall.title` / `option.name`），
// 因此本模块一律走 `NS.dom.el(tag, cls, text)`（textContent），**禁止 innerHTML**。
//
// 状态语义：
//   pending  记录区只留一行（⏳ + 标题 + Review），作答的按钮在悬浮抽屉里（CUSTOM-20261001-158）
//   deferred 已退回到弹框（面板不可见 / 被关闭）——按钮**禁用**，避免与弹框抢答
//   selected 已选定（只读卡 + 结果行）
//   cancelled 已取消（轮次被取消 / 会话关闭 / 弹框被关掉）
//
// [CUSTOM-20261001-158] **两处宿主，一份回答路径**：作答按钮既在悬浮抽屉（.perm-drawer，主入口）
// 也在只读卡上（.perm，历史形态）——发送与"发送中"守卫都收在本模块的 `answer()` 里，
// 与表单（152）逐条同构；`links.ts` 只负责把按钮解析到宿主再转进来。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260924-020
export const permissionViewClient = `
(function (NS) {
  'use strict';

  // [CUSTOM-20261001-158] 发送中守卫（原先只有表单有，权限卡点两下会发两条 —— 桥虽然幂等，
  // 但界面看起来像没反应）。sentFor 记着是哪条 prompt 在发，抽屉重建时据此保持禁用。
  var sending = false;
  var sentFor = null;

  function isAllow(kind) {
    return String(kind || '').indexOf('allow') === 0;
  }

  function optionLabel(option) {
    return (isAllow(option.kind) ? '\\u2713 ' : '\\u2715 ') + (option.name || '');
  }

  function noteText(state) {
    if (state.status === 'deferred') { return 'Waiting for an answer in the dialog\\u2026'; }
    if (state.status === 'cancelled') { return 'Cancelled'; }
    if (state.status === 'selected') {
      var chosen = null;
      var options = state.options || [];
      for (var i = 0; i < options.length; i++) {
        if (options[i].optionId === state.selectedOptionId) { chosen = options[i]; }
      }
      return (chosen && isAllow(chosen.kind) ? 'Allowed: ' : 'Rejected: ') + (chosen ? chosen.name : '');
    }
    return '';
  }

  /** The buttons that answer this prompt, wherever they are (drawer and/or record card). */
  function buttonsOf(promptId) {
    var out = [];
    if (!document.querySelectorAll) { return out; }
    var all = document.querySelectorAll('[data-perm-option]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-perm-id') === promptId) { out.push(all[i]); }
    }
    return out;
  }

  function setButtonsDisabled(promptId, disabled) {
    var buttons = buttonsOf(promptId);
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = disabled; }
  }

  /** The option buttons for one prompt (used by both hosts). */
  function buildActions(state) {
    var actions = NS.dom.el('div', 'perm-actions');
    var options = state.options || [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var btn = NS.dom.el('button', 'perm-btn ' + (isAllow(option.kind) ? 'allow' : 'reject'), optionLabel(option));
      btn.type = 'button';
      // Both attributes on the button: the delegated handler resolves the host by
      // walking up to '.perm' / '.perm-drawer', and this module sends the answer.
      btn.setAttribute('data-perm-id', state.promptId);
      btn.setAttribute('data-perm-option', option.optionId);
      if (sending && sentFor === state.promptId) { btn.disabled = true; }
      actions.appendChild(btn);
    }
    return actions;
  }

  /** The head line: badge + what is being asked + the tool kind. */
  function buildHead(state) {
    var head = NS.dom.el('div', 'perm-head');
    head.appendChild(NS.dom.el('span', 'perm-badge', '?'));
    head.appendChild(NS.dom.el('span', 'perm-title', state.title || 'Permission Request'));
    if (state.kind) { head.appendChild(NS.dom.el('span', 'perm-kind', state.kind)); }
    return head;
  }

  /**
   * Build the record node for a permission state.
   *
   * Pending: a single compact row — the answering buttons live in the floating drawer
   * above the composer, and a full card here would push the conversation around for
   * something that is not part of it (same rule the form card got in 152).
   * Settled/deferred: the read-only card (what was asked + what came of it) — history.
   */
  function render(state) {
    var card = NS.dom.el('div', 'perm');
    fill(card, state);
    return card;
  }

  function fill(card, state) {
    var status = state.status || 'pending';
    card.className = 'perm ' + status;
    card.setAttribute('data-perm-id', state.promptId || '');
    card.setAttribute('data-perm-status', status);
    NS.dom.clear(card);
    if (status === 'pending') {
      var row = NS.dom.el('div', 'perm-pending-row');
      row.appendChild(NS.dom.el('span', 'perm-pending-icon', '\\u23f3'));
      row.appendChild(NS.dom.el('span', 'perm-pending-text', state.title || 'Permission Request'));
      var openBtn = NS.dom.el('button', 'perm-open', 'Review');
      openBtn.type = 'button';
      openBtn.setAttribute('data-perm-open', state.promptId || '');
      row.appendChild(openBtn);
      card.appendChild(row);
      card.appendChild(NS.dom.el('div', 'perm-note'));
      return;
    }
    card.appendChild(buildHead(state));
    card.appendChild(NS.dom.el('div', 'perm-note', noteText(state)));
  }

  /** Reflect status on an existing card (used on create and on every revise). */
  function applyState(card, state) {
    if (!card) { return; }
    var status = state.status || 'pending';
    if (card.getAttribute('data-perm-status') === 'pending' && status === 'pending') {
      // Same pending prompt: nothing to rebuild (and the buttons, wherever they are,
      // must keep the state the send guard gave them).
      return;
    }
    // [CUSTOM-20261001-158] The shape CHANGES across status (row ⇄ card), so this is a
    // rebuild rather than a patch — unlike the form card there is no half-filled state
    // to preserve: a click sends immediately.
    if (sending && sentFor === state.promptId && status !== 'pending') {
      sending = false;
      sentFor = null;
    }
    fill(card, state);
  }

  /**
   * [CUSTOM-20261001-158] Send one answer. The ONE place a permission is answered from
   * the panel — the record row's Review button only opens the drawer, never answers.
   */
  function answer(host, promptId, optionId) {
    if (!promptId || !optionId || sending) { return; }
    // Only a PENDING prompt may be answered: a settled one is history, and a deferred
    // one belongs to the VS Code dialog (a second answer path would race it).
    if (host && host.getAttribute && host.getAttribute('data-perm-status') !== 'pending') { return; }
    sending = true;
    sentFor = promptId;
    setButtonsDisabled(promptId, true);
    NS.bridge.postForSession({ type: 'permissionAnswer', promptId: promptId, optionId: optionId });
  }

  NS.permissionView = {
    render: render,
    applyState: applyState,
    answer: answer,
    buildActions: buildActions,
    buildHead: buildHead,
    isSending: function (promptId) { return sending && sentFor === promptId; }
  };
})(window.__acpc = window.__acpc || {});
`;
