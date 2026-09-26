// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 新面板的扩展侧实现：把 SessionManager / SessionUpdateHandler 的事件翻译成会话记录，
// 再通过 postMessage 推给 webview。
//
// 设计要点：
//   · transcript 存在扩展宿主（TranscriptStore），因此切标签、切面板、重新 attach 都不丢内容——
//     不需要重新 session/load。
//   · 记录在 panel 未 attach 时也照常累积（后台会话继续跑），只是 postMessage 被守卫丢弃。
//   · 所有发出的消息都带 sessionId；所有收到的消息都先校验 sessionId 与 SessionManager 匹配，
//     不匹配一律丢弃并记日志，绝不静默落到「当前聚焦会话」上。
//   · 两个 surface（侧边栏视图 / 编辑区面板）共享本实例：`post()` 广播、`boot` 只回给发起者
//     （CUSTOM-20260924-019，见 ChatSurface.ts）。
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk';

import type { SessionManager, SessionInfo } from '../../core/SessionManager';
import type { SessionUpdateHandler, SessionUpdateListener } from '../../handlers/SessionUpdateHandler';
import { log } from '../../utils/Logger';
import { renderChatHtml, createNonce } from './html';
import { SafeMarkdown } from './markdown';
import { Outbox } from './Outbox';
import type {
  Attachment,
  ChatToExt,
  CloseReason,
  ExtToChat,
  ExtToChatMessage,
  MarkdownRendered,
  SessionMeta,
  SessionSummary,
  TranscriptSnapshotWire,
  UiPrefs,
} from './protocol';
import type { IChatPanel, PanelContext } from './panelContract';
import { isModernAgent, MODERN_AGENTS } from './panelContract';
import { viewSurface, type ChatSurface, type SurfaceKey } from './ChatSurface';
import type { PermissionPresenter, PermissionState } from '../../handlers/PermissionBridge';
import { PermissionBridge } from '../../handlers/PermissionBridge';
import { TranscriptStore } from './transcript/TranscriptStore';
import { ToolInvocationStore } from './transcript/ToolInvocationStore';
import { toToolCallView } from './content/toolCalls';
import { toContentView, hasVisibleContent } from './content/contentBlocks';
import { resolveNestingStrategy } from './nesting/NestingStrategy';
import {
  choiceChanges,
  choiceSnapshotFromState,
  choiceSnapshotPatched,
  type ChoiceSnapshot,
} from './sessionChoices';

/** Prefix of the output channel used for panel-level diagnostics. */
const LOG_PREFIX = 'chat-panel';

/**
 * [CUSTOM-20260924-022] Message types that must NEVER be delayed or merged.
 *
 * INV-C: `sessionsChanged` drives the Send/Stop button — a late one leaves a
 * stale `Send` after the turn already started.
 * INV-D: `sessionClosed` must remove its tab immediately.
 * `boot`/`focus` are full snapshots and are always preceded by a flush, so they
 * can never arrive before an append they already contain (INV-E).
 */
const STRUCTURAL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'boot', 'focus', 'sessionsChanged', 'sessionClosed', 'meta', 'attachments', 'error',
]);

/** [CUSTOM-20260926-077] globalState key for the outline pin/width prefs. */
const UI_PREFS_KEY = 'acpc.outlinePrefs.v1';

export class ChatPanelHost implements IChatPanel, PermissionPresenter {
  readonly id = 'modern' as const;

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 单视图 → 多 surface（侧边栏 + 编辑区）。
  // 状态仍然只有这一份，两个面读同一个 store；`post()` 默认广播，两边自动同源。
  // `lastActive` 只用于「把某个面提到前面」（附件 chip），不参与路由决策。
  private readonly surfaces = new Map<SurfaceKey, ChatSurface>();
  private lastActive: SurfaceKey | null = null;
  // [CUSTOM-END] CUSTOM-20260924-019

  private readonly transcripts = new TranscriptStore();
  private readonly tools = new ToolInvocationStore();
  private readonly markdown = new SafeMarkdown();

  /** sessionId → pending attachments (resource_link blocks for the next prompt). */
  private readonly attachments: Map<string, Attachment[]> = new Map();
  /** sessionId → latest usage numbers, rendered as a token bar. */
  private readonly usage: Map<string, SessionMeta['usage']> = new Map();
  /** `${sessionId}::${toolCallId}` → transcript entry id. */
  private readonly toolEntryIds: Map<string, string> = new Map();
  /** sessionId → entry id of the single plan card (ACP replaces the list). */
  private readonly planEntryIds: Map<string, string> = new Map();
  // [CUSTOM-20260925-063] Sessions that produced output while they were NOT the
  // focused one. Surfaced as the tab-strip "attention" dot, which is a HINT and
  // never a notification: no dialog, no focus stealing.
  private readonly unread: Set<string> = new Set();
  // [CUSTOM-20260926-073] sessionId → last known switchable state (mode + config
  // options), for the "Switched to <model>" notice. The cache is written ONLY here
  // (never read back from SessionManager at diff time), because the two paths that
  // report a change — our own setter and the agent's `*_update` notification — race
  // against SessionManager's listener order. Whatever lands first announces, and
  // the other one diffs to nothing: that is the de-duplication, by construction.
  private readonly choices: Map<string, ChoiceSnapshot> = new Map();
  // [CUSTOM-20260926-075] sessionId → last known title, for the rename notice.
  // Same "the cache is ours" rule as `choices`: SessionManager may already have
  // applied the new title by the time our listener runs, so its copy cannot tell us
  // what the OLD one was.
  private readonly sessionTitles: Map<string, string> = new Map();

  private focused: PanelContext = { agentName: null, sessionId: null };
  /** [CUSTOM-20260926-077] Outline pin/width prefs, cached from globalState. */
  private uiPrefs: UiPrefs | null = null;

  // [CUSTOM-BEGIN] CUSTOM-20260924-022 - 合帧队列 + 标签栏快照签名（见 refreshSessions）。
  private readonly outbox: Outbox;
  private lastSessionsSignature: string | null = null;
  // [CUSTOM-END] CUSTOM-20260924-022

  private readonly updateListener: SessionUpdateListener;
  private readonly subscriptions: vscode.Disposable[] = [];
  // [CUSTOM-20260925-041] Held so dispose() can UNREGISTER the listener. The
  // legacy provider does this (ChatWebviewProvider.dispose ->
  // removeListener) while this host only ever added one, leaving the
  // registration to be swept up by SessionUpdateHandler.dispose() — correct by
  // accident, not by contract.
  private readonly sessionUpdateHandler: SessionUpdateHandler;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
    private readonly permissionBridge?: PermissionBridge,
    // [CUSTOM-20260926-077] globalState for UI prefs that survive webview disposal.
    private readonly globalState?: vscode.Memento,
  ) {
    this.sessionUpdateHandler = sessionUpdateHandler;
    this.uiPrefs = this.globalState?.get<UiPrefs>(UI_PREFS_KEY) ?? null;
    // The host IS the permission presenter for the modern panel: no other
    // object knows whether a surface is on screen and which session is focused.
    this.permissionBridge?.setPresenter(this);
    // [CUSTOM-20260924-022] One frame of coalescing for order-coupled messages.
    this.outbox = new Outbox({
      send: message => this.postNow(message),
      log: message => log(`${LOG_PREFIX}: ${message}`),
    });
    this.updateListener = (update: SessionNotification) => this.onSessionUpdate(update);
    this.sessionUpdateHandler.addListener(this.updateListener);

    const refresh = () => this.refreshSessions();
    const on = (event: string, handler: (...args: any[]) => void) => {
      this.sessionManager.on(event, handler);
      this.subscriptions.push({ dispose: () => this.sessionManager.off(event, handler) });
    };

    on('session-created', refresh);
    on('session-closed', (sessionId: string, _agentName: string, reason: CloseReason) => {
      // Release everything keyed by this session, then tell the client so a
      // closed tab disappears immediately rather than waiting for the focus
      // change that follows.
      this.transcripts.drop(sessionId);
      this.tools.drop(sessionId);
      this.attachments.delete(sessionId);
      this.usage.delete(sessionId);
      this.planEntryIds.delete(sessionId);
      // [CUSTOM-20260926-073] Session ids are never reused, so a stale switch
      // baseline could only ever suppress the first notice of a new session.
      this.choices.delete(sessionId);
      this.sessionTitles.delete(sessionId);
      for (const key of Array.from(this.toolEntryIds.keys())) {
        if (key.startsWith(`${sessionId}::`)) { this.toolEntryIds.delete(key); }
      }
      this.post({ type: 'sessionClosed', sessionId, reason });
      refresh();
    });
    on('agent-connected', refresh);
    on('agent-disconnected', refresh);
    on('session-info-changed', refresh);
    on('session-load-start', refresh);
    on('session-load-end', (sessionId: string) => {
      // [CUSTOM-20260925-055] A replay is a FINITE recorded stream, so once it
      // ends nothing can still be streaming — but nothing else closes the
      // entries it created: `finalizeTurn` only runs for a prompt WE sent, and a
      // `session/load` is not one. Left open, the trailing assistant entry keeps
      // the client in its streaming state forever and pins `aria-busy` to true,
      // which silently mutes the screen reader. (Found by
      // src/test/chat-panel.test.ts against a real captured replay.)
      this.finalizeEntries(sessionId);
      refresh();
    });
    on('active-session-changed', (sessionId: string | null, agentName: string | null) => {
      // The router owns focus decisions, but a focus change originating from
      // elsewhere (e.g. the tree) must still reach an attached panel.
      this.focused = { agentName, sessionId };
      // [CUSTOM-20260925-063] Focusing a session consumes its unread marker, and
      // the strip has to be told — otherwise the attention dot lingers.
      if (sessionId) { this.unread.delete(sessionId); }
      this.pushFocus();
      this.refreshSessions();
    });
  }

  // --- IChatPanel ----------------------------------------------------------

  attach(view: vscode.WebviewView, ctx: PanelContext): void {
    this.attachSurface(viewSurface(view), ctx);
  }

  /**
   * [CUSTOM-20260924-019] Attach (or re-attach) one surface. The same entry
   * point serves the sidebar view and the editor panel, so the HTML is rendered
   * per document — each webview needs its own CSP nonce and its own
   * `cspSource`, which is why the html string is never shared between surfaces.
   */
  attachSurface(surface: ChatSurface, ctx: PanelContext): void {
    this.surfaces.set(surface.key, surface);
    this.lastActive = surface.key;
    this.focused = ctx;
    surface.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    surface.setHtml(renderChatHtml(surface.webview, createNonce(), surface.key));
    // Targeted: a broadcast boot would force the OTHER document to reset and
    // re-hydrate (losing its scroll position) every time a surface attaches.
    this.pushBoot(surface.key);
  }

  detach(): void {
    this.detachSurface('view');
  }

  detachSurface(key: SurfaceKey): void {
    this.surfaces.delete(key);
    if (this.lastActive === key) {
      this.lastActive = this.surfaces.keys().next().value ?? null;
    }
    // [CUSTOM-20260924-020] Last surface gone: any permission card still
    // waiting for a click is now unreachable, and the agent is blocked on it.
    // The bridge moves those prompts to the dialog instead of hanging.
    if (this.attachedCount === 0) { this.permissionBridge?.onPresenterLost(); }
    // [CUSTOM-END] CUSTOM-20260924-020
  }

  /** Zero means there is nowhere to render; every push must bail out. */
  private get attachedCount(): number {
    return this.surfaces.size;
  }

  onFocusChanged(ctx: PanelContext): void {
    this.focused = ctx;
    this.pushFocus();
  }

  hasContent(): boolean {
    return this.transcripts.hasContent(this.focused.agentName);
  }

  /**
   * Deliberate no-op. `clear-chat` exists because upstream's single-session
   * panel had to wipe its transcript when a new conversation started. Here a
   * new conversation is simply a new session with its own transcript, so
   * wiping would destroy a background session's history.
   */
  clearChat(): void {
    log(`${LOG_PREFIX}: clear-chat ignored (multi-session panel keeps per-session transcripts)`);
  }

  attachFile(uri: vscode.Uri): void {
    const sessionId = this.focused.sessionId;
    if (!sessionId) {
      void vscode.window.showWarningMessage('Attach File: no session is focused.');
      return;
    }
    this.addAttachments(sessionId, [{ path: uri.fsPath, name: basename(uri.fsPath) }]);
    // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 提到「最近交互过的面」而不是固定的侧边栏视图。
    // 旧写法 `view?.show?.(true)` 对 WebviewPanel 会静默失效（面板没有 `show`），
    // 表现为附件 chip 不显示也不报错。
    const surface = this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
    surface?.reveal(true);
    // [CUSTOM-END] CUSTOM-20260924-019
  }

  /**
   * [CUSTOM-20260925-049] Add attachments to a session's pending list.
   *
   * Extracted from `attachFile` so the drag-and-drop path can share it — that
   * path must NOT reveal a surface, because the drop already happened on a
   * visible one and raising another panel would steal focus for no reason.
   */
  private addAttachments(sessionId: string, incoming: Attachment[]): void {
    const list = this.attachments.get(sessionId) ?? [];
    for (const attachment of incoming) {
      if (!list.some(existing => existing.path === attachment.path)) { list.push(attachment); }
    }
    this.attachments.set(sessionId, list);
    this.post({ type: 'attachments', sessionId, attachments: list });
  }

  /** Files dropped onto (or pasted into) the panel. */
  private handleAttachPaths(sessionId: string, paths: unknown): void {
    if (!Array.isArray(paths)) { return; }
    const incoming: Attachment[] = [];
    for (const raw of paths) {
      if (typeof raw !== 'string' || raw.length === 0) { continue; }
      incoming.push({ path: raw, name: basename(raw) });
    }
    if (incoming.length === 0) { return; }
    this.addAttachments(sessionId, incoming);
    log(`${LOG_PREFIX}: attached ${incoming.length} dropped/pasted file(s) to ${sessionId}`);
  }

  onMessage(message: unknown, from: SurfaceKey = 'view'): void {
    const msg = message as Partial<ChatToExt> & { type?: string };
    if (!msg || typeof msg.type !== 'string') { return; }
    this.lastActive = from;

    switch (msg.type) {
      case 'ready':
        this.pushBoot(from);
        return;
      case 'newSession': {
        // [CUSTOM-BEGIN] CUSTOM-20260924-024 - 修「+ 按钮点了没反应」。
        // 原先这里调 `connectToAgent(agentName)`，而它的语义是**已有会话就复用**
        // （SessionManager.connectToAgent：liveIds.length > 0 时只 focusSession），
        // 于是「开新会话」在有会话时退化成「聚焦已有会话」。开新会话必须走
        // newConversation → createSession —— 那才是 010 引入的原子操作。
        const agentName = (msg as { agentName?: string }).agentName ?? this.focused.agentName;
        if (!agentName) {
          this.reportError(null, new Error(
            'No agent to start a session with. Connect one in the Agents view first.'));
          return;
        }
        void this.sessionManager.newConversation(agentName).catch(e => this.reportError(null, e));
        return;
        // [CUSTOM-END] CUSTOM-20260924-024
      }
      case 'focusAgent': {
        const agentName = (msg as { agentName?: string }).agentName;
        if (!agentName) { return; }
        const ids = this.sessionManager.getSessionIdsForAgent(agentName);
        const next = ids[ids.length - 1];
        if (next) { this.sessionManager.focusSession(next); }
        return;
      }

      // [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的「连接」与「历史会话」。
      // 都按设计不带 sessionId（要用它们时往往根本没有聚焦会话），所以在守卫之前处理。
      case 'connectAgent': {
        this.handleConnectAgent((msg as { agentName?: string }).agentName);
        return;
      }
      case 'listHistory': {
        void this.handleListHistory((msg as { agentName?: string }).agentName);
        return;
      }
      case 'openHistorySession': {
        void this.handleOpenHistorySession(
          (msg as { agentName?: string }).agentName ?? '',
          (msg as { sessionId?: string }).sessionId ?? '',
          // [CUSTOM-20260925-057] The row carries the session's own directory;
          // see handleOpenHistorySession for why it matters.
          (msg as { cwd?: string }).cwd || undefined,
        );
        return;
      }
      // [CUSTOM-END] CUSTOM-20260925-032/033

      // [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页：同样按设计不带 sessionId
      // （草稿就是"还没有会话"），所以在守卫之前处理。
      case 'listDirectoryChoices':
        void this.handleListDirectoryChoices((msg as { agentName?: string }).agentName, from);
        return;
      case 'pickDirectory':
        void this.handlePickDirectory(from);
        return;
      case 'createDraftAndSend':
        void this.handleCreateDraftAndSend(
          (msg as { draftId?: string }).draftId ?? '',
          (msg as { agentName?: string }).agentName,
          (msg as { cwd?: string }).cwd,
          (msg as { text?: string }).text ?? '',
          from,
        );
        return;
      // [CUSTOM-END] CUSTOM-20260925-058

      // --- NOT session-scoped: must be handled BEFORE the guard below -----
      // These carry no top-level `sessionId` by design, so routing them
      // through `verifySession` dropped every one of them — which is what made
      // markdown rendering (and therefore code blocks, Copy buttons and links)
      // dead on arrival.
      case 'renderMarkdown':
        // Per-item session ids are validated inside handleRenderMarkdown.
        this.handleRenderMarkdown(
          (msg as { items: Array<{ entryId: string; sessionId: string; text: string }> }).items,
        );
        return;
      case 'copy':
        void vscode.env.clipboard.writeText((msg as { text?: string }).text ?? '');
        return;
      // [CUSTOM-20260925-029] NOT session-scoped: forward to the output channel.
      case 'clientLog': {
        const level = (msg as { level?: string }).level ?? 'info';
        const text = (msg as { message?: string }).message ?? '';
        log(`${LOG_PREFIX}: client(${level}): ${text}`);
        return;
      }
      // [CUSTOM-END] CUSTOM-20260925-029
      // [CUSTOM-20260926-077] Outline pin/width prefs: NOT session-scoped, persist
      // to globalState so they survive webview disposal (window reload / editor panel).
      case 'setUiPref': {
        const outlineMode = (msg as { outlineMode?: string }).outlineMode === 'sidebar' ? 'sidebar' : 'popup';
        const outlineWidth = Number((msg as { outlineWidth?: unknown }).outlineWidth);
        this.uiPrefs = {
          outlineMode,
          outlineWidth: Number.isFinite(outlineWidth) ? outlineWidth : 240,
        };
        this.globalState?.update(UI_PREFS_KEY, this.uiPrefs);
        return;
      }
      case 'openLink':
        void this.handleOpenLink((msg as { href?: string }).href ?? '');
        return;
      case 'executeCommand':
        log(`${LOG_PREFIX}: ignoring webview executeCommand (no allowlist yet)`);
        return;

      default:
        break;
    }

    // Everything below is session-scoped and must name a live session.
    const sessionId = verifySession(this.sessionManager, msg as { sessionId?: string });
    if (!sessionId) {
      log(`${LOG_PREFIX}: dropped ${msg.type} for unknown session ${String((msg as { sessionId?: string }).sessionId)}`);
      return;
    }

    switch (msg.type) {
      case 'sendPrompt':
        void this.handleSendPrompt(sessionId, (msg as { text?: string }).text ?? '');
        return;
      case 'cancelTurn':
        void this.sessionManager.cancelTurn(sessionId).catch(e => this.reportError(sessionId, e));
        this.refreshSessions();
        return;
      case 'closeSession': {
        const agentName = sessionOf(this.sessionManager, sessionId)?.agentName;
        if (!agentName) { return; }
        void this.sessionManager.closeSession(agentName, sessionId)
          .catch(e => this.reportError(sessionId, e));
        return;
      }
      case 'focusSession':
        this.sessionManager.focusSession(sessionId);
        return;
      case 'detachFile': {
        const path = (msg as { path?: string }).path;
        const list = (this.attachments.get(sessionId) ?? []).filter(a => a.path !== path);
        this.attachments.set(sessionId, list);
        this.post({ type: 'attachments', sessionId, attachments: list });
        return;
      }
      // [CUSTOM-20260925-049] Session-scoped: sits AFTER the guard above.
      case 'attachPath':
        this.handleAttachPaths(sessionId, (msg as { paths?: unknown }).paths);
        return;
      // [CUSTOM-END] CUSTOM-20260925-049
      case 'setMode':
        void this.sessionManager.setMode(sessionId, (msg as { modeId: string }).modeId)
          // [CUSTOM-20260926-073] Announce the switch in the transcript, not just in
          // the picker: the record is what a reader scrolls back through.
          .then(() => { this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setModel':
        void this.sessionManager.setModel(sessionId, (msg as { modelId: string }).modelId)
          .then(() => { this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setConfigOption':
        void this.sessionManager.setConfigOption(
          sessionId,
          (msg as { configId: string }).configId,
          (msg as { value: string }).value,
        )
          .then(() => { this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      // [CUSTOM-20260924-027] Session-scoped: it must sit AFTER the guard above.
      case 'needToolView': {
        this.resendToolView(
          sessionId,
          (msg as { entryId?: string }).entryId ?? '',
          (msg as { toolCallId?: string }).toolCallId ?? '',
          from,
        );
        return;
      }
      // [CUSTOM-END] CUSTOM-20260924-027
      case 'openFile':
        void this.handleOpenFile(
          sessionId,
          (msg as { path?: string }).path ?? '',
          (msg as { line?: number }).line,
        );
        return;
      case 'openTerminal':
        this.handleOpenTerminal(sessionId, (msg as { terminalId?: string }).terminalId ?? '');
        return;
      // [CUSTOM-20260924-020] Session-scoped: it must sit AFTER the guard above.
      case 'permissionAnswer': {
        const promptId = (msg as { promptId?: string }).promptId;
        if (promptId) {
          this.permissionBridge?.answer(promptId, (msg as { optionId?: string }).optionId);
        }
        return;
      }
      // [CUSTOM-END] CUSTOM-20260924-020
      default:
        break;
    }
  }

  dispose(): void {
    // [CUSTOM-20260925-041] Unregister first: an update arriving while the
    // rest of this method runs would otherwise index into state that is being
    // torn down.
    this.sessionUpdateHandler.removeListener(this.updateListener);
    this.outbox.dispose();
    for (const d of this.subscriptions) { d.dispose(); }
    this.subscriptions.length = 0;
    this.surfaces.clear();
    this.lastActive = null;
    this.unread.clear();
    // setPresenter(null) also cancels every prompt still awaiting an answer:
    // nothing can render or answer them once the host is gone.
    this.permissionBridge?.setPresenter(null);
  }

  // --- Prompt handling -----------------------------------------------------

  private async handleSendPrompt(sessionId: string, text: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }

    const attachments = this.attachments.get(sessionId) ?? [];

    // The transcript is the panel's own record; the extension-side store keeps
    // it so the bubble survives a panel switch.
    this.transcripts.ensureSession(sessionId, session.agentName);
    // A new user turn ends any prose the agent was still streaming.
    this.finalizeEntries(sessionId, { only: 'assistant' });
    const userEntry = this.transcripts.appendUser(sessionId, text);
    if (userEntry) { this.post({ type: 'append', sessionId, entries: [userEntry] }); }

    this.sessionManager.recordFirstPrompt(sessionId, text);
    this.attachments.set(sessionId, []);
    this.post({ type: 'attachments', sessionId, attachments: [] });

    const blocks: ContentBlock[] = [{ type: 'text', text }];
    for (const a of attachments) {
      // ACP `ResourceLink.uri` is a plain string (file:// URI per convention).
      blocks.push({ type: 'resource_link', uri: fileUri(a.path).toString(), name: a.name });
    }

    try {
      // Start the turn and only THEN refresh: `sendPrompt` registers the
      // in-flight turn synchronously before its first await, so refreshing
      // beforehand would always report `running: false` (no Stop button).
      const pending = this.sessionManager.sendPrompt(sessionId, blocks);
      this.finalizeEntries(sessionId, { only: 'thought' });
      this.refreshSessions();
      this.pushMeta(sessionId);

      const response = await pending;
      this.applyStopReason(sessionId, response.stopReason);
      this.applyResponseUsage(sessionId, (response as { usage?: unknown }).usage);
    } catch (e: any) {
      this.reportError(sessionId, e);
    } finally {
      this.finalizeTurn(sessionId);
    }
  }

  /**
   * Surface a non-normal turn ending. The ACP spec is explicit that a
   * `refusal` turn's content is excluded from the next prompt, so the UI must
   * show it rather than ending silently.
   */
  private applyStopReason(sessionId: string, stopReason: string | undefined): void {
    if (!stopReason || stopReason === 'end_turn' || stopReason === 'cancelled') { return; }
    const message = stopReason === 'refusal'
      ? 'The agent refused to continue. This turn will not be included in the next prompt.'
      : stopReason === 'max_tokens'
        ? 'The turn was cut short by the token limit.'
        : stopReason === 'max_turn_requests'
          ? 'The turn was cut short by the agent-request limit.'
          : `Turn ended with reason: ${stopReason}`;
    const entry = this.transcripts.appendNotice(sessionId, 'warn', message);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  /**
   * Fold `PromptResponse.usage` into the token bar. Not every agent emits
   * `usage_update`, so without this the bar stays hidden for them.
   * The two shapes differ: the response reports absolute token counts, the
   * notification reports `used`/`size` of the context window.
   */
  private applyResponseUsage(sessionId: string, usage: unknown): void {
    if (!usage || typeof usage !== 'object') { return; }
    const u = usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number };
    const used = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
    if (used === undefined) { return; }
    const previous = this.usage.get(sessionId);
    this.usage.set(sessionId, {
      used,
      // The response carries no context-window size; keep the last known one.
      size: previous?.size ?? 0,
      costAmount: previous?.costAmount,
      costCurrency: previous?.costCurrency,
    });
    this.pushMeta(sessionId);
  }

  // --- Switch notices (CUSTOM-20260926-073) --------------------------------

  /** The session's switchable state right now, or null when it has no session. */
  private choiceState(sessionId: string): ChoiceSnapshot | null {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return null; }
    return choiceSnapshotFromState(session.modes, session.configOptions);
  }

  /**
   * Diff a session's switchable state against the cached snapshot and announce
   * whatever moved (model / mode / any other config option).
   *
   * The FIRST snapshot of a session is a BASELINE, not a change: opening a session
   * must not print "Switched to <the model it already had>". That also covers the
   * two racing reporters of the same change — whichever arrives first announces,
   * the second diffs to nothing.
   *
   * `next` lets a caller pass a state built from a NOTIFICATION payload (see
   * onSessionUpdate); omitted, the state is read from SessionManager.
   */
  private syncChoices(sessionId: string, next?: ChoiceSnapshot | null): void {
    const state = next === undefined ? this.choiceState(sessionId) : next;
    if (!state) { return; }
    const previous = this.choices.get(sessionId);
    this.choices.set(sessionId, state);
    if (!previous) { return; }
    const labels = choiceChanges(previous, state);
    if (labels.length === 0) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'switch', labels.join(' · '));
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  /**
   * [CUSTOM-20260926-075] Announce a RENAME — not a title being assigned for the
   * first time. The first `session_info_update` of a session is normally the
   * auto-generated title ("Fix the parser bug"), and printing a line for it would
   * add noise to every single session. So the baseline is seeded from the title the
   * session already had, and only a later, different title is announced.
   */
  private announceRename(sessionId: string, title: string): void {
    const previous = this.sessionTitles.get(sessionId) ?? '';
    this.sessionTitles.set(sessionId, title);
    if (!title || !previous || title === previous) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'info', `Session renamed to “${title}”`);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  /**
   * Close streaming entries and tell the webview, so its copy of the entry
   * learns `streaming: false` (and, for thoughts, the elapsed time).
   */
  private finalizeEntries(sessionId: string, opts: { only?: 'assistant' | 'thought' } = {}): void {
    for (const entryId of this.transcripts.finalizeStreaming(sessionId, opts)) {
      const entry = this.transcripts.getEntry(sessionId, entryId);
      if (!entry) { continue; }
      this.post({
        type: 'revise',
        sessionId,
        entryId,
        patch: { streaming: false, elapsedMs: (entry as { elapsedMs?: number }).elapsedMs },
      });
    }
  }

  /** Close streaming entries and ask the webview to render markdown. */
  private finalizeTurn(sessionId: string): void {
    this.finalizeEntries(sessionId);
    this.sessionManager.touchHistory(sessionId);
    this.refreshSessions();
    this.pushTurnState(sessionId);
    // [CUSTOM-20260924-022] Batching health check: a high merged/queued ratio
    // means the coalescing is doing its job; if `queued` stays large at turn
    // end something is bypassing the outbox.
    // [CUSTOM-20260925-041] Per-turn, not cumulative (see Outbox.resetStats).
    // `queued` here is normally 0-2 (the frame still in flight); a value that
    // stays large across turns is the real signal.
    const stats = this.outbox.stats();
    log(`${LOG_PREFIX}: outbox sent=${stats.sent} merged=${stats.merged} queued=${stats.queued}`);
    this.outbox.resetStats();
  }

  // --- Session update → transcript ----------------------------------------

  private onSessionUpdate(update: SessionNotification): void {
    const sessionId = update.sessionId;
    const data = update.update as any;
    const session = sessionOf(this.sessionManager, sessionId);
    if (!data || !session) { return; }

    this.transcripts.ensureSession(sessionId, session.agentName);

    // [CUSTOM-20260926-073] Take the switch baseline here, at the top, because this
    // runs for every update of every session regardless of whether a surface is
    // attached — so a baseline exists before any switch can be reported.
    if (!this.choices.has(sessionId)) { this.syncChoices(sessionId); }
    // [CUSTOM-20260926-075] ...and the rename baseline, for the same reason.
    if (!this.sessionTitles.has(sessionId)) { this.sessionTitles.set(sessionId, session.title ?? ''); }

    switch (data.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(data.content);
        if (text.length === 0) {
          this.postContentNotice(sessionId, data.content);
          return;
        }
        // Close ONLY the thought block: prose beginning means the reasoning is
        // done. Closing the assistant entry here too was the bug that turned
        // one reply into one bubble per chunk.
        this.finalizeEntries(sessionId, { only: 'thought' });
        const entry = this.transcripts.appendAssistantChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
        // A chunk means a turn is in flight even if we did not start it.
        this.refreshSessions();
        return;
      }

      case 'agent_thought_chunk': {
        const text = textOf(data.content);
        if (text.length === 0) {
          // [CUSTOM-20260926-075] Non-text content inside a THOUGHT chunk (an image
          // the agent pasted into its reasoning, a resource link) used to be dropped
          // on the floor. It becomes a content record like any other.
          //
          // The thought is closed first, and that is not cosmetic: entries only
          // merge into the LAST one, so a thought left open here would be stranded
          // with a permanent "Thinking…" spinner while the next thought chunk opens
          // a second block.
          this.finalizeEntries(sessionId, { only: 'thought' });
          this.postContentNotice(sessionId, data.content);
          return;
        }
        const entry = this.transcripts.appendThoughtChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
        return;
      }

      case 'user_message_chunk': {
        // Replay path (`session/load`).
        const text = textOf(data.content);
        if (text.length === 0) { return; }
        // [CUSTOM-20260925-053] A user chunk IS a turn boundary, so it must
        // close any assistant prose still marked as streaming. Nothing else
        // does it on the replay path: `finalizeTurn` only runs for a prompt we
        // sent, and the tool_call branch only fires when a tool follows. An
        // entry left `streaming: true` forever keeps the client's copy in the
        // streaming state — which among other things pins `aria-busy` to true
        // (CUSTOM-20260925-048) and silently mutes the screen reader for the
        // rest of the session. The legacy panel finalizes the pending assistant
        // turn here too ("finalizes pending assistant turn", its
        // user_message_chunk branch).
        this.finalizeEntries(sessionId, { only: 'assistant' });
        const entry = this.transcripts.appendUser(sessionId, text);
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
        return;
      }

      case 'tool_call': {
        // Prose that continues after a tool call belongs in a new bubble, so
        // the transcript reads text → tool → text. (Only the assistant entry:
        // the thought block was already closed by the first prose chunk.)
        this.finalizeEntries(sessionId, { only: 'assistant' });
        const inv = this.tools.upsertCall(sessionId, data);
        const entry = this.transcripts.appendTool(sessionId, inv.toolCallId);
        if (entry) {
          this.toolEntryIds.set(toolKey(sessionId, inv.toolCallId), entry.id);
          // Nesting must run BEFORE rendering this card so it carries its
          // parent link on first paint.
          const changed = this.applyNesting(sessionId, session.agentName);
          this.post({ type: 'append', sessionId, entries: [{ ...entry, toolView: toToolCallView(inv) }] });
          this.pushNestingUpdates(sessionId, changed, inv.toolCallId);
        }
        return;
      }

      case 'tool_call_update': {
        const inv = this.tools.upsertUpdate(sessionId, data);
        if (!inv) { return; }
        // A Task's output often arrives only at the END of the call, which is
        // when an explicit parent link becomes discoverable — so re-run the
        // strategy on every update, not just on first sight.
        const changed = this.applyNesting(sessionId, session.agentName);
        const entryId = this.toolEntryIds.get(toolKey(sessionId, inv.toolCallId));
        if (entryId) {
          this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) });
        }
        this.pushNestingUpdates(sessionId, changed, inv.toolCallId);
        return;
      }

      case 'plan': {
        // ACP replaces the whole plan on every update, so consecutive
        // notifications must update ONE card rather than stack up.
        const previousId = this.planEntryIds.get(sessionId);
        const existing = previousId ? this.transcripts.getEntry(sessionId, previousId) : undefined;
        if (existing && existing.kind === 'plan') {
          existing.entries = data.entries ?? [];
          // [CUSTOM-20260925-038] 键名是 `entries`（= 记录字段名），不是 `plan`。
          // 曾用 `plan` 导致客户端的 patch 写进 entry.plan 而渲染读 entry.entries，
          // 于是 Todo 列表永远停在第一次快照且没有任何报错。
          this.post({ type: 'revise', sessionId, entryId: existing.id, patch: { entries: existing.entries } });
          return;
        }
        const entry = this.transcripts.appendPlan(sessionId, data.entries ?? []);
        if (entry) {
          this.planEntryIds.set(sessionId, entry.id);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        return;
      }

      case 'usage_update': {
        this.usage.set(sessionId, {
          used: Number(data.used ?? 0),
          size: Number(data.size ?? 0),
          costAmount: data.cost?.amount,
          costCurrency: data.cost?.currency,
        });
        this.pushMeta(sessionId);
        return;
      }

      default: {
        // available_commands_update / config_option_update / current_mode_update /
        // session_info_update are handled by SessionManager + the legacy provider's
        // listener; the host only needs to re-read state after they land.
        if (data.sessionUpdate === 'available_commands_update'
          || data.sessionUpdate === 'config_option_update'
          || data.sessionUpdate === 'current_mode_update'
          || data.sessionUpdate === 'session_info_update') {
          this.pushMeta(sessionId);
          this.refreshSessions();
        }
        // [CUSTOM-20260926-075] A rename notice does not depend on the switch
        // baseline, so it is handled before the guard below.
        if (data.sessionUpdate === 'session_info_update') {
          this.announceRename(sessionId, typeof data.title === 'string' ? data.title : '');
        }
        // [CUSTOM-20260926-073] A switch the agent pushed (or that another surface
        // triggered). The PAYLOAD is used rather than SessionManager's copy: our
        // listener may run before SessionManager's, in which case its state is still
        // the old one and the diff would come out empty. If our own setter already
        // reported this change, the diff here is empty and nothing prints twice.
        const previous = this.choices.get(sessionId);
        if (!previous) { return; }
        if (data.sessionUpdate === 'config_option_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { configOptions: data.configOptions }));
        } else if (data.sessionUpdate === 'current_mode_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { modeId: data.currentModeId }));
        }
        return;
      }
    }
  }

  /**
   * Non-text content in a message chunk becomes a real transcript entry so the
   * webview renders it (image inline, resource as a chip, …) instead of a
   * `[image content]` placeholder.
   *
   * [CUSTOM-20260924-026] An **empty text block** reaches here whenever the
   * agent uses one as a chunk separator (`textOf` returns '' so the caller
   * treats it as non-text). `toContentView` maps it to a perfectly valid
   * `{type:'text', text:''}` view, and rendering that produced a blank strip in
   * the transcript — that was the source of the "empty bars" between real
   * blocks. A block nobody can see is not content: drop it.
   */
  private postContentNotice(sessionId: string, block: unknown): void {
    const view = toContentView(block as ContentBlock | null);
    if (!hasVisibleContent(view)) { return; }
    const entry = this.transcripts.appendContent(sessionId, [view!]);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Sub-agent nesting ---------------------------------------------------

  /**
   * Recompute parent links for a session's tool calls.
   *
   * ACP has no nesting concept, so this is inference — see `nesting/`. The
   * strategy is per-agent and the default is a no-op, which is why the flat
   * list is the guaranteed-correct baseline rather than a fallback branch.
   */
  private applyNesting(sessionId: string, agentName: string): string[] {
    const strategy = resolveNestingStrategy(agentName);
    return strategy.apply(this.tools.list(sessionId));
  }

  /** Push fresh views for cards whose nesting changed since they were sent. */
  private pushNestingUpdates(sessionId: string, changed: readonly string[], skip?: string): void {
    for (const toolCallId of changed) {
      if (toolCallId === skip) { continue; }
      const inv = this.tools.get(sessionId, toolCallId);
      const entryId = this.toolEntryIds.get(toolKey(sessionId, toolCallId));
      if (!inv || !entryId) { continue; }
      this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) });
    }
  }

  // --- Markdown round-trip -------------------------------------------------

  private handleRenderMarkdown(items: Array<{ entryId: string; sessionId: string; text: string; key?: string }>): void {
    const rendered: Array<{ entryId: string; sessionId: string; html: string; key?: string }> = [];
    for (const item of items) {
      const sessionId = verifySession(this.sessionManager, item);
      if (!sessionId) { continue; }
      const html = this.markdown.render(item.text);
      // [CUSTOM-20260925-066] A KEYED item is a sub-block of a tool card, not a
      // transcript record: there is nothing in the store to patch, the HTML goes
      // back to the element that asked for it. Skipping the patch also avoids a
      // pointless lookup for an id that can never be found.
      if (!item.key) { this.transcripts.patch(sessionId, item.entryId, { html }); }
      rendered.push({ entryId: item.entryId, sessionId, html, key: item.key });
    }
    if (rendered.length > 0) {
      this.post({ type: 'markdownRendered', items: rendered });
    }
  }

  // --- Links / files -------------------------------------------------------

  private async handleOpenLink(href: string): Promise<void> {
    // Scheme allowlist. `command:` would turn agent output into IDE command
    // execution; javascript:/data:/file: are equally unacceptable here.
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (parsed.scheme !== 'http' && parsed.scheme !== 'https' && parsed.scheme !== 'mailto') {
      void vscode.window.showWarningMessage(`Blocked link with unsupported scheme: ${parsed.scheme}`);
      return;
    }
    await vscode.env.openExternal(parsed);
  }

  private async handleOpenFile(sessionId: string, rawPath: string, line?: number): Promise<void> {
    if (!rawPath) { return; }
    // [CUSTOM-20260925-039] Resolve relative paths against the session that OWNS
    // the chip rather than whatever happens to be focused. The `verifySession`
    // guard already validated this id, so there is one source of truth for the
    // working directory (previously this read `this.focused.sessionId`, which
    // was equivalent only because the client filters by the focused session).
    const session = sessionOf(this.sessionManager, sessionId);
    const uri = fileUri(rawPath, session?.cwd);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (e: any) {
      void vscode.window.showWarningMessage(`Could not open ${rawPath}: ${e?.message ?? e}`);
    }
  }

  /**
   * Show a tool call's terminal output.
   *
   * ACP's `Terminal` tool-content is only a *reference* (`{terminalId}`) — the
   * client owns the terminal and must render it. Until now the chip was a dead
   * control because there was no path to the handler at all.
   */
  private handleOpenTerminal(sessionId: string, terminalId: string): void {
    if (!terminalId) { return; }
    const handlers = this.sessionManager.getConnectionForSession(sessionId)?.terminals;
    const snapshot = handlers?.readOutput(terminalId) ?? null;
    if (!snapshot) {
      this.reportError(sessionId, new Error(`Terminal ${terminalId} is no longer available.`));
      return;
    }
    const status = snapshot.exited
      ? `exited: ${snapshot.exitCode ?? 'signal ' + (snapshot.exitSignal ?? 'unknown')}`
      : 'still running';
    const text = [
      `$ terminal ${terminalId} (${status})${snapshot.truncated ? ' — output truncated' : ''}`,
      '',
      snapshot.output || '(no output yet)',
    ].join('\n');
    const entry = this.transcripts.appendContent(sessionId, [{ type: 'text', text }]);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Permission presenter (CUSTOM-20260924-020) --------------------------

  /**
   * Can this prompt be answered on a card the user will actually see?
   *
   * Three conditions, all required: the prompt belongs to the focused session
   * (a card for another session would be filtered out client-side and the
   * agent would wait on an invisible button), the agent is a modern-panel one
   * (legacy sessions have no transcript here), and some surface exists. A
   * hidden surface is raised — without stealing focus — because the agent is
   * blocked until this is answered.
   */
  canPresent(sessionId: string): boolean {
    if (this.focused.sessionId !== sessionId) { return false; }
    if (!isModernAgent(this.focused.agentName)) { return false; }
    const surface = this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
    if (!surface) { return false; }
    if (!surface.visible) { surface.reveal(true); }
    return true;
  }

  show(state: PermissionState): void {
    const session = sessionOf(this.sessionManager, state.sessionId);
    if (!session) { return; }
    this.transcripts.ensureSession(state.sessionId, session.agentName);
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (entry) { this.post({ type: 'append', sessionId: state.sessionId, entries: [entry] }); }
  }

  update(state: PermissionState): void {
    // appendPermission returns the existing entry for this promptId (after
    // applying the new state), so `patch` below only needs to tell the webview.
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (!entry) { return; }
    this.post({ type: 'revise', sessionId: state.sessionId, entryId: entry.id, patch: { permission: state } });
  }

  // --- Tool views (CUSTOM-20260924-027) ------------------------------------

  /**
   * The client reported a tool card with no view model.
   *
   * This is the recovery path for a card that was placed before its view model
   * existed (a bare `.tool` shell that `updateTool` used to be unable to repair).
   * If the invocation is genuinely gone there is nothing to send — but the log
   * line is the answer to "why is this card empty", which used to be invisible
   * (it only produced a `console.warn` inside the webview console).
   */
  private resendToolView(sessionId: string, entryId: string, toolCallId: string, to: SurfaceKey): void {
    const inv = toolCallId ? this.tools.get(sessionId, toolCallId) : undefined;
    if (!inv) {
      log(`${LOG_PREFIX}: client asked for the view of tool ${toolCallId || '(no id)'} in ${sessionId} but the invocation is not in the store (entry ${entryId})`);
      return;
    }
    log(`${LOG_PREFIX}: resending view for tool ${toolCallId} (client had none for entry ${entryId})`);
    // Targeted at the surface that asked: the other one already has it, and an
    // unnecessary toolUpdate would be a visual no-op anyway.
    this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) }, to);
  }

  // --- Panel entry points: connect + history (CUSTOM-20260925-032/033) ------

  /** Falls back to the panel's own agent when nothing is focused. */
  private panelAgent(preferred?: string): string | null {
    if (preferred) { return preferred; }
    if (this.focused.agentName) { return this.focused.agentName; }
    for (const agentName of MODERN_AGENTS) { return agentName; }
    return null;
  }

  /** Workspace folder used to scope the local history cache, when there is one. */
  private workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * [CUSTOM-20260925-032] "Connect" button.
   *
   * [CUSTOM-20260925-058] Now means "make sure the process is up, then hand back
   * to the client": the client opens a DRAFT, and the session is created on the
   * first message. Creating one here (as `connectToAgent` does when none exists)
   * would leave an empty session in the agent's history for a user who only
   * wanted to check that the agent starts — and `session/close` does not remove
   * it again. The connectivity feedback the button exists for is preserved
   * because `ensureConnected` still throws when the process will not start.
   *
   * If sessions already exist, the newest is focused (reuse, not pile up).
   */
  private handleConnectAgent(agentName?: string): void {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      this.reportError(null, new Error('No agent available to connect.'));
      return;
    }
    log(`${LOG_PREFIX}: connect requested for ${agent}`);
    void this.sessionManager.ensureConnected(agent)
      .then(() => {
        const ids = this.sessionManager.getSessionIdsForAgent(agent);
        const newest = ids[ids.length - 1];
        if (newest) { this.sessionManager.focusSession(newest); }
        // No session to focus: the client's draft page is the right place to be.
      })
      .catch(e => this.reportError(null, e));
  }

  /**
   * [CUSTOM-20260925-033] History picker contents for one agent.
   *
   * Source order matters: **the local cache first when the agent is not
   * connected**, because `sessionManager.listSessions` calls `ensureConnected`
   * and would spawn an agent process just to render a menu. Once it IS connected
   * the agent-side list wins: it is authoritative and includes sessions this
   * window never saw.
   */
  private async handleListHistory(agentName?: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      this.post({ type: 'history', agentName: '', sessions: [], source: 'local', error: 'No agent selected.' });
      return;
    }

    const connected = this.sessionManager.isAgentConnected(agent);
    const caps = this.sessionManager.getCachedCapabilities(agent);
    const local = () => {
      const entries = this.sessionManager.getHistoryStore()?.list(agent, this.workspaceCwd()) ?? [];
      const live = new Set(this.sessionManager.getSessionIdsForAgent(agent));
      return {
        source: 'local' as const,
        sessions: entries
          // Live sessions are already tabs; the picker is for the other ones.
          .filter(e => !live.has(e.sessionId))
          .map(e => ({
            sessionId: e.sessionId,
            title: e.title ?? e.firstPrompt ?? null,
            cwd: e.cwd,
            updatedAt: e.lastActiveAt,
          })),
      };
    };

    try {
      if (connected && caps?.list) {
        const response = await this.sessionManager.listSessions(agent);
        const live = new Set(this.sessionManager.getSessionIdsForAgent(agent));
        this.post({
          type: 'history',
          agentName: agent,
          source: 'agent',
          sessions: response.sessions
            .filter(s => !live.has(String((s as { sessionId?: unknown }).sessionId ?? '')))
            .map(s => {
              const info = s as { sessionId?: unknown; title?: unknown; cwd?: unknown; updatedAt?: unknown };
              return {
                sessionId: String(info.sessionId ?? ''),
                title: typeof info.title === 'string' ? info.title : null,
                cwd: typeof info.cwd === 'string' ? info.cwd : undefined,
                updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : undefined,
              };
            }),
        });
        return;
      }
      const fallback = local();
      this.post({ type: 'history', agentName: agent, ...fallback });
    } catch (e: any) {
      // An agent-side failure still has the cache as a usable answer.
      const fallback = local();
      this.post({
        type: 'history',
        agentName: agent,
        ...fallback,
        error: `Could not query the agent (${e?.message ?? e}); showing the local cache.`,
      });
    }
  }

  /** [CUSTOM-20260925-033] Open a session from the picker (load, else resume). */
  private async handleOpenHistorySession(agentName: string, sessionId: string, cwd?: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent || !sessionId) { return; }
    log(`${LOG_PREFIX}: opening history session ${sessionId} of ${agent}${cwd ? ` (cwd ${cwd})` : ''}`);
    try {
      // [CUSTOM-20260925-057] Pass the session's OWN directory. The picker shows
      // sessions from other directories (the agent-side list spans them), and
      // without this the agent was told the current workspace instead — so a
      // session belonging elsewhere was reopened as if it lived here.
      const how = await this.sessionManager.openExistingSession(agent, sessionId, { cwd });
      if (how === 'resume') {
        const entry = this.transcripts.appendNotice(sessionId, 'info',
          'Resumed without replaying history (this agent does not support session/load).');
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
      }
    } catch (e) {
      this.reportError(null, e);
    }
  }

  // --- Draft page: directory choices + create-on-first-send (058) ----------

  /** How many recent directories the picker offers (keeps the drawer scannable). */
  private static readonly MAX_RECENT_DIRECTORIES = 8;

  /**
   * [CUSTOM-20260925-058] Candidate directories for the draft page.
   *
   * Targeted at the asking surface: it is that document's draft being edited.
   */
  private async handleListDirectoryChoices(agentName: string | undefined, to: SurfaceKey): Promise<void> {
    const agent = this.panelAgent(agentName);
    this.post({
      type: 'directoryChoices',
      agentName: agent,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      recent: await this.recentDirectories(agent),
      defaultCwd: this.sessionManager.resolveDefaultCwd(),
    }, to);
  }

  /**
   * Directories this agent has used, most recent first.
   *
   * Two sources, merged: the local history cache (durable, but `workspaceState`
   * scoped — a fresh workspace knows nothing) and the AGENT's own
   * `session/list`, which spans directories (it is what the "open previous
   * session" picker shows). The agent side needs a live connection and the
   * `list` capability, so it is only consulted when both are present — a
   * directory list is never worth spawning a process for.
   */
  private async recentDirectories(agent: string | null): Promise<string[]> {
    if (!agent) { return []; }
    const merged: string[] = [];
    const push = (candidate: unknown): void => {
      if (typeof candidate !== 'string' || candidate.length === 0) { return; }
      if (merged.includes(candidate)) { return; }
      if (merged.length >= ChatPanelHost.MAX_RECENT_DIRECTORIES) { return; }
      merged.push(candidate);
    };

    for (const cwd of this.sessionManager.getHistoryStore()?.recentDirectories(agent) ?? []) {
      push(cwd);
    }
    if (this.sessionManager.isAgentConnected(agent)
      && this.sessionManager.getCachedCapabilities(agent)?.list) {
      try {
        const response = await this.sessionManager.listSessions(agent);
        for (const session of response.sessions) {
          push((session as { cwd?: unknown }).cwd);
        }
      } catch (e) {
        // A failed agent query is not worth failing the picker over: the local
        // cache is still a usable answer.
        log(`${LOG_PREFIX}: directory choices: agent list failed (${String(e)})`);
      }
    }
    return merged;
  }

  /** Native folder picker — the webview cannot open one itself. */
  private async handlePickDirectory(to: SurfaceKey): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this directory',
      defaultUri: vscode.Uri.file(this.sessionManager.resolveDefaultCwd()),
    });
    this.post({ type: 'directoryPicked', path: picked?.[0]?.fsPath ?? null }, to);
  }

  /**
   * [CUSTOM-20260925-058] The draft's first message: create the session **with
   * the chosen directory**, then send.
   *
   * This is the whole point of the draft page. Creating the session earlier (on
   * `+`) and recreating it when the directory changes would be simpler code, but
   * `session/close` does NOT remove a session from the agent's history — so every
   * directory change would leave another empty session behind (my own two
   * capture sessions are visible in that list as evidence).
   *
   * On failure the draft is left alone: the client keeps the tab AND the typed
   * text, and shows the message.
   */
  private async handleCreateDraftAndSend(
    draftId: string,
    agentName: string | undefined,
    cwd: string | undefined,
    text: string,
    to: SurfaceKey,
  ): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      this.post({ type: 'draftFailed', draftId, message: 'No agent to start a session with.' }, to);
      return;
    }
    if (text.trim().length === 0) {
      this.post({ type: 'draftFailed', draftId, message: 'Nothing to send.' }, to);
      return;
    }
    const target = cwd?.trim() || this.sessionManager.resolveDefaultCwd();
    log(`${LOG_PREFIX}: draft ${draftId}: creating a session for ${agent} in ${target}`);

    try {
      const session = await this.sessionManager.createSession(agent, { cwd: target, focus: true });
      // Resolve the draft BEFORE starting the turn: `handleSendPrompt` awaits the
      // whole turn (it is what carries the stop reason back), and the client must
      // be able to swap its draft tab for the real one immediately.
      this.post({ type: 'draftResolved', draftId, sessionId: session.sessionId }, to);
      void this.handleSendPrompt(session.sessionId, text)
        .catch(e => this.reportError(session.sessionId, e));
    } catch (e: any) {
      this.post({ type: 'draftFailed', draftId, message: e?.message ?? String(e) }, to);
    }
  }

  // --- Outbound messages ---------------------------------------------------

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 单目标 → 广播（可定向）。
  // 两个面同时存在时，除 `boot` 外的一切都必须两端一致：客户端本来就按
  // `currentSessionId` 过滤，所以广播既安全又是让两侧保持同步的最简做法。
  //
  // [CUSTOM-20260924-022] 这里同时是**合帧队列的入口**：按消息类型决定走
  // 「攒一帧再发」（可按条目合并）还是「立即发」（结构性）。路由表放在这一处，
  // 而不是散在每个调用点——漏改一个调用点就会静默破坏 INV-A（revise 越过 append）
  // 或 INV-C（sessionsChanged 被延迟，Send/Stop 按钮状态错）。
  private post(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    const type = (message as { type?: string }).type ?? '';
    // [CUSTOM-20260925-063] One choke point for "a session produced output": every
    // transcript-bearing message goes through here, so the unread marker cannot be
    // remembered on some append paths and forgotten on others (which is what a
    // per-call-site approach would eventually do).
    if (type === 'append' || type === 'revise' || type === 'toolUpdate') {
      const sessionId = (message as { sessionId?: string }).sessionId;
      if (sessionId && this.focused.sessionId !== sessionId && !this.unread.has(sessionId)) {
        this.unread.add(sessionId);
        // Tell the strip immediately. Without this the dot could wait for the next
        // unrelated refresh — some append paths (a notice, terminal output) never
        // call refreshSessions themselves.
        this.refreshSessions();
      }
    }
    if (!to && !STRUCTURAL_MESSAGE_TYPES.has(type)) {
      this.outbox.enqueue(message as ExtToChatMessage);
      return;
    }
    this.postNow(message, to);
  }

  /** Broadcast (or target) immediately, bypassing the coalescing queue. */
  private postNow(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    if (to) {
      const only = this.surfaces.get(to);
      if (only) { this.send(only, message); }
      return;
    }
    for (const surface of this.surfaces.values()) { this.send(surface, message); }
  }

  private send(surface: ChatSurface, message: ExtToChat | MarkdownRendered): void {
    // Watch the returned promise: a payload that fails structured clone rejects,
    // and a bare `void` would swallow that. Silent send failures are exactly
    // what makes "the UI just shows nothing" impossible to diagnose.
    const sent = surface.webview.postMessage(message);
    void sent?.then(undefined, (e: unknown) => {
      log(`${LOG_PREFIX}: postMessage failed for "${(message as { type?: string }).type}" on "${surface.key}": ${String(e)}`);
    });
  }
  // [CUSTOM-END] CUSTOM-20260924-019

  private pushBoot(to?: SurfaceKey): void {
    if (this.attachedCount === 0) { return; }
    // INV-E: the snapshot must not overtake anything still sitting in the queue.
    this.outbox.flush();
    this.refreshLiveSessionIds();
    const sessions = this.buildSummaries();
    const focused = this.focused.sessionId ? this.buildSummary(this.focused.sessionId) : null;
    this.post({
      type: 'boot',
      focused,
      sessions,
      snapshot: focused ? this.snapshotOf(focused.sessionId) : null,
      meta: focused ? this.metaOf(focused.sessionId) : null,
    }, to);
    // [CUSTOM-20260926-077] Bring the outline pin/width prefs along with the boot,
    // so a recreated webview (editor panel reopen / window reload) restores them.
    if (this.uiPrefs) {
      this.post({ type: 'uiPrefs', ...this.uiPrefs }, to);
    }
  }

  private pushFocus(): void {
    if (this.attachedCount === 0) { return; }
    this.outbox.flush();
    const sessionId = this.focused.sessionId;
    const summary = sessionId ? this.buildSummary(sessionId) : null;
    this.post({
      type: 'focus',
      summary,
      snapshot: summary ? this.snapshotOf(sessionId!) : null,
      meta: summary ? this.metaOf(sessionId!) : null,
    });
  }

  private pushMeta(sessionId: string): void {
    if (this.attachedCount === 0) { return; }
    if (this.focused.sessionId !== sessionId) { return; }
    this.post({ type: 'meta', sessionId, meta: this.metaOf(sessionId) });
  }

  private pushTurnState(sessionId: string): void {
    this.refreshSessions();
    this.pushMeta(sessionId);
  }

  private refreshSessions(): void {
    if (this.attachedCount === 0) { return; }
    this.refreshLiveSessionIds();
    const sessions = this.buildSummaries();
    // [CUSTOM-20260924-022] This runs on EVERY agent message chunk, so without
    // the signature check each streamed token rebuilt the whole tab strip and
    // agent dropdown on the client. Skipping the no-op case is also what keeps
    // `flushThenPost` from flushing the coalescing queue on every chunk.
    const signature = sessions
      .map(s => `${s.sessionId}|${s.agentName}|${s.title ?? ''}|${s.loading ? 1 : 0}|${s.running ? 1 : 0}|${s.unread ? 1 : 0}`)
      .join('\n');
    if (signature === this.lastSessionsSignature) { return; }
    this.lastSessionsSignature = signature;
    this.outbox.flushThenPost({ type: 'sessionsChanged', sessions });
  }

  // --- State assembly ------------------------------------------------------

  private refreshLiveSessionIds(): void {
    this.transcripts.setLiveSessionIds(this.sessionManager.getLiveSessions().map(s => s.sessionId));
  }

  private buildSummaries(): SessionSummary[] {
    return this.sessionManager.getLiveSessions().map(s => this.toSummary(s));
  }

  private buildSummary(sessionId: string): SessionSummary | null {
    const session = sessionOf(this.sessionManager, sessionId);
    return session ? this.toSummary(session) : null;
  }

  private toSummary(session: SessionInfo): SessionSummary {
    const stored = this.sessionManager.getHistoryStore()?.get(session.agentName, session.sessionId);
    return {
      sessionId: session.sessionId,
      agentName: session.agentName,
      title: session.title ?? stored?.firstPrompt ?? null,
      cwd: session.cwd,
      createdAt: session.createdAt,
      loading: this.sessionManager.isLoading(session.sessionId),
      running: this.sessionManager.isTurnInFlight(session.sessionId),
      // [CUSTOM-20260925-063] Drives the tab-strip "attention" dot. NOTE:
      // refreshSessions()'s signature string must include it too, or the strip
      // would never be told this changed (022's signature de-dup trap).
      unread: this.unread.has(session.sessionId),
    };
  }

  /**
   * Snapshot for the webview. Tool entries are hydrated with their view model
   * here — the raw entry only knows a `toolCallId`, so without this step a
   * session switch (or a panel re-attach) renders an empty tool card that a
   * later `tool_call_update` cannot repair.
   */
  private snapshotOf(sessionId: string): TranscriptSnapshotWire | null {
    const snapshot = this.transcripts.snapshot(sessionId);
    if (!snapshot) { return null; }
    return {
      sessionId: snapshot.sessionId,
      agentName: snapshot.agentName,
      entries: snapshot.entries.map(entry => {
        if (entry.kind !== 'tool') { return entry; }
        const inv = this.tools.get(sessionId, entry.toolCallId);
        if (!inv) {
          // NOT temporary (the earlier label said otherwise): a tool entry whose
          // invocation cannot be found is sent WITHOUT a view model, so the client
          // renders it as an empty shell — and this log line is the only place
          // that says WHY. 027's lesson was that the reason must be visible in the
          // output channel rather than in a webview console nobody opens, and it
          // costs one line only when the invocation is genuinely gone.
          log(`${LOG_PREFIX}: snapshot missing invocation ${entry.toolCallId} in ${sessionId}`);
          return entry;
        }
        return { ...entry, toolView: toToolCallView(inv) };
      }),
    };
  }

  private metaOf(sessionId: string): SessionMeta {
    const session = sessionOf(this.sessionManager, sessionId);
    return {
      sessionId,
      modes: session?.modes ?? null,
      models: session?.models ?? null,
      configOptions: session?.configOptions ?? null,
      availableCommands: (session?.availableCommands ?? []).map(c => ({
        name: c.name,
        description: c.description,
        inputHint: (c.input as any)?.hint ?? null,
      })),
      usage: this.usage.get(sessionId) ?? null,
      // Attachments live here so they survive a focus/boot round-trip; the
      // standalone `attachments` message is only for immediate feedback.
      attachments: this.attachments.get(sessionId) ?? [],
    };
  }

  /**
   * Record a failure.
   *
   * For a known session the notice goes into the transcript store and is
   * delivered as a normal `append` — the same path as every other entry, so it
   * survives a session switch and is not duplicated on the client. The
   * standalone `error` message is reserved for failures with no session to
   * attach to.
   */
  private reportError(sessionId: string | null, e: unknown): void {
    const message = (e as any)?.message ?? String(e);
    log(`${LOG_PREFIX}: error ${message}`);
    if (!sessionId) {
      this.post({ type: 'error', message });
      return;
    }
    const entry = this.transcripts.appendNotice(sessionId, 'error', message);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }
}

// --- helpers ---------------------------------------------------------------

function sessionOf(manager: SessionManager, sessionId: string): SessionInfo | undefined {
  return manager.getSession(sessionId);
}

/** Validate that a message's sessionId names a live session; else return null. */
function verifySession(manager: SessionManager, msg: { sessionId?: string }): string | null {
  const sessionId = msg?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) { return null; }
  return manager.getSession(sessionId) ? sessionId : null;
}

function toolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}::${toolCallId}`;
}

function textOf(content: unknown): string {
  if (!content || typeof content !== 'object') { return ''; }
  const block = content as { type?: string; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function fileUri(path: string, cwd?: string): vscode.Uri {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return vscode.Uri.file(path);
  }
  // Relative paths resolve against the session's working directory.
  const base = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return vscode.Uri.file(base ? `${base}/${path}` : path);
}
