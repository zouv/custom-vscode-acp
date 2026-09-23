# 历史坑点 / Pitfalls

> **这是什么**：本仓库（acp-client-custom）开发与排查中**踩过的坑**的沉淀。新会话动手前先扫一眼标题，
> 避免重复踩坑。每条写清：现象 → 根因 → 解法 → 验证方式。
>
> **维护铁律**：每解决一个"反复折腾才定位到"的问题，就来这里加一条（一次没定位到就解决的不算坑）。
> 配套：代码位置反查见 [`../architecture.md`](../architecture.md)。

---

## 1. 上游没有任何版本 tag → "按 tag 定基线"的机制直接失效

- **日期**：2026-09-23（初始配置）
- **现象**：照搬 chatbox 的初始化脚本（`git tag -l "v*" --sort=-v:refname | head -1` 取最新 tag 作为
  vendor 基线）会拿到**空字符串**；`registry.md` 的 `current_upstream_version` 无值可填，
  `vendor/vX.Y.x` 分支名 fallback 逻辑也失去意义。
- **根因**：`formulahendry/vscode-acp` 从建仓至今**从未打过 tag**，只有 `main` 分支。
  chatbox 的整套机制建立在上游有稳定 tag 的假设上。
- **解法**：
  1. vendor 基线分支固定为 **`vendor/main`**（不再按 `vX.Y.x` 建线）；
  2. `current_upstream_version` 取**上游 `package.json` 的 `version` 字段**（如 `0.2.0`）——
     它只表达语义版本，**不足以定位代码**；
  3. 唯一定位靠 `current_upstream_commit`（上游 `main` 的 commit hash），两者必须同时准确。
- **教训**：跨仓库移植一套机制前，**先用 `git ls-remote --tags <upstream>` 验证机制依赖的前提**
  （有没有 tag、有没有 release、默认分支叫什么），别假设另一个仓库的约定成立。
- **验证**：`git rev-parse upstream/main` 与 registry frontmatter 一致；
  `pwsh CUSTOMIZATIONS/scripts/init-repo.ps1` 可重复执行不报错。

## 2. 命令 id / 视图 id / 配置键是**全局命名空间** → 改 publisher 不足以让 fork 与上游并存

- **日期**：2026-09-23（初始配置，CUSTOM-20260923-001）
- **现象**：改掉 `package.json` 的 `publisher`/`name`（扩展 id 变成 `zouv.acp-client-custom`）后，
  与上游 `formulahendry.acp-client` 同时安装仍然冲突：命令面板出现重复命令、
  开发者工具报 command already exists、配置项互相覆盖。
- **根因**：VS Code 的 **command id、view id、viewContainer id、configuration section key**
  都在**整个 IDE 实例内全局唯一**，与"哪个扩展贡献的"无关。扩展 id 只决定扩展身份，不决定这些命名空间。
  上游用了 `acp.*` 前缀，fork 原样沿用就必然撞车。
- **解法**：全量重命名 `acp.*` → `acpc.*`，覆盖：
  - `package.json`：21 个命令 id、视图容器 id（`acp-client`→`acp-client-custom`）、
    视图 id（`acpc-sessions`/`acpc-chat`）、配置段（`acpc.agents` 等 4 项）、上下文键（`acpc.turnInProgress`）
  - `src/`：`registerCommand` / `executeCommand` 的字符串字面量、`getConfiguration('acp')`、
    `createTreeView` / `viewType`、`createOutputChannel` 的名称
  - `package.json` 的 `contributes.menus.*.when` 里 `view == acp-sessions` 这类**长字符串内的片段**
- **教训**：
  1. **TypeScript 编译器不检查字符串字面量**——`npm run compile` 全绿**不代表改干净了**，
     必须 `grep -rn` 反向复核残留；
  2. fork 一个 VS Code 扩展前，第一件事是列出它占用的**全局命名空间清单**，而不是先改 publisher。
- **验证**：`grep -rn "acp\.\|acp-sessions\|acp-chat" src/ package.json` 无（非故意保留的）残留；
  两个扩展同时安装后控制台无冲突告警。详见 `registry.md` 的 CUSTOM-20260923-001。

## 3. 批量替换的模式边界：太紧会漏、太松会误伤（同一类错误，两个方向都踩过）

- **日期**：2026-09-23（做坑点 2 的重命名时踩到"太紧"；做 007 的 `sh`→`bash` 时踩到"太松"）
- **现象（太紧→漏）**：用 `s/"acp-sessions"/"acpc-sessions"/g` 批量替换，`package.json` 里
  `"id": "acp-sessions"` 改成功了，但 `"when": "view == acp-sessions"` 里的 `acp-sessions`
  **原封不动**——渲染出的菜单条件全部失效。
- **现象（太松→误伤）**：用 `s|sh CUSTOMIZATIONS/scripts/|bash CUSTOMIZATIONS/scripts/|g` 批量替换，
  模式的 `sh` 子串匹配到了 `pw**sh** CUSTOMIZATIONS/scripts/`，把 4 处 `pwsh` 改成了 **`pwbash`**。
- **根因**：两者是同一个问题的两面——**模式没锚定到词/引号的边界**。
  太紧时（带引号）匹配不到长字符串内的片段；太松时（裸 `sh`）会咬进别的单词里。
- **解法**：
  - 太紧 → 对长字符串内的片段补独立模式（`s/== acp-sessions/== acpc-sessions/g`），
    或一开始就用**不带引号边界的词形模式**；
  - 太松 → 加左边界，例如 `s|\bsh CUSTOMIZATIONS/scripts/|bash ...|g`，
    或用 `([^a-z]|^)sh ` 之类避免咬进 `pwsh`。
- **教训**：
  1. 批量重命名/替换必须**双向验证**——正向确认替换发生，**反向 grep 确认没有残留**；
  2. 还要**同时 grep 被误伤的目标**（本次若没顺手查 `pwbash`，`pwsh` 调用说明就被悄悄改坏了）；
  3. 写完 sed 别只看"改了多少处"，要 `git diff` 扫一眼**改动内容**是否符合预期。
- **验证**：`grep -rn "== acp-" src/ package.json` 为空；`grep -rn "pwbash"` 为空。

## 4. 两处 `acp.` 是**扩展内作用域**，不该跟着重命名

- **日期**：2026-09-23（做坑点 2 的重命名时识别出）
- **现象**：无脑全量替换 `acp.` → `acpc.` 会把两处**不该改**的地方一起改掉：
  1. `src/core/SessionHistoryStore.ts` 的 `const STATE_KEY = 'acp.sessionHistory.v1'`
  2. `src/core/ConnectionManager.ts` 的 `clientInfo.name = 'vscode-acp-client'`
- **根因**：
  1. `STATE_KEY` 是 `workspaceState` 的 **Memento key**，作用域是**当前扩展自己**，
     不与上游冲突；**改了它 = 既有用户的会话历史全部读不出来（等于丢失）**。
  2. `clientInfo.name` 是 ACP `initialize` 握手时**上报给 agent 的客户端标识**，属协议元数据，
     不参与 VS Code 命名空间，改不改都不冲突。
- **解法**：两者**保持原值**，并在 `architecture.md §4` 明确写"故意保留，勿顺手修"。
- **教训**：重命名前先分清两类字符串——
  **全局可冲突标识符**（必须改）vs **扩展内作用域 / 协议元数据**（不该改）。
  判断标准：这个字符串会不会被**别的扩展**在同一命名空间里也用？会 → 改；不会 → 别动。
- **验证**：改完后 `grep -n "STATE_KEY" src/core/SessionHistoryStore.ts` 仍为 `'acp.sessionHistory.v1'`。

## 5. 上游 `acpc.turnInProgress` 上下文键从未 `setContext` → Escape 取消是死绑定

- **日期**：2026-09-23（初始配置扫描时发现，**尚未修复**）
- **现象**：`package.json` 里两处依赖 `acpc.turnInProgress`（改名前的 `acp.turnInProgress`）：
  - `keybindings`：`escape` → `acpc.cancelTurn`，条件是 `when: acpc.turnInProgress`
  - `menus.view/title`：取消按钮的可见性条件 `view == acpc-chat && acpc.turnInProgress`

  但 `grep -rn "setContext" src/` **没有任何结果**——这个上下文键从来没有人设置过，
  因此上述两条的 `when` 恒为 false：**Escape 键取消不了当前轮次，取消按钮也不显示**。
- **根因**：上游遗留——贡献点声明了上下文键，但实现里漏了
  `vscode.commands.executeCommand('setContext', 'acpc.turnInProgress', <bool>)`。
- **解法**：**本次未修**（超出"初始配置"范围）。修复方向：在 `SessionManager` 的
  `promptStart`/`promptEnd`（或对应事件）回调里设置该上下文键，与
  `ChatWebviewProvider` 的 `promptStart`/`promptEnd` 消息同源。
- **教训**：`when` 子句里引用的每个上下文键，都要 `grep setContext` 确认有 setter；
  贡献点的"声明"和"实现"分处两个文件，很容易只有一半。
- **验证**（修复后）：发一条消息，确认取消按钮出现且 Escape 能中断当前轮次。

## 6. `.vscodeignore` 不与顶层目录联动 → 自定义内容被打进 `.vsix` 发给用户

- **日期**：2026-09-23（初始配置，CUSTOM-20260923-003）
- **现象**：新建 `CUSTOMIZATIONS/`、`.agents/`、`AGENTS.md` 后直接 `vsce package`，
  这些**开发机制文件会全部进入 `.vsix`**（vsce 默认打包仓库里除忽略项外的一切），
  安装包体积变大，且把内部开发文档、改动账本、坑点库发给终端用户。
- **根因**：`.vscodeignore` 是**白名单式的反向排除**（列出"不打包什么"），
  上游只排除了它自己知道的路径；新增顶层目录不会自动被排除。
- **解法**：每新增一个顶层目录/文件，同步往 `.vscodeignore` 加一条；本次加了
  `CUSTOMIZATIONS/**`、`.agents/**`、`.claude/**`、`AGENTS.md`、`release/**`、`.github/**`。
- **教训**：`.vscodeignore` 和顶层目录是**联动契约**——架构变更（加目录）时容易忘。
  打包后用 `npx @vscode/vsce ls --tree` 验证产物清单。
- **验证**：`npx @vscode/vsce ls --tree | grep -i "customiz\|agents\|AGENTS"` 无输出。

## 7. 上游以 CRLF 入库 + 本机 `core.autocrlf=true` → 编辑一次就整文件伪差异

- **日期**：2026-09-23（首次提交前发现，差点带着 14000 行伪差异提交）
- **现象**：准备提交时 `git diff --stat` 显示 `src/ui/ChatWebviewProvider.ts | 5121 +-`、
  `package.json | 852 +-`——但实际只改了几行；整仓统计 14339 插入 / 12788 删除。
- **根因**：
  1. 上游 `formulahendry/vscode-acp` 的 blob **以 CRLF 入库**（仓库里**没有 `.gitattributes`**，
     推测作者在 Windows 上未开 autocrlf 直接提交）；
  2. 本机 `core.autocrlf=true`（`C:/Program Files/Git/etc/gitconfig` 与 `~/.gitconfig` 都设了），
     但 autocrlf 对**已是 CRLF 的 blob** 不做归一化，两边就这么"相安无事"地一致着；
  3. 编辑工具一介入就打破平衡：**`sed -i`、`Write` 工具、`npm install` 都产出 LF**，
     而 `Edit` 工具会保留文件原有换行。于是一部分文件被转成 LF，与 CRLF blob 逐行不等 → 整文件 diff。
- **危害**：不只是 diff 难看——**后续每次合并上游都会变成全文件冲突**，三方合并能力彻底丧失。
- **解法**（三层）：
  1. 加 `.gitattributes` 写 `* -text`：关闭 git 的换行转换，按字节原样存取，
     保证本地 blob 与上游 blob 逐字节可比对（`-text` 只关 EOL 转换，不影响 diff/merge）；
  2. `CUSTOMIZATIONS/scripts/normalize-eol.mjs` 做批量归一化 + `--check` 只读自检；
  3. 自检接入 `check-registry.mjs` §4；`release-vsix.sh` 在 `npm install` 之后自动把 `package-lock.json` 转回 CRLF。
- **判据（两类文件，别一刀切）**——修的过程中踩到的第二个坑：

  | 类别 | 路径 | 换行 | 理由 |
  |---|---|---|---|
  | **上游共有** | `src/`、`package*.json`、`.github/`、`.gitignore`、`.vscodeignore`、`tsconfig.json` … | **CRLF** | 与上游 blob 逐行可比，否则合并全冲突 |
  | **纯自定义** | `CUSTOMIZATIONS/`、`.agents/`、`AGENTS.md`、`.gitattributes` | **LF** | 不与上游同名，无冲突风险 |

  **纯自定义文件必须保持 LF——尤其是 `.sh`**：带 CRLF 的 shell 脚本在 Linux/macOS 上会因
  shebang / 命令解析带上 `\r` 而直接执行失败。第一版 `normalize-eol.mjs` 把"所有已跟踪文件"
  一刀切成 CRLF，提交后自检立刻抓到 `sync-vendor.ps1` 被误判——**同一份规则里，两个方向都错得起来**。
- **教训**：
  1. **fork 一个仓库、动手改之前，先确认它的换行符约定**——`git ls-files --eol` 或
     `git cat-file blob HEAD:<file> | xxd | head` 看一眼真实字节，别等提交时才发现；
  2. **测量换行符不要用 Git Bash 的 `grep -U`**——它可能仍走文本模式，读数会骗人；
     用 node/python 直接读字节才准（本次就被误导过一次）；
  3. 判断"有没有真改动"看 `git diff --numstat` 的数字，数值离谱基本就是换行符问题；
  4. **写"归一化"类工具时先想清楚分类**，别默认全局一个规则——本次先过度归一（把 .sh 转 CRLF），
     才补上 CUSTOM_ONLY 判据。好在自检脚本在提交后立刻暴露了它。
- **验证**：`node CUSTOMIZATIONS/scripts/normalize-eol.mjs --check` 报"全部 36 个上游共有文件一致（CRLF）"；
  `git diff --numstat src/extension.ts` 从 `544/544` 降到真实改动量。

## 8. macOS 自带 bash 3.2 → `declare -A` 报 "invalid option"（本地永远复现不了）

- **日期**：2026-09-23（把自检接进 CI 三平台矩阵后立刻被 macos-latest 抓出，CUSTOM-20260923-008）
- **现象**：CI 里 ubuntu 与 windows 都过，**macos-latest 挂在自检步骤**：
  ```
  check-registry.sh: line 17: declare: -A: invalid option
  declare: usage: declare [-afFirtx] [-p] [name[=value] ...]
  ##[error]Process completed with exit code 2.
  ```
- **根因**：**macOS 自带的 `/bin/bash` 是 3.2 版（2007 年）**——苹果因 GPLv3 授权问题一直没升级它。
  关联数组 `declare -A` 需要 bash 4.0+，所以直接不可用。
  而开发机上的 Git Bash 是 bash 5.x，**本地怎么跑都是绿的**，问题只会在 CI（或别人的 Mac）上出现。
- **解法**：把自检脚本整体**移植到 Node**（`check-registry.mjs`），删掉 bash 版。
  选 Node 而不是"绕开关联数组改写 bash"的理由：
  1. Node 在本项目是**硬依赖**（`npm install` 是前置步骤，不可能没有）；
  2. 项目里 `normalize-eol.mjs` 已有先例，语言统一；
  3. 一次性消除 Windows / Linux / macOS 的 **shell 方言**差异——而 CI 恰恰是三平台跑的。
- **教训**：
  1. **shell 脚本的可移植性比想象中差得多**：关联数组、`mapfile`、`sed -i` 语义、`grep -P`……
     在 macOS(BSD) 与 Linux(GNU) 上差异一堆，而 macOS 还锁在 bash 3.2。
     **凡是 CI 要在多平台跑的脚本，优先用 Node/Python，别用 bash**；
  2. **"本地能跑"不等于"能跑"**——本地 Git Bash 是 bash 5，掩盖了 macOS 的问题。
     把检查放进多平台 CI 的价值就在这里：**这次是 CI 替我们发现的，不是用户**；
  3. 移植脚本时要**对照原实现验证等价性**（本次移植初版有 bug，含标记文件数从 12 误报成 2，
     靠与 bash 版对照计数才发现），并用**反向测试**（故意破坏 → 确认能报错 → 还原）证明检测真的有效。
- **验证**：`node CUSTOMIZATIONS/scripts/check-registry.mjs` 输出与 bash 版一致（12 个含标记文件）；
  CI 三平台的 job 全部通过（macOS 的测试步骤另见 #9）。

## 9. macOS runner 上 `npm test` 必失败 → 上游既有问题，别去修

- **日期**：2026-09-23（修完 #8 后 CI 仍红，追查到是另一回事，CUSTOM-20260923-009）
- **现象**：macos-latest 的 `npm test` 报
  ```
  - Downloading (299.02 MB)
  ✔ Downloaded VS Code into .../.vscode-test/vscode-darwin-arm64-1.139.0
  Test error: Error: spawn .../Visual Studio Code.app/Contents/MacOS/Electron ENOENT
  ```
- **根因**：**299 MB 不可能 12 秒下完**——"Downloaded" 是假的，**解压静默失败**，
  所以 Electron 二进制根本不存在。属 `@vscode/test-electron` 在 macOS arm64 runner 上的工具链问题。
- **关键证据（决定了"不该自己修"）**：查上游仓库的 CI 历史——
  `gh run list -R formulahendry/vscode-acp` 里**没有一次成功**，全是 `failure` / `action_required`。
  说明这是上游既有的问题，不是本仓库引入的，也不该由本仓库去修。
- **解法**：**不修**。macOS 上仍然跑机制自检与打包（跨平台自检覆盖必须保留——
  正是它在 macOS 上抓出了 #8 的 bash 3.2 问题），只跳过启动 VS Code 的测试步骤：
  ```yaml
  - run: npm test
    if: runner.os == 'Windows'     # Linux 走 xvfb-run，macOS 跳过
  ```
  等上游/工具链修好后再放开。
- **教训**：
  1. **CI 红了先分清"谁的问题"**——查上游仓库的 CI 历史（`gh run list -R <upstream>`）是一分钟的事，
     能立刻区分"我引入的"与"上游既有的"，避免一头扎进去修不属于自己的坑；
  2. **不要用 `continue-on-error` 掩盖**——那会让 build 显示绿、实际有失败，掩盖真问题。
     要用显式的 `if` 跳过 + 注释写清楚原因与证据；
  3. 判断"跨平台检查要不要保留"时看**它有没有真的抓到过东西**：
     自检在 macOS 上抓到过 #8，所以留下；测试在 macOS 上从没成功过，所以跳过。
- **验证**：CI 在 ubuntu / windows / macos 三个 job 全部通过；macOS 的日志里能看到
  `Check custom-development invariants` 是 ✓ 而测试步骤被跳过。
