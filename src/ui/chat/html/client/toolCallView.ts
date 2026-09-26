// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 工具调用渲染：状态图标、kind 标签、命令、locations chips、content / diff / terminal。
// 旧面板对工具调用**完全不渲染详情**；这里把 ACP 能给的都摊开。
// diff 由客户端自行计算（ACP 的 Diff 只给 path/oldText/newText，没有行号也没有 hunk）：
// 先裁掉公共前后缀，再对中段跑 LCS；过大时退化为整块替换。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const toolCallViewClient = `
(function (NS) {
  'use strict';

  var MAX_LCS_LINES = 400;
  var MAX_RENDER_LINES = 2000;

  var STATUS_GLYPH = {
    pending: '\\u25f7',
    in_progress: '\\u25d0',
    completed: '\\u2713',
    failed: '\\u2717'
  };

  var KIND_LABEL = {
    read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search',
    execute: 'Run', think: 'Think', fetch: 'Fetch', switch_mode: 'Mode', other: 'Tool'
  };

  // [CUSTOM-20260925-039] Kept in step with SafeMarkdown's SAFE_LINK_SCHEME
  // (src/ui/chat/markdown.ts) and the host's allowlist in
  // ChatPanelHost.handleOpenLink — a link the host would reject must never
  // render as a clickable chip.
  var OPENABLE_SCHEME = /^(https?:|mailto:)/i;

  function splitLines(text) {
    if (text === null || text === undefined) { return []; }
    var value = String(text);
    if (value.length === 0) { return []; }
    return value.split('\\n');
  }

  function computeDiff(oldText, newText) {
    var a = splitLines(oldText);
    var b = splitLines(newText);

    var start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
    var endA = a.length;
    var endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    var midA = a.slice(start, endA);
    var midB = b.slice(start, endB);
    var tooLarge = midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES;

    var ops = [];
    var i;
    if (tooLarge) {
      for (i = 0; i < midA.length; i++) { ops.push({ t: 'del', a: i }); }
      for (i = 0; i < midB.length; i++) { ops.push({ t: 'add', b: i }); }
    } else {
      ops = lcsOps(midA, midB);
    }

    var rows = [];
    var oldNo = 1;
    var newNo = 1;
    var added = 0;
    var removed = 0;
    for (i = 0; i < start; i++) {
      rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: a[i] });
    }
    for (i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.t === 'ctx') { rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: midA[op.a] }); }
      else if (op.t === 'del') { rows.push({ type: 'del', oldNo: oldNo++, newNo: '', text: midA[op.a] }); removed++; }
      else { rows.push({ type: 'add', oldNo: '', newNo: newNo++, text: midB[op.b] }); added++; }
    }
    for (i = endA; i < a.length; i++) {
      rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: a[i] });
    }
    return { rows: rows, added: added, removed: removed, tooLarge: tooLarge };
  }

  function lcsOps(midA, midB) {
    var n = midA.length;
    var m = midB.length;
    var dp = [];
    var i, j;
    for (i = 0; i <= n; i++) {
      var row = [];
      for (j = 0; j <= m; j++) { row.push(0); }
      dp.push(row);
    }
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    var x = 0;
    var y = 0;
    while (x < n && y < m) {
      if (midA[x] === midB[y]) { out.push({ t: 'ctx', a: x }); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push({ t: 'del', a: x }); x++; }
      else { out.push({ t: 'add', b: y }); y++; }
    }
    while (x < n) { out.push({ t: 'del', a: x }); x++; }
    while (y < m) { out.push({ t: 'add', b: y }); y++; }
    return out;
  }

  function renderDiff(item, key) {
    var el = NS.dom.el;
    var wrap = el('div', 'diff');
    // [CUSTOM-20260925-040] Identity used to carry the user's expansion state
    // across a body rebuild (see fillToolBody). The ACP Diff item gives no id,
    // so the caller-supplied positional key plus the path is the best available
    // handle — and it stays stable under reordering within one tool call.
    if (key) { wrap.setAttribute('data-expand-key', key); }
    var result = computeDiff(item.oldText, item.newText);

    // [CUSTOM-20260925-047] A real <button>: Enter/Space toggle the body for
    // free, and aria-expanded describes the state to a screen reader. The card
    // head was click-only before.
    var head = el('button', 'diff-head');
    head.type = 'button';
    head.setAttribute('data-diff-toggle', '1');
    head.setAttribute('aria-expanded', 'false');
    var caret = el('span', 'tool-caret', '\\u25b8');
    head.appendChild(caret);
    var path = el('span', 'diff-path', item.path || '(new file)');
    path.title = item.path || '';
    head.appendChild(path);
    var stat = el('span', 'diff-stat');
    var addSpan = el('span', 'diff-add', '+' + result.added);
    var delSpan = el('span', 'diff-del', '  -' + result.removed);
    stat.appendChild(addSpan);
    stat.appendChild(delSpan);
    head.appendChild(stat);
    wrap.appendChild(head);

    var body = el('div', 'diff-body');
    body.hidden = true;
    if (result.rows.length > MAX_RENDER_LINES) {
      body.appendChild(el('div', 'diff-note', 'Diff too large to render (' + result.rows.length + ' lines). Open the file to inspect it.'));
    } else {
      for (var i = 0; i < result.rows.length; i++) {
        var r = result.rows[i];
        var line = el('div', 'diff-line ' + r.type);
        line.appendChild(el('span', 'diff-no', String(r.oldNo)));
        line.appendChild(el('span', 'diff-no', String(r.newNo)));
        line.appendChild(el('span', 'diff-code', r.text));
        body.appendChild(line);
      }
      if (result.tooLarge) {
        body.appendChild(el('div', 'diff-note', 'Large diff: shown as a full replacement rather than a minimal edit.'));
      }
    }
    wrap.appendChild(body);
    return wrap;
  }

  /** [CUSTOM-20260924-026] Blank = whitespace OR zero-width characters. */
  function isBlank(text) {
    var s = String(text === undefined || text === null ? '' : text);
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      // 0x200b..0x200d zero-width space/joiners, 0x2060 word joiner, 0xfeff BOM
      if (code === 0xfeff || code === 0x2060 || (code >= 0x200b && code <= 0x200d)) { continue; }
      // Anything that is not whitespace (and not one of the above) is visible.
      if (s.charAt(i).trim().length > 0) { return false; }
    }
    return true;
  }

  /**
   * Render one entry of a tool call's content collection.
   *
   * 'key' is an optional stable identity supplied by the caller, used only by
   * the diff renderer to survive a body rebuild (CUSTOM-20260925-040).
   */
  /**
   * [CUSTOM-20260925-066] Tool results arrive as MARKDOWN, not plain text.
   *
   * Claude Code wraps shell output in a '''console fence (12 of them in the
   * captured replay), so rendering the text verbatim showed the literal backticks
   * and lost the code-block styling and Copy button. Tool text therefore goes
   * through the SAME round-trip as assistant prose ('SafeMarkdown' on the host,
   * sanitized again on this side) instead of a second, weaker renderer.
   *
   * Two caches, both cleared per session:
   *   · mdCache  - key -> rendered HTML, so a body rebuild (which happens whenever
   *                bodySignature changes) puts the HTML straight back;
   *   · mdPending - key -> { entryId, text, host } for the next renderMarkdown batch.
   */
  var mdCache = {};
  var mdPending = {};

  /** Re-render this host from the cache, or queue it for the next round-trip. */
  function markdownText(host, key, entryId, text) {
    if (Object.prototype.hasOwnProperty.call(mdCache, key)) {
      applyRendered(host, mdCache[key]);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(mdPending, key)) {
      mdPending[key] = { entryId: entryId, text: text, host: host };
    }
  }

  function applyRendered(host, html) {
    NS.dom.setSanitizedHtml(host, html);
    // Code blocks need their Copy button and tables their scroll wrapper - the same
    // decoration assistant bubbles get.
    NS.links.decorateScrollables(host);
  }

  /** Items to ask the host for (merged with the assistant bubbles' own batch). */
  function pendingMarkdownItems() {
    var out = [];
    for (var key in mdPending) {
      if (!Object.prototype.hasOwnProperty.call(mdPending, key)) { continue; }
      out.push({ entryId: mdPending[key].entryId, key: key, text: mdPending[key].text });
    }
    return out;
  }

  /** The host rendered one of them: cache it and, if the node still exists, show it. */
  function applyMarkdown(key, html) {
    mdCache[key] = html;
    var item = mdPending[key];
    delete mdPending[key];
    if (item && item.host && item.host.parentNode) { applyRendered(item.host, html); }
  }

  /** Session switch: rendered HTML belongs to the previous transcript. */
  function resetMarkdown() {
    mdCache = {};
    mdPending = {};
  }

  function renderContentItem(item, key, entryId) {
    var el = NS.dom.el;
    if (item.type === 'diff') { return renderDiff(item, key); }

    if (item.type === 'terminal') {
      // [CUSTOM-20260925-047] A real <button> -> keyboard reachable.
      var chip = el('button', 'chip', '\\u25b6 terminal ' + item.terminalId);
      chip.type = 'button';
      chip.setAttribute('data-terminal', item.terminalId);
      chip.title = 'Open the terminal output for this tool call';
      var wrapTerm = el('div', 'chip-row');
      wrapTerm.appendChild(chip);
      return wrapTerm;
    }

    var block = item.block;
    if (!block) { return el('span', ''); }
    // [CUSTOM-20260924-026] A blank text block is invisible content: rendering
    // it produced an empty .tool-text strip (margin 3px 0 with nothing inside).
    // Cosmetic only, so an empty inline span is enough — no need to hide nodes.
    if (block.type === 'text') {
      if (isBlank(block.text)) { return el('span', ''); }
      var textHost = el('div', 'tool-text');
      // [CUSTOM-20260925-066] Markdown, not raw text - see markdownText above.
      markdownText(textHost, (entryId || '') + '#' + (key || ''), entryId || '', block.text);
      return textHost;
    }
    if (block.type === 'image') {
      var img = document.createElement('img');
      img.className = 'content-image';
      img.src = block.dataUri;
      img.alt = block.name || 'image';
      return img;
    }
    if (block.type === 'resource_link') {
      // [CUSTOM-20260925-039] 'path' 由扩展侧判定（本地文件，含相对路径）。
      // 这里只负责把点击导向正确的通道：本地文件走 data-path -> openFile，
      // 可放行协议走 data-href -> openLink。两者都不是就做成**静态 chip**——
      // 此前一律写 data-href，于是点一个本地文件只会弹出
      // 'Blocked link with unsupported scheme: file' 而什么都不打开。
      // [CUSTOM-20260925-047] 只有**能点**的才做成 <button>；打不开的用 <span>，
      // 否则它会白白占一个 tab 停靠位（键盘用户一路 Tab 过去全是死控件）。
      var openable = !!block.path || OPENABLE_SCHEME.test(String(block.uri || ''));
      var linkChip = openable
        ? el('button', 'chip', (block.title || block.name || block.uri))
        : el('span', 'chip chip-static', (block.title || block.name || block.uri));
      if (openable) { linkChip.type = 'button'; }
      if (block.path) {
        linkChip.setAttribute('data-path', block.path);
        linkChip.title = block.path;
      } else if (openable) {
        linkChip.setAttribute('data-href', block.uri);
        linkChip.title = block.uri;
      } else {
        linkChip.title = String(block.uri || '') + ' (this link type cannot be opened)';
      }
      var row = el('div', 'chip-row');
      row.appendChild(linkChip);
      return row;
    }
    if (block.type === 'resource') {
      if (block.text !== undefined) { return el('div', 'tool-text', block.text); }
      return el('div', 'tool-text', block.uri + ' (' + (block.byteLength || 0) + ' bytes)');
    }
    if (block.type === 'audio') {
      return el('div', 'tool-text', 'audio ' + (block.mimeType || '') + ' (' + (block.byteLength || 0) + ' bytes)');
    }
    return el('span', '');
  }

  /**
   * [CUSTOM-20260925-040] The single builder for a tool card's body.
   *
   * 'render' and 'update' used to build it twice, independently — which is how
   * 'locations' came to be rendered on first paint and then dropped by every
   * later update (the update path never re-emitted the chips, and its
   * 'NS.dom.clear(body)' removed the ones already there). One builder makes
   * that class of drift impossible.
   */
  function fillToolBody(body, tool, entryId) {
    var el = NS.dom.el;
    NS.dom.clear(body);
    if (tool.command) {
      body.appendChild(el('div', 'tool-command', tool.command));
    }
    var locations = tool.locations || [];
    if (locations.length > 0) {
      var row = el('div', 'chip-row');
      for (var i = 0; i < locations.length; i++) {
        var loc = locations[i];
        // [CUSTOM-20260925-047] A real <button> -> keyboard reachable.
        var chip = el('button', 'chip', loc.name + (loc.line ? ':' + loc.line : ''));
        chip.type = 'button';
        chip.setAttribute('data-path', loc.path);
        if (loc.line) { chip.setAttribute('data-line', String(loc.line)); }
        chip.title = loc.path + (loc.line ? ':' + loc.line : '');
        row.appendChild(chip);
      }
      body.appendChild(row);
    }
    var items = tool.items || [];
    for (var j = 0; j < items.length; j++) {
      // Positional key so a rebuilt diff keeps the user's expansion state.
      body.appendChild(renderContentItem(items[j], 'i' + j + ':' + (items[j].path || ''), entryId));
    }
    if (!tool.command && locations.length === 0 && items.length === 0) {
      body.appendChild(el('div', 'diff-note', 'No detail reported for this tool call.'));
    }
    return body;
  }

  /**
   * [CUSTOM-20260925-040] Expansion state of the nested collapsibles inside a
   * tool body, keyed by 'data-expand-key'.
   *
   * A running command receives a 'tool_call_update' on every output chunk, and
   * the body is rebuilt each time; without this, a diff the user just opened
   * re-collapsed under their cursor on the next chunk.
   */
  function captureExpansion(body) {
    var out = {};
    if (!body || !body.querySelectorAll) { return out; }
    var blocks = body.querySelectorAll('[data-expand-key]');
    for (var i = 0; i < blocks.length; i++) {
      var inner = blocks[i].querySelector('.diff-body');
      if (inner) { out[blocks[i].getAttribute('data-expand-key')] = !inner.hidden; }
    }
    return out;
  }

  function applyExpansion(body, state) {
    if (!body || !body.querySelectorAll) { return; }
    var blocks = body.querySelectorAll('[data-expand-key]');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var key = block.getAttribute('data-expand-key');
      if (!Object.prototype.hasOwnProperty.call(state, key)) { continue; }
      var open = state[key];
      var inner = block.querySelector('.diff-body');
      if (!inner || inner.hidden === !open) { continue; }
      inner.hidden = !open;
      // [CUSTOM-20260925-047] Keep aria-expanded in step with the restored state.
      var diffHead = block.querySelector('.diff-head');
      if (diffHead) { diffHead.setAttribute('aria-expanded', open ? 'true' : 'false'); }
      var caret = block.querySelector('.tool-caret');
      if (caret) { caret.textContent = open ? '\\u25be' : '\\u25b8'; }
    }
  }

  // [CUSTOM-20260925-044] Above this length a string is not hashed at all:
  // fingerprinting becomes the caller's "rebuild unconditionally" case instead
  // of risking a wrong cache hit. 256K chars is far past any normal diff, so in
  // practice every real card gets the fast path.
  var HASH_LIMIT = 262144;

  /**
   * [CUSTOM-20260925-044] FNV-1a hash of a string, plus its length — or null
   * when the string is too long to hash cheaply.
   *
   * Length alone is NOT a usable change signal: an update that rewrites a diff
   * (or a command, or a text block) with the SAME number of characters would
   * produce an identical signature and leave the old rendering on screen
   * forever. Hashing costs one O(n) pass, which is far cheaper than re-running
   * the LCS and rebuilding up to MAX_RENDER_LINES DOM rows.
   */
  function fingerprintText(value) {
    if (value === null || value === undefined) { return '-'; }
    var s = String(value);
    if (s.length > HASH_LIMIT) { return null; }
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    return h + ':' + s.length;
  }

  /**
   * [CUSTOM-20260925-040] Cheap identity of everything the body renders.
   *
   * Most 'tool_call_update's change only the status, which lives in the head —
   * rebuilding the body for those also re-runs every diff's LCS for nothing.
   * Returns **null** when the body cannot be fingerprinted cheaply; the caller
   * must then rebuild unconditionally.
   *
   * Deliberately never stringifies a payload: an image block's data URI is
   * megabytes long, so image-bearing cards opt out of the cache instead.
   */
  function bodySignature(tool) {
    var command = fingerprintText(tool.command);
    if (command === null) { return null; }
    // [CUSTOM-20260925-044] The leading 'cmd:' is now a HASH, not a length —
    // see fingerprintText for why a length is not a safe change signal.
    var parts = ['cmd:' + command];
    var locations = tool.locations || [];
    for (var i = 0; i < locations.length; i++) {
      parts.push('loc:' + locations[i].path + ':' + (locations[i].line || 0));
    }
    var items = tool.items || [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (item.type === 'diff') {
        var oldFp = fingerprintText(item.oldText);
        var newFp = fingerprintText(item.newText);
        if (oldFp === null || newFp === null) { return null; }
        parts.push('diff:' + item.path + ':' + oldFp + ':' + newFp);
      } else if (item.type === 'terminal') {
        parts.push('term:' + item.terminalId);
      } else if (item.block) {
        var block = item.block;
        // An image's data URI is megabytes long, so it is never scanned: the
        // card opts out of the cache rather than risk a stale render.
        if (block.type === 'image') { return null; }
        var textFp = fingerprintText(block.text);
        if (textFp === null) { return null; }
        // Every field any non-image renderer reads, so a change cannot slip
        // past the signature (an under-covered field = permanently stale card).
        parts.push('blk:' + block.type
          + ':' + textFp
          + ':' + (block.uri || '')
          + ':' + (block.name || '')
          + ':' + (block.title || '')
          + ':' + (block.mimeType || '')
          + ':' + (block.byteLength || 0));
      }
    }
    return parts.join('|');
  }

  /** Build the DOM for a tool call. */
  function render(tool, entryId) {
    var el = NS.dom.el;
    var wrap = el('div', 'tool');
    wrap.setAttribute('data-tool-id', tool.toolCallId);
    if (tool.parentId) { wrap.setAttribute('data-parent-id', tool.parentId); }

    // [CUSTOM-20260925-047] A real <button> — see the diff head above.
    var head = el('button', 'tool-head');
    head.type = 'button';
    head.setAttribute('data-tool-toggle', '1');
    head.setAttribute('aria-expanded', 'false');
    // [CUSTOM-20260924-028] Type icon first, then the caret/status/kind/title.
    // The head is never cleared wholesale (update only rewrites the status,
    // kind and title spans), so the icon survives every patch.
    var icon = NS.icons && NS.icons.toolIcon ? NS.icons.toolIcon() : null;
    if (icon) { head.appendChild(icon); }
    head.appendChild(el('span', 'tool-caret', '\\u25b8'));
    head.appendChild(el('span', 'tool-status tc-' + tool.status, STATUS_GLYPH[tool.status] || '\\u2022'));
    head.appendChild(el('span', 'tool-kind', KIND_LABEL[tool.kind] || 'Tool'));
    // [CUSTOM-20260926-074] The agent's own tool name, when it reported one.
    applyToolName(head, tool);
    var title = el('span', 'tool-title', tool.title || tool.toolCallId);
    title.title = tool.title || '';
    head.appendChild(title);
    applyDuration(head, tool);
    if (tool.inferredParent) {
      head.appendChild(inferredMarker());
    }
    wrap.appendChild(head);

    var body = el('div', 'tool-body');
    body.hidden = true;
    fillToolBody(body, tool, entryId);
    var signature = bodySignature(tool);
    if (signature !== null) { wrap.setAttribute('data-body-sig', signature); }
    wrap.appendChild(body);
    return wrap;
  }

  /**
   * [CUSTOM-20260926-074] Put the agent's own tool name in the card head ("Bash" /
   * "Read" / "Edit"), when it reported one.
   *
   * It sits NEXT TO the kind chip rather than replacing it: the kind is ACP's
   * coarse vocabulary (Run / Read / Edit / Search), the name is the specific tool,
   * and both are useful — the kind is what a non-Claude agent can always provide.
   * Absent for any agent that publishes no _meta, so the chip has to be
   * addable, removable AND patchable (a placeholder card becomes the real card via
   * 'update', which is the path that once lost 'locations').
   */
  function applyToolName(head, tool) {
    var name = tool.toolName || '';
    var node = head.querySelector('.tool-name');
    if (!name) {
      if (node && node.parentNode) { node.parentNode.removeChild(node); }
      return;
    }
    if (node) { node.textContent = name; return; }
    node = NS.dom.el('span', 'tool-name', name);
    var title = head.querySelector('.tool-title');
    if (title) { head.insertBefore(node, title); } else { head.appendChild(node); }
  }

  /**
   * [CUSTOM-20260925-065] Put the call's duration in the card head, once it has
   * finished. A still-running call shows nothing: the pulsing status glyph already
   * says "in progress", and a live counter would mean a ticking re-render.
   *
   * Used by BOTH render and update — the duration appears on the update that
   * reports completion, so the update path must be able to create the span (the
   * same gap that made 027's shell permanent).
   */
  function applyDuration(head, tool) {
    var label = NS.dom.duration(tool.elapsedMs);
    var node = head.querySelector('.tool-time');
    if (!label) {
      if (node && node.parentNode) { node.parentNode.removeChild(node); }
      return;
    }
    if (!node) {
      node = NS.dom.el('span', 'tool-time');
      head.appendChild(node);
    }
    node.textContent = label;
    node.title = 'This tool call took ' + label;
  }

  function inferredMarker() {
    var marker = NS.dom.el('span', 'tool-inferred', '?');
    marker.title = 'Sub-agent relationship inferred — ACP has no nesting concept, so this link '
      + 'was derived from tool timings and outputs and may be wrong.';
    return marker;
  }

  /** Apply a fresh view model to an existing card. */
  function update(node, tool, entryId) {
    if (!node) { return; }

    // Parent link can appear (or disappear) on any update, since the strategy
    // re-runs and a parent's output may only reveal the link at its end.
    if (tool.parentId) {
      node.setAttribute('data-parent-id', tool.parentId);
    } else {
      node.removeAttribute('data-parent-id');
    }
    var head = node.querySelector('.tool-head');
    var existingMarker = node.querySelector('.tool-inferred');
    if (head && tool.inferredParent && !existingMarker) {
      head.appendChild(inferredMarker());
    } else if (existingMarker && !tool.inferredParent) {
      existingMarker.parentNode.removeChild(existingMarker);
    }

    var status = node.querySelector('.tool-status');
    if (status) {
      status.className = 'tool-status tc-' + tool.status;
      status.textContent = STATUS_GLYPH[tool.status] || '\\u2022';
    }
    // [CUSTOM-20260924-027] The kind label is patchable too: a card built from a
    // placeholder starts as "Tool" and must pick up the real kind (Read / Edit /
    // Run / …) when the view model finally arrives.
    var kind = node.querySelector('.tool-kind');
    if (kind) { kind.textContent = KIND_LABEL[tool.kind] || 'Tool'; }
    // [CUSTOM-20260926-074] Same reason as the kind label above: a card built from
    // a placeholder starts without a tool name and must pick it up on the update
    // that finally carries the view model.
    if (head) { applyToolName(head, tool); }
    // [CUSTOM-20260925-065] The duration only exists once the call has finished,
    // which arrives on an update — so it has to be applied here too.
    if (head) { applyDuration(head, tool); }
    var title = node.querySelector('.tool-title');
    if (title && tool.title) {
      title.textContent = tool.title;
      title.title = tool.title;
    }
    var body = node.querySelector('.tool-body');
    if (body) {
      // [CUSTOM-20260925-040] Rebuild through the shared builder (so 'locations'
      // arriving late are actually rendered) while carrying over the user's
      // expansion state — and skip the whole rebuild when nothing the body
      // renders has changed (which is the common case: updates usually only
      // move the status).
      var signature = bodySignature(tool);
      var previous = node.getAttribute('data-body-sig');
      if (signature === null || previous === null || signature !== previous) {
        var expansion = captureExpansion(body);
        fillToolBody(body, tool, entryId);
        applyExpansion(body, expansion);
        if (signature === null) { node.removeAttribute('data-body-sig'); }
        else { node.setAttribute('data-body-sig', signature); }
      }
    }
    // [CUSTOM-20260925-044] Coalesced, not synchronous: this runs on every
    // output chunk of a running command (see refreshGroupingSoon).
    if (node.parentNode) { refreshGroupingSoon(node.parentNode); }
  }

  /**
   * [CUSTOM-20260925-044] Coalesced 'refreshGrouping' — at most one full walk
   * per animation frame.
   *
   * 'refreshGrouping' is a 'querySelectorAll' over the whole transcript, and
   * 'update()' used to run it **synchronously** on every tool update — which is
   * the common case, since a running command emits one update per output chunk.
   * 'transcriptView' already coalesced it for the append path via the shared
   * rAF queue; the coalescer now lives here, next to the function it coalesces,
   * so both paths use it and there is no second copy to forget.
   */
  var groupingPending = false;
  var groupingRoot = null;

  function refreshGroupingSoon(root) {
    if (root) { groupingRoot = root; }
    if (groupingPending) { return; }
    groupingPending = true;
    NS.dom.schedule(function () {
      groupingPending = false;
      var target = groupingRoot;
      groupingRoot = null;
      if (target) { refreshGrouping(target); }
    });
  }

  /**
   * Recompute grouping indicators across a transcript.
   *
   * Children stay in the transcript in arrival (chronological) order — that is
   * the honest ordering given the links are inferred — and grouping is applied
   * purely visually: indentation, a connector, and a step count on the parent.
   * The "flat" toggle only flips a class, so no re-render is needed.
   */
  function refreshGrouping(root) {
    if (!root || !root.querySelectorAll) { return; }
    var cards = root.querySelectorAll('.tool[data-tool-id]');
    var counts = {};
    var i;
    for (i = 0; i < cards.length; i++) {
      var pid = cards[i].getAttribute('data-parent-id');
      if (pid) { counts[pid] = (counts[pid] || 0) + 1; }
    }

    var anyChildren = false;
    for (i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = card.getAttribute('data-tool-id');
      var n = counts[id] || 0;
      if (n > 0) { anyChildren = true; }

      var badge = card.querySelector('.tool-steps');
      if (n > 0) {
        if (!badge) {
          var head = card.querySelector('.tool-head');
          if (head) {
            badge = NS.dom.el('span', 'tool-steps');
            head.appendChild(badge);
          }
        }
        if (badge) { badge.textContent = n + (n === 1 ? ' step' : ' steps'); }
      } else if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
    }

    // The toggle only makes sense when something is actually grouped.
    var toggle = NS.dom.qs('nestToggle');
    if (toggle) { toggle.hidden = !anyChildren; }
  }

  NS.toolCallView = {
    render: render,
    update: update,
    refreshGrouping: refreshGrouping,
    // [CUSTOM-20260925-044] The coalesced form — the one every caller should
    // use unless it is already inside a rAF pass (transcriptView's delegate).
    refreshGroupingSoon: refreshGroupingSoon,
    isBlank: isBlank,
    // [CUSTOM-20260925-066] Tool text rides the same markdown round-trip as
    // assistant prose: these three are what boot.ts and transcriptView need.
    pendingMarkdownItems: pendingMarkdownItems,
    applyMarkdown: applyMarkdown,
    resetMarkdown: resetMarkdown,
    // Reused by transcriptView for 'content' entries (non-text message
    // blocks) so there is exactly one renderer per ContentBlock variant.
    renderContentItem: renderContentItem
  };
})(window.__acpc = window.__acpc || {});
`;
