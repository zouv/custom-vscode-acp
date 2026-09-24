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
        }
        break;

      case 'append': {
        if (message.sessionId !== currentSessionId) { break; }
        var entries = message.entries || [];
        for (var i = 0; i < entries.length; i++) {
          NS.transcriptView.append(entries[i], entries[i].toolView);
        }
        if (entries.length > 0) { showEmpty(false); }
        break;
      }

      case 'revise':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.patch(message.entryId, message.patch);
        }
        break;

      case 'toolUpdate':
        if (message.sessionId === currentSessionId) {
          NS.transcriptView.updateTool(message.entryId, message.tool);
        }
        break;

      case 'markdownRendered': {
        var items = message.items || [];
        for (var j = 0; j < items.length; j++) {
          if (items[j].sessionId !== currentSessionId) { continue; }
          NS.transcriptView.patch(items[j].entryId, { html: items[j].html });
        }
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

      case 'error':
        // A background session's failure must not land in the visible
        // transcript. The extension already recorded it in the store, so the
        // only job here is to show it when it belongs to the focused session.
        if (message.sessionId && message.sessionId !== currentSessionId) { break; }
        NS.transcriptView.append(noticeNode('error', message.message));
        showEmpty(false);
        NS.composer.setRunning(false);
        setLoading(false);
        break;

      default:
        break;
    }
  }

  function init() {
    emptyState = NS.dom.qs('emptyState');
    loadOverlay = NS.dom.qs('loadOverlay');

    NS.scroll.init(NS.dom.qs('messages'), NS.dom.qs('jumpToLatest'));
    NS.transcriptView.init(NS.dom.qs('messages'));
    NS.tabs.init();
    NS.composer.init();
    NS.links.installDelegatedHandlers(document.body);

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
