// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 扩展侧 transcript 的数据模型。与旧面板的关键差异：记录是**结构化**的（而非 DOM 字符串），
// 因此可以按会话存储、跨面板切换保活、并在 Phase 3 里把工具调用详情渲染成 diff / terminal。
// [CUSTOM-END] CUSTOM-20260923-011
import type { PlanEntry, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

import type { ContentBlockView } from '../content/contentBlocks';

/** Why a plan/tool entry exists in the transcript. */
export type TranscriptEntryKind = 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'content' | 'notice';

interface EntryBase {
  /** Stable id, unique within a session. Assigned by TranscriptStore. */
  id: string;
  /** Monotonic ms timestamp, used for ordering and nesting inference. */
  at: number;
}

export interface UserEntry extends EntryBase {
  kind: 'user';
  text: string;
}

export interface AssistantEntry extends EntryBase {
  kind: 'assistant';
  text: string;
  /** Rendered HTML, populated lazily via the `renderMarkdown` round-trip. */
  html?: string;
  /** ACP `ContentChunk.messageId` when the agent supplies it (@experimental). */
  messageId?: string;
  streaming: boolean;
}

export interface ThoughtEntry extends EntryBase {
  kind: 'thought';
  text: string;
  messageId?: string;
  streaming: boolean;
  /** Wall-clock duration, filled in when the thought block is finalized. */
  elapsedMs?: number;
}

export interface ToolEntry extends EntryBase {
  kind: 'tool';
  toolCallId: string;
}

export interface PlanEntryRecord extends EntryBase {
  kind: 'plan';
  entries: PlanEntry[];
}

/**
 * Non-text content the agent sent in a message chunk (image / audio /
 * resource_link / embedded resource). Rendering it as a transcript entry —
 * rather than a `[image content]` placeholder — is what makes those blocks
 * actually visible.
 */
export interface ContentEntry extends EntryBase {
  kind: 'content';
  blocks: ContentBlockView[];
}

export interface NoticeEntry extends EntryBase {
  kind: 'notice';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThoughtEntry
  | ToolEntry
  | PlanEntryRecord
  | ContentEntry
  | NoticeEntry;

/** Full snapshot of one session's transcript, sent on focus/boot. */
export interface TranscriptSnapshot {
  sessionId: string;
  agentName: string;
  entries: TranscriptEntry[];
}

/**
 * Mutable subset shared by the entries that receive in-place updates. Declared
 * explicitly rather than as `Partial<AssistantEntry & ThoughtEntry>` — that
 * intersection collapses `kind` to `never` and poisons every property.
 */
export interface EntryPatch {
  text?: string;
  html?: string;
  streaming?: boolean;
  elapsedMs?: number;
  /** Replacement plan entries (ACP `plan` updates replace the whole list). */
  plan?: PlanEntry[];
  /** Replacement content blocks (non-text message content). */
  content?: ContentBlockView[];
}

/**
 * View model for a single ACP tool call. Mirrors `ToolCall` / `ToolCallUpdate`
 * with the spec's replace-collection semantics applied (see
 * ToolInvocationStore.upsert).
 */
export interface ToolInvocation {
  toolCallId: string;
  title: string;
  kind: ToolKind | undefined;
  status: ToolCallStatus | undefined;
  /** Raw ACP content blocks (diff / terminal / content) — rendered in Phase 3. */
  content: unknown[];
  locations: Array<{ path: string; line?: number | null }>;
  rawInput: unknown;
  rawOutput: unknown;
  /**
   * ACP `_meta` for this tool call. Vendor-specific and typed `unknown`, but
   * it is one of the few places an agent could put an explicit parent link —
   * so the nesting strategy searches it.
   */
  meta?: unknown;
  startedAt: number;
  endedAt?: number;
  /** Nesting parent, set by a NestingStrategy (Phase 4). */
  parentId?: string;
  /** True when the parent/child link was inferred rather than reported. */
  inferredParent?: boolean;
}

/** ACP `ToolCallStatus` values that mean the call is over. */
export function isTerminalStatus(status: ToolCallStatus | undefined): boolean {
  return status === 'completed' || status === 'failed';
}
