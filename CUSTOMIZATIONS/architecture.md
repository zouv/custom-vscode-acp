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
   └── 视图 acpc-chat     (webview)── ChatWebviewProvider  ← HTML 内联，无独立构建步骤
                                          ▲ postMessage
                                          │
                              ┌───────────┴────────────┐
                              │   SessionManager        │  ← 编排器（36KB，最复杂）
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
| 聊天 UI / 消息渲染 / 模式模型选择器 | `ChatWebviewProvider.ts`（**只读 `getHtmlContent()` 对应片段，勿整读 87KB**） | core | §2.5 |
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
| `src/core/SessionManager.ts` | **本仓库最复杂的编排器**（36KB）：`connectToAgent`/`newConversation`/`sendPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`listSessions`/`loadSession`/`resumeSession`；`-32000` 认证重试；早到通知缓冲（`pendingAvailableCommands`/`pendingConfigOptions`/`pendingTitles`）；emit 13 种事件 | 会话状态机 / 新事件 / 能力协商 |
| `src/core/SessionHistoryStore.ts` | `workspaceState` 持久化的会话缓存（tier-2 树数据源），按 agent+cwd 分桶、有容量上限、`reconcileFromAgent` 与 agent 侧对账 | 会话列表丢失 / 缓存策略 |
| `src/core/AcpClientImpl.ts` | ACP SDK `Client` 接口的门面，把方法转发给各 handler | 新增 ACP 客户端能力 |
| `src/handlers/FileSystemHandler.ts` | `fs/read_text_file`（**优先返回未保存的编辑器缓冲区**，支持 `line`/`limit`）、`fs/write_text_file`（建父目录 + 打开预览） | 文件读写异常 |
| `src/handlers/TerminalHandler.ts` | `terminal/*`：托管终端 Map、1MB 输出上限（UTF-8 安全截断）、100ms 缓冲刷写、SIGTERM 终止 | 终端输出卡住 / 乱码 / 泄漏 |
| `src/handlers/PermissionHandler.ts` | `session/request_permission` → 读 `acpc.autoApprovePermissions` 自动批准，否则 QuickPick | 权限弹窗行为 |
| `src/handlers/SessionUpdateHandler.ts` | `session/update` 通知的监听器扇出（try/catch 隔离单个订阅者） | 流式更新丢事件 |
| `src/ui/ChatWebviewProvider.ts` | **单文件 87KB**：webview 视图 + **内联 HTML 字符串**（`getHtmlContent()`，CSP+nonce）；webview↔扩展 postMessage 协议；`marked` 渲染 markdown | 聊天 UI / 消息协议 |
| `src/ui/SessionTreeProvider.ts` | 两层树 `AgentNode`/`ChildNode`：`AgentTreeItem`/`SessionTreeItem`/`InfoTreeItem`（loading/empty/unsupported/error/auth-required/load-more） | 树结构 / 右键菜单行为 |
| `src/ui/StatusBarManager.ts` | 状态栏 `$(hubot) ACP: <status>`，订阅 5 个 SessionManager 事件；点击触发 `acpc.connectAgent` | 状态显示 |
| `src/config/AgentConfig.ts` | 读 `acpc.agents` 设置，导出 `getAgentConfigs`/`getAgentNames`/`getAgentConfig` | agent 列表读取逻辑 |
| `src/config/RegistryClient.ts` | 拉 `cdn.agentclientprotocol.com` 的 agent registry，5 分钟 TTL，失败回退缓存 | 换 registry 源 / 缓存策略 |
| `src/utils/Logger.ts` | 双输出通道（`ACP Client (Custom)` / `ACP Traffic (Custom)`）；`logTraffic` 按 JSON-RPC 分类 REQUEST/NOTIFICATION/RESPONSE，受 `acpc.logTraffic` 开关控制 | 日志格式 / 新增通道 |
| `src/utils/StreamAdapter.ts` | `childProcessToWebStreams`：ChildProcess → `AcpStream{readable,writable}` | 流适配 |
| `src/utils/TelemetryManager.ts` | **本仓库已改为 no-op**（见 registry `CUSTOM-20260923-002`），保留同名 API | 重新启用遥测 |
| `src/test/extension.test.ts` | 唯一的测试：扩展存在 / 能激活 / 命令已注册（断言 `acpc.` 前缀） | 改扩展 id 或命令前缀时必须同步 |

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
`ChatWebviewProvider.getHtmlContent()`（内联 HTML/CSS/JS，**用 grep 定位片段，勿整读**）、
`handleMessage`（webview→扩展：`sendPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`executeCommand`/`ready`/`renderMarkdown`）、
postMessage 到 webview 的类型：`state`/`promptStart`/`promptEnd`/`clearChat`/`error`/`sessionUpdate`/`modesUpdate`/`modelsUpdate`/`configOptionsUpdate`/`loadSessionStart`/`loadSessionEnd`/`sessionInfoUpdate`/`markdownRendered`。

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
