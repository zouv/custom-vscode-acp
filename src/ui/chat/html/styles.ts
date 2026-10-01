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
    /* [CUSTOM-20260930-140] 底栏（.composer）改成绝对定位、浮在消息区之上 —— 它的定位祖先
       就是这里，所以 body 必须 positioned。 */
    position: relative;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    /* [CUSTOM-BEGIN] CUSTOM-20260930-137 - 底部栏的尺度，定义在这一层是因为输入区是 body 的
       后代（.composer 不是 .message-area 的后代，挂那边够不着）。
       · --acpc-composer-max：输入卡宽度。137 起**消息列不再限宽**（用户要求消息平铺开、
         读得更宽），只有底部这一块仍限宽 —— 卡片过宽时发送按钮离正文太远、不好点。
       · --acpc-input-max-h：输入框的**视口**上限。与 autoGrow 里那个 320 是两件事——
         320 管"内容最多长到多高"，这条管"面板再高也不许高过屏幕的 38%"；两者同时存在时
         浏览器取更小的那个，所以 composer.ts 不需要知道视口有多高。 */
    --acpc-composer-max: 720px;
    --acpc-input-max-h: min(320px, 38vh);
    /* [CUSTOM-END] CUSTOM-20260930-137 */
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
  /* [CUSTOM-20260930-130] 圆点有**两个独立的信号**（用户指定）：
       · 颜色说"这个会话处在什么状态"；
       · 外面的圈说"它正在做事"。
     两者必须独立——卡在权限提示上的轮次两件事同时为真。颜色走 color 而不是直接写
     background，外圈才能用同一个 currentColor 画出来（颜色只有一个来源）。
     **它只是提示**：不弹窗、不抢焦点——与"不做后台权限卡"的决定不冲突。 */
  .tab-dot {
    position: relative;
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
    background: currentColor;
  }
  /* 优先级：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > 平常。 */
  .tab-dot.waiting { color: var(--vscode-charts-orange, var(--vscode-charts-yellow)); }
  .tab-dot.running { color: var(--vscode-progressBar-background); }
  .tab-dot.loading { color: var(--vscode-charts-yellow); }
  /* [CUSTOM-20260925-063] 后台会话在你离开后有了新输出 —— 由宿主侧的 unread 集合驱动。 */
  .tab-dot.attention { color: var(--vscode-charts-blue); }
  /* 外圈：一圈向外扩散的涟漪，只在"正在做事"（轮次在跑 / 正在载入）时出现。
     早先把 running 做成圆点自身的脉动，那样两个信号就挤在同一个像素上了。 */
  .tab-dot.busy::after {
    content: ''; position: absolute; inset: -1px; border-radius: 50%;
    border: 1px solid currentColor;
    animation: tab-ring 1.4s ease-out infinite;
  }
  @keyframes tab-ring {
    0% { transform: scale(0.7); opacity: 0.9; }
    100% { transform: scale(1.9); opacity: 0; }
  }
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
  /* [CUSTOM-20260930-141] 历史浮层里的目录过滤菜单要能**溢出**浮层本身。
     因果链：菜单是绝对定位，它的包含块是 .outline-head（sticky ⇒ positioned），而 head 在
     #history 内部 ⇒ #history 的 overflow-y: auto **会把它裁掉**（可见高度 = head 底边到
     #history 底边的距离；历史列表越短它越矮，实测只剩几行）。把滚动从容器下移到 .outline-list：
     #history 不再裁剪任何后代，菜单高度交回它自己的 max-height 单独控制。
     只写在 #history 上、不动 .outline 的通用规则 —— #outline / #cwdMenu 里没有这种嵌套菜单。
     head 的 background: inherit 与 sticky 都保留（后者仍是菜单的定位锚）。 */
  #history { display: flex; flex-direction: column; overflow: visible; }
  #history .outline-head { flex: none; }
  #history .outline-list { flex: 1; min-height: 0; overflow-y: auto; }
  /* --- 时间显示（CUSTOM-20260925-065）------------------------------------
     每条记录的时刻。元素**始终在 DOM 里**，可见性由 #messages 上的一个类决定
     （与 flat-tools 同一套机制）⇒ 切换开关**不需要重渲染任何东西**，纯样式翻转。
     默认隐藏；鼠标悬停在整条上另有一个完整时刻（见 transcriptView.place 设的 title）。 */
  /* [CUSTOM-20260930-129] 打开 Times 时，时刻**跟着记录的标题行走**，不再单独占一行：
     非工具卡的记录浮在自己节点的右上角（下面那条 .messages > * 提供定位上下文），工具卡则作为
     .tool-head 里的一项参与 flex 排版、排在耗时之后 ⇒ 标题行右侧读作 "2.2s 11:57"。 */
  .rec-time {
    display: none;
    position: absolute; top: 0; right: 0;
    font-size: 0.78em; color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    /* 它只是文本：既不接点击，也不该挡住底下那行的 hover（整条记录的完整时刻在 node.title 上）。 */
    pointer-events: none;
  }
  /* [CUSTOM-20260930-146] 时刻**只在工具卡上显示**（用户定的）：ACP 里只有工具调用带耗时
     （elapsedMs），普通消息与 Thought 根本没有"耗时"这个量 —— 给它们单独挂一个时刻，读起来
     像是缺了一半的信息，齐不齐也都靠排版去凑。所以开关只对工具卡生效：
       关 = 3ms（耗时，常显）；开 = 3ms 18:32（耗时 + 时刻，见下）。
     非工具记录的 .rec-time 仍然在 DOM 里（transcriptView 一律插入），只是这条选择器不再放它出来。 */
  .messages.show-times .tool-head .rec-time { display: block; }
  /* 记录节点当定位上下文，时刻才浮得住。position: relative 不改变布局（只建立上下文），
     所以对既有排版（rail 的测量、置顶克隆）没有影响。 */
  .messages > * { position: relative; }
  /* 工具卡：时刻是标题行里的一项，静态排版、跟在 .tool-time 后面 ⇒ 整行读作 "3ms 18:32"。
     [CUSTOM-20260930-146] 145 曾把它改成"也浮到右上角"来跟其它记录对齐 —— 那会挤掉标题行的
     宽度（要靠 padding-right 硬留槽位），工具卡本来就工整的一行反而散了，**已回退**。 */
  .tool-head .rec-time { position: static; }
  /* 105 之前这里有一条 .entry-user .rec-time { text-align: right }（时刻跟着右对齐的气泡走）。
     用户消息改为靠左铺满后它没有存在理由了——留着会让时刻与正文分居两端。 */
  /* 工具耗时常显（与 Thought 的 "Thought for Ns" 同类信息，不需要开关）。 */
  .tool-time {
    flex: 0 0 auto; font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
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
  /* [CUSTOM-20260926-077] 钉住按钮并进 .outline-head（"N messages" 同一行）。
     .outline-head-info 是 render() 清空并回填的计数容器；钉住按钮是它的兄弟、静态。 */
  .outline-head-info {
    display: flex; align-items: center; gap: 8px;
    flex: 1; min-width: 0;
  }
  /* 大纲项里的类型图标（user/assistant）。挂 .outline-kind 而不是 .rec-icon：后者是
     "贴在记录气泡里"的语义（icons.attach 用），这里是列表项里独立的一格。 */
  .outline-kind { flex: none; display: inline-flex; align-items: center; align-self: center; opacity: 0.7; }
  .outline-kind svg { display: block; }
  .outline-item.active .outline-kind { opacity: 1; }
  /* [CUSTOM-20260926-077] 按类型着色：user 与 transcript 用户气泡同色（蓝），
     assistant 用中性灰。SVG 是 stroke=currentColor，改 color 即可区分。 */
  .outline-kind-user { color: var(--vscode-button-background); }
  .outline-kind-assistant { color: var(--vscode-descriptionForeground); }

  /* --- 右侧常驻大纲栏（CUSTOM-20260926-076）----------------------------- */
  /* 是 #messages 的 flex 兄弟、定宽（JS 拖拽后写 inline width 覆盖这里的默认 240px）。
     绝对定位的调宽手柄因此要 relative 锚定；注意别加 overflow，否则 left:-3px 的手柄被裁。 */
  .outline-sidebar {
    flex: 0 0 auto; width: 240px;
    display: flex; flex-direction: column;
    border-left: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    position: relative;
  }
  .outline-sidebar-head {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .outline-sidebar-title {
    flex: 1; font-size: 0.8em; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: .04em;
  }
  /* 列表独立滚动，不跟着 #messages 走。 */
  .outline-sidebar .outline-list { flex: 1; overflow-y: auto; scrollbar-width: thin; }
  /* 调宽手柄：钉在侧栏左缘（跨过 1px 边框各留 3px 命中区）。 */
  .outline-resize {
    position: absolute; left: -3px; top: 0; bottom: 0; width: 6px;
    cursor: col-resize; z-index: 4;
  }
  /* [CUSTOM-20260930-129] 这里原有 .usage-bar / .usage-track / .usage-fill——顶部那条进度条
     整个删掉了，底部改画圆环（.gauge-* 见下），三条规则一起成了死 CSS，一并清掉。 */

  /* [CUSTOM-20260930-131] 未连接（含正在连接）时，header 只留历史按钮和地址：
     Times 在没有记录的界面上没有意义。相位由 stateCard 写在 body 的 data-phase 上，
     所以这里不需要任何 JS。 */
  body[data-phase="disconnected"] #timeToggle,
  body[data-phase="connecting"] #timeToggle { display: none; }

  /* --- Messages -------------------------------------------------------- */
  .message-area { position: relative; flex: 1; min-height: 0; display: flex; }
  /* [CUSTOM-20260928-103] 消息列：.message-area 这一行里除它之外只有定宽的大纲栏。
     置顶副本（.sticky-user）是它的绝对定位子元素，于是"覆盖层不会盖到大纲栏上"是按构造
     成立的——不用量大纲栏宽度。min-width: 0 与 #messages 当初作为 flex 项时同义。 */
  /* [CUSTOM-BEGIN] CUSTOM-20260930-137 - 消息列**不限宽**。132 一度给它加过版心（max-width +
     auto margin 居中），本轮按用户要求撤销：消息要平铺开、读得更宽；限宽只保留在底部输入卡上
     （卡片太宽时发送按钮离正文太远，那是另一个问题）。
     这一层的定位意义不变 —— 置顶卡片（.sticky-user）、引导条（.rail）与 Jump to latest 都是
     它的绝对定位子元素，所以 132 把后两者搬进来的改动**保留**：列满宽时它们与内容的位置关系
     与改动前逐像素一致，将来若再限宽也不必重做。 */
  .messages-column {
    position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  }
  /* [CUSTOM-END] CUSTOM-20260930-137 */
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
  /* [CUSTOM-20260925-062] 命中区扩展：'step' 只有 7px，鼠标几乎点不中。
     用一层透明的 ::after 把可点范围撑到约 17px——**外观完全不变**（inset 为负，
     伪元素不参与布局，也不影响 #1 的圆心对齐）。 */
  .rail-dot::after {
    content: ''; position: absolute; inset: -5px; border-radius: 50%;
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
  /* [CUSTOM-20260925-062] 「当前视口在哪」的指示器**刻意不用环**：这个面板里
     「环」已经被 047 定义成**键盘焦点**的语义（全局 :focus-visible 规则），
     再用 --vscode-focusBorder 画一个环，一个颜色就有了两种意思，用户分不清
     "我在哪" 与 "焦点在哪"。改用**尺寸**——scale 以中心为基准，所以不影响 #1 的圆心对齐。 */
  .rail-dot.active {
    opacity: 1;
    transform: scale(1.4);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    /* padding-left 给左侧引导条留出通道（.rail 是绝对定位的、与 #messages 同属
       .messages-column 的兄弟节点，覆盖在这条空隙上）。[CUSTOM-20260930-132] rail 原来挂在
       .message-area 上，随版心一起搬进了列 —— 通道必须跟着列走：它靠 .rail 的 left:0 定位，
       锚在面板上就会在列居中之后与内容脱开。
       [CUSTOM-20260926-069] 底部 4px → 24px：最后一条记录贴着输入框的上边框时，
       读者会以为"下面还有内容、没滚到底"（用户反馈）。留白本身就是"到头了"的信号。 */
    padding: 8px 10px 24px 19px;
    /* [CUSTOM-20260930-144] 留白**一贯存在**（069 的 24px + 悬浮输入卡的高度）：内容永远停在
       卡片上方、不会被它遮挡 —— 用户明确要求"消息区的触底判断应该保持在输入框上面的位置"。
       （中途试过"只在贴底那一刻让位"的条件式，那会让未到底的内容被卡片切断 —— 方向是错的，
       而且它还要在 scroll.ts 里维护"切类 + 位置补偿"，白白多出三个坑。）
       高度随输入框在 1 行与多行之间变化，由 composer.ts 的 ResizeObserver 写进
       --acpc-composer-h（pitfall #27：别去列"什么会让它变高"）。
       [CUSTOM-20260930-152] 表单抽屉（.elic-drawer）也浮在底栏之上，同一个道理再加一段：
       --acpc-elic-h 由 elicitationView.ts 的观察器写（收起成一行时它自己会变小）。 */
    padding-bottom: calc(24px + var(--acpc-composer-h, 0px) + var(--acpc-elic-h, 0px));
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

  /* [CUSTOM-20260928-102] 悬浮在消息列顶部的「本轮提问」。不透明背景是必须的——
     它盖在消息之上，半透明会让下面那行字透出来。

     [CUSTOM-20260928-103] 克隆体要和列表里长得一样，靠的是**把列表那套排布条件照搬过来**，
     不是给克隆体写一套新样式：
       · 用户气泡的右对齐与 88% 宽度来自 .entry-user{align-self:flex-end; max-width:88%}，
         而 align-self **只在 flex 容器里生效**。102 时这里是个普通块容器，于是克隆体左对齐、
         按块级撑开（用户报的"被拉长、没靠右"）——所以 .sticky-body 是 flex 列。
       · 水平内边距与 .messages 相同（左 19 给引导条让位、右 10）—— 内容盒宽度与列表逐像素相同，
         否则 max-width:88% 的 88% 会落在两个不同的基数上。

     [CUSTOM-20260928-104] 改成悬浮卡片。要点是**分成两层**：
       · 这一层只负责定位与内边距，背景透明、pointer-events: none —— 卡片周围要让内容与点击
         都透过去（悬浮，不是盖一层膜）。
       · 卡片（.sticky-card）才画底色/描边/阴影，而且它必须**不占额外布局**：描边用 box-shadow
         的 0 0 0 1px 而不是 border，否则内容盒会窄 1px，克隆体就对不上原位。
     padding-top 由 stickyUser.ts 写入（那里的 TOP_GAP）——那 8px 同时是"本体交棒"的阈值，
     布局与判据必须相等，所以只留一个来源（pitfall #19）。 */
  .sticky-user {
    position: absolute; top: 0; left: 0; right: 0; z-index: 6;
    padding: 0 8px 8px 17px;
    display: flex; flex-direction: column;
    pointer-events: none;
    max-height: 40%; overflow: hidden;
  }
  .sticky-user > * { flex: 0 0 auto; pointer-events: auto; }
  /* [CUSTOM-20260928-105] 高亮边框（用户要求"加些高亮/阴影，跟原消息区分开"）。107 起
     改成 **2px + --vscode-foreground**：105 用的是 1px --vscode-focusBorder，而气泡底色是
     --vscode-button-background（蓝）——两者在默认主题里都是蓝的，对比度极低，用户回报
     "看到了但很不明显"。换成前景色（深色主题近白、浅色主题近黑）压在蓝气泡上，两种主题
     都清楚。
     · 语义上仍是 border 不是环：环在这个面板里被定义为键盘焦点（062 的教训）。
     · 上面 padding 里的 17/8 与列表的 19/10 差 2，就是给这条 2px 边框让位的：
       卡片的内容盒因此**仍然逐像素等于** .messages 的内容盒（克隆体落在原位上，
       交棒时看不出接缝）。padding-top 依旧由 JS 写（TOP_GAP）。
       垂直方向的 2px 不补：边框让克隆体的落点比 TOP_GAP 低 2px，交棒那一帧因此有 2px 的
       沉降，肉眼不可见；要抹平就得让交棒窗口跟着 +2，那样这个常量就有了第二个来源
       （pitfall #19），不划算。 */
  .sticky-card {
    position: relative;
    display: flex; flex-direction: column;
    background: var(--vscode-sideBar-background);
    border: 2px solid var(--vscode-foreground);
    border-radius: 8px;
    box-shadow: 0 4px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
    overflow: hidden;
    cursor: pointer;
  }
  .surface-editor .sticky-card { background: var(--vscode-editor-background); }
  /* 同 .messages > *（037）：克隆体在"列 flex + overflow:hidden"里同样不许被压缩。 */
  .sticky-body { display: flex; flex-direction: column; }
  .sticky-body > * { flex: 0 0 auto; }
  /* [CUSTOM-20260928-104] 收缩/展开。105 起用户消息铺满整列，卡片里**没有空档了**，
     所以按钮挪到卡片左侧那条 18px 通道里（那是 .messages 给左侧引导条留的 padding-left，
     见 .messages 的注释）——位置固定、永不压到正文，也不占内容盒宽度。 */
  .sticky-toggle {
    position: absolute; left: 1px; top: 10px; z-index: 1;
    width: 15px; height: 16px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-family: inherit; font-size: 0.8em; line-height: 1;
    cursor: pointer;
  }
  .sticky-toggle:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
  }
  /* 收缩成一行：多行气泡是 details.user-fold（summary 就是第一行），单行气泡本来就是一行。
     展开态的那部分（.fold-body）藏掉即可，不用重建节点。 */
  .sticky-user.collapsed .bubble,
  .sticky-user.collapsed .user-fold > summary {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sticky-user.collapsed .fold-body { display: none; }
  /* [CUSTOM-20260928-103] 时刻的显隐由 .messages.show-times 控制，而克隆体不在 #messages 里
     —— 不同步这个状态就会出现"列表有时刻、置顶副本没有"。show-times 由 render() 从
     #messages 抄到 host 上。
     [CUSTOM-20260930-146] 但这条规则现在**不再需要**：时刻只留给工具卡（见 .rec-time 那段），
     而置顶条里永远是用户消息 ⇒ 克隆体上不该出现时刻。留着它反而会让"开关一开，置顶那份
     凭空多个时刻"。 */
  .sticky-user.show-times .rec-time { display: none; }
  /* [CUSTOM-20260928-104] 本体交棒给悬浮条时隐藏：副本已经站在它原来的位置上，留着就是同屏两份。
     用 visibility 而不是 display —— 几何保持不变，rail 的测量与 jumpTo 依赖的 offsetTop 都还成立。

     **'.messages' 这个前缀是承重的，不是修饰**：cloneNode 会连 class 一起复制，而副本不在
     #messages 里 —— 去掉前缀，换成副本看不见（悬浮条"打不开了"，静默）。render() 里另有一道
     同因的防线（显式摘掉这个类）。 */
  .messages .sticky-source { visibility: hidden; }
  /* 三档间距阶梯：同类紧 / 跨类松 / 轮次边界最松。
     data-kind 由 transcriptView.place() 打在每条上，这里纯用兄弟选择器实现。 */
  .messages > * + * { margin-top: 10px; }
  .messages > [data-kind="thought"] + [data-kind="thought"] { margin-top: 2px; }
  .messages > [data-kind="tool"]    + [data-kind="tool"]    { margin-top: 4px; }
  .messages > [data-kind="content"] + [data-kind="content"] { margin-top: 2px; }
  .messages > [data-kind="user"] { margin-top: 16px; }
  .jump-latest {
    /* [CUSTOM-20260930-140] 底栏浮在面板底部，这个按钮要跟着抬起来，否则会被输入卡盖住。
       [CUSTOM-20260930-152] 表单抽屉也浮在同一处，所以再抬一段（同 --acpc-composer-h 的写法）。 */
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(12px + var(--acpc-composer-h, 0px) + var(--acpc-elic-h, 0px));
    padding: 3px 10px; border-radius: 12px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; font-family: inherit; font-size: 0.9em;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
  }
  .jump-latest:hover { background: var(--vscode-button-hoverBackground); }

  /* [CUSTOM-20260926-082] 空态居中：它原来是 #messages 的**兄弟**，而 .message-area 是 flex 行、
     #messages 是 flex: 1 —— 自由空间被它吃光，margin: auto 没有可分配的余量可分，
     于是空态被顶到最右边（面板越宽越明显；窄侧边栏里看不出来，所以一直没被发现）。
     改为**覆盖在消息区之上并自我居中**（.message-area 本来就是 position: relative，
     .jump-latest 早就这么用）。不占布局，也不会与谁重叠：空态出现 ⟺ 没有聚焦会话 ⟺ 没有锚点
     ⟺ 081 已经把大纲栏与引导条收掉了。 */
  /* [CUSTOM-BEGIN] CUSTOM-20260930-123 - 状态卡（取代 090 的空态排版）。
     居中的方式很关键：**不用** 'justify-content: center' + 容器滚动——内容一旦比消息区高，
     center 会把顶部裁掉且**滚不到**（pitfall #17 同族）。改成
     「容器 flex-start + 卡片 margin: auto」：有富余空间时两轴居中，超高时可完整滚动。
     这一层的 display 唯一写者是 boot.showEmpty()，所以这里可以放心写 flex。 */
  .empty-state {
    position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    display: flex; flex-direction: column; align-items: center;
    justify-content: flex-start; overflow-y: auto;
    text-align: center; color: var(--vscode-descriptionForeground); padding: 20px;
  }
  .state-card {
    /* 'margin: auto' 是上面那条居中的另一半，不要删。
       'width: 100%' 让卡片跟随容器收缩（上限 max-width）。卡片是纵向 flex 的子项，交叉轴
       不会被拉伸，宽度只能靠 width 显式约束 —— 否则它取 fit-content，在窄侧边栏里会不会
       自己收下去就成了"关于浏览器行为的推断"（pitfall #31）。
       实测（preview-records 的 #emptynarrow，把消息区钉死 260px）：cardW=220、居中偏差 0、无裁切。 */
    width: 100%;
    margin: auto;
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    max-width: 420px; padding: 18px 20px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    /* ⚠️ 这里**绝不能**写 overflow：卡片是 flex 列的子项，overflow 非 visible 会把它的
       自动最小尺寸变成 0，卡片会被压扁（pitfall #17）。 */
  }
  /* 转圈槽位：固定最小高度，连接中之外空着也不让标题上下跳。
     #stateBusy 只由 hidden 切换——**不要**给它写 display，否则它会永远可见（pitfall #13）。 */
  .state-head { display: flex; align-items: center; justify-content: center; min-height: 16px; }
  .state-title { margin: 0; font-weight: 600; color: var(--vscode-foreground); }
  .state-hint { margin: 0; font-size: 0.92em; }
  .state-error {
    margin: 0; max-width: 100%; text-align: left; font-size: 0.92em;
    padding: 4px 8px; border-radius: 3px; word-break: break-word;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
  .state-actions { display: flex; gap: 6px; margin-top: 4px; }
  .state-connect {
    padding: 4px 14px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 0.95em;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .state-connect:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  /* 连接中 = 不可点：用 secondary 配色而不是压暗前景色，明暗主题下都可读。 */
  .state-connect:disabled {
    cursor: default; opacity: 0.65;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  .state-opt {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    margin-top: 2px; font-size: 0.88em;
  }
  /* 选择器限定在本卡片内：写成全局 input[type=checkbox] 会连带改掉表单卡（119）的复选框。 */
  .state-opt input { flex: none; margin: 0; accent-color: var(--vscode-button-background); }
  /* [CUSTOM-END] CUSTOM-20260930-123 */

  .entry { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
  /* [CUSTOM-20260928-105] 用户消息**靠左铺满**（用户要求）。原来是 align-self:flex-end +
     max-width:88%，于是气泡宽度=内容宽度(fit-content)：短消息是个小气泡，而折叠后只剩首行、
     宽度随之缩短 —— 面板在折叠/展开时"会自己变窄"，读起来像布局在跳。铺满之后宽度是常量，
     折与不折只影响高度。顺带：正文与时刻同一起点，圆角也改成四角一致（原来的 8/8/2/8
     是"右下收尾"的对话气泡形，靠左之后那个缺口指向反了）。 */
  .entry-user { align-self: stretch; }
  /* [CUSTOM-20260925-061] 气泡观感同时挂在「单行气泡」与「多行折叠的 details」上，
     所以展开时背景与圆角是**连续的一整块**，不会出现两条气泡。 */
  .entry-user .bubble,
  .entry-user .user-fold {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 6px 10px; border-radius: 8px;
    white-space: pre-wrap; word-break: break-word;
  }
  /* 折叠时背景与内边距在 details 上，summary 只是它的第一行——必须抹掉，
     否则会出现两层内边距 / 两层背景。 */
  .entry-user .user-fold > summary {
    cursor: pointer; user-select: none; list-style: none;
    background: transparent; padding: 0; border-radius: 0; color: inherit;
  }
  /* [CUSTOM-20260928-108] 正文从第二行开始（图标与折叠三角留在第一行）。
     .bubble-body 是 block，所以 summary 里的文字永远另起一行；折叠态的截断
     作用在它自己身上（不再是整个 summary，否则图片 chip 也会被截掉）。 */
  .bubble-body { display: block; }
  /* [CUSTOM-20260928-110] 折叠时正文提到第一行（用户要求）：
     图标/caret 与"优化下排版"在同一行，而不是把正文挤到第二行。 */
  .entry-user .user-fold:not([open]) .bubble-body {
    display: inline;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* [CUSTOM-20260928-108] 图片 chip 在气泡内：第一行、caret 之后、正文之前。
     图片在 summary 里，气泡内留一点间距。 */
  /* [CUSTOM-20260928-110] 气泡内的图片 chip 用深色半透明底：chip 的默认底色
     (--vscode-textCodeBlock-background) 压在蓝气泡上对比度太低，图片名几乎看不见。 */
  /* [CUSTOM-20260928-112] 带图片的气泡：summary 改为 flex 行，图标/caret/chip 都排在
     第一行，正文（.bubble-body）用 flex-basis:100% 撑到第二行。
     **注意**：无图片时 bubble-body 是 block（自然另起一行），不能给所有 summary 都套 flex
     —— block 在 flex 容器里不会换行，会把正文挤到与图标同一行。 */
  .entry-user .user-fold > summary:has(.content-image-chip) {
    display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px;
  }
  /* [CUSTOM-20260928-113] 折叠时 bubble-body 也是 flex 项（不占满一行），与图标/caret 同行。 */
  .entry-user .user-fold:not([open]) > summary:has(.content-image-chip) .bubble-body {
    flex-basis: auto;
  }
  .entry-user .user-fold > summary:has(.content-image-chip) .bubble-body {
    flex-basis: 100%;
  }
  .entry-user .content-image-chip {
    margin: 2px 4px 2px 0;
    vertical-align: middle;
    background: rgba(0, 0, 0, 0.25);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .entry-user .user-fold > summary::-webkit-details-marker { display: none; }
  /* 折叠态：summary 占**恰好一行**并以省略号截断——现在只截正文（.bubble-body），
     图标与折叠三角留在第一行（[CUSTOM-20260928-108]）。
     **只在折叠态生效**——展开时若还是 nowrap，第一段会被截成"半句话加省略号"。 */
  /* 展开态：body 是 **inline**，从切分点接着往下流。切分点只是实现细节
     （长单行消息没有换行可切），用块级 body 会在半句话处多出一处换行。 */
  .entry-user .user-fold .fold-body {
    display: inline;
    white-space: pre-wrap; word-break: break-word;
  }
  /* 展开态：body 是 **inline**，从切分点接着往下流。切分点只是实现细节
     （长单行消息没有换行可切），用块级 body 会在半句话处多出一处换行。 */
  .entry-user .user-fold .fold-body {
    display: inline;
    white-space: pre-wrap; word-break: break-word;
  }
  .entry-assistant { align-self: stretch; }
  /* [CUSTOM-20260929-114] 助手消息也是 <details>（与用户消息同一套折叠控件），
     **外观因此挂在 details 上**——它现在包住「标题行 + 正文」两段，而原来只有一个 .bubble。 */
  .entry-assistant .msg-fold {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px 8px 8px 2px;
    padding: 6px 10px;
    word-break: break-word;
    white-space: pre-wrap;
  }
  /* 标题行（图标 + 折叠三角 + 折叠时的首行预览）就是切换区。**正文刻意不在 summary 里**：
     在 <summary> 里划选文本 == 点它，读者选中一段回答就会把它折起来；而 markdown 正文里
     还有链接 / 代码 Copy / 图片 chip。见 buildAssistantFold 的注释。 */
  .entry-assistant .msg-head {
    cursor: pointer; user-select: none; list-style: none; padding: 0;
  }
  .entry-assistant .msg-head::-webkit-details-marker { display: none; }
  /* 展开态：图标行在上、正文在下（正文是 summary 的块级兄弟，天然另起一行）。 */
  .entry-assistant .bubble-body.md { white-space: normal; }
  /* [CUSTOM-20260929-116] 折叠态：正文被浏览器整块藏起来（details 的默认行为，作者样式
     **抢不过**——115 用 display 试过，折叠后正文依旧不可见），所以"首行"由 summary 里的
     .msg-preview 提供 —— 它是**真文本节点**，随正文内容更新（refreshPreview）。
     展开时必须藏掉它，否则正文上方会多出一份重复的首行。 */
  .entry-assistant .msg-fold[open] .msg-preview { display: none; }
  /* 折叠态那一行不换行、超出省略号（与用户消息折叠后一样只占一行）。 */
  .entry-assistant .msg-fold:not([open]) > .msg-head {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
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
  /* --- Form: ACP elicitation / AskUserQuestion (CUSTOM-20260929-119, 152 改悬浮抽屉) ----
     与权限卡同一族观感（它也是**阻塞的**：agent 在等到答复前不会继续），但内容是一张表单，
     所以用的是 VS Code 的输入控件配色，而不是自造一套。

     [152] 分成两层：
       · 记录层（.elic）：内联的一条记录。pending 时**只有一行**"待回答"（表单本体在抽屉里，
         内联卡会把记录区撑长、也不像"现在需要你操作"）；结算后是只读的问答摘要（历史）。
       · 抽屉层（.elic-drawer，body 级浮层）：贴在输入卡之上、与它同宽同中线。多道题按 tab
         分页，题内控件见下面的 .elic-select / .elic-option / .elic-input。 */
  .entry-elicitation { align-self: stretch; }
  .elic {
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border));
    border-left-width: 3px;
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; gap: 8px;
  }
  .elic.pending { border-left-color: var(--vscode-focusBorder, var(--vscode-charts-blue)); }
  .elic.deferred { opacity: 0.75; }
  .elic.accepted, .elic.declined, .elic.cancelled {
    border-left-color: var(--vscode-panel-border); background: transparent;
  }
  .elic-title { font-size: 0.95em; font-weight: 600; word-break: break-word; }
  .elic-body { display: flex; flex-direction: column; gap: 8px; }
  .elic-field { display: flex; flex-direction: column; gap: 3px; }
  /* The "Other" box belongs to the question above it, so it is indented and quiet. */
  .elic-field.elic-other { margin-left: 14px; opacity: 0.9; }
  .elic-label { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
  .elic-help { font-size: 0.92em; word-break: break-word; }
  .elic-option { display: flex; align-items: baseline; gap: 6px; cursor: pointer; }
  .elic-option.static { cursor: default; }
  .elic-option input { flex: none; margin: 0; }
  .elic-option-text { display: flex; flex-direction: column; }
  .elic-option-label { font-size: 0.95em; }
  .elic-option-desc { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .elic-input {
    font-family: inherit; font-size: 0.95em; width: 100%;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px; padding: 3px 6px;
  }
  .elic-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .elic-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .elic-btn {
    font-family: inherit; font-size: 0.92em; padding: 3px 10px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .elic-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .elic-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .elic-btn:disabled { cursor: default; opacity: 0.5; }
  .elic-note { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .elic-note:empty { display: none; }

  /* --- [CUSTOM-20260930-152] 记录里的"待回答"条 --------------------------- */
  .elic-pending-row { display: flex; align-items: center; gap: 6px; }
  .elic-pending-icon { flex: none; font-size: 0.95em; }
  .elic-pending-text {
    flex: 1; min-width: 0; font-size: 0.92em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .elic-open {
    flex: none; font-family: inherit; font-size: 0.88em; padding: 2px 8px;
    border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .elic-open:hover { background: var(--vscode-button-hoverBackground); }

  /* --- [CUSTOM-20260930-152] 抽屉 ---------------------------------------- */
  /* 定位：与输入卡**同一套居中规则**（用户 2026-10-01 报"没居中"）。输入卡的中心不是面板中心：
     '.composer-main' 是"面板宽 − 预留功能区（--acpc-aside-w，钉住大纲栏时 240px）"，卡片在它
     里面居中 —— 所以抽屉的包含块必须用 right 把那一段让出来，否则钉住大纲时抽屉会整体右移
     asideW/2（实测差 ~120px）。'.composer-main' 的 padding-inline: 8px 用 '100% - 16px' 对齐。
     **不要**用 transform 居中 —— 抽屉里的下拉菜单是 position: fixed，transform 会让它变成
     "相对该元素"定位。bottom 跟着 --acpc-composer-h：浮层叠在底栏之上，两者一起由消息区的
     留白让位。 */
  .elic-drawer {
    position: fixed; left: 0; right: var(--acpc-aside-w, 0px); margin: 0 auto;
    bottom: var(--acpc-composer-h, 0px);
    width: min(100% - 16px, var(--acpc-composer-max, 720px));
    max-height: min(70vh, 560px);
    z-index: 9;                       /* 高于底栏（8），低于右键菜单（60）与图片浮层（90） */
    display: flex; flex-direction: column;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border));
    border-radius: 8px;
    box-shadow: 0 -2px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .elic-drawer[hidden] { display: none; }
  /* [CUSTOM-20261001-154] 抽屉的头部行没了：tab 条、进度与收起箭头合成一条 bar，
     进度与箭头靠右（用户要求）。收起时 tab 条让位给当前题的名字。 */
  .elic-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 2px 8px 0 10px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .elic-progress { flex: none; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .elic-collapsed-title {
    display: none; flex: 1; min-width: 0; font-size: 0.92em; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .elic-toggle {
    flex: none; width: 22px; height: 20px; padding: 0; cursor: pointer;
    background: transparent; border: none; color: inherit; font-family: inherit;
    font-size: 0.8em; line-height: 1;
  }
  .elic-toggle:hover { background: var(--vscode-toolbar-hoverBackground, transparent); border-radius: 3px; }
  /* 收起态 = 只剩 bar 这一行（用户要的"^ 收成一行"）：正文与操作栏都藏起来，
     tab 条换成当前题的名字。 */
  .elic-drawer.collapsed .elic-note { display: none; }
  .elic-drawer.collapsed .elic-panes { display: none; }
  .elic-drawer.collapsed .elic-actions { display: none; }
  .elic-drawer.collapsed .elic-tabs { display: none; }
  .elic-drawer.collapsed .elic-collapsed-title { display: block; }
  .elic-form { display: flex; flex-direction: column; min-height: 0; }
  /* 操作栏与结果说明固定在抽屉底部（表单区自己滚，按钮不跟着滚走）。 */
  .elic-drawer .elic-actions { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .elic-drawer .elic-note { padding: 0 10px 8px; }
  .elic-tabs {
    display: flex; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0;
  }
  .elic-tab {
    display: flex; align-items: center; gap: 5px; max-width: 100%;
    font-family: inherit; font-size: 0.88em; padding: 3px 8px; cursor: pointer;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: none; border-bottom: 2px solid transparent;
  }
  .elic-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .elic-tab-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .elic-tab-dot {
    flex: none; width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-descriptionForeground); opacity: 0.5;
  }
  .elic-tab.answered .elic-tab-dot { background: var(--vscode-charts-green, #89d185); opacity: 1; }
  /* 表单区可滚动（表单可以很长）。 */
  .elic-panes { padding: 10px; overflow-y: auto; min-height: 0; }
  .elic-panes .elic-field[hidden] { display: none; }
  .elic-unanswered { font-size: 0.85em; color: var(--vscode-descriptionForeground); opacity: 0.85; }
  .elic-unanswered[hidden] { display: none; }
  .elic-custom-label {
    margin-top: 4px; font-size: 0.88em; color: var(--vscode-descriptionForeground);
  }
  .elic-custom-hint { font-size: 0.82em; color: var(--vscode-descriptionForeground); opacity: 0.85; }
  /* [CUSTOM-20261001-154] 自拟框：跟着**被选中的那一行**走（默认藏着，选了才出现）。 */
  .elic-custom { display: flex; flex-direction: column; gap: 3px; margin: 4px 0 2px 22px; }
  .elic-custom[hidden] { display: none; }
  /* 单选改成平铺的 radio 列表（用户 2026-10-01 的修改）：每行 = 主标题 + 副标题（说明），
     自拟框插在选中行的下面（见 .elic-custom 的 margin-left 缩进）。 */
  .elic-option-row { display: flex; flex-direction: column; }
  .elic-option-row + .elic-option-row { margin-top: 6px; }
  .elic-option-row .elic-option { align-items: flex-start; }
  .elic-option-row .elic-option input { margin-top: 2px; }
  .elic-option-row .elic-option-desc { margin-top: 1px; }
  .elic-option-row.elic-other-row .elic-option-label { color: var(--vscode-descriptionForeground); }
  .elic-clear {
    align-self: flex-start; margin-top: 4px; padding: 0;
    font-family: inherit; font-size: 0.82em; cursor: pointer;
    background: transparent; border: none; color: var(--vscode-textLink-foreground, var(--vscode-descriptionForeground));
    text-decoration: underline;
  }
  .elic-clear[hidden] { display: none; }

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
  /* [CUSTOM-20260926-073] 切换提示（模型 / 模式 / 配置项）：居中的分隔式一行，参照
     Claude 官方插件的「Switched to …」。它不是一条内容气泡，而是时间线上的一处标记，
     所以左右各引一条虚线把它与两侧内容分开，并且**占满整行**。
     必须显式写 flex-direction: row —— .entry 是 column，只覆盖 display 会让两条虚线
     上下堆叠（分隔线跑到文字上方和下方，看起来像一条空记录）。 */
  .entry-notice.switch {
    align-self: stretch;
    display: flex; flex-direction: row; align-items: center; gap: 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.88em;
  }
  .entry-notice.switch::before,
  .entry-notice.switch::after {
    content: ''; flex: 1 1 auto; min-width: 12px;
    border-top: 1px dashed var(--vscode-panel-border);
  }
  .entry-notice.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  /* [CUSTOM-20260928-109] 注入块（<task-notification> 等）：不是用户输入，也不该是气泡。
     居中、灰色、小字，不拿 icon（icon 是"谁说的"的记号，而它不是任何一方）。 */
  .entry-notice.meta {
    align-self: stretch;
    text-align: center;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.85;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .entry-notice.error {
    color: var(--vscode-inputValidation-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }

  /* Markdown
     [CUSTOM-20260926-072] 作用域是 .bubble **和** .md：助手气泡（.bubble.md）与
     思考块正文（.thought-body.md）走的是同一条 markdown 往返，排版规则必须共用——
     各写一套就是「同一份知识存两份」（pitfalls #19）。 */
  .bubble p, .md p { margin: 0 0 6px; }
  .bubble p:last-child, .md p:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6,
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 8px 0 4px; line-height: 1.3; }
  .bubble ul, .bubble ol, .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .bubble pre, .md pre {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px; padding: 8px; overflow-x: auto; margin: 6px 0;
  }
  .bubble code, .md code {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, 0.95em);
  }
  .bubble :not(pre) > code, .md :not(pre) > code {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 0 3px;
  }
  .bubble blockquote, .md blockquote {
    margin: 6px 0; padding-left: 10px;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .bubble table, .md table { border-collapse: collapse; margin: 6px 0; }
  /* [CUSTOM-20260925-062] 宽表格自己的横向滚动容器（由 links.decorateScrollables 套上）。
     与 .bubble pre 同一个套路：滚动发生在块内部，气泡本身不被撑宽。
     min-width:0 让它在 flex/宽度受限的父级里真的能收缩，否则 overflow 不会生效。 */
  .table-wrap { overflow-x: auto; max-width: 100%; }
  .table-wrap > table { margin: 6px 0; }
  .bubble th, .bubble td, .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  .bubble a, .md a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .bubble a:hover, .md a:hover { text-decoration: underline; }
  /* GFM 任务列表的勾选态（CUSTOM-20260926-072）：由宿主侧 markdown.ts 的 checkbox
     钩子渲染，白名单里因此不需要 INPUT。 */
  .task-box { font-family: var(--vscode-editor-font-family); opacity: .85; }
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
  .content-image { max-width: 100%; border-radius: 4px; margin: 4px 0; cursor: zoom-in; }
  /* [CUSTOM-20260928-102] 图片以「缩略图 + 文件名」的紧凑 chip 呈现（此前按原始尺寸平铺，
     一张 1344x695 的截图就把整个面板撑满）。点击整块打开放大层（097）。 */
  .content-image-chip {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 100%; padding: 2px 8px 2px 2px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    cursor: zoom-in; font-family: inherit; font-size: 0.88em; color: inherit;
  }
  .content-image-chip:hover { background: var(--vscode-list-hoverBackground); }
  .content-thumb {
    display: block; flex: 0 0 auto;
    width: 24px; height: 24px; object-fit: cover; border-radius: 2px;
  }
  .content-image-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* [CUSTOM-20260925-050] 编辑区面与编辑器标签同处一列：用侧边栏底色会像"外部面板
     贴在了编辑区里"。类名由 body(surface) 打在 <body> 上（见 html/body.ts）。
     侧边栏面不加任何规则——它必须保持侧边栏底色。 */
  .surface-editor {
    background: var(--vscode-editor-background);
  }
  /* [CUSTOM-20260930-144] 这里原来还有 .composer。底栏从 140 起是**浮在消息之上的透明层**
     （见 .composer 那段），给它刷 editor-background 就等于把整条底栏变成一块不透明带：输入卡
     两侧的消息、右侧大纲栏的底部全被盖住 —— 用户报的"还是遮挡"就是这个，而且它**只在编辑区
     面出现**（本脚本的预览默认渲染侧边栏面，所以一直没照出来）。
     编辑区面的底色差异现在只由 .load-overlay 承担（它本来就是不透明遮罩）。 */
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
  /* --- 折叠三角（CUSTOM-20260925-061）----------------------------------
     它是**真元素**（.fold-caret），不是 summary::before —— 伪元素永远画在内容之前，
     而类型图标（icons.attach 会 prepend 到 summary）必须排在三角**前面**，
     否则顺序会变成「▸ 图标 标签」而不是「图标 ▸ 标签」。
     三角本身是空元素：字形与方向由 CSS 依 details[open] 驱动，所以切换不需要 JS。 */
  .fold-caret { display: inline-block; flex: none; width: 12px; opacity: .7; }
  .fold-caret::before { content: '▸'; }
  details[open] > summary .fold-caret::before { content: '▾'; }
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
  /* [CUSTOM-20260926-072] 渲染成 markdown 的推理正文（宿主侧 SafeMarkdown → .md）。
     两处必须覆盖：
       · white-space —— pre-wrap 会把 marked 输出里的换行**再加一倍**（每个 <p> 之间
         多出一整行空行），所以 md 态回到 normal，与 .entry-assistant .bubble-body.md 同理；
       · font-style —— 正文保持斜体（那是「这是推理」的视觉身份），但代码块与表格里
         的斜体很难读，就地重置为非斜体。 */
  .thought-body.md { white-space: normal; }
  .thought-body.md pre, .thought-body.md code, .thought-body.md table { font-style: normal; }
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
  /* [CUSTOM-20260926-074] 工具自己的名字（Bash / Read / Edit …），来自 agent 的 _meta。
     与左侧的 kind 标签（Run / Read）并列：kind 是 ACP 的粗粒度词表，名字是具体工具，
     两张 "Run" 卡靠它才分得开。 */
  .tool-name {
    flex: 0 0 auto; font-size: 0.82em; padding: 0 4px; border-radius: 3px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background);
  }
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
  /* [CUSTOM-20260929-121] 纵向收紧：工具卡一轮十几张，body 的上下留白各收 2px 就有几十像素。 */
  .tool-body { padding: 3px 7px 5px; border-top: 1px solid var(--vscode-panel-border); }
  /* [CUSTOM-20260929-121] IN / OUT 段：**左右两栏**（对齐官方插件）——段标在左列、
     内容在右列。写成两行（标签一行、内容一行）时每张卡要多占两行，而工具卡在一轮里动辄十几张。
     等宽只给命令本身（IN），不套整段——OUT 里是 markdown 渲染结果，等宽会毁掉它的排版。 */
  .tool-seg {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    column-gap: 8px; align-items: start;
    margin: 0 0 4px;
  }
  .tool-seg:last-child { margin-bottom: 0; }
  .tool-seg-label {
    grid-column: 1;
    font-size: 0.72em; letter-spacing: .06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    /* 与右侧首行的文字基线大致对齐（等宽 0.92em 的行盒比标签高一档）。 */
    padding-top: 3px;
  }
  /* 段里除标签外的每个子节点都落在右列（否则 auto-placement 会把第二个子节点甩回第一列）。 */
  .tool-seg > :not(.tool-seg-label) { grid-column: 2; min-width: 0; }
  /* [CUSTOM-20260929-122] OUT 是一块内容区：淡背景 + 圆角，并且**限高滚动**——长输出不该把
     面板顶走（340px 与 .diff-body 同一档，不新增第二个魔数）。
     **底色与内边距挂在"内容格"上，不挂在网格容器上**：容器带左右内边距会把整个网格（含标签列）
     往右推 6px，于是 OUT 的内容比 IN 偏右——实测 IN 内容列 x=65、OUT x=71，肉眼就是"没对齐"。
     这也是为什么这里不用 padding 而用子选择器给每个内容格各自加框。 */
  .tool-seg-out { background: transparent; padding: 0; border-radius: 0; }
  .tool-seg-out > :not(.tool-seg-label) {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 2px 6px;
  }
  /* [CUSTOM-20260929-121] 工具输出里的代码块不要那两个装饰：围栏语言标签（"console"）对
     命令输出没有信息量，而 has-lang 会给 pre 预留 20px 顶部内边距——那正是 OUT 框里
     上方那片空白。assistant 气泡里的代码块照旧保留。 */
  .tool-seg-out .code-lang { display: none; }
  .tool-seg-out .code-wrap.has-lang pre { padding-top: 0; }
  /* [CUSTOM-20260929-122] **字体与字号必须和 IN 的命令行一致**：工具输出里的 pre 落在
     .tool-text 里（不在 .bubble/.md 作用域内），拿不到那套等宽规则，于是回落到浏览器默认
     monospace（Windows 上是 Courier）——与 IN 的编辑器字体**字面宽度与左边界都不同**，
     视觉上就是"IN/OUT 没对齐"，两种等宽并排也显得脏。顺带清掉 UA 给 pre 的 1em 上下边距
     （盒子的底色与内边距已经由 .tool-seg-out 提供）。 */
  .tool-seg pre, .tool-seg code {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
  }
  .tool-seg-out pre { margin: 0; background: transparent; }
  .tool-seg-out > .tool-text:first-of-type { margin-top: 0; }
  .tool-seg-out .chip-row { margin-top: 0; }
  /* [CUSTOM-20260929-118] 兜底的原始输出（agent 报了 rawOutput、但 content 里没有可渲染的项）：
     终端文本按等宽渲染，限高与 .tool-seg-out 一致。 */
  .tool-raw {
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    white-space: pre-wrap; word-break: break-all; margin: 0;
  }
  .tool-body .tool-seg-out { max-height: 340px; overflow: auto; }
  .tool-command {
    font-family: var(--vscode-editor-font-family); font-size: 0.92em;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 2px 6px; margin: 0;
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
  /* [CUSTOM-20260930-138] 底部栏 = **两列**：主列（输入卡）+ 预留功能区。用 flex 两列而不是
     135 那种"给左边补一段 padding"的算法，是因为主列的宽度天然等于"面板宽 − 预留区宽"，
     于是输入卡的中线与消息列的中线**自动**重合 —— 少维护一个等式（pitfall #24 的正解）。 */
  .composer {
    display: flex; align-items: stretch;
    /* [CUSTOM-20260930-140] **真悬浮**：脱离文档流、盖在消息区之上。139 时它还在文档流里，
       于是底部这一整条（含卡片两侧那两块空白）都不显示消息 —— 用户报"输入框两侧还是会盖住
       消息内容"。现在消息区占满整个高度、卡片浮在上面，内容也不会被压住：#messages 的
       padding-bottom 留出了 --acpc-composer-h（composer.ts 的观察器写），滚到底时最后一条
       正好停在卡片上方。
       **背景必须透明** —— 有底色就等于把那两侧的消息蒙上一块。
       z-index 8：高于置顶卡片（6）与引导条（3）；消息内容本身不带 z-index。 */
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 8;
    /* [CUSTOM-20260930-144] 空区不吞鼠标：底栏通栏，但**只有卡片那一块**该接事件 ——
       否则输入卡两侧、以及右侧大纲栏底部那块透明区域会把点击拦下来（实测大纲最后一条的
       elementFromPoint 命中的是 composer，而不是那条记录）。可见的部件各自把 events 打开。 */
    pointer-events: none;
    /* [CUSTOM-20260930-139] 悬浮观感：卡片自己的描边 + 阴影 + 四周留白（底部这 10px 就是它
       不贴着面板下缘的那点距离）。
       [CUSTOM-20260930-138] **左右 padding 必须是 0**：右侧任何 padding 都会让预留区的
       border-left（那根竖线）比钉住的大纲栏左边界靠左同样的像素数（实测 8px 就是这么来的）。
       输入卡自己的边距交给 .composer-main 的**对称** padding —— 对称的 padding 不改变主列的
       中心，所以卡片与消息列的中线仍然重合（实测 dxCardVsCol = 0）。 */
    padding: 6px 0 10px;
  }
  /* [CUSTOM-20260930-143] 没连上 agent 之前不显示底栏：那时输入框本来就是禁用的，露一个
     "看得见却打不了字"的框只会让人以为它坏了（用户反馈）。相位由 stateCard 写在
     body[data-phase] 上，与上面 Times 那条用的是同一个机制（disconnected / connecting）。
     顺带的好处：display: none 会让 ResizeObserver 把 --acpc-composer-h 归零，消息区于是不再
     为一条并不存在的底栏留出底部空白。 */
  body[data-phase="disconnected"] .composer,
  body[data-phase="connecting"] .composer { display: none; }
  .composer-main { flex: 1; min-width: 0; display: flex; justify-content: center; padding-inline: 8px; }
  /* [CUSTOM-20260930-132] 限宽只加在这里（外墙照旧通栏），窄面板自动退化成满宽。
     它同时是 .slash-popup 的定位上下文 —— 弹层按输入卡对齐而不是按面板算
     （后者会在宽屏下横跨整屏）。 */
  /* [CUSTOM-20260930-144] 卡片与它的弹层要收事件（父级 .composer 关掉了 pointer-events）。 */
  .composer-inner {
    position: relative; width: 100%; max-width: var(--acpc-composer-max); pointer-events: auto;
  }
  /* [CUSTOM-20260930-138] 右下角的预留功能区。宽度与大纲栏**同源**（JS 写的 --acpc-aside-w，
     见 outline.ts 的 applyReserve）⇒ 可见时它的左边界与钉住的大纲栏左边界落在同一条竖线上，
     而那根竖线就是这里的 border-left。
     [143] **默认 0**：没有钉住的大纲栏就没有那根竖线，输入卡随之在面板里居中（用户要求）。
     下面几个 min() 是让"宽度为 0"这件事**彻底**：不然 border-left 会留一条 1px 的孤线、
     padding 也会撑出 8px —— 那时元素虽然宽 0，却仍然占着位置。
     max-width 是安全阀：面板窄到放不下时不让它把输入区挤没（那种宽度下竖线不再严格对齐，
     但那时也没有谁拿它当参照——大纲栏自己同样受 50% 上限约束）。 */
  .composer-aside {
    flex: 0 0 auto;
    width: var(--acpc-aside-w, 0px); max-width: 40%;
    border-left: min(1px, var(--acpc-aside-w, 0px)) solid var(--vscode-panel-border);
    display: flex; align-items: center; justify-content: center;
    padding-left: min(8px, var(--acpc-aside-w, 0px));
  }
  /* [CUSTOM-20260930-133] 一体式输入卡：textarea 与按钮栏共用一层描边（原来是"带边框的
     textarea + 卡外一行按钮"，中间隔一条缝，看着像两个孤立控件）。
     这一层**绝不能写 overflow**：.picker-menu 与 .slash-popup 都向上弹出、会被裁掉；而且
     column flex 容器上的 overflow 会压缩子项而不是让容器滚动（pitfalls #17）。 */
  .composer-card {
    display: flex; flex-direction: column;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 4px 8px 6px;
    /* [CUSTOM-20260930-139] 悬浮感来自这层阴影（与 .state-card / .picker-menu 同一档），
       配合上面去掉的通栏分隔线与四周留白。 */
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
  }
  .composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .config-pickers { display: flex; flex-wrap: wrap; gap: 4px; margin-right: auto; }
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
  /* [CUSTOM-20260926-079] 历史列表的目录过滤 chip + 菜单：**复用** composer 那套
     .picker-btn / .picker-menu / .picker-item（同一个"选一个值"的控件，观感应当一致），
     只补三件它没有的东西：
       · .down —— composer 的 picker 在面板底部、菜单向上弹；这个在 header 上、向下弹；
       · 右对齐 —— chip 在 header 右侧，菜单该从它这一侧展开；
       · .filter-item / .picker-count —— 行内有"名称 + 条数"，名称要能被省略号截断。 */
  .picker-menu.down { top: 100%; bottom: auto; left: auto; right: 0; min-width: 240px; }
  .filter-chip { max-width: 170px; font-size: 0.82em; padding: 0 5px; }
  /* 过滤生效时给边框上色：与 .outline-item.active 同一套"当前项"语义。**不用环**——
     环在这个面板里是键盘焦点（062 的教训）。 */
  .filter-chip.on { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  /* [CUSTOM-20260930-141] 目录过滤菜单与历史列表的底色/边框/圆角几乎同值（两者都吃
     --vscode-dropdown-* 那套 token），叠在一起分不清哪个是哪个 —— 用户要求区分开。
     借 .filter-chip.on 已有的那套语义（--vscode-focusBorder 表示"当前项"）：**不是画环**
     （环在这个面板里是键盘焦点，062 的教训），只是把边框换成高亮色。 */
  .filter-menu { border-color: var(--vscode-focusBorder); }
  .filter-icon { display: inline-flex; align-items: center; flex: none; opacity: .7; }
  .filter-icon svg { display: block; }
  .filter-caret { flex: none; opacity: .7; }
  .filter-item { display: flex; align-items: center; gap: 8px; }
  .filter-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .picker-count { flex: none; opacity: .7; font-size: 0.9em; }

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

  /* [CUSTOM-20260930-133] .input-row 这一层删掉了：它唯一的子节点就是 textarea，而 133 起
     textarea 是 .composer-card（flex 列）的子项 —— 那层 flex 行不再有任何作用，原文里的
     flex:1 在纵轴上的含义也完全不同（下面是 width:100%）。 */
  .prompt-input {
    width: 100%; box-sizing: border-box; resize: none; overflow-y: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    border: none; border-radius: 0; padding: 4px 0 0;
    font-family: inherit; font-size: inherit; line-height: 1.4;
    /* [CUSTOM-20260930-139] 默认只占**一行**：autoGrow 里那个 60px 的下限已放开，正常情况
       下高度就是内容的自然高度；这条 min-height 是"JS 还没跑 / 内容为空"时的保底，
       数字与上面那条 1.4 的行高同源（再算上 padding-top 的 4px）。 */
    min-height: calc(1.4em + 4px);
    /* [CUSTOM-20260930-134] 视口上限；内容上限仍是 autoGrow 的 320，两者取小。 */
    max-height: var(--acpc-input-max-h);
  }
  /* [CUSTOM-20260930-134] 焦点环改由卡片承担（见下面的 :focus-within）。只抑制这一个元素的
     outline，全局的 :focus-visible 不动 —— "环 = 键盘焦点"的语义（062）不变。 */
  .prompt-input:focus, .prompt-input:focus-visible { outline: none; }
  .prompt-input:disabled { opacity: .55; }
  .composer-card:focus-within { border-color: var(--vscode-focusBorder); }
  /* 禁用态让整张卡片跟着退场，否则是"鲜活的框里一行灰字"。:has() 需 Chromium ≥105
     （VS Code 1.85+ / Electron 25 起满足）；删掉也只损失一点观感。 */
  .composer-card:has(.prompt-input:disabled) { opacity: .7; }
  .send-stop {
    flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border-radius: 4px; cursor: pointer;
    border: none; font-family: inherit; font-size: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .send-stop:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .send-stop:disabled { opacity: .5; cursor: default; }
  .send-stop.stop { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }
  .send-stop .send-icon { display: inline-flex; align-items: center; }
  .send-stop .send-icon svg { display: block; width: 14px; height: 14px; }

  /* [CUSTOM-20260930-129] 置底栏的上下文用量：**圆环 + 圆心数字**（取代 096 的细条 + 百分比）。
     选圆环的理由是按钮栏里横向空间稀缺；顺带它多挂得下一个"正在跑"的外圈。
     数据与阈值都没变，仍然是 meta.usage 与 0.7 / 0.9 两档。 */
  .context-meter {
    position: relative; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    color: var(--vscode-descriptionForeground); cursor: default;
  }
  .context-meter svg { display: block; }
  .gauge-track { fill: none; stroke: var(--vscode-panel-border); stroke-width: 2.5; }
  .gauge-fill {
    fill: none; stroke: var(--vscode-progressBar-background); stroke-width: 2.5;
    stroke-linecap: round;
    /* 起点从 3 点方向挪到 12 点方向，否则进度看起来是"从右边开始长"的。 */
    transform: rotate(-90deg); transform-origin: 50% 50%;
  }
  .context-meter.warn .gauge-fill { stroke: var(--vscode-charts-yellow); }
  .context-meter.hot .gauge-fill { stroke: var(--vscode-charts-red); }
  .gauge-text {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 8.5px; font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground); pointer-events: none;
  }
  /* 外圈：一段 1/4 弧。只在**有轮次在跑**时出现并绕圈转——"它在干活"。
     半径比进度环大 2.5，两环之间才留得出缝（贴在一起时外弧读不出是"另一圈"）。
     周长 2π×11.5 ≈ 72.3，所以 dasharray 的 18.1 + 54.2 恰好绕满一圈。
     减少动效偏好由文件末尾那条全局规则兜住（animation: none !important）。 */
  .gauge-spin {
    /* currentColor (= the .context-meter's descriptionForeground), NOT the progress blue:
       same colour as the progress ring made the two read as two different progress bars.
       A neutral arc says "activity", and the blue ring keeps saying "how much". */
    fill: none; stroke: currentColor; stroke-width: 1.5;
    stroke-linecap: round; stroke-dasharray: 18.1 54.2;
    opacity: 0; transform-origin: 50% 50%;
  }
  .context-meter.running .gauge-spin { opacity: .9; animation: gauge-spin 1.5s linear infinite; }
  @keyframes gauge-spin { to { transform: rotate(360deg); } }

  .attachment-thumb { height: 20px; width: 20px; object-fit: cover; border-radius: 2px; flex: 0 0 auto; cursor: zoom-in; }

  /* Slash popup */
  .slash-popup {
    /* [CUSTOM-20260930-132] left/right 从 6px 改成 0：定位祖先已从 .composer 换成
       .composer-inner —— 那 6px 原本是抵消 .composer 的左右内边距、让弹层与 textarea 的
       边框盒对齐；现在祖先本身就是版心，0 就是卡片的那条边。留着 6px 会缩进一圈，
       而如果把它放在 .composer 里，宽屏下它会横跨整屏（与 820 的版心错位）。 */
    position: absolute; bottom: 100%; left: 0; right: 0; z-index: 30;
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

  /* --- 自定义右键菜单（CUSTOM-20260925-067）------------------------------
     取代 Chromium 的原生菜单：它提供的 Cut/Paste 在这里没有意义，而 Copy 复制的是
     **选区**（右键时通常没有选区）⇒ 表现为"点了没反应"。位置由 JS 按光标与视口边界算。 */
  .ctx-menu {
    position: fixed; z-index: 60;
    min-width: 150px; padding: 3px 0;
    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
    border-radius: 4px;
    box-shadow: 0 3px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .ctx-item {
    display: block; width: 100%; text-align: left;
    padding: 3px 12px; cursor: pointer;
    background: transparent; border: none; color: inherit;
    font-family: inherit; font-size: inherit;
  }
  .ctx-item:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, inherit);
  }
  /* 禁用态是有意义的："Copy" 在没有选区时禁用，而不是点了什么都不发生。 */
  .ctx-item:disabled { opacity: 0.5; cursor: default; }

  /* Load overlay */
  /* [CUSTOM-20260928-099] Scoped to the message area (its parent is
     '.message-area', which is already 'position: relative') — it used to be
     'position: fixed', which covered the tab strip, header and composer too. */
  .load-overlay {
    position: absolute; inset: 0; z-index: 40;
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

  /* --- 图片放大查看（CUSTOM-20260928-097）--------------------------------- */
  /* [hidden] 靠文件顶部的 [hidden]{display:none!important} 生效（pitfall #13）。 */
  .image-lightbox {
    position: fixed; inset: 0; z-index: 90;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.75);
    cursor: zoom-out;
  }
  .image-lightbox-img {
    max-width: 92%; max-height: 92%;
    border-radius: 4px; box-shadow: 0 6px 28px rgba(0, 0, 0, 0.55);
  }
  .image-lightbox-close {
    position: absolute; top: 14px; right: 14px;
    width: 32px; height: 32px; padding: 0;
    border: none; border-radius: 4px; cursor: pointer;
    background: rgba(255, 255, 255, 0.16); color: #fff;
    font-size: 16px; line-height: 1;
  }
  .image-lightbox-close:hover { background: rgba(255, 255, 255, 0.32); }
</style>`;
}
