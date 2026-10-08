// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// postMessage 协议：**从第一天起就是 session 作用域的**——每一条会话相关的消息都同时携带
// agentName 与 sessionId，接收端校验二者匹配后才生效，绝不静默落到「当前聚焦会话」上。
// [CUSTOM-END] CUSTOM-20260923-011
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
// [CUSTOM-20261003-175] ACP SDK 1.x 删掉了 models API（说明见 core/SessionManager.ts 的同名注释）。
import type { LegacySessionModelState } from '../../core/SessionManager';

import type { EntryPatch, TranscriptEntry, TranscriptSnapshot } from './transcript/types';
import type { ToolCallView } from './content/toolCalls';
import type { HistoryDirOption } from './historyDirs';

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
  /**
   * [CUSTOM-20260925-063] The session produced output while it was NOT the
   * focused one — drives the tab-strip attention dot. A hint, never a
   * notification: nothing pops up and focus is never stolen.
   */
  unread: boolean;
  /**
   * [CUSTOM-20260930-130] A permission prompt or a form is parked on this session, so
   * nothing moves until the reader answers. Distinct from `running`: both are usually
   * true at once, and the tab dot paints them with two independent signals (colour vs.
   * the pulsing ring).
   */
  waiting: boolean;
}

/** Everything the panel needs to render one session's header + composer. */
export interface SessionMeta {
  sessionId: string;
  modes: SessionModeState | null;
  models: LegacySessionModelState | null;
  configOptions: SessionConfigOption[] | null;
  availableCommands: Array<{ name: string; description: string; inputHint?: string | null }>;
  usage: { used: number; size: number; costAmount?: number; costCurrency?: string } | null;
  /**
   * Pending attachments for this session. Carried on `meta` (and therefore on
   * `boot`/`focus`) so the chips survive a session switch rather than being
   * cleared client-side while the extension still holds them.
   */
  attachments: Attachment[];
  /**
   * [CUSTOM-20261004-187] The session's agent takes messages **mid-turn**
   * (`_session/steering`, advertised at handshake). The composer reads it to decide what
   * Enter does while a turn is running: send, or (unsupported) stay put and say so —
   * a silent no-op is what the user reported as "the input can't be sent any more".
   *
   * Optional, and **absent means unsupported**: the field is a capability the host may
   * not know yet (no connection, an older extension host), and guessing "supported"
   * would send a message into a hole.
   */
  steering?: boolean;
}

/** Incremental patch for an existing transcript entry (streaming text, status). */
export type { EntryPatch };

export interface Attachment {
  path: string;
  name: string;
  // [CUSTOM-BEGIN] CUSTOM-20260928-096 - 输入框图片：image 附件把字节留在宿主内存，
  // 只有 `path`（合成 id）+ `kind`/`mimeType` 走协议；base64 绝不进 meta（否则每次
  // boot/focus 都重发整张图）。
  kind?: 'file' | 'image';
  mimeType?: string;
  // [CUSTOM-END] CUSTOM-20260928-096
}

/** Webview UI prefs that must survive webview disposal (window reload / editor-panel
 *  recreation). Persisted in the extension host's `globalState`. */
export interface UiPrefs {
  outlineMode: 'popup' | 'sidebar';
  outlineWidth: number;
  // [CUSTOM-20261007-198] Tab 栏的手工顺序（会话 id 数组）。与大纲偏好共用**同一条**
  // globalState 记录：顺序是工作区级的事（两个面、两个窗口看到的是同一条），
  // 而 **不是**会话作用域的（`setUiPref` 因此仍在 verifySession 守卫之前处理）。
  tabOrder?: string[];
  // [CUSTOM-20261008-200] 记录区「Times」（每条记录的时刻）开关。**不是**一个布尔：
  //   · timesBySession 记用户**在那个会话里**最后一次拨动的值；
  //   · timesDefault 是用户最后一次在**任何地方**拨动的值 —— 没有记录的会话与草稿页用它。
  // 有效值 = timesBySession[id] ?? timesDefault。存在宿主而不是 webview 本地：关掉编辑器面板、
  // 重载窗口之后它还该在（vscode.setState 会随文档一起没），两个面也该看到同一条。
  timesBySession?: Record<string, boolean>;
  timesDefault?: boolean;
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
  /**
   * [CUSTOM-20260926-079] Normalized identity of `cwd` (see historyDirs.directoryKey).
   * Computed by the HOST because the identity depends on the platform (Windows and
   * macOS fold case, Linux does not) — the client only ever compares two keys, so
   * "are these the same folder" is answered in exactly one place.
   */
  dirKey?: string;
  /** ISO timestamp of the last activity, when the source reports one. */
  updatedAt?: string;
  /**
   * [CUSTOM-20260927-092] True for a row that came from the LOCAL CACHE alone — the
   * agent's `session/list` did not mention it (it omits sessions still open elsewhere,
   * measured). Rendered as an honest hint: such a row may no longer exist agent-side.
   */
  fromCache?: boolean;
  /**
   * [CUSTOM-20260927-094] True for a row recovered from the agent's OWN transcript
   * directory (Claude Code storage) — the agent's `session/list` did not report it, which
   * is exactly what the official panel reads instead. Same honesty rule as `fromCache`:
   * say where it came from, because it may still be open elsewhere.
   */
  fromDisk?: boolean;
}

/** extension → webview */
export type ExtToChat =
  // [CUSTOM-20260927-090] `agentConnected` drives the empty state's copy (and whether
  // its button is "Connect Claude Code" or "New session"): a sessionless panel can have
  // a live agent process — closing the last session does not stop it. Optional so an
  // older surface simply keeps the old copy.
  // [CUSTOM-20261008-199] `defaultCwd` 是「没有聚焦会话时地址栏该显示什么」的那份内容
  // （宿主 `resolveDefaultCwd()`：下次会话将建在这里）。随 boot 走而不是客户端自己猜：
  // 默认目录的三级回退（配置 → 第一个工作区文件夹 → cwd）只有宿主知道，且 058 的草稿页
  // 展示的是**同一份**值（pitfalls #19：同一份知识不要存两份）。
  | { type: 'boot'; focused: SessionSummary | null; sessions: SessionSummary[]; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null; agentConnected?: boolean; autoConnect?: boolean; defaultCwd?: string }
  | { type: 'focus'; summary: SessionSummary | null; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null; agentConnected?: boolean }
  | { type: 'sessionsChanged'; sessions: SessionSummary[]; agentConnected?: boolean }
  // [CUSTOM-20260926-077] 大纲钉住/宽度偏好，随 boot 一起带回（跨窗口重载存活）。
  // [CUSTOM-20261007-198] 外加 tab 栏的手工顺序（同一条记录）。
  // [CUSTOM-20261008-200] 外加 Times 的按会话记录 + 默认值（同一条记录）。
  | { type: 'uiPrefs'; outlineMode: 'popup' | 'sidebar'; outlineWidth: number; tabOrder?: string[]; timesBySession?: Record<string, boolean>; timesDefault?: boolean }
  // [CUSTOM-BEGIN] CUSTOM-20260925-033 - 历史会话列表（回复 `listHistory`）。
  // `source` 说明这份列表从哪来：agent 侧 `session/list`，还是本地 workspaceState 缓存
  // （未连接时不去 spawn agent，见 ChatPanelHost.handleListHistory）。
  // [CUSTOM-20260926-079] `directories` 是过滤器的候选目录（宿主按列表算出来的，
  // **只含列表里真实出现过的目录 + 当前会话的目录**）。客户端据此渲染 header 的 chip，
  // 并在本地按 `dirKey` 过滤——列表本来就在客户端，换目录不该再问一次 agent。
  // 其中 `current: true` 的那条就是"开启过滤时的默认目录"，所以不需要另开一个字段。
  | { type: 'history'; agentName: string; sessions: HistorySessionSummary[]; source: 'agent' | 'local' | 'merged'; directories?: HistoryDirOption[]; error?: string }
  // [CUSTOM-END] CUSTOM-20260925-033
  // [CUSTOM-BEGIN] CUSTOM-20260928-095 - 磁盘补充的增量应答（回复 `supplementHistory`）。
  // 客户端按 sessionId 合并进已有列表，不触发 setHistory 的全量替换（那会把 filterKey
  // 重置回 current 目录）。只回发起过滤的那个目录的磁盘会话。
  | { type: 'historySupplement'; agentName: string; cwd: string; sessions: HistorySessionSummary[] }
  // [CUSTOM-END] CUSTOM-20260928-095
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
  // [CUSTOM-BEGIN] CUSTOM-20260930-151 - 草稿页的输入卡要"显示完整"：模式/模型等配置项与
  // 斜杠命令在 ACP 里**都是会话级的**（`session/new` 只收 cwd/mcpServers，没有 mode/model
  // 入参），而草稿按定义还没有会话——所以回的是「该 agent 上一次会话的快照」（宿主缓存，
  // 见 ChatPanelHost.rememberAgentOptions）。快照只作候选与预选：创建会话时逐项按 id + 可选值
  // 校验后才下发，陈旧无害。
  // 定向发给发起请求的那个面（同 058 那四条——这是"某个文档正在编辑的草稿"）；
  // `draftId` 同样不能省：应答回来时用户可能已经换了草稿，客户端据它丢弃过期结果。
  | { type: 'draftOptions'; draftId: string; agentName: string | null; configOptions: SessionConfigOption[]; availableCommands: SessionMeta['availableCommands'] }
  // [CUSTOM-END] CUSTOM-20260930-151
  | { type: 'sessionClosed'; sessionId: string; reason: CloseReason }
  | { type: 'append'; sessionId: string; entries: WireEntry[] }
  | { type: 'revise'; sessionId: string; entryId: string; patch: EntryPatch }
  | { type: 'toolUpdate'; sessionId: string; entryId: string; tool: ToolCallView }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'attachments'; sessionId: string; attachments: Attachment[] }
  // [CUSTOM-BEGIN] CUSTOM-20260930-124 - 一次连接尝试的相位（状态卡用）。
  // **必须无条件回话**，这不是锦上添花：`refreshSessions` 靠签名去重（1867 行的 `conn:` 位），
  // 而 `ensureConnected` 在进程已经起来时不发任何事件 ⇒「已连接 + 无会话 + 点 Connect」
  // 这条路上宿主一条消息都不会发，客户端的「连接中」会**永久卡死**（pitfall #29 的形态：
  // 效果上没变化 ≠ 可以不回话）。
  // 没有 'disconnected'：断开方向由 `agentConnected` 单独表达，不设第二条真相（pitfall #19）。
  /**
   * [CUSTOM-20261006-194] `detail` 只在 `connecting` 时出现：agent 进程的 stderr 里最近一行
   * （最典型的是 npx 的 "…will be installed: …"）。用户卡在连接界面时，那一行才说明**为什么**在等
   * —— 此前它只进日志，卡片上永远只有一句 "Connecting…"。
   */
  | { type: 'connection'; state: 'connecting' | 'connected' | 'failed'; message?: string; detail?: string }
  // [CUSTOM-END] CUSTOM-20260930-124
  // [CUSTOM-BEGIN] CUSTOM-20260930-125 - 设置项 acpc.autoConnectOnOpen 的当前值。
  // 走**广播**：两个面渲染的是同一个开关，不能各显示各的。
  // 带在 boot 里的是**首屏值**（客户端要靠 {agentConnected, focused, autoConnect} 三者
  // 同时成立才布防自动连接，拆成两条消息就会出现半状态窗口），
  // 这条消息则负责**运行期**的变更（另一个面改了 / 用户在 Settings 里改了）。
  | { type: 'autoConnectPref'; value: boolean }
  // [CUSTOM-END] CUSTOM-20260930-125
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
  // [CUSTOM-20260926-077] 大纲钉住/宽度偏好：非会话作用域，宿主存 globalState。
  // [CUSTOM-20261007-198] 字段**全部可选**：两个写者（大纲、tab 顺序）各发自己那几个，
  // 由宿主**合并**（重建会把对方那一半抹掉）。缺的字段 = 这一轮没改它。
  // [CUSTOM-20261008-200] Times 同样走这条（第三个写者）：timesBySession 整份发上来
  // （与 tabOrder 同一形态 —— 顺序与开关都是"一整张表"，逐条 delta 反而要宿主维护版本）。
  | { type: 'setUiPref'; outlineMode?: 'popup' | 'sidebar'; outlineWidth?: number; tabOrder?: string[]; timesBySession?: Record<string, boolean>; timesDefault?: boolean }
  // [CUSTOM-20260930-125] 状态卡上的自动连接开关。**非会话作用域**（正是没有会话时
  // 才需要它），所以必须放在 verifySession 守卫**之前**处理，与 setUiPref 同一位置。
  | { type: 'setAutoConnect'; value: boolean }
  | { type: 'sendPrompt'; sessionId: string; text: string }
  | { type: 'cancelTurn'; sessionId: string }
  | { type: 'newSession'; agentName: string }
  // [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的两个新入口。
  // 都**不是会话作用域**（可能根本没有聚焦会话——正是要用它们的时候），
  // 因此必须在 verifySession 守卫**之前**处理。
  | { type: 'connectAgent'; agentName?: string }
  // [CUSTOM-20261001-155] `cwd` = 客户端**地址栏当前显示**的目录（草稿的目录在客户端，
  // 宿主猜不到，058）。宿主用它标记 `directories` 里 `current: true` 的候选，客户端据此
  // 把过滤器的默认目录设成它。缺省时宿主仍按自己的规则猜（见 historyFilterCwd）。
  | { type: 'listHistory'; agentName?: string; cwd?: string }
  // [CUSTOM-BEGIN] CUSTOM-20260928-095 - 按过滤目录补扫磁盘转录目录。094 的磁盘补充只扫
  // workspaceFolders[0]，多根/跨目录场景下扫错目录。客户端过滤到具体目录时请求，宿主
  // 扫该目录并增量返回（非会话作用域，在 verifySession 守卫之前处理）。
  | { type: 'supplementHistory'; agentName?: string; cwd: string }
  // [CUSTOM-END] CUSTOM-20260928-095
  // [CUSTOM-20260928-098/100] `title` rides along so the tab matches the list
  // immediately; `fromDraft` says the CLIENT was on a draft page (the host's
  // `focused` then names some other session, and it is the draft that must step
  // aside — a draft is client-local, 058).
  | { type: 'openHistorySession'; agentName: string; sessionId: string; cwd?: string; title?: string; fromDraft?: boolean }
  // [CUSTOM-END] CUSTOM-20260925-032/033
  // [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页与目录选择。
  // 三条都**不是**会话作用域：草稿按定义还没有 sessionId（那正是它存在的意义），
  // 所以它们必须和其他非会话作用域消息一样，在 `verifySession` 守卫**之前**处理（§5.4 规则二）。
  | { type: 'listDirectoryChoices'; agentName?: string }
  | { type: 'pickDirectory' }
  /**
   * [CUSTOM-20261005-193] 草稿页也可能带附件。
   *
   * 附件原本是**会话作用域**的（`attachPath`/`attachImage` 都带 sessionId，宿主按会话存），
   * 而草稿还没有会话 —— 于是"新建会话页粘一张图"在客户端就被拒了（`attachImage` 里那句
   * "no session is focused"），图片根本发不出去。做法是让**首条消息**把附件一起带上：
   * 客户端在草稿上先本地攒着（它展示 chip），发送时随这条消息交给宿主，宿主建完会话再按
   * 常规通道（`handleAttachImage` / `handleAttachPaths`）落账 —— 与已有会话走同一条路。
   */
  | {
    type: 'createDraftAndSend'; draftId: string; agentName?: string; cwd?: string; text: string;
    configSelections?: Array<{ configId: string; value: string }>;
    images?: Array<{ id: string; name: string; mimeType: string; dataUrl: string }>;
    paths?: string[];
  }
  // [CUSTOM-END] CUSTOM-20260925-058
  // [CUSTOM-BEGIN] CUSTOM-20260930-151 - 草稿页要"显示完整"：问宿主有没有该 agent 上一次会话
  // 的配置项/命令快照（草稿还没有 session，这些在 ACP 里只存在于会话上）。
  // 与 058 那三条同区：**不是**会话作用域（草稿按定义没有 sessionId），必须在
  // `verifySession` 守卫**之前**处理（§5.4 规则二）。
  | { type: 'listDraftOptions'; draftId: string; agentName?: string }
  // @remarks `agentName` 与 `createDraftAndSend` 的一样，是"可选的偏好"而不是必填：草稿是**纯
  // 客户端状态**，客户端其实不知道 agent。两条消息必须由宿主用**同一个** `panelAgent()` 解析
  // （草稿页出现在屏幕上时，宿主手上的聚焦会话往往是别的那个），否则会出现"显示 A 的模型、
  // 建的是 B 的会话"——而那种错配在应用阶段会被逐项校验静默丢掉。
  // [CUSTOM-END] CUSTOM-20260930-151
  | { type: 'closeSession'; sessionId: string }
  | { type: 'focusSession'; sessionId: string }
  | { type: 'focusAgent'; agentName: string }
  | { type: 'detachFile'; sessionId: string; path: string }
  // [CUSTOM-20260925-049] Files dropped onto / pasted into the panel. Session
  // scoped, so it MUST be handled after the `verifySession` guard (§5.4 rule 1).
  | { type: 'attachPath'; sessionId: string; paths: string[] }
  // [CUSTOM-BEGIN] CUSTOM-20260928-096 - 输入框图片：粘贴/拖入的位图无路径，只能把
  // base64 带上。会话作用域（verifySession 守卫之后，同 attachPath）。`id` 由客户端
  // 生成（合成附件 id），宿主用它作附件 `path` 并把字节存进 imageData。
  | { type: 'attachImage'; sessionId: string; id: string; name: string; mimeType: string; dataUrl: string }
  // [CUSTOM-END] CUSTOM-20260928-096
  | { type: 'setMode'; sessionId: string; modeId: string }
  | { type: 'setModel'; sessionId: string; modelId: string }
  | { type: 'setConfigOption'; sessionId: string; configId: string; value: string }
  | { type: 'renderMarkdown'; items: Array<{ entryId: string; sessionId: string; text: string; key?: string }> }
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
// [CUSTOM-20260929-119] 表单（elicitation）的回答。同样是**会话作用域**，必须放在 verifySession
// 守卫之后处理（放前面会被静默丢弃，那是 permission 踩过的坑）。
// `accept` 带收集到的字段值；`decline` = 用户跳过（轮次继续）；`cancel` = 放弃（工具调用中止）。
// 字段值的类型与 ACP 的 `ElicitationContentValue` 一致。
| {
    type: 'elicitationAnswer';
    sessionId: string;
    promptId: string;
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, string | number | boolean | string[]>;
  }
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
  items: Array<{ entryId: string; sessionId: string; html: string; key?: string }>;
}

/** Anything the extension may post to the webview. */
export type ExtToChatMessage = ExtToChat | MarkdownRendered;

export type { TranscriptEntry, TranscriptSnapshot };
