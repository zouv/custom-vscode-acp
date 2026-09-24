# 代码链路图谱 · acp-client-custom

> **本文件的目的**：给 AI（及人类）一份「读这一份就能定位代码」的导航地图，
> 避免每次改动/排查都全量扫描源码，节省上下文与 token。
>
> **维护铁律**：改了代码结构（新增函数 / 移动逻辑 / 改数据流 / 改接口），必须同步更新本文件。
> **体量铁律**：超过 ~400 行即拆分——保留 §0 / §0.5 / §1，各模块细节拆到 `docs/arch/<module>.md`。
>
> **配套**：历史坑点见 [`docs/pitfalls.md`](./docs/pitfalls.md)；改动账本见 [`registry.md`](./registry.md)。

---

## 0. 一句话架构

TypeScript + VS Code Extension API，webpack + ts-loader 打成单文件 `dist/extension.js`。
扩展作为 **ACP（Agent Client Protocol）客户端**：把 AI coding agent 的 CLI 作为子进程拉起，
用 `@agentclientprotocol/sdk` 走 **stdio 上的 JSON-RPC 2.0**（`ndJsonStream`）通信，
把会话渲染进 VS Code 侧边栏（一个 tree view + 一个 webview）。

```
VS Code 侧边栏容器 acp-client-custom
   ├── 视图 acpc-sessions (tree)  ── SessionTreeProvider   ← 两层树：agent → session
   └── 视图 acpc-chat     (webview)── ChatRouterProvider   ← 按聚焦 agent 分发（CUSTOM-20260923-011）
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                               ▼
                   ChatPanelHost                   LegacyPanelAdapter
                   （新面板，Claude Code）          （facade 包装，旧面板零改动）
                          ▲ postMessage                  ▲ postMessage
                                          │
                              ┌───────────┴────────────┐
                              │   SessionManager        │  ← 编排器（N 进程 × M 会话）
                              │   会话生命周期/状态机    │
                              └───────────┬────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            AgentManager          ConnectionManager      SessionHistoryStore
            (spawn/kill 子进程)   (建连 + initialize)    (workspaceState 缓存)
                                          │
                                          ▼ ClientSideConnection（ACP SDK）
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                     AcpClientImpl              handlers/*
                     (Client 接口门面)      fs / terminal / permission
```

**技术栈 / 关键约束**：npm（**禁 pnpm/yarn**，否则生成本仓库不认的锁文件）；
webpack + ts-loader（不是 esbuild）；ESLint flat config；`@vscode/test-cli` + mocha；
上游同步走 `acp-merge-upstream` skill（禁手动 merge vendor）；
全局标识符命名空间为 **`acpc.*`**（非上游的 `acp.*`，见 §4）。

---

## 0.5 任务作用域路由（先定范围，避免污染上下文）

| 任务类型 | 该读（仅限） | 可忽略 | 入口 |
|---|---|---|---|
| 连接/拉起 agent 失败（ENOENT、退出码、stderr） | `AgentManager.ts` + `AgentConfig.ts` | UI、webview | §2.1 |
| ACP 握手 / 协议 traffic 日志 | `ConnectionManager.ts` + `StreamAdapter.ts` + `AcpClientImpl.ts` + `Logger.ts(logTraffic)` | tree、webview | §2.2 |
| 会话生命周期（新建/加载/恢复/切换、认证 -32000） | `SessionManager.ts` + `SessionHistoryStore.ts` | handlers | §2.3 |
| 发消息 / 取消 / 流式更新 | `SessionManager.ts(sendPrompt/cancelTurn)` + `SessionUpdateHandler.ts` + `ChatWebviewProvider.ts(handleMessage)` | tree | §2.4 |
| 聊天 UI（新面板 / 路由 / 标签页 / 工具调用渲染） | `src/ui/chat/`（入口 `index.ts`；先看 §5 的文件表再定位） | 旧面板、core | §5 |
| 聊天 UI（旧面板，仅非 Claude Code agent 走这条） | `ChatWebviewProvider.ts`（**只读 `getHtmlContent()` 对应片段，勿整读 87KB**） | 新面板 | §2.5 |
| 侧边栏树 / 未连接态 / 会话列表分页 | `SessionTreeProvider.ts` | webview | §2.6 |
| 文件读写 / 终端 / 权限弹窗 | `handlers/` | core | §2.7 |
| agent 默认列表 / 设置项 schema | `package.json(contributes.configuration)` + `AgentConfig.ts` | 全部业务代码 | §2.8 |
| 打包 / 发布 | `CUSTOMIZATIONS/scripts/*`、`.vscodeignore`、`package.json(scripts)` | 全部业务代码 | §2.9 |

> 定位优先级：**函数名 grep > 本表**。表过期时以代码为准并顺手订正本表。

---

## 1. 文件职责速查

| 文件/目录 | 职责 | 何时改它 |
|---|---|---|
| `src/extension.ts` | 激活入口：装配全部服务与 UI、注册 21 个命令、把 SessionManager 事件接到视图刷新、dispose 编排 | 新增命令 / 新增事件转发 / 改装配顺序 |
| `src/core/AgentManager.ts` | agent 子进程生命周期：`spawnAgent`/`killAgent`/`killAll`；Windows 走 `cmd.exe`+`shell:true`，macOS/Linux 走 login shell（修 `spawn npx ENOENT`）；emit `agent-stderr`/`agent-error`/`agent-closed` | agent 起不来 / 平台差异 / 进程泄漏 |
| `src/core/ConnectionManager.ts` | 把子进程 stdio 转 Web Streams + `ndJsonStream`，建 `ClientSideConnection`，做 `initialize` 握手；`tapStream` 双向拦截供 traffic 日志 | 协议握手 / 抓包 / ACP SDK 升级 |
| `src/core/SessionManager.ts` | **本仓库最复杂的编排器**（1300+ 行，属"用 grep 定位、勿整读"一类）：`connectToAgent`/`newConversation`/`sendPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`listSessions`/`loadSession`/`resumeSession`；`-32000` 认证重试；早到通知缓冲（`pendingAvailableCommands`/`pendingConfigOptions`/`pendingTitles`）；emit 13 种事件 | 会话状态机 / 新事件 / 能力协商 |
| `src/core/SessionHistoryStore.ts` | `workspaceState` 持久化的会话缓存（tier-2 树数据源），按 agent+cwd 分桶、有容量上限、`reconcileFromAgent` 与 agent 侧对账 | 会话列表丢失 / 缓存策略 |
| `src/core/AcpClientImpl.ts` | ACP SDK `Client` 接口的门面，把方法转发给各 handler | 新增 ACP 客户端能力 |
| `src/handlers/FileSystemHandler.ts` | `fs/read_text_file`（**优先返回未保存的编辑器缓冲区**，支持 `line`/`limit`）、`fs/write_text_file`（建父目录 + 打开预览） | 文件读写异常 |
| `src/handlers/TerminalHandler.ts` | `terminal/*`：托管终端 Map、1MB 输出上限（UTF-8 安全截断）、100ms 缓冲刷写、SIGTERM 终止 | 终端输出卡住 / 乱码 / 泄漏 |
| `src/handlers/PermissionHandler.ts` | `session/request_permission` → 读 `acpc.autoApprovePermissions` 自动批准，否则 QuickPick | 权限弹窗行为 |
| `src/handlers/SessionUpdateHandler.ts` | `session/update` 通知的监听器扇出（try/catch 隔离单个订阅者） | 流式更新丢事件 |
| `src/ui/ChatWebviewProvider.ts` | **legacy 面板（单会话、未改造）**：webview 视图 + 内联 HTML 字符串（`getHtmlContent()`，CSP+nonce）；webview↔扩展 postMessage 协议；`marked` 渲染 markdown。CUSTOM-20260923-011 起由 `LegacyPanelAdapter` 用 **facade** 包装后接入路由层，**本文件零改动** | 仅在必须跟上游同步时动；旧缺陷不在此文件里修 |
| `src/ui/chat/` | **新 Chat 面板子系统**（CUSTOM-20260923-011，28 个模块，入口见 §5）。入口 `index.ts` 只导出 `ChatRouterProvider`。见下方 §5 | 聊天 UI / 面板路由 / 多会话 |
| `src/ui/SessionTreeProvider.ts` | 两层树 `AgentNode`/`ChildNode`：`AgentTreeItem`/`SessionTreeItem`/`InfoTreeItem`（loading/empty/unsupported/error/auth-required/load-more） | 树结构 / 右键菜单行为 |
| `src/ui/StatusBarManager.ts` | 状态栏 `$(hubot) ACP: <status>`，订阅 5 个 SessionManager 事件；点击触发 `acpc.connectAgent` | 状态显示 |
| `src/config/AgentConfig.ts` | 读 `acpc.agents` 设置，导出 `getAgentConfigs`/`getAgentNames`/`getAgentConfig` | agent 列表读取逻辑 |
| `src/config/RegistryClient.ts` | 拉 `cdn.agentclientprotocol.com` 的 agent registry，5 分钟 TTL，失败回退缓存 | 换 registry 源 / 缓存策略 |
| `src/utils/Logger.ts` | 双输出通道（`ACP Client (Custom)` / `ACP Traffic (Custom)`）；`logTraffic` 按 JSON-RPC 分类 REQUEST/NOTIFICATION/RESPONSE，受 `acpc.logTraffic` 开关控制 | 日志格式 / 新增通道 |
| `src/utils/StreamAdapter.ts` | `childProcessToWebStreams`：ChildProcess → `AcpStream{readable,writable}` | 流适配 |
| `src/utils/TelemetryManager.ts` | **本仓库已改为 no-op**（见 registry `CUSTOM-20260923-002`），保留同名 API | 重新启用遥测 |
| `src/test/extension.test.ts` | 扩展存在 / 能激活 / 命令已注册（断言 `acpc.` 前缀） | 改扩展 id 或命令前缀时必须同步 |
| `src/test/nesting.test.ts` | 嵌套推断的 11 条单元测试（护栏行为钉死；全项目最"猜"的一块） | 改 `src/ui/chat/nesting/` 时必须同步 |

---

## 2. 任务 → 代码位置反查

### 2.1 连接/拉起 agent
`SessionManager.connectToAgent` → `AgentConfig.getAgentConfig` → `AgentManager.spawnAgent`
（平台分支：Windows `cmd.exe`/`shell:true`；macOS/Linux login shell 解析）→ 失败看
`AgentManager` 的 `agent-stderr`/`agent-error` 事件与 `Logger`。

### 2.2 ACP 握手与抓包
`ConnectionManager.connect`（`childProcessToWebStreams` → `ndJsonStream` → `ClientSideConnection` →
`initialize`）→ 想看原始报文开 `acpc.logTraffic`，读 `Logger.logTraffic` + `ConnectionManager.tapStream`。

### 2.3 会话生命周期
`SessionManager`：`newConversation` / `loadSession` / `resumeSession` / `listSessions`；
认证失败是 `-32000` → 走 `showQuickPick` 选 auth method 后重试 `newSession`；
持久化缓存读写看 `SessionHistoryStore`。

### 2.4 发消息 / 流式更新
`SessionManager.sendPrompt` → agent 侧 `session/update` 通知 → `SessionUpdateHandler` 扇出 →
`SessionManager` 转发 → `ChatWebviewProvider` postMessage 到 webview。
取消走 `SessionManager.cancelTurn`。

### 2.5 聊天 UI
**路由层**：`ChatRouterProvider`（`src/ui/chat/`）按「聚焦会话所属 agent」在
`ChatPanelHost`（新，仅 Claude Code）与 `LegacyPanelAdapter`（旧）之间切换；
`ChatWebviewProvider` 本身零改动，靠 facade 接入。**视图 id 仍是唯一的 `acpc-chat`**。

**新面板**：`ChatPanelHost.onMessage`（webview→扩展）→ `SessionManager`；
`onSessionUpdate`（`session/update` → transcript）→ `TranscriptStore` → postMessage。

webview→扩展消息类型：`ready`/`sendPrompt`/`cancelTurn`/`newSession`/`closeSession`/`focusSession`/`focusAgent`/`detachFile`/`setMode`/`setModel`/`setConfigOption`/`renderMarkdown`/`openLink`/`openFile`/`openTerminal`/`copy`/`executeCommand`。
扩展→webview 消息类型：`boot`/`focus`/`sessionsChanged`/`sessionClosed`/`append`/`revise`/`toolUpdate`/`markdownRendered`/`meta`/`attachments`/`error`。

**旧面板的历史协议**（仅 `LegacyPanelAdapter` 使用，勿与新协议混用）：
`handleMessage` 收 `sendPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`executeCommand`/`ready`/`renderMarkdown`；
发出 `state`/`promptStart`/`promptEnd`/`clearChat`/`error`/`sessionUpdate`/`modesUpdate`/`modelsUpdate`/`configOptionsUpdate`/`loadSessionStart`/`loadSessionEnd`/`sessionInfoUpdate`/`markdownRendered`。

### 2.6 侧边栏树
`SessionTreeProvider.getChildren` → `getAgentNodes` → `getAgentChildren` →
`getAgentSourcedChildren`（agent 支持 `session/list`）或 `getLocalSourcedChildren`（回退本地缓存）；
分页 `loadMore`；能力探测 `probeCapabilities`。

### 2.7 客户端能力实现
`handlers/FileSystemHandler`（读写文件）、`handlers/TerminalHandler`（终端）、
`handlers/PermissionHandler`（权限）；都由 `AcpClientImpl` 统一暴露给 ACP SDK。

### 2.8 agent 默认列表与设置项
agent 定义是**纯数据**：`package.json` 的
`contributes.configuration.properties["acpc.agents"].default`（11 条）+ `AgentConfig.ts` 读取。
加/改 agent 不需要动代码。其余设置项：`acpc.autoApprovePermissions` / `acpc.defaultWorkingDirectory` / `acpc.logTraffic`。

### 2.9 打包 / 发布
`package.json` 的 `scripts`（`compile`/`watch`/`package`/`lint`/`test`）、
`.vscodeignore`（**新增顶层目录必须同步加排除，否则会打进 .vsix**）、
`CUSTOMIZATIONS/scripts/release-vsix.sh`。

---

## 3. 重点链路详解（高频改动区）

### 3.1 激活装配与 dispose（改命令/事件必看）
`extension.ts` 的 `activate()` 顺序：`initTelemetry`（no-op）→ 构造 SessionUpdateHandler /
AgentManager / ConnectionManager / SessionManager → `SessionHistoryStore`（挂到 SessionManager）→
构造 SessionTreeProvider + `createTreeView('acpc-sessions')` → 构造 ChatWebviewProvider +
`registerWebviewViewProvider(ChatWebviewProvider.viewType)` → StatusBarManager → **注册 21 个命令** →
挂事件转发。所有 Disposable 进 `context.subscriptions`；末尾一个总的 dispose 依次拆
sessionManager / sessionUpdateHandler / chatWebviewProvider / sessionTreeProvider / 输出通道。

### 3.2 命名空间 `acpc.*`（本仓库与上游的核心差异）
所有**全局可冲突标识符**已从上游的 `acp.*` 改名为 `acpc.*`：
命令 id（21 个）、视图容器 id（`acp-client-custom`）、视图 id（`acpc-sessions`/`acpc-chat`）、
配置段（`acpc.*`，4 项）、上下文键（`acpc.turnInProgress`）、输出通道名。
改这些标识符时**必须三层同步**：`package.json`（contributes）↔ `src/*.ts`（注册/执行）↔ webview 内联 JS（若有）。详见 §4。

### 3.3 子进程 → 流 → SDK 的转换链
`AgentManager.spawnAgent` 产出 `ChildProcess` → `childProcessToWebStreams` 转 Web Streams →
`ndJsonStream` 编解码 JSON-RPC → `ClientSideConnection`（ACP SDK）→ `AcpClientImpl` 回调到 handlers。
排查协议问题在这一条链上任选一点打日志。

---

## 4. 数据/契约铁律

1. **全局标识符一律 `acpc.*`**，不沿用上游 `acp.*`——两套扩展会同时安装，命令 id / 视图 id / 配置段
   在 VS Code 中是**全局命名空间**，重名会冲突。改名后必须 `grep` 复核（编译器不检查字符串字面量）。
2. **两处 `acp.` 是故意保留的**，勿"顺手修"：
   - `src/core/SessionHistoryStore.ts` 的 `STATE_KEY = 'acp.sessionHistory.v1'`——这是 `workspaceState`
     的 Memento key，**扩展内作用域**，不与上游冲突；改名会导致既有会话历史全丢。
   - `src/core/ConnectionManager.ts` 的 `clientInfo.name = 'vscode-acp-client'`——ACP `initialize`
     握手时上报给 agent 的客户端名，协议元数据，非全局标识符。
3. **`acpc.turnInProgress` 上下文键上游从未 `setContext`**——`package.json` 里 Escape 取消绑定
   与 `view/title` 的取消按钮都依赖它，但代码中无 setter，属上游遗留问题（见 pitfalls）。改动取消
   逻辑时留意。
4. **`package.json` 是改动的必改项但无标记**：命令/设置/视图的任何增删都要动它，且它是 JSON
   不能加注释。登记时按 README 的"无标记"三情形处理。
5. **webview 内联 HTML 里也有命令 id 字面量**（`executeCommand` 调用点），改命令 id 时
   `grep src/ui/ChatWebviewProvider.ts` 确认。
6. **`.vscodeignore` 与顶层目录联动**：新增任何顶层目录/文件必须同步加进 `.vscodeignore`，
   否则会打进 `.vsix` 发给用户。

---

## 5. 新 Chat 面板子系统（`src/ui/chat/`，CUSTOM-20260923-011）

> 上游**没有**这一整棵树，所以它不参与任何上游合并冲突。入口是 `index.ts`，
> 外部只依赖 `ChatRouterProvider`。

### 5.1 文件职责

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `ChatRouterProvider.ts` | **唯一一个 `acpc-chat` 视图的路由层**。按聚焦会话所属的 `acpc.agents` 配置键决定渲染新面板还是旧面板；也是 webview 上**唯一**的 `onDidReceiveMessage` 注册者 | 新增「哪些 agent 用新面板」/ 改切换策略 |
| `ChatPanelHost.ts` | 新面板的扩展侧：session/update → transcript，用户消息 → SessionManager；markdown 往返、链接白名单、附件 | 改新面板行为 |
| `LegacyPanelAdapter.ts` | 用 **facade** 包装未改动的 `ChatWebviewProvider`，使其满足 `IChatPanel`。facade 的 `onDidReceiveMessage`/`onDidDispose` 刻意**不转发**（只存回调），避免旧 provider 重复收消息 | 旧 provider 接触了新 API 时 |
| `panelContract.ts` | `IChatPanel` / `PanelContext` / `PanelId` | 面板接口变更 |
| `protocol.ts` | postMessage 判别联合（`ExtToChat` / `ChatToExt`）+ `verifySession` 纪律 | 增删消息类型 |
| `markdown.ts` | `SafeMarkdown`：覆盖 `marked` 的 `html`/`link`/`image` 三个渲染钩子。**必须用 `new Marked()`**（旧面板改的是全局单例） | markdown 安全策略变更 |
| `transcript/types.ts` | transcript 记录模型（`user`/`assistant`/`thought`/`tool`/`plan`/**`content`**/`notice` 七类，`content` 承载非文本消息块）+ `ToolInvocation` | 记录结构变更 |
| `transcript/TranscriptStore.ts` | 按会话存记录；三重上限（500 条 / 24 会话 LRU / 64KB 每条）；活跃会话豁免 LRU。`finalizeStreaming` 带 `only` 过滤（**不要**在正文 chunk 上调用无参形式，那会把一次回复碎成 N 个气泡） | 容量策略 / 新记录类型 |
| `transcript/ToolInvocationStore.ts` | 工具调用索引，严格实现 ACP 的 **replace-collection** 语义 | 工具调用字段变更 |
| `content/contentBlocks.ts` | `ContentBlock`（5 种）→ 可序列化视图模型 | 新增内容类型 |
| `content/toolCalls.ts` | `ToolInvocation` → `ToolCallView`（命令、locations、diff/terminal/content 项） | 工具调用渲染数据 |
| `nesting/NestingStrategy.ts` | `NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 分派 + `flatNesting`（**空实现，且是默认路径**） | 新增 agent 的嵌套策略 |
| `nesting/ClaudeCodeNesting.ts` | Claude Code 的嵌套推断：显式链接（父的 `rawOutput`/`_meta` 里出现子 id）优先，时序包含回退。**全部是启发式猜测** | 探针 (b) 有新发现时改这里 |
| `html/index.ts` | `renderChatHtml(webview, nonce)`：外壳 + 样式 + 标记 + 脚本 | 装配顺序变更 |
| `html/shell.ts` / `styles.ts` / `body.ts` | CSP 与文档外壳 / 全部 CSS / 静态标记 | UI 外观 |
| `html/nonce.ts` | CSP nonce 生成 | — |
| `html/client/*.ts` | webview 内联客户端 JS，**每个模块是一个字符串**，统一挂到 `window.__acpc` | 改前端交互 |

**终端输出通路**（CUSTOM-20260923-012）：ACP 的 `Terminal` 工具内容只是引用（`{terminalId}`），终端归客户端所有。
链路为：`ConnectionInfo.terminals`（`ConnectionManager` 暴露）→ `TerminalHandler.readOutput(terminalId)`
（只读、未知 id 返回 `null`）→ `ChatPanelHost.handleOpenTerminal` → 作为 `content` 条目追加。

### 5.2 webview 客户端代码的三条纪律（写之前必读）

客户端 JS 嵌在 **TS 模板字符串**里，因此：

1. **模板字符串内部严禁反引号**（哪怕在注释里）——会直接终止字符串，tsc 报出的
   `TS1005` 位置与肇事处相距甚远。注释一律用单引号。见 `docs/pitfalls.md` #11。
2. **想出现在生成脚本里的反斜杠必须双写**：源里写 `'\n'`，生成脚本才是 `'\n'`。
   `\u` 转义只吃 4 位十六进制。
3. 改动后**必须**跑校验：
   ```bash
   node CUSTOMIZATIONS/scripts/check-webview-client.mjs
   ```
   它把各模块的模板内容抽出、拼接，交给 `new Function()` 做语法校验（只解析不执行）。
   已接入 `check-registry.mjs` **§5**，CI 会跑。

### 5.3 面板切换与在途状态

- 新面板的 transcript 存在**扩展宿主**（`TranscriptStore`），切走再切回不丢内容，也不需要重新 `session/load`。
- 面板未 attach 时记录照常累积（后台会话继续跑），只是 `postMessage` 被守卫丢弃。
- 旧面板的 DOM 记录在重新赋 `webview.html` 时**会丢**——这是明确接受的代价（非目标）。
- `acpc-chat.focus` 的 5 个调用点（`extension.ts` ×4 + `SessionTreeProvider` 的树项命令）**都不需要改**：
  视图 id 没变，路由层决定内容。

### 5.4 消息纪律（改协议前必读）

**规则一：会话作用域的消息必须带 `sessionId`。**
扩展侧 `ChatPanelHost.onMessage` 用 `verifySession()` 校验其对应会话存在；不匹配（含过期会话）一律丢弃并记日志——
**绝不静默落到「当前聚焦会话」上**。webview 侧同样只处理与当前聚焦会话匹配的消息。
客户端用 `NS.bridge.postForSession(msg)` 发这类消息（它会给缺失的 `sessionId` 打上当前聚焦会话）。

**规则二：非会话作用域的消息必须在守卫之前处理。**
`verifySession` 守卫之前的那个 switch 是给**按设计不带 `sessionId`** 的消息用的：
`ready` / `newSession` / `focusAgent` / `renderMarkdown` / `copy` / `openLink` / `executeCommand`。
**把这类消息放到守卫之后 = 它们会被全部丢弃。**
这不是理论风险：Phase 2 的 `renderMarkdown` 就被放在了守卫之后，导致 markdown 渲染整条链失效
（助手气泡只显示原始 markdown 文本，代码块/复制按钮/链接全都没有），而所有自动化检查都是绿的——
因为 tsc/lint/webpack 都看不到「消息被运行时守卫丢掉」。见 `CUSTOM-20260923-012`。

### 5.5 fork 侧的安全约定

- CSP：`script-src` **只有 nonce**（无 `'unsafe-inline'`），`img-src` 额外允许 `data:`（非文本内容的 base64 图片）。
- 链接：markdown 渲染出的 `<a>` **不带真实 href**（只写 `data-href`），点击回传扩展侧做协议白名单
  （仅 `http`/`https`/`mailto`）再 `openExternal`。**`command:` 必须拒绝**——那等于把 IDE 变成远程命令执行。
- markdown：扩展侧 `SafeMarkdown` 渲染 + 客户端 `DOMParser` 白名单双重兜底。

### 5.6 子 agent 分组：全部是推断（CUSTOM-20260923-013）

> **前提**：ACP **没有**子 agent / 父子工具调用概念——枚举 SDK 全部 239 个 schema 定义，
> `parent|subagent|delegate|nested|child|spawn` **零命中**。工具调用是只以 `toolCallId` 为键的**扁平集合**。
> 因此界面上任何"树"都是**事后推断**，依据是 agent 自定义的 `rawInput` / `rawOutput` / `_meta`（均为 `unknown`）。

两条铁律，改这块之前请先读：

1. **默认必须是扁平的。** `flatNesting`（空实现）是**默认路径**而非兜底分支——对形状未知的 agent，
   时间线顺序是正确的，**错的树比没有树更糟**。新 agent 只有在实测过它的流量之后才应接入推断策略。
2. **推断出来的边必须在 UI 上可区分。** `inferredParent: true` 的边带 `?` 角标与 tooltip，
   明说"此链接由时序与产出推断而来，可能是错的"。**绝不允许**把推断结果伪装成协议事实。

推断分两级，显式优先：

| 级别 | 判据 | 标记 |
|---|---|---|
| 显式 | 某个 Task 类调用的 `rawOutput` 或 `_meta` 里**出现了子调用的 toolCallId**——与厂商无关，不需要知道键名 | `inferredParent: false` |
| 时序回退 | 子调用区间被父区间包住，取**最内层**（跨度最小）者 | `inferredParent: true` |

护栏（宁可漏连，不可错连）：父区间须比子区间长 ≥ 50ms；深度上限 3；**并列（跨度相同）不连**；
**只有 Task 类调用能做父**（Task 可嵌 Task，普通 Edit/Read 不会被误归组）。

`apply()` 是「先算后改 + 迭代收敛」——单趟边改边算会让结果依赖遍历顺序；而深度护栏读的是上一轮的深度，
单趟会让一条全新的深链全部连上（深度都从 0 开始）。**改动前请先跑 `src/test/nesting.test.ts`（11 条）**，
它把上面每条护栏都钉死了。
