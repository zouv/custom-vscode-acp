// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 文档装配：外壳 + 样式 + 标记 + 客户端脚本。
// 没有独立构建步骤——这些模块经 webpack 现有的 src/extension.ts 入口内联进 dist/extension.js，
// 不产出新文件，因此 `.vscodeignore` 无需改动（`src/**` 本就排除）。
// [CUSTOM-END] CUSTOM-20260923-011
import type * as vscode from 'vscode';

import type { SurfaceKey } from '../ChatSurface';
import { shell } from './shell';
import { styles } from './styles';
import { body } from './body';
import { clientScript } from './client';

/**
 * [CUSTOM-20260925-050] `surface` reaches the document as a body class so the
 * stylesheet can give the editor-area panel the editor's background instead of
 * the sidebar's. Defaults to 'view' so the sidebar path reads unchanged.
 */
export function renderChatHtml(webview: vscode.Webview, nonce: string, surface: SurfaceKey = 'view'): string {
  return [
    shell(webview, nonce),
    styles(),
    body(surface),
    clientScript(nonce),
  ].join('\n');
}

export { createNonce } from './nonce';
