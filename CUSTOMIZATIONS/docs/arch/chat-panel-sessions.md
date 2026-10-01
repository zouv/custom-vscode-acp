# Chat 面板 · 会话目录与重开路径

> **这是什么**：`docs/arch/chat-panel.md` §5.13–§5.15 的**拆出部分**（CUSTOM-20260925-060），
> 以及后续长在这里的 §5.24（历史选择器的目录过滤，CUSTOM-20260926-079）。
> 主文件已到 488 行，超了 `architecture.md` §0 那条「体量铁律」（超过 ~400 行即拆分）。
>
> **为什么这几节放在一起**：它们是同一个主题的几面——**会话与它的工作目录**。
> 建会话时选目录（§5.15）、已存在会话的目录从哪来（§5.14）、重开会话时那条 replay 链
> 怎么测（§5.13）、以及按目录过滤历史列表（§5.24）。它们共享同一个前提：
> **cwd 是会话级属性、且由协议固定在创建时**。
>
> **§5.x 的编号原样保留**（与 `chat-panel.md` 同一套编号，跨文件连续），所以各处引用只需换文件名。
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

- **列表的"全集"由 agent 与它的存储共同决定**：agent 的 `session/list` **不含仍在其他窗口开着的会话**
  （实测见 `CUSTOMIZATIONS/scripts/probe-session-list.mjs` 的**磁盘 ↔ agent 对账**：本项目 8 个转录文件、
  agent 只报 6 个、`disk-only = 2`、`agent-only = 0`）。094 起从**转录目录**补这一块，
  但仍有边界：① **只补当前工作目录那一个 slug**（别的目录的会话仍只能靠 agent 报）；
  ② **只有 Claude Code**（那是它的私有存储）；③ 转录格式变了就只退化成"没有补充"。
  **再有人报"列表少了"，先跑那个探针**——它把"agent 没报"和"我们过滤掉了"一次分开。
- **从转录目录补出来的行可能还在别处开着**：tooltip 里写明"read from the transcript folder — the agent did
  not list it"。打开它（`session/load`）会与另一个写入方共用同一个转录文件——官方插件同样允许这么做，
  但这是**有代价的**，所以标记必须保留、不能省成"看起来和别的行一样"。

- **cwd 在会话创建后不可改**（协议只提供 `session/new` / `session/load` 时的 `additionalDirectories`，
  没有"改 cwd"）。所以 UI 上它只能是"新建时选"，已发出消息的会话里它是只读的。
- **打开历史会话会按需连接（083）**：`openExistingSession` 在**读能力之前**先
  `await ensureConnected(agentName, opts.cwd)`。原因见 `pitfalls.md` #30：
  `session/load` / `resume` 的能力来自 ACP 的 `initialize` 握手，**没连接过 ⇒ 缓存里没有 ⇒
  旧代码把它读成"这个 agent 不支持"**。历史选择器未连接时列的是**本地缓存**（设计如此，
  计数行写着 "from the local cache"），所以那会儿每一条都点得动、每一条都失败。
  `opts.cwd` 顺带作为进程启动的偏好 ⇒ 跨目录的会话在它自己的目录里被打开。
  **已知体验缺口**：连接 + 重放期间没有 loading 反馈（要补的话该给客户端一条状态，别在记录区打印噪声）。
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
| **切回会话标签（080）** | 点会话标签只发一条 `focusSession`，**渲染完全依赖宿主的 `focus` 应答**；而 `SessionManager.focusSession` 在"**已经是这个会话**"时 early-return（只在**变化**时 emit）。草稿是客户端私有的、宿主不知道它存在 ⇒ 宿主"我这边已经是 A 了"就不回话 ⇒ 面板永远停在草稿页，A 的标签看起来是坏的。修法是宿主侧 `focusSession(sessionId, { force: true })`（manager 自己对 newConversation/loadSession/resume 用的同一条惯用法）。**规矩：客户端显式请求的聚焦，宿主必须回话**——客户端的"我在看什么"不是宿主状态的函数（草稿/空白页就是反例）。守卫不放宽：未知会话照旧丢弃 |

**草稿的固有代价 —— 已被 [CUSTOM-20260930-151] 补上**：草稿没有 `sessionId`，而模式 / 模型 /
斜杠命令都是 agent 在 `session/new` 时（或之后的通知里）下发的，所以草稿页本来只有输入框。
现在由宿主按 agent 留一份"上一次会话的快照"来填（`listDraftOptions` → `draftOptions`），
用户选的值随 `createDraftAndSend` 一起走、建出会话后逐项校验再应用 —— 见
[`chat-panel.md`](./chat-panel.md) §5.32。**仍然成立的部分**：全新环境（本进程没开过该 agent
的会话）没有快照可用，那时草稿页依旧只有输入框。

### 5.24 历史选择器的目录过滤（CUSTOM-20260926-079）

**为什么需要**：这个列表是 **agent 侧的**（跨目录），实测 232 条会话横跨多个仓库——
没有过滤就得在两百多行里找一条。

**一句话**：header 右侧一个 chip 兼管"开关"与"选目录"（`All folders` / `<目录名>`），
过滤是**纯客户端的 key 比较**，key 由宿主算好。

| 关注点 | 规则 |
|---|---|
| 控件形态 | **一个 chip 兼管两件事**（`📁 All folders ▾` / `📁 <目录名> ▾`）：点开菜单，首项 `All folders` 就是关闭过滤。"开启"与"选一个目录"本来就是同一个动作，拆成"勾选框 + 下拉框"是两步操作 |
| 何时出现 | 候选 ≥ 2 个目录，**或过滤正生效**（否则用户关不掉它）。用 `hidden` 属性（`.picker-btn` 的 `display` 被全局 `[hidden]{display:none!important}` 压住，这是 pitfall #13 的正确用法） |
| 候选从哪来 | **只来自列表里真实出现过的目录** + 当前会话的目录（**0 条也在**）。过滤一个列表里没有会话的目录只会得到空列表，所以「浏览…」在这里是死路；而"默认目录不在菜单里"会像一个坏掉的控件。**排序：名称字母序**（[142]：原先 current → 条数降序 → 名称，前两个键把字母序盖住了，看起来就像"根本没排序"；当前目录只保留 `current` 标记——客户端据此高亮它——不再置顶） |
| 候选怎么显示 | `label` 而不是 `name`：**两个目录同名时标签向左长**（`git/UniverseEditor` vs `zdev/UniverseEditor`）——第一个真实列表里 "UniverseEditor" 就出现了两次（同一仓库的两份检出），两个一模一样的标签根本没法选。唯一的名字保持原样（不长） |
| **点击落在哪里，要问派发时的路径** | 关闭判定用 `event.composedPath()`，**不是 `drawer.contains(event.target)`**：选中目录会重建菜单行，把正在冒泡的那个按钮摘下来，而 `contains` 对游离节点恒为 false ⇒ 这次点击被判成"点了外面"、**整个列表关掉**（用户复验当场发现的那个 bug）。派发路径在事件派发瞬间就固定了，所以它仍然答得出"这次点击在不在抽屉里"。完整教训见 `pitfalls.md` #28 |
| 目录同一性 | `historyDirs.directoryKey`：反斜杠→正斜杠、去尾分隔符（`D:\x\` = `D:\x`；`C:\`/`C:`/`C:/` 都折成 `c:`）、**大小写只在 win32/darwin 折叠**（linux 的 `/Home` 与 `/home` 是两个目录）。**刻意不用 `path.normalize`**：它在不同平台上行为不同，会让行为与测试都变成环境相关的 |
| 谁算 key | **宿主**。客户端只比较两个 key —— 于是"这两个路径算不算同一个目录"只有一个地方需要想清楚。列表本来就在客户端，**换目录不产生任何往返**（那会是一次 `session/list`） |
| 记忆策略 | **开关持久化**（`vscode.setState`，同 `Times`/`Sub-agents`）；**目录每次打开都回到当前会话的工作目录**。记住目录会在切到别的项目后继续过滤一个已无关的文件夹 |
| 默认目录 | 聚焦会话**属于本次查询的那个 agent** 时用它的 cwd（picker 是按 agent 查的，聚焦会话可能属于另一个 agent），否则第一个工作区文件夹。取不到 ⇒ 未过滤（草稿、或 agent 没报 cwd），这是诚实的答案 |
| 计数行 | 未过滤：`232 sessions · from the agent`（不变）；过滤：`12 of 232 sessions · from the agent`——**总数不能省**，只写"12 sessions"会像 agent 丢了两百多条 |
| **列表来源是并集（092）** | `source: 'agent' \| 'local' \| 'merged'`（`merged` = 有多个来源贡献）。连上 agent 时是 **agent 列表 ∪ 转录目录 ∪ 本地缓存**：靠前者优先（agent 是"会话还在不在"的权威），只有后面来源知道的行带 `fromDisk` / `fromCache` 标记（tooltip 里说明），按 `updatedAt` 倒序。**为什么必须并集**：agent 的 `session/list` **不是全集**——实测（091 的探针）227 条里没有缺 cwd 的，但本项目磁盘上 8 个会话只报了 6 个，少掉的正是**仍在其他窗口开着的**那些 |
| **第三个来源：转录目录（094）** | Claude Code 把每个工作目录的会话放在 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<路径里非字母数字都换成 '-' 的 slug>/<sessionId>.jsonl`。**官方插件看到的就是这个目录**，所以这里补上它（`diskSessions.ts`）。三条硬约束：**只对 Claude Code**（`CLAUDE_CODE_AGENT`，与 `MODERN_AGENTS` 分开——那是"用哪个面板"，这是"愿意读谁的私有存储"）；**初始只扫当前工作目录对应的那一个 slug**（与本地缓存同作用域）；**095 起按过滤目录按需补扫**——客户端过滤到具体目录时发 `supplementHistory { cwd }`，宿主 `readDiskHistory(agent, cwd?)` 按该目录扫描并增量返回（`historySupplement`），解决多根/跨目录场景下扫错目录的问题；**任何失败都只是"没有补充"**，绝不影响 agent 的那份列表。读取用**按行流式**、超长行跳过（转录能到几十 MB，且**第一行本身就可能很大**——按字符切一刀会读不到任何记录，探针的第一版就是这么错的） |
| **没有目录的行（093）** | `dirKey` 为空（agent 没报 cwd）的行**不属于任何候选**——但"不知道它在哪个目录"**不等于**"它在别的目录"，静默丢弃是把猜测当规则。现在：菜单末尾多一个 `Unknown folder (N)` 候选（哨兵 key `~unknown`，真实 key 必含分隔符、撞不了车），选中即筛出这些行；用真实目录过滤时计数行补一句 `· N without a folder` |
| 空结果 | 一行「No sessions in this folder」+ 一行可点的「Show all folders」（chip 不显眼，不能只靠它） |
| 挂载位置 | 菜单挂在 `.outline-head` **内部**：它已是定位元素（`position: sticky`），`top: 100%` 正好落在 header 下面——不量高度、没有常量偏移（pitfalls #24）。chip 与菜单是 `.outline-head-info`（`render()` 清空回填的计数容器）的**兄弟**，所以重渲染不会把它们清掉（077 的形态）。**[141] 但它必须能"溢出"浮层**：浮层 `#history` 原本是 `overflow-y: auto` 的滚动容器，而菜单的包含块（head）在它里面 ⇒ 菜单被裁成"head 底边到浮层底边"那么几行（历史列表越短它越矮，用户实测只剩两三行）。修法是把滚动**下移**到 `.outline-list`：`#history` 变成 flex column + `overflow: visible`，于是它不再裁剪任何后代，菜单高度交回自己的 `max-height` 单独控制。**只写在 `#history` 上**（`#outline` / `#cwdMenu` 里没有这种嵌套菜单，不动通用规则） |
| **观感与历史列表区分（141）** | 两者都吃 `--vscode-dropdown-*` 那套 token（底色 / 边框 / 圆角 / 阴影几乎同值），叠在一起分不清谁是谁。给菜单加 `.filter-menu`，只把边框换成 `--vscode-focusBorder`——**不是画环**（环在这个面板里是键盘焦点，062 的教训），借的是 `.filter-chip.on` 那套"当前项"语义 |
| **菜单用 `.open` 类，不是 `hidden` 属性** | `.picker-menu` 自带 `display: none`，与 `.open` 的 `display` 是同一层级的竞争。写错的表现是"菜单永远不出现"，而它看起来像 JS 没跑——正是 pitfall #13 的反面 |
| 选中后菜单**不关闭** | 换目录通常是**连着比几个**（比较两个、或再试下一个），关掉就变成"重开→选→重开→选"。选中后菜单**原地刷新**：计数行、列表、以及菜单里那一项的激活标记都跟着变（这是用户 F5 复验时提的第一条修改）。焦点要还给新激活的那一行——重建会销毁刚点的按钮，焦点掉回文档后下一次 Tab 会从面板顶部重新开始。**点击抽屉里的别处**才收起它（标准下拉行为；chip 自己 stopPropagation，菜单行当然不能收起自己所在的菜单） |
| Esc | **分层**：菜单开着时只收菜单，再按一次才收抽屉。否则一次 Esc 会把整份列表连同浏览位置一起丢掉 |
| 宿主回复 | `handleListHistory` 的三条路径（agent / 本地缓存 / 出错回退）合并成一个 `postHistory`——三处各自拼装正是"其中一处漏了 `dirKey`"的写法，而漏掉的表现是**那些行在过滤后凭空消失**。协议只做追加（`dirKey?` / `directories?`），`directories` 里 `current: true` 的那条即默认目录，不需要另开字段 |

**已知边界（本轮不做）**：

- **本地缓存那条路只有本工作区的会话**（`workspaceState` 按工作区分桶，`list(agent, workspaceCwd())`），
  所以未连接时过滤往往只有"当前目录"一个候选、chip 不出现。跨目录要靠 agent 侧 `session/list`。
- **别处的 cwd 比较仍然是精确 `===`**（`SessionHistoryStore.list` 的按目录过滤、`recentDirectories` 的去重、
  文件 chip 的路径）：`D:\x\` 与 `D:\x` 在那几处仍是两个目录。本轮**只给历史过滤器**引入归一化，
  没有顺手改它们——那会改变会话列表与"最近使用目录"的既有行为，需要单独一轮。
  `directoryKey` 已经是那个现成的工具（纯函数、已测）。

