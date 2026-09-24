// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 工具调用视图模型的索引，严格实现 ACP 的 replace-collection 语义：
// ToolCallUpdate 的 `content` / `locations` 是**整体替换**而非合并（SDK 文档明写），
// `title` / `status` 是 string|null，null 表示「保留原值」。
// 平坦映射（toolCallId → 调用）永远是地面真相；嵌套关系由 Phase 4 的 NestingStrategy 事后推断。
// [CUSTOM-END] CUSTOM-20260923-011
import type { ToolCall, ToolCallStatus, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';

import { isTerminalStatus, type ToolInvocation } from './types';

/**
 * Per-session tool-call index. Flat by construction — ACP has no nesting
 * concept (verified: zero matches for parent/subagent/child across all 239
 * schema definitions), so any tree is an inference layered on top.
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

    this.put(sessionId, inv);
    return inv;
  }

  get(sessionId: string, toolCallId: string): ToolInvocation | undefined {
    return this.bySession.get(sessionId)?.get(toolCallId);
  }

  list(sessionId: string): ToolInvocation[] {
    const m = this.bySession.get(sessionId);
    return m ? Array.from(m.values()).sort((a, b) => a.startedAt - b.startedAt) : [];
  }

  drop(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  dropAgentSessions(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) { this.bySession.delete(id); }
  }

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
