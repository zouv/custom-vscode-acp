# 变更日志（按次）

> **这是什么**：本仓库自定义改动的 **append-only 历史流水**，按时间倒序，只增不改（历史是事实）。
> 每条记录一次改动：功能 / 改动文件 / 详细说明 / 验证方式 / 基于哪个上游 commit。
>
> **什么时候读它**：需要追查某次改动的来龙去脉、或核对某一轮到底改了什么时才读。
> **平时不要读**——查「某个文件现在改了什么、合并上游时怎么处理」请读
> [`../registry.md`](../registry.md) 的**改动总览**（那才是当前真相）。
>
> 本文件于 `CUSTOM-20260923-016` 从 `registry.md` 拆分出来：原先单体 59KB，其中 40KB 是这个日志，
> 而 `AGENTS.md` 把 `registry.md` 列为每次任务前必读。

> **2026-09-25 做过一次同题合并**（CUSTOM-20260925-060）：把"同一个问题分多次修"的条目合并成一条
> （14 项面板审计 → 2 条、白条问题 → 1 条、每会话 cwd 两步 → 1 条），59 条 → 46 条。
> **所有 change-id 都保留在合并后的标题里**，所以「代码标记 → 账本 → 日志」的追溯链没有断。
> 这是本文件唯一一次改写历史——**之后仍然 append-only**。

---

### 2026-09-30 - CUSTOM-20260930-150
- **改进**：把"日志落盘"这条排查路径放回**入口处**（能力早就有，问题是想不起来用）
- **改动文件**：`CUSTOMIZATIONS/docs/dev-workflow.md`、`CUSTOMIZATIONS/docs/pitfalls.md`（另加一条 AI 长期记忆，不在仓库里）
- **来源**：用户复验 149 时提出 —— "这次要我手动拷贝日志，上次添加本地日志，下次类似问题你可以自己记录到日志里然后排查？"
- **详细说明**：
  - 落盘本身在 **CUSTOM-20260928-095** 就做了：`~/.claude/acp-client-custom.log`，宿主的 `log()` / `logTraffic()`、以及 webview 客户端经 `clientLog` 转发的 `console.warn/error` 全都写进去（超 5MB 先截断）。代码注释里当时写的就是"让 AI 排查时能直接读文件而不必用户手动贴日志"。
  - 但这条知识**只存在注释里**，而排查的入口是文档与长期记忆 —— 两处不重合，等于没记：147 / 149 两轮里我三次请用户"打开输出面板 → 搜 [acpc] → 发我"。
  - 本次：①`dev-workflow.md` 新增「排查入口：日志已经落盘」（路径、`grep` 姿势、"要新证据就加 `console.warn('[acpc] …')`"、**不要请用户手工拷贝**）；②`pitfalls.md` **#35** 记下这条流程教训（"我们已经有这个能力"与"我下次会想起用它"是两件事）；③147 加的三条诊断（`renderMarkdown asked` / `markdownRendered` / `patch dropped`）由"临时"**转正为常驻** —— 它们噪声低，而且现在会自动进日志文件。
- **验证方式**：`grep -n "acpc]" ~/.claude/acp-client-custom.log | tail` 能看到 149 修复后的正常往返（`renderMarkdown asked` 紧跟 `markdownRendered`、**不再有** `dropped markdown item`）—— 这条链路现在自带留痕，下次同类问题不必再让用户搬日志。`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-149
- **修复**：最后一条助手消息不渲染 markdown（真凶找到了 —— 客户端没有会话身份）
- **改动文件**：`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户提供的 Output 日志 —— 里面反复出现 `chat-panel: dropped markdown item <id> (unknown session null)`
- **详细说明**：
  - **真凶**：客户端发出去的 markdown 请求里 **`sessionId` 是 `null`**，宿主 `verifySession` 不认，于是把**每一条回填都静默丢弃** —— 记录显示得出来（数据在客户端、append 那道守卫也放行了），可渲染结果永远回不来。
  - **null 从哪来**：`transcriptView.sessionId`。`reset()` 有意清空它（防止旧的 id 把下一批 markdown 打上前一个会话的标签 —— 那里有注释），而**只有 hydrate（快照路径）会把它设回来**。于是"重开面板 / 切会话之后新到的记录"整段时间里它是 `null`。**注意 boot 自己的 `currentSessionId` 是有值的**（`case 'append'` 有一道 `message.sessionId !== currentSessionId` 的守卫，记录能显示就证明它通过了）—— 两个 sessionId 不是一回事，这正是症状别扭的原因。
  - **修法**：新增 `transcriptView.setSessionId()`；`boot.onMessage` 在每条**带记录**的消息（`entries` 或 `entryId`，即 append / revise / toolUpdate）上顺手校正它 —— 那些消息本来就带 `sessionId`，用它最可靠。
  - **验证方法本身也修了一个假阴性**：我给端到端档写采样时用的是 `setTimeout(0)`，而 `window.postMessage` 的派发是**独立的一次 task**、排在它之后 ⇒ 回填还没被处理就下了"未渲染"的结论。前三轮我报告的"本地跑通/没跑通"因此都不可靠 —— 采样已延后到 120ms。
- **验证方式**：预览新增 `#bootround` 档，走**与真机同一条路径**：`boot`（`focused` 为会话摘要对象）→ `reset()` → `append` → `revise`，且模拟宿主**像真宿主那样校验 sessionId**（没有就丢弃）。结果：`asked: ["md1:v1","md1:v2"]` → `markdownRendered` ×2 → `hasMdClass: true, text: "v2"`、**`droppedNoSession: 0`**。桩测试"reset 之后要靠 setSessionId 把会话身份找回来"把根因钉死（断言 reset 之后确实是 `null`、校正后恢复）。`npm test` **205 passing**、`npm run lint` 0、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-147
- **修复**：最后一条助手消息不渲染 markdown（停在原文），重开会话却正常
- **改动文件**：`src/ui/chat/html/client/boot.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户报"最后一条消息会出现不渲染的情况（应该按 markdown 渲染），对话后动态更新出来的往往不渲染，重开会话就正常"
- **详细说明**：
  - **先复现再判**：加了一条桩测试走**完整链路**（append 时无正文 → revise 送 text → finalize），**通过** ⇒ 客户端的请求链路（`markPending` → `scheduleMarkdown` → `requestMarkdown`）没问题，问题在**回填那一侧**。
  - **真凶是两道过严的守卫**（都在 boot.ts）：
    ①`requestMarkdown` 开头的 `if (!currentSessionId) { return; }` —— `transcriptView` 的 item **自带 sessionId**（请求方就是它），不需要借 boot 的聚焦状态；这道守卫只会在"正文刚落地、聚焦还没同步好"的那一帧把整批请求吞掉（pending 不清空，但下一次触发可能永远不来，正是 128 修过的那个形状）。现在守卫只包住**没有会话身份**的工具项。
    ②`markdownRendered` 的回填循环里 `if (items[j].sessionId !== currentSessionId) continue;` —— 两端的 sessionId 来源不同（请求方是 transcriptView，这里是 boot），一旦不一致就把回填**静默丢掉**，那条记录于是一直停在原文。而宿主其实**已经把 html 写进了 store**（`handleRenderMarkdown` 里 `transcripts.patch`），所以"重开会话就正常"——重开走的是快照，不经过这里。`entryId` 在 store 里全局唯一，按它回填本来就串不了台。
  - **为什么是"往往"**：两条守卫都只在"两个 id 不同步"的窗口里发作，所以它是偶发的 —— 这也解释了为什么重开一次就好了。
- **本地端到端复现（本轮补上的能力）**：这条链路此前**从来没被预览覆盖过** —— `boot.ts` 顶层有 `var vscode = acquireVsCodeApi();`，而预览脚本没提供它，于是 boot 模块一加载就抛错、`NS.boot` 根本不存在，`flushPending` 里那句守卫让它静默什么都不做。现在预览补了三件东西：①`acquireVsCodeApi` 替身（排在客户端脚本之前）；②`#bootround` 档 —— 让 boot 自己初始化（并手动补一次 `DOMContentLoaded`：预览里那个事件早已派发过，boot 的 init 因此一直挂在等它）、由本档**模拟宿主**把 `renderMarkdown` 渲染成 html 回填，走的是真实的流式形状（先落地无正文 → patch 送 text → finalize）；③最早时机的未捕获错误收集器 + 把三条诊断日志抓进探针。**结论**：修好的代码在这条链路上通过（`asked: ["md1"]` → `markdownRendered` → `hasMdClass: true`）；而这条链路里 `currentSessionId` 一直是 `null`（预览收不到 boot 消息），**正是老代码会失败的那条路径**。
- **诊断留痕**：`requestMarkdown` 发出时、`markdownRendered` 到达时、`patch` 因找不到 entry/node 提前返回时，各打一条 `[acpc]` 日志（走既有 Output 通道）。三条合起来能一次判定断点：只有第一条 ⇒ 宿主没回；三条都有 ⇒ 回填落地失败；一条都没有 ⇒ 请求压根没发。
- **验证方式**：新增桩测试"正文后到的助手记录在 settle 时仍会请求"（走 append → patch(text) → patch(streaming:false) 完整链路），`npm test` **204 passing**；`npm run lint` 0、`check-webview-client` 通过、`check-registry.mjs` 六节全绿。真机路径建议 `Ctrl+R` 后连续对话两轮观察最后一条。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-146
- **功能**：Times 开关改成**只作用于工具卡** —— 关 = `3ms`（耗时，常显）；开 = `3ms 18:32`（耗时 + 时刻）。普通消息与 Thought 不再显示时刻
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 145 —— "排版更乱了，不仅没对齐，原本工具调用很工整的现在也都乱了。既然只有'工具调用才有耗时'，那就处理成：开启 times 后，只在工具上显示时间+耗时（不开则只显示耗时）"
- **详细说明**：
  - **145 为什么错**：我为了"让工具卡的时刻与其它记录对齐"，把工具卡的时刻从"标题行里的一项"改成"也浮到右上角"，并给标题行加 `padding-right: calc(5.5ch + 13px)` 硬留槽位 —— 结果是**把工具卡原本工整的那一行挤散了**（标题被压、时刻与耗时分离）。为了对齐去改其中一类的排版，往往把它原本对的东西也搞坏。
  - **回退 + 换方向**：撤销 145 的全部改动（`.tool-head` 的 padding、`.rec-time` 的固定槽位、以及那条"工具卡时刻浮右上"的例外）。真正的修法是用户给的那个：**时刻只属于有耗时的东西**（工具调用），所以选择器从 `.messages.show-times .rec-time` 收窄成 `.messages.show-times .tool-head .rec-time`；非工具记录的时刻元素仍在 DOM 里（`transcriptView` 一律插入），只是不再放它出来 —— **零 JS 改动**。顺带把 `.sticky-user.show-times .rec-time` 改成 `display: none`（置顶条里永远是用户消息，不该冒出时刻）。
- **验证方式**：真 Chromium 无头 + 探针（`times` 读数改为**先按可见过滤**：`visible` 应等于工具卡数量、`rows` 里只该出现 tool）。实测：`visible = 3`（三个工具卡）、`total = 9`（其余 6 个元素在 DOM 里但不可见）、`rows` 全是 `tool`；宽窄两种面板一致。截图 `times.png` 里工具卡读作 `420ms 18:24`，消息/Thought 上没有任何时刻。`npm test` 203 passing、`npm run lint` 0、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-145
- **功能**：打开 Times 后，**所有**记录的时刻落在同一条竖线上（工具卡的时刻不再由它自己那行挤出来）
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验"勾上 times 之后所有卡片都显示时间了（没有时长，而且不对齐）"，并问"其他卡片没有时长是因为拿不到吗"
- **详细说明**：
  - **先回答"时长"那一问**：不是拿不到 —— **只有工具调用**有耗时（ACP 的 `elapsedMs`），普通消息与 Thought 都没有这个数据，所以它们只显示时刻（Thought 的 `Thought for Ns` 是耗时，但它写在正文里、也不是每条都有）。也就是说"没有时长的记录不显示时长"是**对的**，问题只在**排版**。
  - **对齐**：`.rec-time` 本来就是"绝对定位浮在记录右上角"，但工具卡是个例外（`.tool-head .rec-time { position: static }`，它是标题行里的一项、排在耗时之后）。实测工具卡的时刻比其它记录靠左 8px、低 8px，而且**窄面板下偏移量还不一样**（宽面板 18/8、窄面板 13/8）—— 因为它的位置由标题行里的内容挤出来，不是钉住的。
  - **修法**：删掉那个例外，让工具卡的时刻**走同一套绝对定位**；标题行用 `padding-right: calc(5.5ch + 13px)` 把槽位让出来（否则会盖住耗时）。同时给 `.rec-time` 一个**固定宽度的槽位**（`width: 5.5ch; text-align: right`）—— 时刻恒为 HH:MM 五个字符、又是 `tabular-nums`，所以这个宽度是定的，右缘因此天生对齐。
- **验证方式**：真 Chromium 无头 + 探针（新增 `times` 读数：逐条量 `.rec-time` 距消息区右缘的距离与距自己卡片顶部的高度）。改前：工具卡 `gapRight = 18`（宽面板）/ `13`（窄面板）、`gapTop = 8`，其余记录 `10`/`0`；改后：工具卡 **`11` / `1`，且宽窄两种面板完全一致**，其余仍是 `10`/`0`（那 1px 是工具卡自己的边框）。窄面板（260px）截图 `times-narrow.png` 里所有时刻贴在同一条右缘上。`npm test` 203 passing、`npm run lint` 0、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-144
- **功能**：底栏悬浮的收尾 —— 消息区底部留白**一贯存在**（内容永不被输入卡遮挡），并把只在**编辑区面板**里出现的两处"隐形遮挡"修掉
- **改动文件**：`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/scroll.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户三轮复验 —— ①"悬浮效果还是没出来（左右空白区域还是会遮挡消息）"；②"还是遮挡了"（附 devtools）；③"消息区的触底判断也应该保持在输入框上面的位置" + "右侧大纲的内容也没显示全"
- **详细说明**：
  - **最终形态**：`.messages` 的 `padding-bottom: calc(24px + var(--acpc-composer-h, 0px))` **一贯存在** —— 内容永远停在卡片上方。配套的是 `scroll.ts` 的判据要**减掉这段留白**：用"内容末尾"而不是"可滚动范围的末尾"算 distance，于是"内容末尾进入视口"与"判定为到底"是同一件事，不会出现"Jump 还说没到底、下面却已经是空白"的灰色地带（那正是前两轮被反复报的区间）。
  - **走过的弯路（已整体撤销）**：中途改成"只在贴底那一刻让位"的条件式 —— `.pin-bottom` 类 + `syncPinBottom()` 单一入口。方向是错的：未到底的内容会被卡片切断，而且为了让它不抖，要在 scroll.ts 里维护"切类 + 滚动位置补偿"，白白多出三个坑（判据减 padding 会撑大贴底区 / 撤留白时 scrollTop 被 clamp 导致来回抖 / `toBottom()` 绕过切类）。教训是：**留白该不该存在，与滚动位置的判定，本来就是两件事**，我一度把它们耦合成一个开关。
  - **编辑区面（真凶）**：`.surface-editor .composer { background: var(--vscode-editor-background) }` 会把这条**浮在消息上的透明层**刷成一块不透明带 —— 输入卡两侧的消息、右侧大纲栏的底部全被它盖住。而这个面正是用户日常用的（面板在编辑区），预览脚本默认渲染的却是**侧边栏面**，所以前三轮一直没照出来。修法：`.surface-editor` 那段只保留 `.load-overlay`（它本来就是不透明遮罩）。
  - **底栏空区吞点击**：`.composer` 通栏但 `pointer-events: none`，只有 `.composer-inner`（卡片与它的弹层）是 `auto` —— 否则输入卡两侧、大纲栏底部那块的点击会被它拦下（实测大纲最后一条的 `elementFromPoint` 命中的是 composer，而不是那条记录）。
- **验证方式**：真 Chromium 无头 + 探针。**编辑区面**（新增 `#…surfaceeditor` 档：把 body 的类改成 surface-editor）：`composerBg = rgba(0, 0, 0, 0)` —— 改之前是 `rgb(31, 31, 31)`，那就是"遮挡"本身。**大纲滚到底**（`#composeroutlinescroll`）：`topElementAtLastItem` 从 `composer` 让开（底栏不再拦事件）。**留白**：各档 `messagesPadBottom = 108px`（= 24 + 卡片 84）一贯存在；`#composerjustup`（贴底后上滚 40px）读到 `messagesClasses = messages`（已无任何切类逻辑，Jump 与留白天然一致）。`npm test` 203 passing、`npm run lint` 0、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-143
- **功能**：未连接时不显示底栏；预留功能区只在钉住大纲栏时占位（没有大纲输入卡就居中）；上下文圆环搬回按钮栏
- **改动文件**：`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/outline.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户第三轮反馈 —— ①没完成连接前把输入框隐藏（这时候显示了也无法输入）；②如果当前没有大纲（新会话或大纲侧边栏没打开），右侧的竖条（预留功能区）也要隐藏，并且输入框居中；③"你错误把上下文进度移到右侧去了，刚才是说先对齐方案才能改，先改回来。右侧预设功能区留着后面设计好方案再看怎么利用"
- **详细说明**：
  - **未连接隐藏底栏**（143）：`body[data-phase="disconnected"] .composer, body[data-phase="connecting"] .composer { display: none }`。相位是 `stateCard` 写在 `body[data-phase]` 上的（与 `Times` 那条同一个机制），所以**不需要新增任何 JS**。副产品：`display: none` 让 ResizeObserver 把 `--acpc-composer-h` 归零，消息区不再为一条并不存在的底栏留白。
  - **预留区条件化**（143）：`applyReserve()` 恢复可见性判断 —— 只在 `sidebar && !sidebar.hidden` 时写侧栏宽，否则写 `0px`；CSS 的 fallback 同步从 `240px` 改成 `0px`（JS 未跑时也居中）。**踩到的细节**：光把 `width` 归零不够 —— `border-left` 会在面板右缘留一条 1px 的孤线、`padding-left` 还会撑出 8px，所以三处都得用 `min(…, var(--acpc-aside-w, 0px))`。
  - **圆环回位**（143）：`#contextMeter` 从 `.composer-aside` 搬回 `.composer-bar`。138 把它挪到预留区是我理解错了 —— 用户当时说的是"先对齐方案才能改"，预留区要**先空着**，等方案定了再谈放什么。
  - **顺带**：写 `styles.ts` 的注释时在模板体里用了反引号（`` `disconnected` ``），`tsc` 立刻报 TS1005 —— pitfall #11 的第三次复发，闸门照样拦住了，没有流出去。
- **验证方式**：真 Chromium 无头 + 探针。`#composerwide`（未钉住）：`asideW = 0`、`cardCenter = colCenter = 712`（输入卡居中于面板）、`dxCardVsCol = 0`；`#composeroutline`（钉住 240px）：`asideW = 240`、`dxAsideVsOutline = 0`（竖线与大纲栏左边界对齐）、`dxCardVsCol = 0`；`#phasedisconnected`：`composerDisplay = none`、`composerH = 0`、`messagesPadBottom = 24px`（回落）。`chat-client.test.ts` 的结构断言改成"圆环在按钮栏内、预留区是空的"，`npm test` 203 passing；`npm run lint`、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-140..142
- **功能**：底栏改成**真悬浮**（消息铺到面板底部，输入卡浮在上面）；历史浮层里的目录过滤菜单不再被裁剪、并与历史列表在观感上区分开；目录候选改按字母序
- **改动文件**：`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/composer.ts`、`src/ui/chat/historyDirs.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户第二轮反馈 —— ①输入框两侧还是会盖住消息内容；②目录选择的弹出列表被历史记录列表高度限制，需改为单独控制；②.1 目录列表风格跟历史记录列表过于相似，加个高亮边框区分；②.2 目录列表按字母顺序排序
- **详细说明**：
  - **真悬浮**（140）：139 的"悬浮"仍留在文档流里 —— 底部这一整条（含卡片两侧那两块空白）都不显示消息，用户报"输入框两侧还是会盖住消息内容"。现在 `.composer` 绝对定位（`body` 因此要 `position: relative`）、**背景透明**（有底色就等于把那两侧蒙上一块），消息区占满整个高度、卡片浮在上面。脱离文档流的代价是占位要补回来：`.messages` 的 `padding-bottom: calc(24px + var(--acpc-composer-h, 0px))`、`#jumpToLatest` 的 `bottom` 同款补偿；`--acpc-composer-h` 由 `composer.ts` 新增的 `watchHeight()` 用 **ResizeObserver 观察底栏本身**写入（pitfall #27：别去列"哪些事件会改变高度"，那份清单必然落后）。桩 DOM 里 `#composer` 与 `body.style.setProperty` 都不存在，两处都判空跳过。
  - **目录菜单被裁**（141）：菜单是绝对定位，包含块是 `.outline-head`（sticky），而 head 在 `#history` **内部** —— 后者是 `overflow-y: auto` 的滚动容器 ⇒ 菜单的可见高度 = head 底边到浮层底边的距离，**历史列表越短菜单越矮**（实测只剩两三行）。修法是把滚动**下移**到 `.outline-list`：`#history` 改成 flex column + `overflow: visible`，于是它不再裁剪任何后代，菜单高度交回自己的 `max-height` 单独控制。**只写 `#history`** —— `#outline` / `#cwdMenu` 没有这种嵌套菜单，不动 `.outline` 的通用规则。
  - **观感区分**（141）：菜单与历史列表都吃 `--vscode-dropdown-*` 那套 token（底色/边框/圆角/阴影几乎同值），叠在一起分不清谁是谁。给菜单加 `.filter-menu`，只把边框换成 `--vscode-focusBorder` —— 借 `.filter-chip.on` 那套"当前项"语义，**不是画环**（环在这个面板里是键盘焦点，062 的教训）。
  - **字母序**（142）：`historyDirs.ts` 的排序原本是 `current → 条数降序 → 名称`，前两个键把字母序盖住了，看起来就像"根本没排序"。改成纯按名称；当前目录仍带 `current` 标记（客户端据此高亮它），只是不再置顶。**会话列表不受影响**：它按 `updatedAt` 倒序，是另一条独立的 sort（两者只共享同一次 `listHistory` 的数据，不共享顺序）。
- **验证方式**：真 Chromium 无头 + 探针。`#composerbottom` 档（滚到最底）：`composerPosition = absolute`、`composerBg = rgba(0,0,0,0)`、`messagesPadBottom = 108px`（= 24 + 底栏 84）、**`lastGap = 111 > 底栏高 85`**（判据就是这一条：小于说明最后一条被卡片压住、而且滚不动）、`jumpBottom = 96px`。`#historyfilter` 档：**`drawerOverflowY = visible`**、`menuH = 260`（= 它自己的 max-height；修好前只露两三行）、`menuScrollH = 484`（菜单内部滚动）、`menuBorderColor = rgb(0,120,212)` = `--vscode-focusBorder`、`menuOverhang = 142`（伸出浮层的那 142px 现在看得见）。排序改动让两条既有断言按新行为更新（`ordering: by name`），`npm test` 203 passing；`npm run lint`、`check-registry.mjs` 六节全绿、行尾 CRLF。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-137..139
- **功能**：底部输入区改成**悬浮输入卡 + 右下角预留功能区**（两列，中间一条与大纲栏对齐的竖线）；撤销上一轮给消息区加的版心（消息恢复平铺）；输入卡默认只占**一行**高
- **改动文件**：`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/{composer,outline,rail}.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户对 132-136 的五条反馈 —— ①输入框固定尺寸 OK，但发送按钮离得太远；②**消息面板不要限尺寸**，应当平铺开（更多阅读区域）；③输入框应做成悬浮样式（参考官方插件）；④高度改小，默认一行、多行时才变高；⑤在指定位置加一根与侧边栏对齐的竖线，右下角作预留功能区
- **详细说明**：
  - **撤销消息区限宽**（137）：132 把消息列与输入区一起限到 820px；本轮按反馈只保留底部限宽（消息要宽、输入条要短），`.messages-column` 恢复满宽，变量改名 `--acpc-composer-max: 720px`（720 是"发送按钮够得着"与"长文本可读"之间的折中）。**132 对 `#rail` / `#jumpToLatest` 的搬迁保留**：列恢复满宽后它们与改动前逐像素一致，而列才是消息内容的定位容器，将来若再限宽不必重做。
  - **底部两列**（138）：`.composer` 变成 `.composer-main`（输入卡）+ `.composer-aside`（预留功能区）。用两列而不是 135 那种"给左边补 padding"的算法，是因为主列宽度天然等于"面板宽 − 预留区宽"，**输入卡的中线与消息列的中线自动重合** —— 少维护一个等式（pitfall #24）。
  - **竖线与大纲栏同源**（138）：预留区宽度取自 `--acpc-aside-w`（`outline.ts` 的 `applyReserve()` 写 = 大纲栏宽度，默认 240），它的 `border-left` 因此与**钉住的大纲栏左边界**落在同一条竖线上。这里踩了一个坑：第一版给 `.composer` 留了 8px 左右 padding，探针立刻测出 `dxAsideVsOutline = -8` —— **右侧任何 padding 都会让竖线偏移同样的像素数**，于是左右 padding 归零，输入卡自己的边距交给 `.composer-main` 的**对称** padding（对称 padding 不改变主列中心，实测 `dxCardVsCol` 仍为 0）。`applyReserve()` 的语义也从"侧栏占用宽度"变成"预留区宽度"（未钉住时照写，那块区域常驻）。
  - **悬浮观感**（139）：去掉 `.composer` 通栏的 `border-top`，改由卡片自己的描边 + `box-shadow` + 8px 圆角 + 四周留白表达。**没有脱离文档流** —— 卡片仍在布局里，所以不必随卡片高度动态给消息区让位（那会变成 pitfall #27 的活）。
  - **默认一行**（139）：`composer.ts` 的 `autoGrow` 去掉了 `Math.max(60, …)` 的下限（高度 = 内容的自然高度），空内容 / JS 未跑时由 `.prompt-input` 的 `min-height: calc(1.4em + 4px)` 保底（与 1.4 的行高同源）。上限仍是 320，视口上限仍由 CSS 的 `max-height: min(320px, 38vh)` 夹。
  - **预留功能区放什么**：本轮先放入**上下文用量圆环**（从输入卡里搬出来 —— 它本来就是"这一轮用了多少"的读数，搬走也腾出了按钮栏的横向空间）。后续可放会话级动作（清空 / 导出 / 在编辑区打开），届时再走协议。
- **验证方式**：真 Chromium 无头 + `#composer*probe` 几何读数（1440×1000）：钉住 240px 大纲栏时 **`dxAsideVsOutline = 0`**（竖线与大纲栏左边界对齐）、`dxCardVsCol = 0`（输入卡中心与消息列中心重合）、`dxRailVsCol = 0`、`dxJumpVsCol = 0`、`asideW = 240`、`asideVar = 240px`、`cardW = 720`、`inputH = 27`（单行；改动前是 71）、`cardRadius = 8px`、`cardOverflow = visible`；未钉住时 `colW = 1424`（消息满宽）、`asideLeft = 1184`；窄档 500 下输入卡随主列收缩且 `dxCardVsCol = 0`。结构断言改为守新布局（两列、圆环在预留区而不在卡内、`#sendStopBtn` 仍在卡内），`npm test` 203 passing；`npm run lint`、`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-132..136
- **功能**：输入区与消息区改成**共用版心**（820px、水平居中、窄面板自动满宽）；底部输入框从"横贯整屏的一条带"变成**一体式圆角输入卡**
- **改动文件**：`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/{outline,rail}.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户反馈"底部的输入框有点太长了（因为这个界面一般宽度会拉的比较开），有没有更好的排版及交互方案"；确认范围 = 输入区 + 消息区、宽度 ≈ 820px、一次做到位
- **详细说明**：
  - **诊断**：`.composer` 是 `<body>`（flex column）的直接子块、**无 width/max-width**，`.prompt-input` 在 `.input-row` 里 `flex:1` ⇒ 宽屏下一行文字横跨 1400px+；消息列同样是 `flex:1` 无上限。全文件没有任何容器查询（唯一的媒体查询是 `prefers-reduced-motion`）。
  - **版心**（132）：`max-width + margin-inline:auto` 加在 `.messages-column` 与新的 `.composer-inner` 上，宽度取自 body 上的 `--acpc-content-max`（一处定义、两处引用，pitfall #19）。**不用 media / container query**：它们键的是窗口（或另一个容器），而版心取决于**面板**宽度——那正是 pitfall #25/#26 说的代理信号；`max-width` 自带窄面板退化。限宽必须落在 `.messages-column` 而不是 `#messages`：置顶卡片与引导条都是前者的绝对定位子元素。
  - **两处 DOM 搬迁**（132，本次最容易被"顺手挪回去"的地方）：`#rail` 与 `#jumpToLatest` 从 `.message-area` 搬进 `.messages-column`。它们的横坐标分别来自 CSS 的 `left:0` / `left:50%`，JS 只测纵向 ⇒ 锚错一层就会与内容脱开 `(W−820)/2`（宽面板上几百像素）或 `S/2`（钉住大纲栏时 120px）。搬进列之后"锚到已经在正确位置上的元素"才成立，不引常量、不需 JS 测宽（pitfall #24）。
  - **一体式卡片**（133）：textarea 与按钮栏合进 `.composer-card`（1px 描边 + 6px 圆角），textarea 去边框、透明底；`.input-row` 这层随之删除（它唯一的子节点就是 textarea，而原 `flex:1` 在 flex **列**里含义完全不同）。卡片**绝不能写 overflow**：`.picker-menu` 与 `.slash-popup` 都要向上弹，且 column flex 上的 overflow 会压扁子项（pitfalls #17）。`.slash-popup` 的 `left/right` 从 6px 改 0 —— 定位祖先已从 `.composer` 换成 `.composer-inner`。
  - **焦点与高度上限**（134）：焦点环从 textarea 移到卡片（`:focus-within` 变色），只抑制 `.prompt-input` 的 outline，全局 `:focus-visible` 不动（"环 = 键盘焦点"，062 的语义不变）。高度上限取 `min(autoGrow 的 320px, 38vh)`——前者管内容、后者管屏幕，同时存在时浏览器取小的那个，所以 `composer.ts` 一行没改、也不需要知道视口高度。
  - **侧栏对齐**（135）：钉住大纲栏时消息列中心是 `(W−S)/2`（auto margin 在扣掉侧栏后的剩余空间里居中），而输入区不在那条 flex 行里、中心恒为 `W/2` ⇒ 差 `S/2`（240px 侧栏 = 120px，与是否触到 820 上限无关；之前看不出来只因为两者都近似满宽）。`.composer` 的 `padding-right` 补偿它，`S` 由 `outline.ts` 新增的 `applyReserve()` 复述成 `--acpc-outline-w`（CSS 读不到 flex 项的实测宽度）——这是本轮**唯一**的 JS 改动，必须判空 `document.body.style.setProperty`（桩 DOM 的 body.style 是普通对象）。
  - **验收工具**（136）：`preview-records.mjs` 的 `shoot()` 加 size 参数（默认的 500 是**故意**的窄档——版心只在面板宽 > 820 时才显形，照默认档截"改前/改后"会一模一样），新增 `#composer*` 六档与 composer 几何探针；探针在量 rail / jump-latest 前会临时去掉它们的 `hidden`（`display:none` 的元素 rect 全为 0，否则根本量不到）。
- **验证方式**：真 Chromium 无头截图 + `#composer*probe` 几何读数（1440×1000）：无侧栏 `colW=cardW=820`、`colLeft=cardLeft=302`、`dxCardVsCol=0`、`dxRailVsCol=0`（`railParent=messages-column`）、`dxJumpVsCol=0`；钉住 240px 侧栏时 `dxCardVsCol` **仍为 0**（改动前会是 +120）、`--acpc-outline-w=240px`、`dxCardVsPanel=−120`（= −S/2，有意）；窄档 500 下 `colW=500`（版心退化）且 `dxCardVsCol=0`；矮窗口 1440×560 下 `inputH=177 ≈ max-height 176.7px`（38vh 生效）；`:focus-within` 时 `cardBorderColor=rgb(0,120,212)`=`--vscode-focusBorder`；`#composerslash` 档 `slashW=820`（弹层跟着版心而不是整屏）。`chat-client.test.ts` 新增 3 条**结构断言**守住承重关系（rail/jump 在列内且 rail 在 `#messages` 之前、覆盖层仍留在 `.message-area`、卡片层级不可互换）；`npm test` 203 passing，`npm run lint` / `check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-123..126
- **功能**：面板初始界面改成**连接状态卡**（未连接 / 连接中 / 已就绪三态）；新增配置项 `acpc.autoConnectOnOpen`（默认开，面板打开 0.5s 后自动连接），并在同一张卡片上以复选框呈现、两边双向同步
- **改动文件**：`src/ui/chat/html/client/stateCard.ts`（新增）、`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/{boot,sessionMenu,tabs,index}.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`package.json`、`src/test/{chat-client,chat-panel}.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户四项要求——①配置项控制面板打开时是否自动连接（0.5s，且连接中要看得见、避免重复点击）；②该配置以勾选方式出现在初始界面且可随时取消；③未连接时输入框禁用、连接成功后可用（发送即建新会话）、连接成功后中央要有内容；④基于现有排版重新设计界面与交互
- **详细说明**：
  - **要修的根因**：点 Connect 后面板立刻切到草稿页，而真正的 spawn + initialize（首次 `npx` 可能要下载几分钟）**在界面上完全不可见**——既没有"连接中"，按钮也没有 pending 态，用户会反复点击；而草稿页中央是空的（`focusDraft` 调 `showEmpty(false)`），这正是用户说的"连接成功后一片空白"。
  - **`connection` 下行消息是必需品，不是装饰**（124）：`refreshSessions` 靠签名去重（`conn:` 位），而 `ensureConnected` 在进程已经起来时**不发任何事件** ⇒「已连接 + 无会话 + 点 Connect」这条路上宿主原本一句话都不会说，客户端的"连接中"会**永久卡死**（pitfalls #29 的形态：效果上没变化 ≠ 可以不回话）。`handleConnectAgent` 的三种出口（无 agent / 成功 / 失败）各回一次，且 `connected` 排在 `focusSession` **之后**——客户端靠这个顺序决定要不要开草稿，反了就会在刚打开的会话旁边多出一张空标签。
  - **点 Connect 不再立即开草稿**：推迟到 `connected` 到达时由 `boot` 开（无会话时开一张；用户按过 `+` 则无论有无会话都开）。于是"未连接时输入框禁用"自然成立——**`composer.ts` 一个字节没改**（草稿不存在就不满足 `canCompose()`）。代价是 058 的离线草稿路径（未连接 → 选目录 → 发送时拉起进程）被有意收掉：`+` 在未连接时改为先连接。
  - **单一写者与一个隐患**：`#emptyState` 的 `display` 仍然只有 `boot.showEmpty()` 一个写者，`stateCard.ts` 只写内容（textContent / checked / disabled / 子节点 hidden）。`showEmpty(true)` 里补 `stickyUser.reset()`——置顶卡片是 `.messages-column` 的绝对定位子元素，`transcriptView.reset()` 清不掉它，而卡片没有背景 ⇒ 草稿页会让上一个会话的置顶卡**透出来**。
  - **无会话的失败改走卡片**：`case 'error'` 与 `draftFailed` 原先往空 transcript 里 append 一条通知并 `showEmpty(false)`（卡片被藏起来、中央只剩一行孤零零的报错），现在写进卡片的 `.state-error`。
  - **配置项与双向同步**（125）：`acpc.autoConnectOnOpen` 的读写经 `PanelPrefsIO` 注入缝（默认实现才是 `getConfiguration('acpc')` + `ConfigurationTarget.Global`）——测试 harness 刻意不碰真实 settings.json。**写入失败时广播的是设置真值而不是请求值**，否则复选框会显示一个 settings.json 里没有的值。宿主**首次**引入 `onDidChangeConfiguration`：理由不是"同步方便"，而是面板把这个配置项**渲染成了控件**，控件显示过期值就是在撒谎。
  - **自动连接的三个前提**：`autoConnect && !agentConnected && !focused`。布防**幂等**（boot 会在同一个文档上投递两次：attachSurface 一次、客户端 ready 一次），触发时**再复查一遍**（这 500ms 里可能已经连上、或用户已经在别的草稿页上打字——判据用 `composer.isComposable()` 这个直接信号，不用代理信号）。连接超过 45s **不谎报失败**，只把按钮放开并说明 npx 可能还在下载（`ensureConnected` 本身没有超时，谎报失败比慢更糟）。
  - **`+` 的两种含义**：已连接 = 立刻开草稿（原行为）；未连接 = 先连接并记下意图，`connected` 到达时兑现——否则用户会看到"点了 `+` 却打不了字"。
  - **视觉**：卡片走 VSCode 设计语言（`--vscode-editorWidget-background` / `--vscode-panel-border` / `--vscode-button-*`）。居中用「容器 `flex-start` + 卡片 `margin: auto`」而不是 `justify-content: center`——内容一旦超高，center 会把顶部裁掉且**滚不到**（pitfall #17 同族）；卡片自身**不写 overflow**（会把它在 flex 列里压扁）。删掉 `styles.ts` 里已无使用者的 `kbd` 规则（旧提示硬编码的 `Ctrl+Shift+A` 在 Mac 上本来就是错的，而快捷键本身已有平台差异，不值得在卡片里复述）。
- **验证方式**：`npm test` **189 passing**（新增桩 DOM 14 条 + 宿主侧协议流 8 条）；`preview-records.mjs` 新增 `#empty` / `#connecting` / `#ready` 三张截图与 `#narrow` 窄档，`#probe` 读实测几何：260px 容器下 cardW=220、居中偏差 0、无裁切、`overflow` 仍为 `visible`；`lint` / `check-registry` / EOL 全绿。**过程中踩到一个工具坑并已写进脚本注释**：`--window-size=430` 只裁剪截图、布局视口仍是 500（Chrome 有约 500px 的最小窗口宽度），图像上看着像"卡片右边被裁掉一截"——量了 `innerWidth` 才定性它根本不是 CSS 问题。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-131
- **功能**：① 自动连接延迟 0.5s → **1s**；② **连接成功（且无历史会话）时直接建一个会话**，输入区与正常会话完全一致；③ 未连接时 header 隐藏 `Times` 按钮
- **改动文件**：`src/ui/chat/html/client/stateCard.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/test/{chat-client,chat-panel}.test.ts`
- **来源**：用户三条要求
- **详细说明**：
  - **① 1s**：0.5s 太赶 —— 面板刚渲染完就开始连接，用户还没看清卡片上写着什么。
  - **② 连上就开会话**（用户在两方案里选的）：草稿页**永远做不到**"和正常会话一样" —— 图片要挂在会话上，而模式/模型选择器来自 `session/new` 的响应，**没有会话就没有**（`composer.setDraft` 的注释早就写着这条："That is inherent to a draft, not an oversight"）。所以 `handleConnectAgent` 在"进程已起 + 无会话"时改为 `createSession(agent, {focus:true})`，并且**在报 `connected` 之前**完成 —— 客户端靠这个顺序决定要不要再开一张草稿。代价写在明处：连上之后不说话就离开，agent 历史里会留一条空会话（`session/close` 不删历史，058 的老账）。
  - **③ Times**：相位是**整块面板**的状态，所以 `stateCard.render()` 把它写到 `body[data-phase]`，CSS 据此隐藏。比让每个按钮各自监听相位少三处同步，而且**本地点击发起的 `connecting` 也覆盖到了**（那条路径不经过宿主，各按钮自己监听会漏）。
- **验证方式**：`npm test` **200 passing**（新增 3 条：无会话时建会话 / 有会话时复用不建 / `data-phase` 跟随相位；两条既有用例按新行为改写）；`preview-records.mjs` 的 `empty` 截图确认未连接时 header 只剩历史按钮；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-130
- **功能**：① 就绪卡的标题改成 `Claude Code is ready`；② 标签栏的状态点拆成**两个独立信号**——颜色说状态，外圈说"正在做事"
- **改动文件**：`src/ui/chat/html/client/{stateCard,tabs}.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/handlers/{PermissionBridge,ElicitationBridge}.ts`、`src/test/{chat-client,chat-panel}.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户两条要求（各带一张截图）
- **详细说明**：
  - **① 文案**：`Connected to Claude Code` 与 `Connect to Claude Code` 只差一个字母，扫读时会被读成后者 —— 于是"已经连上了"变成"还需要连接"。状态句（`Claude Code is ready`）比被动语态难误读。
  - **② 圆点的两个信号**：早先 `running` 被映射成"圆点变蓝 **+ 自己脉动**"，一个信号同时说了两件事。现在按分工拆开：**颜色**说这个会话处在什么状态（等人回答 = 橙 > 轮次在跑 = 蓝 > 载入历史 = 黄 > 后台有新输出 = 蓝 > 平常 = 灰），**圆点外的涟漪圈**说"它正在做事"。**为什么必须独立**：一个卡在权限提示上的轮次两件事同时为真（在跑 + 在等人），挤进同一个信号就必然丢掉一件。颜色走 `color` + `background: currentColor`，外圈才能用同一个 `currentColor` 画出来（颜色只有一个来源）。
  - **新增 `SessionSummary.waiting`**：从 `PermissionBridge` / `ElicitationBridge` 的 `hasPendingFor(sessionId)` 读 —— 两个桥才是 pending 的唯一持有者，宿主不再存第二份（pitfalls #19）。`show` / `update` 里各刷一次标签栏（bridge 在这两个调用点前后已经更新过 pending 列表，所以读到的永远是最新值），并且 **`waiting` 必须计入 `refreshSessions` 的签名** —— 漏签名的后果 022（unread）与 063 各踩过一次，那条警告就写在签名旁边。
- **验证方式**：`npm test` **198 passing**（客户端一条覆盖五个组合的用例，颜色与外圈**分别**断言；宿主一条"停在权限提示上 → waiting=true → 结算后回落 false"）；`preview-records.mjs` 新增 `#tabs` / `#tabsbig`（后者把标签栏放大 2.5 倍 —— 7px 的点在整页截图里只有几个像素，不放大看不出外圈）；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-129
- **功能**：界面三处调整——① 打开 Times 时每条记录的时刻移到**标题行右侧**（工具卡读作 `2.2s 11:57`），不再单占一行；② 删掉顶部地址栏的上下文进度条；③ 底部的上下文进度改成**圆环 + 圆心数字**，有轮次在跑时外圈转一段弧
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/{body,styles}.ts`、`src/ui/chat/html/client/{tabs,boot,composer}.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`
- **来源**：用户三条要求（各带一张截图，第 3 条明确委托设计）
- **详细说明**：
  - **① 时刻进标题行**：原先 `.rec-time` 是记录节点的第一个子元素 + `display: block` ⇒ 单占一行。现在它挂在记录的**标题行**里并绝对定位浮在右上角；工具卡例外——它是 `.tool-head` 里的一项、`appendChild` 在耗时之后，于是读作 `2.2s 11:57`。**为什么必须进 summary**：折叠的 `<details>` 会隐藏 summary 之外的一切，早先"挂在记录节点上"的写法会让时刻在**折叠的记录上直接消失**（思考块默认折叠，第一版实测就是它没有时刻）。`.messages > *` 加 `position: relative` 提供定位上下文（不改变布局，rail 测量与置顶克隆都不受影响）。
  - **② 删掉顶部进度条**：`#usageBar` / `renderUsage` / `.usage-bar` 一并删除，`.usage-track` / `.usage-fill` 也随之成为死 CSS 一起清掉。那里的**成本**信息没有丢——移进了底部圆环的 tooltip。
  - **③ 圆环**：24px 的两圈 SVG。内圈是进度（`stroke-dashoffset` 由 JS 按百分比算好，起点用 `rotate(-90deg)` 挪到 12 点方向，否则进度看起来"从右边长出来"），圆心是百分比数字（不带 `%`，精确数值与成本在 tooltip 里），配色沿用 0.7 / 0.9 两档。**外圈**是「有轮次在跑」的信号：一段 1/4 弧缓慢旋转。两处是看截图才定下来的：**外圈必须用 `currentColor` 而不是进度的蓝色**（同色时两圈被读成"两根进度条"）；**外圈半径要比内圈大 2.5**（只差 1.5 时两环贴在一起，读不出是"外圈"）。
  - **测试里 5 条断言按新结构改写**（不是为了让测试变绿）：三处文本断言学会排除那个浮层（`textContent` 不看 `display: none`，pitfall #16 的老账），两处 DOM 顺序断言改用新增的 `summaryOrder()` —— 时刻绝对定位、脱离文档流，不该参与"谁在谁后面"的判断。另：桩 DOM 的 `setAttribute` 补了 `class → className` 的反射（SVG 元素只能 `setAttribute`，没有这层反射桩就找不到 SVG 构造出来的东西）。
- **验证方式**：`npm test` **196 passing**；`preview-records.mjs` 新增 `#times` / `#timescollapsed` / `#gauge`（含 `#gaugewarn` / `#gaugehot` / `#gaugebusy`，以及 `#gaugebig` 放大档）共 8 张截图，肉眼确认时刻位置与圆环形态——**布局靠看，不靠推**（pitfall #31：第一版的外圈配色与半径都是看图才改对的）；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-128
- **功能**：修两个既有缺陷——① 切换模式时记录区出现**两条**提示（第二条把第一条又带了一遍）；② 一轮的**最后一条助手消息**停在原始 markdown 不渲染
- **改动文件**：`src/ui/chat/sessionChoices.ts`、`src/core/SessionManager.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/ChatPanelHost.ts`（只加一行丢弃日志）、`src/test/{chat-client,chat-panel}.test.ts`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **来源**：用户复验 123 时同时报的两条（各带一张截图）
- **详细说明**：
  - **① 模式切换报两次**：`session.modes.currentModeId` 与 `configOptions[category='mode'].currentValue` 是**同一事实的两份副本**，而它们**不会同时被写**——`SessionManager.setMode` 在会话有 configOptions 时提前 return（Claude Code 正是这种），`current_mode_update` 也从不落到 SessionManager。于是宿主的两条上报路径各看到一半：通知路径用 payload 拿到新 modeId，却留着**旧的** mode option；setter 路径读 SessionManager 拿到新 option，却读到**冻结的** `currentModeId`。两份快照永不相等 ⇒「先到的那条提示、后到的那条 diff 为空」这个去重前提失效 ⇒ 第二条提示是现实中不存在的混合态（实测：`Switched to Manual mode · Switched to Bypass permissions mode`）。修法是**让 config option 成为权威**：快照的 modeId 由它派生（没有该选项时回退 `modes.currentModeId`，纯 modes 通道的 agent 不受影响），收到只带 modeId 的 payload 时把新值写回那份副本，`choiceChanges` 跳过该选项（否则一次变化会被报两遍）。`SessionManager.applyConfigOptions` 顺带把值写回 `modes.currentModeId`，让 `metaOf` 等其它消费者也看到新值。
  - **② 最后一条助手消息不渲染**：`transcriptView` 的 `markPending` 在 `place()` 时把记录放进待渲染队列，但**全项目唯一的 `flushPending` 挂在 `patch()` 路径上** ⇒ 一条记录若「最后一次 DOM 更新就是它自己的 append」，它的渲染请求**永远发不出去**，界面上只剩原文，而且两侧都不报任何错。**一轮里的最后一条记录正好是这个形状**（收尾的 revise 若晚到、或这一轮根本不是本面板发起的，就再也没有 patch 了）。这与 **118** 是同一个病——118 给工具卡的正文加了 `scheduleMarkdown()`，助手/思考这一侧当时漏了；现在照同一形态补上（入队即排一帧，一帧最多一次请求）。顺带给 `handleRenderMarkdown` 的静默丢弃加了一行日志：被丢弃的 item 意味着那条记录永远停在原文，而那是唯一能查的地方（120 的教训）。
  - **测试里两处既有断言按新规则改写**（不是为了让测试变绿）：①「模式切换无论走哪个通道标签都一样」原本把两个通道混在一条用例里，且构造了「`modes` 变了而 option 没变」——在新规则下那是**不可能出现的状态**（Claude Code 的 setMode 走 option），现在拆成「无 mode 选项的 agent 走回退」与「有 mode 选项时以它为准」两条；②「mode payload 不丢其它选项」原本断言 `options` 完全不变，现在 mode 副本**应当**被写回，改为断言「其余选项逐一不变 + mode 副本同步」。
- **验证方式**：`npm test` **195 passing**（新增 5 条，其中宿主侧的 `one switch reported through both channels is announced once` 是先红后绿）；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-30 - CUSTOM-20260930-127
- **功能**：已连接时，状态卡上的 "Connect automatically when a panel opens" 整行退场
- **改动文件**：`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/stateCard.ts`、`src/test/chat-client.test.ts`
- **来源**：用户复验 123 后报「已经连接成功就不要显示 Connect automatically when a panel opens 了」（截图）
- **详细说明**：
  - 连上之后卡片是"去下面打字"的路标，不是一个设置表单——开关管的是"下次打开这个面板"，留在这里只是噪音。
  - **隐藏的是整行（`#autoConnectRow`）而不是那个 `<input>`**：只藏复选框会把它的标签文字留在原地。
  - **连接中仍然保留**：那恰恰是用户最可能想关掉它的时刻（agent 起得慢时会想"下次别自动连了"）。测试把这一半也钉住了——只测"连上后消失"的话，一个"永远消失"的实现同样会通过。
- **验证方式**：`npm test` **190 passing**（新增 2 条）；`preview-records.mjs` 的 `ready` 截图确认卡片只剩标题 + 一行引导；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-122
- **功能**：工具卡 `IN` / `OUT` 的**内容左右对齐**（并把输出字体统一成编辑器字体）
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`（新增 `#probe`）、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 121 后报「In 和 Out 没对齐」（截图）
- **详细说明**：
  - **量出来的两条原因**（用 harness 新增的 `#probe` 模式读实测几何，不靠肉眼）：
    1. `OUT` 的 `padding: 2px 6px` 原先加在**grid 容器**（`.tool-seg-out`）上 ⇒ 整个网格（**含标签列**）被推右 6px：IN 的内容列 x=65、OUT x=71。修法：容器不带内边距，**底色与内边距改挂内容格**（`.tool-seg-out > :not(.tool-seg-label)`）。
    2. 工具输出里的 `pre` 落在 `.tool-text` 内（不在 `.bubble`/`.md` 作用域），拿不到那套等宽规则 ⇒ 回落到浏览器默认 monospace（Windows 上是 Courier），与 IN 的编辑器字体**字面宽度与左边界都不同**。修法：`.tool-seg pre/code` 统一 `--vscode-editor-font-family` + 0.92em，并清掉 UA 给 `pre` 的 1em 上下边距（盒子已由内容格提供）。
  - **复核**：修后两侧正文**同起于 x=71**（`#probe` 读数），截图确认 `IN` 与 `OUT` 的文字左边界齐平、同为编辑器字体。
- **验证方式**：`npm test` **167 passing**；`preview-records.mjs` 的 `#probe` + `chrome --dump-dom` 给出对齐前后的坐标；`lint` / `check-registry` / EOL 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-121
- **功能**：工具卡 IN/OUT 改成**左右两栏**（对齐官方插件），并收紧纵向留白
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 120 后报「能看到 output 了，但排版乱乱的，请参考官方的左右排版，尽量少占纵向空间」
- **详细说明**：
  - `.tool-seg` 从"标签一行 + 内容一行"改成 `display: grid; grid-template-columns: 30px minmax(0,1fr)`：**段标在左列、内容在右列**（`.tool-seg > :not(.tool-seg-label) { grid-column: 2 }`，否则 auto-placement 会把第二个子节点甩回第一列）。一张卡因此省掉两行，而一轮里工具卡动辄十几张。
  - **去掉 OUT 框顶部那片空白**：它来自围栏语言标签（`.code-lang` 显示成 "console"）+ `.code-wrap.has-lang pre` 给标签预留的 20px 内边距。工具输出里这个标签没有信息量（命令输出就是 console），两条一起归零；assistant 气泡里的代码块照旧保留。
  - 纵向收紧：`.tool-body` 内边距 4/7/7 → 3/7/5，`.tool-command` 与 `.tool-seg-out` 的内边距各收 1px。
- **验证方式**：`npm test` **167 passing**；`preview-records.mjs`（真 Chromium）截图确认两栏排版与留白（截图里三张 Bash 卡：带描述、无描述、只有 rawOutput 兜底，均在 2 行内完成 IN/OUT）；`lint` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-120
- **功能**：修掉"工具卡 OUT 永远空白"的真凶——`renderMarkdown` 的工具项漏了必填的 `sessionId`
- **改动文件**：`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/boot.ts`、`src/test/{chat-client,chat-panel}.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`、`CUSTOMIZATIONS/docs/pitfalls.md`（#33）
- **来源**：用户第三次报"还是既没有看到 Out 内容，也没有出现 AskUserQuestion 的选项弹框"
- **详细说明**：
  - **根因**：协议里 `renderMarkdown` 的 item 是 `{ entryId, sessionId, text, key? }`，`sessionId` **必填**；宿主的 `handleRenderMarkdown` 对每个 item 跑 `verifySession(...)`，**缺 sessionId 就 `continue` 静默丢弃**。assistant 的 item 一直带着它，而 `toolCallView.pendingMarkdownItems()` 构造的**工具项漏了**——工具正文的 markdown 请求到达宿主即被扔掉，卡上留一个空的 `.tool-text`，**两个进程都不报错**。
  - **修法**：`pendingMarkdownItems(sessionId)` 带上会话（调用方 `boot.requestMarkdown` 传 focused session）。
  - **为什么三轮才找到**：①客户端代码是模板字符串里的**字符串**，`tsc` 不检查里面的对象字面量（必填字段只存在于 `protocol.ts` 的类型里）；②`check-webview-client.mjs` 只查语法；③**自查工具自己掩盖了它**——`preview-records.mjs` 的驱动脚本"替宿主回话"，既不传 sessionId 也不做那一步校验，所以截图里 OUT 一直有内容。现在驱动也照宿主规则校验，这类 bug 以后会被它拦住。
- **验证方式**：`npm test` **167 passing**（新增 2 条：客户端断言请求带 sessionId；宿主断言"没 sessionId 的项被丢弃、有的被渲染"）；`preview-records.mjs` 改走 `hydrate()` + 校验后重新截图，OUT 仍有内容；`lint` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-119
- **功能**：ACP elicitation（表单）支持——AskUserQuestion 在面板里弹选项面板并能回答（Phase B）
- **改动文件**：`src/handlers/ElicitationBridge.ts`（新增）、`src/handlers/ElicitationHandler.ts`（新增）、`src/ui/chat/html/client/elicitationView.ts`（新增）、`src/core/ConnectionManager.ts`、`src/core/AcpClientImpl.ts`、`src/core/SessionManager.ts`、`src/extension.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/transcript/{types,TranscriptStore}.ts`、`src/ui/chat/html/client/{index,transcriptView,links}.ts`、`src/ui/chat/html/styles.ts`、`src/test/elicitation-bridge.test.ts`（新增）、`src/test/{chat-client,chat-panel}.test.ts`、`src/test/fixtures/claude-code-bash-tools.json`（新增，真抓包）、`CUSTOMIZATIONS/scripts/probe-elicitation.mjs`（新增）
- **来源**：用户复验 117/118 后报「现在对话里 Agent 就是处于等待状态（AskUserQuestion），使用官方插件就会弹出选项面板，请再排查下」＋「请先自测好」
- **详细说明**：
  - **根因（adapter 源码 + 实跑双重确认）**：AskUserQuestion 在 ACP 里走 **elicitation（form 模式）**，而 adapter 用 `clientCapabilities.elicitation.form` 门控：不声明时**连工具本身都被禁用**（`disallowedTools = ["AskUserQuestion"]`）。我们此前零 elicitation 支持 ⇒ 会话卡在工具卡上、无从回答。
  - **宿主**：`initialize` 声明 `elicitation: { form: {} }`（`url` 刻意不声明）；`AcpClientImpl.unstable_createElicitation` → `ElicitationHandler`（策略+弹框兜底）→ `ElicitationBridge`（**与 PermissionBridge 同构**：FIFO / `resolved` 幂等 / 单点 resolve / `cancelSession`+`cancelAll`+`onPresenterLost`）；取消轮次、关闭会话、dispose 三处都接上（表单同样是"不答就永远等"的 JSON-RPC 请求）。**三态**：accept 带 content / decline = 跳过（轮次继续）/ cancel = 中止工具调用；只支持 sessionId 作用域（requestId 作用域直接 cancel）。
  - **面板**：新记录类型 `kind:'elicitation'`（`TranscriptStore.appendElicitation`，一个 promptId 一条）+ 新客户端模块 `elicitationView.ts`（按宿主扁平化的 `fields` 渲染单选/多选/复选/数字/文本与「Other」框，三态按钮，结算后禁用并留结果行）。**表单卡是 transcript 的记录 ⇒ 快照天然把它带回来**，切会话/双 surface/重挂载无需新机制。
  - **自测（本轮的重点）**：① 桥的纯逻辑单测 10 条（`PermissionBridge` 至今零测试，这次不重蹈）；② 表单卡桩 DOM 6 条；③ `preview-records.mjs` 加真 schema 的表单夹具，真 Chromium 截图确认观感；④ **`probe-elicitation.mjs` 用真 adapter v0.84.0 端到端跑通**：收到 form（`message`=题目、`question_0.oneOf`=选项、`question_0_custom`=Other），我们的 `fieldsOf` 正确扁平化，回 `{question_0:'A 方案'}` 后 agent 收下并继续（工具结果 "Your questions have been answered: 选哪个方案=A 方案"）。
  - **实跑还推翻了一个假设（见 pitfalls #32）**：`session/load` 一个"卡在 AskUserQuestion"的会话时，adapter **只回放工具卡、不会重抛提问**（`--no-answer` 造出这种会话再 `--reopen` 实测：elicitation 0 次）。所以官方插件能弹面板，是因为**那个未决请求在它自己的进程里**；我们重开别人的会话时不能替它回答——这一点写进文档，别当成 bug 追。
- **验证方式**：`npm test` **165 passing**（新增 16 条：桥 10 + 客户端表单 6）；真 Chromium 截图（表单卡）；真 adapter 端到端探针通过；`lint` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-118
- **功能**：复验 117 的三条修正——工具卡回到默认收起；OUT 不再是空盒子；顺带修掉工具正文渲染请求没人发的老 bug
- **改动文件**：`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/links.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/content/toolCalls.ts`、`src/utils/Logger.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 117 后报三条（"有命令行的卡不需要展开"、"Out 没有内容"、"AskUserQuestion 不弹面板"）
- **详细说明**：
  - **① 默认收起**：117 让"有命令行的卡"自动展开（对齐官方），用户否掉——长会话会变成一堵命令输出墙。现在**每张卡都默认收起**，并把 117 那套自动展开 + `data-user-toggled` 机制整段删除（不留死代码）。
  - **② OUT 空盒子**，两个独立成因：(a) **空白文本项**照旧渲染出一个空节点（026 的规矩本就是"空白不可见"）⇒ `fillToolBody` 跳过它；(b) `rawOutput` 是 agent 在**每条**工具结果里都会写的字段（`rawOutput: chunk.content`），却从未进过视图模型 ⇒ 新增 `ToolCallView.output` 兜底，**仅当 items 里没有可见项**时渲染（`hasVisibleItem` 判定），`bodySignature` 加 `out:`（INV-H）。
  - **③ 工具正文的 markdown 请求以前根本没人发**（这次借 IN/OUT 才暴露的老 bug）：`toolCallView` 的 `mdPending` 队列**只写不读**——全项目只有 `transcriptView.flushPending` 会 `requestMarkdown()`，而它只在 assistant/thought 记录跟踪 markdown 时触发。于是工具正文的渲染请求**只在恰好后面跟着一次 assistant finalize 时**才发得出去；以工具调用结束的轮次、或 assistant 条目本就带 html 的 replay ⇒ 工具正文**永远空白且没有任何报错**。修法：`markdownText` 入队后 `scheduleMarkdown()`（一帧一次、自动合并多个 item）。**这条是 OUT 空白的真凶**，也是为什么用户 117 之前从未看见过 Bash 输出。
  - **顺带**：`logTraffic()` 现在也落盘到 `~/.claude/acp-client-custom.log`（095 那次的目的是"让 AI 直接读日志文件"，而协议 JSON 恰是最值钱的一份却只进了输出通道——本次排查只读得到 type 摘要）。
  - **排查依据（未抓包）**：本机 adapter 源码 `@agentclientprotocol/claude-agent-acp/dist/{tools.js,elicitation.js,acp-agent.js}` + 用户的真实会话记录 `~/.claude/projects/D--Git-zgame-zgame-blog-astro/*.jsonl` + 扩展落盘日志。**结论**：Bash 的 `content` 在客户端不声明 `_meta.terminal_output` 时是 ```console 文本块（有输出）、流式 update 里还会带描述；AskUserQuestion 则被 adapter 用 `clientCapabilities.elicitation.form` 门控——我们没声明，所以它既不会渲染成表单，工具本身也被 `disallowedTools` 禁用。
- **验证方式**：`npm test` **146 passing**（新增 3 条：空白项被跳过且 rawOutput 兜底、可见项优先于兜底、**工具卡确实发出了 markdown 请求**）；`preview-records.mjs` 新增 `#tools` 变体（展开所有工具卡）并加了一条"只有空白项 + rawOutput"的夹具，真 Chromium 截图确认 OUT 有内容。`lint` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-117
- **功能**：工具卡对齐官方 Claude Code 插件——标题用 agent 写的一句话，正文按 **IN / OUT** 分段（Phase A）
- **改动文件**：`src/ui/chat/transcript/ToolInvocationStore.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/content/toolCalls.ts`、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/links.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户要求（附图对照官方插件）："Bash 调用有个标题需要显示"、"Bash 的执行结果需要显示（图2 里有 In 和 Out）"
- **详细说明**：
  - **标题**：`rawInput.description`（真夹具里 4 张 Bash 卡都带，如 "List files in the working directory"）→ 回退 ACP `title`。**必须在 store 里 latch**：描述比首帧晚到（夹具里是第 3 条 update），而 `rawInput` 是"键在才覆盖"、`_meta` 是**整体替换**（`_meta.claudeCode.title` 只活在那一条 update 里）——"要用时再读一遍"会让标题在下一个 chunk 静默闪回命令行。`title` 语义未动（rail tooltip 与 IN 段都读它），只有客户端 `.tool-title` 节点的文字改成 `description || title`。
  - **IN / OUT**：段标只在**有命令行**时出现（`tool.command`）；Read / Edit / Search 没有输入行，**不套 OUT 标签**（那是对调用方向的断言，客户端并不知道），它们的布局与 117 之前逐字一致。
  - **默认展开**：有命令行的卡默认展开（官方就是直接铺开，而"输出看不到"正是用户报的），caret 与 `aria-expanded` 一起置成展开态；`links.ts` 在用户点击时写 `data-user-toggled`，之后自动展开不再插手（否则用户刚收起、下一个输出 chunk 又弹开）。`.tool-seg-out` 复用 `.diff-body` 的 340px 限高。
  - **顺带修了自查工具自己的缺陷**：`preview-records.mjs` 原先自己解析 `.ts` 模板字面量，不做 TS 反斜杠反转义 —— 截图里 `\\u25b8` 真的以字面量出现。改为读编译产物（`styles()` / `body()` / `clientSource()`），不再维护第二份解析器。
- **验证方式**：`npm test` **143 passing**（新增 7 条：客户端 4 + 宿主 3，含"latch 跨 `_meta` 替换存活"与"真夹具 live 流把 description 送到 webview"）；**并用 `preview-records.mjs` 在真 Chromium 里截图验收**（两条 Bash：带描述 / 不带描述，`[Bash] 查看博客目录及父目录现有内容` + IN 命令行 + OUT 输出框）。`lint` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-116
- **功能**：助手消息折叠后显示**正文首行**（与用户消息一致）；并新增**记录区布局的自查工具**（真 Chromium 无头截图）
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/scripts/preview-records.mjs`（新增）、`CUSTOMIZATIONS/docs/pitfalls.md`（#31）、`CUSTOMIZATIONS/docs/dev-workflow.md`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 115 后报「展开时第一行文字显示在了图标行，折叠后文字看不到了。搞反了」
- **详细说明**：
  - **115 的两条推断都是错的**，而且都是用真 Chromium 量出来才发现的（不是读代码能看出来的）：
    ①「作者样式能覆盖 details 折叠时对非 summary 子节点的隐藏」——**覆盖不了**；115 那个 `display` 覆盖
    让折叠态正文彻底不可见（用户看到的就是"折叠后文字没了"）；
    ②「`display:flex` 挂在 details 上 ⇒ 标题行与正文成为两个 flex 项目、`flex-basis:100%` 会把正文换到第二行」
    ——**不成立**（实测首行贴着图标走、其余照旧另起）。
  - **现在的做法（不跟浏览器抢任何东西）**：折叠态那"首行"由 summary 里的 `span.msg-preview` 提供
    —— 它是真文本节点，随正文内容刷新（`refreshPreview`，在 `applyAssistant` 末尾调用：首次渲染与每次
    patch 都会走到，只有一个同步点）。文本取自**渲染后**正文的**首个块元素**（纯流式文本回退到整段），
    只取一行、截到 240 字。展开时由 `.msg-fold[open] .msg-preview { display: none }` 藏掉。
  - **折叠时正文为什么不用管**：`details` 自己会把非 summary 子节点藏起来——这正好是我要的行为，
    以前错在想"抢"它。
  - **116 第一版自己踩的坑**：`buildAssistantFold` 里先调 `applyAssistant` 再 append 正文，
    而预览刷新要顺着记录节点找 `.msg-preview` ⇒ 那时正文还没进树，折叠态一片空白。
    改为**先 append 再 applyAssistant**，并写了用例钉住。
  - **新工具 `CUSTOMIZATIONS/scripts/preview-records.mjs`**：把 webview 真正用的 CSS（`styles.ts`）+
    标记（`body.ts`）+ 全部客户端模块（按 `client/index.ts` 的顺序）拼成独立 HTML，用本机 Chrome/Edge
    **无头截图** `#expanded` / `#collapsed` 两张图。复用生产代码、不复制知识；没有浏览器时跳过后 exit 0；
    不引入任何依赖。这是本轮最有价值的产出——**它一次性结束了"推理 → 写 CSS → 请用户 F5"这个循环**。
- **验证方式**：`npm test` **136 passing**（新增 1 条：预览承载首行、且在 markdown 重写后跟着刷新）。
  **并用 `preview-records.mjs` 在真 Chromium（Chrome）里截图确认了两个状态**：折叠 = `[图标][▸][首行]` 一行、
  展开 = `[图标][▾]` 一行 + 正文在下且**没有重复的首行**。`lint` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-115
- **功能**：助手消息折叠后压成**一行**（`[图标][三角][正文首行]`），与用户消息一致
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户复验 114 后要求「助手消息折叠后，需将第一行文字显示在图标行（与用户消息保持一致）」
- **详细说明**：
  - **114 的折叠态是两行**（标题行 + 钳到一行的正文），而正文是 **summary 的兄弟**（刻意不在 summary 里，理由见 114：在 summary 里划选文本就是点它）——两个**块级兄弟**天然各占一行，光靠行钳制排不到同一行。
  - **修法**：`.msg-fold` 改为 **flex 容器**（`display: flex; flex-wrap: wrap; align-items: baseline`）。折叠时正文 `flex: 1 1 0` 吃掉标题行剩下的宽度（配合行钳制 ⇒ 恰好一行 `[图标][三角][正文首行]`）；展开时正文 `flex-basis: 100%` 换到第二行，图标行在上、正文在下，与 114 之前的样子一致。112 给用户气泡的图片 chip 用的是同一招（flex + `flex-basis: 100%`）。
  - **展开态的 `min-width: 0` 是必需的**：flex 项目的默认 `min-width: auto` 拒绝收窄到内容宽度以下，一个长代码块会把面板横向撑开。
  - **DOM 与协议零改动**：只是 details 的布局方式变了。
- **验证方式**：`npm test` **135 passing**（无新增用例——纯布局，桩 DOM 测不了；结构与 114 完全相同，114 的 2 条用例仍然守着它）。`check-webview-client` 顺带抓到我注释里的反引号（模板字符串内不许有），已修；`lint` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260929-114
- **功能**：助手消息（`agent_message_chunk`）也支持折叠，与用户消息共用同一套折叠控件
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`
- **来源**：用户要求「agent_message_chunk / agent_thought_chunk 类的消息，也都需要支持折叠（规则同用户消息）」（截图）
- **详细说明**：
  - **结构**：`details.msg-fold[open]` > `summary.msg-head`（`[图标][三角]`）+ `div.bubble-body`（summary 的**兄弟**）。默认展开（刚到的回答不该被藏起来）。真三角 `.fold-caret` + 原生 `details` ⇒ 切换不需要 JS，与用户消息同一套机制。
  - **正文刻意不在 summary 里**：用户气泡是惰性文本，整行当点击区没问题；助手正文是 markdown HTML（链接、代码 Copy、图片 chip），而且**在 `<summary>` 里划选文本 == 点它**——读者选中一段回答就会把它折起来。切换区因此只有标题行。
  - **折叠用 CSS 行钳制**（`.msg-fold:not([open]) > .bubble-body { display:-webkit-box; -webkit-line-clamp:1 }`），不是按测量切文本：渲染后的 markdown（段落/代码块/表格）里"切在第几个字符"没有意义；而"首行预览副本"会把同一行文字在 DOM 里放两份（全选/划选复制会重复）。**代价**：折叠态占两行（标题行 + 正文首行），用户气泡是一行。
  - **连带**：`icons.attach` 的 `HOST.assistant` `.bubble` → `.msg-head`（图标仍排在三角前）；`applyAssistant` 里的 takeIcon/putIcon 删掉（图标不再住在被重写的节点里）；`patch` 取内容宿主 `.bubble` → `.bubble-body`（不改这里 markdown 会**静默**落不进新结构）；外观规则 `.entry-assistant .bubble` → `.msg-fold`，`.md` 类名移到 `.bubble-body`。
  - **未改动**：思考块（`agent_thought_chunk`）本来就折叠（默认收起、标题 `Thought for Ns`），本次不动。
- **验证方式**：`npm test` **135 passing**（新增 2 条：助手折叠的结构/默认展开/正文不在 summary 里；markdown 重写后仍落在同一个 body 且标题行的图标与三角都在）。`check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-29 - CUSTOM-20260928-113
- **功能**：折叠控件收尾——单行用户消息也给 caret（不再把控件藏起来）
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/stickyUser.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/docs/arch/chat-panel-records.md`、`CUSTOMIZATIONS/docs/arch/chat-panel.md`
- **来源**：用户复验 112 后报「只有一行的用户对话，也需要支持折叠（现在是把折叠按钮隐藏了）」（截图）
- **详细说明**：
  - **判据**：`planFold` 在**实测占一行**时返回 `{ split: 文本长度, drop: 0 }` —— 全文留在 summary、body 为空、`details` 与 caret **保留**。原先这一档是"退回普通气泡"（064 起），于是短消息没有折叠控件；**这一档不能用 `tidySplit` 表达**（它把"切在末尾"答成 0），必须在 `total <= 1` 时显式返回。
  - **为什么单行也要有控件**：用户看到的缺陷是"按钮不见了"；而且单行消息在更窄的宽度下会折行、折叠态的 summary 不折行，那时折叠是真的动作。
  - **`.fold-body` 变成有含义的标记**：body 为空 ⇒ **不生成**该元素（它 = "caret 后面还藏着东西"）。`settleUserFold` 的重判路径因此改为按需重加，不再无条件 append 一个空 span。
  - **置顶条的收缩按钮跟着改判据**：`stickyUser.render` 从"含 `.user-fold`"改为"含 `.fold-body`"。不改的话每条消息都会拿到一个没反应的收缩按钮 —— 那正是 104 明确拒绝过的（"单行气泡配个没反应的按钮更糟"）。
  - **顺带**（样式，同一轮的收尾）：折叠态带图片时 `.bubble-body` 用 `flex-basis:auto`，正文与图标/caret 同行。
- **验证方式**：`npx mocha --ui tdd out/test/chat-client.test.js` **47 passing**（改 3 条既有用例：单行现在**有** caret 且**无** `.fold-body`；两条"一行放得下"的用例改为断言 split 为空 body，而不是"不折叠"）。`npm run lint` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-112
- **功能**：图片 chip 与图标/caret 同一行
- **改动文件**：`src/ui/chat/html/styles.ts`
- **来源**：用户复验 111 后报"图片显示的位置不对，应该移到第一行"
- **详细说明**：chip 在 `.bubble-body`（`display:block`）之前，被它挤到第二行。改为带图片的 summary 用 `display:flex; flex-wrap:wrap`，`.bubble-body` 用 `flex-basis:100%` 撑到第二行，图标/caret/chip 都排在第一行。
- **验证方式**：`npm test` **133 passing**（无新增用例——纯 CSS 布局，桩 DOM 测不了）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-111
- **功能**：replay 的图片并入用户气泡（不再出现独立的 content 条目）
- **改动文件**：`src/ui/chat/diskSessions.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户复验 110 后报"图片还是没有合并到一起"
- **详细说明**：
  - **根因**：replay 把用户消息的文本与图片分成**两条 chunk**（100 的教训），所以气泡里没有可合并的东西。发送路径（`handleSendPrompt`）已经把图片并进用户气泡，replay 路径没有。
  - **修法**：**在 replay 开始前读转录**。`readTranscriptUserImages`（`diskSessions.ts`）按 `uuid` 建 `messageId → ContentBlockView[]` 表，`preloadTranscriptTimes` 顺带预读（同一目录、同一扫描循环的约束）；`user_message_chunk` 的文本分支据此把图片并入 `appendUser`，随后的图片 chunk 被丢弃（不再产生第二条 content 记录）。任何失败都退化为"没有图片"，不影响 replay。
  - **为什么不用 messageId 关联两条 chunk**：`user_message_chunk` 的文本与非文本块分成两条 chunk 到达，而条目模型没有 `messageId` 可以关联回去——第二来源的关联需要改数据模型，比读转录重得多。
- **验证方式**：`npm test` **133 passing**（新增 1 条："a replayed user message carries its images in the bubble, and the image chunk is dropped"）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-110
- **功能**：折叠时正文提到第一行 + 图片 chip 进气泡内
- **改动文件**：`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/test/chat-client.test.ts`
- **来源**：用户复验 108 后报的两条排版问题（截图）
- **详细说明**：
  - **① 折叠时正文提到第一行**：原来图标与折叠三角留在第一行、正文在第二行，折叠时把正文挤到第二行。改为 `.entry-user .user-fold:not([open]) .bubble-body { display: inline }`，折叠时正文与图标/caret 在同一行。
  - **② 图片 chip 进气泡内**：原来三条「image」chip 在气泡**外面**（每条独占一行），用户要求"参考图 2，应该放到红框位置"。`buildUserBubble` 里把 chip 放在 caret 之后、正文之前；`.entry-user .content-image-chip` 加间距与深色半透明底（`--vscode-textCodeBlock-background` 压在蓝气泡上对比度太低）。
- **验证方式**：`npm test` **132 passing**（新增 2 条："a folded user message keeps its text on the first line"、"an image attachment sits inside the bubble, before the text"）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-106/107
- **功能**：置顶条高亮边框加强（1px 蓝 → 2px 前景色）
- **改动文件**：`src/ui/chat/html/styles.ts`
- **来源**：用户复验 105 后报"看到了但很不明显"
- **详细说明**：105 用的是 1px `--vscode-focusBorder`，而气泡底色是 `--vscode-button-background`（蓝）——两者在默认主题里都是蓝的，对比度极低。改为 **2px `--vscode-foreground`**（深色主题近白、浅色主题近黑）压在蓝气泡上，两种主题都清楚。host 水平内边距从 18/9 改成 17/8，把这 2px 还给内容盒。
- **验证方式**：`npm test` 126 passing；`check-webview-client` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-108
- **功能**：用户消息正文移到第二行 + 图片附件进用户气泡
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户要求（"图标和 Fold 按钮让排版错误，收缩时才显示到第一行"）
- **详细说明**：
  - **正文从第二行开始**：summary 第一行只放图标/caret（+图片 chip），正文包进 `.bubble-body`（`display:block`）另起一行。`textNodeOf` 改为在 `.bubble-body` 里找文本节点（图标/caret/chip 都在外面）。`unfoldUser` 重建气泡时把 chip 一并迁过去。折叠态的截断从整个 summary 改到 `.bubble-body` 自己（否则图片 chip 会被一起截掉）。
  - **图片附件进用户气泡**：`UserEntry` 加 `attachments?: ContentBlockView[]`，`appendUser` 接受并写入；`handleSendPrompt` 里把图片的 `toContentView` 循环提前到 `appendUser` 之前、把 views 一并传入，删掉独立 `content` 条目的 append。Replay 路径不重建（`user_message_chunk` 的文本与非文本块分成两条 chunk 到达，条目模型没有 messageId 可以关联回去）。
- **验证方式**：`npm test` **127 passing**（新增 1 条："a send with text and an image records the image inside the user bubble (108)"）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-109
- **功能**：`<task-notification>` 等注入块从「用户气泡」分流为 `meta` 提示条
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户报的 bug（截图：`<task-notification>` 被渲染成蓝色用户气泡）
- **详细说明**：
  - **判据**：前缀匹配（`isInjectedChunk`：`<task-notification`、`<system-reminder`、`<local-command`、`<command-name`、`<command-message`），与 `diskSessions.ts:66` 的 `<local-command` 先例同一类。
  - **分流**：`user_message_chunk` 分支与 `handleSendPrompt` 共用同一个判据，命中则 `appendNotice(sessionId, 'meta', preview)`；`preview` 由 `stripInjectionWrapper`（剥外层 `<tag>…</tag>`）+ `firstLineOf`（取第一行）得到。
  - **渲染**：`notice.level` 新增 `'meta'`；CSS `.entry-notice.meta` 居中、灰色、小字、无气泡、无图标（icon 是"谁说的"的记号，而它不是任何一方）。
  - **发送路径**：注入块仍然要真的发出去（agent 期待收到），只是不再产生用户气泡。
- **验证方式**：`npm test` **130 passing**（新增 3 条：task-notification → meta、system-reminder → meta、纯用户消息不被分流）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-105
- **功能**：置顶条与消息列真正对齐（让开滚动条）、加高亮边框、用户消息改为靠左铺满
- **改动文件**：`src/ui/chat/html/client/stickyUser.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`
- **来源**：用户复验 104 后的第八轮反馈（截图三条）
- **详细说明**：
  - **① 对齐：差的其实是滚动条**（用户报"悬浮面板还是没有对齐"）。卡片内容盒与 `.messages` 的内边距本来就一致，但 **`.messages` 是滚动容器**——`scrollbar-width: thin` 的细滚动条照样占布局宽度，于是"消息的内容盒"比"消息列"窄那么几像素；悬浮条不是滚动容器，卡片右缘就**右出滚动条那么宽**。修法在 `sync()` 里量：`offsetWidth - clientWidth` 即滚动条宽度（没有则为 0），写进 host 的 `right`，随滚动条出现/消失自动跟着变。**这是"锚真实几何"而不是"量个常量"**——pitfall #24 的反面用法：量的是元素自己当下的宽度差，换主题/换字号/换平台都不会失效。
  - **② 高亮边框**：卡片加 1px `--vscode-focusBorder` 边框——这是本面板**「当前项」的既有语义**（`.outline-item.active` 的左边框、`.filter-chip.on` 的边框同款）。**必须是 border，不能是环**：环在这个面板里已经被 062 定义成键盘焦点（`.rail-dot.active` 的注释就写着这条教训）。host 的水平内边距随之从 19/10 调成 18/9，把那 1px 还给边框，**卡片的内容盒因此仍然逐像素等于 `.messages` 的内容盒**（这是 103 修好、104 又靠 `box-shadow` 保住的同一件事，这次改用 padding 补偿）。
  - **③ 用户消息靠左铺满**（用户要求："现在是靠右对齐，Fold 收缩后面板宽度会因为首行内容少自动缩短，体验不好"）。原来 `align-self: flex-end; max-width: 88%` 让气泡宽度 = 内容宽度（fit-content）：短消息是个小气泡，折叠后只剩首行、**宽度随之缩短**——面板在折/展时自己变窄。改为 `align-self: stretch` 后宽度是常量，折与不折只影响高度。顺带两处必然的连带修改：正文与时刻同一起点（删掉 `.entry-user .rec-time` 的右对齐），圆角由 `8/8/2/8` 改为**四角一致**（那个 2px 缺口本来指向右下，靠左之后方向反了）。**收缩按钮随之从卡片内挪到卡片左侧那条 18px 通道**（`.messages` 给引导条留的 padding-left）：消息铺满后卡片内已没有空档，放在里面会压住正文。
- **验证方式**：`npm test` **126 passing**（置顶组 11 条，新增"the bar ends where the messages end, scrollbar included"）。**RED 验证**：去掉 `sync()` 里的 `alignToContent()`，失败的正好是那条新用例。`check-webview-client` / `check-registry` / `lint` / `compile` 全绿。
- **踩坑记录**：本轮**第三次**踩 pitfall #11（模板字符串里用反引号包代码词，位置在 `styles.ts` 的一句 CSS 注释）。`precompile` 钩子依旧一次报出精确位置——这个钩子自 102 加上以来已经回收了三次成本。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-104
- **功能**：置顶提问条改为悬浮卡片 + 吸顶式交棒 + 收缩为一行
- **改动文件**：`src/ui/chat/html/client/stickyUser.ts`、`src/ui/chat/html/client/scroll.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`
- **来源**：用户复验 103 后的第七轮反馈（截图）；交棒时机由用户在两个方案（加过渡动画 / 吸顶式接管）里选定后者
- **详细说明**：
  - **① 交棒时机提前到"顶边到达视口顶"**：103 的判据是"完全离开视口才置顶"，用户报"等整个对话看不见才闪出来，比较突兀"。改成 `offsetTop - scrollTop < TOP_GAP`（严格窗口）：消息顶边一碰到那条线就成为本轮提问。**提前的前提是位置不变**——副本落在本体当时所在的位置上（窗口 8px，交棒那一帧画面上没有位移），所以提前不会看到两份；103 担心的"同屏"改由**隐藏本体**解决：`.sticky-source { visibility: hidden }`。用 visibility 而不是 display，是因为**几何必须保住**——rail 的测量、`NS.scroll.jumpTo` 依赖的 `offsetTop` 都还要成立。`markSource()` 每帧幂等重贴（一次引用比较），user 条目节点本来也不会被重建（`replaceChild` 只发生在 plan/content/tool 三条路径上，核对过）。
  - **② 悬浮卡片**：外层 `.sticky-user` 降级成"只管定位与内边距"的透明层（`pointer-events: none`，卡片周围的内容与点击都要透过去），底色/圆角/阴影/描边移到内层 `.sticky-card`。描边用 `box-shadow: 0 0 0 1px` 而**不是 border**——**border 会占 1px 布局**，卡片的内容盒便与 `.messages` 的内容盒差 1px，克隆体的右对齐与 88% 宽度就跟着差，而"逐像素对齐"正是 103 刚修好的东西。`TOP_GAP` 由 JS 写进 host 的 inline `padding-top`：那 8px 既是布局也是交棒窗口，必须相等，所以只留一个来源（pitfall #19）。
  - **③ 收缩按钮**：`#stickyToggle`（静态标记在 body.ts，钉在卡片左上角——气泡右对齐，左边那 12% 是空的，且不占内容盒宽度）给 host 加 `.collapsed` 收成一行：多行气泡本就是 `details.user-fold`，`summary` 就是第一行，把 `.fold-body` 藏掉即可，不重建节点。**只在克隆体含 `.user-fold` 时显示**：单行气泡本来就是一行，配一个按下去没变化的按钮比没有按钮更糟（pitfall #5/#23 那一类"点了没反应"）。`stopPropagation` 是必需的——宿主的点击是"跳回原处"。
  - **④ `NS.scroll.jumpTo(node, clearance)`**：新增可选位移（默认 0，既有调用点一行未改）。置顶条的点击要落在**交棒窗口之外**（`TOP_GAP + 1`）：正好落在线上会把消息立刻交还给条，点击就成了一次"没反应"。
  - **⑤ 一个静默的坑（实现时当场发现，加了两道防线）**：`cloneNode(true)` 会把 `class` 一起复制，而本体在交棒后被加上了 `sticky-source` —— **重渲染时（Times 开关、换一条钉住）克隆到的是一个已隐藏的节点，悬浮条会空着显示**，看起来像"这个功能坏了"。防线一：CSS 规则限定在 `.messages` 之内（副本不在其中），那道前缀因此是承重的、不是修饰；防线二：`render()` 显式摘掉这个类。
- **验证方式**：`npm test` **125 passing**（置顶相关 10 条，新增 6 条：顶边一到就接管且本体让位 / 下一条接管时上一条被放回 / 重渲染不得把隐藏类克隆进条里 / 点击交还时要求位移 / 收缩按钮只在多行消息上出现且不触发跳转 / 单行消息不给收缩按钮）。**做过三次 RED 验证**，每次失败的都正好是应该失败的那几条：退回 103 的"完全离开视口"⇒"takes over the instant"红；`markSource` 改空实现 ⇒ 两条断言 `sticky-source` 的红；去掉 `render()` 里摘类那一行 ⇒"never clones the hiding class"红。`check-webview-client` / `check-registry` / `lint` / `compile` 全绿。
- **踩坑记录**：本轮在 `scroll.ts` 的 jsdoc 与 `styles.ts` 的 CSS 注释里写了反引号包裹的代码词，**踩 pitfall #11 两次**（模板字符串在此提前终止，`tsc` 报的是 `TS1005`/`TS2304`，位置与肇事处对不上）。`precompile` 钩子的检查器给出了精确位置——钩子是 102 加的，这次它自己把钱赚回来了。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-103
- **功能**：置顶用户对话的两项优化——排版与列表逐像素一致（不再伸进大纲栏）、判据收紧为「视口里有用户消息就不置顶」
- **改动文件**：`src/ui/chat/html/client/stickyUser.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/boot.ts`、`src/test/chat-client.test.ts`
- **来源**：用户复验 102 后的第六轮反馈（截图 + 两项 AskUserQuestion 选择）
- **详细说明**：
  - **① 判据收紧（用户选定：露出一像素就算"在显示区"、两个滚动方向都生效）**：102 的 `pinnedEntry()` 只回答"最后一条**完全**滚出视口顶部的用户消息是谁"，于是往上滑回到某条提问时，它**越过这条**去钉住更旧的那条——读者眼前明明摆着这一问、顶上却钉着上一问。改为按 DOM 顺序走，**第一条"不完全在视口顶部之上"的条目决定结果**：它在视口里 ⇒ 直接不置顶；它在视口下方 ⇒ 结束遍历返回候选。
    选「无阈值」的理由是**判据要能来回对称**：单一阈值 ⇒ 同一画面从不同方向到达结果相同、不会闪；任何"露出超过 X 才不置顶"都是量出来的常量，换面板高度/字号就错位（pitfalls #24/#26）。顺带**去掉 102 的 8px 容差**——它会让本体还有 8px 露在屏幕上时就钉住，正是 102 自己想避免的"同屏两份"。
  - **② 横向不再盖到大纲栏**：`#stickyUser` 与 `#messages` 移进新的 `.messages-column` 定位容器。102 时 `#stickyUser` 是 `.message-area` 那一 flex **行**的兄弟，而该行除消息列外还装着**定宽可拖拽**的大纲栏 ⇒ `position:absolute; left:0; right:0` 的覆盖层横跨两段，右边一直伸进大纲栏下面（用户报的"甚至到右侧大纲界面了"）。移进容器后"覆盖层不会盖到大纲栏上"是**按构造成立**——不用量大纲栏宽度。已核对无 CSS/JS 依赖「`#messages` 是 `.message-area` 的直接子节点」；`offsetTop` 与 `scroll.jumpTo` 的 `node.offsetTop - container.offsetTop` 在换层前后数值相同。
  - **③ 克隆体排版与列表一致**：`.sticky-user` 补 `display:flex; flex-direction:column`，水平内边距改成与 `.messages` 相同（左 19 给引导条让位 / 右 10）。用户气泡的右对齐与 88% 宽度来自 `.entry-user{align-self:flex-end; max-width:88%}`，而 **`align-self` 只在 flex 容器里生效**——102 的普通块容器让它被忽略，克隆体于是左对齐、按块级撑开（用户报的"被拉长、没靠右"）；88% 的基数也必须与列表相同，否则两个宽度各自成立却对不齐。
  - **④ 时刻的显隐**：`.rec-time` 由 `.messages.show-times` 控制，克隆体不在 `#messages` 里够不着该选择器 ⇒ Times 打开时会出现"列表有时刻、置顶副本没有"。改为 `render()` 把 `show-times` 抄到 host 上，`boot.applyTimes` 之后调 `NS.stickyUser.refresh()` 重渲染（`shownId` 去抖是为让**滚动**便宜，用户手动开关不值得省这一下；`hidden` 仍被 `[hidden]{display:none!important}` 压住，加 `display` 不破坏隐藏，pitfall #13）。
- **验证方式**：`npm test` **119 passing**（置顶相关新增 4 条：视口里有用户消息则不置顶 / 下一条也滚出后由它接管 / 回滚到下一问时**清空置顶而不是退回钉住更旧的那条** / 置顶副本跟随时刻开关）。**做过 RED 验证**：把判据临时改回 102 的写法，失败的正好是其中两条，其余（含"滚过顶部后钉住"这条反向用例）仍绿。`check-webview-client` / `check-registry` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-102
- **功能**：图片改缩略图 chip + 最近一条用户消息悬浮置顶 + 大纲高亮行自动滚入视野 + 构建期客户端脚本硬闸门
- **改动文件**：`src/ui/chat/html/client/stickyUser.ts`（新增）、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/lightbox.ts`、`src/ui/chat/html/client/outline.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`package.json`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/docs/dev-workflow.md`
- **来源**：用户第五轮三项反馈（截图）+ 授权选择（AskUserQuestion）
- **详细说明**：
  - **① 图片改为紧凑 chip**（用户选择「固定小缩略图 + 文件名」）：`renderContentItem` 的 image 分支从 `<img style=max-width:100%>`（一张 1344×695 的截图就撑满整个面板）改为 `<button class=content-image-chip>` = 24×24 缩略图 + 文件名，点击整块打开放大层（097）。`lightbox.zoomTarget` 改为**向上找 `data-zoom-src`**，所以点文件名也生效（此前只有点图片本身）。
  - **② 最近一条用户消息悬浮置顶**（用户选择「消息区顶部、保持一样的渲染」）：新增客户端模块 `stickyUser.ts`。滚动时找到**已完全滚出视口顶部**的最后一条 user 条目，`cloneNode(true)` 到 `#stickyUser`（`.message-area` 内的 absolute 层）——**克隆而不是重写摘要**，折叠态/图标/时刻/markdown 全部与本体一致。只在该条**完全不可见**时才出现（部分可见时浮出会与本体在屏幕上重叠）。仅在「当前钉住的是哪一条」变化时重建（克隆一个 markdown 气泡是这面板最贵的事之一）。点击跳回原处。
  - **③ 大纲高亮行自动滚入视野**：`revealActive()` 在两个形态各自的滚动容器上做最小位移（popup 是 `.outline` 本身，sidebar 是 `.outline-list`）——**刻意不用 `scrollIntoView`**，它会一路向上滚把 `#messages` 也滚了。行已可见时不动，所以刚点过的行不会把列表在光标下重新居中。
  - **④ `precompile` 钩子**：`npm run compile` 现在先跑 `check-webview-client.mjs`。**理由**：本轮我在模板注释里用反引号包裹代码词，**连续踩了三次** pitfall #11，每次都要等 `tsc` 报一个位置对不上的 `TS1005`。检查器本来就能精确报出 `[BACKTICK] 文件:行`，只是没人保证它会先跑。做过负向验证：注入反引号后 `npm run compile` 在 webpack 之前中止。
- **验证方式**：`npm test` **115 passing**（新增 3 条：图片渲染成 chip 且带 `data-zoom-src`；滚过顶部后钉住 / 可见时不钉住、滚回再出现）。`check-registry` / `lint` / `compile`（含新钩子）全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-100
- **功能**：replay 保真度四项——大纲"当前项"贴底判定、记录的真实时刻、草稿页让位、用户消息里的图片
- **改动文件**：`src/ui/chat/html/client/outline.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/diskSessions.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/test/chat-panel.test.ts`、`src/test/chat-client.test.ts`
- **来源**：用户第四轮四项反馈（截图）
- **详细说明**：
  - **① 大纲贴底判定**（"我已经拉到底了，右侧选中的是倒数第二个"）：`syncActive` 原本只按"视口顶部"二分，而最后一条比视口短时它的顶边在视口上方 ⇒ 命中的是倒数第二条。加一条**贴底优先**规则（`scrollTop + clientHeight >= scrollHeight - 4` ⇒ 高亮最后一条），`clientHeight > 0` 守卫隐藏面板（高度全 0 会被误读成"在底部"）。
  - **② 记录的真实时刻**（"时间也不准，都几乎显示在同一秒"）：**根因是 ACP 的 `session/update` 没有任何时间字段**（核对过 SDK：`SessionNotification` 只有 `_meta`/`sessionId`/`update`），宿主给 replay 的每条记录打 `Date.now()`。而**转录文件知道真实时间**，且 replay 分片带的 `messageId` 恰好是转录里的标识（对真实抓包核对：user chunk ↔ 记录 `uuid`、assistant/thought chunk ↔ 记录的 `message.id`）。新增 `diskSessions.readTranscriptTimes`（读整个转录建 `messageId → 最早 timestamp` 表），host 在**打开前**preload（`session-load-start` 太晚——replay 通知是同步流），三条 chunk 路径按 `messageId` 校正 `entry.at`。失败/无转录一律回退 `Date.now()`。
  - **③ 草稿页让位**（"在 New Session 选历史会话，实际刷新的是第一个 tab 页"）：草稿是**客户端私有**的（058），宿主的 `focused` 指向别的会话，于是 099 的替换逻辑关掉了第一个 tab。新增 `fromDraft` 标志：客户端在草稿页选会话时自行 retire 该草稿（`NS.draft.resolve`，不触发 fallback），宿主据此**跳过替换**。
  - **④ 用户消息里的图片**：`user_message_chunk` 只取 `textOf(content)`，非文本块被直接丢弃 ⇒ 重开的会话看不到当时贴的图。照 075 的 thought 修法：空文本时改走 `postContentNotice`。
- **验证方式**：`npm test` **111 passing**（新增 6 条：图片块成为 content 记录、时间表映射与"最早者胜"、端到端 replay 记录带上真实时刻、`fromDraft` 不关闭聚焦会话、贴底高亮最后一条、置顶高亮第一条）。另修 3 条既有用例的等待方式（打开会话不再是首个 await，单微任务不够）。`check-registry` / `lint` / `compile` / `check-webview-client` 全绿。
- **踩坑记录**：又在模板注释里用反引号包裹 `clientHeight > 0`，**这次 `check-webview-client.mjs` 先报了出来**（`[BACKTICK] outline.ts:200`）——pitfall #11 的检查器确实有效，闸门顺序上它值得先跑。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-099
- **功能**：从历史列表选会话改为「当前界面直接切换」，并把加载遮罩限制在消息区
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户反馈「历史里选其他 session 还是会自动新建并切换（tab 越点越多）」+「开新 session 时 Loading 遮罩盖住整个界面」
- **详细说明**：
  - **替换语义**：`handleOpenHistorySession` 在打开前先让**当前聚焦会话让位**（`closeSession`），被选中的会话接管它的位置——tab 数量不再随每次访问历史而增长。语义上也更对：历史列表是**导航**，不是"再开一个"。**没有任何东西被销毁**：让位的会话仍在 agent 自身历史与磁盘上，同一个列表随时能重新打开它（§5.14/§5.24 的整个前提）。要打开的会话**已经在 tab 里**时不做任何关闭（那里没有可替换的东西，那只是一次焦点变更）。关闭失败只记日志、不阻塞用户要打开的会话。
  - **遮罩范围**：`#loadOverlay` 从 `<body>` 末尾移入 `#messageArea`（它本来就是 `position: relative`），`.load-overlay` 由 `position: fixed` 改为 `absolute`。此前会话加载时 tab 栏 / header / 输入框全被盖住，面板看起来像卡死、也没法切走。
- **验证方式**：`npm test` **105 passing**（新增 2 条：选历史会话会关闭当前聚焦会话使其让位；已在 tab 里的会话只聚焦、不关闭任何东西）。`check-registry` / `lint` / `compile` / `check-webview-client` 全绿。
- **踩坑记录**：本轮在 `body.ts` / `styles.ts` 的**注释里**用反引号包裹 `position: fixed` 等 CSS 词，触发 pitfall #11（模板体内反引号会提前终止字符串）。tsc 先报 TS1005。事后对检查器做了**负向验证**（注入反引号 → `check-webview-client.mjs` 两个文件都正确报 `[BACKTICK]`），确认它本身有效——问题在于改完先跑的是 `compile` 而不是检查器。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-098
- **功能**：会话标题随历史列表选择一并带入，让 tab 立即显示与历史一致的名字
- **改动文件**：`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/core/SessionManager.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户反馈「session tab 还是没有显示名称（预期与历史记录一致）」
- **详细说明**：
  - **根因**：`session/load` 的 replay **不总是**回放 `session_info_update`（实测当前会话 353 条消息的 replay 里没有它）。097 让宿主在收到 `session_info_update` 时调 `applySessionInfoUpdate` 落地标题，但 replay 里没有这条通知时 `session.title` 仍是 null，`toSummary` 回退到 `stored.title`/`stored.firstPrompt`——跨目录重开的会话本地缓存里没有条目，于是 tab 显示 sessionId 前缀。
  - **修法**：历史列表的每一行已经带着标题（agent `session/list` 或磁盘 `ai-title`），把它随点击一并带回。`openHistorySession` 消息加 `title`，客户端行上写 `data-open-title`，`handleOpenHistorySession` → `openExistingSession(…,{title})` → `loadSession`/`resumeSession` 把 title 作为**临时标题**写进 session（replay 若带了 `session_info_update` 会覆盖成权威值）；`openExistingSession` 的「已 live」分支也补上「若还没有标题就采用」。
  - **标题规则复核**（用户问「现在的规则是什么」）：`ai-title`（Claude Code 自动命名）优先，找不到回退**第一条**对话。已核对真实数据——agent `session/list` 对近期会话报 ai-title、对早期会话（无 `ai-title` 记录）报首条 prompt，磁盘路径（095）也是 ai-title→首句，规则本身**没有**「最后一条」的情况。
- **验证方式**：`npm test` **103 passing**（新增 1 条：标题随 openHistorySession 一并传入）。`check-registry` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-097
- **功能**：图片点击放大（lightbox）+ 三项会话元数据修复（tab 标题、历史列表含当前会话、Recently used 记录目录）
- **改动文件**：`src/ui/chat/html/client/lightbox.ts`（新增）、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/core/SessionManager.ts`、`src/core/SessionHistoryStore.ts`、`src/test/chat-panel.test.ts`
- **来源**：用户截图反馈 + 复验
- **详细说明**：
  - **图片点击放大**：新增客户端模块 `lightbox.ts`（`#imageLightbox` 覆盖层 + 对 `.content-image`/`.attachment-thumb` 的委托式点击）。记录区图片与输入框图片缩略图点击后全屏放大，点背景 / 点 ✕ / 按 Escape 关闭。纯客户端，不动协议/命令/package.json。
  - **tab 标题不显示**：根因是 `applySessionInfoUpdate` 只被 legacy provider 调用，新面板的 `onSessionUpdate` 收到 `session_info_update` 只 `pushMeta`+`refreshSessions`，从不把标题写到 `session.title`，于是 `toSummary` 回退到 `firstPrompt`/sessionId 前缀。修法：宿主侧在 `session_info_update` 时调 `applySessionInfoUpdate`；并把 `toSummary` 的标题兜底链补上 `stored.title`（与 078 的历史选择器对齐）。
  - **历史列表不含当前会话**：`handleListHistory` 三处（local / fromAgent / readDiskHistory）都 `.filter(!live.has(...))` 把 live 会话（含当前）过滤掉。去掉该过滤（`mergeHistoryRows` 按 sessionId 去重，点当前会话只是重新聚焦，无竞态）。
  - **Recently used 缺目录**：`loadSession`/`resumeSession` 末尾原本 `touch`（只 bump 时间戳、不建条目），跨目录重开的会话在本地历史缓存里没有条目，进不了 `recentDirectories`。改为 `upsertNew(agentName, cwd, sessionId)`；并让 `upsertNew` 命中已有条目时同步更新 `cwd`。
- **验证方式**：`npm test` **102 passing**（新增 2 条 + 重写 1 条：`session_info_update` 落地标题、`upsertNew` 记录/更新目录、live 会话进历史）。`check-registry` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-096
- **功能**：聊天面板输入区四项优化——按钮栏下移 + Send 图标化 + 置底栏、Jump to latest 居中、置底栏上下文用量、输入框图片
- **改动文件**：`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/composer.ts`、`src/ui/chat/html/client/boot.ts`、`src/test/chat-panel.test.ts`、`src/test/chat-client.test.ts`
- **来源**：用户截图反馈 + 对标 Claude Code 官方插件
- **详细说明**：
  - **布局**：`#configPickers`（mode/model/thought）从输入框上方移到下方，`Send` 由文字按钮改成图标按钮（send/stop 两个 12×12 线稿 SVG，语义保留在 title/aria-label），二者与新增 `#contextMeter` 合并成一条 `.composer-bar`（pickers 靠左 `margin-right:auto`、Send 靠右）。
  - **Jump to latest 居中**：`.jump-latest` 由 `right:14px` 改为 `left:50% + translateX(-50%)`。
  - **上下文用量**：复用既有 `meta.usage {used,size}`（宿主已从 `usage_update`/`PromptResponse.usage` 填充，**无需协议扩展**），在置底栏渲染细进度条 + 百分比，配色沿用 header 的 `.usage-fill/.warn/.hot`；header 的 `#usageBar` 保留不动。
  - **输入框图片**：新增会话作用域消息 `attachImage {id,name,mimeType,dataUrl}`（verifySession 守卫之后，同 attachPath）。剪贴板里的无路径位图在客户端 `FileReader` 读成 data URL（有路径的文件粘贴仍走 attachPath），宿主把 base64 剥离前缀后存进 `imageData`（**只留宿主内存、不进 meta**，避免每次 boot/focus 重发整张图），附件列表只发轻量 chip（`kind:'image'`+`mimeType`，path=合成 id）。发送时 image 附件拼 ACP `image` ContentBlock、file 附件仍拼 `resource_link`；空文字+图片附件允许发送，图片以 content 条目进记录区（复用既有 image 渲染）；`detachFile` 与 session 关闭同步清 `imageData`。
- **验证方式**：`npm test` **100 passing**（新增 6 条：宿主 attachImage 广播不带字节、send 转 image/resource_link、image-only 记录 content 条目；客户端上下文计量显隐、空文字仅在有附件时发送、图片 chip 缩略图/回退图标）。`check-registry` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-28 - CUSTOM-20260928-095
- **功能**：磁盘补充按过滤目录扫描（094 只扫 `workspaceFolders[0]`，多根/跨目录场景扫错目录）+ 日志落盘
- **改动文件**：`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/html/client/boot.ts`、`src/utils/Logger.ts`、`src/test/chat-panel.test.ts`、`src/test/chat-client.test.ts`
- **来源**：用户第三次追问「ACP Client 里看到的 session 记录跟官方插件还是不一样，少了」，用落盘日志定位到根因
- **根因**：094 的磁盘补充写死「只扫 `workspaceFolders[0]`」。用户的 VS Code 是多根/跨目录场景——`workspaceFolders[0]` = ai-vibe-creator，而用户过滤查看的是 custom-vscode-acp。于是磁盘补充扫的是 ai-vibe-creator 的转录目录（日志 `48 rows from ...ai-vibe-creator`），custom-vscode-acp 的 disk-only 会话（`1afe26db`、`9ac8da1f`）永远补不上。
- **详细说明**：
  - **修法（增量而非全量替换）**：新增 `supplementHistory`（webview→ext）/ `historySupplement`（ext→webview）消息。客户端过滤到具体目录时按需发 `supplementHistory { cwd }`，宿主 `readDiskHistory(agent, cwd?)` 按该目录扫描并增量返回，客户端按 sessionId 合并。**刻意不用 `listHistory { cwd }` 复用**：那会触发 `setHistory` 全量替换，把 `filterKey` 重置回 current 目录（= 聚焦会话所在目录），冲掉用户刚选的过滤。
  - 客户端 `supplementedDirs` 记录已请求的目录（每次开抽屉清空），过滤来回切换不重复扫描。
  - **补进来的行标题与排序**（用户 F5 复验后第二次反馈「还是少 3 条」）：真因不是没补上，而是两处观感——①`diskSessions` 原本只取首句 prompt，disk-only 会话显示成"History 面板里条目显示的名称是怎么读取的…"而非官方插件的摘要标题；转录文件里其实有 `ai-title` 记录（约第 18 行），正是官方标题，改为**优先取 `ai-title`、首句仅回退**；②`applySupplement` 合并后**没重排序**，补进来的行堆到列表末尾、脱离时间排序，让"最新的一条排最末"像是丢了。合并后按 `updatedAt` 倒序重排。
  - **日志落盘**：`Logger.log()` 除写输出通道外，异步 `appendFile` 到 `~/.claude/acp-client-custom.log`（失败静默；首次使用时超 5MB 截断），让 AI 排查时能直接读文件而不必用户手动贴。
- **验证方式**：`npm test` **94 passing**（新增 3 条：宿主 `supplementHistory` 按过滤目录扫、只回选中目录的磁盘会话；`ai-title` 摘要优先于首句；客户端 `applySupplement` 按 sessionId 合并且不覆盖、最新行重排到顶部）。`check-registry` / `lint` / `compile` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-094
- **功能**：历史列表补上**第三个来源**——agent 自己的转录目录（Claude Code），列表终于与官方插件一致
- **改动文件**：**新增** `src/ui/chat/diskSessions.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户第二次追问「ACP Client 里查看到的 session 记录还是少了，你能自己测试下吗」
- **先测后改（这次的关键）**：把探针升级成**磁盘 ↔ agent 双向对账**，一次跑出确凿数字：
  ```
  transcript dir : C:\Users\zouwei\.claude\projects\D--Git-zgithub-custom-vscode-acp
  on disk        : 8 sessions
  agent reported : 6 of them
  *** disk-only  : 2   （1afe26db「History 面板里条目显示的名称…」、9ac8da1f＝当时正在运行的那个会话）
  agent-only     : 0   （我们这边一条都没多、没少）
  ```
  ⇒ **少掉的两条从头到尾不在 agent 的 `session/list` 里**；我们的过滤（目录 key、活跃会话）什么都没丢
  （`agent-only = 0` 是这一点的直接证据）。
- **详细说明**：
  - 新增 `diskSessions.ts`：按 Claude Code 的存储约定读
    `<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/<slug>/<sessionId>.jsonl`（slug = 路径里所有非字母数字换成 `-`），
    取 sessionId（文件名）、cwd、首个可见用户提示（当标题）、文件 mtime（当活动时间）；
    当前会话还没写 cwd/标题时用**bucket 本身的含义**兜底（那个目录就是它的 cwd）。
  - **三条硬约束**：只对 `Claude Code`（新常量 `CLAUDE_CODE_AGENT`，与 `MODERN_AGENTS` **分开**——
    一个是"用哪个面板"、一个是"愿意读谁的私有存储"，同一天同名但语义不同，不互相继承变更）；
    只扫**当前工作目录**那一个 slug（与本地缓存同作用域）；**任何失败都只是"没有补充"**，
    绝不影响 agent 的那份列表（这正是"官方插件看得见、我们看不见"的那一块）。
  - **按行流式读、超长行跳过**：转录文件能到几十 MB，而且**第一行本身就可能很大**——
    探针的第一版按字符切前 200KB，于是对 `9ac8da1f` 读出了空 cwd/标题；改成流式逐行后立刻正确。
    （这条错误本身写进了文件注释与 `chat-panel.md` §5.2。）
  - 合并：`agent > 转录目录 > 本地缓存`（靠前者逐字段胜出），只有后面来源知道的行带
    `fromDisk` / `fromCache`，tooltip 如实写明来源；`source: 'merged'` 的计数行措辞改为
    **"from the agent + local sources"**（本地来源现在有两个）。
  - **有代价的诚实标记**：从转录目录补出来的行可能**仍在别的窗口开着**，打开它（`session/load`）
    会与另一个写入方共用同一个转录文件（官方插件同样允许，但这是真的取舍）——所以标记必须保留，
    不能让它"看起来和别的行一样"。
- **验证方式**：`npm test` **91 passing**（新增 3 条：①逐行读且 300KB 的超长首行不影响——
  正是第一版探针栽的地方；②目录不存在 = "没有补充"而不是报错；③端到端：把 `CLAUDE_CONFIG_DIR`
  指向临时根、造一个只有转录知道的会话 ⇒ 它出现在回复里、`fromDisk === true`、cwd/标题都对、
  `source === 'merged'`）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
  **待用户 F5 复验**：历史列表里应能看到那两条（含 tooltip 的 "read from the transcript folder — the agent
  did not list it"）；`dev-workflow.md` 的 154-157。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-091
- **功能**：新增探针 `probe-session-list.mjs`——一条命令分清"历史列表少了会话"是 **agent 没报** 还是 **我们过滤掉了**
- **改动文件**：**新增** `CUSTOMIZATIONS/scripts/probe-session-list.mjs`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「ACP Client 里看到的 session 记录比 Claude Code 官方插件少了两条」
- **详细说明**：本扩展的历史选择器**完全依赖 agent 的 `session/list`**（未连接时退回本地缓存），
  所以"少了会话"只有两种可能，而修法完全不同——猜是没用的。探针只做 `initialize` + `session/list`
  （**只读**，不建会话，比 `probe-session-cwd.mjs` 便宜），打印：总数、`nextCursor`、以及 cwd 命中所查项目的那些行，
  外加**完全没有 cwd 的行**（过滤无法安置它们）。用法与代价写在文件头。
- **094 起它还会做"磁盘 ↔ agent 双向对账"**（读 Claude Code 的转录目录，列出 disk-only / agent-only），
  这正是 094 定性的依据：`on disk 8 / agent reported 6 / disk-only 2 / agent-only 0`。
- **实测结论（2026-09-27）**：agent 报 **227 条**、**没有一条缺 cwd**，其中 cwd 指向本项目的是 **6 条**，
  而磁盘上该项目有 **8 个会话文件** ⇒ 少掉的那两条（`9ac8da1f…`＝当时正在运行的那个会话、
  `1afe26db…`＝当天早些时候的一条）**从头到尾不在 agent 的回复里**。最可能的原因是
  **仍在其他窗口开着的会话不进历史列表**；**不是**本扩展的目录过滤或"活跃会话"过滤造成的
  （由此也修掉了两个真实缺陷，见 092/093）。
- **验证方式**：`node CUSTOMIZATIONS/scripts/probe-session-list.mjs` 输出如上；
  `check-registry` / `tsc` / `lint` / `compile` / `check-webview-client` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-092
- **功能**：历史列表改成 **agent 列表 ∪ 本地缓存**（不再"连上 agent 就只用 agent 的"）
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：091 的实测结论（agent 的 `session/list` **不是全集**）
- **详细说明**：
  - 合并规则：按 `sessionId` 取并集，**agent 的行优先**（它才是"这个会话还在不在"的权威），
    只有缓存知道的行标 `fromCache: true`；按 `updatedAt` 倒序（列表的意义就是"我刚在哪儿"）。
  - `source` 增加 `'merged'`，计数行如实写成 **"from the agent + local cache"**；
    缓存独有的行在 **tooltip** 里加一句 `(not listed by the agent — from the local cache)`——
    这类行可能已被 agent 侧删除，不假装它权威，也不给每行加视觉噪声。
  - 为什么能补回来：**我们自己打开过的会话一定在本地缓存里**（`workspaceState`，按 agent+cwd 分桶），
    即使 agent 的列表漏报。091 实测那两条不是我们开的，所以补不回来——这一点如实写在 §5.24。
- **验证方式**：`npm test` **88 passing**（新增 1 条：agent 知 2 条、缓存知 2 条、其中 1 条共有 ⇒
  并集 3 条、共有的取 agent 的标题且不带 `fromCache`、缓存独有的带 `fromCache`、按时间倒序、
  `source === 'merged'`）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-093
- **功能**：没有目录的行不再被静默藏起来（自己的候选桶 + 计数行说明）
- **改动文件**：`src/ui/chat/html/client/sessionMenu.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：091/092 复查目录过滤时发现（本次实测没触发，但路径存在）
- **详细说明**：目录过滤下，`dirKey` 为空的行（agent 没报 cwd）**不属于任何候选**，
  于是被静默丢弃——但"不知道它在哪个目录"不等于"它在别的目录"，那是**把猜测当规则**。
  现在：① 菜单末尾多一个 `Unknown folder (N)` 候选（哨兵 key `~unknown`，真实目录 key 必含分隔符，
  不可能撞车），选中即筛出这些行；② 用真实目录过滤时，计数行补一句 `· N without a folder`；
  ③ 该桶的 chip tooltip 只说条数（它没有路径可显示）。
- **验证方式**：`npm test` **88 passing**（新增 2 条：未知桶存在且带条数、选中后恰好筛出那些行且 chip 改名；
  用真实目录过滤时计数行同时含 `2 of 4 sessions` / `1 without a folder` / `from the agent + local cache`）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-084
- **功能**：工具卡的输出不再永久停在第一段（markdown 往返的 key 标识**文本**而非槽位）
- **改动文件**：`src/ui/chat/html/client/toolCallView.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：面板全面审计（渲染/性能线）——**正确性问题，用户可见**
- **根因**：往返 key 是 `entryId#itemIndex`，一个**位置**。而工具输出文本会**增长**：agent 先流一段、再把最终文本发到同一个 item 上（抓包夹具里 27 条 `tool_call_update` 有 18 条带 content，其中一个 toolCallId 的输出从 35 字长到 268 字）。位置 key ⇒ 第一次那段文本渲染出的 HTML 被**永远**套用；在首次回程到达前那块还是**空白**（`mdPending` 只记第一次的文本）。
- **详细说明**：key 里折进文本的指纹（复用已有的 `fingerprintText`，FNV-1a + 长度）。宿主把 key 当**不透明串**原样回传，于是"每个应答都绑定到它渲染的那段文本"——迟到的旧片段的应答不会再被当成当前文本。指纹算不出来（>256KB）时**不缓存、按纯文本渲染**：宁可退化，也不用一个算不出的 key 去信任。
- **验证方式**：`npm test` 85 passing（新增 3 条：文本变化会重新请求且 key 随之变化 / 可见卡片最终显示的是**它当前那段文本**的 HTML（旧片段的应答不会覆盖）/ 文本未变时仍然命中缓存）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-085
- **功能**：草稿页的输入文本按 **draftId** 保存（不再丢失 / 串台）
- **改动文件**：`src/ui/chat/html/client/composer.ts`、`src/ui/chat/html/client/boot.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：面板全面审计（两组审计**独立**发现）
- **根因**：textarea 的存放表只按 **sessionId** 为键，而草稿**没有 sessionId** ⇒ `stashDraft()` 在草稿态下**什么都不做**。后果两条：离开草稿时输入被丢弃；进入另一个草稿时会看到上一个草稿的文字（也没有任何地方恢复它）。第二个更糟——它可能被当成新会话的**首条消息**发出去。
- **详细说明**：新增 `ownerKey()`（草稿 → draftId，会话 → sessionId），`setDraft` **先存后取**；`setFocus` 里的 `stashDraft()` 必须移到 `state.draft = null` **之前**（先清空会让 ownerKey 变 null——这条是测试抓出来的）；丢弃草稿时 `boot.dropDraft` 调 `composer.forgetDraft(draftId)` 清理。
- **验证方式**：`npm test` 85 passing（新增 2 条：草稿文本在离开后能还原 / 两个草稿不共享文本）。**过程记录**：第二条一次通过、第一条先红——正是"清空顺序"那一步没做对，测试把实现里的第二个疏漏也逼出来了。`check-registry` / `tsc` / `lint` / `compile` / `check-webview-client` 全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260927-086..090
- **功能**：面板审计 P0 的其余五项（路由 / 树命令 / 关会话 / 标签 / 空态）
- **改动文件**：`src/ui/chat/panelContract.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/extension.ts`、`src/core/SessionManager.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/{tabs,boot,sessionMenu}.ts`、`src/test/{chat-panel,chat-client}.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：面板全面审计（会话生命周期线 + 交互/无障碍线）
- **详细说明**：
  - **086 路由**：`panelIdForFocus()` 里 `isModernAgent(null) === false` ⇒ **无聚焦会话时路由到 legacy**，而 legacy 在 attach 时**替换侧边栏文档** ⇒ 草稿页与已输入文字被销毁，并且现代的 "No session yet / Connect" 空态**几乎永远见不到**（它就是为无会话面板做的）。新增纯函数 `panelIdForAgent`：**null/空 ⇒ modern**，只有"已知的非 modern agent"才 legacy。
  - **087 树命令**：`acpc.openSession` 在"该会话已是活跃会话"时静默 `return` —— 080 的**第三个调用点**（我上次只修了消息路径）。改为 `focusSession(id, { force: true })` 再 reveal。
  - **088 关会话**：`removeSession` 直接 `inFlightTurns.delete`，agent 继续跑一个没人会看的轮次；按 `cancelTurn` 里已经遵守的 ACP 契约，待决的 `session/request_permission` 必须被回答成 `cancelled`，否则 agent 永久挂起（pitfalls #14）。`closeSession` 现在**先**取消在途轮次（失败只记日志，不影响关闭）。
  - **089 标签**：`×` 嵌在标签 `<button>` 内部且默认可 Tab ⇒ 每个会话多一个 tab stop，roving tabindex 失效，途中误按 Enter 会关掉会话。改为 `close.tabIndex = -1`（Delete/Backspace 本来就能关）。
  - **090 空态**：已连接 agent 但没会话时仍说 "Connect an agent"——而关掉最后一个会话**不会**停掉进程。宿主新增 `panelAgentConnected()`，随 `boot`/`focus`/`sessionsChanged` 下发（**并计入 `sessionsChanged` 的签名**，否则连接状态变化永远不会刷新——022 为 `unread` 记过同一个陷阱）；客户端按它切换两套静态文案（提示里有 `<kbd>`，所以用两段 + `hidden` 而不是改 textContent），按钮文案在"Connect Claude Code"/"New session"之间切换；同时**无会话且无草稿时隐藏头部的 `#cwdBtn`**（空按钮仍能打开抽屉，而抽屉会解释"这个会话的目录已固定"——对一个根本没有会话的面板说谎）。
- **验证方式**：`npm test` 85 passing（新增 6 条：null 路由到 modern / 关会话先取消在途轮次 / 空闲会话不产生多余取消 / 三条消息都带连接标志 / `×` 不在 tab 序里且恰好一个标签可 Tab / `#cwdBtn` 随会话与草稿显隐）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
- **待用户 F5 复验**：关掉最后一个会话后面板应停在**现代空态**（不再跳到上游界面、草稿与文字还在）；已连接时的空态文案与按钮；头部目录按钮在无会话时消失。见 `dev-workflow.md` 的 148-151。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260926-083
- **功能**：修「未连接时点历史会话只会报 "does not support loading or resuming sessions"」
- **改动文件**：`src/core/SessionManager.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户截图提问：「还没 "Connect Claude Code"，但点 "Previous session" 能看到 session 记录（实际点击会弹图2）是什么问题？」
- **两个现象，两种性质**（第一个是设计，第二个是 bug）：
  1. **未连接也能看到列表**：**设计如此**。历史选择器在 agent 未连接时不 spawn 进程，
     改读本地缓存（`workspaceState` 的 `SessionHistoryStore`），并且计数行如实写着
     **"from the local cache"**（连上后同一位置写 "from the agent"）。离线可读本身就是这个入口的价值。
  2. **点开却报"不支持"**：**真 bug**。`session/load` / `resume` 的能力来自 ACP 的 `initialize` 握手，
     而 `openExistingSession` 读的是 `getCachedCapabilities()` —— **从没连接过 ⇒ 缓存是空的 ⇒
     被当成"这个 agent 不支持"**。于是列表里每一条都点得动、每一条都失败，
     而错误信息把责任推给了 agent（Claude Code 明明支持 `session/load`）。
- **详细说明**：
  - 读能力**之前**先 `await this.ensureConnected(agentName, opts.cwd)`：
    `ensureConnected` 是幂等的（并发调用会合并）、公开的、且正是树视图"未连接时探测能力"用的那个原语；
    `opts.cwd` 顺带作为**进程启动的偏好**——打开一条属于别的目录的会话时，进程正好落在它自己的目录里。
  - **修在 `openExistingSession` 而不是两个调用方**：它是文档里写明的「打开一个已存在会话」的**唯一决策点**，
    面板的历史选择器与树的 `acpc.openSession` 命令都走它（否则就是修一处、另一处继续报同样的错）。
  - **守卫没有被放宽**：连上之后能力仍然要真的支持，才走 load/resume；
    真不支持的 agent 得到的还是那条错误，只是现在**报得准**（用例钉住了这一点）。
  - 已知的体验缺口（本轮不做）：连接过程本身没有 loading 反馈——它是"点一下 → 等进程起来 + 重放"。
    真要补的话应该给客户端一条"正在连接/正在加载"的状态，而不是在记录区打印噪声。已登记在 §5.14。
- **验证方式**：`npm test` **74 passing**（新增 2 条）。**做过 RED 验证**：临时去掉那行 `ensureConnected`，
  两条都失败（第一条因为压根没有 load；第二条因为 `ensureConnected` 从未被调用），恢复后通过。
  `tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
  **待用户 F5 复验**：不先连接，直接点历史会话 → 进程被拉起、会话被重放打开（不再报错）；
  连接期间界面暂时没有 loading 提示属于已知缺口。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260926-082
- **功能**：修「空态（"No session yet"）不居中，贴在面板右边」
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户在上一条（081）修复后的截图上继续反馈：「没有居中对齐」
- **根因**：`#emptyState` 是 `#messages` 的**兄弟**，而 `.message-area` 是 flex **行**、
  `#messages` 是 `flex: 1`——自由空间被它吃光，空态的 `margin: auto` **没有可分配的余量**可分，
  于是被顶到行的最右端（纵向倒是靠 auto margin 居中，所以看起来只是"偏右"）。
  面板越宽越明显：窄侧边栏里它离正中不远，所以这条从 032 起一直没被发现；
  081 把钉住的大纲栏收掉之后，整块左半边空了出来，偏右就一眼可见了。
- **详细说明**：`.empty-state` 改成**覆盖在消息区之上并自我居中**：
  `position: absolute; inset 四边为 0` + flex 居中（`.message-area` 本来就是 `position: relative`，
  `.jump-latest` 早就这么用）。不占布局、也没有重叠风险——**空态出现 ⟺ 没有聚焦会话 ⟺ 没有锚点 ⟺
  081 已经把大纲栏与引导条收掉了**，这条不变式写进了 CSS 注释。
  行为不变：显示/隐藏仍是 `showEmpty()` 写 inline `display`（清空即回落到样式表里的 `flex`），
  与 `[hidden]{display:none!important}` 那条道路无关（pitfall #13 的正面用法）。
- **验证方式**：纯 CSS（绝对定位 + flex 居中）⇒ 属于**布局**，按 `dev-workflow.md` 的分区表无法自动断言，
  只能 F5 复验（清单 145）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿；
  `npm test` 72 passing（无新增：这一条没有可测的逻辑）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260926-081
- **功能**：修「首次打开面板时钉住的大纲栏占着一列，空态被挤出正中」
- **改动文件**：`src/ui/chat/html/client/outline.ts`、`src/ui/chat/html/client/boot.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户截图反馈：「首次打开 Chat Panel 时显示的是图1的界面（里面有 3 块内容，但实际应该居中显示 "No session yet"？）」
- **根因**：**一条判据只加在了一个消费方身上。** 045 定下「没有锚点就没有大纲」，
  但它只写在了 ☰ 按钮上（当时下拉是唯一形态，"没有按钮就等于没有大纲"，所以看不出问题）；
  076 让大纲可以**钉成常驻右栏**之后，那一栏**没走这条判据**——`renderVisibility()` 只看 `isOpen && mode === 'sidebar'`，
  而钉住模式下 `isOpen` 恒为 true ⇒ 空对话、甚至**一个会话都没有**时，右侧照样摊着一列
  "OUTLINE / No messages yet"，空态被挤到右半边。
- **详细说明**：
  - 判据收到一处：`outline.ts` 新增 `anchorsPresent`（由 `syncButton()` **唯一写入**、`renderVisibility()` 读取），
    ☰ 按钮 / 下拉 / 钉住侧栏**三者共用**。`mode` 只是偏好，不决定可不可见。
  - `syncButton()` 现在除了按钮还会调 `renderVisibility()` —— 否则"锚点数变化"只会更新按钮，
    钉住的那一栏要等到下次 show/hide/pin 才刷新。
  - **boot 的空会话分支补上 `outline.close() + invalidate()`**：那条 early return 以前跳过这两个调用，
    于是从"有会话"切到"无会话"时，`anchorsPresent` 留着旧值（true），钉住栏会**带着过期列表留在原地**。
  - 保留的行为（有意）：钉住的**偏好**不动，第一条消息到达时那栏自己回来（宽度也还在）；
    副作用是空对话时点不到 ✕ 取消钉住——此时它本来也没有内容可导航，写进了 §5.9。
- **验证方式**：`npm test` **72 passing**（新增 1 条：钉住模式下零锚点时侧栏与 ☰ 都不显示、
  追加第一条消息并 `invalidate()` 后侧栏回来）。**这条用例做过 RED 验证**：临时回退 `renderVisibility()`
  的判据后正是它失败，恢复后通过。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
  **待用户 F5 复验**：清掉/重置偏好后重新钉住，然后开一个**没有会话**的面板 —— 应当只剩居中的
  "No session yet"（没有右侧栏）；发第一条消息后右侧栏出现。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-27 - CUSTOM-20260926-080
- **功能**：修「从草稿页切回会话标签点了没反应」
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户截图反馈：「从"现在'创新工厂'…"会话切到 "New Session" 后，再点前者那个会话 tab 就切不回去了（点了没反应，界面还停在 New Session）」
- **根因**：**"没变化就不回话"的幂等请求，遇到"客户端的聚焦状态与宿主不同步"就永远等不到答案。**
  客户端点会话标签只发一条 `focusSession`（`tabs.ts`），渲染完全依赖宿主的 `focus` 应答；
  而宿主的 `case 'focusSession'` 调 `SessionManager.focusSession(sessionId)`，
  后者**在"已经是这个会话"时直接 early-return**（它只在**变化**时 emit）。
  于是：宿主聚焦的仍是会话 A → 客户端点出一个**客户端私有的草稿页**（058，宿主根本不知道草稿存在）
  → 用户再点 A 的标签 → `focusSession(A)` → 宿主认为"我这边已经是 A 了" → 不 emit → 不回 `focus`
  → 面板一直停在草稿页。**A 的标签看起来"坏了"，其实请求发出去了、也通过了校验，只是没人回话。**
- **详细说明**：
  - 修法一行，用 `SessionManager` 自己已有的惯用法：
    `this.sessionManager.focusSession(sessionId, { force: true })`。`force` 的语义就是
    "这是用户可见的聚焦动作，即使没变化也要重新广播"，manager 内部在
    `newConversation` / `loadSession` / `resume` / `openExistingSession` 里已经这么用了 5 处
    —— **这次是把同一条规矩补到"客户端显式请求"这个入口上**。
  - **为什么修宿主而不是修客户端**：`focusSession` 在客户端有两个调用点
    （点标签 `tabs.ts`、丢弃最后一个草稿后接管 `focusFirstSession`），两边都有同一个洞；
    而且**客户端没有别的办法自己渲染出那条会话**——transcript 按会话存在宿主侧，
    没有 `focus` 应答就只有 DOM 里的草稿页。宿主回话才是根，客户端各自打补丁是两份知识（pitfalls #19）。
  - `force` 的附带效果（`active-session-changed` 重新广播）全是幂等的刷新：
    未读点清除 + 标签栏刷新 + 树/状态栏/路由各刷一次。相对于"用户明确要求聚焦"，这正是应有的语义。
  - 守卫没有被放宽：请求仍然先过 `verifySession`，**未知会话照旧静默丢弃**
    （否则会为一条已不存在的会话推一份快照），这条也有用例钉住。
- **验证方式**：`npm test` **71 passing**（新增 2 条：①宿主已聚焦该会话时，显式请求**必须**有 `focus` 应答
  且 `summary.sessionId` 正确 —— 修前为 RED，正是用户报的现象；②未知会话的请求仍然被丢弃，
  保证修复没有把守卫一起改掉）。`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿。
  **待用户 F5 复验**：会话 A → 点 `+` 开草稿 → 点回 A 的标签，应当立刻切回 A
  （并且 A 的未读蓝点被消费掉）；连续来回切多次都正常。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-079
- **功能**：历史会话列表（「Open previous session」）加**按工作目录过滤**的 chip，默认落在当前会话的工作目录上
- **改动文件**：**新增** `src/ui/chat/historyDirs.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈：「Open Previous session 的弹出列表加个目录过滤选项（显示在 "232 sessions · from the agent" 同行，靠右对齐），开启后默认使用当前会话的工作目录，支持下拉选择，具体交互你可再设计下」
- **详细说明**：
  - **交互形态（用户确认）**：header 右侧**一个 chip 兼管开关与选择**——`📁 All folders ▾` / `📁 <目录名> ▾`，
    点开菜单，首项 `All folders` 就是关闭过滤。"开启"与"选一个目录"是同一个动作，所以不需要
    "先勾选再选目录"两步。chip 只在候选 ≥ 2 个目录时出现，但**过滤生效时永远显示**（否则关不掉）。
  - **候选只来自列表里真实出现过的目录**（用户确认），带条数、当前会话目录置顶、**0 条的当前目录也在**。
    理由：过滤一个列表里没有会话的目录只会得到空列表，所以「浏览…」在这个场景是死路；而"默认目录不在菜单里"
    会像一个坏掉的控件。排序：当前 → 条数降序 → 名称。
  - **记忆策略（用户确认）**：开关持久化（`vscode.setState`，与 `Times`/`Sub-agents` 同一套）；
    **目录每次打开都回到当前会话的工作目录**——记住目录会在切到别的项目后继续过滤一个已无关的文件夹。
    没有"当前目录"（草稿、或 agent 没报 cwd）时表现为未过滤。
  - **过滤是纯客户端的 key 比较**：列表本来就在客户端，换目录不该再问一次 agent（那会是一次
    `session/list` 往返）。**key 由宿主算好**，因为目录同一性依赖平台。
  - **新增纯函数 `historyDirs.ts`**（`directoryKey` / `directoryOptions` / `folderName`）：
    `directoryKey` 用**字符串操作而不是 `path.normalize`** —— 后者在不同平台上行为不同，
    会让行为与测试都变成环境相关的；平台只从**大小写规则**进入（win32/darwin 折叠、linux 不折叠），
    尾分隔符去掉（`D:\x\` 与 `D:\x` 是一个目录），`C:\` / `C:` / `C:/` 折叠成同一个 `c:`。
    `ChatPanelHost` 里那份私有的 `basename` 一并换成 `folderName`（同一个"最后一段"的三份拷贝
    是漂移的来源，pitfalls #19）。
  - **宿主侧**：`handleListHistory` 的三条回复路径（agent 列表 / 本地缓存 / 出错回退缓存）合并成
    一个 `postHistory` —— 三处各自拼装正是"其中一处漏了 `dirKey`"的写法，而漏掉的表现是
    **那些行在过滤后凭空消失**。每条会话补 `dirKey`；回复里加 `directories`（候选，其中
    `current: true` 的那条就是默认目录，所以不需要另开字段）。默认目录取**聚焦会话属于自己的 agent 时**
    它自己的 cwd，否则第一个工作区文件夹（picker 是按 agent 查的，聚焦会话可能属于另一个 agent）。
  - **协议只有追加**：`HistorySessionSummary.dirKey?` + `history` 消息的 `directories?`，都可选。
  - **CSS 复用**：chip 与菜单直接用 composer 那套 `.picker-btn` / `.picker-menu` / `.picker-item`
    （同一个"选一个值"的控件观感），只补一个向下弹的变体 `.picker-menu.down`（composer 的菜单是向上弹的）、
    右对齐、行内条数。菜单**挂在 header 内部**：header 是 `position: sticky`（已是定位元素），
    `top: 100%` 正好落在它下面——不量高度、没有常量偏移（pitfalls #24）。
  - **菜单用 `.open` 类而不是 `hidden` 属性**：`.picker-menu` 自己带 `display: none`，
    与 `.open` 的 `display` 是同一层级的竞争——这是 pitfall #13 的反面（那次是 `hidden` 被作者样式覆盖），
    用错了表现是"菜单永远不出现"，而且看起来像 JS 没跑。
  - **Esc 分层**：菜单开着时 Esc 只收菜单，再按一次才收抽屉——否则一次 Esc 会把整份列表连同用户的
    浏览位置一起丢掉。
  - **选中目录后菜单不关闭**（用户 F5 复验时的第一条修改）：换目录通常是**连着比几个**，
    关掉就变成"重开 → 选 → 重开 → 选"。选中后菜单原地刷新（计数行、列表、以及菜单里那一项的激活标记），
    并把焦点还给新激活的那一行（重建会销毁刚点的按钮，焦点掉回文档后下一次 Tab 会从面板顶部重新开始）。
  - **选中目录不再关掉整个列表**（用户复验的第二条，我第一版只修了"菜单不关"，没修到这条）：
    选中会重建菜单行，把正在冒泡的那个按钮摘下来，而"点击别处就关闭"的监听器问的是
    `drawer.contains(event.target)` —— `contains` 对**游离节点恒为 false** ⇒ 这次点击被判成点了外面。
    改为问**派发时冻结的路径** `event.composedPath()`（老环境退回 `contains`）。完整教训见 pitfalls #28。
    这一条用**桩 DOM 的事件派发**钉住了（`chat-client.test.ts` 新增 4 条，含一条反向用例
    "点真外面仍然关闭"——它保证桩的忠实度，也保证修改没把功能一起改没）。
  - **同名目录不再分不清**（用户截图里 "UniverseEditor" 出现两次，同一仓库的两份检出）：
    候选新增 `label` —— 两个目录同名时标签**向左长**（`git/UniverseEditor` vs `zdev/UniverseEditor`），
    唯一的名字保持原样。两行一模一样的标签是没法选的。
    **点击抽屉里的别处**才收起它。
  - **键盘**：chip 与菜单行都是真 `<button>`（047 的规矩，Tab 可达）；不自己实现方向键，与 composer 的
    picker 保持一致。空结果时列表里给一行「No sessions in this folder」+ 一行可点的「Show all folders」，
    用户不会被卡在空列表里。
- **验证方式**：`check-webview-client`（15 个客户端模块拼接后可解析）/ `tsc` / `lint` / `compile` /
  `check-registry` 全绿；`npm test` **64 passing**（新增 6 条：目录同一性的大小写/根目录/空值规则、
  候选去重与排序、当前目录 0 条也在、宿主回复形状（每行 `dirKey`、候选条数与 `current`）、
  已是标签页的会话不出现在历史里）。夹具**只用尾斜杠差异、不用大小写差异**，所以同一条断言在每个平台上
  说的是同一件事。**待用户 F5 复验**：chip 与菜单的位置/激活态、切换目录后计数行变成「N of M sessions」、
  重开抽屉时开关保留而目录回到当前会话、Esc 分层、空结果那两行——见 `dev-workflow.md` 的 134-140。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-078
- **功能**：历史会话列表的标题兜底——agent 侧 `session/list` 缺 title 时回退本地缓存的 title/firstPrompt，与 tab 标题兜底链对齐
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈 History 面板条目名与打开会话后的 tab 标题不一致（tab 标题准确）
- **详细说明**：
  - **现象**：History 面板（↺ 抽屉）里条目显示成 sessionId 前 8 位十六进制，而打开后 tab 标题是准确的会话标题。根因是两条链路读不同字段：tab 标题用 `session.title`（`session_info_update` 推送、实时更新，`toSummary` 的 `session.title ?? stored?.firstPrompt`），History 面板在已连接且 agent 支持 `session/list`（Claude Code 正是如此）时走 agent 侧路径，只认 `session/list` 返回的 `title`，缺了直接填 `null`，客户端 `sessionMenu.labelOf` 就退化成 sessionId 前缀。
  - **修法**：`handleListHistory` 的 agent 侧映射里，`title` 为空的条目回退到本地历史缓存的 `title`/`firstPrompt`（`getHistoryStore()?.get(agent, sessionId)`），与 tab 标题兜底链对齐。本地缓存来源（未连接/不支持 list）本就带 `e.title ?? e.firstPrompt`，无需改。
  - **刻意不改**：tab 那套「自动标题优先、firstPrompt 兜底」的优先级保持不变——首条消息虽是记忆锚点，但含糊首句/粘贴日志时 agent 自动标题更可读（与用户讨论后确认）。
- **验证方式**：`check-registry` / `lint` / `compile` 全绿。**待用户 F5 复验**：History 面板里此前显示 sessionId 前缀的条目现在显示标题或首条消息。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-077
- **功能**：会话大纲二次优化——图标按类型着色、时间右移并显示秒级、钉住状态宿主级持久化、钉住按钮并入计数行
- **改动文件**：`src/ui/chat/html/client/outline.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/extension.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验 076 的侧栏后提的 4 点反馈
- **详细说明**：
  - **①类型区分度不高**：user/assistant 都是 12px 线稿图标、形状差异在窄侧栏里不明显。改为按 kind 着色——`renderInto` 给图标 span 追加 `outline-kind-<kind>` 后缀类，CSS 里 `.outline-kind-user` 用 `--vscode-button-background`（与 transcript 用户气泡同色蓝）、`.outline-kind-assistant` 用 `--vscode-descriptionForeground`（灰）；SVG 是 `stroke=currentColor`，改 `color` 即变色，零空间成本。
  - **②时间占左侧空间 + 要秒级**：`timeLabel` 从 `HH:MM` 改 `HH:MM:SS`，且 `.outline-time` 从「图标与文本之间」移到每项最右（正文 `.outline-text` 的 `flex:1` 占满左侧、时间紧凑靠右）。
  - **③钉住状态应跨会话还原**：根因是 `outlineMode/outlineWidth` 存在 webview 本地 `vscode.setState`，只活在同一实例 reload，窗口重载 / 编辑器面板关闭重开会丢。改为宿主级持久化：新增非会话作用域消息 `setUiPref`（webview→ext）与 `uiPrefs`（ext→webview，随 boot 定向带回）；`ChatPanelHost` 构造新增可选 `globalState` 形参（extension.ts 传 `context.globalState`，key `acpc.outlinePrefs.v1`），`onMessage` 里在 `verifySession` 守卫**之前**处理 `setUiPref` 并 `globalState.update`；客户端 `outline.init` 不再从本地状态读，改由 boot 后 `applyPrefs(prefs)` 恢复（幂等）。`setUiPref` 在守卫之前处理是 §5.4 规则二（非会话作用域）。
  - **④钉住按钮独占一栏**：把 `#outlinePin` 从独立的 `.outline-bar` 并进 `.outline-head`（"N messages" 同一行），动态计数放进 `.outline-head-info` 子容器（render 只清它、不抹掉钉住按钮），删除 `.outline-bar` 与相关 CSS。
- **验证方式**：`lint` / `check-registry` / `compile` / `compile-tests` 全绿；`npm test` **58 passing**（`chat-client.test.ts` 大纲用例更新为断言 `.outline-kind-user/-assistant` 着色 + 时间两个冒号 + 桩 `.outline-head-info`）。**待用户 F5 复验**：图标蓝/灰分明；时间在右且到秒；钉住后关闭会话再打开（乃至重载窗口）仍还原钉住与宽度；钉住按钮与 "N messages" 同一行。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-076
- **功能**：会话大纲「钉住式右侧栏」——☰ 按钮右移、大纲扩到 user+assistant 并带类型图标 / hover 全文，新增可调宽的常驻右侧栏形态
- **改动文件**：`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/outline.ts`、`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **详细说明**：
  - 用户提出三项：①把 ☰ 从 header 最左移到右侧；②在大纲下拉之外再加一个「固定显示在右侧、宽度可调、只显示 message 类内容（带类型图标、缩略信息、hover 看更多、点击跳转）」的侧栏模式；③先评估必要性/可行性并设计交互，确认后再改。
  - **必要性/可行性**：当前大纲是"点开即收"的下拉，只列 user、无图标、跳转即关，适合临时查一句、不适合边看边导航。改动**纯客户端**（§5.9 已声明不动协议/命令/package.json），复用 `scroll.jumpTo` / `transcriptView.ordered/entry/node` / `icons` / `persistUi` 全齐，唯一从零写的是分隔条拖拽。
  - **形态**：钉住模式（用户确认）——下拉与侧栏并存；下拉头部新增静态「固定到右侧」钉住条（`#outlineBar`，不被 `render()` 清掉），点它把大纲从下拉钉成常驻右栏（`#outlineSidebar`，`#messages` 的 flex 兄弟、定宽）。`mode`（popup/sidebar）与 `width`（180px~50%）走 `NS.boot.persistUi`（vscode.setState）持久化，重载恢复。
  - **内容**：`anchors()` 从「只收 user」扩到「user+assistant」（用户确认），每项 = 类型图标（`NS.icons` 新增 `icon` 导出）+ 时间 + 摘要（80 字截断）+ 原生 title 全文（hover 看更多）；`transcriptView` 新增 `messageAnchorCount()`（user+assistant，O(1) 驱动 ☰ 显隐）。
  - **交互差异**：侧栏是常驻导航——跳转后不关；下拉维持「跳完收起」；点击外部只关下拉、不关侧栏；`close()`（会话切换语义）在侧栏模式下 no-op，避免 boot 的 close 把刚恢复的侧栏关掉。
  - **调宽**：`#outlineResize` pointer 事件拖拽，`width = clamp(start - dx, 180, area*0.5)`（拖左变宽、拖右变窄），`pointerup` 时持久化并 `NS.rail.reflow()`（`#messages` 变窄会改折行 → 左 rail 圆点要重对齐）。
  - **测试**：`chat-client.test.ts` 加载 `outlineClient`（桩 DOM 补 `classList.toggle`），新增 2 条大纲逻辑用例。
- **验证方式**：`check-registry` / `lint` / `compile` 全绿；`chat-client.test.js` 10 passing（新增 2 条：锚点只收 user+assistant 且每项带图标/时间/摘要/jump-id/title、摘要截 80 字带省略号）。**待用户 F5 复验**：☰ 在右；下拉带图标；pin 出侧栏可拖宽；点击跳转不关侧栏；hover 有全文；重载恢复宽度与形态。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-069
- **功能**：记录区底部留白 4px → 24px（滚到底时不再像"还有内容没拉出来"）
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验反馈（图3）：「最后一个对话底部多留一些间隔，现在总会误以为没拉到底部」
- **详细说明**：`.messages` 的 `padding-bottom` 原为 4px，而输入区 `.composer` 紧贴在它下面且带一条上边框——最后一条记录几乎贴着那条线，看起来像被截断。留白本身就是"到头了"的信号，所以这是一行 CSS 的事；没有动 `scroll.follow()`（它的贴底判据用 `scrollHeight`，padding 已经算在内）。
- **验证方式**：`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿，`npm test` 56 passing。**待用户 F5 复验**：滚到底时最后一条与输入框之间有约 24px 留白，"回到最新"按钮位置不变。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-070
- **功能**：左侧引导线的圆点在**任何布局变化**后重新对齐（展开折叠块、展开工具卡、图片加载完）
- **改动文件**：`src/ui/chat/html/client/rail.ts`、`src/ui/chat/html/client/transcriptView.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验反馈（图5）：「如果有内容块触发了 unfold，左侧引导线的圆点没有重对齐」
- **根因**：圆点的 `top` 只在 `rail.measure()` 里算，而它只由三个时机触发——标记集变化（`invalidate`）、window resize、markdown 回填（`reflow`）。`<details>` 展开、工具卡正文展开（`links.toggleBody` 改的是 `hidden` 属性，**没有任何事件**）、图片加载完成都不在其中 ⇒ 条目高度变了而圆点留在旧位置。
- **详细说明**：
  - **不枚举触发事件，而是观察布局本身**：`rail.ts` 内一个 `ResizeObserver` 观察**每条记录节点**，回调 → `reflow()`（只测量不重建）。理由与 pitfalls #24/#25 同源——手写的事件清单会静默落后（这次就是）。**不做 `toggle` 兜底**：它只覆盖 `<details>`，工具卡那条根本没有事件，属于"半个修复且没有信号"。Chromium 的 webview 恒有 ResizeObserver，缺失时经日志桥 `console.warn` 一次。
  - **回调跳过 streaming 的记录**：流式正文每个 chunk 都会让节点变大，全量测量会毁掉本模块的设计前提（"流式期间零布局读取"，见 rail.ts 文件头）。streaming 条目的**首行**不可能移动，圆点本来就是对的。
  - **挂载点**：`transcriptView` 里"把节点放进 `#messages`"与"替换节点"的**全部 6 处**（hydrate / append、append 的壳→卡重建、patch 的 plan / content、updateTool），外加本轮的折叠换子。漏一处 = 那条记录的圆点从此不再动，且完全静默。`reset()` 调 `resetNodes()`（ResizeObserver **强引用**被观察元素，不 disconnect 会随会话切换一直留着废弃节点）。
  - `measure()` 增加守卫：容器高度为 0（后台编辑器组 / 未 reveal 的 webview）直接返回并保留 `needMeasure`，否则所有点被钉到 `top: 0` 且被当成真相。
- **验证方式**：`check-webview-client`（15 个模块拼接后可解析）/ `tsc` / `lint` / `compile` / `check-registry` 全绿，`npm test` 56 passing。**交互无法自动测**（布局类问题的分界线见 `dev-workflow.md`）。**待用户 F5 复验**：展开/收起任意 thought、折叠的用户消息、工具卡、diff 后，左侧圆点立刻与首行重新对齐。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-071
- **功能**：用户消息的折叠判据改为**实测渲染行数**（长句子折行也折叠；一行放得下就不折叠）
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/rail.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验反馈（图4 + 文字）：「多行的对话还是没有显示 fold 按钮」——064 已经把判据扩到"有换行 **或** 长度 > 160"，但用户依然看不到折叠。
- **根因**：阈值与换行一样是**代理信号**（pitfalls #25 的第二次复发）。判据问的是"文本像不像多行"，而用户看的是"屏幕上占了几行"：窄侧边栏里一条 100 字、不含任何换行的消息会折成三行，却因为没到 160 字而不折叠。
- **详细说明**：
  - **换成直接信号**：先把真正会渲染的结构建出来（`<details class="user-fold">` + caret + 图标——它们占横向空间，宽度必须是对的），插入 DOM 后用 `Range.getClientRects()` **只框住文本节点**数行盒（`height > 0` 的矩形个数；行长边界的零高矩形要滤掉），多于一行才保留折叠、只有一行就**退回普通气泡**。
  - **切分点**：在"一行以内"的前缀上二分 → 回退到最近空格 → 不切断代理对；文本里 `\n` 之后还有可见内容时**优先按 `\n` 切**（那是精确答案，测量改善不了）。切在 `\n` 上时**那个换行符被丢弃**：summary 与 body 的块边界本身已经渲染成一次换行，留着会多出一整行空行（064 的实现一直有这个小缺陷）。
  - **量不出来时**（隐藏面板的 0 高矩形 / 无 `createRange` / 超 2000 字）回退旧判据，并给节点打 `data-fold="heuristic"`；等它第一次拿到真实尺寸（正是 070 那个 ResizeObserver 报的事件）**只重判一次**，两个方向都要能改（折→不折、不折→折）。
  - `hydrate()` 里在**整个快照落地之后**统一结算一次（循环内逐条结算会边追加边强制布局）。
- **验证方式**：`npm test` **56 passing**（`chat-client.test.ts` 新增/改写 4 条：只折行无换行的消息折叠、一行放得下的长文本不折叠、回退档 + 重判能把折叠改回去、多行折叠不再重复原文）。桩 DOM 补了一个**确定性 Range 模型**（每 N 字一行、可调），因此被测的是我们的逻辑而不是浏览器的换行算法。**待用户 F5 复验**：窄侧边栏里 100 字以内的无换行消息出现 ▸；展开后原文不重复、不多出换行；宽编辑区面板里同一条若一行放得下则**不**出现 ▸。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-072
- **功能**：思考块按 markdown 渲染；顺带修好 GFM 任务列表的勾选态
- **改动文件**：`src/ui/chat/markdown.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验反馈（图1，放大后可见**字面反引号**与**字面 `- ` 列表符**）：「输出按 markdown 显示还是有些没有支持」
- **根因**：`buildThought` 用 `NS.dom.el('div','thought-body', entry.text)` 写**纯文本**，思考块从未走 markdown 往返（`markPending` 当时只认 `assistant`）。夹具里 `agent_thought_chunk` 有 492 条、比正文的 422 条还多，所以这是最显眼的一处。
- **详细说明**：
  - **复用助手气泡那条往返**（宿主 `SafeMarkdown` → 客户端 `sanitize`），不写第二个更弱的渲染器。
  - `ThoughtEntry` 加 `html`；`TranscriptStore.patch` 的 thought 分支补 `html`（**不加就是静默丢弃**：宿主自己的补丁落不了库，切会话又变回纯文本）；`appendThoughtChunk` 的**合并分支要清 `html`**（助手分支一直有，思考分支没有 ⇒ 之后每个 chunk 都会带上过期前缀的 html）。
  - **流式期间不渲染 markdown**：只从定稿的 revise 排 pending（否则会把某个前缀的 html 冻在还在长的正文上）。`patch` 的 thought 分支与助手共用新的 `trackMarkdown`：html 到了就不再请求；**定稿时若没有 html 就重新排 pending**（finalize 的 revise 不带 html 键，只判断 `changes.html` 会永远不排）——这正是"定稿瞬间 markdown 反被原文覆盖"的两个方向。
  - 加载态（hydrate）也覆盖：`buildThought` 直接按 `entry.html` 决定渲染方式，否则从快照恢复的思考块会永远停在纯文本。
  - `styles.ts`：markdown 规则作用域从 `.bubble` 扩到 `.bubble, .md` 共享（各写一套 = 同一份知识存两份）；`.thought-body.md` 回到 `white-space: normal`（pre-wrap 会把 marked 的换行再加一倍）；正文保持斜体（推理的视觉身份），但 `pre`/`code`/`table` 内重置为非斜体。
  - **任务列表**：`marked` 默认输出 `<input type="checkbox" disabled>`，而客户端白名单没有 INPUT ⇒ 被 unwrap，`- [x] 做完了` 与未完成长得一模一样。改成覆盖渲染器的 `checkbox` 钩子输出字形 span（**不**把表单控件加进白名单；覆盖 `checkbox` 而不是 `listitem`，是为了不重写 marked 自己那套紧/松列表的插入位置）。
- **验证方式**：`npm test` **56 passing**（新增 2 条：流式期间不渲染 + 定稿后 `.thought-body` 变 md；后续 revise 不得把 markdown 换回原文）。**待用户 F5 复验**：思考块里的 ``` 围栏与 `- ` 列表按 markdown 显示（有代码块样式与 Copy 按钮）；流式输出期间仍是纯文本、定稿后变形；`- [x]` 有勾选字形。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-073
- **功能**：切换模型/模式/配置项后，记录区留一条分隔式提示（"Switched to deepseek-v4-pro[1M]"）
- **改动文件**：**新增** `src/ui/chat/sessionChoices.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验反馈（图2 是 Claude 官方插件的同款提示）：「切换大模型后也会有一个内容输出，请加上支持」
- **详细说明**：
  - 三个入口（`setModel` / `setMode` / `setConfigOption`）此前只 `pushMeta()`，transcript 里不留任何痕迹。
  - **纯函数放 `sessionChoices.ts`**（取快照 / 按载荷打补丁 / 算差异 → 人类可读的一句话），宿主只做缓存与发帖。抽出来的理由是可测：真正的分支判断（谁先到、同一次切换被上报两次怎么办、级联变更怎么表述）在编排器里没法单测。
  - **去重靠"缓存由我们独占"**：同一次切换有两条上报路径——我们自己的 setter，和 agent 的 `config_option_update` / `current_mode_update`。先到的那条算出差异并提示，后到的那条与我们刚写入的快照一比就是空的。**通知路径用载荷**而不是 `SessionManager` 的状态：两个监听器的先后顺序不保证，读状态可能拿到改前或改后。
  - **首次见到某会话只做基线**（在 `onSessionUpdate` 顶部播种），所以打开会话不会打印"切到它本来就有的模型"。
  - 表述：model → `Switched to <名字>`（与官方同款）；mode → `Switched to <名字> mode`（无论来自 `session.modes` 还是 category='mode' 的配置项，读者不该看出差别）；其它配置项 → `<选项名>: <值名>`（只说 "Switched to High" 是个谜语）。同一次响应里的级联变更合成**一条**（分隔符 ` · `），并把 model/mode 排在前面。
  - 渲染：`NoticeEntry['level']` 增加 `'switch'`（**表现形式，不是严重级别**），CSS 用左右虚线做成分隔式一行。协议不变。
- **验证方式**：`npm test` **56 passing**（`chat-panel.test.ts` 新增 7 条：模型 / 模式两条通道 / 其它配置项 / 级联顺序 / **同一次切换第二次上报必须静默** / 载荷打补丁不丢其它状态 / 空状态不崩）。**待用户 F5 复验**：切换模型或模式后出现居中分隔式提示；再切一次不出现重复的两条；`session/load` 重开会话时不出现"切到当前模型"的噪声。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-074
- **功能**：工具卡头部显示 agent 自己报的工具名（Bash / Read / Edit …）
- **改动文件**：`src/ui/chat/content/toolCalls.ts`、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户在确认第 2 项范围时勾选的「工具卡显示真实工具名」
- **详细说明**：ACP 的 `kind` 是粗粒度词表（Run / Read / Edit / Search），两张 "Run" 卡只能靠标题区分。夹具里 **12/12 个**工具调用都带 `_meta.claudeCode.toolName`，所以从 `inv.meta` 取出来作为 `.tool-name` chip 与 kind 标签**并列**（不替换：kind 是任何 agent 都能给的那一层）。`_meta` 按定义是厂商私有的，只认这一种已知形状、其余一律静默——猜第二个厂商的键正是 §5.6 警告的"把推断当事实"。chip 必须可加、可删、可改：`update` 路径也要调（占位卡靠 update 才拿到真实视图模型，这是 027/040 反复踩过的那条路）。
- **验证方式**：`check-webview-client` / `tsc` / `lint` / `compile` / `check-registry` 全绿，`npm test` 56 passing。**待用户 F5 复验**：工具卡头部出现 Bash / Read 等真实工具名，泛化的 RUN / READ 标签同时保留。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260926-075
- **功能**：会话被重命名时留一条轻提示；思考块里的非文本内容不再被丢弃
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户在确认第 2 项范围时勾选的另外两项（内容块审计的结论）
- **详细说明**：
  - **改名提示**：`session_info_update` 此前只更新标签栏与会话历史。现在缓存"上一次的标题"（**宿主独占**，因为 `SessionManager` 可能已经先应用了新标题，它的状态答不出"旧标题是什么"），且**只提示真正的改名**——一条会话的第一次 `session_info_update` 通常是自动生成的标题，为它打印一行等于给每个新会话都加噪声。
  - **思考块内非文本内容**：`agent_thought_chunk` 带的图片/资源此前直接 `return` 丢掉。现在复用 `postContentNotice` 变成 content 记录，**但先 `finalizeEntries(only:'thought')`**：记录只并入"最后一条"，不关掉旧思考块的话它会永远停在 `Thinking…`（后续 thought chunk 会另起一条）。
  - 审计结论里**刻意没做**的：`available_commands_update`（斜杠菜单已经消费它，再提示是噪声）、`usage_update` 的成本数字（令牌条里已有）、用户消息里的非文本内容（replay 路径上没出现过）。
- **验证方式**：`tsc` / `lint` / `compile` / `check-webview-client` / `check-registry` 全绿，`npm test` 56 passing。**待用户 F5 复验**：让 agent 改一次会话标题（或从树里重命名）后出现一条轻提示，而新会话的自动标题**不**产生提示。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260925-068
- **功能**：**客户端逻辑的常驻测试**（桩 DOM）——`src/test/chat-client.test.ts`
- **改动文件**：**新增** `src/test/chat-client.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：本轮排查 064 时，读代码怎么看都对，最后是**用一个临时桩 DOM 把客户端那段逻辑真跑了一遍**才定性。
  那个探测当场抓到了 bug ⇒ 说明客户端**逻辑**层一直在自动测试的覆盖范围之外，而这层恰恰是 bug 高发区。
- **详细说明**：
  - **只加载被测链路的模块**：`dom`（工具）→ `icons`（图标，用于断言挂载顺序）→ `links`（装饰）→
    `toolCallView` → `transcriptView`；其余协作者（scroll / outline / rail / boot / bridge）给**最小替身**。
    **刻意不加载 boot**：它的 `init()` 会去接十几个 `body.ts` 提供的元素，为了让它跑起来就得把桩扩张成一个
    假 DOM——那只会得到一堆与产品无关的桩代码。**边界画在被测链路上**。
  - 覆盖四条**只有逻辑、不涉布局**的断言：①单行用户消息不给折叠；②多行折叠且 summary+body 能**原样重建**
    原文（防重复显示）；③**长单行也给折叠**（064 的修复——"看起来多行"≠"有换行"）；
    ④**INV-J**：折叠三角排在类型图标**之后**，且收束那次 summary 重写后**图标与三角都还在**。
  - **它能测什么 / 不能测什么**写进了文件头：能测结构、顺序、类名、内容切分（**逻辑**）；
    **不能测**布局、尺寸、换行位置、颜色、焦点（需要真 Chromium——用 jsdom 之类的近似实现去测布局
    只会给出**假信心**，这条界线与 `dev-workflow.md` 的分区表一致）。
  - 桩是**外部 API 的测试替身**（同文件里早就有个假 Memento），不是我们自己知识的第二份拷贝——
    后者才是 pitfalls #19 说的漂移来源。
- **过程记录（几处都是"测试自身的假设错了"，值得记）**：①最初按"容器的第一个元素子节点"取记录，
  而 065 之后 `place()` 会把 `.rec-time` 插到最前 ⇒ **第一例是假通过**；改为按 `[data-kind]` 标记定位。
  ②用户记录是**包着 details 的 div**，而 Thought 记录**本身就是 details** ⇒ 只认一种形态会让两条用例都误判"无折叠"。
  两次都是"测试错了、产品没错"，而这**正是桩 DOM 的代价**：它的假设也要被检验。
- **验证方式**：`npm test` **45 passing**（本文件 4 条）；`lint` / `tsc` / `compile` / `check-registry` 均通过。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260925-067
- **功能**：**自己的右键菜单**，取代 Chromium 的原生菜单（去掉无意义的 Cut/Paste，让 Copy 真的能用）
- **改动文件**：**新增** `src/ui/chat/html/client/contextMenu.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「右键菜单 Copy 点了没效果，另外 Cut 和 Paste 在这里应该不需要」
- **根因（用户观察是对的，而且原因比"坏了"更具体）**：webview 里弹的是 **Chromium 的原生菜单**，
  它的 `Copy` 复制的是**选区**——右键时通常并没有选中任何文本，所以它看起来可用、实际什么都不做；
  而 `Cut`/`Paste` 只对可编辑内容有意义，这个面板除了输入框全是只读的。
- **详细说明**：
  - `contextmenu` 上 `preventDefault()` **整体接管**（留着原生菜单会得到两个菜单），按上下文给项：
    `Copy`（选区）/ `Copy message`（整条记录）/ `Copy code`（代码块）/ `Select all`。
  - **没有 Cut/Paste**；`Copy` 在没有选区时是**禁用**的——**这正是重点**：一个禁用项比一个"点了没反应"的项
    诚实得多（本次故障的全部体感就是"点了没反应"）。
  - 复制一律走扩展侧的 `copy` 通道（与代码块的 Copy 按钮同一条路）：webview 里的 `navigator.clipboard`
    依赖文档焦点，不可靠。
  - 输入框里**不接管**右键（那里系统的 Cut/Paste 是对的）。
  - 关闭：任意点击 / Esc / 滚动 / resize / 失焦；位置按光标算并**贴边翻转**，不越出视口。
  - 菜单项是真 `<button>`（047 的规矩），打开时焦点落到第一个可用项 ⇒ 键盘可达。
- **验证方式**：`check-webview-client.mjs`（15 个客户端模块）/ `tsc` / `lint` / `compile` /
  `check-registry.mjs` 全绿；`npm test` 45 passing。**交互无法自动测**（分界线见 `dev-workflow.md`）。
  **待用户 F5 复验**：右键对话区 → 只有四项且无 Cut/Paste；选中文字后 `Copy` 可用并真的复制到；
  没选中时它是灰的；`Copy message` 复制整条；`Select all` 后可直接 Ctrl+C；输入框里右键仍弹系统菜单。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260925-066
- **功能**：**工具输出按 markdown 显示**（此前是纯文本，字面的 ``` 围栏直接显示出来）
- **改动文件**：`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户问「Run 执行命令里的信息是 markdown 格式的文本？需要按 markdown 显示」
- **证据（不是推测）**：抓包夹具里 **12 处工具结果文本块带 ``` 围栏**（例如 ` ```console\ntotal 36099\n… `）
  ——Claude Code 的 Bash 结果**本身就是 markdown 包装的**，而我们按纯文本渲染，于是围栏变成了字面字符，
  也拿不到代码块的样式与 Copy 按钮。
- **详细说明**：
  - **复用助手气泡那条 markdown 往返**，而不是在本端写第二个更弱的渲染器：文本仍由宿主侧 `SafeMarkdown`
    渲染、客户端 `sanitize` 再兜一层，两边**同一套策略**。
  - 工具内容项此前没有身份，无法与 HTML 对应 ⇒ 给它一个稳定 key：`entryId + '#' + 项下标`（下标在同一调用内稳定）。
  - 协议：`renderMarkdown` 的 item 与 `markdownRendered` 的 item 各加一个可选 `key`；
    **带 key 的项宿主不做 `transcripts.patch`**（它不是记录，没有可打补丁的对象），HTML 原样回给请求它的元素。
  - 客户端两份缓存（`mdCache` / `mdPending`），**按会话清空**（`transcriptView.reset()` 里调 `resetMarkdown()`）：
    工具 body 在 `bodySignature` 变化时会整块重建，缓存是让已渲染的 HTML 挺过重建的关键。
  - **顺手收敛了一处重复**：`post` / `postNow` / `send` 三个签名里各写了一遍 `markdownRendered` 的内联类型，
    加一个字段就要改三处（漏一处就是静默不匹配）⇒ 统一改用 `protocol.ts` 的 `MarkdownRendered`。
  - **防御**：拿不到 entryId 时（没有唯一 key）**回落到纯文本**——key 撞车会把一条记录的 HTML 喂给另一条。
- **验证方式**：`check-webview-client.mjs` / `tsc` / `lint` / `compile` / `check-registry.mjs` 全绿；
  `npm test` 45 passing。**待用户 F5 复验**：工具卡里的命令输出应显示为**代码块**（有语言标签与 Copy 按钮），
  不再出现字面的 ```；diff 与 terminal chip 行为不变。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260925-065
- **功能**：**时间信息**——hover 看完整时刻、工具卡显示耗时、头部「Times」开关显示每条 HH:MM
- **改动文件**：`src/ui/chat/content/toolCalls.ts`、`src/ui/chat/html/client/dom.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户问「每条记录有执行的时间信息吗，想把时间信息显示出来，有什么好的方案」
- **事实（先回答这个）**：**每条记录都已经带 `at` 时间戳**（`TranscriptStore` 在 append 时打的），只是从来没显示过；
  Thought 显示的 `Thought for Ns` 是**耗时**不是时刻；工具**早已有** `startedAt`/`endedAt`，只是没下发到视图模型。
- **详细说明（三个层次，按"噪声从低到高"）**：
  - **hover**：每条记录设 `title` 为完整时刻（HH:MM:SS）——零成本、零噪声，任何时候都能查。
  - **工具耗时**：`ToolCallView` 新增 `elapsedMs`（宿主侧用 `endedAt - startedAt` 算，**不下发两个时间戳**——
    已完成的时长不需要客户端时钟；仍在跑的不显示：`status` 的脉动就已经说明"进行中"，实时计时器意味着每帧重渲染）。
    卡头显示 `1.2s` / `420ms` / `2m 5s`，与 `Thought for Ns` 是**同一类信息**，所以常显、不设开关。
  - **头部「Times」开关**：打开后每条记录前显示 HH:MM。`.rec-time` 元素**始终在 DOM 里**，可见性由
    `#messages` 上的一个类决定（与「Sub-agents」开关同一套机制）⇒ **切换开关不需要重渲染任何东西**，
    且状态经 `persistUi` 持久化。
  - 时长的格式化放进 `NS.dom.duration`（最底层模块）：`toolCallView` 与记录层都要用它，而模块加载顺序
    **只允许依赖指向前方**——放在 `transcriptView` 里 `toolCallView` 用不到，抄第二份又会漂（pitfalls #19）。
- **验证方式**：`check-webview-client.mjs`（15 个客户端模块）/ `tsc` / `lint` / `compile` /
  `check-registry.mjs` 全绿；`npm test` 45 passing。**待用户 F5 复验**：hover 任意记录看到完整时刻；
  工具卡头在跑完后出现时长；点「Times」后每条前面出现 HH:MM、再点关闭；重启面板后开关状态还在。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-26 - CUSTOM-20260925-064
- **功能**：修「**多行用户消息也不折叠**」——折叠的触发判据只认逻辑换行，漏了「视觉折行」
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验 061 时的反馈（"我刚看到的是多行也没现实和折叠"）
- **定位方式（值得记下来）**：读代码怎么看都对（多行确实会走 details 分支），于是写了个**桩 DOM** 把客户端那段逻辑
  **真跑一遍**，三种输入一次就定性：单行短消息 → 不折（对）；**逻辑多行（有 `\n`）→ 折叠（对）**；
  **长单行（视觉折行）→ 不折（错）**。
- **根因**：`buildUserBubble` 用 `text.indexOf('\n')` 判断"是不是多行"。但"多行"有**两种**含义——
  **逻辑换行**与**长句子视觉折行**，而后者**一个换行符都没有**。用户看到的长消息正是后者 ⇒ 不给折叠。
- **详细说明**：
  - 触发条件改成 `有逻辑换行` **或** `长度超过约 160 字`（后者是启发式：约一个面板宽；切分点本身是看不见的实现细节）。
  - 切分点：优先取逻辑换行；否则取 160 字内**最后一个空格**（展开后从那里接下去，切到词中间会被看见）。
  - **折叠态** summary 占**恰好一行**并省略号截断（`.user-fold:not([open]) > summary`）——**只在折叠态**：
    展开时若还是 nowrap，第一段会被截成"半句话加省略号"，看起来像内容丢了。
  - **展开态 body 是 inline**：切分点只是实现细节，用块级 body 会在半句话处凭空多一处换行。
- **验证方式**：新增的 `src/test/chat-client.test.ts`（068）**四条用例**钉住它，其中一条正是
  「长单行也给折叠」；`npm test` **45 passing**；`check-webview-client.mjs` / `tsc` / `lint` / `compile` /
  `check-registry.mjs` 全绿。**待用户 F5 复验**：长消息（无换行）也出现折叠三角；折叠态是一行加省略号；
  展开后文字**连续、无重复、无多余换行**；单行短消息仍然没有三角。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-063
- **功能**：标签栏加「后台会话有新输出」提示——把 `.tab-dot.attention` 这条闲置 CSS 接上线
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/tabs.ts`、`src/ui/chat/html/styles.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求"总体盘一下"时发现 `.tab-dot.attention` 从未被任何 JS 使用（052 已登记为"设计预留"）。
  用户此前决定**不做后台权限卡**，所以给了它一个**更轻**的用途。
- **详细说明**：
  - **状态放宿主**：只有宿主同时知道"哪个会话产生了输出"与"当前聚焦的是哪个"。
    `ChatPanelHost` 新增 `unread: Set<sessionId>`；`toSummary()` 带上 `unread`。
  - **只在一个咽喉点标记**：所有带记录的下行消息都经过 `post()`，所以在那里按
    `type ∈ {append, revise, toolUpdate}` 且 `focused.sessionId !== sessionId` 打标。
    **刻意不在每条 append 调用点各写一遍**——那迟早会漏掉一条路径（判据同 040 那次
    "两条路径各写一遍 body 构建"的教训）。
  - **签名必须跟着加**：`refreshSessions()` 的签名字符串现在含 `title|loading|running`，
    加上 `unread` 才算完整。**漏加的表现是"标签永远不刷新"**（022 的签名去重是双刃剑）。
    同时在**新标记产生**与**聚焦清除**两处各调一次 `refreshSessions()`：有些 append 路径
    （notice / 终端输出）本来就不会自己刷新，靠别的调用点顺带刷是不可靠的。
  - **优先级**：`loading` > `running` > `unread` > 普通。正在流式的标签本来就在脉动，
    两个信号表示一件事只会更乱。
  - **它只是提示**：不弹窗、不抢焦点——与"不做后台权限卡"的决定不冲突。
  - 顺带把 `.tab-dot.attention` 上方那段"设计预留、从未接线、**看到它没生效别当 bug 修**"的
    注释改成了真描述（它现在有接线了，旧注释会误导下一个人）。
- **验证方式**：`npm test` **41 passing**（新增 2 条：后台会话的输出 → 其 summary 的 `unread` 为 true
  且 **`sessionsChanged` 真的发出了带 unread 的载荷**（这条同时守住"签名漏加"那个坑）；
  聚焦后为 false；聚焦会话自己的输出永远不为 true）。
  **待用户 F5 复验**：开两个会话 → 在 A 里发消息 → 切到 B → A 的标签点变蓝（不脉动）；点回 A → 蓝点消失；
  A 仍在流式时是脉动的 running 点而不是蓝点。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-062
- **功能**：修三处可测性/语义缺陷——宽表格横向撑破气泡、"当前位置"与键盘焦点同色、引导条圆点难点中
- **改动文件**：`src/ui/chat/html/client/links.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求"总体盘一下"时的评审结果，三处都有代码证据（不是主观意见）
- **详细说明**：
  1. **宽 markdown 表格横向撑破气泡**：`.bubble pre` 有 `overflow-x: auto`，而 `.bubble table`
     只有 `border-collapse` ⇒ 列多的表格把气泡（进而整个面板）撑宽，而不是在内部滚动。
     修法**复用一个通道**：`links.ts` 的 `decorateCodeBlocks()` 旁边加 `decorateTables()`，
     再由新的 `decorateScrollables()` 一次调用两者（**一个入口**，将来新增块类型不会只记得一处）。
     `transcriptView` 的调用点跟着改；`.table-wrap { overflow-x: auto; max-width: 100% }`。
     **为什么用包装元素而不是给 `.bubble` 加 `overflow-x`**：后者会改变气泡自身的溢出语义，
     而包装元素让"两种可横向滚动的块"处理方式**一致**。
  2. **引导条"当前位置"的环与键盘焦点环同色**：`.rail-dot.active` 用 `--vscode-focusBorder` 画外环，
     而 047 刚把同一个变量定义成**键盘焦点**的语义（全局 `:focus-visible`）⇒ **一个颜色两种意思**，
     用户分不清"我在哪"与"焦点在哪"。改为**不依赖颜色**的区分：`.rail-dot.active { transform: scale(1.4) }`
     （`scale` 以中心为基准，所以不影响 061 的圆心对齐）。**刻意不用环**——环在这个面板里已经等于"焦点"。
  3. **引导条圆点只有 7px，鼠标几乎点不中**：加一层透明的 `.rail-dot::after { inset: -5px }`，
     命中区约 17px 而**外观完全不变**（伪元素不参与布局）。
- **验证方式**：`check-registry.mjs` 六节全绿；`check-webview-client.mjs` / `tsc` / `lint` / `compile`
  均通过；`npm test` 41 passing（本轮改动集中在 CSS/DOM，**不在自动测试覆盖范围内**）。
  **待用户 F5 复验**：宽表格在气泡内部横向滚动 / 当前圆点"变大"而不是出现焦点色环且键盘焦点环仍可辨 /
  小圆点明显更容易点中。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-061
- **功能**：对话区三处——引导条圆点对齐、Thought 折叠三角位置、**用户消息支持折叠**
- **改动文件**：`src/ui/chat/html/client/rail.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验时的三条反馈（截图：圆点比区块偏上；三角在图标左侧；用户消息不能折叠）
- **详细说明**：
  1. **圆点对齐：把魔法偏移换成"按构造对齐"**。`rail.measure()` 原本是 `dot.style.top = (y + 6)`，
     而 CSS 用 `margin-top: -半高` 抵消尺寸 ⇒ `top` 就是**圆心**，于是圆心被钉死在"条目顶边 + 6px"。
     但各条目首行中心并不在那儿（工具卡 3px 内边距 ≈ 12px、用户气泡 6px ≈ 15px），**统一偏上 6–9px**。
     修法：锚到条目里的**类型图标**——`icons.attach()` 本来就把它放在该条目的首行上，
     所以它的几何中心**就是**要对的中心，不需要任何常量。`points[]` 里 `y`（条目顶边，供 `syncActive`
     的二分查找用）与 `centre`（圆心）分开存；`rail-line` 的两端改用 `centre`，于是竖线恰好落在首末圆点上。
  2. **Thought 三角移到图标右侧**：三角是 `summary::before`，而**伪元素永远画在内容之前**，
     图标（prepend 到 summary）排它后面 ⇒ 顺序成了「▸ 图标 标签」。改成**真元素** `.fold-caret`：
     buildThought 先建三角、图标再 prepend ⇒ 天然是「图标 ▸ 标签」。三角是空的，字形与方向仍由 CSS
     依 `details[open]` 驱动，**切换不需要 JS**。
     **同时改了 `patch()` 里那次 summary 重写**：它原本只保留 `.rec-icon`，会把新三角一起清掉；
     改成**保留所有元素子节点、只丢弃文本与 `.thought-spin`**——"保留元素"不会像名字清单那样漏掉新挂件。
  3. **用户消息折叠（与 Thought 同一形态）**：多行用户消息包成 `<details class="user-fold" open>`，
     **首行在 summary、其余行在 body**——刻意**不**把全文再放一遍（否则展开时文字重复两遍）。
     单行消息**不出现三角**：没有可折的东西，凭空多个三角只是噪声。
     **默认展开**：刚发出的消息不该默认藏起来（Thought 那次自动收起是因为推理是辅助信息，消息不是）。
     气泡观感挂在 details 上（背景/内边距/圆角），summary 抹平自身的背景与内边距 ⇒ 展开时仍是**一个连续气泡**。
- **验证方式**：`check-registry.mjs` 六节全绿；`check-webview-client.mjs`（14 个客户端模块）/ `tsc` /
  `lint` / `compile` 均通过；`npm test` 41 passing（本项改动全在客户端，**布局与交互无法自动测**）。
  **待用户 F5 复验**：逐个核对工具卡/Thought/用户气泡的圆点是否落在**首行图标中心**上、竖线两端是否恰好在首末圆点；
  Thought 收束那次重写后三角不丢；多行消息可折叠且首行不重复、单行消息无三角；折叠态默认展开。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-060
- **功能**：再次拆分模块文档（方案 A）；并合并 changelog / pitfalls 里"同一个问题分多次修"的记录
- **改动文件**：`CUSTOMIZATIONS/docs/arch/chat-panel.md`（488 → 385 行）、**新增** `CUSTOMIZATIONS/docs/arch/chat-panel-sessions.md`、`CUSTOMIZATIONS/docs/changelog.md`（1161 → 990 行，59 → 42 条）、`CUSTOMIZATIONS/docs/pitfalls.md`（694 → 667 行）、`CUSTOMIZATIONS/architecture.md`、`CUSTOMIZATIONS/registry.md`
- **来源**：`chat-panel.md` 到了 488 行，超了 `architecture.md` §0 那条「体量铁律」（超过 ~400 行即拆分）——
  而这条铁律存在的理由很具体：**它每长一行，就是每个会话都要付一次的上下文税**。
- **详细说明**：
  1. **拆分（方案 A）**：把 §5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）
     移入 `docs/arch/chat-panel-sessions.md`。**为什么这三节一起走**：它们是同一个主题的三面——
     **会话生命周期**（建会话时选目录 / 已存在会话的目录从哪来 / 重开会话那条 replay 链怎么测），
     共享同一个前提：cwd 是会话级属性、且由协议固定在创建时。主文件保留面板本体（§5.1–§5.12，385 行），
     并按同一套纪律留了一个指向新文件的 §5.13–5.15 小节。
     **§5.x 的编号原样保留**（理由同 042）——因此本次拆分**不需要改动任何外部引用**：
     代码注释与其它文档里的「§5.4」「§5.5」「§5.7」「§5.8」「§5.10」「§5.12」全都留在主文件里。
  2. **changelog 的同题合并**：59 → 42 条（1161 → 990 行）。合并的是**同一个问题分多次修**的条目：
     14 项面板审计（038-041 + 043-052）→ 2 条、白条问题（026/027/034/036/037）→ 1 条、
     每会话 cwd 两步（056/057）→ 1 条、replay 收尾（053 并入 055）→ 合 1 条。
     **所有 change-id 都保留在合并后的标题或正文里**（用 `038..041` / `053/055` 这类范围写法），
     所以「代码 `[CUSTOM-BEGIN]` 标记 → 账本演进链 → 日志条目」的追溯链没有断——已用脚本核对
     **000–060 每个 id 都仍能找到**。
  3. **顺带修掉一个我自己的错误**：056/057/058 是用 `cat >>` 追加的，落到了**文件末尾**——
     而这个日志的契约是**按时间倒序（最新在最上）**。合并时一并按 `(日期 desc, 序号 desc)` 重排修正。
  4. **pitfalls 的合并**：§11（模板字符串里的反引号）原有四条"复发记录"，合并成一段
     「复发史 + 四次升级」，保留每一条**不同的**教训（让检查器报出来 → 覆盖全 → 理解工具自身的实现 →
     直接修掉它），去掉重复叙述。
  5. **这是 changelog 唯一一次改写历史**：该文件的契约是 append-only（"历史是事实"）。
     用户明确要求做同题合并，所以做了——但在文件头部写了说明（合并范围 + id 全保留 + 之后仍 append-only），
     避免下一个人以为历史丢失。**代价已记录：合并后的措辞是后来重写的，不再是当时的原文。**
- **验证方式**：`check-registry.mjs` 六节全绿；`npm test` 42 passing；`tsc` / `lint` / `compile` /
  `check-webview-client.mjs` 均通过；id 完整性由一次性脚本核对（000–060 无缺失）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-059
- **功能**：修「点 Browse 选完目录后没反应」——目录选择的**两处静默失败**
- **改动文件**：`src/ui/chat/html/client/directoryMenu.ts`、`src/ui/chat/html/client/boot.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 复验 058 时发现：草稿页点头部目录 → Browse → 在系统对话框里选好并点 “Use this directory”
  → **面板里显示的目录没有变**
- **根因（两条，同一个反模式：数据更新被 UI 状态门控，失败还不出声）**：
  1. `setChoices` 里 `if (!open) { return; }` 出现在**采用默认目录那一步之前**。而草稿页出现时抽屉本来
     就是关的（`focusDraft` 直接调 `refresh`，不经过 `show`）⇒ **默认目录永远没被采用**，头部一直显示
     `Default directory`——这正是用户截图里那一行。
  2. `setPicked` 里同样先判 `if (!open) { return; }`。系统文件夹对话框是**会抢焦点的异步交互**，
     靠"我们的抽屉在它返回时还开着"来收结果本身就不可靠；一旦不成立，**用户的选择被静默丢弃**。
- **详细说明**：
  - **数据更新不再门控于 `open`**：`setChoices` 无论抽屉开没开都采用默认目录；`setPicked` 无论抽屉
    开没开都应用结果（只在需要重绘时才看 `open`）。
  - **草稿只用 `draftId` 标识，cwd 现读**：抽屉此前缓存了一份 draft 对象——那是"同一份知识存两份"
    （pitfalls #19）。现在它只存 id，渲染时从新的 `NS.draft.get(draftId)` 现读，单一真相源。
  - 顺带删掉已经无用的 `browseIntent`（两个分支做的是同一件事——052 的规矩：不留死代码）。
- **验证方式**：`npm test` 39 passing；`check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` /
  `check-webview-client.mjs` 均通过。**这一类（客户端交互）无法自动测**——`dev-workflow.md` 的分界线表
  里写明布局与键盘只能人工；清单 94/96 就是这两条路径。
- **教训**：写客户端状态机时问一句「**这个数据更新依赖某个 UI 状态吗？**」——依赖了就会在"UI 状态
  恰好不成立"时静默丢结果，而这类失败**没有任何日志**。判据：更新所依赖的应该是**数据本身的标识**
  （draftId），不是"某个面板是否可见/是否打开"。已回写 pitfalls。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-058
- **功能**：**草稿页 + 目录选择器**——「新建会话时可以选这个会话的工作目录」，并让 `+` 与空态 Connect 统一到草稿
- **改动文件**：`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/client/`（**新增 `directoryMenu.ts`**；改 `boot.ts`/`tabs.ts`/`composer.ts`/`sessionMenu.ts`/`index.ts`）、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/*`
- **来源**：用户提出「点 New Session 跳转到新会话界面时（还没发对话），支持切换当前 session 的对话目录」。
  需求对齐后确认四条：①草稿页（发出第一条才建会话）；②目录候选四种都要（工作区文件夹含多根 /
  任意绝对路径 / 最近用过 / 让 `defaultWorkingDirectory` 生效）；③一个会话挂多个目录本轮不做；
  ④第一条之后目录只读。
- **详细说明**：
  1. **草稿页是纯客户端状态**（`boot.ts` 的 `drafts` + `focusedDraftId`）：点 `+` 只开一个本地标签
     （`New session`，虚线空心点），**不发任何建会话请求**。它必须能在 `sessionsChanged` / `boot`
     之后存活——服务端列表按定义不含草稿，冲掉的表现就是"点 `+` 后标签闪一下就没了"。
     所以 `tabs.ts` 的 `setSessions` 刻意**不碰** drafts，草稿走独立的 `setDrafts`/`setDraftFocus`。
  2. **发出第一条时才建会话**（`createDraftAndSend {draftId, agentName, cwd, text}`）：
     宿主 `createSession(agent, {cwd, focus:true})` → **复用现成的 `handleSendPrompt`**（它已经会做
     `recordFirstPrompt`、附件、`finalizeTurn`）。**为什么不是"先建再重建"**：`session/close` 不会把会话
     从 agent 历史里移除（图1 里那两条我抓包留下的空会话就是证据），于是每改一次目录就多一个垃圾会话。
  3. **应答带相关性 id**：`draftResolved {draftId, sessionId}` / `draftFailed {draftId, message}`。
     `createSession` 会连带触发 `session-created → sessionsChanged → focus`，靠"收到新 focus 就删草稿"
     在慢路径/失败路径上会留下孤儿草稿或误删。**失败时草稿与已输入的文字都保留**——
     所以 composer 在草稿模式下**刻意不清空输入框**，清空发生在 `draftResolved`。
  4. **目录候选**（`listDirectoryChoices` → `directoryChoices`）三组：工作区文件夹（**含多根**，
     此前只用了 `workspaceFolders[0]`）、最近用过（本地历史缓存的 `recentDirectories` 与 agent 侧
     `session/list` 的 cwd **合并**——本地那份是 `workspaceState` 作用域的，新工作区开局为空）、
     以及默认目录。第四组「浏览…」走 `pickDirectory` → **宿主** `showOpenDialog`（webview 自己打不开）。
  5. **抽屉形态照抄 `sessionMenu`**（021/033 那套 `.outline*` 与 `#cwdMenu`，与 `#outline`/`#history` 同级），
     三个抽屉互斥（打开一个会关掉另外两个）。头部显示目录的那格（`#sessionTitle`）**从 `<span>` 变成真
     `<button id="cwdBtn">`**——延续 047 的规矩，键盘可达且带焦点环。
  6. **已开始的会话**：目录由协议固定在创建时（ACP 没有"改 cwd"），所以那一格只读展示，
     抽屉里点候选项等于**在那个目录里开一个新草稿**（`NS.draft.start(path)`）——不假装能改。
  7. **空态 Connect 按钮改为 `ensureConnected` + 草稿**：只把进程拉起来（按钮存在的意义就是"我这个 agent
     起得来吗"，这条反馈没丢，`ensureConnected` 仍会在起不来时抛错），**不建会话**；若该 agent 已有会话
     则聚焦最新那条，草稿留在标签栏里可随时回来。
  8. **历史会话行显示目录**：列表是**跨目录**的（agent 侧，用户的截图里 245 条），而此前只能靠 hover
     才知道各自属于哪个项目。行右侧加 `.outline-cwd`（只显示最后一段，全路径在 tooltip 里）。
- **顺带加的工具**（`check-webview-client.mjs --fix`）：本轮我在客户端模板的注释里**第 7 次**写下反引号，
  而修法永远是同一个机械动作。按 pitfall #11 自己的教训——**「能自动化的纪律就不要留给记忆」**——
  给检查器加了 `--fix`：把**模板体内**（只在模板体内；文件头注释里的反引号不受影响）的反引号就地
  换成单引号，然后照常校验。**做过负向测试**：注入 6 处 → 报错 → `--fix` → 只改了那两行、其余零改动。
  读写按 `'\n'` 切分拼接，因此 **CRLF 文件不会被转成 LF**（pitfall #7）。`--fix` 是手动用的，
  `check-registry.mjs` §5 与 CI 调它时**不带参数**，所以闸门仍然是"只报错、不改代码"。
- **验证方式**：`npm test` **39 passing**（本步新增 5 条：选中的目录一路传到 `createSession` 且随后真的发了
  prompt / 空草稿不建任何东西 / 建会话失败时回 `draftFailed` 且**不消费草稿** / 目录候选三个字段齐全
  且默认目录非空 / connect **只** `ensureConnected` 不建会话）。
  `check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` / `check-webview-client.mjs` 均通过。
- **待用户 F5 复验**（布局与交互无法自动测，见 `dev-workflow.md` 的分界线表；清单已加为 93-100 项）：
  ① `+` → 出现 `New session` 草稿页，头部目录可点、抽屉三组候选都在；
  ② 选工作区文件夹 / 任意目录 / 最近用过 → 发送 → 新标签出现、头部目录是它、**agent 在那个目录里干活**；
  ③ 草稿里**先打字再改目录** → 文字不丢；
  ④ 空态 Connect → 也是草稿页；agent 起不来时有明确报错；
  ⑤ 已发出消息的会话 → 头部目录只读、抽屉里点候选是"在新目录里开新会话"；
  ⑥ 历史列表每行右侧能看到目录；
  ⑦ 键盘：Tab 到 `#cwdBtn` → Enter → 点击项 → 关闭（Esc 也行）；
  ⑧ 正常会话的发/停/running 状态、标签切换、`+` 之后立刻发送，都不受影响。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-056/057（每会话工作目录：探针闸门 + 宿主侧落地）
- **功能**：**每会话工作目录**——顺带修掉历史选择器丢 cwd 的现网 bug，并让 `acpc.defaultWorkingDirectory` 真正生效
- **改动文件**：**新增** `CUSTOMIZATIONS/scripts/probe-session-cwd.mjs`、**新增** `src/test/fixtures/session-cwd-probe.json`、`src/core/SessionManager.ts`、`src/core/SessionHistoryStore.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要「在新会话页面上切换该会话的工作目录」。多标签并发会话从 010 起就能用，缺的只是
  **每页有自己的目录**——而 `getWorkspaceCwd()` 硬编码"工作区第一个文件夹"，被四处调用点各自调用。
- **详细说明**：
  1. **先做闸门（056）**：ACP 把 cwd 定义成**会话级**属性（`NewSessionRequest.cwd`："The working
     directory for this session"），但本扩展 `spawnAgent(name, config, workspaceCwd)` 是把**进程** spawn
     在工作区的。**若适配器沿用进程 cwd，就必须按 (agent, cwd) 分进程**（`agentProcesses` 的键要变），
     量级完全不同——所以先用探针实测，不猜。探针是非对称设计、一次就够：两个临时目录 A（进程 cwd）/
     B（会话 cwd），各放一份**同名不同内容**的 `which-dir.txt` 与一个**只在一边存在**的文件；用 cwd=A
     拉起 agent 后 `session/new({cwd:B})`，让 agent 跑 `pwd`/`ls -1` 并读**相对路径**。判定机械——标记
     字符串只会出现在输出里。**结论 `honours-session-cwd`**：`pwd` 报会话目录、`ls` 只看到会话那边、
     读相对路径得到会话那边的标记，**进程目录的标记一个都没出现** ⇒ 只需改一条链。
     **两个附带发现（都推翻了一个合理假设）**：`terminal/create` 与 `fs/read_text_file` 各被调用 **0 次**
     ——Claude Code 的 `Terminal`/`Read File` 是**适配器自己执行**的，不走客户端能力。因此每会话目录
     **不依赖**我们的 `TerminalHandler`，而 `FileSystemHandler` 的「优先返回未保存编辑器缓冲区」对它
     **从不生效**。
  2. **cwd 成为一等属性（057）**：`getWorkspaceCwd()` → **`resolveDefaultCwd()`**（公开，三级回退：
     `acpc.defaultWorkingDirectory` → 第一个工作区文件夹 → `process.cwd()`；**相对路径或不存在的目录被
     拒绝并记日志**，不交给 agent——坏 cwd 会让 `session/new` 在适配器深处失败）。
     `createSession(agent, {focus?, cwd?})` 的 cwd 可选，并作为**进程 spawn 的偏好**传给
     `ensureConnected`（只影响首次 spawn）。`loadSession`/`resumeSession`/`openExistingSession` 接受
     cwd，解析顺序是「调用方给的 → **本地历史缓存里那条会话自己的 cwd** → 默认」——**这修掉了一个
     现网 bug**：历史选择器展示的是 agent 侧跨目录的 `session/list`（用户截图里 245 条），而点开时宿主
     从不传 cwd，于是告诉 agent 的是**当前工作区**，一条属于别的项目的会话会被当成住在这里重开；行的
     `cwd` 早就取到了（只用在 tooltip 上）。客户端现在把该行的 cwd 一并回传（`data-open-cwd`）。
  3. **`acpc.defaultWorkingDirectory` 从死设置变真设置**：它此前在 package.json 里声明得齐齐整整，
     **而 `grep defaultWorkingDirectory src/` 零命中**——pitfalls #5 那个"声明了却没接线"的模式
     **第二次复发**，已加复发记录（判据：给每个 `acpc.*` 设置项 grep 一次读取点，没有读取点的要么接上、
     要么删掉）。
  4. **`pickDefaultCwd(...)` 抽成纯函数并导出**，`resolveDefaultCwd()` 只是它的 vscode 外壳——
     抽出来的理由是**可测**：直接驱动 `getConfiguration().update()` 写设置意味着测试要去改用户/工作区
     的真实设置文件。
  5. **`SessionHistoryStore.recentDirectories(agentName)`**（新）：为目录选择器的"最近用过"组提供来源，
     复用现成的 `list(agentName)`（不传 cwd = 全部）——它本就按 `lastActiveAt` 降序，所以**首次出现的
     目录就是它最近一次被用的时刻**。**作用域注意**：该 store 在 `workspaceState` 里，只记得**本工作区
     曾用过**的目录（058 会把它与 agent 侧的跨目录清单合并）。
- **验证方式**：`npm test` **34 passing**（本步新增 9 条：`pickDefaultCwd` 的三级回退与两种拒绝、
  `recentDirectories` 的去重/排序（用内存假 Memento，不碰任何真实设置）、历史选择器的 cwd 路由
  （用**记录型子类**而非手写桩））。`check-registry.mjs` 六节全绿；`tsc`/`lint`/`compile` 均通过；
  **上一轮的 replay 回归闸门保持全绿**——本步正好改了 `session/load` 的调用点，它是最直接的报警器。
  **人工验收**：`dev-workflow.md` 清单 90-92（设置项生效 / 相对路径被拒且记日志 / 跨目录会话用
  **自己的** cwd 打开）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-054
- **功能**：**让聊天面板可以自己测**——真实 ACP replay 抓包脚本 + 宿主侧协议流回归测试
- **改动文件**：**新增** `CUSTOMIZATIONS/scripts/capture-acp-replay.mjs`、**新增** `src/test/chat-panel.test.ts`、**新增** `src/test/fixtures/claude-code-session-load.json`、`CUSTOMIZATIONS/*`
- **来源**：用户提出「每次我手动看，这样测试效率有点低，有什么办法可以让你自己测试吗」
- **详细说明**：
  1. **`capture-acp-replay.mjs`（夹具生成器）**：用真实 agent 走
     `initialize → session/new → prompt（可多轮）→ session/close → session/load`，
     把**两段流**（live 与 replay）一起写进一个夹具文件。它实现了一个**最小但忠实**的 ACP client：
     能力集与扩展一致（`fs` 读写 + `terminal`，因为 agent 行为可能取决于宣称的能力），
     终端能力真的接 `child_process`（不实现的话 Claude Code 的 Bash 工具会让整轮失败），
     权限一律自动批准（否则抓包卡在等人点按钮）。**在一次性临时目录里跑**，绝不在仓库内跑。
  2. **`src/test/chat-panel.test.ts`**：在**真 Extension Host**（`npm test` 已经提供）里构造真实的
     `SessionManager` / `ConnectionManager` / `AgentManager` / `ChatPanelHost`，用桩 `ChatSurface`
     拦下宿主准备发给 webview 的每一条协议消息，再对夹具断言。**不需要 agent、不需要 webview、
     不需要额度**，所以它是 CI 能跑的。
  3. **测出来的两类问题**（都是它自己发现的，不是我读出来的）：
     ① 首次跑起来两条流都"丢正文"，根因是**测试脚手架**：宿主把 `append` 走合帧队列，
     只在 16ms 定时器或结构性消息前冲刷，同步测试必须显式冲刷——改用公开的 `onFocusChanged`
     （它**恰好就是"重新聚焦/重开"那条路径**，于是断言变成"重开会看到什么"，正是要测的东西）；
     ② 冲刷之后暴露出**真 bug**（见 055）。
- **设计取舍（写下来免得下一个人返工）**：
  - **不做 DOM 测试**。这一层能判定的三类问题（正文有没有被丢、有没有记录永远 streaming、
    快照与增量是否一致）全都在协议流上可判，而且这样测试不依赖 webview、跑得快、不会因布局细节而脆。
    **布局类问题**（空白条、条目被压扁、diff 被折叠、按钮化后外观错位）仍需另一层"真 webview +
    客户端回传 DOM dump"的测试——那层**没写**，所以在 `dev-workflow.md` 的验收清单里仍标着"需人工"。
  - 夹具里的 live 段有 ~935 条通知（含 487 条 thought），文件约 450KB。**刻意不裁剪**：
    手工裁剪等于把我对"什么重要"的假设塞回夹具里，而这份东西的价值恰恰在于它是**未经加工的协议事实**。
- **验证方式**：`npm test` 25 passing（其中 6 条来自本文件的 replay 套件）；
  `check-registry.mjs` 六节全绿；`tsc` / `lint` / `compile` 通过。
  夹具缺失时测试会给出可操作的失败信息（附重抓命令），而不是一个看不懂的断言失败。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-053/055
- **功能**：**修「重开会话后助手正文与推理块全部消失」—— 宿主侧 `isBlankText` 的返回值与它的名字相反**
- **改动文件**：`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户报「重新打开看到的会话有问题，跟实时看到的内容不一样」（图1 实时正常 / 图2 重开后助手正文与 Thought 块全没了）
- **定性过程（值得记下来，因为它把「猜」换成了「测」）**：
  1. 先确认两条重开路径本来就不同——`SessionManager.loadSession` 在**会话已 live** 时只 `focusSession`（客户端从宿主 store hydrate），**已关闭**时才发 `session/load`（transcript 由 replay 重建）。
  2. 写抓包脚本（`CUSTOM-20260925-054`）用真实 agent 抓一份 replay。**结论推翻了最初的假设**：
     replay **完整包含** assistant 正文与 `agent_thought_chunk`（两轮答案、markdown 表格都在）。
     所以不是"agent 不回放"，**是我们丢的**。
  3. 夹具喂进宿主侧测试 → 复现：`transcript had 8 records: user,tool,tool,tool,tool,tool,user,tool`
     —— replay 的 5 条 thought + 2 条 assistant 正文**一条记录都没建出来**。
- **根因**：`contentBlocks.isBlankText()` 的 `return true` / `return false` **写反了**。
  它的名字、它的文档注释（"True when this text would render as something the reader can see" ——
  恰好描述的是**正确**极性）、以及**客户端的同名副本**（`toolCallView.isBlank`）**三者都是对的**，
  只有这个函数体是反的。`isBlankText('abc')` 返回 `true`，`isBlankText('   ')` 返回 `false`。
  调用点的语义是「看不见就不建记录」（`if (!merges && isBlankText(text)) return null;`），
  判据反过来就成了**「看得见就不建记录」** —— 每个*新开一条记录*的真切正文分片被丢掉，
  空白分片反而被保留。
- **为什么它藏了整整一天（026 → 055）而所有自动检查全绿**：
  **实时路径靠巧合是对的**。实时流里 agent 先发一个换行/空白分片当分隔符，按反了的判据它"不是空白"
  ⇒ 记录被建出来；之后真切正文走**合并**分支（`merges === true` 时那个守卫被整段跳过）⇒ 正文正常追加。
  而 replay 是**单块真切正文、前面没有空白分片** ⇒ 记录直接被丢。
  **这就是"实时好、重开坏"的全部原因。**
  另外，`''`（空串）走的是 `if (!text) return true;` 这个**提前返回**，而它是对的 ——
  所以 026 针对"空文本块"的那半修法确实生效了，而针对"纯空白分片"的那半**从未生效**。
- **修法**：把两处 `return` 对调，并把文档注释改成描述真正的语义（"True when this text would render
  as nothing"）。同时给 `session-load-end` 补上收尾（见下）：
  replay 是**有限**的流，结束后不可能还有东西在流式——但没有任何东西会关闭它建出来的记录
  （`finalizeTurn` 只为我们自己发出的 prompt 跑，`session/load` 不是）。不补的话最后那条助手记录
  会永远停在 `streaming: true`，把客户端的 `aria-busy` 钉在 true、**读屏从此静默**。
- **防复发**：`src/test/chat-panel.test.ts` 新增 `isBlankText polarity` 套件，五组用例
  （空串 / 纯空白 / 零宽字符 / 可见字符 / **夹具里每一条真实正文分片都不得被判为空白**）。
  最后一组是**用真实数据**而不是我编的用例——被误分类的正是那批字符串。
- **验证方式**：`npm test` **25 passing**（新增 10 条）；`check-registry.mjs` 六节全绿；
  `check-webview-client.mjs` / `tsc` / `lint` / `compile` 均通过。
  **待用户 F5 复验**：关掉那个会话再重开 → 助手正文与 Thought 块应当都在，与实时视图一致。
- **基于上游版本**：0.2.0（commit e7371659）
- **同轮的另一处收尾（053）——独立缺陷，**不是**上面症状的原因**：`user_message_chunk` 到达时
  **没有东西关闭仍在流式的助手记录**，而 legacy 面板一直这么做（"finalizes pending assistant turn"）。
  后果：replay 路径上若某条助手记录后面没紧跟工具调用，它会**永远停在 `streaming: true`**
  （`finalizeTurn` 只为我们自己发的 prompt 跑），于是客户端一直当流式渲染、而 048 新加的 `aria-busy`
  被钉在 true、**读屏从此静默**。修法：在 `appendUser` **之前**补
  `finalizeEntries(sessionId, {only:'assistant'})`，并在 `session-load-end` 时补 `finalizeEntries()`
  （replay 是**有限**流，结束后不可能还有东西在流式）。**INV-I**：replay 路径上不许留下
  `streaming: true` 的记录——测试里的 `no entry is left dangling as streaming` 是它的守卫。

### 2026-09-25 - CUSTOM-20260925-043..052（面板审计：性能 / 交互无障碍 / 清理）
- **功能**：把面板审计里"查到但没修"的问题**全部落地**（阶段 1 的四条正确性修复见 038-041）
- **改动文件**：`src/ui/chat/html/client/`（toolCallView / transcriptView / outline / rail / tabs / composer / links / boot / sessionMenu / dom / **新增 directoryMenu**）、`src/ui/chat/nesting/ClaudeCodeNesting.ts`、`src/ui/chat/transcript/ToolInvocationStore.ts`、`src/ui/chat/content/*`、`src/ui/chat/html/styles.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/protocol.ts`、`src/test/chat-panel.test.ts`、`CUSTOMIZATIONS/*`
- **来源**：面板审计（逻辑 / 性能 / 交互 / 无障碍四面）一次做完，分三档落地
- **详细说明（按档）**：
  - **性能（043-046）**
    - **043 嵌套推断去重复序列化**：`payloadContains` 曾对每个候选父调用 `JSON.stringify` 其
      `rawOutput`/`_meta`（上限 200KB），而 `apply()` 在**每次 `tool_call_update`** 上全量重算——
      宿主聊天链路最贵的一件事是反复序列化同一个没变的对象。改为按**载荷对象本身**缓存的 WeakMap
      （存**已切到 MAX_SCAN_CHARS 的串**，语义不变、内存上界 min(载荷, 200K)），安全前提是 `upsert*`
      **整体替换**字段而非就地改（引用变化即失效信号，不需要版本号）；`isTaskLike` 同样备忘。
      `ToolInvocationStore.list()` 去掉 `.sort`——`Map` 本就是插入序、`startedAt` 插入时打戳不改，
      两种序**按构造同一个**，那个排序是每次工具通知都付的 O(n log n) 空转。
      **刻意不加每会话容量上限**（原计划有一条）：`snapshotOf` 从本索引补水视图模型，淘汰一条记录仍在
      transcript 里的调用正好会渲染出 027 消灭掉的"空壳卡片"；安全上限要从宿主推入引用计数
      （与 `TranscriptStore.setLiveSessionIds` 对称），是独立改动——理由写在类注释里。
    - **044 工具路径并入 rAF 合帧 + 补掉 040 的自查缺口**：`toolCallView.update()` 末尾原本**同步**跑
      整条 transcript 的 `querySelectorAll`，而命令每输出一片就推一次更新；合帧器搬进**拥有**
      `refreshGrouping` 的 `toolCallView`，两条路径共用一份（`transcriptView` 留一层薄委派）。
      同时修 040 留下的**陈旧渲染缺口**：`bodySignature` 原用**字符串长度**判变化，同长度改写会跳过
      重建、把旧内容永久留在屏幕上 → 改为 FNV-1a 哈希（256K 以内 O(n)；超阈值返回 `null` 走 040 已建立
      的"无条件重建"逃生门，**语义永不退化**）。
    - **045 抽屉锚点扫描降 O(1)**：`outline.invalidate()` 在每个 append/revise 上都调 `syncButton()`，
      而它是遍历全条目列表；改为 `transcriptView` 维护 user 条目计数器（`place()` 是唯一新增入口，
      `patch` 从不改 `kind`，所以计数不会漂）。rail 早就是这么做的，抽屉是漏网的那一处。
    - **046 删掉常驻的 TEMP 诊断**：036/034 装的 `checkTextless` 等约 98 行，每新增一条记录就起 4 秒
      定时做**全量 getBoundingClientRect 走查**（未命中时还会反复测量，`dumpStructure` 还会跑
      `getComputedStyle`）。白条真根因 037 已修，这套只剩成本。**若白条复发：先量几何，不要先怀疑数据**
      （要用时按显式开关装轻量版，别让它常驻）。
  - **交互与无障碍（047-051）**
    - **047 键盘可达性**：标签 / 抽屉行 / 菜单项 / 斜杠项 / 工具卡头 / diff 头 / chip / 引导条点全部从
      `div`/`span` 换成真 `<button type="button">`——**Enter/Space 由浏览器原生触发 click**，
      所以委托式 click 处理器一行未改就同时支持键盘（比补 keydown 分支更不容易漏）。CSS 加"抹平 UA
      按钮样式"的基础设施（**必须放在各 class 规则之前**才保持外观一致）+ `:focus-visible` 焦点环
      （面板此前完全没有焦点样式）。标签栏补 `aria-selected` + roving tabindex + ←/→ + Delete；
      引导条同样 roving tabindex（标记可能几百个，逐个进 tab 序列会让 Tab 彻底失效）；
      `aria-expanded` 跟着卡头展开态；接上**从未被调用**的 `focusInput()`（文档获焦且用户未在选字时
      把光标放进输入框——否则 `acpc-chat.focus` 键绑定只完成一半）；打不开的 `resource_link`
      渲染成 `<span>` 而非 `<button>`（不能点就不该占 tab 停靠位）。
      **过程记录**：初版给 `.tab` 写了 `width: 100%`，而它是 flex 行子项——会解析成"容器内容宽的
      100%"而容器宽又由子项决定（循环），标签栏会变形；已摘出并写明原因。
    - **048 流式播报**：`#messages` 加 `role="log"` + `aria-live` + `aria-relevant="additions"`，
      并由 `transcriptView` 用**计数器**驱动 `aria-busy`（有任一条在流式就 busy，辅助技术推迟播报、
      结算后整段念一次）。直接加 `aria-live` 会让读屏把逐片重写的回答从头念几十遍。
    - **049 附件拖拽**：新增**会话作用域**消息 `attachPath`（守卫**之后**处理）；`text/uri-list`
      （VS Code 内部拖拽，主用例）+ `files[].path` 两级取路径，**两者都拿不到时明确发 error 通知**
      而不是静默；宿主侧把"加入待发附件 + 广播"抽成 `addAttachments` 共用，**拖拽路径刻意不 reveal
      任何 surface**（拖拽本就在可见面上）。粘贴图片暂不支持（剪贴板图是 Blob、无路径，落盘需要受管
      附件目录 + 清理策略，属另一功能）。**过程记录**：路径解析最初写成含转义斜杠的正则，被检查器报了
      一个位置完全对不上的语法错误——因为该检查器按**原始模板文本**解析、不还原转义（pitfalls #11 第四次
      复发）。已改成不含反斜杠的码点判断，并写成客户端纪律第四条。
    - **050 输入与观感**：①按会话记忆草稿（原先切会话 `input.value = ''`，切去另一标签看一眼就丢）；
      `stashDraft()` **必须在 `state.sessionId` 改写之前**调用，否则退场会话的草稿会记到入场会话名下；
      恢复也**只在真的换了会话时**做（对同一会话重设 value 会把光标移到末尾，而"重设同一会话"会发生）。
      ②编辑区面改用编辑器底色（标记里写 `<body class="surface-*">`，CSS 里**只有** `.surface-editor`
      的覆盖规则，侧边栏面不能加）。③`prefers-reduced-motion` 关掉 pulse/spin。
    - **051 代码块语言标签**：`SafeMarkdown.code` 早在输出 `data-lang`，界面从未用过。标签放左上角
      （右上角归 Copy）、`pointer-events: none`，**只有带语言的块**才让出顶部内边距（否则普通代码块
      凭空多一条空白）。**刻意不引入高亮器**——那要加依赖并改 CSP。
  - **清理（052）**：删零引用死代码（`dom.esc`+`ESCAPES`、`toContentViews`、`TranscriptStore` 的
    `sessionHasContent`/`listSessionIds`/`size`/`entriesNeedingMarkdown`、
    `ToolInvocationStore.dropAgentSessions`）——每处都先 grep 复核。`dom.esc` 删除处留了
    "**不要补回来**"的说明（通用转义助手是"用字符串拼 HTML"的邀请函）。
    `toolCalls.ts` 的 `statusGlyph`/`statusClass`/`kindLabel` **保留**（宿主侧拼写，将来的日志/树项会要）
    但加注释「**改一处必须改另一处**」并点明这正是 038 那类漂移的温床；`styles.ts` 的
    `.tab-dot.attention` **保留**并注明「设计预留、从未接线，看到没生效别当 bug 修」。
- **本轮自查出的 3 处缺口**（都已回写）：040 的长度签名（044 修）、049 的正则转义、以及各处被
  `check-webview-client.mjs` 抓到的模板反引号（后来做成了 `--fix`，见 058）。
- **验证方式**：`npm test` 全绿（本阶段 25 → 34 passing）；`check-registry.mjs` 六节全绿；
  `check-webview-client.mjs` / `tsc` / `lint` / `compile` 均通过。
  **人工验收**：`docs/dev-workflow.md` 清单 71-89（键盘路径、读屏、拖拽、草稿、语言标签、性能回归，
  以及"外观与改动前逐处比对"——按钮化最容易出问题的是内边距与对齐）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-042
- **功能**：拆分 `architecture.md`——把原 §5（新 Chat 面板子系统）移入 `docs/arch/chat-panel.md`
- **改动文件**：`CUSTOMIZATIONS/architecture.md`（539 → 244 行）、**新增** `CUSTOMIZATIONS/docs/arch/chat-panel.md`（332 行）、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`、`src/ui/chat/ChatEditorPanel.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/ui/chat/content/contentBlocks.ts`（后三者**只改注释里的引用路径**，无行为变化）
- **来源**：面板审计（阶段 1）顺带发现的机制违规——`architecture.md` 达 539 行，而它**自己在文件头写着**
  「**体量铁律**：超过 ~400 行即拆分——保留 §0 / §0.5 / §1，各模块细节拆到 `docs/arch/<module>.md`」。
  这条铁律的存在理由很具体：该文件被 `AGENTS.md` 列为每次任务前必读，**它每长一行就是每个会话都要付一次的上下文税**。
  （拆分的先例就在这个仓库里：`registry.md` 曾因为同样原因把 42KB 的变更日志拆到 `docs/changelog.md`。）
- **详细说明**：
  1. 原 §5 共 12 个小节（§5.1 文件职责 … §5.12 面板审计），313 行，**占全文 58%**，整体移入新文件。
  2. **关键决策：`§5.x` 的编号原样保留**。全仓库有几十处「§5.4」「§5.10」引用，散落在
     **代码注释**（`ChatEditorPanel.ts` / `ChatRouterProvider.ts` / `contentBlocks.ts`）、
     `registry.md`、`AGENTS.md` 里。重编号会把它们全部变成指向空处的雷，而拆分的目的是**省上下文**，
     不是整理编号。因此拆分只做「换文件名」，引用只需把 `architecture.md` 换成 `docs/arch/chat-panel.md`
     ——**这是本次拆分唯一需要小心的操作，也是它最容易被漏的一步**（注释里的引用不会被任何检查器发现）。
  3. 拆分的边界写在新文件头上：主文件保留 §0（架构图）/ §0.5（任务路由）/ §1（文件职责速查）/
     §2–§4（反查、链路、契约），即**「读到该改哪个文件」所需的全部**；
     按需加载的是**「改 `src/ui/chat/**` 时才知道要读的东西」**（为什么长这样、哪些不变量破了
     不会有任何自动检查报错）。下次再超 400 行时，§2–§4 是下一个拆分对象。
  4. `AGENTS.md` 的「文档更新职责」表加了指向：改 `src/ui/chat/**` 时除 `architecture.md` 还要看
     `docs/arch/chat-panel.md`。`registry.md` 的 `CUSTOMIZATIONS/` 目录清单补上 `docs/arch/chat-panel.md`。
  5. `.vscodeignore` **无需改动**：`CUSTOMIZATIONS/**` 已整体排除，新增的是其**子目录**而非顶层目录。
- **验证方式**：`check-registry.mjs` 六节全绿（exit 0）；`npx tsc --noEmit`（改了 3 个 `.ts` 的注释）；
  `npm run lint` 通过。人工核对：`grep -rn "§5" src/ CUSTOMIZATIONS/ AGENTS.md` 的输出里，
  除 `docs/arch/chat-panel.md` 自身与 `check-registry.mjs` 自己的「§5」（那指脚本的第 5 节，与本文件无关）
  以及 `docs/changelog.md` 的**历史条目**（append-only，按规矩不改写）外，全部已指向新文件。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-038..041（面板审计·阶段 1：正确性）
- **功能**：面板审计（逻辑/性能/交互/无障碍四面）后落地的**四条正确性修复**——保守档，可单独验收
- **改动文件**：`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/Outbox.ts`、`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/toolCallView.ts`、`CUSTOMIZATIONS/*`
- **详细说明**：
  1. **038 · 修「plan 卡永不更新」**：协议层的 `EntryPatch.plan` / `.content` 与**记录层的字段名**
     `entries` / `blocks` 不一致，客户端 `PATCH_KEYS` 照抄了协议层的名字 ⇒ patch 写进 `entry.plan`
     而 `buildPlan()` 读 `entry.entries`，**更新被静默丢弃**（`patch()` 对不认识的键不报错）。表现是
     Claude Code 的 Todo 列表永远停在第一次快照、切走再切回才对。四处统一到**记录字段名**
     （`types.ts` / `TranscriptStore.patch` / `ChatPanelHost` 的 plan 分支 / 客户端 `PATCH_KEYS`）；
     `content` 那条是**潜伏**缺陷（当时无调用点）一并改掉。**这类错位 tsc/lint/webpack 全看不见**
     （字符串字面量），已回写 pitfalls。
  2. **039 · 修 resource_link 走文件通道**：chip 此前一律写 `data-href` → 落到 `openLink` → 被协议
     白名单拦下，点本地文件只弹 Blocked link 警告。改为在**宿主侧** `contentBlocks.localPathOf()` 判定
     （`file:` 走 `node:url` 的 `fileURLToPath`；裸路径/相对路径原样；**Windows 盘符必须先于 scheme
     判定**，因为 `C:\x` 符合 URI scheme 的语法），客户端按 `path` / 可放行协议 / 两者都不是，分别渲染
     `data-path` chip / `data-href` chip / **静态 chip**（新增第三态：没有可用打开方式就不该长成可点的
     样子）。顺带把 `handleOpenFile` 解析相对路径的依据从 `this.focused.sessionId` 改为守卫校验过的
     消息 sessionId。
  3. **040 · 工具卡 body 单点构建**：两个同根缺陷——`render()` 与 `update()` **各写了一遍 body 构建**，
     于是 `locations` 在 update 路径既不会补上晚到的、还会被 `clear(body)` 清掉；`renderDiff` 每次以
     `body.hidden = true` 新建 ⇒ 用户展开的 diff 被下一次更新合上（而命令每输出一片就推一次更新）。
     抽出 `fillToolBody()` 单点构建 + `captureExpansion`/`applyExpansion` 按 `data-expand-key` 搬运
     展开态；加 `bodySignature` 跳过"只改了 head 里 status"的无谓重建。**签名刻意不序列化 payload**
     （图片的 data URI 是 MB 级）：遇 image block 返回 `null` = 不可缓存、宁可多建一次；非图片 block 把
     渲染函数读的**每个**字段纳入签名（漏一个 = 卡片永久陈旧，即 INV-H）。
  4. **041 · dispose 完整化 + outbox 单轮统计**：`ChatPanelHost.dispose()` 补上
     `sessionUpdateHandler.removeListener`（legacy provider 是注销的，此前只是碰巧被
     `SessionUpdateHandler.dispose()` 兜住）；`Outbox.stats()` 从累计改为**单轮**（新增 `resetStats()`）
     ——累计会让 `merged/sent` 漂向长期均值、那行诊断随时间失去意义。
- **验证方式**：`check-registry.mjs` 六节全绿；`check-webview-client.mjs` / `tsc` / `lint` / `compile`
  均通过。**人工验收**：plan 卡随 TodoWrite 实时刷新 / 本地文件链接能点开且危险协议仍被拦 /
  locations 晚到的工具卡有 chip / 展开的 diff 保持展开 / outbox 日志每轮从 0 重新计。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-035
- **功能**：历史会话按钮的图标由文字字形 `↺` 换成**时钟图标**（内联 SVG）
- **改动文件**：`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/sessionMenu.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「历史会话用这个 ↺ 图标合适，改成合适的」
- **为什么换**：`↺`（U+21BA）的通用语义是**撤销 / 刷新**，用在"打开历史会话"上会让人以为点了会重载当前会话。时钟是"最近 / 历史"最通用的形状。
- **实现**：复用 028 的内联 SVG 图标系统（`NS.icons`），新增 `history: [circle + hands]` 与 `historyIcon()`。**只用 circle 与直线**——按该文件既有的自定约束，弧线命令写错不会报错、只会画歪，所以宁可用基础图形拼。`sessionMenu.init()` 把按钮里预置的文字字形换成 SVG；**markup 里保留文字字形作为脚本失效时的兜底**（注释写明）。
- **顺带说明**：相邻的会话大纲按钮仍是文字字形 `☰`（三条横线）。两者都是单色线稿，视觉上基本一致；若希望严格统一，把 `☰` 也换成 SVG 只是一行（图标系统已经就位）——**本轮没动**，避免超出用户要求。
- **验证方式**：`check-webview-client.mjs` 通过（13 个客户端模块 + 19 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：标题栏出现时钟图标（14px，跟随主题色），与 `☰` 并排；hover 提示仍为 "Open a previous session"；点击行为不变。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-033
- **功能**：Chat 面板标题栏的历史会话选择器（↺），点一条即打开
- **改动文件**：`src/ui/chat/html/client/sessionMenu.ts`（新增）、`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/core/SessionManager.ts`、`src/extension.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「Chat Panel 上需加上查看/选择历史 Session 的按钮（只需处理 Claude Code 面板）」
- **数据源顺序（有讲究）**：**未连接时先用本地缓存**，因为 `SessionManager.listSessions` 内部会 `ensureConnected`——**为了渲染一个菜单而 spawn 一个 agent 进程**是不合理的；已连接时以 agent 侧列表为准（权威、且包含本窗口没见过的会话）。两者都排除**当前 live 的会话**（那些已经在标签行里了）。回复消息带 `source: 'agent' | 'local'`，浮层头部会写明来源，避免"为什么少了几个会话"的困惑。
- **打开方式收敛到一处**：新增 `SessionManager.openExistingSession(agentName, sessionId)`——优先 `session/load`（重放历史，面板因此有完整记录），退化为 `resume`（此时在面板里补一条 notice 说明"历史未重放"）。**`acpc.openSession` 命令改为调用它**，替掉原来内联的 caps 判断：两处各持一份决策迟早会漂移成"面板和树打开方式不一样"。
- **协议**：三条消息**都刻意不带 `sessionId`**（要用它们时往往根本没有聚焦会话），因此都在 `verifySession` 守卫**之前**处理——这正是 §5.4 规则二的适用场景。
- **非目标**：不做搜索/过滤、不做分页（agent 侧 `nextCursor` 先忽略）、不做跨 agent 的会话列表（面板只服务 modern agent）。
- **验证方式**：`check-webview-client.mjs` 通过（13 个模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：⑥ 标题栏 ↺ 拉出历史列表，头部写明来源与条数；⑦ 点一条 → `session/load` 重放，面板出现完整记录（`ACP Traffic` 里有 `session/load`）；⑧ 未连接时点 ↺ → 只列本地缓存、**不 spawn agent**（`ACP Traffic` 里没有 `initialize`）；⑨ Esc 关浮层不取消轮次。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-032
- **功能**：Chat 面板空态加「Connect Claude Code」按钮
- **改动文件**：`src/ui/chat/html/body.ts`、`src/ui/chat/html/client/sessionMenu.ts`（新增）、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「Chat Panel 上需加上连接按钮（只需处理 Claude Code 面板）」
- **行为**：空态（没连接 / 没聚焦会话）一键连接，不必先去 Agents 视图。走 `connectToAgent` 而**不是** `newConversation`——已有会话就聚焦它，没有才建一个：这才是"连接"该有的语义（`+` 按钮负责"开新的"，两者互补）。
- **agent 名怎么来**：消息不带 agentName（客户端在空态时无从得知），由 host 的 `panelAgent()` 兜底顺序决定：显式传入 → 聚焦 agent → `MODERN_AGENTS` 里的第一个。
- **已知硬编码**：按钮文案 `Connect Claude Code` 写死在客户端常量里（modern 面板按设计就是 Claude Code 专用）。若将来出现第二个 modern agent，这个字符串应当改由 host 下发——注释里写明了这一点。
- **验证方式**：`check-webview-client.mjs` 通过；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：① 未连接任何 agent 时面板空态出现按钮；② 点一下 → Claude Code 被拉起并出现一个新会话标签（`ACP Traffic` 里有 `initialize` + `session/new`）；③ 已有会话时点它 → 只是聚焦，不新建第二个。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-031
- **功能**：编辑区 Chat 面板**不再依赖侧边栏**——点侧边栏按钮直接打开，不再弹「Claude Code only」
- **改动文件**：`src/ui/chat/ChatEditorPanel.ts`、`src/ui/chat/ChatRouterProvider.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户实测反馈（截图：点 030 新加的侧边栏按钮弹信息提示），要求「点击后直接打开面板，先评估可行性」
- **根因（提示是误报）**：门禁判的是 `isModernAgent(context().agentName)`，而 `context()` 取**当前聚焦会话**的 agent。`activeSessionId` 为 null 时（**窗口重载后、或没点过任何会话**）它就是 null → 判 false → 弹提示。误导性来自状态栏：
  ```ts
  const agentName = activeSession?.agentDisplayName || connectedAgents[0];  // ← 没有活跃会话时退化成"第一个已连接的 agent"
  ```
  **状态栏写着 Claude Code 并不代表它被聚焦**（030 之后它恰好又排第一），所以看起来"明明就是 Claude Code 却被拒"。
- **修改（三处，缺一不可）**：
  1. `open()` 门禁：只在**存在聚焦 agent 且它不是 modern** 时拒绝——那才是这条门禁要防的情况（防止显示别的 agent 的陈旧内容）；**没有聚焦 = 放行**。
  2. `syncActivePanel()` 的关闭条件同步放宽：只在**聚焦到 legacy agent** 时 `close('focus-changed')`。**只改第 1 处不改这里会留下最坑的一种表现**：刚打开，下一次 `active-session-changed`（`panelIdForFocus()` 在无聚焦时返回 'legacy'）就把它关掉。
  3. 无聚焦会话时 `focusMostRecentModernSession()`：复用面板 agent 选择器那套逻辑（`getSessionIdsForAgent(name)` 取最近一个 → `focusSession`），打开即有内容。**刻意不自动建会话**——「打开面板」不该 spawn 一个 agent 进程；空面板是合法结果，面板里的 `+` 一键开新会话（024 已修）。
  另外 `open()` 在创建面板前会**重新读一次 context** 作为 boot 快照，否则会拿到自动聚焦之前的空上下文。
- **不变量改写**：§5.7 从「编辑区面存在 **⟺** 聚焦 agent ∈ modern」改为 **⟹**
  （「聚焦 agent **若有**」），并把"为什么无聚焦是安全的"写进文档——否则下一个人会照 ⟺ 把它改回去。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功；`check-webview-client.mjs` 通过。
  **待用户 F5 复验**：② 重载窗口后（不点任何会话）直接点侧边栏按钮 → 面板打开且**自带内容**（自动聚焦到 Claude Code 最近的会话，输出通道有 `no focused session; focusing Claude Code's most recent`）；③ 焦点切到非 Claude Code 会话 → 编辑区面板仍会**自动关闭**（这条不变量必须保住）；④ 完全没连接任何 agent 时点按钮 → 面板打开并显示空态，不弹提示。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-030
- **功能**：① 侧边栏 Agents 视图标题栏加「在编辑区打开 Chat 面板」按钮；② `Claude Code` 固定排到 agent 列表第一位
- **改动文件**：`package.json`、`src/config/AgentConfig.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「希望在左侧边栏（ACP Client）里加一个直接打开 Editor Area 区 Chat 面板的按钮」「左侧边栏，把 Claude Code 移到第一位」
- **① 侧边栏按钮**：`acpc.openChatInEditor` 此前只挂在 `acpc-chat` 视图的标题栏（025 加的）——那个视图在侧边栏里可能被折叠或滚出视野。现在也挂到 **`acpc-sessions`（Agents）视图**的标题栏（`group navigation@0`，最左），因为它在容器顶部、任何时候都看得见。同一个命令两处入口，不改代码。
- **② Claude Code 置顶**：agent 顺序来自 `acpc.agents` 的**键序**，而 `Claude Code` 原本排在 `GitHub Copilot` 之后，用户自建配置更容易把它排到后面。改两处：
  - `package.json` 的**默认列表**把 `Claude Code` 提到第一位（新装/未自定义配置时生效）；
  - `AgentConfig.getAgentNames()` 做一次**稳定**调整：只把主用 agent 提到最前，其余保持原顺序——**不做全排序**（那会打乱用户刻意安排的次序），这样即使用户覆盖了 `acpc.agents` 也仍然生效。
  与 `panelContract.MODERN_AGENTS` 是两件事（那个管「哪些 agent 用新面板」），取值相同但理由不同，刻意不合并。
- **验证方式**：`node -e` 复核默认列表顺序（`Claude Code | GitHub Copilot | …`）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：⑳ Agents 视图标题栏最左出现图标按钮，点击打开编辑区面板；⑴ 树里 `Claude Code` 在第一位。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260925-029
- **功能**：① 修复类型图标可能影响全局排版的风险（改为挂进气泡 + 写文本的两条路径保留它）；② 新增 webview → 输出通道的**日志桥**；③ 加一条"白条"TEMP 诊断
- **改动文件**：`src/ui/chat/html/client/icons.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/styles.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/ChatPanelHost.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户报告「问题更严重了，全变成了白条」——**这是一次回归报告，而我在 028 之后无法仅凭代码复现**，因此本轮做三件事：消除首要嫌疑、加可观测性、请用户回传一行日志
- **① 撤销布局改动（首要嫌疑）**：028 为了让助手的图标躲开"文本被整段重写"，把它挂到了**条目外层**并给 `.entry-assistant` 加了 `flex-direction: row`——**这是 028 里唯一会影响所有助手记录排版的改动**。现在改成：图标仍挂**气泡内**，由两条写文本的路径（`setStreamingText` 的整段替换分支、`setSanitizedHtml` 的 markdown 落地分支）用 `takeIcon`/`putIcon` **保留并还原**它。**不再有任何布局改动**——这既消掉了嫌疑，本身也是更稳的做法（图标位置与文本同源，不依赖条目结构）。
- **② 日志桥 `clientLog`**：webview 的 `console.warn/error` 与未捕获错误转发到 `ACP Client (Custom)` 输出通道（上限 50 条，防刷屏）。存在的理由：**webview 控制台不开 DevTools 就看不见**，而"界面为什么不对"的排查已经在这上面卡了两次（027 的空壳工具卡、本次的白条）。这是一条**永久**能力，不是临时补丁。
- **③ 白条诊断**：`hydrate` 结束时若**过半的非用户记录渲染后没有任何文本**，就打一条带 kind 直方图的 warn（经日志桥上到输出通道），例如 `hydrate: 38/40 non-user entries rendered without text (kinds: assistant:12,tool:26,thought:2)`。用户气泡充当对照组——报出正值即说明记录本身丢了内容，而不是"看起来空"。
- **非目标**：不猜白条的根因（已排除 CSS 括号失衡、非工具路径的代码改动、图标挂载点三处）；等诊断数据。
- **验证方式**：`check-webview-client.mjs` 通过（12 个客户端模块 + 18 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：① 助手/用户/推理/计划的图标都在且颜色跟随主题；② 助手气泡**宽度仍占满**、**流式输出时图标不消失**；③ **若仍出现白条**，输出通道里会出现 `chat-panel: client(warn): [acpc] hydrate: N/M non-user entries rendered without text (kinds: …)` —— **把这一行发我**，它就是答案；若没有这一行，说明渲染出来的记录其实**有**文本，那么"白条"另有来源（那时请顺手把 `#messages` 的头几条 `className` 发我）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-028
- **功能**：给每类记录加一个内联 SVG 类型图标（用户 / 助手 / 推理 / 工具 / 计划 / 通知）
- **改动文件**：`src/ui/chat/html/client/icons.ts`（新增）、`src/ui/chat/html/client/toolCallView.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户要求「参考图中（Claude Code 官方扩展的对话区），加个小图标标记不同类型的记录」
- **为什么是内联 SVG 而不是 codicon 字体**：webview 的 CSP 是 `default-src 'none'`，用图标字体要额外加 `font-src` 并把字体文件随扩展打包发布（还要动 `.vscodeignore`）；而 **SVG 元素不受 CSP 限制**——CSP 管的是 `<img src>` / 字体 / 脚本，不管文档内的 SVG 标记。`stroke="currentColor"` 还能自动跟随主题与所在文字颜色（用户气泡=按钮前景色、推理=次要色）。
- **挂载点是按「谁会被重写」选的**（这是本轮唯一容易做错的地方）：
  | 记录 | 图标挂哪 | 为什么 |
  |---|---|---|
  | 助手 | **条目外层** `.entry-assistant`（配 row 布局） | 气泡文本被流式更新整段重写，markdown 落地还会 `innerHTML` 覆盖——挂气泡里每片都会被抹掉 |
  | 推理 | `summary` | body 每片重写；`summary` 只在收束时重写一次，而那条路径已改成**保留 `.rec-icon`** |
  | 工具 | 卡头内（`toolCallView.render` 建） | 卡头从不整块清空（`update` 只改 status/kind/title 三个 span） |
  | 用户 | 气泡内 | 用户消息只追加不重写，最省事 |
  | 计划 / 通知 | `.plan-title` / 条目本身 | 计划重建时补挂（`attach` 幂等）；通知不重写 |
  | **不加** | `content` / `permission` | 前者已有图片/chip 形态，后者自带 `?` 角标——再加图标是噪声 |
- **非目标**：不做「按工具 kind 区分图标」（Read/Edit/Run…）——卡头已有 kind 文字标签，图标区分度收益有限，先看这版效果。
- **验证方式**：`check-webview-client.mjs` 通过（**12** 个客户端模块 + 18 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第八、九、十、十一次**复发（`icons.ts` 两处、`transcriptView.ts` 两处的注释）——全部由检查器一次报全。
  **待用户 F5 复验**：㊿ 每类记录左侧有图标且颜色跟随主题；助手气泡仍是**占满宽度**的（row 布局别把气泡压成内容宽度）；推理块**收束后图标仍在**（`Thought for Ns` 前面）；流式输出时助手图标**不消失**（这条专门验证挂载点选对了）；工具卡头有图标且状态色正确。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-25 - CUSTOM-20260924-026/027 + CUSTOM-20260925-034/036/037（「白条」问题：四轮迭代）
- **功能**：修掉聊天面板里成串的空白条 / 空盒子 / 空壳工具卡——并在第四轮找到**真根因**
- **改动文件**：`src/ui/chat/html/styles.ts`、`src/ui/chat/content/contentBlocks.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/html/client/`（transcriptView / toolCallView）、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈，四轮逐步收敛（每轮都带回了上轮诊断的日志或确定的复现步骤）
- **诚实说明（这一节最该先读的）**：四轮里 **037 才是真根因，而且从 011 起就存在**；
  026/027 修的是**真实但次要**的缺陷——它们解释的是"细窄无边框的白条"与"空壳工具卡"，
  而用户看到的大面积白条一直是 037。把这段留下来，是因为**下一个看到"界面是空的"的人，
  最该先量高度，而不是先怀疑数据**。
- **详细说明（按轮次）**：
  1. **026 · 成串空白条**（两种成因、两种外观，靠外观就能分辨）：
     - **细窄无边框** = `content` 记录。`agent_message_chunk` 文本为空时走 `postContentNotice`，而
       `toContentView({type:'text', text:''})` 返回的是一个**合法视图**（不是 null）→ 建出一条 `content`
       记录 → 渲染成空的 `.tool-text`（`margin: 3px 0`）。agent 把**空文本块当分片分隔符**发，所以成串出现。
     - **带圆角边框的空盒子** = `assistant` 气泡。工具调用后 agent 先发 `"\n\n"` 这类纯空白分片，此时上一条
       不是 streaming assistant，`appendAssistantChunk` 就**新建**了一条记录，气泡里只有换行；推理块同理
       （表现为一个**没有时长的 `Thought`**）。
     - 修法：`contentBlocks.ts` 新增 `isBlankText` / `hasVisibleContent`（判据排掉 `trim()` 能去掉的空白
       **以及零宽字符** U+200B..U+200D / U+2060 / U+FEFF——它们**不在** trim 范围内）；`postContentNotice`
       加守卫；`appendAssistantChunk` / `appendThoughtChunk` 加守卫（**合并进已有流式气泡仍然照旧**，段落
       换行就是这么来的，但不允许用空白文本**开启**新气泡）；客户端 `toolCallView.isBlank` 兜底。
     - **为什么不在客户端"把空块隐藏掉"了事**：那是把问题从记录层推到渲染层，记录里仍躺着一堆空条目
       （占 500 条上限的配额、让大纲/引导条多出无意义锚点、每次快照都要传输）。在**建记录之前**判断才是对的位置。
     - **本轮踩到的坑**（已回写 pitfalls）：想在正则字符类里写 `\u200b` 这样的转义，结果**工具链的转义层
       把它还原成了真字符**落进源码；改用 `node -e` 按码点定位时，shell 转义又把 `\s` 吃成了 `s`。最终改成
       **按码点判断、源码里一个反斜杠都不出现**，这类问题才根除。
  2. **027 · 空壳工具卡**：018 的注释自己写着「updateTool … can NEVER repair a shell」，但那次只给
     **append 路径**加了重建分支——而工具跑起来后绝大多数消息走 **`tool_call_update` → `updateTool`**，
     它**仍然只能打补丁**。于是卡片第一次落地时若没带上 view model，空壳永久留下。
     三层修法（**不赌数据在哪一侧丢**）：① `updateTool` 补上空壳重建分支；② 客户端 `place()` 遇到没有
     view model 的工具条目**不再渲染空壳**，改渲染一张由 `toolCallId` 拼出的最简卡片，并发一条**会话作用域**
     消息 `needToolView`，扩展侧 `resendToolView` **定向**回该面（自愈：不管数据在哪侧丢都能补回来）；
     ③ 索引里确实没有时记一行日志——**这正是以前查不出来的地方**（原来只有 webview console 的 `console.warn`，
     输出通道里什么都看不到）。顺带让 `update` 也能补 `.tool-kind`（占位卡的 "Tool" 要能变成真实 kind）。
  3. **034/036 · 诊断必须量几何，而且不能只在一条路径上跑**：
     - 034 把诊断从**只在 `hydrate` 跑**扩到实时会话（4 秒防抖 + `markdownRendered` 后）——
       **盯着一个实时会话的人永远不会触发 hydrate**，这正是用户上一轮查不到那行日志的原因。
     - 036 的**原理性修正**：上一版诊断数的是 `node.textContent`，而 **`textContent` 在元素被隐藏、裁剪、
       或处在 0 高度容器里时依然有值**——"文字在 DOM 里但没显示出来"它**永远抓不到**，而用户的截图恰恰是这种。
       判据改为 `getBoundingClientRect().height < 6px`（隐藏/裁剪的元素高度为 0，这是诚实的信号），
       并 dump 出前 8 条的结构（`kind | h | txt | cls | kid | fg | bg | fs | vis`）——有了颜色那一项，
       "文字色＝背景色"这类纯视觉故障也能一眼看出来。**这条比 bug 本身更值得记。**
     - 036 顺带修的真缺陷：`applyAssistant` 把 `html === ''` 当作"已渲染的 HTML"，于是 `setSanitizedHtml(bubble, '')`
       把气泡清空——**空字符串不是渲染结果**，现在回落到原始文本分支。（**这一条后来在 055 有了更深的解释**：
       `isBlankText` 的返回值是反的，见 055。）
  4. **037 · 真根因（CSS 规范，不是数据问题）**：**flex 子项的「自动最小尺寸」（`min-height: auto`）在其
     `overflow` 不是 `visible` 时等于 0**。而工具卡 `.tool` 恰好有 `overflow: hidden` ⇒ 没有最小高度保护
     ⇒ 内容一超出容器，flex 就把它们按比例压扁（用户那次是 206 张卡挤进 ~500px → 每张 2px，正好两条 1px 边框），
     卡片内容被 `overflow: hidden` 裁掉，`.messages` 的 `overflow-y: auto` 因此**永远不触发**。
     定性它的那行日志是：`[acpc] 206/207 non-user entries rendered shorter than 6px …  tool h=2 txt=201`
     ——**`txt=201` 而 `h=2`**：文字就在 DOM 里、可见性正常，但整张卡只有 2px。
     完整指纹（三条全部对上，也是"重开才坏"的原因）：
     | 元素 | overflow | 结果 |
     |---|---|---|
     | `.tool` 卡片 | `hidden` | 自动最小尺寸 0 → **被压成 2px = 白条** |
     | `.entry-user` / `.plan` | 无 | 自动最小尺寸 = 内容高度 → **压不动，显示正常** |
     | 新会话首次打开 | — | 条目少、不溢出 → 从不触发 |
     **修法**：`.messages > * { flex: 0 0 auto; }`（禁掉收缩），溢出改由 `.messages` 的 `overflow-y: auto` 承担。
     **对照**：`.tab-strip` 同样是 flex + overflow-x，但它的子项早就写了 `flex: 0 0 auto`（011 时写的），
     所以标签栏从没出过这个问题——**全项目只有 `.messages` 漏了**。
- **一套诊断最终被 046 删除**：白条真根因修掉后，`checkTextless` 那套常驻诊断（每新增一条记录起 4 秒定时做
  全量几何走查）只剩成本，已删。**若白条复发：先量几何，不要先怀疑数据**；要用时按显式开关装轻量版。
- **验证方式**：每一轮都过了 `check-webview-client.mjs` / `tsc` / `lint` / `compile`；
  最终由用户 F5 复验「关掉面板再打开那个 207 条的会话 → 所有工具卡正常展开显示、列表可滚动」。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-025
- **功能**：`acpc.openChatInEditor` 改为标题栏**图标按钮**（原来是一个宽文字按钮，与旁边的图标按钮对不齐）
- **改动文件**：`package.json`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈（截图圈出右侧边栏 chat 面板标题栏里的那个宽 Tip）
- **根因**：`contributes.commands` 少了 `icon` 字段。VS Code 在 `view/title` 的 `navigation` 组里**总是内联渲染**，命令带 `icon` 才是图标按钮，不带就退化成**文字按钮**——宽度、行高都跟旁边的图标不一致，这正是"对齐问题"的来源。同组的 `acpc.newConversation`（`$(add)`）、`acpc.attachFile`（`$(attach)`）都带了。
- **修法**：加 `"icon": "$(open-preview)"`（`open-preview` 就是 VS Code 内置的「在旁边打开预览」用的那个图标，语义最贴近"在编辑区打开"）。hover 的 Tip 由 VS Code 自动生成（命令 title + 快捷键），无需额外代码。
- **顺便查明（**没有改**）**：`view/title` 里还有三个命令没有 `icon`——`acpc.showLog` / `acpc.showTraffic` / `acpc.browseRegistry`。它们是**上游刻意留在 `...` 溢出菜单**里的次要操作；给它们加图标会把它们挤进标题栏、改变上游的布局，所以按"不动上游设计"处理。若哪天想让它们也上标题栏，加 `icon` 即可。
- **验证方式**：`node -e` 复核 `contributes` 里该命令含 `icon`；`check-registry.mjs` 六节全绿；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：㊽ 标题栏最左侧（`+` 之前）出现一个图标按钮，与旁边按钮等宽等高；hover 显示 Tip；点击能打开编辑区面板。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-024
- **功能**：修 Bug —— 标签行的 `+`（New Session）按钮点了没反应
- **改动文件**：`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/client/tabs.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户 F5 实测反馈（截图圈出 `+` 按钮）
- **根因（两个，都会表现成"点了没反应"）**：
  1. **主因：调错了 API**。`newSession` 分支调用的是 `sessionManager.connectToAgent(agentName)`，
     而 `connectToAgent` 的语义是「**已有该 agent 的会话就复用**」：
     ```ts
     const liveIds = this.getSessionIdsForAgent(agentName);
     if (liveIds.length > 0) { this.focusSession(liveIds[liveIds.length - 1]); return ...; }
     ```
     用户此刻正好有一个会话，于是「开新会话」退化成「聚焦那个已有会话」——UI 上完全看不出发生过什么。
     开新会话必须走 `newConversation` → `createSession`（010 引入的原子操作，也负责按需 spawn agent 进程）。
     **这是 011 起就存在的缺陷**，不是本轮引入的：`newSession` 消息从第一天就是这个实现，
     而 021/023 加的 ☰ 抽屉与引导条都绕开了它，所以一直没暴露。
  2. **次因：空焦点时点击被静默吞掉**。客户端是 `if (state.focusedAgent) { post(...) }`——
     把所有标签都关掉之后 `focusedAgent` 为 null，点击连消息都不发。
     现在退回 `state.sessions[0].agentName`；连一个会话都没有时不带 agentName 上报，
     由扩展侧回一条明确的提示（"No agent to start a session with. Connect one in the Agents view first."），
     而不是让用户对着一个没反应的按钮猜。
- **教训**：**"开新" 与 "连接/聚焦" 是两个语义**，`connectToAgent` 这个名字容易让人以为它总会建会话。
  项目里已经有专门的 `newConversation`/`createSession`，走它们才对。
  同类隐患的排查方法：搜 `connectToAgent` 的所有调用点，逐个确认它期望的是"复用"还是"新建"。
- **非目标**：不给 `+` 加"正在创建"的加载态（`createSession` 对已连接的 agent 只是一次 RPC，通常很快；
  真需要的话应该由 `session-created` 前后的状态驱动，另开一轮做）。
- **验证方式**：`check-webview-client.mjs` 通过（11 个客户端模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：㊺ 有会话时点 `+` → **真的多出一个新标签页**并聚焦到它（`ACP Traffic` 里能看到一次 `session/new`）；
  ㊻ 把所有标签关掉后点 `+` → 仍能建出新会话（走 `sessions[0]` 的 agent）；
  ㊼ 连一个 agent 都没连接时点 `+` → 对话区出现一条提示，而不是毫无动静。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-023
- **功能**：左侧引导条——照 Claude Code 官方扩展的对话区形态，每个执行步骤一个点、连成一条竖线，可点击跳转、当前项高亮
- **改动文件**：`src/ui/chat/html/client/rail.ts`（新增）、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户贴了官方扩展的截图，要求「参考下 claude code 官方插件的设计，在左侧放一个引导条」
- **与 021 的关系（不是重复劳动）**：参考图那条线是**按执行步骤**标的（每个 thinking / Write / Bash 一个点，当前那个是实心蓝点），回答的是「**这一轮干到哪一步了**」；021 的 ☰ 抽屉回答的是「**跨轮次回看某句话**」。用户确认两者并存。
- **形态**：两级——用户消息处是**大实心点**（轮次边界），其余记录（推理 / 工具 / 正文 / plan / content / notice / 权限卡）是**小空心点**（步骤）；一条竖线从首个标记连到最后一个。状态着色：`in_progress`/`pending`/流式 → 蓝（进行中），`failed` → 红，其余灰。
- **三个实现决策**：
  1. **引导条是 `.message-area` 的兄弟节点，不是 `#messages` 的子节点**。放进 `#messages` 会被两样东西咬：①那里的三档间距阶梯是 `.messages > * + *` 的 `margin-top`，会把绝对定位的引导条也位移；②它会被当成一个"条目"参与 flex 排版。改为兄弟节点 + track 做 `translateY(-scrollTop)` 与内容同步滚动，视觉完全一致而互不干扰。
  2. **布局读取分成两档**，这是性能上的关键：`invalidate()`（条目集合或状态变化）先比对**标记签名**，签名没动就完全不读布局——所以流式 chunk（同一 entry 反复 append）的开销是"一次字符串比较 + 一次 transform 写入"；`reflow()`（markdown 回填、窗口尺寸变化）只测量不重建。长会话里 500 个标记若每帧全量测 `offsetTop`，成本是毫秒级的，这条分档就是为了避开它。
  3. **点的尺寸/偏移放在 CSS，JS 只写 `top`**。`.rail-dot.turn` 与 `.rail-dot.step` 用 `margin-top: -半高` 抵消，于是 JS 写 `top = 入口节点 y + 6` 就正好是圆心——JS 里不必再算两套尺寸。
- **顺带修的一处**：`transcriptView.updateTool` 现在会把新的 view model 存回 `objects[entryId]`。原因：引导条按工具的 `status` 着色，而 `status` **不在 `PATCH_KEYS`** 里（那份白名单只覆盖 text/html/streaming/elapsedMs/plan/content/permission），不存回的话工具跑完了点还是蓝的。
- **非目标**：不做 hover 摘要浮层（改用原生 `title` 属性，零定位逻辑）；不做引导条的折叠/隐藏开关；不做"跳转到任意步骤"的键盘导航。
- **验证方式**：`check-webview-client.mjs` 通过（**11** 个客户端模块 + 17 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第六、七次**复发（`rail.ts` 与 `transcriptView.ts` 各一处注释）——同样由检查器一次报全。这已经是第 4 轮连续复发，只能靠检查器兜着。
  **待用户 F5 复验**：㊵ 对话区左侧出现竖线 + 点，用户消息处是大实心点、其余是小空心点；㊶ 有工具在跑时它的点是蓝色，失败是红色；㊷ 点任一点跳到对应步骤，滚动时高亮跟随；㊸ 长回复流式输出时引导条不卡顿（DevTools Performance 无长任务）；㊹ 与 ☰ 抽屉同时存在、互不干扰。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-022
- **功能**：长会话性能——流式消息合帧、增量文本追加、rAF 合帧、每会话滚动记忆
- **改动文件**：`src/ui/chat/Outbox.ts`（新增）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/scroll.ts`、`src/ui/chat/html/client/boot.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「chat 面板内对话可能会积累到很长，需要考虑超长对话的优化」。用户选的是**先做低风险高收益一批**（不做虚拟滚动、不做旧轮次折叠）。
- **四个具体病灶**（都是先量出来的，不是猜的）：
  1. **扩展侧每个 chunk 一次 postMessage**：`ChatPanelHost.onSessionUpdate` 的 `agent_message_chunk` 分支逐片发 `append`。一次长回复 = 几百条消息，每条都要 structured-clone。
  2. **客户端每次整段重设文本**：`applyAssistant` 是 `bubble.textContent = entry.text`，即每来一片就把**累积全文**重写一遍（一次回复是 O(n²) 的字符串与文本节点操作），随后 `scroll.follow()` 读 `scrollHeight` 触发强制重排。
  3. **`refreshSessions()` 每个 chunk 都跑**：于是每片都在客户端重建整条标签栏 + agent 下拉。**这一条的收益比 rAF 还大**，而且它顺带决定了合帧队列能不能真正攒住（见下）。
  4. **工具分组重排**（`toolCallView.refreshGrouping`）是整容器的 `querySelectorAll` 遍历，工具追加与每次更新都会跑。
- **① 合帧队列 `Outbox`**：按条目合并流式 append，攒一帧（16ms）再发。**只合并一种情况**——队尾是「单条 append」且 entry id 相同。之所以能只替换队尾：`TranscriptStore.appendAssistantChunk` 是**就地修改并返回同一个对象**，队列里那份引用天然带着最新文本，攒着不发不会丢内容，反而省掉中间态。
  路由表集中在 `ChatPanelHost.post()` 一处（按消息类型），因为**漏改一个调用点就会静默破坏顺序不变式**。
- **INV-A..F（写进 architecture §5.10，改这块前必读）**：
  - **INV-A** `revise` 不得越过创建它的 `append`——客户端 `patch()` 对未知 id 是**静默 no-op**，越过等于那条更新凭空消失。
  - **INV-B** `markdownRendered` 同理，只能按 FIFO 走。
  - **INV-C** `sessionsChanged` 不得延迟/合并——它驱动 Send/Stop 按钮，晚了按钮状态就是错的。
  - **INV-D** `sessionClosed` 不得延迟。
  - **INV-E** 每次 `boot`/`focus` 快照前必须先 `flush()`。
  - **INV-F** **只延后滚动、大纲 tick、工具分组重排**；`hydrate` / `append` / `patch` / `pending` 表 / `requestMarkdown` **一律同步**——`applyFocus` 里 `hydrate()` 之后立刻 `requestMarkdown()`，一延后 `pendingMarkdown()` 就是空的，markdown 整条链会静默失效（正是 012 修过的 P0 #1）。
- **② 增量文本追加**：新文本是旧文本前缀时 `textNode.appendData(delta)`，否则回落整段重设。回落（并清掉 tail 记录）的四种情况：首次/hydrate/reset、不是前缀（典型是 64KB 截断改了尾巴）、`entry.html != null`（**绝不能**往已渲染成 HTML 的气泡里追加裸文本）、宿主节点被替换。
- **③ rAF 合帧**：`NS.dom.schedule`（021 建的）扩展到滚动跟随与工具分组重排。滚动改成「消息任务里只写 DOM，下一帧只读一次 `scrollHeight` 再写 `scrollTop`」，读写分离。
- **④ 每会话滚动记忆**：`offsets[sessionId] = { top, pinned }`（**连贴底状态一起记**，否则贴底的会话切回来会停在半空）。
  **`hydrate()` 里那句无条件的 `toBottom()` 删掉了**——它是"功能做了但没生效"的典型来源：滚动位置的决策上移到 `applyFocus`（切走前 remember、hydrate 后 restore），留在 hydrate 里就会把恢复的位置立刻冲掉。
  markdown 回填会改变高度 → `markdownRendered` 后 `reassert()` 再对齐一次；用户一旦自己滚动就放弃恢复（用 `expectedTop` 区分程序写入与用户滚动）。`persistUi` 防抖落盘，**关掉再打开面板位置也在**。
- **验证方式**：`check-webview-client.mjs` 通过（10 个客户端模块 + 16 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  新增诊断日志：每轮结束时 `chat-panel: outbox sent=N merged=M queued=K`——`merged` 占比高说明合帧真的在工作。
  **待用户 F5 复验**：⑮ 让它输出极长回复 → 只有 1 个气泡、不丢字、DevTools Performance 无 >50ms 长任务、`merged` 比例高；⑯ 切走再切回 → 滚动位置与贴底状态都恢复，流式期间切走再切回不被重新贴底；⑰ 关掉再打开编辑区面板 → 位置还在；⑱ 发送后 `■ Stop` **立即**出现（签名去重没有延迟按钮状态）。
  **回归重点**：P0 #1（markdown 往返）、#2（只有 1 个气泡在增长）、#5（工具卡片切面后还在）——三者都在本轮改动的作用域内。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-021
- **功能**：会话大纲抽屉——标题栏的 ☰ 列出所有用户消息，点击跳转、当前项高亮
- **改动文件**：`src/ui/chat/html/client/outline.ts`（新增）、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/scroll.ts`、`src/ui/chat/html/client/dom.ts`、`src/ui/chat/html/client/boot.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/body.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「想给 chat 面板里的对话记录加一个导航栏（列出方便回看跳转对话记录）」
- **形态**：用户选的是**抽屉式目录**（而不是右侧迷你导航条）。锚点 = 每条用户消息；列表每行是「HH:MM + 首行摘要（≤80 字）」；超过 200 条时头部显示「… N earlier hidden」（会话记录上限是 500 条，最多约 250 个用户轮次，不做虚拟化）。
- **三个必须守住的点**（写进了代码注释与 architecture §5.9）：
  1. **顺序不能用 `Object.keys` 拿**。entry id 是字符串，而 `Object.keys` 的顺序保证只覆盖整数样式的键——顺序错了的表现是"点击跳到不相干的消息"，很难联想到根因。所以 `transcriptView` 新增显式 `order` 数组（`place()` 里 push、`reset()` 里清空）与 `ordered()/entry()/node()` 访问器，并在每个节点上打 `data-entry-id`。
  2. **布局读取只在 rAF 回调里做**。新增 `NS.dom.schedule`（一帧一次的回调队列），`scroll` 事件只置脏位；在 scroll 处理函数里读 `offsetTop` 会让每帧强制重排（这正好是 022 要治理的同一类问题）。高亮用二分查找缓存的锚点位置，`invalidate()` 后重建。
  3. **跳转不能把自己拽回底部**。`scroll.jumpTo(node)` 在写 `scrollTop` **之前**就 `pinned = false`，随后由 scroll 事件按真实距离重算——这样"跳到中间 → 后续分片继续流入"不会打断阅读；跳到最后一条时仍会正确重新贴底。
- **边界**：`Escape` 用**捕获阶段**监听并 `stopPropagation`——composer 在 textarea 上监听 Escape（取消轮次），不拦截的话关抽屉会顺手把正在跑的轮次取消掉。抽屉打开时点击外部关闭（与 composer 的菜单同款行为）。
- **非目标**：不做搜索/过滤、不做助手回合或工具调用的锚点、不做虚拟化（200 条上限足够，且不阻塞 022 的 B/C 期）。
- **验证方式**：`check-webview-client.mjs` 通过（10 个客户端模块 + 16 个模板模块）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **本轮实际踩到的坑**：反引号**第五次**复发（`scroll.ts` / `transcriptView.ts` / `styles.ts` 三处注释）——同样由 `check-webview-client.mjs` 一次性全部报出，没有变成难啃的 `TS1005`。评审结论不变：这条纪律只能靠检查器兜。
  **待用户 F5 复验**：⑪ ☰ 打开大纲、条目按轮次列出、点击跳转且高亮跟随；⑫ 流式输出中打开大纲能看到新轮次，跳上去**不会被后续分片拽回底部**；⑬ 跳上去后出现 `↓ Jump to latest`，点回底部并重新贴底；⑭ 输入框未聚焦时 Esc 只关抽屉、不取消轮次；⑮ 无用户消息时 ☰ 不显示。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-020
- **功能**：权限请求从「VS Code 窗口级 QuickPick」搬进聊天面板，成为对话里的一张卡
- **改动文件**：`src/handlers/PermissionBridge.ts`（新增）、`src/handlers/PermissionHandler.ts`、`src/core/ConnectionManager.ts`、`src/core/SessionManager.ts`、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/protocol.ts`、`src/ui/chat/transcript/types.ts`、`src/ui/chat/transcript/TranscriptStore.ts`、`src/ui/chat/html/client/permissionView.ts`（新增）、`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/client/links.ts`、`src/ui/chat/html/client/index.ts`、`src/ui/chat/html/styles.ts`、`src/extension.ts`、`CUSTOMIZATIONS/*`
- **来源**：用户反馈「选择界面需要改为在 chat 面板内提示（现在是在 vscode 顶部弹框提示，很难察觉）」
- **为什么不是"把 QuickPick 换成卡片"这么简单**：这条链上有**三条会挂死 agent 的泄漏路径**，上游实现一条都没堵。
  1. **SDK 侧对 `session/request_permission` 没有超时**（`grep setTimeout` 在 SDK 的权限路径上零命中）。所以"呈现不出来"绝不能静默——用户没看见 = agent 永远等下去。本轮的规则是：**能进面板就进面板，进不去才退回弹框，两条路都没有就说明有 bug**。
  2. **轮次被取消时必须把待决请求回答成 `cancelled`**。ACP 契约明写（SDK 文档注释）：会话被 cancel 时客户端必须结束待决的权限请求。上游 `cancelTurn` 只发 `session/cancel`，**从不解决那个 promise**——加了面板卡片后这个问题会立刻显形（卡片点不了、agent 卡住），所以本轮一并修掉。
  3. **并发请求**。上游是几个请求就弹几个 QuickPick，且标题里只有工具名，两个会话同时请求时无法分辨谁是谁。
- **设计：新增 `PermissionBridge` 作为唯一出口**。它不 import 任何 vscode UI 类型（只认 `PermissionPresenter` 接口），因为"ACP 响应 promise"的所有权属于 handler 层，而不是 UI 层。
  - `request()` 判定顺序：**自动批准分支（原样保留）→ 能进面板就发卡片 → 否则入全局 FIFO 队列，一次只弹一个**（队列化修的就是第 3 条问题）。
  - `answer(promptId, optionId?)`：未知/已解决/已 deferred 的答复一律拒绝并记日志——一个请求只能有一个答案，两个面同时点、双击、与弹框抢答都在这里被挡住。
  - `cancelSession` / `cancelAll` / `settle`：保证每个请求**恰好**被回答一次（第 2 条问题）。
  - `onPresenterLost()`：最后一条 surface 断开时把面板卡片降级为 `deferred` 并入队弹框。**这是 agent 不挂死的最后一道保险**——此时 store 仍在，所以卡片还会被更新成 `deferred`（按钮禁用 + 文案「Waiting for an answer in the dialog…」），但已经没有任何能点的地方了。
- **卡片本身**：transcript 第 8 种记录类型 `permission`，锚在**它所属的工具调用之后**；状态机 `pending → deferred | selected | cancelled`；`deferred` 时按钮**禁用**（避免与弹框形成第二条回答路径）。
  **安全**：`toolCall.title` 与 `option.name` 都是 agent 可控字符串，客户端一律用 `NS.dom.el(tag, cls, text)`（textContent），**不用 innerHTML**。
- **呈现策略**：`canPresent` 要求「是聚焦会话 + 是 modern agent + 有 surface」。聚焦会话是必须的——给非聚焦会话发卡片，客户端会按 `currentSessionId` 把它过滤掉，结果就是"agent 在等一个没人看得见的按钮"。surface 不可见（侧边栏收起 / 编辑区在后台标签）时会 `reveal(true)` 把它提到前面，但**不抢焦点**。
  已知取舍：待决期间切到别的会话，卡片仍在该会话的记录里，切回去即可回答（agent 在等，这是可发现的）。
- **顺带修掉的隐患**：`PermissionHandler` 提取出 `private quickPick(params, label)`，弹框标题现在带会话标识（`agentName · 标题`，未知会话退化为 sessionId）。
- **非目标**：不做权限超时（需要新配置项 + 「谁答的」语义，落点在 `PermissionBridge.request` 的注释里标了）；不给 legacy 面板做卡片（协议流量永不进旧面板，其对话内容在 webview DOM 里）；`acpc.turnInProgress` 上下文键仍未修（Escape 取消与 view/title 取消按钮仍是死的，见 pitfalls #5）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功；`check-webview-client.mjs` 通过（9 个客户端模块 + 15 个模板模块）。
  **本轮实际踩到的坑**：`permissionView.ts` 与 `transcriptView.ts` 的注释里写了反引号（pitfall #11 的**第四次**复发）——但这次是**检查器先把 tsc 的错误报了出来**（`[BACKTICK] transcriptView.ts:266`），而不是让人去啃 `TS1005` 的位置。017 把扫描范围扩到整个 `html/` 树的收益在这里兑现了。
  **待用户 F5 复验**：⑥ 权限请求 → 卡片出现在对应工具卡之后、两个面都有，在侧边栏点允许 → 编辑区卡片同步更新；⑦ 待决时关掉编辑区面板（侧边栏在别的 agent）→ 弹出 QuickPick，回答后卡片显示最终结果；⑧ 两个会话同时请求 → 弹框一次只出一个且各自标明会话；⑨ 待决时按 Stop/Escape → 卡片变 Cancelled，`ACP Traffic` 出现 `session/cancel` → `stopReason: cancelled`，agent 不挂死；⑩ 恶意标题 `<img src=x onerror=alert(1)>` → 显示为字面文本、不弹框。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-24 - CUSTOM-20260924-019
- **功能**：聊天面板支持在**编辑区**（编辑器标签页）打开，与侧边栏**并存**、共享同一份会话记录
- **改动文件**：`src/ui/chat/ChatSurface.ts`（新增）、`src/ui/chat/ChatEditorPanel.ts`（新增）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/ChatRouterProvider.ts`、`src/ui/chat/panelContract.ts`、`src/extension.ts`、`package.json`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户反馈「这个 chat 界面能支持移到编辑区吗（现在只能放左右侧边栏）」
- **背景（为什么必须新建面板）**：侧边栏的 `webview` 视图**在 VS Code 里无法被拖到编辑区**，也没有"声明式"的开关——编辑区承载 webview 的唯一途径是 `vscode.window.createWebviewPanel`（本仓库此前零处使用）。用户选择的是「并存、可随时切换」而不是「移动」，所以侧边栏 `acpc-chat` 视图保持不变（`acpc-chat.focus` 的 5 个调用点因此一个都不用改）。
- **为什么这件事成本很低**：新面板的 transcript 存在扩展宿主（`TranscriptStore`，见 011），与视图无关；`renderChatHtml(webview, nonce)` 的形参本来就是普通 `vscode.Webview`。所以第二个面是"再 attach 一次"，不需要第二份状态，也不会触发 `session/load` 重放。
- **核心抽象 `ChatSurface`**：把两种视图的差异收敛成三个成员（`visible` / `reveal(preserveFocus)` / `onDidDispose`）。**它解决的不只是类型问题**：旧写法 `this.view?.show?.(true)`（附件 chip 把面板提到前面）对 `WebviewPanel` 会**静默失效**——面板没有 `show` 方法，可选链吞掉了它，表现为附件不显示也不报错。
- **`ChatPanelHost` 的三条改动**：
  1. `private view` → `surfaces: Map<SurfaceKey, ChatSurface>`，新增 `attachSurface` / `detachSurface` / `attachedCount`；`attach(view)`/`detach()` 的对外签名不变（`IChatPanel` 契约与 LegacyPanelAdapter 都不受影响）；
  2. `post(msg, to?)` **默认广播**、可定向。广播是安全的：客户端本来就按 `currentSessionId` 过滤（`boot.ts` 七处），而两个面必须看到同一份时间线；
  3. **`ready` 的应答必须定向**（`pushBoot(from)`）。广播 boot 会让**另一个**文档被迫 `hydrate`（reset + 重建 + `toBottom()`），也就是"打开编辑区面板会把侧边栏的滚动位置重置"——这类 bug 静态检查看不出来。
- **不变量**：**编辑区面存在 ⟺ 聚焦 agent 属于 `MODERN_AGENTS`（目前只有 Claude Code）**。非 Claude Code 走 legacy 面板，而 legacy 的对话内容存在 webview DOM 里，换面渲染等于丢历史——所以 `open()` 直接给提示并拒绝，`syncActivePanel()` 在焦点跨出去时关闭面板。双向保证让这个中间状态不可达。
- **顺带修的隐患**：`syncActivePanel()` 原先第一行是 `if (!this.view) return`，即**侧边栏从未打开时，任何焦点变化都推不到聊天面板**。编辑区面板恰好是"没有侧边栏也能用"的场景，所以改成：侧边栏不存在但编辑区面板开着时，仍把 `PanelContext` 推给 modern host。
- **顺序铁律（代码里有注释）**：`createWebviewPanel` 之后必须**先注册** `onDidReceiveMessage` / `onDidDispose`，**再** `attachSurface`。反了会漏掉文档的第一条 `ready`，面板永久空白——与 architecture §5.4 的"消息被守卫丢掉"同属**无自动检查能发现**的一类故障。
- **非目标**：编辑区面板不支持非 Claude Code agent；不做窗口重载后的面板恢复（需 `registerWebviewPanelSerializer`）；不加 `editor/title` 菜单（其 `when` 需要 `activeWebviewPanelId` 上下文键，本仓库从未验证过该键，不引入没验证过的 `when`——`acpc.turnInProgress` 正是"声明了却没 setter"的前车之鉴）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功（`dist/extension.js` 内含 `acpc-chat-editor` 与 `acpc.openChatInEditor`）；`node CUSTOMIZATIONS/scripts/normalize-eol.mjs` 归一两个新文件（CRLF）；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿。
  **待用户 F5 复验**：① 面板打开时在侧边栏点会话标签 → 两个面同步切换、都渲染 markdown、都不重字；② 关掉编辑区面板再打开 → 完整记录回来，`ACP Traffic` 里没有 `session/load`；③ 面板开着时聚焦非 Claude Code 会话 → 面板自动关闭、侧边栏回到旧面板；④ 聚焦非 Claude Code 时执行命令 → 只弹提示、不开面板；⑤ 两个 webview 的 DevTools 里都能敲出 `window.__acpc`。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-018
- **功能**：Chat 面板块视觉体系重构 —— 推理块自动折叠 + 三级视觉层次 + 三档间距阶梯
- **改动文件**：`src/ui/chat/html/client/transcriptView.ts`、`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户 F5 实测反馈「不同段区分度太低」（截图里 6 段 `Thought for Ns` 连成一片灰字墙）
- **诊断出两部分问题，行为 bug 才是主因**：
  1. **推理块展开后永不折叠**：`buildThought` 里 `details.open = !!entry.streaming` **只在创建时设置一次**，收束时 `patch` 只改 summary 文字、**从未设 `open = false`**。旧面板有这个行为（正文一开始就折叠），本仓库重写时丢了。于是长推理链留下 N 个永久展开的块。
     **修法只需客户端一行**——扩展侧信号早就对了：`ChatPanelHost` 在正文开始时就调 `finalizeEntries(sessionId, { only: 'thought' })` 发出带 `streaming: false` 的 `revise`，只是没人消费。语义上恰好吻合：thought 收束的时机**就是**正文开始或轮次结束。
  2. **`thought` 是面板里唯一的"裸文本块"**：user/assistant 是气泡、tool/plan 是卡片，只有推理是"一条左侧竖线 + 灰斜体"，没有边界。后果是相邻两块的竖线在同一条 x 轴上只隔 12px、读起来是一根连续的线；且展开态与折叠态除高度外几乎无差别。
- **设计：确立三级视觉层次**（靠背景深度 + 边框强度 + 字号三重信号，而不是只靠一条竖线）
  | 层级 | 块 | 形态 |
  |---|---|---|
  | L1 主角 | user / assistant 正文 | 气泡（未改） |
  | L2 卡片 | tool / plan | 卡片（未改） |
  | **L3 轻卡** | **thought** | **折叠态：无背景、次要色、小字号的一行；展开态：淡背景 + 边框 + 圆角** |
  关键是让 L3 的折叠/展开形成**强对比**——折叠时几乎"消失"成一行，展开时变成有边界的浅色卡片。
  另加自定义折叠标记（隐藏原生 marker，用 `summary::before` 输出 ▸/▾）——原生三角在 Chromium 下太小且样式不可控。
- **三档间距阶梯**：`.messages` 的 `gap: 8px` → `gap: 0`，改用兄弟选择器按 `data-kind` 分档——同类相邻 2px / 跨类 10px / 用户消息前 16px。
  `data-kind` 由 `transcriptView.place()` 统一打（`hydrate` 走同一路径自动覆盖）。
  **一个必须注意的点**：`patch` 里 plan/content 分支走 `replaceChild` 重建节点，新节点没有 `data-kind`，已补设——否则那两类块的间距规则会静默失效。
- **顺带修复**：`styles.ts` 里 `.entry-content` 与 `.entry-notice.info` 两条 CSS 规则挤在同一行（早前一次编辑漏了换行），已拆开。
- **非目标**：不做推理段聚合分组（"推理 · 6 段 · 109s"）——自动折叠落地后连续推理本就只剩几行矮条，聚合收益不足以抵消 DOM 合并的复杂度。
- **验证方式**：`check-webview-client.mjs` 通过（14 模块扫描 + 反引号检查）；`npx tsc -p . --noEmit` 无错误；`npm run lint` 通过；`npm run compile` 成功。
  **待用户 F5 复验**：长推理后正文出现时推理块应自动收成一行；点开折叠块应看到淡背景卡片（与折叠态对比明显）；连续推理之间紧凑、推理→工具拉开、用户消息前留白最大；▸/▾ 正确切换；工具/plan 卡片与 assistant 气泡外观不受影响。
  **注意**：本改动在 v0.2.0-custom.2 打包**之后**，尚未进入任何 .vsix 产物。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-017
- **功能**：修复阻断级 bug —— 新面板加载遮罩「Loading session history…」常驻不消失
- **改动文件**：`src/ui/chat/html/styles.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/docs/pitfalls.md`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`
- **来源**：用户 F5 实测反馈（本仓库新面板的**首次真实运行**）
- **根因**：`hidden` 属性**不是魔法属性**，它依赖浏览器默认样式表里的 `[hidden] { display: none }`；而**作者样式表里的任何 `display` 声明都会覆盖它**——这与选择器权重无关，是「作者样式 > UA 样式」的层叠顺序。所以 CSS 里写了 `display: flex` 的元素，`hidden` **完全失效**。
  中招三个：`#loadOverlay`（本次症状，且它是 `position:fixed; inset:0; z-index:40`，**同时吞掉整块面板的点击**，输入框也点不了）、`#agentBar`、`#attachments`。
  **关键线索**：截图里遮罩**后面**的内容其实已完整渲染（Markdown 表格、代码块、工具卡片全在）——加载是成功的，问题在遮罩本身，这把范围从"加载逻辑"直接缩到了"遮罩显隐"。
- **修法**：`styles.ts` 的 `<style>` 顶部加一条全局规则 `[hidden] { display: none !important; }`，用 `!important` 把 `[hidden]` 的语义从被覆盖的状态抢回来。**不需要改任何 JS**，现有的 `.hidden = true/false` 赋值在规则生效后就是对的。注释里写明了"不要删"的理由与影响范围。
- **附带发现并修复的检查器缺口（值得单记）**：修 CSS 时我在 `styles.ts` 注释里又写了反引号（pitfall #11 的**第三次**复发），而 `check-webview-client.mjs` **报了 OK** —— 因为它当时只扫 `html/client/*.ts`，`styles.ts` 在上一级目录，**不在扫描范围内**。表现为 **tsc 报错、检查器说没问题**：一个专为防这类 bug 而写的工具，对范围外的同类 bug 视而不见。
  已把扫描范围扩到整个 `html/` 树（14 个模块）。扩范围后第一版立刻误报 13 处假阳性（把 TS 注释里合法的反引号也当错误），已改为**只在模板体内**报错。最后用负向测试在真实文件上确认：往 `styles.ts` 注入模板体内反引号 → 精确报 `[BACKTICK] styles.ts:17` 且 exit 1；还原后复检通过。
- **这是"静态检查全绿 ≠ 界面能用"的样本**：tsc / ESLint / webpack / 单测都不模拟 CSS 层叠，而本次首跑发现的唯一 bug 恰好是个纯 CSS 层叠问题。
- **验证方式**：`node CUSTOMIZATIONS/scripts/check-webview-client.mjs` 通过（14 模块扫描 + 8 模块拼接校验）；`check-webview-client` 负向测试确认能检出；`npx tsc -p . --noEmit` 无错误；`check-registry.mjs` 六节全绿。
  **待用户 F5 复验**：打开 session 时遮罩加载完成后消失、加载期间正常出现；只连 1 个 agent 时顶部无空白条；无附件时输入框上方无多余空隙；输入框可点击、Send 可用。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-016
- **功能**：文档去冗余——拆分账本、修掉一条不可用的机制规则、清理重复规则
- **改动文件**：`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/changelog.md`（新增）、`CUSTOMIZATIONS/README.md`、`AGENTS.md`、`CUSTOMIZATIONS/architecture.md`、`.agents/skills/acp-record-change/SKILL.md`、`.agents/skills/acp-merge-upstream/SKILL.md`
- **背景**：用户指出「`AGENTS.md` 里塞启动说明会增加每个会话的上下文」后发现的一类问题——**文档没有按「每会话必读」与「按需查阅」分层**。做了一轮独立审计（逐文件读、并与代码/脚本交叉核对），结果如下。
- **① 账本拆分（最大收益）**：`registry.md` 长到 **59KB**，其中**变更日志占 40KB**，而 `AGENTS.md` 把它列为每次任务前**无条件必读**——等于每次白读 40KB 历史流水。文件自己的头部写着"不必通读变更日志"，但一次 `Read` 调用会返回全部 345 行，**指引拦不住工具行为**。
  **拆法**：变更日志移到 `CUSTOMIZATIONS/docs/changelog.md`（42KB，按需）；`registry.md` 只剩 frontmatter + 仓库信息 + 改动总览（**18.5KB**）。
  `registry.md` 里**刻意保留了一行 `## 变更日志` 标题**作为指针——因为 `check-registry.mjs` 与 `list-custom.ps1` 都用它作为「总览表格扫描到此为止」的终止哨兵，保留即可让**两个解析器零代码改动**继续工作（已实测：`check-registry` exit 0、`list-custom` 正确报出 27 条总览条目）。
- **② 修掉一条不可用的机制规则（正确性问题）**：`README.md` 与 merge skill 都写着「新功能放 `CUSTOMIZATIONS/src/`」，但该目录**至今只有一个 `.gitkeep`**——它不在 `tsconfig.json` 的 `rootDir`/`include` 里、也不在 webpack 入口图里，放进去的 `.ts` **根本无法编译**（TS6059）。这是从 Electron 项目移植机制时没有适配 VS Code 语境的残留。已改为实际做法（新文件放仓库根 `src/` 下 + 文件头标记），并在 README 目录树处加了一段说明为什么该目录是死的。
- **③ 文档与实现不一致（正确性问题）**：`README.md` 声称是「唯一规则源」，但它的「**三种**无标记情形」表**少了第 4 条**——而 `check-registry.mjs:103` 实际在强制它（总览里记录"某上游值被刻意保留"的行必须含 `未改动`/`非改动`，否则报 `NO-MARKER`）。skill 里是 4 条、README 是 3 条。已补齐并把标题改成「四种」。
- **④ 重复规则收敛**：
  - merge skill 里**内联了一份 `acp.*` 残留 grep**，与 `check-registry.mjs` 的 `NS_PATTERNS` 各持一份——加一个模式就会静默跑偏。已改为「跑 `check-registry.mjs`，§3 就是这件事」。
  - 冲突策略表原在 README 与 merge skill 各一份（且优先级编号还不同）。已收敛到 README 一处，skill 改为链接。
  - `[CUSTOM-BEGIN]` 标记模板原在 AGENTS.md / README / record-change skill 三处。AGENTS.md 收敛为一行 + 指针。
- **⑤ `AGENTS.md` 减重**：147 行 → **121 行**。删除「项目结构速查」（与 `architecture.md` §1 重复且**已双向漂移**：一边写"唯一的测试"、另一边漏了 `nesting/`）；技术栈只留会破坏构建的两条（npm / webpack+ts-loader），其余移到 architecture.md §0；Git 分支表与构建命令压缩；补上两条**真正缺失的硬约束**——「`check-registry.mjs` 必须 exit 0」与「改完 `src/**` 要跑 `normalize-eol.mjs`」（后者是合并能力的命脉，此前只存在于按需文档 pitfalls #7 里）。
- **⑥ 过期事实修正**：`architecture.md` 里 `SessionManager` 的 "36KB"（实为 51KB/1312 行）改为不写死尺寸；`src/ui/chat/` 的模块数 25→28；"唯一的测试"补上 `nesting.test.ts`；本文件 013 条目里 `nesting/` 的 "3 个新增文件"→**2 个**（append-only 是指不删历史，不是指保留笔误）。
- **验证方式**：`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿；`powershell -File CUSTOMIZATIONS/scripts/list-custom.ps1` 正常输出（改动总览 27 条，未被日志干扰）；`normalize-eol.mjs --check` 通过；`AGENTS.md` 147→121 行、`registry.md` 59KB→18.5KB；章节结构完整性已复核。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-015
- **功能**：把启动/验收说明从 `AGENTS.md` 下沉到独立文档 `CUSTOMIZATIONS/docs/dev-workflow.md`
- **改动文件**：`CUSTOMIZATIONS/docs/dev-workflow.md`（新增）、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`
- **详细说明**：
  - **问题（用户指出）**：014 把三种启动方式、差异对照表、重载循环、验收清单全写进了 `AGENTS.md`，共 57 行。
    但 `AGENTS.md` 是**每个会话都会被加载**的 AI 硬约束摘要——这等于给所有与"启动测试环境"无关的任务
    加了一笔固定的上下文税。**要按"每会话必读"与"按需查阅"分层。**
  - **解法**：新建 `CUSTOMIZATIONS/docs/dev-workflow.md`（与 `pitfalls.md` 同级，属于按需查阅类文档），
    收录：三种启动方式 + 差异对照表（能否下断点）、`Ctrl+R` 重载循环、验收该看哪几个输出通道、
    判断当前是新面板还是旧面板、手动验收清单、常见问题。
    `AGENTS.md` 只留 **1 行指针**（顺带保留 `npm run dev:host` 这一条构建命令），57 行 → 4 行。
  - **顺带修掉一个悬空引用**：012 / 013 的变更日志里写着「见 Phase 3 计划 §4」的验收清单，
    而那份计划文件在 `~/.claude/plans/` 下、**不在仓库里**——一旦离开开发机器这份引用就断了。
    验收清单现已收录进 `dev-workflow.md`。**变更日志按机制只增不改，所以通过本条记录补上正确位置，
    不回去改写 012/013 的历史条目。**
  - **`AGENTS.md` 的文档更新职责表**新增一行：「改了启动/构建/验收流程 → `CUSTOMIZATIONS/docs/dev-workflow.md`」，
    让这条分层规则对后续的 AI 会话可见。
- **验证方式**：`AGENTS.md` 中该章节从 57 行缩减为 4 行（含指针）；`CUSTOMIZATIONS/docs/dev-workflow.md` 内容完整；
  `check-registry.mjs` 六节全绿；`normalize-eol.mjs --check` 通过（新文档为纯自定义路径 → LF）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-014
- **功能**：本地启动测试环境一条命令化（`npm run dev:host`）+ 把用法写进 `AGENTS.md`
- **改动文件**：`CUSTOMIZATIONS/scripts/dev-host.mjs`（新增）、`package.json`、`AGENTS.md`、`CUSTOMIZATIONS/registry.md`
- **详细说明**：
  - **背景**：手动验收要在命令行敲一长串
    `code --new-window --extensionDevelopmentPath="D:\...\custom-vscode-acp" "D:\...\custom-vscode-acp"`，
    还需要自己先记得 `npm run compile`。忘编译就会测到旧产物——这正是 Phase 2/3 那批"纸面验收"踩过的形状。
  - **为什么用 Node 脚本而不是把命令直接写进 `scripts`**：npm 在 Windows 默认走 cmd.exe、在 macOS/Linux 走 sh，
    `%CD%` 与 `$PWD` 互不通用，而 `--extensionDevelopmentPath` 需要**绝对路径**。
    本仓库已有同类先例——`check-registry.mjs` 从 bash 移植到 Node 就是为了消除 shell 方言差异（pitfalls #8）。
  - **脚本行为**：默认先跑 `npm run compile` 再启动（`--no-build` 可跳过）；把仓库根作为扩展路径与默认工作区
    （`npm run dev:host -- <目录>` 可换）；`code` 优先走 PATH，找不到再回退到 Windows 常见安装位置；
    **detached 启动**，所以 `npm run dev:host` 会立即返回而不是占住终端。
  - **踩到并修掉的一个 Windows 细节**：`shell: true` 是运行 `code.cmd` 的必需项，但 Node **不会**替我们给命令加引号——
    安装路径含空格（`C:\Program Files\…`）时会被拆成多个 argv。加了 `shellQuote()`，
    并**实测**过脚本（编译 → 定位 CLI → 启动 → 确认宿主窗口进程出现）。
  - **AGENTS.md**：把原来仅一行的「调试：按 F5」扩成《启动测试环境》章节——三种方式（`npm run dev:host` / 直接敲 code /
    F5）与差异对照表、`Ctrl+R` 重载循环、以及首次验收要开哪两个输出通道和 Webview Developer Tools。
    顺带修了两处因 Phases 1–4 而过期的描述：结构速查里的「test/ 唯一的测试」「ui/ 未提及 chat/」。
- **验证方式**：`npm run dev:host` 实测通过——webpack 编译成功、定位到 `code`、正确解析扩展路径与工作区、
  宿主窗口进程（PID 32108）确实出现；`check-registry.mjs` 六节全绿。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-013
- **功能**：Chat 面板重写方案 Phase 4 —— 子 agent 调用树（嵌套推断 + 分组 UI）
- **改动文件**：`src/ui/chat/nesting/`（2 个新增文件）、`src/ui/chat/ChatPanelHost.ts`、`src/ui/chat/transcript/{types,ToolInvocationStore}.ts`、`src/ui/chat/html/`（body/styles/client 三处）、`src/test/nesting.test.ts`（新增）、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/architecture.md`
- **前提说明（重要）**：**ACP 协议里没有子 agent 概念**——枚举 SDK 全部 239 个 schema 定义，`parent|subagent|delegate|nested|child|spawn` **零命中**，工具调用是只以 `toolCallId` 为键的扁平集合。因此**任何"树"都是事后推断**，推断依据是 agent 自定义的 `rawInput` / `rawOutput` / `_meta`（三者都是 `unknown`）。
  **Phase 0 探针 (b) 尚未执行**（需要真实 Claude Code 流量），所以本轮的判据是"可插拔 + 默认关闭 + 结果可区分"，而不是"猜对了键名"。
- **详细说明**：
  - **策略可插拔，默认是空实现**：`NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 按 `acpc.agents` 配置键分派。`flatNesting`（空实现）是**默认路径**而非兜底分支——对形状未知的 agent，扁平时间线是正确的，错的树比没有树更糟。目前只有 `'Claude Code'` 走推断。
  - **两级推断，显式优先**：
    1. **显式链接**：某个 Task 类调用的 `rawOutput` 或 `_meta` 里**出现了子调用的 toolCallId**。这是**与厂商无关**的判据——不需要知道键名叫什么，只要 id 出现在父的产出里就成立。它同时也是对探针 (b) 的防御：命中即为 `inferredParent: false`。
    2. **时序包含回退**：子调用的生命周期区间被父区间包住，取**最内层**（跨度最小）的父，标记 `inferredParent: true`。
  - **护栏（宁可漏连，不可错连）**：父区间须比子区间长 ≥ 50ms（否则同刻开始的调用会互相"包含"）；嵌套深度上限 3；**并列（跨度相同）时不连**；**只有 Task 类调用能做父**——因此 Task 可以挂在另一个 Task 下（子 agent 再派生），但普通 Edit/Read 不会被误归到某个 Task 下。
  - **`apply()` 是「先算后改」+ 迭代收敛**：单趟边改边算会让结果依赖遍历顺序，所以决策阶段完全不读本轮要改的字段。另外深度护栏读的是**上一轮**的深度，单趟会让一条全新的 5 层委派链全部连上（深度都从 0 开始）——因此迭代到定点，无嵌套时 2 轮收敛，否则最多 MAX_DEPTH+2 轮。
    这是本轮**自查发现的真问题**（最初版本深度上限形同虚设），单元测试里有一条专门钉死它。
  - **UI 的诚实性**：推断出的边带 `?` 角标 + tooltip（明说"ACP 没有嵌套概念，此链接由时序与产出推断而来，可能是错的"）。子卡片**保持按到达顺序**排布（考虑到链接本身是推断的，时间顺序才是诚实的排序），分组只做视觉处理：缩进 + 连接线 + 父卡片的「N steps」徽标；折叠父卡片会一并折叠其子卡片。会话头部有 `Sub-agents` 开关可切回完全扁平，偏好走 `vscode.setState` 存在 webview 本地。
  - **每次 tool 更新都重跑推断**：Task 的 `rawOutput` 往往在调用**结束时**才到达，而那正是显式链接变得可发现的时刻——所以推断必须可重入、自愈，并且只用真正变化的边去推送 `toolUpdate`。
  - **单元测试**（`src/test/nesting.test.ts`，11 条）：`isTaskLike` 判定、flat 策略是 no-op 且是未知 agent 的默认、Task 窗口内的调用被归组且标记为推断、**等跨度/并列/子早于父都不连**、`rawOutput` 里的 id 算显式链接、`_meta` 里的 id 同样、最内层优先且 Task 可嵌套 Task、深度不超上限、`apply` 幂等且只报告真变化、显式链接可**升级**已有推断链接。这是全项目最"猜"的一块，所以把行为钉在测试里。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；**`npm test` 14 passing（新增 11 条嵌套测试全绿）**；`check-registry.mjs` 六节全绿；`normalize-eol.mjs` 全部 CRLF。
  **待人工验证（需 F5 + 真实 Claude Code 流量）**：让 Claude Code 用 Task 起子 agent → 子卡片应缩进显示在父卡片下并带 `?` 角标；点 `Sub-agents` 开关应能切回扁平；折叠父卡片应连带折叠子卡片。
  **Phase 0 探针 (b) 的执行仍然重要**：若日志显示适配器提供了显式父子键，应删除时序启发式、只保留显式链接（`ClaudeCodeNesting` 的注释里已写明这一点）。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-012
- **功能**：Chat 面板重写方案 Phase 3 —— 修复首次审计出的 15 个缺陷 + 补齐功能缺口
- **改动文件**：`src/ui/chat/`（多个模块）、`src/handlers/TerminalHandler.ts`、`src/core/ConnectionManager.ts`、`src/extension.ts`、`CUSTOMIZATIONS/scripts/check-webview-client.mjs`、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/architecture.md`、`CUSTOMIZATIONS/docs/pitfalls.md`
- **背景**：Phase 2 交付的新面板通过了全部**自动化**检查，但**从未运行过**（F5 验收未做）。Phase 3 动手前做了一次独立代码审计——端到端逐条走查代码路径，不依赖运行环境——**发现 15 个缺陷，其中 5 个会让面板第一眼就不可用**。
- **P0 · 让面板可用（5 条）**：
  1. **markdown 渲染整条链是死的**（最严重）。`ChatPanelHost.onMessage` 在第二个 switch 前统一执行 `verifySession()`，而 webview 发来的 `renderMarkdown` / `copy` / `openLink` 按协议设计**本就没有顶层 `sessionId`**，全部在守卫处被丢弃。后果：助手气泡只显示原始 markdown 文本，代码块/加粗/列表/表格都不渲染，复制按钮与链接也不存在。修法：把这四类消息移到守卫**之前**（`renderMarkdown` 本就逐条校验 item 的 sessionId）；另给客户端 bridge 加 `postForSession()`，补上 `openFile` / `openTerminal` 缺失的 `sessionId`。
  2. **流式路径逐 chunk 调 `finalizeStreaming`** → 一次回复碎成 N 个气泡。该方法会把**所有** streaming 条目标记结束，于是 `appendAssistantChunk` 每次走新建分支。修法：给 `finalizeStreaming` 加 `only` 过滤——正文开始时只收束 **thought**，`tool_call` 到达时只收束 **assistant**，轮次结束才全部收束。
  3. **客户端 `append` 非幂等** → 重复 DOM 节点。扩展侧对「就地改写的同一条目」重复发 `append`，客户端无条件 `appendChild` 并覆盖映射，旧节点成孤儿。**与第 2 条是同一处症状的两半，只修一个会从「碎泡」变成「重复泡」**。修法：`append` 先查 `objects[id]`，已存在则走 patch。
  4. **编辑器收不到 running/loading** → 没有 Stop 按钮，且等待中再点发送会**清空 textarea 并丢失草稿**。根因有二：客户端 `sessionsChanged` 只喂给标签行；扩展侧 `refreshSessions()` 在 `await sendPrompt` **之前**调用，那时 `inFlightTurns` 尚未置位。修法：客户端按聚焦会话同步 `setRunning/setLoading`；扩展侧改为「先启动 promise → 再 refresh → 再 await」（`sendPrompt` 的置位发生在第一个 await 之前）。
  5. **工具卡片切会话后变空白**。`TranscriptStore.snapshot()` 的 tool 条目不含 `toolView`，而它只在实时 append 路径挂过一次，且后续 `tool_call_update` 也救不回来（更新函数只改标题/状态/正文，占位框里一个都没有）。修法：`snapshotOf` 用 `ToolInvocationStore` 回填 `toolView`。
- **P1 · 功能补齐（5 条）**：
  6. 思考块永远停在 "Thinking…"（第 2 条的连带修复：收束后必须 post `revise`，否则 webview 那份条目仍是 `streaming: true`）。
  7. `PromptResponse.usage` 与 `stopReason` 被丢弃。改为：非 `end_turn`/`cancelled` 的结束原因追加 notice（`refusal` 尤其重要——ACP 规范明说该轮内容不会进入下一次 prompt，UI 必须反映）；`totalTokens` 归一到 usage 条的 `used`，让只在轮次响应里报 usage 的 agent 也能显示。
  8. 非文本内容块退化成 `[image content]` 占位。新增 transcript 条目类型 `content`，复用已在工具调用路径上验证过的 `ContentBlockView` 渲染（把它从 `toolCallView` 暴露为 `renderContentItem`）。
  9. `plan` 每次更新堆一张新卡片。ACP 的 `plan` 是**整体替换**语义，改为按会话记住唯一条目 id 并走 `revise`。
  10. **终端输出没有数据通路**（跨三个文件）。`TerminalHandler.terminals` 私有且 `terminalOutput()` 对未知 id 抛异常；`terminalHandler` 只是 `connect()` 里的局部变量，`ConnectionInfo` 未暴露——面板连拿都拿不到。修法：新增只读 `readOutput()`（未知 id 返回 `null`）、`ConnectionInfo` 加 `terminals` 字段、面板读输出后作为 content 条目追加。
- **P2 · 清理（6 条）**：删除死协议分支（`sessionOpened` 从未发出、`readSessionId` 无人引用），并补发 `sessionClosed` 让客户端的关闭分支变成活代码；`error` 消息按 sessionId 过滤（后台会话的报错不再落到前台）；`reset()` 补清 `sessionId`（残留会让 markdown 批量请求带错 id 而被静默丢弃）；附件并入 `SessionMeta` 随 focus/boot 下发（原先切标签后 chip 消失但扩展侧仍在发送）；`patch` 的写入键收窄到 `EntryPatch` 的已知键；**确认文案改为「当前会话保留在它的标签中」**（用户决策：多会话下新建只是开标签，原文案与实现不符）。
- **机制增强**：`check-webview-client.mjs` 新增**模板体内反引号检测**。本 Phase 改 `boot.ts` 时**第二次**踩中同一颗地雷（模板字符串内部的 JSDoc 用了反引号），而现有检查器当时只能在拼接后报语法错误、tsc 只给出难以定位的 TS1005。现在直接报 `[BACKTICK] file:line` 并 exit 1，已做负向测试确认（见 pitfalls #11）。
- **验证方式**：`npx tsc -p . --noEmit` 无错误；`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；`npm test` 3 passing；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 六节全绿；`normalize-eol.mjs` 全部 CRLF；`check-webview-client.mjs` 反引号检测负向测试可检出。
  **待人工验证（需 F5，尚未跑）**：见本文件的 Phase 3 计划 §4 —— P0 六条验收（markdown 渲染/单气泡/思考计时/Stop 按钮/工具卡片保活/diff 展开）+ P1 四条 + 八个敌意 markdown 向量 + 旧面板回归。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-011
- **功能**：Chat 面板重写方案 Phase 2 —— 面板路由层 + `src/ui/chat/` 模块骨架（新面板先用于 Claude Code）
- **改动文件**：`src/ui/chat/`（25 个新增文件）、`src/extension.ts`、`CUSTOMIZATIONS/scripts/`（新增 `check-webview-client.mjs`、修 `normalize-eol.mjs`、`check-registry.mjs` 加 §5）、`CUSTOMIZATIONS/registry.md`、`CUSTOMIZATIONS/docs/pitfalls.md`、`CUSTOMIZATIONS/architecture.md`
- **方案来源**：`C:\Users\zouwei\.claude\plans\dazzling-dancing-pancake.md`（用户已批准）。Phase 1（多会话核心改造）已在 CUSTOM-20260923-010 落地。
- **详细说明**：
  - **路由方式（单视图，经用户拍板）**：视图 id 仍是唯一的 `acpc-chat`，`package.json` **完全不动**，不引入 view 级 `when`、不用 `setContext`。`ChatRouterProvider` 按「聚焦会话所属的 agent」在 `ChatPanelHost`（新）与 `LegacyPanelAdapter`（旧）之间切换。
    否决「双视图 + when 条件显隐」的理由：`acpc-chat.focus` 有 **5 个调用点**（`extension.ts` ×4 + `SessionTreeProvider` 的 `AgentTreeItem.command`），单视图下全部无需改动；侧边栏也不会出现两个聊天入口；且能避开本仓库从未成功用过的 `setContext`（`acpc.turnInProgress` 恒不成立就是前车之鉴）。
  - **让旧面板零改动的关键手法（本 Phase 最有价值的一步）**：`LegacyPanelAdapter` 递给 `ChatWebviewProvider` 的不是真实 `WebviewView`，而是一个 **facade**。已逐点核实旧 provider 对 `WebviewView` 的接触面只有 6 处（`options` / `html` / `cspSource` / `onDidReceiveMessage` / `postMessage` / `onDidDispose` + `show`），facade 完全够用。**`src/ui/ChatWebviewProvider.ts` 一行未改**，上游合并时该文件零冲突。
    facade 的 `onDidReceiveMessage` / `onDidDispose` **刻意不转发**给真实视图，只存回调——真实视图上必须只有路由层那一个监听器，否则旧 provider 会同时经路由分发与直接订阅收到两条消息而重复处理。
  - **扩展侧 transcript（切面板不丢内容的关键）**：`TranscriptStore` 按会话存结构化记录（而非 DOM 字符串），三重上限（500 条/会话、24 会话 LRU、64KB/条），活跃会话豁免 LRU。面板隐藏时记录照常累积，`postMessage` 被守卫丢弃；切回只需推一次快照，**不需要重新 `session/load`**。
  - **webview 无框架、无新构建步骤**：`html/` 下把 HTML 骨架 / CSS / 客户端 JS 拆成模块，编译期拼接进同一个 `<script nonce>`。webview 内没有模块系统（CSP 只允许带 nonce 的内联脚本），每个客户端模块是 IIFE，统一挂到 `window.__acpc`。
  - **markdown 消毒（零新依赖，安全由构造保证）**：实测确认 `marked` v15 默认 renderer 的 `html()` 原样返回原始 HTML、`link()` 只做 `cleanUrl` 不做协议白名单（`[x](javascript:alert(1))` 直通）。`SafeMarkdown` 覆盖 `html`/`link`/`image` 三个钩子：原始 HTML 转义为字面文本（无损且惰性），非 `https?`/`mailto` 的链接降级为纯文本，图片渲染为 chip。另在客户端用 `DOMParser` + 标签/属性白名单兜底。**必须用 `new Marked(...)` 而非 `marked.setOptions(...)`**——旧面板改的是全局单例，共用会互相污染。
  - **CSP 变化**：新面板加了 `img-src ${cspSource} data:`（非文本 ContentBlock 的 base64 图片），`script-src` 仍**只有 nonce**、无 `'unsafe-inline'`。
  - **协议从第一天起就是 session 作用域的**：所有会话相关消息都带 `sessionId`，扩展侧 `verifySession()` 校验其对应会话存在，不匹配一律丢弃并记日志——绝不静默落到「当前聚焦会话」上。
- **顺带修掉的机制缺口（本 Phase 发现）**：
  - `normalize-eol.mjs` 用 `git ls-files`（**只列已跟踪文件**），新建未提交的文件会静默绕过 CRLF 检查。实测：修复前对 25 个 LF 新文件报「所有文件已是 CRLF，无需修正」。已改为 `--cached --others --exclude-standard`（见 pitfalls #10）。
  - 新增 `check-webview-client.mjs` 并接入 `check-registry.mjs` **§5**：把 webview 内联客户端脚本抽出拼接后交给 `new Function()` 做**语法校验**。起因是模板字符串里的两类只在运行时才炸的错误（内部出现反引号、反斜杠忘记双写）——本 Phase 就实际踩中一次（`boot.ts` / `toolCallView.ts` 的 JSDoc 里用了反引号，tsc 只报出难以定位的 TS1005）。已用负向测试确认该检查器能检出并返回 1。
  - `check-registry.mjs` 新增 **§6 源码卫生**：扫描 NUL 等控制字符。起因是 `ChatPanelHost.ts` 的注释里被写入了 2 个**字面 NUL 字节**，导致 `grep` 把源文件当**二进制**跳过——搜索静默失效（见 pitfalls #12）。同一轮里检查脚本自己也曾把字面控制字符嵌进正则，故 §6 改为**按码点判断**而非字面正则。
- **明确非目标**：旧面板的既有缺陷（附件失效、工具调用零详情、`in_progress` 无样式、滚动抢占、无复制按钮、链接不响应）**不在旧面板里修**——那是上游合并冲突的主要来源。它们在新面板里重做。
- **验证方式**：`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；`npx tsc -p . --noEmit` 无错误；`node CUSTOMIZATIONS/scripts/check-webview-client.mjs` 8 个客户端模块拼接后可解析；`node CUSTOMIZATIONS/scripts/check-registry.mjs` 五节全绿；`normalize-eol.mjs --check` 全部 CRLF。
  **待人工验证（需 F5，尚未跑）**：连 Claude Code → 出现带标签行的新面板；连 Gemini CLI → 旧面板；经树切回 → 新面板且 transcript 完好；`package.json` 仍只有**一个** `acpc-chat` 视图且无 view 级 `when`。
- **基于上游版本**：0.2.0（commit e7371659）

### 2026-09-23 - CUSTOM-20260923-010
- **功能**：核心改造——「单活跃会话」模型改为 **N 进程 × M 会话**（Chat 面板重写方案的 Phase 1）
- **改动文件**：`src/core/SessionManager.ts`、`src/core/AgentManager.ts`、`src/core/SessionHistoryStore.ts`、`src/extension.ts`
- **详细说明**：
  - **背景**：上游假设同一时间只有一个已连接 agent、一个会话。这个假设散落在四处：
    (a) `activeSessionId` 唯一；(b) `agentSessions` 是 `Map<agentName, sessionId>` 1:1 映射；
    (c) `connectToAgent` 主动断开前一个 agent；(d) `newConversation` 走 disconnect → reconnect。
    协议本身**没有**这个限制——ACP 的每个请求/通知都带 `sessionId`，SDK 的 `SessionId`
    文档注释明写"允许与同一个 agent 有多个独立交互"。所以改造全部落在实现层，不动协议。
  - **顺带修掉的两个真 bug**（都是审查中发现的，非本次改造引入）：
    ① **进程泄漏不可回收**：`loadSession`/`resumeSession` 会把同 agent 的旧会话从
    `sessions`/`agentSessions` 里删掉**但不杀它的进程**；而 `disconnectAgent` 在
    `agentSessions` 查不到条目时**提前返回**，于是泄漏的进程再也无法通过任何公开 API 回收，
    同时 `getConnectedAgentNames()`（由 `agentSessions.keys()` 派生）也不再报告它。
    现在 `agentProcesses` 是独立索引，`disconnectAgent` 一律回收。
    ② **EventEmitter 监听器泄漏 + 盲区**：`connectToAgent` 每次调用都注册一对新的
    `agent-error`/`agent-closed` 监听器且**从不移除**（Node 在 10 个以上会告警）；
    反过来 `ensureConnected` 路径**完全不注册**，该路径创建的会话没有错误/退出处理。
    现在改为构造函数里唯一一次订阅，靠 `agentProcessNames` 反查 agent 名分发。
  - **设计要点**：**一个 agent 名只对应一个进程**，进程内承载 M 个会话。这是有意简化——
    `SessionHistoryStore` / `SessionTreeProvider` / `AgentConfig` 全都假设 `agentName → agentId` 唯一。
  - **控制面串行化**：`enqueueControl()` 仅包裹 `session/new` / `load` / `resume` / `close`。
    `prompt` **刻意保持并发**（那是本功能的意义）。同一连接上「一边流式输出一边建新会话」是否
    可行尚未实测（见 `CUSTOMIZATIONS/src/phase0-traffic/` 待补的探针 (c)），这层队列在两种情况下
    都无风险：并发成立时开销是微秒级，不成立时正好避免跨会话卡死。
  - **兼容性**：事件契约**只追加尾参、不改名**，`SessionTreeProvider` 与 `StatusBarManager`
    只消费 `getActiveSessionId()`/`isAgentConnected()`，零改动即可继续工作。
    `ChatWebviewProvider.ts` **一行未改**。
  - **行为变化（需注意）**：`isAgentConnected` 现在会为「已探测但无会话」的 agent 报告已连接
    （上游只认 `agentSessions`）——这是修复，但树上会因此亮绿灯。
- **验证方式**：`npm run lint`（`--max-warnings 0`）通过；`npm run compile` 成功；
  `node CUSTOMIZATIONS/scripts/check-registry.mjs` 四节全绿；`normalize-eol.mjs` 仅 `SessionManager.ts`
  需回写 CRLF（Write 工具产出 LF，已修正）。
  **待人工验证（需在 Extension Development Host 中执行，尚未跑）**：连跑三次 `acpc.newConversation`
  → 流量日志应只有**一次** `initialize`、三次 `session/new`、任务管理器只有一个 node/npx 子进程；
  `acpc.openSession` 打开另一个会话 → 不出现 `agent-closed`；重跑原泄漏路径 → 旧进程仍存活**且**
  可被 `acpc.disconnectAgent` 回收
- **基于上游版本**：0.2.0（commit e7371659）

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
