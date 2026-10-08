// [CUSTOM-BEGIN] CUSTOM-20260930-123 - 面板初始界面：连接状态卡。新增客户端模块。
//
// 取代 090 那套「两段静态提示 + 一个按钮」的空态。它要解决的问题是**连接过程在界面上不可见**：
// 点完 Connect 之后面板只会立刻切到草稿页，而真正的 spawn + initialize（首次 npx 可能下载几分钟）
// 没有任何反馈，用户会反复点击。现在这一层是一个三态卡片：
//
//   disconnected  未连接   —— 标题 + 一句说明 + Connect 按钮 + 自动连接复选框
//   connecting    连接中   —— 转圈 + 按钮禁用（这就是「不要重复点」的那道闸）
//   ready         已就绪   —— 引导用户去下面的输入框；按钮退场（用户选择：纯引导卡不放按钮）
//   creating      建会话中 —— [195] 草稿页首条消息发出 → 会话回来之间。与 connecting 同形：
//                             转圈 + 秒表；理由见 HINTS.creating 里的真机采样。
//
// 三条纪律（破了任何一条都会重演本仓库付过账的问题）：
//   1. **本模块绝不写 #emptyState 的 display** —— 那是 boot.showEmpty() 一个人的活（081/082 的
//      单一写者约定）。这里只写内容：textContent / checked / disabled / 子节点 hidden。
//   2. 写入文本一律**先比较再写**：卡片是 role="status"，每写一次屏幕阅读器就播报一次。
//   3. 自动连接的布防**必须幂等** —— boot 会在同一个文档上投递两次（attachSurface 一次、
//      客户端 ready 一次）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
// [CUSTOM-END] CUSTOM-20260930-123
export const stateCardClient = `
(function (NS) {
  'use strict';

  var els = null;
  var connected = false;
  var connecting = false;
  // [CUSTOM-20261006-195] 草稿页的首条消息已经交上去、会话还没回来（第四个相位，见 HINTS.creating）。
  var creating = false;
  var autoConnect = false;
  // [CUSTOM-20261009-209] 会话恢复：上次开着的会话 + 设置值 + "面板此刻空着、可以问"。
  // 三者都由 boot 喂（它才知道有没有聚焦会话/草稿），本模块只负责画。
  var recoverSessions = [];
  var restorePref = 'ask';
  var restoreAskable = false;
  var errorText = '';
  // [CUSTOM-20260930-126] 「+」在未连接时按下的意图：它要的是一张**新草稿**，不是一个已有会话。
  // 连接成功后由 boot 消费（见 boot 的 case 'connection'）。
  var draftIntent = false;
  var armed = false;
  var armTimer = null;
  var slowTimer = null;
  // [CUSTOM-20261006-194] 连接中显示的东西：agent 最近一行 stderr（说明为什么在等）与秒表。
  var detail = '';
  var connectStartedAt = 0;
  var tickTimer = null;

  // [CUSTOM-20260930-131] 500ms 太赶：面板刚渲染完就自动连接，用户还没看清这张卡片上
  // 写着什么。1s 让"卡片出现 → 开始连接"有个可感知的先后（用户要求）。
  var AUTO_CONNECT_DELAY_MS = 1000;
  // 超过这么久还没有回话时**不谎报失败**：ensureConnected 本身没有超时，首次 npx 下载
  // 可以几分钟。只把按钮放开（让用户能再点一次）并说明原因——谎报失败比慢更糟。
  var SLOW_CONNECT_MS = 45000;

  var TITLES = {
    disconnected: 'Claude Code',
    connecting: 'Connecting to Claude Code\\u2026',
    // [CUSTOM-20260930-130] 不是 'Connected to Claude Code'：那串字在扫读时会被当成
    // 'Connect to Claude Code'（动词短语），于是"已经连上了"被读成"还需要连接"。
    // 状态句比被动语态难误读。
    ready: 'Claude Code is ready',
    // [CUSTOM-20261006-195] 首条消息正在建会话（见 HINTS.creating）。
    creating: 'Creating this session\\u2026'
  };
  var HINTS = {
    disconnected: 'Connect to start a session in this panel.',
    connecting: 'Starting the agent process. npx may need to download the package the first time.',
    ready: 'Type your first message below to start a session.',
    // [CUSTOM-20261006-195] 用户报：「在这个界面发出第一条消息后，要等较长时间消息区才有反应」。
    //
    // 那段时间**全在 session/new 这一发请求里**（真机日志三次采样：agent 侧 session/create 的
    // sdk-initialize 一步 675ms / 11116ms / 13194ms，而"建完会话 → 应用草稿选择 → 发出消息"
    // 一共只要 ~160ms）。它不可缩短（agent 内部），但**必须可见**：原本这段时间卡片还写着
    // "Claude Code is ready"、输入框里的字又故意留着（058 不清空，失败时要保命）⇒ placeholder
    // 被内容挡着 ⇒ 屏幕上没有任何一处能看出"已经在建了"。
    creating: 'Starting the agent for this session \\u2014 the first message waits for it.'
  };

  /** [CUSTOM-20261009-209] 该不该问"要不要恢复上次那几个会话"。 */
  function restoreVisible() {
    return restoreAskable && recoverSessions.length > 0 && restorePref !== 'never';
  }

  function restoreTitle() {
    var n = recoverSessions.length;
    return 'Restore ' + n + (n === 1 ? ' session' : ' sessions') + ' from your last window?';
  }

  /** 列几条标题当预览（与 tab 上那条兜底链一致：title → id 前 8 位），超过三条收成省略号。 */
  function restoreHintText() {
    var parts = [];
    for (var i = 0; i < recoverSessions.length && i < 3; i++) {
      var s = recoverSessions[i] || {};
      parts.push(s.title || String(s.sessionId || '').slice(0, 8) || 'session');
    }
    if (recoverSessions.length > 3) { parts.push('\u2026'); }
    return parts.join(' \u00b7 ');
  }

  function phase() {
    if (connecting) { return 'connecting'; }
    // [CUSTOM-20261009-209] 提问**压过 ready**：面板空着、上次还有会话时，用户先要回答这个。
    if (connected && restoreVisible()) { return 'restore'; }
    // [CUSTOM-20261006-195] 建会话只在**已连接**时成立：socket 若半路掉了，就退回 disconnected
    // （那时 Connect 按钮该回来），而不是把用户留在一张永远转圈的卡片上。
    if (creating && connected) { return 'creating'; }
    if (connected) { return 'ready'; }
    return 'disconnected';
  }

  /** Only write when it actually changes: this node is a live region. */
  function setText(node, text) {
    if (!node) { return; }
    var next = text || '';
    if (node.textContent !== next) { node.textContent = next; }
  }

  function render() {
    if (!els) { return; }
    var p = phase();
    // [CUSTOM-20261006-195] 「在等」的两态：连接中 / 建会话中。转圈、aria-busy 与"按钮退场"
    // 三条都按它算 —— 免得两个相位各写一遍、迟早漏一处。
    var waiting = (p === 'connecting' || p === 'creating');
    var asking = p === 'restore';
    setText(els.title, asking ? restoreTitle() : TITLES[p]);
    // [CUSTOM-20261006-194] 连接中若拿到了 agent 的 stderr（npx 在下载那几行），就**用它**代替
    // 那句套话 —— 用户卡在连接界面时要的是"为什么在等"，而不是"正在启动"。
    // [CUSTOM-20261006-195] 建会话中：套话 + **秒表**（同 194 的道理：数字在动才说明"还在等"）。
    setText(els.hint, asking
      ? restoreHintText()
      : (p === 'creating'
        ? HINTS.creating + elapsedLabel()
        : ((p === 'connecting' && detail) ? detail : HINTS[p])));
    setText(els.error, errorText);
    if (els.error) { els.error.hidden = !errorText; }
    if (els.busy) { els.busy.hidden = !waiting; }
    if (els.connect) {
      els.connect.disabled = p === 'connecting';
      setText(els.connect, p === 'connecting'
        ? 'Connecting\\u2026' + elapsedLabel()
        : 'Connect Claude Code');
    }
    // ready 态的按钮整块退场（连同它的间距），不是只把它藏起来。[195] 建会话中同理：
    // 那一刻按 Connect 没有意义（而且 connect 按钮的相位文案会跟卡片的标题打架）。
    if (els.actions) { els.actions.hidden = asking || p === 'ready' || p === 'creating'; }
    // [CUSTOM-20261009-209] 提问那一组自己一套按钮 + 一行"记住我的选择"。
    if (els.restoreActions) { els.restoreActions.hidden = !asking; }
    if (els.restoreAccept) {
      var n = recoverSessions.length;
      setText(els.restoreAccept, 'Restore ' + n + (n === 1 ? ' session' : ' sessions'));
    }
    if (els.restoreRememberRow) { els.restoreRememberRow.hidden = !asking; }
    // [CUSTOM-BEGIN] CUSTOM-20260930-127 - 已连接时也不问"要不要自动连接"：连上了，用户要的是
    // 去下面打字，而开关管的是"下次打开这个面板"，留在这儿只是噪音。它仍然只在**未连接**时
    // 出现——那正是用户会想关掉它的时刻。
    if (els.autoRow) { els.autoRow.hidden = asking || p === 'ready' || p === 'creating'; }
    // [CUSTOM-END] CUSTOM-20260930-127
    if (els.card) { els.card.setAttribute('aria-busy', waiting ? 'true' : 'false'); }
    // [CUSTOM-20260930-131] 相位是**整块面板**的状态，不只属于卡片：header 上的按钮要不要
    // 露出来（未连接时只剩历史和地址）由 CSS 按这个属性决定。写在 body 上，而不是让每个
    // 按钮自己监听相位——那会有三次同步，且本地点击发起的 connecting 到不了它们。
    if (document.body && document.body.setAttribute) { document.body.setAttribute('data-phase', p); }
  }

  function clearSlowTimer() {
    if (slowTimer) { window.clearTimeout(slowTimer); slowTimer = null; }
  }

  // [CUSTOM-20261006-194] 连接中的秒表。用户报"一直卡在连接界面"——数字在动至少能说明
  // "还在等"而不是"死了"。只在 connecting 期间跑，离开相位就停（别让一个计时器常驻）。
  function elapsedLabel() {
    if (!connectStartedAt) { return ''; }
    var secs = Math.floor((Date.now() - connectStartedAt) / 1000);
    if (secs < 1) { return ''; }
    return ' ' + (secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm' + (secs % 60) + 's');
  }

  function startTick() {
    // [CUSTOM-20261006-195] 顺序是承重的：stopTick() 会把 connectStartedAt 清零，原来写在
    // 它前面的 connectStartedAt = Date.now() 因此**当场被抹掉** ⇒ elapsedLabel() 永远返回 ''
    // ⇒ 194 那个秒表其实一次都没显示过数字（"数字在动"是它存在的唯一理由）。
    stopTick();
    connectStartedAt = Date.now();
    if (typeof window.setInterval !== 'function') { return; }
    tickTimer = window.setInterval(function () { render(); }, 1000);
  }

  function stopTick() {
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = null; }
    connectStartedAt = 0;
  }

  function armSlowTimer() {
    clearSlowTimer();
    slowTimer = window.setTimeout(function () {
      slowTimer = null;
      if (!connecting) { return; }
      connecting = false;
      errorText = 'Still starting\\u2026 npx may be downloading the agent package. You can try again.';
      render();
    }, SLOW_CONNECT_MS);
  }

  /** Ask the host to make sure the process is up. Idempotent while one is in flight. */
  function beginConnect(wantDraft) {
    if (wantDraft) { draftIntent = true; }
    if (connecting) { return; }
    connecting = true;
    errorText = '';
    detail = '';
    if (!tickTimer) { startTick(); }
    render();
    armSlowTimer();
    NS.bridge.post({ type: 'connectAgent' });
  }

  function onConnection(message) {
    var state = message && message.state;
    if (state === 'connecting') {
      connecting = true;
      errorText = '';
      // [CUSTOM-20261006-194] agent 的 stderr 逐行跟着这条消息下来（见 ChatPanelHost.noteAgentStderr）；
      // 没有 detail 的那条是相位本身（发起连接），此时清掉上一轮的残留。
      detail = (message && message.detail) || '';
      if (!tickTimer) { startTick(); }
      armSlowTimer();
    } else if (state === 'connected') {
      connecting = false;
      connected = true;
      errorText = '';
      detail = '';
      stopTick();
      clearSlowTimer();
    } else if (state === 'failed') {
      connecting = false;
      detail = '';
      stopTick();
      errorText = (message && message.message) || 'Could not connect to the agent.';
      clearSlowTimer();
    } else {
      return;
    }
    render();
  }

  // [CUSTOM-20260927-090] Comes from boot / focus / sessionsChanged: the host's
  // agentConnected is what says the process is DOWN (its socket died), which no
  // connection phase can express.
  function setConnected(value) {
    connected = value === true;
    if (connected) { connecting = false; clearSlowTimer(); }
    render();
  }

  function setAutoConnect(value) {
    autoConnect = value === true;
    if (els && els.toggle) { els.toggle.checked = autoConnect; }
    render();
  }

  function setError(text) {
    errorText = text || '';
    render();
  }

  /**
   * [CUSTOM-20261006-195] 草稿页的首条消息交出去了，会话还没回来。
   *
   * 谁调：composer.send() 的草稿分支（state.draftPending = true 那一步，同一帧）。
   * 谁收尾：boot 的 resolveDraft（成功）/ failDraft（失败）/ dropDraft（用户把草稿页关掉）。
   *
   * 幂等：重复调用不重启秒表。判据用 creating 自己（而不是 tickTimer）—— 秒表在桩 DOM 里
   * 根本起不来（没有 setInterval），那时 tickTimer 永远是 null，"已在等"会被误判成"刚开始等"。
   */
  function beginCreating() {
    var wasCreating = creating;
    creating = true;
    errorText = '';
    if (!wasCreating) { startTick(); }
    render();
  }

  function endCreating() {
    if (!creating) { return; }
    creating = false;
    stopTick();
    render();
  }

  /**
   * Arm the auto-connect timer, once per document. Re-checked when it fires:
   * the panel may have connected, or the user may already be typing in another
   * draft, by the time 500ms are up.
   */
  function noteBoot(info) {
    var boot = info || {};
    connected = boot.agentConnected === true;
    if (boot.autoConnect !== undefined) { setAutoConnect(boot.autoConnect === true); }
    render();
    if (armed) { return; }
    // A panel that opened onto a session has nothing to connect for.
    if (boot.focused === true) { return; }
    if (!autoConnect || connected || connecting) { return; }
    armed = true;
    armTimer = window.setTimeout(function () {
      armTimer = null;
      if (!autoConnect || connected || connecting) { return; }
      // The direct signal for "the user can already type" (pitfall #25: never a proxy).
      if (NS.composer && NS.composer.isComposable && NS.composer.isComposable()) { return; }
      beginConnect(false);
    }, AUTO_CONNECT_DELAY_MS);
  }

  /** Consume the '+' intent: true exactly once, if it was pressed while offline. */
  function takeDraftIntent() {
    var wanted = draftIntent;
    draftIntent = false;
    return wanted;
  }

  function init() {
    els = {
      card: NS.dom.qs('stateCard'),
      busy: NS.dom.qs('stateBusy'),
      title: NS.dom.qs('stateTitle'),
      hint: NS.dom.qs('stateHint'),
      error: NS.dom.qs('stateError'),
      actions: NS.dom.qs('stateActions'),
      // [CUSTOM-20260930-127] The whole row, not just the input: hiding the checkbox
      // alone would leave its label text sitting there.
      autoRow: NS.dom.qs('autoConnectRow'),
      connect: NS.dom.qs('emptyConnect'),
      toggle: NS.dom.qs('autoConnectToggle'),
      // [CUSTOM-20261009-209] 会话恢复那一组（两个按钮 + 一行"记住我的选择"）。
      restoreActions: NS.dom.qs('restoreActions'),
      restoreAccept: NS.dom.qs('restoreAccept'),
      restoreFresh: NS.dom.qs('restoreFresh'),
      restoreRememberRow: NS.dom.qs('restoreRememberRow'),
      restoreRemember: NS.dom.qs('restoreRemember')
    };
    if (els.connect) {
      els.connect.addEventListener('click', function (event) {
        event.preventDefault();
        beginConnect(false);
      });
    }
    // [CUSTOM-20261009-209] 恢复那一组：回答交给 boot（它才知道会话/草稿有没有、怎么建本地 tab），
    // 这里只把"要不要记住"一起带过去（勾了才写设置）。
    function answerRestore(kind) {
      if (NS.boot && NS.boot.restoreChoice) {
        NS.boot.restoreChoice(kind, !!(els.restoreRemember && els.restoreRemember.checked === true));
      }
    }
    if (els.restoreAccept) {
      els.restoreAccept.addEventListener('click', function (event) { event.preventDefault(); answerRestore('restore'); });
    }
    if (els.restoreFresh) {
      els.restoreFresh.addEventListener('click', function (event) { event.preventDefault(); answerRestore('fresh'); });
    }
    if (els.toggle) {
      els.toggle.addEventListener('change', function () {
        var value = els.toggle.checked === true;
        // Optimistic: the host echoes the real value back (and corrects us if the
        // write failed), so the switch never shows a value the setting does not have.
        setAutoConnect(value);
        NS.bridge.post({ type: 'setAutoConnect', value: value });
      });
    }
    render();
  }

  /**
   * [CUSTOM-20261009-209] boot 喂进来的"可恢复的会话 + 设置值 + 现在问不问"。
   * 'askable' 由 boot 算（只有它知道有没有聚焦会话/草稿），本模块只按它决定画不画提问态。
   */
  function setRestore(payload) {
    var next = (payload && payload.sessions) || [];
    recoverSessions = next;
    restorePref = (payload && payload.pref) || 'ask';
    restoreAskable = !!(payload && payload.askable);
    render();
  }

  NS.stateCard = {
    init: init,
    // [CUSTOM-20261009-209] 会话恢复：喂数据 + 问"现在是不是该问用户"。
    setRestore: setRestore,
    setRestorePref: function (value) { restorePref = value || 'ask'; render(); },
    isRestorePending: function () { return phase() === 'restore'; },
    noteBoot: noteBoot,
    setConnected: setConnected,
    setAutoConnect: setAutoConnect,
    setError: setError,
    onConnection: onConnection,
    beginConnect: beginConnect,
    // [CUSTOM-20261006-195] 「建会话中」这一相位（草稿页首条消息 —— 见 beginCreating）。
    beginCreating: beginCreating,
    endCreating: endCreating,
    takeDraftIntent: takeDraftIntent,
    isConnecting: function () { return connecting; },
    isCreating: function () { return creating; },
    isConnected: function () { return connected; },
    phase: phase
  };
})(window.__acpc = window.__acpc || {});
`;
