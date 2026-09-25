# Chat 面板 · 会话目录与重开路径

> **这是什么**：`docs/arch/chat-panel.md` §5.13–§5.15 的**拆出部分**（CUSTOM-20260925-060）。
> 主文件已到 488 行，超了 `architecture.md` §0 那条「体量铁律」（超过 ~400 行即拆分）。
>
> **为什么这三节放在一起**：它们是同一个主题的三面——**会话生命周期**。
> 建会话时选目录（§5.15）、已存在会话的目录从哪来（§5.14）、以及重开会话时那条 replay 链
> 怎么测（§5.13）。三者共享同一个前提：**cwd 是会话级属性、且由协议固定在创建时**。
>
> **§5.x 的编号原样保留**（与 `chat-panel.md` 同一套编号），所以各处引用只需换文件名。
>
> **配套**：面板的整体架构、文件职责、消息纪律、安全约定、权限卡、大纲/引导条、以及面板审计
> 的结论表，都在 [`chat-panel.md`](./chat-panel.md)（§5.1–§5.12）；任务路由见
> [`../../architecture.md`](../../architecture.md)。

---

### 5.13 replay 路径：怎么测、怎么重抓、以及那条「重开后正文消失」的真根因（CUSTOM-20260925-053..055）

**这一节回答两个问题**：这条路径以前为什么查不出来、以及下次该怎么查。

**病灶（055）**：`contentBlocks.isBlankText()` 的 `return true` / `return false` 是**反的**，
于是 `if (!merges && isBlankText(text)) return null;` 这条「看不见就不建记录」的守卫，
实际做的是**「看得见就不建记录」**。实时路径靠一个巧合掩盖了它（agent 实时先发一个空白分片，
按反判据"不是空白"⇒ 记录被建出来，之后正文走合并分支），而 `session/load` 的 replay 是
**单块真切正文、前面没有空白** ⇒ 助手正文与 Thought 记录**整条被丢**。
完整复盘见 `docs/pitfalls.md` #22 —— 那一节比这里更该读。

**两条重开路径本来就不同**（这是所有相关排查的第一道分岔，别再重复怀疑）：

| 重开方式 | 走哪条路 | 客户端看到什么 |
|---|---|---|
| 会话**仍 live**（在另一个标签里） | `loadSession` 只 `focusSession` | 宿主 store 的**快照** hydrate → 应与实时完全一致 |
| 会话**已关闭**（或本窗口从未打开） | `session/load` → **replay** | 由 replay 流**重建**的 transcript |
| `resume`（agent 不支持 load） | 无 history，只有提示 notice | 几近空白（**这是设计如此**，不是 bug） |

**这一层怎么自动测**（`src/test/chat-panel.test.ts`，`CUSTOM-20260925-054`）：

- 在**真 Extension Host**（`npm test` 已提供）里构造真实的 `SessionManager` / `ConnectionManager` /
  `AgentManager` / `ChatPanelHost`，用桩 `ChatSurface` 拦下宿主**准备发给 webview 的每一条消息**。
- 用 `src/test/fixtures/claude-code-session-load.json` 驱动——**真实 agent 抓的**字节。
- 断言四件事：replay 的正文不得被静默丢弃 / 不得留下永远 `streaming` 的记录 /
  快照与增量一致 / live 对照组同样不丢。外加一条**诊断**：打印 live 与 replay 的**通知类型直方图**。
- **下次再有人报「重开不一样」**：先看那条直方图。`replay:` 里有没有 `agent_message_chunk`／
  `agent_thought_chunk`？**有 = 我们丢了**（看 `isBlankText` 那类守卫、合并条件、客户端过滤）；
  **没有 = agent 没回放**（那时该做的是别把它渲染成"像是丢了内容"）。
  这一步把"猜"换成了"读一行日志"。

**夹具怎么重抓**（协议形状变了才需要）：

```bash
node CUSTOMIZATIONS/scripts/capture-acp-replay.mjs --out src/test/fixtures/claude-code-session-load.json
```

它会**真的拉起 agent、花额度、并在该 agent 的会话历史里留一个新会话**，所以是一次性动作。
它把 live 与 replay 两段流写进同一个文件（测试要靠这一点做对比），并且**在一次性临时目录里跑**。

**这一层不测什么（写在文件头，也写在这）**：**不做 DOM 测试**。
它能判定的三类问题全在协议流上可判，而这样测试不依赖 webview、跑得快、不会因布局细节而脆。
**布局类问题**（空白条 / 条目被压扁 / diff 被折叠 / 按钮化后外观错位）仍只能人工验收——
`docs/dev-workflow.md` 的验收清单里那些项**仍然有效，不要因为"有测试了"就跳过**。

**同族的收尾（053）**：`user_message_chunk` 到达时要 `finalizeEntries({only:'assistant'})`，
`session-load-end` 时要 `finalizeEntries()`——replay 是**有限**流，结束后不可能还有东西在流式。
两处都不做的话，记录会永远停在 `streaming: true`，把 `aria-busy` 钉在 true、**读屏从此静默**。
**INV-I：replay 路径上不许留下 `streaming: true` 的记录**（`ChatPanelHost` 的两处 finalize +
测试里的 `no entry is left dangling as streaming` 是它的守卫）。

### 5.14 每会话工作目录（CUSTOM-20260925-056..057）

**为什么需要**：多标签并发会话从 010 起就能用，但**所有会话共用同一个 cwd**——
`getWorkspaceCwd()` 硬编码「工作区第一个文件夹」，被四处调用点各自调用。于是"不同会话用不同目录"
做不到，而用户的真实工作方式就是跨项目切换（「Open previous session」里 245 条会话横跨多个仓库）。

**协议是支持的，而且实测确认过。** `NewSessionRequest.cwd` 的原文是
*"The working directory for this session"*——**会话级**属性，与 agent 进程的 cwd 无关。
2026-09-25 用 `CUSTOMIZATIONS/scripts/probe-session-cwd.mjs` 实测（进程在 A、会话声明 B）：
`pwd`、`ls`、读相对路径**全部落在 B**，A 那边的东西一个都没出现 ⇒ **`honours-session-cwd`**。
**这一条是整个特性的前提**：若适配器沿用进程 cwd，就必须按 (agent, cwd) 分进程，
`agentProcesses` 的键要变——那是量级不同的改动。**协议形状或适配器版本变化后请重跑探针。**

**cwd 的解析链**（`SessionManager`）：

| 场景 | 取值 |
|---|---|
| `createSession(agent, {cwd})` | 显式 cwd → 否则 `resolveDefaultCwd()` |
| `loadSession` / `resumeSession` | 调用方给的 cwd → 否则**本地历史缓存里那条会话自己的 cwd** → 否则 `resolveDefaultCwd()` |
| `resolveDefaultCwd()` | `acpc.defaultWorkingDirectory`（**校验：必须是绝对路径且存在**，否则拒绝并记日志）→ 第一个工作区文件夹 → `process.cwd()` |
| 进程 spawn（`ensureConnected`） | 作为**偏好**传入；只影响首次 spawn，进程在会话间复用 |

**一个被顺带修掉的现网 bug**：历史选择器展示的是 agent 侧 `session/list`（**跨目录**），
而点开时宿主从不传 cwd ⇒ 告诉 agent 的是**当前工作区**，
一条属于 `D:\Git\zdev\...\ai-broadcast-studio` 的会话会被当成住在这里重开。
行的 `cwd` 早就取到了（只用在 tooltip 上），只是没被使用。现在客户端在行上写 `data-open-cwd` 并回传。
**注意**：这条链还有第二层兜底——`loadSession` 会查本地历史缓存；
但**跨工作区的会话不在那个缓存里**（`workspaceState` 是按工作区分桶的），
所以**客户端回传的那一份是主力，缓存只是兜底**，两者都不能省。

**已知边界（本轮不修）**：

- **cwd 在会话创建后不可改**（协议只提供 `session/new` / `session/load` 时的 `additionalDirectories`，
  没有"改 cwd"）。所以 UI 上它只能是"新建时选"，已发出消息的会话里它是只读的。
- **`recentDirectories()` 只在 `workspaceState` 里**，因此只记得**本工作区曾用过**的目录；
  新工作区开局是空的。要跨工作区就得走 agent 侧 `session/list`（下一步 058 会合并两者）。
- **`session/close` 不会把会话从 agent 历史里移除**（[图1] 里两条我抓包留下的空会话是证据）。
  这也是「点 `+` 立刻建会话、改目录就重建」被否掉的原因：那样每改一次目录就留一个空会话。
  改为**草稿页**（058）：发出第一条消息时才建会话。
- **`additionalDirectories`（一个会话挂多个目录）** 是实验性能力，本轮不做。

### 5.15 草稿页与目录选择（CUSTOM-20260925-058）

**一句话**：点 `+` 不再立刻建会话，而是开一个**本地草稿页**；在那一页上选好工作目录，**发出第一条消息时**
才 `session/new({cwd})`。

**为什么不是"先建会话、改目录就重建"**（这是本节最该记住的一条）：
ACP 没有"改会话 cwd"的请求——cwd 只在 `session/new` / `session/load` 时给定——所以"改目录"只能**重建**。
而 **`session/close` 不会把会话从 agent 的历史里移除**：用户的「Open previous session」列表里
那两条 `In two sentences: w…` / `File byte size markdown table` 就是我两次抓包留下的空会话。
于是"每改一次目录就重建"会给用户的历史里留下一条垃圾会话——**改三次就三条**。

| 关注点 | 规则 |
|---|---|
| 草稿是什么 | **纯客户端状态**（`boot.ts` 的 `drafts` / `focusedDraftId`），宿主不知道它，也没有 `sessionId` |
| 存活性 | **`sessionsChanged` / `boot` 不得把它冲掉**。服务端列表按定义不含草稿——所以 `tabs.setSessions` 刻意**不碰** drafts，草稿走独立的 `setDrafts` / `setDraftFocus`。漏了的表现是"点 `+` 后标签闪一下就没了" |
| 两个模式互斥 | `composer` 的 `setFocus` 清 `draft`、`setDraft` 清 `sessionId`——因为 `send()` 按 `state.draft` 分支，留一个陈旧的会让发送走错路 |
| 发出第一条 | `createDraftAndSend {draftId, agentName, cwd, text}` → 宿主 `createSession(agent,{cwd,focus:true})` → **复用 `handleSendPrompt`**（`recordFirstPrompt` / 附件 / `finalizeTurn` 都在里面） |
| 应答相关性 | `draftResolved {draftId, sessionId}` / `draftFailed {draftId, message}`。**`draftId` 不能省**：`createSession` 会连带触发 `session-created → sessionsChanged → focus`，靠"收到新 focus 就删草稿"在慢/失败路径上会留下孤儿草稿或误删 |
| 失败时 | 草稿**和已输入的文字都保留**——所以 composer 在草稿模式下**刻意不清空输入框**，清空发生在 `draftResolved` |
| 消息位置 | 三条请求都**非会话作用域**，因此在 `verifySession` 守卫**之前**（§5.4 规则二）；四条应答都**定向**给发起请求的那个面 |
| 目录候选 | 工作区文件夹（**含多根**，此前只用了 `workspaceFolders[0]`）/ 最近用过（本地 `recentDirectories` 与 agent 侧 `session/list` 的 cwd **合并**——前者是 `workspaceState` 作用域的，新工作区开局为空）/ 默认目录 / 「浏览…」走宿主 `showOpenDialog`（webview 打不开） |
| 已开始的会话 | 目录**只读**（协议固定），抽屉里点候选 = 在那个目录里开一个**新草稿**（不假装能改） |
| 空态 Connect | 改为 `ensureConnected` + 草稿：只拉进程、**不建会话**（按钮的意义"我这个 agent 起得来吗"靠 `ensureConnected` 仍会抛错来保留）；该 agent 已有会话则聚焦最新那条 |
| 键盘 | `#cwdBtn` 是真 `<button>`（047 的规矩）；三个抽屉（outline / history / cwd）**互斥**，开一个关掉另外两个 |

**草稿的固有代价（写进代码注释，不是 bug）**：草稿没有 `sessionId`，所以**模式 / 模型 / 斜杠命令**
要到建会话之后才有——那些是 agent 在 `session/new` 时下发的。
