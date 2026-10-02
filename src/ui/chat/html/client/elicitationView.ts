// [CUSTOM-BEGIN] CUSTOM-20260929-119 - 表单卡（ACP elicitation / AskUserQuestion）。
// [CUSTOM-20260930-152] 从"记录流里的一张内联卡"改成**悬浮抽屉**（底部、贴在输入卡上方）：
//   内联记录只留一行"待回答"条（点「Open form」把表单调到抽屉里）；表单本体在抽屉里，
//   多道题按 tab 分页，单选是下拉、多选是经典勾选列表，每题都可带一个"追加/自拟"输入框。
//   为什么改：问题多、选项带长介绍时，内联卡会把记录区撑得很长，而且它混在消息里不像
//   "现在需要你操作"（用户 2026-09-30 报的现象）。
//
// 数据仍然全部来自宿主送来的 `ElicitationState`：`fields` 是**已经扁平化**的字段表（宿主的
// ElicitationBridge.fieldsOf 把 ACP 的 JSON Schema 转成可选/多选/布尔/数字/文本五种），
// 所以这里不做任何 schema 解析，只负责画控件、收值、回传。字段的真实形状（来自 adapter
// `askUserQuestionsToCreateRequest`）：每道题 = `question_<n>`（单选 string+oneOf / 多选
// array+anyOf）+ `question_<n>_custom`（自由文本，`_meta` 标记指回该题 ⇒ 宿主标成 customFor）。
// **自拟文本会取代该题所选**（adapter 的 applyAskElicitationResponse 里 custom 优先），
// 所以那个框下面的说明必须写清真实效果，不能只说"追加"。
//
// 四处与权限卡（permissionView）同源的设计：
//   · 全部走 NS.dom.el / textContent —— **禁 innerHTML**（agent 可控字符串）；
//   · 回传走 NS.bridge.postForSession —— 会话作用域，宿主放在 verifySession 守卫之后处理；
//   · 结算后按钮禁用/隐藏，且留一行"结果"说明（比"点了没反应"诚实）；
//   · 半填的草稿只留在 webview 里（DOM 就是表单状态），不进记录。
//
// **不变量（119 立的，不许破）**：记录仍是唯一真相 —— `kind:'elicitation'` 的 transcript 记录
// 承载一切，于是 boot/focus 的全量快照天然把表单带回来，切会话 / 双 surface / 重挂载都不需要
// 新协议或宿主改动。抽屉只是**同一份 state 的另一种呈现**，它自己不存任何真相。
//
// [CUSTOM-20261001-161] 多题时 **Submit 只在最后一题那一页可点**（用户要求防误提交：
// 在第一页就能点，翻页只是"看看后面还有没有"时很容易顺手点掉）。禁用而不是隐藏，且带一句
// title 说明为什么；Skip / Cancel 不受影响（它们是逃生门，任何一页都该能用）。
// `activeTab` 超出新表单的题数时会夹回最后一页 —— 否则会一个 pane 都不显示，而且会让上面那条
// 判据误判成"已经在最后一题"。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 \\**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260929-119
export const elicitationViewClient = `
(function (NS) {
  'use strict';

  /** What the buttons send. 'submit' = accept, 'skip' = decline, 'cancel' = cancel. */
  var ACTION_OF = { submit: 'accept', skip: 'decline', cancel: 'cancel' };

  /** The body-level floating drawer (#elicDrawer). Null in the stub DOM. */
  var drawer = null;
  /** The pending form the drawer is showing right now (promptId). */
  var activeId = null;
  /** Collapsed = the drawer is a single row (the user asked for a '^' toggle). */
  var collapsed = false;
  /**
   * promptId -> true once the user collapses that form. Kept for the whole webview life
   * (not per session switch): a form you deliberately pushed aside must not spring back
   * every time you leave and return to the session.
   */
  var dismissed = {};
  /**
   * promptId -> the built form element. Reused so that switching between forms (or between
   * tabs) never discards half-filled answers — the DOM *is* the form state (119).
   */
  var forms = {};
  /** Index of the visible question inside the active form. */
  var activeTab = 0;
  /** True while an answer is in flight: the actions are disabled and say so. */
  var sending = false;
  /**
   * The session whose transcript is on screen, as boot understands it.
   *
   * The record says WHICH forms are pending; this says WHOSE they are. Filtering on it is a
   * direct check rather than a bet that the transcript was rebuilt on every switch — a form that
   * belongs to another session must not be shown in this one (user report, 2026-10-01).
   */
  var sessionId = null;

  function el(tag, cls, text) { return NS.dom.el(tag, cls, text); }

  function closestAttr(node, attr) {
    for (var n = node; n; n = n.parentNode) {
      if (n.getAttribute && n.getAttribute(attr) !== null && n.getAttribute(attr) !== undefined) { return n; }
    }
    return null;
  }

  function inputsNamed(root, name) {
    // Attribute-only selector, then filter: the stub DOM in src/test/chat-client.test.ts
    // matches '[attr]' but NOT '[attr="value"]' (its selector support is deliberately minimal),
    // and a value selector would silently match nothing there — i.e. the tests would pass
    // against a UI that cannot find its own inputs.
    var all = root.querySelectorAll('input[data-field]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-field') === name) { out.push(all[i]); }
    }
    return out;
  }

  /** The one element carrying this attribute value (attribute-only selector + filter). */
  function findByAttr(root, attr, value) {
    var all = root.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute(attr) === value) { return all[i]; }
    }
    return null;
  }

  // --- Questions -----------------------------------------------------------

  /**
   * Group the flat field list into one entry per QUESTION.
   *
   * A field with 'customFor' belongs to the question it is the custom answer for (the adapter
   * emits them adjacent, but the pairing is by name, not by position). Everything else is its
   * own question — a bare text/number/boolean field from some other agent still gets a tab.
   */
  function groupsOf(state) {
    var fields = state.fields || [];
    var groups = [];
    var byName = {};
    var i;
    for (i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (field.customFor) { continue; }
      var group = { field: field, extras: [] };
      byName[field.name] = group;
      groups.push(group);
    }
    for (i = 0; i < fields.length; i++) {
      var extra = fields[i];
      if (!extra.customFor) { continue; }
      var parent = byName[extra.customFor];
      if (parent) { parent.extras.push(extra); continue; }
      // A custom field whose question is missing: show it on its own rather than dropping it.
      groups.push({ field: extra, extras: [] });
    }
    return groups;
  }

  /** Is this field answered? (Answering is read from the DOM — that is where it lives.) */
  function fieldAnswered(root, field) {
    var inputs = inputsNamed(root, field.name);
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (input.type === 'radio' || input.type === 'checkbox') {
        if (!input.checked) { continue; }
        // The "Other" row carries an empty value: picking it is a gesture, not an answer — what
        // answers the question is the text typed in its box (which counts as its own field).
        if (input.value === '') { continue; }
        return true;
      } else if (String(input.value || '').trim() !== '') {
        return true;
      }
    }
    return false;
  }

  function groupAnswered(root, group) {
    if (fieldAnswered(root, group.field)) { return true; }
    for (var i = 0; i < group.extras.length; i++) {
      if (fieldAnswered(root, group.extras[i])) { return true; }
    }
    return false;
  }

  function answeredCount(root, state) {
    var groups = groupsOf(state);
    var n = 0;
    for (var i = 0; i < groups.length; i++) { if (groupAnswered(root, groups[i])) { n++; } }
    return n;
  }

  /** A one-line gist of the form, for the inline record row and the collapsed drawer. */
  function gistOf(state) {
    var text = String(state.message || '').replace(/\\s+/g, ' ').trim();
    if (text === '') { text = 'Input needed'; }
    return text;
  }

  // --- Controls ------------------------------------------------------------

  /**
   * A single-select field, laid out FLAT (user's 2026-10-01 revision of rule 1): one radio row per
   * option with its title AND description, plus an "Other" row when the question has a custom box.
   * No dropdown — a list is what the official panel shows, and it makes the descriptions readable
   * without a second click.
   *
   * Still a plain radio group under the hood, so 'collect()' (which reads 'input[data-field]')
   * keeps working unchanged and the value that travels back is exactly the same. Sibling radios
   * are unchecked explicitly on pick: a stub DOM has no native radio-group behaviour, so being
   * explicit is what makes both worlds agree.
   */
  function selectRow(field, value, title, description) {
    var row = el('div', 'elic-option-row');
    var label = el('label', 'elic-option');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = field.name;
    radio.value = value;
    radio.setAttribute('data-field', field.name);
    radio.setAttribute('data-kind', 'select');
    radio.addEventListener('change', function () { onPick(field.name, value); });
    // [CUSTOM-20261002-168] 再点一次**已经选中**的那一行 = 取消选择（radio 原生做不到）。
    // 判据用 data-elic-picked（由 onPick 写）：点击时浏览器已经把它设成 checked 了，
    // 靠 checked 自己分不出"刚选中"与"再点一次"。
    radio.addEventListener('click', function () {
      if (radio.checked && radio.getAttribute('data-elic-picked') === '1') { clearPick(field.name); }
    });
    label.appendChild(radio);
    var text = el('span', 'elic-option-text');
    text.appendChild(el('span', 'elic-option-label', title));
    if (description) { text.appendChild(el('span', 'elic-option-desc', description)); }
    label.appendChild(text);
    row.appendChild(label);
    // The custom box is MOVED into the chosen row (see placeCustomBoxes) — inside the row wrapper
    // but OUTSIDE the <label>, or clicking into the box would toggle the radio.
    return row;
  }

  function buildSelect(field, extras) {
    var wrap = el('div', 'elic-select');
    var list = el('div', 'elic-options');
    var options = field.options || [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      list.appendChild(selectRow(field, option.value, option.title, option.description));
    }
    // A free-form answer is a CHOICE here, exactly like the official "Other" row: picking it means
    // "my answer is what I type", and its radio carries the empty value (an answer the adapter
    // drops, since a typed custom answer is what travels back).
    if (extras.length > 0) {
      var other = selectRow(field, '', extras[0].title || 'Other', null);
      other.className = 'elic-option-row elic-other-row';
      list.appendChild(other);
    }
    wrap.appendChild(list);
    // Nothing is required, so a pick must be undoable: a radio cannot be unchecked by clicking it
    // again, and the dropdown that used to offer "Clear selection" is gone.
    var clear = el('button', 'elic-clear', 'Clear answer');
    clear.type = 'button';
    clear.setAttribute('data-elic-clear', field.name);
    clear.hidden = true;
    wrap.appendChild(clear);
    return wrap;
  }

  /** Drop a single-select pick (back to "not answered"). */
  function clearPick(fieldName) {
    var form = activeId ? forms[activeId] : null;
    var state = activeId ? formOf(activeId, pendingForms()) : null;
    if (!form || !state) { return; }
    var inputs = inputsNamed(form, fieldName);
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = false;
      inputs[i].setAttribute('data-elic-picked', '0');
    }
    refresh(form, state);
  }

  /**
   * Put each custom box under the row it belongs to: the SELECTED option of its question (or the
   * "Other" row), and keep it hidden while that question has no pick.
   *
   * Why under the chosen row: the typed text answers THAT choice (the adapter lets it replace the
   * option), so it should read as part of it — and it only shows up once there is something to
   * attach it to (user's rule 2, 2026-10-01).
   */
  function placeCustomBoxes(root, state) {
    var groups = groupsOf(state);
    // [CUSTOM-20261002-168] 多选的每个选项行自带一个补充框：跟着**那一行自己的**勾选态
    // （单选那条在下面 —— 它的框是题目级的，会被移进所选行）。
    var noteBoxes = root.querySelectorAll('.elic-note-box');
    for (var nb = 0; nb < noteBoxes.length; nb++) {
      var owner = noteBoxes[nb].parentNode;
      var own = owner && owner.querySelector ? owner.querySelector('input[data-field]') : null;
      noteBoxes[nb].hidden = !(own && own.checked);
    }
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      if (group.field.kind !== 'select') { continue; }
      var rows = root.querySelectorAll('.elic-option-row');
      for (var e = 0; e < group.extras.length; e++) {
        var box = findByAttr(root, 'data-elic-custom', group.extras[e].name);
        if (!box) { continue; }
        var host = null;
        for (var r = 0; r < rows.length && !host; r++) {
          var input = rows[r].querySelector('input');
          if (input && input.type === 'radio' && input.checked && input.name === group.field.name) {
            host = rows[r];
          }
        }
        if (host) {
          // appendChild MOVES the element: its typed value survives (the DOM is the form state).
          host.appendChild(box);
          box.hidden = false;
        } else {
          // Park it back in its question block (hidden) rather than detaching it: a detached node
          // cannot be found by the next lookup, and its text would drop out of collect() too.
          var home = findByAttr(root, 'data-elic-home', group.field.name);
          if (home) { home.appendChild(box); }
          box.hidden = true;
        }
      }
    }
  }

  /** Pick a single-select value: exclusive by construction, then re-place the custom boxes. */
  function onPick(fieldName, value) {
    var form = activeId ? forms[activeId] : null;
    var state = activeId ? formOf(activeId, pendingForms()) : null;
    if (!form || !state) { return; }
    var inputs = inputsNamed(form, fieldName);
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = inputs[i].value === value;
      // [168] 记住"这一格是当前选中项"，供"再点一次取消"判定。
      inputs[i].setAttribute('data-elic-picked', inputs[i].checked ? '1' : '0');
    }
    refresh(form, state);
  }

  /**
   * [CUSTOM-20261002-168] 每个选项行自带的「补充说明」框（多选；单选那个由题目级的 extra 框
   * 移进所选行）。它**不是** schema 里的字段（用 data-elic-note 而不是 data-field）——内容会被
   * collect() 并进那一项的值里（「选项 — 说明」），所以不单独发送，通用收集循环也看不到它。
   */
  function buildOptionNote(value) {
    var box = el('div', 'elic-custom elic-note-box');
    box.setAttribute('data-elic-note', value);
    box.hidden = true;   // shown once THIS row is picked (placeCustomBoxes)
    var wrap = el('div', 'elic-input-wrap');
    var input = document.createElement('input');
    input.className = 'elic-input';
    input.type = 'text';
    input.placeholder = 'Add a note (optional)';
    input.title = 'Adds to this option.';
    wrap.appendChild(input);
    box.appendChild(wrap);
    return box;
  }

  function optionRow(field, option) {
    // [CUSTOM-20261002-168] 与单选的 selectRow 同形：.elic-option-row > label + 补充框。
    // 包一层是**必须**的 —— 框放 label 里面的话，点进输入框就会顺手勾上/取消这一项。
    var row = el('div', 'elic-option-row');
    var label = el('label', 'elic-option');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.name = field.name;
    box.value = option.value;
    box.setAttribute('data-field', field.name);
    box.setAttribute('data-kind', 'multi');
    label.appendChild(box);
    var text = el('span', 'elic-option-text');
    text.appendChild(el('span', 'elic-option-label', option.title));
    if (option.description) { text.appendChild(el('span', 'elic-option-desc', option.description)); }
    label.appendChild(text);
    if (option.preview) { label.title = option.preview; }
    row.appendChild(label);
    row.appendChild(buildOptionNote(option.value));
    return row;
  }


  function buildMulti(field) {
    var wrap = el('div', 'elic-options');
    var options = field.options || [];
    for (var i = 0; i < options.length; i++) { wrap.appendChild(optionRow(field, options[i])); }
    return wrap;
  }

  function buildBoolean(field) {
    var row = el('label', 'elic-option');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.name = field.name;
    box.setAttribute('data-field', field.name);
    box.setAttribute('data-kind', 'boolean');
    row.appendChild(box);
    var text = el('span', 'elic-option-text');
    text.appendChild(el('span', 'elic-option-label', field.title || 'Yes'));
    row.appendChild(text);
    return row;
  }

  function buildInput(field) {
    var wrap = el('div', 'elic-input-wrap');
    var input = document.createElement('input');
    input.className = 'elic-input';
    input.type = field.kind === 'number' ? 'number' : 'text';
    input.name = field.name;
    input.setAttribute('data-field', field.name);
    input.setAttribute('data-kind', field.kind);
    if (field.customFor) { input.placeholder = 'Type your own answer'; }
    wrap.appendChild(input);
    return wrap;
  }

  /** The custom-answer box of one question, with the line that says what it really does. */
  function buildCustomBox(extra, compact) {
    var box = el('div', 'elic-custom');
    box.setAttribute('data-elic-custom', extra.name);
    box.hidden = true;   // shown by placeCustomBoxes once its question has a pick
    // [CUSTOM-20261002-168] 语义改成**追加**：collect() 会把「选项 + 说明」合成**一个**答案发出，
    // 而且**不再单独发**这个 custom 字段 —— adapter 那边 custom 优先并 return（有它就丢掉所选项），
    // 单独发就等于替换。所以那条「替换上面所选」的说明行没有了（旧语义遗留，用户报「描述不对」），
    // 说明只留在输入框的 tooltip 里（用户要求：不单占一行）。
    var wrap = buildInput(extra);
    var input = wrap.querySelector('input');
    if (input) {
      input.placeholder = compact ? 'Notes or other answer\\u2026' : 'Type your own answer';
      input.title = 'Adds to what you picked above.';
    }
    box.appendChild(wrap);
    return box;
  }

  /** The block for one question: the question text, its control, and its custom box. */
  function buildGroup(group, index) {
    var wrap = el('div', 'elic-field');
    wrap.setAttribute('data-elic-group', String(index));
    var field = group.field;
    if (field.title) { wrap.appendChild(el('div', 'elic-label', field.title)); }
    if (field.description) { wrap.appendChild(el('div', 'elic-help', field.description)); }
    var extras = group.extras;
    if (field.kind === 'select') {
      // Flat radio list (rule 1 as revised on 2026-10-01). The custom boxes start here and are
      // MOVED under the picked row by placeCustomBoxes (hidden until there is a pick) — keeping
      // them in the DOM is what preserves whatever the user has typed.
      var select = buildSelect(field, extras);
      // Where a box waits while its question has no pick (see placeCustomBoxes).
      select.setAttribute('data-elic-home', field.name);
      for (var e = 0; e < extras.length; e++) { select.appendChild(buildCustomBox(extras[e], true)); }
      wrap.appendChild(select);
    } else {
      if (field.kind === 'multi') { wrap.appendChild(buildMulti(field)); }
      else if (field.kind === 'boolean') { wrap.appendChild(buildBoolean(field)); }
      else { wrap.appendChild(buildInput(field)); }
      // Anything that is not a select keeps its custom box underneath, in full (label + hint).
      for (var i = 0; i < extras.length; i++) { wrap.appendChild(buildCustomBox(extras[i], false)); }
    }
    wrap.appendChild(el('div', 'elic-unanswered', 'Not answered \\u00b7 it will not be part of the answer'));
    return wrap;
  }

  // --- The form (shared by the drawer) -------------------------------------

  function buildForm(state) {
    var form = el('div', 'elic-form');
    var groups = groupsOf(state);
    // [CUSTOM-20261002-168] 诊断：表单里到底有几项带说明。153 那次"选项说明丢了"两边都证明过
    // 客户端是好的，于是留下的下一步就是这一行 —— 真机再看时，日志会直接给出答案
    // （'~/.claude/acp-client-custom.log' 里搜 "form fields"）。
    // [CUSTOM-20261002-168] 诊断：表单里到底有几项带说明。153 那次'选项说明丢了'两边都证明过
    // 客户端是好的，留下的下一步就是这一行 —— 真机再看时日志会直接给出答案
    // （'~/.claude/acp-client-custom.log' 里搜 form fields）。console.warn 会被日志桥转发。
    var optTotal = 0, optWithDesc = 0;
    for (var d = 0; d < groups.length; d++) {
      var opts = groups[d].field.options || [];
      for (var oi = 0; oi < opts.length; oi++) {
        optTotal++;
        if (opts[oi].description) { optWithDesc++; }
      }
    }
    console.warn('[acpc] form fields: ' + groups.length + ' question(s), ' + optTotal +
      ' option(s), ' + optWithDesc + ' with description');
    // [CUSTOM-20261001-154] 标题行没了（用户要求）：tab 栏、进度与收起按钮合成一条 bar，
    // 进度与箭头**靠右**对齐。收起来时 tab 条隐藏、只留当前题的名字 + 进度 + 箭头。
    var bar = el('div', 'elic-bar');
    var tabs = el('div', 'elic-tabs');
    var panes = el('div', 'elic-panes');
    var firstTitle = '';
    for (var i = 0; i < groups.length; i++) {
      var title = groups[i].field.title || ('Question ' + (i + 1));
      if (i === 0) { firstTitle = title; }
      var tab = el('button', 'elic-tab');
      tab.type = 'button';
      tab.setAttribute('data-elic-tab', String(i));
      tab.appendChild(el('span', 'elic-tab-dot'));
      tab.appendChild(el('span', 'elic-tab-text', title));
      tabs.appendChild(tab);
      panes.appendChild(buildGroup(groups[i], i));
    }
    bar.appendChild(el('span', 'elic-collapsed-title', firstTitle));
    bar.appendChild(tabs);
    bar.appendChild(el('span', 'elic-progress', ''));
    var toggle = el('button', 'elic-toggle');
    toggle.type = 'button';
    toggle.setAttribute('data-elic-toggle', '1');
    bar.appendChild(toggle);
    form.appendChild(bar);
    form.appendChild(panes);
    form.appendChild(el('div', 'elic-actions'));
    return form;
  }

  function actionsOf(form) { return form.querySelector('.elic-actions'); }

  /**
   * Update everything that is NOT an input: tab dots, per-question "not answered" hints, where the
   * custom box goes, the progress line and the Submit label. Never rebuilds inputs — that would
   * wipe what the user has typed (and move the caret).
   */
  function refreshChrome(form, state) {
    var groups = groupsOf(state);
    // [CUSTOM-20261001-161] A form with fewer tabs than the previous one must not leave the
    // drawer pointing at a tab that no longer exists — that hides every pane AND would fool
    // the "is this the last question" check below.
    if (activeTab >= groups.length) { activeTab = Math.max(0, groups.length - 1); }
    var answered = 0;
    var panes = form.querySelectorAll('.elic-field');
    var tabs = form.querySelectorAll('.elic-tab');
    for (var i = 0; i < groups.length; i++) {
      var isAnswered = groupAnswered(form, groups[i]);
      if (isAnswered) { answered += 1; }
      if (tabs[i]) {
        tabs[i].className = 'elic-tab' + (isAnswered ? ' answered' : '') + (i === activeTab ? ' active' : '');
        tabs[i].setAttribute('aria-selected', i === activeTab ? 'true' : 'false');
      }
      if (panes[i]) {
        panes[i].hidden = i !== activeTab;
        var hint = panes[i].querySelector('.elic-unanswered');
        if (hint) { hint.hidden = isAnswered; }
      }
    }
    var total = groups.length;
    var progress = form.querySelector('.elic-progress');
    if (progress) { progress.textContent = 'Answered ' + answered + '/' + total; }
    var collapsedTitle = form.querySelector('.elic-collapsed-title');
    if (collapsedTitle && groups[activeTab]) {
      collapsedTitle.textContent = groups[activeTab].field.title || ('Question ' + (activeTab + 1));
    }
    // The "Clear answer" link belongs to a select that HAS a pick.
    var clears = form.querySelectorAll('.elic-clear');
    for (var c = 0; c < clears.length; c++) {
      var clearName = clears[c].getAttribute('data-elic-clear');
      var clearField = null;
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].field.name === clearName) { clearField = groups[g].field; }
      }
      clears[c].hidden = !clearField || !fieldAnswered(form, clearField);
    }
    var submit = form.querySelector('.elic-submit');
    if (submit) {
      submit.textContent = 'Submit ' + answered + '/' + total;
      // [CUSTOM-20261001-161] 多题时 Submit **只在最后一题那一页**可点（用户要求：在
      // 第一页就能点，容易误提交）。禁用而不是隐藏 —— 看得见的禁用按钮会说明"还差一步"，
      // 藏起来只会让人以为这个表单没有提交按钮。'sending' 也要算进去：否则提交后一次
      // input/change 触发的 refresh 会把它重新点亮，又变回两条回答路径。
      var isLastTab = total <= 1 || activeTab >= total - 1;
      submit.disabled = sending || !isLastTab;
      submit.title = isLastTab ? '' : 'Go to the last question to submit';
    }
    // The custom box follows the pick — after the counts, so a move never fights the tally.
    placeCustomBoxes(form, state);
  }

  function refresh(form, state) {
    refreshChrome(form, state);
  }

  // --- The drawer ----------------------------------------------------------

  function buildDrawer(state) {
    if (!drawer) { return; }
    drawer.setAttribute('data-elic-id', state.promptId || '');
    drawer.setAttribute('data-elic-root', state.promptId || '');
    // The same guard the inline card uses: only a PENDING form may be answered (a settled one
    // has no buttons, but the status is what makes that a rule rather than a coincidence).
    drawer.setAttribute('data-elic-status', 'pending');
    NS.dom.clear(drawer);
    // [CUSTOM-20261001-154] 没有标题行：tab、进度与收起按钮都在表单自己的 bar 上（用户要求）。
    var form = forms[state.promptId];
    if (!form) {
      form = buildForm(state);
      forms[state.promptId] = form;
    }
    // The action bar is rebuilt each time and lives at the bottom of the form, so the progress
    // line and the collapse toggle stay put while the form scrolls.
    var actions = actionsOf(form);
    if (actions) {
      NS.dom.clear(actions);
      var submit = el('button', 'elic-btn primary elic-submit', 'Submit');
      submit.type = 'button';
      submit.setAttribute('data-elic-action', 'submit');
      submit.setAttribute('data-elic-id', state.promptId || '');
      var skip = el('button', 'elic-btn', 'Skip');
      skip.type = 'button';
      skip.setAttribute('data-elic-action', 'skip');
      skip.setAttribute('data-elic-id', state.promptId || '');
      skip.title = 'Skip this request (the turn continues)';
      var cancel = el('button', 'elic-btn', 'Cancel');
      cancel.type = 'button';
      cancel.setAttribute('data-elic-action', 'cancel');
      cancel.setAttribute('data-elic-id', state.promptId || '');
      cancel.title = 'Cancel the request (the tool call is aborted)';
      actions.appendChild(submit);
      actions.appendChild(skip);
      actions.appendChild(cancel);
    }
    drawer.appendChild(form);
    drawer.appendChild(el('div', 'elic-note'));
    sending = false;
    applyCollapsed();
    refresh(form, state);
    applyDrawerHeight();
  }

  function applyCollapsed() {
    if (!drawer) { return; }
    drawer.className = 'elic-drawer' + (collapsed ? ' collapsed' : '');
    var toggle = drawer.querySelector('.elic-toggle');
    if (toggle) {
      NS.dom.clear(toggle);
      toggle.appendChild(el('span', 'elic-toggle-glyph', collapsed ? '\\u25b4' : '\\u25be'));
      toggle.title = collapsed ? 'Expand' : 'Collapse';
      toggle.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    }
    if (drawer.hidden) { return; }
    applyDrawerHeight();
  }

  function show(state) {
    if (!drawer) { return; }
    drawer.hidden = false;
    buildDrawer(state);
  }

  function hide() {
    if (!drawer) { return; }
    drawer.hidden = true;
    drawer.className = 'elic-drawer';
    NS.dom.clear(drawer);
    applyDrawerHeight();
  }

  /** Pending forms in the record, in order. The DOM holds only the focused session's records,
   *  so this list is already session-scoped (no sessionId needed here). */
  function pendingForms() {
    var out = [];
    // No focused session = nothing to answer here (a draft page, the empty state, a closed
    // session). This is the direct half of the guard: 'setSession(null)' is what boot pushes on
    // every path that clears the transcript.
    if (!sessionId) { return out; }
    if (!NS.transcriptView || !NS.transcriptView.ordered || !NS.transcriptView.entry) { return out; }
    var ids = NS.transcriptView.ordered() || [];
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (!entry || entry.kind !== 'elicitation') { continue; }
      var state = entry.elicitation || {};
      if (state.status !== 'pending' || !state.promptId) { continue; }
      // A form for another session is not ours to show — even if it is somehow still in this
      // transcript. (Returns to it when you switch back: the record is what remembers.)
      if (state.sessionId && state.sessionId !== sessionId) { continue; }
      out.push(state);
    }
    return out;
  }

  function formOf(promptId, list) {
    for (var i = 0; i < list.length; i++) { if (list[i].promptId === promptId) { return list[i]; } }
    return null;
  }

  /**
   * Reconcile the drawer with the record. Called by boot after boot/focus and after any
   * append/revise that carried an elicitation, so the drawer tracks the truth without the
   * host having to know a drawer exists.
   */
  function sync() {
    if (!drawer) { return; }
    var pending = pendingForms();
    if (pending.length === 0) { activeId = null; hide(); return; }
    var active = formOf(activeId, pending);
    if (!active) {
      // Pick the first form the user has not pushed aside. All of them dismissed => stay
      // hidden; their inline rows are the way back in.
      for (var i = 0; i < pending.length; i++) {
        if (!dismissed[pending[i].promptId]) { active = pending[i]; break; }
      }
    }
    if (!active) { activeId = null; hide(); return; }
    var sameForm = activeId === active.promptId && !drawer.hidden;
    // [CUSTOM-20261001-166] 换了一张表单就**从展开态开始**：collapsed 是「那张被收起的表单」
    // 的属性，而「哪张表单被推开了」另有记录（dismissed，按 promptId）。把布尔留在模块级，
    // 会让别的会话/别的表单一冒出来就是收起的 —— 用户从没对它按下过那个按钮。
    if (!sameForm) { collapsed = false; }
    activeId = active.promptId;
    if (sameForm) { refresh(forms[activeId], active); return; }
    show(active);
  }

  /** Open a specific pending form (the inline row's button, or the collapsed drawer). */
  function open(promptId) {
    if (!drawer) { return; }
    var pending = pendingForms();
    var state = formOf(promptId, pending);
    if (!state) { return; }
    delete dismissed[promptId];
    activeId = promptId;
    collapsed = false;
    show(state);
    // An explicit open is a user action, so it MAY take the caret (an automatic one must not).
    var first = drawer.querySelector('.elic-input, .elic-select-btn, .elic-option input');
    if (first && first.focus) { first.focus(); }
  }

  function setCollapsed(value) {
    collapsed = value === true;
    if (collapsed && activeId) { dismissed[activeId] = true; }
    if (collapsed && activeId === null) { hide(); return; }
    applyCollapsed();
    if (activeId) { refresh(forms[activeId], formOf(activeId, pendingForms()) || {}); }
  }

  function selectTab(index) {
    activeTab = index;
    var state = drawer ? formOf(activeId, pendingForms()) : null;
    if (state) { refresh(forms[activeId], state); }
  }

  // --- Answers -------------------------------------------------------------

  /**
   * The input of the note box inside one option row (null when absent).
   *
   * 分开返回**元素**而不只是文本：collect() 要把它标成"已消费"，而那必须是**同一个节点**
   * （桩 DOM 的 matches 不支持后代选择器 ''.elic-custom input''，靠选择器再查一次会静默拿到 null ——
   * 真机没这问题，测试里却会让"已消费"永远为空）。
   */
  function noteInputInRow(row) {
    if (!row || !row.querySelector) { return null; }
    var box = row.querySelector('.elic-custom');
    return box && box.querySelector ? box.querySelector('input') : null;
  }

  /** The typed note inside one option row, trimmed ('' when empty or absent). */
  function noteInRow(row) {
    var input = noteInputInRow(row);
    return input ? String(input.value || '').trim() : '';
  }

  /** The label shown on an option row ('' when absent). */
  function labelInRow(row) {
    var node = row && row.querySelector ? row.querySelector('.elic-option-label') : null;
    return node ? String(node.textContent || '').trim() : '';
  }

  /**
   * [CUSTOM-20261002-168] Read the form's values.
   *
   * 与上一版的差别（用户 2026-10-02 的四条要求）：
   *   · **追加而不是替换**：某选项的补充框里写了字 ⇒ 答案是「选项 \\u2014 说明」这**一个**字符串，
   *     那个 custom 字段**不再单独发送** —— adapter 那边 custom 优先并 return，单独发就等于替换；
   *   · 多选的**每个选项**都能带自己的补充框（同上，各自并进自己那一项）；
   *   · "Other" 行（空值）的答案就是框里的文本；多选的题级 Other 框作为**追加项**并进数组。
   */
  function collect(root, state) {
    var out = {};
    var consumed = [];   // 已经并进选项值的输入框：通用循环不能再发一次
    var groups = state ? groupsOf(state) : [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var kind = group.field.kind;
      if (kind !== 'select' && kind !== 'multi') { continue; }
      var picks = [];
      var inputs = inputsNamed(root, group.field.name);
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        if (!input.checked) { continue; }
        var row = input.closest ? (input.closest('.elic-option-row') || input.closest('.elic-option')) : null;
        var note = noteInRow(row);
        if (note) {
          var boxInput = noteInputInRow(row);
          if (boxInput) { consumed.push(boxInput); }
        }
        if (input.value === '') { if (note) { picks.push(note); } continue; }   // "Other" 行
        picks.push(note ? ((labelInRow(row) || input.value) + ' \\u2014 ' + note) : input.value);
      }
      if (kind === 'multi') {
        var extra = null;
        for (var e = 0; e < group.extras.length && !extra; e++) {
          var box = findByAttr(root, 'data-elic-custom', group.extras[e].name);
          var boxIn = box && box.querySelector ? box.querySelector('input') : null;
          var text = boxIn ? String(boxIn.value || '').trim() : '';
          if (text) { extra = { text: text, input: boxIn }; }
        }
        if (extra && picks.length > 0) { picks.push(extra.text); consumed.push(extra.input); }
        if (picks.length > 0) { out[group.field.name] = picks; }
        continue;
      }
      if (picks.length > 0) { out[group.field.name] = picks[0]; }
    }
    var rest = root.querySelectorAll('input[data-field]');
    for (var r = 0; r < rest.length; r++) {
      var el2 = rest[r];
      if (consumed.indexOf(el2) >= 0) { continue; }
      var kind2 = el2.getAttribute('data-kind');
      if (kind2 === 'select' || kind2 === 'multi') { continue; }   // 上面已处理
      var name2 = el2.getAttribute('data-field');
      if (kind2 === 'boolean') {
        if (el2.checked && out[name2] === undefined) { out[name2] = true; }
        continue;
      }
      if (out[name2] !== undefined) { continue; }   // 别覆盖已合并的答案
      var text2 = String(el2.value || '').trim();
      if (text2 === '') { continue; }
      out[name2] = kind2 === 'number' ? Number(text2) : text2;
    }
    return out;
  }

  function noteText(status, summary) {
    if (status === 'sent') { return 'Sending\\u2026'; }
    if (status === 'deferred') { return 'Waiting for an answer in the dialog\\u2026'; }
    if (status === 'accepted') { return summary ? 'Answered \\u00b7 ' + summary : 'Answered'; }
    if (status === 'declined') { return 'Skipped'; }
    if (status === 'cancelled') { return 'Cancelled'; }
    return '';
  }

  /**
   * Send one of the three outcomes. Called by the delegated click handler in links.ts
   * (which is also where the permission card's buttons are wired) with the form root —
   * the inline record card OR the drawer.
   */
  function answer(root, action) {
    if (!root || sending) { return; }
    var promptId = root.getAttribute('data-elic-id');
    if (!promptId) { return; }
    // Only a PENDING form may be answered: a settled one is history, and a deferred one belongs
    // to the VS Code dialog (its buttons would race the open QuickPick).
    if (root.getAttribute('data-elic-status') !== 'pending') { return; }
    var outgoingKind = ACTION_OF[action];
    if (!outgoingKind) { return; }
    var message = {
      type: 'elicitationAnswer',
      promptId: promptId,
      action: outgoingKind
    };
    // 'accept' carries the answers; the other two are decisions, not data.
    // [CUSTOM-20261002-168] 带上 state：合并"选项 + 说明"要知道每个选项属于哪道题。
    if (outgoingKind === 'accept') {
      message.content = collect(root, activeId ? formOf(activeId, pendingForms()) : null);
    }
    // A second click before the host answers would send a duplicate — the bridge is idempotent,
    // but the UI should not look like nothing happened either.
    sending = true;
    var actions = root.querySelector ? root.querySelector('.elic-actions') : null;
    if (actions) {
      var buttons = actions.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = true; }
    }
    var note = root.querySelector ? root.querySelector('.elic-note') : null;
    if (note) { note.textContent = noteText('sent'); }
    NS.bridge.postForSession(message);
  }

  // --- Inline record -------------------------------------------------------

  /**
   * The record node for one elicitation entry.
   *
   * Pending: a single compact row — the form itself lives in the drawer, and a full card here
   * would push the conversation around for something that is not part of it (user report).
   * Settled/deferred: the read-only card (what was asked + what came of it), which is history.
   */
  function render(state) {
    var card = el('div', 'elic');
    fill(card, state);
    return card;
  }

  function fill(card, state) {
    var status = state.status || 'pending';
    card.className = 'elic ' + status;
    card.setAttribute('data-elic-id', state.promptId || '');
    card.setAttribute('data-elic-root', state.promptId || '');
    card.setAttribute('data-elic-status', status);
    NS.dom.clear(card);
    if (status === 'pending') {
      var row = el('div', 'elic-pending-row');
      row.appendChild(el('span', 'elic-pending-icon', '\\u23f3'));
      row.appendChild(el('span', 'elic-pending-text', gistOf(state)));
      var openBtn = el('button', 'elic-open', 'Open form');
      openBtn.type = 'button';
      openBtn.setAttribute('data-elic-open', state.promptId || '');
      row.appendChild(openBtn);
      card.appendChild(row);
      card.appendChild(el('div', 'elic-note'));
      return;
    }
    card.appendChild(el('div', 'elic-title', state.message || 'Input needed'));
    var body = el('div', 'elic-body');
    var fields = state.fields || [];
    for (var i = 0; i < fields.length; i++) { body.appendChild(readOnlyField(fields[i])); }
    card.appendChild(body);
    card.appendChild(el('div', 'elic-note', noteText(status, state.summary)));
  }

  /** A settled form, rendered as a record: the question, the options it offered, the note. */
  function readOnlyField(field) {
    var wrap = el('div', 'elic-field' + (field.customFor ? ' elic-other' : ''));
    if (field.title) { wrap.appendChild(el('div', 'elic-label', field.title)); }
    if (field.description) { wrap.appendChild(el('div', 'elic-help', field.description)); }
    var options = field.options || [];
    if (options.length > 0) {
      var list = el('div', 'elic-options');
      for (var i = 0; i < options.length; i++) {
        var row = el('div', 'elic-option static');
        var text = el('span', 'elic-option-text');
        text.appendChild(el('span', 'elic-option-label', options[i].title));
        if (options[i].description) {
          text.appendChild(el('span', 'elic-option-desc', options[i].description));
        }
        row.appendChild(text);
        list.appendChild(row);
      }
      wrap.appendChild(list);
      return wrap;
    }
    if (field.kind !== 'boolean') { wrap.appendChild(el('div', 'elic-help', '\\u2014')); }
    return wrap;
  }

  /** Reflect the state the host sent (same contract as permissionView.applyState). */
  function applyState(card, state) {
    if (!card) { return; }
    var was = card.getAttribute('data-elic-status');
    var samePending = was === 'pending' && (state.status || 'pending') === 'pending'
      && card.getAttribute('data-elic-id') === (state.promptId || '');
    // A pending form that is already on screen is NOT rebuilt: the DOM holds the user's
    // half-filled answers, and a snapshot/revise for the same prompt would wipe them (119).
    if (samePending) { return; }
    fill(card, state);
  }

  // --- Wiring --------------------------------------------------------------

  function onDrawerClick(event) {
    var target = event.target;
    var tab = closestAttr(target, 'data-elic-tab');
    if (tab) { selectTab(Number(tab.getAttribute('data-elic-tab'))); return; }
    var toggle = closestAttr(target, 'data-elic-toggle');
    if (toggle) { setCollapsed(!collapsed); return; }
    var clear = closestAttr(target, 'data-elic-clear');
    if (clear) { clearPick(clear.getAttribute('data-elic-clear')); return; }
  }

  /**
   * Any input inside the form changed: re-count. Without this the tab dots, the "not answered"
   * hints and the Submit progress would only move for the controls that go through a handler of
   * their own (the single-select radios) and stay stale for every checkbox / text field.
   */
  function onDrawerChange() {
    var state = activeId ? formOf(activeId, pendingForms()) : null;
    if (state && forms[activeId]) { refresh(forms[activeId], state); }
  }

  function onDocumentClick(event) {
    var openBtn = closestAttr(event.target, 'data-elic-open');
    if (openBtn) { open(openBtn.getAttribute('data-elic-open')); }
  }

  function onDocumentKeyDown(event) {
    if (event.key !== 'Escape') { return; }
    // Escape COLLAPSES the drawer; it must never cancel. 'Cancel' aborts the agent's tool call,
    // and that is not something a stray keypress may do.
    if (drawer && !drawer.hidden && !collapsed) { setCollapsed(true); }
  }

  /**
   * The floating drawer is a layer, so the message area has to make room for it — measured,
   * never inferred from "what could change its height" (pitfall #27).
   *
   * The observer covers content-driven growth; the callers below ALSO poke it whenever THEY
   * change the drawer (hidden ⇄ shown, expanded ⇄ collapsed), because a ResizeObserver callback
   * is delivered at the end of a frame and is not guaranteed to run in every host (headless
   * previews, for one) — leaving '--acpc-elic-h' at its old value would let the drawer cover the
   * last record.
   */
  function applyDrawerHeight() {
    if (!drawer || !document.body || !document.body.style || !document.body.style.setProperty) { return; }
    document.body.style.setProperty('--acpc-elic-h', drawer.hidden ? '0px' : drawer.offsetHeight + 'px');
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

  function init() {
    // Idempotent: boot wires this once, but the preview harness and any future second caller
    // must not end up with two sets of listeners on the same element.
    var found = NS.dom.qs('elicDrawer');
    if (!found || drawer) { return; }
    drawer = found;
    drawer.addEventListener('click', onDrawerClick);
    drawer.addEventListener('change', onDrawerChange);
    drawer.addEventListener('input', onDrawerChange);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onDocumentKeyDown);
    watchHeight();
  }

  /** Tell the drawer which session is on screen (boot calls this on every focus change). */
  function setSession(id) {
    sessionId = id || null;
  }

  NS.elicitationView = {
    init: init,
    setSession: setSession,
    render: render,
    applyState: applyState,
    answer: answer,
    sync: sync,
    open: open,
    setCollapsed: setCollapsed,
    selectTab: selectTab,
    groupsOf: groupsOf,
    collect: collect
  };
})(window.__acpc = window.__acpc || {});
`;
