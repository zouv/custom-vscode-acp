// [CUSTOM-BEGIN] CUSTOM-20260924-019 - 编辑区聊天面板（第二个 surface）：新增文件。
// 编辑区（编辑器标签页）里的 Chat 面板。与侧边栏 `acpc-chat` 视图**并存**，两者共享同一个
// `ChatPanelHost`——记录本来就存在扩展宿主，所以两个面天然同源，关掉再打开也不丢内容
// （重开只是新文档 → `ready` → 定向 boot → 全量快照，**不会**触发 session/load）。
//
// 所有配置的 ACP agent 都使用现代的 session-keyed host；编辑区和侧边栏同源。
// MODERN_AGENTS 仅是空焦点时的缺省候选，不是 Claude/Codex 白名单。
// [CUSTOM-END] CUSTOM-20260924-019
import * as vscode from 'vscode';

import type { SessionManager } from '../../core/SessionManager';
import { log } from '../../utils/Logger';
import type { ChatPanelHost } from './ChatPanelHost';
import { panelSurface } from './ChatSurface';
import { isModernAgent, MODERN_AGENTS, type PanelContext } from './panelContract';

export const CHAT_EDITOR_VIEW_TYPE = 'acpc-chat-editor';

const LOG_PREFIX = 'chat-panel';

export class ChatEditorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly host: ChatPanelHost,
    private readonly sessionManager: SessionManager,
    private readonly extensionUri: vscode.Uri,
    private readonly context: () => PanelContext,
  ) {}

  get isOpen(): boolean {
    return this.panel !== null;
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  open(): void {
    const ctx = this.context();
    // [CUSTOM-20260925-031] 门禁放宽（用户要求「点击后直接打开面板，不依赖侧边栏」）。
    // 原来要求「聚焦 agent 必须是 modern」，于是**没有聚焦会话**时也会被拒——而
    // 「窗口重载后 / 没点过任何会话」正好是这种状态（`activeSessionId` 为 null）。
    // 更误导的是状态栏：它显示的是 `activeSession?.agentDisplayName || connectedAgents[0]`，
    // 没有活跃会话时退化成「第一个已连接的 agent」，所以看起来像"明明就是 Claude Code"。
    // 现在所有非空 agent 名都通过现代面板门禁；保留分支供未来路由策略扩展。
    if (ctx.agentName && !isModernAgent(ctx.agentName)) {
      void vscode.window.showInformationMessage(
        'This agent does not support the editor-area chat panel.',
      );
      log(`${LOG_PREFIX}: editor panel refused (agent "${ctx.agentName}" uses the legacy panel)`);
      return;
    }
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }

    // 没有聚焦会话时先挑一个，否则面板打开就是空态（用户选的行为）。
    if (!ctx.sessionId) { this.focusMostRecentModernSession(); }

    const panel = vscode.window.createWebviewPanel(
      CHAT_EDITOR_VIEW_TYPE,
      'ACP Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Same trade-off as the sidebar view: the transcript lives in the
        // extension host, but keeping the document alive avoids rebuilding a
        // long timeline every time the tab is switched away and back.
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.panel = panel;

    // ORDER MATTERS: the listeners must exist BEFORE the surface attaches.
    // `attachSurface` writes the HTML, and the document's `ready` message can
    // arrive immediately after; registering late drops that first `ready` and
    // leaves the panel permanently empty (same failure class as the message
    // guard documented in CUSTOMIZATIONS/docs/arch/chat-panel.md §5.4 —
    // nothing automated catches it).
    panel.webview.onDidReceiveMessage(message => this.host.onMessage(message, 'editor'));
    panel.onDidDispose(() => {
      this.panel = null;
      this.host.detachSurface('editor');
      log(`${LOG_PREFIX}: editor panel disposed`);
    });

    // Re-read the context: focusing a session above may have just changed it, and
    // the boot snapshot is built from whatever we hand over here.
    this.host.attachSurface(panelSurface(panel), this.context());
    log(`${LOG_PREFIX}: editor panel opened`);
  }

  /**
   * [CUSTOM-20260925-031] No session is focused but the user wants the panel.
   *
   * Reuses exactly what the panel's own agent picker does (`focusAgent`): take the
   * most recent live session of a modern agent and focus it. Focusing emits
   * `active-session-changed`, so the rest of the system follows along.
   *
   * Deliberately does NOT create a session: "open the panel" must not spawn an
   * agent process. An empty panel is a valid outcome, and its `+` button creates
   * a session in one click.
   */
  private focusMostRecentModernSession(): void {
    // [CUSTOM-BEGIN] CUSTOM-20261101-007 - Default candidates first, then every other connected agent.
    const candidates = new Set([...MODERN_AGENTS, ...this.sessionManager.getConnectedAgentNames()]);
    // [CUSTOM-END] CUSTOM-20261101-007
    for (const agentName of candidates) {
      const ids = this.sessionManager.getSessionIdsForAgent(agentName);
      const mostRecent = ids[ids.length - 1];
      if (mostRecent) {
        log(`${LOG_PREFIX}: no focused session; focusing ${agentName}'s most recent (${mostRecent})`);
        this.sessionManager.focusSession(mostRecent);
        return;
      }
    }
    log(`${LOG_PREFIX}: no focused session and no modern session to focus; opening empty panel`);
  }

  close(reason: 'user' | 'focus-changed' | 'dispose'): void {
    if (!this.panel) { return; }
    log(`${LOG_PREFIX}: editor panel closed (${reason})`);
    this.panel.dispose();
  }

  dispose(): void {
    this.close('dispose');
  }
}
