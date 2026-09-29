// [CUSTOM-BEGIN] CUSTOM-20260929-119 - ACP elicitation（表单）桥：AskUserQuestion 等
// 「向用户要结构化输入」的请求可以在面板里答了。
//
// **它为什么存在**：在 ACP 里 AskUserQuestion 走的是 elicitation（form 模式）协议，而客户端
// **必须先在 initialize 里声明 `clientCapabilities.elicitation.form`**，agent 才会把它渲染成
// 表单——不声明时 adapter 连这个工具都直接禁用（`disallowedTools`）。
// 声明之后，请求就落到这里，而它和 `session/request_permission` 有**同一个致命性质**：
// 它是个 JSON-RPC 请求，SDK 侧没有超时，用户不回答 agent 就永远等。
//
// 因此本文件与 `PermissionBridge` 同构（照抄它的三处防漏，别自创）：
//   1. 呈现不出来时降级到可见的弹框，绝不静默；
//   2. 轮次取消 / 会话关闭时**必须回一个响应**（表单是三态：accept / decline / cancel）；
//   3. 并发请求走 FIFO，一次只弹一个。
//
// **与 permission 的两处不同**（写在这里免得被当成笔误）：
//   · 三态而不是两态：`accept` 带 content、`decline` 是"用户跳过"（空答案，轮次继续）、
//     `cancel` 才中止工具调用。adapter 的 `applyAskElicitationResponse` 就是按这三态解释的。
//   · 只支持 **sessionId 作用域**：ACP 的 form 请求还可以挂在 `requestId` 上（与任何会话无关），
//     那种请求这里没有会话可归属，直接回 `cancel`（面板是按会话组织的，猜一个会话去渲染更糟）。
//
// 本文件不 import vscode 的 UI 类型（只认 `ElicitationPresenter`），因此可以被单测直接驱动。
// [CUSTOM-END] CUSTOM-20260929-119
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';

import { log } from '../utils/Logger';
import type { SessionLabel } from './PermissionBridge';

const LOG_PREFIX = 'elicitation-bridge';

/**
 * `_meta` key the Claude Code adapter puts on the per-question free-text "Other"
 * field. Deliberately un-namespaced upstream ("so ACP clients can recognize the
 * same marker across Codex, Claude, and other AskUserQuestion bridges"), so this
 * client reads exactly that key and nothing else.
 */
const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer';

/** One field of a form, in the shape both the panel and the dialog can render. */
export interface ElicitationFieldView {
  /** Form-field key (`question_0`, `question_0_custom`, …) — echoed back verbatim. */
  name: string;
  kind: 'select' | 'multi' | 'text' | 'number' | 'boolean';
  /** Short label (AskUserQuestion's `header`), when the agent sent one. */
  title?: string;
  /** The question text for this field (the schema's `description`). */
  description?: string;
  options?: Array<{ value: string; title: string; description?: string; preview?: string }>;
  /** Set on an "Other" text field: the field it is the custom answer FOR. */
  customFor?: string;
}

export type ElicitationStatus = 'pending' | 'deferred' | 'accepted' | 'declined' | 'cancelled';

/** What the user is being asked, in a form both the panel and the dialog can render. */
export interface ElicitationPrompt {
  promptId: string;
  sessionId: string;
  toolCallId?: string;
  /** The agent's own prompt line (for a single question: the question itself). */
  message: string;
  fields: ElicitationFieldView[];
}

/** Prompt + where its answer currently has to come from + what came of it. */
export interface ElicitationState extends ElicitationPrompt {
  status: ElicitationStatus;
  /** Human-readable record of the decision, shown on the settled card. */
  summary?: string;
}

/**
 * The UI that can render a form inside the chat panel. `ChatPanelHost` implements
 * it; the bridge holds at most one. Same contract as `PermissionPresenter`.
 */
export interface ElicitationPresenter {
  canPresent(sessionId: string): boolean;
  show(state: ElicitationState): void;
  update(state: ElicitationState): void;
}

/** What the panel sends back: the three ACP outcomes plus the collected values. */
export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationContent = Record<string, string | number | boolean | string[]>;

/**
 * The dialog path, supplied per request by `ElicitationHandler` so the QuickPick
 * code stays in exactly one place.
 */
export type ElicitationFallback = (
  params: CreateElicitationRequest,
  label: string,
) => Promise<CreateElicitationResponse>;

interface Pending {
  prompt: ElicitationPrompt;
  params: CreateElicitationRequest;
  fallback: ElicitationFallback;
  resolve: (response: CreateElicitationResponse) => void;
  owner: 'panel' | 'dialog';
  shown: boolean;
  resolved: boolean;
}

export class ElicitationBridge {
  private presenter: ElicitationPresenter | null = null;
  private lookup: ((sessionId: string) => SessionLabel | undefined) | null = null;
  private readonly pending: Map<string, Pending> = new Map();
  private readonly queue: Pending[] = [];
  private draining = false;
  private seq = 0;

  setPresenter(presenter: ElicitationPresenter | null): void {
    this.presenter = presenter;
    if (presenter === null) {
      // The host itself is going away (extension dispose). Nothing can render any
      // more, so do not leave requests hanging on it.
      this.cancelAll();
    }
  }

  /** The presenter exists but has no surface left to draw on (same as permission). */
  onPresenterLost(): void {
    const presenter = this.presenter;
    let moved = 0;
    for (const item of this.pending.values()) {
      if (item.resolved || item.owner !== 'panel') { continue; }
      if (item.shown) { presenter?.update(this.stateOf(item, 'deferred')); }
      this.enqueueDialog(item);
      moved++;
    }
    if (moved > 0) { log(`${LOG_PREFIX}: ${moved} form(s) demoted to the dialog (no panel surface)`); }
  }

  setSessionLookup(lookup: (sessionId: string) => SessionLabel | undefined): void {
    this.lookup = lookup;
  }

  /** ACP entry point. Never rejects: every path resolves to a valid response. */
  request(params: CreateElicitationRequest, fallback: ElicitationFallback): Promise<CreateElicitationResponse> {
    const prompt = this.buildPrompt(params);
    return new Promise<CreateElicitationResponse>(resolve => {
      const item: Pending = { prompt, params, fallback, resolve, owner: 'dialog', shown: false, resolved: false };
      this.pending.set(prompt.promptId, item);

      if (this.presenter?.canPresent(prompt.sessionId)) {
        item.owner = 'panel';
        item.shown = true;
        this.presenter.show(this.stateOf(item, 'pending'));
        log(`${LOG_PREFIX}: form ${prompt.promptId} shown in panel (${prompt.fields.length} field(s))`);
        return;
      }
      this.enqueueDialog(item);
    });
  }

  /**
   * Answer from the panel. Returns false for an unknown / already-resolved prompt
   * (double click, both surfaces racing, stale card) or one owned by the dialog.
   */
  submit(promptId: string, action: ElicitationAction, content?: ElicitationContent): boolean {
    const item = this.pending.get(promptId);
    if (!item || item.resolved) {
      log(`${LOG_PREFIX}: ignoring answer for unknown/resolved form ${promptId}`);
      return false;
    }
    if (item.owner !== 'panel') {
      // A deferred card must not race an open dialog (same rule as permission).
      log(`${LOG_PREFIX}: form ${promptId} is deferred to the dialog; ignoring panel answer`);
      return false;
    }
    this.settle(item, action, content);
    return true;
  }

  /**
   * Resolve every pending form of one session.
   *
   * `cancel` (not decline): the user cancelled the turn, so the tool call must not
   * be "answered with empty answers" — that would hand the agent a bogus reply.
   */
  cancelSession(sessionId: string): void {
    let cancelled = 0;
    for (const item of this.pending.values()) {
      if (item.prompt.sessionId !== sessionId || item.resolved) { continue; }
      this.settle(item, 'cancel');
      cancelled++;
    }
    if (cancelled > 0) { log(`${LOG_PREFIX}: cancelled ${cancelled} pending form(s) for ${sessionId}`); }
  }

  cancelAll(): void {
    for (const item of Array.from(this.pending.values())) {
      if (!item.resolved) { this.settle(item, 'cancel'); }
    }
  }

  dispose(): void {
    this.cancelAll();
    this.presenter = null;
    this.lookup = null;
    this.queue.length = 0;
  }

  /** Diagnostics: how many forms are still awaiting an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --- Internals -----------------------------------------------------------

  private buildPrompt(params: CreateElicitationRequest): ElicitationPrompt {
    const schema = (params as { requestedSchema?: unknown }).requestedSchema;
    return {
      promptId: `${(params as { sessionId?: string }).sessionId ?? 'no-session'}:${++this.seq}`,
      sessionId: (params as { sessionId?: string }).sessionId ?? '',
      toolCallId: (params as { toolCallId?: string }).toolCallId,
      message: typeof params.message === 'string' ? params.message : '',
      fields: fieldsOf(schema),
    };
  }

  private stateOf(item: Pending, status: ElicitationStatus, summary?: string): ElicitationState {
    return { ...item.prompt, status, summary };
  }

  private labelFor(sessionId: string): string {
    const info = this.lookup?.(sessionId);
    const parts = [info?.agentName, info?.title].filter((p): p is string => !!p);
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
        if (item.resolved) { continue; }
        let response: CreateElicitationResponse;
        try {
          response = await item.fallback(item.params, this.labelFor(item.prompt.sessionId));
        } catch (e) {
          log(`${LOG_PREFIX}: dialog failed for ${item.prompt.promptId}: ${String(e)}`);
          response = { action: 'cancel' };
        }
        if (item.resolved) { continue; }
        this.settleWith(item, response);
      }
    } finally {
      this.draining = false;
    }
  }

  private settle(item: Pending, action: ElicitationAction, content?: ElicitationContent): void {
    const response: CreateElicitationResponse = action === 'accept'
      ? { action: 'accept', content: content ?? {} }
      : action === 'decline' ? { action: 'decline' } : { action: 'cancel' };
    this.settleWith(item, response);
  }

  private settleWith(item: Pending, response: CreateElicitationResponse): void {
    if (item.resolved) { return; }
    item.resolved = true;
    this.pending.delete(item.prompt.promptId);
    if (item.shown && this.presenter) {
      const status: ElicitationStatus = response.action === 'accept' ? 'accepted'
        : response.action === 'decline' ? 'declined' : 'cancelled';
      this.presenter.update(this.stateOf(item, status, summarize(response)));
    }
    item.resolve(response);
  }
}

/** One line for the settled card: what the user actually chose. */
function summarize(response: CreateElicitationResponse): string | undefined {
  if (response.action === 'decline') { return 'Skipped'; }
  if (response.action !== 'accept') { return 'Cancelled'; }
  const content = response.content ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined || value === null || value === '') { continue; }
    parts.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Answered';
}

/**
 * Flatten an ACP `ElicitationSchema` into the fields the panel renders.
 *
 * Only the four shapes this client can actually draw are recognised — string with
 * `oneOf` (single select), array with `items.anyOf` (multi select), boolean,
 * number/integer, and a plain string (text). Anything else is **left out of the
 * form** rather than rendered as something misleading; the response simply omits
 * it (nothing in the ACP schema is required, so an omitted field is a valid
 * answer, and `decline`/`cancel` are always available when that is not enough).
 */
export function fieldsOf(schema: unknown): ElicitationFieldView[] {
  const properties = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  if (!properties || typeof properties !== 'object') { return []; }
  const fields: ElicitationFieldView[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const prop = raw as {
      type?: string; title?: string; description?: string;
      oneOf?: Array<{ const?: unknown; title?: string; description?: string; _meta?: unknown }>;
      items?: { anyOf?: Array<{ const?: unknown; title?: string; description?: string; _meta?: unknown }> };
      _meta?: unknown;
    };
    if (!prop || typeof prop !== 'object') { continue; }
    const field: ElicitationFieldView = { name, kind: 'text' };
    if (typeof prop.title === 'string') { field.title = prop.title; }
    if (typeof prop.description === 'string') { field.description = prop.description; }

    const marker = (prop._meta as Record<string, { isCustomAnswer?: unknown; questionId?: unknown }> | undefined)
      ?.[CUSTOM_ANSWER_META_KEY];
    if (marker?.isCustomAnswer === true) {
      field.kind = 'text';
      if (typeof marker.questionId === 'string') { field.customFor = marker.questionId; }
      fields.push(field);
      continue;
    }

    if (Array.isArray(prop.oneOf)) {
      field.kind = 'select';
      field.options = prop.oneOf.map(optionOf).filter((o): o is NonNullable<typeof o> => o !== null);
    } else if (prop.type === 'array' && Array.isArray(prop.items?.anyOf)) {
      field.kind = 'multi';
      field.options = prop.items.anyOf.map(optionOf).filter((o): o is NonNullable<typeof o> => o !== null);
    } else if (prop.type === 'boolean') {
      field.kind = 'boolean';
    } else if (prop.type === 'number' || prop.type === 'integer') {
      field.kind = 'number';
    } else if (prop.type !== 'string') {
      // Unknown shape (object, nested array, …): see the note above — leave it out.
      continue;
    }
    fields.push(field);
  }
  return fields;
}

function optionOf(o: { const?: unknown; title?: string; description?: string; _meta?: unknown }):
{ value: string; title: string; description?: string; preview?: string } | null {
  if (!o || typeof o !== 'object') { return null; }
  const value = typeof o.const === 'string' ? o.const : undefined;
  if (value === undefined) { return null; }
  const out: { value: string; title: string; description?: string; preview?: string } = {
    value,
    title: typeof o.title === 'string' && o.title.length > 0 ? o.title : value,
  };
  if (typeof o.description === 'string' && o.description.length > 0) { out.description = o.description; }
  // ACP has no structural slot for the SDK's option `preview`, so the adapter
  // forwards it under its own namespaced `_meta` key; read exactly that one.
  const meta = o._meta as Record<string, { preview?: unknown }> | undefined;
  const preview = meta?.['_claude/askUserQuestionOption']?.preview;
  if (typeof preview === 'string' && preview.length > 0) { out.preview = preview; }
  return out;
}
