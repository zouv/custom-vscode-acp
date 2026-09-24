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

---
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
