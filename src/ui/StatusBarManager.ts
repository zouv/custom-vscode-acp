// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';
import { SessionManager } from '../core/SessionManager';

/**
 * Manages the status bar item showing ACP connection status.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly sessionManager: SessionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'acpc.connectAgent';
    this.updateStatus();

    // Update on agent changes
    this.sessionManager.on('agent-connected', () => this.updateStatus());
    this.sessionManager.on('agent-disconnected', () => this.updateStatus());
    this.sessionManager.on('active-session-changed', () => this.updateStatus());
    this.sessionManager.on('agent-error', () => this.showError());
    this.sessionManager.on('agent-closed', () => this.updateStatus());
  }

  private updateStatus(): void {
    const activeSession = this.sessionManager.getActiveSession();
    const connectedAgents = this.sessionManager.getConnectedAgentNames();

    if (connectedAgents.length === 0) {
      this.statusBarItem.text = '$(hubot) ACP: Disconnected';
      this.statusBarItem.tooltip = 'Click to connect to an agent';
      this.statusBarItem.backgroundColor = undefined;
    } else {
      const agentName = activeSession?.agentDisplayName || connectedAgents[0];
      this.statusBarItem.text = `$(hubot) ACP: ${agentName}`;
      this.statusBarItem.tooltip = `Connected to ${agentName}\n${connectedAgents.length} agent(s) connected`;
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.show();
  }

  private showError(): void {
    this.statusBarItem.text = '$(error) ACP: Error';
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
