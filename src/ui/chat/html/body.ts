// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 静态标记。所有动态内容由内联脚本填充；这里只有骨架与固定文案。
// [CUSTOM-END] CUSTOM-20260923-011
// [CUSTOM-BEGIN] CUSTOM-20260925-050 - body 带上「这是哪个面」，供样式区分。
// 编辑区面板与编辑器标签同处一列，用侧边栏底色会显得像外部面板；侧边栏视图则必须
// 保持侧边栏底色。差异全部交给 CSS（`.surface-editor`），标记里只写类名。
// [CUSTOM-END] CUSTOM-20260925-050
import type { SurfaceKey } from '../ChatSurface';

export function body(surface: SurfaceKey = 'view'): string {
  return `<body class="surface-${surface}">
  <div id="agentBar" class="agent-bar" hidden>
    <select id="agentSelect" class="agent-select" aria-label="Focused agent"></select>
  </div>

  <div id="tabStrip" class="tab-strip">
    <div id="tabs" class="tabs" role="tablist"></div>
    <button id="newTab" class="tab-new" title="New session" aria-label="New session">+</button>
  </div>

  <div id="sessionHeader" class="session-header">
    <button id="historyBtn" class="outline-btn"
            title="Open a previous session" aria-label="Open a previous session">↺</button>
    <!-- [CUSTOM-20260925-058] 这一格以前是 <span>，只显示 cwd 纯文本。现在它是真按钮
         （047 的规矩：真按钮才有键盘可达性），点开是目录选择抽屉。草稿页上它显示的是
         "这个会话将建在哪个目录"，已发出消息的会话上则是只读展示 + "在别处新建"。 -->
    <button id="cwdBtn" class="session-title" title="Working directory" aria-label="Working directory"></button>
    <span id="usageBar" class="usage-bar" hidden></span>
    <button id="timeToggle" class="nest-toggle"
            title="Show the wall-clock time of each record">Times</button>
    <button id="nestToggle" class="nest-toggle" hidden
            title="Group sub-agent tool calls under their parent (links are inferred)">Sub-agents</button>
    <button id="outlineBtn" class="outline-btn" hidden
            title="Conversation outline" aria-label="Conversation outline">☰</button>
    <div id="outline" class="outline" hidden>
      <!-- [CUSTOM-20260926-077] 钉住按钮并进 .outline-head（"N messages" 同一行）：
           .outline-head-info 是动态计数容器（render 只清它），钉住按钮是它的兄弟、静态。 -->
      <div class="outline-head">
        <span class="outline-head-info"></span>
        <button id="outlinePin" class="outline-btn"
                title="Pin to the right side" aria-label="Pin to the right side">⇥</button>
      </div>
      <div class="outline-list"></div>
    </div>
    <div id="history" class="outline" hidden>
      <!-- [CUSTOM-20260926-079] 与 077 同一形态：'.outline-head-info' 是 render() 清空并回填
           计数的动态容器，目录过滤 chip 与它的菜单是**兄弟节点**（静态，不会被重渲染清掉）。
           菜单挂在 head **内部**：head 是 position: sticky（已是定位元素），菜单用 top: 100%
           正好落在它下面——不需要量高度、也没有常量偏移。
           注意菜单用 '.open' 类切换而**不是 hidden 属性**：它有作者样式 display: none，
           与 .open 的 display 是同一层级的竞争（pitfall #13 的反面：这里靠类，不靠属性）。 -->
      <div class="outline-head">
        <span class="outline-head-info"></span>
        <button id="historyFilter" class="picker-btn filter-chip" hidden aria-expanded="false"></button>
        <div id="historyFilterMenu" class="picker-menu down"></div>
      </div>
      <div class="outline-list"></div>
    </div>
    <div id="cwdMenu" class="outline" hidden>
      <div class="outline-head"></div>
      <div class="outline-list"></div>
    </div>
  </div>

  <div id="messageArea" class="message-area">
    <div id="rail" class="rail" hidden><div id="railTrack" class="rail-track"></div></div>
    <!-- [CUSTOM-20260928-103] 消息列：把 #messages 与置顶副本关进同一个定位容器。
         102 时 #stickyUser 是 #messages 的兄弟、相对 .message-area 定位，而 .message-area 是
         flex 行、除消息列外还装着定宽的大纲栏 ⇒ 绝对定位的覆盖层横跨两段，右边一直伸进大纲
         栏下面（用户报的"甚至到右侧大纲界面了"）。放进这一层之后，"覆盖层不会盖到大纲栏上"
         是按构造成立的——不用量宽度，更不用常量偏移（pitfall #24）。 -->
    <div class="messages-column">
      <!-- [CUSTOM-20260928-102] 最近一条用户消息的「悬浮置顶条」（104 改成悬浮卡片 + 收缩按钮）。
           它是 .messages-column 的绝对定位子元素，不参与滚动也不占布局。
           卡片是内层元素：背景/描边/圆角要画在「内容盒」上，px 才能与 .messages 的内容盒对齐。 -->
      <div id="stickyUser" class="sticky-user" hidden>
        <!-- 105 起按钮在卡片**外面**（卡片左侧那条引导条通道里）：用户消息铺满整列之后
             卡片内已没有空档，放在里面就会压住正文。 -->
        <button id="stickyToggle" class="sticky-toggle" type="button" hidden
                title="Collapse" aria-label="Collapse or expand the pinned message"
                aria-expanded="true">&#x25B4;</button>
        <div id="stickyCard" class="sticky-card">
          <div id="stickyBody" class="sticky-body"></div>
        </div>
      </div>
      <!-- [CUSTOM-20260925-048] role="log" + aria-live: the transcript is the one
           region a screen reader must follow. aria-busy is driven by
           transcriptView (true while any entry is still streaming) so assistive
           tech defers announcements instead of reading every chunk — see
           refreshBusy. aria-relevant="additions" keeps text appended to an
           existing node from being re-announced. -->
      <div id="messages" class="messages" role="log" aria-live="polite"
           aria-relevant="additions" aria-busy="false"></div>
    </div>
    <!-- [CUSTOM-20260926-076] 右侧常驻大纲栏：钉住模式下显示，是 .messages-column 的 flex 兄弟
         （103 前是 #messages 的兄弟——那段距离只差一层不占尺寸的包装）。
         .outline-head（计数行）与 .outline-list（列表）与下拉共用同一套渲染逻辑。 -->
    <div id="outlineSidebar" class="outline-sidebar" hidden>
      <div class="outline-sidebar-head">
        <span class="outline-sidebar-title">Outline</span>
        <button id="outlineUnpin" class="outline-btn"
                title="Close outline" aria-label="Close outline">✕</button>
      </div>
      <div class="outline-head"></div>
      <div class="outline-list"></div>
      <div id="outlineResize" class="outline-resize" aria-hidden="true"></div>
    </div>
    <button id="jumpToLatest" class="jump-latest" hidden>↓ Jump to latest</button>
    <!-- [CUSTOM-20260927-090] 两套提示文案，按"agent 是否已连接"切换（boot.applyEmptyState）。
         用**静态两段 + hidden**而不是改 textContent：提示里有 <kbd> 元素，重写文本会把它
         的样式丢掉。已连接却还说"Connect an agent"是错的——关掉最后一个会话并不会停掉进程。 -->
    <div id="emptyState" class="empty-state">
      <p class="empty-title">No session yet</p>
      <p class="empty-hint" id="emptyHintDisconnected">Connect an agent to start, or press <kbd>Ctrl+Shift+A</kbd> to focus this panel.</p>
      <p class="empty-hint" id="emptyHintConnected" hidden>Start a new session with <kbd>+</kbd>, or open one from the history list <kbd>&#x21ba;</kbd>.</p>
      <button id="emptyConnect" class="empty-connect">Connect Claude Code</button>
    </div>
    <!-- [CUSTOM-20260928-099] Loading overlay lives INSIDE the message area: as a
         full-panel fixed-position sheet it covered the tab strip, the header and the
         composer while a session loaded, so the panel looked frozen and the user could
         not switch away from the session being loaded. -->
    <div id="loadOverlay" class="load-overlay" hidden>
      <div class="load-box"><span class="spinner"></span><span>Loading session history…</span></div>
    </div>
  </div>

  <div id="composer" class="composer">
    <div id="slashPopup" class="slash-popup" hidden></div>
    <div id="attachments" class="attachments" hidden></div>
    <div class="input-row">
      <textarea id="promptInput" class="prompt-input" rows="3" placeholder="Type a message…" disabled></textarea>
    </div>
    <!-- [CUSTOM-BEGIN] CUSTOM-20260928-096 - 输入区重构：按钮栏（mode/model/thought）移到输入框
         下方，Send 改为图标按钮，二者与上下文进度条合并成一条置底按钮栏（pickers 靠左、
         Send 靠右）。 -->
    <div class="composer-bar">
      <div id="configPickers" class="config-pickers"></div>
      <div id="contextMeter" class="context-meter" hidden title="Context usage"></div>
      <button id="sendStopBtn" class="send-stop send" disabled title="Send" aria-label="Send"></button>
    </div>
    <!-- [CUSTOM-END] CUSTOM-20260928-096 -->
  </div>

  <!-- [CUSTOM-20260925-067] 自定义右键菜单；项由 JS 按上下文生成（见 client/contextMenu.ts）。 -->
  <div id="ctxMenu" class="ctx-menu" hidden><div class="ctx-items"></div></div>

  <!-- [CUSTOM-20260928-097] 图片放大查看的覆盖层。点背景 / 点 ✕ / 按 Escape 关闭。 -->
  <div id="imageLightbox" class="image-lightbox" hidden>
    <button class="image-lightbox-close" title="Close" aria-label="Close">&#x2715;</button>
    <img class="image-lightbox-img" alt="">
  </div>
</body>
</html>`;
}
