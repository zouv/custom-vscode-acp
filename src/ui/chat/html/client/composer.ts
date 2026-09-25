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
  var drafts = {};
  var draftTimer = null;

  function stashDraft() {
    if (state.sessionId) { drafts[state.sessionId] = input.value; }
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
  }

  function target() {
    return { sessionId: state.sessionId };
  }

  function canCompose() {
    // [CUSTOM-20260925-058] A draft has no sessionId yet but is perfectly
    // composable — its first message is what creates the session.
    return (!!state.sessionId || !!state.draft) && !state.loading;
  }

  function refreshControls() {
    var enabled = canCompose();
    input.disabled = !enabled;
    sendBtn.disabled = !enabled && !state.running;
    sendBtn.className = 'send-stop ' + (state.running ? 'stop' : 'send');
    sendBtn.textContent = state.running ? '\\u25a0 Stop' : 'Send';
    if (state.draftPending) {
      // A create-then-send is in flight: the button must not accept a second one.
      sendBtn.disabled = true;
      sendBtn.textContent = 'Creating\\u2026';
      input.placeholder = 'Creating this session\\u2026';
      return;
    }
    if (state.draft) {
      // Say why the tab says "New session": the first message is what creates it.
      input.placeholder = 'Your first message creates this session\\u2026';
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
    if (!text || text.trim().length === 0) { return; }

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
        text: text
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
    var next = Math.max(60, Math.min(320, input.scrollHeight));
    input.style.height = next + 'px';
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
    btn.title = option.description || option.name || option.id;
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
      NS.bridge.post({
        type: 'setConfigOption',
        sessionId: state.sessionId,
        configId: option.id,
        value: String(value)
      });
    });
    return item;
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
    // Leaving a real session: keep its typed text under its own id.
    if (state.sessionId) { stashDraft(); }
    state.sessionId = null;
    state.agentName = null;
    state.running = false;
    state.loading = false;
    state.draft = draft ? { draftId: draft.draftId, cwd: draft.cwd || null } : null;
    state.draftPending = false;
    state.attachments = [];
    // No session ⇒ no 'meta' yet: mode/model/commands only arrive once the agent
    // has created the session. That is inherent to a draft, not an oversight.
    state.commands = [];
    state.configOptions = [];
    hideSlash();
    renderPickers();
    renderAttachments();
    refreshControls();
    autoGrow();
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
    state.draft = null;
    state.draftPending = false;
    var changed = wasDraft || !state.sessionId || !summary || summary.sessionId !== state.sessionId;
    // [CUSTOM-20260925-050] Stash BEFORE the id changes, so the outgoing
    // session's draft is filed under its own id rather than the incoming one.
    if (changed) { stashDraft(); }
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
    refreshControls();
    autoGrow();
  }

  function setRunning(running) {
    state.running = running;
    refreshControls();
  }

  function setMeta(meta) {
    state.commands = meta.availableCommands || [];
    state.configOptions = meta.configOptions || [];
    renderPickers();
    refreshControls();
  }

  function setAttachments(list) {
    state.attachments = list || [];
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
    setLoading: setLoading,
    focusInput: focusInput,
    isComposable: isComposable,
    forgetDraft: forgetDraft,
    setDraft: setDraft,
    updateDraftCwd: updateDraftCwd,
    resolveDraft: resolveDraft,
    failDraft: failDraft
  };
})(window.__acpc = window.__acpc || {});
`;
