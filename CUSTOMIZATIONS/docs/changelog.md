# 变更日志（按次）

> **这是什么**：本仓库自定义改动的 **append-only 历史流水**，按时间倒序，只增不改（历史是事实）。
> 每条记录一次改动：功能 / 改动文件 / 详细说明 / 验证方式 / 基于哪个上游 commit。
>
> **什么时候读它**：需要追查某次改动的来龙去脉、或核对某一轮到底改了什么时才读。
> **平时不要读**——查「某个文件现在改了什么、合并上游时怎么处理」请读
> [`../registry.md`](../registry.md) 的**改动总览**（那才是当前真相）。
>
> 本文件于 `CUSTOM-20260923-016` 从 `registry.md` 拆分出来：原先单体 59KB，其中 40KB 是这个日志，
> 而 `AGENTS.md` 把 `registry.md` 列为每次任务前必读。

> **2026-09-25 做过一次同题合并**（CUSTOM-20260925-060）：把"同一个问题分多次修"的条目合并成一条
> （14 项面板审计 → 2 条、白条问题 → 1 条、每会话 cwd 两步 → 1 条），59 条 → 46 条。
> **所有 change-id 都保留在合并后的标题里**，所以「代码标记 → 账本 → 日志」的追溯链没有断。
> 这是本文件唯一一次改写历史——**之后仍然 append-only**。

---

### 2026-09-25 - CUSTOM-20260925-060
- **功能**：再次拆分模块文档（方案 A）；并合并 changelog / pitfalls 里"同一个问题分多次修"的记录
- **改动文件**：`CUSTOMIZATIONS/docs/arch/chat-panel.md`（488 → 385 行）、**新增** `CUSTOMIZATIONS/docs/arch/chat-panel-sessions.md`、`CUSTOMIZATIONS/docs/changelog.md`（1161 → 990 行，59 → 42 条）、`CUSTOMIZATIONS/docs/pitfalls.md`（694 → 667 行）、`CUSTOMIZATIONS/architecture.md`、`CUSTOMIZATIONS/registry.md`
- **来源**：`chat-panel.md` 到了 488 行，超了 `architecture.md` §0 那条「体量铁律」（超过 ~400 行即拆分）——
  而这条铁律存在的理由很具体：**它每长一行，就是每个会话都要付一次的上下文税**。
- **详细说明**：
  1. **拆分（方案 A）**：把 §5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）
     移入 `docs/arch/chat-panel-sessions.md`。**为什么这三节一起走**：它们是同一个主题的三面——
     **会话生命周期**（建会话时选目录 / 已存在会话的目录从哪来 / 重开会话那条 replay 链怎么测），
     共享同一个前提：cwd 是会话级属性、且由协议固定在创建时。主文件保留面板本体（§5.1–§5.12，385 行），
     并按同一套纪律留了一个指向新文件的 §5.13–5.15 小节。
     **§5.x 的编号原样保留**（理由同 042）——因此本次拆分**不需要改动任何外部引用**：
     代码注释与其它文档里的「§5.4」「§5.5」「§5.7」「§5.8」「§5.10」「§5.12」全都留在主文件里。
  2. **changelog 的同题合并**：59 → 42 条（1161 → 990 行）。合并的是**同一个问题分多次修**的条目：
     14 项面板审计（038-041 + 043-052）→ 2 条、白条问题（026/027/034/036/037）→ 1 条、
     每会话 cwd 两步（056/057）→ 1 条、replay 收尾（053 并入 055）→ 合 1 条。
     **所有 change-id 都保留在合并后的标题或正文里**（用 `038..041` / `053/055` 这类范围写法），
     所以「代码 `[CUSTOM-BEGIN]` 标记 → 账本演进链 → 日志条目」的追溯链没有断——已用脚本核对
     **000–060 每个 id 都仍能找到**。
  3. **顺带修掉一个我自己的错误**：056/057/058 是用 `cat >>` 追加的，落到了**文件末尾**——
     而这个日志的契约是**按时间倒序（最新在最上）**。合并时一并按 `(日期 desc, 序号 desc)` 重排修正。
  4. **pitfalls 的合并**：§11（模板字符串里的反引号）原有四条"复发记录"，合并成一段
     「复发史 + 四次升级」，保留每一条**不同的**教训（让检查器报出来 → 覆盖全 → 理解工具自身的实现 →
     直接修掉它），去掉重复叙述。
  5. **这是 changelog 唯一一次改写历史**：该文件的契约是 append-only（"历史是事实"）。
     用户明确要求做同题合并，所以做了——但在文件头部写了说明（合并范围 + id 全保留 + 之后仍 append-only），
     避免下一个人以为历史丢失。**代价已记录：合并后的措辞是后来重写的，不再是当时的原文。**
- **验证方式**：`check-registry.mjs` 六节全绿；`npm test` 42 passing；`tsc` / `lint` / `compile` /
  `check-webview-client.mjs` 均通过；id 完整性由一次性脚本核对（000–060 无缺失）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-059
- **功能**：修「点 Browse 选完目录后没反应」——目录选择的**两处静默失败**
- **改动文件**：`src/ui/chat/html/client/directoryMenu.ts`、`src/ui/chat/html/client/boot.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验 058 时发现：草稿页点头部目录 → Browse → 在系统对话框里选好并点 “Use this directory”
  → **面板里显示的目录没有变**
- **根因（两条，同一个反模式：数据更新被 UI 状态门控，失败还不出声）**：
  1. `setChoices` 里 `if (!open) { return; }` 出现在**采用默认目录那一步之前**。而草稿页出现时抽屉本来
     就是关的（`focusDraft` 直接调 `refresh`，不经过 `show`）⇒ **默认目录永远没被采用**，头部一直显示
     `Default directory`——这正是用户截图里那一行。
  2. `setPicked` 里同样先判 `if (!open) { return; }`。系统文件夹对话框是**会抢焦点的异步交互**，
     靠"我们的抽屉在它返回时还开着"来收结果本身就不可靠；一旦不成立，**用户的选择被静默丢弃**。
- **详细说明**：
  - **数据更新不再门控于 `open`**：`setChoices` 无论抽屉开没开都采用默认目录；`setPicked` 无论抽屉
    开没开都应用结果（只在需要重绘时才看 `open`）。
  - **草稿只用 `draftId` 标识，cwd 现读**：抽屉此前缓存了一份 draft 对象——那是"同一份知识存两份"
    （pitfalls #19）。现在它只存 id，渲染时从新的 `NS.draft.get(draftId)` 现读，单一真相源。
  - 顺带删掉已经无用的 `browseIntent`（两个分支做的是同一件事——052 的规矩：不留死代码）。
- **验证方式**：`npm test` 39 passing；`check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` /
  `check-webview-client.mjs` 均通过。**这一类（客户端交互）无法自动测**——`dev-workflow.md` 的分界线表
  里写明布局与键盘只能人工；清单 94/96 就是这两条路径。
- **教训**：写客户端状态机时问一句「**这个数据更新依赖某个 UI 状态吗？**」——依赖了就会在"UI 状态
  恰好不成立"时静默丢结果，而这类失败**没有任何日志**。判据：更新所依赖的应该是**数据本身的标识**
  （draftId），不是"某个面板是否可见/是否打开"。已回写 pitfalls。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-058
- **功能**：**草稿页 + 目录选择器**——「新建会话时可以选这个会话的工作目录」，并让 `+` 与空态 Connect 统一到草稿
- **改动文件**：`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/`（**新增 `directoryMenu.ts`**；改 `boot.ts`/`tabs.ts`/`composer.ts`/`sessionMenu.ts`/`index.ts`）、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/*`
- **来源**：用户提出「点 New Session 跳转到新会话界面时（还没发对话），支持切换当前 session 的对话目录」。
  需求对齐后确认四条：①草稿页（发出第一条才建会话）；②目录候选四种都要（工作区文件夹含多根 /
  任意绝对路径 / 最近用过 / 让 `defaultWorkingDirectory` 生效）；③一个会话挂多个目录本轮不做；
  ④第一条之后目录只读。
- **详细说明**：
  1. **草稿页是纯客户端状态**（`boot.ts` 的 `drafts` + `focusedDraftId`）：点 `+` 只开一个本地标签
     （`New session`，虚线空心点），**不发任何建会话请求**。它必须能在 `sessionsChanged` / `boot`
     之后存活——服务端列表按定义不含草稿，冲掉的表现就是"点 `+` 后标签闪一下就没了"。
     所以 `tabs.ts` 的 `setSessions` 刻意**不碰** drafts，草稿走独立的 `setDrafts`/`setDraftFocus`。
  2. **发出第一条时才建会话**（`createDraftAndSend {draftId, agentName, cwd, text}`）：
     宿主 `createSession(agent, {cwd, focus:true})` → **复用现成的 `handleSendPrompt`**（它已经会做
     `recordFirstPrompt`、附件、`finalizeTurn`）。**为什么不是"先建再重建"**：`session/close` 不会把会话
     从 agent 历史里移除（图1 里那两条我抓包留下的空会话就是证据），于是每改一次目录就多一个垃圾会话。
  3. **应答带相关性 id**：`draftResolved {draftId, sessionId}` / `draftFailed {draftId, message}`。
     `createSession` 会连带触发 `session-created → sessionsChanged → focus`，靠"收到新 focus 就删草稿"
     在慢路径/失败路径上会留下孤儿草稿或误删。**失败时草稿与已输入的文字都保留**——
     所以 composer 在草稿模式下**刻意不清空输入框**，清空发生在 `draftResolved`。
  4. **目录候选**（`listDirectoryChoices` → `directoryChoices`）三组：工作区文件夹（**含多根**，
     此前只用了 `workspaceFolders[0]`）、最近用过（本地历史缓存的 `recentDirectories` 与 agent 侧
     `session/list` 的 cwd **合并**——本地那份是 `workspaceState` 作用域的，新工作区开局为空）、
     以及默认目录。第四组「浏览…」走 `pickDirectory` → **宿主** `showOpenDialog`（webview 自己打不开）。
  5. **抽屉形态照抄 `sessionMenu`**（021/033 那套 `.outline*` 与 `#cwdMenu`，与 `#outline`/`#history` 同级），
     三个抽屉互斥（打开一个会关掉另外两个）。头部显示目录的那格（`#sessionTitle`）**从 `<span>` 变成真
     `<button id="cwdBtn">`**——延续 047 的规矩，键盘可达且带焦点环。
  6. **已开始的会话**：目录由协议固定在创建时（ACP 没有"改 cwd"），所以那一格只读展示，
     抽屉里点候选项等于**在那个目录里开一个新草稿**（`NS.draft.start(path)`）——不假装能改。
  7. **空态 Connect 按钮改为 `ensureConnected` + 草稿**：只把进程拉起来（按钮存在的意义就是"我这个 agent
     起得来吗"，这条反馈没丢，`ensureConnected` 仍会在起不来时抛错），**不建会话**；若该 agent 已有会话
     则聚焦最新那条，草稿留在标签栏里可随时回来。
  8. **历史会话行显示目录**：列表是**跨目录**的（agent 侧，用户的截图里 245 条），而此前只能靠 hover
     才知道各自属于哪个项目。行右侧加 `.outline-cwd`（只显示最后一段，全路径在 tooltip 里）。
- **顺带加的工具**（`check-webview-client.mjs --fix`）：本轮我在客户端模板的注释里**第 7 次**写下反引号，
  而修法永远是同一个机械动作。按 pitfall #11 自己的教训——**「能自动化的纪律就不要留给记忆」**——
  给检查器加了 `--fix`：把**模板体内**（只在模板体内；文件头注释里的反引号不受影响）的反引号就地
  换成单引号，然后照常校验。**做过负向测试**：注入 6 处 → 报错 → `--fix` → 只改了那两行、其余零改动。
  读写按 `'\n'` 切分拼接，因此 **CRLF 文件不会被转成 LF**（pitfall #7）。`--fix` 是手动用的，
  `check-registry.mjs` §5 与 CI 调它时**不带参数**，所以闸门仍然是"只报错、不改代码"。
- **验证方式**：`npm test` **39 passing**（本步新增 5 条：选中的目录一路传到 `createSession` 且随后真的发了
  prompt / 空草稿不建任何东西 / 建会话失败时回 `draftFailed` 且**不消费草稿** / 目录候选三个字段齐全
  且默认目录非空 / connect **只** `ensureConnected` 不建会话）。
  `check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` / `check-webview-client.mjs` 均通过。
- **待用户 F5 复验**（布局与交互无法自动测，见 `dev-workflow.md` 的分界线表；清单已加为 93-100 项）：
  ① `+` → 出现 `New session` 草稿页，头部目录可点、抽屉三组候选都在；
  ② 选工作区文件夹 / 任意目录 / 最近用过 → 发送 → 新标签出现、头部目录是它、**agent 在那个目录里干活**；
  ③ 草稿里**先打字再改目录** → 文字不丢；
  ④ 空态 Connect → 也是草稿页；agent 起不来时有明确报错；
  ⑤ 已发出消息的会话 → 头部目录只读、抽屉里点候选是"在新目录里开新会话"；
  ⑥ 历史列表每行右侧能看到目录；
  ⑦ 键盘：Tab 到 `#cwdBtn` → Enter → 点击项 → 关闭（Esc 也行）；
  ⑧ 正常会话的发/停/running 状态、标签切换、`+` 之后立刻发送，都不受影响。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-056/057（每会话工作目录：探针闸门 + 宿主侧落地）
- **功能**：**每会话工作目录**——顺带修掉历史选择器丢 cwd 的现网 bug，并让 `acpc.defaultWorkingDirectory` 真正生效
- **改动文件**：**新增** `CUSTOMIZATIONS/scripts/probe-session-cwd.mjs`、**新增** `src/test/fixtures/session-cwd-probe.json`、`src/core/SessionManager.ts`、`src/core/SessionHistoryStore.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要「在新会话页面上切换该会话的工作目录」。多标签并发会话从 010 起就能用，缺的只是
  **每页有自己的目录**——而 `getWorkspaceCwd()` 硬编码"工作区第一个文件夹"，被四处调用点各自调用。
- **详细说明**：
  1. **先做闸门（056）**：ACP 把 cwd 定义成**会话级**属性（`NewSessionRequest.cwd`："The working
     directory for this session"），但本扩展 `spawnAgent(name, config, workspaceCwd)` 是把**进程** spawn
     在工作区的。**若适配器沿用进程 cwd，就必须按 (agent, cwd) 分进程**（`agentProcesses` 的键要变），
     量级完全不同——所以先用探针实测，不猜。探针是非对称设计、一次就够：两个临时目录 A（进程 cwd）/
     B（会话 cwd），各放一份**同名不同内容**的 `which-dir.txt` 与一个**只在一边存在**的文件；用 cwd=A
     拉起 agent 后 `session/new({cwd:B})`，让 agent 跑 `pwd`/`ls -1` 并读**相对路径**。判定机械——标记
     字符串只会出现在输出里。**结论 `honours-session-cwd`**：`pwd` 报会话目录、`ls` 只看到会话那边、
     读相对路径得到会话那边的标记，**进程目录的标记一个都没出现** ⇒ 只需改一条链。
     **两个附带发现（都推翻了一个合理假设）**：`terminal/create` 与 `fs/read_text_file` 各被调用 **0 次**
     ——Claude Code 的 `Terminal`/`Read File` 是**适配器自己执行**的，不走客户端能力。因此每会话目录
     **不依赖**我们的 `TerminalHandler`，而 `FileSystemHandler` 的「优先返回未保存编辑器缓冲区」对它
     **从不生效**。
  2. **cwd 成为一等属性（057）**：`getWorkspaceCwd()` → **`resolveDefaultCwd()`**（公开，三级回退：
     `acpc.defaultWorkingDirectory` → 第一个工作区文件夹 → `process.cwd()`；**相对路径或不存在的目录被
     拒绝并记日志**，不交给 agent——坏 cwd 会让 `session/new` 在适配器深处失败）。
     `createSession(agent, {focus?, cwd?})` 的 cwd 可选，并作为**进程 spawn 的偏好**传给
     `ensureConnected`（只影响首次 spawn）。`loadSession`/`resumeSession`/`openExistingSession` 接受
     cwd，解析顺序是「调用方给的 → **本地历史缓存里那条会话自己的 cwd** → 默认」——**这修掉了一个
     现网 bug**：历史选择器展示的是 agent 侧跨目录的 `session/list`（用户截图里 245 条），而点开时宿主
     从不传 cwd，于是告诉 agent 的是**当前工作区**，一条属于别的项目的会话会被当成住在这里重开；行的
     `cwd` 早就取到了（只用在 tooltip 上）。客户端现在把该行的 cwd 一并回传（`data-open-cwd`）。
  3. **`acpc.defaultWorkingDirectory` 从死设置变真设置**：它此前在 package.json 里声明得齐齐整整，
     **而 `grep defaultWorkingDirectory src/` 零命中**——pitfalls #5 那个"声明了却没接线"的模式
     **第二次复发**，已加复发记录（判据：给每个 `acpc.*` 设置项 grep 一次读取点，没有读取点的要么接上、
     要么删掉）。
  4. **`pickDefaultCwd(...)` 抽成纯函数并导出**，`resolveDefaultCwd()` 只是它的 vscode 外壳——
     抽出来的理由是**可测**：直接驱动 `getConfiguration().update()` 写设置意味着测试要去改用户/工作区
     的真实设置文件。
  5. **`SessionHistoryStore.recentDirectories(agentName)`**（新）：为目录选择器的"最近用过"组提供来源，
     复用现成的 `list(agentName)`（不传 cwd = 全部）——它本就按 `lastActiveAt` 降序，所以**首次出现的
     目录就是它最近一次被用的时刻**。**作用域注意**：该 store 在 `workspaceState` 里，只记得**本工作区
     曾用过**的目录（058 会把它与 agent 侧的跨目录清单合并）。
- **验证方式**：`npm test` **34 passing**（本步新增 9 条：`pickDefaultCwd` 的三级回退与两种拒绝、
  `recentDirectories` 的去重/排序（用内存假 Memento，不碰任何真实设置）、历史选择器的 cwd 路由
  （用**记录型子类**而非手写桩））。`check-registry.mjs` 六节全绿；`tsc`/`lint`/`compile` 均通过；
  **上一轮的 replay 回归闸门保持全绿**——本步正好改了 `session/load` 的调用点，它是最直接的报警器。
  **人工验收**：`dev-workflow.md` 清单 90-92（设置项生效 / 相对路径被拒且记日志 / 跨目录会话用
  **自己的** cwd 打开）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-054
- **功能**：**让聊天面板可以自己测**——真实 ACP replay 抓包脚本 + 宿主侧协议流回归测试
- **改动文件**：**新增** `CUSTOMIZATIONS/scripts/capture-acp-replay.mjs`、**新增** `src/test/chat-panel.test.ts`、**新增** `src/test/fixtures/claude-code-session-load.json`、`CUSTOMIZATIONS/*`
- **来源**：用户提出「每次我手动看，这样测试效率有点低，有什么办法可以让你自己测试吗」
- **详细说明**：
  1. **`capture-acp-replay.mjs`（夹具生成器）**：用真实 agent 走
     `initialize → session/new → prompt（可多轮）→ session/close → session/load`，
     把**两段流**（live 与 replay）一起写进一个夹具文件。它实现了一个**最小但忠实**的 ACP client：
     能力集与扩展一致（`fs` 读写 + `terminal`，因为 agent 行为可能取决于宣称的能力），
     终端能力真的接 `child_process`（不实现的话 Claude Code 的 Bash 工具会让整轮失败），
     权限一律自动批准（否则抓包卡在等人点按钮）。**在一次性临时目录里跑**，绝不在仓库内跑。
  2. **`src/test/chat-panel.test.ts`**：在**真 Extension Host**（`npm test` 已经提供）里构造真实的
     `SessionManager` / `ConnectionManager` / `AgentManager` / `ChatPanelHost`，用桩 `ChatSurface`
     拦下宿主准备发给 webview 的每一条协议消息，再对夹具断言。**不需要 agent、不需要 webview、
     不需要额度**，所以它是 CI 能跑的。
  3. **测出来的两类问题**（都是它自己发现的，不是我读出来的）：
     ① 首次跑起来两条流都"丢正文"，根因是**测试脚手架**：宿主把 `append` 走合帧队列，
     只在 16ms 定时器或结构性消息前冲刷，同步测试必须显式冲刷——改用公开的 `onFocusChanged`
     （它**恰好就是"重新聚焦/重开"那条路径**，于是断言变成"重开会看到什么"，正是要测的东西）；
     ② 冲刷之后暴露出**真 bug**（见 055）。
- **设计取舍（写下来免得下一个人返工）**：
  - **不做 DOM 测试**。这一层能判定的三类问题（正文有没有被丢、有没有记录永远 streaming、
    快照与增量是否一致）全都在协议流上可判，而且这样测试不依赖 webview、跑得快、不会因布局细节而脆。
    **布局类问题**（空白条、条目被压扁、diff 被折叠、按钮化后外观错位）仍需另一层"真 webview +
    客户端回传 DOM dump"的测试——那层**没写**，所以在 `dev-workflow.md` 的验收清单里仍标着"需人工"。
  - 夹具里的 live 段有 ~935 条通知（含 487 条 thought），文件约 450KB。**刻意不裁剪**：
    手工裁剪等于把我对"什么重要"的假设塞回夹具里，而这份东西的价值恰恰在于它是**未经加工的协议事实**。
- **验证方式**：`npm test` 25 passing（其中 6 条来自本文件的 replay 套件）；
  `check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` 通过。
  夹具缺失时测试会给出可操作的失败信息（附重抓命令），而不是一个看不懂的断言失败。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-053/055
- **功能**：**修「重开会话后助手正文与推理块全部消失」—— 宿主侧 `isBlankText` 的返回值与它的名字相反**
- **改动文件**：`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户报「重新打开看到的会话有问题，跟实时看到的内容不一样」（图1 实时正常 / 图2 重开后助手正文与 Thought 块全没了）
- **定性过程（值得记下来，因为它把「猜」换成了「测」）**：
  1. 先确认两条重开路径本来就不同——`SessionManager.loadSession` 在**会话已 live** 时只 `focusSession`（客户端从宿主 store hydrate），**已关闭**时才发 `session/load`（transcript 由 replay 重建）。
  2. 写抓包脚本（`CUSTOM-20260925-054`）用真实 agent 抓一份 replay。**结论推翻了最初的假设**：
     replay **完整包含** assistant 正文与 `agent_thought_chunk`（两轮答案、markdown 表格都在）。
     所以不是"agent 不回放"，**是我们丢的**。
  3. 夹具喂进宿主侧测试 → 复现：`transcript had 8 records: user,tool,tool,tool,tool,tool,user,tool`
     —— replay 的 5 条 thought + 2 条 assistant 正文**一条记录都没建出来**。
- **根因**：`contentBlocks.isBlankText()` 的 `return true` / `return false` **写反了**。
  它的名字、它的文档注释（"True when this text would render as something the reader can see" ——
  恰好描述的是**正确**极性）、以及**客户端的同名副本**（`toolCallView.isBlank`）**三者都是对的**，
  只有这个函数体是反的。`isBlankText('abc')` 返回 `true`，`isBlankText('   ')` 返回 `false`。
  调用点的语义是「看不见就不建记录」（`if (!merges && isBlankText(text)) return null;`），
  判据反过来就成了**「看得见就不建记录」** —— 每个*新开一条记录*的真切正文分片被丢掉，
  空白分片反而被保留。
- **为什么它藏了整整一天（026 → 055）而所有自动检查全绿**：
  **实时路径靠巧合是对的**。实时流里 agent 先发一个换行/空白分片当分隔符，按反了的判据它"不是空白"
  ⇒ 记录被建出来；之后真切正文走**合并**分支（`merges === true` 时那个守卫被整段跳过）⇒ 正文正常追加。
  而 replay 是**单块真切正文、前面没有空白分片** ⇒ 记录直接被丢。
  **这就是"实时好、重开坏"的全部原因。**
  另外，`''`（空串）走的是 `if (!text) return true;` 这个**提前返回**，而它是对的 ——
  所以 026 针对"空文本块"的那半修法确实生效了，而针对"纯空白分片"的那半**从未生效**。
- **修法**：把两处 `return` 对调，并把文档注释改成描述真正的语义（"True when this text would render
  as nothing"）。同时给 `session-load-end` 补上收尾（见下）：
  replay 是**有限**的流，结束后不可能还有东西在流式——但没有任何东西会关闭它建出来的记录
  （`finalizeTurn` 只为我们自己发出的 prompt 跑，`session/load` 不是）。不补的话最后那条助手记录
  会永远停在 `streaming: true`，把客户端的 `aria-busy` 钉在 true、**读屏从此静默**。
- **防复发**：`src/test/chat-panel.test.ts` 新增 `isBlankText polarity` 套件，五组用例
  （空串 / 纯空白 / 零宽字符 / 可见字符 / **夹具里每一条真实正文分片都不得被判为空白**）。
  最后一组是**用真实数据**而不是我编的用例——被误分类的正是那批字符串。
- **验证方式**：`npm test` **25 passing**（新增 10 条）；`check-registry.mjs` 六节全绿；
  `check-webview-client.mjs` / `tsc` / `lint` / `compile` 均通过。
  **待用户 F5 复验**：关掉那个会话再重开 → 助手正文与 Thought 块应当都在，与实时视图一致。
- **基于上游版本**：0.2.0（commit e7371659）
- **同轮的另一处收尾（053）——独立缺陷，**不是**上面症状的原因**：`user_message_chunk` 到达时
  **没有东西关闭仍在流式的助手记录**，而 legacy 面板一直这么做（"finalizes pending assistant turn"）。
  后果：replay 路径上若某条助手记录后面没紧跟工具调用，它会**永远停在 `streaming: true`**
  （`finalizeTurn` 只为我们自己发的 prompt 跑），于是客户端一直当流式渲染、而 048 新加的 `aria-busy`
  被钉在 true、**读屏从此静默**。修法：在 `appendUser` **之前**补
  `finalizeEntries(sessionId, {only:'assistant'})`，并在 `session-load-end` 时补 `finalizeEntries()`
  （replay 是**有限**流，结束后不可能还有东西在流式）。**INV-I**：replay 路径上不许留下
  `streaming: true` 的记录——测试里的 `no entry is left dangling as streaming` 是它的守卫。

### 2026-09-25 - CUSTOM-20260925-043..052（面板审计：性能 / 交互无障碍 / 清理）
- **功能**：把面板审计里"查到但没修"的问题**全部落地**（阶段 1 的四条正确性修复见 038-041）
- **改动文件**：`src/ui/chat/html/client/`（toolCallView / transcriptView / outline / rail / tabs / composer / links / boot / sessionMenu / dom / **新增 directoryMenu**）、`src/ui/chat/nesting/ClaudeCodeNesting.ts`、`src/ui/chat/transcript/ToolInvocationStore.ts`、`src/ui/chat/content/*`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/protocol.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：面板审计（逻辑 / 性能 / 交互 / 无障碍四面）一次做完，分三档落地
- **详细说明（按档）**：
  - **性能（043-046）**
    - **043 嵌套推断去重复序列化**：`payloadContains` 曾对每个候选父调用 `JSON.stringify` 其
      `rawOutput`/`_meta`（上限 200KB），而 `apply()` 在**每次 `tool_call_update`** 上全量重算——
      宿主聊天链路最贵的一件事是反复序列化同一个没变的对象。改为按**载荷对象本身**缓存的 WeakMap
      （存**已切到 MAX_SCAN_CHARS 的串**，语义不变、内存上界 min(载荷, 200K)），安全前提是 `upsert*`
      **整体替换**字段而非就地改（引用变化即失效信号，不需要版本号）；`isTaskLike` 同样备忘。
      `ToolInvocationStore.list()` 去掉 `.sort`——`Map` 本就是插入序、`startedAt` 插入时打戳不改，
      两种序**按构造同一个**，那个排序是每次工具通知都付的 O(n log n) 空转。
      **刻意不加每会话容量上限**（原计划有一条）：`snapshotOf` 从本索引补水视图模型，淘汰一条记录仍在
      transcript 里的调用正好会渲染出 027 消灭掉的"空壳卡片"；安全上限要从宿主推入引用计数
      （与 `TranscriptStore.setLiveSessionIds` 对称），是独立改动——理由写在类注释里。
    - **044 工具路径并入 rAF 合帧 + 补掉 040 的自查缺口**：`toolCallView.update()` 末尾原本**同步**跑
      整条 transcript 的 `querySelectorAll`，而命令每输出一片就推一次更新；合帧器搬进**拥有**
      `refreshGrouping` 的 `toolCallView`，两条路径共用一份（`transcriptView` 留一层薄委派）。
      同时修 040 留下的**陈旧渲染缺口**：`bodySignature` 原用**字符串长度**判变化，同长度改写会跳过
      重建、把旧内容永久留在屏幕上 → 改为 FNV-1a 哈希（256K 以内 O(n)；超阈值返回 `null` 走 040 已建立
      的"无条件重建"逃生门，**语义永不退化**）。
    - **045 抽屉锚点扫描降 O(1)**：`outline.invalidate()` 在每个 append/revise 上都调 `syncButton()`，
      而它是遍历全条目列表；改为 `transcriptView` 维护 user 条目计数器（`place()` 是唯一新增入口，
      `patch` 从不改 `kind`，所以计数不会漂）。rail 早就是这么做的，抽屉是漏网的那一处。
    - **046 删掉常驻的 TEMP 诊断**：036/034 装的 `checkTextless` 等约 98 行，每新增一条记录就起 4 秒
      定时做**全量 getBoundingClientRect 走查**（未命中时还会反复测量，`dumpStructure` 还会跑
      `getComputedStyle`）。白条真根因 037 已修，这套只剩成本。**若白条复发：先量几何，不要先怀疑数据**
      （要用时按显式开关装轻量版，别让它常驻）。
  - **交互与无障碍（047-051）**
    - **047 键盘可达性**：标签 / 抽屉行 / 菜单项 / 斜杠项 / 工具卡头 / diff 头 / chip / 引导条点全部从
      `div`/`span` 换成真 `<button type="button">`——**Enter/Space 由浏览器原生触发 click**，
      所以委托式 click 处理器一行未改就同时支持键盘（比补 keydown 分支更不容易漏）。CSS 加"抹平 UA
      按钮样式"的基础设施（**必须放在各 class 规则之前**才保持外观一致）+ `:focus-visible` 焦点环
      （面板此前完全没有焦点样式）。标签栏补 `aria-selected` + roving tabindex + ←/→ + Delete；
      引导条同样 roving tabindex（标记可能几百个，逐个进 tab 序列会让 Tab 彻底失效）；
      `aria-expanded` 跟着卡头展开态；接上**从未被调用**的 `focusInput()`（文档获焦且用户未在选字时
      把光标放进输入框——否则 `acpc-chat.focus` 键绑定只完成一半）；打不开的 `resource_link`
      渲染成 `<span>` 而非 `<button>`（不能点就不该占 tab 停靠位）。
      **过程记录**：初版给 `.tab` 写了 `width: 100%`，而它是 flex 行子项——会解析成"容器内容宽的
      100%"而容器宽又由子项决定（循环），标签栏会变形；已摘出并写明原因。
    - **048 流式播报**：`#messages` 加 `role="log"` + `aria-live` + `aria-relevant="additions"`，
      并由 `transcriptView` 用**计数器**驱动 `aria-busy`（有任一条在流式就 busy，辅助技术推迟播报、
      结算后整段念一次）。直接加 `aria-live` 会让读屏把逐片重写的回答从头念几十遍。
    - **049 附件拖拽**：新增**会话作用域**消息 `attachPath`（守卫**之后**处理）；`text/uri-list`
      （VS Code 内部拖拽，主用例）+ `files[].path` 两级取路径，**两者都拿不到时明确发 error 通知**
      而不是静默；宿主侧把"加入待发附件 + 广播"抽成 `addAttachments` 共用，**拖拽路径刻意不 reveal
      任何 surface**（拖拽本就在可见面上）。粘贴图片暂不支持（剪贴板图是 Blob、无路径，落盘需要受管
      附件目录 + 清理策略，属另一功能）。**过程记录**：路径解析最初写成含转义斜杠的正则，被检查器报了
      一个位置完全对不上的语法错误——因为该检查器按**原始模板文本**解析、不还原转义（pitfalls #11 第四次
      复发）。已改成不含反斜杠的码点判断，并写成客户端纪律第四条。
    - **050 输入与观感**：①按会话记忆草稿（原先切会话 `input.value = ''`，切去另一标签看一眼就丢）；
      `stashDraft()` **必须在 `state.sessionId` 改写之前**调用，否则退场会话的草稿会记到入场会话名下；
      恢复也**只在真的换了会话时**做（对同一会话重设 value 会把光标移到末尾，而"重设同一会话"会发生）。
      ②编辑区面改用编辑器底色（标记里写 `<body class="surface-*">`，CSS 里**只有** `.surface-editor`
      的覆盖规则，侧边栏面不能加）。③`prefers-reduced-motion` 关掉 pulse/spin。
    - **051 代码块语言标签**：`SafeMarkdown.code` 早在输出 `data-lang`，界面从未用过。标签放左上角
      （右上角归 Copy）、`pointer-events: none`，**只有带语言的块**才让出顶部内边距（否则普通代码块
      凭空多一条空白）。**刻意不引入高亮器**——那要加依赖并改 CSP。
  - **清理（052）**：删零引用死代码（`dom.esc`+`ESCAPES`、`toContentViews`、`TranscriptStore` 的
    `sessionHasContent`/`listSessionIds`/`size`/`entriesNeedingMarkdown`、
    `ToolInvocationStore.dropAgentSessions`）——每处都先 grep 复核。`dom.esc` 删除处留了
    "**不要补回来**"的说明（通用转义助手是"用字符串拼 HTML"的邀请函）。
    `toolCalls.ts` 的 `statusGlyph`/`statusClass`/`kindLabel` **保留**（宿主侧拼写，将来的日志/树项会要）
    但加注释「**改一处必须改另一处**」并点明这正是 038 那类漂移的温床；`styles.ts` 的
    `.tab-dot.attention` **保留**并注明「设计预留、从未接线，看到没生效别当 bug 修」。
- **本轮自查出的 3 处缺口**（都已回写）：040 的长度签名（044 修）、049 的正则转义、以及各处被
  `check-webview-client.mjs` 抓到的模板反引号（后来做成了 `--fix`，见 058）。
- **验证方式**：`npm test` 全绿（本阶段 25 → 34 passing）；`check-registry.mjs` 六节全绿；
  `check-webview-client.mjs` / `tsc` / `lint` / `compile` 均通过。
  **人工验收**：`docs/dev-workflow.md` 清单 71-89（键盘路径、读屏、拖拽、草稿、语言标签、性能回归，
  以及"外观与改动前逐处比对"——按钮化最容易出问题的是内边距与对齐）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-042
- **功能**：拆分 `architecture.md`——把原 §5（新 Chat 面板子系统）移入 `docs/arch/chat-panel.md`
- **改动文件**：`CUSTOMIZATIONS/architecture.md`（539 → 244 行）、**新增** `CUSTOMIZATIONS/docs/arch/chat-panel.md`（332 行）、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`、`src/ui/chat/ChatEditorPanel.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/ui/chat/content/contentBlocks.ts`（后三者**只改注释里的引用路径**，无行为变化）
- **来源**：面板审计（阶段 1）顺带发现的机制违规——`architecture.md` 达 539 行，而它**自己在文件头写着**
  「**体量铁律**：超过 ~400 行即拆分——保留 §0 / §0.5 / §1，各模块细节拆到 `docs/arch/<module>.md`」。
  这条铁律的存在理由很具体：该文件被 `AGENTS.md` 列为每次任务前必读，**它每长一行就是每个会话都要付一次的上下文税**。
  （拆分的先例就在这个仓库里：`registry.md` 曾因为同样原因把 42KB 的变更日志拆到 `docs/changelog.md`。）
- **详细说明**：
  1. 原 §5 共 12 个小节（§5.1 文件职责 … §5.12 面板审计），313 行，**占全文 58%**，整体移入新文件。
  2. **关键决策：`§5.x` 的编号原样保留**。全仓库有几十处「§5.4」「§5.10」引用，散落在
     **代码注释**（`ChatEditorPanel.ts` / `ChatRouterProvider.ts` / `contentBlocks.ts`）、
     `registry.md`、`AGENTS.md` 里。重编号会把它们全部变成指向空处的雷，而拆分的目的是**省上下文**，
     不是整理编号。因此拆分只做「换文件名」，引用只需把 `architecture.md` 换成 `docs/arch/chat-panel.md`
     ——**这是本次拆分唯一需要小心的操作，也是它最容易被漏的一步**（注释里的引用不会被任何检查器发现）。
  3. 拆分的边界写在新文件头上：主文件保留 §0（架构图）/ §0.5（任务路由）/ §1（文件职责速查）/
     §2–§4（反查、链路、契约），即**「读到该改哪个文件」所需的全部**；
     按需加载的是**「改 `src/ui/chat/**` 时才知道要读的东西」**（为什么长这样、哪些不变量破了
     不会有任何自动检查报错）。下次再超 400 行时，§2–§4 是下一个拆分对象。
  4. `AGENTS.md` 的「文档更新职责」表加了指向：改 `src/ui/chat/**` 时除 `architecture.md` 还要看
     `docs/arch/chat-panel.md`。`registry.md` 的 `CUSTOMIZATIONS/` 目录清单补上 `docs/arch/chat-panel.md`。
  5. `.vscodeignore` **无需改动**：`CUSTOMIZATIONS/**` 已整体排除，新增的是其**子目录**而非顶层目录。
- **验证方式**：`check-registry.mjs` 六节全绿（exit 0）；`npx tsc --noEmit`（改了 3 个 `.ts` 的注释）；
  `npm run lint` 通过。人工核对：`grep -rn "§5" src/ CUSTOMIZATIONS/ AGENTS.md` 的输出里，
  除 `docs/arch/chat-panel.md` 自身与 `check-registry.mjs` 自己的「§5」（那指脚本的第 5 节，与本文件无关）
  以及 `docs/changelog.md` 的**历史条目**（append-only，按规矩不改写）外，全部已指向新文件。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-038..041（面板审计·阶段 1：正确性）
- **功能**：面板审计（逻辑/性能/交互/无障碍四面）后落地的**四条正确性修复**——保守档，可单独验收
- **改动文件**：`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/Outbox.ts`、`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/toolCallView.ts`、`CUSTOMIZATIONS/*`
- **详细说明**：
  1. **038 · 修「plan 卡永不更新」**：协议层的 `EntryPatch.plan` / `.content` 与**记录层的字段名**
     `entries` / `blocks` 不一致，客户端 `PATCH_KEYS` 照抄了协议层的名字 ⇒ patch 写进 `entry.plan`
     而 `buildPlan()` 读 `entry.entries`，**更新被静默丢弃**（`patch()` 对不认识的键不报错）。表现是
     Claude Code 的 Todo 列表永远停在第一次快照、切走再切回才对。四处统一到**记录字段名**
     （`types.ts` / `TranscriptStore.patch` / `ChatPanelHost` 的 plan 分支 / 客户端 `PATCH_KEYS`）；
     `content` 那条是**潜伏**缺陷（当时无调用点）一并改掉。**这类错位 tsc/lint/webpack 全看不见**
     （字符串字面量），已回写 pitfalls。
  2. **039 · 修 resource_link 走文件通道**：chip 此前一律写 `data-href` → 落到 `openLink` → 被协议
     白名单拦下，点本地文件只弹 Blocked link 警告。改为在**宿主侧** `contentBlocks.localPathOf()` 判定
     （`file:` 走 `node:url` 的 `fileURLToPath`；裸路径/相对路径原样；**Windows 盘符必须先于 scheme
     判定**，因为 `C:\x` 符合 URI scheme 的语法），客户端按 `path` / 可放行协议 / 两者都不是，分别渲染
     `data-path` chip / `data-href` chip / **静态 chip**（新增第三态：没有可用打开方式就不该长成可点的
     样子）。顺带把 `handleOpenFile` 解析相对路径的依据从 `this.focused.sessionId` 改为守卫校验过的
     消息 sessionId。
  3. **040 · 工具卡 body 单点构建**：两个同根缺陷——`render()` 与 `update()` **各写了一遍 body 构建**，
     于是 `locations` 在 update 路径既不会补上晚到的、还会被 `clear(body)` 清掉；`renderDiff` 每次以
     `body.hidden = true` 新建 ⇒ 用户展开的 diff 被下一次更新合上（而命令每输出一片就推一次更新）。
     抽出 `fillToolBody()` 单点构建 + `captureExpansion`/`applyExpansion` 按 `data-expand-key` 搬运
     展开态；加 `bodySignature` 跳过"只改了 head 里 status"的无谓重建。**签名刻意不序列化 payload**
     （图片的 data URI 是 MB 级）：遇 image block 返回 `null` = 不可缓存、宁可多建一次；非图片 block 把
     渲染函数读的**每个**字段纳入签名（漏一个 = 卡片永久陈旧，即 INV-H）。
  4. **041 · dispose 完整化 + outbox 单轮统计**：`ChatPanelHost.dispose()` 补上
     `sessionUpdateHandler.removeListener`（legacy provider 是注销的，此前只是碰巧被
     `SessionUpdateHandler.dispose()` 兜住）；`Outbox.stats()` 从累计改为**单轮**（新增 `resetStats()`）
     ——累计会让 `merged/sent` 漂向长期均值、那行诊断随时间失去意义。
- **验证方式**：`check-registry.mjs` 六节全绿；`check-webview-client.mjs` / `tsc` / `lint` / `compile`
  均通过。**人工验收**：plan 卡随 TodoWrite 实时刷新 / 本地文件链接能点开且危险协议仍被拦 /
  locations 晚到的工具卡有 chip / 展开的 diff 保持展开 / outbox 日志每轮从 0 重新计。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-035
- **功能**：历史会话按钮的图标由文字字形 `↺` 换成**时钟图标**（内联 SVG）
- **改动文件**：`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「历史会话用这个 ↺ 图标合适，改成合适的」
- **为什么换**：`↺`（U+21BA）的通用语义是**撤销 / 刷新**，用在"打开历史会话"上会让人以为点了会重载当前会话。时钟是"最近 / 历史"最通用的形状。
- **实现**：复用 028 的内联 SVG 图标系统（`NS.icons`），新增 `history: [circle + hands]` 与 `historyIcon()`。**只用 circle 与直线**——按该文件既有的自定约束，弧线命令写错不会报错、只会画歪，所以宁可用基础图形拼。`sessionMenu.init()` 把按钮里预置的文字字形换成 SVG；**markup 里保留文字字形作为脚本失效时的兜底**（注释写明）。
- **顺带说明**：相邻的会话大纲按钮仍是文字字形 `☰`（三条横线）。两者都是单色线稿，视觉上基本一致；若希望严格统一，把 `☰` 也换成 SVG 只是一行（图标系统已经就位）——**本轮没动**，避免超出用户要求。
- **验证方式**：`check-webview-client.mjs` 通过（13 个客户端模块 + 19 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：标题栏出现时钟图标（14px，跟随主题色），与 `☰` 并排；hover 提示仍为 "Open a previous session"；点击行为不变。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-033
- **功能**：Chat 面板标题栏的历史会话选择器（↺），点一条即打开
- **改动文件**：`src/ui/chat/html/client/sessionMenu.ts`（新增）、`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/core/SessionManager.ts`、`src/extension.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「Chat Panel 上需加上查看/选择历史 Session 的按钮（只需处理 Claude Code 面板）」
- **数据源顺序（有讲究）**：**未连接时先用本地缓存**，因为 `SessionManager.listSessions` 内部会 `ensureConnected`——**为了渲染一个菜单而 spawn 一个 agent 进程**是不合理的；已连接时以 agent 侧列表为准（权威、且包含本窗口没见过的会话）。两者都排除**当前 live 的会话**（那些已经在标签行里了）。回复消息带 `source: 'agent' | 'local'`，浮层头部会写明来源，避免"为什么少了几个会话"的困惑。
- **打开方式收敛到一处**：新增 `SessionManager.openExistingSession(agentName, sessionId)`——优先 `session/load`（重放历史，面板因此有完整记录），退化为 `resume`（此时在面板里补一条 notice 说明"历史未重放"）。**`acpc.openSession` 命令改为调用它**，替掉原来内联的 caps 判断：两处各持一份决策迟早会漂移成"面板和树打开方式不一样"。
- **协议**：三条消息**都刻意不带 `sessionId`**（要用它们时往往根本没有聚焦会话），因此都在 `verifySession` 守卫**之前**处理——这正是 §5.4 规则二的适用场景。
- **非目标**：不做搜索/过滤、不做分页（agent 侧 `nextCursor` 先忽略）、不做跨 agent 的会话列表（面板只服务 modern agent）。
- **验证方式**：`check-webview-client.mjs` 通过（13 个模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：⑥ 标题栏 ↺ 拉出历史列表，头部写明来源与条数；⑦ 点一条 → `session/load` 重放，面板出现完整记录（`ACP Traffic` 里有 `session/load`）；⑧ 未连接时点 ↺ → 只列本地缓存、**不 spawn agent**（`ACP Traffic` 里没有 `initialize`）；⑨ Esc 关浮层不取消轮次。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-032
- **功能**：Chat 面板空态加「Connect Claude Code」按钮
- **改动文件**：`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/sessionMenu.ts`（新增）、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「Chat Panel 上需加上连接按钮（只需处理 Claude Code 面板）」
- **行为**：空态（没连接 / 没聚焦会话）一键连接，不必先去 Agents 视图。走 `connectToAgent` 而**不是** `newConversation`——已有会话就聚焦它，没有才建一个：这才是"连接"该有的语义（`+` 按钮负责"开新的"，两者互补）。
- **agent 名怎么来**：消息不带 agentName（客户端在空态时无从得知），由 host 的 `panelAgent()` 兜底顺序决定：显式传入 → 聚焦 agent → `MODERN_AGENTS` 里的第一个。
- **已知硬编码**：按钮文案 `Connect Claude Code` 写死在客户端常量里（modern 面板按设计就是 Claude Code 专用）。若将来出现第二个 modern agent，这个字符串应当改由 host 下发——注释里写明了这一点。
- **验证方式**：`check-webview-client.mjs` 通过；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：① 未连接任何 agent 时面板空态出现按钮；② 点一下 → Claude Code 被拉起并出现一个新会话标签（`ACP Traffic` 里有 `initialize` + `session/new`）；③ 已有会话时点它 → 只是聚焦，不新建第二个。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-031
- **功能**：编辑区 Chat 面板**不再依赖侧边栏**——点侧边栏按钮直接打开，不再弹「Claude Code only」
- **改动文件**：`src/ui/chat/ChatEditorPanel.ts`、`src/ui/chat/ChatRouterProvider.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户实测反馈（截图：点 030 新加的侧边栏按钮弹信息提示），要求「点击后直接打开面板，先评估可行性」
- **根因（提示是误报）**：门禁判的是 `isModernAgent(context().agentName)`，而 `context()` 取**当前聚焦会话**的 agent。`activeSessionId` 为 null 时（**窗口重载后、或没点过任何会话**）它就是 null → 判 false → 弹提示。误导性来自状态栏：
  ```ts
  const agentName = activeSession?.agentDisplayName || connectedAgents[0];  // ← 没有活跃会话时退化成"第一个已连接的 agent"
  ```
  **状态栏写着 Claude Code 并不代表它被聚焦**（030 之后它恰好又排第一），所以看起来"明明就是 Claude Code 却被拒"。
- **修改（三处，缺一不可）**：
  1. `open()` 门禁：只在**存在聚焦 agent 且它不是 modern** 时拒绝——那才是这条门禁要防的情况（防止显示别的 agent 的陈旧内容）；**没有聚焦 = 放行**。
  2. `syncActivePanel()` 的关闭条件同步放宽：只在**聚焦到 legacy agent** 时 `close('focus-changed')`。**只改第 1 处不改这里会留下最坑的一种表现**：刚打开，下一次 `active-session-changed`（`panelIdForFocus()` 在无聚焦时返回 'legacy'）就把它关掉。
  3. 无聚焦会话时 `focusMostRecentModernSession()`：复用面板 agent 选择器那套逻辑（`getSessionIdsForAgent(name)` 取最近一个 → `focusSession`），打开即有内容。**刻意不自动建会话**——「打开面板」不该 spawn 一个 agent 进程；空面板是合法结果，面板里的 `+` 一键开新会话（024 已修）。
  另外 `open()` 在创建面板前会**重新读一次 context** 作为 boot 快照，否则会拿到自动聚焦之前的空上下文。
- **不变量改写**：§5.7 从「编辑区面存在 **⟺** 聚焦 agent ∈ modern」改为 **⟹**
  （「聚焦 agent **若有**」），并把"为什么无聚焦是安全的"写进文档——否则下一个人会照 ⟺ 把它改回去。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功；`check-webview-client.mjs` 通过。
  **待用户 F5 复验**：② 重载窗口后（不点任何会话）直接点侧边栏按钮 → 面板打开且**自带内容**（自动聚焦到 Claude Code 最近的会话，输出通道有 `no focused session; focusing Claude Code's most recent`）；③ 焦点切到非 Claude Code 会话 → 编辑区面板仍会**自动关闭**（这条不变量必须保住）；④ 完全没连接任何 agent 时点按钮 → 面板打开并显示空态，不弹提示。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-030
- **功能**：① 侧边栏 Agents 视图标题栏加「在编辑区打开 Chat 面板」按钮；② `Claude Code` 固定排到 agent 列表第一位
- **改动文件**：`package.json`、`src/config/AgentConfig.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「希望在左侧边栏（ACP Client）里加一个直接打开 Editor Area 区 Chat 面板的按钮」「左侧边栏，把 Claude Code 移到第一位」
- **① 侧边栏按钮**：`acpc.openChatInEditor` 此前只挂在 `acpc-chat` 视图的标题栏（025 加的）——那个视图在侧边栏里可能被折叠或滚出视野。现在也挂到 **`acpc-sessions`（Agents）视图**的标题栏（`group navigation@0`，最左），因为它在容器顶部、任何时候都看得见。同一个命令两处入口，不改代码。
- **② Claude Code 置顶**：agent 顺序来自 `acpc.agents` 的**键序**，而 `Claude Code` 原本排在 `GitHub Copilot` 之后，用户自建配置更容易把它排到后面。改两处：
  - `package.json` 的**默认列表**把 `Claude Code` 提到第一位（新装/未自定义配置时生效）；
  - `AgentConfig.getAgentNames()` 做一次**稳定**调整：只把主用 agent 提到最前，其余保持原顺序——**不做全排序**（那会打乱用户刻意安排的次序），这样即使用户覆盖了 `acpc.agents` 也仍然生效。
  与 `panelContract.MODERN_AGENTS` 是两件事（那个管「哪些 agent 用新面板」），取值相同但理由不同，刻意不合并。
- **验证方式**：`node -e` 复核默认列表顺序（`Claude Code | GitHub Copilot | …`）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：⑳ Agents 视图标题栏最左出现图标按钮，点击打开编辑区面板；⑴ 树里 `Claude Code` 在第一位。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-029
- **功能**：① 修复类型图标可能影响全局排版的风险（改为挂进气泡 + 写文本的两条路径保留它）；② 新增 webview → 输出通道的**日志桥**；③ 加一条"白条"TEMP 诊断
- **改动文件**：`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户报告「问题更严重了，全变成了白条」——**这是一次回归报告，而我在 028 之后无法仅凭代码复现**，因此本轮做三件事：消除首要嫌疑、加可观测性、请用户回传一行日志
- **① 撤销布局改动（首要嫌疑）**：028 为了让助手的图标躲开"文本被整段重写"，把它挂到了**条目外层**并给 `.entry-assistant` 加了 `flex-direction: row`——**这是 028 里唯一会影响所有助手记录排版的改动**。现在改成：图标仍挂**气泡内**，由两条写文本的路径（`setStreamingText` 的整段替换分支、`setSanitizedHtml` 的 markdown 落地分支）用 `takeIcon`/`putIcon` **保留并还原**它。**不再有任何布局改动**——这既消掉了嫌疑，本身也是更稳的做法（图标位置与文本同源，不依赖条目结构）。
- **② 日志桥 `clientLog`**：webview 的 `console.warn/error` 与未捕获错误转发到 `ACP Client (Custom)` 输出通道（上限 50 条，防刷屏）。存在的理由：**webview 控制台不开 DevTools 就看不见**，而"界面为什么不对"的排查已经在这上面卡了两次（027 的空壳工具卡、本次的白条）。这是一条**永久**能力，不是临时补丁。
- **③ 白条诊断**：`hydrate` 结束时若**过半的非用户记录渲染后没有任何文本**，就打一条带 kind 直方图的 warn（经日志桥上到输出通道），例如 `hydrate: 38/40 non-user entries rendered without text (kinds: assistant:12,tool:26,thought:2)`。用户气泡充当对照组——报出正值即说明记录本身丢了内容，而不是"看起来空"。
- **非目标**：不猜白条的根因（已排除 CSS 括号失衡、非工具路径的代码改动、图标挂载点三处）；等诊断数据。
- **验证方式**：`check-webview-client.mjs` 通过（12 个客户端模块 + 18 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：① 助手/用户/推理/计划的图标都在且颜色跟随主题；② 助手气泡**宽度仍占满**、**流式输出时图标不消失**；③ **若仍出现白条**，输出通道里会出现 `chat-panel: client(warn): [acpc] hydrate: N/M non-user entries rendered without text (kinds: …)` —— **把这一行发我**，它就是答案；若没有这一行，说明渲染出来的记录其实**有**文本，那么"白条"另有来源（那时请顺手把 `#messages` 的头几条 `className` 发我）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-028
- **功能**：给每类记录加一个内联 SVG 类型图标（用户 / 助手 / 推理 / 工具 / 计划 / 通知）
- **改动文件**：`src/ui/chat/html/client/icons.ts`（新增）、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「参考图中（Claude Code 官方扩展的对话区），加个小图标标记不同类型的记录」
- **为什么是内联 SVG 而不是 codicon 字体**：webview 的 CSP 是 `default-src 'none'`，用图标字体要额外加 `font-src` 并把字体文件随扩展打包发布（还要动 `.vscodeignore`）；而 **SVG 元素不受 CSP 限制**——CSP 管的是 `<img src>` / 字体 / 脚本，不管文档内的 SVG 标记。`stroke="currentColor"` 还能自动跟随主题与所在文字颜色（用户气泡=按钮前景色、推理=次要色）。
- **挂载点是按「谁会被重写」选的**（这是本轮唯一容易做错的地方）：
  | 记录 | 图标挂哪 | 为什么 |
  |---|---|---|
  | 助手 | **条目外层** `.entry-assistant`（配 row 布局） | 气泡文本被流式更新整段重写，markdown 落地还会 `innerHTML` 覆盖——挂气泡里每片都会被抹掉 |
  | 推理 | `summary` | body 每片重写；`summary` 只在收束时重写一次，而那条路径已改成**保留 `.rec-icon`** |
  | 工具 | 卡头内（`toolCallView.render` 建） | 卡头从不整块清空（`update` 只改 status/kind/title 三个 span） |
  | 用户 | 气泡内 | 用户消息只追加不重写，最省事 |
  | 计划 / 通知 | `.plan-title` / 条目本身 | 计划重建时补挂（`attach` 幂等）；通知不重写 |
  | **不加** | `content` / `permission` | 前者已有图片/chip 形态，后者自带 `?` 角标——再加图标是噪声 |
- **非目标**：不做「按工具 kind 区分图标」（Read/Edit/Run…）——卡头已有 kind 文字标签，图标区分度收益有限，先看这版效果。
- **验证方式**：`check-webview-client.mjs` 通过（**12** 个客户端模块 + 18 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第八、九、十、十一次**复发（`icons.ts` 两处、`transcriptView.ts` 两处的注释）——全部由检查器一次报全。
  **待用户 F5 复验**：㊿ 每类记录左侧有图标且颜色跟随主题；助手气泡仍是**占满宽度**的（row 布局别把气泡压成内容宽度）；推理块**收束后图标仍在**（`Thought for Ns` 前面）；流式输出时助手图标**不消失**（这条专门验证挂载点选对了）；工具卡头有图标且状态色正确。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260924-026/027 + CUSTOM-20260925-034/036/037（「白条」问题：四轮迭代）
- **功能**：修掉聊天面板里成串的空白条 / 空盒子 / 空壳工具卡——并在第四轮找到**真根因**
- **改动文件**：`src/ui/chat/html/styles.ts`、`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/`（transcriptView / toolCallView）、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈，四轮逐步收敛（每轮都带回了上轮诊断的日志或确定的复现步骤）
- **诚实说明（这一节最该先读的）**：四轮里 **037 才是真根因，而且从 011 起就存在**；
  026/027 修的是**真实但次要**的缺陷——它们解释的是"细窄无边框的白条"与"空壳工具卡"，
  而用户看到的大面积白条一直是 037。把这段留下来，是因为**下一个看到"界面是空的"的人，
  最该先量高度，而不是先怀疑数据**。
- **详细说明（按轮次）**：
  1. **026 · 成串空白条**（两种成因、两种外观，靠外观就能分辨）：
     - **细窄无边框** = `content` 记录。`agent_message_chunk` 文本为空时走 `postContentNotice`，而
       `toContentView({type:'text', text:''})` 返回的是一个**合法视图**（不是 null）→ 建出一条 `content`
       记录 → 渲染成空的 `.tool-text`（`margin: 3px 0`）。agent 把**空文本块当分片分隔符**发，所以成串出现。
     - **带圆角边框的空盒子** = `assistant` 气泡。工具调用后 agent 先发 `"\n\n"` 这类纯空白分片，此时上一条
       不是 streaming assistant，`appendAssistantChunk` 就**新建**了一条记录，气泡里只有换行；推理块同理
       （表现为一个**没有时长的 `Thought`**）。
     - 修法：`contentBlocks.ts` 新增 `isBlankText` / `hasVisibleContent`（判据排掉 `trim()` 能去掉的空白
       **以及零宽字符** U+200B..U+200D / U+2060 / U+FEFF——它们**不在** trim 范围内）；`postContentNotice`
       加守卫；`appendAssistantChunk` / `appendThoughtChunk` 加守卫（**合并进已有流式气泡仍然照旧**，段落
       换行就是这么来的，但不允许用空白文本**开启**新气泡）；客户端 `toolCallView.isBlank` 兜底。
     - **为什么不在客户端"把空块隐藏掉"了事**：那是把问题从记录层推到渲染层，记录里仍躺着一堆空条目
       （占 500 条上限的配额、让大纲/引导条多出无意义锚点、每次快照都要传输）。在**建记录之前**判断才是对的位置。
     - **本轮踩到的坑**（已回写 pitfalls）：想在正则字符类里写 `\u200b` 这样的转义，结果**工具链的转义层
       把它还原成了真字符**落进源码；改用 `node -e` 按码点定位时，shell 转义又把 `\s` 吃成了 `s`。最终改成
       **按码点判断、源码里一个反斜杠都不出现**，这类问题才根除。
  2. **027 · 空壳工具卡**：018 的注释自己写着「updateTool … can NEVER repair a shell」，但那次只给
     **append 路径**加了重建分支——而工具跑起来后绝大多数消息走 **`tool_call_update` → `updateTool`**，
     它**仍然只能打补丁**。于是卡片第一次落地时若没带上 view model，空壳永久留下。
     三层修法（**不赌数据在哪一侧丢**）：① `updateTool` 补上空壳重建分支；② 客户端 `place()` 遇到没有
     view model 的工具条目**不再渲染空壳**，改渲染一张由 `toolCallId` 拼出的最简卡片，并发一条**会话作用域**
     消息 `needToolView`，扩展侧 `resendToolView` **定向**回该面（自愈：不管数据在哪侧丢都能补回来）；
     ③ 索引里确实没有时记一行日志——**这正是以前查不出来的地方**（原来只有 webview console 的 `console.warn`，
     输出通道里什么都看不到）。顺带让 `update` 也能补 `.tool-kind`（占位卡的 "Tool" 要能变成真实 kind）。
  3. **034/036 · 诊断必须量几何，而且不能只在一条路径上跑**：
     - 034 把诊断从**只在 `hydrate` 跑**扩到实时会话（4 秒防抖 + `markdownRendered` 后）——
       **盯着一个实时会话的人永远不会触发 hydrate**，这正是用户上一轮查不到那行日志的原因。
     - 036 的**原理性修正**：上一版诊断数的是 `node.textContent`，而 **`textContent` 在元素被隐藏、裁剪、
       或处在 0 高度容器里时依然有值**——"文字在 DOM 里但没显示出来"它**永远抓不到**，而用户的截图恰恰是这种。
       判据改为 `getBoundingClientRect().height < 6px`（隐藏/裁剪的元素高度为 0，这是诚实的信号），
       并 dump 出前 8 条的结构（`kind | h | txt | cls | kid | fg | bg | fs | vis`）——有了颜色那一项，
       "文字色＝背景色"这类纯视觉故障也能一眼看出来。**这条比 bug 本身更值得记。**
     - 036 顺带修的真缺陷：`applyAssistant` 把 `html === ''` 当作"已渲染的 HTML"，于是 `setSanitizedHtml(bubble, '')`
       把气泡清空——**空字符串不是渲染结果**，现在回落到原始文本分支。（**这一条后来在 055 有了更深的解释**：
       `isBlankText` 的返回值是反的，见 055。）
  4. **037 · 真根因（CSS 规范，不是数据问题）**：**flex 子项的「自动最小尺寸」（`min-height: auto`）在其
     `overflow` 不是 `visible` 时等于 0**。而工具卡 `.tool` 恰好有 `overflow: hidden` ⇒ 没有最小高度保护
     ⇒ 内容一超出容器，flex 就把它们按比例压扁（用户那次是 206 张卡挤进 ~500px → 每张 2px，正好两条 1px 边框），
     卡片内容被 `overflow: hidden` 裁掉，`.messages` 的 `overflow-y: auto` 因此**永远不触发**。
     定性它的那行日志是：`[acpc] 206/207 non-user entries rendered shorter than 6px …  tool h=2 txt=201`
     ——**`txt=201` 而 `h=2`**：文字就在 DOM 里、可见性正常，但整张卡只有 2px。
     完整指纹（三条全部对上，也是"重开才坏"的原因）：
     | 元素 | overflow | 结果 |
     |---|---|---|
     | `.tool` 卡片 | `hidden` | 自动最小尺寸 0 → **被压成 2px = 白条** |
     | `.entry-user` / `.plan` | 无 | 自动最小尺寸 = 内容高度 → **压不动，显示正常** |
     | 新会话首次打开 | — | 条目少、不溢出 → 从不触发 |
     **修法**：`.messages > * { flex: 0 0 auto; }`（禁掉收缩），溢出改由 `.messages` 的 `overflow-y: auto` 承担。
     **对照**：`.tab-strip` 同样是 flex + overflow-x，但它的子项早就写了 `flex: 0 0 auto`（011 时写的），
     所以标签栏从没出过这个问题——**全项目只有 `.messages` 漏了**。
- **一套诊断最终被 046 删除**：白条真根因修掉后，`checkTextless` 那套常驻诊断（每新增一条记录起 4 秒定时做
  全量几何走查）只剩成本，已删。**若白条复发：先量几何，不要先怀疑数据**；要用时按显式开关装轻量版。
- **验证方式**：每一轮都过了 `check-webview-client.mjs` / `tsc` / `lint` / `compile`；
  最终由用户 F5 复验「关掉面板再打开那个 207 条的会话 → 所有工具卡正常展开显示、列表可滚动」。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-025
- **功能**：`acpc.openChatInEditor` 改为标题栏**图标按钮**（原来是一个宽文字按钮，与旁边的图标按钮对不齐）
- **改动文件**：`package.json`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈（截图圈出右侧边栏 chat 面板标题栏里的那个宽 Tip）
- **根因**：`contributes.commands` 少了 `icon` 字段。VS Code 在 `view/title` 的 `navigation` 组里**总是内联渲染**，命令带 `icon` 才是图标按钮，不带就退化成**文字按钮**——宽度、行高都跟旁边的图标不一致，这正是"对齐问题"的来源。同组的 `acpc.newConversation`（`$(add)`）、`acpc.attachFile`（`$(attach)`）都带了。
- **修法**：加 `"icon": "$(open-preview)"`（`open-preview` 就是 VS Code 内置的「在旁边打开预览」用的那个图标，语义最贴近"在编辑区打开"）。hover 的 Tip 由 VS Code 自动生成（命令 title + 快捷键），无需额外代码。
- **顺便查明（**没有改**）**：`view/title` 里还有三个命令没有 `icon`——`acpc.showLog` / `acpc.showTraffic` / `acpc.browseRegistry`。它们是**上游刻意留在 `...` 溢出菜单**里的次要操作；给它们加图标会把它们挤进标题栏、改变上游的布局，所以按"不动上游设计"处理。若哪天想让它们也上标题栏，加 `icon` 即可。
- **验证方式**：`node -e` 复核 `contributes` 里该命令含 `icon`；`check-registry.mjs` 六节全绿；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：㊽ 标题栏最左侧（`+` 之前）出现一个图标按钮，与旁边按钮等宽等高；hover 显示 Tip；点击能打开编辑区面板。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-024
- **功能**：修 Bug —— 标签行的 `+`（New Session）按钮点了没反应
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/client/tabs.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈（截图圈出 `+` 按钮）
- **根因（两个，都会表现成"点了没反应"）**：
  1. **主因：调错了 API**。`newSession` 分支调用的是 `sessionManager.connectToAgent(agentName)`，
     而 `connectToAgent` 的语义是「**已有该 agent 的会话就复用**」：
     ```ts
     const liveIds = this.getSessionIdsForAgent(agentName);
     if (liveIds.length > 0) { this.focusSession(liveIds[liveIds.length - 1]); return ...; }
     ```
     用户此刻正好有一个会话，于是「开新会话」退化成「聚焦那个已有会话」——UI 上完全看不出发生过什么。
     开新会话必须走 `newConversation` → `createSession`（010 引入的原子操作，也负责按需 spawn agent 进程）。
     **这是 011 起就存在的缺陷**，不是本轮引入的：`newSession` 消息从第一天就是这个实现，
     而 021/023 加的 ☰ 抽屉与引导条都绕开了它，所以一直没暴露。
  2. **次因：空焦点时点击被静默吞掉**。客户端是 `if (state.focusedAgent) { post(...) }`——
     把所有标签都关掉之后 `focusedAgent` 为 null，点击连消息都不发。
     现在退回 `state.sessions[0].agentName`；连一个会话都没有时不带 agentName 上报，
     由扩展侧回一条明确的提示（"No agent to start a session with. Connect one in the Agents view first."），
     而不是让用户对着一个没反应的按钮猜。
- **教训**：**"开新" 与 "连接/聚焦" 是两个语义**，`connectToAgent` 这个名字容易让人以为它总会建会话。
  项目里已经有专门的 `newConversation`/`createSession`，走它们才对。
  同类隐患的排查方法：搜 `connectToAgent` 的所有调用点，逐个确认它期望的是"复用"还是"新建"。
- **非目标**：不给 `+` 加"正在创建"的加载态（`createSession` 对已连接的 agent 只是一次 RPC，通常很快；
  真需要的话应该由 `session-created` 前后的状态驱动，另开一轮做）。
- **验证方式**：`check-webview-client.mjs` 通过（11 个客户端模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：㊺ 有会话时点 `+` → **真的多出一个新标签页**并聚焦到它（`ACP Traffic` 里能看到一次 `session/new`）；
  ㊻ 把所有标签关掉后点 `+` → 仍能建出新会话（走 `sessions[0]` 的 agent）；
  ㊼ 连一个 agent 都没连接时点 `+` → 对话区出现一条提示，而不是毫无动静。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-023
- **功能**：左侧引导条——照 Claude Code 官方扩展的对话区形态，每个执行步骤一个点、连成一条竖线，可点击跳转、当前项高亮
- **改动文件**：`src/ui/chat/html/client/rail.ts`（新增）、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户贴了官方扩展的截图，要求「参考下 claude code 官方插件的设计，在左侧放一个引导条」
- **与 021 的关系（不是重复劳动）**：参考图那条线是**按执行步骤**标的（每个 thinking / Write / Bash 一个点，当前那个是实心蓝点），回答的是「**这一轮干到哪一步了**」；021 的 ☰ 抽屉回答的是「**跨轮次回看某句话**」。用户确认两者并存。
- **形态**：两级——用户消息处是**大实心点**（轮次边界），其余记录（推理 / 工具 / 正文 / plan / content / notice / 权限卡）是**小空心点**（步骤）；一条竖线从首个标记连到最后一个。状态着色：`in_progress`/`pending`/流式 → 蓝（进行中），`failed` → 红，其余灰。
- **三个实现决策**：
  1. **引导条是 `.message-area` 的兄弟节点，不是 `#messages` 的子节点**。放进 `#messages` 会被两样东西咬：①那里的三档间距阶梯是 `.messages > * + *` 的 `margin-top`，会把绝对定位的引导条也位移；②它会被当成一个"条目"参与 flex 排版。改为兄弟节点 + track 做 `translateY(-scrollTop)` 与内容同步滚动，视觉完全一致而互不干扰。
  2. **布局读取分成两档**，这是性能上的关键：`invalidate()`（条目集合或状态变化）先比对**标记签名**，签名没动就完全不读布局——所以流式 chunk（同一 entry 反复 append）的开销是"一次字符串比较 + 一次 transform 写入"；`reflow()`（markdown 回填、窗口尺寸变化）只测量不重建。长会话里 500 个标记若每帧全量测 `offsetTop`，成本是毫秒级的，这条分档就是为了避开它。
  3. **点的尺寸/偏移放在 CSS，JS 只写 `top`**。`.rail-dot.turn` 与 `.rail-dot.step` 用 `margin-top: -半高` 抵消，于是 JS 写 `top = 入口节点 y + 6` 就正好是圆心——JS 里不必再算两套尺寸。
- **顺带修的一处**：`transcriptView.updateTool` 现在会把新的 view model 存回 `objects[entryId]`。原因：引导条按工具的 `status` 着色，而 `status` **不在 `PATCH_KEYS`** 里（那份白名单只覆盖 text/html/streaming/elapsedMs/plan/content/permission），不存回的话工具跑完了点还是蓝的。
- **非目标**：不做 hover 摘要浮层（改用原生 `title` 属性，零定位逻辑）；不做引导条的折叠/隐藏开关；不做"跳转到任意步骤"的键盘导航。
- **验证方式**：`check-webview-client.mjs` 通过（**11** 个客户端模块 + 17 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第六、七次**复发（`rail.ts` 与 `transcriptView.ts` 各一处注释）——同样由检查器一次报全。这已经是第 4 轮连续复发，只能靠检查器兜着。
  **待用户 F5 复验**：㊵ 对话区左侧出现竖线 + 点，用户消息处是大实心点、其余是小空心点；㊶ 有工具在跑时它的点是蓝色，失败是红色；㊷ 点任一点跳到对应步骤，滚动时高亮跟随；㊸ 长回复流式输出时引导条不卡顿（DevTools Performance 无长任务）；㊹ 与 ☰ 抽屉同时存在、互不干扰。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-022
- **功能**：长会话性能——流式消息合帧、增量文本追加、rAF 合帧、每会话滚动记忆
- **改动文件**：`src/ui/chat/Outbox.ts`（新增）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/scroll.ts`、`src/ui/chat/html/client/boot.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「chat 面板内对话可能会积累到很长，需要考虑超长对话的优化」。用户选的是**先做低风险高收益一批**（不做虚拟滚动、不做旧轮次折叠）。
- **四个具体病灶**（都是先量出来的，不是猜的）：
  1. **扩展侧每个 chunk 一次 postMessage**：`ChatPanelHost.onSessionUpdate` 的 `agent_message_chunk` 分支逐片发 `append`。一次长回复 = 几百条消息，每条都要 structured-clone。
  2. **客户端每次整段重设文本**：`applyAssistant` 是 `bubble.textContent = entry.text`，即每来一片就把**累积全文**重写一遍（一次回复是 O(n²) 的字符串与文本节点操作），随后 `scroll.follow()` 读 `scrollHeight` 触发强制重排。
  3. **`refreshSessions()` 每个 chunk 都跑**：于是每片都在客户端重建整条标签栏 + agent 下拉。**这一条的收益比 rAF 还大**，而且它顺带决定了合帧队列能不能真正攒住（见下）。
  4. **工具分组重排**（`toolCallView.refreshGrouping`）是整容器的 `querySelectorAll` 遍历，工具追加与每次更新都会跑。
- **① 合帧队列 `Outbox`**：按条目合并流式 append，攒一帧（16ms）再发。**只合并一种情况**——队尾是「单条 append」且 entry id 相同。之所以能只替换队尾：`TranscriptStore.appendAssistantChunk` 是**就地修改并返回同一个对象**，队列里那份引用天然带着最新文本，攒着不发不会丢内容，反而省掉中间态。
  路由表集中在 `ChatPanelHost.post()` 一处（按消息类型），因为**漏改一个调用点就会静默破坏顺序不变式**。
- **INV-A..F（写进 architecture §5.10，改这块前必读）**：
  - **INV-A** `revise` 不得越过创建它的 `append`——客户端 `patch()` 对未知 id 是**静默 no-op**，越过等于那条更新凭空消失。
  - **INV-B** `markdownRendered` 同理，只能按 FIFO 走。
  - **INV-C** `sessionsChanged` 不得延迟/合并——它驱动 Send/Stop 按钮，晚了按钮状态就是错的。
  - **INV-D** `sessionClosed` 不得延迟。
  - **INV-E** 每次 `boot`/`focus` 快照前必须先 `flush()`。
  - **INV-F** **只延后滚动、大纲 tick、工具分组重排**；`hydrate` / `append` / `patch` / `pending` 表 / `requestMarkdown` **一律同步**——`applyFocus` 里 `hydrate()` 之后立刻 `requestMarkdown()`，一延后 `pendingMarkdown()` 就是空的，markdown 整条链会静默失效（正是 012 修过的 P0 #1）。
- **② 增量文本追加**：新文本是旧文本前缀时 `textNode.appendData(delta)`，否则回落整段重设。回落（并清掉 tail 记录）的四种情况：首次/hydrate/reset、不是前缀（典型是 64KB 截断改了尾巴）、`entry.html != null`（**绝不能**往已渲染成 HTML 的气泡里追加裸文本）、宿主节点被替换。
- **③ rAF 合帧**：`NS.dom.schedule`（021 建的）扩展到滚动跟随与工具分组重排。滚动改成「消息任务里只写 DOM，下一帧只读一次 `scrollHeight` 再写 `scrollTop`」，读写分离。
- **④ 每会话滚动记忆**：`offsets[sessionId] = { top, pinned }`（**连贴底状态一起记**，否则贴底的会话切回来会停在半空）。
  **`hydrate()` 里那句无条件的 `toBottom()` 删掉了**——它是"功能做了但没生效"的典型来源：滚动位置的决策上移到 `applyFocus`（切走前 remember、hydrate 后 restore），留在 hydrate 里就会把恢复的位置立刻冲掉。
  markdown 回填会改变高度 → `markdownRendered` 后 `reassert()` 再对齐一次；用户一旦自己滚动就放弃恢复（用 `expectedTop` 区分程序写入与用户滚动）。`persistUi` 防抖落盘，**关掉再打开面板位置也在**。
- **验证方式**：`check-webview-client.mjs` 通过（10 个客户端模块 + 16 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  新增诊断日志：每轮结束时 `chat-panel: outbox sent=N merged=M queued=K`——`merged` 占比高说明合帧真的在工作。
  **待用户 F5 复验**：⑮ 让它输出极长回复 → 只有 1 个气泡、不丢字、DevTools Performance 无 >50ms 长任务、`merged` 比例高；⑯ 切走再切回 → 滚动位置与贴底状态都恢复，流式期间切走再切回不被重新贴底；⑰ 关掉再打开编辑区面板 → 位置还在；⑱ 发送后 `■ Stop` **立即**出现（签名去重没有延迟按钮状态）。
  **回归重点**：P0 #1（markdown 往返）、#2（只有 1 个气泡在增长）、#5（工具卡片切面后还在）——三者都在本轮改动的作用域内。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-021
- **功能**：会话大纲抽屉——标题栏的 ☰ 列出所有用户消息，点击跳转、当前项高亮
- **改动文件**：`src/ui/chat/html/client/outline.ts`（新增）、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/scroll.ts`、`src/ui/chat/html/client/dom.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「想给 chat 面板里的对话记录加一个导航栏（列出方便回看跳转对话记录）」
- **形态**：用户选的是**抽屉式目录**（而不是右侧迷你导航条）。锚点 = 每条用户消息；列表每行是「HH:MM + 首行摘要（≤80 字）」；超过 200 条时头部显示「… N earlier hidden」（会话记录上限是 500 条，最多约 250 个用户轮次，不做虚拟化）。
- **三个必须守住的点**（写进了代码注释与 architecture §5.9）：
  1. **顺序不能用 `Object.keys` 拿**。entry id 是字符串，而 `Object.keys` 的顺序保证只覆盖整数样式的键——顺序错了的表现是"点击跳到不相干的消息"，很难联想到根因。所以 `transcriptView` 新增显式 `order` 数组（`place()` 里 push、`reset()` 里清空）与 `ordered()/entry()/node()` 访问器，并在每个节点上打 `data-entry-id`。
  2. **布局读取只在 rAF 回调里做**。新增 `NS.dom.schedule`（一帧一次的回调队列），`scroll` 事件只置脏位；在 scroll 处理函数里读 `offsetTop` 会让每帧强制重排（这正好是 022 要治理的同一类问题）。高亮用二分查找缓存的锚点位置，`invalidate()` 后重建。
  3. **跳转不能把自己拽回底部**。`scroll.jumpTo(node)` 在写 `scrollTop` **之前**就 `pinned = false`，随后由 scroll 事件按真实距离重算——这样"跳到中间 → 后续分片继续流入"不会打断阅读；跳到最后一条时仍会正确重新贴底。
- **边界**：`Escape` 用**捕获阶段**监听并 `stopPropagation`——composer 在 textarea 上监听 Escape（取消轮次），不拦截的话关抽屉会顺手把正在跑的轮次取消掉。抽屉打开时点击外部关闭（与 composer 的菜单同款行为）。
- **非目标**：不做搜索/过滤、不做助手回合或工具调用的锚点、不做虚拟化（200 条上限足够，且不阻塞 022 的 B/C 期）。
- **验证方式**：`check-webview-client.mjs` 通过（10 个客户端模块 + 16 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第五次**复发（`scroll.ts` / `transcriptView.ts` / `styles.ts` 三处注释）——同样由 `check-webview-client.mjs` 一次性全部报出，没有变成难啃的 `TS1005`。评审结论不变：这条纪律只能靠检查器兜。
  **待用户 F5 复验**：⑪ ☰ 打开大纲、条目按轮次列出、点击跳转且高亮跟随；⑫ 流式输出中打开大纲能看到新轮次，跳上去**不会被后续分片拽回底部**；⑬ 跳上去后出现 `↓ Jump to latest`，点回底部并重新贴底；⑭ 输入框未聚焦时 Esc 只关抽屉、不取消轮次；⑮ 无用户消息时 ☰ 不显示。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-020
- **功能**：权限请求从「VS Code 窗口级 QuickPick」搬进聊天面板，成为对话里的一张卡
- **改动文件**：`src/handlers/PermissionBridge.ts`（新增）、`src/handlers/PermissionHandler.ts`、`src/core/ConnectionManager.ts`、`src/core/SessionManager.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/html/client/permissionView.ts`（新增）、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/links.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/styles.ts`、`src/extension.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「选择界面需要改为在 chat 面板内提示（现在是在 vscode 顶部弹框提示，很难察觉）」
- **为什么不是"把 QuickPick 换成卡片"这么简单**：这条链上有**三条会挂死 agent 的泄漏路径**，上游实现一条都没堵。
  1. **SDK 侧对 `session/request_permission` 没有超时**（`grep setTimeout` 在 SDK 的权限路径上零命中）。所以"呈现不出来"绝不能静默——用户没看见 = agent 永远等下去。本轮的规则是：**能进面板就进面板，进不去才退回弹框，两条路都没有就说明有 bug**。
  2. **轮次被取消时必须把待决请求回答成 `cancelled`**。ACP 契约明写（SDK 文档注释）：会话被 cancel 时客户端必须结束待决的权限请求。上游 `cancelTurn` 只发 `session/cancel`，**从不解决那个 promise**——加了面板卡片后这个问题会立刻显形（卡片点不了、agent 卡住），所以本轮一并修掉。
  3. **并发请求**。上游是几个请求就弹几个 QuickPick，且标题里只有工具名，两个会话同时请求时无法分辨谁是谁。
- **设计：新增 `PermissionBridge` 作为唯一出口**。它不 import 任何 vscode UI 类型（只认 `PermissionPresenter` 接口），因为"ACP 响应 promise"的所有权属于 handler 层，而不是 UI 层。
  - `request()` 判定顺序：**自动批准分支（原样保留）→ 能进面板就发卡片 → 否则入全局 FIFO 队列，一次只弹一个**（队列化修的就是第 3 条问题）。
  - `answer(promptId, optionId?)`：未知/已解决/已 deferred 的答复一律拒绝并记日志——一个请求只能有一个答案，两个面同时点、双击、与弹框抢答都在这里被挡住。
  - `cancelSession` / `cancelAll` / `settle`：保证每个请求**恰好**被回答一次（第 2 条问题）。
  - `onPresenterLost()`：最后一条 surface 断开时把面板卡片降级为 `deferred` 并入队弹框。**这是 agent 不挂死的最后一道保险**——此时 store 仍在，所以卡片还会被更新成 `deferred`（按钮禁用 + 文案「Waiting for an answer in the dialog…」），但已经没有任何能点的地方了。
- **卡片本身**：transcript 第 8 种记录类型 `permission`，锚在**它所属的工具调用之后**；状态机 `pending → deferred | selected | cancelled`；`deferred` 时按钮**禁用**（避免与弹框形成第二条回答路径）。
  **安全**：`toolCall.title` 与 `option.name` 都是 agent 可控字符串，客户端一律用 `NS.dom.el(tag, cls, text)`（textContent），**不用 innerHTML**。
- **呈现策略**：`canPresent` 要求「是聚焦会话 + 是 modern agent + 有 surface」。聚焦会话是必须的——给非聚焦会话发卡片，客户端会按 `currentSessionId` 把它过滤掉，结果就是"agent 在等一个没人看得见的按钮"。surface 不可见（侧边栏收起 / 编辑区在后台标签）时会 `reveal(true)` 把它提到前面，但**不抢焦点**。
  已知取舍：待决期间切到别的会话，卡片仍在该会话的记录里，切回去即可回答（agent 在等，这是可发现的）。
- **顺带修掉的隐患**：`PermissionHandler` 提取出 `private quickPick(params, label)`，弹框标题现在带会话标识（`agentName · 标题`，未知会话退化为 sessionId）。
- **非目标**：不做权限超时（需要新配置项 + 「谁答的」语义，落点在 `PermissionBridge.request` 的注释里标了）；不给 legacy 面板做卡片（协议流量永不进旧面板，其对话内容在 webview DOM 里）；`acpc.turnInProgress` 上下文键仍未修（Escape 取消与 view/title 取消按钮仍是死的，见 pitfalls #5）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功；`check-webview-client.mjs` 通过（9 个客户端模块 + 15 个模板模块）。
  **本轮实际踩到的坑**：`permissionView.ts` 与 `transcriptView.ts` 的注释里写了反引号（pitfall #11 的**第四次**复发）——但这次是**检查器先把 tsc 的错误报了出来**（`[BACKTICK] transcriptView.ts:266`），而不是让人去啃 `TS1005` 的位置。017 把扫描范围扩到整个 `html/` 树的收益在这里兑现了。
  **待用户 F5 复验**：⑥ 权限请求 → 卡片出现在对应工具卡之后、两个面都有，在侧边栏点允许 → 编辑区卡片同步更新；⑦ 待决时关掉编辑区面板（侧边栏在别的 agent）→ 弹出 QuickPick，回答后卡片显示最终结果；⑧ 两个会话同时请求 → 弹框一次只出一个且各自标明会话；⑨ 待决时按 Stop/Escape → 卡片变 Cancelled，`ACP Traffic` 出现 `session/cancel` → `stopReason: cancelled`，agent 不挂死；⑩ 恶意标题 `<img src=x onerror=alert(1)>` → 显示为字面文本、不弹框。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-019
- **功能**：聊天面板支持在**编辑区**（编辑器标签页）打开，与侧边栏**并存**、共享同一份会话记录
- **改动文件**：`src/ui/chat/ChatSurface.ts`（新增）、`src/ui/chat/ChatEditorPanel.ts`（新增）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/ui/chat/panelContract.ts`、`src/extension.ts`、`package.json`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户反馈「这个 chat 界面能支持移到编辑区吗（现在只能放左右侧边栏）」
- **背景（为什么必须新建面板）**：侧边栏的 `webview` 视图**在 VS Code 里无法被拖到编辑区**，也没有"声明式"的开关——编辑区承载 webview 的唯一途径是 `vscode.window.createWebviewPanel`（本仓库此前零处使用）。用户选择的是「并存、可随时切换」而不是「移动」，所以侧边栏 `acpc-chat` 视图保持不变（`acpc-chat.focus` 的 5 个调用点因此一个都不用改）。
- **为什么这件事成本很低**：新面板的 transcript 存在扩展宿主（`TranscriptStore`，见 011），与视图无关；`renderChatHtml(webview, nonce)` 的形参本来就是普通 `vscode.Webview`。所以第二个面是"再 attach 一次"，不需要第二份状态，也不会触发 `session/load` 重放。
- **核心抽象 `ChatSurface`**：把两种视图的差异收敛成三个成员（`visible` / `reveal(preserveFocus)` / `onDidDispose`）。**它解决的不只是类型问题**：旧写法 `this.view?.show?.(true)`（附件 chip 把面板提到前面）对 `WebviewPanel` 会**静默失效**——面板没有 `show` 方法，可选链吞掉了它，表现为附件不显示也不报错。
- **`ChatPanelHost` 的三条改动**：
  1. `private view` → `surfaces: Map<SurfaceKey, ChatSurface>`，新增 `attachSurface` / `detachSurface` / `attachedCount`；`attach(view)`/`detach()` 的对外签名不变（`IChatPanel` 契约与 LegacyPanelAdapter 都不受影响）；
  2. `post(msg, to?)` **默认广播**、可定向。广播是安全的：客户端本来就按 `currentSessionId` 过滤（`boot.ts` 七处），而两个面必须看到同一份时间线；
  3. **`ready` 的应答必须定向**（`pushBoot(from)`）。广播 boot 会让**另一个**文档被迫 `hydrate`（reset + 重建 + `toBottom()`），也就是"打开编辑区面板会把侧边栏的滚动位置重置"——这类 bug 静态检查看不出来。
- **不变量**：**编辑区面存在 ⟺ 聚焦 agent 属于 `MODERN_AGENTS`（目前只有 Claude Code）**。非 Claude Code 走 legacy 面板，而 legacy 的对话内容存在 webview DOM 里，换面渲染等于丢历史——所以 `open()` 直接给提示并拒绝，`syncActivePanel()` 在焦点跨出去时关闭面板。双向保证让这个中间状态不可达。
- **顺带修的隐患**：`syncActivePanel()` 原先第一行是 `if (!this.view) return`，即**侧边栏从未打开时，任何焦点变化都推不到聊天面板**。编辑区面板恰好是"没有侧边栏也能用"的场景，所以改成：侧边栏不存在但编辑区面板开着时，仍把 `PanelContext` 推给 modern host。
- **顺序铁律（代码里有注释）**：`createWebviewPanel` 之后必须**先注册** `onDidReceiveMessage` / `onDidDispose`，**再** `attachSurface`。反了会漏掉文档的第一条 `ready`，面板永久空白——与 architecture §5.4 的"消息被守卫丢掉"同属**无自动检查能发现**的一类故障。
- **非目标**：编辑区面板不支持非 Claude Code agent；不做窗口重载后的面板恢复（需 `registerWebviewPanelSerializer`）；不加 `editor/title` 菜单（其 `when` 需要 `activeWebviewPanelId` 上下文键，本仓库从未验证过该键，不引入没验证过的 `when`——`acpc.turnInProgress` 正是"声明了却没 setter"的前车之鉴）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功（`dist/extension.js` 内含 `acpc-chat-editor` 与 `acpc.openChatInEditor`）；`node CUSTOMIZATIONS/scripts/normalize-eol.mjs` 归一两个新文件（CRLF）；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿。
  **待用户 F5 复验**：① 面板打开时在侧边栏点会话标签 → 两个面同步切换、都渲染 markdown、都不重字；② 关掉编辑区面板再打开 → 完整记录回来，`ACP Traffic` 里没有 `session/load`；③ 面板开着时聚焦非 Claude Code 会话 → 面板自动关闭、侧边栏回到旧面板；④ 聚焦非 Claude Code 时执行命令 → 只弹提示、不开面板；⑤ 两个 webview 的 DevTools 里都能敲出 `window.__acpc`。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-018
- **功能**：Chat 面板块视觉体系重构 —— 推理块自动折叠 + 三级视觉层次 + 三档间距阶梯
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户 F5 实测反馈「不同段区分度太低」（截图里 6 段 `Thought for Ns` 连成一片灰字墙）
- **诊断出两部分问题，行为 bug 才是主因**：
  1. **推理块展开后永不折叠**：`buildThought` 里 `details.open = !!entry.streaming` **只在创建时设置一次**，收束时 `patch` 只改 summary 文字、**从未设 `open = false`**。旧面板有这个行为（正文一开始就折叠），本仓库重写时丢了。于是长推理链留下 N 个永久展开的块。
     **修法只需客户端一行**——扩展侧信号早就对了：`ChatPanelHost` 在正文开始时就调 `finalizeEntries(sessionId, { only: 'thought' })` 发出带 `streaming: false` 的 `revise`，只是没人消费。语义上恰好吻合：thought 收束的时机**就是**正文开始或轮次结束。
  2. **`thought` 是面板里唯一的"裸文本块"**：user/assistant 是气泡、tool/plan 是卡片，只有推理是"一条左侧竖线 + 灰斜体"，没有边界。后果是相邻两块的竖线在同一条 x 轴上只隔 12px、读起来是一根连续的线；且展开态与折叠态除高度外几乎无差别。
- **设计：确立三级视觉层次**（靠背景深度 + 边框强度 + 字号三重信号，而不是只靠一条竖线）
  | 层级 | 块 | 形态 |
  |---|---|---|
  | L1 主角 | user / assistant 正文 | 气泡（未改） |
  | L2 卡片 | tool / plan | 卡片（未改） |
  | **L3 轻卡** | **thought** | **折叠态：无背景、次要色、小字号的一行；展开态：淡背景 + 边框 + 圆角** |
  关键是让 L3 的折叠/展开形成**强对比**——折叠时几乎"消失"成一行，展开时变成有边界的浅色卡片。
  另加自定义折叠标记（隐藏原生 marker，用 `summary::before` 输出 ▸/▾）——原生三角在 Chromium 下太小且样式不可控。
- **三档间距阶梯**：`.messages` 的 `gap: 8px` → `gap: 0`，改用兄弟选择器按 `data-kind` 分档——同类相邻 2px / 跨类 10px / 用户消息前 16px。
  `data-kind` 由 `transcriptView.place()` 统一打（`hydrate` 走同一路径自动覆盖）。
  **一个必须注意的点**：`patch` 里 plan/content 分支走 `replaceChild` 重建节点，新节点没有 `data-kind`，已补设——否则那两类块的间距规则会静默失效。
- **顺带修复**：`styles.ts` 里 `.entry-content` 与 `.entry-notice.info` 两条 CSS 规则挤在同一行（早前一次编辑漏了换行），已拆开。
- **非目标**：不做推理段聚合分组（"推理 · 6 段 · 109s"）——自动折叠落地后连续推理本就只剩几行矮条，聚合收益不足以抵消 DOM 合并的复杂度。
- **验证方式**：`check-webview-client.mjs` 通过（14 模块扫描 + 反引号检查）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：长推理后正文出现时推理块应自动收成一行；点开折叠块应看到淡背景卡片（与折叠态对比明显）；连续推理之间紧凑、推理→工具拉开、用户消息前留白最大；▸/▾ 正确切换；工具/plan 卡片与 assistant 气泡外观不受影响。
  **注意**：本改动在 v0.2.0-custom.2 打包**之后**，尚未进入任何 .vsix 产物。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-017
- **功能**：修复阻断级 bug —— 新面板加载遮罩「Loading session history…」常驻不消失
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/docs/pitfalls.md`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户 F5 实测反馈（本仓库新面板的**首次真实运行**）
- **根因**：`hidden` 属性**不是魔法属性**，它依赖浏览器默认样式表里的 `[hidden] { display: none }`；而**作者样式表里的任何 `display` 声明都会覆盖它**——这与选择器权重无关，是「作者样式 > UA 样式」的层叠顺序。所以 CSS 里写了 `display: flex` 的元素，`hidden` **完全失效**。
  中招三个：`#loadOverlay`（本次症状，且它是 `position:fixed; inset:0; z-index:40`，**同时吞掉整块面板的点击**，输入框也点不了）、`#agentBar`、`#attachments`。
  **关键线索**：截图里遮罩**后面**的内容其实已完整渲染（Markdown 表格、代码块、工具卡片全在）——加载是成功的，问题在遮罩本身，这把范围从"加载逻辑"直接缩到了"遮罩显隐"。
- **修法**：`styles.ts` 的 `<style>` 顶部加一条全局规则 `[hidden] { display: none !important; }`，用 `!important` 把 `[hidden]` 的语义从被覆盖的状态抢回来。**不需要改任何 JS**，现有的 `.hidden = true/false` 赋值在规则生效后就是对的。注释里写明了"不要删"的理由与影响范围。
- **附带发现并修复的检查器缺口（值得单记）**：修 CSS 时我在 `styles.ts` 注释里又写了反引号（pitfall #11 的**第三次**复发），而 `check-webview-client.mjs` **报了 OK** —— 因为它当时只扫 `html/client/*.ts`，`styles.ts` 在上一级目录，**不在扫描范围内**。表现为 **tsc 报错、检查器说没问题**：一个专为防这类 bug 而写的工具，对范围外的同类 bug 视而不见。
  已把扫描范围扩到整个 `html/` 树（14 个模块）。扩范围后第一版立刻误报 13 处假阳性（把 TS 注释里合法的反引号也当错误），已改为**只在模板体内**报错。最后用负向测试在真实文件上确认：往 `styles.ts` 注入模板体内反引号 → 精确报 `[BACKTICK] styles.ts:17` 且 exit 1；还原后复检通过。
- **这是"静态检查全绿 ≠ 界面能用"的样本**：tsc / ESLint / webpack / 单测都不模拟 CSS 层叠，而本次首跑发现的唯一 bug 恰好是个纯 CSS 层叠问题。
- **验证方式**：`node CUSTOMIZATIONS/scripts/check-webview-client.mjs` 通过（14 模块扫描 + 8 模块拼接校验）；`check-webview-client` 负向测试确认能检出；`npx tsc -p . --noEmit` 无错误；`check-registry.mjs` 六节全绿。
  **待用户 F5 复验**：打开 session 时遮罩加载完成后消失、加载期间正常出现；只连 1 个 agent 时顶部无空白条；无附件时输入框上方无多余空隙；输入框可点击、Send 可用。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-016
- **功能**：文档去冗余——拆分账本、修掉一条不可用的机制规则、清理重复规则
- **改动文件**：`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`（新增）、`CUSTOMIZATIONS/README.md`、`AGENTS.md`、`CUSTOMIZATIONS/architecture.md`、`.agents/skills/acp-record-change/SKILL.md`、`.agents/skills/acp-merge-upstream/SKILL.md`
- **背景**：用户指出「`AGENTS.md` 里塞启动说明会增加每个会话的上下文」后发现的一类问题——**文档没有按「每会话必读」与「按需查阅」分层**。做了一轮独立审计（逐文件读、并与代码/脚本交叉核对），结果如下。
- **① 账本拆分（最大收益）**：`registry.md` 长到 **59KB**，其中**变更日志占 40KB**，而 `AGENTS.md` 把它列为每次任务前**无条件必读**——等于每次白读 40KB 历史流水。文件自己的头部写着"不必通读变更日志"，但一次 `Read` 调用会返回全部 345 行，**指引拦不住工具行为**。
  **拆法**：变更日志移到 `CUSTOMIZATIONS/docs/changelog.md`（42KB，按需）；`registry.md` 只剩 frontmatter + 仓库信息 + 改动总览（**18.5KB**）。
  `registry.md` 里**刻意保留了一行 `## 变更日志` 标题**作为指针——因为 `check-registry.mjs` 与 `list-custom.ps1` 都用它作为「总览表格扫描到此为止」的终止哨兵，保留即可让**两个解析器零代码改动**继续工作（已实测：`check-registry` exit 0、`list-custom` 正确报出 27 条总览条目）。
- **② 修掉一条不可用的机制规则（正确性问题）**：`README.md` 与 merge skill 都写着「新功能放 `CUSTOMIZATIONS/src/`」，但该目录**至今只有一个 `.gitkeep`**——它不在 `tsconfig.json` 的 `rootDir`/`include` 里、也不在 webpack 入口图里，放进去的 `.ts` **根本无法编译**（TS6059）。这是从 Electron 项目移植机制时没有适配 VS Code 语境的残留。已改为实际做法（新文件放仓库根 `src/` 下 + 文件头标记），并在 README 目录树处加了一段说明为什么该目录是死的。
- **③ 文档与实现不一致（正确性问题）**：`README.md` 声称是「唯一规则源」，但它的「**三种**无标记情形」表**少了第 4 条**——而 `check-registry.mjs:103` 实际在强制它（总览里记录"某上游值被刻意保留"的行必须含 `未改动`/`非改动`，否则报 `NO-MARKER`）。skill 里是 4 条、README 是 3 条。已补齐并把标题改成「四种」。
- **④ 重复规则收敛**：
  - merge skill 里**内联了一份 `acp.*` 残留 grep**，与 `check-registry.mjs` 的 `NS_PATTERNS` 各持一份——加一个模式就会静默跑偏。已改为「跑 `check-registry.mjs`，§3 就是这件事」。
  - 冲突策略表原在 README 与 merge skill 各一份（且优先级编号还不同）。已收敛到 README 一处，skill 改为链接。
  - `[CUSTOM-BEGIN]` 标记模板原在 AGENTS.md / README / record-change skill 三处。AGENTS.md 收敛为一行 + 指针。
- **⑤ `AGENTS.md` 减重**：147 行 → **121 行**。删除「项目结构速查」（与 `architecture.md` §1 重复且**已双向漂移**：一边写"唯一的测试"、另一边漏了 `nesting/`）；技术栈只留会破坏构建的两条（npm / webpack+ts-loader），其余移到 architecture.md §0；Git 分支表与构建命令压缩；补上两条**真正缺失的硬约束**——「`check-registry.mjs` 必须 exit 0」与「改完 `src/**` 要跑 `normalize-eol.mjs`」（后者是合并能力的命脉，此前只存在于按需文档 pitfalls #7 里）。
- **⑥ 过期事实修正**：`architecture.md` 里 `SessionManager` 的 "36KB"（实为 51KB/1312 行）改为不写死尺寸；`src/ui/chat/` 的模块数 25→28；"唯一的测试"补上 `nesting.test.ts`；本文件 013 条目里 `nesting/` 的 "3 个新增文件"→**2 个**（append-only 是指不删历史，不是指保留笔误）。
- **验证方式**：`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿；`powershell -File CUSTOMIZATIONS/scripts/list-custom.ps1` 正常输出（改动总览 27 条，未被日志干扰）；`normalize-eol.mjs --check` 通过；`AGENTS.md` 147→121 行、`registry.md` 59KB→18.5KB；章节结构完整性已复核。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-015
- **功能**：把启动/验收说明从 `AGENTS.md` 下沉到独立文档 `CUSTOMIZATIONS/docs/dev-workflow.md`
- **改动文件**：`CUSTOMIZATIONS/docs/dev-workflow.md`（新增）、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`
- **详细说明**：
  - **问题（用户指出）**：014 把三种启动方式、差异对照表、重载循环、验收清单全写进了 `AGENTS.md`，共 57 行。
    但 `AGENTS.md` 是**每个会话都会被加载**的 AI 硬约束摘要——这等于给所有与"启动测试环境"无关的任务
    加了一笔固定的上下文税。**要按"每会话必读"与"按需查阅"分层。**
  - **解法**：新建 `CUSTOMIZATIONS/docs/dev-workflow.md`（与 `pitfalls.md` 同级，属于按需查阅类文档），
    收录：三种启动方式 + 差异对照表（能否下断点）、`Ctrl+R` 重载循环、验收该看哪几个输出通道、
    判断当前是新面板还是旧面板、手动验收清单、常见问题。
    `AGENTS.md` 只留 **1 行指针**（顺带保留 `npm run dev:host` 这一条构建命令），57 行 → 4 行。
  - **顺带修掉一个悬空引用**：012 / 013 的变更日志里写着「见 Phase 3 计划 §4」的验收清单，
    而那份计划文件在 `~/.claude/plans/` 下、**不在仓库里**——一旦离开开发机器这份引用就断了。
    验收清单现已收录进 `dev-workflow.md`。**变更日志按机制只增不改，所以通过本条记录补上正确位置，
    不回去改写 012/013 的历史条目。**
  - **`AGENTS.md` 的文档更新职责表**新增一行：「改了启动/构建/验收流程 → `CUSTOMIZATIONS/docs/dev-workflow.md`」，
    让这条分层规则对后续的 AI 会话可见。
- **验证方式**：`AGENTS.md` 中该章节从 57 行缩减为 4 行（含指针）；`CUSTOMIZATIONS/docs/dev-workflow.md` 内容完整；
  `check-registry.mjs` 六节全绿；`normalize-eol.mjs --check` 通过（新文档为纯自定义路径 → LF）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-014
- **功能**：本地启动测试环境一条命令化（`npm run dev:host`）+ 把用法写进 `AGENTS.md`
- **改动文件**：`CUSTOMIZATIONS/scripts/dev-host.mjs`（新增）、`package.json`、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`
- **详细说明**：
  - **背景**：手动验收要在命令行敲一长串
    `code --new-window --extensionDevelopmentPath="D:\...\custom-vscode-acp" "D:\...\custom-vscode-acp"`，
    还需要自己先记得 `npm run compile`。忘编译就会测到旧产物——这正是 Phase 2/3 那批"纸面验收"踩过的形状。
  - **为什么用 Node 脚本而不是把命令直接写进 `scripts`**：npm 在 Windows 默认走 cmd.exe、在 macOS/Linux 走 sh，
    `%CD%` 与 `$PWD` 互不通用，而 `--extensionDevelopmentPath` 需要**绝对路径**。
    本仓库已有同类先例——`check-registry.mjs` 从 bash 移植到 Node 就是为了消除 shell 方言差异（pitfalls #8）。
  - **脚本行为**：默认先跑 `npm run compile` 再启动（`--no-build` 可跳过）；把仓库根作为扩展路径与默认工作区
    （`npm run dev:host -- <目录>` 可换）；`code` 优先走 PATH，找不到再回退到 Windows 常见安装位置；
    **detached 启动**，所以 `npm run dev:host` 会立即返回而不是占住终端。
  - **踩到并修掉的一个 Windows 细节**：`shell: true` 是运行 `code.cmd` 的必需项，但 Node **不会**替我们给命令加引号——
    安装路径含空格（`C:\Program Files\…`）时会被拆成多个 argv。加了 `shellQuote()`，
    并**实测**过脚本（编译 → 定位 CLI → 启动 → 确认宿主窗口进程出现）。
  - **AGENTS.md**：把原来仅一行的「调试：按 F5」扩成《启动测试环境》章节——三种方式（`npm run dev:host` / 直接敲 code /
    F5）与差异对照表、`Ctrl+R` 重载循环、以及首次验收要开哪两个输出通道和 Webview Developer Tools。
    顺带修了两处因 Phases 1–4 而过期的描述：结构速查里的「test/ 唯一的测试」「ui/ 未提及 chat/」。
- **验证方式**：`npm run dev:host` 实测通过——webpack 编译成功、定位到 `code`、正确解析扩展路径与工作区、
  宿主窗口进程（PID 32108）确实出现；`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-013
- **功能**：Chat 面板重写方案 Phase 4 —— 子 agent 调用树（嵌套推断 + 分组 UI）
- **改动文件**：`src/ui/chat/nesting/`（2 个新增文件）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/{types,ToolInvocationStore}.ts`、`src/ui/chat/html/`（body/styles/client 三处）、`src/test/nesting.test.ts`（新增）、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/architecture.md`
- **前提说明（重要）**：**ACP 协议里没有子 agent 概念**——枚举 SDK 全部 239 个 schema 定义，`parent|subagent|delegate|nested|child|spawn` **零命中**，工具调用是只以 `toolCallId` 为键的扁平集合。因此**任何"树"都是事后推断**，推断依据是 agent 自定义的 `rawInput` / `rawOutput` / `_meta`（三者都是 `unknown`）。
  **Phase 0 探针 (b) 尚未执行**（需要真实 Claude Code 流量），所以本轮的判据是"可插拔 + 默认关闭 + 结果可区分"，而不是"猜对了键名"。
- **详细说明**：
  - **策略可插拔，默认是空实现**：`NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 按 `acpc.agents` 配置键分派。`flatNesting`（空实现）是**默认路径**而非兜底分支——对形状未知的 agent，扁平时间线是正确的，错的树比没有树更糟。目前只有 `'Claude Code'` 走推断。
  - **两级推断，显式优先**：
    1. **显式链接**：某个 Task 类调用的 `rawOutput` 或 `_meta` 里**出现了子调用的 toolCallId**。这是**与厂商无关**的判据——不需要知道键名叫什么，只要 id 出现在父的产出里就成立。它同时也是对探针 (b) 的防御：命中即为 `inferredParent: false`。
    2. **时序包含回退**：子调用的生命周期区间被父区间包住，取**最内层**（跨度最小）的父，标记 `inferredParent: true`。
  - **护栏（宁可漏连，不可错连）**：父区间须比子区间长 ≥ 50ms（否则同刻开始的调用会互相"包含"）；嵌套深度上限 3；**并列（跨度相同）时不连**；**只有 Task 类调用能做父**——因此 Task 可以挂在另一个 Task 下（子 agent 再派生），但普通 Edit/Read 不会被误归到某个 Task 下。
  - **`apply()` 是「先算后改」+ 迭代收敛**：单趟边改边算会让结果依赖遍历顺序，所以决策阶段完全不读本轮要改的字段。另外深度护栏读的是**上一轮**的深度，单趟会让一条全新的 5 层委派链全部连上（深度都从 0 开始）——因此迭代到定点，无嵌套时 2 轮收敛，否则最多 MAX_DEPTH+2 轮。
    这是本轮**自查发现的真问题**（最初版本深度上限形同虚设），单元测试里有一条专门钉死它。
  - **UI 的诚实性**：推断出的边带 `?` 角标 + tooltip（明说"ACP 没有嵌套概念，此链接由时序与产出推断而来，可能是错的"）。子卡片**保持按到达顺序**排布（考虑到链接本身是推断的，时间顺序才是诚实的排序），分组只做视觉处理：缩进 + 连接线 + 父卡片的「N steps」徽标；折叠父卡片会一并折叠其子卡片。会话头部有 `Sub-agents` 开关可切回完全扁平，偏好走 `vscode.setState` 存在 webview 本地。
  - **每次 tool 更新都重跑推断**：Task 的 `rawOutput` 往往在调用**结束时**才到达，而那正是显式链接变得可发现的时刻——所以推断必须可重入、自愈，并且只用真正变化的边去推送 `toolUpdate`。
  - **单元测试**（`src/test/nesting.test.ts`，11 条）：`isTaskLike` 判定、flat 策略是 no-op 且是未知 agent 的默认、Task 窗口内的调用被归组且标记为推断、**等跨度/并列/子早于父都不连**、`rawOutput` 里的 id 算显式链接、`_meta` 里的 id 同样、最内层优先且 Task 可嵌套 Task、深度不超上限、`apply` 幂等且只报告真变化、显式链接可**升级**已有推断链接。这是全项目最"猜"的一块，所以把行为钉在测试里。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；**`npm test` 14 passing（新增 11 条嵌套测试全绿）**；`check-registry.mjs` 六节全绿；`normalize-eol.mjs` 全部 CRLF。
  **待人工验证（需 F5 + 真实 Claude Code 流量）**：让 Claude Code 用 Task 起子 agent → 子卡片应缩进显示在父卡片下并带 `?` 角标；点 `Sub-agents` 开关应能切回扁平；折叠父卡片应连带折叠子卡片。
  **Phase 0 探针 (b) 的执行仍然重要**：若日志显示适配器提供了显式父子键，应删除时序启发式、只保留显式链接（`ClaudeCodeNesting` 的注释里已写明这一点）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-012
- **功能**：Chat 面板重写方案 Phase 3 —— 修复首次审计出的 15 个缺陷 + 补齐功能缺口
- **改动文件**：`src/ui/chat/`（多个模块）、`src/handlers/TerminalHandler.ts`、`src/core/ConnectionManager.ts`、`src/extension.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/architecture.md`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **背景**：Phase 2 交付的新面板通过了全部**自动化**检查，但**从未运行过**（F5 验收未做）。Phase 3 动手前做了一次独立代码审计——端到端逐条走查代码路径，不依赖运行环境——**发现 15 个缺陷，其中 5 个会让面板第一眼就不可用**。
- **P0 · 让面板可用（5 条）**：
  1. **markdown 渲染整条链是死的**（最严重）。`ChatPanelHost.onMessage` 在第二个 switch 前统一执行 `verifySession()`，而 webview 发来的 `renderMarkdown` / `copy` / `openLink` 按协议设计**本就没有顶层 `sessionId`**，全部在守卫处被丢弃。后果：助手气泡只显示原始 markdown 文本，代码块/加粗/列表/表格都不渲染，复制按钮与链接也不存在。修法：把这四类消息移到守卫**之前**（`renderMarkdown` 本就逐条校验 item 的 sessionId）；另给客户端 bridge 加 `postForSession()`，补上 `openFile` / `openTerminal` 缺失的 `sessionId`。
  2. **流式路径逐 chunk 调 `finalizeStreaming`** → 一次回复碎成 N 个气泡。该方法会把**所有** streaming 条目标记结束，于是 `appendAssistantChunk` 每次走新建分支。修法：给 `finalizeStreaming` 加 `only` 过滤——正文开始时只收束 **thought**，`tool_call` 到达时只收束 **assistant**，轮次结束才全部收束。
  3. **客户端 `append` 非幂等** → 重复 DOM 节点。扩展侧对「就地改写的同一条目」重复发 `append`，客户端无条件 `appendChild` 并覆盖映射，旧节点成孤儿。**与第 2 条是同一处症状的两半，只修一个会从「碎泡」变成「重复泡」**。修法：`append` 先查 `objects[id]`，已存在则走 patch。
  4. **编辑器收不到 running/loading** → 没有 Stop 按钮，且等待中再点发送会**清空 textarea 并丢失草稿**。根因有二：客户端 `sessionsChanged` 只喂给标签行；扩展侧 `refreshSessions()` 在 `await sendPrompt` **之前**调用，那时 `inFlightTurns` 尚未置位。修法：客户端按聚焦会话同步 `setRunning/setLoading`；扩展侧改为「先启动 promise → 再 refresh → 再 await」（`sendPrompt` 的置位发生在第一个 await 之前）。
  5. **工具卡片切会话后变空白**。`TranscriptStore.snapshot()` 的 tool 条目不含 `toolView`，而它只在实时 append 路径挂过一次，且后续 `tool_call_update` 也救不回来（更新函数只改标题/状态/正文，占位框里一个都没有）。修法：`snapshotOf` 用 `ToolInvocationStore` 回填 `toolView`。
- **P1 · 功能补齐（5 条）**：
  6. 思考块永远停在 "Thinking…"（第 2 条的连带修复：收束后必须 post `revise`，否则 webview 那份条目仍是 `streaming: true`）。
  7. `PromptResponse.usage` 与 `stopReason` 被丢弃。改为：非 `end_turn`/`cancelled` 的结束原因追加 notice（`refusal` 尤其重要——ACP 规范明说该轮内容不会进入下一次 prompt，UI 必须反映）；`totalTokens` 归一到 usage 条的 `used`，让只在轮次响应里报 usage 的 agent 也能显示。
  8. 非文本内容块退化成 `[image content]` 占位。新增 transcript 条目类型 `content`，复用已在工具调用路径上验证过的 `ContentBlockView` 渲染（把它从 `toolCallView` 暴露为 `renderContentItem`）。
  9. `plan` 每次更新堆一张新卡片。ACP 的 `plan` 是**整体替换**语义，改为按会话记住唯一条目 id 并走 `revise`。
  10. **终端输出没有数据通路**（跨三个文件）。`TerminalHandler.terminals` 私有且 `terminalOutput()` 对未知 id 抛异常；`terminalHandler` 只是 `connect()` 里的局部变量，`ConnectionInfo` 未暴露——面板连拿都拿不到。修法：新增只读 `readOutput()`（未知 id 返回 `null`）、`ConnectionInfo` 加 `terminals` 字段、面板读输出后作为 content 条目追加。
- **P2 · 清理（6 条）**：删除死协议分支（`sessionOpened` 从未发出、`readSessionId` 无人引用），并补发 `sessionClosed` 让客户端的关闭分支变成活代码；`error` 消息按 sessionId 过滤（后台会话的报错不再落到前台）；`reset()` 补清 `sessionId`（残留会让 markdown 批量请求带错 id 而被静默丢弃）；附件并入 `SessionMeta` 随 focus/boot 下发（原先切标签后 chip 消失但扩展侧仍在发送）；`patch` 的写入键收窄到 `EntryPatch` 的已知键；**确认文案改为「当前会话保留在它的标签中」**（用户决策：多会话下新建只是开标签，原文案与实现不符）。
- **机制增强**：`check-webview-client.mjs` 新增**模板体内反引号检测**。本 Phase 改 `boot.ts` 时**第二次**踩中同一颗地雷（模板字符串内部的 JSDoc 用了反引号），而现有检查器当时只能在拼接后报语法错误、tsc 只给出难以定位的 TS1005。现在直接报 `[BACKTICK] file:line` 并 exit 1，已做负向测试确认（见 pitfalls #11）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；`npm test` 3 passing；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿；`normalize-eol.mjs` 全部 CRLF；`check-webview-client.mjs` 反引号检测负向测试可检出。
  **待人工验证（需 F5，尚未跑）**：见本文件的 Phase 3 计划 §4 —— P0 六条验收（markdown 渲染/单气泡/思考计时/Stop 按钮/工具卡片保活/diff 展开）+ P1 四条 + 八个敌意 markdown 向量 + 旧面板回归。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-011
- **功能**：Chat 面板重写方案 Phase 2 —— 面板路由层 + `src/ui/chat/` 模块骨架（新面板先用于 Claude Code）
- **改动文件**：`src/ui/chat/`（25 个新增文件）、`src/extension.ts`、`CUSTOMIZATIONS/scripts/`（新增 `check-webview-client.mjs`、修 `normalize-eol.mjs`、`check-registry.mjs` 加 §5）、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/pitfalls.md`、`CUSTOMIZATIONS/architecture.md`
- **方案来源**：`C:\Users\zouwei\.claude\plans\dazzling-dancing-pancake.md`（用户已批准）。Phase 1（多会话核心改造）已在 CUSTOM-20260923-010 落地。
- **详细说明**：
  - **路由方式（单视图，经用户拍板）**：视图 id 仍是唯一的 `acpc-chat`，`package.json` **完全不动**，不引入 view 级 `when`、不用 `setContext`。`ChatRouterProvider` 按「聚焦会话所属的 agent」在 `ChatPanelHost`（新）与 `LegacyPanelAdapter`（旧）之间切换。
    否决「双视图 + when 条件显隐」的理由：`acpc-chat.focus` 有 **5 个调用点**（`extension.ts` ×4 + `SessionTreeProvider` 的 `AgentTreeItem.command`），单视图下全部无需改动；侧边栏也不会出现两个聊天入口；且能避开本仓库从未成功用过的 `setContext`（`acpc.turnInProgress` 恒不成立就是前车之鉴）。
  - **让旧面板零改动的关键手法（本 Phase 最有价值的一步）**：`LegacyPanelAdapter` 递给 `ChatWebviewProvider` 的不是真实 `WebviewView`，而是一个 **facade**。已逐点核实旧 provider 对 `WebviewView` 的接触面只有 6 处（`options` / `html` / `cspSource` / `onDidReceiveMessage` / `postMessage` / `onDidDispose` + `show`），facade 完全够用。**`src/ui/ChatWebviewProvider.ts` 一行未改**，上游合并时该文件零冲突。
    facade 的 `onDidReceiveMessage` / `onDidDispose` **刻意不转发**给真实视图，只存回调——真实视图上必须只有路由层那一个监听器，否则旧 provider 会同时经路由分发与直接订阅收到两条消息而重复处理。
  - **扩展侧 transcript（切面板不丢内容的关键）**：`TranscriptStore` 按会话存结构化记录（而非 DOM 字符串），三重上限（500 条/会话、24 会话 LRU、64KB/条），活跃会话豁免 LRU。面板隐藏时记录照常累积，`postMessage` 被守卫丢弃；切回只需推一次快照，**不需要重新 `session/load`**。
  - **webview 无框架、无新构建步骤**：`html/` 下把 HTML 骨架 / CSS / 客户端 JS 拆成模块，编译期拼接进同一个 `<script nonce>`。webview 内没有模块系统（CSP 只允许带 nonce 的内联脚本），每个客户端模块是 IIFE，统一挂到 `window.__acpc`。
  - **markdown 消毒（零新依赖，安全由构造保证）**：实测确认 `marked` v15 默认 renderer 的 `html()` 原样返回原始 HTML、`link()` 只做 `cleanUrl` 不做协议白名单（`[x](javascript:alert(1))` 直通）。`SafeMarkdown` 覆盖 `html`/`link`/`image` 三个钩子：原始 HTML 转义为字面文本（无损且惰性），非 `https?`/`mailto` 的链接降级为纯文本，图片渲染为 chip。另在客户端用 `DOMParser` + 标签/属性白名单兜底。**必须用 `new Marked(...)` 而非 `marked.setOptions(...)`**——旧面板改的是全局单例，共用会互相污染。
  - **CSP 变化**：新面板加了 `img-src ${cspSource} data:`（非文本 ContentBlock 的 base64 图片），`script-src` 仍**只有 nonce**、无 `'unsafe-inline'`。
  - **协议从第一天起就是 session 作用域的**：所有会话相关消息都带 `sessionId`，扩展侧 `verifySession()` 校验其对应会话存在，不匹配一律丢弃并记日志——绝不静默落到「当前聚焦会话」上。
- **顺带修掉的机制缺口（本 Phase 发现）**：
  - `normalize-eol.mjs` 用 `git ls-files`（**只列已跟踪文件**），新建未提交的文件会静默绕过 CRLF 检查。实测：修复前对 25 个 LF 新文件报「所有文件已是 CRLF，无需修正」。已改为 `--cached --others --exclude-standard`（见 pitfalls #10）。
  - 新增 `check-webview-client.mjs` 并接入 `check-registry.mjs` **§5**：把 webview 内联客户端脚本抽出拼接后交给 `new Function()` 做**语法校验**。起因是模板字符串里的两类只在运行时才炸的错误（内部出现反引号、反斜杠忘记双写）——本 Phase 就实际踩中一次（`boot.ts` / `toolCallView.ts` 的 JSDoc 里用了反引号，tsc 只报出难以定位的 TS1005）。已用负向测试确认该检查器能检出并返回 1。
  - `check-registry.mjs` 新增 **§6 源码卫生**：扫描 NUL 等控制字符。起因是 `ChatPanelHost.ts` 的注释里被写入了 2 个**字面 NUL 字节**，导致 `grep` 把源文件当**二进制**跳过——搜索静默失效（见 pitfalls #12）。同一轮里检查脚本自己也曾把字面控制字符嵌进正则，故 §6 改为**按码点判断**而非字面正则。
- **明确非目标**：旧面板的既有缺陷（附件失效、工具调用零详情、`in_progress` 无样式、滚动抢占、无复制按钮、链接不响应）**不在旧面板里修**——那是上游合并冲突的主要来源。它们在新面板里重做。
- **验证方式**：`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；`npx tsc -p . --noEmit` 无错误；`node CUSTOMIZATIONS/scripts/check-webview-client.mjs` 8 个客户端模块拼接后可解析；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 五节全绿；`normalize-eol.mjs --check` 全部 CRLF。
  **待人工验证（需 F5，尚未跑）**：连 Claude Code → 出现带标签行的新面板；连 Gemini CLI → 旧面板；经树切回 → 新面板且 transcript 完好；`package.json` 仍只有**一个** `acpc-chat` 视图且无 view 级 `when`。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-010
- **功能**：核心改造——「单活跃会话」模型改为 **N 进程 × M 会话**（Chat 面板重写方案的 Phase 1）
- **改动文件**：`src/core/SessionManager.ts`、`src/core/AgentManager.ts`、`src/core/SessionHistoryStore.ts`、`src/extension.ts`
- **详细说明**：
  - **背景**：上游假设同一时间只有一个已连接 agent、一个会话。这个假设散落在四处：
    (a) `activeSessionId` 唯一；(b) `agentSessions` 是 `Map<agentName, sessionId>` 1:1 映射；
    (c) `connectToAgent` 主动断开前一个 agent；(d) `newConversation` 走 disconnect → reconnect。
    协议本身**没有**这个限制——ACP 的每个请求/通知都带 `sessionId`，SDK 的 `SessionId`
    文档注释明写"允许与同一个 agent 有多个独立交互"。所以改造全部落在实现层，不动协议。
  - **顺带修掉的两个真 bug**（都是审查中发现的，非本次改造引入）：
    ① **进程泄漏不可回收**：`loadSession`/`resumeSession` 会把同 agent 的旧会话从
    `sessions`/`agentSessions` 里删掉**但不杀它的进程**；而 `disconnectAgent` 在
    `agentSessions` 查不到条目时**提前返回**，于是泄漏的进程再也无法通过任何公开 API 回收，
    同时 `getConnectedAgentNames()`（由 `agentSessions.keys()` 派生）也不再报告它。
    现在 `agentProcesses` 是独立索引，`disconnectAgent` 一律回收。
    ② **EventEmitter 监听器泄漏 + 盲区**：`connectToAgent` 每次调用都注册一对新的
    `agent-error`/`agent-closed` 监听器且**从不移除**（Node 在 10 个以上会告警）；
    反过来 `ensureConnected` 路径**完全不注册**，该路径创建的会话没有错误/退出处理。
    现在改为构造函数里唯一一次订阅，靠 `agentProcessNames` 反查 agent 名分发。
  - **设计要点**：**一个 agent 名只对应一个进程**，进程内承载 M 个会话。这是有意简化——
    `SessionHistoryStore` / `SessionTreeProvider` / `AgentConfig` 全都假设 `agentName → agentId` 唯一。
  - **控制面串行化**：`enqueueControl()` 仅包裹 `session/new` / `load` / `resume` / `close`。
    `prompt` **刻意保持并发**（那是本功能的意义）。同一连接上「一边流式输出一边建新会话」是否
    可行尚未实测（见 `CUSTOMIZATIONS/src/phase0-traffic/` 待补的探针 (c)），这层队列在两种情况下
    都无风险：并发成立时开销是微秒级，不成立时正好避免跨会话卡死。
  - **兼容性**：事件契约**只追加尾参、不改名**，`SessionTreeProvider` 与 `StatusBarManager`
    只消费 `getActiveSessionId()`/`isAgentConnected()`，零改动即可继续工作。
    `ChatWebviewProvider.ts` **一行未改**。
  - **行为变化（需注意）**：`isAgentConnected` 现在会为「已探测但无会话」的 agent 报告已连接
    （上游只认 `agentSessions`）——这是修复，但树上会因此亮绿灯。
- **验证方式**：`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；
  `node CUSTOMIZATIONS/scripts/check-registry.mjs` 四节全绿；`normalize-eol.mjs` 仅 `SessionManager.ts`
  需回写 CRLF（Write 工具产出 LF，已修正）。
  **待人工验证（需在 Extension Development Host 中执行，尚未跑）**：连跑三次 `acpc.newConversation`
  → 流量日志应只有**一次** `initialize`、三次 `session/new`、任务管理器只有一个 node/npx 子进程；
  `acpc.openSession` 打开另一个会话 → 不出现 `agent-closed`；重跑原泄漏路径 → 旧进程仍存活**且**
  可被 `acpc.disconnectAgent` 回收
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-009
- **功能**：macOS 上跳过 `npm test`（上游既有工具链问题），让 CI 恢复绿色信号
- **改动文件**：`.github/workflows/ci.yml`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **详细说明**：
  - **现象**：008 之后 macOS 的自检已通过，但同一 job 的 `npm test` 仍失败：
    `spawn .../vscode-darwin-arm64-1.139.0/Visual Studio Code.app/Contents/MacOS/Electron ENOENT`。
  - **诊断**：日志显示 "Downloading (299.02 MB)" 后 **12 秒**就报 "Downloaded"——
    299MB 不可能 12 秒下完，是**解压静默失败**，Electron 二进制压根不存在。
  - **判定为上游既有问题**：`gh run list -R formulahendry/vscode-acp` 显示上游 CI
    **历史上没有任何一次成功**（全是 failure / action_required）。不是本仓库引入的。
  - **处理（不修，只隔离）**：macOS 上仍跑机制自检与打包，仅把启动 VS Code 的测试步骤
    限制为 `if: runner.os == 'Windows'`（Linux 走 `xvfb-run`）。
    **刻意不用 `continue-on-error`**——那会让 build 显示绿但实际有失败，掩盖真问题。
  - **为什么保留 macOS 的 job**：机制自检的跨平台覆盖有价值且已被证明——
    正是它在 macos-latest 上抓出了 #8 的 bash 3.2 不兼容。
- **验证方式**：js-yaml 解析确认步骤与 `if` 条件正确；CI 三平台 job 全绿；macOS 日志中
  `Check custom-development invariants` 为 ✓ 而测试步骤被跳过
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-008
- **功能**：自检脚本从 bash 移植到 Node —— 修 macOS 兼容性（007 的 CI 直接抓出来的）
- **改动文件**：`CUSTOMIZATIONS/scripts/check-registry.mjs`（新增，取代 .sh）、`CUSTOMIZATIONS/scripts/check-registry.sh`（删除）、`.github/workflows/ci.yml`、`CUSTOMIZATIONS/README.md`、`CUSTOMIZATIONS/docs/pitfalls.md`、`.agents/skills/（acp-record-change、acp-merge-upstream、acp-release）`、`CUSTOMIZATIONS/scripts/list-custom.ps1`
- **详细说明**：
  - **问题**：007 把机制自检接进 CI 的三平台矩阵后，**macos-latest 立刻失败**：
    `check-registry.sh: line 17: declare: -A: invalid option`。
    根因是 **macOS 自带 bash 3.2**（2007 年版，苹果因 GPLv3 一直未升级），不支持关联数组 `declare -A`；
    本地 Git Bash 是 bash 5，所以在本机永远发现不了。
  - **解法**：整个自检脚本移植为 **Node**（`check-registry.mjs`），删除 bash 版。
    理由：①Node 在本项目是硬依赖（`npm install` 是前置步骤）；②`normalize-eol.mjs` 已有先例；
    ③彻底消除 Windows/Linux/macOS 的 shell 方言差异——而 CI 恰恰是三平台跑的。
    逻辑完全保留四节（标记↔账本 / 反向校验 / 命名空间卫生 / 换行符卫生），
    输出格式与退出码不变。
  - **移植中的一个自伤**：初版 `walk()` 只返回文件列表却没把结果传给 `collect()`，
    导致含标记文件数从 12 误报成 2。**靠与 bash 版对照计数**才发现——
    这条验证手段值得保留。
  - **验证手段**：用**反向测试**确认检测有效（临时删掉 `src/extension.ts` 那一行 →
    脚本报 `[MISSING-IN-DOC]` 并退出 1 → 还原后全绿）。
- **验证方式**：Node 版与 bash 版输出一致（均为 12 个含标记文件）；反向测试能正确检出遗漏并返回 1；还原后 `git diff` 无残留；`grep -rn "check-registry.sh"` 仅剩历史变更日志条目
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-007
- **功能**：修复 CI 完全失效的问题；把机制自检接入 CI；脚本调用从 `sh` 改为 `bash`
- **改动文件**：`.github/workflows/ci.yml`、`CUSTOMIZATIONS/README.md`、`CUSTOMIZATIONS/scripts/（check-registry.sh、release-vsix.sh、list-custom.ps1）`、`.agents/skills/（acp-record-change、acp-merge-upstream、acp-release）`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **详细说明**：
  - **CI 失效（本次核心发现）**：`ci.yml` 的 `push`/`pull_request` 都过滤 `branches: [main]`，但本仓库是 fork，根本没有 `main` 分支（默认与开发分支是 `custom/main`，上游镜像在 `vendor/main`）——**CI 从建仓起就没触发过，也永远不会触发**。这也解释了 `gh workflow list` 里看不到它。改为 `[custom/main]`；`vendor/main` 由 sync-vendor.ps1 推进，不需要 CI。
  - **机制自检入 CI**：新增「Check custom-development invariants」步骤跑 `check-registry.sh`，把"每次登记必须全绿"从口头约定变成 CI 强制，可自动拦住整文件伪差异（pitfalls #7）与半重命名（pitfalls #2）两类坑。放在三平台矩阵里是有意的，顺带验证换行符规则在 Linux/macOS 上也成立。
  - **`sh` → `bash`**：`check-registry.sh` 用了 `declare -A` / `[[ ]]` / `BASH_REMATCH` / `pipefail` 等 bash 专有特性，而 Ubuntu runner 的 `sh` 是 dash——用 `sh` 调用会直接报错。全部文档与脚本内的调用示例统一改为 `bash`。
  - **修正过程中的自伤**：批量 `s|sh CUSTOMIZATIONS/scripts/|bash ...|` 时，模式子串匹配到了 `pw**sh** CUSTOMIZATIONS/scripts/` 里的 `sh`，产出 4 处 `pwbash`，已修正。**与 pitfalls #3 是同一类错误（模式边界不当）**。
- **验证方式**：js-yaml 解析确认 `on = {push: [custom/main], pull_request: [custom/main]}`、步骤含 Check custom-development invariants；`grep -rn "pwbash"` 无残留；`grep -rn "sh CUSTOMIZATIONS/scripts"` 无残留；换行符仍为 CRLF；check-registry.sh 四节全绿
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-006
- **功能**：`publish.yml` 改为纯手动打包，去掉与手动发布重复的自动触发
- **改动文件**：`.github/workflows/publish.yml`
- **详细说明**：v0.2.0-custom.1 发布后暴露的一个设计冗余——`publish.yml` 原以 `release: created` 自动触发并挂 `.vsix` 到 Release，而本仓库的发布主路径是本地 `gh release create`（acp-release skill）。两者并存会让每次发布都多挂一个名为 `extension.vsix` 的冗余名资产。现改为：**仅 `workflow_dispatch` 手动触发**，产出 workflow artifact，**完全不接触 GitHub Release**；workflow 名 `Publish` → `Package (Manual)`，job `publish` → `package`，上传步骤从 `softprops/action-gh-release` 换成 `actions/upload-artifact@v4`。**文件名刻意保留 `publish.yml`**：它是上游也有的文件，改名会让后续合并上游产生 delete/modify 冲突。
- **验证方式**：js-yaml 解析确认 `triggers = {workflow_dispatch}`、无 release/marketplace/softprops 残留（排除注释行）；换行符仍为 CRLF（用 Edit 工具而非 Write，避免踩 pitfalls #7）
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-005
- **功能**：固定换行符处理，修复整文件伪差异（首次提交前发现，属阻断性问题）
- **改动文件**：`.gitattributes`（新增）、`CUSTOMIZATIONS/scripts/normalize-eol.mjs`（新增）、`CUSTOMIZATIONS/scripts/check-registry.sh`、`CUSTOMIZATIONS/scripts/release-vsix.sh`、`.agents/skills/acp-merge-upstream/SKILL.md`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **详细说明**：
  - **问题**：上游 `formulahendry/vscode-acp` 的 blob **以 CRLF 入库**（仓库无 `.gitattributes`），本机 `core.autocrlf=true`。`sed -i`、`Write` 工具、`npm install` 均产出 LF，把 12 个已跟踪文件转成了 LF，导致 `git diff --stat` 出现 14339 插入 / 12788 删除的伪差异（`ChatWebviewProvider.ts` 显示 5121 行变更，实际只改了 4 行）。**真正的危害是后续每次合并上游都会变成全文件冲突**，三方合并能力彻底丧失。
  - **修复**：①新增 `.gitattributes` 写 `* -text`（关闭 EOL 转换、按字节原样存取，`-text` 不影响 diff/merge）；②新增 `normalize-eol.mjs` 做批量归一化与 `--check` 自检；③把 12 个被翻转的文件转回 CRLF。
  - **防复发**：`check-registry.sh` 新增 §4 换行符卫生检查；`release-vsix.sh` 在 `npm install` 后自动把 `package.json` 与 `package-lock.json` 转回 CRLF（写版本号的 node 脚本与 npm install 都产出 LF）；`acp-merge-upstream` skill 的验证步骤前置归一化。
  - **判据分两类**（修的过程中踩到的第二个坑）：**上游共有文件**（`src/`、`package*.json`、`.github/`、`.gitignore`、`.vscodeignore` …）必须 CRLF；**纯自定义路径**（`CUSTOMIZATIONS/`、`.agents/`、`AGENTS.md`、`.gitattributes`）必须 LF——带 CRLF 的 `.sh` 在 Linux/macOS 上会执行失败。第一版 `normalize-eol.mjs` 一刀切成 CRLF，提交后自检立刻抓到 `sync-vendor.ps1` 被误判，已补 `CUSTOM_ONLY` 判据。
  - **测量教训**：Git Bash 的 `grep -U $'\r'` 仍可能走文本模式，读数不可靠（本次被误导过一次），须用 node 直接读字节。
- **验证方式**：`node CUSTOMIZATIONS/scripts/normalize-eol.mjs --check` → 40 个文件全部 CRLF；`git diff --numstat src/extension.ts` 从 `544/544` 降至 `35/30`；`git diff --stat` 全仓从 14339/12788 降至 228/378
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-004
- **功能**：`publish.yml` 改造为只打包发 Release，不发布插件市场；命令 title 前缀补全；AGENTS.md 补会话礼仪
- **改动文件**：`.github/workflows/publish.yml`、`package.json`、`.vscodeignore`、`AGENTS.md`
- **详细说明**：
  - **publish.yml**：用户决策——本仓库是自用 fork，**不发布到 VS Code Marketplace / Open VSX**。移除 `Publish to Visual Studio Marketplace` 与 `Publish to Open VSX Registry` 两步（依赖 `secrets.VSCE_PAT`/`secrets.OVSX_PAT`，本仓库无这些 secret，release created 触发即失败）；保留三平台 `test` 矩阵作为打包前门禁；job `publish` 改名 `package`；`npx vsce package` 改为 `npx @vscode/vsce package`；保留 `softprops/action-gh-release` 上传 `.vsix` 作为 Release 资产。
  - **命令 title 补全**：上一轮只给带 `ACP: ` 前缀的命令加了 `ACP (Custom): `，遗漏上游本就无前缀的 3 个（Refresh / Copy Session ID / Forget Session）。这 3 个在右键菜单与视图标题中同样会与上游同名，本轮补齐，**全部 21 个命令统一前缀**。
  - **.vscodeignore**：追加 `.github/**`——CI 配置无需随扩展分发给用户。
  - **AGENTS.md**：补「每次回复开头都要先喊一声"啊唯"」会话礼仪约定（与 custom-chatbox 保持一致）。
- **验证方式**：`npm run lint` 通过；`npm run compile` 成功；`grep -c '"title": "ACP (Custom): ' package.json` = 21；`sh CUSTOMIZATIONS/scripts/check-registry.sh` 全绿；重新 `vsce package` 确认 `.vsix` 内不再含 `.github/`
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-003
- **功能**：打包与忽略卫生——确保自定义开发机制文件不进入 `.vsix`
- **改动文件**：`.vscodeignore`、`.gitignore`
- **详细说明**：`.vscodeignore` 追加 `CUSTOMIZATIONS/**`、`.agents/**`、`.claude/**`、`AGENTS.md`、`release/**`；`.gitignore` 追加 `release/`、`.zcode/plans/`、`.claude/explore-results/`。两处均用 `# [CUSTOM-BEGIN]/[CUSTOM-END]` 注释包裹。
- **验证方式**：`npx @vscode/vsce package` 后 `npx @vscode/vsce ls --tree | grep -i "customiz\|agents\|AGENTS"` 无输出（31 个文件，487KB）
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-002
- **功能**：移除遥测上报
- **改动文件**：`src/utils/TelemetryManager.ts`、`src/extension.ts`、`package.json`、`package-lock.json`
- **详细说明**：上游 `TelemetryManager.ts` 硬编码了作者自己的 Application Insights 连接串 `InstrumentationKey=c4d676c8-3b21-4047-8f57-804f20ccb62d` 并向其上报使用数据。本 fork 将整个模块重写为 **no-op**（返回 `vscode.Disposable` 空对象 + 三个空函数，未用参数加 `_` 前缀以过 eslint `no-unused-vars`），保留同名 API 使其余约 18 处调用点零改动。移除 `package.json` 的 `@vscode/extension-telemetry` 依赖并 `npm install` 重新生成锁文件。额外移除 `extension.ts` 中的 `sendEvent('extension/activated', …)`——其参数读取上游扩展 id `formulahendry.acp-client`，在 fork 中恒为 undefined。
- **验证方式**：`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；`grep -c extension-telemetry package-lock.json` = 0
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-001
- **功能**：扩展身份自定义 + 全局命名空间重命名（使 fork 可与上游同时安装而不冲突）
- **改动文件**：`package.json`、`src/extension.ts`、`src/ui/SessionTreeProvider.ts`、`src/ui/ChatWebviewProvider.ts`、`src/ui/StatusBarManager.ts`、`src/config/AgentConfig.ts`、`src/handlers/PermissionHandler.ts`、`src/utils/Logger.ts`、`src/test/extension.test.ts`
- **详细说明**：
  - **背景**：用户目标是与上游 `formulahendry.acp-client` 同时安装、独立配置。仅改 publisher/name **不够**——VS Code 的命令 id、视图 id、视图容器 id、配置段 key 在整个 IDE 实例内**全局唯一**，与扩展 id 无关（详见 pitfalls #2）。
  - **身份**：`zouv.acp-client-custom` / displayName `ACP Client (Custom)` / description 标注 custom fork / repository、bugs、homepage 指向 zouv/custom-vscode-acp（并移除上游 `bugs.email`，避免把 issue 发给原作者）。
  - **命名空间**：`acp.*` → `acpc.*`，覆盖 21 个命令 id、视图容器 id（`acp-client` → `acp-client-custom`）、视图 id（`acp-sessions`/`acp-chat` → `acpc-sessions`/`acpc-chat`）、4 个配置键、上下文键 `acpc.turnInProgress`、输出通道名、命令 title 前缀（→ `ACP (Custom): `，避免命令面板与上游同名）。执行方式为 `grep -rn` 穷举而非硬编码清单。
  - **故意不改的两处**：`SessionHistoryStore.ts` 的 Memento key `acp.sessionHistory.v1`（改了会丢历史）与 `ConnectionManager.ts` 的 ACP clientInfo 名 `vscode-acp-client`（协议元数据，非全局命名空间）。见 pitfalls #4。
  - **无标记处理**：`package.json` 是 JSON 不能加注释，按 README 的"无标记三情形"登记；`src/` 中参与全局重命名的 7 个文件在**文件头**加一对 `[CUSTOM-BEGIN]/[CUSTOM-END]` 说明（散落全文的重命名无法逐处包裹）。
- **验证方式**：`npm run lint` 通过；`npm run compile` 成功；反向 grep 复核残留（`grep -rn "acp\.\|acp-sessions\|acp-chat" src/ package.json` 仅剩标记注释与两处故意保留）；`npx @vscode/vsce package` 产物 manifest 为 `Id=acp-client-custom Publisher=zouv`
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-000
- **功能**：初始化自定义开发结构
- **改动文件**：`AGENTS.md`、`CUSTOMIZATIONS/`（README.md、architecture.md、registry.md、docs/pitfalls.md、release-notes/、src/、patches/、scripts/）、`.agents/skills/`
- **详细说明**：移植 zouv/custom-chatbox 的自定义开发机制并按 VS Code 扩展语境适配：①上游无 tag → vendor 基线固定 `vendor/main` + commit hash 锚点（`current_upstream_version` 改取上游 package.json 的 version）；②pnpm → npm（冲突策略表的 `pnpm-lock.yaml` 行改为 `package-lock.json`）；③Electron/electron-builder → webpack/.vsix（release skill 的 release+publish 两段合并为一段）；④新增"无标记三情形"规则处理 JSON / 测试文件 / 全局重命名。建立分支基线 `vendor/main`（上游 main 镜像）与 `custom/main`（开发主线）。
- **验证方式**：`git branch -vv` 确认分支与跟踪关系；`sh CUSTOMIZATIONS/scripts/check-registry.sh` 全绿
- **基于上游版本**：0.2.0（commit e7371659）
