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
    emptyState.style.display = show ? '' : 'none';
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
    NS.tabs.setFocus(summary);
    NS.composer.setFocus(summary, meta);
    NS.tabs.renderUsage(meta);
    // Attachments ride along on meta so they survive a session switch.
    NS.composer.setAttachments((meta && meta.attachments) || []);

    if (!summary) {
      NS.transcriptView.reset();
      showEmpty(true);
      setLoading(false);
      return;
    }

    showEmpty(false);
    setLoading(!!summary.loading);
    if (snapshot) {
      NS.transcriptView.hydrate(snapshot);
    } else {
      NS.transcriptView.reset();
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
    // [CUSTOM-20260925-033] The history list belongs to the previous agent.
    NS.sessionMenu.reset();
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
    if (!currentSessionId) { return; }
    var pending = NS.transcriptView.pendingMarkdown();
    if (pending.length === 0) { return; }
    NS.bridge.post({ type: 'renderMarkdown', items: pending });
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
    NS.transcriptView.reset();
    showEmpty(false);
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
    if (neighbour) { focusDraft(neighbour.draftId); return; }
    // Nothing local left: fall back to a live session, else to the empty state.
    if (NS.tabs.focusFirstSession && NS.tabs.focusFirstSession()) { renderDrafts(); return; }
    currentSessionId = null;
    NS.tabs.setFocus(null);
    NS.composer.setFocus(null, null);
    NS.transcriptView.reset();
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
    NS.transcriptView.append(noticeNode('error', message));
    showEmpty(false);
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
    get: draftById
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

  function onMessage(event) {
    var message = event.data;
    if (!message || !message.type) { return; }

    switch (message.type) {
      case 'boot':
        NS.tabs.setSessions(message.sessions || []);
        applyFocus(message.focused, message.snapshot, message.meta);
        syncFocusedState(message.sessions || []);
        break;

      case 'sessionsChanged':
        NS.tabs.setSessions(message.sessions || []);
        syncFocusedState(message.sessions || []);
        break;

      case 'focus':
        applyFocus(message.summary, message.snapshot, message.meta);
        break;

      case 'sessionClosed':
        if (message.sessionId === currentSessionId) {
          currentSessionId = null;
          NS.transcriptView.reset();
          showEmpty(true);
          NS.outline.invalidate();
          NS.rail.invalidate();
        }
        // [CUSTOM-20260924-022] Drop the remembered position of a session that
        // no longer exists (ids are never reused, so this is pure hygiene).
        NS.scroll.forget(message.sessionId);
        // [CUSTOM-20260925-050] Same for its draft.
        NS.composer.forgetDraft(message.sessionId);
        break;

      case 'append': {
        if (message.sessionId !== currentSessionId) { break; }
        var entries = message.entries || [];
        for (var i = 0; i < entries.length; i++) {
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
        break;
      }

      case 'revise':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.patch(message.entryId, message.patch);
          NS.outline.invalidate();
          NS.rail.invalidate();
        }
        break;

      case 'toolUpdate':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.updateTool(message.entryId, message.tool);
          // [CUSTOM-20260924-023] A tool's status is what colours its rail dot.
          NS.rail.invalidate();
        }
        break;

      case 'markdownRendered': {
        var items = message.items || [];
        for (var j = 0; j < items.length; j++) {
          if (items[j].sessionId !== currentSessionId) { continue; }
          NS.transcriptView.patch(items[j].entryId, { html: items[j].html });
        }
        // [CUSTOM-20260924-022] Markdown grew the transcript, so a restored
        // scroll position has to be re-applied (no-op once the user scrolled).
        NS.scroll.reassert();
        // [CUSTOM-20260924-023] ...and the rail's cached dot positions are stale
        // (text became HTML, heights changed). Measure-only, no rebuild.
        NS.rail.reflow();
        break;
      }

      case 'meta':
        if (message.sessionId === currentSessionId) {
          NS.composer.setMeta(message.meta);
          NS.tabs.renderUsage(message.meta);
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

      case 'draftFailed':
        failDraft(message.draftId, message.message);
        break;

      case 'error':        // A background session's failure must not land in the visible
        // transcript. The extension already recorded it in the store, so the
        // only job here is to show it when it belongs to the focused session.
        if (message.sessionId && message.sessionId !== currentSessionId) { break; }
        NS.transcriptView.append(noticeNode('error', message.message));
        showEmpty(false);
        NS.composer.setRunning(false);
        setLoading(false);
        NS.outline.invalidate();
        NS.rail.invalidate();
        break;

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
    // A pasted image is a Blob with no filesystem path. Writing those bytes
    // somewhere is a separate feature (it needs a managed attachment directory
    // and a cleanup policy), so this says so instead of doing nothing.
    input.addEventListener('paste', function (event) {
      var dt = event.clipboardData;
      if (!dt || !dt.files || dt.files.length === 0) { return; }
      var paths = pathsFromTransfer(dt);
      if (paths.length === 0) {
        event.preventDefault();
        NS.bridge.post({ type: 'error', message: 'Pasting images is not supported yet - drop the file into the panel, or use ACP (Custom): Attach File.' });
        return;
      }
      event.preventDefault();
      attachPaths(paths);
    });
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
    // [CUSTOM-20260925-032/033] Connect button (empty state) + history picker.
    NS.sessionMenu.init();
    // [CUSTOM-20260925-058] Directory drawer for the draft page.
    NS.directoryMenu.init();
    NS.tabs.init();
    NS.composer.init();
    NS.links.installDelegatedHandlers(document.body);
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
