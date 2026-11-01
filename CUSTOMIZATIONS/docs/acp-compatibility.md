# Claude / Codex ACP 接口与功能兼容审查

审查日期：2026-11-01。项目基线：0.2.0-custom.15 / 645b81c；客户端 SDK：@agentclientprotocol/sdk 1.7.0。本文区分标准可选能力、已实现客户端功能、适配器限制与私有扩展，不宣称 ACP 全覆盖。

## 1. 证据与版本边界

逐项检查本项目 ConnectionManager / SessionManager / AcpClientImpl / handlers / Chat 路由，并核对固定版本适配器源码与 npm 元数据：

- Claude：@agentclientprotocol/claude-agent-acp **0.99.1**；commit **0f78dbbdd089e5c64fc908173e8656aa9cc757fb**；主证据：src/acp-agent.ts。
- Codex：@zed-industries/codex-acp **0.16.0**；tag v0.16.0 对应 commit **bb590500e8646f6daf879b8b3c6a659fbd29017d**；主证据：src/codex_agent.rs。
- 协议：ACP v1 session-setup / authentication；本地 SDK 1.7.0 的类型及 Zod schema。
- Codex ACP 是第三方适配器；OpenAI 官方 native Codex app-server 文档不是“本客户端已实现 ACP 功能”的依据。

固定版本不是对未来 latest 的承诺。默认 npx 配置可能拉取变化的适配器；运行时必须依 initialize 实际能力和 configOptions，不能依 Agent 显示名称假定支持。未登录真实账号、未做有费用的 prompt，本文源码声明不等于端到端真实服务验收。

来源（固定源码优先）：

- https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/0f78dbbdd089e5c64fc908173e8656aa9cc757fb/src/acp-agent.ts
- https://raw.githubusercontent.com/zed-industries/codex-acp/bb590500e8646f6daf879b8b3c6a659fbd29017d/src/codex_agent.rs
- https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.99.1
- https://registry.npmjs.org/@zed-industries/codex-acp/0.16.0
- https://agentclientprotocol.com/protocol/v1/session-setup
- https://agentclientprotocol.com/protocol/authentication
- https://learn.chatgpt.com/docs/app-server

## 2. 接口 / 能力矩阵

“未声明”不能理解为请求仍可任意发送；可选接口只在能力协商后调用。

| 能力 / 接口 | Claude 固定版本 | Codex 固定版本 | 本客户端当前状态 |
|---|---|---|---|
| initialize / new / prompt / cancel | 实现 | 实现 | 已接；握手失败/closed 幂等释放资源；新建失败不杀共享 Agent |
| session/update / permission | 实现 | 实现 | session-keyed transcript、权限 bridge/FIFO/取消/弹框兜底 |
| configOptions / legacy modes/models | 使用动态配置 | 使用动态配置 | configOptions 包括 [] 都独占；无旧 model API 显式报错，不假成功 |
| image prompt | 声明 true | 声明 true | send/steer 发出前验证；附件 UI 仍受实际能力约束 |
| audio prompt | 未声明 | 未声明 | 明确拒绝，不能承诺支持音频 |
| embedded resource | 声明 true | 声明 true | resource 能力门控；resource_link 按协议独立处理 |
| fs/read/write + terminal/* | 可用客户端能力 | 可用客户端能力 | 声明并实现；dirty buffer 保护；安全 argv、UTF-8、session ownership、进程树回收 |
| load / list / resume / close | 声明 | 声明 | 已接；历史全页去重/循环游标保护；close 不等于 delete |
| session/fork | 声明 | 未声明 | fork capability 存了，但没有调用 unstable_forkSession / 无 UI |
| session/delete | 声明 | 未声明 | 未实现；本地归档不等于 Agent 永久删除 |
| additionalDirectories | 声明 | 未声明 | 新建会话已接且验证绝对路径；不自动把所有工作区目录授权给 Agent |
| systemPrompt | 声明 | 未声明 | 未接 ACP 配置入口；一般用户 prompt 不是 systemPrompt |
| 客户端注入 MCP stdio/http/sse | http+sse 能力 | http 能力；未声明 sse | **缺口**：new/load/resume 的 mcpServers 全部 []；无客户端配置注入 |
| agent authenticate | 某些认证方法依协商 | ChatGPT 登录 | 已接 RPC + 重试；认证取消保留其他会话 |
| terminal authenticate | 随客户端 terminal auth 能力提供 | 此版本无 terminal 方法声明 | 已实现独立交互命令，不调用 authenticate RPC；args/env 合并，exit0 才成功 |
| EnvVar authenticate | 不以该版本作为重点 | CODEX_API_KEY / OPENAI_API_KEY | **部分**：预先配置启动环境可用；SDK v1 元数据缺口与安全输入 UI 未补 |
| auth/logout | 声明并实现 | 声明并实现 | 未提供客户端入口；断连/关会话不是退出账号 |
| provider list/set/disable | providers 能力 | 未声明 providers 能力 | 未接 SDK unstable provider 接口 / UI |
| form elicitation | 支持 AskUserQuestion/MCP form 等 | 依实际通知；未承诺产生相同 Claude 工具 | 客户端宣告 form 并实现三态/队列/兜底；跨适配器真实服务未验 |
| URL elicitation | 协议可选模式 | 协议可选模式 | 未实现且未声明，属于诚实降级 |
| native subagents / 专属工具扩展 | 部分按客户端身份条件声明（如 AIR） | 该版本无等价声明 | 现有 Claude 嵌套是启发式，不是 native subagents 全覆盖 |
| steering | _meta.steering 扩展 | 未声明 | 仅支持声明后 _session/steering；Codex 不假装支持忙中补发 |

## 3. 优先遗漏与建议

### P1：MCP 配置注入链路缺失

SessionManager.createAcpSession / loadSession / resumeSession 写死 mcpServers:[]。因此编辑器无法通过 ACP 传入用户选定的 MCP 配置；Agent 自身配置的 MCP 仍可能可用，不能说“所有 MCP 不工作”。

建议新增有类型与 runtime validation 的会话 MCP 配置、stdio/http/sse 能力 gate（只对适配器声明的可选 transport）、headers/env 秘密隔离；new/load/resume/fork 共用构造器，明确服务器启动与清理归属。不得未经设计就把工作区不可信配置当可执行命令自动启动。

### P1：Codex EnvVar 认证只覆盖预配置环境

Codex 源码把 ChatGPT 定义为 AuthMethodAgent，把两种 API Key 定义为 AuthMethodEnvVar，声明所需变量。适配器 authenticate 实现可读取预配置环境，缺失则报 env not set。

本地 SDK **1.7.0 v1** AuthMethod 只包含 agent/terminal；zAuthMethodAgent 默认 strip 未知字段，EnvVar 的 type/env 元数据不能完整传到 SessionManager。因此“显示一个认证选项并调用 RPC”不等于 EnvVar 安全认证已实现。

当前可行路径仅为启动 Agent 前已配置相应环境。缺少密码输入框、SecretStorage、明确 opt-in 注入与可控重连。后续需先验证 SDK/协议升级或边界适配，再实现 agent-scoped secret 生命周期；**不能靠强制重启共享 Agent 注入 key 而破坏其他会话**。本轮不把密钥写进 settings、不收集真实账号凭据。

### P2：Claude fork / delete 与两者 logout 未接

能力已经存在但客户端入口未接。fork 需要分支的 transcript/history/focus 初始化；delete 是破坏性操作，必须确认、取消 pending permission/elicitation、清本地快照，且不能把归档当删除。logout 为连接/账号级动作，应明确对全部会话的影响，不能与单会话 close 混同。

### P2：provider / systemPrompt / auth status 等扩展未覆盖

Claude providers 能力已声明；本地 SDK 有 unstable_listProviders/setProvider/disableProvider，但当前没有调用/UI。systemPrompt 和部分原生子 Agent 能力也未接。authStatus 的 _auth/status_update、promptQueueing、异步任务停止等扩展不等于基本 session/update，不能靠现有通用 UI 假定全支持。

建议将能力与扩展注册集中成可测试矩阵，先实现用户需要的入口；不要一次性接入身份限定的 AIR 扩展。URL elicitation 保持不声明，直到有安全 URL/用户确认/取消生命周期实现。

### 私有模型扩展边界

acpc.customModels 经 _meta.extraModels 传给本仓库配套 Claude fork；这是私有扩展，不是通用 ACP 标准。stock Claude / Codex 不保证追加或接受这些模型；UI 出现候选不等于后端可执行。以适配器返回 configOptions 与 RPC 结果为准。

## 4. 本轮已修复的协议与可靠性问题

- 现代多会话界面覆盖 Claude/Codex/自定义 Agent，解决 legacy 标题/记录混会话路径。
- terminal auth 能力与执行接线；cmd/native exe argv，auth/base env 合并；取消不破坏其他会话。
- configOptions 空数组错误 fallback、无 legacy model API 假成功、unsupported prompt blocks 先验。
- Agent 会话列表分页全量、重复游标/ID 去重与 100 页防护；筛选/不完整失败不 reconcile；非权威联合历史禁用提前删除。
- 握手失败/closed/dispose 清理、共享会话错误隔离；工具终端输出及时性、UTF-8、所有权与进程树。
- dirty editor 防覆盖（realpath 匹配 Windows 大小写及符号链接别名）；未知 HTML 包装递归清洗；shutdown 前快照 flush。
- 日志默认关闭原文与落盘；窗口隔离、限额队列/持续轮转；Registry v1 schema、超时/并发缓存防旧响应回填。
- SDK ESM 测试 bundling 与最低宿主矩阵；保留 preview/probe 的 out 模块；生产声明/源图不分发。

## 5. 验证、风险与剩余边界

- Windows 本机 VS Code **1.144.0** 与 **1.85.0**：各 **503 passing**。含真实编辑器、SDK stdio、cmd/.bin/native argv、进程树与真实 no-op 交互终端自然退出；其余协议大多用可控桩，不冒充真实 Claude/Codex 登录和模型推理。
- npm audit --omit=dev：**0**。全量：**17 moderate、0 high/critical**；残留在 glob/minimatch 与 lint/test/vsce 链。采用非 force 的兼容修复与 Mocha scoped serialize-javascript 7.1.3 override；未盲目跨 major 升级。
- CI 配置已补 Node 22、Windows minimum、macOS compile/lint 和分发闸门；未跑远程 CI，macOS 历史 Electron live-test 限制保留。
- 普通关闭尽力保存快照；宿主强杀/系统断电不承诺 Memento 写必完成。已退出父进程的孤儿后代不保证全面回收；日志溢出/I/O 错误可能丢记录。
- 三份 replay fixture 路径已匿名化，另补两份夹具 ls owner/group 的 user/1000 占位替换，预览与测试中的机器相关样例也替换为占位值，并加入路径/目录身份闸门（10个合成自检）；历史 changelog 的两处私人路径和 Git 历史仍未清理：append-only/历史重写规则需要用户明确授权。不是全面 secret/二进制审计。
- 未 commit、push、升版本或发布。
