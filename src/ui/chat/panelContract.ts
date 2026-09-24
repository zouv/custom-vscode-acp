// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 面板契约：路由层依赖的最小接口，使「新面板」与「未改动的旧面板」可以互换。
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

/** Which implementation is currently owning the single chat view. */
export type PanelId = 'modern' | 'legacy';

/** Focused agent + session, as understood by the router. */
export interface PanelContext {
  agentName: string | null;
  sessionId: string | null;
}

/**
 * The router owns the real `WebviewView` and exactly one
 * `onDidReceiveMessage` listener; panels are handed the view on attach.
 *
 * Panels MUST tolerate `detach()` followed by stray events: an unattached
 * panel drops its outgoing messages instead of throwing.
 */
export interface IChatPanel {
  readonly id: PanelId;

  /** Render into the view (or hand it off to the wrapped implementation). */
  attach(view: vscode.WebviewView, ctx: PanelContext): void;

  /** Give up the view. Subsequent outgoing messages must become no-ops. */
  detach(): void;

  /** A message arrived from the webview (already JSON-parsed). */
  onMessage(message: unknown): void;

  /** The focused agent/session changed. */
  onFocusChanged(ctx: PanelContext): void;

  /** Whether the panel currently holds transcript content (confirm dialogs). */
  hasContent(): boolean;

  /**
   * Discard the visible conversation. The modern panel treats this as a no-op
   * (a new conversation is a new tab, and its transcript lives per session);
   * the legacy panel wipes its single transcript, which is what upstream's
   * `clear-chat` meant.
   */
  clearChat(): void;

  /** `acpc.attachFile` picked a file. */
  attachFile(uri: vscode.Uri): void;
}
