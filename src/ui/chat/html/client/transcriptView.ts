// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 记录渲染：user / assistant / thought / tool / plan / content / notice / permission 八类。
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
  // [CUSTOM-20260924-021] Explicit append order. Object key order is NOT usable
  // here: entry ids are strings but Object.keys ordering guarantees only cover
  // integer-like keys, and the outline must list turns in the order they were
  // placed (a mis-ordered outline silently jumps to the wrong message).
  var order = [];
  // [CUSTOM-20260924-022] entryId -> { text, node }: the streaming text tail we
  // can extend in place instead of rewriting the whole string per chunk.
  var tails = {};
  // [CUSTOM-20260924-027] entryId -> true once we have asked the extension for
  // a tool view model (ask once; a missing invocation must not loop).
  var requestedViews = {};
  // [CUSTOM-20260926-071] entryId -> record node, for user messages whose fold was
  // decided by the fallback proxy because the panel had no layout yet. Cleared by
  // resolvePendingFolds (or reset).
  var pendingFolds = {};
  // [CUSTOM-20260925-045] Running count of user entries. The outline's "is
  // there anything to navigate?" check used to walk EVERY entry on every
  // append/revise — and 'append'/'revise' fire per streamed message. Counting
  // here (the only place entries are added) makes it O(1). Maintained in
  // place() and zeroed in reset(); 'patch' never changes an entry's kind, so
  // the count cannot drift.
  var userCount = 0;
  // [CUSTOM-20260926-076] 大纲现在收 user+assistant（不再只收 user），这条计数也
  // 覆盖两者。与 userCount 并列：userCount 仍是 rail/其它路径的语义，别合并。
  var messageCount = 0;
  // [CUSTOM-20260925-048] Screen-reader pacing. 'aria-live' on #messages would
  // otherwise announce EVERY streamed chunk (the bubble's text is rewritten
  // dozens of times per reply, and a reader would hear the whole answer
  // repeatedly from the start). 'aria-busy=true' while any entry is still
  // streaming makes assistive tech defer announcements until the entry settles,
  // at which point the finished text is announced once — which is what a reader
  // actually wants. A counter rather than a scan, because this is updated on
  // every streamed chunk.
  var streamingCount = 0;
  var lastBusy = null;

  // Only these keys may be copied onto a stored entry. Narrowing the write
  // prevents a future message shape from silently corrupting entry objects.
  // [CUSTOM-20260925-038] 这四个替换型键名必须与**记录字段名**逐字相同
  // （plan -> entries / content -> blocks）。曾经写的是 'plan' / 'content'，
  // 于是 patch 落进 entry.plan 而 buildPlan 读 entry.entries —— 更新静默丢弃
  // （patch() 不认识的那个键只是被拷进对象，没有任何报错）。
  // 改这里之前先对照 src/ui/chat/transcript/types.ts 的 EntryPatch。
  var PATCH_KEYS = ['text', 'html', 'streaming', 'elapsedMs', 'entries', 'blocks', 'permission'];

  function init(container) {
    messagesEl = container;
  }

  // --- 时间显示（CUSTOM-20260925-065）--------------------------------------
  // 每条记录都已经带 'at'（TranscriptStore 在 append 时打的时间戳），只是从来没显示过。
  // 两个层次：**hover 看完整时刻**（零成本、零噪声），以及头部「Times」开关打开后
  // 每条前面显示 HH:MM。

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function clockLabel(at) {
    if (!at) { return ''; }
    var d = new Date(at);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fullStamp(at) {
    if (!at) { return ''; }
    var d = new Date(at);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // 时长的格式化在 NS.dom.duration（最底层模块）——toolCallView 也要用，而模块加载顺序
  // 只允许依赖指向前方。

  /** [CUSTOM-20260925-048] Reflect the streaming state; writes only on change. */
  function refreshBusy() {
    if (!messagesEl) { return; }
    var busy = streamingCount > 0 ? 'true' : 'false';
    if (busy === lastBusy) { return; }
    lastBusy = busy;
    messagesEl.setAttribute('aria-busy', busy);
  }

  // [CUSTOM-20260925-044] The coalescer moved into toolCallView (it owns
  // refreshGrouping, so it should own the coalescing too, and update() needs it
  // as well). This stays as the transcript's own entry point so the messages
  // container is resolved in exactly one place.
  function refreshGroupingSoon() {
    if (messagesEl) { NS.toolCallView.refreshGroupingSoon(messagesEl); }
  }

  function reset() {
    nodes = {};
    objects = {};
    pending = {};
    order = [];
    tails = {};
    requestedViews = {};
    pendingFolds = {};
    userCount = 0;
    messageCount = 0;
    streamingCount = 0;
    // Must be cleared too: a stale id would tag the next markdown batch with
    // the previous session, and the extension would render it for a session
    // the webview then filters out.
    sessionId = null;
    if (messagesEl) { NS.dom.clear(messagesEl); }
    // [CUSTOM-20260926-070] Those nodes are gone: drop their layout observations
    // too. ResizeObserver holds strong references to what it observes, so a
    // session switch would otherwise keep every discarded node alive.
    if (NS.rail && NS.rail.resetNodes) { NS.rail.resetNodes(); }
    refreshBusy();
    // [CUSTOM-20260925-066] Rendered tool HTML belongs to the previous session.
    if (NS.toolCallView && NS.toolCallView.resetMarkdown) { NS.toolCallView.resetMarkdown(); }
  }

  function hasPending() {
    for (var key in pending) {
      if (Object.prototype.hasOwnProperty.call(pending, key)) { return true; }
    }
    return false;
  }

  function markPending(entry) {
    var text = entry.text;
    if (!text) { return; }
    if (entry.html !== undefined && entry.html !== null && entry.html !== '') { return; }
    if (entry.kind === 'assistant') { pending[entry.id] = text; return; }
    // [CUSTOM-20260926-072] A thought renders markdown through the same round-trip,
    // but only once it has SETTLED: html for a block that is still streaming would
    // freeze a prefix of the text while the stream keeps appending. A settled
    // thought collapses immediately anyway, so the reader sees the rendered form
    // rather than a flicker. markPending runs for every placed record, so this also
    // covers records hydrated from a snapshot (replay / session switch).
    if (entry.kind === 'thought' && entry.streaming === false) { pending[entry.id] = text; }
  }

  function flushPending() {
    if (!hasPending() || !NS.boot) { return; }
    NS.boot.requestMarkdown();
  }

  /**
   * [CUSTOM-20260925-061] The fold triangle for a <details>.
   *
   * A REAL element rather than 'summary::before': a pseudo-element always paints
   * BEFORE the content, so the type icon (which icons.attach prepends to the
   * summary) ended up to the LEFT of the caret. Building the caret first and
   * letting the icon prepend itself yields [icon][caret][label].
   *
   * It is empty on purpose - the glyph and its direction are CSS-driven off the
   * parent's [open] state, so toggling needs no JS.
   */
  function foldCaret() {
    return NS.dom.el('span', 'fold-caret');
  }

  function buildThought(entry) {
    var details = document.createElement('details');
    details.className = 'thought';
    details.open = !!entry.streaming;
    var summary = document.createElement('summary');
    summary.appendChild(foldCaret());
    if (entry.streaming) {
      summary.appendChild(NS.dom.el('span', 'thought-spin'));
      summary.appendChild(document.createTextNode('Thinking\\u2026'));
    } else {
      summary.appendChild(document.createTextNode(thoughtLabel(entry)));
    }
    details.appendChild(summary);
    var body = NS.dom.el('div', 'thought-body');
    applyThoughtBody(body, entry);
    details.appendChild(body);
    return details;
  }

  /**
   * [CUSTOM-20260926-072] The reasoning body: same markdown round-trip as an
   * assistant bubble (extension-side SafeMarkdown, client-side sanitize), so the
   * agent's backticks and '- ' list markers stop showing up as literal text.
   *
   * Falls back to the raw text while the block is streaming, and when html has not
   * arrived yet - which is also what makes a stored snapshot without html render.
   */
  function applyThoughtBody(body, entry) {
    var hasHtml = entry.html !== undefined && entry.html !== null && entry.html !== '';
    if (hasHtml) {
      // The bubble is now HTML: any text node we were appending to is gone, so the
      // delta bookkeeping must go with it (same rule as applyAssistant).
      delete tails[entry.id];
      body.className = 'thought-body md';
      NS.dom.setSanitizedHtml(body, entry.html);
      NS.links.decorateScrollables(body);
      return;
    }
    body.className = 'thought-body';
    setStreamingText(body, entry.id, entry.text || '');
  }

  /**
   * [CUSTOM-20260926-072] Markdown bookkeeping for a record that renders through
   * the round-trip. Shared by the assistant and thought branches because they need
   * the same two rules:
   *   · html arrived -> stop asking for it (otherwise every later patch re-renders);
   *   · the record settled WITHOUT html -> ask now. The finalize patch carries only
   *     { streaming, elapsedMs }, so a check that looked at 'html' alone would never
   *     ask for a thought's markdown at all.
   */
  function trackMarkdown(entryId, entry, changes) {
    if (changes.html !== undefined && changes.html !== null) {
      delete pending[entryId];
      return;
    }
    if (entry.streaming === false && entry.text) {
      pending[entryId] = entry.text;
      flushPending();
    }
  }

  /**
   * [CUSTOM-20260925-061] A multi-line USER message folds like a thought block.
   *
   * The first line lives in the <summary> and the REST live in the body - the
   * whole text is deliberately NOT repeated, which would show it twice while
   * expanded.
   *
   * A single-line message gets no fold affordance at all: there is nothing to
   * fold, and a permanent triangle on every short message is pure noise.
   *
   * Open by default: a message the user just sent must not appear hidden.
   *
   * [CUSTOM-20260925-064] The body is an INLINE span, so expanding continues the
   * same text flow: the split point is an implementation detail and must not show
   * up as an extra line break.
   *
   * [CUSTOM-20260926-071] The judgement is no longer "is there a \\n / is the text
   * longer than N chars". Both of those are PROXIES for "does it look multi-line",
   * and a proxy is blind to the case the user reported twice: a message with no
   * newline anywhere (shorter than any threshold) that wraps to three lines in a
   * narrow sidebar. Pitfalls #25, one round later.
   *
   * So the direct signal is used instead: the folded structure is built FIRST
   * (caret and icon present - they take horizontal room, and building them later
   * would measure a different width than the one that renders), inserted, and then
   * MEASURED. If it turns out to occupy one line, it is reverted to a plain bubble.
   */
  function buildUserBubble(entry) {
    var details = document.createElement('details');
    details.className = 'user-fold';
    details.open = true;
    var summary = NS.dom.el('summary', 'bubble');
    // Caret before the label, so the prepended icon lands leftmost (see foldCaret).
    summary.appendChild(foldCaret());
    summary.appendChild(document.createTextNode(entry.text || ''));
    details.appendChild(summary);
    return details;
  }

  /** The text node of a summary, skipping the caret span and the type icon. */
  function textNodeOf(host) {
    for (var i = 0; i < host.childNodes.length; i++) {
      if (host.childNodes[i].nodeType === 3) { return host.childNodes[i]; }
    }
    return null;
  }

  /**
   * Line boxes covered by text[0..len) of this text node, or 0 when unmeasurable
   * (no createRange, or the node has no layout yet - a hidden panel reports height
   * 0 for everything).
   *
   * A range ending exactly at a line boundary can report an extra zero-height rect
   * on the following line. Counting those would make every prefix look like it
   * spilled onto two lines, which is why they are filtered rather than counted.
   */
  function rangeLines(textNode, len) {
    if (!textNode || !document.createRange) { return 0; }
    var range;
    try {
      range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, len);
    } catch (e) { return 0; }
    var rects = range.getClientRects ? range.getClientRects() : null;
    if (!rects) { return 0; }
    var lines = 0;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height > 0) { lines++; }
    }
    return lines;
  }

  /** Longest prefix of the text that still sits on ONE rendered line (or -1). */
  function firstLineEnd(textNode, text) {
    // Every probe walks the whole text node, so a pathological 64KB message (the
    // store's per-entry clamp) is not worth probing: let the caller fall back.
    if (text.length > FOLD_MEASURE_LIMIT) { return -1; }
    var lo = 1;
    var hi = text.length;
    var best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (rangeLines(textNode, mid) <= 1) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  }

  /** Pull a measured split back to a word boundary (and off a surrogate pair). */
  function tidySplit(text, split) {
    if (split <= 0) { return 0; }
    if (split >= text.length) { return 0; }
    var space = text.lastIndexOf(' ', split);
    if (space > split / 2) { split = space + 1; }
    // Never cut a surrogate pair in half: the two halves would render as two
    // replacement glyphs once summary and body are separate nodes.
    var code = text.charCodeAt(split - 1);
    if (code >= 0xd800 && code <= 0xdbff) { split--; }
    return split;
  }

  /** A logical line break with something visible after it: multi-line by definition. */
  function newlineSplit(text) {
    var nl = text.indexOf('\\n');
    if (nl < 0) { return null; }
    if (NS.toolCallView.isBlank(text.slice(nl + 1))) { return null; }
    return { split: nl, drop: 1 };
  }

  /** Roughly one panel width worth of text (fallback only, see planFold). */
  var FOLD_PREVIEW_CHARS = 160;
  /** Above this length the layout probe is skipped in favour of the fallback. */
  var FOLD_MEASURE_LIMIT = 2000;

  /** [CUSTOM-20260925-064] The old proxy judgement, kept for the unmeasurable case. */
  function heuristicFold(text) {
    var hard = newlineSplit(text);
    if (hard) { return hard; }
    if (text.length <= FOLD_PREVIEW_CHARS) { return null; }
    // Prefer a word boundary: the expanded body continues from here, so cutting a
    // word in half would be visible once it is expanded.
    var head = text.slice(0, FOLD_PREVIEW_CHARS);
    var space = head.lastIndexOf(' ');
    return { split: space > FOLD_PREVIEW_CHARS / 2 ? space + 1 : FOLD_PREVIEW_CHARS, drop: 0 };
  }

  /**
   * [CUSTOM-20260926-071] Where to fold this message, plus whether the answer came
   * from a real measurement.
   *
   * 'drop' is the number of characters AT the split that belong to neither half.
   * It is 1 when the split lands on a line break: the boundary between <summary>
   * and the body already renders as a line break, so keeping the '\\n' as well
   * would add one blank line the moment the block is expanded.
   *
   * Order: a logical break wins (exact, and no measurement can improve on it), then
   * the measured line count, then - only when nothing can be measured - the old
   * proxy, flagged so the caller can re-decide later.
   */
  function planFold(textNode, text) {
    var hard = newlineSplit(text);
    if (hard) { return { plan: hard, measured: true }; }
    if (textNode) {
      var total = rangeLines(textNode, text.length);
      if (total > 0) {
        if (total <= 1) { return { plan: null, measured: true }; }
        var tidied = tidySplit(text, firstLineEnd(textNode, text));
        if (tidied > 0) { return { plan: { split: tidied, drop: 0 }, measured: true }; }
      }
    }
    return { plan: heuristicFold(text), measured: false };
  }

  /** Replace a folded record with a plain bubble (measured as one line after all). */
  function unfoldUser(wrapper, details, text) {
    var bubble = NS.dom.el('div', 'bubble', text);
    var summary = details.querySelector('summary');
    putIcon(bubble, summary ? takeIcon(summary) : null);
    if (details.parentNode === wrapper) {
      wrapper.insertBefore(bubble, details);
      wrapper.removeChild(details);
    }
  }

  /**
   * [CUSTOM-20260926-071] Decide and apply one user record's fold. MUST run after
   * the record is in the DOM: the decision is a measurement.
   *
   * Idempotent, and safe to call again: it restores the pristine text into the
   * summary before re-deciding, so the re-decide path (resolvePendingFolds) sees
   * the same input the first pass did.
   */
  function settleUserFold(wrapper, entry) {
    if (!wrapper || !wrapper.querySelector) { return; }
    var text = entry.text || '';
    var details = wrapper.querySelector('details.user-fold');
    var summary = details ? details.querySelector('summary') : null;
    var textNode = summary ? textNodeOf(summary) : null;
    if (!details || !textNode) {
      // First pass: the caller put a plain bubble (or nothing) here.
      details = buildUserBubble(entry);
      // NOT firstElementChild: place() prepends the .rec-time stamp, so that would
      // be the timestamp span and this would DELETE it. Ask for the bubble instead —
      // the same trap the test helper hit (CUSTOM-20260925-068).
      var previous = wrapper.querySelector('.bubble, details.user-fold');
      if (previous) {
        putIcon(details.querySelector('summary'), takeIcon(previous));
        wrapper.removeChild(previous);
      }
      wrapper.appendChild(details);
      summary = details.querySelector('summary');
      textNode = summary ? textNodeOf(summary) : null;
    } else {
      var body = details.querySelector('.fold-body');
      if (body) { details.removeChild(body); }
      textNode.data = text;
    }
    var decided = planFold(textNode, text);
    // 'heuristic' is a promise to try again once the panel has a real size; see
    // resolvePendingFolds. 'done' means the answer came from layout and is final.
    wrapper.setAttribute('data-fold', decided.measured ? 'done' : 'heuristic');
    if (!decided.measured) { pendingFolds[entry.id] = wrapper; }
    if (!decided.plan) {
      unfoldUser(wrapper, details, text);
      return;
    }
    if (textNode) { textNode.data = text.slice(0, decided.plan.split); }
    details.appendChild(NS.dom.el('span', 'fold-body', text.slice(decided.plan.split + decided.plan.drop)));
  }

  /**
   * [CUSTOM-20260926-071] Re-decide the records whose fold came from the fallback
   * proxy because they were hydrated while the panel had no layout (background
   * editor group, webview not yet revealed). Called by the rail's ResizeObserver -
   * which observes exactly the event we are waiting for (a record getting a real
   * size) - and one-shot per record: a measured answer is final.
   */
  function resolvePendingFolds() {
    for (var id in pendingFolds) {
      if (!Object.prototype.hasOwnProperty.call(pendingFolds, id)) { continue; }
      var node = pendingFolds[id];
      var entry = objects[id];
      if (!node || !node.parentNode || !entry) { delete pendingFolds[id]; continue; }
      var box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!box || box.height === 0) { continue; }
      delete pendingFolds[id];
      settleUserFold(node, entry);
    }
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
    var rendered = 0;
    for (var i = 0; i < blocks.length; i++) {
      // [CUSTOM-20260924-026] Blank text blocks are invisible: rendering them
      // left a bare strip behind (the extension now filters them out, this is
      // the backstop for snapshots that already contain one).
      if (blocks[i] && blocks[i].type === 'text' && NS.toolCallView.isBlank(blocks[i].text)) { continue; }
      wrap.appendChild(NS.toolCallView.renderContentItem(
        { type: 'content', block: blocks[i] }, 'c' + i, entry.id));
      rendered++;
    }
    if (rendered === 0) {
      wrap.appendChild(NS.dom.el('div', 'tool-text', '(empty content)'));
    }
    return wrap;
  }

  function build(entry) {
    if (entry.kind === 'user') {
      var userEntry = NS.dom.el('div', 'entry entry-user');
      userEntry.appendChild(buildUserBubble(entry));
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
    // [CUSTOM-20260924-020] Permission card (panel-side replacement for the
    // window-level QuickPick).
    if (entry.kind === 'permission') {
      var permWrap = NS.dom.el('div', 'entry entry-permission');
      permWrap.appendChild(NS.permissionView.render(entry.permission || {}));
      return permWrap;
    }
    // [CUSTOM-END] CUSTOM-20260924-020
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

  // [CUSTOM-20260924-029] The type icon lives INSIDE the content host, so every
  // rewrite of that host (streaming text, markdown html) has to put it back.
  // Keeping it here avoids restructuring any entry's layout.
  function takeIcon(host) {
    var icon = host.querySelector('.rec-icon');
    if (icon && icon.parentNode) { icon.parentNode.removeChild(icon); }
    return icon;
  }

  function putIcon(host, icon) {
    if (icon) { host.insertBefore(icon, host.firstChild); }
  }

  function applyAssistant(bubble, entry) {
    // [CUSTOM-20260925-036] An EMPTY html string is not a rendered message.
    // markdown.render() can return '' (blank-ish input), and treating that as
    // "we have HTML" turned the bubble into an empty bordered box - one of the
    // two shapes the "blank bars" report showed. Fall back to the raw text.
    var hasHtml = entry.html !== undefined && entry.html !== null && entry.html !== '';
    if (hasHtml) {
      // The bubble becomes sanitized HTML: any text node we were appending to
      // is gone, so the delta bookkeeping must go with it.
      delete tails[entry.id];
      var icon = takeIcon(bubble);
      bubble.className = 'bubble md';
      NS.dom.setSanitizedHtml(bubble, entry.html);
      putIcon(bubble, icon);
      NS.links.decorateScrollables(bubble);
      return;
    }
    bubble.className = 'bubble';
    setStreamingText(bubble, entry.id, entry.text || '');
  }

  /**
   * [CUSTOM-20260924-022] Streaming text is monotonic, so a new chunk is almost
   * always "the old string plus a suffix". Re-assigning textContent each time
   * rewrites the whole accumulated reply (O(n^2) per reply) and re-creates the
   * text node. Appending only the suffix keeps it O(delta).
   *
   * Falls back to a full replace whenever the prefix relation does not hold:
   *   · no previous text node (first paint / hydrate / reset / after HTML)
   *   · not a prefix - e.g. the 64KB clamp rewrites the trailing marker
   *   · the host element was replaced (plan/content rebuilds swap nodes)
   */
  function setStreamingText(host, entryId, next) {
    var tail = tails[entryId];
    if (tail && tail.node.parentNode === host && next.length >= tail.text.length
      && next.indexOf(tail.text) === 0) {
      var delta = next.slice(tail.text.length);
      if (delta.length > 0) { tail.node.appendData(delta); }
      tail.text = next;
      return;
    }
    delete tails[entryId];
    var icon = takeIcon(host);
    host.textContent = next;
    putIcon(host, icon);
    // Remember the node we just created so the next chunk can extend it. It is
    // the LAST child now (the icon, when present, sits in front of it).
    var first = host.lastChild;
    if (first && first.nodeType === 3) { tails[entryId] = { text: next, node: first }; }
  }

  /**
   * [CUSTOM-20260924-027] A tool entry without its view model used to render as
   * a bare tool box — an empty shell that updateTool could never repair (it only
   * patches the status / title / body, none of which exist in a shell). That is
   * what "the tool call isn't displayed" looked like.
   *
   * Two things happen here instead: a minimal but *real* card is built from the
   * entry's own id (so it never renders blank), and the extension is asked once
   * for the actual view model — which then arrives as a toolUpdate and patches
   * this card through the normal path.
   */
  function placeholderToolView(entry) {
    if (!requestedViews[entry.id]) {
      requestedViews[entry.id] = true;
      console.warn('[acpc] tool entry without toolView, requesting it:', entry.id, entry.toolCallId);
      NS.bridge.postForSession({ type: 'needToolView', entryId: entry.id, toolCallId: entry.toolCallId });
    }
    return {
      toolCallId: entry.toolCallId,
      title: entry.toolCallId,
      kind: 'other',
      status: 'pending',
      command: null,
      locations: [],
      items: []
    };
  }

  /**
   * [CUSTOM-20260926-070] Let the rail observe this record for layout changes.
   *
   * Called from every place that puts a node into #messages or replaces one: the
   * two creation sites (hydrate / append) and the four rebuild-in-place sites
   * (append's shell -> card, patch's plan, patch's content, updateTool). A missed
   * call is invisible — that record's rail dot simply stops moving after the next
   * unfold, which is the bug this exists to fix. Must run AFTER the node is in the
   * DOM: observing a detached node measures 0 and would park its dot at the top.
   */
  function watchNode(node) {
    if (node && NS.rail && NS.rail.watch) { NS.rail.watch(node); }
  }

  function place(entry, toolView) {
    var node;
    if (entry.kind === 'tool') {
      node = NS.toolCallView.render(toolView || placeholderToolView(entry), entry.id);
    } else {
      node = build(entry);
    }
    // [CUSTOM-20260925-065] The wall-clock stamp of every record. The element is
    // ALWAYS in the DOM; a class on #messages decides whether it is visible (the
    // same mechanism the sub-agent toggle uses), so flipping the toggle never has
    // to re-render anything. Hover shows the full timestamp regardless.
    if (entry.at) {
      node.insertBefore(NS.dom.el('span', 'rec-time', clockLabel(entry.at)), node.firstChild);
      node.title = fullStamp(entry.at);
    }
    // Drives the three-tier spacing ladder in the stylesheet (same-kind blocks
    // sit tight, cross-kind blocks get air, user messages start a new turn).
    node.setAttribute('data-kind', entry.kind);
    // [CUSTOM-20260924-021] Per-entry anchor. The outline (and anything that
    // later needs to find a specific record's DOM node) keys off this instead
    // of re-deriving positions from the entry list.
    node.setAttribute('data-entry-id', entry.id);
    // [CUSTOM-20260924-028] Type icon. Must happen here (not inside the build
    // functions) so it covers hydrate and both append paths at once; attach is
    // idempotent, so the rebuild paths can call it again safely.
    NS.icons.attach(node, entry);
    objects[entry.id] = entry;
    nodes[entry.id] = node;
    order.push(entry.id);
    // [CUSTOM-20260925-045] The one place entries are added, so the one place
    // the outline's anchor count can change.
    if (entry.kind === 'user') { userCount++; }
    if (entry.kind === 'user' || entry.kind === 'assistant') { messageCount++; }
    // [CUSTOM-20260925-048] ...and the one place the streaming count can grow.
    if (entry.streaming) { streamingCount++; }
    refreshBusy();
    markPending(entry);
    return node;
  }

  /** Render a full snapshot (session switch, boot). */
  function hydrate(snapshot) {
    reset();
    if (!snapshot) { return; }
    sessionId = snapshot.sessionId;
    var entries = snapshot.entries || [];
    // [CUSTOM-20260926-071] User-message folds are decided by MEASUREMENT, so they
    // are settled once the whole snapshot is in the DOM - settling inside the loop
    // would force one layout per message while the appends keep re-dirtying it.
    // It is still synchronous: boot reads this container's geometry the moment
    // hydrate() returns (scroll restore + rail), so those heights must be final.
    var folds = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var node = place(entry, entry.toolView);
      messagesEl.appendChild(node);
      watchNode(node);
      if (entry.kind === 'user') { folds.push({ node: node, entry: entry }); }
    }
    for (var f = 0; f < folds.length; f++) {
      settleUserFold(folds[f].node, folds[f].entry);
    }
    refreshGroupingSoon();
    // [CUSTOM-20260924-022] No unconditional toBottom() here: the scroll target
    // is now a decision (restore the remembered position vs. stick to bottom)
    // and it belongs to boot.applyFocus. Leaving it here made scroll memory
    // silently ineffective - every session switch landed at the bottom.
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
        var existing = nodes[entry.id];
        if (existing && existing.parentNode && !existing.querySelector('.tool-head')) {
          // The card exists only as an empty shell (it was placed before its
          // view model was available). updateTool can only patch
          // .tool-status/.tool-title/.tool-body, so it can NEVER repair a shell
          // -- which is why a shell used to be permanent. Rebuild instead.
          var rebuilt = NS.toolCallView.render(toolView, entry.id);
          rebuilt.setAttribute('data-kind', 'tool');
          existing.parentNode.replaceChild(rebuilt, existing);
          nodes[entry.id] = rebuilt;
          watchNode(rebuilt);
          refreshGroupingSoon();
        } else {
          updateTool(entry.id, toolView);
        }
      } else {
        patch(entry.id, entry);
      }
      return;
    }
    var placed = place(entry, toolView);
    messagesEl.appendChild(placed);
    watchNode(placed);
    // [CUSTOM-20260926-071] The fold decision for a user message is a measurement.
    if (entry.kind === 'user') { settleUserFold(placed, entry); }
    if (entry.kind === 'tool') { refreshGroupingSoon(); }
    NS.scroll.follow();
  }

  function patch(entryId, changes) {
    var entry = objects[entryId];
    var node = nodes[entryId];
    if (!entry || !node || !changes) { return; }

    // [CUSTOM-20260925-048] Capture before the copy: a streaming -> settled
    // transition is the moment to let assistive tech speak.
    var wasStreaming = !!entry.streaming;
    for (var i = 0; i < PATCH_KEYS.length; i++) {
      var key = PATCH_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(changes, key)) { entry[key] = changes[key]; }
    }
    if (wasStreaming !== !!entry.streaming) {
      streamingCount += entry.streaming ? 1 : -1;
      if (streamingCount < 0) { streamingCount = 0; }
      refreshBusy();
    }

    if (entry.kind === 'assistant') {
      var bubble = node.querySelector('.bubble');
      if (bubble) { applyAssistant(bubble, entry); }
      trackMarkdown(entryId, entry, changes);
    } else if (entry.kind === 'thought') {
      var body = node.querySelector('.thought-body');
      if (body) { applyThoughtBody(body, entry); }
      // [CUSTOM-20260926-072] Shared with the assistant branch: without it, the
      // finalize revise would re-render the raw text over the markdown that had
      // just arrived - the block would visibly revert to literal backticks at the
      // exact moment it settles.
      trackMarkdown(entryId, entry, changes);
      var summary = node.querySelector('summary');
      if (summary && entry.streaming === false) {
        // [CUSTOM-20260924-028] Replace only the label, keep the decorations: this
        // rewrite (streaming -> "Thought for Ns") used to clear the whole summary,
        // which wiped the icon on every finalized block.
        // [CUSTOM-20260925-061] Keep **every element** child (icon, caret) and drop
        // only text + the streaming spinner. The previous version named the icon
        // explicitly, which would have silently wiped the caret added this round -
        // "keep the elements" cannot fall behind the way a name list does.
        var keep = [];
        for (var s = 0; s < summary.childNodes.length; s++) {
          var child = summary.childNodes[s];
          if (child.nodeType !== 1) { continue; }
          if (child.className === 'thought-spin') { continue; }
          keep.push(child);
        }
        NS.dom.clear(summary);
        for (var k = 0; k < keep.length; k++) { summary.appendChild(keep[k]); }
        summary.appendChild(document.createTextNode(thoughtLabel(entry)));
        // Auto-collapse: a finished reasoning block must stop occupying the
        // viewport. Its finalize fires exactly when the answer starts (or the
        // turn ends), which is precisely when the reader wants it out of the
        // way. The node itself IS the <details> element, so set .open on it.
        node.open = false;
      }
    } else if (entry.kind === 'plan') {
      var rebuilt = buildPlan(entry);
      rebuilt.setAttribute('data-kind', entry.kind);
      NS.icons.attach(rebuilt, entry);
      node.parentNode.replaceChild(rebuilt, node);
      nodes[entryId] = rebuilt;
      watchNode(rebuilt);
    } else if (entry.kind === 'content') {
      var rebuiltContent = buildContent(entry);
      rebuiltContent.setAttribute('data-kind', entry.kind);
      node.parentNode.replaceChild(rebuiltContent, node);
      nodes[entryId] = rebuiltContent;
      watchNode(rebuiltContent);
    } else if (entry.kind === 'permission') {
      // [CUSTOM-20260924-020] Patch the existing card in place (rather than
      // rebuilding) so the button the user is aiming at never moves/disappears
      // mid-click. The data-kind attribute is already on the wrapper.
      var card = node.querySelector('.perm');
      if (card) { NS.permissionView.applyState(card, entry.permission || {}); }
    }
    NS.scroll.follow();
  }

  function updateTool(entryId, tool) {
    var node = nodes[entryId];
    var entry = objects[entryId];
    // [CUSTOM-20260924-023] Keep the stored view model in step with the patch:
    // the conversation rail reads its status field to colour the dot, and tool
    // status is not part of PATCH_KEYS.
    if (entry) { entry.toolView = tool; }
    if (!node) { return; }
    // [CUSTOM-20260924-027] A card that was placed before its view model existed
    // is a bare tool shell, and update can only patch an existing head. The
    // append path learned this in 018; this path was the remaining gap, which is
    // why such a card stayed empty forever.
    if (tool && !node.querySelector('.tool-head')) {
      var rebuilt = NS.toolCallView.render(tool, entryId);
      rebuilt.setAttribute('data-kind', 'tool');
      if (node.parentNode) { node.parentNode.replaceChild(rebuilt, node); }
      nodes[entryId] = rebuilt;
      watchNode(rebuilt);
      refreshGroupingSoon();
    } else {
      NS.toolCallView.update(node, tool, entryId);
    }
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

  // [CUSTOM-20260924-021] Ordered accessors for the conversation outline.
  function ordered() { return order; }
  function entryOf(id) { return objects[id]; }
  function nodeOf(id) { return nodes[id]; }
  // [CUSTOM-20260925-045] O(1) replacement for the outline's full walk.
  function userAnchorCount() { return userCount; }
  function messageAnchorCount() { return messageCount; }

  NS.transcriptView = {
    init: init,
    reset: reset,
    hydrate: hydrate,
    append: append,
    patch: patch,
    updateTool: updateTool,
    pendingMarkdown: pendingMarkdown,
    // [CUSTOM-20260926-071] Called by the rail when a record gains a real size.
    resolvePendingFolds: resolvePendingFolds,
    ordered: ordered,
    entry: entryOf,
    node: nodeOf,
    userAnchorCount: userAnchorCount,
    messageAnchorCount: messageAnchorCount
  };
})(window.__acpc = window.__acpc || {});
`;
