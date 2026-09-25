// [CUSTOM-BEGIN] CUSTOM-20260923-010 - 多会话 / 多 agent 并行改造。
// 上游是「单活跃会话」模型（activeSessionId 唯一、agentSessions 为 1:1 映射、connectToAgent 强制
// 断开前一个 agent、load/resume 驱逐同 agent 的旧会话）。本改造将其改为 N 进程 × M 会话：
//   · agentSessions  → Map<agentName, Set<sessionId>>（1:N）
//   · 新增 agentProcesses / agentProcessNames（agent 名 ↔ 进程 id 双向索引，作为「是否已连接」的真相源）
//   · 新增 inFlightTurns（每会话在途轮次）与 connectionQueues（每连接控制面串行化）
//   · connectToAgent 不再断开其他 agent；newConversation 不再销毁旧会话
//   · 新增 createSession / closeSession / focusSession；loadSession / resumeSession 不再驱逐
//   · 生命周期监听器改为构造函数中一次性注册（修上游「每次 connect 注册一对监听器且从不移除」的泄漏，
//     以及 ensureConnected 路径完全不注册监听器导致无错误/退出处理的盲区）
//   · 事件契约仅追加尾参，不改名：active-session-changed 增加 agentName、agent-closed 增加 agentName、
//     clear-chat 增加 (agentName, sessionId)，新增 session-created / session-closed
// 上游合并后，本文件若出现新的会话生命周期逻辑，需按 CUSTOMIZATIONS/architecture.md §2.4 重新比对。
// [CUSTOM-END] CUSTOM-20260923-010
import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type {
  NewSessionResponse,
  PromptResponse,
  InitializeResponse,
  ContentBlock,
  SessionModeState,
  SessionModelState,
  AvailableCommand,
  SessionConfigOption,
  SessionInfo as ProtocolSessionInfo,
  AgentCapabilities,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

import { AgentManager } from './AgentManager';
import { ConnectionManager, ConnectionInfo } from './ConnectionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { SessionHistoryStore } from './SessionHistoryStore';
// [CUSTOM-BEGIN] CUSTOM-20260924-020
import type { PermissionBridge } from '../handlers/PermissionBridge';
// [CUSTOM-END] CUSTOM-20260924-020
import { getAgentConfigs } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';
import { sendEvent, sendError } from '../utils/TelemetryManager';

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  createdAt: string;
  initResponse: InitializeResponse;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  /**
   * Generic session config options (ACP "Session Config Options" — supersedes
   * `modes` / `models`). `null` means the agent did not provide this field.
   * Per spec, when both `configOptions` and `modes` are present, clients
   * should use `configOptions` exclusively.
   */
  configOptions: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[];
  /** Latest title supplied via `session_info_update`, if any. */
  title?: string;
}

/**
 * Discovery flags for an agent, derived from `initialize.agentCapabilities`.
 * Populated lazily when {@link SessionManager.ensureConnected} runs.
 */
export interface AgentCapabilitySummary {
  list: boolean;
  load: boolean;
  resume: boolean;
  /**
   * [CUSTOM-20260923-010] `session/close` — used by multi-session teardown.
   * Advertised as `agentCapabilities.sessionCapabilities.close`.
   */
  close: boolean;
  /** [CUSTOM-20260923-010] `session/fork` — advertised the same way. */
  fork: boolean;
}

/**
 * [CUSTOM-20260923-010] Why a session left the live set.
 * `'agent-disconnected'` = the whole agent process went away; `'user'` = the
 * user explicitly closed this one session (the process survives).
 */
export type SessionCloseReason = 'user' | 'agent-disconnected';

/**
 * Why an agent expansion failed (used to surface a useful tree placeholder).
 */
export type AgentConnectionError =
  | { kind: 'auth-cancelled' }
  | { kind: 'connect-failed'; message: string };

/**
 * Manages the lifecycle of ACP agent connections.
 *
 * [CUSTOM-20260923-010] Multi-session model. Upstream assumed exactly one
 * connected agent with exactly one session. We now keep N agent processes
 * alive concurrently, each hosting M ACP sessions, because the protocol is
 * fully session-scoped (every request carries a `sessionId`).
 *
 * `activeSessionId` is retained but its meaning is now "the FOCUSED session"
 * — i.e. the one the chat panel is showing — not "the only session".
 *
 * Event contract (only the ones that changed from upstream are listed):
 *   - `active-session-changed` (sessionId | null, agentName | null)
 *   - `agent-closed`           (agentId, code, agentName?)
 *   - `clear-chat`             (agentName, sessionId)
 *   - `session-created`        (sessionId, agentName)          [new]
 *   - `session-closed`         (sessionId, agentName, reason)  [new]
 * All other events are unchanged and already session-scoped.
 */
export interface DefaultCwdDecision {
  cwd: string;
  /** Which level of the chain produced it. */
  reason: 'configured' | 'workspace' | 'process';
  /** Set when a configured value was REJECTED, so the caller can log why. */
  ignoredConfigured?: 'relative' | 'missing';
}

/**
 * [CUSTOM-20260925-057] The "which directory does a new session get" policy,
 * as a **pure function**.
 *
 * Extracted from the class so it can be tested directly. The alternative —
 * driving `vscode.workspace.getConfiguration()` from a test — would mean
 * writing to real user or workspace settings files, which a test has no
 * business doing. Everything vscode-shaped is therefore passed in, including
 * the directory check.
 *
 * A configured value that is relative or not an existing directory is
 * **rejected, not passed on**: `session/new` with a bogus cwd fails deep
 * inside the agent, where the reason is hard to see.
 */
export function pickDefaultCwd(
  configured: string | undefined,
  workspaceFolder: string | undefined,
  processCwd: string,
  isDirectory: (candidate: string) => boolean,
): DefaultCwdDecision {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  const fallback: 'workspace' | 'process' = workspaceFolder ? 'workspace' : 'process';
  const fallbackCwd = workspaceFolder || processCwd;
  if (!trimmed) {
    return { cwd: fallbackCwd, reason: fallback };
  }
  if (!isAbsolute(trimmed)) {
    return { cwd: fallbackCwd, reason: fallback, ignoredConfigured: 'relative' };
  }
  if (!isDirectory(trimmed)) {
    return { cwd: fallbackCwd, reason: fallback, ignoredConfigured: 'missing' };
  }
  return { cwd: trimmed, reason: 'configured' };
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();

  /**
   * [CUSTOM-20260923-010] The FOCUSED session (what the chat panel shows).
   * May be `null` while other sessions are still live.
   */
  private activeSessionId: string | null = null;

  /**
   * [CUSTOM-20260923-010] agentName → live session ids (was a 1:1 map).
   */
  private agentSessions: Map<string, Set<string>> = new Map();

  /**
   * [CUSTOM-20260923-010] agentName → spawned process id. This — not
   * `agentSessions` — is the source of truth for "is this agent connected":
   * a process can legitimately be alive with zero sessions (tree probing
   * calls {@link ensureConnected} without creating one).
   */
  private agentProcesses: Map<string, string> = new Map();

  /** [CUSTOM-20260923-010] agentId → agentName, for single-point event dispatch. */
  private agentProcessNames: Map<string, string> = new Map();

  /**
   * [CUSTOM-20260923-010] Sessions whose prompt turn is currently running.
   * Guards against overlapping prompts on one session (the protocol's
   * `session/prompt` resolves only when the whole turn completes).
   */
  private inFlightTurns: Set<string> = new Set();

  /**
   * [CUSTOM-20260923-010] Per-connection serialization of CONTROL-PLANE RPCs
   * (`session/new` / `load` / `resume` / `close`). Prompts deliberately stay
   * concurrent — that is the whole point of the feature.
   */
  private connectionQueues: Map<string, Promise<unknown>> = new Map();

  /**
   * [CUSTOM-20260923-010] In-flight `ensureConnected` per agent. Without this,
   * a tree probe and a user-initiated connect racing on the same agent spawn
   * TWO processes — much easier to hit now that several agents can be probed
   * and connected independently.
   */
  private connecting: Map<string, Promise<ConnectionInfo>> = new Map();

  /**
   * [CUSTOM-20260923-010] Most-recently-focused-first ordering, used to pick a
   * successor when the focused session disappears.
   */
  private focusRecency: string[] = [];

  /**
   * Buffers session/update payloads that arrive before the corresponding
   * session is registered in `this.sessions`. Drained by createAcpSession
   * once the session is set up. This closes a microtask race between the
   * resolution of `newSession` and the SDK's async notification dispatch.
   */
  private pendingAvailableCommands: Map<string, AvailableCommand[]> = new Map();
  private pendingConfigOptions: Map<string, SessionConfigOption[]> = new Map();
  private pendingTitles: Map<string, string> = new Map();

  /**
   * Cache of `initialize.agentCapabilities` per agent so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities: Map<string, AgentCapabilitySummary> = new Map();

  /** Set of session IDs that are currently being replayed via `session/load`. */
  private loadingSessionIds: Set<string> = new Set();

  /** Client-side session history (optional — only used for tier-2 tree). */
  private historyStore: SessionHistoryStore | null = null;

  // [CUSTOM-BEGIN] CUSTOM-20260924-020
  /** Permission bridge (optional — only used to retire pending prompts on cancel). */
  private permissionBridge: PermissionBridge | null = null;
  // [CUSTOM-END] CUSTOM-20260924-020

  constructor(
    private readonly agentManager: AgentManager,
    private readonly connectionManager: ConnectionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    super();

    // [CUSTOM-BEGIN] CUSTOM-20260923-010 - 生命周期监听器只在构造函数注册一次。
    // 上游在 connectToAgent 里每次调用都注册一对新的监听器且从不移除（EventEmitter 泄漏，
    // 10 个以上即触发 Node 警告），同时 ensureConnected 路径完全不注册（该路径创建的会话
    // 没有错误/退出处理）。改为单一订阅点，靠 agentProcessNames 把 agentId 反查回配置键。
    this.agentManager.on('agent-error', (evt: { agentId: string; error: Error }) => {
      const agentName = this.agentProcessNames.get(evt.agentId);
      logError(`Agent ${agentName ?? evt.agentId} error`, evt.error);
      this.emit('agent-error', evt.agentId, evt.error, agentName);
    });

    this.agentManager.on('agent-closed', (evt: { agentId: string; code: number | null; name?: string }) => {
      const agentName = this.agentProcessNames.get(evt.agentId) ?? evt.name;
      log(`Agent ${agentName ?? evt.agentId} closed with code ${evt.code}`);
      // Only tear down if this process is still registered — disconnectAgent()
      // deregisters before killing, so it won't double-teardown here.
      if (agentName && this.agentProcesses.get(agentName) === evt.agentId) {
        this.teardownAgent(agentName, /* alreadyDead= */ true);
      }
      this.emit('agent-closed', evt.agentId, evt.code, agentName);
    });
    // [CUSTOM-END] CUSTOM-20260923-010
  }

  /** Wire in the persistent session-history store (called once at startup). */
  setHistoryStore(store: SessionHistoryStore): void {
    this.historyStore = store;
  }

  // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限桥（晚绑定，理由同 setHistoryStore：
  // 桥由 extension.ts 构造，而 SessionManager 的构造早于它）。
  // 用途只有一个：取消轮次时必须把待决的权限请求回答掉，见 cancelTurn。
  setPermissionBridge(bridge: PermissionBridge): void {
    this.permissionBridge = bridge;
  }
  // [CUSTOM-END] CUSTOM-20260924-020

  /** Public accessor for downstream UI. */
  getHistoryStore(): SessionHistoryStore | null {
    return this.historyStore;
  }

  /**
   * Read cached capabilities for an agent. Returns `undefined` if the agent
   * has never been initialized — callers can call {@link ensureConnected}
   * first to populate.
   */
  getCachedCapabilities(agentName: string): AgentCapabilitySummary | undefined {
    return this.capabilities.get(agentName);
  }

  // [CUSTOM-BEGIN] CUSTOM-20260925-057 - 每会话工作目录：`getWorkspaceCwd()` → `resolveDefaultCwd()`。
  //
  // 从上游到这里，cwd 一直是「工作区第一个文件夹」，硬编码在四处调用点里。ACP 其实把 cwd 定义成
  // **会话级**属性（`NewSessionRequest.cwd`："The working directory for this session"），
  // 与 agent 进程的 cwd 无关——2026-09-25 用真实适配器实测确认过（见
  // `CUSTOMIZATIONS/scripts/probe-session-cwd.mjs`：进程在 A 目录、会话声明 B 目录，
  // shell 的 `pwd`、`ls`、以及读相对路径**全部落在 B**，A 那边的东西一个都没出现）。
  // 所以「不同会话用不同目录」只需把这条链的参数化，不需要按 cwd 分进程。
  //
  // 顺带让 `acpc.defaultWorkingDirectory` 真正生效——它此前在 package.json 里声明了、
  // **代码里零处读取**，与 pitfall #5 的 `acpc.turnInProgress` 是同一类「声明了却没接线」。
  /**
   * The cwd a session gets when the caller does not name one. Three levels:
   *   1. `acpc.defaultWorkingDirectory`;
   *   2. the first workspace folder;
   *   3. `process.cwd()`.
   *
   * A configured value that is relative or does not exist is **ignored with a
   * log line** rather than handed to the agent: `session/new` with a bogus cwd
   * fails deep inside the agent, where the reason is hard to see.
   */
  resolveDefaultCwd(): string {
    const decision = pickDefaultCwd(
      vscode.workspace.getConfiguration('acpc').get<string>('defaultWorkingDirectory'),
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      process.cwd(),
      candidate => existsSync(candidate) && statSync(candidate).isDirectory(),
    );
    if (decision.ignoredConfigured) {
      log(`SessionManager: ignoring acpc.defaultWorkingDirectory (${decision.ignoredConfigured})`);
    }
    return decision.cwd;
  }
  // [CUSTOM-END] CUSTOM-20260925-057

  private summarizeCapabilities(caps: AgentCapabilities | undefined | null): AgentCapabilitySummary {
    const sc: any = (caps as any)?.sessionCapabilities;
    return {
      list: !!sc?.list,
      load: !!(caps as any)?.loadSession,
      resume: !!sc?.resume,
      // [CUSTOM-20260923-010] upstream ignored these two; `close` is what
      // multi-session teardown needs to shut a session down honestly.
      close: !!sc?.close,
      fork: !!sc?.fork,
    };
  }

  // --- Session bookkeeping -------------------------------------------------

  /** [CUSTOM-20260923-010] Register a live session under its agent. */
  private addSessionToAgent(agentName: string, sessionId: string): void {
    let ids = this.agentSessions.get(agentName);
    if (!ids) {
      ids = new Set();
      this.agentSessions.set(agentName, ids);
    }
    ids.add(sessionId);
    this.syncLiveSessions(agentName);
  }

  /**
   * [CUSTOM-20260923-010] Keep the history store's live-session exemption set
   * in step with our index, so capacity eviction and `session/list`
   * reconciliation never drop a session whose process is still running.
   */
  private syncLiveSessions(agentName: string): void {
    this.historyStore?.setLiveSessions(agentName, this.agentSessions.get(agentName) ?? []);
  }

  /** [CUSTOM-20260923-010] Drop one session from every index and emit. */
  private removeSession(sessionId: string, reason: SessionCloseReason): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    const agentName = session.agentName;
    this.sessions.delete(sessionId);
    this.inFlightTurns.delete(sessionId);
    this.loadingSessionIds.delete(sessionId);
    this.focusRecency = this.focusRecency.filter(id => id !== sessionId);

    const ids = this.agentSessions.get(agentName);
    if (ids) {
      ids.delete(sessionId);
      if (ids.size === 0) { this.agentSessions.delete(agentName); }
    }
    this.syncLiveSessions(agentName);

    this.emit('session-closed', sessionId, agentName, reason);
    if (this.activeSessionId === sessionId) {
      this.focusSession(this.mostRecentLiveSessionId());
    }
  }

  /** [CUSTOM-20260923-010] Drop every session of an agent (process is gone). */
  private dropSessionsForAgent(agentName: string, reason: SessionCloseReason): void {
    const ids = this.agentSessions.get(agentName);
    if (!ids) { return; }
    for (const sessionId of Array.from(ids)) {
      this.removeSession(sessionId, reason);
    }
    this.agentSessions.delete(agentName);
  }

  /** [CUSTOM-20260923-010] Full agent teardown: sessions + process indices. */
  private teardownAgent(agentName: string, alreadyDead = false): void {
    const agentId = this.agentProcesses.get(agentName);

    this.agentProcesses.delete(agentName);
    if (agentId) { this.agentProcessNames.delete(agentId); }

    this.dropSessionsForAgent(agentName, 'agent-disconnected');

    if (!alreadyDead && agentId) {
      this.agentManager.killAgent(agentId);
      this.connectionManager.removeConnection(agentId);
    }
    this.connectionQueues.delete(agentId ?? '');

    this.emit('agent-disconnected', agentName);
    this.focusSession(this.mostRecentLiveSessionId());

    // [CUSTOM-20260923-010] Prune the persistent cache of sessions whose
    // process is gone? No — the history store is the *tier-2 tree* source and
    // deliberately outlives the process (that is how you reopen a session).
  }

  /** [CUSTOM-20260923-010] Most recently focused session that is still live. */
  private mostRecentLiveSessionId(): string | null {
    for (let i = this.focusRecency.length - 1; i >= 0; i--) {
      const id = this.focusRecency[i];
      if (this.sessions.has(id)) { return id; }
    }
    // Nothing in the recency list — fall back to insertion order so a
    // surviving background session still gets focus rather than nothing.
    const last = Array.from(this.sessions.keys()).pop();
    return last ?? null;
  }

  /**
   * [CUSTOM-20260923-010] Change the focused session. The single choke point
   * for focus changes — every emission of `active-session-changed` goes
   * through here so the trailing `agentName` is always consistent.
   */
  focusSession(sessionId: string | null, opts: { force?: boolean } = {}): void {
    if (sessionId !== null && !this.sessions.has(sessionId)) { return; }
    if (this.activeSessionId === sessionId && !opts.force) { return; }

    this.activeSessionId = sessionId;
    if (sessionId) {
      this.focusRecency = this.focusRecency.filter(id => id !== sessionId);
      this.focusRecency.push(sessionId);
    }
    const agentName = sessionId ? (this.sessions.get(sessionId)?.agentName ?? null) : null;
    this.emit('active-session-changed', sessionId, agentName);
  }

  /** [CUSTOM-20260923-010] Serialize control-plane RPCs per connection. */
  private enqueueControl<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.connectionQueues.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => task(), () => task());
    this.connectionQueues.set(agentId, next.catch(() => undefined));
    return next;
  }

  // --- Connection + session lifecycle --------------------------------------

  /**
   * [CUSTOM-20260923-010] Connect to an agent and start chatting.
   *
   * Upstream disconnected any previously connected agent here ("single-agent
   * model"). That is gone: multiple agents can now be live at once.
   *
   * If the agent already has a live session, that session is focused and
   * returned (same reuse semantics as upstream). Otherwise a fresh session is
   * created — spawning the process if it isn't running.
   */
  async connectToAgent(agentName: string, opts: { focus?: boolean } = {}): Promise<SessionInfo> {
    const { focus = true } = opts;

    // If we already have a live session with this agent, reuse it.
    const liveIds = this.getSessionIdsForAgent(agentName);
    if (liveIds.length > 0) {
      const sessionId = liveIds[liveIds.length - 1];
      this.focusSession(sessionId, { force: focus });
      return this.sessions.get(sessionId)!;
    }

    return this.createSession(agentName, { focus });
  }

  /**
   * [CUSTOM-20260923-010] Create a NEW session on an agent, spawning the agent
   * process if needed. This is the atomic primitive behind multi-chat.
   *
   * New sessions are never destroyed implicitly — the caller decides focus.
   *
   * [CUSTOM-20260925-057] `opts.cwd` names this session's working directory.
   * Omitted ⇒ {@link resolveDefaultCwd}. It is also handed to the process spawn
   * as a *preference*, but that only matters for the very first spawn of that
   * agent (the process is reused across sessions), and only for adapters that
   * care — the one we ship against does not (see resolveDefaultCwd's note).
   */
  async createSession(
    agentName: string,
    opts: { focus?: boolean; cwd?: string } = {},
  ): Promise<SessionInfo> {
    const { focus = true, cwd: requestedCwd } = opts;
    const cwd = requestedCwd || this.resolveDefaultCwd();

    const configs = getAgentConfigs();
    const config = configs[agentName];
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
    }

    log(`SessionManager: creating session for agent "${agentName}" in ${cwd}`);
    sendEvent('agent/connect.start', { agentName });
    const connectStartTime = Date.now();

    try {
      const connInfo = await this.ensureConnected(agentName, cwd);
      const agentId = this.findAgentIdForConnection(connInfo);
      if (!agentId) {
        throw new Error(`Unable to locate agent process for "${agentName}".`);
      }

      // The session is already registered in `this.sessions` by createAcpSession
      // so that any notifications arriving during/after newSession can be
      // persisted rather than dropped.
      const sessionInfo = await this.enqueueControl(
        agentId,
        () => this.createAcpSession(agentName, agentId, connInfo, cwd),
      );

      this.addSessionToAgent(agentName, sessionInfo.sessionId);
      this.emit('session-created', sessionInfo.sessionId, agentName);
      if (focus) { this.focusSession(sessionInfo.sessionId); }

      log(`Created session ${sessionInfo.sessionId} for agent ${agentName}`);
      sendEvent('agent/connect.end', { agentName, result: 'success' }, { duration: Date.now() - connectStartTime });
      return sessionInfo;
    } catch (e: any) {
      sendError('agent/connect.end', { agentName, result: 'error', errorMessage: e.message || String(e) }, { duration: Date.now() - connectStartTime });
      throw e;
    }
  }

  /**
   * [CUSTOM-20260923-010] Start a new conversation.
   *
   * Upstream destroyed the existing session and reconnected. Now this simply
   * opens an additional session, leaving every existing one alive.
   */
  async newConversation(agentName?: string): Promise<SessionInfo | null> {
    const target = agentName ?? this.getActiveAgentName();
    if (!target) {
      return null;
    }

    const session = await this.createSession(target, { focus: true });
    // Legacy panel compatibility: it has no tab strip, so a new conversation
    // must clear its transcript. The new panel ignores this and opens a tab.
    this.emit('clear-chat', target, session.sessionId);
    return session;
  }

  /**
   * [CUSTOM-20260923-010] Close ONE session, leaving the agent process (and
   * every sibling session) alive. Counterpart to {@link disconnectAgent}.
   */
  async closeSession(agentName: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.agentName !== agentName) { return; }

    // Best-effort protocol-level close, gated on the advertised capability.
    if (this.capabilities.get(agentName)?.close) {
      const connInfo = this.connectionManager.getConnection(session.agentId);
      if (connInfo) {
        try {
          await this.enqueueControl(
            session.agentId,
            () => connInfo.connection.closeSession({ sessionId }),
          );
        } catch (e) {
          logError(`session/close failed for ${sessionId} (continuing with local teardown)`, e);
        }
      }
    }

    log(`Closing session ${sessionId} of agent ${agentName}`);
    this.removeSession(sessionId, 'user');
  }

  /**
   * Disconnect from an agent: close ALL of its sessions, kill the process and
   * clean up every index.
   *
   * [CUSTOM-20260923-010] Upstream early-returned when `agentSessions` had no
   * entry for the agent, which made processes leaked by load/resume
   * unreclaimable. This version always reclaims if a process is registered.
   */
  async disconnectAgent(agentName: string): Promise<void> {
    const agentId = this.agentProcesses.get(agentName);
    const hasSessions = this.agentSessions.has(agentName);
    if (!agentId && !hasSessions) { return; }

    log(`Disconnecting agent ${agentName}`);
    sendEvent('agent/disconnect', { agentName });

    // Deregister FIRST so the 'agent-closed' handler fired by killAgent()
    // doesn't run a second teardown.
    this.agentProcesses.delete(agentName);
    if (agentId) { this.agentProcessNames.delete(agentId); }

    this.dropSessionsForAgent(agentName, 'agent-disconnected');

    if (agentId) {
      this.agentManager.killAgent(agentId);
      this.connectionManager.removeConnection(agentId);
      this.connectionQueues.delete(agentId);
    }

    this.emit('agent-disconnected', agentName);
    this.focusSession(this.mostRecentLiveSessionId());
  }

  /**
   * Internal: create the ACP session with auth handling.
   */
  private async createAcpSession(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
    cwd: string,
  ): Promise<SessionInfo> {
    let sessionResponse: NewSessionResponse;
    try {
      sessionResponse = await connInfo.connection.newSession({
        cwd,
        mcpServers: [],
      });
    } catch (e: any) {
      if (!this.isAuthRequiredError(e)) {
        logError('Failed to create session', e);
        this.agentManager.killAgent(agentId);
        throw e;
      }
      // Auth required — interactively authenticate, then retry.
      await this.runAuthFlow(agentName, agentId, connInfo);
      try {
        sessionResponse = await connInfo.connection.newSession({
          cwd,
          mcpServers: [],
        });
      } catch (retryErr) {
        logError('Failed to create session after authentication', retryErr);
        this.agentManager.killAgent(agentId);
        throw retryErr;
      }
    }

    const sessionInfo: SessionInfo = {
      sessionId: sessionResponse.sessionId,
      agentId,
      agentName,
      agentDisplayName: connInfo.initResponse.agentInfo?.title ||
        connInfo.initResponse.agentInfo?.name ||
        agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: connInfo.initResponse,
      modes: sessionResponse.modes ?? null,
      models: (sessionResponse as any).models ?? null,
      configOptions: (sessionResponse as any).configOptions ?? null,
      availableCommands: [],
    };

    // Register the session into the map *synchronously* with newSession's
    // resolution so that any session/update notifications dispatched by the
    // agent (e.g. available_commands_update) can be persisted onto it. If
    // we waited until the caller's continuation, notifications would race
    // and be dropped by handleSessionUpdate.
    this.sessions.set(sessionInfo.sessionId, sessionInfo);
    this.drainPending(sessionInfo);

    // Capture in the local history store so it appears in the tree.
    this.historyStore?.upsertNew(agentName, cwd, sessionInfo.sessionId);

    return sessionInfo;
  }

  /** Returns true if a thrown error denotes ACP "auth required" (-32000). */
  private isAuthRequiredError(e: any): boolean {
    return (e instanceof RequestError && e.code === -32000)
      || (e?.code === -32000)
      || (typeof e?.message === 'string' && /auth.?required/i.test(e.message));
  }

  /**
   * Run the interactive auth flow against an already-initialized connection.
   * Throws if the user cancels or auth fails — caller is expected to clean
   * up the agent process.
   */
  private async runAuthFlow(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
  ): Promise<void> {
    const authMethods = connInfo.initResponse.authMethods;
    if (!authMethods || authMethods.length === 0) {
      this.agentManager.killAgent(agentId);
      throw new Error(
        `Agent "${agentName}" requires authentication but did not advertise any auth methods.`,
      );
    }

    log(`Agent requires authentication. Methods: ${authMethods.map(m => m.name).join(', ')}`);

    let selectedMethod = authMethods[0];
    if (authMethods.length > 1) {
      const picked = await vscode.window.showQuickPick(
        authMethods.map(m => ({
          label: m.name,
          description: m.description || '',
          detail: `ID: ${m.id}`,
          method: m,
        })),
        {
          placeHolder: 'Select an authentication method',
          title: `${agentName} requires authentication`,
        },
      );
      if (!picked) {
        this.agentManager.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
      selectedMethod = picked.method;
    } else {
      const confirm = await vscode.window.showInformationMessage(
        `${agentName} requires authentication via "${selectedMethod.name}".`,
        { modal: true, detail: selectedMethod.description || undefined },
        'Authenticate',
      );
      if (confirm !== 'Authenticate') {
        this.agentManager.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
    }

    try {
      log(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
      await connInfo.connection.authenticate({ methodId: selectedMethod.id });
      log('Authentication successful');
    } catch (authErr: any) {
      logError('Authentication failed', authErr);
      this.agentManager.killAgent(agentId);
      throw new Error(`Authentication failed: ${authErr.message}`);
    }
  }

  /**
   * Drain any buffered state captured before the session was registered.
   * Used by all session-registration paths (new / load / resume).
   */
  private drainPending(sessionInfo: SessionInfo): void {
    const pendingCmds = this.pendingAvailableCommands.get(sessionInfo.sessionId);
    if (pendingCmds) {
      sessionInfo.availableCommands = pendingCmds;
      this.pendingAvailableCommands.delete(sessionInfo.sessionId);
    }
    const pendingCfg = this.pendingConfigOptions.get(sessionInfo.sessionId);
    if (pendingCfg !== undefined) {
      sessionInfo.configOptions = pendingCfg;
      this.pendingConfigOptions.delete(sessionInfo.sessionId);
    }
    const pendingTitle = this.pendingTitles.get(sessionInfo.sessionId);
    if (pendingTitle !== undefined) {
      sessionInfo.title = pendingTitle;
      this.pendingTitles.delete(sessionInfo.sessionId);
    }
  }

  /**
   * Send a prompt to a session.
   *
   * [CUSTOM-20260923-010] The second parameter accepts a full ContentBlock
   * array so file attachments can be sent as `resource_link` blocks, and an
   * in-flight guard prevents overlapping turns on one session (the protocol
   * resolves `session/prompt` only when the whole turn finishes).
   */
  async sendPrompt(sessionId: string, prompt: string | ContentBlock[]): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      throw new Error(`No connection for agent: ${session.agentId}`);
    }

    if (this.inFlightTurns.has(sessionId)) {
      throw new Error('A turn is already running for this session. Cancel it before sending another prompt.');
    }

    const blocks: ContentBlock[] = typeof prompt === 'string'
      ? [{ type: 'text', text: prompt }]
      : prompt;

    log(`sendPrompt: session=${sessionId}, blocks=${blocks.length}`);

    this.inFlightTurns.add(sessionId);
    try {
      const response = await connInfo.connection.prompt({
        sessionId,
        prompt: blocks,
      });
      log(`Prompt response: stopReason=${response.stopReason}`);
      return response;
    } finally {
      this.inFlightTurns.delete(sessionId);
    }
  }

  /**
   * Cancel an active prompt turn.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 先回答待决的权限请求，再发 session/cancel。
    // ACP 契约：会话被取消时，客户端必须把每个待决的 `session/request_permission`
    // 以 `{ outcome: 'cancelled' }` 结束。少了这一步，agent 会一直卡在等答复上
    // ——旧实现（只有 QuickPick）从来没有解决过这个 promise。
    this.permissionBridge?.cancelSession(sessionId);
    // [CUSTOM-END] CUSTOM-20260924-020

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return; }

    log(`Cancelling turn for session ${sessionId}`);
    await connInfo.connection.cancel({ sessionId });
  }

  /**
   * Set the session mode (e.g., plan mode, code mode).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `mode` — this keeps user keybindings working across agents that have
   * migrated to the new API.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    // Prefer configOptions if available (spec: clients that support
    // configOptions MUST use it exclusively when both are present)
    if (session.configOptions && session.configOptions.length > 0) {
      const modeOpt = session.configOptions.find(o => o.category === 'mode');
      if (modeOpt) {
        await this.setConfigOption(sessionId, modeOpt.id, modeId);
        return;
      }
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return; }

    await connInfo.connection.setSessionMode({ sessionId, modeId });

    // Update local state
    if (session.modes) {
      session.modes.currentModeId = modeId;
    }
    this.emit('mode-changed', sessionId, modeId);
  }

  /**
   * Set the session model (experimental).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `model`.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    if (session.configOptions && session.configOptions.length > 0) {
      const modelOpt = session.configOptions.find(o => o.category === 'model');
      if (modelOpt) {
        await this.setConfigOption(sessionId, modelOpt.id, modelId);
        return;
      }
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return; }

    await (connInfo.connection as any).unstable_setSessionModel({ sessionId, modelId });

    // Update local state
    if (session.models) {
      session.models.currentModelId = modelId;
    }
    this.emit('model-changed', sessionId, modelId);
  }

  /**
   * Set a generic session config option (ACP "Session Config Options").
   * The agent's response contains the full configOptions array — we
   * replace our local copy so that cascading changes (e.g. changing the
   * model adjusts thought-level options) are reflected.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) { return null; }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return null; }

    const response = await connInfo.connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });

    const options = (response as any)?.configOptions ?? null;
    this.applyConfigOptions(sessionId, options);
    return options;
  }

  /**
   * Replace a session's configOptions in place and notify listeners.
   * Used by both the setter response and the `config_option_update`
   * push-notification handler.
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Buffer until the session is registered (handles the race where a
      // notification is dispatched before createAcpSession finishes).
      this.pendingConfigOptions.set(sessionId, options ?? []);
      return;
    }
    session.configOptions = options ?? null;
    this.emit('config-options-changed', sessionId, session.configOptions);
  }

  /**
   * Replace a session's availableCommands and notify listeners. Buffers
   * the value if the session isn't registered yet (race during creation).
   */
  applyAvailableCommands(sessionId: string, commands: AvailableCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.pendingAvailableCommands.set(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
    this.emit('available-commands-changed', sessionId, commands);
  }

  /**
   * Apply a `session_info_update` notification: patches title / updatedAt on
   * the in-memory session and on the persistent history store.
   */
  applySessionInfoUpdate(sessionId: string, update: { title?: string | null; updatedAt?: string | null }): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (update.title === null) {
        delete session.title;
      } else if (typeof update.title === 'string') {
        session.title = update.title;
      }
    } else if (typeof update.title === 'string') {
      // Session not registered yet — buffer for drain.
      this.pendingTitles.set(sessionId, update.title);
    }
    // Mirror onto the history store regardless of whether session is live.
    if (this.historyStore && session) {
      this.historyStore.setTitle(session.agentName, sessionId, update.title);
    }
    this.emit('session-info-changed', sessionId, update);
  }

  /**
   * Record the first user prompt of a session so the history-store tree can
   * use it as a label fallback when no title arrives.
   */
  recordFirstPrompt(sessionId: string, prompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.historyStore) { return; }
    this.historyStore.setFirstPromptIfMissing(session.agentName, sessionId, prompt);
  }

  /** Bump a session's `lastActiveAt` in the history store. */
  touchHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    this.historyStore?.touch(session.agentName, sessionId);
  }

  // --- Connection lifecycle (no session) ---

  /**
   * Spawn + initialize + (optionally authenticate) an agent without creating
   * a session. Caches the capability summary. Idempotent.
   *
   * NOTE: this never disconnects the currently-active agent — it is safe to
   * call from the tree view to probe capabilities or list sessions while
   * the user is chatting with a different agent. Callers that want to
   * switch the active session (e.g. loadSession) handle the active-agent
   * teardown themselves.
   *
   * [CUSTOM-20260923-010] The process is now registered in `agentProcesses`
   * / `agentProcessNames` here, and `agent-connected` is emitted at this
   * point (not after session creation) so that a probed-but-sessionless
   * agent is correctly reported as connected.
   */
  async ensureConnected(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    // [CUSTOM-20260923-010] Collapse concurrent calls for the same agent onto
    // one connection attempt — otherwise a probe/connect race spawns two
    // processes for one agent name.
    const inFlight = this.connecting.get(agentName);
    if (inFlight) { return inFlight; }

    const attempt = this.ensureConnectedOnce(agentName, preferredCwd).finally(() => {
      this.connecting.delete(agentName);
    });
    this.connecting.set(agentName, attempt);
    return attempt;
  }

  /**
   * [CUSTOM-20260925-057] `preferredCwd` only affects a *newly spawned* process;
   * an already-running agent keeps the cwd it was spawned with. That is a real
   * limitation but not a correctness one for the adapter we ship against — it
   * resolves everything relative to the SESSION cwd (see resolveDefaultCwd).
   */
  private async ensureConnectedOnce(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    // Already connected and initialized? Reuse the existing connection.
    const registeredId = this.agentProcesses.get(agentName);
    if (registeredId) {
      const conn = this.connectionManager.getConnection(registeredId);
      if (conn) {
        this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
        return conn;
      }
      // Stale index entry (connection went away without a close event).
      this.agentProcesses.delete(agentName);
      this.agentProcessNames.delete(registeredId);
      this.connectionQueues.delete(registeredId);
    }

    // If the agent process is already spawned (e.g. from a previous probe),
    // adopt it instead of spawning a new one.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (instance.name === agentName) {
        const conn = this.connectionManager.getConnection(instance.id);
        if (conn) {
          this.registerAgentProcess(agentName, instance.id);
          this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
          return conn;
        }
      }
    }

    const configs = getAgentConfigs();
    const config = configs[agentName];
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}.`);
    }

    const workspaceCwd = preferredCwd || this.resolveDefaultCwd();
    const agentInstance = this.agentManager.spawnAgent(agentName, config, workspaceCwd);
    const agentId = agentInstance.id;

    const agentProcess = this.agentManager.getAgent(agentId);
    if (!agentProcess) {
      throw new Error('Agent process not found after spawn');
    }

    let connInfo: ConnectionInfo;
    try {
      connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
    } catch (e) {
      this.agentManager.killAgent(agentId);
      throw e;
    }

    this.registerAgentProcess(agentName, agentId);
    this.capabilities.set(agentName, this.summarizeCapabilities(connInfo.initResponse.agentCapabilities));
    this.emit('agent-connected', agentName);
    return connInfo;
  }

  /** [CUSTOM-20260923-010] Register an agent process in both indices. */
  private registerAgentProcess(agentName: string, agentId: string): void {
    this.agentProcesses.set(agentName, agentId);
    this.agentProcessNames.set(agentId, agentName);
  }

  /**
   * List sessions known to an agent (ACP `session/list`).
   * Throws if the agent doesn't advertise the capability.
   */
  async listSessions(agentName: string, opts: { cwd?: string; cursor?: string } = {}): Promise<{ sessions: ProtocolSessionInfo[]; nextCursor?: string }> {
    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }

    const params: any = {};
    if (opts.cwd) { params.cwd = opts.cwd; }
    if (opts.cursor) { params.cursor = opts.cursor; }

    let response: any;
    try {
      response = await conn.connection.listSessions(params);
    } catch (e: any) {
      if (this.isAuthRequiredError(e)) {
        // Auth then retry.
        const agentInfo = this.findAgentIdForConnection(conn);
        if (agentInfo) {
          await this.runAuthFlow(agentName, agentInfo, conn);
          response = await conn.connection.listSessions(params);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    const sessions: ProtocolSessionInfo[] = response?.sessions ?? [];
    // Reconcile the history store — drop any locally-cached entries that
    // the agent no longer knows about. Live sessions are never pruned
    // (see SessionHistoryStore.reconcileFromAgent).
    if (this.historyStore && !opts.cursor) {
      this.historyStore.reconcileFromAgent(
        agentName,
        new Set(sessions.map(s => s.sessionId)),
        this.getSessionIdsForAgent(agentName),
      );
    }
    return { sessions, nextCursor: response?.nextCursor ?? undefined };
  }

  /**
   * Load an existing session, replaying the entire conversation history via
   * `session/update` notifications. Heavyweight. The loaded session becomes
   * the focused session on success.
   *
   * [CUSTOM-20260923-010] Upstream also disconnected any agent other than
   * `agentName` and EVICTED the same agent's previously-focused session from
   * `sessions`/`agentSessions` without killing its process — which both
   * violated the single-session model and leaked the process unrecoverably
   * (disconnectAgent early-returned on the now-missing map entry). Both are
   * removed: loading a session now simply adds one alongside the others.
   */
  // [CUSTOM-BEGIN] CUSTOM-20260925-033 - 「打开一个已存在的会话」的唯一决策点。
  // 抽出理由：树命令（`acpc.openSession`）和聊天面板的历史会话选择器要做**同一件事**，
  // 各自判断一次 load/resume 迟早会漂移成"面板和树打开方式不一样"。
  // 优先 `session/load`：它会重放历史（面板因此能显示完整记录），resume 不会。
  // 返回实际走的那条路，供调用方决定要不要提示「历史未重放」。
  // [CUSTOM-20260925-057] `opts.cwd` = the directory the session belongs to.
  // The history picker knows it and passes it; when omitted, load/resume fall
  // back to the local history cache (see loadSession). Ignored for a session
  // that is already live — a session's cwd is fixed at creation, which is a
  // property of the protocol, not a limitation here.
  async openExistingSession(
    agentName: string,
    sessionId: string,
    opts: { cwd?: string } = {},
  ): Promise<'live' | 'load' | 'resume'> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.focusSession(sessionId, { force: true });
      return 'live';
    }
    const caps = this.getCachedCapabilities(agentName);
    if (caps?.load) {
      await this.loadSession(agentName, sessionId, opts.cwd);
      return 'load';
    }
    if (caps?.resume) {
      await this.resumeSession(agentName, sessionId, opts.cwd);
      return 'resume';
    }
    throw new Error(`Agent "${agentName}" does not support loading or resuming sessions.`);
  }
  // [CUSTOM-END] CUSTOM-20260925-033

  async loadSession(agentName: string, sessionId: string, requestedCwd?: string): Promise<SessionInfo> {
    // Already live? Just focus it.
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.focusSession(sessionId, { force: true });
      return existing;
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    // [CUSTOM-20260925-057] The session's OWN directory, not the current
    // workspace's. The caller may name it (the history picker knows it), and
    // otherwise the local history cache does — which is what makes opening a
    // session from ANOTHER directory work. Until this change the agent was
    // always told the current workspace, so a session belonging to
    // `D:\some\other\project` was reopened as if it lived here.
    const cwd = requestedCwd
      || this.historyStore?.get(agentName, sessionId)?.cwd
      || this.resolveDefaultCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    // Pre-register a placeholder so notifications that arrive during the
    // replay can be associated with the session (closing the same race the
    // pending* buffers handle for session/new).
    const placeholder: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title
        || conn.initResponse.agentInfo?.name
        || agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: null,
      models: null,
      configOptions: null,
      availableCommands: [],
    };
    this.sessions.set(sessionId, placeholder);
    this.drainPending(placeholder);
    this.loadingSessionIds.add(sessionId);
    this.addSessionToAgent(agentName, sessionId);
    this.emit('session-created', sessionId, agentName);
    // Focus up front so handleSessionUpdate forwards the replayed chunks to
    // the webview during the load. Without this, updates arrive before the
    // focus is set and are dropped.
    // Emit focus BEFORE session-load-start so the webview first repaints from
    // the new session state, then immediately enters the loading-overlay state.
    this.focusSession(sessionId, { force: true });
    this.emit('session-load-start', sessionId, agentName);

    try {
      const response = await this.enqueueControl(
        agentId,
        () => conn.connection.loadSession({
          sessionId,
          cwd,
          mcpServers: [],
        }),
      );
      // The response carries the latest mode/model/configOptions snapshot.
      placeholder.modes = (response as any).modes ?? null;
      placeholder.models = (response as any).models ?? null;
      placeholder.configOptions = (response as any).configOptions ?? null;
    } catch (e: any) {
      this.loadingSessionIds.delete(sessionId);
      this.removeSession(sessionId, 'user');
      this.emit('session-load-end', sessionId, agentName, /*ok=*/false);

      // If the agent says the session is gone, prune from local history so
      // it doesn't reappear on next refresh.
      const msg = String(e?.message || '');
      if (/not found|no such|unknown session/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    this.loadingSessionIds.delete(sessionId);
    this.emit('session-load-end', sessionId, agentName, /*ok=*/true);

    // Touch history-store activity timestamp.
    this.historyStore?.touch(agentName, sessionId);
    return placeholder;
  }

  /**
   * Resume an existing session without replaying history (light path).
   *
   * [CUSTOM-20260923-010] Same single-session eviction removal as loadSession.
   */
  async resumeSession(agentName: string, sessionId: string, requestedCwd?: string): Promise<SessionInfo> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.focusSession(sessionId, { force: true });
      return existing;
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    // [CUSTOM-20260925-057] Same resolution as loadSession — the session's own
    // directory, with the local history cache as the fallback.
    const cwd = requestedCwd
      || this.historyStore?.get(agentName, sessionId)?.cwd
      || this.resolveDefaultCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    let response: any;
    try {
      response = await this.enqueueControl(
        agentId,
        () => conn.connection.resumeSession({
          sessionId,
          cwd,
          mcpServers: [],
        }),
      );
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/not found|no such|unknown session/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const sessionInfo: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title
        || conn.initResponse.agentInfo?.name
        || agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: response?.modes ?? null,
      models: response?.models ?? null,
      configOptions: response?.configOptions ?? null,
      availableCommands: [],
    };
    this.sessions.set(sessionId, sessionInfo);
    this.drainPending(sessionInfo);
    this.addSessionToAgent(agentName, sessionId);
    this.emit('session-created', sessionId, agentName);
    this.focusSession(sessionId, { force: true });

    this.historyStore?.touch(agentName, sessionId);
    return sessionInfo;
  }

  /** Return true if a session is currently mid-replay via `session/load`. */
  isLoading(sessionId: string): boolean {
    return this.loadingSessionIds.has(sessionId);
  }

  /** Helper: reverse-lookup agentId for a known ConnectionInfo. */
  private findAgentIdForConnection(conn: ConnectionInfo): string | undefined {
    // [CUSTOM-20260923-010] Fast path: the agent-name index is authoritative.
    for (const [agentName, agentId] of this.agentProcesses) {
      if (this.connectionManager.getConnection(agentId) === conn) {
        return agentId;
      }
      void agentName;
    }
    for (const session of this.sessions.values()) {
      const c = this.connectionManager.getConnection(session.agentId);
      if (c === conn) { return session.agentId; }
    }
    // Connection without a session — search agentManager's spawned set.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (this.connectionManager.getConnection(instance.id) === conn) {
        return instance.id;
      }
    }
    return undefined;
  }


  // --- Getters ---

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSession(): SessionInfo | undefined {
    if (!this.activeSessionId) { return undefined; }
    return this.sessions.get(this.activeSessionId);
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /** Get the agent name for the current active session. */
  getActiveAgentName(): string | null {
    const session = this.getActiveSession();
    return session?.agentName ?? null;
  }

  /** [CUSTOM-20260923-010] Alias making the "focused, not only" semantics explicit. */
  getFocusedAgentName(): string | null {
    return this.getActiveAgentName();
  }

  /**
   * Check if a specific agent is currently connected.
   *
   * [CUSTOM-20260923-010] Now derived from the process index, so a probed
   * agent without any session correctly reports as connected.
   */
  isAgentConnected(agentName: string): boolean {
    return this.agentProcesses.has(agentName) || this.agentSessions.has(agentName);
  }

  /** Get all connected agent names. */
  getConnectedAgentNames(): string[] {
    return Array.from(new Set([...this.agentProcesses.keys(), ...this.agentSessions.keys()]));
  }

  /** [CUSTOM-20260923-010] Every live session across all agents. */
  getLiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /** [CUSTOM-20260923-010] Live session ids belonging to one agent. */
  getSessionIdsForAgent(agentName: string): string[] {
    const ids = this.agentSessions.get(agentName);
    if (!ids) { return []; }
    // Insertion order = creation order; callers treat the last as newest.
    return Array.from(ids).filter(id => this.sessions.has(id));
  }

  /** [CUSTOM-20260923-010] True while a prompt turn is running for a session. */
  isTurnInFlight(sessionId: string): boolean {
    return this.inFlightTurns.has(sessionId);
  }

  getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) { return undefined; }
    return this.connectionManager.getConnection(session.agentId);
  }

  // --- Cleanup ---

  dispose(): void {
    this.agentManager.killAll();
    this.connectionManager.dispose();
    this.sessions.clear();
    this.agentSessions.clear();
    // [CUSTOM-20260923-010] New indices must be cleared too, otherwise a
    // re-activation would see phantom connected agents.
    this.agentProcesses.clear();
    this.agentProcessNames.clear();
    this.inFlightTurns.clear();
    this.connectionQueues.clear();
    this.connecting.clear();
    this.focusRecency = [];
    this.activeSessionId = null;
  }
}
