// [CUSTOM-BEGIN] CUSTOM-20260929-119 - 表单卡（ACP elicitation / AskUserQuestion）。
//
// 它渲染宿主送来的 `ElicitationState`：`fields` 是**已经扁平化**的字段表（宿主的
// ElicitationBridge.fieldsOf 把 ACP 的 JSON Schema 转成可选/多选/布尔/数字/文本五种），
// 所以这里不做任何 schema 解析，只负责画控件、收值、回传。
//
// 三处与权限卡（permissionView）同源的设计：
//   · 全部走 NS.dom.el / textContent —— **禁 innerHTML**（agent 可控字符串）；
//   · 回传走 NS.bridge.postForSession —— 会话作用域，宿主放在 verifySession 守卫之后处理；
//   · 结算后按钮禁用/隐藏，且卡上留一行"结果"说明（比"点了没反应"诚实）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 \\**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260929-119
export const elicitationViewClient = `
(function (NS) {
  'use strict';

  /** What the buttons send. 'submit' = accept, 'skip' = decline, 'cancel' = cancel. */
  var ACTION_OF = { submit: 'accept', skip: 'decline', cancel: 'cancel' };

  function button(cls, label, action, promptId) {
    var btn = NS.dom.el('button', cls, label);
    btn.type = 'button';
    btn.setAttribute('data-elic-action', action);
    btn.setAttribute('data-elic-id', promptId || '');
    return btn;
  }

  function group(field) {
    var wrap = NS.dom.el('div', 'elic-field' + (field.customFor ? ' elic-other' : ''));
    // The question text. For a single-question AskUserQuestion the adapter carries the
    // question in 'message' and the field has only a short 'title' (the header), so
    // neither alone is enough: show the title when present and the description under it.
    if (field.title) { wrap.appendChild(NS.dom.el('div', 'elic-label', field.title)); }
    if (field.description) { wrap.appendChild(NS.dom.el('div', 'elic-help', field.description)); }
    return wrap;
  }

  function optionRow(field, option, type) {
    var row = NS.dom.el('label', 'elic-option');
    var input = document.createElement('input');
    input.type = type;
    input.name = field.name;
    input.value = option.value;
    input.setAttribute('data-field', field.name);
    input.setAttribute('data-kind', field.kind);
    row.appendChild(input);
    row.appendChild(NS.dom.el('span', 'elic-option-label', option.title));
    if (option.description) { row.appendChild(NS.dom.el('span', 'elic-option-desc', option.description)); }
    // The SDK's option 'preview' has no structural slot in ACP, so the adapter forwards
    // it under its own _meta key; the host passes it through and we surface it on hover.
    if (option.preview) { row.title = option.preview; }
    return row;
  }

  function renderField(field) {
    var wrap = group(field);
    var options = field.options || [];
    if (field.kind === 'select') {
      for (var i = 0; i < options.length; i++) { wrap.appendChild(optionRow(field, options[i], 'radio')); }
      return wrap;
    }
    if (field.kind === 'multi') {
      for (var j = 0; j < options.length; j++) { wrap.appendChild(optionRow(field, options[j], 'checkbox')); }
      return wrap;
    }
    if (field.kind === 'boolean') {
      var row = NS.dom.el('label', 'elic-option');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.name = field.name;
      box.setAttribute('data-field', field.name);
      box.setAttribute('data-kind', 'boolean');
      row.appendChild(box);
      row.appendChild(NS.dom.el('span', 'elic-option-label', field.title || 'Yes'));
      wrap.appendChild(row);
      return wrap;
    }
    var input = document.createElement('input');
    input.className = 'elic-input';
    input.type = field.kind === 'number' ? 'number' : 'text';
    input.name = field.name;
    input.setAttribute('data-field', field.name);
    input.setAttribute('data-kind', field.kind);
    input.setAttribute('data-elic-input', '1');
    if (field.customFor) { input.placeholder = 'Type your own answer'; }
    wrap.appendChild(input);
    return wrap;
  }

  /** Build the card for one form request. */
  function render(state) {
    var el = NS.dom.el;
    var card = el('div', 'elic');
    card.setAttribute('data-elic-id', state.promptId || '');
    card.appendChild(el('div', 'elic-title', state.message || 'Input needed'));
    var body = el('div', 'elic-body');
    var fields = state.fields || [];
    for (var i = 0; i < fields.length; i++) { body.appendChild(renderField(fields[i])); }
    card.appendChild(body);
    var actions = el('div', 'elic-actions');
    actions.appendChild(button('elic-btn primary', 'Submit', 'submit', state.promptId));
    actions.appendChild(button('elic-btn', 'Skip', 'skip', state.promptId));
    actions.appendChild(button('elic-btn', 'Cancel', 'cancel', state.promptId));
    card.appendChild(actions);
    card.appendChild(el('div', 'elic-note'));
    applyState(card, state);
    return card;
  }

  /** Read the form's current values back out of the DOM (the DOM is the form's state). */
  function collect(card) {
    var out = {};
    var inputs = card.querySelectorAll('input[data-field]');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var name = input.getAttribute('data-field');
      var kind = input.getAttribute('data-kind');
      if (kind === 'select' || kind === 'multi' || kind === 'boolean') {
        if (!input.checked) { continue; }
        if (kind === 'multi') {
          if (!out[name]) { out[name] = []; }
          out[name].push(input.value);
        } else if (kind === 'boolean') {
          out[name] = true;
        } else {
          out[name] = input.value;
        }
        continue;
      }
      var text = String(input.value || '').trim();
      if (text === '') { continue; }
      out[name] = kind === 'number' ? Number(text) : text;
    }
    return out;
  }

  /**
   * Send one of the three outcomes. Called by the delegated click handler in links.ts
   * (which is also where the permission card's buttons are wired).
   */
  function answer(card, action) {
    if (!card) { return; }
    var promptId = card.getAttribute('data-elic-id');
    if (!promptId) { return; }
    var outgoingKind = ACTION_OF[action];
    if (!outgoingKind) { return; }
    var message = {
      type: 'elicitationAnswer',
      promptId: promptId,
      action: outgoingKind
    };
    // 'accept' carries the answers; the other two are decisions, not data.
    if (outgoingKind === 'accept') { message.content = collect(card); }
    NS.bridge.postForSession(message);
  }

  function noteText(status, summary) {
    if (status === 'deferred') { return 'Waiting for an answer in the dialog\\u2026'; }
    if (status === 'accepted') { return summary ? 'Answered \\u00b7 ' + summary : 'Answered'; }
    if (status === 'declined') { return 'Skipped'; }
    if (status === 'cancelled') { return 'Cancelled'; }
    return '';
  }

  /** Reflect the state the host sent (same contract as permissionView.applyState). */
  function applyState(card, state) {
    if (!card) { return; }
    var status = state.status || 'pending';
    card.className = 'elic ' + status;
    var actions = card.querySelector('.elic-actions');
    var note = card.querySelector('.elic-note');
    // Only a PENDING card may be answered. A deferred one belongs to the dialog (its
    // buttons would race the open QuickPick), a settled one is history.
    if (actions) { actions.hidden = status !== 'pending'; }
    var inputs = card.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) { inputs[i].disabled = status !== 'pending'; }
    if (note) { note.textContent = noteText(status, state.summary); }
  }

  NS.elicitationView = { render: render, applyState: applyState, answer: answer };
})(window.__acpc = window.__acpc || {});
`;
