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
  function entryIdOf(node) {
    if (!node || !node.closest) { return ''; }
    var holder = node.closest('[data-entry-id]');
    if (holder) { return holder.getAttribute('data-entry-id') || ''; }
    // [CUSTOM-20261007-197] 置顶悬浮卡是**另一棵树**：卡外壳（.sticky-card / .sticky-body）与
    // 它里面的克隆体都在 .sticky-user 下，而用户右键点中的常常是卡片那一圈留白/边框 ——
    // 那里没有 data-entry-id，菜单于是只剩一条**灰掉的** "Copy"（它复制的是**选区**，右键时
    // 通常没有选区）+ "Select all"，没有任何办法复制这条消息（用户报的就是这个）。
    // 卡片自己带着这条记录的 id（stickyUser 写的 data-sticky-id），在这一层认下来即可。
    var card = node.closest('.sticky-card');
    return card && card.getAttribute ? (card.getAttribute('data-sticky-id') || '') : '';
  }

  function entryTextOf(node) {
    var id = entryIdOf(node);
    if (!id || !NS.transcriptView.entry) { return ''; }
    var entry = NS.transcriptView.entry(id);
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
    // [CUSTOM-BEGIN] CUSTOM-20261009-211 - 三个上下文专属格。它们**必须**排在通用清单之前：
    // 这几处右键时通常没有选区，通用那条 Copy 只会灰着（"有个 Copy 但点不动"——用户报的
    // 就是它），而用户要的拷贝内容与"选区"根本不是一回事：
    //   1) 大纲行（含下拉抽屉）：Copy = 这条消息的**正文**（整条记录，不是截断的标题）；
    //   2) 地址栏（#cwdBtn）：Copy = 它正显示的目录路径；
    //   3) 会话 tab：Close（关掉这个 tab，会话留在列表里）/ Rename（给这条会话改名）。
    // 选择器都带各自的 data-*，"是不是这一类"不靠猜（表格里都是真 button，不冲突）。
    var outlineRow = target && target.closest ? target.closest('.outline-item[data-jump-id]') : null;
    if (outlineRow) {
      var jumpId = outlineRow.getAttribute('data-jump-id');
      var entry = jumpId && NS.transcriptView && NS.transcriptView.entry
        ? NS.transcriptView.entry(jumpId) : null;
      var text = entry && typeof entry.text === 'string' ? entry.text : '';
      if (!text) {
        // 记录已经不在（会话被换掉之类）：退回行上可见的文本，绝不复制空串。
        var labelEl = outlineRow.querySelector ? outlineRow.querySelector('.outline-text') : null;
        text = labelEl ? String(labelEl.textContent || '') : '';
      }
      return [{ label: 'Copy', run: function () { copy(text); } }];
    }
    var addr = target && target.closest ? target.closest('.session-title') : null;
    if (addr) {
      // .session-title 就是 body.ts 的 #cwdBtn（地址栏按钮）——用类选择器是为了桩 DOM 也
      // 认（它只支持标签 / .class / [attr]，见 chat-client.test.ts 的 matchesOne）。
      // currentCwd() 是"地址栏此刻显示的是什么"的同源读口（155）；草稿页它的文案可能不是
      // 路径（如 "Default directory"），拿不到 cwd 时退回可见文本 —— 复制它自己显示的东西，
      // 与菜单项的语义一致。
      var path = NS.tabs && NS.tabs.currentCwd ? NS.tabs.currentCwd() : '';
      if (!path) { path = String(addr.textContent || ''); }
      return [{ label: 'Copy', run: function () { copy(path); } }];
    }
    var tab = target && target.closest ? target.closest('.tab') : null;
    if (tab) {
      var tabItems = [{
        label: 'Close',
        run: function () { if (NS.tabs && NS.tabs.closeTabNode) { NS.tabs.closeTabNode(tab); } }
      }];
      // Rename 只对**真会话** tab 有意义（草稿/待恢复的还没有会话可改名，× 已是它们的语义）。
      // 初值取行上**看得见**的标签（与用户看到的一致，155 的同源原则）；宿主弹原生输入框。
      if (tab.getAttribute('data-session-id')) {
        tabItems.push({
          label: 'Rename',
          run: function () {
            var tabLabelEl = tab.querySelector ? tab.querySelector('.tab-label') : null;
            NS.bridge.post({
              type: 'renameSession',
              sessionId: tab.getAttribute('data-session-id'),
              currentTitle: tabLabelEl ? String(tabLabelEl.textContent || '') : ''
            });
          }
        });
      }
      return tabItems;
    }
    // [CUSTOM-20261009-212] 历史列表的行（sessionMenu 的行也带 data-open-session）：悬停图标
    // 够不着的键盘用户（Shift+F10）走这里一样能归档/改名 —— 同一对动作、同一个出口。
    var historyRow = target && target.closest ? target.closest('.outline-item[data-open-session]') : null;
    if (historyRow) {
      var historyId = historyRow.getAttribute('data-open-session');
      var historyTitle = historyRow.getAttribute('data-open-title') || '';
      return [
        { label: 'Archive', run: function () { NS.bridge.post({ type: 'archiveSession', sessionId: historyId }); } },
        {
          label: 'Rename',
          run: function () {
            NS.bridge.post({ type: 'renameSession', sessionId: historyId, currentTitle: historyTitle });
          }
        }
      ];
    }
    // [CUSTOM-END] CUSTOM-20261009-211

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

  // itemsFor 是给桩 DOM 测试用的（"右键这一处会给哪些项"是这套菜单的全部语义，
  // 而菜单本身的显示/定位属于布局，见 preview-records.mjs）。
  NS.contextMenu = { install: install, close: close, itemsFor: itemsFor };
})(window.__acpc = window.__acpc || {});
`;
