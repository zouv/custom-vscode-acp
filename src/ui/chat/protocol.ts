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

/** One entry of the panel's history picker (agent-side list or local cache). */
export interface HistorySessionSummary {
  sessionId: string;
  title?: string | null;
  cwd?: string;
  /** ISO timestamp of the last activity, when the source reports one. */
  updatedAt?: string;
}

/** extension → webview */
export type ExtToChat =
  | { type: 'boot'; focused: SessionSummary | null; sessions: SessionSummary[]; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null }
  | { type: 'focus'; summary: SessionSummary | null; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null }
  | { type: 'sessionsChanged'; sessions: SessionSummary[] }
  // [CUSTOM-BEGIN] CUSTOM-20260925-033 - 历史会话列表（回复 `listHistory`）。
  // `source` 说明这份列表从哪来：agent 侧 `session/list`，还是本地 workspaceState 缓存
  // （未连接时不去 spawn agent，见 ChatPanelHost.handleListHistory）。
  | { type: 'history'; agentName: string; sessions: HistorySessionSummary[]; source: 'agent' | 'local'; error?: string }
  // [CUSTOM-END] CUSTOM-20260925-033
  // [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页与目录选择的应答。
  // 四条都**定向**发给发起请求的那个面（`post(msg, to)` 会绕开合帧队列），
  // 因为它们是"某个文档正在编辑的东西"，广播会让另一个面也长出同一个草稿。
  | { type: 'directoryChoices'; agentName: string | null; workspaceFolders: string[]; recent: string[]; defaultCwd: string }
  | { type: 'directoryPicked'; path: string | null }
  // `draftId` 是**相关性 id，不能省**：`createSession` 会连带触发
  // `session-created → sessionsChanged → focus`，靠"收到一个新 focus 就删草稿"
  // 在慢路径/失败路径上会留下孤儿草稿或误删。
  | { type: 'draftResolved'; draftId: string; sessionId: string }
  | { type: 'draftFailed'; draftId: string; message: string }
  // [CUSTOM-END] CUSTOM-20260925-058
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
  // [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的两个新入口。
  // 都**不是会话作用域**（可能根本没有聚焦会话——正是要用它们的时候），
  // 因此必须在 verifySession 守卫**之前**处理。
  | { type: 'connectAgent'; agentName?: string }
  | { type: 'listHistory'; agentName?: string }
  | { type: 'openHistorySession'; agentName: string; sessionId: string; cwd?: string }
  // [CUSTOM-END] CUSTOM-20260925-032/033
  // [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页与目录选择。
  // 三条都**不是**会话作用域：草稿按定义还没有 sessionId（那正是它存在的意义），
  // 所以它们必须和其他非会话作用域消息一样，在 `verifySession` 守卫**之前**处理（§5.4 规则二）。
  | { type: 'listDirectoryChoices'; agentName?: string }
  | { type: 'pickDirectory' }
  | { type: 'createDraftAndSend'; draftId: string; agentName?: string; cwd?: string; text: string }
  // [CUSTOM-END] CUSTOM-20260925-058
  | { type: 'closeSession'; sessionId: string }
  | { type: 'focusSession'; sessionId: string }
  | { type: 'focusAgent'; agentName: string }
  | { type: 'detachFile'; sessionId: string; path: string }
  // [CUSTOM-20260925-049] Files dropped onto / pasted into the panel. Session
  // scoped, so it MUST be handled after the `verifySession` guard (§5.4 rule 1).
  | { type: 'attachPath'; sessionId: string; paths: string[] }
  | { type: 'setMode'; sessionId: string; modeId: string }
  | { type: 'setModel'; sessionId: string; modelId: string }
  | { type: 'setConfigOption'; sessionId: string; configId: string; value: string }
  | { type: 'renderMarkdown'; items: Array<{ entryId: string; sessionId: string; text: string }> }
  | { type: 'openLink'; href: string }
  | { type: 'openFile'; sessionId: string; path: string; line?: number }
  | { type: 'openTerminal'; sessionId: string; terminalId: string }
  | { type: 'copy'; text: string }
  // [CUSTOM-BEGIN] CUSTOM-20260925-029 - webview 控制台 → 扩展侧输出通道的日志桥。
  // **非会话作用域**（不带 sessionId），所以必须在 verifySession 守卫**之前**处理。
  // 存在理由：webview 的 console 只有打开 Webview DevTools 才看得到，而"界面为什么不对"
  // 的排查每次都卡在这上面（027 的空壳工具卡就是这样，线索只存在于没人看的 console 里）。
  | { type: 'clientLog'; level: 'info' | 'warn' | 'error'; message: string }
  // [CUSTOM-END] CUSTOM-20260925-029
  // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 面板内权限卡的回答。会话作用域：
  // 必须走 verifySession 守卫（在它**之后**处理），否则会被静默丢弃。
  // `optionId` 缺省表示取消/关闭。
  | { type: 'permissionAnswer'; sessionId: string; promptId: string; optionId?: string }
  // [CUSTOM-END] CUSTOM-20260924-020
  // [CUSTOM-BEGIN] CUSTOM-20260924-027 - 客户端报告「这张工具卡没有 view model」，
  // 扩展侧收到后重发一次视图模型。会话作用域（走 verifySession 守卫之后）。
  // 存在的意义：卡片第一次落地时若没带上视图模型，会渲染成一个空壳，而 `updateTool`
  // 只能打补丁、修不了空壳——用户看到的就是"工具调用没有显示"。与其猜数据在哪一侧丢，
  // 不如让客户端主动要一次。
  | { type: 'needToolView'; sessionId: string; entryId: string; toolCallId: string }
  // [CUSTOM-END] CUSTOM-20260924-027
  | { type: 'executeCommand'; command: string };

/** extension → webview reply to `renderMarkdown`. */
export interface MarkdownRendered {
  type: 'markdownRendered';
  items: Array<{ entryId: string; sessionId: string; html: string }>;
}

/** Anything the extension may post to the webview. */
export type ExtToChatMessage = ExtToChat | MarkdownRendered;

export type { TranscriptEntry, TranscriptSnapshot };
