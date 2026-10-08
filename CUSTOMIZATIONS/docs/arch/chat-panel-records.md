# Chat 面板 · 记录区（折叠 / 时间 / 内容渲染 / 右键菜单）

> **这是什么**：`docs/arch/chat-panel.md` 的**继续拆分**（CUSTOM-20260925-068 之后，2026-09-26）。
> 主文件到 396 行、贴着它自己那条「超过 ~400 行即拆分」的线，而**记录区**这一块正在长——
> 于是有了这个文件。
>
> **为什么是"记录区"**：它管**一条记录长什么样、能不能折、要不要显示时间、内容怎么渲染、
> 右键给什么**。与主文件的边界很清楚：主文件管面板骨架（surface / 路由 / 协议纪律 / 权限卡 /
> 引导条 / 性能不变式），这里管**记录本身**。
>
> **§5.x 编号继续沿用主文件那一套**（本节从 §5.16 起），所以引用只需换文件名，不必重编号。
>
> **配套**：面板骨架与消息纪律见 [`chat-panel.md`](./chat-panel.md)；
> 会话目录与重开路径见 [`chat-panel-sessions.md`](./chat-panel-sessions.md)。

---

### 5.16 记录的折叠（Thought / 用户消息）与 INV-J

**两条记录可以折叠**：`thought`（推理块）与**多行**用户消息。两者共用同一套形态：`<details>` +
`<summary>`（标签）+ 内容体。

| 关注点 | 规则 |
|---|---|
| 折叠三角 | **真元素 `.fold-caret`，不是 `summary::before`**——伪元素永远画在内容之前，而类型图标是 `prepend` 到 `summary` 的，用伪元素会把三角挤到图标**左边**。正确顺序 `[图标][三角][标签]` 靠"先建三角、图标再 prepend"**按构造**得到。三角本身是空的：字形与方向由 CSS 依 `details[open]` 驱动 ⇒ **切换不需要 JS** |
| 重写 summary 时 | **保留所有元素子节点**（只丢文本与 `.thought-spin`）。按名字逐个列（旧写法只列 `.rec-icon`）会在新增挂件时**静默丢掉它** |
| 用户消息的切分 | **首行在 `summary`、其余在 `body`**（**不**重复全文，否则展开时文字两遍）；**默认展开**（刚发的消息不该被藏起来）；**折叠控件每条都有（113）**——单行消息不是"没有可折的东西"：它在更窄的宽度下会折行，而折叠态的 summary 不折行，那时折叠是真的动作。单行时 body 为空 ⇒ **不生成 `.fold-body`**（见下） |
| **触发条件（071，取代 064；113 去掉"单行退回气泡"）** | 判据是**实测渲染行数**，不是任何字符特征：先建出真正会渲染的 `<details>`（caret 与图标都在，宽度才对）、插入 DOM，再用 `Range.getClientRects()` **只框住文本节点**数行盒（`height > 0` 的矩形个数；行长边界会多出一个零高矩形），多于一行才**切分**；只有一行就把**全文留在 summary**、body 为空（**控件保留**，这是 113：单行消息在更窄的宽度下会折行，那时折叠是真实动作）。**064 的"`有 \n` 或 `长度 > 160`"已经删掉**——阈值与换行都是**代理信号**，两次都不够用（窄侧边栏里 100 字无换行的消息视觉上三行却不折叠，见 pitfalls #25 的第二次复发）。旧判据只保留为**量不出来时**的回退档 |
| **`.fold-body` 在不在是有含义的（113）** | 它 = "caret 后面还藏着东西"：单行消息的 body 为空 ⇒ **不生成这个元素**。置顶条的收缩按钮正是按它判断的（按 `.user-fold` 判断会变成"每条消息都配一个没反应的按钮"，那正是 104 拒绝过的）。`settleUserFold` 的"先清空旧 body 再重判"因此要按需重加，不能无条件 append 一个空 span |
| 切分点 | 有 `\n` 且其后还有可见内容 ⇒ **按 `\n` 切**（精确答案）；否则二分找**第一行末尾** → 回退到最近空格 → 不切断代理对。切在 `\n` 上时**那个换行符被丢弃**：summary 与 body 的块边界本身就渲染成一次换行，留着会多出一整行空行 |
| 量不出来时（隐藏面板 / 无 `createRange` / 超 2000 字） | 回退 064 的判据，并把节点标成 `data-fold="heuristic"`；等它第一次拿到真实尺寸（`rail` 的 ResizeObserver 正好报这个事件）**只重判一次**，两个方向都要能改（折→不折、不折→折）。**不要每次 resize 都重判**——那会与引导条互相打架 |
| 折叠态 | summary 占**恰好一行**并省略号截断（`.user-fold:not([open]) > summary`）——**只在折叠态**：展开时若还是 `nowrap`，第一段会被截成"半句话加省略号"，看起来像内容丢了 |
| 展开态 | body 是 **inline**：切分点只是实现细节，块级 body 会在半句话处凭空多一处换行 |
| **用户消息的宽度（105）** | `.entry-user { align-self: stretch }`——**靠左、铺满内容盒**。原先是 `flex-end` + `max-width:88%`，气泡宽度 = 内容宽度；于是**折叠后只剩首行、宽度跟着缩短**，面板在折/展时自己变窄（用户报"体验不好"）。宽度现在是常量，折与不折只影响高度。连带：正文与时刻同一起点（`.rec-time` 的右对齐已删）、圆角四角一致（原来的 `8/8/2/8` 缺口指向右下，靠左之后方向反了）。**置顶卡片里的克隆体吃的是同一套规则**，所以"铺满"也决定了卡片里没有空档（169 起卡片里那条折叠三角就是**唯一**的收缩控件，位置见 §5.25） |
| **正文从第二行开始（108）** | summary 第一行只放图标/caret（+图片 chip），正文包进 `.bubble-body`（`display:block`）另起一行。`textNodeOf` 改为在 `.bubble-body` 里找文本节点（图标/caret/chip 都在外面）。`unfoldUser` 重建气泡时把 chip 一并迁过去。折叠态的截断从整个 summary 改到 `.bubble-body` 自己（否则图片 chip 会被一起截掉） |
| **图片附件进用户气泡（108）** | `UserEntry` 加 `attachments?: ContentBlockView[]`；`handleSendPrompt` 把图片的 `toContentView` 循环提前到 `appendUser` 之前、把 views 一并传入，删掉独立 `content` 条目的 append。**Replay 路径（111）**：replay 把文本与图片分成两条 chunk（100 的教训），气泡里没有可合并的东西——改为在 replay 开始前读转录（`readTranscriptUserImages`），按 `uuid` 建 `messageId → 图片视图` 表，`user_message_chunk` 的文本分支据此并入 `appendUser`，随后的图片 chunk 丢弃。任何失败退化为"没有图片" |
| **注入块分流（109）** | `<task-notification>`、`<system-reminder>` 等注入块走 `user_message_chunk` 通道，被无条件渲染成蓝色用户气泡。改为**前缀判据**（`isInjectedChunk`），两条入口（replay 分支、`handleSendPrompt`）共用同一个判据，分流成 `notice` 的 `meta` 级别（居中、灰色、小字、无气泡、无图标）。发送路径仍然真的发出去（agent 期待收到），只是不再产生用户气泡 |
| **IDE 上下文 → 文件 chip（205）** | `<ide_opened_file>…</ide_opened_file>` 是 IDE（官方 Claude Code 扩展）注入的"当前打开的文件"**上下文**，它跟 109 那批一样走 user chunk 通道 ⇒ 同一条消息渲染成**两个**蓝色气泡（用户报："附加的文件没有合并到一个对话里，分成了两条对话"）。**它的正确形状不是提示条而是 chip**（官方插件就是这么画的：同一个气泡里，chip 在上、正文在下）：`ideOpenedFilePath()` 抠出路径，按「会话::messageId」暂存（回放里两条 chunk 同 messageId、顺序不保证），正文 chunk 到的时候作为 `attachments` 进同一个气泡（chip 是 `resource_link` 视图 → 点它走 openFile，见 039）；块本身**不建记录**。⚠️ **判据要放在 `isInjectedChunk` 之前**（它也以 `<ide_` 开头）；其它 `<ide_*>` 块（`<ide_selection>` / `<ide_diagnostics>`）归 109 那条路（`<ide_` 进了前缀表），认不出形状也不会变成"用户说过的话"。暂存表只留最近 20 条（用户只开了个文件、没有下文时那条永远没人来取），会话关闭即清 |

**INV-J（破了不会有自动检查报错；`src/test/chat-client.test.ts` 是它的守卫）**：
①三角在图标**之后**；②summary 重写后**图标与三角都还在**；③用户消息折叠**不重复全文**、
默认展开、**每条消息都有控件**（113）——单行时 body 为空且**不生成 `.fold-body`**（那个元素
就是"后面还有东西"的标记，置顶条的收缩按钮按它判断）；④**触发判据是"屏幕上几行"**——
两个方向都要测：只折行无换行的消息**必须切分**（有 `.fold-body`），
一行放得下的长文本**必须不切分**（无 `.fold-body`）；只测前者说明不了它是测量而不是"更宽的阈值"。

### 5.16.1 助手消息的折叠（114；折叠态一行 115→116）

`agent_message_chunk`（助手气泡）与用户消息**共用同一套折叠控件**：真三角 `.fold-caret`、
`<details>` 原生开关（切换不需要 JS）、**默认展开**（刚到的回答不该被藏起来）。
**思考块本来就能折叠**（§5.16 的 `.thought`），所以 114 只补助手这一类。

| 关注点 | 规则 |
|---|---|
| 结构 | `details.msg-fold[open] > summary.msg-head([icon][caret][.msg-preview])` ＋ `div.bubble-body`（summary 的**兄弟**） |
| **正文为什么不在 summary 里** | 用户气泡里是惰性文本，整行当点击区没问题；**助手正文是 markdown HTML**（链接、代码 Copy、图片 chip），而且**在 `<summary>` 里划选文本 == 点它** —— 读者选中一段回答就会把它折起来。所以切换区只有那一行 [图标][三角]，正文在外面 |
| 折叠怎么实现 | **首行预览**：一段预览文本放在 summary 里（`.msg-preview`，真文本节点），折叠时显示、展开时由 CSS 藏掉。**"更聪明"的两条路都试过并否掉了**：按测量切开正文（渲染后的 markdown 里"切在第几个字符"没有意义）、给正文加行钳制（**`details` 折叠时对非 summary 子节点的隐藏，作者样式抢不过**——115 用 `display` 覆盖，结果折叠后正文干脆不可见，用户看到的正是"折叠后文字没了"） |
| **折叠后占几行（115→116）** | **一行**：`[图标][三角][正文首行]`，与用户消息一致（用户要求）。115 想用 flex 把正文的首行挪到标题行上——**没用**：`display:flex` 挂在 `details` 上并不产生"两个 flex 项目"的布局（实测首行跑到图标行、其余照旧另起）。116 改成"预览文本"这条唯一可行的路。**这类判断必须靠 `preview-records.mjs` 截图，不要靠推理**（pitfalls #31） |
| 预览从哪来 | `refreshPreview(record, body)`，在 **`applyAssistant` 末尾**调用——那是正文内容变化仅有的两个入口（首次渲染 / 每次 patch）的汇聚点，所以只有一个同步点。文本取自**渲染后**正文的**首个块元素**（`firstElementChild.textContent`），纯流式文本没有元素子节点时回退到整段文本；只取一行、截到 240 字（`ASSISTANT_PREVIEW_CHARS`）。**取自渲染结果而不是 `entry.text`**，否则 `## 标题` 会原样出现在预览里 |
| 预览不是"正文的副本"隐患 | 展开时它是 `display:none`：不参与渲染，也不进划选/全选复制（`Copy message` 读 `entry.text`，与 DOM 无关）；折叠时正文被浏览器整块藏起来，屏幕上只有这一份 |
| 图标挂在哪 | `icons.attach` 的 `HOST.assistant` 从 `.bubble` 改成 `.msg-head`（在 caret 之后 prepend ⇒ 仍是 `[图标][三角]`）。**顺带删掉 `applyAssistant` 里 takeIcon/putIcon 那一对**：图标不再住在被重写的节点里，没有东西能擦掉它 |
| 外观挂在哪 | `.entry-assistant .msg-fold`（原来是 `.bubble`）——details 现在包住标题行+正文两段。`.md` 类名移到 `.bubble-body`，故 `.entry-assistant .bubble-body.md { white-space: normal }` |
| 重写路径 | `patch` 里 `node.querySelector('.bubble')` → `.bubble-body`（否则 markdown 永远落不进新结构，且是**静默**的：记录还在、只是不再更新） |
| 构建顺序 | 标题行里是 `[图标][三角][预览]`（INV-J ① ＋ 预览垫底）。`buildAssistantFold` 必须**先把正文 append 进 details、再调 applyAssistant**——预览刷新顺着 records 找 `.msg-preview`，正文不在树里时那条链是断的（116 的第一版就栽在这，图上是"折叠后一片空白"） |

### 5.17 每条记录的时间（065）

**事实**：**每条记录都已经带 `at`**（`TranscriptStore` 在 append 时打的时间戳），只是一直没显示过。
Thought 的 `Thought for Ns` 是**耗时**不是时刻。

| 层次 | 做法 | 理由 |
|---|---|---|
| 悬停 | 每条记录的 `title` 是完整时刻（HH:MM:SS） | 零成本、零噪声，随时可查 |
| 工具耗时 | `ToolCallView.elapsedMs`（宿主用 `endedAt - startedAt` 算），卡头显示 `1.2s` / `420ms` / `2m 5s`，**常显** | 与 `Thought for Ns` 同类信息，不设开关。**不下发两个时间戳**：已完成的时长不需要客户端时钟；**仍在跑的不显示**——`status` 的脉动已说明"进行中"，实时计时器意味着每帧重渲染 |
| 每条时刻 | 头部「Times」开关（持久化）⇒ **只在工具卡上**显示 HH:MM：关 = `3ms`（耗时，常显）；开 = `3ms 18:32`（耗时 + 时刻，见 129）。**[146] 普通消息与 Thought 不显示时刻** —— ACP 里只有工具调用带 `elapsedMs`，它们根本没有"耗时"这个量，单独挂一个时刻读起来像缺了一半 | `.rec-time` 元素**始终在 DOM 里**（`transcriptView` 一律插入），显隐由一个类决定：`.messages.show-times .tool-head .rec-time { display: block }` ⇒ **切换开关不重渲染任何东西**。工具卡的时刻是**标题行里的一项**（`.tool-head .rec-time { position: static }`，跟在 `.tool-time` 后面，整行读作 `3ms 18:32`）；其余记录的时刻元素仍插在 `summary` 里，只是选择器不放它出来（`.rec-time` 的绝对定位对它们才成立，工具卡是例外）。挂在**标题行**而不是记录节点上，是因为折叠的 `<details>` 会隐藏 summary 之外的一切。**145 曾试图让工具卡的时刻也浮到右上角**（好让所有记录对齐），靠 `padding-right` 硬留槽位 —— 结果把工具卡本来工整的一行挤散了，**已回退** |

**时长的格式化在 `NS.dom.duration`**（最底层模块）：`toolCallView` 与记录层都要用，而模块加载顺序
**只允许依赖指向前方**——放在 `transcriptView` 里 `toolCallView` 用不到，抄第二份又会漂（pitfalls #19）。

### 5.18 工具输出按 markdown 渲染（066）

**事实**：Claude Code 的 Bash 结果**本身就是 markdown 包装的**（抓包夹具里 12 处带 ``` 围栏），
所以按纯文本渲染会显示字面的 ``` 并丢掉代码块样式与 Copy 按钮。

- **复用助手气泡那条 markdown 往返**（宿主 `SafeMarkdown` + 客户端 `sanitize` 双重兜底），
  **不写第二个更弱的渲染器** —— 行为一致是这条的全部价值。
- 工具内容项没有身份 ⇒ 给它稳定 key：**`entryId + '#' + 项下标`**（下标在同一调用内稳定）。
- 协议：`renderMarkdown` / `markdownRendered` 的 item 各加可选 `key`；**带 key 的项宿主不做
  `transcripts.patch`**（它不是记录，没有可打补丁的对象），HTML 原样回给请求它的元素。
- 客户端两份缓存（`mdCache` / `mdPending`），**按会话清空**（`transcriptView.reset()` 里调到）：
  工具 body 在 `bodySignature` 变化时会**整块重建**，缓存是让已渲染 HTML 挺过重建的关键。
- **防御**：拿不到 `entryId` 时（无唯一 key）**回落纯文本**——key 撞车会把一条记录的 HTML 喂给另一条。
- **[147] 助手/思考那条往返上的两处守卫**（用户报"最后一条不渲染、重开会话就正常"）：
  ①`boot.requestMarkdown` 里原来有一条"聚焦会话为空就整批不发"的守卫 —— 而 `transcriptView` 的
  item **自带 sessionId**（请求方就是它），根本不需要借聚焦状态；那道守卫只会在"正文刚落地、
  聚焦还没同步好"的那一帧白白丢掉一次请求（pending 不清空，但下一次触发可能永远不来 —— 128 修
  的就是这个形状）。守卫现在只留给**没有会话身份**的工具项。
  ②客户端处理 `markdownRendered` 时**不再**拿 item.sessionId 跟 boot 的 `currentSessionId` 比：
  两端来源不同，一旦不一致就把回填**静默丢掉**，那条记录于是一直停在原文 —— 而宿主其实已经把
  html 写进了 store，所以它表现为"重开会话就正常"（重开走快照，不经过这里）。`entryId` 在 store
  里全局唯一，按它回填本来就串不了台。**判据**：客户端的请求链路本身由桩测试钉住了
  （`markdown asks for itself`，含"正文后到 + finalize"那条），所以再遇到同类症状应当先怀疑
  **回填这一侧**，而不是去翻 `markPending`。

### 5.19 右键菜单是自己的（067）

Webview 默认弹 **Chromium 的原生菜单**，它在这个面板上有两个问题：`Cut`/`Paste` 对只读内容没有意义；
`Copy` 复制的是**选区**（右键时通常没有选区）⇒ 看起来可用、实际什么都不做。

- `contextmenu` 上 `preventDefault()` **整体接管**（留着原生菜单会得到两个菜单）。
- 项：`Copy`（选区，**无选区时禁用**）/ `Copy message` / `Copy code` / `Select all`。**没有 Cut/Paste**。
  **禁用项比"点了没反应"诚实得多** —— 本次故障的全部体感就是"点了没反应"。
- 复制走扩展侧 `copy` 通道（与代码块 Copy 同一条路）：webview 的 `navigator.clipboard` 依赖文档焦点。
- **输入框里不接管**（那里系统的 Cut/Paste 是对的）。
- 关闭：任意点击 / Esc / 滚动 / resize / 失焦；位置贴边翻转。项是真 `<button>`（047 的规矩）。

### 5.20 客户端逻辑的自动测试（068）

`src/test/chat-client.test.ts`：**桩 DOM** + 只加载被测链路的模块
（`dom` → `icons` → `links` → `toolCallView` → `transcriptView`），其余协作者给最小替身。

- **边界画在被测链路上**：不加载 `boot`（它的 `init()` 会去接十几个 `body.ts` 的元素，
  为了让它跑起来就得把桩扩张成一个假 DOM ⇒ 一堆与产品无关的桩代码）。
- **能测逻辑，不能测布局**：结构、顺序、类名、内容切分 ✅；尺寸、换行位置、颜色、焦点 ❌
  （需要真 Chromium——用 jsdom 之类的近似实现测布局只会给出**假信心**，与 `dev-workflow.md` 的分区表一致）。
- 桩是**外部 API 的测试替身**（同目录里早有假 Memento），不是我们自己知识的第二份拷贝（那才是 pitfalls #19）。
- **它的假设也要被检验**：068 落地过程中两次"测试错了、产品没错"——①按"容器的第一个子节点"取记录，
  而 `place()` 会把 `.rec-time` 插进标题行（**第一例是假通过**）；②用户记录是**包着 details 的 div**，
  而 Thought 记录**本身就是 details**，只认一种形态会误判"无折叠"。⇒ **按标记（`[data-kind]`）定位，不要假设位置。**
- **071 之后的桩**：折叠判据要"实测行数"，于是在 `document` 上补了一个**确定性的 Range 模型**
  （每 N 字一行，`charsPerLine` 可调）。**这不是假装测布局**：换行位置仍是浏览器的活，桩只回答
  "这个前缀占几行"，被测的是我们的逻辑（二分、空格回退、`\n` 优先级、回退档、重判）。
  把 `charsPerLine` 调大就能测"一行放得下的长文本**不**折叠"——那是**唯一**能把"测量"与"更宽的阈值"分开的办法。

### 5.21 思考块也走 markdown（072）

**事实**：`thought` 记录此前是**纯文本**（`buildThought` 直接写 `entry.text`），所以 agent 推理里的
反引号、`- ` 列表符、``` 围栏全部以字面字符显示。夹具里 `agent_thought_chunk` 有 492 条，
比正文的 422 条还多——这是记录区里最显眼的一处"markdown 没支持"。

- **复用助手气泡那条往返**（宿主 `SafeMarkdown` → 客户端 `sanitize`），不写第二个渲染器。
- `ThoughtEntry.html`；`TranscriptStore.patch` 的 thought 分支**必须处理 `html`**
  ——不加就是**静默丢弃**（宿主自己的补丁落不了库，切会话又变回纯文本）。
- **INV-K：思考块的合并分支必须清掉 `html`**（`appendThoughtChunk` 的 merges 分支）。
  助手分支一直有这一行，思考分支漏了的话，之后每个 chunk 都会带上**过期前缀**的 html
  ——正文冻结或来回跳，而且没有任何报错。
- **流式期间不渲染 markdown**：只从**定稿**的 revise 排 pending。给还在长的正文应用"某个前缀的 html"
  是错的；定稿的 revise 又**不带 html 键**，所以 `patch` 里必须"html 到了就不再请求、定稿且没有 html 就重新排"
  两个方向都写（`trackMarkdown`，与助手共用）——只判断 `changes.html` 会永远不排，表现就是
  "markdown 刚到达又被原文覆盖"。
- **hydrate 也要覆盖**：`buildThought` 直接按 `entry.html` 决定渲染方式，否则从快照恢复的思考块永远是纯文本。
- **CSS 作用域**：markdown 规则从 `.bubble` 扩到 `.bubble, .md` **共享**（各写一套 = 同一份知识存两份）。
  `.thought-body.md` 回到 `white-space: normal`（pre-wrap 会把 marked 的换行**再加一倍**）；
  正文保持斜体（推理的视觉身份），但 `pre`/`code`/`table` 内重置为非斜体。
- **顺带**：GFM **任务列表的勾选态**。`marked` 默认输出 `<input type="checkbox" disabled>`，
  而客户端白名单没有 `INPUT` ⇒ 被 unwrap，`- [x] 做完了` 与未完成**长得一模一样**。
  修法是**覆盖渲染器的 `checkbox` 钩子**输出字形 span——**不**把表单控件加进白名单；
  覆盖 `checkbox` 而不是 `listitem`，是为了不重写 marked 自己那套紧/松列表的插入位置。

### 5.22 切换模型/模式的提示（073）

**事实**：`setModel` / `setMode` / `setConfigOption` 以前只 `pushMeta()`，记录区里不留痕迹——
读者回看时不知道从哪一句起换了模型。Claude 官方插件在切换处插一条分隔式提示。

- **纯函数放 `src/ui/chat/sessionChoices.ts`**（取快照 / 按通知载荷打补丁 / 算差异 → 人类可读的一句话），
  宿主只做缓存与发帖。抽出来的理由是**可测**：真正的分支（谁先到、同一次切换被上报两次怎么办、
  级联变更怎么表述）在编排器里没法单测。
- **去重靠"缓存由我们独占"**：同一次切换有两条上报路径——我们自己的 setter 与 agent 的
  `config_option_update` / `current_mode_update`。**先到的那条**算出差异并提示，后到的那条与我们刚写入的
  快照一比就是空的。**通知路径用载荷**而不是 `SessionManager` 的状态：两个监听器的先后顺序不保证，
  读状态可能拿到改前或改后。
- **[CUSTOM-20260930-128] 但"两条路径产出同一个快照"是个契约，而它一度不成立。** 模式在
  `session.modes.currentModeId` 与 `configOptions[category='mode'].currentValue` 里**各有一份副本**，
  而两份**不会同时被写**（`setMode` 在会话有 configOptions 时提前 return，`current_mode_update`
  也从不落到 `SessionManager`）⇒ 上面那句去重**静默失效**：一次切换被报成两条，第二条还是
  "新的一半 + 旧的一半"拼出来的、现实中不存在的状态（实测 `Manual mode · Bypass permissions mode`）。
  现在**以 config option 为权威**：快照的 modeId 由它派生（没有这个选项时才回退 `modes.currentModeId`，
  纯 modes 通道的 agent 不受影响），只带 modeId 的 payload 会把值**写回**那份副本，`choiceChanges`
  跳过该选项（否则一次变化会被报两遍）。`SessionManager.applyConfigOptions` 同步把值写回 `modes`，
  让 `metaOf` 等其它消费者也看到新值。完整教训见 pitfalls #34。
- **首次见到某会话只做基线**（`onSessionUpdate` 顶部播种）⇒ 打开会话不会打印"切到它本来就有的模型"。
  同理，**"从无到有"不算切换而是初始化**：会话的第一个快照是空的（`SessionManager` 那时还没有东西），
  选项列表往往随后才到——把"出现"当"切换"会给每个会话都打印一行 `Model: … · Mode: … · Reasoning effort: …`。
  `choiceChanges` 因此只在**两边都知道**这个选项、且值真的不同时才产出标签（代价是极小窗口内的切换不提示，
  而那个窗口里 picker 本身还是空的）。
- 表述：`model` → `Switched to <名字>`；`mode` → `Switched to <名字> mode`（来自 `session.modes`
  还是 category='mode' 的配置项都一样——读者不该看出差别）；其它 → `<选项名>: <值名>`
  （只说 "Switched to High" 是个谜语）。级联变更合成**一条**（` · ` 连接），model/mode 排前面。
- 渲染：`NoticeEntry['level']` 增加 `'switch'`——它是**表现形式，不是严重级别**；CSS 用左右虚线做成一行。
  **协议没有变化**（`level` 本来就在记录里）。

### 5.23 内容块审计的其余补充（074 / 075）

对 ACP 全部 11 种 `session/update` 与 5 种内容块盘过一遍，补了三处、**刻意没做**两处。

| 做了什么 | 关键点 |
|---|---|
| 工具卡显示真实工具名（074） | `kind` 是 ACP 的粗粒度词表（Run / Read），两张 "Run" 卡只能靠标题区分。夹具里 **12/12** 个工具调用都带 `_meta.claudeCode.toolName`，取出来与 kind 标签**并列**（不替换）。**chip 要可加可删可改**：`update` 路径也得调（占位卡靠 update 才拿到真实视图模型）。`_meta` 是厂商私有的，**只认这一种已知形状**、其余静默——猜第二个厂商的键就是把推断当事实（§5.6） |
| 会话标题（075 的提示已废；[163] 静默；[164] 冻结） | `session_info_update` 更新标签栏与会话历史。**075**：缓存上一次的标题、对「真正的改名」插一行 `Session renamed to “…”` —— **[163] 取消**（用户报：会话进行中自己冒出一行改名）。**[164] 标题由第一次对话定死**：① 那一刻已经拿到的自动命名就是它的名字；② 没拿到就用**第一条用户消息**（`toSummary` 的回退链 `session.title ?? stored.title ?? stored.firstPrompt`）；③ **之后任何标题都不再改**，包括几轮之后才生成的「第一个自动命名」。**冻结点 = 第二次发言那一刻**（`handleSendPrompt` 里判 `turnsDone`）——不放在「第一轮结束时」，因为 adapter 正是在 idle（轮次结束）那一刻才去读并推标题（`maybeUpdateSessionTitle` 的注释：「SDK 在后台生成标题，`idle` 是轮次结束信号，也是新标题可能已落地的时刻」），在那儿冻结会把刚生成的自动命名一起挡在门外。**判定只有一处**（`trackTitle` 返回是否收下，SessionManager 的`applySessionInfoUpdate` 跟着它走）：只挡宿主那份 map 是不够的 —— tab 的标题读的是 `session.title`（第一版就是这么漏的，两条测试抓住）。 |
| 思考块里的非文本内容（075） | `agent_thought_chunk` 带的图片/资源此前直接 `return` 丢掉。现在复用 `postContentNotice`，**但先 `finalizeEntries(only:'thought')`**：记录只并入"最后一条"，不关掉旧思考块的话它会永远停在 `Thinking…`（后续 thought chunk 会另起一条） |
| **没做**：`available_commands_update` | 斜杠菜单已经消费它，再提示纯属噪声 |
| **没做**：`usage_update` 的成本数字 / 用户消息里的非文本内容 | 前者令牌条里已有；后者在 replay 路径上从未出现过 |

### 5.26 工具卡的标题与 IN / OUT（CUSTOM-20260929-117）

对齐官方 Claude Code 面板的观感（用户拿它的截图当参照）：卡片标题是**人写的一句话**、正文按
**IN / OUT** 分段。数据来自真实抓包夹具（`claude-code-session-load.json`），不是推断：

| 关注点 | 规则 |
|---|---|
| 标题从哪来 | `rawInput.description`（模型写的描述，如 "List files in the working directory"）→ 回退 ACP 的 `title`。**用户看到的那行"Bash 查看博客目录及父目录现有内容"= 工具名 chip（074 的 `_meta.claudeCode.toolName`）+ 这段描述** |
| **为什么要在 store 里 latch** | 描述**比首帧晚到**（真夹具里是第 3 条 update），而两处来源的存活方式不同：`rawInput` 是"键在才覆盖"（描述留下了），`_meta` 是**整体替换**（`_meta.claudeCode.title` 只活在那一条 update 里）。任何"要用时再读一遍"的写法都会让标题在下一个 chunk **闪回命令行**，且没有任何报错 ⇒ `ToolInvocation.description` 只在**有值时**写入（`ToolInvocationStore.latchDescription`），`toToolCallView` 直通 |
| `title` 没被改 | 它仍是 ACP 给的原值：**IN 段显示的就是它**，rail 的 tooltip 也读它（`rail.ts` 用 `view.title`）。客户端只是把 `.tool-title` 这个**节点**的文字换成 `description || title`，悬停仍给 title |
| **对齐的两条硬规则（122）** | ①OUT 的底色与内边距**挂在内容格上，不能挂在 grid 容器上**——容器的左右内边距会把整个网格（含标签列）推右 6px（实测 IN 内容 x=65 / OUT x=71）；②工具输出里的 `pre` 必须**显式**指定编辑器字体与字号，否则回落到浏览器默认 monospace，字面宽度与左边界都与 IN 不同。修后两侧正文同起于 x=71（`#probe` 读数） |
| **IN / OUT 的排版（121）** | **左右两栏**（对齐官方插件）：`.tool-seg` 是 `grid-template-columns: 30px minmax(0,1fr)`，段标在左列、内容在右列 ⇒ 一张卡省掉两行（一轮十几张工具卡，这是可观的纵向空间）。**除标签外的每个子节点都要显式 `grid-column: 2`**，否则 auto-placement 把第二个子节点甩回第一列。工具输出里的**围栏语言标签要藏掉**（`.code-lang` + `has-lang` 给 pre 预留的 20px 顶边距）——命令输出显示 "console" 没有信息量，那片空白却很明显 |
| IN / OUT | 段标只在**有命令行**时出现（`tool.command`）：Bash 这类 execute 调用是"输入 → 输出"，正是官方的样子；Read / Edit / Search 没有输入行，**不套 OUT 标签**——那会是对调用方向的断言，而客户端并不知道。它们的正文布局与 117 之前逐字一致（零回归） |
| 默认展开还是收起 | **收起**（118 定案）：117 让"有命令行的卡"自动展开，用户否掉了——长会话会变成一堵命令输出墙。所以**每张卡都默认收起**，IN/OUT 一点即开，标题行给的是 agent 的描述，读者知道点开是什么。展开态与 caret/`aria-expanded` 由 `links.toggleBody` 统一维护 |
| **OUT 空盒子（118）** | 用户报"IN/OUT 出来了但 OUT 没内容"。两个独立的成因，都修了：①**空白文本项**照旧渲染出一个空节点（026 的规矩是空白不可见）⇒ `fillToolBody` 直接跳过它；②`rawOutput` 是 agent 在**每条**结果里都会写的字段，却从未进过视图模型 ⇒ `ToolCallView.output` 兜底渲染（**仅当 items 里没有可见项**，见 `hasVisibleItem`）。`bodySignature` 必须带 `out:`（INV-H） |
| **工具文本的 markdown 请求曾没人发（118）** | `toolCallView` 的 `mdPending` 队列**只写不读**：全项目只有 `transcriptView.flushPending` 会 `requestMarkdown()`，而它只在 assistant/thought 记录跟踪 markdown 时触发 ⇒ 工具正文的渲染请求**只在恰好后面跟着一次 assistant finalize 时**才发得出去。以工具调用结束的轮次（或 assistant 条目本来就带 html 的 replay）⇒ 工具正文**永远空白**，且没有任何报错。修法：`markdownText` 入队后 `scheduleMarkdown()`（一帧一次，合并多个 item）。**[CUSTOM-20260930-128] 助手/思考这一侧当时漏了同一个病**：`transcriptView.markPending` 只入队，而全项目唯一的 `flushPending` 挂在 `patch()` 路径上 ⇒ 「最后一次 DOM 更新就是它自己的 append」的记录（**一轮的最后一条正是这个形状**：收尾的 revise 若晚到，或这轮根本不是本面板发起的，就再也没有 patch 了）永远等不到渲染请求，界面只剩原文，两侧还都不报错。照同一形态补上 `scheduleMarkdown()`；另给 `handleRenderMarkdown` 的静默丢弃补了一行日志 |
| 输出限高 | `.tool-seg-out` 复用 `.diff-body` 的 340px + `overflow:auto`（长输出不该把面板顶走，也不再引入第二个魔数） |
| 测试 | 客户端 4 条（描述回退 / update 路径补上描述 / IN-OUT 分段与默认展开 / 无命令行卡不变）+ 宿主 3 条（latch 跨 `_meta` 替换存活、无描述就是无描述、真夹具 live 流把 description 送到 webview） |
| 观感证据 | `preview-records.mjs` 的夹具里有两条 Bash（一条带描述、一条没有），真 Chromium 截图即验收（pitfall #31） |
