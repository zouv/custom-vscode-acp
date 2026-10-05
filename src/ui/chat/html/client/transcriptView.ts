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
  // [CUSTOM-20261004-186] entryId -> 这次渲染请求**是针对哪段文本**发出的。
  //
  // 回填报文里只有 entryId（没有文本指纹），所以"这份 html 是哪一版的渲染结果"只能靠这里记。
  // 记录文本一变，旧的那份 html 就作废了 —— 而作废这件事**传不过来**：宿主 store 合并时确实把
  // last.html 置成 undefined（见 TranscriptStore.appendAssistantChunk），但 JSON.stringify
  // 会丢掉 undefined 键，客户端那份副本于是永远以为"我手里这版 html 还是最新的"。
  // 后果就是记录冻在**第一段的渲染结果**上，后面收到的内容一个字都不显示（用户报的"消息
  // 显示不全"）。工具卡那条路 084 已经用"key 里带文本指纹"治过，助手/思考这条一直没治。
  // 详见 pitfalls #49。
  // ⚠️ 本文件是嵌在模板字符串里的客户端代码，注释里也**不能出现反引号**（pitfalls #11）。
  var asked = {};
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
  // [CUSTOM-BEGIN] CUSTOM-20261004-180 - 转录内容版本号。
  // 置顶条每一帧都要一份"用户消息列表"，而它此前每次都走一遍 ordered() 全表 + 逐条 entry()
  //（滚动每一帧、每次折叠都付一次）。内容只在 place()（唯一新增点）与 reset() 变化，所以用版本号
  // 把它们绑起来：置顶条只在版本变了时重建那份列表 —— pitfall #27 的正解是让**会改它的那处代码**
  // 自己举手，而不是让读的人去列"什么会让它变"。
  var contentVersion = 0;
  // [CUSTOM-END] CUSTOM-20261004-180

  // [CUSTOM-BEGIN] CUSTOM-20261004-179 - 用户消息折叠状态：**唯一的真相**（记录与置顶卡共用）。
  //
  // 用户 2026-10-04 报："对话在悬浮状态时点了折叠按钮，消息面板里对应的那条还是展开的（预期一致）"。
  // 根因是两边各存一份、谁也不读谁：
  //   · 记录这边根本没有存储 —— details.open 只在建的时候写成 true，重建（patch/hydrate/切会话）
  //     就回到展开，用户手动折过的状态**本来就保不住**；
  //   · 卡片那边是 stickyUser 的 collapsedBySession，只喂克隆体。
  // 于是"点卡片 = 折消息"这件事在数据结构上就没有落点。现在把这一位收在这里（记录层的所有者），
  // 两边都**读它**、任何一侧的 toggle 都**写它**：
  //   · 键 = 会话 + 条目（沿用 166/172 定下的粒度："每张卡各记各的"、"切走再切回各自记得"）；
  //   · reset() **不清**它（切会话回来还要用）；换会话只换 foldSessionId；
  //   · 幂等：写相同的值直接返回 —— 这是打断"程序化改写 details.open → 又触发一次 toggle →
  //     又回写"这条来回震荡的关键（写 DOM 只在值真的不同时才做，同样是为它）。
  var foldBySession = {};
  var foldSessionId = null;

  /** [CUSTOM-20261004-179] 当前转录属于哪个会话（折叠状态按它分桶；boot 在焦点咽喉点同步）。 */
  function setFoldSession(id) {
    foldSessionId = id || null;
  }

  /** [CUSTOM-20261004-179] 这条用户消息被用户折起来了吗（记录与卡片共用这一个答案）。 */
  function userCollapsed(entryId) {
    var bySession = foldSessionId ? foldBySession[foldSessionId] : null;
    return !!(bySession && bySession[entryId]);
  }

  /**
   * [CUSTOM-20261004-179] 写折叠状态，并把**另一边**同步过去。
   *
   * 调用来自两处：记录自己的 details 的 toggle，以及置顶卡克隆体的 toggle。两边都写同一个
   * 函数 ⇒ 无论用户点的是哪一个，两边都跟着变（用户要的"保持一致"）。写相同的值直接返回：
   * 程序化地改 details.open 也会触发一次 toggle，没有这条守卫就会来回震荡。
   */
  function setUserCollapsed(entryId, collapsed) {
    var on = collapsed === true;
    if (foldSessionId) {
      var bySession = foldBySession[foldSessionId] || (foldBySession[foldSessionId] = {});
      if (!!bySession[entryId] === on) { return; }
      bySession[entryId] = on;
    }
    // ① 记录本体（用户可能是在卡片上点的）。
    var node = nodeOf(entryId);
    var det = node && node.querySelector ? node.querySelector('details.user-fold') : null;
    if (det && det.open === on) { det.open = !on; }
    // ② 置顶卡（用户可能是在记录上点的）。卡片没有这一条时它自己会无视。
    if (NS.stickyUser && NS.stickyUser.onFoldChanged) { NS.stickyUser.onFoldChanged(entryId); }
    // ③ 折叠改了内容高度，两处缓存会因此过期（都是"几何变了但没有任何事件"那一族，pitfall #27）：
    //    视口的贴底判定（176 的入口）与大纲的锚点表。rail 的圆点**不在这里刷新** —— 它观察着
    //    这条记录节点，ResizeObserver 会带着"变了哪一个"来找我们（见 180 的增量重排）。
    if (NS.scroll && NS.scroll.reflowNow) { NS.scroll.reflowNow(); }
    if (NS.outline && NS.outline.invalidate) { NS.outline.invalidate(); }
  }
  // [CUSTOM-END] CUSTOM-20261004-179

  // Only these keys may be copied onto a stored entry. Narrowing the write
  // prevents a future message shape from silently corrupting entry objects.
  // [CUSTOM-20260925-038] 这四个替换型键名必须与**记录字段名**逐字相同
  // （plan -> entries / content -> blocks）。曾经写的是 'plan' / 'content'，
  // 于是 patch 落进 entry.plan 而 buildPlan 读 entry.entries —— 更新静默丢弃
  // （patch() 不认识的那个键只是被拷进对象，没有任何报错）。
  // 改这里之前先对照 src/ui/chat/transcript/types.ts 的 EntryPatch。
  // [CUSTOM-20260929-119] 'elicitation' 与记录字段名逐字相同（表单卡的 patch）。
  var PATCH_KEYS = ['text', 'html', 'streaming', 'elapsedMs', 'entries', 'blocks', 'permission', 'elicitation'];

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
    // [CUSTOM-20261004-186] 渲染请求与记录一起作废：留着旧 entryId 的"问过哪段文本"，
    // 只会让新会话里同名 id 的第一次回填被误判成旧文本的。
    asked = {};
    order = [];
    tails = {};
    requestedViews = {};
    pendingFolds = {};
    userCount = 0;
    messageCount = 0;
    streamingCount = 0;
    // [CUSTOM-20261004-180] 记录整批换掉：也让置顶条的缓存失效。
    contentVersion++;
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
    if (entry.kind === 'assistant') { asked[entry.id] = text; pending[entry.id] = text; scheduleMarkdown(); return; }
    // [CUSTOM-20260926-072] A thought renders markdown through the same round-trip,
    // but only once it has SETTLED: html for a block that is still streaming would
    // freeze a prefix of the text while the stream keeps appending. A settled
    // thought collapses immediately anyway, so the reader sees the rendered form
    // rather than a flicker. markPending runs for every placed record, so this also
    // covers records hydrated from a snapshot (replay / session switch).
    if (entry.kind === 'thought' && entry.streaming === false) { asked[entry.id] = text; pending[entry.id] = text; scheduleMarkdown(); }
  }

  function flushPending() {
    if (!hasPending() || !NS.boot) { return; }
    NS.boot.requestMarkdown();
  }

  // [CUSTOM-BEGIN] CUSTOM-20260930-128 - 记录落地时**自己**去要渲染，不要等下一次 patch。
  //
  // 118 给工具卡的正文修过同一个病（toolCallView 的 scheduleMarkdown），助手/思考这一侧当时漏了：
  // markPending 在 place() 里入队，而全项目唯一的 flushPending 只在 trackMarkdown（patch 路径）
  // 里被调 ⇒ 一条记录若"最后一次 DOM 更新就是它自己的 append"，它的 markdown 请求**永远发不出去**，
  // 界面上只剩原文，而且两侧都不报任何错。**一轮里的最后一条记录正好是这个形状**（收尾的 revise
  // 若晚到、或这一轮根本不是本面板发起的，就再也没有 patch 了）。
  var markdownFlushPending = false;

  /** One request per frame, however many records were queued. */
  function scheduleMarkdown() {
    if (markdownFlushPending) { return; }
    markdownFlushPending = true;
    NS.dom.schedule(function () {
      markdownFlushPending = false;
      flushPending();
    });
  }
  // [CUSTOM-END] CUSTOM-20260930-128

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
    // [CUSTOM-20261004-186] 只有"渲染的就是当前这段文本"的回填才算数（asked 没记录时按
    // 老规矩照收：那说明 html 不是这条请求要回来的）。旧文本的回填既不该落到正文上，
    // 也不该把我们新排的请求顶掉。
    var hasHtml = changes.html !== undefined && changes.html !== null;
    var fresh = hasHtml && (asked[entryId] === undefined || asked[entryId] === entry.text);
    if (fresh) {
      delete pending[entryId];
      delete asked[entryId];
      return;
    }
    // 过期回填（或压根没有回填）：把那次请求**清掉**。留着它（它问的是一段已经不存在的
    // 文本）会让下面那条自愈判据永远不成立 —— 记录停在原文，谁也不再来要一次。
    delete pending[entryId];
    if (entry.streaming === false && entry.text) {
      asked[entryId] = entry.text;
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
   * A single-line message folds too, with an EMPTY body: the caret is the same on every
   * message (CUSTOM-20260928-113 - the affordance used to be hidden for one-liners, and a
   * hidden control per message is what the reader reported), while the thing that used to
   * gate it - "is there anything to hide" - now gates only the pinned bar's shrink button.
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
    // [CUSTOM-20261004-179] 折叠状态来自共用存储（不再是写死的 true）：重建/切回会话时才记得住。
    details.open = !userCollapsed(entry.id);
    // [CUSTOM-20261004-179] toggle **不冒泡**，所以只能逐节点挂；这里是唯一造 user-fold 的地方
    //（settleUserFold 复用同一个节点、不重建），漏掉它就等于两边静默不同步。
    details.addEventListener('toggle', function () { setUserCollapsed(entry.id, !details.open); });
    var summary = NS.dom.el('summary', 'bubble');
    // Caret before the label, so the prepended icon lands leftmost (see foldCaret).
    summary.appendChild(foldCaret());
    // [CUSTOM-20260928-112] 图片 chip 进 bubble，**在 caret 之后、正文之前**。
    var attachments = entry.attachments || [];
    for (var i = 0; i < attachments.length; i++) {
      summary.appendChild(NS.toolCallView.renderContentItem(
        { type: 'content', block: attachments[i] }, 'a' + i, entry.id));
    }
    // [CUSTOM-20260928-108] 正文从**第二行**开始：caret 与图标放在第一行，
    // 正文包一个 .bubble-body（display:block）撑出新行。
    var body = NS.dom.el('span', 'bubble-body');
    body.appendChild(document.createTextNode(entry.text || ''));
    summary.appendChild(body);
    details.appendChild(summary);
    return details;
  }

  /** The text node of a summary, inside the .bubble-body wrapper. */
  function textNodeOf(host) {
    if (!host) { return null; }
    // [CUSTOM-20260928-108] 正文被包进了 .bubble-body，图标/caret/图片 chip 都在外面。
    var body = host.querySelector ? host.querySelector('.bubble-body') : null;
    var scope = body || host;
    for (var i = 0; i < scope.childNodes.length; i++) {
      if (scope.childNodes[i].nodeType === 3) { return scope.childNodes[i]; }
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
  /** [CUSTOM-20260929-116] Cap on the collapsed preview of an assistant message (DOM size). */
  var ASSISTANT_PREVIEW_CHARS = 240;

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
        // [CUSTOM-20260928-113] It fits on ONE line: the whole text stays in the
        // summary and nothing goes to the body. The caret is kept anyway - every
        // message now has the same affordance (the user asked for it), and for a
        // message that wraps at a narrower width collapsing is a real action: the
        // collapsed summary does not wrap. tidySplit() cannot express this case,
        // because it answers 0 for "split at the very end".
        if (total <= 1) { return { plan: { split: text.length, drop: 0 }, measured: true }; }
        var tidied = tidySplit(text, firstLineEnd(textNode, text));
        if (tidied > 0) { return { plan: { split: tidied, drop: 0 }, measured: true }; }
      }
    }
    return { plan: heuristicFold(text), measured: false };
  }

  /** Replace a folded record with a plain bubble (measured as one line after all). */
  function unfoldUser(wrapper, details, text) {
    var bubble = NS.dom.el('div', 'bubble');
    // [CUSTOM-20260928-108] 单行也一样：正文包 .bubble-body、图片 chip 跟着走。
    var body = NS.dom.el('span', 'bubble-body');
    body.appendChild(document.createTextNode(text));
    bubble.appendChild(body);
    var summary = details.querySelector('summary');
    putIcon(bubble, summary ? takeIcon(summary) : null);
    if (summary) {
      var chips = summary.querySelectorAll('.content-image-chip');
      for (var i = 0; i < chips.length; i++) {
        bubble.insertBefore(chips[i], body);
      }
    }
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
    // [CUSTOM-20260928-113] An empty remainder gets NO .fold-body element: the element
    // means "there is hidden text behind this caret", and the pinned bar's shrink button
    // is gated on its presence (a control that does nothing is worse than none).
    var rest = text.slice(decided.plan.split + decided.plan.drop);
    if (rest) { details.appendChild(NS.dom.el('span', 'fold-body', rest)); }
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
      // [CUSTOM-20260929-114] Foldable, like a user message (see buildAssistantFold).
      var aEntry = NS.dom.el('div', 'entry entry-assistant');
      aEntry.appendChild(buildAssistantFold(entry));
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
    // [CUSTOM-BEGIN] CUSTOM-20260929-119 - Form card (ACP elicitation / AskUserQuestion).
    if (entry.kind === 'elicitation') {
      var elicWrap = NS.dom.el('div', 'entry entry-elicitation');
      elicWrap.appendChild(NS.elicitationView.render(entry.elicitation || {}));
      return elicWrap;
    }
    // [CUSTOM-END] CUSTOM-20260929-119
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

  /**
   * [CUSTOM-20260929-114] An assistant message folds like a user message: the same real
   * caret, the same "collapsed means one visible line", and OPEN by default - an answer
   * that just arrived must not be hidden.
   *
   * One thing is deliberately NOT the same: the content is not INSIDE the <summary>.
   * A user bubble holds inert text, so its whole line can be the click target. This
   * content is markdown HTML (links, code Copy buttons, image chips) and, worse,
   * selecting text inside a <summary> IS a click on it - a reader highlighting an
   * answer would collapse it. So the summary stays a small header row ([icon][caret])
   * and the body is its sibling.
   *
   * The collapse itself is a CSS line clamp, not a measured text split: a character
   * offset means nothing inside rendered markdown (paragraphs, code blocks, tables),
   * and a preview copy of the first line would put that text in the DOM twice.
   */
  function buildAssistantFold(entry) {
    var details = document.createElement('details');
    details.className = 'msg-fold';
    details.open = true;
    var summary = NS.dom.el('summary', 'msg-head');
    // Caret before the label, so the prepended icon lands leftmost (see foldCaret).
    summary.appendChild(foldCaret());
    // [CUSTOM-20260929-116] The FIRST LINE, for the collapsed state only (CSS hides it while
    // the record is open). It has to live in the summary: a closed <details> hides every
    // child but the summary by itself, and that hiding is NOT overridable by author CSS -
    // 115 tried a display override on the body and the body stayed invisible.
    summary.appendChild(NS.dom.el('span', 'msg-preview'));
    details.appendChild(summary);
    var body = NS.dom.el('div', 'bubble-body');
    // Appended BEFORE applyAssistant: the preview is refreshed from inside it, and that
    // lookup needs the body in its tree (see refreshPreview).
    details.appendChild(body);
    applyAssistant(body, entry, details);
    return details;
  }

  /**
   * [CUSTOM-20260929-116] Keep the collapsed preview in step with the body.
   *
   * Runs at the end of applyAssistant - the ONLY place the body's content changes (first
   * paint and every patch), so there is exactly one sync point.
   *
   * The text comes from the RENDERED body, not from entry.text: a markdown heading would
   * otherwise preview as "## ...". The first ELEMENT child is used when there is one (that is
   * the first block of rendered markdown); plain streaming text has none, so it falls back to
   * the whole text node. One line, capped - the element is a one-line glimpse, and a copy of
   * a 64KB message would otherwise sit in the DOM a second time.
   */
  function refreshPreview(record, body) {
    var preview = record && record.querySelector ? record.querySelector('.msg-preview') : null;
    if (!preview) { return; }
    var first = body.firstElementChild;
    var text = String((first && first.textContent) || body.textContent || '');
    var nl = text.indexOf('\\n');
    if (nl >= 0) { text = text.slice(0, nl); }
    if (text.length > ASSISTANT_PREVIEW_CHARS) { text = text.slice(0, ASSISTANT_PREVIEW_CHARS); }
    preview.textContent = text.trim();
  }

  function applyAssistant(body, entry, record) {
    // [CUSTOM-20260925-036] An EMPTY html string is not a rendered message.
    // markdown.render() can return '' (blank-ish input), and treating that as
    // "we have HTML" turned the bubble into an empty bordered box - one of the
    // two shapes the "blank bars" report showed. Fall back to the raw text.
    var hasHtml = entry.html !== undefined && entry.html !== null && entry.html !== '';
    if (hasHtml) {
      // The host becomes sanitized HTML: any text node we were appending to is gone,
      // so the delta bookkeeping must go with it.
      delete tails[entry.id];
      // [CUSTOM-20260929-114] No takeIcon/putIcon dance here any more: the type icon
      // lives in the summary now (icons.attach targets .msg-head), so rewriting the
      // body cannot touch it in the first place.
      body.className = 'bubble-body md';
      NS.dom.setSanitizedHtml(body, entry.html);
      NS.links.decorateScrollables(body);
      refreshPreview(record, body);
      return;
    }
    body.className = 'bubble-body';
    setStreamingText(body, entry.id, entry.text || '');
    refreshPreview(record, body);
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
      // [CUSTOM-20260930-129] The stamp rides on the record's TITLE ROW instead of being a
      // block of its own. A tool card puts it inside .tool-head, after the elapsed time, so
      // the line reads "2.2s 11:57"; every other record floats it to the top-right corner
      // (see the .rec-time rules) — which is what "no longer takes a whole line" means.
      var stamp = NS.dom.el('span', 'rec-time', clockLabel(entry.at));
      // [CUSTOM-20260930-129] It goes in the record's TITLE ROW, which is the one part
      // that stays visible in every state: a collapsed details hides everything that is
      // not its summary, so a stamp placed beside the details would disappear exactly
      // when the reader turned Times on to look for it (a collapsed thought block was
      // doing just that).
      var toolHead = node.querySelector('.tool-head');
      var summary = toolHead ? null : node.querySelector('summary');
      if (toolHead) {
        // A tool card reads "2.2s 11:57" — appended, so the stamp follows the elapsed time.
        toolHead.appendChild(stamp);
      } else if (summary) {
        // Prepended inside the summary: absolute positioning makes its DOM order
        // irrelevant, and this keeps "the body is the summary's last child" true.
        summary.insertBefore(stamp, summary.firstChild);
      } else {
        node.insertBefore(stamp, node.firstChild);
      }
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
    // [CUSTOM-20261004-180] 内容变了：置顶条的缓存该重建了（见 contentVersion 的注释）。
    contentVersion++;
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
  /**
   * [CUSTOM-20260930-149] 由 boot 用**当前消息自带的** sessionId 校正会话身份。
   *
   * reset() 有意把 sessionId 清空（见那里的注释：旧的 id 会把下一批 markdown 打上前一个会话的
   * 标签），但**只有 hydrate（快照路径）会把它设回来** —— 于是"重开面板 / 切会话之后新到的记录"
   * 这段时间里它一直是 null，markdown 请求于是带着 null 发出去，宿主 verifySession 不认、**静默
   * 丢弃**。实测 Output 的原话：
   *     chat-panel: dropped markdown item <id>:2:2 (unknown session null)
   * 表现就是"最后一条只显示原文、重开会话却正常"（重开走 hydrate，sessionId 有值）。
   * 每条带记录的消息本来就带 sessionId，用它校正最可靠；同值则什么都不做。
   */
  function setSessionId(next) {
    if (!next || next === sessionId) { return; }
    sessionId = next;
  }

  function hydrate(snapshot) {
    reset();
    if (!snapshot) { return; }
    sessionId = snapshot.sessionId;
    // [CUSTOM-20261004-179] 折叠状态按会话分桶 —— 快照路径自己就知道是哪个会话。
    setFoldSession(snapshot.sessionId);
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
    if (!entry || !node || !changes) {
      // [CUSTOM-20260930-147] 这里原来是**静默返回** —— 宿主明明回了 html，只要这一侧找不到
      // entry/node 就当作没发生，界面上永远停在原文，而 Output 里一个字都没有。这条日志是
      // 定位"最后一条不渲染"的关键：有它说明回填到了客户端但落不了地，没它说明回填根本没到。
      console.warn('[acpc] patch dropped: entry=' + !!entry + ' node=' + !!node
        + ' changes=' + !!changes + ' id=' + entryId);
      return;
    }

    // [CUSTOM-20260925-048] Capture before the copy: a streaming -> settled
    // transition is the moment to let assistive tech speak.
    var wasStreaming = !!entry.streaming;
    for (var i = 0; i < PATCH_KEYS.length; i++) {
      var key = PATCH_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(changes, key)) { entry[key] = changes[key]; }
    }
    // [CUSTOM-20261004-186] 两条作废规则，都是宿主 store 已有的语义在客户端这侧的补课
    // （宿主那边合并时把 html 置回 undefined，但 undefined 过不了 JSON，客户端收不到这个信号）。
    //   ① 回填只认领"针对当前文本"的那一份 —— 否则正文会被一份旧渲染覆盖回去；
    //   ② 文本变了而这一版没带新 html ⇒ 手里的 html 已经作废，丢掉它，让正文跟着**文本**走
    //      （流式期间显示原文，收尾时 trackMarkdown 会把完整文本要来重渲染）。
    // ① 回填只认领"针对当前文本"的那一份。只在**确知**它过时（问过、且问的不是这段文本）
    //    时丢弃 —— asked 没记录的情况（例如 html 来自快照）一律照收，别把正常的回填误伤。
    if (changes.html !== undefined && changes.html !== null
      && asked[entryId] !== undefined && asked[entryId] !== entry.text) {
      entry.html = undefined;
    }
    if (changes.text !== undefined && changes.html === undefined && entry.html !== undefined) {
      entry.html = undefined;
    }
    if (wasStreaming !== !!entry.streaming) {
      streamingCount += entry.streaming ? 1 : -1;
      if (streamingCount < 0) { streamingCount = 0; }
      refreshBusy();
    }

    if (entry.kind === 'assistant') {
      // [CUSTOM-20260929-114] The content host is the body INSIDE the fold, not the
      // record's bubble (which does not exist any more - the details carries the look).
      var bodyEl = node.querySelector('.bubble-body');
      if (bodyEl) { applyAssistant(bodyEl, entry, node); }
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
    } else if (entry.kind === 'elicitation') {
      // [CUSTOM-20260929-119] Patch the existing card in place, like the permission
      // card: the field the user is aiming at must not be replaced mid-answer.
      var elicCard = node.querySelector('.elic');
      if (elicCard) { NS.elicitationView.applyState(elicCard, entry.elicitation || {}); }
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
    // [CUSTOM-20260930-149] boot 用每条带记录的消息自带的 sessionId 校正它（reset 之后会是 null）。
    setSessionId: setSessionId,
    // [CUSTOM-20261004-179] 折叠状态的唯一真相（置顶卡与记录共用；boot 在焦点咽喉点同步会话）。
    setFoldSession: setFoldSession,
    userCollapsed: userCollapsed,
    setUserCollapsed: setUserCollapsed,
    // [CUSTOM-20260926-071] Called by the rail when a record gains a real size.
    resolvePendingFolds: resolvePendingFolds,
    ordered: ordered,
    entry: entryOf,
    node: nodeOf,
    userAnchorCount: userAnchorCount,
    messageAnchorCount: messageAnchorCount,
    // [CUSTOM-20261004-180] 内容版本（place/reset 里自增）：置顶条据此缓存用户消息列表。
    version: function () { return contentVersion; }
  };
})(window.__acpc = window.__acpc || {});
`;
