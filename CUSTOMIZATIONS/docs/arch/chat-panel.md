# Chat 面板子系统 · 代码链路图谱（`src/ui/chat/`）

> **这是什么**：`architecture.md` §5 的**拆出部分**（CUSTOM-20260925-042）。
> 它是本项目体量最大、坑点最密的一块代码——30 个模块、约 8000 行，
> 按 `architecture.md` §0 的体量铁律（「超过 ~400 行即拆分」）从主文件移出。
>
> **§5.x 的编号原样保留**。这不是偷懒：代码注释与其它文档里有几十处「§5.4」「§5.10」之类的引用，
> 重编号会把它们全部变成指向空处的雷；而这次拆分的目的是**省上下文**，不是整理编号。
> 因此读到「§5.7」时，只需要把文件名从 `architecture.md` 换成 `docs/arch/chat-panel.md`。
>
> **什么时候读它**：改 `src/ui/chat/**` 之前。
> 只是想知道「某个文件负责什么」不必读它——那是 [`../../architecture.md`](../../architecture.md) §1 的职责表。
> 本文件回答的是**另一类问题**：「这块代码为什么长这样」「哪些不变量破了不会有任何自动检查报错」。
>
> **配套**：**会话目录与重开路径（§5.13–§5.15）已再拆到
> [`chat-panel-sessions.md`](./chat-panel-sessions.md)**（CUSTOM-20260925-060）；
> 导航与任务路由见 [`../../architecture.md`](../../architecture.md)（§0 架构图 / §0.5 任务路由 / §1 文件职责）；
> 历史坑点见 [`../pitfalls.md`](../pitfalls.md)；改动账本见 [`../../registry.md`](../../registry.md)。

---

## 5. 新 Chat 面板子系统（`src/ui/chat/`，CUSTOM-20260923-011）

> 上游**没有**这一整棵树，所以它不参与任何上游合并冲突。入口是 `index.ts`，
> 外部只依赖 `ChatRouterProvider`。

### 5.1 文件职责

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `ChatRouterProvider.ts` | **唯一一个 `acpc-chat` 视图的路由层**。按聚焦会话所属的 `acpc.agents` 配置键决定渲染新面板还是旧面板；也是侧边栏 webview 上**唯一**的 `onDidReceiveMessage` 注册者。019 起同时持有编辑区面板（`openEditorChat`） | 新增「哪些 agent 用新面板」/ 改切换策略 |
| `ChatPanelHost.ts` | 新面板的扩展侧：session/update → transcript，用户消息 → SessionManager；markdown 往返、链接白名单、附件。019 起持有**多个 surface**（侧边栏 / 编辑区），`post()` 广播、`boot` 定向 | 改新面板行为 |
| `ChatSurface.ts` | **019 新增**。把 `WebviewView`（侧边栏）与 `WebviewPanel`（编辑区）归一化：`visible` / `reveal(preserveFocus)` / `onDidDispose`。差异只在显隐与前置方式（`show` vs `reveal`） | 新增第三种承载方式 |
| `Outbox.ts` | **022 新增**。流式消息合帧队列：只合并「队尾单条同 id 的 append」，其余按 FIFO 原样发。顺序不变式 INV-A..E 见 §5.10 | 改合帧策略 / 新增消息类型 |
| `ChatEditorPanel.ts` | **019 新增**。编辑区面板生命周期：`open()`（**只在聚焦到 legacy agent 时拒绝**，见 §5.7）/ `close(reason)`。视图类型 `acpc-chat-editor`。**监听器必须先于 `attachSurface` 注册**（见 §5.7） | 编辑区面板行为 |
| `LegacyPanelAdapter.ts` | 用 **facade** 包装未改动的 `ChatWebviewProvider`，使其满足 `IChatPanel`。facade 的 `onDidReceiveMessage`/`onDidDispose` 刻意**不转发**（只存回调），避免旧 provider 重复收消息 | 旧 provider 接触了新 API 时 |
| `panelContract.ts` | `IChatPanel` / `PanelContext` / `PanelId` + **`MODERN_AGENTS` / `isModernAgent()`**（019 从 router 移来，供 host 与编辑区面板共用，避免循环依赖） | 面板接口 / agent 策略变更 |
| `protocol.ts` | postMessage 判别联合（`ExtToChat` / `ChatToExt`）+ `verifySession` 纪律 | 增删消息类型 |
| `markdown.ts` | `SafeMarkdown`：覆盖 `marked` 的 `html`/`link`/`image` 三个渲染钩子。**必须用 `new Marked()`**（旧面板改的是全局单例） | markdown 安全策略变更 |
| `sessionChoices.ts` | **073 新增**。切换状态（mode + config options）的**快照 / 按通知载荷打补丁 / 算差异 → 人类可读的一句话**。纯函数，宿主只做缓存与发帖（去重靠"缓存由宿主独占"，见 §5.22）。**128 起模式以 config option 为权威**：快照的 modeId 由它派生、mode payload 写回该副本——两通道各存一份副本且只写一份时，去重会静默失效（见 §5.22 末与 pitfalls #34） | 改切换提示的表述、或改"两条上报路径怎么去重" |
| `historyDirs.ts` | **079 新增**。历史选择器的目录过滤器：`directoryKey`（目录同一性：平台大小写规则 + 尾分隔符）/ `directoryOptions`（候选目录与条数）/ `folderName`。纯函数，宿主算 key、客户端只比较（见 §5.24） | 改"两个路径算不算同一个目录"、或改候选目录的来源与排序 |
| `transcript/types.ts` | transcript 记录模型（`user`/`assistant`/`thought`/`tool`/`plan`/**`content`**/`notice` 七类，`content` 承载非文本消息块）+ `ToolInvocation` | 记录结构变更 |
| `transcript/TranscriptStore.ts` | 按会话存记录；三重上限（500 条 / 24 会话 LRU / 64KB 每条）；活跃会话豁免 LRU。`finalizeStreaming` 带 `only` 过滤（**不要**在正文 chunk 上调用无参形式，那会把一次回复碎成 N 个气泡） | 容量策略 / 新记录类型 |
| `transcript/ToolInvocationStore.ts` | 工具调用索引，严格实现 ACP 的 **replace-collection** 语义 | 工具调用字段变更 |
| `content/contentBlocks.ts` | `ContentBlock`（5 种）→ 可序列化视图模型 | 新增内容类型 |
| `content/toolCalls.ts` | `ToolInvocation` → `ToolCallView`（命令、locations、diff/terminal/content 项） | 工具调用渲染数据 |
| `nesting/NestingStrategy.ts` | `NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 分派 + `flatNesting`（**空实现，且是默认路径**） | 新增 agent 的嵌套策略 |
| `nesting/ClaudeCodeNesting.ts` | Claude Code 的嵌套推断：显式链接（父的 `rawOutput`/`_meta` 里出现子 id）优先，时序包含回退。**全部是启发式猜测** | 探针 (b) 有新发现时改这里 |
| `html/index.ts` | `renderChatHtml(webview, nonce, surface = 'view')`：外壳 + 样式 + 标记 + 脚本。**`surface` 会变成 `<body class="surface-view\|surface-editor">`**（050），供 CSS 区分侧边栏与编辑区底色 | 装配顺序变更 |
| `html/shell.ts` / `styles.ts` / `body.ts` | CSP 与文档外壳 / 全部 CSS / 静态标记 | UI 外观 |
| `html/nonce.ts` | CSP nonce 生成 | — |
| `html/client/*.ts` | webview 内联客户端 JS，**每个模块是一个字符串**，统一挂到 `window.__acpc`。058 新增 `directoryMenu.ts`（草稿页的目录抽屉，形态照抄 `sessionMenu.ts`）；097 新增 `lightbox.ts`（图片点击放大）；102 新增 `stickyUser.ts`（置顶最近一条用户消息，判据见 §5.25）；123 新增 `stateCard.ts`（**连接状态卡**：未连接/连接中/已就绪三态 + 自动连接开关，见 §5.28——它同时接管了原先散在 `sessionMenu.ts` 与 `boot.ts` 的空态文案和 Connect 按钮）。151 起 `composer.ts` 也接管**草稿页**的输入卡（模式/模型/斜杠命令来自宿主的快照，见 §5.32）；152 起 `elicitationView.ts` 从"记录里的内联卡"改成**悬浮抽屉**（记录只留一行待答条，见 §5.33） | 改前端交互 |

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
4. **不要在模板体里写含 `/` 的正则**（CUSTOM-20260925-049 新增）；
   **也不要在字符串里写 `\\'`（转义单引号）**（CUSTOM-20260927-094 新增，同一类坑的第二个形态）。
   上面那个检查器是**按原始模板文本**解析的——**它不还原模板转义**。于是源码里的
   `/^\\/[a-zA-Z]:/`（生成的脚本里是 `/^\/[a-zA-Z]:/`，完全合法）在它眼里是
   「转义的反斜杠 + 未转义的 `/`」⇒ **正则在此提前结束**，后面的 `[a-zA-Z]:` 成了裸代码，
   报出一个位置完全对不上的 `Unexpected token ':'`。
   同理 `'…agent\\'s…'`（生成脚本里是 `'…agent\'s…'`，合法）在它眼里是
   「转义的反斜杠 + **字符串结束**」，后面的 `s transcript folder…` 成了裸代码 ⇒ `Unexpected identifier 's'`。
   避开办法：改写成语义等价的**无正则**形式（本次用 `charCodeAt` 判断盘符），或者让正则里
   不出现 `/`；字符串则**避免转义引号**——换个不含撇号的措辞，或用双引号包住整串。
   **字符串**里的其它转义（`\\n` / `\\u2026`）没有这个问题，只有「反斜杠 + 引号」和「正则里的 `/`」会这样炸。
   完整经过见 `docs/pitfalls.md` #11 的复发记录。

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
`ready` / `newSession` / `focusAgent` / `renderMarkdown` / `copy` / `openLink` / `executeCommand` /
`connectAgent` · `listHistory` · `openHistorySession` · `createDraftAndSend`（032/033/058）/
`setUiPref`（077）/ `setAutoConnect`（125）。
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

### 5.7 双 surface：侧边栏 + 编辑区（CUSTOM-20260924-019）

**为什么必须新建面板**：侧边栏的 `webview` 视图**无法被拖进编辑区**，VS Code 也没有对应的声明式开关；
编辑区承载 webview 的唯一途径是 `vscode.window.createWebviewPanel`（本仓库此前零处使用）。
用户选的是「并存可切换」而非「移动」，所以侧边栏视图原样保留，`acpc-chat.focus` 的 5 个调用点一处未改。

**成本为什么低**：transcript 存在扩展宿主（011 的设计），与视图无关；`renderChatHtml(webview, nonce)`
的形参本来就是普通 `vscode.Webview`。第二个面 = 再 attach 一次，**不需要第二份状态，也不会触发 `session/load`**。

| 关注点 | 规则 |
|---|---|
| 状态归属 | 只有一个 `ChatPanelHost`，两个面读同一份 `TranscriptStore` / 工具索引 / 附件 / usage |
| 下行消息 | `post(msg)` **广播**（客户端本来就按 `currentSessionId` 过滤，广播即同步） |
| `boot` | **定向**（`pushBoot(from)`）。广播会让另一个文档被迫 `hydrate` → reset + 重建 + 滚到底 |
| `focus` / `meta` / `sessionsChanged` / `append` / `revise` | 广播 |
| `renderMarkdown` 往返 | 请求照旧；`markdownRendered` 广播（两个文档都需要 html，`TranscriptStore.patch` 幂等） |
| 关掉再打开 | `onDidDispose` → `detachSurface('editor')`；store 不动；重开 → 新文档 → `ready` → 定向 boot → 全量快照 |
| 窗口重载后恢复 | **非目标**（需 `registerWebviewPanelSerializer`） |

**三条不变量**（踩了不会有自动检查报错）：

1. **编辑区面存在 ⟹ 聚焦 agent（若有）∈ `MODERN_AGENTS`**。
   焦点跨到一个 **legacy** agent 时 `syncActivePanel()` 必须 `close('focus-changed')`。
   **注意是蕴含不是等价**（031 放宽）：**没有聚焦会话是合法状态**，不该关面板、也不该拒绝打开——
   窗口重载后 `activeSessionId` 就是 null，而状态栏仍会显示"第一个已连接的 agent"
   （`activeSession?.agentDisplayName || connectedAgents[0]`），所以"状态栏写着 Claude Code"
   并不代表它被聚焦。这条曾经让「打开编辑区面板」的按钮在重载后必被拒。
2. **`attachSurface` 之前必须先注册 `onDidReceiveMessage` / `onDidDispose`**。`attachSurface` 会写 HTML，
   文档的 `ready` 紧随其后；注册晚了会漏掉第一条 `ready`，面板永久空白。
3. **`detach()` 只断侧边栏面**（`detachSurface('view')`）。写成清空全部 = 侧边栏切到 legacy 时编辑区一起变空白。

**打开面板时的目标会话（031）**：`ChatEditorPanel.open()` 的顺序是
「有聚焦 agent 且是 legacy → 拒绝」→「没有聚焦会话 → `focusMostRecentModernSession()`
（复用面板 agent 选择器那套：取该 agent 最近一个 live 会话并 `focusSession`）」→「创建面板并
**重新读一次 context** 作为 boot 快照」。
**刻意不自动建会话**：`open()` 不该 spawn 进程；空面板是合法结果，面板里的 `+` 一键开新会话。

**`syncActivePanel` 的第二个用途**：旧实现第一行是 `if (!this.view) return`，即「侧边栏从未打开时，
焦点变化推不到任何面板」。编辑区面板恰好是"没有侧边栏也能用"的场景，所以现在侧边栏不存在但编辑区开着时，
仍会把 `PanelContext` 推给 modern host。

**编辑区面消息不走 `this.current`**：`ChatEditorPanel` 直接转给 `modern` host
（`onMessage(msg, 'editor')`）——此刻侧边栏可能正挂在 legacy 上。

### 5.8 面板内权限卡（CUSTOM-20260924-020）

**三条会挂死 agent 的泄漏路径**（改这块之前必须知道，上游一条都没堵）：

1. **SDK 对 `session/request_permission` 没有超时**——呈现不出来就是永久等待。
   所以 `canPresent` 里的 `surface.reveal(true)` 不是锦上添花，是"让 agent 继续跑"的必要动作。
2. **取消轮次必须回答 `cancelled`**（ACP 契约）。`SessionManager.cancelTurn` 的第一句就是
   `bridge.cancelSession(sessionId)`。**不要**把它挪到 `connection.cancel()` 之后。
3. **并发请求**：弹框路径走全局 FIFO（`drain()`），一次只弹一个。

**状态机**（`PermissionState.status`，客户端 `permissionView.applyState` 消费）：

```
pending ──用户点按钮──► selected        （回答 optionId）
   │  └──取消/会话关闭──► cancelled     （回答 { outcome: 'cancelled' }）
   └──最后一条 surface 断开──► deferred ──弹框回答──► selected | cancelled
```

**回答路径唯一性**：`deferred` 时卡片按钮**禁用**。存在两条回答路径 = 用户以为点了 A 实际生效 B，
而 `answer()` 对已 deferred 的 prompt 直接拒绝（记日志），不做事后补救。

**`canPresent` 的三个必要条件**（缺一不可）：聚焦会话匹配、modern agent、存在 surface。
第一个条件是必须的：给非聚焦会话发卡片，客户端会按 `currentSessionId` 过滤掉，
结果是"agent 在等一个没人看得见的按钮"。

**协议**：`permissionAnswer` 是**会话作用域**的（带 `sessionId`），因此在 `ChatPanelHost.onMessage`
里必须放在 `verifySession` 守卫**之后**（§5.4 规则一）。卡片状态本身**不占新消息类型**，
走现有的 `append` / `revise`，快照天然携带待决卡片。

**安全**：`toolCall.title` / `option.name` 是 agent 可控字符串，客户端一律 `NS.dom.el(..., text)`，
**禁止 innerHTML**（`permissionView.ts` 头部有说明）。

**非目标**：权限超时（落点：`PermissionBridge.request`）。

### 5.9 会话大纲（CUSTOM-20260924-021，076 加钉住式右侧栏，077 二次优化）

**纯客户端**：不动协议、不加命令、不改 `package.json`。锚点来自 `transcriptView.ordered()`，
**不是** `Object.keys(objects)` —— 后者的顺序保证只覆盖整数样式的键，错了的表现是"跳转到不相干的消息"。
076 起锚点从「只收 `user`」扩到「`user` + `assistant`」（其它 kind 仍排除），每项带类型图标 + hover 全文。

| 关注点 | 规则 |
|---|---|
| DOM 锚 | 每个节点在 `place()` 里打 `data-entry-id`；`node(id)` / `entry(id)` 是唯一查找入口 |
| 布局读取 | **只在 rAF 回调里**（`NS.dom.schedule`）。scroll 事件只置脏位，否则每帧强制重排 |
| 高亮 | 缓存的 `[{id, top}]` 上二分；`invalidate()`（transcript 变更）后重建；重建只在抽屉打开时做 |
| 跳转 | `scroll.jumpTo(node)` 先置 `pinned = false` 再写 `scrollTop`，随后 scroll 事件按真实距离重算 |
| Escape | **捕获阶段**监听 + `stopPropagation`：composer 在 textarea 上监听 Escape 取消轮次，不拦会误取消 |
| 上限 | 200 条锚点，多出的折叠成一行「… N earlier hidden」 |
| **有没有东西可导航（081）** | **这条判据管所有形态**：没有锚点（无会话 / 新会话 / 全是工具记录）时，☰ 按钮、下拉浮层、**钉住的右侧栏****一律不显示**。045 当年只把它加在 ☰ 按钮上——那时下拉是唯一形态，"没有按钮就没有大纲"成立；076 让它可钉住之后，钉住的那一栏**没走这条判据**，于是空态旁边会摊着一列 "OUTLINE / No messages yet"，把空态挤出面板正中（用户截图）。判据只有一处（`outline.ts` 的 `anchorsPresent`，由 `syncButton()` 唯一写入、`renderVisibility()` 读取），**mode 只是偏好、不决定可不可见**：钉住状态留着，第一条消息一到那栏自己回来。副作用：空对话时没法点 ✕ 取消钉住（等第一条消息即可）——因为此时它本来也没有内容可导航 |

**`invalidate()` 的调用点**在 `boot.ts` 的 `append` / `revise` / `focus` / `boot` / `sessionClosed` / `error`
分支里——**不要**放进 `meta` / `attachments`，那会让抽屉在流式期间被反复重建。

**钉住式右侧栏（CUSTOM-20260926-076，077 二次优化）**：下拉与侧栏两种形态并存，`mode ∈ {popup, sidebar}`
+ 瞬态 `isOpen`。下拉头部「固定到右侧」并进 `.outline-head`（"N messages" 同一行，`#outlinePin` 是
`.outline-head-info` 计数容器的兄弟、静态），把大纲钉成常驻右栏（`#outlineSidebar`，`#messages` 的 flex
兄弟、定宽，宽度由 JS 写 inline）。

| 关注点 | 规则 |
|---|---|
| 持久化 | `mode` / `width`（180px~50%）走**宿主 `globalState`**（077）：`setUiPref`（webview→ext）存 `acpc.outlinePrefs.v1`，`uiPrefs`（ext→webview）随 boot 带回、`applyPrefs()` 恢复——跨窗口重载/编辑器面板重开存活（webview 本地 `vscode.setState` 只活在同一实例 reload） |
| 跳转 | 侧栏模式**不关**（常驻导航）；下拉模式维持「跳完收起」 |
| `close()` 语义 | **只关下拉**：`boot.ts` 会话切换调 `close()`，侧栏模式 no-op——否则刚恢复的侧栏会被 boot 的 close 关掉 |
| 点击外部 | 只关下拉；侧栏是常驻面板，在 transcript 里点来点去不关 |
| 调宽 | `#outlineResize` pointer 事件：`width = clamp(start - dx, 180, area*0.5)`（拖左变宽）；`pointerup` 持久化 + `NS.rail.reflow()`（`#messages` 变窄改折行 → 左 rail 圆点重对齐） |
| 图标着色 | `NS.icons.icon(kind, 'outline-kind outline-kind-<kind>')`；`.outline-kind-user` 蓝（`--vscode-button-background`）、`.outline-kind-assistant` 灰（`--vscode-descriptionForeground`），与 transcript 气泡同色系 |
| 时间 | 移到每项最右（正文 `flex:1` 占满左侧），`HH:MM:SS` |
| 计数 | `transcriptView.messageAnchorCount()`（user+assistant，O(1)）驱动 ☰ 显隐 |

### 5.10 长会话性能：outbox / 增量文本 / rAF / 滚动记忆（CUSTOM-20260924-022）

**四个病灶**（改之前先确认还在不在）：① 扩展侧每个 chunk 一次 postMessage；② 客户端每次整段重设
`textContent`（累积全文，O(n²)）+ 读 `scrollHeight` 强制重排；③ `refreshSessions()` 每个 chunk 都跑，
于是每片重建整条标签栏；④ 工具分组的整容器 `querySelectorAll` 在每次工具更新时都跑。

| 手段 | 位置 |
|---|---|
| 合帧队列（只合并队尾单条同 id 的 append） | `ChatPanelHost.post()` 按类型路由 → `Outbox` |
| 标签栏快照签名（没变就不发） | `ChatPanelHost.refreshSessions()` |
| 增量文本追加（前缀成立才 `appendData`） | `transcriptView.setStreamingText()` |
| rAF 合帧：滚动跟随 + 工具分组重排 | `dom.schedule` ← `scroll.follow()` / `refreshGroupingSoon()` |
| 每会话滚动记忆（含贴底状态）+ 持久化 | `scroll.remember/restore/reassert/forget` + `boot.applyFocus` |

**INV-A..F（顺序不变式，破了**没有任何自动检查会报错**）**

- **INV-A** 某条 entry 的 `revise` 不得越过创建它的 `append`。客户端 `patch()` 对未知 id 是
  **静默 no-op**（`transcriptView.patch` 的前两行），越过 = 那条更新凭空消失。
  靠 FIFO + 只合并队尾保证。
- **INV-B** `markdownRendered` 同样只能按 FIFO 走，不得被"提前冲刷"。
- **INV-C** `sessionsChanged` 不得延迟/合并——它驱动 Send/Stop 按钮（`boot.syncFocusedState`），
  晚了按钮状态就是错的。它走 `flushThenPost`，且**只在签名变化时**才调（否则会顺带把队列冲掉，
  等于取消合帧）。
- **INV-D** `sessionClosed` 不得延迟。
- **INV-E** 每次 `boot`/`focus` 快照前必须先 `flush()`（`pushBoot`/`pushFocus` 的第一句）。
- **INV-F** **只延后**滚动、大纲 tick、工具分组重排。`hydrate` / `append` / `patch` / `updateTool` /
  `pending` 表 / `requestMarkdown` **一律同步**——`applyFocus` 里 `hydrate()` 之后立刻
  `requestMarkdown()`，一旦延后 `pendingMarkdown()` 就是空的，markdown 整条链静默失效（P0 #1 那个 bug）。

**滚动记忆的两个陷阱**：
1. `hydrate()` 里**不能**留无条件的 `toBottom()`——决策在 `applyFocus`（切走前 `remember`、
   hydrate 后 `restore`），留着会把刚恢复的位置立刻冲掉，表现为"功能做了但没生效"。
2. markdown 回填会改变高度 → `markdownRendered` 后要 `reassert()` 再对齐；
   用户一旦自己滚动就放弃恢复（`expectedTop` 区分程序写入与用户滚动）。

**诊断**：每轮结束打一行 `chat-panel: outbox sent=N merged=M queued=K`。`merged` 占比高 = 合帧在工作。
**043 起这三个数字是「单轮」语义**（`finalizeTurn` 打印后 `resetStats()`）——此前是累计值，
`merged/sent` 会漂向长期均值、那行诊断随时间失去意义。轮末的 `queued` 正常是 0–2（还在飞行中的那一帧），
**跨轮持续偏大**才是"有东西绕过 outbox"的真信号。

### 5.11 左侧引导条（CUSTOM-20260924-023）

**职责与 5.9 不同**：抽屉（§5.9）管「跨轮次回看某句话」，引导条管「这一轮干到哪一步了」。
形态照 Claude Code 官方扩展：轮次大实心点 + 步骤小空心点 + 一条竖线，可点跳转、当前项高亮。

| 关注点 | 规则 |
|---|---|
| DOM 位置 | `#rail`/`#railTrack` 与 `#messages` 同属 **`.messages-column`**（`#messages` 之外）。**不要**放进 `#messages`：那里的三档间距阶梯（`.messages > * + *` 的 `margin-top`）会位移它，它也会被当成一个"条目"参与 flex 排版。**132 起它是该列的绝对定位子元素**（原为 `.message-area` 的兄弟节点）：横向位置全靠 CSS 的 `.rail{left:0}`、JS 只测纵向，所以**锚在哪一层就贴哪条左缘**。137 撤销了消息列的限宽（列恢复满宽，与改动前逐像素一致），搬迁仍然保留 —— 列才是消息内容的定位容器，将来若再限宽也不必重做（见 §5.31）。**别挪回去** |
| 随内容滚动 | track 做 `translateY(-scrollTop)`（同一个 rAF tick 里，且值未变则不写） |
| 布局读取分档 | **`invalidate()`**（条目集合/状态变化）先比标记签名，签名没动就**不读布局**——流式 chunk 走的就是这条；**`reflow()`**（布局变化、resize）只测量不重建。500 个标记全量测 `offsetTop` 是毫秒级的，分档就是为了避开它 |
| **布局变化后重对齐（070）** | **不枚举触发事件，而是观察布局本身**：一个 `ResizeObserver` 观察**每条记录节点**（`watch()`，由 `transcriptView` 在"节点进 `#messages`"与"节点被替换"的**全部 6 处**调用——漏一处 = 那条记录的圆点从此不再动，且完全静默），回调 → `reflow()`。此前只有"标记集变化 / window resize / markdown 回填"三个时机，`<details>` 展开、工具卡正文展开（`links.toggleBody` 改的是 `hidden` 属性，**没有任何事件**）、图片加载完都不在其中 ⇒ 展开后圆点停在旧高度。**回调跳过 `streaming` 的记录**：流式条目每个 chunk 都在长，测量它们会毁掉上面那条"流式期间零布局读取"（streaming 条目的首行不可能移动，圆点本来就对）。**只观察记录节点**，观察 rail/track 自己就是观察自己的输出（回环）。不做 `toggle` 兜底——它只覆盖 `<details>`，是"半个修复且没有信号"（完整教训见 `pitfalls.md` #27）。`reset()` 要 `resetNodes()`：ResizeObserver **强引用**被观察元素 |
| 隐藏面板 | `measure()` 在 `#messages` 高度为 0 时**直接返回并保留 `needMeasure`**：否则每个点都被钉到 `top: 0`、而且这个错误位置会被当成真相缓存下来（后台编辑器组、还没 reveal 的 webview 都会碰上）。恢复可见时 ResizeObserver 会重新报尺寸，测量自然发生 |
| 点尺寸 | 尺寸与左偏移在 CSS（`.rail-dot.turn/.step`），用 `margin-top: -半高` 抵消，**所以 JS 写的 `top` 是圆心**（读 JS 时别以为它是顶边——这一条曾经让"对齐"修错方向） |
| **圆心怎么定（061）** | **锚到条目里的类型图标**：`node.querySelector('.rec-icon, .tool-icon')`，它的几何中心就是要对的中心（`icons.attach()` 本来就把它放在首行上）——**按构造对齐，没有常量、不按类型分支**。此前的 `top = y + 6` 是量出来的常量，而工具卡（3px 内边距）与用户气泡（6px）的首行中心不在一处，**统一偏上 6–9px**。`points[]` 里 `y`（条目顶边，供 `syncActive` 二分）与 `centre`（圆心）**必须分开**；`rail-line` 的两端用 `centre` |
| 命中区（062） | `.rail-dot::after { inset: -5px }` 把可点范围扩到约 17px（`step` 只有 7px），**外观不变**、不参与布局 |
| **当前项指示（062）** | **刻意不用环**：环在这个面板里已经是**键盘焦点**的语义（047 的全局 `:focus-visible`），再用 `--vscode-focusBorder` 画环就是"一个颜色两种意思"。改用**尺寸**：`.rail-dot.active { transform: scale(1.4) }`（scale 以中心为基准，所以不影响上面的圆心对齐） |
| 状态着色 | `running`（工具 `in_progress`/`pending`、文本 `streaming`、待决权限卡）蓝 / `failed` 红 / 其余灰 |
| 工具状态来源 | `transcriptView.updateTool` 会把新 view model 存回 `objects[]`——**`status` 不在 `PATCH_KEYS` 里**，不存回工具跑完了点还是蓝的 |
| 点击穿透 | `.rail` 整体 `pointer-events: none`（别挡住左侧文字选区），只有 `.rail-dot` 是 `auto` |
| `hidden` | `.rail` **不能写 `display`**（pitfall #13，靠文件顶部的 `[hidden]{display:none!important}` 兜底） |

### 5.12 面板审计与阶段 1 修复（CUSTOM-20260925-038..041）

对整套面板（侧边栏 + 编辑区）做过一次系统审计，四面（逻辑 / 性能 / 交互 / 无障碍）都有实质发现。
**038-041 只落地了「正确性」这一档**，性能与交互档的做法见下方"待办"，别当成已经安全。

**四条已落地的规则（改动时不要破坏）**

1. **`EntryPatch` 的键名 = 记录字段名，逐字相同**（`entries` / `blocks`，见 `transcript/types.ts`）。
   曾经的 `plan` / `content` 与记录层的 `entries` / `blocks` 错位，客户端 `PATCH_KEYS` 抄了协议层的
   名字 ⇒ patch 写进 `entry.plan`、渲染读 `entry.entries`，**更新静默丢弃**（`patch()` 对未知键不报错）。
   表现是 plan 卡永远停在第一次快照、切走再切回才对。**编译器看不见这类错位**（pitfall #18）。
2. **`resource_link` 的点击通道在宿主侧决定**：`contentBlocks.localPathOf(uri)` 判本地文件 → 填 `path`
   → 客户端写 `data-path`（走 `openFile`，相对路径按会话 cwd 解析）；http/https/mailto → `data-href`；
   **两者都不是 → 静态 chip**（不得长成可点的样子，否则点一次吃一个 `Blocked link` 警告）。
   注意 Windows 盘符（`C:\x`）符合 URI scheme 语法，**必须先于 scheme 判定**。
3. **工具卡的 body 只有一个构建入口 `fillToolBody(body, tool)`**，`render()` 与 `update()` 共用。
   两条路径各写一遍是「locations 时有时无」与「展开的 diff 被下一次更新合上」的共同根因
   （pitfall #15 的第二次复发）。重建前 `captureExpansion` / 重建后 `applyExpansion`，按
   `data-expand-key` 搬运展开态。`bodySignature` 命中则连重建都跳过；签名**刻意不序列化 payload**，
   遇 image block 返回 `null`（不可缓存 → 无条件重建），宁可多建一次也不冒陈旧渲染的风险。
4. **`ChatPanelHost.dispose()` 必须注销 `SessionUpdateHandler` 监听器**（对照
   `ChatWebviewProvider.ts` 的同名方法）。此前只是碰巧被 `SessionUpdateHandler.dispose()` 兜住。
   `Outbox.stats()` 是**单轮**语义（`finalizeTurn` 打印后 `resetStats()`）——累计会让 `merged/sent`
   漂向长期均值，那行诊断就失去意义。

**两条不变式（破了不会有自动检查报错）**

- **INV-G 替换型 patch 的键名不得改名。** 改 `EntryPatch` 或 `PATCH_KEYS` 任一侧，必须 `grep` 出全部
  消费点对照：`transcript/types.ts` ↔ `TranscriptStore.patch` ↔ `ChatPanelHost` 的调用点 ↔
  客户端 `PATCH_KEYS`。**四处**，少一处就是静默失效。
- **INV-H 工具卡 body 的字段覆盖要跟着渲染函数走。** `bodySignature` 必须涵盖渲染函数读的**每一个**
  字段；漏一个 ⇒ 该字段变化时签名不变 ⇒ **卡片永久陈旧**。加字段到 `renderContentItem` 时，
  同步加进签名（image 例外：它返回 `null` 走无条件重建）。

**审计查到的其余问题（阶段 1 时"查到但未修"；阶段 2-4 的 043-052 已全部落地，见下）**

| 档 | 问题 | 位置 |
|---|---|---|
| 性能 | **嵌套推断在每次 `tool_call_update` 全量重算**，且每个候选 `JSON.stringify` 父输出（上限 200KB） | `ChatPanelHost.onSessionUpdate` 的 `tool_call_update` 分支 + `ClaudeCodeNesting.payloadContains` |
| 性能 | `toolCallView.update` 末尾**同步**跑 `refreshGrouping` 的 `querySelectorAll`，绕过 022 的 rAF 合帧 | 对照 `transcriptView.refreshGroupingSoon` |
| 性能 | `outline.invalidate()` 每个 append/revise 至少走一遍全量锚点扫描（rail 已用签名降到 O(1)，抽屉没做） | `html/client/outline.ts` |
| 性能 | **TEMP 诊断常驻**：每次新增条目后 4 秒全量 `getBoundingClientRect` 走查（白条根因已在 037 修掉） | `html/client/transcriptView.ts` 的 `checkTextless` 整块 |
| 交互 | **键盘完全不可达**：标签 / 抽屉行 / 菜单项 / 斜杠项 / chip / 卡头都是 div+click，无 `tabindex` | 各 client 模块 |
| 交互 | 无 `aria-selected`（标签已有 `role=tab`）、无 `aria-live`（流式不播报）；`composer.focusInput()` 写了从未被调用 | `tabs.ts` / `body.ts` / `composer.ts` |
| 交互 | **webview 内零拖拽/粘贴处理**，附件只能走命令与资源管理器右键 | 全量 grep 为空 |
| 界面 | `SafeMarkdown.code` 已输出 `data-lang`，界面完全没用（无语言标签） | `markdown.ts` 产出，无消费 |
| 界面 | 编辑区面仍用 `--vscode-sideBar-background`（`body` / `.composer` / `.load-overlay`），与周围编辑器底色不一致 | `styles.ts` |
| 登记 | `.tab-dot.attention` 是**从未被任何 JS 使用**的死 CSS（像没接完的功能），用户已决定不加功能 | `styles.ts` |
| 登记 | 无 sessionId 的 `error` notice 只进当前 DOM、不进 store，切走再切回消失（**注释已声明是刻意的**） | `boot.ts` 的 `error` 分支 |

**阶段 2-4 的落地结果（CUSTOM-20260925-043..052）**

| # | 做了什么 | 关键约束（改动时别破） |
|---|---|---|
| 043 | 嵌套推断去重复序列化；`ToolInvocationStore.list()` 去掉无谓排序 | 两个缓存都**按对象引用**失效（`upsert*` 整体替换字段，引用变化即失效信号）。**不要给工具索引加 LRU 上限**——`snapshotOf` 靠它补水视图模型，淘汰会渲染出 027 消灭掉的空壳卡（理由写在类注释里） |
| 044 | 工具路径并入 rAF 合帧；`bodySignature` 用**哈希**而非长度 | **INV-H 加强**：长度不是变化信号（同长度改写会永久陈旧）。指纹化不可便宜完成时返回 `null` → 无条件重建，语义永不退化 |
| 045 | 抽屉"要不要显示 ☰"降到 O(1) | `place()` 是唯一的新增入口（`patch` 从不改 `kind`），计数器才不会漂 |
| 046 | 删掉 TEMP 诊断（约 98 行） | 白条根因在 037 的 `.messages > * { flex: 0 0 auto }`。**复发时先量高度**（036 的教训），需要时再按显式开关装轻量版，别让它常驻 |
| 047 | 键盘可达性：真 `<button>` + `:focus-visible` + roving tabindex | 委托式 click 覆盖了键盘（**Enter/Space 由浏览器原生触发 click**）——所以**不要再补一套 keydown 分支**，两套会漂。按钮样式重置块**必须放在各 class 规则之前** |
| 048 | `aria-busy` 驱动流式播报 | 计数器由 `place()` / `patch()` 的 `wasStreaming` 对比维护；`lastBusy` 守卫避免每片写 DOM |
| 049 | 附件拖拽（`attachPath`）；粘贴图片明确提示暂不支持 | 消息**会话作用域**，在守卫**之后**处理。拖拽路径**不 reveal surface**（拖拽本就在可见面上）。取不到路径必须报出来 |
| 050 | 草稿按会话记忆；编辑区面用编辑器底色；`prefers-reduced-motion` | `stashDraft()` **必须在 `state.sessionId` 改写之前**调用。CSS 里**只有** `.surface-editor` 的覆盖规则——侧边栏面不能加 |
| 051 | 代码块语言标签 | 标签在左上角（右上角归 Copy），`pointer-events: none`；只有带语言的块才让出顶部内边距。**不引入高亮器**（要改 CSP） |
| 052 | 清死代码；两处"刻意保留"写明理由 | `dom.esc` **删除处写了"不要补回来"**——通用转义助手是"用字符串拼 HTML"的邀请函。`statusGlyph` 组与 `.tab-dot.attention` 保留但必须带"为什么在这"的注释 |

**仍刻意不改的（登记在案，别当 bug 修）**

- `.tab-dot.attention`（死 CSS，设计预留）与无 sessionId 的 `error` notice（只进当前 DOM、不进 store）
  ——两者都在代码注释与 `pitfalls.md` #20 里写明了理由。
- `sanitize()` 放行整个 `data-*` 家族，而点击委托信任其中几个属性 —— 当前不可利用
  （`SafeMarkdown.html()` 把原始 HTML 转义成文本，无注入路径），但作为"将来 marked 新增钩子"的
  兜底时形同虚设。见 `pitfalls.md` #21。
- `'Claude Code'` 字面量分散在 4 处（语义各不相同）——见 `pitfalls.md` #19 的处置原则：
  跨宿主/客户端或跨语义的重复，要么注释互指，要么让一侧成为唯一真源（走协议下发）。

**其他值得知道的风险**

- `'Claude Code'` 这个字面量出现在 **4 个语义不同的地方**：`panelContract.MODERN_AGENTS`（面板路由）、
  `NestingStrategy.resolveNestingStrategy`（嵌套策略）、`stateCard.ts` 的空态文案（客户端硬编码，123 从 `sessionMenu.ts`/`boot.ts` 收拢到这里）、
  `AgentConfig.getAgentNames`（排序）。新增第二个 modern agent 时要同改四处。
- `sanitize()` 的 `ATTR_ALLOWLIST` **放行全部 `data-*`**，而点击委托偏偏信任 `data-href` / `data-path` /
  `data-terminal`——这层兜底实际没约束住它最该约束的几个属性。当前不可利用（`SafeMarkdown.html()`
  把原始 HTML 转义成文本，没有注入路径），但将来若 marked 新增没人覆盖的钩子，这层就形同虚设。



### 5.25 置顶本轮提问（CUSTOM-20260928-102，103 收紧判据并修正排版，104 改成吸顶交棒 + 悬浮卡片 + 收缩，105 对齐/高亮边框/用户消息铺满）

**一句话**：**顶边到达视口顶**的那条用户消息就是"本轮提问"，它被 `cloneNode(true)` 到
`#stickyUser` 的悬浮卡片里、本体让位；**只要视口里看得到更晚的用户消息就不置顶**。

| 关注点 | 规则 |
|---|---|
| 判据（104 的核心） | `node.offsetTop - scrollTop < TOP_GAP`（严格）⇒ 候选，取最后一个；第一条**没进这个窗口**的：在视口里 ⇒ 不置顶，在视口下方 ⇒ 结束遍历返回候选。103 的"完全离开视口"已被它取代 |
| **为什么能这么早** | 副本落在**本体当时所在的位置**上（窗口就是 `TOP_GAP`，那 8px 同时是卡片的 padding-top），交棒那一帧画面上没有位移。所以"同屏两份"（102/103 等的理由）不再靠"等它走光"解决，而靠**隐藏本体** |
| 隐藏本体 | `.messages .sticky-source { visibility: hidden }`。**visibility 不是 display**：几何必须保住 —— rail 的逐节点测量、`NS.scroll.jumpTo` 的 `node.offsetTop` 都还依赖它。**前缀 `.messages` 是承重的**：`cloneNode` 连 `class` 一起复制，去掉前缀，副本也会被藏起来（悬浮条"打不开了"，静默）；`render()` 另有一道同因防线（显式摘类）。`markSource()` 每帧幂等重贴（一次引用比较）；user 条目节点不会被 `replaceChild` 换掉（那条路径只走 plan/content/tool），但仍留了这一层，因为漏掉的代价是"本体和副本同屏"这种静默的错 |
| 代价（写在这里免得被当成 bug） | 悬浮条会**长时间盖住下方内容**，而且"消息滚走"在视觉上不再发生——它变成"消息停住、下方内容从它下面流过"。收缩按钮与 `max-height: 40%` 是两个出口 |
| 为什么**没有阈值** | 用户选定"露出一像素就算在显示区"。单一阈值 ⇒ 同一画面从不同方向到达结果相同、不会闪；"露出超过 X 才不置顶"是量出来的常量，换面板高度/字号就错位（pitfalls #24/#26）。102 的 8px 容差已在 103 去掉 |
| 为什么不用**滚动方向** | 判据只依赖当前画面。记住方向会让同一画面从不同来向显示不同结果 |
| 横向范围 | `#stickyUser` 与 `#messages` 同属 **`.messages-column`**（103 新增的定位容器）。102 时它是 `.message-area` 那一 flex 行的兄弟，而该行还有**定宽可拖拽**的大纲栏 ⇒ 覆盖层横跨两段、右边伸进大纲栏下面。挪进容器后由**构造**保证不越界。该列 132 一度限过宽、**137 已撤销**（见 §5.31）：sticky 是列的绝对定位子元素，宽度始终跟着列走；`alignToContent()` 量的仍是滚动条宽（`offsetWidth − clientWidth`，与列宽无关），照旧成立。`#jumpToLatest` 也在 132 搬进了该列 |
| 三层结构（104） | `.sticky-user`＝定位层（透明、`pointer-events:none`，卡片周围的内容与点击都透过去）→ `.sticky-card`＝外观层（底色/圆角/**1px 高亮边框**/阴影）→ `.sticky-body`＝克隆体的 flex 列（`align-self` 必需） |
| 对齐（105，用户报"还是没对齐"） | 卡片右缘要让开**滚动条**：`.messages` 是滚动容器，`scrollbar-width: thin` 照样占布局宽度 ⇒ 消息的内容盒比消息列窄几像素，而悬浮条不是滚动容器。`sync()` 里用 `offsetWidth - clientWidth` 量出来写进 host 的 `right`（没有滚动条就是 0）。**别换成常量**——它随滚动条出现/消失、随主题与字号变（pitfall #24 的反面：锚真实几何） |
| 边框为什么是 border | 高亮边框是真 `border`（1px `--vscode-focusBorder`，本面板「当前项」的既有语义，同 `.outline-item.active` / `.filter-chip.on`），host 水平内边距相应由 19/10 改成 **18/9** 把这 1px 还给内容盒。**不能用环**：环在这个面板里已经是键盘焦点（062 的教训）。也别改回 `box-shadow` 环——104 用它只是为了避开布局位移，有了 padding 补偿就不必了 |
| 用户消息铺满（105） | `.entry-user { align-self: stretch }`（原 `flex-end` + `max-width:88%`）。气泡宽度=内容宽度时，折叠后只剩首行、宽度随之缩短，面板在折/展时会自己变窄；铺满后宽度是常量，折与不折只影响高度。这**同时决定**了卡片里有没有空档给按钮 |
| 排版一致性 | 用户气泡的宽度=卡片的内容盒宽度，而卡片的内容盒由"`.messages` 的内边距 + 105 的 1px 边框补偿 + 105 的滚动条让位"三者共同决定；水平内边距必须与 `.messages` 相同（左 19 / 右 10），否则克隆体会整体偏移。103 修的是 flex 基准，105 修的是这层横向几何 |
| 排版一致性 | 用户气泡的右对齐与 88% 宽度来自 `.entry-user{align-self:flex-end; max-width:88%}`，而 **`align-self` 只在 flex 容器里生效**；水平内边距也必须与 `.messages` 相同（左 19 / 右 10），否则 88% 落在两个不同的基数上。103 修的就是这两条 |
| `TOP_GAP` 只有一个来源 | 它既是布局（JS 写进 host 的 inline `padding-top`）又是交棒窗口。两者必须相等，否则每次交棒都带一段位移 ⇒ 由 JS 写，CSS 不写 padding-top（pitfall #19） |
| 收缩按钮 | `#stickyToggle` 是**卡片的兄弟**，钉在卡片左侧那条 18px 通道里（`.messages` 给引导条留的 padding-left）。105 之前它嵌在卡片左上角——消息铺满后那里没有空档了，放里面会压住正文。`.collapsed` 收成一行：多行气泡本就是 `details.user-fold`，`summary` 即第一行；**只在克隆体含 `.fold-body` 时显示**（"后面还有东西"才是可收缩的；113 起每条用户消息都是 `details.user-fold`，所以按 `.user-fold` 判断会变成"每条都配一个没反应的按钮"，而单行气泡配个没反应的按钮更糟）。它的点击必须 `stopPropagation`——宿主的点击是"跳回原处" |
| 点击交还 | `NS.scroll.jumpTo(node, TOP_GAP + 1)`：落在**窗口之外**，否则消息立刻又被条接管、点击看起来"没反应"。该形参默认 0，既有调用点一行未改 |
| 渲染状态 | 克隆体不在 `#messages` 里，`.messages.show-times` 这类**状态类选择器够不着它** ⇒ `render()` 把 `show-times` 抄到 host，`boot.applyTimes` 之后调 `NS.stickyUser.refresh()` 重渲染。**再加新的"挂在 `#messages` 上的渲染开关"时，别忘了这里也要抄一份** |
| 成本 | 克隆一个 markdown 气泡是这面板最贵的事之一 ⇒ `shownId` 去抖（只有"钉住的是哪一条"变化才重建）+ 滚动只标记、`NS.dom.schedule` 一帧一次。`refresh()` 故意绕过去抖，因为它服务的是**用户手动开关**，不是滚动 |
| 维护提示 | 判据依赖 `node.offsetTop` 与 `#messages` 的 `scrollTop` **在同一坐标系**。当前靠"节点与 `#messages` 同处 `.messages-column`"成立——**给 `#messages` 或那条链上新加带 `position` 的祖先时要重新核对**（`NS.scroll.jumpTo` 的 `node.offsetTop - container.offsetTop` 是同一个前提） |

案例钉在 `src/test/chat-client.test.ts`「image chip and pinned question」一组的 11 条用例里。
**桩要如实建模两件事**，否则这几条会假通过/假失败：`#stickyUser > (#stickyToggle, .sticky-card > #stickyBody)`
的嵌套，以及 `#messages` 的 `padding-top`（首条记录在 `offsetTop = 8`，正是"停在最上面的提问不被接管"
那条的判据）。做过四次 RED 验证，每次失败的都正好是应该失败的那几条：退回 103 的判据 ⇒"顶边一到就接管"红；
`markSource` 改空实现 ⇒ 断言 `sticky-source` 的两条红；去掉 `render()` 里摘类那一行 ⇒"重渲染不得把隐藏类
克隆进条里"红；去掉 `alignToContent()` ⇒"the bar ends where the messages end"红。

### 5.13–5.15 已拆出：会话目录与重开路径

> **§5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）、
> §5.24（历史选择器的目录过滤）**
> 已移到 **[`chat-panel-sessions.md`](./chat-panel-sessions.md)**（CUSTOM-20260925-060、079）。
>
> **为什么是这三节一起走**：它们是同一个主题的三面——**会话生命周期**。
> 建会话时选目录（5.15）、已存在会话的目录从哪来（5.14）、重开会话那条 replay 链怎么测（5.13），
> 共享同一个前提：**cwd 是会话级属性、且由协议固定在创建时**。
>
> **§5.x 的编号原样保留**，所以各处引用只需换文件名，不必重编号（理由同 042）。
>
> 本文件保留的是**面板本体**：文件职责（§5.1）、客户端三条纪律（§5.2）、在途状态（§5.3）、
> 消息纪律（§5.4）、安全约定（§5.5）、子 agent 分组推断（§5.6）、双 surface（§5.7）、
> 权限卡（§5.8）、会话大纲（§5.9）、长会话性能与 INV-A..F（§5.10）、引导条（§5.11）、
> 面板审计结论表（§5.12）。

> **记录区（§5.16 起）另见 [`chat-panel-records.md`](./chat-panel-records.md)**：折叠与 INV-J、
> 每条记录的时间显示、工具输出的 markdown 渲染、思考块的 markdown（§5.21）、切换模型/模式的提示（§5.22）、
> 自定义右键菜单、以及客户端逻辑测试的边界。
>
> **编号不连续是正常的**：`§5.24` 在 sessions 文件、`§5.16–§5.23` 在 records 文件、
> `§5.25`（置顶最近一条用户消息）在本文件——章节号是**稳定的引用地址**，不是阅读顺序。

### 5.27 表单：ACP elicitation / AskUserQuestion（CUSTOM-20260929-119，152 改悬浮抽屉）

**为什么需要它**：AskUserQuestion 在 ACP 里走 **elicitation（form 模式）**协议，而 adapter 用
`clientCapabilities.elicitation.form` 门控——**不声明时连工具本身都被禁用**
（`disallowedTools = ["AskUserQuestion"]`）。所以"官方插件会弹选项面板、我们的面板只有一个卡住的工具卡"
不是渲染问题，是**能力声明缺失**。

**[152] 呈现方式**：记录里只留一行"待回答"条，表单本体在**悬浮抽屉**里（底部、贴着输入卡上方、
与它同宽同中线），多道题按 tab 分页 —— 用户 2026-09-30 报"表单以消息卡片的形式出现"，而问题多、
选项带长介绍时那张卡会把记录区撑得很长，且混在消息里不像"现在需要你操作"。细节见 §5.33。

| 关注点 | 规则 |
|---|---|
| 谁能弹 | `canPresent` 与权限卡**共用同一套判据**（聚焦会话 + modern agent + 至少一个 surface，不可见则 `reveal` 不抢焦点） |
| 通道 | `AcpClientImpl.unstable_createElicitation` → `ElicitationHandler`（策略+弹框兜底）→ `ElicitationBridge`（**与 `PermissionBridge` 同构**：FIFO / `resolved` 幂等位 / `settleWith` 单点 resolve / `cancelSession`·`cancelAll`·`onPresenterLost`） |
| 三态 | `accept`（带 content）/ `decline`（**跳过**：空答案，轮次继续）/ `cancel`（中止工具调用）。adapter 的 `applyAskElicitationResponse` 就是这么解释的；**轮次被取消时回 cancel 而不是 decline**——空答案会骗到 agent |
| 作用域 | **只支持 `sessionId`**：ACP 还允许把表单挂在 `requestId` 上（与任何会话无关），那种没有会话可归属 ⇒ 直接 `cancel`，并记日志说明 |
| 字段扁平化 | `fieldsOf(requestedSchema)` → `select`(oneOf) / `multi`(array+anyOf) / `boolean` / `number` / `text`。**认不出的形状不进表单**（省略字段是合法答案——schema 里没有任何 required；猜一个比不填更糟）。`_meta._askUserQuestionCustomAnswer` 标记的自由文本框会带上 `customFor`，客户端据此把它排进对应问题（§5.33）。**[153] 标记缺失时按名字兜底**：实测 2026-10-01 的真机请求里 adapter **不再发** `_meta`（只有 `title: 'Other'` + 一句 description），只认标记会让那个框变成**独立的一题**（多出一个 "Other" 标签页、问题块里看不到自拟输入框）⇒ 现在额外认 `<某字段>_custom` 这个名字约定，且**父字段必须存在**；误判面很窄，真误判也只是排到那道题下面（提交时的字段名与取值不变） |
| 记录与回传 | 新记录类型 `kind: 'elicitation'`（`TranscriptStore.appendElicitation`，一个 promptId 一条，同权限卡）+ 客户端 `elicitationView.ts`；回答走 `elicitationAnswer` 消息（**会话作用域，必须放在 `verifySession` 守卫之后**）。**表单记录是 transcript 的记录 ⇒ boot/focus 的全量快照天然把它带回来**，切会话/双 surface/重挂载都不需要新机制；抽屉**不是**真相，它每次都由记录重新算出来 |
| 半填的草稿 | **只留在 webview 里**（DOM 就是表单状态），不进 transcript——否则每次 revise/快照都会把草稿重发一遍。结算态（accepted/declined/cancelled + summary）才由宿主写进记录。152 的抽屉因此**不重建已渲染的表单**（按 promptId 缓存元素），切 tab / 收起 / 重绘 chrome 都不碰输入控件 |
| 兜底弹框 | 无面板时**逐字段**问（VS Code 没有表单对话框）：select/multi → QuickPick、boolean → Yes/No、文本/数字 → InputBox。**取消某一步 = decline（跳过）**；面板里的 Cancel 才是硬中止 |
| **重开别人的会话不会重抛（实测）** | `session/load` 一个"卡在提问上"的会话时，adapter **只回放工具卡**、不会重新发 elicitation（`probe-elicitation.mjs --no-answer` 造出该状态再 `--reopen` 实测：0 次）。官方插件能弹是因为**那个未决请求在它自己的进程里**；我们重开时是另一个进程，替它回答不了。详见 pitfalls #32 |

### 5.28 连接状态卡与自动连接（CUSTOM-20260930-123..126）

**它修的是什么**：点 Connect 之后面板立刻切到草稿页，而真正的 spawn + initialize（首次 `npx` 可能下载几分钟）
**在界面上完全不可见**；而草稿页中央是空的（`focusDraft` 调 `showEmpty(false)`）。结果是用户反复点按钮，
连上之后又只看到一片空白。现在这一层是三态卡片（`html/client/stateCard.ts`）。

| 关注点 | 规则 |
|---|---|
| 三态 | `phase = connecting ? 'connecting' : (connected ? 'ready' : 'disconnected')`。`connected` 有**两个来源**（`boot`/`focus`/`sessionsChanged` 的 `agentConnected` 说的是"进程还活着/已死"，`connection{state:'connected'}` 说的是"刚连上"），`connecting` 也有两个（本地点击、宿主广播）。 |
| **`connection` 必须无条件回话** | `refreshSessions` 靠签名去重（`conn:` 位），而 `ensureConnected` 在进程已起时**不发任何事件** ⇒「已连接 + 无会话 + 点 Connect」这条路上宿主原本一句话都不会说，客户端的"连接中"会**永久卡死**（pitfalls #29 的形态：效果上没变化 ≠ 可以不回话）。三种出口（无 agent / 成功 / 失败）各发一次。 |
| 顺序是承重的 | `handleConnectAgent` 里 `focusSession(newest)` 必须排在 `connection{connected}` **之前**——客户端靠这个顺序决定开不开草稿，反了会在刚打开的会话旁边多出一张空标签。`connection` 因此也进了 `STRUCTURAL_MESSAGE_TYPES`（排进合帧队列就可能反过来）。 |
| 谁写 `display` | **仍然只有 `boot.showEmpty()`**。卡片模块只写内容（textContent / checked / disabled / 子节点 hidden）。卡片是 `role="status"`，所以文本**先比较再写**——每写一次读屏就播报一次。 |
| 草稿的时机 | 点 Connect **不再立即开草稿**。`handleConnectAgent` 成功后：**有会话就聚焦最新的那条**，**没有会话就建一个**（131，用户在三方案里选的）。"未连接时输入框禁用"因此自然成立——`composer.ts` 的 `canCompose()` 一个字节没改。**为什么无会话时是"建会话"而不是"开草稿"**：草稿页**永远**做不到"和正常会话一样"——图片要挂在会话上，模式/模型选择器来自 `session/new` 的响应，没有会话就没有（`composer.setDraft` 的注释里写着这条）。代价：连上后不说话就离开会在 agent 历史里留一条空会话（`session/close` 不删历史，058）。 |
| 相位也是面板级的 | `stateCard.render()` 把相位写到 `body[data-phase]`，header 上的 `Times` 按钮据此隐藏（129 之前它在未连接时也显示）。写在 body 上而不是让每个按钮各自监听：少三处同步，而且**本地点击发起的 `connecting` 也覆盖到了**（那条路径不经过宿主）。 |
| `stickyUser` 的残留 | `showEmpty(true)` 里补 `NS.stickyUser.reset()`：置顶卡片是 `.messages-column` 的绝对定位子元素，`transcriptView.reset()` 清不掉它，而卡片没有背景 ⇒ 草稿页会让上一个会话的置顶卡**透出来**。 |
| 无会话的失败 | `case 'error'` 与 `draftFailed` 原先往空 transcript 里 append 通知并 `showEmpty(false)`（卡片被藏起来、中央只剩一行孤零零的报错），现在写进卡片的 `.state-error`。 |
| 自动连接的前提 | `autoConnect && !agentConnected && !focused`，**延迟 1s**（131 从 500ms 上调：面板刚渲染完就连接，用户还没看清卡片上写着什么）。布防**幂等**（boot 会在同一个文档上投递两次），触发时**再复查一遍**（这一秒里可能已经连上、或用户已经在别的草稿页上打字——判据用 `composer.isComposable()` 这个**直接信号**，不用代理信号）。 |
| 不谎报失败 | 45s 没回话**不报错**：`ensureConnected` 本身没有超时，首次 `npx` 下载可以几分钟。只把按钮放开（允许重试）并说明原因——谎报失败比慢更糟。 |
| 设置的读写 | `acpc.autoConnectOnOpen` 经 `PanelPrefsIO` 注入缝读写（默认实现才碰 `vscode.workspace`；测试给桩，**不碰真实 settings.json**）。**写失败时广播的是设置真值而不是请求值**，否则复选框会显示一个 settings.json 里没有的值。宿主只在这一个 key 上挂了 `onDidChangeConfiguration`——面板把这个配置项**渲染成了控件**，控件显示过期值就是在撒谎。 |
| 开关什么时候在 | 只在**未连接 / 连接中**显示。连上之后卡片是"去下面打字"的路标，不是一个设置表单——开关管的是"下次打开这个面板"（127，用户复验提出）；**连接中仍然保留**，那恰恰是最想关掉它的时刻。隐藏的是整行 `#autoConnectRow` 而不是那个 `<input>`，否则标签文字会留在原地。 |
| 居中与溢出 | `#emptyState` 用「容器 `flex-start` + 卡片 `margin: auto`」而不是 `justify-content: center`（内容一超高，center 会把顶部裁掉且**滚不到**，pitfall #17 同族）；卡片**不写 `overflow`**（会在 flex 列里被压扁），写 `width: 100%`（否则取 fit-content，窄侧边栏里的行为就只能靠推断，见 pitfalls #31）。实测入口：`preview-records.mjs` 的 `#empty` / `#connecting` / `#ready` / `#narrow`，几何靠 `#probe` + `chrome --dump-dom` 读回来。 |

### 5.29 记录时刻的位置与上下文用量（CUSTOM-20260930-129）

用户在复验 123 时提的三条界面调整。

| 关注点 | 规则 |
|---|---|
| 时刻挂在**标题行**里 | `.rec-time` 绝对定位浮在记录右上角，但**DOM 上必须位于标题行之内**（工具卡是 `.tool-head` 的一项，其余进 `summary`）——折叠的 `details` 会隐藏 summary 之外的一切，挂在记录节点上的话折叠态就看不到时刻了。`.messages > *` 因此要有 `position: relative`。工具卡用 `appendChild`（跟在耗时之后 ⇒ `2.2s 11:57`），其余用 `insertBefore(…, summary.firstChild)`（绝对定位下 DOM 顺序无关，这样能保住"正文是 summary 最后一个子节点"这条既有约束） |
| 顶部进度条已删除 | `#usageBar` / `tabs.renderUsage` / `.usage-bar` `.usage-track` `.usage-fill` 全部删掉；**成本**信息移进底部圆环的 tooltip。上下文用量现在只有一处呈现 |
| 底部圆环 | 24px 的两圈 SVG。内圈 = 进度（`stroke-dashoffset` 由 JS 按百分比算好，`rotate(-90deg)` 把起点挪到 12 点方向），圆心 = 百分比数字（不带 `%`），配色沿用 0.7 / 0.9 两档。**外圈 = "有轮次在跑"**：一段 1/4 弧缓慢旋转，用 `currentColor`（**不是**进度的蓝色——同色会被读成两根进度条），半径比内圈大 2.5（只差 1.5 时两环贴在一起，读不出是"外圈"）。数据仍是 `meta.usage`；`setRunning` 是外圈的唯一开关，而那条路径拿不到 `meta`，所以 composer 自己留了一份 `lastUsage` |
| 视觉验收 | `preview-records.mjs` 的 `#times` / `#timescollapsed` / `#gauge`（外加 `#gaugewarn` / `#gaugehot` / `#gaugebusy` / `#gaugebig`）。**圆环的配色与外圈半径都是看图才改对的**——布局与观感不靠推（pitfall #31） |

### 5.30 标签状态点：颜色说状态，外圈说"正在做事"（CUSTOM-20260930-130）

**分工**（用户指定）：圆点的**颜色**表达这个会话处在什么状态，圆点外的**涟漪圈**表达"它正在做事"。
两者必须独立 —— 一个卡在权限提示上的轮次两件事同时为真（在跑 **+** 在等人），挤进同一个信号就必然丢掉一件。

| 状态 | 颜色 | 外圈 |
|---|---|---|
| 等人回答（权限 / 表单） | 橙 `--vscode-charts-orange` | 有（轮次通常还在跑） |
| 轮次在跑 | 蓝 `--vscode-progressBar-background` | 有 |
| 载入历史（replay） | 黄 `--vscode-charts-yellow` | 有 |
| 后台有新输出（unread） | 蓝 `--vscode-charts-blue` | 无 —— 它是关于**过去**的提示，不是当下的活动 |
| 平常 | 灰 `--vscode-descriptionForeground` | 无 |

- **数据**：`waiting` 从两个桥的 `hasPendingFor(sessionId)` 读 —— **桥才是 pending 的唯一持有者**，
  宿主不存第二份（pitfalls #19）。
- **必须计入 `refreshSessions` 的签名**：数据变了而签名没变 ⇒ 标签栏永远不刷新。这条在 022（unread）
  与 063 上各踩过一次，警告就写在签名旁边。
- **样式**：颜色走 `color` + `background: currentColor`，外圈的 `border-color` 用同一个 `currentColor` ——
  颜色只有一个来源，改一处就够。
- 另：就绪卡的标题是 **`Claude Code is ready`** 而不是 `Connected to Claude Code` —— 后者与
  `Connect to Claude Code` 只差一个字母，扫读时会被读成"还需要连接"。

### 5.31 底部栏：悬浮输入卡 + 预留功能区（CUSTOM-20260930-132..139）

**症状**：面板一拉开，底部输入框横向铺满整个 webview（一行文字横跨 1400px+），发送按钮离正文很远、不好点。

**先撤销了一半**：132 曾把**消息列与输入区一起**限到 820px 居中；137 按用户要求撤销了**消息列**的限宽（消息要平铺开、读得更宽），只保留底部这一块限宽 —— 两件事的目标本来就不同：消息区要宽，输入条要短。

| 主题 | 结论 |
|---|---|
| 底部栏结构（138） | `.composer` 是**两列** flex：`.composer-main`（输入卡）+ `.composer-aside`（预留功能区）。用两列而不是"给左边补一段 padding"的算法，是因为主列宽度天然等于"面板宽 − 预留区宽"，**输入卡的中线与消息列的中线自动重合** —— 少维护一个等式（pitfall #24） |
| 输入卡宽度（137） | `--acpc-composer-max: 720px`，定义在 `body` 上（输入区是它的后代；`.composer` **不是** `.message-area` 的后代，挂那边够不着）。窄面板自动退化成满宽 |
| 为什么不用 media / container query | 它们键的是**窗口**（或另一个容器），而这里取决于**面板**宽度 —— 正是 pitfalls #25/#26 说的代理信号。`max-width` 自带退化：窄面板下没有余量可分 |
| 竖线（138） | `.composer-aside` 的 `border-left` 就是用户要的那根线。它的宽度取自 `--acpc-aside-w`（由 `outline.ts` 的 `applyReserve()` 写入 = 大纲栏宽度，默认 240）⇒ 与**钉住的大纲栏左边界**落在同一条竖线上。两个宽度**同源**，不是对齐到一个常量（pitfall #19） |
| `.composer` 的左右 padding 必须为 0（138） | 右侧任何 padding 都会让竖线比大纲栏左边界靠左同样的像素数（实测差 8px 就是这么来的）。输入卡自己的边距交给 `.composer-main` 的**对称** padding —— 对称 padding 不改变主列中心，所以卡片与消息列的中线仍然重合（实测 `dxCardVsCol = 0`） |
| 真悬浮（139 + 140） | 139 去掉通栏的 `border-top`，改由卡片的描边 + `box-shadow` + 8px 圆角 + 四周留白表达"浮在底部"，但它**仍在文档流里** —— 于是底部这一整条（含卡片两侧那两块空白）都不显示消息，用户报"输入框两侧还是会盖住消息内容"。140 改成**真悬浮**：`.composer` 绝对定位（`body` 因此要 `position: relative`）、**背景透明**（有底色就等于把两侧的消息蒙上一块），消息区占满整个高度、卡片浮在上面 |
| 底部留白（140 + 144） | **一贯存在**：`.messages` 的 `padding-bottom: calc(24px + var(--acpc-composer-h, 0px))` —— 内容永远停在卡片上方、不会被它遮挡（用户明确要求"消息区的触底判断应该保持在输入框上面的位置"）。配套的是 `scroll.ts` 的判据要**减掉这段留白**：用"内容末尾"而不是"可滚动范围的末尾"算 distance，这样"内容末尾进入视口"与"判定为到底"就是同一件事 —— 否则会出现"Jump 还说没到底、下面却已经是空白"的灰色地带（那正是被反复报的那个区间）。⚠️ 中途试过"只在贴底那一刻让位"的条件式（`.pin-bottom` 类）：**方向是错的** —— 未到底的内容会被卡片切断，还要在 scroll.ts 里维护"切类 + 位置补偿"，白白多出三个坑（都实测过，记录见 changelog）。`--acpc-composer-h` 由 `composer.ts` 的 `watchHeight()` 用 ResizeObserver 观察底栏本身写入（pitfall #27）；`#jumpToLatest` 的 `bottom` 用同一个变量补偿。桩 DOM 里 `#composer` / `body.style.setProperty` / `getComputedStyle` 都不存在，三处都判空 |
| 底栏的两条"隐形"规则（144） | ①**编辑区面不能给底栏刷背景**：`.surface-editor .composer { background: editor-background }` 会把这条浮层变成一块**不透明带** —— 输入卡两侧的消息、右侧大纲栏的底部全被它盖住。而这个面正是用户日常用的：预览脚本默认渲染**侧边栏面**，所以这条一直没被照出来（`#…surfaceeditor` 档就是为它加的，探针读 `composerBg`）。②**底栏空区不吞点击**：`.composer` 通栏但 `pointer-events: none`，只有 `.composer-inner`（卡片与它的弹层）是 `auto` —— 否则输入卡两侧、大纲栏底部那块的点击会被它拦下（实测：大纲最后一条的 `elementFromPoint` 命中的是 composer，而不是那条记录） |
| 悬浮后的 z-index | 底栏 `z-index: 8`：高于置顶卡片（6）与引导条（3）；消息内容本身不带 z-index。`.picker-menu`（20）与 `.slash-popup`（30）都在底栏的层叠上下文内，所以它们照样盖住消息区 |
| 默认一行（139） | `autoGrow` 里 60px 的下限已放开，高度就是内容的自然高度；空内容 / JS 未跑时由 `.prompt-input` 的 `min-height: calc(1.4em + 4px)` 保底（与 1.4 的行高同源） |
| 高度上限是两件事 | `autoGrow` 的 320 是**内容**上限；`--acpc-input-max-h: min(320px, 38vh)` 是**视口**上限。两者并存时浏览器取小的那个，所以 JS 不需要知道视口有多高 |
| 预留功能区（138 + 143） | 与输入区并列的第二列，宽度与大纲栏同源。**[143] 只在钉住的大纲栏可见时才占宽度**（`applyReserve` 写 0 或侧栏宽）—— 没有大纲就没有那根竖线，输入卡随之在面板里居中；`width` / `border-left` / `padding-left` 三处都用 `min(…, var(--acpc-aside-w, 0px))`，否则宽度归零时那 1px 边框与 8px padding 仍然占着位置。**里面先空着**：用户要求"留着后面设计好方案再谈怎么用"，138 搬进去的上下文圆环 143 已回到按钮栏。`max-width: 40%` 仍是窄面板下的安全阀 |
| 未连接时不显示底栏（143） | `body[data-phase="disconnected"] .composer, body[data-phase="connecting"] .composer { display: none }` —— 那时输入框本来就是禁用的，露一个"看得见却打不了字"的框只会让人以为它坏了。相位由 `stateCard` 写在 `body[data-phase]` 上（与上面 `Times` 那条同一个机制）。副产品：`display: none` 让 ResizeObserver 把 `--acpc-composer-h` 归零，消息区不再为一条并不存在的底栏留白 |
| 一体式卡片（133） | `.composer-card` 里装 textarea 与 `.composer-bar`；textarea 去边框、透明底。`.input-row` 这层已删（它唯一的子节点就是 textarea，而原 `flex:1` 在 flex **列**里含义完全不同） |
| 卡片不许写 overflow | `.picker-menu` 与 `.slash-popup` 都要向上弹；而且 column flex 上的 overflow 会**压扁子项**而不是让容器滚动（pitfalls #17） |
| 焦点环（134） | 从 textarea 移到卡片（`.composer-card:focus-within { border-color: --vscode-focusBorder }`），只对 `.prompt-input` 抑制 outline。全局 `:focus-visible` 不动 —— **"环 = 键盘焦点"的语义（062）不变** |
| `.slash-popup` 的 left/right | 从 6px 改成 0：定位祖先已从 `.composer` 换成 `.composer-inner`，0 才对得上卡片的边 |
| `#rail` 与 `#jumpToLatest`（132） | 搬进了 `.messages-column`（原为 `.message-area` 的子节点）。它们的横坐标来自 CSS 的 `left:0` / `left:50%`，锚错一层就贴错边。137 撤销列限宽后列恢复满宽、与改动前逐像素一致，搬迁**保留** —— 列才是消息内容的定位容器，将来若再限宽也不必重做。**别挪回 `.message-area`** |
| 消息列的定位意义 | `.messages-column` 不再限宽，但它仍是 `.sticky-user` / `.rail` / `#jumpToLatest` 的定位容器；`alignToContent()` 量的仍是滚动条宽（`offsetWidth − clientWidth`） |

**怎么验收（布局只能量，不能推 —— pitfalls #31）**：`preview-records.mjs` 的 `#composer*` 档**必须显式给宽档**（`shoot()` 的 size 参数）—— 输入卡的限宽在脚本默认的 500 档下不显形。读数输出在 `#composer*probe` 的 `<pre id="probe">` 里，主数字是 **`dxAsideVsOutline`**（预留区左边界 − 大纲栏左边界，138 的核心验收）与 `dxCardVsCol`（输入卡中心 − 消息列中心），配套 `dxRailVsCol` / `dxJumpVsCol` / `inputH` / `slashW` / `cardFocusWithin`；rail 与 jump-latest 平时是 hidden，探针会**临时去掉 hidden 再量**（`display:none` 的 rect 全为 0）。改前 / 改后对比：`--out` 两个目录并排看 `composer-wide.png`（配方写在脚本头部注释里）。

**实测（1440×1000，Chrome 无头）**：钉住 240px 大纲栏时 `dxAsideVsOutline = 0`、`dxCardVsCol = 0`、`dxRailVsCol = 0`、`dxJumpVsCol = 0`、`asideW = 240`、`asideVar = 240px`、`cardW = 720`、`inputH = 27`、`cardRadius = 8px`、`cardOverflow = visible`；未钉住时 `colW = 1424`（消息满宽）、`asideLeft = 1184`；窄档 500 下输入卡随主列收缩且 `dxCardVsCol = 0`；矮窗口 1440×560 下 `inputH` 被 `max-height` 夹在 176.7px。

**[140] 真悬浮**：`#composerbottom` 档（滚到最底）读 `composerPosition = absolute`、`composerBg = rgba(0,0,0,0)`、`messagesPadBottom = 108px`（= 24 + 底栏 84），关键是 **`lastGap = 111 > 底栏高 85`** —— 小于就说明最后一条被卡片压住、而且滚不动。**[141] 目录菜单**：`#historyfilter` 档读 `drawerOverflowY = visible`、`menuH = 260`（= 它自己的 max-height；修好前只露两三行）、`menuBorderColor = rgb(0,120,212)`。**[143]**：`#composerwide`（未钉住）`asideW = 0` 且 `cardCenter = colCenter = 712`（输入卡居中于面板）、`#composeroutline`（钉住）`asideW = 240` 且 `dxAsideVsOutline = 0`、`#phasedisconnected` 档 `composerDisplay = none` 且 `messagesPadBottom` 回落 24px。**[144]**：各档 `messagesPadBottom = 108px`（= 24 + 卡片 84，**一贯存在**），`scroll.ts` 的判据减掉它 ⇒ `#composerjustup`（贴底后上滚 40px）读到 `messagesClasses = messages`（已无切类逻辑，Jump 与留白天然一致）。**编辑区面**（`#…surfaceeditor` 档）：`composerBg = rgba(0, 0, 0, 0)` —— 改之前是 `rgb(31, 31, 31)`，那就是"遮挡"本身。**大纲滚到底**：`topElementAtLastItem` 从 `composer` 让开（底栏空区加了 `pointer-events: none`）。

---

### 5.32 草稿页的输入卡为什么能"完整"（模式/模型/斜杠命令，CUSTOM-20260930-151）

**问题**：点 tab 栏的「+」得到的是草稿页（058），它在 ACP 里**还不是 session** —— 而模式、模型、
可用命令在协议里**全是会话级的**：`NewSessionRequest` 只有 `cwd` / `mcpServers` /
`additionalDirectories`（**没有 mode/model 入参**，已核对 SDK 的 `types.gen.d.ts`），
`availableCommands` 也**只**出现在 `session/update` 的 `available_commands_update` 通知里。
于是草稿页的输入卡长期只有一个 textarea，看起来"没渲染完整"。

**做法**：宿主按 agent 留一份**上一次会话的快照**，草稿页拿它渲染，用户的选择随
`createDraftAndSend` 一起走、在建出会话后逐项校验并应用（"新会话继承上次用的模式/模型"）。

| 主题 | 结论 |
|---|---|
| 数据从哪来 | `ChatPanelHost.rememberAgentOptions(sessionId)` → `Map<agentName, {configOptions, availableCommands}>`，并按 agent 持久化到 `globalState`（`acpc.draftOptions.v1`，照抄 077 的 `uiPrefs` 模式）。**不持久化等于默认路径不生效**：VS Code 重载后宿主内存里的活动会话全没了，"全新窗口点 + 还是空输入卡"正是用户报的现象 |
| 挂在哪些事件上 | `session-created` / `session-load-end` / `config-options-changed` / `available-commands-changed`。**不挂 `pushMeta`**：它在"没有 surface attach"或"不是聚焦会话"时提前 return，后台会话的变化进不了快照 |
| 为什么还要 `session-load-end` | `loadSession` 是"先注册 placeholder → emit `session-created` → 收到响应才写 `configOptions`"，**而且不走 `applyConfigOptions`** ⇒ 只挂 `session-created` 会让"打开一个历史会话"把快照的配置项清空 |
| 为什么**空值不覆盖** | `resumeSession` 的 `availableCommands` 恒为 `[]`（不重放），照单全收会把斜杠命令**擦掉**。空数组在这两条路径上只表示"还没填"，不表示"这个 agent 没有"。代价：可能留着一个陈旧的选项而它应用时会被跳过；收益：快照不会退化（陈旧 ≠ 退化） |
| 隐藏依赖 | `config-options-changed` / `available-commands-changed` 会响，是因为**旧面板**（`ChatWebviewProvider`）的 listener 调用了 `applyConfigOptions` / `applyAvailableCommands`，而它是这两个方法的唯一调用者（新版子系统的斜杠命令本来就靠它）。哪天旧面板改成惰性创建，快照会**静默停止更新** |
| 谁发起请求 | `composer.setDraft()` 自己发 `listDraftOptions`（不是 boot）：要渲染应答的组件才是知道自己缺东西的那个，而且这样能落在 `chat-client.test.ts` 的桩 DOM 覆盖里（`loadClient` **刻意不加载 boot**）。应答由 boot 的消息 switch 转给 `NS.composer.setDraftOptions` |
| 迟到的应答 | 请求与应答都带 `draftId`，`setDraftOptions` 只认**当前聚焦的那个草稿**。`draftSeq` 是每个 webview 独立的，两个面会同时存在 `draft-1` ⇒ 定向与 `draftId` 两道判定都不能省 |
| 选择存在哪 | 存在 **boot 持有的 draft 对象**上（`draft.selections`），composer 只读它 —— 一份副本（pitfall #19）。切走再切回时靠它重放；快照每次聚焦都会重新下发，所以"快照值"永远不许覆盖用户已经选过的值 |
| 草稿态点菜单**不发** `setConfigOption` | 草稿没有 sessionId，那条消息会带 `sessionId: null` 被守卫静默丢弃（§5.4 规则一）—— 用户选了等于没选。改为只改本地副本的 `currentValue`（显示即所得）+ 记进 `selections` |
| 应用时机 | `createSession` → 发 `draftResolved`（保持 058 的不变量）→ 逐项校验后 `await setConfigOption` → 播种切换基线 → `pushMeta` → 首条消息。**在首条消息之前**是重点：第一轮就该跑在用户选的模式/模型上 |
| 三道校验闸门 | ① 按**新会话**的 `configOptions` 校验 id 与取值（`selectValues()`，`sessionChoices.ts` 的纯函数，含分组形态；快照可能来自 agent 旧版本）；② 与当前值相同的跳过（省一次往返，也少一次让 agent 推通知的机会）；③ 单项失败**不阻断**发消息，但**不许静默**（pitfalls #29）：记日志 + 在记录区留一行，否则用户只看到选择器自己弹回默认值 |
| 为什么要播种切换基线 | 应用完 `this.choices.set(sessionId, choiceState(sessionId))`。**不播种反而静默**（`syncChoices` 在 `!previous` 时 return），真正会出噪声的时序是：agent 在应用前先推过一次 `session/update`（`onSessionUpdate` 拿**默认值**当基线），应用后的通知 diff 非空 ⇒ 播出一条用户**从未做过**的切换。这是 pitfall #34 那套"两份副本 + 去重"的既定前提 |
| 不可覆盖的边界 | 全新环境（本进程没开过该 agent 的会话、globalState 也空）仍然只有输入框 —— 没有会话就没有地方问，这是这条路的**固有边界**，不是漏做 |
| 验收 | 桩 DOM：`chat-client.test.ts` 的 `draft composer options` 套件（渲染、迟到的应答、不发 setConfigOption、重试带当前选择、切回不丢）。宿主：`chat-panel.test.ts` 的草稿套件（空也回话、load/resume 两条时序、应用在首条消息之前、陈旧值跳过、失败留痕、应用不播报切换）。布局：`preview-records.mjs` 的 `#composerdraft*` 档（卡片 + 完整底栏） |

### 5.33 表单抽屉：分页 / 下拉 / 收起（CUSTOM-20260930-152）

**一句话**：记录层一行（`⏳ 待回答 · <gist>` + `Open form`），抽屉层一面（`#elicDrawer`）。

| 关注点 | 规则 |
|---|---|
| 层级 | `position: fixed`。**不要**用 `transform` 居中：我们要的规则是"与输入卡**同一个包含块**"（见下），transform 给不了这个。居中规则**必须与输入卡同源**：`left: 0; right: var(--acpc-aside-w, 0px); margin: 0 auto; width: min(100% - 16px, --acpc-composer-max)`。输入卡的中心不是面板中心——`.composer-main` 是"面板宽 − 预留功能区"，钉住大纲栏时两者差 `asideW/2`（240px 的栏 ⇒ 120px 偏移，用户 2026-10-01 报的"没居中"就是这个）。`bottom: var(--acpc-composer-h)` 直接叠在底栏上（实测抽屉下沿 = 输入卡上沿）。`z-index: 9`（高于底栏 8、低于右键菜单 60 与图片浮层 90） |
| 高度让位 | 新增 `--acpc-elic-h`：`#messages` 的 `padding-bottom` 与 `#jumpToLatest` 的 `bottom` 各加一段（实测展开 405px = 24 + 底栏 84 + 抽屉 297；收起 145px）。写变量的是 `applyDrawerHeight()`，**观察器 + 显式调用两条腿**：ResizeObserver 的回调按帧投递，不是每个宿主都送达（无头预览里就没送达，第一版只靠它 ⇒ 留白停在旧值，抽屉会压住最后一条记录）。这是 pitfall #27 的同一件事：量，并且别赌回调时机 |
| 题目分页 | 一个 tab 一道题（标题取 `field.title`，即 AskUserQuestion 的 `header`）；`customFor === X` 的字段并进 `X` 那道题（**按名字配对**，不按位置）。tab 上的圆点 = 已答/未答。**[154] bar（用户要求）：没有标题行** —— tab 条、`Answered n/N` 与收起箭头合成一条，进度与箭头**靠右**；收起时 tab 条换成当前题的名字 |
| 单选 | **[154] 平铺的 radio 列表**（用户第二次改规则：不要下拉）——每行 = **主标题 + 副标题（选项说明）**，末尾一行 `Other`（自由作答也是一"选"）。底层就是一组普通 radio，`collect()` 的判据一个字节没动；点击时**显式**取消同级 checked（桩 DOM 没有原生 radio 组行为，显式让两边一致）。没有下拉菜单 = 没有"菜单被裁/开错方向"那一类问题（153 为此改过两版规则） |
| 多选 | **经典复选框列表**（用户规则 2），行 = 选项名 + 选项介绍（用户规则 3） |
| 自拟框 | **[154] 单选：跟着"被选中的那一行"走**（`placeCustomBoxes` 把它 `appendChild` 进那行的容器里），没选时**藏在自己的题块里**（`data-elic-home`）而不是从 DOM 摘掉 —— 摘掉就再也找不回来，写进去的字也会掉出 `collect()`（这条是踩出来的）。多选：仍在列表下方。**任何形态都必须带那行说明**（"填了它就以它作答、取代上面所选"）——adapter 的 `applyAskElicitationResponse` 里 custom **优先于**选择，只写"追加"就是 UI 撒谎 |
| 收起 | bar 右端的箭头把抽屉收成**一行**（当前题的名字 + 进度 + 箭头）。**Escape 只收起、绝不 cancel**（cancel 会中止工具调用，不能由一次误按键触发）。收起会把这个 promptId 记进 `dismissed`：切走再回来不会自动重弹，内联条的「Open form」是回来的路 |
| 打开策略 | 自动打开 = 聚焦会话里有 pending 且该 promptId 没被收起过；**主动打开**（内联条 / 收起态）才把焦点给抽屉（显式动作才抢焦点，同 019/125 的态度） |
| **只看当前会话** | `setSession(sessionId)`（boot 在 `syncElicitations()` 这个唯一入口里同步）+ `pendingForms()` 按 `state.sessionId` 过滤。为什么不用"转录已经是当前会话的"当判据：那是**代理信号**（pitfall #25/#26），一旦某条路径没重建转录，别的会话的表单就会在这边显示出来（用户 2026-10-01 报的正是它）。记录仍记着"谁的表单" —— 切回去它自己会回来。**[154] 另一半在清记录那一侧**：`sessionId` 为空时 `pendingForms()` 直接返回空（草稿页/空态没有会话），而 boot 里所有清记录的地方统一走 `resetTranscript()` 包装（reset + 对账）—— 上一版只调了 `reset`，切到草稿页时抽屉就留在屏幕上了（用户第二张图） |
| 多个待答表单 | 抽屉同一时刻只呈现一个（记录里第一条未收起的），其余靠各自内联条的「Open form」切过去（`open(promptId)`）——不做叠层 |
| 委托点击 | 抽屉自己持有一个**容器级** click 监听（tab / 收起 / 清除所选，容器不重建 ⇒ 不怕 pitfall #28 的"重建后 target 脱离"）；`data-elic-action`（提交/跳过/取消）继续走 `links.ts` 的全局委托，根节点查找改为 `.elic` **或** `.elic-drawer`；下拉菜单项的 `data-elic-pick` 与"点外面关菜单"走 document 级监听 |
| 记录层的 pending 条 | 一行：⏳ + `<gist>`（`state.message` 折成一行）+ `Open form`。结算后仍是那张只读卡（问题 + 曾提供的选项 + 结果说明）——那是历史，不该被这次改动抹掉 |
| 已答判定 | 从 **DOM** 读（DOM 就是表单状态）：radio/checkbox 看 `checked`，文本框看非空。`onDrawerChange`（容器上的 change/input 委托）负责重算 tab 圆点/进度/未答提示 —— 少了它，勾选框不会让进度动（第一版就漏了） |
| 桩 DOM 的两个约束 | ①客户端代码里**不要用带值的属性选择器**（`[data-x="v"]`）——`src/test/chat-client.test.ts` 的桩只支持 `[attr]`，用它会让"找不到自己的 input"的 bug 在测试里永远绿；一律 `querySelectorAll('[attr]')` + 过滤（`inputsNamed`/`findByAttr`）。②`loadClient` 刻意不加载 boot，所以抽屉的**请求/应答**接线由 `NS.elicitationView.init()` 自己完成，测试直接调它 |
