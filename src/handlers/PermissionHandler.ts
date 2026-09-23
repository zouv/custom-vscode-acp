// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * Handles ACP permission requests from agents.
 * Shows VS Code QuickPick for user to select from agent-provided options.
 */
export class PermissionHandler {
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
      placeHolder: title,
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
