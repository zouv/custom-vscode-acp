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
//   · 两个 surface（侧边栏视图 / 编辑区面板）共享本实例：`post()` 广播、`boot` 只回给发起者
//     （CUSTOM-20260924-019，见 ChatSurface.ts）。
// [CUSTOM-END] CUSTOM-20260923-011
import * as vscode from 'vscode';

import type { ContentBlock, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';

import type { SessionManager, SessionInfo } from '../../core/SessionManager';
import type { SessionUpdateHandler, SessionUpdateListener } from '../../handlers/SessionUpdateHandler';
import { log } from '../../utils/Logger';
import { renderChatHtml, createNonce } from './html';
import { SafeMarkdown } from './markdown';
// [CUSTOM-20261009-216] 回放里文件引用是一段文本（`[@名](file:///…)`），得先认出来。
import { fileMentionViews } from './markdown';
import { Outbox } from './Outbox';
import type {
  Attachment,
  ChatToExt,
  CloseReason,
  ExtToChat,
  ExtToChatMessage,
  MarkdownRendered,
  RecoverableSession,
  RestoreChoice,
  SessionMeta,
  SessionSummary,
  TranscriptSnapshotWire,
  UiPrefs,
} from './protocol';
import type { IChatPanel, PanelContext } from './panelContract';
import { isModernAgent, MODERN_AGENTS } from './panelContract';
import { viewSurface, type ChatSurface, type SurfaceKey } from './ChatSurface';
// [CUSTOM-20261001-156] 会话状态通知（等待权限 / 等待表单 / 轮次完成）。宿主只认这个类型，
// 测试塞假 channel；真实的 vscode 通知调用在下面（vscodeNoticeChannel —— 本文件不 import 它
// 到 SessionNotifier 里去，那边必须保持不依赖 vscode）。
import { SessionNotifier } from './SessionNotifier';
import type { NoticeChannel } from './SessionNotifier';
import type { PermissionPresenter, PermissionState } from '../../handlers/PermissionBridge';
// [CUSTOM-20260929-119] 表单（elicitation）presenter —— 与权限卡同构。
import type {
  ElicitationPresenter,
  ElicitationState,
  ElicitationAction,
  ElicitationContent,
} from '../../handlers/ElicitationBridge';
import { PermissionBridge } from '../../handlers/PermissionBridge';
import { ElicitationBridge } from '../../handlers/ElicitationBridge';
import { TranscriptStore } from './transcript/TranscriptStore';
import { ToolInvocationStore } from './transcript/ToolInvocationStore';
import { toToolCallView } from './content/toolCalls';
import { toContentView, hasVisibleContent } from './content/contentBlocks';
import type { ContentBlockView } from './content/contentBlocks';
import { resolveNestingStrategy } from './nesting/NestingStrategy';
import {
  choiceChanges,
  choiceSnapshotFromState,
  choiceSnapshotPatched,
  selectValues,
  type ChoiceSnapshot,
} from './sessionChoices';
// [CUSTOM-20260926-079] The history picker's directory filter: `directoryKey` /
// `directoryOptions` are pure and unit-tested; `folderName` replaces the local
// `basename` (same "last path segment" idea the client's folderName implements, and
// two copies of it here is exactly how they drift — pitfalls #19).
import { directoryKey, directoryOptions, folderName as basename } from './historyDirs';
import { CLAUDE_CODE_AGENT, claudeTranscriptDir, readDiskSessions, readTranscriptTimes, readTranscriptUserAttachments } from './diskSessions';
import type { TranscriptUserParts } from './diskSessions';
import type { HistorySessionSummary } from './protocol';

/** Prefix of the output channel used for panel-level diagnostics. */
const LOG_PREFIX = 'chat-panel';

/**
 * [CUSTOM-20260924-022] Message types that must NEVER be delayed or merged.
 *
 * INV-C: `sessionsChanged` drives the Send/Stop button — a late one leaves a
 * stale `Send` after the turn already started.
 * INV-D: `sessionClosed` must remove its tab immediately.
 * `boot`/`focus` are full snapshots and are always preceded by a flush, so they
 * can never arrive before an append they already contain (INV-E).
 */
const STRUCTURAL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'boot', 'focus', 'sessionsChanged', 'sessionClosed', 'meta', 'attachments', 'error',
  // [CUSTOM-20260930-124] 连接相位必须立即发：它会被 `focus`（连接成功且有会话时紧随其后）
  // 语义性覆盖，排进合帧队列就可能反过来、让客户端多开一张草稿。
  'connection',
]);

/** [CUSTOM-20260926-077] globalState key for the outline pin/width prefs. */
const UI_PREFS_KEY = 'acpc.outlinePrefs.v1';

// [CUSTOM-BEGIN] CUSTOM-20260930-151 - 草稿页的配置项/命令快照，按 agent 存。
// 为什么要持久化：VS Code 重载后宿主内存里的活动会话**全没了**，而"全新窗口点 + 时输入卡
// 还是只有输入框"正是用户报的那个现象——只存内存等于默认路径上不生效。
const DRAFT_OPTIONS_KEY = 'acpc.draftOptions.v1';

/** One agent's last-seen composer options (see ChatPanelHost.rememberAgentOptions). */
interface AgentOptionSnapshot {
  configOptions: SessionConfigOption[];
  availableCommands: SessionMeta['availableCommands'];
}

/** The persisted shape: agent name → snapshot. */
type DraftOptionsStore = Record<string, AgentOptionSnapshot>;
// [CUSTOM-END] CUSTOM-20260930-151

// [CUSTOM-BEGIN] CUSTOM-20261001-159 - 记住用户手动选过的模式，新建会话时套用。
//
// 为什么要**按 agent** 分开：模式是各 agent 自己的词表（Claude Code 的
// `bypassPermissions` 对别的 agent 毫无意义），按会话记则等于没记（新建会话正是要跨会话）。
//
// 为什么存在 globalState 而不是内存：重载窗口后内存里什么都不剩，而"新开会话又回到默认模式"
// 正是这个功能要消灭的现象（与 `acpc.draftOptions.v1` 同一条理由）。
const LAST_MODE_KEY = 'acpc.lastMode.v1';

/** One agent's remembered mode: the config option id and the value the user picked. */
interface RememberedMode {
  configId: string;
  value: string;
}

/** The persisted shape: agent name → remembered mode. */
type LastModeStore = Record<string, RememberedMode>;
// [CUSTOM-END] CUSTOM-20261001-159

/**
 * [CUSTOM-20260930-125] The setting behind the start card's auto-connect switch.
 * Declared in package.json, rendered as a checkbox by the panel — so a change made
 * in either place has to reach the other (see the configuration listener below).
 */
const AUTO_CONNECT_KEY = 'acpc.autoConnectOnOpen';
// [CUSTOM-20261009-209] 「上次打开过的会话」快照（globalState）：重载/关闭重开后问一句要不要恢复它们。
const OPEN_SESSIONS_KEY = 'acpc.openSessions.v1';
const RESTORE_KEY = 'acpc.restoreSessionsOnOpen';
/** [CUSTOM-20261009-209] 快照写入的防抖：它挂在 created/closed/focus 三个事件上。 */
const SNAPSHOT_DEBOUNCE_MS = 300;

// [CUSTOM-BEGIN] CUSTOM-20261009-212 - 历史列表的本地覆盖（改名 / 归档）。
// 一份按 sessionId 记的账（globalState）：**任何来源**的行都能被改 —— agent 列的 / 本地
// 缓存的 / 转录目录补出来的。不写进 SessionHistoryStore 有两个理由：它只覆盖本地那一段
// （agent / disk 行不在里面），而且它的 memento key 是冻结的（architecture §4 铁律 2）。
// 归档 = 历史列表里不再出现；改名 = 列表 / tab / 树上的标题换成这个名字（覆盖优先于
// agent 的 session_info_update）。
const SESSION_LABELS_KEY = 'acpc.sessionLabels.v1';
interface SessionLabelOverride {
  title?: string;
  archived?: boolean;
}
// [CUSTOM-END] CUSTOM-20261009-212

export class ChatPanelHost implements IChatPanel, PermissionPresenter, ElicitationPresenter {
  readonly id = 'modern' as const;

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 单视图 → 多 surface（侧边栏 + 编辑区）。
  // 状态仍然只有这一份，两个面读同一个 store；`post()` 默认广播，两边自动同源。
  // `lastActive` 只用于「把某个面提到前面」（附件 chip），不参与路由决策。
  private readonly surfaces = new Map<SurfaceKey, ChatSurface>();
  private lastActive: SurfaceKey | null = null;
  /**
   * [CUSTOM-20261006-194] 正在连接中（postConnection('connecting') 之后、'connected'/'failed' 之前）。
   * 只用来决定"agent 的 stderr 要不要往卡片上送" —— 连接好了以后的 stderr 是噪声。
   */
  private connecting = false;
  // [CUSTOM-END] CUSTOM-20260924-019

  private readonly transcripts = new TranscriptStore();
  private readonly tools = new ToolInvocationStore();
  private readonly markdown = new SafeMarkdown();

  /** sessionId → pending attachments (resource_link blocks for the next prompt). */
  private readonly attachments: Map<string, Attachment[]> = new Map();
  // [CUSTOM-20260928-096] sessionId → attachmentId → image 字节（base64 + mimeType）。
  // 字节只留宿主内存、不进 meta（否则每次 boot/focus 都重发整张图）；发送时据此拼
  // ACP `image` ContentBlock。
  private readonly imageData: Map<string, Map<string, { data: string; mimeType: string }>> = new Map();
  /**
   * [CUSTOM-20261004-185] sessionId → 上下文占用，渲染成输入卡右下角那颗圆环。
   *
   * **只有一个写入者：`usage_update`**（`used` = 当前上下文 token 数，`size` = 窗口大小）。
   * 曾经还有一个 `applyResponseUsage` 把 `PromptResponse.usage.totalTokens` 折进 `used` ——
   * 那是**单位张冠李戴**：协议里 `Usage.totalTokens` 是 *Sum of all token types across session*
   * （claude-agent-acp 实现为每轮 `+= input/output/cache_read/cache_write`，cache read 每轮都重算），
   * 是个只增不减的累计量，而 `size` 是窗口大小 ⇒ 长会话必然出现 `1841k / 1000k`。
   * 它当初的理由是"没发 usage_update 的 agent 也能有读数"，但那**不成立**：没有 usage_update
   * 就没有 `size`，`renderContext` 在 `!size` 时直接隐藏 —— 那个分支唯一能做到的事就是把
   * 已经正确的读数改坏。要再引入"会话累计 token"，请**另开字段**，别复用 `used`。
   */
  private readonly usage: Map<string, SessionMeta['usage']> = new Map();
  /** `${sessionId}::${toolCallId}` → transcript entry id. */
  private readonly toolEntryIds: Map<string, string> = new Map();
  /** sessionId → entry id of the single plan card (ACP replaces the list). */
  private readonly planEntryIds: Map<string, string> = new Map();
  // [CUSTOM-20260925-063] Sessions that produced output while they were NOT the
  // focused one. Surfaced as the tab-strip "attention" dot, which is a HINT and
  // never a notification: no dialog, no focus stealing.
  private readonly unread: Set<string> = new Set();
  // [CUSTOM-20260926-073] sessionId → last known switchable state (mode + config
  // options), for the "Switched to <model>" notice. The cache is written ONLY here
  // (never read back from SessionManager at diff time), because the two paths that
  // report a change — our own setter and the agent's `*_update` notification — race
  // against SessionManager's listener order. Whatever lands first announces, and
  // the other one diffs to nothing: that is the de-duplication, by construction.
  private readonly choices: Map<string, ChoiceSnapshot> = new Map();
  // [CUSTOM-20260926-075] sessionId → last known title, for the rename notice.
  // Same "the cache is ours" rule as `choices`: SessionManager may already have
  // applied the new title by the time our listener runs, so its copy cannot tell us
  // what the OLD one was.
  private readonly sessionTitles: Map<string, string> = new Map();
  // [CUSTOM-20260928-100] sessionId → (replay messageId → real epoch ms), read from the
  // agent's transcript BEFORE a replay starts. ACP carries no per-message time, so
  // without this every record of a reopened conversation is stamped `Date.now()` and
  // the outline shows one identical second for a conversation spanning an hour.
  private readonly replayTimes: Map<string, Map<string, number>> = new Map();
  // [CUSTOM-20260928-111] sessionId → (messageId → 图片视图)。replay 把图片并回用户气泡
  // （100 的教训：文本与非文本块分成两条 chunk 到达，气泡里没有可合并的东西）。
  // [CUSTOM-20261009-216] 文件引用一并收在这里（它们连到同一批块），外加"这条消息有没有正文"
  // ——附件 chunk 该丢还是该自己渲染，判据是它（见 diskSessions.TranscriptUserParts）。
  private readonly replayUserParts: Map<string, Map<string, TranscriptUserParts>> = new Map();
  /**
   * [CUSTOM-20261008-205] IDE 上下文块（`<ide_opened_file>`）按「会话::messageId」暂存，
   * 等**同一条消息**的正文 chunk 到了再挂到那个气泡上（回放里两条 chunk 同 messageId，
   * 而代码顺序不保证 —— 用 messageId 配对就不必赌顺序）。见 user_message_chunk 分支。
   */
  private readonly ideFilesByMessage: Map<string, ContentBlockView> = new Map();
  /** [CUSTOM-20261008-206] 上一次推给客户端的"编辑器当前文件"签名（选区每次移动都会回调）。 */
  private activeFileSignature: string | null = null;
  // [CUSTOM-20261009-209] 会话恢复：上次退出时开着的会话（globalState 里的快照）+ 本次是否已经答复过。
  private openSessions: OpenSessionsSnapshot | null = null;
  private restoreDismissed = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本生命周期里出现过会话吗 —— 只有出现过，才允许把快照写成空表（启动时的空态会把它抹掉）。 */
  private sawLiveSession = false;

  private focused: PanelContext = { agentName: null, sessionId: null };
  // [CUSTOM-20261001-156] 会话状态通知（等待权限 / 等待表单 / 轮次完成）。默认实现打到
  // vscode 通知；测试注入假的。分配放在 ctor 体内而不是参数属性：默认值要用 `this`
  // （点击回调 = revealSession）。
  private readonly notifier: SessionNotifier;
  /** [CUSTOM-20261001-156] 每会话的轮次序号，只用来给 turn-done 通知一个稳定去重键。 */
  private readonly turnSeq: Map<string, number> = new Map();
  /** [CUSTOM-20260926-077] Outline pin/width prefs, cached from globalState. */
  private uiPrefs: UiPrefs | null = null;
  // [CUSTOM-20260930-151] agent → 它最后一次会话的配置项/命令快照（草稿页拿它渲染输入卡）。
  // 只由 rememberAgentOptions 写；**不是**可写状态——用户真正生效的那份永远在 SessionManager。
  private readonly draftOptions: Map<string, AgentOptionSnapshot> = new Map();

  // [CUSTOM-20261001-159] agent → 用户最后一次**手动**选的模式（新建会话时套用）。
  // 只由 rememberUserMode 写（三个用户动作的落点），从不读 agent 自己的切换。
  private readonly lastMode: Map<string, RememberedMode> = new Map();
  // [CUSTOM-20261001-159] `session-created('new')` 启动的那次应用，按会话挂着：
  // 草稿页在自己的显式选择之前要先 `await` 它落地，否则两个 setConfigOption 谁后到谁赢
  // （用户刚选的模式可能被"默认模式"盖回去）。
  private readonly modeApply: Map<string, Promise<void>> = new Map();

  // [CUSTOM-20261001-162] 轮次之外还在干活的后台子任务（见 noteBackgroundTask）。
  // 存在的理由：`running` 原本只看"轮次请求还没返回"，而 Claude Code 的后台子任务（Task 工具
  // 带 run_in_background）**在轮次结束后继续干活**——它一停，面板就把发送按钮变回普通状态，
  // 用户看到的就是"活还在跑，按钮却复原了"。
  private readonly backgroundTasks: Map<string, NodeJS.Timeout> = new Map();

  // [CUSTOM-20261001-164] 会话标题在"第二次发言"时冻结（见 trackTitle）。
  // 为什么不是"最新那个"：adapter 每轮结束去拉 SDK 标题（`maybeUpdateSessionTitle`），而 SDK
  // 的后台生成可能几轮之后才落盘 ⇒ 那些标题描述的是"聊了几轮之后的主题"，不是这次会话的名字。
  private readonly titleFrozen = new Set<string>();
  /** 已经跑完过至少一轮的会话 —— 冻结的判据（第二次发言时它一定在里面）。 */
  private readonly turnsDone = new Set<string>();

  // [CUSTOM-BEGIN] CUSTOM-20260924-022 - 合帧队列 + 标签栏快照签名（见 refreshSessions）。
  private readonly outbox: Outbox;
  private lastSessionsSignature: string | null = null;
  // [CUSTOM-END] CUSTOM-20260924-022

  private readonly updateListener: SessionUpdateListener;
  private readonly subscriptions: vscode.Disposable[] = [];
  // [CUSTOM-20260925-041] Held so dispose() can UNREGISTER the listener. The
  // legacy provider does this (ChatWebviewProvider.dispose ->
  // removeListener) while this host only ever added one, leaving the
  // registration to be swept up by SessionUpdateHandler.dispose() — correct by
  // accident, not by contract.
  private readonly sessionUpdateHandler: SessionUpdateHandler;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
    private readonly permissionBridge?: PermissionBridge,
    // [CUSTOM-20260926-077] globalState for UI prefs that survive webview disposal.
    private readonly globalState?: vscode.Memento,
    // [CUSTOM-20260929-119] 表单桥（晚绑定失败时的兜底同权限桥）。
    private readonly elicitationBridge?: ElicitationBridge,
    // [CUSTOM-20260930-125] settings 读写缝。注入而不是直接调 vscode.workspace：
    // 测试 harness 刻意不碰真实用户设置（见 chat-panel.test.ts 的 FakeMemento 注释），
    // 而写 ConfigurationTarget.Global 会改掉开发者的 settings.json。
    private readonly prefs: PanelPrefsIO = vscodePanelPrefs(),
    // [CUSTOM-20261001-156] 通知渠道（默认 = vscode 通知）。注入缝的理由与 prefs 相同：
    // 测试不该真的弹系统通知（会被测试宿主吞掉且无法断言）。注入的是 channel 而不是
    // SessionNotifier——这样"点击通知 → 聚焦会话"这条真路径（revealSession）也在被测范围里。
    private readonly noticeChannel: NoticeChannel = vscodeNoticeChannel(),
    // [CUSTOM-20261001-162] 后台子任务"多久没动静就不再等"（见 noteBackgroundTask）。
    // 测试会把它调到毫秒级；默认两分钟——比实测看到的最长静默间隔（57s）宽裕一倍。
    private readonly backgroundQuietMs: number = 120_000,
  ) {
    this.notifier = new SessionNotifier(this.noticeChannel,
      // 显式用户动作（点了通知）：可以抢焦点、把面板抬到前台。
      notice => this.revealSession(notice.sessionId, notice.label),
    );
    this.sessionUpdateHandler = sessionUpdateHandler;
    this.uiPrefs = this.globalState?.get<UiPrefs>(UI_PREFS_KEY) ?? null;
    // [CUSTOM-20261009-209] 上一次退出时开着的会话（可能是上一次进程留下的 —— 本次还没人写它）。
    this.openSessions = this.globalState?.get<OpenSessionsSnapshot>(OPEN_SESSIONS_KEY) ?? null;
    // [CUSTOM-20260930-151] 草稿页的配置项/命令快照（重载窗口后仍可用）。
    const storedOptions = this.globalState?.get<DraftOptionsStore>(DRAFT_OPTIONS_KEY) ?? {};
    for (const agentName of Object.keys(storedOptions)) {
      const snapshot = storedOptions[agentName];
      if (!snapshot) { continue; }
      this.draftOptions.set(agentName, {
        configOptions: snapshot.configOptions ?? [],
        availableCommands: snapshot.availableCommands ?? [],
      });
    }
    // [CUSTOM-20261001-159] 记住的模式（重载窗口后仍然生效）。
    const storedModes = this.globalState?.get<LastModeStore>(LAST_MODE_KEY) ?? {};
    for (const agentName of Object.keys(storedModes)) {
      const entry = storedModes[agentName];
      if (entry && typeof entry.configId === 'string' && typeof entry.value === 'string') {
        this.lastMode.set(agentName, { configId: entry.configId, value: entry.value });
      }
    }
    // The host IS the permission presenter for the modern panel: no other
    // object knows whether a surface is on screen and which session is focused.
    this.permissionBridge?.setPresenter(this);
    this.elicitationBridge?.setPresenter(this);
    // [CUSTOM-20260924-022] One frame of coalescing for order-coupled messages.
    this.outbox = new Outbox({
      send: message => this.postNow(message),
      log: message => log(`${LOG_PREFIX}: ${message}`),
    });
    this.updateListener = (update: SessionNotification) => this.onSessionUpdate(update);
    this.sessionUpdateHandler.addListener(this.updateListener);

    const refresh = () => this.refreshSessions();
    const on = (event: string, handler: (...args: any[]) => void) => {
      this.sessionManager.on(event, handler);
      this.subscriptions.push({ dispose: () => this.sessionManager.off(event, handler) });
    };

    // [CUSTOM-20261006-194] agent 的 stderr → 连接卡片（只在连接中显示，见 noteAgentStderr）。
    on('agent-stderr', (evt: { line?: string }) => this.noteAgentStderr(evt?.line ?? ''));

    on('session-created', (sessionId: string, _agentName: string, origin?: string) => {
      // [CUSTOM-20260930-151] 会话一建好就把它的配置项/命令收进草稿页快照——下一次点「+」用的
      // 就是这一份。
      this.rememberAgentOptions(sessionId);
      // [CUSTOM-20261009-209] 快照跟着"开着哪些会话"变（重载后要按它恢复）。
      this.sawLiveSession = true;
      this.saveOpenSessions();
      refresh();
      // [CUSTOM-20261001-159] 只有**新建**的会话套用记住的模式。打开历史（load）/恢复（resume）
      // 走的是同一个事件：那个会话有自己的模式，那是"重新打开它"的一部分，覆盖掉就是改坏它。
      // `undefined`（更老的调用方、测试直接 emit）按"不是新建"处理——宁可不动，也别在该不动时动。
      if (origin === 'new') {
        const applied = this.applyRememberedMode(sessionId);
        this.modeApply.set(sessionId, applied);
      }
    });
    on('session-closed', (sessionId: string, _agentName: string, reason: CloseReason) => {
      // Release everything keyed by this session, then tell the client so a
      // closed tab disappears immediately rather than waiting for the focus
      // change that follows.
      this.saveOpenSessions();
      this.transcripts.drop(sessionId);
      this.tools.drop(sessionId);
      this.attachments.delete(sessionId);
      this.imageData.delete(sessionId);
      this.replayTimes.delete(sessionId);
      this.replayUserParts.delete(sessionId);
      for (const key of Array.from(this.ideFilesByMessage.keys())) {
        if (key.startsWith(`${sessionId}::`)) { this.ideFilesByMessage.delete(key); }
      }
      this.usage.delete(sessionId);
      this.planEntryIds.delete(sessionId);
      // [CUSTOM-20260926-073] Session ids are never reused, so a stale switch
      // baseline could only ever suppress the first notice of a new session.
      this.choices.delete(sessionId);
      this.sessionTitles.delete(sessionId);
      // [CUSTOM-20261001-156] Its notification keys can never fire again.
      this.notifier.forget(sessionId);
      this.turnSeq.delete(sessionId);
      // [CUSTOM-20261001-159] …and a mode application that never got awaited.
      this.modeApply.delete(sessionId);
      // [CUSTOM-20261001-162] …and any wait on a background task of this session.
      this.endBackgroundTask(sessionId, 'closed');
      // [CUSTOM-20261001-164] Session ids are never reused: drop the title bookkeeping too.
      this.titleFrozen.delete(sessionId);
      this.turnsDone.delete(sessionId);
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
    on('session-load-end', (sessionId: string) => {
      // [CUSTOM-20260925-055] A replay is a FINITE recorded stream, so once it
      // ends nothing can still be streaming — but nothing else closes the
      // entries it created: `finalizeTurn` only runs for a prompt WE sent, and a
      // `session/load` is not one. Left open, the trailing assistant entry keeps
      // the client in its streaming state forever and pins `aria-busy` to true,
      // which silently mutes the screen reader. (Found by
      // src/test/chat-panel.test.ts against a real captured replay.)
      this.finalizeEntries(sessionId);
      // [CUSTOM-20260930-151] `loadSession` 把 configOptions 写进 placeholder 是在
      // `session-created` **之后**（而且不走 applyConfigOptions）—— 不在这儿再记一次的话，
      // 打开一个历史会话会把草稿页快照的配置项清成空，用户点「+」就又看不到模式/模型了。
      this.rememberAgentOptions(sessionId);
      refresh();
    });
    on('active-session-changed', (sessionId: string | null, agentName: string | null) => {
      // The router owns focus decisions, but a focus change originating from
      // elsewhere (e.g. the tree) must still reach an attached panel.
      this.focused = { agentName, sessionId };
      // [CUSTOM-20260925-063] Focusing a session consumes its unread marker, and
      // the strip has to be told — otherwise the attention dot lingers.
      if (sessionId) { this.unread.delete(sessionId); }
      this.saveOpenSessions();
      this.pushFocus();
      this.refreshSessions();
    });

    // [CUSTOM-20260930-151] 配置项 / 可用命令一变就刷新草稿页快照。挂在 SessionManager 的
    // 事件上而不是 pushMeta 里：pushMeta 在"没有 surface attach"或"不是聚焦会话"时会提前
    // return，后台会话的变化就进不了快照——而那正是下一次草稿页要用的那份。
    //
    // 隐藏依赖（查过才敢写）：这两个事件之所以会响，是因为**旧面板**（ChatWebviewProvider）
    // 的 listener 调用了 `applyConfigOptions` / `applyAvailableCommands`，而它是这两者的唯一
    // 调用者（ChatWebviewProvider.ts:132/138；新版子系统的斜杠命令本来就靠它）。哪天旧面板改成
    // 惰性创建，快照会**静默停止更新**（现代面板的斜杠补全也会一起坏）。
    on('config-options-changed', (sessionId: string) => this.rememberAgentOptions(sessionId));
    on('available-commands-changed', (sessionId: string) => this.rememberAgentOptions(sessionId));

    // [CUSTOM-20260930-125] 本仓库第一次用 onDidChangeConfiguration。理由不是"同步方便"：
    // 面板把这个配置项**渲染成了一个控件**，控件显示过期值就是在撒谎（与 pitfalls #29 同族）。
    // 只认一个 key，disposable 进 subscriptions —— dispose() 已经统一释放它们。
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(AUTO_CONNECT_KEY)) { this.postAutoConnectPref(); }
        if (e.affectsConfiguration(RESTORE_KEY)) { this.postRestorePref(); }
      }),
    );
    // [CUSTOM-20261008-206] 编辑器里"当前打开的文件/选区"→ 输入框的引用栏（见 pushActiveFile）。
    // 选中变化**每次光标移动都会回调**，所以推送那边按签名去重（叠成行区间之后，同一行里动就不发）。
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.pushActiveFile()),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) { this.pushActiveFile(); }
      }),
    );
  }

  // --- IChatPanel ----------------------------------------------------------

  attach(view: vscode.WebviewView, ctx: PanelContext): void {
    this.attachSurface(viewSurface(view), ctx);
  }

  /**
   * [CUSTOM-20260924-019] Attach (or re-attach) one surface. The same entry
   * point serves the sidebar view and the editor panel, so the HTML is rendered
   * per document — each webview needs its own CSP nonce and its own
   * `cspSource`, which is why the html string is never shared between surfaces.
   */
  attachSurface(surface: ChatSurface, ctx: PanelContext): void {
    this.surfaces.set(surface.key, surface);
    // [CUSTOM-20261008-206] 新面立刻拿到编辑器当前文件（签名是全局的，这里必须 force）。
    this.pushActiveFile(true);
    this.lastActive = surface.key;
    this.focused = ctx;
    surface.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    surface.setHtml(renderChatHtml(surface.webview, createNonce(), surface.key));
    // Targeted: a broadcast boot would force the OTHER document to reset and
    // re-hydrate (losing its scroll position) every time a surface attaches.
    this.pushBoot(surface.key);
  }

  detach(): void {
    this.detachSurface('view');
  }

  detachSurface(key: SurfaceKey): void {
    this.surfaces.delete(key);
    if (this.lastActive === key) {
      this.lastActive = this.surfaces.keys().next().value ?? null;
    }
    // [CUSTOM-20260924-020] Last surface gone: any permission card still
    // waiting for a click is now unreachable, and the agent is blocked on it.
    // The bridge moves those prompts to the dialog instead of hanging.
    if (this.attachedCount === 0) {
      this.permissionBridge?.onPresenterLost();
      // [CUSTOM-20260929-119] 表单同理：没有面能画，就退回弹框，别让 agent 干等。
      this.elicitationBridge?.onPresenterLost();
    }
    // [CUSTOM-END] CUSTOM-20260924-020
  }

  /** Zero means there is nowhere to render; every push must bail out. */
  private get attachedCount(): number {
    return this.surfaces.size;
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
    this.addAttachments(sessionId, [{ path: uri.fsPath, name: basename(uri.fsPath) }]);
    // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 提到「最近交互过的面」而不是固定的侧边栏视图。
    // 旧写法 `view?.show?.(true)` 对 WebviewPanel 会静默失效（面板没有 `show`），
    // 表现为附件 chip 不显示也不报错。
    const surface = this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
    surface?.reveal(true);
    // [CUSTOM-END] CUSTOM-20260924-019
  }

  /**
   * [CUSTOM-20260925-049] Add attachments to a session's pending list.
   *
   * Extracted from `attachFile` so the drag-and-drop path can share it — that
   * path must NOT reveal a surface, because the drop already happened on a
   * visible one and raising another panel would steal focus for no reason.
   */
  private addAttachments(sessionId: string, incoming: Attachment[]): void {
    const list = this.attachments.get(sessionId) ?? [];
    for (const attachment of incoming) {
      // [CUSTOM-20261008-207] 去重按**引用**而不是按路径：同一个文件可以引用**多段**
      // （`foo.cs:12-40` 与 `foo.cs:5-9` 是两条引用，用户明确要求）。拖拽/粘贴没有区间，
      // 于是它们仍然按路径去重（同一条路径拖两次只留一份）。
      if (!list.some(existing => sameReference(existing, attachment))) { list.push(attachment); }
    }
    this.attachments.set(sessionId, list);
    this.post({ type: 'attachments', sessionId, attachments: list });
  }

  /** Files dropped onto (or pasted into) the panel. */
  private handleAttachPaths(sessionId: string, paths: unknown, meta?: unknown): void {
    if (!Array.isArray(paths)) { return; }
    const labels = Array.isArray(meta) ? (meta as Array<{ name?: unknown; lineStart?: unknown; lineEnd?: unknown }>) : [];
    const incoming: Attachment[] = [];
    for (let i = 0; i < paths.length; i++) {
      const raw = paths[i];
      if (typeof raw !== 'string' || raw.length === 0) { continue; }
      const m = labels[i] ?? {};
      const lineStart = typeof m.lineStart === 'number' ? m.lineStart : undefined;
      const lineEnd = typeof m.lineEnd === 'number' ? m.lineEnd : undefined;
      // [CUSTOM-20261008-206] 显示名优先用调用方给的（编辑器那条带行区间），否则 basename。
      const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : basename(raw);
      incoming.push({ path: raw, name, ...(lineStart ? { lineStart, lineEnd } : {}) });
    }
    if (incoming.length === 0) { return; }
    this.addAttachments(sessionId, incoming);
    log(`${LOG_PREFIX}: attached ${incoming.length} dropped/pasted file(s) to ${sessionId}`);
  }

  // [CUSTOM-20260928-096] 剪贴板/拖入的位图：剥离 data URL 前缀后把 base64 存进 imageData，
  // 附件列表里只放轻量 chip（path=合成 id）。发送时由 handleSendPrompt 拼成 image 块。
  private handleAttachImage(sessionId: string, id: string, name: string, mimeType: string, dataUrl: string): void {
    if (!id) { return; }
    const data = stripDataUrlPrefix(dataUrl);
    if (!data) {
      log(`${LOG_PREFIX}: attachImage dropped ${id}: no base64 payload`);
      return;
    }
    let map = this.imageData.get(sessionId);
    if (!map) { map = new Map(); this.imageData.set(sessionId, map); }
    map.set(id, { data, mimeType });
    this.addAttachments(sessionId, [{ path: id, name, kind: 'image', mimeType }]);
    log(`${LOG_PREFIX}: attached image ${id} to ${sessionId}`);
  }

  onMessage(message: unknown, from: SurfaceKey = 'view'): void {
    const msg = message as Partial<ChatToExt> & { type?: string };
    if (!msg || typeof msg.type !== 'string') { return; }
    this.lastActive = from;

    switch (msg.type) {
      case 'ready':
        this.pushBoot(from);
        return;
      case 'newSession': {
        // [CUSTOM-BEGIN] CUSTOM-20260924-024 - 修「+ 按钮点了没反应」。
        // 原先这里调 `connectToAgent(agentName)`，而它的语义是**已有会话就复用**
        // （SessionManager.connectToAgent：liveIds.length > 0 时只 focusSession），
        // 于是「开新会话」在有会话时退化成「聚焦已有会话」。开新会话必须走
        // newConversation → createSession —— 那才是 010 引入的原子操作。
        const agentName = (msg as { agentName?: string }).agentName ?? this.focused.agentName;
        if (!agentName) {
          this.reportError(null, new Error(
            'No agent to start a session with. Connect one in the Agents view first.'));
          return;
        }
        void this.sessionManager.newConversation(agentName).catch(e => this.reportError(null, e));
        return;
        // [CUSTOM-END] CUSTOM-20260924-024
      }
      case 'focusAgent': {
        const agentName = (msg as { agentName?: string }).agentName;
        if (!agentName) { return; }
        const ids = this.sessionManager.getSessionIdsForAgent(agentName);
        const next = ids[ids.length - 1];
        if (next) { this.sessionManager.focusSession(next); }
        return;
      }

      // [CUSTOM-BEGIN] CUSTOM-20260925-032/033 - 面板内的「连接」与「历史会话」。
      // 都按设计不带 sessionId（要用它们时往往根本没有聚焦会话），所以在守卫之前处理。
      case 'connectAgent': {
        this.handleConnectAgent((msg as { agentName?: string }).agentName);
        return;
      }
      case 'listHistory': {
        void this.handleListHistory(
          (msg as { agentName?: string }).agentName,
          // [CUSTOM-20261001-155] The directory the CLIENT's address bar is showing —
          // the only correct source for a draft page (drafts are client-local, 058).
          (msg as { cwd?: string }).cwd,
        );
        return;
      }
      // [CUSTOM-BEGIN] CUSTOM-20260928-095 - 按过滤目录补扫磁盘（非会话作用域，守卫前）。
      case 'supplementHistory': {
        void this.handleSupplementHistory(
          (msg as { agentName?: string }).agentName,
          (msg as { cwd?: string }).cwd ?? '',
        );
        return;
      }
      // [CUSTOM-END] CUSTOM-20260928-095
      // [CUSTOM-20261009-209] 会话恢复的三条（都非会话作用域：快照里的会话此刻都还没活）。
      case 'startRestore': {
        // 「开始恢复」：快照**留着**（下一次重载还要用），本次不再问了 —— 客户端负责建那些"未加载"的
        // 本地 tab（懒恢复：点开才 load）。宿主这边只做一件事：把**上次聚焦的那条**现在就加载起来，
        // 好让面板一恢复就有内容（那也正是用户刚刚在看的那个会话）。
        const snapshot = this.openSessions;
        const sessions = snapshot?.sessions ?? [];
        const target = snapshot?.focused && sessions.some(s => s.sessionId === snapshot.focused)
          ? snapshot.focused
          : sessions[0]?.sessionId;
        this.restoreDismissed = true;
        log(`${LOG_PREFIX}: restoring the open-session snapshot (${sessions.length} tab(s), loading ${target ?? 'none'} now)`);
        if (target) {
          const entry = sessions.find(s => s.sessionId === target);
          if (entry) { void this.openSnapshotSession(entry); }
        }
        return;
      }
      case 'dismissSessions':
        // 「开始新的」：用户不要这些 tab 了 —— 清掉快照，别再拿它问。
        this.restoreDismissed = true;
        this.openSessions = null;
        this.globalState?.update(OPEN_SESSIONS_KEY, undefined);
        log(`${LOG_PREFIX}: open-session snapshot dismissed`);
        return;
      case 'forgetRestorable': {
        const sessionId = (msg as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === 'string' && this.openSessions) {
          this.openSessions = {
            ...this.openSessions,
            sessions: this.openSessions.sessions.filter(s => s.sessionId !== sessionId),
          };
          this.globalState?.update(OPEN_SESSIONS_KEY, this.openSessions);
        }
        return;
      }
      // [CUSTOM-BEGIN] CUSTOM-20261009-212 - 历史列表的归档 / 改名（会话 tab 右键菜单的 Rename
      // 走同一条 `renameSession`）。两条都**必须**在会话守卫之前：列表里的行大多不是活会话，
      // verifySession 只认 live 的，放在守卫后会整条丢掉。
      // 动作由宿主做（改名走原生输入框 —— webview 里没有等价控件），做完回一条 `sessionAction`
      // 让客户端**就地**更新列表；不重发整份 history，因为那会重置用户选的目录过滤。
      case 'archiveSession': {
        const id = (msg as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !id) { return; }
        void this.updateSessionLabel(id, { archived: true }).then(() => {
          this.post({ type: 'sessionAction', action: 'archive', sessionId: id });
        });
        return;
      }
      case 'renameSession': {
        const id = (msg as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !id) { return; }
        const current = (msg as { currentTitle?: unknown }).currentTitle;
        void this.handleRenameSession(id, typeof current === 'string' ? current : '');
        return;
      }
      // [CUSTOM-END] CUSTOM-20261009-212
      case 'setRestorePref':
        void this.handleSetRestorePref((msg as { value?: unknown }).value);
        return;
      case 'openHistorySession': {
        void this.handleOpenHistorySession(
          (msg as { agentName?: string }).agentName ?? '',
          (msg as { sessionId?: string }).sessionId ?? '',
          // [CUSTOM-20260925-057] The row carries the session's own directory;
          // see handleOpenHistorySession for why it matters.
          (msg as { cwd?: string }).cwd || undefined,
          // [CUSTOM-20260928-098] And its title, so the tab matches the list.
          (msg as { title?: string }).title || undefined,
          // [CUSTOM-20260928-100] The CLIENT was on a draft page: that draft is what
          // steps aside, not the session the host still has focused.
          !!(msg as { fromDraft?: boolean }).fromDraft,
          // [CUSTOM-20261009-209] 恢复多个会话时：**别**关掉当前聚焦的那个（099 的替换语义不适用）。
          !!(msg as { keepOthers?: boolean }).keepOthers,
        );
        return;
      }
      // [CUSTOM-END] CUSTOM-20260925-032/033

      // [CUSTOM-BEGIN] CUSTOM-20260925-058 - 草稿页：同样按设计不带 sessionId
      // （草稿就是"还没有会话"），所以在守卫之前处理。
      case 'listDirectoryChoices':
        void this.handleListDirectoryChoices((msg as { agentName?: string }).agentName, from);
        return;
      case 'pickDirectory':
        void this.handlePickDirectory(from);
        return;
      case 'createDraftAndSend':
        void this.handleCreateDraftAndSend(
          (msg as { draftId?: string }).draftId ?? '',
          (msg as { agentName?: string }).agentName,
          (msg as { cwd?: string }).cwd,
          (msg as { text?: string }).text ?? '',
          (msg as { configSelections?: Array<{ configId: string; value: string }> }).configSelections ?? [],
          // [CUSTOM-20261005-193] 草稿页攒下的附件（草稿还没有会话，客户端先本地拿着）。
          (msg as { images?: Array<{ id: string; name: string; mimeType: string; dataUrl: string }> }).images ?? [],
          (msg as { paths?: string[] }).paths ?? [],
          from,
        );
        return;
      // [CUSTOM-20260930-151] 草稿页的输入卡该显示什么（模式/模型/命令）。同区、同样不带
      // sessionId —— 放守卫之后会被静默丢弃（§5.4 规则二）。
      case 'listDraftOptions':
        this.handleListDraftOptions(
          (msg as { agentName?: string }).agentName,
          (msg as { draftId?: string }).draftId ?? '',
          from,
        );
        return;
      // [CUSTOM-END] CUSTOM-20260925-058

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
      // [CUSTOM-20260925-029] NOT session-scoped: forward to the output channel.
      case 'clientLog': {
        const level = (msg as { level?: string }).level ?? 'info';
        const text = (msg as { message?: string }).message ?? '';
        log(`${LOG_PREFIX}: client(${level}): ${text}`);
        return;
      }
      // [CUSTOM-END] CUSTOM-20260925-029
      // [CUSTOM-20260926-077] Outline pin/width prefs: NOT session-scoped, persist
      // to globalState so they survive webview disposal (window reload / editor panel).
      case 'setUiPref': {
        // [CUSTOM-20261007-198] **合并**而不是重建。原先这里按消息里的字段重建整个对象 ——
        // 那时只有一个写者（大纲）。现在有了第二个（tab 手工顺序），重建会把对方那一半抹掉
        // （同一条记录两个写者 = 后到的赢，而"赢"的代价是另一项被重置）。
        const previous = this.uiPrefs ?? { outlineMode: 'popup' as const, outlineWidth: 240 };
        const mode = (msg as { outlineMode?: unknown }).outlineMode;
        const outlineWidth = Number((msg as { outlineWidth?: unknown }).outlineWidth);
        const tabOrder = (msg as { tabOrder?: unknown }).tabOrder;
        // [CUSTOM-20261008-200] Times（第三个写者，同一条记录）：整份表 + 一个默认值。
        const timesBySession = (msg as { timesBySession?: unknown }).timesBySession;
        const timesDefault = (msg as { timesDefault?: unknown }).timesDefault;
        // [CUSTOM-20261008-204] 大纲侧栏的"按会话开/关"（第四个写者，同一形状）。
        const outlineOpenBySession = (msg as { outlineOpenBySession?: unknown }).outlineOpenBySession;
        const outlineOpenDefault = (msg as { outlineOpenDefault?: unknown }).outlineOpenDefault;
        const next: UiPrefs = {
          outlineMode: mode === undefined
            ? previous.outlineMode
            : (mode === 'sidebar' ? 'sidebar' : 'popup'),
          outlineWidth: Number.isFinite(outlineWidth) ? outlineWidth : previous.outlineWidth,
        };
        // 缺的字段 = 这一轮没改它 ⇒ 保留上一次的值。**从没写过的**那一项不落进记录里
        // （undefined 键会让 globalState 里那条记录读起来像"写过但没值"，也会让断言多出一堆噪声）。
        const order = tabOrder === undefined ? previous.tabOrder : sanitizeTabOrder(tabOrder);
        if (order !== undefined) { next.tabOrder = order; }
        const times = timesBySession === undefined ? previous.timesBySession : sanitizeSessionFlags(timesBySession);
        if (times !== undefined) { next.timesBySession = times; }
        const def = timesDefault === undefined ? previous.timesDefault : timesDefault === true;
        if (def !== undefined) { next.timesDefault = def; }
        const openMap = outlineOpenBySession === undefined
          ? previous.outlineOpenBySession
          : sanitizeSessionFlags(outlineOpenBySession);
        if (openMap !== undefined) { next.outlineOpenBySession = openMap; }
        const openDef = outlineOpenDefault === undefined ? previous.outlineOpenDefault : outlineOpenDefault === true;
        if (openDef !== undefined) { next.outlineOpenDefault = openDef; }
        this.uiPrefs = next;
        this.globalState?.update(UI_PREFS_KEY, this.uiPrefs);
        // [CUSTOM-20261007-198] 另外那个面（侧边栏 / 编辑区）也要跟着换序，否则它下次被重开
        // 之前会一直用旧顺序 —— 同一份偏好，两个写者，必须回话（pitfall #29 的老规矩）。
        this.post({ type: 'uiPrefs', ...this.uiPrefs });
        return;
      }
      // [CUSTOM-20260930-125] The start card's auto-connect switch. NOT session-scoped
      // (the switch is exactly what you reach for when there is no session), so it is
      // handled here, before the verifySession guard (§5.4 rule 2).
      case 'setAutoConnect': {
        void this.handleSetAutoConnect((msg as { value?: unknown }).value === true);
        return;
      }
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
        // [CUSTOM-20260926-080] `force` — an explicit request from the client must
        // ALWAYS be answered.
        //
        // `SessionManager.focusSession` early-returns when the id is already active
        // (it emits only on a CHANGE), and the host's `focused` is not what the
        // client is showing: **drafts are client-local** (058), so the panel can be
        // sitting on a draft page while our `focused` already names this very
        // session. Without `force` the click produced no event, hence no `focus`
        // reply — and the panel stayed on the draft with a tab that "does nothing".
        // (Same idiom the manager itself uses for the user-visible focus changes of
        // newConversation / loadSession / resume.)
        this.sessionManager.focusSession(sessionId, { force: true });
        return;
      case 'detachFile': {
        const path = (msg as { path?: string }).path;
        // [CUSTOM-20261008-207] 带区间 = 只摘那一段（同一个文件的多段引用各自能删）；不带 = 整条路径
        // 全摘（拖拽/粘贴的 chip 没有区间，行为不变）。
        const start = (msg as { lineStart?: unknown }).lineStart;
        const end = (msg as { lineEnd?: unknown }).lineEnd;
        const ranged = typeof start === 'number';
        const list = (this.attachments.get(sessionId) ?? []).filter(a => ranged
          ? !(a.path === path && (a.lineStart ?? 0) === start && (a.lineEnd ?? 0) === (typeof end === 'number' ? end : start))
          : a.path !== path);
        this.attachments.set(sessionId, list);
        if (path) { this.imageData.get(sessionId)?.delete(path); }
        this.post({ type: 'attachments', sessionId, attachments: list });
        return;
      }
      // [CUSTOM-20260925-049] Session-scoped: sits AFTER the guard above.
      case 'attachPath':
        this.handleAttachPaths(
          sessionId,
          (msg as { paths?: unknown }).paths,
          // [CUSTOM-20261008-206] 与 paths 平行的显示名/行区间（只有"编辑器当前文件"那条带）。
          (msg as { meta?: unknown }).meta,
        );
        return;
      // [CUSTOM-END] CUSTOM-20260925-049
      // [CUSTOM-BEGIN] CUSTOM-20260928-096 - 输入框图片：会话作用域，守卫之后（同 attachPath）。
      case 'attachImage':
        this.handleAttachImage(
          sessionId,
          (msg as { id?: string }).id ?? '',
          (msg as { name?: string }).name ?? 'image',
          (msg as { mimeType?: string }).mimeType ?? 'image/png',
          (msg as { dataUrl?: string }).dataUrl ?? '',
        );
        return;
      // [CUSTOM-END] CUSTOM-20260928-096
      case 'setMode':
        void this.sessionManager.setMode(sessionId, (msg as { modeId: string }).modeId)
          // [CUSTOM-20260926-073] Announce the switch in the transcript, not just in
          // the picker: the record is what a reader scrolls back through.
          // [CUSTOM-20261001-159] …and remember it as the user's choice (this is a
          // user action by construction: the message only comes from the panel).
          .then(() => { this.rememberUserMode(sessionId); this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setModel':
        void this.sessionManager.setModel(sessionId, (msg as { modelId: string }).modelId)
          .then(() => { this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setConfigOption':
        void this.sessionManager.setConfigOption(
          sessionId,
          (msg as { configId: string }).configId,
          (msg as { value: string }).value,
        )
          // [CUSTOM-20261001-159] Remember only when the option that changed IS the mode
          // (this one message carries model, mode, effort and anything else the agent adds).
          .then(() => {
            const session = sessionOf(this.sessionManager, sessionId);
            const mode = modeOptionOf(session?.configOptions);
            if (mode && mode.id === (msg as { configId: string }).configId) { this.rememberUserMode(sessionId); }
            this.syncChoices(sessionId);
            this.pushMeta(sessionId);
          })
          .catch(e => this.reportError(sessionId, e));
        return;
      // [CUSTOM-20260924-027] Session-scoped: it must sit AFTER the guard above.
      case 'needToolView': {
        this.resendToolView(
          sessionId,
          (msg as { entryId?: string }).entryId ?? '',
          (msg as { toolCallId?: string }).toolCallId ?? '',
          from,
        );
        return;
      }
      // [CUSTOM-END] CUSTOM-20260924-027
      case 'openFile':
        void this.handleOpenFile(
          sessionId,
          (msg as { path?: string }).path ?? '',
          (msg as { line?: number }).line,
        );
        return;
      case 'openTerminal':
        this.handleOpenTerminal(sessionId, (msg as { terminalId?: string }).terminalId ?? '');
        return;
      // [CUSTOM-20260924-020] Session-scoped: it must sit AFTER the guard above.
      // [CUSTOM-20260929-119] 表单回答：与会话作用域守卫之后的位置要求一致。
      case 'elicitationAnswer': {
        const answer = msg as {
          promptId?: string;
          action?: ElicitationAction;
          content?: ElicitationContent;
        };
        if (answer.promptId && answer.action) {
          this.elicitationBridge?.submit(answer.promptId, answer.action, answer.content);
        }
        return;
      }
      case 'permissionAnswer': {
        const promptId = (msg as { promptId?: string }).promptId;
        if (promptId) {
          this.permissionBridge?.answer(promptId, (msg as { optionId?: string }).optionId);
        }
        return;
      }
      // [CUSTOM-END] CUSTOM-20260924-020
      default:
        break;
    }
  }

  dispose(): void {
    // [CUSTOM-20260925-041] Unregister first: an update arriving while the
    // rest of this method runs would otherwise index into state that is being
    // torn down.
    this.sessionUpdateHandler.removeListener(this.updateListener);
    this.outbox.dispose();
    for (const d of this.subscriptions) { d.dispose(); }
    this.subscriptions.length = 0;
    this.surfaces.clear();
    this.lastActive = null;
    this.unread.clear();
    // [CUSTOM-20261001-162] No timers may outlive the host (they would refresh a
    // torn-down panel and keep the extension host awake for nothing).
    for (const timer of this.backgroundTasks.values()) { clearTimeout(timer); }
    this.backgroundTasks.clear();
    // setPresenter(null) also cancels every prompt still awaiting an answer:
    // nothing can render or answer them once the host is gone.
    this.permissionBridge?.setPresenter(null);
    this.elicitationBridge?.setPresenter(null);
  }

  // --- Prompt handling -----------------------------------------------------

  private async handleSendPrompt(sessionId: string, text: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }

    // [CUSTOM-20261001-164] 第二次发言 = 第一次对话已经结束：此刻的标题就是它的名字，冻住。
    // 放在这里而不是"第一轮结束时"：adapter 是在 idle（轮次结束）那一刻才去推标题的，两者几乎
    // 同时到达 —— 在轮次结束处冻结会把刚刚生成的自动命名一起挡在门外（那是它唯一该被采纳的时机）。
    // 等到下一条消息发出时再判，既不抢跑也不迟到。
    if (this.turnsDone.has(sessionId) && !this.titleFrozen.has(sessionId)) {
      this.titleFrozen.add(sessionId);
      log(`${LOG_PREFIX}: session ${sessionId} keeps the title it had after the first exchange`);
    }

    // [CUSTOM-20260928-109] 注入块（<task-notification> 等）虽然是从输入框发出去的，
    // 但仍然是注入块——渲染成蓝色用户气泡一样会误导。发送路径与 replay 路径用同一个
    // 判据（isInjectedChunk）。
    if (isInjectedChunk(text)) {
      const preview = firstLineOf(stripInjectionWrapper(text));
      const entry = this.transcripts.appendNotice(sessionId, 'meta', preview);
      if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
      // 仍然要真的发出去（agent 期待收到这条注入），只是不把它当用户消息渲染。
      // 复用下面的发送逻辑：把 text 原样作为唯一 text block。
    }

    const attachments = this.attachments.get(sessionId) ?? [];
    const images = this.imageData.get(sessionId) ?? new Map();

    // The transcript is the panel's own record; the extension-side store keeps
    // it so the bubble survives a panel switch.
    this.transcripts.ensureSession(sessionId, session.agentName);
    // A new user turn ends any prose the agent was still streaming.
    this.finalizeEntries(sessionId, { only: 'assistant' });
    // [CUSTOM-20260928-108] 图片附件进用户气泡（不再独立成行）——它们是这次提问的
    // 一部分，不是另一条记录。
    // [CUSTOM-20261009-215] **文件引用**同样要进气泡（用户报："引用了文件的消息发出去后，
    // 消息面板里这条用户消息卡片里看不到引用的文件"——它只进了发给 agent 的 blocks，
    // 气泡里没有对应视图）。两处产出一遍算：气泡视图与 blocks 在**同一个循环**里砌出来，
    // uri / `#L` 片段 / name 各只有一个来源（pitfall #19），不会出现"发出去带区间、
    // 气泡里不带"这类两边漂移。
    const blocks: ContentBlock[] = [];
    const attachmentViews: ContentBlockView[] = [];
    if (text.trim().length > 0) { blocks.push({ type: 'text', text }); }
    for (const a of attachments) {
      if (a.kind === 'image') {
        const img = images.get(a.path);
        if (!img) {
          log(`${LOG_PREFIX}: image attachment ${a.path} has no stored bytes`);
          continue;
        }
        blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        const view = toContentView({ type: 'image', data: img.data, mimeType: img.mimeType });
        if (view && view.type === 'image') {
          if (a.name) { view.name = a.name; }
          attachmentViews.push(view);
        }
      } else {
        // ACP `ResourceLink.uri` is a plain string (file:// URI per convention).
        // [CUSTOM-20261008-206] 带选区行区间时挂一个 `#L12-40` 片段：`name` 里已经有它是给人看的，
        // 片段则是让 agent 也能看到"引用的是哪几行"（不认识片段的实现会照旧忽略它）。
        const range = a.lineStart ? `#L${a.lineStart}-${a.lineEnd ?? a.lineStart}` : '';
        const uri = fileUri(a.path).toString() + range;
        blocks.push({ type: 'resource_link', uri, name: a.name });
        // 视图走同一条 uri（toContentView 会认出本地文件并给出 `path`）⇒ 气泡里的 chip
        // 点击走 openFile 通道（039/205 的既有约定）。
        const view = toContentView({ type: 'resource_link', uri, name: a.name });
        if (view && view.type === 'resource_link') { attachmentViews.push(view); }
      }
    }
    // [CUSTOM-20260928-096] 空文字 + 附件时跳过空的气泡。
    // [CUSTOM-20260928-109] 注入块已在上面作为 meta notice 落账，这里不再产生用户气泡。
    if (!isInjectedChunk(text) && text.trim().length > 0) {
      const userEntry = this.transcripts.appendUser(
        sessionId, text, attachmentViews.length > 0 ? attachmentViews : undefined);
      if (userEntry) { this.post({ type: 'append', sessionId, entries: [userEntry] }); }
    } else if (attachmentViews.length > 0) {
      const entry = this.transcripts.appendContent(sessionId, attachmentViews);
      if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
    }

    this.sessionManager.recordFirstPrompt(sessionId, text);
    this.attachments.set(sessionId, []);
    this.imageData.delete(sessionId);
    this.post({ type: 'attachments', sessionId, attachments: [] });

    // [CUSTOM-BEGIN] CUSTOM-20261004-187 - 轮次进行中：把这条消息**注入**正在跑的那一轮
    // （Claude Code 的 steering），而不是当第二个 `session/prompt` 发出去。
    //
    // 为什么要单独一条路：steering 是在**同一个**轮次里追加内容，它**不会**产生第二个
    // PromptResponse。走下面的正常路径要么被 SessionManager 的"已有轮次在跑"守卫拒掉
    // （那正是用户报的"任务进行中按回车没反应"），要么 await 一个永远不来的响应
    // （Stop 按钮永不熄灭、finalizeTurn 永不执行）。所以这里把用户气泡落账后**原样返回**：
    // 轮次状态一个都不动，让原来那一轮自己收尾。
    if (this.sessionManager.hasRunningTurn(sessionId) && this.sessionManager.supportsSteering(sessionId)) {
      try {
        const how = await this.sessionManager.steerPrompt(sessionId, blocks);
        if (how === 'steered') { return; }
        // 'idle'：agent 说它没在跑（我们这边的标记陈旧了，例如后台任务）⇒ 落回普通路径。
      } catch (e: any) {
        this.reportError(sessionId, e);
        return;
      }
    }
    // [CUSTOM-END] CUSTOM-20261004-187

    // [CUSTOM-20261001-157] How this turn ended, for the turn-done notification
    // (filled in below; `finalizeTurn` runs in the finally, so it has to be declared
    // out here).
    let outcome: TurnOutcome = {};

    try {
      // Start the turn and only THEN refresh: `sendPrompt` registers the
      // in-flight turn synchronously before its first await, so refreshing
      // beforehand would always report `running: false` (no Stop button).
      // [CUSTOM-20261001-162] 新轮次开始：不必再替后台任务"占着"运行中（轮次自己就会报告）。
      this.endBackgroundTask(sessionId, 'turn');
      const pending = this.sessionManager.sendPrompt(sessionId, blocks);
      this.finalizeEntries(sessionId, { only: 'thought' });
      this.refreshSessions();
      this.pushMeta(sessionId);

      const response = await pending;
      this.applyStopReason(sessionId, response.stopReason);
      // [CUSTOM-20261004-185] 这里原来还有一次 `applyResponseUsage`（把 PromptResponse 的
      // totalTokens 折进圆环）—— 那是单位张冠李戴，已删除；圆环只认 usage_update。
      // [CUSTOM-20261001-157] 这一轮怎么结束的，决定要不要（以及怎么）通知。
      outcome = turnOutcome(response.stopReason);
    } catch (e: any) {
      this.reportError(sessionId, e);
      outcome = { failed: true, detail: e?.message ?? String(e) };
    } finally {
      this.finalizeTurn(sessionId, outcome);
    }
  }

  /**
   * Surface a non-normal turn ending. The ACP spec is explicit that a
   * `refusal` turn's content is excluded from the next prompt, so the UI must
   * show it rather than ending silently.
   */
  private applyStopReason(sessionId: string, stopReason: string | undefined): void {
    // [CUSTOM-20261001-157] The wording lives in `stopReasonText` (shared with the
    // turn-done notification) so the record and the toast cannot tell two stories.
    const message = stopReasonText(stopReason);
    if (!message) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'warn', message);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Switch notices (CUSTOM-20260926-073) --------------------------------

  /** The session's switchable state right now, or null when it has no session. */
  private choiceState(sessionId: string): ChoiceSnapshot | null {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return null; }
    return choiceSnapshotFromState(session.modes, session.configOptions);
  }

  /**
   * Diff a session's switchable state against the cached snapshot and announce
   * whatever moved (model / mode / any other config option).
   *
   * The FIRST snapshot of a session is a BASELINE, not a change: opening a session
   * must not print "Switched to <the model it already had>". That also covers the
   * two racing reporters of the same change — whichever arrives first announces,
   * the second diffs to nothing.
   *
   * `next` lets a caller pass a state built from a NOTIFICATION payload (see
   * onSessionUpdate); omitted, the state is read from SessionManager.
   */
  private syncChoices(sessionId: string, next?: ChoiceSnapshot | null): void {
    const state = next === undefined ? this.choiceState(sessionId) : next;
    if (!state) { return; }
    const previous = this.choices.get(sessionId);
    this.choices.set(sessionId, state);
    if (!previous) { return; }
    const labels = choiceChanges(previous, state);
    if (labels.length === 0) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'switch', labels.join(' · '));
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  /**
   * [CUSTOM-20260926-075] Keep the session's title map in step with the agent.
   *
   * [CUSTOM-20261001-163] …but **without announcing the change in the transcript**
   * (user report: 会话进行中会自己改名，跳出一行 `Session renamed to “…”`).
   *
   * [CUSTOM-20261001-164] …and (user rule) **only until the first exchange is over**:
   * the name is decided by the first exchange — the auto-title if it landed by then,
   * otherwise the first user message — and NOTHING may rename the session afterwards.
   *
   * Why: the adapter pulls the SDK title at every turn end (`maybeUpdateSessionTitle`)
   * and the SDK generates it in a background task, so it can land several turns later —
   * by which time it describes what the conversation drifted INTO, not what it is
   * (user's words: 这时候对话信息已经脱离第一次对话内容了). Late is not "an update",
   * it is a different name for a different thing.
   */
  private trackTitle(sessionId: string, title: string): boolean {
    if (!title) { return false; }
    if (this.titleFrozen.has(sessionId)) {
      log(`${LOG_PREFIX}: ignoring a late title for ${sessionId} (the name is fixed by the first exchange)`);
      return false;
    }
    this.sessionTitles.set(sessionId, title);
    return true;
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
  private finalizeTurn(sessionId: string, outcome: TurnOutcome = {}): void {
    // [CUSTOM-20261001-164] 一轮跑完 ⇒ 下一次发言到来时标题就该冻住了。
    this.turnsDone.add(sessionId);
    this.finalizeEntries(sessionId);
    this.sessionManager.touchHistory(sessionId);
    this.refreshSessions();
    this.pushTurnState(sessionId);
    // [CUSTOM-20260924-022] Batching health check: a high merged/queued ratio
    // means the coalescing is doing its job; if `queued` stays large at turn
    // end something is bypassing the outbox.
    // [CUSTOM-20260925-041] Per-turn, not cumulative (see Outbox.resetStats).
    // `queued` here is normally 0-2 (the frame still in flight); a value that
    // stays large across turns is the real signal.
    const stats = this.outbox.stats();
    log(`${LOG_PREFIX}: outbox sent=${stats.sent} merged=${stats.merged} queued=${stats.queued}`);
    this.outbox.resetStats();
    // [CUSTOM-20261001-157] 后台会话跑完一轮就通知一声。这里是**唯一**的轮次结束收敛点
    // （finalizeTurn 全仓只有 handleSendPrompt 的 finally 一处调用），所以"这一轮结束了吗"
    // 不需要第二份状态（pitfall #34）。
    if (!outcome.silent) {
      const turn = (this.turnSeq.get(sessionId) ?? 0) + 1;
      this.turnSeq.set(sessionId, turn);
      this.notifySession({
        kind: 'turn-done',
        sessionId,
        token: String(turn),
        detail: outcome.detail,
        failed: outcome.failed,
      });
    }
  }

  // --- Session update → transcript ----------------------------------------

  private onSessionUpdate(update: SessionNotification): void {
    const sessionId = update.sessionId;
    const data = update.update as any;
    const session = sessionOf(this.sessionManager, sessionId);
    if (!data || !session) { return; }

    this.transcripts.ensureSession(sessionId, session.agentName);

    // [CUSTOM-20260926-073] Take the switch baseline here, at the top, because this
    // runs for every update of every session regardless of whether a surface is
    // attached — so a baseline exists before any switch can be reported.
    if (!this.choices.has(sessionId)) { this.syncChoices(sessionId); }
    // [CUSTOM-20260926-075] ...and the rename baseline, for the same reason.
    if (!this.sessionTitles.has(sessionId)) { this.sessionTitles.set(sessionId, session.title ?? ''); }

    // [CUSTOM-20261001-162] 后台子任务：进入 / 续期"轮次之外仍在工作"（见 noteBackgroundTask）。
    // 放在 switch 之前：这两条判据只看通告本身，与具体分支无关。
    if (isBackgroundLaunch(data.rawInput)) {
      this.noteBackgroundTask(sessionId, 'a background task was launched');
    } else if (this.backgroundTasks.has(sessionId) && isWorkUpdate(data)) {
      this.noteBackgroundTask(sessionId, 'still producing output');
    }

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
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        // A chunk means a turn is in flight even if we did not start it.
        this.refreshSessions();
        return;
      }

      case 'agent_thought_chunk': {
        const text = textOf(data.content);
        if (text.length === 0) {
          // [CUSTOM-20260926-075] Non-text content inside a THOUGHT chunk (an image
          // the agent pasted into its reasoning, a resource link) used to be dropped
          // on the floor. It becomes a content record like any other.
          //
          // The thought is closed first, and that is not cosmetic: entries only
          // merge into the LAST one, so a thought left open here would be stranded
          // with a permanent "Thinking…" spinner while the next thought chunk opens
          // a second block.
          this.finalizeEntries(sessionId, { only: 'thought' });
          this.postContentNotice(sessionId, data.content);
          return;
        }
        const entry = this.transcripts.appendThoughtChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        return;
      }

      case 'user_message_chunk': {
        // Replay path (`session/load`).
        const text = textOf(data.content);
        // [CUSTOM-20261008-205] IDE 上下文块：**不建记录**，挂到同一条消息的用户气泡上。
        // 放在注入块判据之前 —— 它也是 `<ide_` 开头，但这里认得出来该做成 chip。
        const idePath = ideOpenedFilePath(text);
        if (idePath) {
          this.rememberIdeFile(sessionId, data.messageId, ideFileChip(idePath));
          return;
        }
        // [CUSTOM-20260928-111] Images of this user message (and, since 216, its FILE
        // REFERENCES) were read from the transcript BEFORE replay started
        // (preloadTranscriptTimes); merge them into the bubble. The separate chunks that
        // follow (100) are dropped below so they do not become second rows.
        const parts = this.replayPartsFor(sessionId, data.messageId);
        // [CUSTOM-20261009-216] 文件引用：agent 把 `resource_link` 块序列化成一段文本回放回来。
        // 这里必须**先于**注入块与正文判据认出它（它也长得像普通文本），否则它会变成一条
        // 蓝色气泡、把 `[@名](file:///…)` 原样显示出来（用户报的正是这个）。
        const mentions = fileMentionViews(text);
        if (mentions) {
          // 这条记录有正文 ⇒ 引用已经（或马上会）随正文 chunk 并进那个气泡，这条只丢不建。
          if (parts?.hasProse) { return; }
          // 没有正文的记录（只引用文件就发送）自己渲染 —— 与发送路径同形（215：落成 content 条目）。
          // 读不到转录时也走这里：无论如何都不把这段 markdown 当正文显示。
          const mentionEntry = this.transcripts.appendContent(sessionId, mentions);
          if (mentionEntry) { this.post({ type: 'append', sessionId, entries: [mentionEntry] }); }
          return;
        }
        if (text.length === 0) {
          // [CUSTOM-20260928-100] Non-text blocks of a USER message were dropped here
          // (a pasted image, a resource link), so a reopened conversation showed the
          // prompt without the picture it carried. Same treatment as the thought chunk
          // below (075): it becomes a content record like any other.
          // [CUSTOM-20261009-216] 丢弃的判据是"这条记录**有正文**"（那它已经随正文 chunk 进气泡了），
          // 不再是"转录里知道这条消息"：只有附件、没有正文的消息（111 起就存在）此前被无条件丢掉，
          // 于是重开后连图片一起消失。没有正文时这里就是它唯一的承载者，自己渲染。
          if (parts?.hasProse) { return; }
          if (parts && (parts.images.length > 0 || parts.files.length > 0)) {
            const ownEntry = this.transcripts.appendContent(sessionId, [...parts.images, ...parts.files]);
            if (ownEntry) { this.post({ type: 'append', sessionId, entries: [ownEntry] }); }
            return;
          }
          this.postContentNotice(sessionId, data.content);
          return;
        }
        // [CUSTOM-20260928-109] 注入块（<task-notification> 等）不是用户输入，
        // 却走同一个 user chunk 通道 —— 渲染成蓝色用户气泡会把"agent 的回报"误读成
        // "我说过这句话"。分流成 meta 提示条，正文截断一行。
        if (isInjectedChunk(text)) {
          // [CUSTOM-20261001-162] 后台任务汇报完毕：等的就是它（见 noteBackgroundTask）。
          if (isTaskNotification(text)) { this.endBackgroundTask(sessionId, 'reported'); }
          const preview = firstLineOf(stripInjectionWrapper(text));
          const entry = this.transcripts.appendNotice(sessionId, 'meta', preview);
          if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
          return;
        }
        // [CUSTOM-20260925-053] A user chunk IS a turn boundary, so it must
        // close any assistant prose still marked as streaming. Nothing else
        // does it on the replay path: `finalizeTurn` only runs for a prompt we
        // sent, and the tool_call branch only fires when a tool follows. An
        // entry left `streaming: true` forever keeps the client's copy in the
        // streaming state — which among other things pins `aria-busy` to true
        // (CUSTOM-20260925-048) and silently mutes the screen reader for the
        // rest of the session. The legacy panel finalizes the pending assistant
        // turn here too ("finalizes pending assistant turn", its
        // user_message_chunk branch).
        this.finalizeEntries(sessionId, { only: 'assistant' });
        // [CUSTOM-20261008-205] 同一条消息的 IDE 上下文（若到过）与附件一起进气泡：chip 在前、正文在下。
        // [CUSTOM-20261009-216] 附件 = IDE 上下文 + 图片 + 文件引用（三者各只有一个来源）。
        const ideChip = this.takeIdeFile(sessionId, data.messageId);
        const views = (ideChip ? [ideChip] : []).concat(parts?.images ?? [], parts?.files ?? []);
        const entry = this.transcripts.appendUser(sessionId, text, views.length > 0 ? views : undefined);
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
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
          // [CUSTOM-20260925-038] 键名是 `entries`（= 记录字段名），不是 `plan`。
          // 曾用 `plan` 导致客户端的 patch 写进 entry.plan 而渲染读 entry.entries，
          // 于是 Todo 列表永远停在第一次快照且没有任何报错。
          this.post({ type: 'revise', sessionId, entryId: existing.id, patch: { entries: existing.entries } });
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
          // [CUSTOM-20261009-224] 思考 token：ACP 的 Usage 里有这个字段，但实测当前适配器没发过来
          // （`used`/`size`/`_meta._claude/model` 之外什么都没有）。有就带上，没有就是 undefined。
          thoughtTokens: typeof (data as { thoughtTokens?: unknown }).thoughtTokens === 'number'
            ? (data as { thoughtTokens?: number }).thoughtTokens
            : undefined,
        });
        this.pushMeta(sessionId);
        return;
      }

      default: {
        // [CUSTOM-20261001-164] 标题的**单一判定点**：`trackTitle` 说收下，SessionManager 才写。
        // 拆成两处会漏 —— 第一版只挡了宿主那份 map，而 tab 的标题读的是 `session.title`
        // （`applySessionInfoUpdate` 写的），于是"迟到几轮的自动命名"照样改掉了名字。
        const titleAccepted = data.sessionUpdate === 'session_info_update'
          ? this.trackTitle(sessionId, typeof data.title === 'string' ? data.title : '')
          : false;
        if (titleAccepted) {
          this.sessionManager.applySessionInfoUpdate(sessionId, {
            title: data.title as string,
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
          });
        }
        // available_commands_update / config_option_update / current_mode_update /
        // session_info_update need the host to re-read state after they land.
        if (data.sessionUpdate === 'available_commands_update'
          || data.sessionUpdate === 'config_option_update'
          || data.sessionUpdate === 'current_mode_update'
          || data.sessionUpdate === 'session_info_update') {
          this.pushMeta(sessionId);
          this.refreshSessions();
        }
        // [CUSTOM-20260926-075] 标题的记账已经在上面的 default 分支里做完（163/164 起静默、
        // 且只认第一次对话里的那一条），这里不再重复。
        // [CUSTOM-20260926-073] A switch the agent pushed (or that another surface
        // triggered). The PAYLOAD is used rather than SessionManager's copy: our
        // listener may run before SessionManager's, in which case its state is still
        // the old one and the diff would come out empty. If our own setter already
        // reported this change, the diff here is empty and nothing prints twice.
        const previous = this.choices.get(sessionId);
        if (!previous) { return; }
        if (data.sessionUpdate === 'config_option_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { configOptions: data.configOptions }));
        } else if (data.sessionUpdate === 'current_mode_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { modeId: data.currentModeId }));
        }
        return;
      }
    }
  }

  /**
   * [CUSTOM-20260928-100] Read a session's real message times BEFORE replaying it.
   *
   * Done up front rather than on `session-load-start` (an event): the replay notifications
   * arrive synchronously once the agent starts streaming, so a table still being read
   * would be too late for the first chunks — and those are exactly the rows a reader
   * scrolls to the top of the outline to find.
   */
  private async preloadTranscriptTimes(agent: string, sessionId: string, cwd?: string): Promise<void> {
    if (agent !== CLAUDE_CODE_AGENT || this.replayTimes.has(sessionId)) { return; }
    const dirCwd = cwd || this.workspaceCwd();
    if (!dirCwd) { return; }
    const dir = claudeTranscriptDir(dirCwd);
    try {
      const times = await readTranscriptTimes(dir, sessionId);
      if (times.size > 0) {
        this.replayTimes.set(sessionId, times);
        log(`${LOG_PREFIX}: replayed times available for ${sessionId} (${times.size} messages)`);
      }
    } catch (e) {
      // Best effort: no times means the records keep the host clock, as before.
      log(`${LOG_PREFIX}: transcript times unavailable (${(e as Error)?.message ?? e})`);
    }
    // [CUSTOM-20260928-111] Images of user messages too: the replay delivers them as
    // separate chunks (100), so the bubble has nothing to merge with unless we read
    // the transcript. Any failure is "no images", never an error.
    // [CUSTOM-20261009-216] …and the message's FILE REFERENCES ride the same way (the agent
    // serialises a `resource_link` block as a `[@name](file:///…)` text block). One scan now
    // serves both, and it also reports whether each record has prose of its own — the
    // discriminator that tells an attachment chunk "this already rode on the text chunk"
    // from "you are the only carrier this message has".
    try {
      const parts = await readTranscriptUserAttachments(dir, sessionId);
      if (parts.size > 0) {
        this.replayUserParts.set(sessionId, parts);
        log(`${LOG_PREFIX}: replayed user attachments available for ${sessionId} (${parts.size} messages)`);
      }
    } catch (e) {
      log(`${LOG_PREFIX}: transcript user attachments unavailable (${(e as Error)?.message ?? e})`);
    }
  }

  /** Real parts (images / file references / prose) of a replayed user message, or undefined. */
  private replayPartsFor(sessionId: string, messageId: unknown): TranscriptUserParts | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    return this.replayUserParts.get(sessionId)?.get(messageId);
  }

  /**
   * [CUSTOM-20261008-205] 存一个"这条消息的 IDE 上下文文件"，等同一条消息的正文 chunk 来取。
   * 认不出 messageId 的 chunk 直接丢掉 —— 没有配对的键，挂到别人身上比不显示更糟。
   */
  private rememberIdeFile(sessionId: string, messageId: unknown, chip: ContentBlockView): void {
    if (typeof messageId !== 'string' || messageId.length === 0) {
      log(`${LOG_PREFIX}: IDE context block without a messageId (dropped)`);
      return;
    }
    this.ideFilesByMessage.set(ideKey(sessionId, messageId), chip);
    // 只留最近 20 条：若用户只是"打开了个文件"而没有下文，这条就永远没人来取。
    while (this.ideFilesByMessage.size > 20) {
      const oldest = this.ideFilesByMessage.keys().next().value;
      if (oldest === undefined) { break; }
      this.ideFilesByMessage.delete(oldest);
    }
  }

  /** [CUSTOM-20261008-205] 取走这条消息的 IDE 上下文（取过即删，不会挂到第二条消息上）。 */
  private takeIdeFile(sessionId: string, messageId: unknown): ContentBlockView | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    const key = ideKey(sessionId, messageId);
    const chip = this.ideFilesByMessage.get(key);
    if (chip) { this.ideFilesByMessage.delete(key); }
    return chip;
  }

  /** Real epoch ms for a replay chunk's message, or undefined when the agent gave none. */
  private replayTimeFor(sessionId: string, messageId: unknown): number | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    return this.replayTimes.get(sessionId)?.get(messageId);
  }

  /**
   * Stamp a replay entry with its real time when the transcript knows it. The entry is
   * the store's OWN object (`append*` returns a live reference), so correcting `at` here
   * also fixes every later snapshot — the client is handed the same object.
   */
  private stampReplayTime(sessionId: string, entry: { at: number } | null, messageId: unknown): void {
    if (!entry) { return; }
    const at = this.replayTimeFor(sessionId, messageId);
    if (at !== undefined) { entry.at = at; }
  }

  /**
   * Non-text content in a message chunk becomes a real transcript entry so the
   * webview renders it (image inline, resource as a chip, …) instead of a
   * `[image content]` placeholder.
   *
   * [CUSTOM-20260924-026] An **empty text block** reaches here whenever the
   * agent uses one as a chunk separator (`textOf` returns '' so the caller
   * treats it as non-text). `toContentView` maps it to a perfectly valid
   * `{type:'text', text:''}` view, and rendering that produced a blank strip in
   * the transcript — that was the source of the "empty bars" between real
   * blocks. A block nobody can see is not content: drop it.
   */
  private postContentNotice(sessionId: string, block: unknown): void {
    const view = toContentView(block as ContentBlock | null);
    if (!hasVisibleContent(view)) { return; }
    const entry = this.transcripts.appendContent(sessionId, [view!]);
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

  private handleRenderMarkdown(items: Array<{ entryId: string; sessionId: string; text: string; key?: string }>): void {
    const rendered: Array<{ entryId: string; sessionId: string; html: string; key?: string }> = [];
    for (const item of items) {
      const sessionId = verifySession(this.sessionManager, item);
      if (!sessionId) {
        // [CUSTOM-20260930-128] Do not drop it silently: a dropped item means that record
        // stays raw markdown forever, and this line is the only place that can say so
        // (pitfall #33's lesson — the 120 bug was invisible for exactly this reason).
        log(`${LOG_PREFIX}: dropped markdown item ${item.entryId} (unknown session ${item.sessionId})`);
        continue;
      }
      const html = this.markdown.render(item.text);
      // [CUSTOM-20261004-186] A render only applies to the text it was made from.
      //
      // `item.text` is a snapshot of the record as it looked when the client asked;
      // the record can have grown since (prose streams, and the ask goes out the
      // moment the record lands — 128). Storing that html anyway leaves the STORE
      // holding a rendering of a prefix, which the next snapshot (session switch,
      // reopen, tab focus) hands to the client as if it were current — the record
      // then shows its first few lines and nothing else. Dropping it is not a loss:
      // the record still has no html, so the client's settle-time request renders
      // the text it actually has.
      // [CUSTOM-20260925-066] A KEYED item is a sub-block of a tool card, not a
      // transcript record: there is nothing in the store to patch, the HTML goes
      // back to the element that asked for it. Skipping the patch also avoids a
      // pointless lookup for an id that can never be found.
      if (!item.key) {
        const current = this.transcripts.getEntry(sessionId, item.entryId);
        const renderedFrom = (current as { text?: string } | undefined)?.text;
        if (current && renderedFrom !== undefined && renderedFrom !== item.text) {
          log(`${LOG_PREFIX}: stale markdown reply dropped for ${item.entryId} (asked ${item.text.length} chars, now ${renderedFrom.length})`);
          continue;
        }
        this.transcripts.patch(sessionId, item.entryId, { html });
      }
      rendered.push({ entryId: item.entryId, sessionId, html, key: item.key });
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

  private async handleOpenFile(sessionId: string, rawPath: string, line?: number): Promise<void> {
    if (!rawPath) { return; }
    // [CUSTOM-20260925-039] Resolve relative paths against the session that OWNS
    // the chip rather than whatever happens to be focused. The `verifySession`
    // guard already validated this id, so there is one source of truth for the
    // working directory (previously this read `this.focused.sessionId`, which
    // was equivalent only because the client filters by the focused session).
    const session = sessionOf(this.sessionManager, sessionId);
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

  // --- Permission presenter (CUSTOM-20260924-020) --------------------------

  /**
   * Whether this prompt belongs to the modern panel — i.e. whether the panel can
   * eventually render it and the user can answer it there.
   *
   * [CUSTOM-20261001-156] This used to require the prompt's session to be the
   * FOCUSED one, which handed every background session's request to the window-level
   * QuickPick. That is wrong for a multi-session panel: the user's screenshot shows
   * the result — a modal question at the top of the window about a session they were
   * not looking at. A record is now created for any modern session (the client
   * filters by focused session, and the focus/boot snapshot brings it back), and when
   * it is NOT on screen the host sends a notification instead (see notifySession).
   *
   * Three conditions, all required: the session exists and its OWN agent is a modern
   * one (matching the focused agent's name was a latent bug — with only one modern
   * agent configured it never showed), and some surface exists to draw on. A hidden
   * surface is raised only for the FOCUSED session — the agent is blocked until this
   * is answered, and that is the session the user is working in. A background
   * session never steals the view; its notification does the telling.
   *
   * "No surface" still returns false on purpose: nothing can render, so the bridge's
   * dialog fallback stays the exit that cannot hang the agent (pitfall #14).
   */
  canPresent(sessionId: string): boolean {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session || !isModernAgent(session.agentName)) { return false; }
    const surface = this.activeSurface();
    if (!surface) { return false; }
    if (this.focused.sessionId === sessionId && !surface.visible) { surface.reveal(true); }
    return true;
  }

  /** The surface a prompt would be drawn on (last active, else any). */
  private activeSurface(): ChatSurface | undefined {
    return this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
  }

  /**
   * [CUSTOM-20261001-156] True when the user is actually looking at this session:
   * it is the focused one AND a visible surface shows it. Everything else gets a
   * notification instead (the panel may be closed, hidden behind an editor, or
   * showing a different session entirely).
   */
  private isSessionOnScreen(sessionId: string): boolean {
    if (this.focused.sessionId !== sessionId) { return false; }
    const surface = this.activeSurface();
    return !!surface && surface.visible;
  }

  /**
   * [CUSTOM-20261001-156] Tell the user about a session they are not looking at.
   * The on-screen check lives HERE rather than inside SessionNotifier: the host owns
   * `focused`/`surfaces`, and keeping the notifier free of host state is what makes
   * it testable with two lines (see SessionNotifier).
   */
  private notifySession(input: {
    kind: 'waiting-permission' | 'waiting-form' | 'turn-done' | 'background-stalled';
    sessionId: string;
    token: string;
    detail?: string;
    failed?: boolean;
  }): void {
    if (this.isSessionOnScreen(input.sessionId)) { return; }
    const label = this.sessionLabel(input.sessionId);
    const sent = this.notifier.notify({ ...input, label });
    // The persisted log is the debugging entry point (docs/dev-workflow.md): "did we
    // notify, and about what" must be answerable without a screenshot. The wording
    // itself is `composeNotice`'s; this line carries the identity.
    log(`${LOG_PREFIX}: notify ${input.kind} ${input.sessionId} ${sent ? 'sent' : 'duplicate'} (${label})`);
  }

  /**
   * "Claude Code · 修复登录 bug" — the same fallback chain `toSummary` uses for the tab
   * title, so a session named after its first message is called the same thing in a
   * notification as in the strip (078/164).
   */
  private sessionLabel(sessionId: string): string {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return sessionId.slice(0, 8); }
    const title = this.sessionTitles.get(sessionId)
      || session.title
      || this.sessionManager.getHistoryStore()?.get(session.agentName, sessionId)?.firstPrompt
      || '';
    return title ? `${session.agentDisplayName} · ${title}` : session.agentDisplayName;
  }

  // [CUSTOM-BEGIN] CUSTOM-20261001-162 - 轮次之外的 agent 工作（后台子任务）。
  //
  // 现象（用户报）：任务还在跑（在等子 agent），发送按钮却已经变回普通状态。
  // 根因：`running` 只由"`session/prompt` 请求还没返回"决定，而后台子任务**在轮次结束后继续
  // 干活**——轮次一结束，面板就让它看起来"空闲"了。
  //
  // 状态机（三条进出条件都要求**有证据**，不猜）：
  //   · 进入：某个 tool call 的 `rawInput.run_in_background` 为真 —— 这是 agent 明说"我在后台
  //     起了个任务"，也是唯一能提前知道的信号（轮次还在飞时就要记下来，因为任务会比轮次活得久）；
  //   · 保持：该会话还有**产出型**通知（助手/思考分片、工具调用/更新）⇒ 看门狗重新武装；
  //   · 退出：① 收到 `<task-notification>` 注入块（后台任务汇报完毕，109 已经在处理这类块）
  //     ② 新轮次开始（轮次自己就报告 running）③ 看门狗超时 —— 此刻**发一条通知**再恢复：
  //     静默地变回"可以发消息"正是用户看到的那种"没人告诉我发生了什么"。
  // [CUSTOM-END] CUSTOM-20261001-162

  /**
   * [CUSTOM-20261001-162] This session keeps working outside the turn: stay "running"
   * until it reports back or goes quiet (see the block above).
   */
  private noteBackgroundTask(sessionId: string, reason: string): void {
    const existing = this.backgroundTasks.get(sessionId);
    if (existing) { clearTimeout(existing); }
    this.backgroundTasks.set(sessionId, setTimeout(
      () => this.endBackgroundTask(sessionId, 'quiet'),
      this.backgroundQuietMs,
    ));
    if (existing) { return; }
    log(`${LOG_PREFIX}: session ${sessionId} keeps running outside the turn (${reason})`);
    this.refreshSessions();
  }

  /** Stop waiting on background work (cause is for the log; `quiet` also notifies). */
  private endBackgroundTask(sessionId: string, cause: 'reported' | 'quiet' | 'turn' | 'closed'): void {
    const timer = this.backgroundTasks.get(sessionId);
    if (!timer) { return; }
    clearTimeout(timer);
    this.backgroundTasks.delete(sessionId);
    log(`${LOG_PREFIX}: session ${sessionId} is no longer waiting on background work (${cause})`);
    this.refreshSessions();
    if (cause === 'quiet') {
      // The wait is over, but not silently: "the button came back and nobody said why"
      // is exactly the experience this whole state exists to remove.
      this.notifySession({
        kind: 'background-stalled',
        sessionId,
        token: String(Date.now()),
        detail: `已 ${Math.round(this.backgroundQuietMs / 1000)} 秒没有输出`,
      });
    }
  }

  /** [CUSTOM-20261001-162] "running" for the summary: a turn in flight OR background work. */
  private isSessionRunning(sessionId: string): boolean {
    return this.sessionManager.isTurnInFlight(sessionId) || this.backgroundTasks.has(sessionId);
  }

  /**
   * [CUSTOM-20261001-156] Clicking a notification: bring that session up.
   *
   * `force` is the established way to focus a session the host already considers
   * active (080/087) — without it the focus event never fires and the panel would
   * stay where it was. A visible surface is raised WITH focus (this is an explicit
   * user action, unlike canPresent's reveal); with no surface at all, the sidebar
   * is opened through the same command extension.ts already uses.
   */
  private revealSession(sessionId: string, label: string): void {
    if (!this.sessionManager.getSession(sessionId)) {
      // The notification outlived its session (it was closed meanwhile). Silence
      // here would look like a dead button (pitfall #29).
      log(`${LOG_PREFIX}: notification clicked for a session that is gone (${sessionId})`);
      return;
    }
    log(`${LOG_PREFIX}: notification clicked — revealing ${label} (${sessionId})`);
    this.sessionManager.focusSession(sessionId, { force: true });
    const surface = this.activeSurface();
    if (surface) { surface.reveal(false); return; }
    void vscode.commands.executeCommand('acpc-chat.focus');
  }

  // [CUSTOM-BEGIN] CUSTOM-20260929-119 - PermissionPresenter + ElicitationPresenter 共用
  // 这一对方法（两个接口的方法名相同，所以实现必须收一个联合类型再按形状分派；
  // 写两个同名方法在 TS 里是重复实现，编译不过）。canPresent 也共用同一套判据。
  show(state: PermissionState | ElicitationState): void {
    // [CUSTOM-20260930-130] This session goes from "the agent is working" to "nothing
    // moves until you answer", and the tab dot has to say so. The bridge has already put
    // the request in its pending list by the time it calls this (see PermissionBridge.show).
    this.refreshSessions();
    if (isElicitationState(state)) { this.showElicitation(state); return; }
    const session = sessionOf(this.sessionManager, state.sessionId);
    if (!session) {
      // [CUSTOM-20261001-156] Reachable for a request whose session went away in the
      // same tick; silence here would be a request nobody ever heard about (#29).
      log(`${LOG_PREFIX}: permission prompt for unknown session ${state.sessionId} (dropped)`);
      return;
    }
    this.transcripts.ensureSession(state.sessionId, session.agentName);
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (entry) { this.post({ type: 'append', sessionId: state.sessionId, entries: [entry] }); }
    // [CUSTOM-20261001-156] Not on screen ⇒ tell the user (the record is there for
    // when they jump over; the notification is the way they learn about it).
    this.notifySession({ kind: 'waiting-permission', sessionId: state.sessionId, token: state.promptId, detail: state.title });
  }

  update(state: PermissionState | ElicitationState): void {
    // [CUSTOM-20260930-130] …and here it may go back (the bridge removes the request from
    // its pending list BEFORE calling this — see settleWith). A mere state change on a
    // card leaves the pending list alone, and the signature check makes this free.
    this.refreshSessions();
    if (isElicitationState(state)) { this.updateElicitation(state); return; }
    // appendPermission returns the existing entry for this promptId (after
    // applying the new state), so `patch` below only needs to tell the webview.
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (!entry) { return; }
    this.post({ type: 'revise', sessionId: state.sessionId, entryId: entry.id, patch: { permission: state } });
  }
  // [CUSTOM-END] CUSTOM-20260929-119

  // [CUSTOM-BEGIN] CUSTOM-20260929-119 - 表单卡的 presenter。与权限卡逐条同构：
  // 卡是 transcript 的一条记录（所以 boot/focus 的全量快照天然能把它带回来——重开面板、
  // 切走再切回、两个 surface 切换都不需要额外机制），回答走 elicitationAnswer 消息。
  showElicitation(state: ElicitationState): void {
    const session = sessionOf(this.sessionManager, state.sessionId);
    if (!session) {
      // [CUSTOM-20261001-156] Same reasoning as the permission branch above.
      log(`${LOG_PREFIX}: form for unknown session ${state.sessionId} (dropped)`);
      return;
    }
    this.transcripts.ensureSession(state.sessionId, session.agentName);
    const entry = this.transcripts.appendElicitation(state.sessionId, state);
    if (entry) { this.post({ type: 'append', sessionId: state.sessionId, entries: [entry] }); }
    // [CUSTOM-20261001-156] "会话等待选项确认" —— 与权限同一条通知纪律。
    this.notifySession({ kind: 'waiting-form', sessionId: state.sessionId, token: state.promptId, detail: state.message });
  }

  updateElicitation(state: ElicitationState): void {
    const entry = this.transcripts.appendElicitation(state.sessionId, state);
    if (!entry) { return; }
    this.post({ type: 'revise', sessionId: state.sessionId, entryId: entry.id, patch: { elicitation: state } });
  }
  // [CUSTOM-END] CUSTOM-20260929-119

  // --- Tool views (CUSTOM-20260924-027) ------------------------------------

  /**
   * The client reported a tool card with no view model.
   *
   * This is the recovery path for a card that was placed before its view model
   * existed (a bare `.tool` shell that `updateTool` used to be unable to repair).
   * If the invocation is genuinely gone there is nothing to send — but the log
   * line is the answer to "why is this card empty", which used to be invisible
   * (it only produced a `console.warn` inside the webview console).
   */
  private resendToolView(sessionId: string, entryId: string, toolCallId: string, to: SurfaceKey): void {
    const inv = toolCallId ? this.tools.get(sessionId, toolCallId) : undefined;
    if (!inv) {
      log(`${LOG_PREFIX}: client asked for the view of tool ${toolCallId || '(no id)'} in ${sessionId} but the invocation is not in the store (entry ${entryId})`);
      return;
    }
    log(`${LOG_PREFIX}: resending view for tool ${toolCallId} (client had none for entry ${entryId})`);
    // Targeted at the surface that asked: the other one already has it, and an
    // unnecessary toolUpdate would be a visual no-op anyway.
    this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) }, to);
  }

  // --- Panel entry points: connect + history (CUSTOM-20260925-032/033) ------

  /** Falls back to the panel's own agent when nothing is focused. */
  /**
   * [CUSTOM-20260927-090] Is the panel's agent connected right now?
   *
   * The empty state has to know. "No session yet — connect an agent" is WRONG once the
   * agent is already running: the panel can be sessionless with a live process (closing
   * the last session keeps the process; only `disconnectAgent` stops it), and its Connect
   * button then offers to do something that has already been done. Sent with every message
   * that can change what the empty state shows (boot / focus / sessionsChanged).
   */
  private panelAgentConnected(): boolean {
    const agent = this.panelAgent();
    return !!agent && this.sessionManager.isAgentConnected(agent);
  }

  private panelAgent(preferred?: string): string | null {
    if (preferred) { return preferred; }
    if (this.focused.agentName) { return this.focused.agentName; }
    for (const agentName of MODERN_AGENTS) { return agentName; }
    return null;
  }

  /** Workspace folder used to scope the local history cache, when there is one. */
  private workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * [CUSTOM-20260925-032] "Connect" button.
   *
   * [CUSTOM-20260925-058] Now means "make sure the process is up, then hand back
   * to the client": the client opens a DRAFT, and the session is created on the
   * first message. Creating one here (as `connectToAgent` does when none exists)
   * would leave an empty session in the agent's history for a user who only
   * wanted to check that the agent starts — and `session/close` does not remove
   * it again. The connectivity feedback the button exists for is preserved
   * because `ensureConnected` still throws when the process will not start.
   *
   * If sessions already exist, the newest is focused (reuse, not pile up).
   *
   * [CUSTOM-20260930-124] Every outcome now answers with a `connection` phase.
   * The client's "Connecting…" is driven by it, and it is the ONLY signal that
   * can end that phase: `refreshSessions` de-dups on a signature whose `conn:` bit
   * is already 1 when the process is up, and `ensureConnected` emits nothing in
   * that case — so a user with a live process and no session would otherwise be
   * stuck on "Connecting…" forever (pitfall #29).
   */
  private handleConnectAgent(agentName?: string): void {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      // Answer anyway: without it the client never leaves the connecting phase.
      this.postConnection('failed', 'No agent available to connect.');
      this.reportError(null, new Error('No agent available to connect.'));
      return;
    }
    log(`${LOG_PREFIX}: connect requested for ${agent}`);
    this.postConnection('connecting');
    void this.sessionManager.ensureConnected(agent)
      .then(async () => {
        const ids = this.sessionManager.getSessionIdsForAgent(agent);
        const newest = ids[ids.length - 1];
        if (newest) {
          this.sessionManager.focusSession(newest);
        } else {
          // [CUSTOM-20261009-209] 有可恢复的会话就先别建新的：面板停在空态卡片上问一句
          // 「要不要恢复上次那几个」。用户选「开始新的」时会再发一次 connectAgent
          // （那时快照已被丢弃），于是照旧走到下面 createSession —— 也就是"保持现在的逻辑"。
          const recoverable = this.recoverableSessions();
          if (recoverable.length > 0) {
            log(`${LOG_PREFIX}: ${recoverable.length} session(s) are restorable — asking before creating a new one`);
          } else {
            // [CUSTOM-20260930-131] No session yet: CREATE one, and do it before reporting
            // the phase. A draft page can never be "the same as a normal session" — images
            // need a session to attach to, and the mode/model pickers come from the
            // `session/new` response, so without a session there is nothing to show. The
            // cost is a session left in the agent's history if the user connects and walks
            // away; `session/close` does not remove it from history (058), and that is the
            // trade the user chose over a half-usable composer.
            await this.sessionManager.createSession(agent, { focus: true });
          }
        }
        // [CUSTOM-20260930-124] 'connected' goes out AFTER the focus/creation above, and the
        // order is load-bearing: the client opens a draft on 'connected' only when no
        // session is focused, so an inversion would hand the user a spare tab next to the
        // session that was just opened.
        this.postConnection('connected');
      })
      .catch(e => {
        this.postConnection('failed', (e as any)?.message ?? String(e));
        this.reportError(null, e);
      });
  }

  /** [CUSTOM-20260930-124] Broadcast one connection attempt's phase. */
  private postConnection(state: 'connecting' | 'connected' | 'failed', message?: string, detail?: string): void {
    // [CUSTOM-20261006-194] `connecting` 期间 agent 的 stderr 会以 detail 的形式跟着这条消息下发
    // （见 noteAgentStderr）—— 用户卡在连接界面时，那几行才是"为什么"。
    this.connecting = state === 'connecting';
    const payload: Record<string, unknown> = { type: 'connection', state };
    if (message) { payload.message = message; }
    if (detail) { payload.detail = detail; }
    this.post(payload as never);
  }

  /**
   * [CUSTOM-20261006-194] agent 进程的 stderr：**只在连接中**转发给面板。
   *
   * 起因：用户报"一直卡在连接界面"。日志里真相很清楚 —— npx 在下载新版本适配器
   * （`The following package was not found and will be installed: …`），而 `initialize` 要等它；
   * 可那几行只进了日志，卡片上永远只有一句 "Connecting…"，用户无从判断是在下载还是死了。
   * 连接建立之后 stderr 就是噪声（各种无关 warn），所以那时不再往卡片上灌。
   */
  private noteAgentStderr(line: string): void {
    if (!this.connecting) { return; }
    const text = String(line ?? '').trim().slice(0, 160);
    if (!text) { return; }
    this.postConnection('connecting', undefined, text);
  }

  /**
   * [CUSTOM-20260930-125] Persist the start card's switch, then answer with whatever the
   * setting ACTUALLY holds — including when the write failed. Echoing the requested value
   * back would leave the checkbox showing something settings.json does not say, which is
   * the same lie the configuration listener exists to prevent.
   */
  private async handleSetAutoConnect(value: boolean): Promise<void> {
    try {
      await this.prefs.setAutoConnect(value);
    } catch (e) {
      log(`${LOG_PREFIX}: could not write ${AUTO_CONNECT_KEY}: ${String(e)}`);
    }
    this.postAutoConnectPref();
  }

  /** [CUSTOM-20260930-125] Tell every surface what the setting currently says. */
  /** [CUSTOM-20261009-209] 卡片上那个「记住我的选择」写回来的值（走 prefs 注入缝，同 autoConnect）。 */
  private async handleSetRestorePref(value: unknown): Promise<void> {
    const choice = resolveRestoreChoice(value);
    try {
      await this.prefs.setRestore(choice);
    } catch (e) {
      log(`${LOG_PREFIX}: could not write ${RESTORE_KEY}: ${String(e)}`);
    }
    this.postRestorePref();
  }

  private postAutoConnectPref(): void {
    this.post({ type: 'autoConnectPref', value: this.prefs.getAutoConnect() });
  }

  /**
   * [CUSTOM-20260925-033] History picker contents for one agent.
   *
   * Source order matters: **the local cache first when the agent is not
   * connected**, because `sessionManager.listSessions` calls `ensureConnected`
   * and would spawn an agent process just to render a menu. Once it IS connected
   * the agent-side list wins: it is authoritative and includes sessions this
   * window never saw.
   */
  private async handleListHistory(agentName?: string, cwd?: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    // [CUSTOM-20261001-155] The client's address-bar directory, when it sent one. It is
    // what the filter's default is derived from (see postHistory); an empty or missing
    // value falls back to the host-side guess, which keeps older clients working.
    const askedCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined;
    if (!agent) {
      this.post({ type: 'history', agentName: '', sessions: [], source: 'local', error: 'No agent selected.' });
      return;
    }

    const connected = this.sessionManager.isAgentConnected(agent);
    const caps = this.sessionManager.getCachedCapabilities(agent);
    const local = (): Array<Omit<HistorySessionSummary, 'dirKey'>> => {
      const entries = this.sessionManager.getHistoryStore()?.list(agent, this.workspaceCwd()) ?? [];
      // [CUSTOM-20260928-097] Live sessions are no longer hidden — the current
      // session should appear in the picker too (clicking it just re-focuses).
      return entries
        .map(e => ({
          sessionId: e.sessionId,
          title: e.title ?? e.firstPrompt ?? null,
          cwd: e.cwd,
          updatedAt: e.lastActiveAt,
          // [CUSTOM-20260927-092] Marked here (the merge no longer invents the mark): a
          // row only the cache knows about may be gone agent-side, and the client says so.
          fromCache: true,
        }));
    };

    try {
      if (connected && caps?.list) {
        const response = await this.sessionManager.listSessions(agent);
        const fromAgent = response.sessions
          .map(s => {
            const info = s as { sessionId?: unknown; title?: unknown; cwd?: unknown; updatedAt?: unknown };
            const sessionId = String(info.sessionId ?? '');
            // [CUSTOM-BEGIN] CUSTOM-20260926-078 - 历史列表 agent 侧缺 title 时回退本地缓存的 title/firstPrompt。
            const stored = this.sessionManager.getHistoryStore()?.get(agent, sessionId);
            const title = typeof info.title === 'string'
              ? info.title
              : (stored?.title ?? stored?.firstPrompt ?? null);
            // [CUSTOM-END] CUSTOM-20260926-078
            return {
              sessionId,
              title,
              cwd: typeof info.cwd === 'string' ? info.cwd : undefined,
              updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : undefined,
            };
          });
        // [CUSTOM-20260927-092] UNION with the local cache instead of replacing it.
        // The agent's `session/list` is not the whole truth: it omits sessions that are
        // still OPEN in another Claude Code window (measured — see
        // CUSTOMIZATIONS/scripts/probe-session-list.mjs: 227 sessions listed, none
        // without a cwd, and two of this workspace's eight absent). A session this
        // workspace opened earlier lives in OUR cache regardless, so the union is what
        // makes "the list I saw before" and "the list I see now" agree.
        // [CUSTOM-20260927-094] …and with the agent's own transcript directory, which is
        // the only source that also covers sessions this workspace never opened (the
        // official Claude Code panel reads exactly that directory).
        this.postHistory(agent, 'merged', mergeHistoryRows(fromAgent, await this.readDiskHistory(agent), local()), askedCwd);
        return;
      }
      // Not connected: the cache plus (for Claude Code) the transcripts on disk.
      this.postHistory(agent, 'merged', mergeHistoryRows(await this.readDiskHistory(agent), local()), askedCwd);
    } catch (e: any) {
      // An agent-side failure still has the cache as a usable answer.
      this.postHistory(agent, 'local', local(), askedCwd,
        `Could not query the agent (${e?.message ?? e}); showing the local cache.`);
    }
  }

  /**
   * [CUSTOM-20260927-094] Rows recovered from the agent's OWN transcript directory.
   *
   * Only for Claude Code (that storage is a vendor detail — see diskSessions.ts), only for
   * the current workspace folder (the same scope the local cache uses), and never fatal:
   * every failure degrades to "no supplement", because this is an addition to the agent's
   * list, not a replacement for it.
   *
   * [CUSTOM-20260928-095] `cwd` overrides the scan directory — the history picker's
   * directory filter asks for the folder it is showing, which may be any folder the
   * agent lists (not just `workspaceFolders[0]`).
   */
  private async readDiskHistory(agent: string, cwd?: string): Promise<Array<Omit<HistorySessionSummary, 'dirKey'>>> {
    if (agent !== CLAUDE_CODE_AGENT) { return []; }
    const dirCwd = cwd ?? this.workspaceCwd();
    if (!dirCwd) { return []; }
    try {
      const dir = claudeTranscriptDir(dirCwd);
      const rows = await readDiskSessions(dir, dirCwd);
      log(`${LOG_PREFIX}: transcript supplement ${rows.length} rows from ${dir}`);
      return rows
        // [CUSTOM-20260928-097] Keep live sessions in the list (deduped by the merge);
        // still drop rows without a cwd — they cannot be filtered or reopened.
        .filter(r => !!r.cwd)
        .map(r => ({
          sessionId: r.sessionId,
          title: r.title ?? null,
          cwd: r.cwd,
          updatedAt: r.updatedAt,
          fromDisk: true,
        }));
    } catch (e) {
      log(`${LOG_PREFIX}: transcript supplement failed (ignored): ${(e as Error)?.message ?? e}`);
      return [];
    }
  }

  /**
   * [CUSTOM-20260928-095] Scan the transcript directory of ONE folder the picker's
   * filter selected, and hand back only the disk rows — as an INCREMENT, so the client
   * merges them without a full `history` replacement (which would reset the filter).
   */
  private async handleSupplementHistory(agentName: string | undefined, cwd: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent || !cwd) { return; }
    const rows = await this.readDiskHistory(agent, cwd);
    if (rows.length === 0) { return; }
    // [CUSTOM-20261009-212] 补扫也会带回归档过的行（磁盘转录不认我们的账）——同一个出口
    // 同一套过滤/覆盖，别让归档在"补扫"这条路上漏回来。
    const supplementLabels = this.sessionLabels();
    const sessions: HistorySessionSummary[] = rows
      .filter(s => !supplementLabels[s.sessionId]?.archived)
      .map(s => {
        const dirKey = directoryKey(s.cwd);
        const titled = supplementLabels[s.sessionId]?.title
          ? { ...s, title: supplementLabels[s.sessionId].title } : s;
        return dirKey ? { ...titled, dirKey } : titled;
      });
    this.post({ type: 'historySupplement', agentName: agent, cwd, sessions });
  }

  // [CUSTOM-BEGIN] CUSTOM-20261009-212 - 会话的本地覆盖（改名 / 归档）——读、写、改名流程。
  private sessionLabels(): Record<string, SessionLabelOverride> {
    return this.globalState?.get<Record<string, SessionLabelOverride>>(SESSION_LABELS_KEY) ?? {};
  }

  /** 覆盖标题；没有覆盖时返回 undefined，调用方继续走原来的回退链。 */
  private sessionLabelTitle(sessionId: string): string | undefined {
    const t = this.sessionLabels()[sessionId]?.title;
    return t ? t : undefined;
  }

  private async updateSessionLabel(sessionId: string, patch: SessionLabelOverride): Promise<void> {
    if (!this.globalState) { return; }
    const all = this.sessionLabels();
    await this.globalState.update(SESSION_LABELS_KEY, {
      ...all,
      [sessionId]: { ...(all[sessionId] ?? {}), ...patch },
    });
  }

  /**
   * 改名：原生输入框（webview 里没有等价控件），做完回一条 `sessionAction`。
   * 清空 / 取消都当"没改"——清空意味着"回到原始标题"，而那需要知道这条行的底层标题
   * （agent 的 / 缓存的 / 磁盘的都可能），列表这边拿不到它。宁可不动，也不猜。
   */
  private async handleRenameSession(sessionId: string, currentTitle: string): Promise<void> {
    const title = await vscode.window.showInputBox({
      title: 'Rename Session',
      prompt: 'New name for this session',
      value: currentTitle,
    });
    if (title === undefined || title.trim() === '') { return; }
    const clean = title.trim();
    await this.updateSessionLabel(sessionId, { title: clean });
    this.post({ type: 'sessionAction', action: 'rename', sessionId, title: clean });
    // 开着这条会话的 tab / 树也要换名字：toSummary 的 title 链已插了覆盖，推一把让
    // 客户端拿到新的 sessionsChanged（签名里含 title，所以不会被去重掉）。
    this.refreshSessions();
  }
  // [CUSTOM-END] CUSTOM-20261009-212

  /**
   * [CUSTOM-20260926-079] The ONE place a `history` reply is assembled.
   *
   * It exists because a reply now carries derived data as well as the rows: the
   * directory identity of every row and the filter's candidate directories. Three
   * reply paths (agent list, local cache, cache-after-error) each building that by
   * hand is how one of them ends up without a `dirKey` — the failure mode would be
   * rows that silently vanish from a filtered list.
   */
  private postHistory(
    agent: string,
    source: 'agent' | 'local' | 'merged',
    sessions: Array<Omit<HistorySessionSummary, 'dirKey'>>,
    currentCwd?: string,
    error?: string,
  ): void {
    // [CUSTOM-20261009-212] 本地覆盖在**唯一装配点**落地：归档的整行滤掉，改过名的换标题
    // （覆盖优先于任何来源的标题）。
    const labels = this.sessionLabels();
    const rows: HistorySessionSummary[] = sessions
      .filter(s => !labels[s.sessionId]?.archived)
      .map(s => {
        const dirKey = directoryKey(s.cwd);
        const titled = labels[s.sessionId]?.title ? { ...s, title: labels[s.sessionId].title } : s;
        return dirKey ? { ...titled, dirKey } : titled;
      });
    this.post({
      type: 'history',
      agentName: agent,
      source,
      sessions: rows,
      // [CUSTOM-20261001-155] `currentCwd` is the CLIENT's address-bar directory when it
      // sent one; the host-side guess is the fallback.
      directories: directoryOptions(rows, currentCwd ?? this.historyFilterCwd(agent)),
      ...(error ? { error } : {}),
    });
  }

  /**
   * [CUSTOM-20260926-079] The directory the history filter defaults to.
   *
   * [CUSTOM-20261001-155] Now only the FALLBACK (see postHistory): the panel's client
   * sends the directory its address bar is showing, which is the correct answer on a
   * draft page (drafts are client-local, 058) and is what the user actually sees. This
   * guess stays for callers that send none.
   *
   * The focused session's OWN directory, when that session belongs to the agent
   * being listed — the picker is per-agent and the focused session may belong to a
   * different one. Otherwise the first workspace folder. Undefined means "no
   * default": the client then opens the list unfiltered, which is the honest answer
   * for a session that has no directory yet (a draft).
   */
  private historyFilterCwd(agent: string): string | undefined {
    const focused = this.focused.sessionId
      ? sessionOf(this.sessionManager, this.focused.sessionId)
      : undefined;
    if (focused && focused.agentName === agent && focused.cwd) { return focused.cwd; }
    return this.workspaceCwd();
  }

  /** [CUSTOM-20260925-033] Open a session from the picker (load, else resume). */
  private async handleOpenHistorySession(
    agentName: string,
    sessionId: string,
    cwd?: string,
    title?: string,
    fromDraft = false,
    // [CUSTOM-20261009-209] 恢复上次的会话：**保留**其它已打开的会话（099 的"替换语义"是给历史
    // 选择器用的 —— 那是导航，不该越点越多；恢复则相反，它就是要多开）。
    keepOthers = false,
  ): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent || !sessionId) { return; }
    log(`${LOG_PREFIX}: opening history session ${sessionId} of ${agent}${cwd ? ` (cwd ${cwd})` : ''}`);
    try {
      // [CUSTOM-20260928-099] Picking from the history list SWITCHES the panel, it does
      // not pile up another tab: the currently focused session steps aside so the picked
      // one takes its place. Reported as "每次选历史都多开一个 tab" — the strip grew by
      // one on every visit, which is not what a history list means.
      //
      // Nothing is destroyed by this: the session stepping aside is still in the agent's
      // own history AND on disk, so the very same list reopens it later (that is the whole
      // point of §5.14/§5.24). A session that is ALREADY live keeps its tab — there is
      // nothing to replace, the pick is just a focus change.
      //
      // [CUSTOM-20260928-100] `fromDraft`: the CLIENT asked while sitting on a draft page.
      // That draft is what should step aside — not the focused SESSION, which the host
      // still holds (a draft is client-local, 058, so the host's `focused` names some
      // other session). The client discards its draft itself.
      const alreadyLive = !!this.sessionManager.getSession(sessionId);
      const current = this.focused.sessionId ? this.sessionManager.getSession(this.focused.sessionId) : undefined;
      if (!alreadyLive && !fromDraft && !keepOthers && current && current.sessionId !== sessionId) {
        try {
          await this.sessionManager.closeSession(current.agentName, current.sessionId);
        } catch (e) {
          // A failed teardown must not block the session the user asked for.
          log(`${LOG_PREFIX}: could not close ${current.sessionId} before switch (${String(e)})`);
        }
      }
      // [CUSTOM-20260928-100] Real per-message times, read before the replay starts
      // (the notifications arrive synchronously once it does).
      await this.preloadTranscriptTimes(agent, sessionId, cwd);
      // [CUSTOM-20260925-057] Pass the session's OWN directory. The picker shows
      // sessions from other directories (the agent-side list spans them), and
      // without this the agent was told the current workspace instead — so a
      // session belonging elsewhere was reopened as if it lived here.
      // [CUSTOM-20260928-098] The title too: the replay does not always re-send
      // session_info_update, so without it the tab would show the id prefix.
      const how = await this.sessionManager.openExistingSession(agent, sessionId, { cwd, title });
      if (how === 'resume') {
        const entry = this.transcripts.appendNotice(sessionId, 'info',
          'Resumed without replaying history (this agent does not support session/load).');
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
      }
    } catch (e) {
      this.reportError(null, e);
    }
  }

  // --- Draft page: directory choices + create-on-first-send (058) ----------

  /** How many recent directories the picker offers (keeps the drawer scannable). */
  private static readonly MAX_RECENT_DIRECTORIES = 8;

  // [CUSTOM-BEGIN] CUSTOM-20260930-151 - 草稿页的输入卡要"显示完整"（模式/模型/命令）。
  // 数据只能来自**该 agent 上一次会话**：模式/模型/可用命令在 ACP 里都是会话级的，而
  // `session/new` 没有 mode/model 入参（已核对 SDK 的 NewSessionRequest），草稿又还没有会话。
  // 所以这里按 agent 留一份"上次见到的快照"，草稿页拿它渲染、创建会话时再逐项校验后应用。
  /**
   * 记下某个会话当前的配置项与可用命令，作为该 agent 的草稿页快照。
   *
   * 调用点都挂在 SessionManager 的事件上（session-created / session-load-end /
   * config-options-changed / available-commands-changed），**不**挂 pushMeta —— 那个在
   * "没 surface attach"或"不是聚焦会话"时提前 return，后台会话的变化就进不来（而那正是下次
   * 点「+」要用的那份）。
   *
   * **空值不覆盖**：三条创建路径的时序并不一致，`[]` 常常只表示"这条路径还没填"而不是"这个
   * agent 没有"：
   *   · `loadSession` 在建好 placeholder 后才把 `configOptions` 写回去（`session-created`
   *     早于它，且不走 `applyConfigOptions`）—— 所以这里还额外订阅了 `session-load-end`；
   *   · `resumeSession` 的 `availableCommands` 恒为 `[]`（不重放），会把上一次好快照里的
   *     斜杠命令**清空**。
   * 一个陈旧的选项列表是无害的（应用时会逐项校验后跳过），而"快照退化"会让草稿页又变得不完整
   * —— 那正是这个功能要修的东西。空数组的代价则只是显示一个用不上、用不上就跳过的选项。
   */
  private rememberAgentOptions(sessionId: string): void {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const previous = this.draftOptions.get(session.agentName);
    const configOptions = session.configOptions ?? [];
    const availableCommands = wireCommands(session);
    const next: AgentOptionSnapshot = {
      configOptions: configOptions.length > 0 ? configOptions : (previous?.configOptions ?? []),
      availableCommands: availableCommands.length > 0 ? availableCommands : (previous?.availableCommands ?? []),
    };
    const signature = JSON.stringify(next);
    if (previous && JSON.stringify(previous) === signature) { return; }
    this.draftOptions.set(session.agentName, next);
    // globalState 只在真的变了才写：这个函数会跟着会话的每一次配置项变化跑。
    const store: DraftOptionsStore = {};
    for (const [agentName, snapshot] of this.draftOptions) { store[agentName] = snapshot; }
    void this.globalState?.update(DRAFT_OPTIONS_KEY, store);
    log(`${LOG_PREFIX}: draft options for ${session.agentName}: ${next.configOptions.length} option(s), ${next.availableCommands.length} command(s)`);
  }

  /**
   * [CUSTOM-20261001-159] The mode the user just picked, remembered per agent.
   *
   * Only USER actions call this (the three setters below) — never an agent-reported
   * change: a mode the agent switched to on its own (plan mode activating itself) is
   * not a preference, and letting those in would make the "default" silently follow
   * whatever the last session happened to do.
   *
   * The value is read from the config option (`category === 'mode'`), never from
   * `session.modes.currentModeId` — 128's rule: the option is the authoritative copy,
   * the other is a mirror only `applyConfigOptions` writes.
   */
  private rememberUserMode(sessionId: string): void {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const option = modeOptionOf(session.configOptions);
    if (!option) { return; }
    const value = String((option as { currentValue?: unknown }).currentValue ?? '');
    if (!value) { return; }
    const previous = this.lastMode.get(session.agentName);
    if (previous && previous.configId === option.id && previous.value === value) { return; }
    this.lastMode.set(session.agentName, { configId: option.id, value });
    const store: LastModeStore = {};
    for (const [agentName, mode] of this.lastMode) { store[agentName] = mode; }
    void this.globalState?.update(LAST_MODE_KEY, store);
    log(`${LOG_PREFIX}: remembered mode ${option.id}=${value} for ${session.agentName}`);
  }

  /**
   * [CUSTOM-20261001-159] Apply the remembered mode to a BRAND NEW session.
   *
   * Same three gates as a draft selection (the shape is deliberately the same — this
   * IS "the value the user chose, applied to a session that did not exist yet"):
   * the option must still be offered, the value must still be a candidate, and an
   * equal current value is skipped (no round trip, no chance for a spurious notice).
   *
   * Unlike a draft selection, a failure is logged and NOT announced in the record: a
   * default is not a request. The user never asked for this particular value here, so
   * a line about it failing would be noise about something they cannot see.
   */
  private async applyRememberedMode(sessionId: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const remembered = this.lastMode.get(session.agentName);
    if (!remembered) { return; }
    const option = (session.configOptions ?? []).find(o => o.id === remembered.configId);
    if (!option || (option as { category?: string }).category !== 'mode') {
      log(`${LOG_PREFIX}: remembered mode ${remembered.configId} is not offered by ${sessionId} (agent ${session.agentName}); skipped`);
      return;
    }
    if (String((option as { currentValue?: unknown }).currentValue ?? '') === remembered.value) { return; }
    const valid = option.type === 'boolean'
      ? remembered.value === 'true' || remembered.value === 'false'
      : selectValues(option).includes(remembered.value);
    if (!valid) {
      log(`${LOG_PREFIX}: remembered mode value ${remembered.value} is no longer a candidate; skipped`);
      return;
    }
    try {
      await this.sessionManager.setConfigOption(sessionId, remembered.configId, remembered.value);
      // Seed the switch baseline: our own setter has already written the authoritative
      // copy, so the agent's next notification about the same state diffs to nothing.
      // Without it the application would be announced as a switch the user never made
      // (the same trap applyDraftSelections documents at length).
      const state = this.choiceState(sessionId);
      if (state) { this.choices.set(sessionId, state); }
      this.pushMeta(sessionId);
      log(`${LOG_PREFIX}: applied remembered mode ${remembered.configId}=${remembered.value} to ${sessionId}`);
    } catch (e: any) {
      log(`${LOG_PREFIX}: applying the remembered mode failed (ignored): ${e?.message ?? e}`);
    }
  }

  /**
   * [CUSTOM-20261001-159] Wait for the mode application `session-created` kicked off.
   *
   * The draft page must run its OWN selections after the default: both land as
   * `session/set_config_option` on one connection, and the one that arrives last wins
   * — the user's explicit pick may not be overwritten by a default.
   */
  private async awaitModeApply(sessionId: string): Promise<void> {
    const pending = this.modeApply.get(sessionId);
    this.modeApply.delete(sessionId);
    if (pending) { await pending; }
  }

  /**
   * [CUSTOM-20260930-151] 草稿页问"这个 agent 的输入卡该显示什么"。
   *
   * 必须**无条件回话**（哪怕是空的）：客户端要靠这条应答才把选择器/斜杠列表布置好，让它在
   * 没有快照时静默等，正是 pitfalls #29 的形态（"效果上没变化 ≠ 可以不回话"）。
   * 定向发给发起请求的那个面，理由同 058 那四条：这是"某个文档正在编辑的草稿"。
   */
  private handleListDraftOptions(agentName: string | undefined, draftId: string, to: SurfaceKey): void {
    const agent = this.panelAgent(agentName);
    const snapshot = agent ? this.draftOptions.get(agent) : undefined;
    this.post({
      type: 'draftOptions',
      draftId,
      agentName: agent,
      // [CUSTOM-20261001-160] 模式那一项显示**记住的值**而不是上一条会话快照里的值：草稿页
      // 显示的就是"你不改的话会建成什么样"，而新建会话套用的正是记住的那个（159）。两处读的
      // 是同一条记录 —— 不是两份真相（pitfall #19）。
      configOptions: withRememberedMode(snapshot?.configOptions ?? [], agent ? this.lastMode.get(agent) : undefined),
      availableCommands: snapshot?.availableCommands ?? [],
    }, to);
  }
  // [CUSTOM-END] CUSTOM-20260930-151

  /**
   * [CUSTOM-20260925-058] Candidate directories for the draft page.
   *
   * Targeted at the asking surface: it is that document's draft being edited.
   */
  private async handleListDirectoryChoices(agentName: string | undefined, to: SurfaceKey): Promise<void> {
    const agent = this.panelAgent(agentName);
    this.post({
      type: 'directoryChoices',
      agentName: agent,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      recent: await this.recentDirectories(agent),
      defaultCwd: this.sessionManager.resolveDefaultCwd(),
    }, to);
  }

  /**
   * Directories this agent has used, most recent first.
   *
   * Two sources, merged: the local history cache (durable, but `workspaceState`
   * scoped — a fresh workspace knows nothing) and the AGENT's own
   * `session/list`, which spans directories (it is what the "open previous
   * session" picker shows). The agent side needs a live connection and the
   * `list` capability, so it is only consulted when both are present — a
   * directory list is never worth spawning a process for.
   */
  private async recentDirectories(agent: string | null): Promise<string[]> {
    if (!agent) { return []; }
    const merged: string[] = [];
    const push = (candidate: unknown): void => {
      if (typeof candidate !== 'string' || candidate.length === 0) { return; }
      if (merged.includes(candidate)) { return; }
      if (merged.length >= ChatPanelHost.MAX_RECENT_DIRECTORIES) { return; }
      merged.push(candidate);
    };

    for (const cwd of this.sessionManager.getHistoryStore()?.recentDirectories(agent) ?? []) {
      push(cwd);
    }
    if (this.sessionManager.isAgentConnected(agent)
      && this.sessionManager.getCachedCapabilities(agent)?.list) {
      try {
        const response = await this.sessionManager.listSessions(agent);
        for (const session of response.sessions) {
          push((session as { cwd?: unknown }).cwd);
        }
      } catch (e) {
        // A failed agent query is not worth failing the picker over: the local
        // cache is still a usable answer.
        log(`${LOG_PREFIX}: directory choices: agent list failed (${String(e)})`);
      }
    }
    return merged;
  }

  /** Native folder picker — the webview cannot open one itself. */
  private async handlePickDirectory(to: SurfaceKey): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this directory',
      defaultUri: vscode.Uri.file(this.sessionManager.resolveDefaultCwd()),
    });
    this.post({ type: 'directoryPicked', path: picked?.[0]?.fsPath ?? null }, to);
  }

  /**
   * [CUSTOM-20260925-058] The draft's first message: create the session **with
   * the chosen directory**, then send.
   *
   * This is the whole point of the draft page. Creating the session earlier (on
   * `+`) and recreating it when the directory changes would be simpler code, but
   * `session/close` does NOT remove a session from the agent's history — so every
   * directory change would leave another empty session behind (my own two
   * capture sessions are visible in that list as evidence).
   *
   * On failure the draft is left alone: the client keeps the tab AND the typed
   * text, and shows the message.
   */
  private async handleCreateDraftAndSend(
    draftId: string,
    agentName: string | undefined,
    cwd: string | undefined,
    text: string,
    selections: Array<{ configId: string; value: string }>,
    // [CUSTOM-20261005-193] 草稿页攒的附件：客户端本地拿着（草稿没有会话），随这条消息一起交上来。
    images: Array<{ id: string; name: string; mimeType: string; dataUrl: string }> = [],
    paths: string[] = [],
    to: SurfaceKey = 'view',
  ): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      this.post({ type: 'draftFailed', draftId, message: 'No agent to start a session with.' }, to);
      return;
    }
    // [CUSTOM-20261005-193] 有附件就该能发（客户端那条"空文字 + 有附件也可以发"的判据同义）。
    if (text.trim().length === 0 && images.length === 0 && paths.length === 0) {
      this.post({ type: 'draftFailed', draftId, message: 'Nothing to send.' }, to);
      return;
    }
    const target = cwd?.trim() || this.sessionManager.resolveDefaultCwd();
    log(`${LOG_PREFIX}: draft ${draftId}: creating a session for ${agent} in ${target}`);

    try {
      const session = await this.sessionManager.createSession(agent, { cwd: target, focus: true });
      // Resolve the draft BEFORE starting the turn: `handleSendPrompt` awaits the
      // whole turn (it is what carries the stop reason back), and the client must
      // be able to swap its draft tab for the real one immediately.
      this.post({ type: 'draftResolved', draftId, sessionId: session.sessionId }, to);
      // [CUSTOM-20261001-159] 先等"记住的默认模式"落地（session-created 那次应用），再应用用户
      // 在草稿页显式选过的值：两个都是同一条连接上的 setConfigOption，后到的赢 —— 顺序反了
      // 的话用户刚选的模式会被默认值盖回去。
      await this.awaitModeApply(session.sessionId);
      // [CUSTOM-20261005-193] 草稿页攒的附件：会话已经有了，**走与普通附件完全相同的那条路**
      // （handleAttachImage / handleAttachPaths），于是 handleSendPrompt 读 this.attachments /
      // imageData 时自然就带上了 —— 这里不另存一份，避免两份账（pitfall #19）。
      for (const image of images) {
        this.handleAttachImage(session.sessionId, image.id, image.name, image.mimeType, image.dataUrl);
      }
      if (paths.length > 0) { this.handleAttachPaths(session.sessionId, paths); }
      // [CUSTOM-20260930-151] 草稿页上选过的模式/模型只能在这里落到会话上（会话存在之前没有
      // 地方可下发），而且必须在首条消息**之前**——第一轮就该跑在用户选的设置上。
      await this.applyDraftSelections(session, selections);
      void this.handleSendPrompt(session.sessionId, text)
        .catch(e => this.reportError(session.sessionId, e));
    } catch (e: any) {
      this.post({ type: 'draftFailed', draftId, message: e?.message ?? String(e) }, to);
    }
  }

  /**
   * [CUSTOM-20260930-151] 把草稿页选好的配置项应用到刚建出来的这个会话上。
   *
   * 三道闸门，缺一不可：
   *   · 按**新会话**的 configOptions 校验（id 存在 + 取值仍在候选里）——快照可能来自 agent
   *     的旧版本，这正是"陈旧无害"这句话兑现的地方；
   *   · 与当前值相同的直接跳过：省一次往返，也少一次让 agent 推通知的机会；
   *   · 单项失败**不阻断**首条消息（一个坏值不该让用户发不出话），但也不许静默（pitfalls #29）：
   *     记日志 + 在记录区留一行，否则用户只会看到选择器自己弹回默认值。
   */
  private async applyDraftSelections(
    session: SessionInfo,
    selections: Array<{ configId: string; value: string }>,
  ): Promise<void> {
    if (selections.length === 0) { return; }
    // 记录区可能还没有这个会话的桶：`ensureSession` 平时由 `onSessionUpdate` 负责，而这里跑的时候
    // 首条消息还没发出去。少了这一句，下面那条"没能应用"的提示会被 `append` **静默丢掉**
    // （没有桶就返回 null）—— 正好复现它要避免的那个坑（这条是测试发现的）。
    this.transcripts.ensureSession(session.sessionId, session.agentName);
    const options = session.configOptions ?? [];
    let applied = 0;
    for (const { configId, value } of selections) {
      const option = options.find(o => o.id === configId);
      if (!option) {
        log(`${LOG_PREFIX}: draft selection ${configId} is not offered by session ${session.sessionId}; skipped`);
        continue;
      }
      if (String((option as { currentValue?: unknown }).currentValue) === value) { continue; }
      const valid = option.type === 'boolean'
        ? value === 'true' || value === 'false'
        : selectValues(option).includes(value);
      if (!valid) {
        log(`${LOG_PREFIX}: draft selection ${configId}=${value} is no longer a valid value; skipped`);
        continue;
      }
      try {
        await this.sessionManager.setConfigOption(session.sessionId, configId, value);
        applied += 1;
        // [CUSTOM-20261001-159] 用户在草稿页显式选过的模式，也算"用户的选择"——下次新建会话
        // 的默认值就是它（否则这里选一次、下个会话又弹回旧值，看起来就是没记住）。
        if ((option as { category?: string }).category === 'mode') {
          this.rememberUserMode(session.sessionId);
        }
      } catch (e: any) {
        const message = e?.message ?? String(e);
        log(`${LOG_PREFIX}: draft selection ${configId}=${value} failed: ${message}`);
        const entry = this.transcripts.appendNotice(
          session.sessionId, 'info',
          `Could not apply the ${option.name || configId} chosen on the new-session page.`,
        );
        if (entry) { this.post({ type: 'append', sessionId: session.sessionId, entries: [entry] }); }
      }
    }
    // 播种切换基线：我们自己的 setter 已经把权威那份写对了，所以 agent 随后推来的同状态通知
    // diff 为空（pitfall #34 那套"两份副本 + 去重"的既定前提）。不播种的话，只要 agent 在应用
    // 之前已经推过一次 session/update（onSessionUpdate 会拿**默认值**当基线），应用后的通知就
    // 会被当成一次用户从未做过的"切换"播报出来。
    if (applied > 0) {
      const state = this.choiceState(session.sessionId);
      if (state) { this.choices.set(session.sessionId, state); }
      this.pushMeta(session.sessionId);
      log(`${LOG_PREFIX}: draft applied ${applied} selection(s) to ${session.sessionId}`);
    }
  }

  // --- Outbound messages ---------------------------------------------------

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 单目标 → 广播（可定向）。
  // 两个面同时存在时，除 `boot` 外的一切都必须两端一致：客户端本来就按
  // `currentSessionId` 过滤，所以广播既安全又是让两侧保持同步的最简做法。
  //
  // [CUSTOM-20260924-022] 这里同时是**合帧队列的入口**：按消息类型决定走
  // 「攒一帧再发」（可按条目合并）还是「立即发」（结构性）。路由表放在这一处，
  // 而不是散在每个调用点——漏改一个调用点就会静默破坏 INV-A（revise 越过 append）
  // 或 INV-C（sessionsChanged 被延迟，Send/Stop 按钮状态错）。
  private post(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    const type = (message as { type?: string }).type ?? '';
    // [CUSTOM-20260925-063] One choke point for "a session produced output": every
    // transcript-bearing message goes through here, so the unread marker cannot be
    // remembered on some append paths and forgotten on others (which is what a
    // per-call-site approach would eventually do).
    if (type === 'append' || type === 'revise' || type === 'toolUpdate') {
      const sessionId = (message as { sessionId?: string }).sessionId;
      if (sessionId && this.focused.sessionId !== sessionId && !this.unread.has(sessionId)) {
        this.unread.add(sessionId);
        // Tell the strip immediately. Without this the dot could wait for the next
        // unrelated refresh — some append paths (a notice, terminal output) never
        // call refreshSessions themselves.
        this.refreshSessions();
      }
    }
    if (!to && !STRUCTURAL_MESSAGE_TYPES.has(type)) {
      this.outbox.enqueue(message as ExtToChatMessage);
      return;
    }
    this.postNow(message, to);
  }

  /** Broadcast (or target) immediately, bypassing the coalescing queue. */
  private postNow(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    if (to) {
      const only = this.surfaces.get(to);
      if (only) { this.send(only, message); }
      return;
    }
    for (const surface of this.surfaces.values()) { this.send(surface, message); }
  }

  private send(surface: ChatSurface, message: ExtToChat | MarkdownRendered): void {
    // Watch the returned promise: a payload that fails structured clone rejects,
    // and a bare `void` would swallow that. Silent send failures are exactly
    // what makes "the UI just shows nothing" impossible to diagnose.
    const sent = surface.webview.postMessage(message);
    void sent?.then(undefined, (e: unknown) => {
      log(`${LOG_PREFIX}: postMessage failed for "${(message as { type?: string }).type}" on "${surface.key}": ${String(e)}`);
    });
  }
  // [CUSTOM-END] CUSTOM-20260924-019

  /**
   * [CUSTOM-20261008-206] 编辑器里「当前打开的文件」（含多行选区的行区间）→ 输入框的引用栏。
   *
   * 它让「把正在看的这个文件加进这条消息」从「找文件 + Attach File」变成点一下 `+`（与官方插件同一件事）。
   * 只在**签名变化**时推：`onDidChangeTextEditorSelection` 每次光标移动都会回调，而区间叠成「行号」之后，
   * 同一行里移动是不该发的（否则光标一动就是一条消息）。
   * `force` 用于面刚挂上来的那一刻 —— 签名是全局的，第二个面挂上来时不该因为「另一个面拿过了」而拿不到。
   */
  private pushActiveFile(force = false): void {
    if (this.attachedCount === 0) { return; }
    const info = readActiveFileFrom(vscode.window.activeTextEditor as ActiveEditorLike | undefined);
    const signature = info
      ? info.path + '|' + (info.lineStart ?? '') + '|' + (info.lineEnd ?? '')
      : '';
    if (!force && signature === this.activeFileSignature) { return; }
    this.activeFileSignature = signature;
    this.post({ type: 'activeFile', file: info });
  }

  /**
   * [CUSTOM-20261009-209] 记下「此刻开着哪些会话、聚焦哪一个」，供下次重开面板时恢复。
   *
   * - **顺序按 uiPrefs.tabOrder**：那正是客户端的手工顺序，恢复出来的 tab 才会回到原位。
   * - **只有本生命周期出现过会话之后，才允许写空表** —— 否则重载后刚启动、一个会话都还没有的
   *   那一瞬间就会把上一次的快照抹掉（而那正是要读它的时刻）。
   * - **防抖**：它挂在 created / closed / focus 三个事件上，而 focus 会因为"切标签"频繁发生。
   */
  private saveOpenSessions(): void {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      const live = this.liveSessionsInTabOrder();
      if (live.length === 0 && !this.sawLiveSession) { return; }
      const snapshot: OpenSessionsSnapshot = { sessions: live, focused: this.focused.sessionId };
      this.openSessions = snapshot;
      const write = this.globalState?.update(OPEN_SESSIONS_KEY, snapshot);
      if (write) { void Promise.resolve(write).catch(() => undefined); }
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * [CUSTOM-20261009-209] 恢复时把一条快照会话真正加载回来。
   *
   * 与历史选择器走**同一个决策点**（`openExistingSession`：load 优先、否则 resume），差别只有两点：
   *   · 它**不动**其它已打开的会话（历史选择器有"替换语义"，恢复是"多开"）；
   *   · 失败（会话在 agent 侧已经没了/转录被删）时把这一条从快照里摘掉，别下次再拿它问用户。
   */
  private async openSnapshotSession(entry: RecoverableSession): Promise<void> {
    const agent = this.panelAgent(entry.agentName);
    if (!agent) { return; }
    try {
      await this.preloadTranscriptTimes(agent, entry.sessionId, entry.cwd);
      await this.sessionManager.openExistingSession(agent, entry.sessionId, { cwd: entry.cwd, title: entry.title });
    } catch (e) {
      log(`${LOG_PREFIX}: could not restore ${entry.sessionId}: ${(e as Error)?.message ?? String(e)}`);
      this.openSessions = {
        sessions: (this.openSessions?.sessions ?? []).filter(s => s.sessionId !== entry.sessionId),
        focused: this.openSessions?.focused ?? null,
      };
      this.globalState?.update(OPEN_SESSIONS_KEY, this.openSessions);
      this.reportError(null, e);
    }
  }

  /** 活着的 modern 会话，按客户端那份手工顺序排（不在表里的按 SessionManager 的顺序接在后面）。 */
  private liveSessionsInTabOrder(): RecoverableSession[] {
    const out: RecoverableSession[] = [];
    for (const agentName of MODERN_AGENTS) {
      for (const sessionId of this.sessionManager.getSessionIdsForAgent(agentName)) {
        const session = this.sessionManager.getSession(sessionId);
        out.push({
          agentName,
          sessionId,
          ...(session?.cwd ? { cwd: session.cwd } : {}),
          ...(session?.title ? { title: session.title } : {}),
        });
      }
    }
    const rank = new Map<string, number>();
    (this.uiPrefs?.tabOrder ?? []).forEach((id, index) => rank.set(id, index));
    const known = out.filter(s => rank.has(s.sessionId));
    const unknown = out.filter(s => !rank.has(s.sessionId));
    known.sort((a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0));
    return known.concat(unknown);
  }

  /**
   * [CUSTOM-20261009-209] 可以恢复的会话：快照里**现在不活的**那些（活着的已经是 tab 了）。
   *
   * 已被答复（选过"开始新的"）或设置是 `never` 时返回空 —— 上层据此决定"问不问"，
   * `handleConnectAgent` 也据此决定"要不要当场建一个新会话"。
   */
  private recoverableSessions(): RecoverableSession[] {
    if (this.restoreDismissed) { return []; }
    if (this.prefs.getRestore() === 'never') { return []; }
    const snapshot = this.openSessions;
    if (!snapshot || snapshot.sessions.length === 0) { return []; }
    return snapshot.sessions.filter(s => !this.sessionManager.getSession(s.sessionId));
  }

  private postRestorePref(): void {
    this.post({ type: 'restorePref', value: this.prefs.getRestore() });
  }

  private pushBoot(to?: SurfaceKey): void {
    if (this.attachedCount === 0) { return; }
    // INV-E: the snapshot must not overtake anything still sitting in the queue.
    this.outbox.flush();
    this.refreshLiveSessionIds();
    const recoverable = this.recoverableSessions();
    const sessions = this.buildSummaries();
    const focused = this.focused.sessionId ? this.buildSummary(this.focused.sessionId) : null;
    this.post({
      type: 'boot',
      focused,
      sessions,
      snapshot: focused ? this.snapshotOf(focused.sessionId) : null,
      meta: focused ? this.metaOf(focused.sessionId) : null,
      agentConnected: this.panelAgentConnected(),
      // [CUSTOM-20260930-125] 首屏值随 boot 一起走：客户端的自动连接布防需要
      // {agentConnected, focused, autoConnect} 三者同时成立。
      autoConnect: this.prefs.getAutoConnect(),
      // [CUSTOM-20261008-199] 没有聚焦会话时地址栏显示它：连接适配器（npx 下载）那几十秒里
      // 面板就是"已连接、还没有会话"，那时地址栏空着会看着像坏了（090 当初把这一格整个隐藏）。
      // 与草稿页显示的是**同一份**语义（下次会话建在这里），所以也复用宿主这一个解析器。
      defaultCwd: this.sessionManager.resolveDefaultCwd(),
      // [CUSTOM-20261009-209] 上次退出时开着的会话（现在都不活）→ 空态卡片据此问一句要不要恢复。
      // 只给 modern agent 的（legacy 交给旧面板会换文档）；一条都没有时不带这个字段。
      ...(recoverable.length > 0 ? { recoverable } : {}),
      restorePref: this.prefs.getRestore(),
    }, to);
    // [CUSTOM-20260926-077] Bring the outline pin/width prefs along with the boot,
    // so a recreated webview (editor panel reopen / window reload) restores them.
    if (this.uiPrefs) {
      this.post({ type: 'uiPrefs', ...this.uiPrefs }, to);
    }
  }

  private pushFocus(): void {
    if (this.attachedCount === 0) { return; }
    this.outbox.flush();
    const sessionId = this.focused.sessionId;
    const summary = sessionId ? this.buildSummary(sessionId) : null;
    this.post({
      type: 'focus',
      summary,
      snapshot: summary ? this.snapshotOf(sessionId!) : null,
      meta: summary ? this.metaOf(sessionId!) : null,
      agentConnected: this.panelAgentConnected(),
    });
  }

  private pushMeta(sessionId: string): void {
    if (this.attachedCount === 0) { return; }
    if (this.focused.sessionId !== sessionId) { return; }
    this.post({ type: 'meta', sessionId, meta: this.metaOf(sessionId) });
  }

  private pushTurnState(sessionId: string): void {
    this.refreshSessions();
    this.pushMeta(sessionId);
  }

  private refreshSessions(): void {
    if (this.attachedCount === 0) { return; }
    this.refreshLiveSessionIds();
    const sessions = this.buildSummaries();
    // [CUSTOM-20260924-022] This runs on EVERY agent message chunk, so without
    // the signature check each streamed token rebuilt the whole tab strip and
    // agent dropdown on the client. Skipping the no-op case is also what keeps
    // `flushThenPost` from flushing the coalescing queue on every chunk.
    // [CUSTOM-20260927-090] The connection flag is part of the signature: an agent
    // connecting or disconnecting changes what the empty state must say, and a signature
    // that missed it would never refresh the strip — the same trap 022 documented for
    // `unread`.
    const agentConnected = this.panelAgentConnected();
    const signature = `conn:${agentConnected ? 1 : 0}\n` + sessions
      .map(s => `${s.sessionId}|${s.agentName}|${s.title ?? ''}|${s.loading ? 1 : 0}|${s.running ? 1 : 0}|${s.unread ? 1 : 0}|${s.waiting ? 1 : 0}`)
      .join('\n');
    if (signature === this.lastSessionsSignature) { return; }
    this.lastSessionsSignature = signature;
    this.outbox.flushThenPost({ type: 'sessionsChanged', sessions, agentConnected });
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
      // [CUSTOM-20260928-097] Title first, then the cached title, then the first
      // prompt — matching the history picker's fallback chain (078), not just
      // firstPrompt (which left a reopened session showing its id prefix).
      // [CUSTOM-20261009-212] 本地改名排在最前：覆盖就是覆盖（tab / 树跟着换名字靠这条）。
      title: this.sessionLabelTitle(session.sessionId)
        ?? session.title ?? stored?.title ?? stored?.firstPrompt ?? null,
      cwd: session.cwd,
      createdAt: session.createdAt,
      loading: this.sessionManager.isLoading(session.sessionId),
      // [CUSTOM-20261001-162] A turn in flight OR background work still reporting (see
      // noteBackgroundTask) — the composer's Send/Stop follows this.
      running: this.isSessionRunning(session.sessionId),
      // [CUSTOM-20260925-063] Drives the tab-strip "attention" dot. NOTE:
      // refreshSessions()'s signature string must include it too, or the strip
      // would never be told this changed (022's signature de-dup trap).
      unread: this.unread.has(session.sessionId),
      // [CUSTOM-20260930-130] A prompt or a form is parked on this session. Read from the
      // bridges — they own the pending lists, so there is exactly one copy of "who is
      // waiting" (pitfalls #19).
      waiting: (this.permissionBridge?.hasPendingFor(session.sessionId) ?? false)
        || (this.elicitationBridge?.hasPendingFor(session.sessionId) ?? false),
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
        if (!inv) {
          // NOT temporary (the earlier label said otherwise): a tool entry whose
          // invocation cannot be found is sent WITHOUT a view model, so the client
          // renders it as an empty shell — and this log line is the only place
          // that says WHY. 027's lesson was that the reason must be visible in the
          // output channel rather than in a webview console nobody opens, and it
          // costs one line only when the invocation is genuinely gone.
          log(`${LOG_PREFIX}: snapshot missing invocation ${entry.toolCallId} in ${sessionId}`);
          return entry;
        }
        return { ...entry, toolView: toToolCallView(inv) };
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
      availableCommands: wireCommands(session),
      usage: this.usage.get(sessionId) ?? null,
      // [CUSTOM-20261004-187] Whether Enter may send while a turn is running.
      steering: this.sessionManager.supportsSteering(sessionId),
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

/**
 * [CUSTOM-20261009-209] globalState 里的「上次打开过的会话」：条目的顺序就是 tab 的顺序。
 */
interface OpenSessionsSnapshot {
  sessions: RecoverableSession[];
  focused: string | null;
}

/**
 * [CUSTOM-20261009-209] 设置值的消毒：手改过的 settings.json 不该把客户端的相位机带进未知状态
 * （同 `resolveAutoConnect` 的理由）。抽成**导出的纯函数**是为了可测。
 */
export function resolveRestoreChoice(value: unknown): RestoreChoice {
  return value === 'always' || value === 'never' ? value : 'ask';
}

/**
 * [CUSTOM-20260930-125] The one settings interaction this host has, behind an interface
 * so tests can hand it a stub instead of writing the developer's settings.json.
 */
export interface PanelPrefsIO {
  getAutoConnect(): boolean;
  setAutoConnect(value: boolean): Promise<void>;
  // [CUSTOM-20261009-209] 「重开面板要不要恢复上次的会话」：ask / always / never。
  getRestore(): RestoreChoice;
  setRestore(value: RestoreChoice): Promise<void>;
}

/** [CUSTOM-20260930-125] Default implementation: the real VS Code configuration. */
export function vscodePanelPrefs(): PanelPrefsIO {
  const config = () => vscode.workspace.getConfiguration('acpc');
  return {
    // Through the resolver: `get<boolean>` is a cast, not a runtime check, and a
    // hand-edited settings.json must not be able to feed a non-boolean to a checkbox.
    getAutoConnect: () => resolveAutoConnect(config().get<unknown>('autoConnectOnOpen')),
    setAutoConnect: async value => {
      await config().update('autoConnectOnOpen', value, vscode.ConfigurationTarget.Global);
    },
    getRestore: () => resolveRestoreChoice(config().get<unknown>('restoreSessionsOnOpen')),
    setRestore: async value => {
      await config().update('restoreSessionsOnOpen', value, vscode.ConfigurationTarget.Global);
    },
  };
}

/**
 * [CUSTOM-20261001-156] Default implementation: a real VS Code notification.
 *
 * Lives here rather than in SessionNotifier for the same reason `vscodePanelPrefs`
 * lives here: that module must not import vscode, or its unit test could not run
 * outside the Extension Host. `Promise.resolve` adopts the extension API's own
 * thenable, so the seam stays a plain Promise.
 */
export function vscodeNoticeChannel(): NoticeChannel {
  return {
    show: (level, message, action) => Promise.resolve(
      level === 'warning'
        ? vscode.window.showWarningMessage(message, action)
        : vscode.window.showInformationMessage(message, action),
    ),
  };
}

/** [CUSTOM-20260930-125] Exported for its table test: only the boolean true is true. */
export function resolveAutoConnect(raw: unknown): boolean {
  return raw === true;
}

/**
 * [CUSTOM-20260929-119] Which presenter interface this state belongs to. The two
 * states share `promptId` / `sessionId` / `status` but nothing else: a permission
 * prompt carries `options`, a form carries `fields`.
 */
function isElicitationState(state: PermissionState | ElicitationState): state is ElicitationState {
  return Array.isArray((state as ElicitationState).fields);
}

/**
 * [CUSTOM-20261001-157] How a turn ended, for the turn-done notification.
 * `silent` is the third state on purpose: a turn the USER cancelled needs no toast
 * ("你可真行，你按的 Stop 你自己知道") — but it also must not read as "已完成".
 */
interface TurnOutcome {
  silent?: boolean;
  failed?: boolean;
  detail?: string;
}

/**
 * [CUSTOM-20261001-157] The one wording for a non-normal stop reason, or null when
 * there is nothing to say (`end_turn` = normal, `cancelled` = the user did it).
 *
 * Two consumers render it — the transcript notice (`applyStopReason`) and the
 * turn-done notification — so it lives in exactly one place; two hand-written
 * copies is precisely how the record and the toast end up disagreeing (#19).
 */
export function stopReasonText(stopReason: string | undefined): string | null {
  if (!stopReason || stopReason === 'end_turn' || stopReason === 'cancelled') { return null; }
  return stopReason === 'refusal'
    ? 'The agent refused to continue. This turn will not be included in the next prompt.'
    : stopReason === 'max_tokens'
      ? 'The turn was cut short by the token limit.'
      : stopReason === 'max_turn_requests'
        ? 'The turn was cut short by the agent-request limit.'
        : `Turn ended with reason: ${stopReason}`;
}

/** [CUSTOM-20261001-157] A finished turn → what (if anything) the notification says. */
export function turnOutcome(stopReason: string | undefined): TurnOutcome {
  if (stopReason === 'cancelled') { return { silent: true }; }
  const detail = stopReasonText(stopReason);
  return detail ? { failed: true, detail } : {};
}

/**
 * [CUSTOM-20261001-159] The session's mode, as the config option list spells it
 * (`category === 'mode'`), or undefined when this agent does not offer one.
 *
 * One place answers "which option is the mode": the picker, the remember step and
 * the apply step all ask this, and three copies of the predicate is how they drift
 * (pitfall #19). Note it is the OPTION's own id that is returned — never the literal
 * string 'mode' — because that id is what `setConfigOption` needs.
 */
export function modeOptionOf(
  options: readonly SessionConfigOption[] | null | undefined,
): SessionConfigOption | undefined {
  return (options ?? []).find(o => (o as { category?: string }).category === 'mode');
}

/**
 * [CUSTOM-20261001-160] The draft page's option list, with the remembered mode shown
 * as the current value (see handleListDraftOptions).
 *
 * A pure copy: the snapshot in `draftOptions` is the agent's own last-seen state and
 * must not be rewritten with a preference — the next session's real configOptions
 * (not this display copy) is what `applyRememberedMode` validates against.
 */
export function withRememberedMode(
  options: readonly SessionConfigOption[],
  remembered: RememberedMode | undefined,
): SessionConfigOption[] {
  if (!remembered) { return options as SessionConfigOption[]; }
  return options.map(option => (option.id === remembered.configId
    // The union (select | boolean) does not survive a spread — the cast is the shape
    // the spread cannot express, not a lie about the value.
    ? { ...option, currentValue: remembered.value } as SessionConfigOption
    : option));
}

function sessionOf(manager: SessionManager, sessionId: string): SessionInfo | undefined {
  return manager.getSession(sessionId);
}

/**
 * [CUSTOM-20260930-151] ACP 的 `AvailableCommand` → 协议里的命令视图。
 *
 * 宿主里只有这一份映射：`metaOf`（会话）与草稿页快照（还没有会话）必须给出同一个形状，
 * 否则客户端要按来源分两套读法——那正是 pitfalls #19 说的"跨边界的重复知识"。
 */
function wireCommands(session: SessionInfo | undefined): SessionMeta['availableCommands'] {
  return (session?.availableCommands ?? []).map(c => ({
    name: c.name,
    description: c.description,
    inputHint: (c.input as any)?.hint ?? null,
  }));
}

/**
 * [CUSTOM-20261007-198] Tab 顺序来自 webview，只信它是个字符串数组，并且有上限：
 * 一个坏掉的客户端（或手改过的 state）不该让这条偏好无限长，也不该把非字符串写进 globalState。
 */
function sanitizeTabOrder(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || out.includes(entry)) { continue; }
    out.push(entry);
    if (out.length >= 200) { break; }
  }
  return out;
}

/**
 * [CUSTOM-20261008-200] 「会话 id → 开/关」这张表的消毒器（Times 与大纲侧栏的开/关共用）。
 *
 * 来源是 webview，所以只信它的**形状**：键必须是非空短字符串（会话 id 的实际字符集，防手改过的
 * state 塞进来一整篇文本）、值只收布尔、条数有上限（同 `sanitizeTabOrder`：这两张表都随用户动作
 * 增长，客户端已经在写之前裁过，上限是第二道闸）。非对象 = 什么都没留下 ⇒ 空表 —— 与
 * `sanitizeTabOrder` 对"不是数组"的处理**同形**。"这一轮没改它"是另一件事，由调用方按
 * "字段缺不缺"判断，不靠这里的返回值。
 *
 * [CUSTOM-20261008-204] 从 `sanitizeTimesMap` 改名而来：大纲侧栏的按会话开关与它**同一形状**，
 * 共用一份比抄第二份强（两份迟早漂移 —— pitfalls #19）。
 */
function sanitizeSessionFlags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  const out: Record<string, boolean> = {};
  let count = 0;
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on !== 'boolean' || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) { continue; }
    out[key] = on;
    count += 1;
    if (count >= 200) { break; }
  }
  return out;
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

/**
 * [CUSTOM-20260927-092] Union the agent's history rows with the local cache's.
 *
 * The agent's row wins field by field (it is the authority on what still exists), and a
 * session only the cache knows about is marked `fromCache` so the client can say where it
 * came from — such a row may have been deleted agent-side, and pretending otherwise would
 * make the picker look authoritative when it is not. Sorted newest first, because the
 * picker's whole point is "the sessions I was just in".
 */
function mergeHistoryRows(
  ...sources: Array<Array<Omit<HistorySessionSummary, 'dirKey'>>>
): Array<Omit<HistorySessionSummary, 'dirKey'>> {
  // First source wins per field ('agent' beats 'transcripts' beats 'cache'), and a row
  // only a later source knows about keeps that source's mark so the client can say where
  // it came from — such a row may no longer exist agent-side, and pretending otherwise
  // would make the picker look authoritative when it is not.
  const byId = new Map<string, Omit<HistorySessionSummary, 'dirKey'>>();
  for (let i = sources.length - 1; i >= 0; i--) {
    for (const row of sources[i]) { byId.set(row.sessionId, row); }
  }
  return Array.from(byId.values()).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

function textOf(content: unknown): string {
  if (!content || typeof content !== 'object') { return ''; }
  const block = content as { type?: string; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

// [CUSTOM-20260928-109] 注入块（<task-notification> 等）不是用户输入，却走同一个
// user chunk 通道 —— 渲染成蓝色用户气泡会把"agent 的回报"误读成"我说过这句话"。
// 判据是前缀（与 diskSessions.ts:66 的 <local-command 先例同一类）。
const INJECTED_PREFIXES = [
  '<task-notification', '<system-reminder', '<local-command', '<command-name', '<command-message',
  // [CUSTOM-20261008-205] 其它 IDE 上下文块（`<ide_selection>` / `<ide_diagnostics>` …）也不是
  // 用户说过的话：认不出形状时至少别渲染成蓝色气泡。认得出来的那个（`<ide_opened_file>`）走下面
  // 的专用通道，变成消息上的文件 chip。
  '<ide_',
];

// [CUSTOM-20261008-205] IDE 注入的"当前打开的文件"上下文。
const IDE_OPENED_FILE_BLOCK = /^\s*<ide_opened_file>([\s\S]*?)<\/ide_opened_file>\s*$/;

/**
 * [CUSTOM-20261008-205] 从 IDE 上下文块里取出文件路径；不是这个块就返回 null。
 *
 * 它是**上下文**，不是用户说过的话 —— 用户报的"附加的文件被拆成了两条对话"就是它：这个块以前按
 * 普通 user chunk 走，于是同一条消息渲染成**两个**蓝色气泡（一个只有 `<ide_opened_file>…` 的原文，
 * 一个才是正文）。官方插件把它渲染成消息上的一个**文件 chip**（同一气泡里、正文在下），这里照做 ——
 * 块本身不建记录，文件挂到同一条消息的用户气泡上（见 user_message_chunk 分支）。
 */
function ideOpenedFilePath(text: string): string | null {
  const m = IDE_OPENED_FILE_BLOCK.exec(text);
  if (!m) { return null; }
  const named = /opened the file\s+(.+?)\s+in the IDE/i.exec(m[1]);
  if (named) { return named[1].trim(); }
  // 措辞若变了也不能把它变回蓝色气泡：退一步找第一个像路径的片段（盘符，或以 / 开头）。
  const guess = /([A-Za-z]:[\\/][^\s<>"']+|\/[^\s<>"']+)/.exec(m[1]);
  return guess ? guess[1].trim() : null;
}

/** [CUSTOM-20261008-205] 路径 → 用户气泡上那个文件 chip 的视图（点它走 openFile，见 039）。 */
function ideFileChip(filePath: string): ContentBlockView {
  const name = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  return { type: 'resource_link', uri: filePath, name, title: name, path: filePath };
}

/**
 * [CUSTOM-20261008-206] `readActiveFileFrom` 要的那几样（**结构子集**，不是 vscode.TextEditor 全量）
 * —— 抽出来是为了**可测**：真 `vscode.window.activeTextEditor` 在测试宿主里造不出来，而"1 基行号 /
 * 停在下一行行首不算"这类判据值得钉住（同 `pickDefaultCwd` 的既有做法：把 vscode 外壳与纯函数分开）。
 */
export interface ActiveEditorLike {
  document: { uri: { scheme: string; fsPath: string } };
  selection: {
    isEmpty: boolean;
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * [CUSTOM-20261008-206] 编辑器里当前打开的文件 + 多行选区的行区间（1 基、含两端），喂给输入框的引用栏。
 *
 * **行号是 0 基、界面上是 1 基**：这里统一换成 1 基。选区若停在下一行的行首（character 0），那一行
 * 不算选中 —— 与编辑器自己的显示一致（否则从第 3 行拖到第 5 行开头会显示成 3-5，而编辑器显示 3-4）。
 * 单行选区不带区间（引用整个文件）；没有可见编辑器、或不是本地文件（`untitled:` / 虚拟文档）时返回 null。
 */
export function readActiveFileFrom(
  editor: ActiveEditorLike | undefined,
): { path: string; name: string; lineStart?: number; lineEnd?: number } | null {
  if (!editor || editor.document.uri.scheme !== 'file') { return null; }
  const path = editor.document.uri.fsPath;
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const sel = editor.selection;
  if (!sel || sel.isEmpty) { return { path, name }; }
  let endLine = sel.end.line;
  if (sel.end.character === 0 && endLine > sel.start.line) { endLine -= 1; }
  if (endLine <= sel.start.line) { return { path, name }; }
  return { path, name, lineStart: sel.start.line + 1, lineEnd: endLine + 1 };
}

/** [CUSTOM-20261008-205] IDE 上下文的暂存键：会话 + messageId（回放里同一消息的两条 chunk 靠它配对）。 */
function ideKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}

/**
 * [CUSTOM-20261008-207] 两条引用是不是**同一条**：路径 + 行区间。
 *
 * 同一个文件的不同段是**不同的引用**（用户可以引用 foo.cs 的 12-40 行和 5-9 行两次，207 的要求）；
 * 没有区间的（拖拽/粘贴进来的文件、图片）按路径比 —— 与它们原来的行为一致。
 */
function sameReference(a: Attachment, b: Attachment): boolean {
  if (a.path !== b.path) { return false; }
  return (a.lineStart ?? 0) === (b.lineStart ?? 0) && (a.lineEnd ?? 0) === (b.lineEnd ?? 0);
}

function isInjectedChunk(text: string): boolean {
  const t = text.trimStart();
  for (const p of INJECTED_PREFIXES) { if (t.startsWith(p)) { return true; } }
  return false;
}

/**
 * [CUSTOM-20261001-162] A background task reporting back (Claude Code injects these
 * into the session when a `run_in_background` sub-agent finishes).
 *
 * Separate from `isInjectedChunk` on purpose: that one answers "is this the user
 * speaking" (five prefixes), this one answers "did the work we were waiting for
 * finish" (one). Reusing the wider predicate would end the wait on any injection.
 */
function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification');
}

/** [CUSTOM-20261001-162] The agent just launched a background task (Task 工具的 run_in_background)。 */
function isBackgroundLaunch(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== 'object') { return false; }
  const flag = (rawInput as Record<string, unknown>).run_in_background;
  return flag === true || flag === 'true';
}

/**
 * [CUSTOM-20261001-162] Which updates count as "still working".
 *
 * Deliberately NOT every notification: `session_info_update` / `available_commands_update` /
 * `current_mode_update` / `usage_update` are housekeeping and can arrive while the agent
 * is idle — counting them would pin a Stop button onto a session with nothing running.
 */
function isWorkUpdate(update: { sessionUpdate?: string }): boolean {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
      return true;
    default:
      return false;
  }
}

/** 剥掉外层 <tag>…</tag>，取第一行可见内容。 */
function stripInjectionWrapper(text: string): string {
  const t = text.trim();
  const m = t.match(/^<[a-z][\w-]*>/);
  if (!m) { return t; }
  const closeTag = '</' + m[0].slice(1);
  const inner = t.endsWith(closeTag) ? t.slice(m[0].length, -closeTag.length) : t.slice(m[0].length);
  return inner.trim();
}

function firstLineOf(text: string): string {
  const nl = text.indexOf('\n');
  const line = nl >= 0 ? text.slice(0, nl) : text;
  return line.trim() || '(no content)';
}

function fileUri(path: string, cwd?: string): vscode.Uri {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return vscode.Uri.file(path);
  }
  // Relative paths resolve against the session's working directory.
  const base = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return vscode.Uri.file(base ? `${base}/${path}` : path);
}

/** [CUSTOM-20260928-096] Strip `data:image/png;base64,` from a data URL (ACP `image.data` wants raw base64). */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
