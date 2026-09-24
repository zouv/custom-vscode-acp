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
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk';

import type { SessionManager, SessionInfo } from '../../core/SessionManager';
import type { SessionUpdateHandler, SessionUpdateListener } from '../../handlers/SessionUpdateHandler';
import { log } from '../../utils/Logger';
import { renderChatHtml, createNonce } from './html';
import { SafeMarkdown } from './markdown';
import type {
  Attachment,
  ChatToExt,
  CloseReason,
  ExtToChat,
  SessionMeta,
  SessionSummary,
  TranscriptSnapshotWire,
} from './protocol';
import type { IChatPanel, PanelContext } from './panelContract';
import { TranscriptStore } from './transcript/TranscriptStore';
import { ToolInvocationStore } from './transcript/ToolInvocationStore';
import { toToolCallView } from './content/toolCalls';
import { toContentView } from './content/contentBlocks';
import { resolveNestingStrategy } from './nesting/NestingStrategy';

/** Prefix of the output channel used for panel-level diagnostics. */
const LOG_PREFIX = 'chat-panel';

export class ChatPanelHost implements IChatPanel {
  readonly id = 'modern' as const;

  private view: vscode.WebviewView | null = null;
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

  private focused: PanelContext = { agentName: null, sessionId: null };

  private readonly updateListener: SessionUpdateListener;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
  ) {
    this.updateListener = (update: SessionNotification) => this.onSessionUpdate(update);
    sessionUpdateHandler.addListener(this.updateListener);

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
    on('session-load-end', refresh);
    on('active-session-changed', (_sessionId: string | null, agentName: string | null) => {
      // The router owns focus decisions, but a focus change originating from
      // elsewhere (e.g. the tree) must still reach an attached panel.
      this.focused = { agentName, sessionId: _sessionId };
      this.pushFocus();
    });
  }

  // --- IChatPanel ----------------------------------------------------------

  attach(view: vscode.WebviewView, ctx: PanelContext): void {
    this.view = view;
    this.focused = ctx;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = renderChatHtml(view.webview, createNonce());
    this.pushBoot();
  }

  detach(): void {
    this.view = null;
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
    const attachment: Attachment = { path: uri.fsPath, name: basename(uri.fsPath) };
    const list = this.attachments.get(sessionId) ?? [];
    if (!list.some(a => a.path === attachment.path)) { list.push(attachment); }
    this.attachments.set(sessionId, list);
    this.post({ type: 'attachments', sessionId, attachments: list });
    this.view?.show?.(true);
  }

  onMessage(message: unknown): void {
    const msg = message as Partial<ChatToExt> & { type?: string };
    if (!msg || typeof msg.type !== 'string') { return; }

    switch (msg.type) {
      case 'ready':
        this.pushBoot();
        return;
      case 'newSession': {
        const agentName = (msg as { agentName?: string }).agentName;
        if (!agentName) { return; }
        void this.sessionManager.connectToAgent(agentName).catch(e => this.reportError(null, e));
        return;
      }
      case 'focusAgent': {
        const agentName = (msg as { agentName?: string }).agentName;
        if (!agentName) { return; }
        const ids = this.sessionManager.getSessionIdsForAgent(agentName);
        const next = ids[ids.length - 1];
        if (next) { this.sessionManager.focusSession(next); }
        return;
      }

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
      case 'setMode':
        void this.sessionManager.setMode(sessionId, (msg as { modeId: string }).modeId)
          .then(() => this.pushMeta(sessionId))
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setModel':
        void this.sessionManager.setModel(sessionId, (msg as { modelId: string }).modelId)
          .then(() => this.pushMeta(sessionId))
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setConfigOption':
        void this.sessionManager.setConfigOption(
          sessionId,
          (msg as { configId: string }).configId,
          (msg as { value: string }).value,
        )
          .then(() => this.pushMeta(sessionId))
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'openFile':
        void this.handleOpenFile(
          (msg as { path?: string }).path ?? '',
          (msg as { line?: number }).line,
        );
        return;
      case 'openTerminal':
        this.handleOpenTerminal(sessionId, (msg as { terminalId?: string }).terminalId ?? '');
        return;
      default:
        break;
    }
  }

  dispose(): void {
    for (const d of this.subscriptions) { d.dispose(); }
    this.subscriptions.length = 0;
    this.view = null;
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
  }

  // --- Session update → transcript ----------------------------------------

  private onSessionUpdate(update: SessionNotification): void {
    const sessionId = update.sessionId;
    const data = update.update as any;
    const session = sessionOf(this.sessionManager, sessionId);
    if (!data || !session) { return; }

    this.transcripts.ensureSession(sessionId, session.agentName);

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
        if (text.length === 0) { return; }
        const entry = this.transcripts.appendThoughtChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
        return;
      }

      case 'user_message_chunk': {
        // Replay path (`session/load`).
        const text = textOf(data.content);
        if (text.length === 0) { return; }
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
          this.post({ type: 'revise', sessionId, entryId: existing.id, patch: { plan: existing.entries } });
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

      default:
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
        return;
    }
  }

  /**
   * Non-text content in a message chunk becomes a real transcript entry so the
   * webview renders it (image inline, resource as a chip, …) instead of a
   * `[image content]` placeholder.
   */
  private postContentNotice(sessionId: string, block: unknown): void {
    const view = toContentView(block as ContentBlock | null);
    if (!view) { return; }
    const entry = this.transcripts.appendContent(sessionId, [view]);
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

  private handleRenderMarkdown(items: Array<{ entryId: string; sessionId: string; text: string }>): void {
    const rendered: Array<{ entryId: string; sessionId: string; html: string }> = [];
    for (const item of items) {
      const sessionId = verifySession(this.sessionManager, item);
      if (!sessionId) { continue; }
      const html = this.markdown.render(item.text);
      this.transcripts.patch(sessionId, item.entryId, { html });
      rendered.push({ entryId: item.entryId, sessionId, html });
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

  private async handleOpenFile(rawPath: string, line?: number): Promise<void> {
    if (!rawPath) { return; }
    const session = this.focused.sessionId ? sessionOf(this.sessionManager, this.focused.sessionId) : undefined;
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

  // --- Outbound messages ---------------------------------------------------

  private post(message: ExtToChat | { type: 'markdownRendered'; items: Array<{ entryId: string; sessionId: string; html: string }> }): void {
    void this.view?.webview.postMessage(message);
  }

  private pushBoot(): void {
    if (!this.view) { return; }
    this.refreshLiveSessionIds();
    const sessions = this.buildSummaries();
    const focused = this.focused.sessionId ? this.buildSummary(this.focused.sessionId) : null;
    this.post({
      type: 'boot',
      focused,
      sessions,
      snapshot: focused ? this.snapshotOf(focused.sessionId) : null,
      meta: focused ? this.metaOf(focused.sessionId) : null,
    });
  }

  private pushFocus(): void {
    if (!this.view) { return; }
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
    if (this.focused.sessionId !== sessionId) { return; }
    this.post({ type: 'meta', sessionId, meta: this.metaOf(sessionId) });
  }

  private pushTurnState(sessionId: string): void {
    this.refreshSessions();
    this.pushMeta(sessionId);
  }

  private refreshSessions(): void {
    if (!this.view) { return; }
    this.refreshLiveSessionIds();
    this.post({ type: 'sessionsChanged', sessions: this.buildSummaries() });
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
        return inv ? { ...entry, toolView: toToolCallView(inv) } : entry;
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
