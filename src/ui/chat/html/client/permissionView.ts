// [CUSTOM-BEGIN] CUSTOM-20260924-020 - 面板内权限卡：新增客户端模块。
// 替代窗口级 QuickPick：卡片落在它所属工具卡之后，两个 surface 同时可见。
//
// 安全：标题与选项名都是 **agent 可控字符串**（`toolCall.title` / `option.name`），
// 因此本模块一律走 `NS.dom.el(tag, cls, text)`（textContent），**禁止 innerHTML**。
//
// 状态语义：
//   pending  按钮可点，这是唯一能回答的入口
//   deferred 已退回到弹框（面板不可见 / 被关闭）——按钮**禁用**，避免与弹框抢答
//   selected 已选定（按钮换成结果行）
//   cancelled 已取消（轮次被取消 / 会话关闭 / 弹框被关掉）
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260924-020
export const permissionViewClient = `
(function (NS) {
  'use strict';

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

  /** Build the card for a permission state. */
  function render(state) {
    var card = NS.dom.el('div', 'perm');
    card.setAttribute('data-perm-id', state.promptId);

    var head = NS.dom.el('div', 'perm-head');
    head.appendChild(NS.dom.el('span', 'perm-badge', '?'));
    head.appendChild(NS.dom.el('span', 'perm-title', state.title || 'Permission Request'));
    if (state.kind) { head.appendChild(NS.dom.el('span', 'perm-kind', state.kind)); }
    card.appendChild(head);

    var actions = NS.dom.el('div', 'perm-actions');
    var options = state.options || [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var btn = NS.dom.el('button', 'perm-btn ' + (isAllow(option.kind) ? 'allow' : 'reject'), optionLabel(option));
      // Both attributes on the button: the delegated handler resolves the
      // closest node carrying each one, and the button carries both.
      btn.setAttribute('data-perm-id', state.promptId);
      btn.setAttribute('data-perm-option', option.optionId);
      actions.appendChild(btn);
    }
    card.appendChild(actions);

    var note = NS.dom.el('div', 'perm-note');
    card.appendChild(note);
    applyState(card, state);
    return card;
  }

  /** Reflect status on an existing card (used on create and on every revise). */
  function applyState(card, state) {
    var settled = state.status === 'selected' || state.status === 'cancelled';
    var actions = card.querySelector('.perm-actions');
    if (actions) { actions.hidden = settled; }
    var buttons = card.querySelectorAll('.perm-btn');
    for (var i = 0; i < buttons.length; i++) {
      // Deferred prompts are answered in the dialog; a live button here would be
      // a second answer path for one request.
      buttons[i].disabled = state.status !== 'pending';
    }
    card.className = 'perm ' + state.status;
    var note = card.querySelector('.perm-note');
    if (note) {
      var text = noteText(state);
      note.textContent = text;
      note.hidden = text.length === 0;
    }
  }

  NS.permissionView = {
    render: render,
    applyState: applyState
  };
})(window.__acpc = window.__acpc || {});
`;
