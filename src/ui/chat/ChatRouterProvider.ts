// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 面板路由层：仍然是**唯一一个** `acpc-chat` 视图（package.json 不动、不引入 view 级 when、
// 不用 setContext），由本类按「当前聚焦会话所属的 agent」决定渲染新面板还是旧面板。
//
// 为什么选单视图路由而不是双视图条件显隐（见 CUSTOMIZATIONS/docs/arch/chat-panel.md §5）：
//   · `acpc-chat.focus` 有 5 个调用点（extension.ts ×4 + SessionTreeProvider 的树项命令），
//     单视图下全部不用改；
//   · 侧边栏不会出现两个聊天入口；
//   · 避开本仓库从未成功用过的 setContext 机制（`acpc.turnInProgress` 就是它失效的前车之鉴）。
// 代价是切换 agent 时 webview 会整体重渲染——但新面板的 transcript 存在扩展侧，切回不丢内容。
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

import type { SessionManager } from '../../core/SessionManager';
import type { SessionUpdateHandler } from '../../handlers/SessionUpdateHandler';
import type { PermissionBridge } from '../../handlers/PermissionBridge';
import { log } from '../../utils/Logger';
import { ChatPanelHost } from './ChatPanelHost';
import { LegacyPanelAdapter } from './LegacyPanelAdapter';
import { ChatWebviewProvider } from '../ChatWebviewProvider';
import type { IChatPanel, PanelContext, PanelId } from './panelContract';
import { isModernAgent } from './panelContract';
import { ChatEditorPanel } from './ChatEditorPanel';

const LOG_PREFIX = 'chat-router';

export class ChatRouterProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acpc-chat';

  private view: vscode.WebviewView | null = null;
  private current: IChatPanel | null = null;

  private readonly modern: ChatPanelHost;
  private readonly legacy: LegacyPanelAdapter;
  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 编辑区面板（第二个 surface，仅 Claude Code）。
  private readonly editor: ChatEditorPanel;
  // [CUSTOM-END] CUSTOM-20260924-019

  constructor(
    extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
    // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 透传给 ChatPanelHost（它注册为 PermissionPresenter）
    permissionBridge?: PermissionBridge,
    // [CUSTOM-END] CUSTOM-20260924-020
    // [CUSTOM-20260926-077] 透传给 ChatPanelHost，持久化大纲钉住/宽度偏好。
    globalState?: vscode.Memento,
  ) {
    this.modern = new ChatPanelHost(extensionUri, sessionManager, sessionUpdateHandler, permissionBridge, globalState);
    this.legacy = new LegacyPanelAdapter(
      new ChatWebviewProvider(extensionUri, sessionManager, sessionUpdateHandler),
    );
    // [CUSTOM-BEGIN] CUSTOM-20260924-019
    this.editor = new ChatEditorPanel(this.modern, sessionManager, extensionUri, () => this.context());
    // [CUSTOM-END] CUSTOM-20260924-019

    // Any focus change may cross the panel boundary (Claude Code ⇄ other agent).
    this.sessionManager.on('active-session-changed', () => this.syncActivePanel());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    // Exactly ONE real listener on the view; panels never register their own.
    webviewView.webview.onDidReceiveMessage(message => {
      this.current?.onMessage(message);
    });

    webviewView.onDidDispose(() => {
      this.current?.detach();
      this.current = null;
      this.view = null;
    });

    const id = this.panelIdForFocus();
    log(`${LOG_PREFIX}: resolving chat view with panel "${id}"`);
    this.activate(id, true);
  }

  // --- Public surface used by extension.ts ---------------------------------

  /** True when the visible panel holds content (drives the confirm dialogs). */
  get hasChatContent(): boolean {
    return this.current?.hasContent() ?? false;
  }

  clearChat(): void {
    this.current?.clearChat();
  }

  attachFile(uri: vscode.Uri): void {
    this.current?.attachFile(uri);
  }

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 打开编辑区面板（`acpc.openChatInEditor`）。
  openEditorChat(): void {
    this.editor.open();
  }
  // [CUSTOM-END] CUSTOM-20260924-019

  notifyActiveSessionChanged(): void {
    this.syncActivePanel();
  }

  // Legacy-only notification surface. Forwarded unconditionally: the wrapped
  // provider no-ops when it is not the attached panel.

  notifyModesUpdate(modes: Parameters<LegacyPanelAdapter['notifyModesUpdate']>[0]): void {
    this.legacy.notifyModesUpdate(modes);
  }

  notifyModelsUpdate(models: Parameters<LegacyPanelAdapter['notifyModelsUpdate']>[0]): void {
    this.legacy.notifyModelsUpdate(models);
  }

  notifyLoadSessionStart(): void {
    this.legacy.notifyLoadSessionStart();
  }

  notifyLoadSessionEnd(ok: boolean): void {
    this.legacy.notifyLoadSessionEnd(ok);
  }

  notifySessionInfoUpdate(title: string | null | undefined): void {
    this.legacy.notifySessionInfoUpdate(title);
  }

  dispose(): void {
    this.editor.dispose();
    this.current?.detach();
    this.current = null;
    this.view = null;
    this.modern.dispose();
  }

  // --- Routing -------------------------------------------------------------

  private panelIdForFocus(): PanelId {
    return isModernAgent(this.sessionManager.getFocusedAgentName()) ? 'modern' : 'legacy';
  }

  private context(): PanelContext {
    return {
      agentName: this.sessionManager.getFocusedAgentName(),
      sessionId: this.sessionManager.getActiveSessionId(),
    };
  }

  /** Re-evaluate which panel should own the view, then refresh its focus. */
  private syncActivePanel(): void {
    const id = this.panelIdForFocus();
    const ctx = this.context();

    // [CUSTOM-BEGIN] CUSTOM-20260924-019 / CUSTOM-20260925-031 - 不变量：编辑区面存在 ⟹
    // 聚焦 agent（**若有**）属于 MODERN_AGENTS。
    // 焦点跨到别的 agent 时先关掉编辑区面板：legacy 面板的对话内容存在 webview DOM 里，
    // 留着它只会显示上一个 agent 的陈旧内容。
    // **没有聚焦会话（agentName 为 null）不再算违规**——那是个合法状态（窗口重载后就是这样），
    // 031 之前它会让"打开编辑区面板"的按钮必被拒（见 ChatEditorPanel.open 的说明）。
    if (ctx.agentName && id !== 'modern' && this.editor.isOpen) {
      this.editor.close('focus-changed');
    }
    // [CUSTOM-END] CUSTOM-20260924-019 / CUSTOM-20260925-031

    if (!this.view) {
      // 侧边栏从未打开（用户只用编辑区面板）时，焦点也必须推给 modern host，
      // 否则面板永远停在 attach 那一刻的快照上。旧实现在这里直接 return。
      if (id === 'modern' && this.editor.isOpen) { this.modern.onFocusChanged(ctx); }
      return;
    }

    this.activate(id, false);
    this.current?.onFocusChanged(ctx);
  }

  private activate(id: PanelId, force: boolean): void {
    if (!this.view) { return; }
    if (!force && this.current?.id === id) { return; }

    this.current?.detach();
    const next: IChatPanel = id === 'modern' ? this.modern : this.legacy;
    next.attach(this.view, this.context());
    this.current = next;
    log(`${LOG_PREFIX}: active panel is now "${id}"`);
  }
}
