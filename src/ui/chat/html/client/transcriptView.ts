// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 记录渲染：user / assistant / thought / tool / plan / content / notice 七类。
// 维护 entryId → {对象, DOM 节点} 映射，使 revise / toolUpdate 能就地打补丁而不是重绘整条时间线。
// 同时追踪「还没有渲染成 HTML 的 assistant 记录」，由扩展侧 SafeMarkdown 往返渲染
// （CSP 只允许带 nonce 的内联脚本，marked 不能进 webview 包）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const transcriptViewClient = `
(function (NS) {
  'use strict';

  var nodes = {};
  var objects = {};
  var pending = {};
  var sessionId = null;
  var messagesEl = null;

  // Only these keys may be copied onto a stored entry. Narrowing the write
  // prevents a future message shape from silently corrupting entry objects.
  var PATCH_KEYS = ['text', 'html', 'streaming', 'elapsedMs', 'plan', 'content'];

  function init(container) {
    messagesEl = container;
  }

  function reset() {
    nodes = {};
    objects = {};
    pending = {};
    // Must be cleared too: a stale id would tag the next markdown batch with
    // the previous session, and the extension would render it for a session
    // the webview then filters out.
    sessionId = null;
    if (messagesEl) { NS.dom.clear(messagesEl); }
  }

  function hasPending() {
    for (var key in pending) {
      if (Object.prototype.hasOwnProperty.call(pending, key)) { return true; }
    }
    return false;
  }

  function markPending(entry) {
    if (entry.kind === 'assistant' && entry.text && (entry.html === undefined || entry.html === null)) {
      pending[entry.id] = entry.text;
    }
  }

  function flushPending() {
    if (!hasPending() || !NS.boot) { return; }
    NS.boot.requestMarkdown();
  }

  function buildThought(entry) {
    var details = document.createElement('details');
    details.className = 'thought';
    details.open = !!entry.streaming;
    var summary = document.createElement('summary');
    if (entry.streaming) {
      summary.appendChild(NS.dom.el('span', 'thought-spin'));
      summary.appendChild(document.createTextNode('Thinking\\u2026'));
    } else {
      summary.appendChild(document.createTextNode(thoughtLabel(entry)));
    }
    details.appendChild(summary);
    details.appendChild(NS.dom.el('div', 'thought-body', entry.text));
    return details;
  }

  function thoughtLabel(entry) {
    var seconds = Math.max(0, Math.round((entry.elapsedMs || 0) / 1000));
    return seconds > 0 ? 'Thought for ' + seconds + 's' : 'Thought';
  }

  function buildPlan(entry) {
    var wrap = NS.dom.el('div', 'plan');
    wrap.appendChild(NS.dom.el('div', 'plan-title', 'Plan'));
    var entries = entry.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var item = entries[i];
      var mark = item.status === 'completed' ? '\\u2713' : (item.status === 'in_progress' ? '\\u25d0' : '\\u25cb');
      var row = NS.dom.el('div', 'plan-row ' + (item.status || 'pending'));
      row.appendChild(NS.dom.el('span', 'plan-mark', mark));
      row.appendChild(NS.dom.el('span', 'plan-text', item.content || ''));
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Non-text message content (image / resource / …) in its own entry. */
  function buildContent(entry) {
    var wrap = NS.dom.el('div', 'entry entry-content');
    var blocks = entry.blocks || [];
    if (blocks.length === 0) {
      wrap.appendChild(NS.dom.el('div', 'tool-text', '(empty content)'));
      return wrap;
    }
    for (var i = 0; i < blocks.length; i++) {
      wrap.appendChild(NS.toolCallView.renderContentItem({ type: 'content', block: blocks[i] }));
    }
    return wrap;
  }

  function build(entry) {
    if (entry.kind === 'user') {
      var userEntry = NS.dom.el('div', 'entry entry-user');
      userEntry.appendChild(NS.dom.el('div', 'bubble', entry.text));
      return userEntry;
    }
    if (entry.kind === 'assistant') {
      var aEntry = NS.dom.el('div', 'entry entry-assistant');
      var bubble = NS.dom.el('div', 'bubble');
      applyAssistant(bubble, entry);
      aEntry.appendChild(bubble);
      return aEntry;
    }
    if (entry.kind === 'thought') { return buildThought(entry); }
    if (entry.kind === 'plan') { return buildPlan(entry); }
    if (entry.kind === 'content') { return buildContent(entry); }
    if (entry.kind === 'notice') {
      return NS.dom.el('div', 'entry entry-notice ' + entry.level, entry.text);
    }
    if (entry.kind === 'tool') {
      var placeholder = NS.dom.el('div', 'tool');
      placeholder.setAttribute('data-tool-id', entry.toolCallId);
      return placeholder;
    }
    return NS.dom.el('div', 'entry');
  }

  function applyAssistant(bubble, entry) {
    if (entry.html !== undefined && entry.html !== null) {
      bubble.className = 'bubble md';
      NS.dom.setSanitizedHtml(bubble, entry.html);
      NS.links.decorateCodeBlocks(bubble);
    } else {
      bubble.className = 'bubble';
      bubble.textContent = entry.text || '';
    }
  }

  function place(entry, toolView) {
    var node;
    if (entry.kind === 'tool' && toolView) {
      node = NS.toolCallView.render(toolView);
    } else {
      node = build(entry);
    }
    objects[entry.id] = entry;
    nodes[entry.id] = node;
    markPending(entry);
    return node;
  }

  /** Render a full snapshot (session switch, boot). */
  function hydrate(snapshot) {
    reset();
    if (!snapshot) { return; }
    sessionId = snapshot.sessionId;
    var entries = snapshot.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      messagesEl.appendChild(place(entry, entry.toolView));
    }
    NS.toolCallView.refreshGrouping(messagesEl);
    NS.scroll.toBottom();
  }

  /**
   * Append — but be idempotent. The extension re-sends an entry it mutated in
   * place (streaming text lives in one entry), so a blind appendChild would
   * leave an orphaned node behind and duplicate the text.
   */
  function append(entry, toolView) {
    if (!messagesEl) { return; }
    if (objects[entry.id]) {
      if (entry.kind === 'tool' && toolView) {
        updateTool(entry.id, toolView);
      } else {
        patch(entry.id, entry);
      }
      return;
    }
    messagesEl.appendChild(place(entry, toolView));
    if (entry.kind === 'tool') { NS.toolCallView.refreshGrouping(messagesEl); }
    NS.scroll.follow();
  }

  function patch(entryId, changes) {
    var entry = objects[entryId];
    var node = nodes[entryId];
    if (!entry || !node || !changes) { return; }

    for (var i = 0; i < PATCH_KEYS.length; i++) {
      var key = PATCH_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(changes, key)) { entry[key] = changes[key]; }
    }

    if (entry.kind === 'assistant') {
      var bubble = node.querySelector('.bubble');
      if (bubble) { applyAssistant(bubble, entry); }
      if (changes.html !== undefined && changes.html !== null) {
        delete pending[entryId];
      } else if (entry.streaming === false && entry.text) {
        pending[entryId] = entry.text;
        flushPending();
      }
    } else if (entry.kind === 'thought') {
      var body = node.querySelector('.thought-body');
      if (body) { body.textContent = entry.text || ''; }
      var summary = node.querySelector('summary');
      if (summary && entry.streaming === false) {
        NS.dom.clear(summary);
        summary.appendChild(document.createTextNode(thoughtLabel(entry)));
      }
    } else if (entry.kind === 'plan') {
      var rebuilt = buildPlan(entry);
      node.parentNode.replaceChild(rebuilt, node);
      nodes[entryId] = rebuilt;
    } else if (entry.kind === 'content') {
      var rebuiltContent = buildContent(entry);
      node.parentNode.replaceChild(rebuiltContent, node);
      nodes[entryId] = rebuiltContent;
    }
    NS.scroll.follow();
  }

  function updateTool(entryId, tool) {
    var node = nodes[entryId];
    if (!node) { return; }
    NS.toolCallView.update(node, tool);
    NS.scroll.follow();
  }

  /** Assistant entries still awaiting markdown, for the extension round-trip. */
  function pendingMarkdown() {
    var out = [];
    for (var id in pending) {
      if (Object.prototype.hasOwnProperty.call(pending, id)) {
        out.push({ entryId: id, sessionId: sessionId, text: pending[id] });
      }
    }
    return out;
  }

  NS.transcriptView = {
    init: init,
    reset: reset,
    hydrate: hydrate,
    append: append,
    patch: patch,
    updateTool: updateTool,
    pendingMarkdown: pendingMarkdown
  };
})(window.__acpc = window.__acpc || {});
`;
