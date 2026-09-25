// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
// [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限请求改走 PermissionBridge。
// 本文件不再是「唯一出口」：能进聊天面板的请求由面板内的卡片回答，进不去才回到这里的 QuickPick。
// 自动批准分支、`ignoreFocusOut` 与两处遥测**保持原样**（回归 #14 靠它们）。
// [CUSTOM-END] CUSTOM-20260924-020
import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import type { PermissionBridge } from './PermissionBridge';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows VS Code QuickPick for user to select from agent-provided options.
 */
export class PermissionHandler {
  constructor(private readonly bridge?: PermissionBridge) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const config = vscode.workspace.getConfiguration('acpc');
    const autoApprove = config.get<string>('autoApprovePermissions', 'none');

    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title} (autoApprove=${autoApprove})`);

    // Auto-approve: pick first allow-type option
    if (autoApprove === 'allowAll') {
      const allowOption = params.options.find(o =>
        o.kind === 'allow_once' || o.kind === 'allow_always'
      );
      if (allowOption) {
        sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption.optionId,
          },
        };
      }
    }

    // [CUSTOM-20260924-020] Anything past the auto-approve branch goes through
    // the bridge, which decides between the in-panel card and `quickPick` below.
    if (this.bridge) {
      return this.bridge.request(params, (p, label) => this.quickPick(p, label));
    }
    return this.quickPick(params, '');
  }

  /**
   * The dialog path. Used when no panel can render the prompt, or when the user
   * configures `acpc.autoApprovePermissions` off and the panel is unavailable.
   * `label` names the asking session so concurrent prompts are distinguishable
   * (the bridge serialises them so only one is up at a time).
   */
  private async quickPick(params: RequestPermissionRequest, label: string): Promise<RequestPermissionResponse> {
    const title = params.toolCall?.title || 'Permission Request';

    // Build QuickPick items from agent-provided options
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: label ? `${label} — ${title}` : title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return {
        outcome: { outcome: 'cancelled' },
      };
    }

    log(`Permission selected: ${selection.optionId}`);
    sendEvent('permission/responded', {
      permissionType: title,
      action: selection.optionId,
      outcome: 'selected',
    });
    return {
      outcome: {
        outcome: 'selected',
        optionId: selection.optionId,
      },
    };
  }
}
