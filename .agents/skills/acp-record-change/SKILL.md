---
name: "acp-record-change"
description: "记录自定义改动到 CUSTOMIZATIONS/registry.md。Invoke when AI agent completes a custom feature, bugfix, or any modification to upstream code, to register the change for future merge tracking."
---

# ACP Client (Custom) 自定义改动记录 Skill

本 Skill 用于在 AI Agent 完成一次自定义开发后，将改动结构化记录到 `CUSTOMIZATIONS/registry.md` 文件中。**每次完成自定义修改后必须调用本 Skill**。

## 触发条件

- 完成一个自定义功能开发（feature）
- 完成一个自定义 Bug 修复
- 对上游源码做了任何非新增文件的修改
- 修改了 CUSTOMIZATIONS/ 下的自定义模块
- 用户明确要求"记录这个改动"

## 账本的两层结构（**分处两个文件**，先理解再写）

| 层 | 在哪个文件 | 组织方式 | 回答什么问题 | 更新方式 |
|---|---|---|---|---|
| **改动总览**（按文件） | `CUSTOMIZATIONS/registry.md` | 每个文件一节，多轮演进合并为当前状态 | "这个文件现在改了什么？合并上游时怎么处理？" | **该文件已有条目就更新那一节**（合并描述、演进链追加新 id）；没有才新增 |
| **变更日志**（按次） | `CUSTOMIZATIONS/docs/changelog.md` | 按时间倒序 append-only | "这次改动何时发生、为什么、怎么验证？" | 只在顶部追加新条目，**永不改写历史** |

> **两个文件都要更新，这是最容易漏的地方**：拆分的起因就是二者原先在 `registry.md` 里，
> 而该文件被列为每次任务前必读——单体长到 59KB 时其中 40KB 是历史流水，每次白读。
> `registry.md` 里保留了一行 `## 变更日志` 指针标题作为解析器哨兵，**不要删那一行**。

关键原则：**同一文件多轮修改 → 总览里仍是一节**（演进链 `001→002→004` 标注历轮 id），变更日志按轮次各留一条。总览与代码中 `[CUSTOM-BEGIN]` 标记一一对应，是"当前状态"的文档镜像。

## 三种"无标记"情形（本仓库特有，务必区分）

不是所有改动都能加 `[CUSTOM-BEGIN]`，写法按情形区分（完整规则见 `CUSTOMIZATIONS/README.md`）：

| 情形 | 例 | 总览「标记」列怎么写 |
|---|---|---|
| 文件格式不支持注释 | `package.json`、`package-lock.json` | `（JSON 不支持注释，已知无标记缺口）` |
| 测试文件 | `src/test/*.test.ts` | `（测试文件，无标记）` |
| 全局性重命名（散落全文） | `acp.*` → `acpc.*` | 填 change-id；标记加在**文件头**而不是逐处包裹 |
| **未改动的"故意保留"说明行** | `SessionHistoryStore.ts`（Memento key 保留） | 该行必须含 **`未改动`** 或 **`非改动`** 字样，否则 `check-registry.mjs` 会报 NO-MARKER |

## 执行流程

### 第一步：确认仓库位置

如果当前工作目录不是本仓库根目录，通过用户确认或查找包含 `package.json`（含 `"name": "acp-client-custom"`）和 `CUSTOMIZATIONS/registry.md` 的目录来定位。

### 第二步：分析本次改动

```bash
git diff --name-only HEAD
git diff --name-only --cached
git diff --name-only
git ls-files --others --exclude-standard
```

对每个改动文件，判断：改动目的（功能/Bug 修复/配置）、冲突策略（keep-ours / keep-theirs / merge-manual）、是否为纯自定义路径（`CUSTOMIZATIONS/`、`.agents/`、`AGENTS.md` 等上游不存在的文件用 keep-ours）。

### 第三步：为上游文件修改添加标记

对 `modified-upstream` 文件，**必须**在代码中用标记包裹自定义改动区域：

```typescript
// [CUSTOM-BEGIN] <change-id> - <简要描述>
... 自定义代码 ...
// [CUSTOM-END] <change-id>
```

`<change-id>` 格式 `CUSTOM-YYYYMMDD-NNN`。已有标记块内追加修改时复用原 id；**同文件的新逻辑改动区域用新 id 新开标记块**（演进由总览的演进链体现）。

若本次是**全局性重命名/散落全文的改动**，无法逐处包裹，则在文件头部加一对标记说明该文件参与什么全局改动、合并上游后需重新应用。

### 第四步：更新 registry.md（两处）

**改动总览（按文件）**——对每个改动文件：

- 已有条目：更新该节——「标记」列填当前 change-id，「演进链」追加本轮 id，「当前效果」合并描述（把多轮描述融合成"这个文件现在是什么样"，**删除已被后续轮次取代的旧描述**）
- 没有条目：按表头新增一行（纯自定义目录可用 `目录/（文件、文件）` 聚合行）
- **未改动的说明行**：若只是记录"某处故意保持上游值"，该行必须含 `未改动` 字样

**变更日志（按次）**——在 `CUSTOMIZATIONS/docs/changelog.md` **顶部**追加（注意不是 `registry.md`）：

```markdown
### <日期> - <change-id>
- **功能**：<一句话>
- **改动文件**：<列表>
- **详细说明**：<改了什么、为什么、注意事项>
- **验证方式**：<怎么验证的>
- **基于上游版本**：<上游 package.json 的 version>（commit <前 8 位>）
```

> 注意：本仓库上游**无 tag**，"基于上游版本"写 version + commit 短 hash 两者。

### 第五步：一致性自检（必须执行）

```bash
node CUSTOMIZATIONS/scripts/check-registry.mjs
```

脚本做三件事，**退出码非 0 必须修到全绿才算登记完成**：

1. 代码 `[CUSTOM-BEGIN]` 标记 ↔ 总览表双向比对
2. 总览表登记的精确路径文件是否真的含标记
3. 命名空间卫生：`src/` 与 `package.json` 不应残留上游 `acp.*` 标识符

### 第六步：汇报（不自动提交）

登记完成后**停止并汇报**：改动、验证结果、check-registry 状态、建议的提交命令。**不要主动执行 git commit / git push**——提交时机由用户决定（见根 AGENTS.md 禁止操作第一条）。

用户明确要求提交时，提交命令参考：

```bash
git add CUSTOMIZATIONS/registry.md <被标记的修改文件>
git commit -m "feat(custom): <简要描述> (CUSTOM-YYYYMMDD-NNN)"
```

功能代码与登记在同一批提交；补录单独提交。

## 重要约束

1. **变更日志只增不改**（`docs/changelog.md`）；总览条目整体废弃时标 `deprecated` 而非删除。
2. **change-id 不可复用**；同一文件多轮修改 → 每轮新 id + 总览演进链。
3. 路径用仓库根相对路径；同一目录多文件用 `目录/（a、b、c）` 聚合写法。
4. 描述用中文；frontmatter 字段不随意改（职责表见 README.md）。
5. 顺带规则：改了代码结构同步 `architecture.md`；解决了反复折腾的问题回写 `docs/pitfalls.md`；**新增顶层目录必须同步 `.vscodeignore`**（见根 AGENTS.md 文档更新职责表）。

## 输出要求

向用户报告：
- 本轮 change-id、涉及的文件
- 总览更新了哪些既有节 / 新增了哪些节（体现"合并而非堆叠"）
- check-registry.mjs 校验结果（全绿）
- `docs/changelog.md` 当前条目数（`grep -c "^### " CUSTOMIZATIONS/docs/changelog.md`）
