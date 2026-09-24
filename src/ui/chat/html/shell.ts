// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 文档外壳：CSP + nonce。
// CSP 说明：`img-src` 允许 `data:`（非文本 ContentBlock 里的 base64 图片），`style-src` 保留
// 'unsafe-inline'（webview 需要内联样式表），但 `script-src` **只有 nonce**——没有 'unsafe-inline'，
// 因此内联事件处理器（onerror=）与 javascript: URL 都无法执行。`cspSource` 只进 img/style，
// 绝不进 script-src。
// [CUSTOM-END] CUSTOM-20260923-011
import type * as vscode from 'vscode';

export function shell(webview: vscode.Webview, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'none'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ACP Chat</title>
</head>`;
}
