// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 委托式交互：markdown 链接、文件/终端 chip、diff 与工具卡片的折叠、代码块复制按钮。
//
// 链接一律不带真实 href（SafeMarkdown 只写 data-href），点击后回传到扩展侧做协议白名单
// 再 openExternal——agent 输出里的 `command:` 链接等于把 IDE 变成远程命令执行，必须挡住。
// 复制也走扩展往返：webview 里的 navigator.clipboard 依赖文档焦点，不可靠。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20260923-011
export const linksClient = `
(function (NS) {
  'use strict';

  /** Wrap each rendered <pre> so a copy button can be positioned over it. */
  function decorateCodeBlocks(root) {
    if (!root) { return; }
    var pres = root.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      // Starts-with rather than equality: the wrapper also carries 'has-lang'
      // when a language label was added below.
      if (pre.parentNode && String(pre.parentNode.className).indexOf('code-wrap') === 0) { continue; }
      // [CUSTOM-20260925-051] Surface the fenced language. SafeMarkdown already
      // emits 'data-lang' (and validates it to a boring character set there) —
      // it was simply never rendered. No syntax highlighter is added: that
      // would mean a new dependency plus a CSP change.
      var lang = pre.getAttribute('data-lang');
      var wrap = NS.dom.el('div', lang ? 'code-wrap has-lang' : 'code-wrap');
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      if (lang) { wrap.appendChild(NS.dom.el('span', 'code-lang', lang)); }
      var btn = NS.dom.el('button', 'code-copy', 'Copy');
      btn.type = 'button';
      btn.setAttribute('data-code-copy', '1');
      wrap.appendChild(btn);
    }
  }

  /**
   * [CUSTOM-20260925-062] Give a wide markdown TABLE its own horizontal scroller.
   *
   * '.bubble pre' already had 'overflow-x: auto', but '.bubble table' only had
   * 'border-collapse' — so a table with many columns pushed the bubble (and with
   * it the whole panel) wider instead of scrolling inside itself.
   *
   * A wrapper rather than 'overflow-x' on the bubble itself, so the two scrollable
   * block types are handled the SAME way (see decorateCodeBlocks above) and the
   * bubble keeps its own overflow semantics.
   */
  function decorateTables(root) {
    if (!root || !root.querySelectorAll) { return; }
    var tables = root.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      if (table.parentNode && String(table.parentNode.className).indexOf('table-wrap') === 0) { continue; }
      var wrap = NS.dom.el('div', 'table-wrap');
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
  }

  /**
   * Everything that needs a scroll container around it, in one call — so a future
   * block type cannot be remembered in one place and forgotten in another.
   */
  function decorateScrollables(root) {
    decorateCodeBlocks(root);
    decorateTables(root);
  }

  function closestWithAttr(node, attr) {
    var current = node;
    while (current && current !== document) {
      if (current.getAttribute && current.getAttribute(attr) !== null) { return current; }
      current = current.parentNode;
    }
    return null;
  }

  function onCopyClicked(button) {
    var wrap = button.parentNode;
    var code = wrap ? wrap.querySelector('code') : null;
    if (!code) { return; }
    NS.bridge.post({ type: 'copy', text: code.textContent || '' });
    button.textContent = 'Copied';
    window.setTimeout(function () { button.textContent = 'Copy'; }, 1200);
  }

  function toggleBody(header, bodySelector) {
    var card = header.parentNode;
    var body = card ? card.querySelector(bodySelector) : null;
    if (!body) { return; }
    body.hidden = !body.hidden;
    // [CUSTOM-20260925-047] The header is a <button> now, so the expanded state
    // is worth announcing. (Enter/Space activate it natively — a button's
    // activation dispatches a click, which is what this delegated handler sees,
    // so no separate keydown branch is needed.)
    header.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    var caret = header.querySelector('.tool-caret');
    if (caret) { caret.textContent = body.hidden ? '\\u25b8' : '\\u25be'; }

    // Collapsing a parent also collapses the cards grouped under it, so the
    // indent never dangles without its parent.
    var id = card.getAttribute && card.getAttribute('data-tool-id');
    if (!id) { return; }
    var selector = '.tool[data-parent-id="' + (window.CSS && window.CSS.escape ? window.CSS.escape(id) : id) + '"]';
    var children = document.querySelectorAll(selector);
    for (var i = 0; i < children.length; i++) { children[i].hidden = body.hidden; }
  }

  function installDelegatedHandlers(root) {
    root.addEventListener('click', function (event) {
      var target = event.target;

      var copyBtn = closestWithAttr(target, 'data-code-copy');
      if (copyBtn) { event.preventDefault(); onCopyClicked(copyBtn); return; }

      // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限卡按钮。放在最前面：它们是
      // session 作用域的消息，且按钮上同时带 data-perm-id 与 data-perm-option。
      var permBtn = closestWithAttr(target, 'data-perm-option');
      if (permBtn) {
        event.preventDefault();
        if (permBtn.disabled) { return; }
        NS.bridge.postForSession({
          type: 'permissionAnswer',
          promptId: permBtn.getAttribute('data-perm-id'),
          optionId: permBtn.getAttribute('data-perm-option')
        });
        return;
      }
      // [CUSTOM-END] CUSTOM-20260924-020

      var diffHead = closestWithAttr(target, 'data-diff-toggle');
      if (diffHead) { event.preventDefault(); toggleBody(diffHead, '.diff-body'); return; }

      var toolHead = closestWithAttr(target, 'data-tool-toggle');
      if (toolHead) { event.preventDefault(); toggleBody(toolHead, '.tool-body'); return; }

      var terminal = closestWithAttr(target, 'data-terminal');
      if (terminal) {
        event.preventDefault();
        // Session-scoped: postForSession stamps the focused session id so the
        // extension can resolve that session's connection + terminal handler.
        NS.bridge.postForSession({ type: 'openTerminal', terminalId: terminal.getAttribute('data-terminal') });
        return;
      }

      var pathNode = closestWithAttr(target, 'data-path');
      if (pathNode) {
        event.preventDefault();
        var line = pathNode.getAttribute('data-line');
        NS.bridge.postForSession({
          type: 'openFile',
          path: pathNode.getAttribute('data-path'),
          line: line ? parseInt(line, 10) : undefined
        });
        return;
      }

      var link = closestWithAttr(target, 'data-href');
      if (link) {
        event.preventDefault();
        NS.bridge.post({ type: 'openLink', href: link.getAttribute('data-href') });
        return;
      }
    });
  }

  NS.links = {
    decorateScrollables: decorateScrollables,
    installDelegatedHandlers: installDelegatedHandlers
  };
})(window.__acpc = window.__acpc || {});
`;
