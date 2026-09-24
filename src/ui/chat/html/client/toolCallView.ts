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

  function renderDiff(item) {
    var el = NS.dom.el;
    var wrap = el('div', 'diff');
    var result = computeDiff(item.oldText, item.newText);

    var head = el('div', 'diff-head');
    head.setAttribute('data-diff-toggle', '1');
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

  function renderContentItem(item) {
    var el = NS.dom.el;
    if (item.type === 'diff') { return renderDiff(item); }

    if (item.type === 'terminal') {
      var chip = el('span', 'chip', '\\u25b6 terminal ' + item.terminalId);
      chip.setAttribute('data-terminal', item.terminalId);
      chip.title = 'Open the terminal output for this tool call';
      var wrapTerm = el('div', 'chip-row');
      wrapTerm.appendChild(chip);
      return wrapTerm;
    }

    var block = item.block;
    if (!block) { return el('span', ''); }
    if (block.type === 'text') { return el('div', 'tool-text', block.text); }
    if (block.type === 'image') {
      var img = document.createElement('img');
      img.className = 'content-image';
      img.src = block.dataUri;
      img.alt = block.name || 'image';
      return img;
    }
    if (block.type === 'resource_link') {
      var linkChip = el('span', 'chip', (block.title || block.name || block.uri));
      linkChip.setAttribute('data-href', block.uri);
      linkChip.title = block.uri;
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

  /** Build the DOM for a tool call. */
  function render(tool) {
    var el = NS.dom.el;
    var wrap = el('div', 'tool');
    wrap.setAttribute('data-tool-id', tool.toolCallId);
    if (tool.parentId) { wrap.setAttribute('data-parent-id', tool.parentId); }

    var head = el('div', 'tool-head');
    head.setAttribute('data-tool-toggle', '1');
    head.appendChild(el('span', 'tool-caret', '\\u25b8'));
    head.appendChild(el('span', 'tool-status tc-' + tool.status, STATUS_GLYPH[tool.status] || '\\u2022'));
    head.appendChild(el('span', 'tool-kind', KIND_LABEL[tool.kind] || 'Tool'));
    var title = el('span', 'tool-title', tool.title || tool.toolCallId);
    title.title = tool.title || '';
    head.appendChild(title);
    if (tool.inferredParent) {
      head.appendChild(inferredMarker());
    }
    wrap.appendChild(head);

    var body = el('div', 'tool-body');
    body.hidden = true;
    if (tool.command) {
      body.appendChild(el('div', 'tool-command', tool.command));
    }
    if (tool.locations && tool.locations.length > 0) {
      var row = el('div', 'chip-row');
      for (var i = 0; i < tool.locations.length; i++) {
        var loc = tool.locations[i];
        var chip = el('span', 'chip', loc.name + (loc.line ? ':' + loc.line : ''));
        chip.setAttribute('data-path', loc.path);
        if (loc.line) { chip.setAttribute('data-line', String(loc.line)); }
        chip.title = loc.path + (loc.line ? ':' + loc.line : '');
        row.appendChild(chip);
      }
      body.appendChild(row);
    }
    var items = tool.items || [];
    for (var j = 0; j < items.length; j++) {
      body.appendChild(renderContentItem(items[j]));
    }
    if (!tool.command && (!tool.locations || tool.locations.length === 0) && items.length === 0) {
      body.appendChild(el('div', 'diff-note', 'No detail reported for this tool call.'));
    }
    wrap.appendChild(body);
    return wrap;
  }

  function inferredMarker() {
    var marker = NS.dom.el('span', 'tool-inferred', '?');
    marker.title = 'Sub-agent relationship inferred — ACP has no nesting concept, so this link '
      + 'was derived from tool timings and outputs and may be wrong.';
    return marker;
  }

  /** Apply a fresh view model to an existing card. */
  function update(node, tool) {
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
    var title = node.querySelector('.tool-title');
    if (title && tool.title) {
      title.textContent = tool.title;
      title.title = tool.title;
    }
    var body = node.querySelector('.tool-body');
    if (body) {
      NS.dom.clear(body);
      if (tool.command) { body.appendChild(NS.dom.el('div', 'tool-command', tool.command)); }
      var items = tool.items || [];
      for (var i = 0; i < items.length; i++) {
        body.appendChild(renderContentItem(items[i]));
      }
    }
    if (node.parentNode) { refreshGrouping(node.parentNode); }
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
    // Reused by transcriptView for 'content' entries (non-text message
    // blocks) so there is exactly one renderer per ContentBlock variant.
    renderContentItem: renderContentItem
  };
})(window.__acpc = window.__acpc || {});
`;
