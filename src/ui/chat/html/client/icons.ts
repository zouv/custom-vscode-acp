// [CUSTOM-BEGIN] CUSTOM-20260924-028 - 记录类型图标（内联 SVG）：新增客户端模块。
// 参考 Claude Code 官方扩展的对话区：每类记录左侧一个小图标，一眼能分清「谁说的 / 在推理 /
// 跑了工具 / 是计划」。
//
// 为什么用内联 SVG 而不是 VS Code 的 codicon 字体：webview 的 CSP 是 `default-src 'none'`，
// 用字体要额外加 `font-src` 并把字体文件随扩展打包发布；而 SVG 元素不受 CSP 限制
// （CSP 管的是 `<img src>` / 字体 / 脚本，不管文档内的 SVG 标记）。用 `stroke="currentColor"`
// 还能自动跟随主题与所在文字的颜色（用户气泡=按钮前景色、推理=次要色）。
//
// **挂载位置是有讲究的**（放错会被抹掉）：
//   · 助手气泡的文本会被流式更新整段重写、markdown 落地还会用 innerHTML 覆盖 → 图标放在
//     **条目外层**（`.entry-assistant`），配一行 row 布局；
//   · 推理块的 body 每片都重写 → 图标放在 **summary**（标签文字在收束时才重写一次，
//     那条路径已改成保留图标）；
//   · 工具卡的头不会被整块清空（只改 status/title/kind 三个 span）→ 图标放**卡头**；
//   · 用户消息只追加不重写 → 放气泡内最省事，但为统一仍走外层。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260924-028
export const iconsClient = `
(function (NS) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // 12x12 线稿图标。只用 circle / path 两种图元，路径刻意选直线与简单曲线——
  // 弧线命令写错时不会报错，只会画歪，所以宁可用基础图形拼。
  var SHAPES = {
    user: [
      ['circle', { cx: 6, cy: 4.5, r: 2.1 }],
      ['path', { d: 'M2.4 10.8c0-1.9 1.6-3.1 3.6-3.1s3.6 1.2 3.6 3.1' }]
    ],
    assistant: [
      ['path', { d: 'M2.4 3.2h7.2v4.4H5.8L3.6 9.6V7.6H2.4Z' }]
    ],
    thought: [
      ['circle', { cx: 6, cy: 4.7, r: 2.6 }],
      ['path', { d: 'M4.9 9.1h2.2' }],
      ['path', { d: 'M5.4 10.7h1.2' }]
    ],
    tool: [
      ['circle', { cx: 6, cy: 6, r: 2.1 }],
      ['path', { d: 'M6 1.9v1.4' }],
      ['path', { d: 'M6 8.7v1.4' }],
      ['path', { d: 'M1.9 6h1.4' }],
      ['path', { d: 'M8.7 6h1.4' }]
    ],
    plan: [
      ['path', { d: 'M2.6 3.2h6.8v6H2.6Z' }],
      ['path', { d: 'M4.5 5.4h3' }],
      ['path', { d: 'M4.5 7.4h2' }]
    ],
    notice: [
      ['circle', { cx: 6, cy: 6, r: 3.6 }],
      ['path', { d: 'M6 5.5v2.3' }],
      ['path', { d: 'M6 4.1v.01' }]
    ],
    // [CUSTOM-20260925-035] 历史会话：时钟。原来用文字字形 ↺，那是"撤销/刷新"的语义，
    // 读起来不像"历史"。时钟是"最近/历史"最通用的形状，且只用 circle + 直线，画不歪。
    history: [
      ['circle', { cx: 6, cy: 6.2, r: 3.9 }],
      ['path', { d: 'M6 3.9v2.4l1.7 1' }]
    ]
  };

  /** Build the SVG element for a record kind, or null when there is no icon. */
  function svg(kind) {
    var shapes = SHAPES[kind];
    if (!shapes) { return null; }
    var root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', '0 0 12 12');
    root.setAttribute('width', '12');
    root.setAttribute('height', '12');
    root.setAttribute('fill', 'none');
    root.setAttribute('stroke', 'currentColor');
    root.setAttribute('stroke-width', '1');
    root.setAttribute('stroke-linecap', 'round');
    root.setAttribute('stroke-linejoin', 'round');
    root.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < shapes.length; i++) {
      var part = document.createElementNS(SVG_NS, shapes[i][0]);
      var attrs = shapes[i][1];
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          part.setAttribute(key, String(attrs[key]));
        }
      }
      root.appendChild(part);
    }
    return root;
  }

  /** Icon wrapper for one record kind (null when that kind has no icon). */
  function iconEl(kind, className) {
    var shape = svg(kind);
    if (!shape) { return null; }
    var wrap = NS.dom.el('span', className);
    wrap.appendChild(shape);
    return wrap;
  }

  // kind -> selector of the element that hosts the icon ('' = the entry itself).
  // Kinds left out on purpose: 'tool' gets its icon inside the card head (built by
  // toolCallView), 'content' is already visually distinct (image / chip rows),
  // and the permission card carries its own "?" badge.
  //
  // Everything that HAS an icon puts it inside its own content host (the bubble /
  // the summary / the plan title) rather than restructuring the entry: an earlier
  // attempt mounted the assistant icon on the entry and switched that entry to a
  // row layout, which touched the layout of every assistant record. The two
  // text-writing paths (setStreamingText, setSanitizedHtml) now preserve the icon
  // instead, so no layout change is needed at all.
  var HOST = {
    user: '.bubble',
    assistant: '.bubble',
    thought: 'summary',
    plan: '.plan-title',
    notice: ''
  };

  /**
   * Attach the type icon to an entry's DOM node. Idempotent: a node that already
   * carries an icon is left alone, so this is safe to call from both the first
   * paint and every rebuild path.
   */
  function attach(node, entry) {
    if (!node || !entry) { return; }
    var sel = HOST[entry.kind];
    if (sel === undefined) { return; }
    var host = sel ? node.querySelector(sel) : node;
    if (!host || host.querySelector('.rec-icon')) { return; }
    var icon = iconEl(entry.kind, 'rec-icon');
    if (!icon) { return; }
    host.insertBefore(icon, host.firstChild);
  }

  /** The icon for the tool card head (a different slot from 'attach'). */
  function toolIcon() {
    return iconEl('tool', 'tool-icon');
  }

  /** [CUSTOM-20260925-035] Clock icon for the history-sessions button. */
  function historyIcon() {
    return iconEl('history', 'btn-icon');
  }

  NS.icons = {
    attach: attach,
    toolIcon: toolIcon,
    historyIcon: historyIcon,
    // [CUSTOM-20260926-076] 大纲侧栏要按 kind 独立取图标（不再挂到记录气泡里），
    // 把私有的 iconEl 暴露出来。参数与 attach 里的一致：kind + 包装 class。
    icon: iconEl
  };
})(window.__acpc = window.__acpc || {});
`;
