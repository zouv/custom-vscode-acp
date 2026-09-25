// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 样式。全部走 `--vscode-*` 主题变量，不硬编码颜色，因此自动适配明/暗主题。
// 工具调用状态类用的是 ACP 的真实取值（pending / in_progress / completed / failed）——
// 旧面板判的是 'running'，那是个 ACP 从不发送的字符串。
// [CUSTOM-END] CUSTOM-20260923-011
export function styles(): string {
  return `<style>
  * { box-sizing: border-box; }

  /* ⚠️ 不要删这条规则。
     'hidden' 属性靠 UA 样式表的 [hidden]{display:none} 生效，而**作者样式里的任何 display
     声明都会覆盖它**——这与选择器权重无关，是"作者样式 > UA 样式"的层叠顺序决定的。
     本文件里 .load-overlay / .agent-bar / .attachments 都需要 flex 布局，没有这条 !important
     的话它们会**永远可见**（曾导致加载遮罩常驻不消失、并吞掉整个面板的点击）。
     改了这条之后：给任何用 hidden 控制的元素加 display 都要先想一下这里。
     另：本文件是模板字符串，注释里禁用反引号——用单引号。 */
  [hidden] { display: none !important; }

  /* --- 键盘可达性基础设施（CUSTOM-20260925-047）------------------------
     面板此前**完全无法用键盘操作**：标签、抽屉行、菜单项、斜杠项、工具卡头、
     diff 头、文件 chip 都是 div/span + click，既不可聚焦也没有 Enter/Space 处理。
     它们现在都是真正的 <button>，这一块的职责是**把 UA 的按钮样式抹平**，
     使外观与改动前一致，并补上面板从来没有过的焦点环。

     位置有讲究：必须放在下方各 class 规则**之前**，让同权重的 class 规则覆盖它。
     （'.chip' / '.tab.active' / '.outline-item:hover' / '.rail-dot.turn' 都在后面，
     它们要么权重更高、要么同权重后出现，所以外观不受影响。） */
  button { font-family: inherit; font-size: inherit; color: inherit; }
  /* [CUSTOM-20260925-058] '.session-title'（显示工作目录的那格）从 span 变成了按钮，
     因此也进这个清单。**注意它不加 width: 100%**——它自身有 'flex: 1' 要吃掉剩余
     宽度，两者会打架。 */
  .tab, .outline-item, .picker-item, .slash-item,
  .tool-head, .diff-head, .chip, .session-title {
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
  }
  /* 宽度：这三个都在**块级容器**里（.outline-list / .picker-menu / .slash-popup），
     按钮默认是 inline-block（收缩到内容宽），所以必须显式铺满。
     **'.tab' 不在此列**——它是 '.tabs'（flex 行）的子项，给 flex 子项写 width: 100%
     会解析成"容器内容宽的 100%"，而容器宽又由子项决定（循环），浏览器只能退回
     max-content 求解，结果是每个标签都被撑到最宽那个的宽度、整条标签栏变形。 */
  .outline-item, .picker-item, .slash-item, .tool-head, .diff-head { width: 100%; }
  .picker-item, .slash-item { display: block; }
  /* .rail-dot 也是 <button>：它自带 background（两级样式权重更高），但 '.turn' 那档
     **只设了 background、没设 border**，不抹掉 UA 的 2px outset 就会多出一圈边框。
     padding 同理——它的尺寸完全由 CSS 决定，多 1px 就会偏位。 */
  .rail-dot { padding: 0; border: none; background: transparent; }
  /* 焦点必须可见。用 :focus-visible 而不是 :focus，鼠标点击不会留下焦点环。 */
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  body {
    margin: 0;
    padding: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }

  /* --- Agent selector ------------------------------------------------- */
  .agent-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .agent-select {
    flex: 1;
    min-width: 0;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px;
    padding: 2px 4px;
    font-family: inherit;
    font-size: inherit;
  }

  /* --- Tabs ------------------------------------------------------------ */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .tabs { display: flex; gap: 2px; flex: 0 0 auto; }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 200px;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    opacity: 0.75;
  }
  .tab:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .tab.active {
    background: var(--vscode-editor-background);
    border-color: var(--vscode-panel-border);
    opacity: 1;
  }
  .tab-label { overflow: hidden; text-overflow: ellipsis; }
  .tab-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
    background: var(--vscode-descriptionForeground);
  }
  .tab-dot.running { background: var(--vscode-progressBar-background); animation: pulse 1.2s ease-in-out infinite; }
  .tab-dot.loading { background: var(--vscode-charts-yellow); }
  /* [CUSTOM-20260925-052] 设计预留、**从未接线**：没有任何 JS 会给标签加 attention
     类（全仓库 grep 只命中这一行）。它的本意是"后台会话在等你"（比如那边有待决的权限
     请求）——而那件事目前由窗口级弹框承担，面板内不做提示（用户 2026-09-25 明确决定）。
     留着是为了将来接线时不用重新想配色。**看到它没生效别当 bug 修**：先确认要不要做
     那个功能，而不是去找"为什么类没加上"。 */
  .tab-dot.attention { background: var(--vscode-charts-blue); }
  .tab-close {
    border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 0 2px; line-height: 1; opacity: 0.6; font-size: 11px;
  }
  .tab-close:hover { opacity: 1; color: var(--vscode-errorForeground); }
  .tab-new {
    flex: 0 0 auto; margin-left: 4px; padding: 2px 8px; cursor: pointer;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    font-family: inherit; font-size: 14px; line-height: 1.2;
  }
  .tab-new:hover { background: var(--vscode-list-hoverBackground); }

  /* --- Session header / usage ------------------------------------------ */
  .session-header {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 10px;
    min-height: 22px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 0.9em;
    /* Anchor for the conversation outline dropdown. Do NOT add overflow here. */
    position: relative;
    color: var(--vscode-descriptionForeground);
  }
  .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  /* --- Conversation outline (CUSTOM-20260924-021) ---------------------- */
  /* 抽屉从标题栏下沿展开。.session-header 没有 overflow: hidden（已核对），
     否则绝对定位的抽屉会被裁掉——这是这类浮层最常见的失灵原因。 */
  .outline-btn {
    flex: none; cursor: pointer; font-family: inherit; font-size: 1em; line-height: 1;
    padding: 2px 5px; border-radius: 3px;
    background: transparent; color: var(--vscode-icon-foreground, currentColor);
    border: 1px solid transparent;
  }
  .outline-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  /* Icon buttons in the session header (history / clock, CUSTOM-20260925-035). */
  .outline-btn .btn-icon { display: inline-flex; align-items: center; }
  .outline-btn .btn-icon svg { display: block; width: 14px; height: 14px; }
  .outline-btn.on {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .outline {
    position: absolute; top: 100%; left: 6px; right: 6px; z-index: 25;
    max-height: 50vh; overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 3px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .outline-head {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px; font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0;
    background: inherit;
  }
  .outline-more { margin-left: auto; }
  /* [CUSTOM-20260925-058] 目录抽屉里的分组标题 / 说明行。观感沿用 .picker-group，
     因为它俩都是"同一类浮层里的分组头"。 */
  .outline-group {
    padding: 5px 8px 2px; font-size: 0.82em; line-height: 1.35;
    color: var(--vscode-descriptionForeground);
  }
  /* 草稿标签：会话还不存在，所以是空心虚线点 + 斜体标签，与真实会话区分开。 */
  .tab-draft .tab-dot {
    background: transparent;
    border: 1px dashed var(--vscode-descriptionForeground);
  }
  .tab-draft .tab-label { font-style: italic; }
  .outline-item {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 8px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .outline-item:hover { background: var(--vscode-list-hoverBackground); }
  .outline-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
  }
  .outline-time {
    flex: none; font-size: 0.82em; font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
  }
  .outline-item.active .outline-time { color: inherit; opacity: 0.85; }
  .outline-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* [CUSTOM-20260925-057] 历史会话行右侧的目录提示（只显示最后一段，全路径在 tooltip 里）。
     没有它的话，245 条跨目录会话只能靠 hover 才知道各自属于哪个项目。 */
  .outline-cwd {
    flex: 0 0 auto; max-width: 40%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-size: 0.82em; color: var(--vscode-descriptionForeground);
  }
  .usage-bar { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .usage-track {
    display: inline-block; width: 60px; height: 6px; border-radius: 3px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    vertical-align: middle; margin: 0 4px; overflow: hidden;
  }
  .usage-fill { display: block; height: 100%; background: var(--vscode-progressBar-background); }
  .usage-fill.warn { background: var(--vscode-charts-yellow); }
  .usage-fill.hot { background: var(--vscode-charts-red); }

  /* --- Messages -------------------------------------------------------- */
  .message-area { position: relative; flex: 1; min-height: 0; display: flex; }
  /* --- Conversation rail (CUSTOM-20260924-023) ------------------------- */
  /* 左侧引导条：轮次大点 + 步骤小点，随内容滚动（track 由 JS 做 translateY(-scrollTop)）。
     注意本元素**不能**写 display——hidden 属性靠文件顶部的 [hidden]{display:none!important}
     生效，那条规则就是为它兜底的（见 pitfalls #13）；absolute 定位的元素默认就是块级。
     条本身 pointer-events: none，避免挡住左侧文字的选区；只有点可点。 */
  .rail {
    position: absolute; left: 0; top: 0; bottom: 0; width: 20px;
    overflow: hidden; z-index: 3; pointer-events: none;
  }
  .rail-track { position: absolute; left: 0; top: 0; width: 100%; height: 0; }
  .rail-line {
    position: absolute; width: 1px; left: 9.5px;
    background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  }
  .rail-dot {
    position: absolute; border-radius: 50%; box-sizing: border-box;
    pointer-events: auto; cursor: pointer;
  }
  /* 两级：轮次点更大且实心，步骤点小且空心。margin-top 取负的一半尺寸，
     这样 JS 只需写 top = 中心 y（绝对定位元素的 margin 会参与位移，这里正好要用）。 */
  .rail-dot.turn {
    left: 5px; width: 10px; height: 10px; margin-top: -5px;
    background: var(--vscode-descriptionForeground, #888);
  }
  .rail-dot.step {
    left: 6.5px; width: 7px; height: 7px; margin-top: -3.5px;
    border: 1px solid var(--vscode-descriptionForeground, #888);
    background: var(--vscode-editor-background);
  }
  .rail-dot.turn.done { opacity: 0.75; }
  .rail-dot.step.done { opacity: 0.6; }
  .rail-dot.running {
    border-color: var(--vscode-charts-blue, var(--vscode-focusBorder));
    background: var(--vscode-charts-blue, var(--vscode-focusBorder));
  }
  .rail-dot.failed {
    border-color: var(--vscode-charts-red, #f14c4c);
    background: var(--vscode-charts-red, #f14c4c);
  }
  .rail-dot.active {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--vscode-focusBorder);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    /* padding-left 给左侧引导条留出通道（.rail 是绝对定位的兄弟节点，覆盖在这条空隙上） */
    padding: 8px 10px 4px 19px;
    display: flex;
    flex-direction: column;
    /* 间距交给下面的阶梯控制。统一 gap 会让「同属一组的连续推理」和「跨类型的独立块」
       看起来一样疏——那正是"不同段区分度太低"的来源。 */
    gap: 0;
    scrollbar-width: thin;
  }
  /* [CUSTOM-20260925-037] 子项**不许被压缩**——这条是 .messages 用 flex 排布的前提，别删。
     规范：flex 子项的「自动最小尺寸」在其 overflow 不是 visible 时**等于 0**。而工具卡
     .tool 正好有 overflow: hidden，于是内容一超出容器，flex 就把 206 张卡一起压成 2px
     （只剩两条边框），卡片内容被 overflow 裁掉——用户看到的就是"整屏白条"。
     用户气泡 / plan 卡没有 overflow，自动最小尺寸是内容高度，压不动，所以它们看起来是好的：
     user h=31 / tool h=2 / plan 正常 这组数据就是这条规范留下的指纹。
     加 flex-shrink: 0 之后，溢出的内容会交给 .messages 的 overflow-y: auto 去滚。
     对照：.tab-strip 同样是 flex + overflow，但它的子项早就写了 flex: 0 0 auto，所以从没出过这个问题。 */
  .messages > * { flex: 0 0 auto; }

  /* [CUSTOM-20260925-049] Drop feedback: shown while a file is dragged over the
     panel. Uses the focus border so it is visible in every theme. */
  body.drop-active .message-area {
    outline: 2px dashed var(--vscode-focusBorder);
    outline-offset: -4px;
  }
  /* 三档间距阶梯：同类紧 / 跨类松 / 轮次边界最松。
     data-kind 由 transcriptView.place() 打在每条上，这里纯用兄弟选择器实现。 */
  .messages > * + * { margin-top: 10px; }
  .messages > [data-kind="thought"] + [data-kind="thought"] { margin-top: 2px; }
  .messages > [data-kind="tool"]    + [data-kind="tool"]    { margin-top: 4px; }
  .messages > [data-kind="content"] + [data-kind="content"] { margin-top: 2px; }
  .messages > [data-kind="user"] { margin-top: 16px; }
  .jump-latest {
    position: absolute; right: 14px; bottom: 12px;
    padding: 3px 10px; border-radius: 12px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; font-family: inherit; font-size: 0.9em;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
  }
  .jump-latest:hover { background: var(--vscode-button-hoverBackground); }

  .empty-state { margin: auto; text-align: center; color: var(--vscode-descriptionForeground); padding: 20px; }
  /* 空态里的「连接」按钮（CUSTOM-20260925-032）：面板自己就能把 agent 拉起来，
     不必先去 Agents 视图。 */
  .empty-connect {
    margin-top: 10px; padding: 4px 14px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 0.95em;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .empty-connect:hover { background: var(--vscode-button-hoverBackground); }
  .empty-title { font-weight: 600; margin: 0 0 6px; }
  .empty-hint { margin: 0; font-size: 0.92em; }
  kbd {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 0 4px;
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
  }

  .entry { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
  .entry-user { align-self: flex-end; max-width: 88%; }
  .entry-user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 6px 10px; border-radius: 8px 8px 2px 8px;
    white-space: pre-wrap; word-break: break-word;
  }
  .entry-assistant { align-self: stretch; }
  .entry-assistant .bubble {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px 8px 8px 2px;
    padding: 6px 10px;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .entry-assistant .bubble.md { white-space: normal; }
  .entry-notice { align-self: center; font-size: 0.9em; padding: 2px 8px; border-radius: 4px; }
  /* --- Record-type icons (CUSTOM-20260924-028) -------------------------- */
  /* 每类记录左侧一个内联 SVG 图标。用 currentColor 描边，所以自动跟随所在文字的颜色
     （用户气泡=按钮前景色、推理=次要色、工具卡=正文色）。 */
  .rec-icon {
    display: inline-flex; align-items: center; vertical-align: -1px;
    margin-right: 4px; opacity: 0.7;
  }
  .rec-icon svg { display: block; }
  .tool-icon { flex: 0 0 auto; display: inline-flex; align-items: center; opacity: 0.7; }
  .tool-icon svg { display: block; }
  /* --- Permission card (CUSTOM-20260924-020) --------------------------- */
  /* 面板内的权限请求卡：替代窗口级 QuickPick。配色故意用 warn 边框而不是普通卡片，
     因为它是**阻塞的**——agent 在等到答复前不会继续。 */
  .entry-permission { align-self: stretch; }
  .perm {
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
    border-left-width: 3px;
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    display: flex; flex-direction: column; gap: 8px;
  }
  .perm.pending { border-left-color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
  .perm.deferred { opacity: 0.75; }
  .perm.selected, .perm.cancelled { border-left-color: var(--vscode-panel-border); background: transparent; }
  .perm-head { display: flex; align-items: center; gap: 6px; }
  .perm-badge {
    flex: none; width: 16px; height: 16px; border-radius: 50%;
    background: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
    color: var(--vscode-editor-background);
    font-size: 0.75em; font-weight: 700; line-height: 16px; text-align: center;
  }
  .perm-title { flex: 1; font-size: 0.95em; word-break: break-word; }
  .perm-kind {
    flex: none; font-size: 0.8em; padding: 0 5px; border-radius: 3px;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .perm-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .perm-btn {
    padding: 3px 12px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 0.92em;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  .perm-btn.allow {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .perm-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .perm-btn:disabled { cursor: default; opacity: 0.5; }
  .perm-note { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  /* Non-text message content (image / resource chips) */
  .entry-content { align-self: stretch; gap: 2px; }
  .entry-notice.info { color: var(--vscode-descriptionForeground); }
  .entry-notice.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  .entry-notice.error {
    color: var(--vscode-inputValidation-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }

  /* Markdown */
  .bubble p { margin: 0 0 6px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 8px 0 4px; line-height: 1.3; }
  .bubble ul, .bubble ol { margin: 4px 0; padding-left: 20px; }
  .bubble pre {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px; padding: 8px; overflow-x: auto; margin: 6px 0;
  }
  .bubble code {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, 0.95em);
  }
  .bubble :not(pre) > code {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 0 3px;
  }
  .bubble blockquote {
    margin: 6px 0; padding-left: 10px;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .bubble table { border-collapse: collapse; margin: 6px 0; }
  .bubble th, .bubble td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  .bubble a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .bubble a:hover { text-decoration: underline; }
  .link-blocked {
    color: var(--vscode-descriptionForeground);
    text-decoration: line-through;
    cursor: help;
  }
  .img-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 0 5px; font-size: 0.9em;
  }
  .content-image { max-width: 100%; border-radius: 4px; margin: 4px 0; }

  /* [CUSTOM-20260925-050] 编辑区面与编辑器标签同处一列：用侧边栏底色会像"外部面板
     贴在了编辑区里"。类名由 body(surface) 打在 <body> 上（见 html/body.ts）。
     侧边栏面不加任何规则——它必须保持侧边栏底色。 */
  .surface-editor {
    background: var(--vscode-editor-background);
  }
  .surface-editor .composer,
  .surface-editor .load-overlay {
    background: var(--vscode-editor-background);
  }

  /* [CUSTOM-20260925-050] 尊重系统的"减少动效"偏好。面板的 pulse / spin 是纯装饰
     （进度点、加载圈），关掉不影响任何状态表达。 */
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }

  /* [CUSTOM-20260925-051] 代码块的语言标签。放**左上角**——右上角归 Copy 按钮。
     pointer-events: none 让它不挡住代码的选区。 */
  .code-lang {
    position: absolute; top: 4px; left: 6px;
    font-family: var(--vscode-editor-font-family); font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    pointer-events: none;
  }
  /* 只有带语言标签的代码块才需要让出顶部空间，否则普通代码块会凭空多出一条空白。 */
  .code-wrap.has-lang pre { padding-top: 20px; }

  /* Copy button injected into rendered code blocks */
  .code-wrap { position: relative; }
  .code-copy {
    position: absolute; top: 4px; right: 4px;
    padding: 1px 6px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none; font-family: inherit; font-size: 0.85em; opacity: 0;
    transition: opacity .12s ease-in-out;
  }
  .code-wrap:hover .code-copy { opacity: 1; }

  /* --- Thoughts --------------------------------------------------------
     三级视觉层次里最轻的一档（L1 气泡 / L2 卡片 / L3 轻卡）。
     折叠态刻意做得很安静：无背景、无边框、次要色、略小字号——推理是辅助信息。
     展开态给出淡背景 + 边框 + 圆角，与折叠态形成**强对比**。
     缺了这个对比时，展开与折叠只差高度，读者分辨不出"这是一段独立内容"。 */
  .thought {
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .thought > summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
    padding: 1px 2px;
    border-radius: 3px;
  }
  .thought > summary::-webkit-details-marker { display: none; }
  /* 自定义折叠标记：原生三角太小且样式不可控（Chromium 下基本没法调） */
  .thought > summary::before {
    content: '▸';
    display: inline-block; width: 12px; opacity: .7;
  }
  .thought[open] > summary::before { content: '▾'; }
  .thought[open] {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    padding: 2px 6px 4px;
  }
  .thought[open] > summary { color: var(--vscode-foreground); }
  .thought-body {
    max-height: 300px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    margin-top: 3px; padding-left: 14px;
    font-style: italic; opacity: 0.85;
  }
  .thought-spin {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-progressBar-background); margin-right: 5px;
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

  /* --- Tool calls ------------------------------------------------------ */
  .tool {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; margin: 3px 0;
    background: var(--vscode-editorWidget-background);
    overflow: hidden;
  }
  .tool-head {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 7px; cursor: pointer; user-select: none;
  }
  .tool-head:hover { background: var(--vscode-list-hoverBackground); }
  .tool-caret { flex: 0 0 auto; width: 10px; opacity: .7; }
  .tool-status { flex: 0 0 auto; width: 12px; text-align: center; font-weight: 700; }
  .tool-status.tc-pending { color: var(--vscode-descriptionForeground); }
  .tool-status.tc-in_progress { color: var(--vscode-progressBar-background); animation: pulse 1.1s ease-in-out infinite; }
  .tool-status.tc-completed { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .tool-status.tc-failed { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
  .tool-kind {
    flex: 0 0 auto; font-size: 0.82em; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 3px;
  }
  .tool-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-inferred {
    flex: 0 0 auto; font-size: 0.8em; color: var(--vscode-descriptionForeground);
    cursor: help;
  }
  /* Step count on a parent card ("N steps") */
  .tool-steps {
    flex: 0 0 auto; font-size: 0.78em; padding: 0 5px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  /* Sub-agent grouping: children indent under their parent with a connector.
     Links are INFERRED (ACP has no nesting concept), so the grouping is purely
     visual and can be switched off with the "Sub-agents" toggle. */
  .messages:not(.flat-tools) .tool[data-parent-id] {
    margin-left: 18px;
    border-left: 2px solid var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  .messages.flat-tools .tool[data-parent-id] { margin-left: 0; }

  .nest-toggle {
    flex: 0 0 auto; padding: 1px 7px; border-radius: 10px; cursor: pointer;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border: none; font-family: inherit; font-size: 0.82em;
  }
  .nest-toggle.off { opacity: 0.5; }
  .tool-body { padding: 4px 7px 7px; border-top: 1px solid var(--vscode-panel-border); }
  .tool-command {
    font-family: var(--vscode-editor-font-family); font-size: 0.92em;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 3px 6px; margin: 0 0 5px;
    white-space: pre-wrap; word-break: break-all;
  }
  .chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 0 5px; cursor: pointer;
    font-family: var(--vscode-editor-font-family); font-size: 0.88em;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip-static { cursor: default; }
  .chip-static:hover { background: var(--vscode-textCodeBlock-background); }
  .tool-text { white-space: pre-wrap; word-break: break-word; margin: 3px 0; }

  /* Diff */
  .diff {
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    margin: 4px 0; overflow: hidden;
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
  }
  .diff-head {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 6px; cursor: pointer;
    background: var(--vscode-textCodeBlock-background);
  }
  .diff-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-stat { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .diff-add { color: var(--vscode-charts-green); }
  .diff-del { color: var(--vscode-charts-red); }
  .diff-body { max-height: 340px; overflow: auto; }
  .diff-line { display: flex; white-space: pre; }
  .diff-no {
    flex: 0 0 auto; width: 4ch; text-align: right; padding-right: 8px;
    color: var(--vscode-editorLineNumber-foreground); user-select: none;
  }
  .diff-code { flex: 1; padding-right: 6px; }
  .diff-line.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(155,185,85,0.16)); }
  .diff-line.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.14)); }
  .diff-line.ctx { color: var(--vscode-descriptionForeground); }
  .diff-note { padding: 3px 6px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }

  /* Plan */
  .plan {
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-editorWidget-background); padding: 5px 8px; margin: 3px 0;
  }
  .plan-title { font-weight: 600; font-size: 0.92em; margin-bottom: 3px; }
  .plan-row { display: flex; gap: 6px; padding: 1px 0; }
  .plan-row.completed .plan-text { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .plan-mark { flex: 0 0 auto; width: 14px; }

  /* --- Composer -------------------------------------------------------- */
  .composer {
    position: relative;
    border-top: 1px solid var(--vscode-panel-border);
    padding: 4px 6px 6px;
    background: var(--vscode-sideBar-background);
  }
  .config-pickers { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .picker { position: relative; }
  .picker-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px; padding: 1px 6px; cursor: pointer;
    font-family: inherit; font-size: 0.88em; max-width: 220px;
  }
  .picker-btn:hover { background: var(--vscode-list-hoverBackground); }
  .picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-menu {
    position: absolute; bottom: 100%; left: 0; z-index: 20;
    min-width: 180px; max-height: 260px; overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 3px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    padding: 2px 0; display: none;
  }
  .picker-menu.open { display: block; }
  .picker-group { padding: 3px 8px 1px; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  .picker-item { padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .picker-item:hover { background: var(--vscode-list-hoverBackground); }
  .picker-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

  .attachments { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .attachment {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    padding: 0 5px; font-size: 0.88em; max-width: 100%;
  }
  .attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-x {
    border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 0 1px; opacity: .7;
  }
  .attachment-x:hover { opacity: 1; color: var(--vscode-errorForeground); }

  .input-row { display: flex; gap: 4px; align-items: flex-end; }
  .prompt-input {
    flex: 1; min-width: 0; resize: none; overflow-y: auto;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px; padding: 4px 6px;
    font-family: inherit; font-size: inherit; line-height: 1.4;
  }
  .prompt-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .prompt-input:disabled { opacity: .55; }
  .send-stop {
    flex: 0 0 auto; padding: 5px 12px; border-radius: 4px; cursor: pointer;
    border: none; font-family: inherit; font-size: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .send-stop:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .send-stop:disabled { opacity: .5; cursor: default; }
  .send-stop.stop { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }

  /* Slash popup */
  .slash-popup {
    position: absolute; bottom: 100%; left: 6px; right: 6px; z-index: 30;
    max-height: 220px; overflow-y: auto;
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
    border-radius: 3px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    margin-bottom: 4px;
  }
  .slash-item { padding: 3px 8px; cursor: pointer; }
  .slash-item.active { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
  .slash-name { font-family: var(--vscode-editor-font-family); }
  .slash-desc { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-left: 8px; }

  /* Load overlay */
  .load-overlay {
    position: fixed; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-sideBar-background);
    opacity: .92;
  }
  .load-box { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); }
  .spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid var(--vscode-panel-border);
    border-top-color: var(--vscode-progressBar-background);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`;
}
