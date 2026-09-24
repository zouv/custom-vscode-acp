// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 静态标记。所有动态内容由内联脚本填充；这里只有骨架与固定文案。
// [CUSTOM-END] CUSTOM-20260923-011
export function body(): string {
  return `<body>
  <div id="agentBar" class="agent-bar" hidden>
    <select id="agentSelect" class="agent-select" aria-label="Focused agent"></select>
  </div>

  <div id="tabStrip" class="tab-strip">
    <div id="tabs" class="tabs" role="tablist"></div>
    <button id="newTab" class="tab-new" title="New session" aria-label="New session">+</button>
  </div>

  <div id="sessionHeader" class="session-header">
    <span id="sessionTitle" class="session-title"></span>
    <span id="usageBar" class="usage-bar" hidden></span>
    <button id="nestToggle" class="nest-toggle" hidden
            title="Group sub-agent tool calls under their parent (links are inferred)">Sub-agents</button>
  </div>

  <div id="messageArea" class="message-area">
    <div id="messages" class="messages"></div>
    <button id="jumpToLatest" class="jump-latest" hidden>↓ Jump to latest</button>
    <div id="emptyState" class="empty-state">
      <p class="empty-title">No session yet</p>
      <p class="empty-hint">Pick an agent in the <strong>Agents</strong> view and connect, or press <kbd>Ctrl+Shift+A</kbd> to focus this panel.</p>
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

  <div id="loadOverlay" class="load-overlay" hidden>
    <div class="load-box"><span class="spinner"></span><span>Loading session history…</span></div>
  </div>
</body>
</html>`;
}
