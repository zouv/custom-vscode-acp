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

## 3. 批量重命名时，"带引号边界"的替换模式会漏掉长字符串内的片段

- **日期**：2026-09-23（做坑点 2 的重命名时踩到）
- **现象**：用 `s/"acp-sessions"/"acpc-sessions"/g` 批量替换，`package.json` 里
  `"id": "acp-sessions"` 改成功了，但 `"when": "view == acp-sessions"` 里的 `acp-sessions`
  **原封不动**——渲染出的菜单条件全部失效。
- **根因**：模式带了引号边界，只能命中"独立成串"的出现；`view == acp-sessions` 里
  `acp-sessions` 前面是空格、后面才是引号，不匹配 `"acp-sessions"`。
- **解法**：对长字符串内的片段补独立模式（`s/== acp-sessions/== acpc-sessions/g`），
  或一开始就用**不带引号边界的词形模式**批量处理。
- **教训**：批量重命名必须**双向验证**——正向确认替换发生，**反向 grep 确认没有残留**。
  只做正向就会漏掉这类"看起来改了其实没改"的片段。
- **验证**：`grep -rn "== acp-" src/ package.json` 为空。

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
  3. 自检接入 `check-registry.sh` §4；`release-vsix.sh` 在 `npm install` 之后自动把 `package-lock.json` 转回 CRLF。
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
