// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 工具调用视图模型的索引，严格实现 ACP 的 replace-collection 语义：
// ToolCallUpdate 的 `content` / `locations` 是**整体替换**而非合并（SDK 文档明写），
// `title` / `status` 是 string|null，null 表示「保留原值」。
// 平坦映射（toolCallId → 调用）永远是地面真相；嵌套关系由 Phase 4 的 NestingStrategy 事后推断。
// [CUSTOM-END] CUSTOM-20260923-011
import type { ToolCall, ToolCallStatus, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';

import { isTerminalStatus, type SubagentInfo, type ToolInvocation } from './types';

/**
 * Per-session tool-call index. Flat by construction — ACP has no nesting
 * concept (verified: zero matches for parent/subagent/child across all 239
 * schema definitions), so any tree is an inference layered on top.
 *
 * [CUSTOM-20260925-043] There is deliberately **no per-session cap** here,
 * unlike `TranscriptStore` (500 entries / 24 sessions). A naive LRU would be a
 * visible regression: `ChatPanelHost.snapshotOf` hydrates every tool entry's
 * view model from this store, so evicting an invocation whose transcript row
 * still exists renders that row as exactly the "empty shell" that
 * CUSTOM-20260924-027 was written to eliminate. A cap only becomes safe once
 * the store knows which ids the transcript still references — i.e. a reference
 * count pushed in from the host, mirroring `TranscriptStore.setLiveSessionIds`.
 * Until then growth is bounded in practice by the transcript cap × session
 * count; only a session with thousands of tool calls would notice.
 */
export class ToolInvocationStore {
  private bySession: Map<string, Map<string, ToolInvocation>> = new Map();

  /** Apply a `tool_call` notification (a full ToolCall). */
  upsertCall(sessionId: string, call: ToolCall): ToolInvocation {
    const existing = this.get(sessionId, call.toolCallId);
    const now = Date.now();
    const inv: ToolInvocation = existing ?? {
      toolCallId: call.toolCallId,
      title: call.title,
      kind: undefined,
      status: undefined,
      content: [],
      locations: [],
      rawInput: undefined,
      rawOutput: undefined,
      startedAt: now,
    };

    inv.title = call.title;
    if (call.kind !== undefined) { inv.kind = call.kind; }
    if (call.status !== undefined) { inv.status = call.status; }
    if (call.content !== undefined) { inv.content = call.content ?? []; }
    if (call.locations !== undefined) { inv.locations = normalizeLocations(call.locations); }
    if ('rawInput' in call) { inv.rawInput = call.rawInput; }
    if ('rawOutput' in call) { inv.rawOutput = call.rawOutput; }
    if (call._meta !== undefined) { inv.meta = call._meta; }
    latchDescription(inv);
    latchSubagent(inv);
    latchToolElapsed(inv);
    if (isTerminalStatus(inv.status) && inv.endedAt === undefined) { inv.endedAt = now; }

    this.put(sessionId, inv);
    return inv;
  }

  /** Apply a `tool_call_update` notification (all fields except id optional). */
  upsertUpdate(sessionId: string, update: ToolCallUpdate): ToolInvocation | null {
    const inv = this.get(sessionId, update.toolCallId);
    if (!inv) { return null; }

    // Per spec: `content` and `locations` REPLACE the collection.
    if (update.content !== undefined) { inv.content = update.content ?? []; }
    if (update.locations !== undefined) { inv.locations = normalizeLocations(update.locations); }
    // Nullable scalars: null means "leave unchanged".
    if (update.kind !== undefined && update.kind !== null) { inv.kind = update.kind as ToolKind; }
    if (update.title !== undefined && update.title !== null) { inv.title = update.title; }
    if (update.status !== undefined && update.status !== null) {
      inv.status = update.status as ToolCallStatus;
      if (isTerminalStatus(inv.status) && inv.endedAt === undefined) { inv.endedAt = Date.now(); }
    }
    if ('rawInput' in update) { inv.rawInput = update.rawInput; }
    if ('rawOutput' in update) { inv.rawOutput = update.rawOutput; }
    if (update._meta !== undefined) { inv.meta = update._meta; }
    latchDescription(inv);
    latchSubagent(inv);
    latchToolElapsed(inv);

    this.put(sessionId, inv);
    return inv;
  }

  get(sessionId: string, toolCallId: string): ToolInvocation | undefined {
    return this.bySession.get(sessionId)?.get(toolCallId);
  }

  /**
   * Invocations in chronological order.
   *
   * [CUSTOM-20260925-043] **No `sort` here.** A `Map` iterates in insertion
   * order, and `startedAt` is stamped at insertion and never revised (an update
   * to an existing call reuses the record, so it never moves) — the two orders
   * are identical by construction. The former `.sort((a, b) => a.startedAt -
   * b.startedAt)` was therefore an O(n log n) no-op that allocated and ran on
   * every tool notification, including every `tool_call_update`.
   */
  list(sessionId: string): ToolInvocation[] {
    const m = this.bySession.get(sessionId);
    return m ? Array.from(m.values()) : [];
  }

  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  // [CUSTOM-20260925-052] `dropAgentSessions` was removed here — no callers. The
  // host drops a session's index through `drop(sessionId)` when the session
  // closes, which is the only case that arises.

  private put(sessionId: string, inv: ToolInvocation): void {
    let m = this.bySession.get(sessionId);
    if (!m) {
      m = new Map();
      this.bySession.set(sessionId, m);
    }
    m.set(inv.toolCallId, inv);
  }
}

function normalizeLocations(
  locations: Array<{ path: string; line?: number | null }> | null | undefined,
): Array<{ path: string; line?: number | null }> {
  if (!locations) { return []; }
  return locations.map(l => ({ path: l.path, line: l.line ?? undefined }));
}

/**
 * [CUSTOM-20260929-117] Pick up the agent's human-written description of the call,
 * if this payload carries one, and keep the first one seen.
 *
 * Two shapes are recognised, both in Claude Code's `_meta`/`rawInput` namespace
 * (the captured replay carries all three Bash calls with `rawInput.description`,
 * and the same string mirrored at `_meta.claudeCode.title`):
 *
 *   · `rawInput.description` — the durable one: a later update that omits the
 *     `rawInput` key leaves the field in place.
 *   · `_meta.claudeCode.title` — present in ONE update only (`_meta` is replaced
 *     wholesale), which is why this is a latch and not a property read.
 *
 * Written **only when a value is found**, so an update without either shape can
 * never erase a description we already have. Silent about anything else: `_meta`
 * is vendor-specific by definition, and guessing at a second vendor's key is the
 * "inferred, not reported" mistake the panel docs warn about (same rule as
 * `extractToolName`, CUSTOM-20260926-074).
 */
function latchDescription(inv: ToolInvocation): void {
  if (inv.description) { return; }
  const found = descriptionOf(inv.rawInput) ?? metaTitleOf(inv.meta);
  if (found) { inv.description = found; }
}

function descriptionOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') { return undefined; }
  const value = (rawInput as { description?: unknown }).description;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function metaTitleOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') { return undefined; }
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (!claudeCode || typeof claudeCode !== 'object') { return undefined; }
  const value = (claudeCode as { title?: unknown }).title;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

// [CUSTOM-BEGIN] CUSTOM-20261009-219 - 子 agent 的身份（判据已按实测改正一次，见下）。
//
// 用户问："消息类内容，有的是主 agent 输出，有的是子 agent 输出，这个能区分吗？"
// ACP 里没有答案（没有 subagent/parent 概念），于是只能读 Claude Code 的厂商专属键。
//
// ⚠️ **首版判据是错的，这里如实记下**：首版只认
// `_meta.claudeCode.toolResponse.agentType`，而当前适配器发出来的 `toolResponse` 根本**没有**
// `agentType`（三个日志文件里 `agentType` 出现 0 次；`toolResponse` 的实测形状只有
// `{elapsedTimeSeconds}` 与 Bash 的 `{stdout,stderr,interrupted,backgroundTaskId,…}`）
// —— 那是更早一次轮转日志里的另一种载荷。用户报"看不出有什么差异"，就是这个原因。
//
// **真正的判据是 `rawInput.subagent_type`**（委派调用的输入里就写着派给谁）：
// 实测 `Explore` / `Plan` / `story_editor`，三个日志里每次 Agent 调用都有它，
// 且它在**首帧** `tool_call` 上就位（不像 description 那样晚到）。
// 还额外认 `agentType`：那是更早那次载荷的形状，留着不花钱；两者都没有就当不是委派，绝不猜。
// [CUSTOM-END] CUSTOM-20261009-219
function latchSubagent(inv: ToolInvocation): void {
  if (inv.subagent) { return; }
  const found = subagentOf(inv.rawInput) ?? subagentOfMeta(inv.meta);
  if (found) { inv.subagent = found; }
}

/** [CUSTOM-20261009-219] `rawInput.subagent_type` —— 委派调用输入里的"派给谁"。 */
function subagentOf(rawInput: unknown): SubagentInfo | undefined {
  if (!rawInput || typeof rawInput !== 'object') { return undefined; }
  const value = (rawInput as { subagent_type?: unknown }).subagent_type;
  if (typeof value !== 'string' || value.trim().length === 0) { return undefined; }
  const info: SubagentInfo = { type: value.trim() };
  // [CUSTOM-20261009-222] 主 agent 派给它的指令也在这里（`rawInput.prompt`），取前 ~200 字进 tooltip。
  const prompt = (rawInput as { prompt?: unknown }).prompt;
  if (typeof prompt === 'string' && prompt.trim().length > 0) {
    const snippet = prompt.replace(/\s+/g, ' ').trim();
    info.prompt = snippet.length > 200 ? snippet.slice(0, 197) + '…' : snippet;
  }
  return info;
}

/** [CUSTOM-20261009-219] 更早一次载荷的形状（`_meta.claudeCode.toolResponse`），有就一起用。 */
function subagentOfMeta(meta: unknown): SubagentInfo | undefined {
  if (!meta || typeof meta !== 'object') { return undefined; }
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (!claudeCode || typeof claudeCode !== 'object') { return undefined; }
  const response = (claudeCode as { toolResponse?: unknown }).toolResponse;
  if (!response || typeof response !== 'object') { return undefined; }
  const r = response as {
    agentType?: unknown; agentId?: unknown; resolvedModel?: unknown;
    totalTokens?: unknown; totalDurationMs?: unknown;
  };
  // `agentType` 是判据：没有它就不是一次可识别的委派，整条 `_meta` 都不猜。
  if (typeof r.agentType !== 'string' || r.agentType.trim().length === 0) { return undefined; }
  const info: SubagentInfo = { type: r.agentType };
  if (typeof r.agentId === 'string' && r.agentId) { info.agentId = r.agentId; }
  if (typeof r.resolvedModel === 'string' && r.resolvedModel) { info.model = r.resolvedModel; }
  if (typeof r.totalTokens === 'number' && Number.isFinite(r.totalTokens)) { info.tokens = r.totalTokens; }
  if (typeof r.totalDurationMs === 'number' && Number.isFinite(r.totalDurationMs)) { info.durationMs = r.totalDurationMs; }
  return info;
}

/** [CUSTOM-20261009-221] `toolResponse.elapsedTimeSeconds` — 工具自己报的耗时，比 `endedAt - startedAt` 准。 */
function latchToolElapsed(inv: ToolInvocation): void {
  if (inv.toolElapsedSeconds !== undefined) { return; }
  if (!inv.meta || typeof inv.meta !== 'object') { return; }
  const claudeCode = (inv.meta as { claudeCode?: unknown }).claudeCode;
  if (!claudeCode || typeof claudeCode !== 'object') { return; }
  const response = (claudeCode as { toolResponse?: unknown }).toolResponse;
  if (!response || typeof response !== 'object') { return; }
  const value = (response as { elapsedTimeSeconds?: unknown }).elapsedTimeSeconds;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    inv.toolElapsedSeconds = value;
  }
}
