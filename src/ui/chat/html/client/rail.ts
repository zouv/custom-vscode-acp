// [CUSTOM-BEGIN] CUSTOM-20260924-023 - 左侧引导条（两级：轮次大点 + 步骤小点）：新增客户端模块。
// 参考 Claude Code 官方扩展的对话区：左侧一条竖向引导条，每个执行步骤一个点、连成一条线，
// 当前视口所在的点高亮。与 ☰ 抽屉（021）**职责不同**：抽屉管「跨轮次回看某句话」，
// 引导条管「这一轮干到哪一步了」。
//
// 实现要点：
//   · 引导条是 `.message-area` 的**兄弟节点**（不在 `#messages` 里），靠 track 的
//     translateY(-scrollTop) 与内容同步滚动。放在 #messages 内会被那里的三档间距阶梯
//     （`.messages > * + *` 的 margin-top）位移，也会被当成一个"条目"参与排版。
//   · **布局读取分两种，别混**：`invalidate()` 只在标记集合/状态变化时才重新测量；
//     `reflow()` 只测量（markdown 回填、窗口尺寸变化）。流式 chunk 走的是 append 同一 entry，
//     签名不变 → 完全不读布局，只更新 transform 与高亮。
//   · 点的位置与状态只用 setAttribute / style 写入，不碰 innerHTML。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260924-023
export const railClient = `
(function (NS) {
  'use strict';

  // 与 styles.ts 里的 .rail-dot 尺寸/偏移保持一致（点中心都在 CENTER_X 上）。
  var LINE_X = '9.5px';

  var messagesEl = null;
  var railEl = null;
  var trackEl = null;
  var lineEl = null;
  var marks = [];        // [{ id, turn, state, node }] 与 ordered() 同序
  var points = [];       // [{ i, y }] 只含测得出来的标记，按 y 递增
  var signature = '';
  var needRebuild = false;
  var needMeasure = false;
  var activeIndex = -1;
  var lastTransform = null;

  // [CUSTOM-20260926-070] Layout-change observation.
  //
  // Dot positions are CACHED — measure() is the only place that reads layout, and
  // it runs only when the marker set changed (invalidate) or on an explicit reflow
  // (window resize, markdown arriving). So anything that changes a record's HEIGHT
  // without changing the marker set left the dots behind: expanding a <details>
  // (thought block / folded user message / diff), expanding a tool card body, an
  // image finishing its load. The report was "unfold a block and the left rail's
  // dot does not re-align".
  //
  // Enumerating those triggers by hand is the mistake pitfalls #24/#25 describe
  // (the list falls behind silently — links.toggleBody even toggles a 'hidden'
  // attribute, which fires NO event at all), so this observes the LAYOUT itself:
  // one ResizeObserver over every record node.
  //
  // Two things it deliberately does NOT do:
  //   · it never observes the rail/track/dots — they are this observer's own
  //     output, which would be a feedback loop;
  //   · it ignores entries that are still STREAMING. A growing bubble fires on
  //     every chunk, and measuring then would destroy the property this module is
  //     built around ("no layout read while streaming", see the file header). A
  //     streaming entry's FIRST line cannot move, so its dot is already right.
  var observer = null;

  function onResize(entries) {
    for (var i = 0; i < entries.length; i++) {
      var node = entries[i].target;
      var id = node.getAttribute ? node.getAttribute('data-entry-id') : null;
      var entry = id ? NS.transcriptView.entry(id) : null;
      if (entry && entry.streaming) { continue; }
      // [CUSTOM-20260926-071] A record that was hydrated while the panel had no
      // layout could not be measured, so its user-message fold came from the
      // fallback proxy. "This record just got a real size" is precisely the event
      // that re-decision waits for, and this is where it is observable.
      if (NS.transcriptView.resolvePendingFolds) { NS.transcriptView.resolvePendingFolds(); }
      reflow();
      return;
    }
  }

  /**
   * Watch one record node for layout changes. Called by transcriptView wherever a
   * node is created or swapped in — if you add another place that puts a node into
   * #messages, watch it there too, or that record's dot silently stops moving.
   * Identical to observe()'s own contract: observing twice is a no-op.
   */
  function watch(node) {
    if (!observer || !node || !node.nodeType) { return; }
    observer.observe(node);
  }

  /** Drop every observation — the nodes are being thrown away (session switch). */
  function resetNodes() {
    if (!observer) { return; }
    observer.disconnect();
  }

  function firstLine(text) {
    var s = String(text || '').replace(/\\s+/g, ' ').trim();
    if (s.length > 70) { s = s.slice(0, 70) + '\\u2026'; }
    return s;
  }

  /** Short human label for the native tooltip. */
  function labelOf(entry) {
    if (entry.kind === 'tool') {
      var view = entry.toolView;
      return (view && view.title) ? view.title : 'Tool call';
    }
    if (entry.kind === 'thought') { return 'Reasoning: ' + firstLine(entry.text); }
    if (entry.kind === 'plan') { return 'Plan'; }
    if (entry.kind === 'content') { return 'Content'; }
    if (entry.kind === 'notice') { return firstLine(entry.text); }
    if (entry.kind === 'permission') {
      return 'Permission: ' + ((entry.permission && entry.permission.title) || '');
    }
    return firstLine(entry.text);
  }

  /**
   * done | running | failed. Tool status comes from the ACP replace-collection
   * view model; text entries are 'running' while they are still streaming.
   */
  function stateOf(entry) {
    if (entry.kind === 'tool') {
      var view = entry.toolView;
      var status = view && view.status;
      if (status === 'failed') { return 'failed'; }
      if (status === 'in_progress' || status === 'pending') { return 'running'; }
      return 'done';
    }
    if (entry.streaming) { return 'running'; }
    if (entry.kind === 'permission' && entry.permission && entry.permission.status === 'pending') {
      return 'running';
    }
    return 'done';
  }

  function collect() {
    var out = [];
    if (!NS.transcriptView.ordered) { return out; }
    var ids = NS.transcriptView.ordered();
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (!entry) { continue; }
      out.push({
        id: entry.id,
        turn: entry.kind === 'user',
        state: stateOf(entry),
        label: labelOf(entry)
      });
    }
    return out;
  }

  function signatureOf(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      parts.push(list[i].id + (list[i].turn ? 'T' : 'S') + list[i].state);
    }
    return parts.join('|');
  }

  function rebuild() {
    var list = collect();
    signature = signatureOf(list);
    NS.dom.clear(trackEl);
    marks = list;
    activeIndex = -1;
    lastTransform = null;
    // Line first so the opaque dots paint over it.
    lineEl = NS.dom.el('div', 'rail-line');
    trackEl.appendChild(lineEl);
    for (var i = 0; i < list.length; i++) {
      var mark = list[i];
      // [CUSTOM-20260925-047] A real <button> so the rail is usable without a
      // mouse — but only ONE of them is in the tab order at a time (roving
      // tabindex; see setActive). There can be hundreds of markers, and a plain
      // <button> per marker would flood the tab order and make Tab useless.
      var dot = NS.dom.el('button', 'rail-dot ' + (mark.turn ? 'turn' : 'step') + ' ' + mark.state);
      dot.type = 'button';
      dot.tabIndex = -1;
      dot.setAttribute('data-entry-id', mark.id);
      if (mark.label) {
        dot.setAttribute('title', mark.label);
        dot.setAttribute('aria-label', mark.label);
      }
      trackEl.appendChild(dot);
      mark.node = dot;
    }
    railEl.hidden = list.length === 0;
    needMeasure = true;
  }

  /**
   * [CUSTOM-20260925-061] Vertical centre a dot should sit on: the centre of the
   * entry's FIRST LINE.
   *
   * Anchored on the entry's **type icon**, which icons.attach has already placed
   * on that line (its HOST table maps each record kind to its content host). So
   * this is alignment **by construction** instead of by a magic offset. The
   * previous version used a flat 'y + 6', which is 6-9px too high depending on the
   * kind — a tool head has 3px padding, a user bubble 6px, so their first lines do
   * not start at the same place at all, and one constant cannot be right for both.
   *
   * Fallback chain: the icon -> the entry's first element -> the entry itself.
   *
   * 'origin' is the content coordinate of the container's top (see measure).
   */
  function firstLineCentre(node, origin) {
    var anchor = node.querySelector('.rec-icon, .tool-icon') || node.firstElementChild || node;
    var rect = anchor.getBoundingClientRect();
    return rect.top - origin + rect.height / 2;
  }

  /** Position every dot. The only place that reads layout. */
  function measure() {
    var box = messagesEl.getBoundingClientRect();
    // [CUSTOM-20260926-070] A hidden panel (background editor group, or a webview
    // that has not been revealed) reports height 0 for everything. Measuring here
    // would pin every dot to top 0 and cache that as truth — so leave the pending
    // flag set and the previous positions intact; the ResizeObserver fires when the
    // panel really has a size again (that is also how a zero-height hydrate is
    // rescued). Not an rAF loop: nothing schedules a tick while nothing moves.
    if (box.height === 0) { needMeasure = true; return; }
    points = [];
    // Content coordinates: what the track's translateY(-scrollTop) is relative to.
    var origin = box.top - messagesEl.scrollTop;
    for (var i = 0; i < marks.length; i++) {
      var node = NS.transcriptView.node(marks[i].id);
      var dot = marks[i].node;
      if (!node || !dot) { if (dot) { dot.hidden = true; } continue; }
      dot.hidden = false;
      var centre = firstLineCentre(node, origin);
      // The dot element carries the -half-size margin, so 'top' IS its centre.
      dot.style.top = centre + 'px';
      // 'y' stays the entry's own TOP: syncActive() asks "which entry is the
      // viewport top inside", which is a question about the entry, not its line.
      points.push({ i: i, y: node.offsetTop - messagesEl.offsetTop, centre: centre });
    }
    if (points.length === 0) {
      lineEl.hidden = true;
      return;
    }
    lineEl.hidden = false;
    lineEl.style.left = LINE_X;
    // The line spans first centre -> last centre, so its ends land exactly on the
    // end dots instead of a guessed 6px below their tops.
    lineEl.style.top = points[0].centre + 'px';
    lineEl.style.height = Math.max(0, points[points.length - 1].centre - points[0].centre) + 'px';
  }

  function setActive(index) {
    if (index === activeIndex) { return; }
    if (activeIndex >= 0 && marks[activeIndex] && marks[activeIndex].node) {
      marks[activeIndex].node.classList.remove('active');
      // [CUSTOM-20260925-047] Roving tabindex: exactly one dot is reachable by
      // Tab, and it follows the viewport, so the rail costs one tab stop no
      // matter how many markers it has.
      marks[activeIndex].node.tabIndex = -1;
    }
    activeIndex = index;
    if (activeIndex >= 0 && marks[activeIndex] && marks[activeIndex].node) {
      marks[activeIndex].node.classList.add('active');
      marks[activeIndex].node.tabIndex = 0;
    }
  }

  /** Highlight the marker the viewport is currently inside. */
  function syncActive() {
    if (points.length === 0) { setActive(-1); return; }
    var y = messagesEl.scrollTop + 8;
    var lo = 0;
    var hi = points.length - 1;
    var found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (points[mid].y <= y) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    setActive(points[found < 0 ? 0 : found].i);
  }

  function applyScroll() {
    if (!trackEl) { return; }
    var y = -messagesEl.scrollTop;
    if (y === lastTransform) { return; }
    lastTransform = y;
    trackEl.style.transform = 'translateY(' + y + 'px)';
  }

  function tick() {
    if (needRebuild) { needRebuild = false; rebuild(); }
    if (needMeasure) { needMeasure = false; measure(); }
    applyScroll();
    syncActive();
  }

  /**
   * Entry set or a marker's state changed. Rebuilds only when the signature
   * actually moved, so streaming chunks (same entry, same state) cost nothing.
   */
  function invalidate() {
    if (signatureOf(collect()) === signature) {
      NS.dom.schedule(tick);
      return;
    }
    needRebuild = true;
    NS.dom.schedule(tick);
  }

  /** Layout changed without the marker set changing (markdown, resize). */
  function reflow() {
    needMeasure = true;
    NS.dom.schedule(tick);
  }

  function onClick(event) {
    var node = event.target;
    while (node && node !== trackEl) {
      if (node.getAttribute && node.getAttribute('data-entry-id')) {
        event.preventDefault();
        var target = NS.transcriptView.node(node.getAttribute('data-entry-id'));
        if (target) { NS.scroll.jumpTo(target); }
        NS.dom.schedule(tick);
        return;
      }
      node = node.parentNode;
    }
  }

  /**
   * [CUSTOM-20260925-047] Up/Down step through the markers.
   *
   * Enter/Space need no branch: a focused <button> dispatches a click on
   * activation, which is what 'onClick' already handles.
   */
  function onKeyDown(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
    if (marks.length === 0) { return; }
    var current = activeIndex < 0 ? 0 : activeIndex;
    var next = current + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) { next = 0; }
    if (next > marks.length - 1) { next = marks.length - 1; }
    event.preventDefault();
    var target = NS.transcriptView.node(marks[next].id);
    if (target) { NS.scroll.jumpTo(target); }
    setActive(next);
    if (marks[next].node) { marks[next].node.focus(); }
    NS.dom.schedule(tick);
  }

  function init(messages, rail, track) {
    messagesEl = messages;
    railEl = rail;
    trackEl = track;
    trackEl.addEventListener('click', onClick);
    trackEl.addEventListener('keydown', onKeyDown);
    // Own scroll listener: it only flags work; all reads happen in the rAF pass.
    messagesEl.addEventListener('scroll', function () { NS.dom.schedule(tick); });
    window.addEventListener('resize', reflow);
    railEl.hidden = true;
    // [CUSTOM-20260926-070] See onResize. Chromium in a webview always has this;
    // if it ever is missing, say so once instead of silently losing the re-align
    // (a hand-written trigger list would be the worse option — see there).
    if (typeof window.ResizeObserver === 'function') {
      observer = new window.ResizeObserver(onResize);
    } else {
      console.warn('[acpc] ResizeObserver unavailable: rail dots will not re-align after layout changes');
    }
  }

  NS.rail = {
    init: init,
    invalidate: invalidate,
    reflow: reflow,
    watch: watch,
    resetNodes: resetNodes
  };
})(window.__acpc = window.__acpc || {});
`;
