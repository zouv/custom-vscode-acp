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
> **两层结构（怎么用）**：
> - **改动总览（按文件）**——查"某个文件现在改了什么、上游合并时怎么处理"：**只读这一节**，每个文件一条，多轮演进已合并为当前状态，无需读历史轮次。
> - **变更日志（按次）**——查"某次改动何时发生、为什么、怎么验证"：按时间倒序的 append-only 流水，只增不改（历史是事实）。
>
> **AI Agent 注意**：
> 1. 开发前读**改动总览**定位相关文件与冲突策略（不必通读变更日志）
> 2. 完成改动后调用 `acp-record-change` skill：**总览里已有该文件就更新那一节**（合并描述、追加演进链 id），没有就新增一节；变更日志追加一轮记录
> 3. 合并上游时按总览的冲突策略列处理；**合并后必须重新执行 `acp.*` → `acpc.*` 命名空间扫描**（见 README 冲突策略节）
> 4. 不要删除历史（总览条目整体废弃时标 deprecated，变更日志永不删改）
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
> **无标记三情形**（详见 README.md）：JSON 无注释 / 测试文件 / 全局性重命名走文件头标记。

| 文件 | 标记（当前） | 演进链 | 当前效果（合并后） | 冲突策略 | 状态 |
|------|-------------|--------|-------------------|---------|------|
| package.json | （JSON 不支持注释，已知无标记缺口） | 20260923-001→002 | ①身份：name `acp-client-custom`、publisher `zouv`、displayName `ACP Client (Custom)`、description 标注 custom fork、repository/bugs/homepage 指向 zouv/custom-vscode-acp，移除上游 `bugs.email`；②命名空间：21 个命令 id → `acpc.*`、视图容器 id → `acp-client-custom`、视图 id → `acpc-sessions`/`acpc-chat`、配置段 → `acpc.agents` 等 4 项、上下文键 → `acpc.turnInProgress`、configuration.title / viewsContainer.title → `ACP Client (Custom)`；③命令 title：**全部 21 个**加 `ACP (Custom): ` 前缀（含上游无 `ACP:` 前缀的 Refresh / Copy Session ID / Forget Session），避免与上游在命令面板与右键菜单中同名；④依赖：移除 `@vscode/extension-telemetry` | merge-manual | active |
| package-lock.json | （锁文件，无标记） | 20260923-002 | 移除 `@vscode/extension-telemetry` 后由 `npm install` 重新生成 | 接受上游版本后 `npm install` 重新生成 | active |
| .vscodeignore | 20260923-003 | 20260923-003 | 追加排除 `CUSTOMIZATIONS/**`、`.agents/**`、`.claude/**`、`AGENTS.md`、`release/**`、`.github/**`，防止开发机制文件与 CI 配置被打进 `.vsix` | merge-manual | active |
| .gitignore | 20260923-003 | 20260923-003 | 追加忽略 `release/`、`.zcode/plans/`、`.claude/explore-results/` | merge-manual | active |
| src/extension.ts | 20260923-001/002 | 20260923-001→002 | ①文件头标记：本文件参与全局命名空间重命名（`createTreeView('acpc-sessions')`、21 处 `registerCommand('acpc.*')`、`executeCommand('acpc-chat.focus')`、`getConfiguration('acpc')` ×2）；②移除 `extension/activated` 遥测上报（原实现读取 `formulahendry.acp-client` 的版本号，fork 后该 id 不存在） | merge-manual | active |
| src/ui/SessionTreeProvider.ts | 20260923-001 | 20260923-001 | 文件头标记：树项命令 id 全部改为 `acpc.*`（`acpc.openChat` / `acpc.openSession` / `acpc.loadMoreSessions` / `acpc.connectAgent` / `acpc.refreshSessions`） | merge-manual | active |
| src/ui/ChatWebviewProvider.ts | 20260923-001 | 20260923-001 | 文件头标记：`viewType` 改为 `acpc-chat`；内联 HTML 里 welcome 按钮的 `executeCommand('acpc.connectAgent')` / `('acpc.addAgent')` | merge-manual | active |
| src/ui/StatusBarManager.ts | 20260923-001 | 20260923-001 | 文件头标记：状态栏点击命令改为 `acpc.connectAgent` | merge-manual | active |
| src/config/AgentConfig.ts | 20260923-001 | 20260923-001 | 文件头标记：`getConfiguration('acpc')`（读 `acpc.agents`） | merge-manual | active |
| src/handlers/PermissionHandler.ts | 20260923-001 | 20260923-001 | 文件头标记：`getConfiguration('acpc')`（读 `acpc.autoApprovePermissions`） | merge-manual | active |
| src/utils/Logger.ts | 20260923-001 | 20260923-001 | 文件头标记：输出通道名改为 `ACP Client (Custom)` / `ACP Traffic (Custom)`；`getConfiguration('acpc')`（读 `acpc.logTraffic`） | merge-manual | active |
| src/utils/TelemetryManager.ts | 20260923-002 | 20260923-002 | **整体重写为 no-op**：删除硬编码的上游 Application Insights 连接串 `InstrumentationKey=c4d676c8-…`，不再 import `@vscode/extension-telemetry`；保留 `initTelemetry` / `sendEvent` / `sendError` / `sendException` 同名 API（空实现 + `_` 前缀未用参数）以免调用点扩散 | keep-ours | active |
| src/test/extension.test.ts | （测试文件，无标记） | 20260923-001 | 断言更新：扩展 id `zouv.acp-client-custom`；命令前缀断言 `acpc.`；`acpc.connectAgent` / `acpc.newConversation` / `acpc.openChat` | keep-ours | active |
| src/core/SessionHistoryStore.ts | （**故意保留 `acp.sessionHistory.v1`，非改动文件**） | — | 未改动。`STATE_KEY` 是 `workspaceState` 的 Memento key，扩展内作用域，不与上游冲突；改名会导致既有会话历史丢失。见 `architecture.md §4` 与 pitfalls #4 | keep-ours | active |
| src/core/ConnectionManager.ts | （**故意保留 `vscode-acp-client`，非改动文件**） | — | 未改动。`clientInfo.name` 是 ACP `initialize` 上报给 agent 的客户端名，协议元数据，非全局命名空间。见 pitfalls #4 | keep-ours | active |
| CUSTOMIZATIONS/（README.md、registry.md、architecture.md、docs/pitfalls.md、release-notes/、src/、patches/） | （纯自定义目录） | 20260923-000 | 自定义开发机制：规则唯一源 + 改动账本 + 代码地图 + 坑点库。移植自 zouv/custom-chatbox 并按 VS Code 扩展语境适配（npm / webpack / .vsix / 上游无 tag） | keep-ours | active |
| CUSTOMIZATIONS/scripts/（init-repo.ps1、sync-vendor.ps1、list-custom.ps1、check-registry.mjs、release-vsix.sh、normalize-eol.mjs） | （纯自定义目录，逐文件标记非必需） | 20260923-000→005→008 | 仓库基线初始化、vendor 同步（`-Ref` 代替 `-Version`）、改动清单查询、标记↔账本一致性自检（含命名空间卫生与换行符两项，**Node 实现**）、.vsix 打包封装、换行符归一化工具 | keep-ours | active |
| .gitattributes | 20260923-005 | 20260923-005 | **新增**。写 `* -text` 关闭 git 的换行转换。上游 blob 以 CRLF 入库且本机 `core.autocrlf=true`，不固定的话编辑工具一转 LF 就产生整文件伪差异、并毁掉三方合并能力（见 pitfalls #7） | keep-ours | active |
| .agents/skills/（acp-record-change、acp-merge-upstream、acp-release） | （纯自定义目录） | 20260923-000 | 3 个 AI Agent 工作流 skill：改动登记、上游合并（适配无 tag 的 vendor/main）、打包发布（.vsix + GitHub Release） | keep-ours | active |
| AGENTS.md | （纯自定义文件） | 20260923-000 | AI Agent 会话级硬约束摘要：必读文件、工作流、技术栈（npm/webpack）、构建命令、分支规则、自定义代码规范、skills 触发表、文档更新职责；含会话礼仪约定（回复开头称"啊唯"） | keep-ours | active |
| .github/workflows/publish.yml | 20260923-004/006 | 20260923-004→006 | ①移除 `Publish to Visual Studio Marketplace` 与 `Publish to Open VSX Registry` 两步（上游依赖 `secrets.VSCE_PAT`/`secrets.OVSX_PAT`，本仓库无这些 secret）；②去掉 `release: created` 自动触发，改为**仅 `workflow_dispatch`**——发布主路径是本地 `gh release create`（acp-release skill），保留自动触发会在手动发布后再挂一个冗余的 `extension.vsix`；③workflow 名 `Publish` → `Package (Manual)`，job `publish` → `package`，产出改为 workflow artifact（`actions/upload-artifact`），**完全不接触 GitHub Release**；④`npx vsce` → `npx @vscode/vsce`。**文件名刻意保留 publish.yml**（上游也有此文件，改名会产生 delete/modify 冲突） | merge-manual | active |
| .github/workflows/ci.yml | 20260923-007/008/009 | 20260923-007→008→009 | ①**修 CI 完全失效的问题**：上游触发分支是 `[main]`，但本仓库（fork）没有 `main` 分支（默认与开发分支是 `custom/main`），导致 CI 从未触发过——改为 `[custom/main]`；②新增「Check custom-development invariants」步骤，用 `node CUSTOMIZATIONS/scripts/check-registry.mjs` 跑机制自检（代码标记↔账本 / 命名空间卫生 / 换行符卫生），把约束从口头约定变成 CI 强制；③`npx vsce package` → `npx @vscode/vsce package`；④**macOS 上跳过 `npm test`**——`@vscode/test-electron` 在 macos-latest 上解压静默失败（299MB 报 12 秒下完，随后 Electron ENOENT），属上游既有问题（上游 CI 历史上从未成功过）；macOS 仍保留机制自检与打包，**跨平台自检覆盖必须留着**（见 pitfalls #9） | merge-manual | active |

---

## 变更日志

> 按时间倒序 append-only，只增不改。

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
