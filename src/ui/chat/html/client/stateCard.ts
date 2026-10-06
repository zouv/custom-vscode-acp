// [CUSTOM-BEGIN] CUSTOM-20260930-123 - 面板初始界面：连接状态卡。新增客户端模块。
//
// 取代 090 那套「两段静态提示 + 一个按钮」的空态。它要解决的问题是**连接过程在界面上不可见**：
// 点完 Connect 之后面板只会立刻切到草稿页，而真正的 spawn + initialize（首次 npx 可能下载几分钟）
// 没有任何反馈，用户会反复点击。现在这一层是一个三态卡片：
//
//   disconnected  未连接   —— 标题 + 一句说明 + Connect 按钮 + 自动连接复选框
//   connecting    连接中   —— 转圈 + 按钮禁用（这就是「不要重复点」的那道闸）
//   ready         已就绪   —— 引导用户去下面的输入框；按钮退场（用户选择：纯引导卡不放按钮）
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
  var autoConnect = false;
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
    ready: 'Claude Code is ready'
  };
  var HINTS = {
    disconnected: 'Connect to start a session in this panel.',
    connecting: 'Starting the agent process. npx may need to download the package the first time.',
    ready: 'Type your first message below to start a session.'
  };

  function phase() {
    if (connecting) { return 'connecting'; }
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
    setText(els.title, TITLES[p]);
    // [CUSTOM-20261006-194] 连接中若拿到了 agent 的 stderr（npx 在下载那几行），就**用它**代替
    // 那句套话 —— 用户卡在连接界面时要的是"为什么在等"，而不是"正在启动"。
    setText(els.hint, (p === 'connecting' && detail) ? detail : HINTS[p]);
    setText(els.error, errorText);
    if (els.error) { els.error.hidden = !errorText; }
    if (els.busy) { els.busy.hidden = p !== 'connecting'; }
    if (els.connect) {
      els.connect.disabled = p === 'connecting';
      setText(els.connect, p === 'connecting'
        ? 'Connecting\\u2026' + elapsedLabel()
        : 'Connect Claude Code');
    }
    // ready 态的按钮整块退场（连同它的间距），不是只把它藏起来。
    if (els.actions) { els.actions.hidden = p === 'ready'; }
    // [CUSTOM-BEGIN] CUSTOM-20260930-127 - 已连接时也不问"要不要自动连接"：连上了，用户要的是
    // 去下面打字，而开关管的是"下次打开这个面板"，留在这儿只是噪音。它仍然只在**未连接**时
    // 出现——那正是用户会想关掉它的时刻。
    if (els.autoRow) { els.autoRow.hidden = p === 'ready'; }
    // [CUSTOM-END] CUSTOM-20260930-127
    if (els.card) { els.card.setAttribute('aria-busy', p === 'connecting' ? 'true' : 'false'); }
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
    connectStartedAt = Date.now();
    stopTick();
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
      toggle: NS.dom.qs('autoConnectToggle')
    };
    if (els.connect) {
      els.connect.addEventListener('click', function (event) {
        event.preventDefault();
        beginConnect(false);
      });
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

  NS.stateCard = {
    init: init,
    noteBoot: noteBoot,
    setConnected: setConnected,
    setAutoConnect: setAutoConnect,
    setError: setError,
    onConnection: onConnection,
    beginConnect: beginConnect,
    takeDraftIntent: takeDraftIntent,
    isConnecting: function () { return connecting; },
    isConnected: function () { return connected; },
    phase: phase
  };
})(window.__acpc = window.__acpc || {});
`;
