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
      <div class="outline-head"></div>
      <div class="outline-list"></div>
    </div>
    <div id="cwdMenu" class="outline" hidden>
      <div class="outline-head"></div>
      <div class="outline-list"></div>
    </div>
  </div>

  <div id="messageArea" class="message-area">
    <div id="rail" class="rail" hidden><div id="railTrack" class="rail-track"></div></div>
    <!-- [CUSTOM-20260925-048] role="log" + aria-live: the transcript is the one
         region a screen reader must follow. aria-busy is driven by
         transcriptView (true while any entry is still streaming) so assistive
         tech defers announcements instead of reading every chunk — see
         refreshBusy. aria-relevant="additions" keeps text appended to an
         existing node from being re-announced. -->
    <div id="messages" class="messages" role="log" aria-live="polite"
         aria-relevant="additions" aria-busy="false"></div>
    <!-- [CUSTOM-20260926-076] 右侧常驻大纲栏：钉住模式下显示，是 #messages 的 flex 兄弟。
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
    <div id="emptyState" class="empty-state">
      <p class="empty-title">No session yet</p>
      <p class="empty-hint">Connect an agent to start, or press <kbd>Ctrl+Shift+A</kbd> to focus this panel.</p>
      <button id="emptyConnect" class="empty-connect">Connect Claude Code</button>
    </div>
  </div>

  <div id="composer" class="composer">
    <div id="slashPopup" class="slash-popup" hidden></div>
    <div id="attachments" class="attachments" hidden></div>
    <div id="configPickers" class="config-pickers"></div>
    <div class="input-row">
      <textarea id="promptInput" class="prompt-input" rows="3" placeholder="Type a message…" disabled></textarea>
      <button id="sendStopBtn" class="send-stop send" disabled>Send</button>
    </div>
  </div>

  <!-- [CUSTOM-20260925-067] 自定义右键菜单；项由 JS 按上下文生成（见 client/contextMenu.ts）。 -->
  <div id="ctxMenu" class="ctx-menu" hidden><div class="ctx-items"></div></div>

  <div id="loadOverlay" class="load-overlay" hidden>
    <div class="load-box"><span class="spinner"></span><span>Loading session history…</span></div>
  </div>
</body>
</html>`;
}
