# 本地开发与验收流程

> **这是什么**：怎么把扩展跑起来、怎么改完立刻看到效果、手动验收时该看哪几个地方。
> 属于**按需查阅**文档——`AGENTS.md` 只留一行指针，避免给每个会话都加这个上下文。
>
> **配套**：代码位置查 [`../architecture.md`](../architecture.md)；历史坑点查 [`pitfalls.md`](./pitfalls.md)。

---

## 启动 Extension Development Host

### 方式一：`npm run dev:host`（推荐）

```bash
npm run dev:host                     # 先编译，再启动宿主窗口
npm run dev:host -- --no-build       # 跳过编译，直接启动
npm run dev:host -- <别的目录>        # 用别的目录当工作区（默认本仓库）
```

默认**先编译再启动**是有意的：忘了编译就会测到旧产物，那是"改了半天没生效"最常见的来源。

实现见 `CUSTOMIZATIONS/scripts/dev-host.mjs`。用 Node 而不是把命令直接写进 `package.json` 的 `scripts`，
是因为 npm 在 Windows 默认走 cmd.exe、macOS/Linux 走 sh，`%CD%` 与 `$PWD` 互不通用，
而 `--extensionDevelopmentPath` 需要**绝对路径**（同 `check-registry.mjs` 从 bash 移植到 Node 的理由，见 pitfalls #8）。

### 方式二：直接敲 code 命令

```powershell
# PowerShell / CMD（code 已在 PATH 上）
code --new-window --extensionDevelopmentPath="D:\Git\zgithub\custom-vscode-acp" "D:\Git\zgithub\custom-vscode-acp"

# Git Bash：编译 + 启动一步到位
npm run compile && code --new-window --extensionDevelopmentPath="D:/Git/zgithub/custom-vscode-acp" "D:/Git/zgithub/custom-vscode-acp"
```

`code` 不在 PATH 时用全路径：`& "D:\Program Files\Microsoft VS Code\bin\code.cmd" --new-window ...`

> `code` 不在 PATH 的永久解法：VS Code 命令面板 → `Shell Command: Install 'code' command in PATH`。

### 方式三：在仓库窗口按 F5

`.vscode/launch.json` 的 "Run Extension"，`preLaunchTask` 是 `npm: watch`（会持续重建）。

### 三种方式的区别

| | `npm run dev:host` | 直接敲 `code` | 仓库窗口按 F5 |
|---|---|---|---|
| 加载扩展 | ✅ | ✅ | ✅ |
| 自动编译 | ✅（可用 `--no-build` 关掉） | ❌ | ✅（watch 任务） |
| **附加调试器**（断点、`launch.json`） | ❌ | ❌ | ✅ |
| 需要先打开仓库窗口 | 不需要 | 不需要 | 必须 |
| 适合 | 手工点击验收 | 脚本里调用 | 断点排查逻辑 |

---

## 改了代码之后怎么重载

在**宿主窗口**（标题带 `[扩展开发宿主]`）按 **`Ctrl+R`** 重载扩展宿主，即可加载新的 `dist/extension.js`。
**不需要关掉重开。**

完整循环：

```
改代码  →  npm run compile  →  宿主窗口 Ctrl+R  →  重新操作验证
```

> **不能**只按保存就生效——宿主加载的是 `dist/extension.js`（webpack 产物），不是 `src/`。
> 这也是 `npm run dev:host` 默认先编译的原因。

---

## 手动验收时该看哪几个地方

按排查效率排序：

| 位置 | 看什么 |
|---|---|
| **`Developer: Open Webview Developer Tools`** | **webview 客户端 JS 的唯一报错出口**。`src/ui/chat/html/client/*.ts` 是内联脚本，tsc/lint 看不到运行时问题。命令面板里搜 `webview` 即可找到 |
| 输出通道 **`ACP Client (Custom)`** | 扩展侧日志。聊天面板相关搜前缀 `chat-router:`（面板路由决策）与 `chat-panel:`（面板收到的消息与错误） |
| 输出通道 **`ACP Traffic (Custom)`** | ACP 协议**原始报文**（受 `acpc.logTraffic` 控制，默认开）。很多时候是 agent 没发某条通知，而不是面板没渲染 |
| 命令面板搜 `ACP (Custom)` | 应该列出 21 个命令。少于 21 个说明扩展没完整激活 |

**判断当前是哪块面板**（Chat 面板重写后有两套实现）：

- 顶部**有标签行** + `+` 按钮 → 新面板（`src/ui/chat/`，目前只有 Claude Code 走这条）
- **无标签行**、单会话 → 旧面板（`ChatWebviewProvider`，其余 agent 走这条）
- DevTools Console 里敲 `window.__acpc`：新面板存在该全局对象，旧面板不存在

---

## 手动验收清单（Chat 面板重写）

> 这份清单原先只存在于开发计划里，而计划文件不在仓库中——记在这里以免丢失。
> 对应改动：`CUSTOM-20260923-011` ~ `CUSTOM-20260923-013`。

**P0 · 面板可用性**（每条对应一个已修的缺陷）

| # | 怎么试 | ✅ 通过 | ❌ 失败长什么样 |
|---|---|---|---|
| 1 | 发一句带代码块的请求 | 代码块/加粗/列表**渲染出来** | 看到 `###`、`**`、``` ``` ``` 原始字符 → markdown 链断了 |
| 2 | 发一条长回复 | **只有 1 个**助手气泡在增长 | 出现 N 个气泡各装一段 → 流式分片 |
| 3 | 让它"先思考再回答" | 思考块自动折叠，标题 `Thought for Ns` | 一直展开且写 `Thinking…` |
| 4 | 发消息后立刻看按钮 | 变成 `■ Stop` | 仍是 `Send` → composer 没收到 running |
| 5 | 跑一个改文件的工具调用 → 切标签再切回 | 工具卡片内容**还在** | 只剩空白框 |
| 6 | 点 diff 头部 | 展开行级 diff（行号 + `+`/`-` 配色） | 点了没反应 |

**P1 · 功能**

7. 图片/资源类内容块渲染成真实元素（不是 `[image content]` 占位）
8. 多次 plan 更新后只有**一张** plan 卡片且内容最新
9. 执行类工具卡片上的 `▶ terminal` chip 能展开该终端输出
10. 工具卡片里的文件 chip 能跳到对应文件的行

**P2 · 子 agent 分组**（Claude Code 专用，全部是推断）

11. 让它用 Task 起子 agent → 子卡片**缩进**在父卡片下，父卡片显示 `N steps`
12. 子卡片带 `?` 角标 → 走的是**时序猜测**；**没有**角标 → 命中了显式链接（更好的结果）
13. 会话头部 `Sub-agents` 开关能切回扁平；折叠父卡片能连带折叠子卡片

**安全 · 敌意 markdown**（必须全部无害）

```
# H <img src=x onerror=alert(1)>
<script>alert(2)</script>
[x](javascript:alert(3))
![i](javascript:alert(4))
<iframe src="//evil"></iframe>
```

通过标准：**不弹窗**；`<script>` 显示为转义后的字面文本；`javascript:` 链接显示成带删除线的灰字。

**回归**

14. 连一个非 Claude Code 的 agent（如 Gemini CLI）→ 仍是旧面板且行为不变
15. 流式输出时向上滚动 → 焦点**不被拽回底部**，出现 `↓ Jump to latest`

---

## 常见问题

**窗口没出现 / 很快消失**
`code --version` 是否可用？不可用见上面「方式二」的全路径写法与永久解法。

**改了代码但界面没变**
漏了 `npm run compile`，或忘了在宿主窗口按 `Ctrl+R`。两者都要。

**扩展没激活 / 命令数不对**
命令面板搜 `ACP (Custom)` 应见 21 个。若侧边栏没有图标，确认启动参数里 `--extensionDevelopmentPath`
指向的是**仓库根目录**（不是 `src/`）。

**webview 一片空白**
先看 Webview Developer Tools 的 Console——白屏几乎总是客户端 JS 抛异常，而异常**不会**出现在扩展侧输出通道里。
