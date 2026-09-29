// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 扩展侧 transcript 的数据模型。与旧面板的关键差异：记录是**结构化**的（而非 DOM 字符串），
// 因此可以按会话存储、跨面板切换保活、并在 Phase 3 里把工具调用详情渲染成 diff / terminal。
// [CUSTOM-END] CUSTOM-20260923-011
// [CUSTOM-BEGIN] CUSTOM-20260924-020 - transcript 增加 `permission` 记录类型（面板内权限卡）。
// [CUSTOM-END] CUSTOM-20260924-020
import type { PermissionOptionKind, PlanEntry, ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

import type { ContentBlockView } from '../content/contentBlocks';

/** Why a plan/tool entry exists in the transcript. */
// [CUSTOM-BEGIN] CUSTOM-20260929-119 - `elicitation`：ACP 表单请求（AskUserQuestion 等）。
export type TranscriptEntryKind = 'user' | 'assistant' | 'thought' | 'tool' | 'plan' | 'content' | 'notice' | 'permission' | 'elicitation';
// [CUSTOM-END] CUSTOM-20260929-119

interface EntryBase {
  /** Stable id, unique within a session. Assigned by TranscriptStore. */
  id: string;
  /** Monotonic ms timestamp, used for ordering and nesting inference. */
  at: number;
}

export interface UserEntry extends EntryBase {
  kind: 'user';
  text: string;
  /**
   * [CUSTOM-20260928-108] 发送时带的图片附件（chip 视图模型）。
   * 不进 ACP 协议——它是宿主从 `handleSendPrompt` 传下来的渲染视图；
   * `attachments` 与 `imageData` 在发送后清空，气泡里的图片因此只存在 transcript 里。
   * Replay 路径不重建（`user_message_chunk` 的文本与非文本块分成两条 chunk 到达，
   * 而条目模型没有 messageId 可以把它关联回去；重建需要第二来源的关联，见 §5.25）。
   */
  attachments?: ContentBlockView[];
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
  /**
   * [CUSTOM-20260926-072] Rendered markdown, populated lazily via the same
   * `renderMarkdown` round-trip as an assistant bubble.
   *
   * Thoughts used to render as raw text, so the agent's own backticks and "- "
   * list markers showed up literally. Only set once the block has SETTLED: html
   * for a still-streaming block would freeze a prefix of the text.
   */
  html?: string;
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
  /**
   * [CUSTOM-20260926-073] 'switch' is a *presentation* level, not a severity: it
   * marks the centered divider-style line used for "Switched to <model>" (the
   * shape Claude's own panel uses for a model/mode change). It sits with info/warn/
   * error so the level stays the single field the client renders from.
   *
   * [CUSTOM-20260928-109] 'meta' marks a host-injected block that arrived as a
   * user chunk but is NOT user input (e.g. <task-notification>, <system-reminder>).
   * Rendered as a small centered gray line — no bubble, no icon, no blue.
   */
  level: 'info' | 'warn' | 'error' | 'switch' | 'meta';
  text: string;
}

// [CUSTOM-BEGIN] CUSTOM-20260924-020
/** One agent-offered choice in a permission prompt (ACP `PermissionOption`). */
export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/**
 * Where an answer to a permission prompt currently has to come from:
 * `pending` = the buttons on the card, `deferred` = a window-level dialog
 * (the card's buttons are disabled to keep one answer path), `selected` /
 * `cancelled` = settled.
 */
export type PermissionStatus = 'pending' | 'deferred' | 'selected' | 'cancelled';

/**
 * A permission card in the transcript. It lives next to the tool call it
 * belongs to (`toolCallId`) and is the panel-side replacement for the
 * window-level QuickPick that was easy to miss.
 */
export interface PermissionState {
  promptId: string;
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  options: PermissionOptionView[];
  status: PermissionStatus;
  selectedOptionId?: string;
}

export interface PermissionEntry extends EntryBase {
  kind: 'permission';
  permission: PermissionState;
}
// [CUSTOM-END] CUSTOM-20260924-020
// [CUSTOM-BEGIN] CUSTOM-20260929-119 - 表单卡（elicitation）。
// 与权限卡同一形态：一条 promptId 一条记录，状态由宿主推进；
// 客户端按 `fields` 渲染控件、把值收集起来回传（见 html/client/elicitationView.ts）。
export interface ElicitationEntry extends EntryBase {
  kind: 'elicitation';
  elicitation: import('../../../handlers/ElicitationBridge').ElicitationState;
}
// [CUSTOM-END] CUSTOM-20260929-119

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ThoughtEntry
  | ToolEntry
  | PlanEntryRecord
  | ContentEntry
  | NoticeEntry
  | PermissionEntry
  | ElicitationEntry;

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
  // [CUSTOM-20260925-038] 键名与记录字段名**必须逐字相同**（`PlanEntryRecord.entries` /
  // `ContentEntry.blocks`）。原先这里叫 `plan` / `content`，而客户端 `PATCH_KEYS` 抄的也是
  // 这两个名字，于是 patch 被写进 `entry.plan`，而渲染函数读的是 `entry.entries` ——
  // 更新**静默丢弃**（客户端 `patch()` 对未知键不报错），表现为 plan 卡永远停在第一次快照。
  // tsc / lint / webpack / check-webview-client 都看不见这类错位，所以这里刻意用与记录
  // 一样的名字，让「抄错名字」在阅读时就能被发现。
  /** Replacement plan entries (ACP `plan` updates replace the whole list). */
  entries?: PlanEntry[];
  /** Replacement content blocks (non-text message content). */
  blocks?: ContentBlockView[];
  /** Replacement permission state (CUSTOM-20260924-020). */
  permission?: PermissionState;
  // [CUSTOM-20260929-119] 表单卡的补丁键（键名必须与记录字段名逐字相同，见 PATCH_KEYS 的教训）。
  elicitation?: import('../../../handlers/ElicitationBridge').ElicitationState;
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
   * [CUSTOM-20260929-117] The agent's human-written description of the call
   * ("List files in the working directory"), latched by the store as soon as any
   * update carries one.
   *
   * Latched rather than read on demand, because the two places it travels do not
   * both survive: `rawInput` keeps the field across updates (a missing key leaves
   * the old value alone), but `_meta` is REPLACED wholesale on every update, so
   * `_meta.claudeCode.title` exists only in the one update that carries it —
   * reading it live would make the card title flicker back to the command line on
   * the next chunk.
   */
  description?: string;
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
