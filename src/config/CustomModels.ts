// [CUSTOM-BEGIN] CUSTOM-20261011-235 - 自定义模型（acpc.customModels）：类型、归一化与读取。
// 从 ChatPanelHost 迁来（原 CUSTOM-20261010-233 的 normalizeCustomModels）：SessionManager（core）
// 也要读同一份配置，在会话创建时经 ACP `_meta.extraModels` 注入 agent，让 agent 把自定义模型
// 列入其 `model` 配置项（配套 fork 桥的做法，见 CUSTOMIZATIONS/docs/changelog.md 235）。
// name/description 供客户端显示名映射用（composer.optionLabel），不在 _meta.extraModels 里。
// [CUSTOM-END] CUSTOM-20261011-235
import * as vscode from 'vscode';

/** A user-defined model alias from `acpc.customModels` (settings.json). */
export interface CustomModel {
  /** The model id injected into the agent via `_meta.extraModels` and sent on selection. */
  modelId: string;
  /** Display name; falls back to `modelId` when absent. */
  name?: string;
  /** Optional hover text (currently unused). */
  description?: string;
}

/**
 * Normalise the raw `acpc.customModels` value: drop entries without a `modelId`,
 * fall `name` back to `modelId`, drop non-string `description`.
 */
export function normalizeCustomModels(raw: unknown): CustomModel[] {
  const out: CustomModel[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') { continue; }
    const entry = item as { modelId?: unknown; name?: unknown; description?: unknown };
    const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
    if (!modelId) { continue; }
    out.push({
      modelId,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : modelId,
      description: typeof entry.description === 'string' ? entry.description : undefined,
    });
  }
  return out;
}

/** Read the configured custom models (normalised). */
export function readCustomModels(): CustomModel[] {
  return normalizeCustomModels(vscode.workspace.getConfiguration('acpc').get('customModels'));
}
