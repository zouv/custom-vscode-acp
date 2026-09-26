// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';

import { AgentManager } from './core/AgentManager';
import { ConnectionManager } from './core/ConnectionManager';
import { SessionManager } from './core/SessionManager';
import { SessionHistoryStore } from './core/SessionHistoryStore';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { SessionTreeProvider } from './ui/SessionTreeProvider';
import { StatusBarManager } from './ui/StatusBarManager';
// [CUSTOM-BEGIN] CUSTOM-20260923-011 - Chat 面板改为路由层（ChatRouterProvider）。
// 视图 id 仍是唯一的 `acpc-chat`，但注册的 provider 换成按聚焦 agent 分发的新/旧面板路由。
// `ChatWebviewProvider` 本身**零改动**，由 LegacyPanelAdapter 用 facade 包装后接入。
// [CUSTOM-END] CUSTOM-20260923-011
import { ChatRouterProvider } from './ui/chat';
// [CUSTOM-BEGIN] CUSTOM-20260924-020
import { PermissionBridge } from './handlers/PermissionBridge';
// [CUSTOM-END] CUSTOM-20260924-020
import { getAgentNames } from './config/AgentConfig';
import { fetchRegistry } from './config/RegistryClient';
import { log, logError, disposeChannels, getOutputChannel, getTrafficChannel } from './utils/Logger';
import { initTelemetry, sendEvent } from './utils/TelemetryManager';

export function activate(context: vscode.ExtensionContext): void {
  log('ACP Client extension activating...');

  // --- Telemetry ---
  const telemetryReporter = initTelemetry();
  context.subscriptions.push(telemetryReporter);

  // --- Core services ---
  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限桥：构造顺序必须是 bridge → ConnectionManager
  // （每个连接都要拿到它）。构造早于 ChatPanelHost，后者在自己的构造函数里注册为 presenter。
  const permissionBridge = new PermissionBridge();
  const connectionManager = new ConnectionManager(sessionUpdateHandler, permissionBridge);
  // [CUSTOM-END] CUSTOM-20260924-020
  const sessionManager = new SessionManager(
    agentManager,
    connectionManager,
    sessionUpdateHandler,
  );

  // Persistent client-side session-history cache (used as the tier-2 tree
  // source for agents that support session/load or session/resume but not
  // session/list).
  const historyStore = new SessionHistoryStore(context.workspaceState);
  sessionManager.setHistoryStore(historyStore);
  context.subscriptions.push({ dispose: () => historyStore.dispose() });

  // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限桥的两条接线：
  //   · setSessionLookup 让退回弹框时能标明「哪个会话在请求」（并发请求不再无法区分）；
  //   · session-closed 把该会话所有待决请求按 ACP 契约回答成 cancelled，否则 agent 永久挂起。
  sessionManager.setPermissionBridge(permissionBridge);
  permissionBridge.setSessionLookup(sessionId => {
    const session = sessionManager.getSession(sessionId);
    return session ? { title: session.title, agentName: session.agentName } : undefined;
  });
  sessionManager.on('session-closed', (sessionId: string) => {
    permissionBridge.cancelSession(sessionId);
  });
  // [CUSTOM-END] CUSTOM-20260924-020

  // --- UI ---
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const sessionTreeProvider = new SessionTreeProvider(sessionManager, historyStore, workspaceCwd);
  const treeView = vscode.window.createTreeView('acpc-sessions', {
    treeDataProvider: sessionTreeProvider,
  });

  const chatRouter = new ChatRouterProvider(
    context.extensionUri,
    sessionManager,
    sessionUpdateHandler,
    permissionBridge,
    context.globalState,
  );
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatRouterProvider.viewType,
    chatRouter,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  // [CUSTOM-BEGIN] CUSTOM-20260923-010 - 事件接线改为 session 作用域。
  // 多会话/多 agent 并行后，后台会话的更新不得打到前台面板上：所有转发都以
  // `sessionManager.getActiveSessionId()`（= 聚焦会话）为过滤条件。
  const isFocused = (sessionId: string | null | undefined): boolean =>
    !!sessionId && sessionId === sessionManager.getActiveSessionId();

  // NOTE: `active-session-changed` is NOT wired here — ChatRouterProvider
  // subscribes to it itself, because a focus change is what decides which panel
  // (modern vs legacy) owns the view.

  // Clear chat when a new conversation is started for the focused agent.
  // A background agent's new conversation must NOT wipe the visible panel.
  sessionManager.on('clear-chat', (agentName: string) => {
    if (agentName !== sessionManager.getFocusedAgentName()) { return; }
    chatRouter.clearChat();
  });

  // Forward mode/model changes to webview (focused session only)
  sessionManager.on('mode-changed', (sessionId: string, _modeId: string) => {
    if (!isFocused(sessionId)) { return; }
    const session = sessionManager.getSession(sessionId);
    if (session?.modes) {
      chatRouter.notifyModesUpdate(session.modes);
    }
  });

  sessionManager.on('model-changed', (sessionId: string, _modelId: string) => {
    if (!isFocused(sessionId)) { return; }
    const session = sessionManager.getSession(sessionId);
    if (session?.models) {
      chatRouter.notifyModelsUpdate(session.models);
    }
  });

  // Session-load replay state — drive the webview overlay.
  sessionManager.on('session-load-start', (sessionId: string) => {
    if (!isFocused(sessionId)) { return; }
    chatRouter.notifyLoadSessionStart();
  });
  sessionManager.on('session-load-end', (sessionId: string, _agentName: string, ok: boolean) => {
    if (!isFocused(sessionId)) { return; }
    chatRouter.notifyLoadSessionEnd(ok);
    if (ok) {
      // The loadSession response carries modes/models/configOptions for the
      // restored session. Re-send the state so the pickers pick them up
      // (the original `active-session-changed` was emitted before the RPC
      // resolved, when those fields were still null).
      chatRouter.notifyActiveSessionChanged();
    }
  });

  // Session metadata (title) update — forward to chat banner.
  sessionManager.on('session-info-changed', (sessionId: string, update: any) => {
    if (!isFocused(sessionId)) { return; }
    chatRouter.notifySessionInfoUpdate(update?.title);
  });
  // [CUSTOM-END] CUSTOM-20260923-010

  // --- Commands ---

  // Connect to Agent (primary action — inline icon in tree or pick from list)
  const connectAgentCmd = vscode.commands.registerCommand('acpc.connectAgent', async (agentNameOrItem?: string | any) => {
    // Handle tree item object or string
    let agentName: string | undefined;
    if (typeof agentNameOrItem === 'string') {
      agentName = agentNameOrItem;
    } else if (agentNameOrItem?.agentName) {
      agentName = agentNameOrItem.agentName;
    }

    if (!agentName) {
      const agentNames = getAgentNames();
      if (agentNames.length === 0) {
        vscode.window.showWarningMessage(
          'No ACP agents configured. Add agents in Settings > ACP > Agents.',
        );
        return;
      }
      agentName = await vscode.window.showQuickPick(agentNames, {
        placeHolder: 'Select an agent to connect',
        title: 'Connect to Agent',
      });
      if (!agentName) { return; }
    }

    // [CUSTOM-BEGIN] CUSTOM-20260923-010 - 文案修正：切换 agent 不再断开原 agent。
    // 上游是单 agent 模型，这里原本断言「将断开 X 并清空历史」；多 agent 并行后
    // 原 agent 保持连接（会话继续存活），只是聊天面板转为显示新的 agent。
    // [CUSTOM-END] CUSTOM-20260923-010
    const currentAgent = sessionManager.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName && chatRouter.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        `Switch chat panel to ${agentName}? ${currentAgent} stays connected in the background.`,
        'Switch Agent',
        'Cancel',
      );
      if (choice !== 'Switch Agent') { return; }
      chatRouter.clearChat();
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${agentName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.connectToAgent(agentName!);
        },
      );
    } catch (e: any) {
      logError('Failed to connect to agent', e);
      vscode.window.showErrorMessage(`Failed to connect: ${e.message}`);
    }
  });

  // New Conversation (disconnect + clear chat + reconnect same agent)
  const newConversationCmd = vscode.commands.registerCommand('acpc.newConversation', async () => {
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) {
      // No active agent — fall back to connect
      await vscode.commands.executeCommand('acpc.connectAgent');
      return;
    }

    // Confirm if there's existing chat content
    // [CUSTOM-BEGIN] CUSTOM-20260923-012 - 文案与新面板语义一致。
    // 多会话下「新建会话」只是开一个新标签，旧会话记录保留、可随时切回，
    // 因此不能说「会清空聊天记录」。（旧面板仍是单会话，确实会被替换。）
    // [CUSTOM-END] CUSTOM-20260923-012
    if (chatRouter.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        'Start a new conversation? The current one stays available in its tab.',
        'New Conversation',
        'Cancel',
      );
      if (choice !== 'New Conversation') { return; }
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting new conversation with ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.newConversation();
        },
      );
    } catch (e: any) {
      logError('Failed to start new conversation', e);
      vscode.window.showErrorMessage(`Failed to start new conversation: ${e.message}`);
    }
  });

  // Disconnect Agent
  const disconnectAgentCmd = vscode.commands.registerCommand('acpc.disconnectAgent', async (item?: any) => {
    const agentName = item?.agentName || sessionManager.getActiveAgentName();
    if (!agentName) {
      vscode.window.showInformationMessage('No agent connected.');
      return;
    }
    await sessionManager.disconnectAgent(agentName);
    vscode.window.showInformationMessage(`Disconnected from ${agentName}.`);
  });

  // Open Chat
  const openChatCmd = vscode.commands.registerCommand('acpc.openChat', () => {
    vscode.commands.executeCommand('acpc-chat.focus');
  });

  // [CUSTOM-BEGIN] CUSTOM-20260924-019 - 在编辑区（编辑器标签页）打开聊天面板。
  // 与侧边栏并存、共享同一份会话记录；仅对新面板（Claude Code）开放，其它 agent 由
  // ChatEditorPanel.open() 给出提示并拒绝。
  const openChatInEditorCmd = vscode.commands.registerCommand('acpc.openChatInEditor', () => {
    chatRouter.openEditorChat();
  });
  // [CUSTOM-END] CUSTOM-20260924-019

  // Send Prompt (from keybinding — just focus chat)
  const sendPromptCmd = vscode.commands.registerCommand('acpc.sendPrompt', async () => {
    vscode.commands.executeCommand('acpc-chat.focus');
  });

  // Cancel Turn
  const cancelTurnCmd = vscode.commands.registerCommand('acpc.cancelTurn', async () => {
    const activeId = sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  });

  // Restart Agent
  const restartAgentCmd = vscode.commands.registerCommand('acpc.restartAgent', async () => {
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) { return; }

    const agentName = activeSession.agentName;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restarting ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.disconnectAgent(agentName);
          await sessionManager.connectToAgent(agentName);
        },
      );
      vscode.window.showInformationMessage(`Restarted ${agentName}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to restart: ${e.message}`);
    }
  });

  // Show Log
  const showLogCmd = vscode.commands.registerCommand('acpc.showLog', () => {
    sendEvent('command/showLog');
    getOutputChannel().show();
  });

  // Show Traffic
  const showTrafficCmd = vscode.commands.registerCommand('acpc.showTraffic', () => {
    sendEvent('command/showTraffic');
    getTrafficChannel().show();
  });

  // Set Mode
  const setModeCmd = vscode.commands.registerCommand('acpc.setMode', async (modeId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) { return; }

    if (!modeId) {
      modeId = await vscode.window.showInputBox({
        placeHolder: 'Enter mode ID (e.g., "plan", "code")',
        title: 'Set Agent Mode',
      }) || undefined;
    }
    if (modeId) {
      try {
        await sessionManager.setMode(activeId, modeId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set mode: ${e.message}`);
      }
    }
  });

  // Set Model
  const setModelCmd = vscode.commands.registerCommand('acpc.setModel', async (modelId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) { return; }

    if (!modelId) {
      modelId = await vscode.window.showInputBox({
        placeHolder: 'Enter model ID',
        title: 'Set Agent Model',
      }) || undefined;
    }
    if (modelId) {
      try {
        await sessionManager.setModel(activeId, modelId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set model: ${e.message}`);
      }
    }
  });

  // Refresh Agents tree
  const refreshAgentsCmd = vscode.commands.registerCommand('acpc.refreshAgents', () => {
    sessionTreeProvider.refresh();
  });

  // Refresh sessions for an agent (or all agents). Invalidates the cached
  // session-list state so the next expansion re-runs `session/list`.
  const refreshSessionsCmd = vscode.commands.registerCommand('acpc.refreshSessions', (arg?: any) => {
    const agentName = typeof arg === 'string' ? arg : arg?.agentName;
    sessionTreeProvider.invalidate(agentName);
  });

  // Open (load or resume) a previously-existing session.
  const openSessionCmd = vscode.commands.registerCommand('acpc.openSession', async (arg?: any) => {
    const agentName: string | undefined = arg?.agentName;
    const sessionId: string | undefined = arg?.sessionId;
    if (!agentName || !sessionId) {
      vscode.window.showErrorMessage('Open Session: missing agentName/sessionId.');
      return;
    }

    // No-op if it is already the active session.
    if (sessionManager.getActiveSessionId() === sessionId) {
      vscode.commands.executeCommand('acpc-chat.focus');
      return;
    }

    // [CUSTOM-BEGIN] CUSTOM-20260923-012 - 同上：新面板里打开另一个会话只是切换标签，
    // 当前会话的记录不会被替换掉。
    // [CUSTOM-END] CUSTOM-20260923-012
    if (chatRouter.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        'Open a different session? The current one stays available in its tab.',
        'Open Session',
        'Cancel',
      );
      if (choice !== 'Open Session') { return; }
    }

    try {
      await vscode.commands.executeCommand('acpc-chat.focus');
      // [CUSTOM-BEGIN] CUSTOM-20260925-033 - load/resume 的决策收敛到
      // SessionManager.openExistingSession（面板的历史会话选择器走同一条路）。
      const how = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Opening session…',
          cancellable: false,
        },
        () => sessionManager.openExistingSession(agentName, sessionId),
      );
      if (how === 'resume') {
        vscode.window.showInformationMessage('Resumed session (history not replayed).');
      }
      // [CUSTOM-END] CUSTOM-20260925-033
    } catch (e: any) {
      logError('Failed to open session', e);
      vscode.window.showErrorMessage(`Failed to open session: ${e.message}`);
    }
  });

  // Pagination cursor: append the next page to the agent-sourced list.
  const loadMoreSessionsCmd = vscode.commands.registerCommand('acpc.loadMoreSessions', async (agentName?: string) => {
    if (!agentName) { return; }
    await sessionTreeProvider.loadMore(agentName);
  });

  // Copy session ID to clipboard (right-click on a session tree item).
  const copySessionIdCmd = vscode.commands.registerCommand('acpc.copySessionId', async (arg?: any) => {
    const sessionId = arg?.sessionId;
    if (!sessionId) { return; }
    await vscode.env.clipboard.writeText(sessionId);
    vscode.window.showInformationMessage(`Copied session ID: ${sessionId}`);
  });

  // Forget a single locally-cached session (right-click on a local session).
  const forgetSessionCmd = vscode.commands.registerCommand('acpc.forgetSession', async (arg?: any) => {
    const agentName = arg?.agentName;
    const sessionId = arg?.sessionId;
    if (!agentName || !sessionId) { return; }
    historyStore.forget(agentName, sessionId);
  });

  // Add Agent Configuration
  const addAgentCmd = vscode.commands.registerCommand('acpc.addAgent', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    });
    if (!name) { return; }

    const command = await vscode.window.showInputBox({
      prompt: 'Command to launch the agent',
      placeHolder: 'npx',
      title: 'Agent Command',
    });
    if (!command) { return; }

    const argsStr = await vscode.window.showInputBox({
      prompt: 'Arguments (space-separated)',
      placeHolder: '-y @my-org/agent',
      title: 'Agent Arguments',
    });
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const config = vscode.workspace.getConfiguration('acpc');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    agents[name] = { command, args };
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    sessionTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" added.`);
    sendEvent('agent/added');
  });

  // Remove Agent
  const removeAgentCmd = vscode.commands.registerCommand('acpc.removeAgent', async (item?: any) => {
    const config = vscode.workspace.getConfiguration('acpc');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      vscode.window.showInformationMessage('No agents configured.');
      return;
    }

    const name = item?.agentName ?? await vscode.window.showQuickPick(agentNames, {
      placeHolder: 'Select agent to remove',
      title: 'Remove ACP Agent',
    });
    if (!name) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Remove agent "${name}"?`, { modal: true }, 'Remove',
    );
    if (confirm !== 'Remove') { return; }

    // Disconnect if connected
    if (sessionManager.isAgentConnected(name)) {
      await sessionManager.disconnectAgent(name);
    }

    delete agents[name];
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    sessionTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" removed.`);
    sendEvent('agent/removed', { agentName: name });
  });

  // Attach File
  const attachFileCmd = vscode.commands.registerCommand('acpc.attachFile', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: 'Attach File to Chat',
    });
    if (uris && uris.length > 0) {
      chatRouter.attachFile(uris[0]);
    }
  });

  // Browse Registry
  const browseRegistryCmd = vscode.commands.registerCommand('acpc.browseRegistry', async () => {
    sendEvent('registry/browse');
    try {
      const agents = await fetchRegistry();
      const items = agents.map(a => ({
        label: a.name,
        description: a.command,
        detail: a.description || '',
      }));
      if (items.length === 0) {
        vscode.window.showInformationMessage('No agents found in registry.');
        return;
      }
      await vscode.window.showQuickPick(items, {
        placeHolder: 'ACP Agent Registry',
        title: 'Available ACP Agents',
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to fetch registry: ${e.message}`);
    }
  });

  // --- Register disposables ---
  context.subscriptions.push(
    treeView,
    chatViewRegistration,
    statusBarManager,
    connectAgentCmd,
    newConversationCmd,
    disconnectAgentCmd,
    openChatCmd,
    sendPromptCmd,
    cancelTurnCmd,
    openChatInEditorCmd,
    restartAgentCmd,
    showLogCmd,
    showTrafficCmd,
    setModeCmd,
    setModelCmd,
    refreshAgentsCmd,
    refreshSessionsCmd,
    openSessionCmd,
    loadMoreSessionsCmd,
    copySessionIdCmd,
    forgetSessionCmd,
    addAgentCmd,
    removeAgentCmd,
    attachFileCmd,
    browseRegistryCmd,
    {
      dispose: () => {
        sessionManager.dispose();
        sessionUpdateHandler.dispose();
        // [CUSTOM-20260924-020] 先回答掉所有待决权限请求，再拆面板。
        permissionBridge.cancelAll();
        chatRouter.dispose();
        permissionBridge.dispose();
        sessionTreeProvider.dispose();
        disposeChannels();
      },
    },
  );

  // [CUSTOM-BEGIN] CUSTOM-20260923-001/002 - 移除 extension/activated 遥测上报
  // （原上游实现会读取 'formulahendry.acp-client' 的版本号上报，fork 后该 id 已不存在）
  // [CUSTOM-END] CUSTOM-20260923-001/002
  log('ACP Client extension activated.');
}

export function deactivate(): void {
  log('ACP Client extension deactivated.');
}
