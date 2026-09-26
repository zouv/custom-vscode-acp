// [CUSTOM-20260925-067] 自定义右键菜单：新增客户端模块。
//
// **为什么要有它**：webview 里默认弹的是 **Chromium 的原生菜单**（Cut / Copy / Paste）。
// 它在这个面板上有两个问题：
//   1. **Cut / Paste 无意义**——面板内容除了输入框都是只读的；
//   2. **Copy 会"点了没反应"**——它复制的是**选区**，而右键时通常并没有选中文本；
//      于是用户得到一个看起来可用、实际什么都不做的菜单项。
//
// 自己的菜单按上下文给项，且**没有 Cut/Paste**：
//   · Copy          —— 复制当前选区（没选区时**禁用**，而不是装作能用）；
//   · Copy message  —— 复制整条记录（用户/助手/推理/通知的正文）；
//   · Copy code     —— 复制代码块内容；
//   · Select all    —— 选中整个对话区，方便手动复制。
//
// 复制一律走**扩展侧的 `copy` 通道**（与代码块的 Copy 按钮同一条路）：webview 里的
// `navigator.clipboard` 依赖文档焦点，不可靠。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260925-067
export const contextMenuClient = `
(function (NS) {
  'use strict';

  var menu = null;
  var itemsEl = null;

  function selectionText() {
    var selection = window.getSelection ? window.getSelection() : null;
    return selection ? String(selection.toString() || '') : '';
  }

  function copy(text) {
    if (!text) { return; }
    NS.bridge.post({ type: 'copy', text: text });
  }

  function selectAll() {
    var messages = NS.dom.qs('messages');
    var selection = window.getSelection ? window.getSelection() : null;
    if (!messages || !selection || !selection.selectAllChildren) { return; }
    selection.removeAllRanges();
    selection.selectAllChildren(messages);
  }

  /** The entry a node belongs to (records carry data-entry-id, see transcriptView.place). */
  function entryTextOf(node) {
    var holder = node && node.closest ? node.closest('[data-entry-id]') : null;
    if (!holder || !NS.transcriptView.entry) { return ''; }
    var entry = NS.transcriptView.entry(holder.getAttribute('data-entry-id'));
    return entry && typeof entry.text === 'string' ? entry.text : '';
  }

  function codeTextOf(node) {
    var wrap = node && node.closest ? node.closest('.code-wrap') : null;
    var code = wrap ? wrap.querySelector('code') : null;
    return code ? String(code.textContent || '') : '';
  }

  /**
   * Context-appropriate items. Only what actually applies is listed, so no item is
   * ever a no-op (that was the whole complaint about the native menu).
   */
  function itemsFor(target) {
    var items = [];
    var selected = selectionText();
    items.push({
      label: 'Copy', disabled: selected.length === 0,
      run: function () { copy(selected); }
    });

    var message = entryTextOf(target);
    if (message) {
      items.push({ label: 'Copy message', run: function () { copy(message); } });
    }

    var code = codeTextOf(target);
    if (code) {
      items.push({ label: 'Copy code', run: function () { copy(code); } });
    }

    items.push({ label: 'Select all', run: selectAll });
    return items;
  }

  function render(target) {
    NS.dom.clear(itemsEl);
    var items = itemsFor(target);
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var btn = NS.dom.el('button', 'ctx-item', item.label);
        btn.type = 'button';
        if (item.disabled) {
          btn.disabled = true;
          btn.title = 'Select some text first';
        } else {
          btn.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            close();
            item.run();
          });
        }
        itemsEl.appendChild(btn);
      })(items[i]);
    }
  }

  /** Keep the menu inside the viewport (flip up / left when it would overflow). */
  function place(x, y) {
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    var rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) { menu.style.top = Math.max(0, y - rect.height) + 'px'; }
    if (rect.right > window.innerWidth) { menu.style.left = Math.max(0, x - rect.width) + 'px'; }
  }

  function close() {
    if (!menu || menu.hidden) { return; }
    menu.hidden = true;
  }

  function open(event) {
    if (!menu) { return; }
    render(event.target);
    menu.hidden = false;
    place(event.clientX, event.clientY);
    var first = itemsEl.querySelector('.ctx-item:not(:disabled)');
    if (first) { first.focus(); }
  }

  function install() {
    menu = NS.dom.qs('ctxMenu');
    if (!menu) { return; }
    itemsEl = menu.querySelector('.ctx-items');

    // Take the menu over from Chromium entirely: leaving the native one in place
    // would give two menus, and the native one offers Cut/Paste that mean nothing
    // here (see the file header).
    document.addEventListener('contextmenu', function (event) {
      if (event.target && event.target.closest && event.target.closest('.prompt-input')) { return; }
      event.preventDefault();
      open(event);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);
    // Any click, scroll or resize dismisses it - a floating menu that outlives its
    // context is worse than no menu.
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    close();
  }

  NS.contextMenu = { install: install, close: close };
})(window.__acpc = window.__acpc || {});
`;
