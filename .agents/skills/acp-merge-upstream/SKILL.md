---
name: "acp-merge-upstream"
description: "Merge upstream formulahendry/vscode-acp updates into the custom repository. Invoke when user asks to sync/merge/update from upstream, upgrade to a new upstream version, or pull upstream changes."
---

# ACP Client (Custom) 上游合并 Skill

本 Skill 用于将 [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) 上游仓库的更新合并到自定义仓库中。**所有跨上游/自定义分支的合并操作必须通过本 Skill 执行，禁止手动 git merge。**

> **本仓库与 chatbox 的关键差异**：上游**没有版本 tag**（只有 `main` 分支）。
> 因此目标用 **commit hash 或 `upstream/main`** 指定（不是 tag），vendor 分支固定 `vendor/main`（不是 `vendor/vX.Y.x`）。
> 版本语义靠读上游 `package.json` 的 `version` 字段。

## 触发条件

- 用户说"合并上游"、"更新到最新版本"、"升级到 vX.Y.Z"、"sync upstream"、"同步原仓库"
- 需要将上游的 bugfix/新功能合入自定义版本

## 参数收集

开始前确认**目标 ref**：

1. **目标 ref**：要合并到哪个上游状态？
   - `upstream/main` → 跟踪上游最新（未指定时的默认值）
   - 指定 commit hash（如 `1a2b3c4`）→ 精确到某个提交
   - 如果用户未指定，先展示上游最近提交再询问：
     ```bash
     git fetch upstream
     git log --oneline upstream/main -20
     ```
2. **是否推送**：合并后是否 `git push`（默认不推，等用户明确指示）

### ⚠️ 全流程中必须执行的一步

> **合并完成、冲突处理完毕、验证之前，必须重新执行 `acp.*` → `acpc.*` 命名空间扫描。**
>
> 本仓库把上游的 `acp.*` 命令 id / 视图 id / 配置段改成了 `acpc.*`（见 `CUSTOMIZATIONS/README.md`）。
> 上游每次更新都可能**新增** `acp.*` 标识符，合并后它们会以**旧前缀**混入，造成半重命名状态
> ——表现为部分命令能注册、部分报 command already exists 或菜单不显示，且 `npm run compile` **不会报错**。
>
> 详见 `CUSTOMIZATIONS/docs/pitfalls.md` #2。

## 前置检查

### 1. 确认仓库状态

```bash
git branch --show-current          # 必须在 custom/main 上
git status --porcelain             # 工作区必须干净
```

工作区不干净时先让用户处理（stash/commit）。**无法自动 stash 时必须暂停并告知用户。**

### 2. 确认 remote 配置

```bash
git remote -v
# upstream 必须指向 https://github.com/formulahendry/vscode-acp.git
# 没有的话：git remote add upstream https://github.com/formulahendry/vscode-acp.git
```

### 3. 读取 CUSTOMIZATIONS/registry.md

通读所有 `active` 状态的自定义改动条目的**冲突策略**列（完整策略表见 `CUSTOMIZATIONS/README.md`）。这是冲突解决的依据。

### 4. 获取上游最新信息

```bash
git fetch upstream --tags
git log --oneline upstream/main -20
git show upstream/main:package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
```

对比 registry frontmatter 的 `current_upstream_version`，判断是**同版本修补**还是**跨版本升级**（后者需留意 ACP SDK 与 `engines.vscode` 的变化）。

---

## 流程

### 1. 预检查报告

执行合并前输出：

```
=== 上游合并预检查 ===
当前自定义基线：<current_upstream_version> @ <current_upstream_commit 短 hash>
目标上游状态：  <ref> @ <hash>
上游版本：      <上游 package.json version>（本地记录：<current_upstream_version>）
预计改动文件数：<git diff --stat vendor/main <ref> 估算>
自定义改动条目数：<registry.md 中 active 条目数>
已知冲突风险文件：<总览里 modified-upstream 的文件 ∩ 上游变更文件>
命名空间敏感文件：<上游变更文件中含 acp.* 新增的文件 —— 合并后必须重扫>
```

### 2. 推进 vendor/main

```bash
git checkout vendor/main
git merge --ff-only <ref>          # vendor/main 必须始终是上游镜像，不能有本地提交
git push origin vendor/main        # 仅在用户同意推送后
git checkout custom/main
```

若 `--ff-only` 失败，说明 vendor/main 被污染过——**停下来排查**，不要改用 `git merge` 强推。

### 3. 合并到 custom/main

```bash
git merge --no-edit vendor/main
# 或指定策略：git merge --no-edit -X ours vendor/main
```

### 4. 冲突处理

按 `CUSTOMIZATIONS/README.md` 的冲突策略速查表处理：

| 冲突文件特征 | 策略 |
|---|---|
| 在 `CUSTOMIZATIONS/src/` 或 `patches/` 下 | keep-ours |
| registry 条目标记 `keep-ours` | keep-ours |
| registry 条目标记 `keep-theirs` | keep-theirs |
| `package-lock.json` | 接受上游版本后 `npm install` 重新生成 |
| 含 `[CUSTOM-BEGIN]` 标记 | merge-manual（保留标记块内的自定义代码，标记外优先用上游） |
| 其他 | merge-manual（逐块分析） |

**`package.json` 特殊处理**（它是 JSON、无标记，但几乎每次上游更新都会改）：
逐字段比对——身份字段（name/publisher/displayName/repository/bugs/homepage）与命名空间（`acpc.*`、`acp-client-custom`、`acpc-sessions`、`acpc-chat`）**必须保留我们的**；
上游新增的命令/设置项**必须接受**，并且**新增的 `acp.*` 要立刻改成 `acpc.*`**。

`CUSTOMIZATIONS/registry.md` 自身冲突必须人工合并，并检查 frontmatter 合法性。

### 5. ⚠️ 重新执行命名空间扫描（不可跳过）

冲突处理完后，**在验证之前**，全仓扫描上游带进来的 `acp.*`：

```bash
# 找出所有上游形态的 acp.* 标识符（排除故意保留的两处）
grep -rn "registerCommand('acp\.\|executeCommand('acp\.\|getConfiguration('acp')\|createTreeView('acp-\|createOutputChannel('ACP Client')\|createOutputChannel('ACP Traffic')\|'acp-sessions'\|'acp-chat'\|== acp-sessions\|== acp-chat\|command:acp\." \
  src/ package.json
```

对每处命中：先确认它**不是**下面两个故意保留项，然后改成 `acpc.*` 形态：

- ❌ `src/core/SessionHistoryStore.ts` 的 `'acp.sessionHistory.v1'`（Memento key，改了丢历史）
- ❌ `src/core/ConnectionManager.ts` 的 `'vscode-acp-client'`（ACP clientInfo，协议元数据）

改完再跑一次确认无残留，然后：

```bash
node CUSTOMIZATIONS/scripts/check-registry.mjs   # §3 会做命名空间卫生检查
```

### 6. 验证

```bash
# 先归一化换行符 —— 冲突解决过程中的编辑很容易产出 LF，而上游是 CRLF，
# 不修的话 diff 会变成整文件伪差异（见 pitfalls #7）
node CUSTOMIZATIONS/scripts/normalize-eol.mjs

npm install         # 依赖可能变了（package-lock 已重新生成）
node CUSTOMIZATIONS/scripts/normalize-eol.mjs package-lock.json   # npm 会把 lock 写成 LF
npm run lint
npm run compile
npm test            # 会拉起真实 VS Code Extension Host
```

`npm test` 的三个断言（扩展存在 / 能激活 / `acpc.*` 命令已注册）是**命名空间是否彻底**的自动化兜底——
若合并引入了半重命名，命令注册断言会失败。

### 7. 更新 registry.md frontmatter

| 字段 | 新值 |
|---|---|
| `current_upstream_version` | 上游 `package.json` 的 version |
| `current_upstream_commit` | `git rev-parse <ref>` |
| `vendor_branch` | `vendor/main`（固定） |
| `last_merge_date` | 今天 |

并在变更日志顶部追加一条记录（change-id 用 `CUSTOM-YYYYMMDD-NNN`），说明合并了哪些上游改动、处理了哪些冲突、命名空间扫描结果。

### 8. 汇报（不自动提交）

汇报：合并的上游范围、冲突文件与处理方式、**命名空间扫描结果（这是重点）**、验证命令的输出、registry 更新情况。
**不要主动 commit / push**，等用户明确指示。

---

## 跨版本升级的额外注意

上游 `version` 的 major/minor 变化时，额外检查：

| 项 | 检查点 |
|---|---|
| `engines.vscode` | 抬高后本地 VS Code 版本是否满足 |
| `@agentclientprotocol/sdk` | ACP 协议版本变化 → `ConnectionManager` 的 `initialize` 握手、新增的 Client 方法可能要实现 |
| `contributes.commands` | 上游新增的命令 → 必须在 `extension.ts` 里真正 `registerCommand`，否则命令面板点了没反应 |
| `contributes.configuration` | 上游新增设置项 → 对应的 `getConfiguration('acp')` 调用点要一起改前缀 |
| `ChatWebviewProvider` | 上游对 webview 消息协议的改动（87KB 单文件，用 grep 比对而非整读） |
| `TelemetryManager` | 上游可能新增遥测调用点 → 保持我们的 no-op 实现（见 registry CUSTOM-20260923-002） |

## 回滚

合并中途出错：

```bash
git merge --abort                     # 冲突未解决时
git reset --hard <合并前的 commit>    # 已提交但未推送时
```

**禁止用 `git rebase` 改写 custom/main 历史**（见根 AGENTS.md 禁止操作）。

## 输出要求

向用户报告：
- 上游合并范围（ref、commit、version）
- 冲突文件清单与各自的处理策略
- **命名空间重扫结果**（扫描到几处、改了哪些、是否有故意保留项）
- `npm run lint` / `compile` / `test` 的实际输出
- registry.md 更新了哪些字段、变更日志新增条目
- 建议的提交命令
