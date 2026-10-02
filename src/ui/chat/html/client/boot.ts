// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 客户端入口：vsCode bridge、消息分发、空态与加载遮罩。
//
// 消息纪律：所有会话作用域的消息都带 sessionId，客户端**只处理与当前聚焦会话匹配的消息**——
// 后台会话的流式更新不得污染前台视图。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const bootClient = `
(function (NS) {
  'use strict';

  var vscode = acquireVsCodeApi();

  // Defined first: every other module posts through this.
  NS.bridge = {
    post: function (message) { vscode.postMessage(message); }
  };

  // [CUSTOM-20260925-029] Forward the webview console + uncaught errors to the
  // extension's output channel. The webview console is invisible without Webview
  // DevTools, and every "why does the UI look wrong" investigation so far hit
  // exactly that wall. Capped so a per-entry warning cannot flood the channel.
  (function installLogBridge() {
    var MAX_FORWARDED = 50;
    var forwarded = 0;
    function forward(level, args) {
      if (forwarded >= MAX_FORWARDED) { return; }
      forwarded++;
      try {
        var text = Array.prototype.map.call(args, function (a) {
          if (typeof a === 'string') { return a; }
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        if (text.length > 400) { text = text.slice(0, 400) + '\\u2026'; }
        NS.bridge.post({ type: 'clientLog', level: level, message: text });
      } catch (e) { /* logging must never break the UI */ }
    }
    var nativeWarn = console.warn;
    var nativeError = console.error;
    console.warn = function () { forward('warn', arguments); nativeWarn.apply(console, arguments); };
    console.error = function () { forward('error', arguments); nativeError.apply(console, arguments); };
    window.addEventListener('error', function (event) {
      forward('error', ['uncaught: ' + (event.message || '?') + ' @line ' + (event.lineno || 0)]);
    });
  })();

  var emptyState = null;
  var loadOverlay = null;
  var currentSessionId = null;

  // Defined after the bridge so it can stamp the focused session onto messages
  // that the extension treats as session-scoped (openFile / openTerminal).
  function postForSession(message) {
    if (currentSessionId && message.sessionId === undefined) {
      message.sessionId = currentSessionId;
    }
    NS.bridge.post(message);
  }
  NS.bridge.postForSession = postForSession;

  function showEmpty(show) {
    // [CUSTOM-20260930-123] 状态卡接管消息区时，置顶副本必须让位：它是
    // .messages-column 的绝对定位子元素，transcriptView.reset() 清不掉它，而卡片
    // 没有背景 ⇒ 上一个会话的置顶卡会**透出来**。这里是它唯一的写者，别在别处再写。
    if (show && NS.stickyUser) { NS.stickyUser.reset(); }
    emptyState.style.display = show ? '' : 'none';
  }

  // [CUSTOM-20260927-090] Whether the panel's agent is up, as last told by the host
  // (boot / focus / sessionsChanged). It decides what the empty state SAYS: a sessionless
  // panel can still have a live agent process, and telling the user to connect one that
  // is already running is simply wrong.
  // [CUSTOM-20260930-123] The status card owns the wording now (client/stateCard.ts holds
  // the single copy of it); this function is only the channel that carries the flag over.
  function applyEmptyState(connected) {
    if (connected === undefined) { return; }
    if (NS.stateCard) { NS.stateCard.setConnected(connected === true); }
  }

  function setLoading(loading) {
    loadOverlay.hidden = !loading;
    NS.composer.setLoading(loading);
  }

  function noticeNode(level, text) {
    return { id: 'notice-' + Date.now() + '-' + Math.floor(Math.random() * 100000), kind: 'notice', level: level, at: Date.now(), text: text };
  }

  function applyFocus(summary, snapshot, meta) {
    // [CUSTOM-20260924-022] Remember the OUTGOING session's position before its
    // DOM is replaced - the same session may come back later (tab switch).
    NS.scroll.remember(currentSessionId);
    currentSessionId = summary ? summary.sessionId : null;
    // [CUSTOM-20261001-166] 置顶条按会话记着自己的收缩状态 —— 在重置它之前把会话同步过去
    // （这是焦点变化唯一的咽喉点，与 elicitationView.setSession 同一形态）。
    if (NS.stickyUser && NS.stickyUser.setSession) { NS.stickyUser.setSession(currentSessionId); }
    NS.tabs.setFocus(summary);
    NS.composer.setFocus(summary, meta);
    // [CUSTOM-20260930-129] 这里原有一行 NS.tabs.renderUsage(meta)（顶部那条进度条）。
    // 顶部进度条已删除，上下文用量只由底部的圆环呈现（composer.setFocus 里画）。
    // Attachments ride along on meta so they survive a session switch.
    NS.composer.setAttachments((meta && meta.attachments) || []);

    if (!summary) {
      resetTranscript();
      // [CUSTOM-20260926-081] The outline goes with the transcript — including the
      // PINNED one. This early return used to skip both calls, so a pinned sidebar
      // kept showing "No messages yet" in a panel that has no session at all, and the
      // empty state was pushed out of the middle. invalidate() is what re-runs the
      // "is there anything to navigate" check that now governs every outline form.
      NS.outline.close();
      NS.outline.invalidate();
      // [CUSTOM-20260928-102] …and the pinned "last question", for the same reason:
      // it is a copy of a node that no longer exists.
      if (NS.stickyUser) { NS.stickyUser.reset(); }
      showEmpty(true);
      setLoading(false);
      return;
    }

    showEmpty(false);
    setLoading(!!summary.loading);
    if (snapshot) {
      NS.transcriptView.hydrate(snapshot);
    } else {
      resetTranscript();
    }
    // Restore *after* hydrate: the decision needs the rebuilt DOM in place, and
    // a session with no memory falls back to "stick to the bottom".
    NS.scroll.restore(currentSessionId);
    // [CUSTOM-20260924-021] A session switch rebuilds the transcript, so the
    // outline is closed and its cached offsets dropped (they belong to the
    // previous session's DOM).
    NS.outline.close();
    NS.outline.invalidate();
    // [CUSTOM-20260924-023] The rail is rebuilt for the same reason.
    NS.rail.invalidate();
    // [CUSTOM-20260928-102] The pinned user message is a CLONE of a node that was just
    // replaced; reset, then re-decide once the restored scroll position is in place
    // (restore writes scrollTop, which fires a scroll event — this makes sure the very
    // first frame after a switch is right even if it does not).
    if (NS.stickyUser) {
      NS.stickyUser.reset();
      // [CUSTOM-20261002-172] 走 schedule() 而不是 dom.schedule(sync)：卡堆的重排现在也会被
      // 流式 chunk 触发，两条来源必须共用一个去重守卫（syncQueued）。
      NS.stickyUser.schedule();
    }
    // [CUSTOM-20260925-033] The history list belongs to the previous agent.
    NS.sessionMenu.reset();
    // [CUSTOM-20261001-165] 图片放大浮层里是**上一个会话**的图：切走就收起来
    // （154 的规矩：浮层属于它打开时那个会话）。
    if (NS.lightbox && NS.lightbox.close) { NS.lightbox.close(); }
    // [CUSTOM-20260925-058] The directory drawer belonged to the previous
    // session/draft too.
    NS.directoryMenu.reset();
    requestMarkdown();
  }

  /**
   * Keep the composer in step with the focused session's turn state. Without
   * this the Send button never flips to Stop (there is no other channel that
   * updates 'running'), so a mid-turn click re-sends and clears the draft.
   */
  function syncFocusedState(sessions) {
    if (!currentSessionId) { return; }
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].sessionId === currentSessionId) {
        NS.composer.setRunning(!!sessions[i].running);
        NS.composer.setLoading(!!sessions[i].loading);
        setLoading(!!sessions[i].loading);
        return;
      }
    }
  }

  /**
   * Ask the extension to render every assistant entry that does not have HTML
   * yet. Round-tripping keeps 'marked' out of the webview bundle (the CSP only
   * allows the nonce'd inline script).
   */
  function requestMarkdown() {
    // [CUSTOM-20260930-147] 这里原来有一条 if (!currentSessionId) { return; }：聚焦会话为空
    // 时整批请求都发不出去。而 transcriptView 的 item **自带 sessionId**（请求方就是它），
    // 不需要借 boot 的聚焦状态 —— 那道守卫只会让"正文刚落地、聚焦还没同步好"的那一帧白白丢掉
    // 一次请求（pending 不清空，但下一次触发可能永远不会来，见 128）。
    var pending = NS.transcriptView.pendingMarkdown();
    // [CUSTOM-20260925-066] Tool text blocks queue on the same round-trip.
    if (NS.toolCallView && NS.toolCallView.pendingMarkdownItems) {
      // [CUSTOM-20260929-120] The tool items have no session of their own — stamp the
      // focused one on them here, or the host drops them (see pendingMarkdownItems).
      // 只有这些 item 依赖聚焦会话，所以守卫挪到了这里。
      if (currentSessionId) {
        pending = pending.concat(NS.toolCallView.pendingMarkdownItems(currentSessionId));
      }
    }
    if (pending.length === 0) { return; }
    NS.bridge.post({ type: 'renderMarkdown', items: pending });
    // [CUSTOM-20260930-147] 临时诊断（定位"最后一条不渲染"后可以删）：请求这一侧到底发没发、
    // 带的是哪条记录。与下面 markdownRendered / patch dropped 两条日志合起来能一次定位断点。
    console.warn('[acpc] renderMarkdown asked: ' + pending.length + ' item(s) ['
      + pending.map(function (it) { return it.entryId; }).join(',') + ']');
  }

  // Exposed so transcriptView can ask for rendering when a stream finalizes.
  NS.boot = {
    requestMarkdown: requestMarkdown,
    persistUi: persistUi,
    recallUi: recallUi
  };

  // --- Draft page (CUSTOM-20260925-058) -------------------------------------
  //
  // A draft is a LOCAL new-session tab: no sessionId, no host-side session. Two
  // reasons it exists instead of creating the session on '+':
  //   · a session's working directory is fixed at creation (the protocol has no
  //     "change cwd"), so choosing it must happen BEFORE the session exists;
  //   · 'session/close' does not remove a session from the agent's history, so
  //     "create, then recreate on change" would leave an empty session behind
  //     for every directory the user tried.
  //
  // Because it is local, it must survive every server-driven repaint:
  // 'sessionsChanged' and 'boot' carry the server's session list, which by
  // definition does not contain drafts. Losing them looks like "I clicked + and
  // the tab flashed away".
  var drafts = [];
  var focusedDraftId = null;
  var draftSeq = 0;

  function draftById(draftId) {
    for (var i = 0; i < drafts.length; i++) {
      if (drafts[i].draftId === draftId) { return drafts[i]; }
    }
    return null;
  }

  function renderDrafts() {
    NS.tabs.setDrafts(drafts, focusedDraftId);
  }

  /** Open a new draft and focus it. 'initialCwd' pre-fills the directory. */
  function startDraft(initialCwd) {
    var draft = { draftId: 'draft-' + (++draftSeq), cwd: initialCwd || null };
    drafts.push(draft);
    focusDraft(draft.draftId);
    return draft;
  }

  function focusDraft(draftId) {
    var draft = draftById(draftId);
    if (!draft) { return; }
    NS.scroll.remember(currentSessionId);
    currentSessionId = null;
    focusedDraftId = draftId;
    NS.tabs.setDraftFocus(draft);
    NS.composer.setDraft(draft);
    resetTranscript();
    // [CUSTOM-20260930-123] 卡片留在中央，不再让位给一片空白：草稿页的「页面」就是它
    // （未连接时是提示、已连接时是引导）。这正是用户报的「连接成功后中间一片空白」。
    showEmpty(true);
    setLoading(false);
    NS.outline.close();
    NS.outline.invalidate();
    NS.rail.invalidate();
    NS.sessionMenu.reset();
    // Ask the host for candidates; the reply also fills in the default directory.
    NS.directoryMenu.refresh(draft);
    renderDrafts();
  }

  function setDraftCwd(draftId, cwd) {
    var draft = draftById(draftId);
    if (!draft) { return; }
    draft.cwd = cwd || null;
    if (focusedDraftId === draftId) {
      NS.tabs.setDraftFocus(draft);
      NS.composer.updateDraftCwd(draftId, draft.cwd);
    }
    renderDrafts();
  }

  function dropDraft(draftId) {
    var draft = draftById(draftId);
    if (!draft) { return; }
    var index = drafts.indexOf(draft);
    drafts.splice(index, 1);
    if (focusedDraftId !== draftId) { renderDrafts(); return; }

    focusedDraftId = null;
    var neighbour = drafts[index] || drafts[index - 1] || null;
    if (neighbour) {
      focusDraft(neighbour.draftId);
      // [CUSTOM-20260927-085] Only after the composer has moved off it: the discard
      // may not leave the dropped draft's text behind (its id is never reused).
      NS.composer.forgetDraft(draftId);
      return;
    }
    // Nothing local left: fall back to a live session, else to the empty state.
    if (NS.tabs.focusFirstSession && NS.tabs.focusFirstSession()) {
      NS.composer.forgetDraft(draftId);
      renderDrafts();
      return;
    }
    currentSessionId = null;
    NS.tabs.setFocus(null);
    NS.composer.setFocus(null, null);
    NS.composer.forgetDraft(draftId);
    resetTranscript();
    showEmpty(true);
    renderDrafts();
  }

  /** The first message was accepted: retire the tab (the session now exists). */
  function resolveDraft(draftId) {
    var draft = draftById(draftId);
    if (draft) { drafts.splice(drafts.indexOf(draft), 1); }
    if (focusedDraftId === draftId) { focusedDraftId = null; }
    // 'focus' normally arrived first (the host focuses the new session), which
    // already moved the composer to it — this is the safety net.
    NS.composer.resolveDraft();
    renderDrafts();
  }

  /** Creating the session failed: keep the draft AND the typed text. */
  function failDraft(draftId, message) {
    NS.composer.failDraft();
    // [CUSTOM-20260930-123] The draft page's "page" is the status card. Appending a notice
    // to an empty transcript would be hidden behind the card (and showEmpty(false) hid the
    // card outright), so the failure goes where the user is actually looking.
    if (NS.stateCard) { NS.stateCard.setError(message); }
    showEmpty(true);
    console.warn('[acpc] draft failed:', draftId, message);
  }

  NS.draft = {
    start: startDraft,
    focus: focusDraft,
    drop: dropDraft,
    setCwd: setDraftCwd,
    // [CUSTOM-20260925-058] Read-only accessor for the directory drawer: it
    // keeps only the draft id and reads the cwd from here, so there is exactly
    // one copy of "which directory will this draft use" (pitfalls #19).
    get: draftById,
    // [CUSTOM-20260928-100] Which draft is on screen, or null. The history picker
    // needs it: opening a session while on a draft page must retire THAT draft,
    // not the session the host still has focused.
    focusedId: function () { return focusedDraftId; },
    // Retire a draft that was consumed by something other than its own first
    // message (here: a history pick). Same shape as resolveDraft — no fallback to
    // another tab, because the caller is about to focus a real session.
    resolve: resolveDraft
  };

  /**
   * Webview-local UI preferences. Survives a reload of this webview; the
   * extension host does not need to know about them.
   */
  function recallUi() {
    try { return vscode.getState() || {}; } catch (e) { return {}; }
  }

  function persistUi(patch) {
    var next = recallUi();
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) { next[key] = patch[key]; }
    }
    try { vscode.setState(next); } catch (e) { /* state is best-effort */ }
  }

  /**
   * Sub-agent grouping is a visual preference: children stay in the transcript
   * in arrival order, and the toggle only flips a class. Links are inferred, so
   * being able to switch the grouping off is part of being honest about it.
   */
  function applyGrouping(flat) {
    var messages = NS.dom.qs('messages');
    var toggle = NS.dom.qs('nestToggle');
    if (messages) {
      if (flat) { messages.classList.add('flat-tools'); } else { messages.classList.remove('flat-tools'); }
    }
    if (toggle) { toggle.className = flat ? 'nest-toggle off' : 'nest-toggle'; }
  }

  /** [CUSTOM-20260925-065] Show the per-record wall-clock stamp (see .rec-time). */
  function applyTimes(on) {
    var messages = NS.dom.qs('messages');
    var toggle = NS.dom.qs('timeToggle');
    if (messages) {
      if (on) { messages.classList.add('show-times'); } else { messages.classList.remove('show-times'); }
    }
    if (toggle) { toggle.className = on ? 'nest-toggle' : 'nest-toggle off'; }
    // [CUSTOM-20260928-103] The pinned copy is a clone outside '#messages', so it carries
    // its own copy of this class (stickyUser.render mirrors it). Re-render it here: the
    // class alone would not reach a copy that is already on screen.
    if (NS.stickyUser) { NS.stickyUser.refresh(); }
  }

  function onMessage(event) {
    var message = event.data;
    if (!message || !message.type) { return; }
    // [CUSTOM-20260930-149] 带记录的消息（append / revise / toolUpdate）都自带 sessionId ——
    // 用它把客户端的会话身份**校正**回来。原因见 transcriptView.setSessionId：reset() 会清空它，
    // 而只有快照（hydrate）会设回来，于是"重开面板 / 切会话之后新到的记录"整段时间里它是 null，
    // markdown 请求带着 null 发出去、被宿主静默丢弃（Output: dropped markdown item … unknown
    // session null），界面上就是"最后一条停在原文"。
    if (message.sessionId && (message.entries || message.entryId)
      && NS.transcriptView.setSessionId) {
      NS.transcriptView.setSessionId(message.sessionId);
    }

    switch (message.type) {
      case 'boot':
        NS.tabs.setSessions(message.sessions || []);
        applyEmptyState(message.agentConnected);
        // [CUSTOM-20260930-123] Arm the auto-connect timer here: this is the only place
        // that knows all three inputs at once (agentConnected + focused + the setting).
        // noteBoot is idempotent — boot is delivered twice per document.
        if (NS.stateCard) {
          NS.stateCard.noteBoot({
            agentConnected: message.agentConnected === true,
            autoConnect: message.autoConnect,
            focused: !!message.focused
          });
        }
        applyFocus(message.focused, message.snapshot, message.meta);
        syncFocusedState(message.sessions || []);
        // [CUSTOM-20260930-152] 表单抽屉跟着记录走：快照重建后重新对账（切会话、重挂载、
        // 双 surface 都靠这一步，不需要宿主知道有抽屉这回事）。
        // [CUSTOM-20261001-158] 权限抽屉同一条路由（syncDrawers = 两个抽屉的唯一入口）。
        syncDrawers();
        break;

      // [CUSTOM-20260926-077] Outline pin/width prefs come back with boot.
      case 'uiPrefs':
        NS.outline.applyPrefs(message);
        break;

      // [CUSTOM-20260930-125] The auto-connect setting's live value: changed on the other
      // surface, or in the Settings UI. The boot-time value rides along with 'boot'.
      case 'autoConnectPref':
        if (NS.stateCard) { NS.stateCard.setAutoConnect(message.value === true); }
        break;

      case 'sessionsChanged':
        NS.tabs.setSessions(message.sessions || []);
        applyEmptyState(message.agentConnected);
        syncFocusedState(message.sessions || []);
        break;

      case 'focus':
        applyEmptyState(message.agentConnected);
        applyFocus(message.summary, message.snapshot, message.meta);
        // [CUSTOM-20260930-152] 另一个会话的表单不该跟着你走，也不该被丢掉：重新对账。
        syncDrawers();
        break;

      case 'sessionClosed':
        if (message.sessionId === currentSessionId) {
          currentSessionId = null;
          resetTranscript();
          showEmpty(true);
          NS.outline.invalidate();
          NS.rail.invalidate();
        }
        // [CUSTOM-20260924-022] Drop the remembered position of a session that
        // no longer exists (ids are never reused, so this is pure hygiene).
        NS.scroll.forget(message.sessionId);
        // [CUSTOM-20260925-050] Same for its draft.
        NS.composer.forgetDraft(message.sessionId);
        // [CUSTOM-20260930-152] 关掉的是聚焦会话时记录已清空 ⇒ 抽屉必须跟着消失。
        syncDrawers();
        break;

      case 'append': {
        if (message.sessionId !== currentSessionId) { break; }
        var entries = message.entries || [];
        var appendedForm = false;
        var appendedPermission = false;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].kind === 'elicitation') { appendedForm = true; }
          if (entries[i].kind === 'permission') { appendedPermission = true; }
          NS.transcriptView.append(entries[i], entries[i].toolView);
        }
        if (entries.length > 0) { showEmpty(false); }
        // [CUSTOM-20260924-021] Only the transcript-mutating cases invalidate the
        // outline: doing it for meta/attachments would re-render the drawer on
        // every token-derived message while it is open.
        NS.outline.invalidate();
        // [CUSTOM-20260924-023] The rail self-checks its marker signature, so a
        // chunk on an existing entry costs one cheap comparison and no layout read.
        NS.rail.invalidate();
        // [CUSTOM-20261002-172] 转录变了 ⇒ 置顶卡堆要重排：下游内容一变高，被顶出的那张卡的
        // 上夹（下一条用户消息的自然位置）就跟着变；追加的又正是新的用户消息本身。
        // 走 schedule（一帧一次 + syncQueued 去重）—— 流式的每条 chunk 都会到这里。
        NS.stickyUser.schedule();
        // [CUSTOM-20260930-152] 只在真的带了表单/权限时对账：流式的每一条 chunk 都走这里。
        if (appendedForm || appendedPermission) { syncDrawers(); }
        break;
      }

      case 'revise':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.patch(message.entryId, message.patch);
          NS.outline.invalidate();
          NS.rail.invalidate();
          // [CUSTOM-20261002-172] 同 append：那条记录的高度可能变了（折叠结构/内容）。
          NS.stickyUser.schedule();
          // [CUSTOM-20260930-152] 表单结算（accepted/declined/cancelled）或转到弹框
          // （deferred）都走这条 revise —— 抽屉据此收起。
          // [CUSTOM-20261001-158] 权限结算（selected/cancelled）或 deferred 同理。
          if (message.patch && (message.patch.elicitation || message.patch.permission)) { syncDrawers(); }
        }
        break;

      case 'toolUpdate':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.updateTool(message.entryId, message.tool);
          // [CUSTOM-20260924-023] A tool's status is what colours its rail dot.
          NS.rail.invalidate();
          // [CUSTOM-20261002-172] 工具卡的收展会改变它下面那些用户消息的自然位置。
          NS.stickyUser.schedule();
        }
        break;

      case 'markdownRendered': {
        var items = message.items || [];
        // [CUSTOM-20260930-147] 临时诊断：宿主回填到了哪几条。
        console.warn('[acpc] markdownRendered: ' + items.length + ' item(s) ['
          + items.map(function (it) { return it.entryId; }).join(',') + ']');
        for (var j = 0; j < items.length; j++) {
          // [CUSTOM-20260930-147] **不再**拿 item.sessionId 跟 currentSessionId 比：两端的来源不同
          // （这里是 boot 的聚焦会话，item 带的是请求方 transcriptView 的），不一致时会把回填
          // **静默丢掉** —— 那条记录于是一直停在原文。而宿主其实已经把 html 写进 store 了，
          // 所以"重开会话就正常"（重开走快照，不经过这里）。
          // entryId 在 store 里是全局唯一的，按它回填本来就串不了台（找不到就 patch 忽略）。
          if (items[j].key) { NS.toolCallView.applyMarkdown(items[j].key, items[j].html); }
          else { NS.transcriptView.patch(items[j].entryId, { html: items[j].html }); }
        }
        // [CUSTOM-20260924-022] Markdown grew the transcript, so a restored
        // scroll position has to be re-applied (no-op once the user scrolled).
        NS.scroll.reassert();
        // [CUSTOM-20260924-023] ...and the rail's cached dot positions are stale
        // (text became HTML, heights changed). Measure-only, no rebuild.
        NS.rail.reflow();
        // [CUSTOM-20261002-172] 同理：回填 markdown 会长高下方内容。
        NS.stickyUser.schedule();
        break;
      }

      case 'meta':
        if (message.sessionId === currentSessionId) {
          NS.composer.setMeta(message.meta);
        }
        break;

      case 'attachments':
        if (message.sessionId === currentSessionId) {
          NS.composer.setAttachments(message.attachments || []);
        }
        break;

      // [CUSTOM-20260925-033] Reply to the history picker (listHistory).
      case 'history':
        NS.sessionMenu.setHistory(message);
        break;

      // [CUSTOM-20260928-095] Per-directory disk supplement (incremental merge).
      case 'historySupplement':
        NS.sessionMenu.applySupplement(message);
        break;

      // [CUSTOM-20260925-058] Draft page: directory candidates, the native
      // picker's result, and the outcome of "create the session and send".
      // All four are TARGETED at this document (the draft is this document's).
      case 'directoryChoices':
        NS.directoryMenu.setChoices(message);
        break;

      case 'directoryPicked':
        NS.directoryMenu.setPicked(message.path || null);
        break;

      case 'draftResolved':
        resolveDraft(message.draftId);
        break;

      // [CUSTOM-20260930-151] 草稿页的配置项/命令快照（回复 composer 发的 listDraftOptions）。
      // 不在下面过滤 currentSessionId：草稿本来就没有 sessionId。是否套用由 composer 按
      // draftId 自己判断（应答是异步的，用户可能已经换了草稿）。
      case 'draftOptions':
        NS.composer.setDraftOptions(message);
        break;

      case 'draftFailed':
        failDraft(message.draftId, message.message);
        break;

      case 'error':        // A background session's failure must not land in the visible
        // transcript. The extension already recorded it in the store, so the
        // only job here is to show it when it belongs to the focused session.
        if (message.sessionId && message.sessionId !== currentSessionId) { break; }
        // [CUSTOM-20260930-123] With no session (and no draft) the failure belongs to the
        // status card: appending to an empty transcript AND hiding the card would leave the
        // user with a stray line in the middle of nothing — the look this change removes.
        if (!currentSessionId && !focusedDraftId) {
          if (NS.stateCard) { NS.stateCard.setError(message.message); }
          NS.composer.setRunning(false);
          setLoading(false);
          break;
        }
        NS.transcriptView.append(noticeNode('error', message.message));
        showEmpty(false);
        NS.composer.setRunning(false);
        setLoading(false);
        NS.outline.invalidate();
        NS.rail.invalidate();
        break;

      // [CUSTOM-20260930-123] One connection attempt's phase. The host answers on every
      // path (see protocol.ts): without that, a panel whose agent process is already up
      // would sit on "Connecting…" forever, because nothing else would ever speak.
      case 'connection': {
        if (NS.stateCard) { NS.stateCard.onConnection(message); }
        if (message.state === 'connected') {
          // The requirement behind this change: once connected, the composer must accept
          // input. With no session the draft page IS that state — its first message is what
          // creates the session (058). When the host focused a session instead, do not add
          // a spare tab next to it.
          // A '+' pressed while offline is honoured unconditionally: it asked for a NEW
          // draft, not for whichever session happens to be newest.
          var wanted = NS.stateCard ? NS.stateCard.takeDraftIntent() : false;
          if (wanted || (!focusedDraftId && !currentSessionId)) { startDraft(); }
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * [CUSTOM-20260925-049] Attachments by drag & drop / paste.
   *
   * The only thing the webview can hand the extension is a PATH, so the whole
   * job here is turning a DataTransfer into one — and being loud when it cannot
   * be done. Silence is the failure mode this project keeps paying for: a drop
   * that does nothing leaves no trace anywhere the user can look (pitfall #15's
   * second lesson).
   */
  function fileUriToPath(uri) {
    var s = String(uri || '');
    if (s.slice(0, 7).toLowerCase() !== 'file://') { return null; }
    var rest = s.slice(7);
    // 'file://host/path' carries an authority; VS Code writes a third slash for
    // local files, so anything not starting with '/' has one to remove.
    if (rest.charAt(0) !== '/') {
      var slash = rest.indexOf('/');
      if (slash < 0) { return null; }
      rest = rest.slice(slash);
    }
    try { rest = decodeURIComponent(rest); } catch (e) { /* keep the raw form */ }
    // 'file:///C:/x' -> '/C:/x' -> 'C:/x'.
    // Deliberately NOT a regex: check-webview-client.mjs parses the RAW template
    // text (it does not evaluate the escapes), so a regex literal containing an
    // escaped slash there would look like it ends early and the checker would
    // report a bogus syntax error. Char-code tests have no such problem.
    var drive = rest.charCodeAt(1);
    var isLetter = (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
    if (rest.charAt(0) === '/' && isLetter && rest.charAt(2) === ':') { rest = rest.slice(1); }
    return rest || null;
  }

  function pathsFromTransfer(dt) {
    var out = [];
    if (!dt) { return out; }
    var i;
    // 1) Drops that STARTED inside VS Code (explorer, editor tab, problems view)
    //    carry the file URIs as text.
    var uriList = dt.getData ? dt.getData('text/uri-list') : '';
    if (uriList) {
      var lines = String(uriList).split(/\\r?\\n/);
      for (i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === '#') { continue; }
        var path = fileUriToPath(line);
        if (path) { out.push(path); }
      }
    }
    // 2) Cross-application drops only give File objects. VS Code's webview host
    //    augments those with a real 'path'; when it is absent there is no
    //    supported way to learn the location, and we say so rather than
    //    pretending the drop worked.
    if (out.length === 0 && dt.files) {
      for (i = 0; i < dt.files.length; i++) {
        var file = dt.files[i];
        if (file && typeof file.path === 'string' && file.path) { out.push(file.path); }
      }
    }
    return out;
  }

  function transferHasFiles(event) {
    var dt = event.dataTransfer;
    if (!dt || !dt.types) { return false; }
    for (var i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === 'Files' || dt.types[i] === 'text/uri-list') { return true; }
    }
    return false;
  }

  function attachPaths(paths) {
    if (paths.length === 0) { return false; }
    if (!currentSessionId) {
      NS.bridge.post({ type: 'error', message: 'Attach File: no session is focused.' });
      return false;
    }
    NS.bridge.postForSession({ type: 'attachPath', paths: paths });
    return true;
  }

  function installFileDrop(root) {
    root.addEventListener('dragover', function (event) {
      if (!transferHasFiles(event)) { return; }
      // Without preventDefault the browser refuses the drop entirely.
      event.preventDefault();
      if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy'; }
      root.classList.add('drop-active');
    });
    root.addEventListener('dragleave', function (event) {
      // Fires for descendant transitions too; only the root leaving counts.
      if (event.target === root) { root.classList.remove('drop-active'); }
    });
    root.addEventListener('drop', function (event) {
      if (!transferHasFiles(event)) { return; }
      event.preventDefault();
      root.classList.remove('drop-active');
      if (!attachPaths(pathsFromTransfer(event.dataTransfer))) {
        NS.bridge.post({ type: 'error', message: 'Could not read the dropped file location. Use ACP (Custom): Attach File instead.' });
      }
    });
  }

  function installImagePaste(input) {
    if (!input) { return; }
    // [CUSTOM-20260928-096] 剪贴板里的位图是无路径的 Blob，读成 data URL 交给宿主；
    // 有路径的文件粘贴仍走 attachPaths（现状）。
    input.addEventListener('paste', function (event) {
      var dt = event.clipboardData;
      if (!dt || !dt.files || dt.files.length === 0) { return; }
      var paths = pathsFromTransfer(dt);
      if (paths.length === 0) {
        var file = dt.files[0];
        if (file && typeof FileReader !== 'undefined' && (!file.type || file.type.indexOf('image/') === 0)) {
          event.preventDefault();
          var reader = new FileReader();
          reader.onload = function () {
            attachImage(file.name || 'pasted-image.png', file.type || 'image/png', String(reader.result));
          };
          reader.readAsDataURL(file);
          return;
        }
        event.preventDefault();
        NS.bridge.post({ type: 'error', message: 'Could not read the pasted file. Drop it into the panel, or use ACP (Custom): Attach File.' });
        return;
      }
      event.preventDefault();
      attachPaths(paths);
    });
  }

  // [CUSTOM-20260928-096] 把剪贴板位图作为 image 附件发到宿主。缩略图留客户端本地缓存，
  // 全图 base64 交给宿主（宿主内存持有、发送时拼进 image ContentBlock）。
  function attachImage(name, mimeType, dataUrl) {
    if (!currentSessionId) {
      NS.bridge.post({ type: 'error', message: 'Attach Image: no session is focused.' });
      return;
    }
    var id = 'img-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    if (NS.composer && NS.composer.rememberImage) { NS.composer.rememberImage(id, dataUrl); }
    NS.bridge.postForSession({ type: 'attachImage', id: id, name: name, mimeType: mimeType, dataUrl: dataUrl });
  }

  /**
   * [CUSTOM-20260930-152] 让表单抽屉与记录对账。
   *
   * 抽屉**不是**真相：pending 的表单就是 transcript 里的一条记录，所以"该不该显示、显示哪一条"
   * 每次都由记录算出来。这样切会话 / 重挂载 / 双 surface 都不需要宿主参与，也不需要新协议。
   * 模块或容器缺失时静默跳过（桩 DOM 里没有 #elicDrawer）。
   */
  function syncElicitations() {
    if (!NS.elicitationView) { return; }
    // 会话身份先同步过去：抽屉据此只显示**属于当前会话**的表单（表单记录可能还躺在转录里，
    // 但那是别的会话的事）。放在这个唯一的入口上，就不必在每个调用点各记一次。
    if (NS.elicitationView.setSession) { NS.elicitationView.setSession(currentSessionId); }
    if (NS.elicitationView.sync) { NS.elicitationView.sync(); }
  }

  /**
   * [CUSTOM-20261001-158] 让权限抽屉与记录对账。与 syncElicitations 逐条同构（同一份理由：
   * 抽屉不是真相，pending 的权限就是转录里的一条记录），两个抽屉各有自己的模块与容器。
   */
  function syncPermissions() {
    if (!NS.permissionDrawer) { return; }
    if (NS.permissionDrawer.setSession) { NS.permissionDrawer.setSession(currentSessionId); }
    if (NS.permissionDrawer.sync) { NS.permissionDrawer.sync(); }
  }

  /**
   * [CUSTOM-20261001-158] 两个抽屉的**唯一**对账入口。所有"记录可能变了"的地方都调它，
   * 而不是分别记着"这里要同步表单、那里要同步权限"——那正是"漏了一处"的写法（pitfall #19）。
   */
  function syncDrawers() {
    syncElicitations();
    syncPermissions();
  }

  /**
   * [CUSTOM-20261001-154] 清空记录 —— 抽屉必须跟着对账。
   *
   * 抽屉是**记录的一部分**（记录驱动），所以记录被清掉就等于抽屉该收起来了。这个包装存在的
   * 理由是一次真实的漏修：切到草稿页（focusDraft）只调了 reset，抽屉于是留在屏幕上
   * （用户 2026-10-01 的图2 就是那个状态 —— 面板停在草稿页，浮框还在）。以后凡是清记录的地方
   * 都走这里，别再单独调 reset。
   */
  function resetTranscript() {
    NS.transcriptView.reset();
    syncDrawers();
  }

  function init() {
    emptyState = NS.dom.qs('emptyState');
    loadOverlay = NS.dom.qs('loadOverlay');

    NS.scroll.init(NS.dom.qs('messages'), NS.dom.qs('jumpToLatest'));
    NS.transcriptView.init(NS.dom.qs('messages'));
    // [CUSTOM-20260924-021]
    NS.outline.init(NS.dom.qs('messages'), NS.dom.qs('outline'), NS.dom.qs('outlineBtn'));
    // [CUSTOM-20260924-023]
    NS.rail.init(NS.dom.qs('messages'), NS.dom.qs('rail'), NS.dom.qs('railTrack'));
    // [CUSTOM-20260930-123] 连接状态卡（取代 sessionMenu 里的空态按钮）。
    if (NS.stateCard) { NS.stateCard.init(); }
    // [CUSTOM-20260930-152] 表单抽屉：接管 #elicDrawer 的委托点击 / Escape / 高度让位。
    if (NS.elicitationView) { NS.elicitationView.init(); }
    // [CUSTOM-20261001-158] 权限抽屉：接管 #permDrawer 的 Review 委托与高度让位。
    if (NS.permissionDrawer) { NS.permissionDrawer.init(); }
    // [CUSTOM-20260925-032/033] Connect button (empty state) + history picker.
    NS.sessionMenu.init();
    // [CUSTOM-20260925-058] Directory drawer for the draft page.
    NS.directoryMenu.init();
    NS.tabs.init();
    NS.composer.init();
    NS.links.installDelegatedHandlers(document.body);
    // [CUSTOM-20260925-067] Menu with context-appropriate items (no Cut/Paste).
    NS.contextMenu.install();
    // [CUSTOM-20260928-097] 图片点击放大（lightbox）。
    if (NS.lightbox) { NS.lightbox.install(); }
    // [CUSTOM-20260928-102] 最近一条用户消息悬浮置顶。
    if (NS.stickyUser) { NS.stickyUser.init(); }
    // [CUSTOM-20260925-049]
    installFileDrop(document.body);
    installImagePaste(NS.dom.qs('promptInput'));

    // [CUSTOM-20260925-047] 'composer.focusInput()' existed but was never
    // called anywhere: focusing the chat view (the acpc-chat.focus keybinding,
    // or the automatic reveal when a file is attached) left the caret on
    // <body>, so the user had to click the textarea before typing — which made
    // the keybinding only half useful. Move the caret when the document gains
    // focus, but only if the composer can actually accept input and the user is
    // not in the middle of selecting transcript text.
    window.addEventListener('focus', function () {
      if (!NS.composer.isComposable()) { return; }
      var selection = window.getSelection && window.getSelection();
      if (selection && selection.type === 'Range') { return; }
      NS.composer.focusInput();
    });

    // Sub-agent grouping: default ON (grouped), user-switchable.
    var ui = recallUi();
    applyGrouping(ui.flatTools === true);
    var nestToggle = NS.dom.qs('nestToggle');
    if (nestToggle) {
      nestToggle.addEventListener('click', function () {
        var messages = NS.dom.qs('messages');
        var flat = !(messages && messages.classList.contains('flat-tools'));
        applyGrouping(flat);
        persistUi({ flatTools: flat });
      });
    }

    // [CUSTOM-20260925-065] Wall-clock stamps per record, off by default.
    // A CLASS on #messages rather than re-rendering: the .rec-time spans are always
    // in the DOM (see transcriptView.place), so toggling is a pure style flip —
    // exactly the mechanism applyGrouping above uses.
    applyTimes(ui.showTimes === true);
    var timeToggle = NS.dom.qs('timeToggle');
    if (timeToggle) {
      timeToggle.addEventListener('click', function () {
        var messages = NS.dom.qs('messages');
        var on = !(messages && messages.classList.contains('show-times'));
        applyTimes(on);
        persistUi({ showTimes: on });
      });
    }

    window.addEventListener('message', onMessage);
    NS.bridge.post({ type: 'ready' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.__acpc = window.__acpc || {});
`;
