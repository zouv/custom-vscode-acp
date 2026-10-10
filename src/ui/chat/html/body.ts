// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 静态标记。所有动态内容由内联脚本填充；这里只有骨架与固定文案。
// [CUSTOM-END] CUSTOM-20260923-011
// [CUSTOM-BEGIN] CUSTOM-20260925-050 - body 带上「这是哪个面」，供样式区分。
// 编辑区面板与编辑器标签同处一列，用侧边栏底色会显得像外部面板；侧边栏视图则必须
// 保持侧边栏底色。差异全部交给 CSS（`.surface-editor`），标记里只写类名。
// [CUSTOM-END] CUSTOM-20260925-050
// [CUSTOM-BEGIN] CUSTOM-20261002-173 - body 带上构建指纹，客户端 boot 会把它报进日志。
//
// 为什么放在 HTML 里而不是让客户端自己算：webview 里跑的是**嵌在这个文档里的**那份脚本，
// 它自己算出来的哈希和宿主一模一样、证明不了任何事。真正要回答的是"这份文档是哪次构建渲染的"
// —— 也就是**生成它的那个宿主进程**是谁，而这个值正是那个时候由宿主写进去的。
// 于是日志上「宿主 activate 的指纹」与「客户端 boot 报出的指纹」一对照，
// 就能区分三种情况：一致=当前构建；客户端是旧值=窗口/webview 是旧的；两者都没有这行=根本没重载。
// （取值见 utils/BuildInfo.ts；只含 [A-Za-z0-9._+:-]，可直接进属性。）
// [CUSTOM-END] CUSTOM-20261002-173
import type { SurfaceKey } from '../ChatSurface';
import { buildStamp } from '../../../utils/BuildInfo';

export function body(surface: SurfaceKey = 'view'): string {
  return `<body class="surface-${surface}" data-acpc-build="${buildStamp()}">
  <div id="agentBar" class="agent-bar" hidden>
    <select id="agentSelect" class="agent-select" aria-label="Focused agent"></select>
  </div>

  <div id="tabStrip" class="tab-strip">
    <div id="tabs" class="tabs" role="tablist"></div>
    <button id="newTab" class="tab-new" title="New session" aria-label="New session">+</button>
  </div>

  <div id="sessionHeader" class="session-header">
    <button id="historyBtn" class="outline-btn"
            title="Open a previous session" aria-label="Open a previous session">↺</button>
    <!-- [CUSTOM-20260925-058] 这一格以前是 <span>，只显示 cwd 纯文本。现在它是真按钮
         （047 的规矩：真按钮才有键盘可达性），点开是目录选择抽屉。草稿页上它显示的是
         "这个会话将建在哪个目录"，已发出消息的会话上则是只读展示 + "在别处新建"。 -->
    <button id="cwdBtn" class="session-title" title="Working directory" aria-label="Working directory"></button>
    <!-- [CUSTOM-20260930-129] 这里原有一个 #usageBar（上下文进度条 + 数字）。删掉了：
         同一份数据在底部已经有一个更省地方的呈现（圆环），顶部这一条只是重复占位。 -->
    <button id="timeToggle" class="nest-toggle"
            title="Show the wall-clock time of each record">Times</button>
    <button id="nestToggle" class="nest-toggle" hidden
            title="Group sub-agent tool calls under their parent (links are inferred)">Sub-agents</button>
    <button id="outlineBtn" class="outline-btn" hidden
            title="Conversation outline" aria-label="Conversation outline">☰</button>
    <div id="outline" class="outline" hidden>
      <!-- [CUSTOM-20260926-077] 钉住按钮并进 .outline-head（"N messages" 同一行）：
           .outline-head-info 是动态计数容器（render 只清它），钉住按钮是它的兄弟、静态。 -->
      <div class="outline-head">
        <span class="outline-head-info"></span>
        <button id="outlinePin" class="outline-btn"
                title="Pin to the right side" aria-label="Pin to the right side">⇥</button>
      </div>
      <div class="outline-list"></div>
    </div>
    <div id="history" class="outline" hidden>
      <!-- [CUSTOM-20260926-079] 与 077 同一形态：'.outline-head-info' 是 render() 清空并回填
           计数的动态容器，目录过滤 chip 与它的菜单是**兄弟节点**（静态，不会被重渲染清掉）。
           菜单挂在 head **内部**：head 是 position: sticky（已是定位元素），菜单用 top: 100%
           正好落在它下面——不需要量高度、也没有常量偏移。
           注意菜单用 '.open' 类切换而**不是 hidden 属性**：它有作者样式 display: none，
           与 .open 的 display 是同一层级的竞争（pitfall #13 的反面：这里靠类，不靠属性）。
           [CUSTOM-20260930-141] 它现在能**溢出**历史浮层了：滚动从 #history 下移到了
           .outline-list（见 styles.ts 里 #history 那条）—— 否则这个绝对定位的菜单会被外层
           滚动容器裁成"只剩几行"（历史列表越短越矮）。filter-menu 类用于与历史列表区分观感。 -->
      <div class="outline-head">
        <span class="outline-head-info"></span>
        <button id="historyFilter" class="picker-btn filter-chip" hidden aria-expanded="false"></button>
        <div id="historyFilterMenu" class="picker-menu down filter-menu"></div>
      </div>
      <div class="outline-list"></div>
    </div>
    <div id="cwdMenu" class="outline" hidden>
      <div class="outline-head"></div>
      <div class="outline-list"></div>
    </div>
  </div>

  <div id="messageArea" class="message-area">
    <!-- [CUSTOM-BEGIN] CUSTOM-20260930-132 - 引导条 #rail 与「Jump to latest」原本都是这一层
         的子节点，现已搬进 .messages-column（见下）。原因是版心：消息列有了 max-width 并
         水平居中之后，绝对定位的它们若仍锚在 .message-area 上，就会留在面板边缘、与内容
         脱节 —— rail 的横坐标来自 CSS 的 left:0（styles.ts 的 .rail），jump-latest 来自
         left:50%，两者锚的是"哪一层"就说哪一层的左缘/中心。搬进列之后它们与内容同一条
         中线，且不必引入任何常量或 JS 测宽（pitfall #24 的正解）。 -->
    <!-- [CUSTOM-END] CUSTOM-20260930-132 -->
    <!-- [CUSTOM-20260928-103] 消息列：把 #messages 与置顶副本关进同一个定位容器。
         102 时 #stickyUser 是 #messages 的兄弟、相对 .message-area 定位，而 .message-area 是
         flex 行、除消息列外还装着定宽的大纲栏 ⇒ 绝对定位的覆盖层横跨两段，右边一直伸进大纲
         栏下面（用户报的"甚至到右侧大纲界面了"）。放进这一层之后，"覆盖层不会盖到大纲栏上"
         是按构造成立的——不用量宽度，更不用常量偏移（pitfall #24）。 -->
    <div class="messages-column">
      <!-- [CUSTOM-BEGIN] CUSTOM-20260930-132 - 引导条搬到这里（原为 .message-area 的第一个
           子节点）。它的横向位置**全靠 CSS**（.rail{left:0}，JS 只测纵向），所以定位祖先
           是哪一层，它就贴哪条左缘：留在 .message-area 上会贴面板左缘，而消息列一居中就与
           内容差 (W−820)/2（1600 宽的面板上是 390px）。搬进来之后 left:0 == 列左缘 ==
           #messages 那条 19px 通道的起点，逐像素与改动前一致。纵向不受影响：列是 flex 项、
           交叉轴 stretch，高度 = .message-area 的高度。 -->
      <div id="rail" class="rail" hidden><div id="railTrack" class="rail-track"></div></div>
      <!-- [CUSTOM-END] CUSTOM-20260930-132 -->
      <!-- [CUSTOM-20260928-102] 悬浮置顶条（104 改成悬浮卡片 + 收缩按钮）。
           它是 .messages-column 的绝对定位子元素，不参与滚动也不占布局。
           卡片是内层元素：背景/描边/圆角要画在「内容盒」上，px 才能与 .messages 的内容盒对齐。
           [CUSTOM-20261002-172] 卡堆之后**同时可能有多张卡**（旧卡被顶出上沿、新卡钉住），
           所以这里只留定位层，卡片由 stickyUser.ts 按条动态建 —— 固定 id 的 #stickyCard /
           #stickyBody 会撞成重复 id。一张卡 = .sticky-card > .sticky-body > 克隆体。 -->
      <div id="stickyUser" class="sticky-user" hidden></div>
      <!-- [CUSTOM-20260925-048] role="log" + aria-live: the transcript is the one
           region a screen reader must follow. aria-busy is driven by
           transcriptView (true while any entry is still streaming) so assistive
           tech defers announcements instead of reading every chunk — see
           refreshBusy. aria-relevant="additions" keeps text appended to an
           existing node from being re-announced. -->
      <div id="messages" class="messages" role="log" aria-live="polite"
           aria-relevant="additions" aria-busy="false"></div>
      <!-- [CUSTOM-BEGIN] CUSTOM-20260930-132 - "Jump to latest" 同样搬进列（原在 .message-area
           上）。它的 left:50% 以定位祖先为基准：锚在 .message-area 时无侧栏恰好居中（两者
           中心重合，所以这个偏差一直没被看见），但钉住大纲栏以后列中心变成 (W−S)/2、按钮
           仍在自己那层的中心 W/2，于是偏 S/2（240px 的侧栏就是 120px）。锚到列上，两者按
           构造是同一条中线。 -->
      <button id="jumpToLatest" class="jump-latest" hidden>↓ Jump to latest</button>
      <!-- [CUSTOM-END] CUSTOM-20260930-132 -->
    </div>
    <!-- [CUSTOM-20260926-076] 右侧常驻大纲栏：钉住模式下显示，是 .messages-column 的 flex 兄弟
         （103 前是 #messages 的兄弟——那段距离只差一层不占尺寸的包装）。
         .outline-head（计数行）与 .outline-list（列表）与下拉共用同一套渲染逻辑。 -->
    <div id="outlineSidebar" class="outline-sidebar" hidden>
      <div class="outline-sidebar-head">
        <span class="outline-sidebar-title">Outline</span>
        <button id="outlineUnpin" class="outline-btn"
                title="Close outline" aria-label="Close outline">✕</button>
      </div>
      <div class="outline-head"></div>
      <div class="outline-list"></div>
      <div id="outlineResize" class="outline-resize" aria-hidden="true"></div>
    </div>
    <!-- [CUSTOM-BEGIN] CUSTOM-20260930-123 - 状态卡（取代 090 的「两段静态提示 + 按钮」）。
         三态：未连接 / 连接中 / 已就绪，由 client/stateCard.ts 按相位切换内容。
         提示文案改由 textContent 写入，所以不再需要 <kbd>（旧提示里硬编码的 Ctrl+Shift+A
         在 Mac 上本来就是错的，而快捷键本身已有平台差异，不值得在卡片里复述）。

         ⚠️ 这一层（#emptyState）的 display **只有一个写者：boot.showEmpty()**。
         状态卡模块只写内容（textContent / checked / disabled / 子节点 hidden），
         绝不写自己这层的 display —— 破了这条就会重演 081 修掉的「空态被挤出正中」。 -->
    <div id="emptyState" class="empty-state">
      <div id="stateCard" class="state-card" role="status" aria-busy="false">
        <!-- 固定高度的转圈槽位：连接中之外它空着，但高度不变，标题不会上下跳。 -->
        <div class="state-head"><span id="stateBusy" class="spinner" hidden></span></div>
        <p id="stateTitle" class="state-title"></p>
        <p id="stateHint" class="state-hint"></p>
        <p id="stateError" class="state-error" hidden></p>
        <div id="stateActions" class="state-actions">
          <button id="emptyConnect" class="state-connect">Connect Claude Code</button>
        </div>
        <!-- 配置项 acpc.autoConnectOnOpen 的勾选形态。放这里而不是设置面板：
             用户是在「面板空着、想让它自动连」的这一刻才需要它。
             [CUSTOM-20260930-127] 已连接时整行退场（stateCard.render）——那一刻用户要的是
             去下面打字，而"下次打开面板要不要自动连"留在这里只是噪音。 -->
        <!-- [CUSTOM-20261009-209] 会话恢复：重开面板时问一句要不要恢复上次开着的几个会话。
             与 #stateActions 同形但**分开两块** —— 两组的显隐条件不同（提问时连接按钮要退场）。 -->
        <div id="restoreActions" class="state-actions" hidden>
          <button id="restoreAccept" class="state-connect"></button>
          <button id="restoreFresh" class="state-fresh">Start fresh</button>
        </div>
        <label id="restoreRememberRow" class="state-opt" hidden>
          <input type="checkbox" id="restoreRemember">
          <span>Remember my choice (don't ask again)</span>
        </label>
        <label id="autoConnectRow" class="state-opt">
          <input type="checkbox" id="autoConnectToggle">
          <span>Connect automatically when a panel opens</span>
        </label>
      </div>
    </div>
    <!-- [CUSTOM-END] CUSTOM-20260930-123 -->
    <!-- [CUSTOM-20260928-099] Loading overlay lives INSIDE the message area: as a
         full-panel fixed-position sheet it covered the tab strip, the header and the
         composer while a session loaded, so the panel looked frozen and the user could
         not switch away from the session being loaded. -->
    <div id="loadOverlay" class="load-overlay" hidden>
      <div class="load-box"><span class="spinner"></span><span>Loading session history…</span></div>
    </div>
  </div>

  <div id="composer" class="composer">
    <!-- [CUSTOM-BEGIN] CUSTOM-20260930-132 - 底部栏的**主列**（输入区）。外墙（.composer）保持
         通栏；输入卡的限宽只加在 .composer-inner 上，窄面板自动退化成满宽（max-width 自带
         这个回退，不需要 media / container query —— 那两者键的是窗口或别的容器）。
         138 起它与 .composer-aside（预留功能区）并列为两列：主列宽度天然是"面板宽 − 预留区宽"，
         于是输入卡的中线与消息列的中线一致 —— 不再需要 JS 用 padding 去补偿（那是 135 的做法，
         见 styles.ts 的 .composer）。
         它同时是弹层的定位上下文：#slashPopup 的 left/right 按输入卡算，而不是按面板算
         （后者会在宽屏下横跨整屏）。 -->
    <div class="composer-main">
      <div class="composer-inner">
        <!-- [CUSTOM-20261004-183] 停止确认条：Escape 与 Stop 按钮都不再**直接**中止轮次
             （中止不可逆：工具调用被掐断）。先在这里问一句，默认隐藏，显隐由 composer.ts 管。
             role=alertdialog 而不是 dialog：它不抢焦点、不模态 —— 只是横在输入卡上方的一条。
             ⚠️ 必须放在 .composer-inner **里面**：.composer-main 是 flex 行（justify-content:center），
             直接放它下面会被当行内项压成 0 高（第一版就是这么错的）。 -->
        <div id="stopConfirm" class="stop-confirm" hidden role="alertdialog" aria-label="Stop this turn?">
          <span class="stop-confirm-text">Stop this turn? The agent will abort what it is doing.</span>
          <button type="button" class="stop-confirm-btn" data-stop-confirm="stop">Stop</button>
          <button type="button" class="stop-confirm-btn" data-stop-confirm="keep">Keep going</button>
        </div>
        <div id="slashPopup" class="slash-popup" hidden></div>
        <!-- [CUSTOM-20261004-187] 轮次进行中、而当前 agent **不支持** steering 时的一条说明。
             以前这种情况按回车是**静默无反应**（182 把回车改成只调 send()，而 send() 守着
             "跑着不发"），用户报的就是"跑着的时候发不出去了"。现在支持的 agent 会真的把消息注入
             正在跑的那一轮；不支持的就把原因写出来，别让人以为是自己没按对。
             同样必须在 .composer-inner 里面（理由见上面 #stopConfirm）。 -->
        <div id="steerHint" class="steer-hint" hidden>This agent can't take messages mid-turn — send it when this turn finishes.</div>
        <div id="attachments" class="attachments" hidden></div>
        <!-- [CUSTOM-20261010-232] 额外根目录（additionalDirectories）的 chips 行，形态同附件行。 -->
        <div id="additionalDirectories" class="attachments" hidden></div>
        <!-- [CUSTOM-BEGIN] CUSTOM-20260930-133 - 一体式输入卡：textarea 与按钮栏合进同一个描边
             容器（原来是"带边框的 textarea + 卡外一行按钮"，中间隔一条缝，看着像两个孤立的
             控件）。焦点环也从 textarea 移到卡片上（:focus-within），见 styles.ts。
             注意这一层**不能**写 overflow —— .picker-menu 与 .slash-popup 都要向上弹出。 -->
        <div class="composer-card">
          <!-- [CUSTOM-20260930-139] rows="1"：默认只占一行，输入多行时才靠 autoGrow 长高
               （composer.ts 里那个 60px 的下限已放开，高度完全交给内容与 CSS 的 min-height）。 -->
          <textarea id="promptInput" class="prompt-input" rows="1" placeholder="Type a message…" disabled></textarea>
          <!-- [CUSTOM-BEGIN] CUSTOM-20260928-096 - 输入区重构：按钮栏（mode/model/thought）移到输入框
               下方，Send 改为图标按钮，二者与上下文进度条合并成一条置底按钮栏（pickers 靠左、
               Send 靠右）。133 起这一条整块移进 .composer-card 内（一体式卡片）。 -->
          <div class="composer-bar">
            <!-- [CUSTOM-20261010-232] 输入栏左下角通用 '+' 入口：弹出一级菜单（工作区目录 / 文件或文件夹）。
                 注意菜单**不能**带 hidden —— [hidden]{display:none!important} 会压过 .open，菜单永远不显示。 -->
            <div class="picker" id="addPicker">
              <button id="addBtn" class="picker-btn" type="button" title="Add to session">
                <span class="picker-icon">+</span>
              </button>
              <div id="addMenu" class="picker-menu"></div>
            </div>
            <div id="configPickers" class="config-pickers"></div>
            <div id="contextMeter" class="context-meter" hidden title="Context usage"></div>
            <button id="sendStopBtn" class="send-stop send" disabled title="Send" aria-label="Send"></button>
          </div>
          <!-- [CUSTOM-END] CUSTOM-20260928-096 -->
        </div>
        <!-- [CUSTOM-END] CUSTOM-20260930-133 -->
      </div>
    </div>
    <!-- [CUSTOM-END] CUSTOM-20260930-132 -->
    <!-- [CUSTOM-BEGIN] CUSTOM-20260930-138 - 预留功能区（右下角）：与输入区并列为第二列。
         [143] 它**只在钉住的大纲栏可见时**才占宽度（--acpc-aside-w 由 outline.ts 的
         applyReserve 写，其余时候为 0）—— 没有大纲就没有那根竖线，输入卡随之居中。
         宽度与大纲栏同源 ⇒ 可见时它的左边界（border-left）与大纲栏左边界在同一条竖线上。
         里面**先空着**：用户要求"留着后面设计好方案再看怎么利用"，所以 138 曾搬进来的上下文
         圆环在 143 已回到输入卡的按钮栏里（那是它原本的位置）。 -->
    <div class="composer-aside"></div>
    <!-- [CUSTOM-END] CUSTOM-20260930-138 -->
  </div>

  <!-- [CUSTOM-BEGIN] CUSTOM-20260930-152 - 表单抽屉（ACP elicitation / AskUserQuestion）：
       悬浮在输入卡之上、与它同宽同中线的一个浮层。它**不在记录流里** —— 记录流只留一行
       "待回答"条（见 client/elicitationView.ts），表单本身在这里。内容全部由 JS 生成。
       放在覆盖层之前：它的 z-index 高于底栏、低于右键菜单与图片浮层。 -->
  <div id="elicDrawer" class="elic-drawer" hidden></div>
  <!-- [CUSTOM-END] CUSTOM-20260930-152 -->

  <!-- [CUSTOM-BEGIN] CUSTOM-20261001-158 - 权限抽屉：与表单抽屉同一形状、同一位置，贴在它的
       上面（两个同时 pending 时上下堆叠，各自的高度变量相加 —— 见 styles.ts 的 .perm-drawer）。
       同样是记录驱动（记录区只留一行 ⏳ + Review，见 client/permissionView.ts）。
       为什么另起一个容器而不是并进 #elicDrawer：后者由 elicitationView 端到端拥有
       （forms / dismissed / tabs / collapsed / ResizeObserver），把两种 state 塞进一个
       容器要引入"谁拥有 body"的协调器，收益只是一个 CSS 变量。 -->
  <div id="permDrawer" class="perm-drawer" hidden></div>
  <!-- [CUSTOM-END] CUSTOM-20261001-158 -->

  <!-- [CUSTOM-20260925-067] 自定义右键菜单；项由 JS 按上下文生成（见 client/contextMenu.ts）。 -->
  <div id="ctxMenu" class="ctx-menu" hidden><div class="ctx-items"></div></div>

  <!-- [CUSTOM-20260928-097] 图片放大查看的覆盖层。点背景 / 点 ✕ / 按 Escape 关闭。 -->
  <div id="imageLightbox" class="image-lightbox" hidden>
    <button class="image-lightbox-close" title="Close" aria-label="Close">&#x2715;</button>
    <img class="image-lightbox-img" alt="">
  </div>
</body>
</html>`;
}
