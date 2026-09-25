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
| `html/client/*.ts` | webview 内联客户端 JS，**每个模块是一个字符串**，统一挂到 `window.__acpc`。058 新增 `directoryMenu.ts`（草稿页的目录抽屉，形态照抄 `sessionMenu.ts`） | 改前端交互 |

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
4. **不要在模板体里写含 `/` 的正则**（CUSTOM-20260925-049 新增）。
   上面那个检查器是**按原始模板文本**解析的——**它不还原模板转义**。于是源码里的
   `/^\\/[a-zA-Z]:/`（生成的脚本里是 `/^\/[a-zA-Z]:/`，完全合法）在它眼里是
   「转义的反斜杠 + 未转义的 `/`」⇒ **正则在此提前结束**，后面的 `[a-zA-Z]:` 成了裸代码，
   报出一个位置完全对不上的 `Unexpected token ':'`。
   避开办法：改写成语义等价的**无正则**形式（本次用 `charCodeAt` 判断盘符），或者让正则里
   不出现 `/`。**字符串**里的转义没有这个问题（`'\\u25b8'` 在原文里也合法），
   只有**正则字面量**会这样炸。完整经过见 `docs/pitfalls.md` #11 的第四次复发记录。

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

### 5.9 会话大纲（CUSTOM-20260924-021）

**纯客户端**：不动协议、不加命令、不改 `package.json`。锚点来自 `transcriptView.ordered()`，
**不是** `Object.keys(objects)` —— 后者的顺序保证只覆盖整数样式的键，错了的表现是"跳转到不相干的消息"。

| 关注点 | 规则 |
|---|---|
| DOM 锚 | 每个节点在 `place()` 里打 `data-entry-id`；`node(id)` / `entry(id)` 是唯一查找入口 |
| 布局读取 | **只在 rAF 回调里**（`NS.dom.schedule`）。scroll 事件只置脏位，否则每帧强制重排 |
| 高亮 | 缓存的 `[{id, top}]` 上二分；`invalidate()`（transcript 变更）后重建；重建只在抽屉打开时做 |
| 跳转 | `scroll.jumpTo(node)` 先置 `pinned = false` 再写 `scrollTop`，随后 scroll 事件按真实距离重算 |
| Escape | **捕获阶段**监听 + `stopPropagation`：composer 在 textarea 上监听 Escape 取消轮次，不拦会误取消 |
| 上限 | 200 条锚点，多出的折叠成一行「… N earlier hidden」 |

**`invalidate()` 的调用点**在 `boot.ts` 的 `append` / `revise` / `focus` / `boot` / `sessionClosed` / `error`
分支里——**不要**放进 `meta` / `attachments`，那会让抽屉在流式期间被反复重建。

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
| DOM 位置 | `#rail`/`#railTrack` 是 `.message-area` 的**兄弟节点**（`#messages` 之外）。**不要**放进 `#messages`：那里的三档间距阶梯（`.messages > * + *` 的 `margin-top`）会位移它，它也会被当成一个"条目"参与 flex 排版 |
| 随内容滚动 | track 做 `translateY(-scrollTop)`（同一个 rAF tick 里，且值未变则不写） |
| 布局读取分档 | **`invalidate()`**（条目集合/状态变化）先比标记签名，签名没动就**不读布局**——流式 chunk 走的就是这条；**`reflow()`**（markdown 回填、resize）只测量不重建。500 个标记全量测 `offsetTop` 是毫秒级的，分档就是为了避开它 |
| 点尺寸 | 尺寸与左偏移在 CSS（`.rail-dot.turn/.step`），用 `margin-top: -半高` 抵消，JS 只写 `top = y + 6`（即圆心） |
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
  `NestingStrategy.resolveNestingStrategy`（嵌套策略）、`sessionMenu.ts` 的空态文案（客户端硬编码）、
  `AgentConfig.getAgentNames`（排序）。新增第二个 modern agent 时要同改四处。
- `sanitize()` 的 `ATTR_ALLOWLIST` **放行全部 `data-*`**，而点击委托偏偏信任 `data-href` / `data-path` /
  `data-terminal`——这层兜底实际没约束住它最该约束的几个属性。当前不可利用（`SafeMarkdown.html()`
  把原始 HTML 转义成文本，没有注入路径），但将来若 marked 新增没人覆盖的钩子，这层就形同虚设。



### 5.13–5.15 已拆出：会话目录与重开路径

> **§5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）**
> 已移到 **[`chat-panel-sessions.md`](./chat-panel-sessions.md)**（CUSTOM-20260925-060）。
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
