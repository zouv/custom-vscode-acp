## 重要

每次回复开头都要先喊一声"啊唯"

## 项目概述

本项目是 **`zouv/acp-client-custom`**——基于 [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp)（VS Code 的 ACP 客户端扩展）的自定义二次开发版本。AI Agent 在本仓库工作时，必须严格遵循以下规则。

## 必读文件（开始任何任务前）

1. **CUSTOMIZATIONS/README.md**——自定义开发机制的完整规则（冲突策略、标记格式、无标记三情形、frontmatter 职责）
2. **CUSTOMIZATIONS/registry.md**——自定义改动登记账本
3. **README.md**——上游项目说明（**注意：命令前缀已不是 `acp.`，见下**）

## 工作流（写代码 / 排查问题前）

1. **先读 `CUSTOMIZATIONS/architecture.md`**：按 §0.5 任务作用域路由表确定该读哪些文件、忽略哪些；用 §2 任务→代码位置表按**函数名**定位（不依赖行号），只读作用域内的函数。特别注意 `src/ui/ChatWebviewProvider.ts` 有 **87KB**，务必用 grep 定位片段不要整读。图谱过期时以代码为准并顺手订正。
2. **排查 bug 前先扫 `CUSTOMIZATIONS/docs/pitfalls.md` 标题**：历史坑点（命名空间重命名、Memento key 误改、`.vscodeignore` 漏排除等）避免重复踩；解决新坑后回写一条。
3. **改任何全局标识符前先读 `architecture.md` §4**：本仓库与上游的核心差异是命名空间 `acpc.*`（非上游 `acp.*`）。

## 技术栈

- TypeScript + VS Code Extension API
- 打包：webpack + ts-loader → `dist/extension.js`（**不是 esbuild**）
- 协议：`@agentclientprotocol/sdk`（ACP，stdio 上的 JSON-RPC 2.0）
- 包管理器：**npm**（**禁止使用 pnpm 或 yarn**——会生成本仓库不认的锁文件）
- Node.js：v20+
- 代码规范：ESLint flat config（`npm run lint`，`--max-warnings 0`）
- 测试：`@vscode/test-cli` + mocha（`npm test`，会拉起真实 VS Code Extension Host）
- 协议：上游 MIT（二次分发需保留 `LICENSE` 与版权声明）

## 构建命令

```bash
npm install         # 安装依赖（必须用 npm）
npm run compile     # 开发构建（webpack）
npm run watch       # 监听构建
npm run package     # 生产构建
npm run lint        # ESLint 检查（--max-warnings 0）
npm test            # 编译 + lint + 跑 Extension Host 测试
```

调试：VS Code 里按 **F5**（`.vscode/launch.json` 的 "Run Extension"），会启动 Extension Development Host。

## 关键差异：命名空间是 `acpc.*`，不是 `acp.*`

本 fork 为了让**与上游扩展同时安装不冲突**，把全部**全局可冲突标识符**从 `acp.*` 改成了 `acpc.*`：
命令 id（21 个）、视图容器 id（`acp-client-custom`）、视图 id（`acpc-sessions`/`acpc-chat`）、
配置段（`acpc.agents` 等 4 项）、上下文键（`acpc.turnInProgress`）、输出通道名。

- **新增任何命令 / 视图 / 配置项，一律用 `acpc.` 前缀**，不要用 `acp.`。
- **两处 `acp.` 是故意保留的，禁止"顺手修"**：
  `src/core/SessionHistoryStore.ts` 的 Memento key `'acp.sessionHistory.v1'`（改了会丢用户会话历史）、
  `src/core/ConnectionManager.ts` 的 `clientInfo.name = 'vscode-acp-client'`（ACP 协议元数据）。
- 改完必须 `grep` 复核——**TypeScript 编译器不检查字符串字面量**。

## Git 分支规则

| 分支 | 用途 | 谁可以写入 |
|------|------|-----------|
| `upstream/main` | 跟踪上游 formulahendry/vscode-acp | 只读（仅 sync 脚本可更新） |
| `vendor/main` | 上游基线镜像 | 只读（仅 `sync-vendor.ps1` 可更新） |
| `custom/main` | 自定义开发主分支 | AI Agent 开发合并 |
| `feature/<name>` | 功能开发分支 | AI Agent 临时分支 |
| `release/<tag>` | 发布分支 | acp-release skill 管理 |

- **remote**：`origin` → https://github.com/zouv/custom-vscode-acp；`upstream` → https://github.com/formulahendry/vscode-acp.git
- **上游没有版本 tag**：基线定位靠 `vendor/main` + `current_upstream_commit`（commit hash），不靠 tag 名。
- **禁止操作**：
  - **禁止未经用户明确指示 commit / push**：完成改动后只汇报结果（改了什么、验证情况），由用户决定何时提交；用户明确说"提交"/"commit"/"push"时才执行
  - 禁止手动 `git merge` 合并 vendor 到 custom/main（必须通过 `acp-merge-upstream` skill）
  - 禁止 `git rebase` 改写 custom/main 的历史
  - 禁止直接 push 到 vendor/main（只能经 `sync-vendor.ps1 -Push`）

## 自定义代码规范（硬约束）

1. **代码隔离优先**：新功能尽量放在 `CUSTOMIZATIONS/src/` 下，通过独立模块挂载
2. **修改上游文件时必须加标记**：
   ```
   // [CUSTOM-BEGIN] CUSTOM-YYYYMMDD-NNN - 描述
   ... 自定义代码 ...
   // [CUSTOM-END] CUSTOM-YYYYMMDD-NNN
   ```
   散落全文的**全局性重命名**无法逐处包裹，在**文件头**加一对标记说明即可（见 CUSTOMIZATIONS/README.md 的"无标记三情形"）
3. **每次改动必须记录**：完成后调用 `acp-record-change` skill 更新 CUSTOMIZATIONS/registry.md
4. **不要删除 registry.md 中的历史条目**（标记 deprecated 即可）
5. **合并冲突**：按 CUSTOMIZATIONS/README.md 的冲突策略速查处理（keep-ours / keep-theirs / merge-manual / package-lock 重新生成）
6. **合并上游完成后、发布前**必须运行 `npm install && npm run lint && npm run compile && npm test`
7. **新增顶层目录/文件必须同步更新 `.vscodeignore`**，否则会被打进 `.vsix` 发给用户

## AI Skills 触发条件

Skill 定义位于 `.agents/skills/`（ZCode 原生发现路径，Claude/Cursor 等工具亦可通过 `.agents` 约定读取）。

| Skill | 何时调用 |
|-------|---------|
| `acp-record-change` | 完成任何自定义功能/修改后 |
| `acp-merge-upstream` | 用户要求合并上游/升级版本/同步原仓库时 |
| `acp-release` | 用户要求打包 .vsix / 生成安装包 / 发布到 GitHub Release 时 |

详细触发场景见各 skill 的 `.agents/skills/<name>/SKILL.md`。

## 项目结构速查

```
src/
├── extension.ts        # 激活入口：装配服务 + 注册 21 个命令 + 事件转发
├── core/               # AgentManager / ConnectionManager / SessionManager(36KB) /
│                       # SessionHistoryStore / AcpClientImpl
├── handlers/           # ACP 客户端能力：FileSystem / Terminal / Permission / SessionUpdate
├── ui/                 # ChatWebviewProvider(87KB) / SessionTreeProvider / StatusBarManager
├── config/             # AgentConfig(读 acpc.agents) / RegistryClient(拉 CDN registry)
├── utils/              # Logger / StreamAdapter / TelemetryManager(已 no-op)
└── test/               # extension.test.ts（唯一的测试）
CUSTOMIZATIONS/         # 自定义开发内容（规则、账本、代码地图、坑点库、代码、脚本）
├── README.md           # 机制与规则唯一完整版
├── architecture.md     # 代码链路图谱（AI 加速索引）
├── registry.md         # 改动登记账本
├── docs/pitfalls.md    # 历史坑点沉淀
├── release-notes/
├── src/ patches/ scripts/
.agents/skills/         # AI Agent 项目级 skills
```

## 文档更新职责（改完代码必须同步）

| 改动类型 | 更新哪里 |
|---------|---------|
| 任何自定义功能/修改 | `CUSTOMIZATIONS/registry.md`（record-change skill） |
| 新增/移动函数、改数据流或接口 | `CUSTOMIZATIONS/architecture.md`（§0.5 路由 / §1 职责表 / §2 反查表 / §3 链路） |
| 解决了一个反复折腾才定位的问题 | `CUSTOMIZATIONS/docs/pitfalls.md`（现象→根因→解法→教训） |
| 机制/规则变更 | `CUSTOMIZATIONS/README.md` |
| 新增顶层目录/文件 | `.vscodeignore`（+ 本文档的项目结构速查） |

## 代码风格

- 不添加注释（除非用户明确要求）
- 遵循现有代码风格（**源文件用 2 空格缩进，`src/test/extension.test.ts` 用 Tab**——遵循各自文件既有风格）
- 使用 TypeScript 严格模式（`tsconfig.json` 已开 `strict`）
- 提交前运行 `npm run lint`
