# CUSTOMIZATIONS —— 自定义开发机制说明

本目录是本仓库所有自定义开发内容的唯一家园。规则以本文档为唯一完整版（single source of truth），根目录 `AGENTS.md` 只保留会话级硬约束摘要。

> 本机制移植自 `zouv/custom-chatbox`，并按 VS Code 扩展语境适配（npm / webpack / .vsix / 上游无 tag）。

## 目录结构

```
CUSTOMIZATIONS/
├── README.md        # 本文件：机制与规则完整版（唯一规则源）
├── architecture.md  # 代码链路图谱：文件职责 / 任务→代码位置 / 重点链路（面向 AI 的加速索引）
├── registry.md      # 账本：frontmatter 元数据 + 改动总览（按文件）+ 变更日志（按次）
├── docs/
│   └── pitfalls.md  # 历史坑点沉淀：现象→根因→解法→教训（动手前先扫标题）
├── release-notes/   # 各自定义版本的发布说明归档
├── src/             # 新增的自定义源码（独立模块，通过入口挂载）
├── patches/         # 对上游文件的补丁
└── scripts/         # init-repo / sync-vendor / list-custom / check-registry / release-vsix
```

核心约定：**一处规则（README.md）、一处账本（registry.md）、一份代码地图（architecture.md）、一份坑点库（docs/pitfalls.md）**。规则改动只改本文件；改动登记只写 registry.md；代码结构变化同步 architecture.md；踩坑沉淀进 docs/pitfalls.md；自定义代码优先放 src/。

## 与上游仓库的关系

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/formulahendry/vscode-acp |
| 自定义仓库（origin） | https://github.com/zouv/custom-vscode-acp |
| 协议 | 上游 MIT；二次分发需保留 `LICENSE` 与版权声明 |

**上游没有版本 tag**（只有 `main` 分支），因此：

- vendor 基线分支固定为 **`vendor/main`**，不再是 `vendor/vX.Y.x` 版本线。
- `registry.md` 的 `current_upstream_version` 取**上游 `package.json` 的 `version` 字段**（如 `0.2.0`），它只表示"语义版本号"，**不足以唯一定位代码**；唯一定位靠 `current_upstream_commit`（上游 main 的 commit hash）。两者必须同时准确。
- 判断是否"跨大版本"：对比上游 `package.json` 的 version 与本地记录值。

## registry.md 的两层结构

| 层 | 组织方式 | 回答什么 | 更新方式 |
|---|---|---|---|
| **改动总览** | 按文件（一文件一节，多轮演进合并） | "这个文件现在改了什么？冲突策略？" | 已有该文件就更新该节，演进链追加 id |
| **变更日志** | 按次（时间倒序 append-only） | "何时/为何/怎么验证" | 顶部追加，永不改写历史 |

总览与代码 `[CUSTOM-BEGIN]` 标记一一对应（同一文件的"当前状态"镜像），`sh CUSTOMIZATIONS/scripts/check-registry.sh` 做双向一致性自检——**每次登记后必须跑到全绿**。

## 必须遵守的铁律

1. **开发前先读 `registry.md` 的改动总览**（不必通读变更日志）：了解相关文件已有什么改动、合并时怎么处理。
2. **改动后必须登记**：调用 `acp-record-change` skill（总览按文件合并更新 + 日志按次追加 + check-registry 全绿）。
3. **变更日志只增不改**；总览条目整体废弃时标 `deprecated` 而非删除。
4. **禁止手动 git merge/rebase**：跨上游合并必须走 `acp-merge-upstream` skill；禁止 rebase 改写 `custom/main` 历史。
5. **写代码前先读 `architecture.md`**：按 §0.5 任务路由只读相关文件，省上下文；改了代码结构后同步该文件。
6. **排查问题前先扫 `docs/pitfalls.md`**：新踩的坑解决后回写一条（现象→根因→解法→教训）。

## change-id 与代码标记

每个逻辑改动分配唯一 id：`CUSTOM-YYYYMMDD-NNN`（日期+序号），不可复用（同一标记块内追加修改除外）。

修改上游文件时，改动区域必须用标记包裹：

```typescript
// [CUSTOM-BEGIN] CUSTOM-YYYYMMDD-NNN - <简要描述>
... 自定义代码 ...
// [CUSTOM-END] CUSTOM-YYYYMMDD-NNN
```

合并上游时：标记外的区域优先使用上游版本；`[CUSTOM-BEGIN]...[CUSTOM-END]` 块必须保留，上游重构导致位置漂移时按函数/组件名找新位置。

### 三种"无标记"情形的处理（重要）

不是所有改动都能加标记，本仓库统一按以下三种方式处理，并在 `check-registry.sh` 中放行：

| 情形 | 例 | 处理 |
|---|---|---|
| **文件格式不支持注释** | `package.json`（JSON）、`package-lock.json` | 总览「标记」列写 `（JSON 不支持注释，已知无标记缺口）`；白名单放行 |
| **测试文件** | `src/test/*.test.ts` | 总览「标记」列写 `（测试文件，无标记）`；白名单放行 |
| **全局性重命名（散落全文）** | `acp.*` → `acpc.*` 命名空间重命名 | 在**文件头部**加一对 `[CUSTOM-BEGIN]…[CUSTOM-END]` 注释说明该文件参与全局重命名；合并上游后须重新应用（见 pitfalls #2） |

## 冲突策略速查

合并上游时，对冲突文件按以下策略处理（按优先级从高到低）：

| 优先级 | 条件 | 策略 |
|--------|------|------|
| 1 | 文件在 `CUSTOMIZATIONS/src/` 目录下 | `keep-ours`（保留我们的） |
| 2 | 文件在 `CUSTOMIZATIONS/patches/` 目录下 | `keep-ours` |
| 3 | registry.md 条目标记 `keep-ours` | `keep-ours` |
| 4 | registry.md 条目标记 `keep-theirs` | `keep-theirs`（使用上游的） |
| 5 | 文件是 `package-lock.json` | 接受上游版本后 `npm install` 重新生成 |
| 6 | 文件包含 `[CUSTOM-BEGIN]` 标记 | `merge-manual`（按标记块保留自定义代码） |
| 7 | 其他文件 | `merge-manual`（AI 分析后合并） |

- `keep-ours`：始终保留自定义版本，上游改动放弃
- `keep-theirs`：始终使用上游版本，自定义改动放弃
- `merge-manual`：需要 AI 逐块分析合并（默认）

**参与命名空间重命名的文件（优先级 6 的特例）**：合并上游后，必须先按 `merge-manual` 合入上游改动，**再对全仓重新执行 `acp.*` → `acpc.*` 重命名扫描**（含 `package.json`、`src/`），否则上游新增的命令/视图/配置会以旧前缀混入，造成半重命名状态。详见 `docs/pitfalls.md`。

`registry.md` 自身冲突必须人工决策后手动合并，并检查 frontmatter 合法性。本文件（README.md）策略为 `keep-ours`。

## 条目类型与状态字典

改动总览以文件为单位，不再使用独立的 type 字段；纯自定义路径（`CUSTOMIZATIONS/`、`.agents/`、`AGENTS.md` 等）按 keep-ours 处理，上游文件按标记逐块合并。历史变更日志中的 type 字段（new-file / modified-upstream / config / asset / dependency / script）作为历史数据保留，含义不变。

状态（status）字段：

- `active`：当前生效中
- `deprecated`：已废弃/被替代
- `merged-upstream`：已被上游原生支持，无需保留
- `needs-migration`：跨大版本升级时需要适配迁移

## registry.md frontmatter 字段职责

| 字段 | 更新时机 | 负责方 |
|---|---|---|
| `current_upstream_version` | 上游合并后（取上游 `package.json` 的 version） | acp-merge-upstream |
| `current_upstream_commit` | 上游合并后（取上游 main 的 commit hash） | acp-merge-upstream |
| `vendor_branch` | 固定 `vendor/main` | acp-merge-upstream |
| `last_merge_date` | 上游合并后 | acp-merge-upstream |
| `last_release_version` / `last_release_date` | 发布后 | acp-release |
| `custom_version` | 发布后 | acp-release |
| `upstream_remote` | 首次 clone 初始化 | init-repo.ps1 |

## 辅助脚本

```bash
# 初始化仓库（首次 clone 后）
pwsh ./CUSTOMIZATIONS/scripts/init-repo.ps1

# 查看当前自定义改动（读 registry.md 的 vendor_branch 定位基线）
pwsh ./CUSTOMIZATIONS/scripts/list-custom.ps1

# 同步 vendor/main 到上游指定 commit / 分支
pwsh ./CUSTOMIZATIONS/scripts/sync-vendor.ps1 -Ref upstream/main -Push

# 打包 .vsix（编译 + lint + 测试 + vsce package）
sh ./CUSTOMIZATIONS/scripts/release-vsix.sh 0.2.0-custom.0

# 登记一致性自检（代码标记 ↔ 改动总览，必须全绿）
sh ./CUSTOMIZATIONS/scripts/check-registry.sh
```
