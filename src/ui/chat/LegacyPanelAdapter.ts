// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 把**未改动的** ChatWebviewProvider 适配成 IChatPanel。
//
// 关键手法：递给旧 provider 的不是真实 WebviewView，而是一个 **facade**。旧 provider 对
// WebviewView 的接触面只有 6 处（options / html / cspSource / onDidReceiveMessage /
// postMessage / onDidDispose + show），因此 facade 能完全满足它，从而让
// `src/ui/ChatWebviewProvider.ts` 保持**零改动**——上游合并时该文件不会产生任何冲突。
//
// facade 的 onDidReceiveMessage / onDidDispose **不转发**给真实视图，只把回调存起来：
// 真实视图上只允许存在路由层那一个监听器，否则旧 provider 会同时通过路由分发和直接订阅
// 收到两条消息，造成重复处理。
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

import { ChatWebviewProvider } from '../ChatWebviewProvider';
import type { IChatPanel, PanelContext } from './panelContract';

interface Facade {
  readonly view: vscode.WebviewView;
  /** Fire the dispose callback the wrapped provider registered. */
  fireDispose(): void;
}

export class LegacyPanelAdapter implements IChatPanel {
  readonly id = 'legacy' as const;

  private facade: Facade | null = null;
  private messageHandler: ((message: unknown) => void) | null = null;

  constructor(private readonly inner: ChatWebviewProvider) {}

  attach(view: vscode.WebviewView, _ctx: PanelContext): void {
    this.facade = makeFacade(view, {
      onMessage: (handler) => { this.messageHandler = handler; },
    });
    // The wrapped provider only touches the six members the facade exposes.
    this.inner.resolveWebviewView(this.facade.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    this.inner.notifyActiveSessionChanged();
  }

  detach(): void {
    // Firing the dispose callback clears the provider's `view` field, so any
    // later postMessage from it becomes a no-op instead of throwing.
    this.facade?.fireDispose();
    this.facade = null;
    this.messageHandler = null;
  }

  onMessage(message: unknown): void {
    this.messageHandler?.(message);
  }

  onFocusChanged(_ctx: PanelContext): void {
    this.inner.notifyActiveSessionChanged();
  }

  hasContent(): boolean {
    return this.inner.hasChatContent;
  }

  clearChat(): void {
    this.inner.clearChat();
  }

  attachFile(uri: vscode.Uri): void {
    this.inner.attachFile(uri);
  }

  // --- Pass-throughs for the legacy-only notification surface --------------
  // These are safe to call while detached: the wrapped provider guards every
  // postMessage on its own `view` field, which detach() clears.

  notifyModesUpdate(modes: Parameters<ChatWebviewProvider['notifyModesUpdate']>[0]): void {
    this.inner.notifyModesUpdate(modes);
  }

  notifyModelsUpdate(models: Parameters<ChatWebviewProvider['notifyModelsUpdate']>[0]): void {
    this.inner.notifyModelsUpdate(models);
  }

  notifyLoadSessionStart(): void {
    this.inner.notifyLoadSessionStart();
  }

  notifyLoadSessionEnd(ok: boolean): void {
    this.inner.notifyLoadSessionEnd(ok);
  }

  notifySessionInfoUpdate(title: string | null | undefined): void {
    this.inner.notifySessionInfoUpdate(title);
  }
}

function makeFacade(
  realView: vscode.WebviewView,
  hooks: { onMessage: (handler: (message: unknown) => void) => void },
): Facade {
  let disposeCallback: (() => void) | null = null;

  const webview = {
    get options(): vscode.WebviewOptions { return realView.webview.options; },
    set options(value: vscode.WebviewOptions) { realView.webview.options = value; },
    get html(): string { return realView.webview.html; },
    set html(value: string) { realView.webview.html = value; },
    get cspSource(): string { return realView.webview.cspSource; },
    postMessage: (message: unknown): Thenable<boolean> => realView.webview.postMessage(message),
    onDidReceiveMessage: (handler: (message: unknown) => void): vscode.Disposable => {
      hooks.onMessage(handler);
      return new vscode.Disposable(() => { /* replaced by detach() */ });
    },
    asWebviewUri: (uri: vscode.Uri): vscode.Uri => realView.webview.asWebviewUri(uri),
  };

  const facade = {
    webview,
    onDidDispose: (handler: () => void): vscode.Disposable => {
      disposeCallback = handler;
      return new vscode.Disposable(() => { disposeCallback = null; });
    },
    show: (preserveFocus?: boolean): void => { realView.show?.(preserveFocus); },
  };

  return {
    view: facade as unknown as vscode.WebviewView,
    fireDispose: () => { disposeCallback?.(); },
  };
}
