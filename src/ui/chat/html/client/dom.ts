// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 客户端 DOM 工具 + HTML 白名单兜底。
//
// 注意（改这个文件前必读）：客户端代码是嵌在模板字符串里的，**每一个想出现在生成脚本里的
// 反斜杠都必须写成 `\\`**；不要使用反引号或 `${`。改动后必须跑客户端脚本语法校验
// （见 CUSTOMIZATIONS/architecture.md 的 Webview 客户端校验一节）。
// [CUSTOM-END] CUSTOM-20260923-011
export const domClient = `
(function (NS) {
  'use strict';

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }

  var ALLOWED_TAGS = {};
  'P BR CODE PRE STRONG EM DEL S UL OL LI BLOCKQUOTE H1 H2 H3 H4 H5 H6 HR TABLE THEAD TBODY TR TH TD A SPAN DIV DETAILS SUMMARY'.split(' ')
    .forEach(function (t) { ALLOWED_TAGS[t] = true; });

  var ALLOWED_ATTRS = {};
  'class title data-href data-lang data-src data-terminal data-path data-line start'.split(' ')
    .forEach(function (a) { ALLOWED_ATTRS[a] = true; });

  /**
   * Backstop for the extension-side SafeMarkdown renderer: parse into an inert
   * document, walk it, and strip every element/attribute outside the allowlist.
   * Even if a future marked release adds a renderer hook nobody overrode, this
   * keeps the result inert.
   */
  function sanitize(html) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var root = doc.body;
    walk(root);
    return root.innerHTML;

    function walk(node) {
      var children = Array.prototype.slice.call(node.childNodes);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 8) { node.removeChild(child); continue; }
        if (child.nodeType !== 1) { continue; }
        if (!ALLOWED_TAGS[child.tagName]) {
          // Unwrap unknown elements rather than dropping their text content.
          while (child.firstChild) { node.insertBefore(child.firstChild, child); }
          node.removeChild(child);
          continue;
        }
        var attrs = Array.prototype.slice.call(child.attributes);
        for (var j = 0; j < attrs.length; j++) {
          var name = attrs[j].name.toLowerCase();
          if (!ALLOWED_ATTRS[name] && name.indexOf('data-') !== 0) {
            child.removeAttribute(attrs[j].name);
          }
        }
        // Anchors never navigate directly; navigation round-trips through the
        // extension for scheme allowlisting.
        if (child.tagName === 'A') { child.setAttribute('href', '#'); }
        walk(child);
      }
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function setSanitizedHtml(node, html) {
    node.innerHTML = sanitize(html);
  }

  function qs(id) { return document.getElementById(id); }

  NS.dom = {
    esc: esc,
    sanitize: sanitize,
    el: el,
    clear: clear,
    setSanitizedHtml: setSanitizedHtml,
    qs: qs
  };
})(window.__acpc = window.__acpc || {});
`;
