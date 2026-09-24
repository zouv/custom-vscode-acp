## 重要

每次回复开头都要先喊一声"啊唯"

## 项目概述

本项目是 **`zouv/acp-client-custom`**——基于 [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) 的自定义二次开发版本。

## 必读文件（开始任何任务前）

1. **`CUSTOMIZATIONS/README.md`**——自定义开发机制的完整规则（冲突策略、标记格式、无标记情形、frontmatter 职责）。
2. **`CUSTOMIZATIONS/registry.md` 的「改动总览」一节**——查某个文件当前改了什么、合并上游时怎么处理。
   **不要读它的「变更日志」**：它占该文件约 70% 体积，是 append-only 历史流水，只在需要追查某次改动的来龙去脉时按需查。
3. **上游根目录的 `README.md` 不作为依据**——它是上游文档且**内容已过期**（仍写 `acp.*` 配置键、单 agent 模型、
   过期的命令名）。本仓库行为一律以 `CUSTOMIZATIONS/` 下的文档与代码为准。

## 工作流（写代码 / 排查问题前）

1. **先读 `CUSTOMIZATIONS/architecture.md`**：按 §0.5 任务作用域路由表确定该读哪些文件、忽略哪些；
   用 §2 按**函数名**定位（不依赖行号），只读作用域内的函数。
   特别注意 `src/ui/ChatWebviewProvider.ts` 有 **87KB**，务必用 grep 定位片段、不要整读。图谱过期时以代码为准并顺手订正。
2. **排查 bug 前先扫 `CUSTOMIZATIONS/docs/pitfalls.md` 的标题**：历史坑点避免重复踩；解决新坑后回写一条。
3. **改任何全局标识符前先读 `architecture.md` §4**。

## 技术栈（只列会破坏构建的两条）

- 包管理器：**npm**（**禁止 pnpm / yarn**——会生成本仓库不认的锁文件）
- 打包：**webpack + ts-loader**（**不是 esbuild**）

其余技术栈细节（ACP SDK、ESLint flat config、`@vscode/test-cli`+mocha、Node 版本）见 `architecture.md` §0。

## 构建命令

```bash
npm install         # 必须用 npm
npm run compile     # 开发构建（webpack）
npm run dev:host    # 编译 + 启动 Extension Development Host
npm run lint        # ESLint（--max-warnings 0）
npm test            # 编译 + lint + 跑真实 Extension Host 测试
```

完整命令、三种启动方式的差异（能否下断点）、改完代码后的 `Ctrl+R` 重载循环、手动验收该看哪几个输出通道——
见 [`CUSTOMIZATIONS/docs/dev-workflow.md`](CUSTOMIZATIONS/docs/dev-workflow.md)。

## 提交前必须全绿（自检闸门）

```bash
node CUSTOMIZATIONS/scripts/check-registry.mjs   # 六节，必须 exit 0
npm run lint
```

- **`check-registry.mjs` 不绿 = 改动未完成**。它检查：标记↔账本一致、命名空间卫生、换行符、
  webview 客户端脚本可解析、源码控制字符。
- **换行符是合并能力的命脉**：上游 blob 以 CRLF 入库，新文件写成 LF 会产生整文件伪差异、
  毁掉三方合并。`Write` / `sed` / `npm install` 都产出 LF，写完 `src/**` 后跑
  `node CUSTOMIZATIONS/scripts/normalize-eol.mjs` 归一（详见 pitfalls #7）。

## 关键差异：命名空间是 `acpc.*`，不是 `acp.*`

本 fork 为了让**与上游扩展同时安装不冲突**，把全部**全局可冲突标识符**从 `acp.*` 改成了 `acpc.*`。

- **新增任何命令 / 视图 / 配置项，一律用 `acpc.` 前缀**，不要用 `acp.`。
- **两处 `acp.` 是故意保留的，禁止"顺手修"**：
  `src/core/SessionHistoryStore.ts` 的 Memento key `'acp.sessionHistory.v1'`（**改了会丢用户会话历史**）、
  `src/core/ConnectionManager.ts` 的 `clientInfo.name = 'vscode-acp-client'`（ACP 协议元数据）。
- 改完必须 `grep` 复核——**TypeScript 编译器不检查字符串字面量**。
- 完整清单、改名范围与理由见 `architecture.md` §4。

## Git 分支规则

- **`custom/main`** 是开发主线；**`vendor/main`** 是上游基线镜像（只读，仅 `sync-vendor.ps1` 可更新）；
  `release/<tag>` 由 `acp-release` skill 管理。
- **上游没有版本 tag**：基线定位靠 `vendor/main` + `registry.md` frontmatter 的 `current_upstream_commit`。
- **禁止操作**：
  - **禁止未经用户明确指示 commit / push**：完成改动后只汇报结果，由用户决定何时提交
  - 禁止手动 `git merge` 合并 vendor 到 custom/main（必须走 `acp-merge-upstream` skill）
  - 禁止 `git rebase` 改写 custom/main 的历史
  - 禁止直接 push 到 `vendor/main`

## 自定义代码规范（硬约束）

1. **新文件放 `src/` 下**（按上游的目录结构组织）并在文件头加标记。
   **不要放 `CUSTOMIZATIONS/src/`**——它不在 `tsconfig.json` 的 `rootDir`/`include` 里、
   也不在 webpack 入口图里，放那里的 `.ts` **无法编译**（该目录目前只有一个 `.gitkeep`）。
2. **修改上游文件必须加标记**（格式、无标记情形的完整规则见 `CUSTOMIZATIONS/README.md`）：
   ```
   // [CUSTOM-BEGIN] CUSTOM-YYYYMMDD-NNN - 描述
   // [CUSTOM-END] CUSTOM-YYYYMMDD-NNN
   ```
3. **每次改动必须记录**：完成后调用 `acp-record-change` skill。
4. **不要删除 `registry.md` 的历史条目**（标记 deprecated 即可）。
5. **合并上游完成后、发布前**必须跑 `npm install && npm run lint && npm run compile && npm test`。
6. **新增顶层目录/文件必须同步更新 `.vscodeignore`**，否则会被打进 `.vsix` 发给用户。

## AI Skills 触发条件

> Skill 定义在 `.agents/skills/`。**本表就是触发依据**——不要依赖工具自动发现。

| Skill | 何时调用 |
|-------|---------|
| `acp-record-change` | 完成任何自定义功能/修改后 |
| `acp-merge-upstream` | 用户要求合并上游 / 升级版本 / 同步原仓库时 |
| `acp-release` | 用户要求打包 `.vsix` / 生成安装包 / 发 GitHub Release 时 |

## 文档更新职责（改完代码必须同步）

| 改动类型 | 更新哪里 |
|---------|---------|
| 任何自定义功能/修改 | `registry.md` 的**改动总览** + **变更日志**（record-change skill） |
| 新增/移动函数、改数据流或接口 | `architecture.md`（§0.5 路由 / §1 职责表 / §2 反查表 / §3 链路 / §5 新面板） |
| 解决了一个反复折腾才定位的问题 | `CUSTOMIZATIONS/docs/pitfalls.md` |
| 改了启动/构建/验收流程 | `CUSTOMIZATIONS/docs/dev-workflow.md` |
| 机制/规则变更 | `CUSTOMIZATIONS/README.md` |
| 新增顶层目录/文件 | `.vscodeignore` |

## 代码风格

- 不添加注释（除非用户明确要求）
- 遵循各文件既有风格（源文件 **2 空格**缩进；`src/test/extension.test.ts` 用 **Tab**）
- TypeScript 严格模式已开（`tsconfig.json`）
