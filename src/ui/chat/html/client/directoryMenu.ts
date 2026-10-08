// [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页的目录选择抽屉：新增客户端模块。
// 形态照抄 sessionMenu.ts（021/033 那套 `.outline*` 样式与抽屉交互）——两者是同一类东西：
// 标题栏下沿的一个浮层。
//
// 它只负责「选」，不负责「存」：选中的目录交给 `NS.draft.setCwd()` / `NS.draft.start()`。
//
// **两条踩过的坑，改这个文件前必读**（CUSTOM-20260925-058 的第一次实现就栽在这里）：
//   1. **数据更新不许门控于 `open`。** 初版在 `setChoices` 里先判 `if (!open) return;`，
//      而草稿页出现时抽屉本来就是关的（`focusDraft` 直接调 `refresh`，不经过 `show`）⇒
//      **默认目录永远没被采用**，头部一直显示 "Default directory"。
//   2. **系统文件夹对话框是会抢焦点的异步交互。** 初版在 `setPicked` 里同样先判 `open`，
//      于是"对话框返回时抽屉恰好是关的"就把用户的选择**静默丢弃**了。
//      现在无论抽屉开没开都应用结果，只在需要重绘时才看 `open`。
//   两条是同一个反模式：**把数据更新挂在 UI 状态上，失败还不出声**。它们的症状都极其安静。
//
// 单一真相源：本模块**只存 `draftId`**，当前目录在渲染时从 `NS.draft.get(draftId)` 现读——
// 不缓存第二份 draft 对象（同族问题见 pitfalls #19）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260925-058
export const directoryMenuClient = `
(function (NS) {
  'use strict';

  var button = null;
  var drawer = null;
  var headEl = null;
  var listEl = null;
  var choices = null;
  /** Which draft this drawer is choosing for; null = an already-started session. */
  var draftId = null;
  var open = false;
  var pending = false;

  function currentDraft() {
    if (!draftId || !NS.draft || !NS.draft.get) { return null; }
    return NS.draft.get(draftId);
  }

  function closeOtherDrawers() {
    if (NS.outline && NS.outline.close) { NS.outline.close(); }
    if (NS.sessionMenu && NS.sessionMenu.reset) { NS.sessionMenu.reset(); }
  }

  /**
   * Apply a directory. **Never gated on the drawer being open** — see the header
   * note; the choice comes back from a focus-stealing dialog.
   */
  function applyPath(path) {
    if (!path) { return; }   // the user cancelled the native picker
    if (!NS.draft) {
      // Should be unreachable (boot defines NS.draft before any click can land).
      // Audible on purpose: a silent return here is exactly how the original bug
      // hid — see pitfalls #23.
      console.warn('[acpc] directory pick ignored: draft support is not loaded');
      return;
    }
    if (drawer && open) { close(); }
    if (draftId) { NS.draft.setCwd(draftId, path); }
    else { NS.draft.start(path); }
  }

  function choose(path) { applyPath(path); }

  function makeRow(label, path, className) {
    var item = NS.dom.el('button', 'outline-item' + (className ? ' ' + className : ''));
    item.type = 'button';
    if (path) { item.setAttribute('data-cwd-choice', path); item.setAttribute('title', path); }
    else { item.setAttribute('data-cwd-browse', '1'); }
    item.appendChild(NS.dom.el('span', 'outline-text', label));
    item.addEventListener('click', function (event) {
      event.preventDefault();
      if (path) { choose(path); return; }
      // Ask the HOST to open the native picker (the webview cannot).
      pending = true;
      render();
      NS.bridge.post({ type: 'pickDirectory' });
    });
    return item;
  }

  function group(label, paths) {
    if (!paths || paths.length === 0) { return; }
    listEl.appendChild(NS.dom.el('div', 'outline-group', label));
    for (var i = 0; i < paths.length; i++) { listEl.appendChild(makeRow(paths[i], paths[i], '')); }
  }

  function render() {
    if (!drawer) { return; }
    NS.dom.clear(headEl);
    NS.dom.clear(listEl);
    headEl.appendChild(NS.dom.el('span', 'outline-count', pending ? 'Loading\\u2026' : 'Working directory'));
    if (pending) { return; }

    var folders = (choices && choices.workspaceFolders) || [];
    var recent = (choices && choices.recent) || [];
    var draft = currentDraft();

    if (draftId) {
      listEl.appendChild(NS.dom.el('div', 'outline-group',
        'This session will be created in: ' + ((draft && draft.cwd) || 'the default directory')));
      group('Workspace folders', folders);
      group('Recently used', recent);
      listEl.appendChild(makeRow('Browse\\u2026', null, 'outline-browse'));
      return;
    }

    // A session that has already started cannot have its directory changed: the
    // protocol fixes it at creation. Offering a "change" here would be a lie, so
    // the candidates open a NEW draft instead.
    listEl.appendChild(NS.dom.el('div', 'outline-group',
      'This session has already started, so its directory is fixed. Pick one to start a new session there:'));
    group('Workspace folders', folders);
    group('Recently used', recent);
    listEl.appendChild(makeRow('Another directory\\u2026', null, 'outline-browse'));
  }

  /** Point the drawer at a draft (or at nothing = "an existing session"). */
  function refresh(forDraft) {
    draftId = forDraft ? forDraft.draftId : null;
    var hadChoices = !!choices;
    if (!hadChoices) { pending = true; }
    render();
    // [CUSTOM-20261008-203] **每开一次都回头问一次**（先渲染手上这份，回复到了再重渲染）。
    //
    // 这份候选会变：Browse 选过的目录、刚用过的目录都要等宿主把它们算进最近列表 —— 而 'choices'
    // 以前是"一次拉取、终身缓存"（'reset()' 都不清），于是**当天新用过的目录永远进不了
    // 「Recently used」**。用户报的正是它：「刚通过 Browse 选择的目录（还发起了对话），最近使用里
    // 没有这个记录」。
    //
    // 只在**第一次**（还没数据）与**打开时**问：boot 在切草稿/切会话时也会调这里（那时抽屉是关的），
    // 那条路径上一次都不能多问 —— 宿主的回复里可能带一次 'session/list'（真 RPC）。
    if (!hadChoices || open) { NS.bridge.post({ type: 'listDirectoryChoices' }); }
  }

  function show() {
    open = true;
    drawer.hidden = false;
    button.classList.add('on');
    closeOtherDrawers();
    refresh(currentDraft());
  }

  function close() {
    if (!open) { return; }
    open = false;
    pending = false;
    drawer.hidden = true;
    button.classList.remove('on');
  }

  function toggle() { if (open) { close(); } else { show(); } }

  /**
   * Reply to listDirectoryChoices.
   *
   * **The draft adopts the default here, regardless of whether the drawer is
   * open** — that is what gives the header a real path from the start (and the
   * send path uses the same default). Gating this on 'open' was the first bug
   * this module had: the header sat on "Default directory" forever.
   */
  function setChoices(message) {
    choices = message || null;
    pending = false;
    var draft = currentDraft();
    if (draft && !draft.cwd && choices && choices.defaultCwd && NS.draft) {
      NS.draft.setCwd(draftId, choices.defaultCwd);
    }
    if (open) { render(); }
  }

  /**
   * Reply to pickDirectory; null means the user cancelled.
   * **Applied whether or not the drawer is still open** — the native dialog
   * steals focus, so its result must not depend on our UI state.
   */
  function setPicked(path) {
    pending = false;
    if (!path) { if (open) { render(); } return; }
    applyPath(path);
  }

  function init() {
    button = NS.dom.qs('cwdBtn');
    drawer = NS.dom.qs('cwdMenu');
    if (drawer) {
      headEl = drawer.querySelector('.outline-head');
      listEl = drawer.querySelector('.outline-list');
    }
    if (button) {
      button.addEventListener('click', function (event) { event.preventDefault(); toggle(); });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);
    document.addEventListener('click', function (event) {
      if (!open) { return; }
      if (drawer.contains(event.target) || button.contains(event.target)) { return; }
      close();
    });
    close();
  }

  /** Focus changed: the drawer belongs to the previous session/draft. */
  function reset() { close(); draftId = null; }

  NS.directoryMenu = {
    init: init,
    reset: reset,
    refresh: refresh,
    setChoices: setChoices,
    setPicked: setPicked,
    close: close
  };
})(window.__acpc = window.__acpc || {});
`;
