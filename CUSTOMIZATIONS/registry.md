---
current_upstream_version: "0.2.0"
current_upstream_commit: "e7371659e3ac100db842b419b1361205a193032e"
custom_version: "0.2.0-custom.1"
last_merge_date: "2026-09-23"
last_release_version: "v0.2.0-custom.1"
last_release_date: "2026-09-23"
vendor_branch: "vendor/main"
upstream_remote: "https://github.com/formulahendry/vscode-acp.git"
---

# ACP Client (Custom) 自定义改动登记

> **本文件是改动登记账本（纯数据）**。机制与规则（冲突策略、标记格式、类型/状态字典、frontmatter 字段职责）见 [`CUSTOMIZATIONS/README.md`](./README.md)。
>
> **只读这一节：「改动总览」**（就在下方）。每个文件一条，多轮演进已合并为当前状态——
> 查"某个文件现在改了什么、上游合并时怎么处理"看它就够了。
>
> **不要读变更日志**：它已拆到 [`docs/changelog.md`](./docs/changelog.md)（42KB，append-only 历史流水）。
> 只在需要追查某次改动的来龙去脉时才去读。
> 拆分原因：原先单体 59KB 而 `AGENTS.md` 把它列为每次任务前必读，等于每次白读 40KB 历史。
>
> **AI Agent 注意**：
> 1. 开发前读**改动总览**定位相关文件与冲突策略
> 2. 完成改动后调用 `acp-record-change` skill：**总览里已有该文件就更新那一节**（合并描述、追加演进链 id），没有就新增一节；同时在 [`docs/changelog.md`](./docs/changelog.md) **顶部追加一条**（注意是两个文件）
> 3. 合并上游时按总览的冲突策略列处理；合并后用 `check-registry.mjs` 复核（它已包含 `acp.*` → `acpc.*` 命名空间扫描，见 §3）
> 4. 不要删除历史（总览条目整体废弃时标 deprecated；changelog 永不删改）
> 5. 一致性自检：`node CUSTOMIZATIONS/scripts/check-registry.mjs`（代码标记 ↔ 总览表双向比对；CI 上也会跑）

---

## 仓库信息

- **上游仓库**：https://github.com/formulahendry/vscode-acp
- **当前基于上游版本**：0.2.0（上游**无 tag**，此值为上游 package.json 的 version，仅表达语义版本）
- **当前基于上游 Commit**：e7371659e3ac100db842b419b1361205a193032e（**唯一定位依据**）
- **当前 Vendor 分支**：vendor/main
- **最近一次上游合并**：2026-09-23
- **最近一次发布版本**：v0.2.0-custom.1（2026-09-23）

---

## 改动总览（按文件）

> **每个文件一条**：该文件当前生效的全部自定义改动（多轮演进已合并）；「标记」列为代码中 `[CUSTOM-BEGIN]` 的 change-id（即该文件自定义区的当前真相），演进链标注历轮 id。代码位置速查见 [`architecture.md`](./architecture.md) §2。
>
> **状态字典**：`active`（生效中）/ `deprecated`（已废弃）/ `merged-upstream`（上游已原生支持）。**冲突策略**字典见 README.md。
>
> **无标记四情形**（详见 README.md）：JSON 无注释 / 测试文件 / 全局性重命名走文件头标记 / "故意保留"说明行必须含 `未改动` 或 `非改动`。

| 文件 | 标记（当前） | 演进链 | 当前效果（合并后） | 冲突策略 | 状态 |
|------|-------------|--------|-------------------|---------|------|
| package.json | （JSON 不支持注释，已知无标记缺口） | 20260923-001→002→014 | ①身份：name `acp-client-custom`、publisher `zouv`、displayName `ACP Client (Custom)`、description 标注 custom fork、repository/bugs/homepage 指向 zouv/custom-vscode-acp，移除上游 `bugs.email`；②命名空间：21 个命令 id → `acpc.*`、视图容器 id → `acp-client-custom`、视图 id → `acpc-sessions`/`acpc-chat`、配置段 → `acpc.agents` 等 4 项、上下文键 → `acpc.turnInProgress`、configuration.title / viewsContainer.title → `ACP Client (Custom)`；③命令 title：**全部 21 个**加 `ACP (Custom): ` 前缀（含上游无 `ACP:` 前缀的 Refresh / Copy Session ID / Forget Session），避免与上游在命令面板与右键菜单中同名；④依赖：移除 `@vscode/extension-telemetry`；⑤**`scripts` 新增 `dev:host`**（→ `node CUSTOMIZATIONS/scripts/dev-host.mjs`，一条命令编译并启动 Extension Development Host）。**合并上游时注意**：`scripts` 块是本文件里最可能冲突的区域之一，`dev:host` 这一行要保留 | merge-manual | active |
| package-lock.json | （锁文件，无标记） | 20260923-002 | 移除 `@vscode/extension-telemetry` 后由 `npm install` 重新生成 | 接受上游版本后 `npm install` 重新生成 | active |
| .vscodeignore | 20260923-003 | 20260923-003 | 追加排除 `CUSTOMIZATIONS/**`、`.agents/**`、`.claude/**`、`AGENTS.md`、`release/**`、`.github/**`，防止开发机制文件与 CI 配置被打进 `.vsix` | merge-manual | active |
| .gitignore | 20260923-003 | 20260923-003 | 追加忽略 `release/`、`.zcode/plans/`、`.claude/explore-results/` | merge-manual | active |
| src/extension.ts | 20260923-001/002/010/011/012 | 20260923-001→002→010→011→012 | ①文件头标记：本文件参与全局命名空间重命名（`createTreeView('acpc-sessions')`、21 处 `registerCommand('acpc.*')`、`executeCommand('acpc-chat.focus')`、`getConfiguration('acpc')` ×2）；②移除 `extension/activated` 遥测上报（原实现读取 `formulahendry.acp-client` 的版本号，fork 后该 id 不存在）；③**多会话改造**：事件接线改为 session 作用域——所有转发到聊天面板的事件（`clear-chat`/`mode-changed`/`model-changed`/`session-load-start`/`session-load-end`/`session-info-changed`）统一以 `getActiveSessionId()`（聚焦会话）过滤，否则后台会话的更新会打到前台面板上；`connectAgent` 的切换确认文案由「将断开 X 并清空历史」改为「X 在后台保持连接」；④**面板路由**：`registerWebviewViewProvider` 的 provider 由 `ChatWebviewProvider` 换成 `ChatRouterProvider`（视图 id 仍是唯一的 `acpc-chat`）；`active-session-changed` 的订阅从本文件移到路由层（焦点变化正是决定哪个面板接管视图的依据）；⑤**确认文案修正**：`newConversation` / `openSession` 两处由「会清空/替换聊天记录」改为「当前会话保留在它的标签中」——多会话下新建只是开新标签，原文案与实现不符 | merge-manual | active |
| src/ui/SessionTreeProvider.ts | 20260923-001 | 20260923-001 | 文件头标记：树项命令 id 全部改为 `acpc.*`（`acpc.openChat` / `acpc.openSession` / `acpc.loadMoreSessions` / `acpc.connectAgent` / `acpc.refreshSessions`） | merge-manual | active |
| src/ui/ChatWebviewProvider.ts | 20260923-001 | 20260923-001 | 文件头标记：`viewType` 改为 `acpc-chat`；内联 HTML 里 welcome 按钮的 `executeCommand('acpc.connectAgent')` / `('acpc.addAgent')`。**CUSTOM-20260923-011 起它成为 legacy 面板，被 LegacyPanelAdapter 用 facade 包装后接入路由层——本文件本身零改动**，旧缺陷也不在此文件内修（见该轮日志的「非目标」） | merge-manual | active |
| src/ui/chat/（新 Chat 面板与路由层，全部为新增文件：`index.ts`、`ChatRouterProvider.ts`、`ChatPanelHost.ts`、`LegacyPanelAdapter.ts`、`panelContract.ts`、`protocol.ts`、`markdown.ts`、`transcript/`、`content/`、`nesting/`、`html/`） | 20260923-011/012/013/017 | 20260923-011→012→013→017 | 上游**没有**这些文件，因此不会产生合并冲突（`git merge vendor/main` 只触碰上游改过的路径）。用途：①单视图路由层按聚焦 agent 分发新/旧面板；②扩展侧 `TranscriptStore` 支撑多会话标签页与「切面板不丢内容」；③`ToolInvocationStore` 实现 ACP 的 replace-collection 语义；④`SafeMarkdown` 零依赖 markdown 消毒；⑤`html/` 下把 webview 的 HTML/CSS/JS 拆成可维护模块，编译期拼接（无新构建步骤）；⑥`nesting/` 子 agent 分组推断（**ACP 无嵌套概念，全部是启发式**，UI 上标注为推断）。**012 修复了首次审计出的 15 个缺陷**（详见该轮日志）。**013 新增 `nesting/`**。**017 修复阻断级 bug**：`hidden` 属性被 `styles.ts` 里的 `display: flex` 覆盖导致加载遮罩常驻（并吞掉全面板点击），加一条全局 `[hidden]{display:none!important}` 修好（详见该轮日志）。每个文件都带 `[CUSTOM-BEGIN]` 头标记以便追溯 | keep-ours | active |
| src/test/nesting.test.ts | （测试文件，无标记） | 20260923-013 | 新增 11 个单元测试钉死嵌套推断的行为，重点是「宁可漏连不可错连」的护栏（等跨度不连、并列不连、子不可早于父、深度上限、显式证据优先于时序猜测）。测试文件按机制约定不要求 `[CUSTOM-BEGIN]` 标记 | keep-ours | active |
| src/ui/StatusBarManager.ts | 20260923-001 | 20260923-001 | 文件头标记：状态栏点击命令改为 `acpc.connectAgent` | merge-manual | active |
| src/config/AgentConfig.ts | 20260923-001 | 20260923-001 | 文件头标记：`getConfiguration('acpc')`（读 `acpc.agents`） | merge-manual | active |
| src/handlers/PermissionHandler.ts | 20260923-001 | 20260923-001 | 文件头标记：`getConfiguration('acpc')`（读 `acpc.autoApprovePermissions`） | merge-manual | active |
| src/utils/Logger.ts | 20260923-001 | 20260923-001 | 文件头标记：输出通道名改为 `ACP Client (Custom)` / `ACP Traffic (Custom)`；`getConfiguration('acpc')`（读 `acpc.logTraffic`） | merge-manual | active |
| src/utils/TelemetryManager.ts | 20260923-002 | 20260923-002 | **整体重写为 no-op**：删除硬编码的上游 Application Insights 连接串 `InstrumentationKey=c4d676c8-…`，不再 import `@vscode/extension-telemetry`；保留 `initTelemetry` / `sendEvent` / `sendError` / `sendException` 同名 API（空实现 + `_` 前缀未用参数）以免调用点扩散 | keep-ours | active |
| src/test/extension.test.ts | （测试文件，无标记） | 20260923-001 | 断言更新：扩展 id `zouv.acp-client-custom`；命令前缀断言 `acpc.`；`acpc.connectAgent` / `acpc.newConversation` / `acpc.openChat` | keep-ours | active |
| src/core/SessionManager.ts | 20260923-010 | 20260923-010 | **多会话 / 多 agent 并行改造**（上游为「单活跃会话」模型）：①`agentSessions` 由 1:1 映射改为 `Map<agentName, Set<sessionId>>`；②新增 `agentProcesses`/`agentProcessNames`（agent 名 ↔ 进程 id 双向索引，作为「是否已连接」的真相源——仅探测无会话的 agent 现在也正确报告已连接）、`inFlightTurns`（每会话在途轮次守卫）、`connectionQueues`（每连接控制面串行化，仅包 `session/new`/`load`/`resume`/`close`；`prompt` 刻意保持并发，那正是本功能的意义）；③**删除** `connectToAgent` 强制断开前一个 agent、`newConversation` 的 disconnect+reconnect、`loadSession`/`resumeSession` **驱逐同 agent 旧会话但不杀进程**（进程泄漏不可回收的根因）三处逻辑；④新增 `createSession`/`closeSession`/`focusSession`（焦点变更的唯一收口点）；⑤生命周期监听器移到构造函数一次性注册——修上游「每次 connect 注册一对监听器且从不移除」的 EventEmitter 泄漏，以及 `ensureConnected` 路径完全不注册导致无错误/退出处理的盲区；⑥`sendPrompt` 第二参数放宽为 `string \| ContentBlock[]`（为附件 `resource_link` 铺路）并加在途守卫；⑦`summarizeCapabilities` 补 `close`/`fork`（`close` 是多会话干净关闭所需）；⑧事件契约**仅追加尾参、不改名**：`active-session-changed` 追加 `agentName`、`agent-closed` 追加 `agentName`、`clear-chat` 追加 `(agentName, sessionId)`，新增 `session-created`/`session-closed`；`activeSessionId` 语义由「唯一活跃」变为「聚焦」 | merge-manual | active |
| src/core/AgentManager.ts | 20260923-010 | 20260923-010 | 生命周期事件补充 agent 名（`agent-error` / `agent-closed` 事件体加 `name` 字段），使 SessionManager 能在单一订阅点把 `agentId` 反查回配置键。纯新增字段，现有消费者按需解构，无破坏性 | merge-manual | active |
| src/core/SessionHistoryStore.ts | 20260923-010 | 20260923-010 | **多会话支持：活跃会话豁免**。新增 `liveSessionIds` 与 `setLiveSessions()`（由 SessionManager 在会话索引变化时推送），`enforceCap` 与 `reconcileFromAgent` **永不**驱逐/剔除活跃 sessionId——多会话会大幅加速会话创建，否则活跃会话会被容量淘汰或 `session/list` 对账删掉，从树上消失而进程仍在跑。`STATE_KEY` 仍为 `acp.sessionHistory.v1`（`workspaceState` 的 Memento key，扩展内作用域，**故意保留**，改名会丢既有历史，见 pitfalls #4） | merge-manual | active |
| src/core/ConnectionManager.ts | 20260923-012 | 20260923-012 | `ConnectionInfo` 新增 `terminals: TerminalHandler` 字段并在 `connect()` 里填入。原因：`TerminalHandler` 此前只在 `connect()` 里作为局部变量存在（仅被 `AcpClientImpl` 的私有字段引用），聊天面板拿不到任何句柄，工具卡片上的终端 chip 是无数据的死控件。`clientInfo.name` 仍是 `vscode-acp-client`——那是 ACP `initialize` 上报给 agent 的客户端名，协议元数据，**故意保留**（见 pitfalls #4） | merge-manual | active |
| src/handlers/TerminalHandler.ts | 20260923-012 | 20260923-012 | 新增只读访问器 `readOutput(terminalId)`：返回 `{output, truncated, exited, exitCode, exitSignal}`，未知 id 返回 `null` 而不是抛异常。ACP 的 `Terminal` 工具内容只是引用（`{terminalId}`），终端归客户端所有也由客户端渲染；上游唯一的读取路径 `terminalOutput()` 对未知 id **抛异常**，不适合 UI 调用 | merge-manual | active |
| CUSTOMIZATIONS/（README.md、registry.md、architecture.md、docs/pitfalls.md、docs/changelog.md、docs/dev-workflow.md、release-notes/、patches/、scripts/） | （纯自定义目录） | 20260923-000→015→016 | 自定义开发机制：规则唯一源 + 改动账本（**总览在 registry.md、日志在 docs/changelog.md，016 拆分**） + 代码地图 + 坑点库 + 本地开发与验收流程。**`src/` 是死的**：不在 tsconfig/webpack 构建图内，放那里的 `.ts` 编译不了，新代码请放仓库根 `src/`（016 修正了原先教错的做法）。移植自 zouv/custom-chatbox 并按 VS Code 扩展语境适配（npm / webpack / .vsix / 上游无 tag） | keep-ours | active |
| CUSTOMIZATIONS/scripts/（init-repo.ps1、sync-vendor.ps1、list-custom.ps1、check-registry.mjs、check-webview-client.mjs、**dev-host.mjs**、release-vsix.sh、normalize-eol.mjs） | （纯自定义目录，逐文件标记非必需） | 20260923-000→005→008→011→012→014 | 仓库基线初始化、vendor 同步（`-Ref` 代替 `-Version`）、改动清单查询、一致性自检（六节：标记↔账本 / 反向校验 / 命名空间卫生 / 换行符 / **webview 客户端脚本可解析性** / **源码控制字符卫生**，**Node 实现**）、webview 内联客户端脚本语法自检、**本地启动测试环境**（`npm run dev:host`）、.vsix 打包封装、换行符归一化工具。**011 两处修复**：①`normalize-eol.mjs` 原先用 `git ls-files`（只列已跟踪文件），新建未提交的文件会静默绕过 CRLF 检查——改为 `--cached --others --exclude-standard`（pitfalls #10）；②`check-registry.mjs` 新增 §6 扫描 NUL 等控制字符（pitfalls #12）。**012 增强**：`check-webview-client.mjs` 新增**模板体内反引号检测**——此前这类错误只能靠 tsc 报出难以定位的 TS1005（pitfalls #11 的第二次复发）。**014 新增**：`dev-host.mjs`。**017**：`check-webview-client.mjs` 的扫描范围从 `html/client/` 扩到整个 `html/` 树——原先漏扫 `styles.ts`/`body.ts`/`shell.ts`，导致「tsc 报错而检查器说 OK」 | keep-ours | active |
| .gitattributes | 20260923-005 | 20260923-005 | **新增**。写 `* -text` 关闭 git 的换行转换。上游 blob 以 CRLF 入库且本机 `core.autocrlf=true`，不固定的话编辑工具一转 LF 就产生整文件伪差异、并毁掉三方合并能力（见 pitfalls #7） | keep-ours | active |
| .agents/skills/（acp-record-change、acp-merge-upstream、acp-release） | （纯自定义目录） | 20260923-000→016 | 3 个 AI Agent 工作流 skill：改动登记、上游合并（适配无 tag 的 vendor/main）、打包发布（.vsix + GitHub Release） | keep-ours | active |
| AGENTS.md | （纯自定义文件） | 20260923-000→015 | AI Agent 会话级硬约束摘要：必读文件、工作流、技术栈（npm/webpack）、构建命令、分支规则、自定义代码规范、skills 触发表、文档更新职责；含会话礼仪约定（回复开头称"啊唯"）。**015 起刻意保持精简**——`AGENTS.md` 每个会话都会被加载，属于"每次都要付的上下文税"，详细流程一律下沉到 `CUSTOMIZATIONS/docs/` 并在本文件留一行指针。**016 进一步减重**（147→121 行）：删除与 `architecture.md` §1 重复的「项目结构速查」、技术栈只留会破坏构建的两条、补上「check-registry 必须 exit 0」与「EOL 归一」两条真正缺失的硬约束 | keep-ours | active |
| .github/workflows/publish.yml | 20260923-004/006 | 20260923-004→006 | ①移除 `Publish to Visual Studio Marketplace` 与 `Publish to Open VSX Registry` 两步（上游依赖 `secrets.VSCE_PAT`/`secrets.OVSX_PAT`，本仓库无这些 secret）；②去掉 `release: created` 自动触发，改为**仅 `workflow_dispatch`**——发布主路径是本地 `gh release create`（acp-release skill），保留自动触发会在手动发布后再挂一个冗余的 `extension.vsix`；③workflow 名 `Publish` → `Package (Manual)`，job `publish` → `package`，产出改为 workflow artifact（`actions/upload-artifact`），**完全不接触 GitHub Release**；④`npx vsce` → `npx @vscode/vsce`。**文件名刻意保留 publish.yml**（上游也有此文件，改名会产生 delete/modify 冲突） | merge-manual | active |
| .github/workflows/ci.yml | 20260923-007/008/009 | 20260923-007→008→009 | ①**修 CI 完全失效的问题**：上游触发分支是 `[main]`，但本仓库（fork）没有 `main` 分支（默认与开发分支是 `custom/main`），导致 CI 从未触发过——改为 `[custom/main]`；②新增「Check custom-development invariants」步骤，用 `node CUSTOMIZATIONS/scripts/check-registry.mjs` 跑机制自检（代码标记↔账本 / 命名空间卫生 / 换行符卫生），把约束从口头约定变成 CI 强制；③`npx vsce package` → `npx @vscode/vsce package`；④**macOS 上跳过 `npm test`**——`@vscode/test-electron` 在 macos-latest 上解压静默失败（299MB 报 12 秒下完，随后 Electron ENOENT），属上游既有问题（上游 CI 历史上从未成功过）；macOS 仍保留机制自检与打包，**跨平台自检覆盖必须留着**（见 pitfalls #9） | merge-manual | active |

---

## 变更日志

> **本节已移至 [`docs/changelog.md`](./docs/changelog.md)。**
> 变更日志是 append-only 的历史流水，占原单体文件约 70% 体积——按需查阅即可
> （只在需要追查某次改动的来龙去脉、或核对「这轮到底改了什么」时才读）。
>
> **本标题刻意保留**：`check-registry.mjs` 与 `list-custom.ps1` 都用它作为「改动总览表格到此为止」
> 的终止哨兵，保留它可以让两个解析器零代码改动继续工作。**不要删掉这一行。**
