// [CUSTOM-BEGIN] CUSTOM-20260928-102 - 最近一条用户消息「悬浮置顶」：新增客户端模块。
//
// **为什么**：长会话往下翻之后，读者会忘记这一轮到底在回答什么问题，而滚回上一条用户
// 消息要重新找位置。把当前这一轮的用户消息以**克隆节点**的形式挂在消息列顶部，点击跳回原处。
//
// **保持一样的渲染**（用户明确要求）：直接 `cloneNode(true)` 那个条目节点，而不是重写一份
// 摘要 —— 折叠态、图标、时刻、markdown 结构全都跟着走，不会出现"悬浮版和本体长得不一样"。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260928-102
//
// [CUSTOM-BEGIN] CUSTOM-20260928-103 - 判定规则收紧：视口里出现更晚的用户消息就不置顶。
//
// **为什么**（用户复验 102 后报的）：往上滑回去看某条用户消息时，102 的判据会**越过它**去
// 钉住更旧的那一条 —— 读者眼前明明摆着这一问，顶上却钉着上一问。规则改成：只要有更晚的
// 用户消息在视口里，就不置顶。判据只依赖当前画面、不依赖滚动方向与历史，来回滚动完全对称。
//
// 排版一致性（同一轮）：host 照抄 `.messages` 的排布条件（flex 列 + 相同的水平内边距），
// 克隆体那份 align-self / max-width 才落到和列表同一个基数上。
// 另外把列表的 `show-times` 状态抄到 host（克隆体不在 `#messages` 里，CSS 选择器够不着）。
// [CUSTOM-END] CUSTOM-20260928-103
//
// [CUSTOM-BEGIN] CUSTOM-20260928-104 - 吸顶式交棒 + 悬浮卡片 + 收缩按钮。
//
// **交棒**（用户复验 103 后从两个方案里选的）：判据从"完全离开视口"提前到"**顶边到达视口顶**"
// —— 消息的顶边一碰到那条线，它就成为"本轮提问"：本体隐藏、副本接管。能提前而不出现同屏两份，
// 靠两件事：①副本**落在本体当时所在的位置上**（TOP_GAP 那个窗口之内），所以交棒那一帧画面上
// 的内容没有位移；②本体用 `visibility: hidden` 让位（保住几何，rail 测量与 jumpTo 都不受影响）。
//
// 代价写在明处：悬浮条会**长时间盖住下方内容**（这正是收缩按钮存在的理由），
// 而且"消息滚走"这个动作在视觉上不再发生 —— 它变成"消息停住、下方内容从它下面流过"。
//
// **悬浮卡片**：底色/描边/阴影移到内层 `.sticky-card`，描边用 box-shadow 画（不占布局，
// 否则内容盒会窄 1px、克隆体就对不上原位）。
//
// **收缩按钮**：只对可折叠（多行）的消息显示 —— 单行气泡本来就是一行，给它一个按下去没变化
// 的按钮比没有按钮更糟（本仓库对"点了没反应"的态度见 pitfalls #5/#23）。
// [CUSTOM-END] CUSTOM-20260928-104
//
// [CUSTOM-BEGIN] CUSTOM-20260928-105 - 与消息列横向对齐：让开滚动条那几像素。
//
// **为什么**：用户报"悬浮面板还是没有对齐"。卡片的内容盒与 .messages 的内边距已经一致，但
// **.messages 是滚动容器**——细滚动条照样占布局宽度，于是消息的内容盒比消息列窄那么几像素，
// 而悬浮条不是滚动容器。不补偿的话，卡片右缘会比它所代表的那条消息**右出滚动条那么宽**，
// 正是"看起来差一点又说不清差在哪"的那种错位。
//
// 修法是量出来的、不是猜的：`offsetWidth - clientWidth` 就是滚动条宽度（没有滚动条时为 0），
// 写进 host 的 right。它随滚动条出现/消失自动跟着变，不引入任何常量（pitfall #24 的反面：
// 这里锚的是元素自己的真实几何）。
// [CUSTOM-END] CUSTOM-20260928-105
//
// [CUSTOM-BEGIN] CUSTOM-20261002-172 - 从「只钉一条」改成「整段前缀」：吸顶推挤 + 从上沿抽回。
//
// **用户报的**（复验 171 后）：①永远只钉一条；②上滑时旧卡不会从上沿抽回；③交棒瞬间跳变。
// 用户给出的期望模型是标准的分区头（iOS section header）语义：新卡顶边碰到**旧卡底边**时
// 两条一起悬浮（旧上、新下）；继续滚，旧卡被逐渐顶出上沿直至不可见；反向滚动时旧卡从上沿
// 慢慢抽回（只露一部分，它的底边就是"判定线"），新卡往下让位。
//
// **为什么保留克隆而不是改用原生 `position: sticky`**：导轨 `rail.ts` 的圆点位置取自
// `getBoundingClientRect()`，而它在滚动时不重测（只平移 track）。原生 sticky 会让被粘住的
// 元素 rect 随滚动漂移，圆点就会离开它代表的那条记录。克隆方案靠"本体 `visibility: hidden`
// 保几何"这个不变量继续保护它，所以不改路线。
//
// **实现**：把 104 的「取前缀里最后一条」换成「保留整段前缀（顶边越过判定线的**每一条**），
// 每条各按其上夹落位」—— 这就是原生 sticky 的等价式（逐条独立，不需要链式递推）：
//
//     natural = node.offsetTop - messagesEl.scrollTop        // 视口坐标（host 的 y=0 即滚动口顶边）
//     upper   = 下一条用户消息的 natural - 本卡高度          // 本条这一轮的"结束位置"
//     top     = min(TOP_GAP, upper)                          // 前缀内 max(natural, TOP_GAP) 恒为 TOP_GAP
//
// 于是用户描述的四步全部自然成立：新卡还在自己的自然位置上（副本都不需要建），旧卡被
// `upper` 一路顶成负值、被 `overflow: hidden` 裁掉；反向滚动时 `upper` 变大，旧卡从上沿
// 降回来、新卡跟着下移，而"旧卡底边 == 新卡顶边"在公式里逐字成立（T_i + h_i == natural_{i+1}）。
//
// **上夹必须锚"下一条的自然位置"（布局量），不能锚"下一条已渲染的位置"**：后者在两卡场景下
// 会让旧卡底边永远停在钉住的那条的位置 ⇒ 旧卡**永久残留一条边**、永远"看不到全部消失"，
// 与用户的要求直接冲突（169 之前那类"只加类不动画面"的错法）。另见 pitfalls #40。
//
// **卡片不再唯一**：每张卡一个 `.sticky-card > .sticky-body > 克隆体`，折叠状态按
// 「会话 + 卡片」各记各的（166 的 `bySession` 再下一层 —— 用户拍板：点哪张收哪张）。
// [CUSTOM-END] CUSTOM-20261002-172
export const stickyUserClient = `
(function (NS) {
  'use strict';

  // [CUSTOM-20260928-104] The bar's top gap, in pixels. It is BOTH:
  //   · the layout — written into the host below, so the copy comes to rest exactly this
  //     far below the scrollport top, and
  //   · the handoff window — the source gives way while its top is still within this many
  //     pixels of where the copy lands, so the swap itself moves nothing.
  // They have to be the same number or every handoff would carry a visible jump, so there
  // is one source for both (pitfall #19: one fact, one place).
  // [CUSTOM-20261001-166] 3px（用户要求：原先 8px 与顶栏隔得太开）。
  var TOP_GAP = 3;

  // [CUSTOM-20261002-172] 「.sticky-card」 的 2px 描边是 border-box 的 border，所以卡片比它
  // 复制的那条**记录**高这 4px。没渲染过的卡（已被顶出上沿、只参与上夹计算的那张）用
  // 「记录高 + 4」估高 —— 误差只落在屏幕外，见 heightOf。
  var CARD_BORDER = 4;

  // [CUSTOM-20261002-172] 被顶出上沿的卡再多留这么多像素才卸载。它纯粹是**避免抖动**：用户
  // 停在交界线上微抖时，卸载/重建会让每帧都克隆一次 markdown 气泡（这面板最贵的事）。
  // 它不改变画面：留着的那张整条都在 y<0，照样被 overflow:hidden 裁着。
  var KEEP_MARGIN = 24;

  var host = null;         // #stickyUser — positioning layer (transparent, click-through)
  var messagesEl = null;
  // [CUSTOM-20261002-172] 每张卡：entryId -> { id, el, bodyEl, sig, h, measured }
  // 元素**缓存**：滚动每帧只改 marginTop；只有内容真的变了（sig）才重建克隆体。
  var cards = {};
  var marked = [];         // 当前带 .sticky-source 的本体节点（集合式 diff，每帧幂等重贴）
  var lastRight = -1;      // [CUSTOM-20260928-105] last value written to host.style.right
  var sessionId = null;
  // [CUSTOM-20261002-172] 收缩状态：sessionId -> { entryId: true }。166 起它按会话记
  // （原先模块级布尔会串会话）；卡堆之后还要再按**卡**分（用户拍板：点哪张收哪张）——
  // 判据就是坑点 #38 的那句"用户说每个 X 自己保持，代码里就该出现 byX"。
  var collapsedBySession = {};
  var syncQueued = false;

  /** User entries in transcript order (the same accessor the outline uses). */
  function userEntries() {
    var out = [];
    if (!NS.transcriptView.ordered) { return out; }
    var ids = NS.transcriptView.ordered();
    for (var i = 0; i < ids.length; i++) {
      var entry = NS.transcriptView.entry(ids[i]);
      if (entry && entry.kind === 'user') { out.push(entry); }
    }
    return out;
  }

  /**
   * [CUSTOM-20261002-172] 活动前缀：顶边已经越过判定线的**每一条**用户消息。
   *
   * 104/166 的 「pinnedEntry」 取的是这一段的**最后一条**；现在整段都要（用户要的"两条一起
   * 悬浮"就是这一段有两条的那些帧）。窗口仍是严格 「<」 —— 一条停在最顶（正好落在判定线上）
   * 的提问不接管，接管了也什么都得不到。
   *
   * 往回走遇到的第一个非候选者是本轮的边界：它之后的消息只会更低，就此收工。它的 natural
   * 同时就是前缀里最后那条的**上夹**，所以顺手带回去（多读一次 offsetTop，与 104 的开销相同）。
   */
  function activePrefix(scrollTop) {
    var items = userEntries();
    var prefix = [];
    var follow = null;
    for (var i = 0; i < items.length; i++) {
      var node = NS.transcriptView.node(items[i].id);
      if (!node) { continue; }
      var natural = node.offsetTop - scrollTop;
      if (natural >= TOP_GAP) { follow = natural; break; }
      prefix.push({ id: items[i].id, node: node, natural: natural });
    }
    return { items: prefix, follow: follow };
  }

  /**
   * [CUSTOM-20261002-172] 这张卡有多高。
   *
   * 量到的（「card.h」）优先 —— 它把"用户把这张卡收成了一行"也算进去。没量过的用记录高
   * 加边框估：这样的卡**一律是被顶出上沿、整条在 y<0** 的那些（可见的那几张每次都量得到），
   * 所以这点误差只会落进屏幕外，不会让可见的画面对不上（pitfall #31 的反面：这里的"随便
   * 估一个"是被论证过的，不是懒得量）。
   */
  function heightOf(id, node) {
    var card = cards[id];
    if (card && card.h) { return card.h; }
    return (node.offsetHeight || 0) + CARD_BORDER;
  }

  /** 前缀里每张卡落在视口的哪个 y —— 上面那段注释里的三行公式。 */
  function layout(found) {
    var items = found.items;
    var placed = [];
    for (var i = 0; i < items.length; i++) {
      var h = heightOf(items[i].id, items[i].node);
      var next = (i + 1 < items.length) ? items[i + 1].natural : found.follow;
      var top = TOP_GAP;
      if (next !== null) {
        var upper = next - h;
        if (upper < top) { top = upper; }
      }
      placed.push({ id: items[i].id, node: items[i].node, h: h, top: top });
    }
    return placed;
  }

  /**
   * 该渲染哪几张。「top」 随序号单调不减，所以"底边还在屏幕上"的构成一段**后缀**，取尾部即可。
   *
   * 第一张被顶出上沿的卡要**多留 KEEP_MARGIN 像素**才卸载（见常量注释）。留着的它整条在
   * y<0，被 host 裁着 ⇒ 画面无差别，只是省掉交界线上的克隆抖动。
   */
  function visible(placed) {
    var first = 0;
    while (first < placed.length && placed[first].top + placed[first].h <= -KEEP_MARGIN) { first++; }
    return placed.slice(first);
  }

  /**
   * [CUSTOM-20260928-104] 让本体给副本让位；[CUSTOM-20261002-172] 改成**集合式 diff**。
   *
   * 原先"只留一个"靠一次引用比较就够；现在同时可能有两条在钉，所以逐帧把新集合贴上、
   * 把掉出集合的摘掉。幂等，所以 sync() 每帧都跑它 —— 被记录层重建过的节点否则会静默
   * 丢掉这个类，画面上就是"本体和副本同屏两份"。
   */
  function markSources(placed) {
    var next = [];
    var i;
    for (i = 0; i < placed.length; i++) { next.push(placed[i].node); }
    for (i = 0; i < marked.length; i++) {
      if (next.indexOf(marked[i]) < 0 && marked[i].classList) { marked[i].classList.remove('sticky-source'); }
    }
    for (i = 0; i < next.length; i++) {
      if (next[i] && next[i].classList) { next[i].classList.add('sticky-source'); }
    }
    marked = next;
  }

  /** [CUSTOM-20261002-172] clone 可能携带的状态类，摘掉。 */
  function stripCopy(copy) {
    // A picture of the message, not a second instance of it: duplicate ids would be
    // invalid, and the anchor is addressed by 'data-entry-id' on the ORIGINAL.
    copy.removeAttribute('data-entry-id');
    // [CUSTOM-20260928-104] The source carries the class that hides it, and cloneNode copies
    // class attributes — so a RE-render (Times, a new pin) would clone a hidden node and the
    // bar would come up invisible. The CSS is scoped to '.messages' for the same reason; this
    // is the second line of defence, because that failure is silent and looks like the bar
    // simply stopped working.
    if (copy.classList) { copy.classList.remove('sticky-source'); }
    if (copy.removeAttribute) { copy.removeAttribute('id'); }
    if (copy.querySelectorAll) {
      var withIds = copy.querySelectorAll('[id]');
      for (var i = 0; i < withIds.length; i++) { withIds[i].removeAttribute('id'); }
      // Buttons inside the clone (a code Copy, a fold caret) must not act on the copy.
      var buttons = copy.querySelectorAll('button');
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        if (btn.getAttribute('data-code-copy') !== null) { btn.parentNode.removeChild(btn); }
      }
    }
  }

  /**
   * [CUSTOM-20261002-172] 这张卡的克隆体是不是过期了。
   *
   * 用**结构信号**而不是高度：「settleUserFold」（记录层）会在首次拿到真实尺寸时决定这条
   * 记录有没有"藏在 caret 后面的东西"，并把 「.fold-body」 补上 —— 而它**不经过 boot 的
   * append/patch**。拿它做签名，第一帧建出来的单行副本就能在这一步之后自动重建；
   * 读高度做签名则会强制一次重排（每卡每帧一次，滚动就被拖慢了）。
   */
  function signatureOf(node) {
    return (node && node.querySelector && node.querySelector('.fold-body')) ? 'fold' : 'plain';
  }

  function collapsedFor(entryId) {
    var bySession = sessionId ? collapsedBySession[sessionId] : null;
    return !!(bySession && bySession[entryId]);
  }

  /** [CUSTOM-20261002-171] 折叠状态同步到**这张卡自己的** <details> 与三角的 tip。 */
  function applyToggle(card) {
    if (!card || !card.el) { return; }
    var collapsed = collapsedFor(card.id);
    var caretEl = card.el.querySelector ? card.el.querySelector('.fold-caret') : null;
    if (caretEl) { caretEl.title = collapsed ? 'Expand message' : 'Collapse message'; }
    var det = card.el.querySelector ? card.el.querySelector('details') : null;
    if (det && det.open === collapsed) { det.open = !collapsed; }
  }

  function setCollapsed(card, on) {
    if (sessionId) {
      var bySession = collapsedBySession[sessionId] || (collapsedBySession[sessionId] = {});
      bySession[card.id] = !!on;
    }
    // 这张卡的高度变了（收成一行）：作废缓存的高度，下一帧重量、重排。
    card.measured = false;
    card.h = 0;
    applyToggle(card);
    scheduleSync();
  }

  /** [CUSTOM-20261002-172] 建一张卡（克隆体 + 外观层）；缓存由 ensureCard 管。 */
  function buildCard(item) {
    var card = NS.dom.el('div', 'sticky-card');
    var bodyEl = NS.dom.el('div', 'sticky-body');
    card.appendChild(bodyEl);
    var copy = item.node.cloneNode(true);
    stripCopy(copy);
    // [CUSTOM-20261002-171] 会话自己的折叠状态写进这个克隆体的 details；用户点三角时浏览器
    // 原生开合，toggle 事件回来记账（按会话 + 按卡存）。
    var copyDetails = copy.querySelector ? copy.querySelector('details') : null;
    var record = { id: item.id, el: card, bodyEl: bodyEl, sig: signatureOf(item.node), h: 0, measured: false };
    if (copyDetails) {
      copyDetails.open = !collapsedFor(item.id);
      copyDetails.addEventListener('toggle', function () { setCollapsed(record, !copyDetails.open); });
    }
    bodyEl.appendChild(copy);
    card.setAttribute('data-sticky-id', item.id);
    card.title = 'Jump back to this message';
    // [CUSTOM-20261002-171] 入场动画：这一张卡是新来的才播（换钉住的那条 = 新建一张卡）。
    // 新元素上第一次加类就会播，不需要 171 那次"读 offsetWidth 强制刷新样式"的重播技巧。
    if (card.classList && card.classList.add) { card.classList.add('entering'); }
    return record;
  }

  /**
   * [CUSTOM-20261002-172] 取这张卡（有就复用、过期就重建）。
   *
   * 复用的判据只有两条：①元素还在；②「sig」 没变。于是滚动这条热路径上**一次克隆都不做**。
   */
  function ensureCard(item) {
    var card = cards[item.id];
    var sig = signatureOf(item.node);
    if (card && card.sig === sig) { applyToggle(card); return card; }
    var fresh = buildCard(item);
    cards[item.id] = fresh;
    if (card) { detach(card.el); }
    applyToggle(fresh);
    return fresh;
  }

  /**
   * [CUSTOM-20261002-172] 量还没量过的卡（新建的、被收起的）。
   *
   * 只有这件事会在"写完之后读"，所以它**必须有界**：稳态滚动时所有卡都量过了，一次都不读。
   * 桩 DOM 里 JS 建的卡 「offsetHeight」 为 0，于是退化成"记录高 + 边框"—— 测试因此可以用
   * 「node.offsetHeight」 建模卡高（见 chat-client.test.ts 的桩注释）。
   */
  function measure(placed) {
    var changed = false;
    for (var i = 0; i < placed.length; i++) {
      var card = cards[placed[i].id];
      if (!card || card.measured) { continue; }
      card.h = (card.el.offsetHeight || 0) || ((placed[i].node.offsetHeight || 0) + CARD_BORDER);
      card.measured = true;
      changed = true;
    }
    return changed;
  }

  /** 挂载/卸载/排序：幂等地把 host 的子节点对齐到 「placed」（子节点顺序 = 从旧到新）。 */
  function mount(placed) {
    var i;
    for (i = 0; i < placed.length; i++) { ensureCard(placed[i]); }
    for (i = 0; i < placed.length; i++) {
      var el = cards[placed[i].id].el;
      var at = host.childNodes[i] || null;
      if (el === at) { continue; }
      // 先摘再插：**不依赖 insertBefore 的"移动"语义**（它把已在树里的节点从原处摘下来
      // 再插到目标位置）。顺序错位的只有"被顶出去又抽回来"那一张，浏览器里两种写法等价，
      // 但显式摘掉少一层对宿主实现的假设（测试桩就没建模那个移动语义）。
      if (el.parentNode) { el.parentNode.removeChild(el); }
      host.insertBefore(el, at);
    }
    while (host.childNodes.length > placed.length) { host.removeChild(host.lastChild); }
  }

  /**
   * [CUSTOM-20261002-172] 落位：每张卡的 「marginTop」。
   *
   * 卡片留在**流里**（host 是 flex 列），所以宿主高度自动等于最下面那张的底边 —— 不需要
   * JS 写高度，而 「overflow: hidden」 天然裁掉上沿溢出（这就是"被顶出去"和"抽回来"）。
   * 偏移量按**前一张的实际底边**算，不是累加常量：卡高里含边框、还可能被收成一行，
   * 用常量累加就会在第二张上开始漂（pitfall #24 的正解：锚已经在正确位置的那张）。
   *
   * 交界处的第一张可能拿到**负的 marginTop** —— flex 子项不参与外边距折叠，负值就是把
   * 它往上拉、越过 padding 区被裁掉，正是"滑出上沿"。
   */
  function place(placed) {
    var prevBottom = 0;
    for (var i = 0; i < placed.length; i++) {
      var card = cards[placed[i].id];
      if (!card) { continue; }
      var offset = (i === 0) ? (placed[i].top - TOP_GAP) : (placed[i].top - prevBottom);
      var value = offset + 'px';
      if (card.el.style.marginTop !== value) { card.el.style.marginTop = value; }
      prevBottom = placed[i].top + placed[i].h;
    }
  }

  /**
   * [CUSTOM-20260928-105] Put the bar's right edge exactly where the messages' content box
   * ends. The messages live inside a scroll container, so a scrollbar (thin, but real) is
   * part of the layout and pushes their content box left; the bar itself never scrolls.
   * Measured rather than assumed, and 0 whenever there is no scrollbar.
   */
  function alignToContent() {
    if (!host || !host.style) { return; }
    var gap = (messagesEl.offsetWidth || 0) - (messagesEl.clientWidth || 0);
    if (gap === lastRight) { return; }
    lastRight = gap;
    host.style.right = gap > 0 ? gap + 'px' : '0px';
  }

  /** [CUSTOM-20260928-103] 克隆体不在 #messages 里，「.messages.show-times」 这类状态类够不着它。 */
  function applyTimes() {
    if (!host || !host.classList) { return; }
    var on = !!(messagesEl.classList && messagesEl.classList.contains('show-times'));
    host.classList.toggle('show-times', on);
  }

  /**
   * [CUSTOM-20261002-172] One coalesced pass per frame (the scroll handler only marks the work).
   *
   * 顺序是**先读后写**（pitfall #17 的姊妹条）：
   *   ① 读：scrollTop / 每条的 offsetTop（activePrefix）、没量过的卡的高度（measure）
   *   ② 算：纯算术（layout / visible）
   *   ③ 写：建卡、排序、marginTop、class、hidden
   * 唯一"写完再读"的是 measure()，它只对**刚建的卡**跑，稳态滚动一次都不跑。
   *
   * 两遍 layout 是有意的：第一遍用"还没量到的卡"的估高决定该挂哪几张，量完之后再算一遍真值。
   * 第二遍通常与原值相同（绝大多数卡早就量过），代价是几条加法。
   */
  function sync() {
    syncQueued = false;
    if (!host || !messagesEl) { return; }
    // 没有布局（面板隐藏 / 还没排布）就整帧放弃：否则会把一屏 0 高的卡"量"进缓存。
    if (!messagesEl.clientHeight) { return; }
    var scrollTop = messagesEl.scrollTop;
    var found = activePrefix(scrollTop);
    var placed = visible(layout(found));
    mount(placed);
    if (measure(placed)) {
      placed = visible(layout(found));
      mount(placed);
    }
    place(placed);
    markSources(placed);
    if (host.hidden !== (placed.length === 0)) { host.hidden = placed.length === 0; }
    applyTimes();
    alignToContent();
  }

  /** 一帧一次的 sync（「NS.dom.schedule」 不去重，流式 chunk 会让同帧排上多次）。 */
  function scheduleSync() {
    if (syncQueued) { return; }
    syncQueued = true;
    NS.dom.schedule(sync);
  }

  /** Transcript replaced (session switch / hydrate): nothing is pinned yet. */
  function reset() {
    detachAll();
    markSources([]);
    cards = {};
    if (host) { host.hidden = true; }
  }

  /**
   * [CUSTOM-20260928-103] Re-render every mounted card even though they did not change — for
   * the times the SAME message must look different (the Times toggle). Forcing the rebuild
   * keeps one code path for rendering; it is a user-initiated toggle, so paying for a clone
   * here is fine (the guard exists to keep SCROLL cheap).
   */
  function refresh() {
    detachAll();
    cards = {};
    sync();
  }

  /**
   * [CUSTOM-20261001-166] Which session the bar is standing in for (boot calls this on
   * every focus change, right where it resets the bar). Picking up that session's own
   * collapse state is the whole point: the choice belongs to the conversation, not to
   * the panel.
   */
  function setSession(id) {
    sessionId = id || null;
  }

  function detach(el) {
    if (el && el.parentNode) { el.parentNode.removeChild(el); }
  }

  function detachAll() {
    var ids = Object.keys(cards);
    for (var i = 0; i < ids.length; i++) { detach(cards[ids[i]].el); }
  }

  function init() {
    host = NS.dom.qs('stickyUser');
    messagesEl = NS.dom.qs('messages');
    if (!host || !messagesEl) { return; }
    // The gap is layout AND handoff window (TOP_GAP) — written here so the two cannot drift.
    if (host.style) { host.style.paddingTop = TOP_GAP + 'px'; }
    messagesEl.addEventListener('scroll', function () { scheduleSync(); });
    // [CUSTOM-20261002-172] 入场动画只播一次：结束就摘掉标记（每次新建那张卡再加）。
    // 挂在 host 上靠冒泡收 —— 卡片是动态建的，逐个挂监听会在重建时漏摘。
    host.addEventListener('animationend', function (event) {
      var el = event && event.target;
      if (el && el.classList) { el.classList.remove('entering'); }
    });
    host.addEventListener('click', function (event) {
      // [CUSTOM-20261001-166] 卡片里的折叠三角（.fold-caret）就是用户眼里的「收缩按钮」。
      // 它走两条路：原生的 <details> 开关 + 冒泡到这里的跳转 —— 于是「点一下既折叠
      // 又跳走」，折叠立刻被跳转抹掉（用户报的「点了还是触发的定位、收缩没生效」）。
      // [CUSTOM-20261002-171] 现在它是本条的收缩控件，而且**走原生**：不 preventDefault —— 让
      // 浏览器开合那个 details（与界面里的折叠完全同逻辑），它的 toggle 事件把状态记回来。
      // 这里唯一要做的就是**不跳转**。
      var caret = event.target && event.target.closest ? event.target.closest('.fold-caret') : null;
      if (caret) {
        if (event.stopPropagation) { event.stopPropagation(); }
        return;
      }
      event.preventDefault();
      // [CUSTOM-20261002-172] 跳转目标取自**被点的那张卡**（卡堆里每张各代表一条消息）。
      var card = event.target && event.target.closest ? event.target.closest('.sticky-card') : null;
      var id = card ? card.getAttribute('data-sticky-id') : null;
      var node = id ? NS.transcriptView.node(id) : null;
      // [CUSTOM-20261002-170] 落点要让开**悬浮条自己的高度**（+ 一点缝）：
      // 原先是 TOP_GAP+1（4px），而悬浮条高 124px 上下 ⇒ 跳过去的消息正好被它盖住，
      // 用户看到的就是"界面里的和悬浮的两条对话重叠"（真浏览器探针量到 overlap:true）。
      // 让位量**量出来的**，不是猜的：隐藏时 offsetHeight 为 0，退化成一个小缝，同样成立。
      // [CUSTOM-20261002-171] 落点回到**交接窗口之内**（0 < TOP_GAP）：顶边一碰到那条线就交棒，
      // 消息**就地接管悬浮条的位置**（用户预期："定位在悬浮框的位置"），本体同时让位
      // （visibility:hidden）⇒ 既不重叠、也不会像 170 那样被挤到下面去。
      // 170 的"让开悬浮条自身高度"把问题解反了：那让开的是**别的东西占着的位置**。
      if (node) { NS.scroll.jumpTo(node, 0); }
    });
  }

  NS.stickyUser = {
    init: init, sync: sync, schedule: scheduleSync, reset: reset, refresh: refresh,
    setSession: setSession,
  };
})(window.__acpc = window.__acpc || {});
`;
