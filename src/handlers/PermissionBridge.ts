// [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限请求桥（面板内提示 + 弹框兜底）：新增文件。
// 上游的 `PermissionHandler` 直接 `showQuickPick`，本仓库把它改成：能进面板就进面板，
// 进不去才退回弹框。桥的职责是把「ACP 请求 → 用户决定 → ACP 响应」这条链路的**所有出口**
// 收在一处，因为这条链有三条必须逐条堵住的泄漏路径：
//
//   1. **agent 会一直等**。`session/request_permission` 是个 JSON-RPC 请求，SDK 侧没有超时，
//      用户不回答就永远不返回。所以「呈现不出来」绝不能静默——要么落到可见的弹框，
//      要么把卡片状态改成 deferred 并说明去哪答。
//   2. **轮次被取消时必须回答 `cancelled`**。ACP 契约明确要求：会话被 cancel 时，
//      客户端必须把待决的权限请求以 `{ outcome: 'cancelled' }` 结束，否则 agent 永久挂起。
//      上游实现里这条完全缺失（`SessionManager.cancelTurn` 只发 `session/cancel`）。
//   3. **同时多个请求**。上游是并发的 QuickPick，两个会话同时请求会叠出两个分不清归属的弹框；
//      这里改成全局 FIFO，一次只弹一个，且标题带会话标识。
//
// 本文件**不 import vscode 的 UI 类型**，只认 `PermissionPresenter` 接口，因此可以被单测直接驱动。
// [CUSTOM-END] CUSTOM-20260924-020
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from '@agentclientprotocol/sdk';

import { log } from '../utils/Logger';

const LOG_PREFIX = 'permission-bridge';

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export type PermissionStatus = 'pending' | 'deferred' | 'selected' | 'cancelled';

/** What the user is being asked, in a form both the panel and the dialog can render. */
export interface PermissionPrompt {
  promptId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  options: PermissionOptionView[];
}

/** Prompt + where its answer currently has to come from. */
export interface PermissionState extends PermissionPrompt {
  status: PermissionStatus;
  selectedOptionId?: string;
}

/**
 * The UI that can render a prompt inside the chat panel. `ChatPanelHost`
 * implements it; the bridge holds at most one.
 */
export interface PermissionPresenter {
  /**
   * True when this prompt can be answered in a panel the user can actually see.
   * Implementations may raise the surface, but must not steal focus.
   */
  canPresent(sessionId: string): boolean;
  show(state: PermissionState): void;
  update(state: PermissionState): void;
}

/** Label describing which session a dialog belongs to (QuickPick title/placeholder). */
export interface SessionLabel {
  title?: string | null;
  agentName: string;
}

/**
 * The dialog path, supplied per request by `PermissionHandler` so the QuickPick
 * code stays in exactly one place.
 */
export type PermissionFallback = (
  params: RequestPermissionRequest,
  label: string,
) => Promise<RequestPermissionResponse>;

interface Pending {
  prompt: PermissionPrompt;
  params: RequestPermissionRequest;
  fallback: PermissionFallback;
  resolve: (response: RequestPermissionResponse) => void;
  /** Where the answer is expected to come from right now. */
  owner: 'panel' | 'dialog';
  /** Whether `presenter.show` was actually called for this prompt. */
  shown: boolean;
  resolved: boolean;
}

export class PermissionBridge {
  private presenter: PermissionPresenter | null = null;
  private lookup: ((sessionId: string) => SessionLabel | undefined) | null = null;
  private readonly pending: Map<string, Pending> = new Map();
  private readonly queue: Pending[] = [];
  private draining = false;
  private seq = 0;

  setPresenter(presenter: PermissionPresenter | null): void {
    this.presenter = presenter;
    if (presenter === null) {
      // The host itself is going away (extension dispose). Nothing can render
      // anymore, so do not leave requests hanging on it.
      this.cancelAll();
    }
  }

  /**
   * The presenter still exists (its store is the source of truth) but it has no
   * surface left to draw on. Panel-owned prompts must move to the dialog,
   * otherwise the agent waits forever on a card nobody can see or click.
   */
  onPresenterLost(): void {
    const presenter = this.presenter;
    let moved = 0;
    for (const item of this.pending.values()) {
      if (item.resolved || item.owner !== 'panel') { continue; }
      if (item.shown) { presenter?.update(this.stateOf(item, 'deferred')); }
      this.enqueueDialog(item);
      moved++;
    }
    if (moved > 0) { log(`${LOG_PREFIX}: ${moved} prompt(s) demoted to the dialog (no panel surface)`); }
  }

  /** Late-bound so the dialog can name its session (mirrors `setHistoryStore`). */
  setSessionLookup(lookup: (sessionId: string) => SessionLabel | undefined): void {
    this.lookup = lookup;
  }

  /** ACP entry point. Never rejects: every path resolves to a valid outcome. */
  request(params: RequestPermissionRequest, fallback: PermissionFallback): Promise<RequestPermissionResponse> {
    const prompt = this.buildPrompt(params);
    return new Promise<RequestPermissionResponse>(resolve => {
      const item: Pending = { prompt, params, fallback, resolve, owner: 'dialog', shown: false, resolved: false };
      this.pending.set(prompt.promptId, item);

      if (this.presenter?.canPresent(prompt.sessionId)) {
        item.owner = 'panel';
        item.shown = true;
        // Multiple panel prompts may coexist: they are anchored in their own
        // session's transcript, so they never compete for one dialog slot.
        this.presenter.show(this.stateOf(item, 'pending'));
        log(`${LOG_PREFIX}: prompt ${prompt.promptId} shown in panel (${prompt.title})`);
        return;
      }
      this.enqueueDialog(item);
    });
  }

  /**
   * Answer a prompt from the panel. Returns false for an unknown or
   * already-resolved prompt (double click, both surfaces racing, stale card).
   */
  answer(promptId: string, optionId?: string): boolean {
    const item = this.pending.get(promptId);
    if (!item || item.resolved) {
      log(`${LOG_PREFIX}: ignoring answer for unknown/resolved prompt ${promptId}`);
      return false;
    }
    if (item.owner !== 'panel') {
      // A deferred card must not race an open QuickPick: two answer paths for
      // one request is exactly how a user answers "twice" and gets confused
      // about which decision took effect.
      log(`${LOG_PREFIX}: prompt ${promptId} is deferred to the dialog; ignoring panel answer`);
      return false;
    }
    this.settle(item, optionId);
    return true;
  }

  /**
   * Resolve every pending prompt of one session as `cancelled`.
   *
   * Required by the ACP contract when a turn is cancelled, and also the only
   * way a prompt can be retired when its session/agent goes away.
   */
  cancelSession(sessionId: string): void {
    let cancelled = 0;
    for (const item of this.pending.values()) {
      if (item.prompt.sessionId !== sessionId || item.resolved) { continue; }
      this.settle(item, undefined);
      cancelled++;
    }
    if (cancelled > 0) { log(`${LOG_PREFIX}: cancelled ${cancelled} pending prompt(s) for ${sessionId}`); }
  }

  cancelAll(): void {
    for (const item of Array.from(this.pending.values())) {
      if (!item.resolved) { this.settle(item, undefined); }
    }
  }

  dispose(): void {
    this.cancelAll();
    this.presenter = null;
    this.lookup = null;
    this.queue.length = 0;
  }

  /** Diagnostics: how many prompts are still awaiting an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --- Internals -----------------------------------------------------------

  private buildPrompt(params: RequestPermissionRequest): PermissionPrompt {
    // Correlation keys only: the handler never sees the JSON-RPC request id, and
    // `session/request_permission` carries just sessionId + toolCall.
    return {
      promptId: `${params.sessionId}:${++this.seq}`,
      sessionId: params.sessionId,
      toolCallId: params.toolCall?.toolCallId ?? '',
      title: params.toolCall?.title || 'Permission Request',
      // ACP types `kind` as `ToolKind | null`; the view model uses `undefined`
      // for "not reported" so JSON round-trips drop the field entirely.
      kind: params.toolCall?.kind ?? undefined,
      options: (params.options ?? []).map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
  }

  private stateOf(item: Pending, status: PermissionStatus, selectedOptionId?: string): PermissionState {
    return { ...item.prompt, status, selectedOptionId };
  }

  private labelFor(sessionId: string): string {
    const info = this.lookup?.(sessionId);
    const parts = [info?.agentName, info?.title].filter((p): p is string => !!p);
    // Fall back to the raw id so an unknown session is still distinguishable
    // from another unknown session.
    return parts.length > 0 ? parts.join(' · ') : sessionId;
  }

  private enqueueDialog(item: Pending): void {
    item.owner = 'dialog';
    this.queue.push(item);
    void this.drain();
  }

  /** One dialog at a time, in arrival order. */
  private async drain(): Promise<void> {
    if (this.draining) { return; }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        // Resolved while queued (turn cancelled, session closed, answered from
        // a stale card): never open a dialog for it.
        if (item.resolved) { continue; }
        let response: RequestPermissionResponse;
        try {
          response = await item.fallback(item.params, this.labelFor(item.prompt.sessionId));
        } catch (e) {
          log(`${LOG_PREFIX}: dialog failed for ${item.prompt.promptId}: ${String(e)}`);
          response = { outcome: { outcome: 'cancelled' } };
        }
        if (item.resolved) { continue; }
        const selected = response.outcome.outcome === 'selected' ? response.outcome.optionId : undefined;
        this.settleWith(item, selected, response);
      }
    } finally {
      this.draining = false;
    }
  }

  private settle(item: Pending, optionId: string | undefined): void {
    const response: RequestPermissionResponse = optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } };
    this.settleWith(item, optionId, response);
  }

  private settleWith(item: Pending, optionId: string | undefined, response: RequestPermissionResponse): void {
    if (item.resolved) { return; }
    item.resolved = true;
    this.pending.delete(item.prompt.promptId);
    if (item.shown && this.presenter) {
      this.presenter.update(this.stateOf(item, optionId ? 'selected' : 'cancelled', optionId));
    }
    item.resolve(response);
  }
}
