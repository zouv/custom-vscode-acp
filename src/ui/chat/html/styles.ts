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
    color: var(--vscode-descriptionForeground);
  }
  .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
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
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    scrollbar-width: thin;
  }
  .jump-latest {
    position: absolute; right: 14px; bottom: 12px;
    padding: 3px 10px; border-radius: 12px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; font-family: inherit; font-size: 0.9em;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
  }
  .jump-latest:hover { background: var(--vscode-button-hoverBackground); }

  .empty-state { margin: auto; text-align: center; color: var(--vscode-descriptionForeground); padding: 20px; }
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
  /* Non-text message content (image / resource chips) */
  .entry-content { align-self: stretch; gap: 2px; }  .entry-notice.info { color: var(--vscode-descriptionForeground); }
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

  /* --- Thoughts -------------------------------------------------------- */
  .thought {
    border-left: 2px solid var(--vscode-panel-border);
    padding-left: 8px; margin: 2px 0;
    color: var(--vscode-descriptionForeground);
    font-style: italic; font-size: 0.95em;
  }
  .thought > summary { cursor: pointer; font-style: normal; user-select: none; }
  .thought-body {
    max-height: 300px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    margin-top: 4px; opacity: 0.85;
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
