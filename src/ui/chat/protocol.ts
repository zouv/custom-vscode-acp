// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// postMessage 协议：**从第一天起就是 session 作用域的**——每一条会话相关的消息都同时携带
// agentName 与 sessionId，接收端校验二者匹配后才生效，绝不静默落到「当前聚焦会话」上。
// [CUSTOM-END] CUSTOM-20260923-011
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

import type { EntryPatch, TranscriptEntry, TranscriptSnapshot } from './transcript/types';
import type { ToolCallView } from './content/toolCalls';

/** Why a session left the live set (mirrors SessionManager.SessionCloseReason). */
export type CloseReason = 'user' | 'agent-disconnected';

/** Compact per-session summary used to render tabs without a full snapshot. */
export interface SessionSummary {
  sessionId: string;
  agentName: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  /** Replay-in-progress flag (`session/load`). */
  loading: boolean;
  /** A prompt turn is running. */
  running: boolean;
}

/** Everything the panel needs to render one session's header + composer. */
export interface SessionMeta {
  sessionId: string;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
  availableCommands: Array<{ name: string; description: string; inputHint?: string | null }>;
  usage: { used: number; size: number; costAmount?: number; costCurrency?: string } | null;
  /**
   * Pending attachments for this session. Carried on `meta` (and therefore on
   * `boot`/`focus`) so the chips survive a session switch rather than being
   * cleared client-side while the extension still holds them.
   */
  attachments: Attachment[];
}

/** Incremental patch for an existing transcript entry (streaming text, status). */
export type { EntryPatch };

export interface Attachment {
  path: string;
  name: string;
}

/**
 * A transcript entry as sent over the wire. Tool entries carry no payload of
 * their own (the transcript only knows the `toolCallId`), so the extension
 * attaches the rendered view model alongside.
 */
export type WireEntry = TranscriptEntry & { toolView?: ToolCallView };

/** extension → webview */
export type ExtToChat =
  | { type: 'boot'; focused: SessionSummary | null; sessions: SessionSummary[]; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null }
  | { type: 'focus'; summary: SessionSummary | null; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null }
  | { type: 'sessionsChanged'; sessions: SessionSummary[] }
  | { type: 'sessionClosed'; sessionId: string; reason: CloseReason }
  | { type: 'append'; sessionId: string; entries: WireEntry[] }
  | { type: 'revise'; sessionId: string; entryId: string; patch: EntryPatch }
  | { type: 'toolUpdate'; sessionId: string; entryId: string; tool: ToolCallView }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'attachments'; sessionId: string; attachments: Attachment[] }
  | { type: 'error'; sessionId?: string; message: string };

/** Snapshot variant carrying wire entries. */
export interface TranscriptSnapshotWire {
  sessionId: string;
  agentName: string;
  entries: WireEntry[];
}

/** webview → extension */
export type ChatToExt =
  | { type: 'ready' }
  | { type: 'sendPrompt'; sessionId: string; text: string }
  | { type: 'cancelTurn'; sessionId: string }
  | { type: 'newSession'; agentName: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'focusSession'; sessionId: string }
  | { type: 'focusAgent'; agentName: string }
  | { type: 'detachFile'; sessionId: string; path: string }
  | { type: 'setMode'; sessionId: string; modeId: string }
  | { type: 'setModel'; sessionId: string; modelId: string }
  | { type: 'setConfigOption'; sessionId: string; configId: string; value: string }
  | { type: 'renderMarkdown'; items: Array<{ entryId: string; sessionId: string; text: string }> }
  | { type: 'openLink'; href: string }
  | { type: 'openFile'; sessionId: string; path: string; line?: number }
  | { type: 'openTerminal'; sessionId: string; terminalId: string }
  | { type: 'copy'; text: string }
  | { type: 'executeCommand'; command: string };

/** extension → webview reply to `renderMarkdown`. */
export interface MarkdownRendered {
  type: 'markdownRendered';
  items: Array<{ entryId: string; sessionId: string; html: string }>;
}

/** Anything the extension may post to the webview. */
export type ExtToChatMessage = ExtToChat | MarkdownRendered;

export type { TranscriptEntry, TranscriptSnapshot };
