// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 输入区：发送/停止、斜杠命令补全、配置选择器（ACP Session Config Options）、附件 chips。
//
// 与旧面板的差异：
//   · 附件真正可用（旧面板的 file-attached 消息在 webview 侧**没有消费者**，端到端是死的）
//   · 斜杠命令展示 input.hint（旧面板完全忽略 `input`）
//   · 配置选择器支持 `type: 'boolean'`（旧面板只认 select）
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const composerClient = `
(function (NS) {
  'use strict';

  var input = null;
  var sendBtn = null;
  var slashPopup = null;
  var attachmentsEl = null;
  var pickersEl = null;
  var contextMeter = null;
  // [CUSTOM-20260930-129] The last usage we were given. The ring's "a turn is running"
  // outer arc is driven by setRunning, and that path never sees 'meta' — so the numbers
  // are kept here and redrawn from them.
  var lastUsage = null;
  // [CUSTOM-20260928-096] 图片附件的缩略图（id → dataUrl）。客户端本地缓存、随 reload 丢，
  // 纯展示用——宿主内存仍持有全图供发送，丢了这个只是 chip 缩略图回退成图标。
  var imageThumbs = {};

  var state = {
    sessionId: null,
    agentName: null,
    running: false,
    loading: false,
    commands: [],
    configOptions: [],
    attachments: [],
    slashIndex: 0,
    slashMatches: [],
    // [CUSTOM-20260925-058] Draft mode: a new session that does not exist yet.
    // '{ draftId, cwd }' while the panel is on a draft, else null. The two modes
    // are mutually exclusive — 'setFocus' clears this and 'setDraft' clears
    // 'sessionId' — because 'send()' branches on it.
    draft: null,
    /** A create-then-send is in flight; blocks a second send. */
    draftPending: false
  };

  // [CUSTOM-20260925-050] Per-session drafts. Switching sessions used to clear
  // the textarea outright, so checking another tab lost whatever you had typed.
  // Persisted through the same webview-local state as the scroll memory.
  // [CUSTOM-20260927-085] …and per-DRAFT: a draft has no sessionId, which is exactly
  // how its text went missing (see ownerKey).
  var drafts = {};
  var draftTimer = null;
  // [CUSTOM-20260930-151] 当前聚焦草稿上用户已选的配置项（configId → value 字符串）。
  // 权威副本在 draft 对象上（见 setDraft）；这里只是"此刻那一个"的引用。
  var selections = {};

  /**
   * Who owns what is in the textarea right now: the focused draft, or the focused
   * session. A DRAFT HAS NO sessionId — keying the store by sessionId alone meant
   * 'stashDraft' silently did nothing while a draft was focused, so leaving a draft
   * discarded the typed text, and entering another draft showed the previous one's
   * text (nothing restored it either).
   */
  function ownerKey() {
    return state.draft ? state.draft.draftId : state.sessionId;
  }

  function stashDraft() {
    var key = ownerKey();
    if (key) { drafts[key] = input.value; }
  }

  function persistDraftsSoon() {
    if (draftTimer) { return; }
    draftTimer = window.setTimeout(function () {
      draftTimer = null;
      if (NS.boot && NS.boot.persistUi) { NS.boot.persistUi({ drafts: drafts }); }
    }, 300);
  }

  function restoreDraft(sessionId) {
    var text = sessionId ? drafts[sessionId] : undefined;
    input.value = text === undefined ? '' : text;
    autoGrow();
  }

  /** Drop a closed session's draft (hygiene: ids are never reused). */
  function forgetDraft(sessionId) {
    if (!sessionId || drafts[sessionId] === undefined) { return; }
    delete drafts[sessionId];
    persistDraftsSoon();
  }

  function init() {
    input = NS.dom.qs('promptInput');
    sendBtn = NS.dom.qs('sendStopBtn');
    slashPopup = NS.dom.qs('slashPopup');
    attachmentsEl = NS.dom.qs('attachments');
    pickersEl = NS.dom.qs('configPickers');
    contextMeter = NS.dom.qs('contextMeter');

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('input', function () {
      stashDraft();
      persistDraftsSoon();
      updateSlashPopup();
    });
    // [CUSTOM-20260925-050] Restore the per-session drafts (same webview-local
    // state the scroll memory uses; each document keeps its own copy).
    if (NS.boot && NS.boot.recallUi) {
      var ui = NS.boot.recallUi();
      if (ui && ui.drafts) { drafts = ui.drafts; }
    }
    sendBtn.addEventListener('click', function () {
      if (state.running) { cancel(); } else { send(); }
    });
    document.addEventListener('click', function (event) {
      if (!pickersEl.contains(event.target)) { closeMenus(); }
    });
    // [CUSTOM-20260930-140] 底栏浮起来了，消息区要靠这个高度才知道该留多少底部空间。
    watchHeight();
  }

  function target() {
    return { sessionId: state.sessionId };
  }

  function canCompose() {
    // [CUSTOM-20260925-058] A draft has no sessionId yet but is perfectly
    // composable — its first message is what creates the session.
    return (!!state.sessionId || !!state.draft) && !state.loading;
  }

  // [CUSTOM-20260928-096] Send/Stop 图标化：文字换成内联 SVG，语义保留在 title/aria-label。
  function setSendIcon(running) {
    NS.dom.clear(sendBtn);
    sendBtn.appendChild(NS.icons.icon(running ? 'stop' : 'send', 'send-icon'));
    sendBtn.title = running ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', running ? 'Stop' : 'Send');
  }

  function refreshControls() {
    var enabled = canCompose();
    input.disabled = !enabled;
    sendBtn.disabled = !enabled && !state.running;
    sendBtn.className = 'send-stop ' + (state.running ? 'stop' : 'send');
    if (state.draftPending) {
      // A create-then-send is in flight: the button must not accept a second one.
      sendBtn.disabled = true;
      setSendIcon(false);
      input.placeholder = 'Creating this session\\u2026';
      return;
    }
    setSendIcon(state.running);
    // [CUSTOM-20260930-151] Pickers are inert while the create-then-send is in flight: the
    // message already carries the choices, so a change now would only desync the label.
    var pickerButtons = pickersEl.querySelectorAll('.picker-btn');
    for (var i = 0; i < pickerButtons.length; i++) { pickerButtons[i].disabled = state.draftPending; }
    if (state.draft) {
      // Say why the tab says "New session": the first message is what creates it. The slash
      // list is mentioned when the host could give us one (the agent's last session's commands).
      input.placeholder = state.commands.length > 0
        ? 'Your first message creates this session, or / for commands\\u2026'
        : 'Your first message creates this session\\u2026';
      return;
    }
    if (state.commands.length > 0) {
      input.placeholder = 'Type a message, or / for commands\\u2026';
    } else {
      input.placeholder = 'Type a message\\u2026';
    }
  }

  function send() {
    // Never send while a turn is running: the extension rejects the second
    // prompt, and clearing the textarea first would lose the user's draft.
    if (state.running) { return; }
    var text = input.value;
    // [CUSTOM-20260928-096] 有附件（图片/文件）时允许空文字发送；纯文字则要求非空。
    if ((!text || text.trim().length === 0) && state.attachments.length === 0) { return; }

    if (state.draft) {
      // [CUSTOM-20260925-058] A draft has no session yet, so the host creates it
      // and THEN sends ('createDraftAndSend').
      //
      // **The textarea is deliberately NOT cleared here.** Creating the session
      // can fail (the agent will not start, the directory is gone), and in that
      // case both the draft tab and the typed text must survive. Clearing
      // happens on 'draftResolved'; on 'draftFailed' the text stays put.
      if (state.draftPending) { return; }
      state.draftPending = true;
      NS.bridge.post({
        type: 'createDraftAndSend',
        draftId: state.draft.draftId,
        cwd: state.draft.cwd || undefined,
        text: text,
        // [CUSTOM-20260930-151] The mode/model picked on this page travels with the message
        // that creates the session (there is nothing to configure until it exists).
        // Read at SEND time, not at press time: a failed attempt keeps the draft, and the
        // retry must carry the selection as it is then, not as it was.
        configSelections: draftSelections()
      });
      refreshControls();
      return;
    }

    if (!state.sessionId) { return; }
    NS.bridge.post({ type: 'sendPrompt', sessionId: state.sessionId, text: text });
    input.value = '';
    // [CUSTOM-20260925-050] The draft is consumed by sending it.
    stashDraft();
    persistDraftsSoon();
    hideSlash();
    autoGrow();
  }

  function cancel() {
    if (!state.sessionId) { return; }
    NS.bridge.post({ type: 'cancelTurn', sessionId: state.sessionId });
  }

  function onKeyDown(event) {
    if (slashPopup && !slashPopup.hidden) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveSlash(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveSlash(-1); return; }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        acceptSlash();
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); hideSlash(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (state.running) { cancel(); } else { send(); }
      return;
    }
    if (event.key === 'Escape' && state.running) {
      event.preventDefault();
      cancel();
    }
  }

  /** Grow the textarea with its content, between sane bounds. */
  function autoGrow() {
    input.style.height = 'auto';
    // [CUSTOM-20260930-139] 下限从 60px 放开：默认就占**一行**，随内容长高。
    // 空内容 / JS 未跑时的保底高度交给 CSS 的 min-height（.prompt-input）；
    // 上限仍是 320，而"面板再高也不许超过屏幕 38%"那条由 CSS 的 max-height 夹 ——
    // 两者同时存在时浏览器取小的那个，所以这里不需要知道视口有多高。
    var next = Math.min(320, input.scrollHeight);
    input.style.height = next + 'px';
  }

  /**
   * [CUSTOM-20260930-140] 把底栏**此刻的高度**写给 CSS（--acpc-composer-h）。
   *
   * 底栏是绝对定位、浮在消息之上的（styles.ts 的 .composer），占位得靠留白补回来：
   * #messages 的 padding-bottom 与 #jumpToLatest 的 bottom 都用这个变量。高度随输入框在
   * 1 行与多行之间变化，所以只能量 —— 用 ResizeObserver 观察底栏本身，而不是去列"哪些事件
   * 会改变它的高度"（pitfall #27：那种清单必然落后）。
   */
  function watchHeight() {
    var composerEl = NS.dom.qs('composer');
    // 桩 DOM（src/test/chat-client.test.ts）没有 #composer，它的 body.style 也没有
    // setProperty ⇒ 判空跳过，别让这条新代码把客户端逻辑测试打红。
    if (!composerEl || !document.body || !document.body.style || !document.body.style.setProperty) { return; }
    function apply() {
      document.body.style.setProperty('--acpc-composer-h', composerEl.offsetHeight + 'px');
    }
    apply();
    if (typeof window.ResizeObserver === 'function') {
      var observer = new window.ResizeObserver(apply);
      observer.observe(composerEl);
    } else {
      // 与 rail.ts 的 onResize 同一个态度：没有 ResizeObserver 时说一声，而不是静默错位。
      window.addEventListener('resize', apply);
      console.warn('[acpc] ResizeObserver unavailable: the composer will not make room when it grows');
    }
  }

  // --- Slash commands ------------------------------------------------------

  function currentQuery() {
    var value = input.value;
    if (value.length === 0 || value.charAt(0) !== '/') { return null; }
    if (value.indexOf(' ') !== -1) { return null; }
    return value.slice(1).toLowerCase();
  }

  function updateSlashPopup() {
    autoGrow();
    var query = currentQuery();
    if (query === null || state.commands.length === 0) { hideSlash(); return; }

    var matches = [];
    for (var i = 0; i < state.commands.length; i++) {
      var cmd = state.commands[i];
      if (query.length === 0 || String(cmd.name).toLowerCase().indexOf(query) === 0) {
        matches.push(cmd);
      }
    }
    if (matches.length === 0) { hideSlash(); return; }

    state.slashMatches = matches;
    if (state.slashIndex >= matches.length) { state.slashIndex = 0; }
    renderSlash();
  }

  function renderSlash() {
    NS.dom.clear(slashPopup);
    for (var i = 0; i < state.slashMatches.length; i++) {
      var cmd = state.slashMatches[i];
      // [CUSTOM-20260925-047] A real <button>: the popup was mouse-only before.
      var item = NS.dom.el('button', 'slash-item' + (i === state.slashIndex ? ' active' : ''));
      item.type = 'button';
      item.appendChild(NS.dom.el('span', 'slash-name', '/' + cmd.name));
      var desc = cmd.description || cmd.inputHint || '';
      if (desc) { item.appendChild(NS.dom.el('span', 'slash-desc', desc)); }
      bindSlashItem(item, i);
      slashPopup.appendChild(item);
    }
    slashPopup.hidden = false;
  }

  function bindSlashItem(item, index) {
    item.addEventListener('mouseenter', function () {
      state.slashIndex = index;
      renderSlash();
    });
    item.addEventListener('click', function (event) {
      event.preventDefault();
      state.slashIndex = index;
      acceptSlash();
    });
  }

  function moveSlash(delta) {
    var count = state.slashMatches.length;
    if (count === 0) { return; }
    state.slashIndex = (state.slashIndex + delta + count) % count;
    renderSlash();
  }

  function acceptSlash() {
    var cmd = state.slashMatches[state.slashIndex];
    if (!cmd) { hideSlash(); return; }
    input.value = '/' + cmd.name + ' ';
    hideSlash();
    input.focus();
    autoGrow();
  }

  function hideSlash() {
    slashPopup.hidden = true;
    state.slashMatches = [];
    state.slashIndex = 0;
  }

  // --- Config pickers ------------------------------------------------------

  function closeMenus() {
    var menus = pickersEl.querySelectorAll('.picker-menu');
    for (var i = 0; i < menus.length; i++) { menus[i].className = 'picker-menu'; }
  }

  function optionLabel(option) {
    var value = option.currentValue;
    if (option.type === 'boolean') { return value ? 'On' : 'Off'; }
    var options = option.options || [];
    for (var i = 0; i < options.length; i++) {
      var entry = options[i];
      if (entry && entry.options) {
        for (var j = 0; j < entry.options.length; j++) {
          if (entry.options[j].value === value) { return entry.options[j].name; }
        }
      } else if (entry && entry.value === value) {
        return entry.name;
      }
    }
    return String(value);
  }

  function iconFor(category) {
    if (category === 'mode') { return '\\u26a1'; }
    if (category === 'model') { return '\\u25c8'; }
    if (category === 'thought_level') { return '\\u22ef'; }
    return '\\u2699';
  }

  function renderPickers() {
    NS.dom.clear(pickersEl);
    var options = state.configOptions || [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      if (option.type !== 'select' && option.type !== 'boolean') { continue; }
      pickersEl.appendChild(buildPicker(option));
    }
  }

  function buildPicker(option) {
    var wrap = NS.dom.el('div', 'picker');
    var btn = NS.dom.el('button', 'picker-btn');
    btn.type = 'button';
    // [CUSTOM-20260930-151] 草稿页的选择器不是"现有会话的设置"，而是"这条消息将要创建的那个
    // 会话的选择"——不说清楚，按钮上显示的值（来自该 agent 上一次会话）会被当成新会话已有的值。
    var hint = option.description || option.name || option.id;
    btn.title = state.draft ? 'For the session this message creates: ' + hint : hint;
    btn.appendChild(NS.dom.el('span', 'picker-icon', iconFor(option.category)));
    btn.appendChild(NS.dom.el('span', 'picker-label', optionLabel(option)));
    wrap.appendChild(btn);

    var menu = NS.dom.el('div', 'picker-menu');
    wrap.appendChild(menu);

    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      var wasOpen = menu.className.indexOf('open') !== -1;
      closeMenus();
      if (!wasOpen) {
        menu.className = 'picker-menu open';
        renderMenu(menu, option);
      }
    });
    return wrap;
  }

  function renderMenu(menu, option) {
    NS.dom.clear(menu);
    if (option.type === 'boolean') {
      menu.appendChild(menuItem(menu, option, option.currentValue ? false : true, option.currentValue ? 'Off' : 'On'));
      return;
    }
    var options = option.options || [];
    for (var i = 0; i < options.length; i++) {
      var entry = options[i];
      if (entry && entry.options) {
        menu.appendChild(NS.dom.el('div', 'picker-group', entry.name || ''));
        for (var j = 0; j < entry.options.length; j++) {
          menu.appendChild(menuItem(menu, option, entry.options[j].value, entry.options[j].name));
        }
      } else if (entry) {
        menu.appendChild(menuItem(menu, option, entry.value, entry.name));
      }
    }
  }

  function menuItem(menu, option, value, label) {
    // [CUSTOM-20260925-047] A real <button> — the config menus were mouse-only.
    var item = NS.dom.el('button', 'picker-item' + (String(option.currentValue) === String(value) ? ' active' : ''), label);
    item.type = 'button';
    item.setAttribute('aria-pressed', String(option.currentValue) === String(value) ? 'true' : 'false');
    item.addEventListener('click', function (event) {
      event.stopPropagation();
      closeMenus();
      // [CUSTOM-20260930-151] A draft has no session to configure yet — see chooseDraftValue.
      if (state.draft) { chooseDraftValue(option, value); return; }
      NS.bridge.post({
        type: 'setConfigOption',
        sessionId: state.sessionId,
        configId: option.id,
        value: String(value)
      });
    });
    return item;
  }

  // --- Context meter (CUSTOM-20260928-096, 129 改圆环) ---------------------
  // Claude Code 风格的上下文用量。数据来自 meta.usage（宿主已从 usage_update /
  // PromptResponse.usage 填充），无需新增协议消息。
  //
  // [CUSTOM-20260930-129] 从"细条 + 百分比"改成**圆环 + 圆心数字**：底部按钮栏里横向空间
  // 是稀缺的，而圆环在同样的高度下多给了一个"正在跑"的外圈动效（见 setRunning）。
  var GAUGE_NS = 'http://www.w3.org/2000/svg';
  var GAUGE_HALF = 13;          // viewBox is 26x26; every circle is centred here
  var GAUGE_R = 9;              // the progress ring
  var GAUGE_SPIN_R = 11.5;      // the "a turn is running" ring, well outside it
  var GAUGE_C = 2 * Math.PI * GAUGE_R;

  function gaugeCircle(className, radius) {
    var circle = document.createElementNS(GAUGE_NS, 'circle');
    circle.setAttribute('class', className);
    circle.setAttribute('cx', String(GAUGE_HALF));
    circle.setAttribute('cy', String(GAUGE_HALF));
    circle.setAttribute('r', String(radius));
    return circle;
  }

  /** A 26x26 pair of rings: the inner one is the progress, the outer one only shows up
   *  while a turn is running (CSS spins it). The gap between them is deliberate — with a
   *  smaller one the two rings touch and the outer arc stops reading as a separate ring. */
  function buildGauge(pct) {
    var root = document.createElementNS(GAUGE_NS, 'svg');
    root.setAttribute('viewBox', '0 0 26 26');
    root.setAttribute('width', '24');
    root.setAttribute('height', '24');
    root.setAttribute('aria-hidden', 'true');
    root.appendChild(gaugeCircle('gauge-track', GAUGE_R));
    var fill = gaugeCircle('gauge-fill', GAUGE_R);
    // dasharray is the whole circumference and dashoffset hides the part not yet reached.
    // SVG attributes cannot do calc(), so both numbers are computed here rather than in CSS.
    fill.setAttribute('stroke-dasharray', String(GAUGE_C));
    fill.setAttribute('stroke-dashoffset', String(GAUGE_C * (1 - pct)));
    root.appendChild(fill);
    root.appendChild(gaugeCircle('gauge-spin', GAUGE_SPIN_R));
    return root;
  }

  function renderContext(usage) {
    lastUsage = usage || null;
    if (!lastUsage || !lastUsage.size) {
      contextMeter.hidden = true;
      return;
    }
    var pct = Math.max(0, Math.min(1, lastUsage.used / lastUsage.size));
    var percent = Math.round(pct * 100);
    var label = Math.round(lastUsage.used / 1000) + 'k / ' + Math.round(lastUsage.size / 1000) + 'k tokens';
    // The cost line used to live in the header bar; that bar is gone, so it rides in the
    // tooltip rather than being dropped.
    if (lastUsage.costAmount !== undefined && lastUsage.costAmount !== null) {
      label += '  ' + lastUsage.costAmount + ' ' + (lastUsage.costCurrency || '');
    }
    contextMeter.hidden = false;
    contextMeter.title = percent + '%  ·  ' + label;
    contextMeter.className = 'context-meter'
      + (pct > 0.9 ? ' hot' : (pct > 0.7 ? ' warn' : ''))
      + (state.running ? ' running' : '');
    NS.dom.clear(contextMeter);
    contextMeter.appendChild(buildGauge(pct));
    contextMeter.appendChild(NS.dom.el('span', 'gauge-text', String(percent)));
  }

  // --- Attachments ---------------------------------------------------------

  function renderAttachments() {
    NS.dom.clear(attachmentsEl);
    if (state.attachments.length === 0) {
      attachmentsEl.hidden = true;
      return;
    }
    attachmentsEl.hidden = false;
    for (var i = 0; i < state.attachments.length; i++) {
      (function (attachment) {
        var chip = NS.dom.el('span', 'attachment');
        // [CUSTOM-20260928-096] 图片附件：缩略图优先（本地缓存，无则回退成相框图标）。
        if (attachment.kind === 'image') {
          var thumb = imageThumbs[attachment.path];
          if (thumb) {
            var img = NS.dom.el('img', 'attachment-thumb');
            img.setAttribute('src', thumb);
            img.setAttribute('alt', attachment.name);
            chip.appendChild(img);
          } else {
            chip.appendChild(NS.icons.icon('image', 'attachment-thumb-icon'));
          }
        }
        chip.appendChild(NS.dom.el('span', 'attachment-name', attachment.name));
        var remove = NS.dom.el('button', 'attachment-x', '\\u00d7');
        remove.title = 'Remove attachment';
        remove.addEventListener('click', function () {
          NS.bridge.post({ type: 'detachFile', sessionId: state.sessionId, path: attachment.path });
        });
        chip.appendChild(remove);
        attachmentsEl.appendChild(chip);
      })(state.attachments[i]);
    }
  }

  // --- Draft mode (CUSTOM-20260925-058) ------------------------------------

  /** Switch the composer into draft mode: enabled, but bound to no session yet. */
  function setDraft(draft) {
    // [CUSTOM-20260927-085] Stash BEFORE the state changes — the outgoing owner may be
    // another DRAFT, and losing its text is what this fix is about.
    stashDraft();
    state.sessionId = null;
    state.agentName = null;
    state.running = false;
    state.loading = false;
    state.draft = draft ? { draftId: draft.draftId, cwd: draft.cwd || null } : null;
    // [CUSTOM-20260930-151] 用户在这个草稿页上选过的配置项（configId → value），随草稿存活。
    // 存回 boot 持有的那个 draft 对象上：切换草稿/切走再切回时它还在，而且**只有一份**
    // （composer 只读它，pitfall #19 的"两份副本"在这里要避开）。
    selections = draft ? (draft.selections || {}) : {};
    if (draft) { draft.selections = selections; }
    state.draftPending = false;
    state.attachments = [];
    // No session ⇒ no 'meta' yet: mode/model/commands only arrive once the agent
    // has created the session. That is inherent to a draft, not an oversight.
    // [CUSTOM-20260930-151] …but the panel no longer leaves it at that: the HOST keeps a
    // snapshot of this agent's last session (config options + available commands) and
    // 'setDraftOptions' fills these two in from it. They are the *candidates* for the
    // session this message will create — not that session's state, which does not exist yet.
    state.commands = [];
    state.configOptions = [];
    hideSlash();
    renderPickers();
    renderAttachments();
    // [CUSTOM-20261001-165] 草稿没有会话，也就没有用量：不清的话输入框右侧的上下文表盘会**留着
    // 上一个会话的数字**（用户截图：新建会话还显示着上一条的百分比）。
    renderContext(null);
    refreshControls();
    // …and hand back what THIS draft had. Without it, switching drafts carried the
    // previous draft's text across (and a discarded-then-reopened draft came back empty).
    restoreDraft(state.draft ? state.draft.draftId : null);
    autoGrow();
    // [CUSTOM-20260930-151] Ask the host for the composer's options. A draft has no session,
    // and mode/model/commands are session-scoped in ACP, so the host answers from a snapshot of
    // this agent's LAST session ('setDraftOptions'). The request lives here rather than in boot
    // because the component that has to render the answer is the one that knows it is missing;
    // draftId rides along so a late answer cannot land on a different draft.
    if (state.draft) {
      NS.bridge.post({ type: 'listDraftOptions', draftId: state.draft.draftId });
    }
  }

  /**
   * [CUSTOM-20260930-151] The host answered 'listDraftOptions'.
   *
   * Guarded by 'draftId': the answer is asynchronous, so by the time it lands the user may have
   * switched to another draft (or dropped this one). Applying it anyway is how a value chosen
   * for draft A silently shows up in draft B — see pitfall #23's family.
   */
  function setDraftOptions(payload) {
    if (!state.draft || state.draft.draftId !== payload.draftId) { return; }
    state.configOptions = payload.configOptions || [];
    state.commands = payload.availableCommands || [];
    // The user's own picks outrank the snapshot's values: this draft may have been focused
    // before, and the answer always arrives with the snapshot's (agent-side) current values.
    applyDraftSelections();
    renderPickers();
    refreshControls();
  }

  /**
   * [CUSTOM-20260930-151] Put the values the user already picked back onto a fresh snapshot copy.
   *
   * Only ids and values that the snapshot actually offers are replayed: a stale snapshot (the
   * agent's model list changed) must not make the button label claim a value this agent no
   * longer has — the host would then skip it silently at creation time.
   */
  function applyDraftSelections() {
    for (var i = 0; i < state.configOptions.length; i++) {
      var option = state.configOptions[i];
      if (!Object.prototype.hasOwnProperty.call(selections, option.id)) { continue; }
      var value = selections[option.id];
      if (option.type === 'boolean') {
        option.currentValue = value === 'true';
      } else if (offersValue(option, value)) {
        option.currentValue = value;
      }
    }
  }

  /** Does this select option still offer 'value'? (Both the flat and the grouped shape.) */
  function offersValue(option, value) {
    var options = option.options || [];
    for (var i = 0; i < options.length; i++) {
      var entry = options[i];
      if (!entry) { continue; }
      if (entry.options) {
        for (var j = 0; j < entry.options.length; j++) {
          if (String(entry.options[j].value) === value) { return true; }
        }
      } else if (String(entry.value) === value) {
        return true;
      }
    }
    return false;
  }

  /**
   * [CUSTOM-20260930-151] The user picked a value on the DRAFT page: record it on the draft.
   *
   * Deliberately **no** 'setConfigOption' message: a draft has no sessionId, so that message
   * would carry 'sessionId: null' and be dropped by the host's 'verifySession' guard (§5.4
   * rule 1) — the user would have chosen something and nothing at all would happen. The choice
   * travels with 'createDraftAndSend' instead, and the local copy's 'currentValue' is updated
   * so the button says what it will do.
   */
  function chooseDraftValue(option, value) {
    var next = option.type === 'boolean' ? (value === true || value === 'true') : String(value);
    option.currentValue = next;
    selections[option.id] = String(next);
    renderPickers();
  }

  /** The draft's picked values, in protocol shape (only what the user actually touched). */
  function draftSelections() {
    var out = [];
    for (var id in selections) {
      if (Object.prototype.hasOwnProperty.call(selections, id)) {
        out.push({ configId: id, value: selections[id] });
      }
    }
    return out;
  }

  /** The user picked a directory for the focused draft. */
  function updateDraftCwd(draftId, cwd) {
    if (!state.draft || state.draft.draftId !== draftId) { return; }
    state.draft.cwd = cwd || null;
    refreshControls();
  }

  /** The first message was accepted: leave draft mode and clear the box. */
  function resolveDraft() {
    state.draft = null;
    state.draftPending = false;
    input.value = '';
    autoGrow();
    refreshControls();
  }

  /** Creating the session failed: stay in draft mode AND keep the typed text. */
  function failDraft() {
    state.draftPending = false;
    refreshControls();
    input.focus();
  }

  // --- Public API ----------------------------------------------------------

  function setFocus(summary, meta) {
    // [CUSTOM-20260925-058] Draft mode and session mode are mutually exclusive —
    // 'send()' branches on 'state.draft', so a stale one would misroute a send.
    var wasDraft = !!state.draft;
    var changed = wasDraft || !state.sessionId || !summary || summary.sessionId !== state.sessionId;
    // [CUSTOM-20260925-050] Stash BEFORE the id changes, so the outgoing
    // session's draft is filed under its own id rather than the incoming one.
    // [CUSTOM-20260927-085] …and before 'state.draft' is cleared: a draft's text is
    // filed under the draft's id, so clearing it first would make ownerKey() null and
    // drop the text (which is exactly the reported data loss).
    if (changed) { stashDraft(); }
    state.draft = null;
    state.draftPending = false;
    state.sessionId = summary ? summary.sessionId : null;
    state.agentName = summary ? summary.agentName : null;
    state.running = summary ? !!summary.running : false;
    state.loading = summary ? !!summary.loading : false;
    if (changed) {
      state.attachments = [];
      hideSlash();
      // [CUSTOM-20260925-050] Only on an actual switch: re-assigning the value
      // for the SAME session would move the caret to the end while the user is
      // typing (a 'focus' for the already-focused session does arrive — e.g.
      // clicking it again in the tree).
      restoreDraft(state.sessionId);
    }
    if (meta) {
      state.commands = meta.availableCommands || [];
      state.configOptions = meta.configOptions || [];
    } else {
      state.commands = [];
      state.configOptions = [];
    }
    renderPickers();
    renderAttachments();
    renderContext(meta && meta.usage);
    refreshControls();
    autoGrow();
  }

  function setRunning(running) {
    state.running = running;
    refreshControls();
    // [CUSTOM-20260930-129] The ring's outer arc says "a turn is running", and this path
    // has no meta of its own — redraw from the numbers we kept.
    renderContext(lastUsage);
  }

  function setMeta(meta) {
    state.commands = meta.availableCommands || [];
    state.configOptions = meta.configOptions || [];
    renderPickers();
    renderContext(meta.usage);
    refreshControls();
  }

  function setAttachments(list) {
    state.attachments = list || [];
    renderAttachments();
  }

  // [CUSTOM-20260928-096] 客户端记录图片缩略图（boot.ts 读取剪贴板位图后调用）。
  function rememberImage(id, dataUrl) {
    imageThumbs[id] = dataUrl;
    renderAttachments();
  }

  function setLoading(loading) {
    state.loading = loading;
    refreshControls();
  }

  function focusInput() { input.focus(); }
  // [CUSTOM-20260925-047] Lets boot.ts decide whether it is appropriate to move
  // the caret into the composer (no session / still loading = it is not).
  function isComposable() { return canCompose(); }

  NS.composer = {
    init: init,
    setFocus: setFocus,
    setRunning: setRunning,
    setMeta: setMeta,
    setAttachments: setAttachments,
    rememberImage: rememberImage,
    setLoading: setLoading,
    focusInput: focusInput,
    isComposable: isComposable,
    forgetDraft: forgetDraft,
    setDraft: setDraft,
    setDraftOptions: setDraftOptions,
    updateDraftCwd: updateDraftCwd,
    resolveDraft: resolveDraft,
    failDraft: failDraft
  };
})(window.__acpc = window.__acpc || {});
`;
