// [CUSTOM-BEGIN] CUSTOM-20260929-119 - elicitation 的策略层 + 弹框兜底：新增文件。
//
// 与 `PermissionHandler` 的两处差别（都是有意的）：
//   · **没有 autoApprove 之类的策略**：表单没有"自动填"的语义，代填一份答案比不答更糟。
//   · **只认 form 模式 + sessionId 作用域**：url 模式我们没声明支持（`elicitation.url`），
//     requestId 作用域的表单没有会话可归属 —— 两种都直接回 `cancel`，并写日志说明原因。
//
// 兜底弹框是本文件唯一的 vscode UI 代码（桥不 import vscode UI，方便单测）。
// [CUSTOM-END] CUSTOM-20260929-119
import * as vscode from 'vscode';
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';

import { log } from '../utils/Logger';
import {
  ElicitationBridge,
  fieldsOf,
  type ElicitationContent,
  type ElicitationFieldView,
} from './ElicitationBridge';

const LOG_PREFIX = 'elicitation';

export class ElicitationHandler {
  constructor(private readonly bridge?: ElicitationBridge) {}

  /** ACP entry point (`unstable_createElicitation`). */
  async create(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const mode = (params as { mode?: string }).mode;
    if (mode !== 'form') {
      // Url mode is not advertised (`clientCapabilities.elicitation.url`), so this
      // is a protocol violation rather than a user decision: refuse it loudly.
      log(`${LOG_PREFIX}: refusing a ${String(mode)} elicitation (only form mode is supported)`);
      return { action: 'cancel' };
    }
    const sessionId = (params as { sessionId?: string }).sessionId;
    if (!sessionId) {
      log(`${LOG_PREFIX}: refusing a request-scoped elicitation (no session to show it in)`);
      return { action: 'cancel' };
    }
    if (this.bridge) {
      return this.bridge.request(params, (p, label) => this.dialog(p, label));
    }
    return this.dialog(params, '');
  }

  /**
   * The no-panel path: ask the same fields one by one in the window.
   *
   * Step by step rather than one combined box because VS Code has no form dialog:
   * a QuickPick holds one question. Cancelling a step means "skip" (decline) —
   * the agent is told the user skipped, which keeps the turn alive; the panel's
   * own Esc is what sends the harder `cancel`.
   */
  private async dialog(params: CreateElicitationRequest, label: string): Promise<CreateElicitationResponse> {
    const fields = fieldsOf((params as { requestedSchema?: unknown }).requestedSchema);
    if (fields.length === 0) {
      log(`${LOG_PREFIX}: a form arrived with no field this panel can render`);
      return { action: 'decline' };
    }
    const message = typeof params.message === 'string' ? params.message : 'Input needed';
    const content: ElicitationContent = {};
    for (const field of fields) {
      const value = await this.askField(field, message, label);
      if (value === undefined) {
        log(`${LOG_PREFIX}: the dialog was dismissed at field ${field.name}`);
        return { action: 'decline' };
      }
      if (value !== null) { content[field.name] = value; }
    }
    return { action: 'accept', content };
  }

  /** `undefined` = dismissed; `null` = left empty (omitted from the content). */
  private async askField(
    field: ElicitationFieldView,
    message: string,
    label: string,
  ): Promise<string | number | boolean | string[] | null | undefined> {
    const title = [label, field.title || message].filter(Boolean).join(' · ');
    const place = field.description ? { placeHolder: field.description } : {};
    if (field.kind === 'select' || field.kind === 'multi') {
      const items = (field.options ?? []).map(o => ({
        label: o.title,
        detail: o.description,
        value: o.value,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title,
        canPickMany: field.kind === 'multi',
        ignoreFocusOut: true,
        ...place,
      });
      if (picked === undefined) { return undefined; }
      return Array.isArray(picked) ? picked.map(p => p.value) : (picked?.value ?? null);
    }
    if (field.kind === 'boolean') {
      const picked = await vscode.window.showQuickPick(
        [{ label: 'Yes', value: true }, { label: 'No', value: false }],
        { title, ignoreFocusOut: true, ...place },
      );
      if (picked === undefined) { return undefined; }
      return picked.value;
    }
    const typed = await vscode.window.showInputBox({
      title,
      ignoreFocusOut: true,
      prompt: field.description,
      ...(field.kind === 'number' ? { validateInput: (v: string) => (v.trim() === '' || !Number.isNaN(Number(v)) ? undefined : 'Enter a number') } : {}),
    });
    if (typed === undefined) { return undefined; }
    if (typed.trim() === '') { return null; }
    return field.kind === 'number' ? Number(typed) : typed;
  }
}
