// [CUSTOM-BEGIN] CUSTOM-20260924-019 - 编辑区聊天面板（第二个 surface）：新增文件。
// 把 WebviewView（侧边栏）与 WebviewPanel（编辑区）归一化成同一个「面」，使 ChatPanelHost
// 不再依赖某一种视图类型。两者 API 的差异全部收敛在这里：
//   · 显隐   WebviewView.visible            / WebviewPanel.visible
//   · 前置   WebviewView.show(preserveFocus) / WebviewPanel.reveal(column, preserveFocus)
//   · 销毁   onDidDispose（两者同名同形）
// 注意 panel 没有 `show`：调用点若沿用旧写法 `view?.show?.(true)`，可选链会**静默失效**，
// 附件 chip 永远不显示也不报错——这正是本文件存在的原因。
// [CUSTOM-END] CUSTOM-20260924-019
import * as vscode from 'vscode';

/** The two surfaces the modern chat panel can render into. */
export type SurfaceKey = 'view' | 'editor';

/**
 * A view-agnostic chat surface. Implementations are thin adapters: they hold no
 * state of their own, so a surface may be created and dropped freely while the
 * transcript keeps living in the extension host.
 */
export interface ChatSurface {
  readonly key: SurfaceKey;
  readonly webview: vscode.Webview;
  /** True while the surface is actually on screen (drives the permission fallback). */
  readonly visible: boolean;
  setHtml(html: string): void;
  /** Bring to front. `preserveFocus` keeps the user's caret where it is. */
  reveal(preserveFocus: boolean): void;
  onDidDispose(listener: () => void): vscode.Disposable;
}

export function viewSurface(view: vscode.WebviewView): ChatSurface {
  return {
    key: 'view',
    get webview() { return view.webview; },
    get visible() { return view.visible; },
    setHtml: html => { view.webview.html = html; },
    reveal: preserveFocus => { view.show(preserveFocus); },
    onDidDispose: listener => view.onDidDispose(listener),
  };
}

export function panelSurface(panel: vscode.WebviewPanel): ChatSurface {
  return {
    key: 'editor',
    get webview() { return panel.webview; },
    get visible() { return panel.visible; },
    setHtml: html => { panel.webview.html = html; },
    // No column argument: the panel was created in `ViewColumn.Beside` and
    // passing a column here would move it on every reveal.
    reveal: preserveFocus => { panel.reveal(undefined, preserveFocus); },
    onDidDispose: listener => panel.onDidDispose(listener),
  };
}
