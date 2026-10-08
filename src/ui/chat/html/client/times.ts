// [CUSTOM-BEGIN] CUSTOM-20261008-200 - 记录区「Times」（每条记录的时刻）开关：状态与接线。
//
// 它**不是**一个布尔：
//   · timesBySession —— 用户在那个会话里最后一次拨动的值；
//   · timesDefault   —— 用户最后一次在**任何地方**拨动的值，是"没有记录的会话"与草稿页的默认。
// 有效值 = timesBySession[会话] ?? timesDefault；算它的地方只有一个（timesOnFor）。
//
// 状态归宿主 globalState（setUiPref / uiPrefs，与大纲、tab 顺序同一条记录）：关掉编辑器面板、
// 重载窗口之后它还该在，另一面改了这边也该跟上 —— 而它以前只是 webview 本地的一个全局布尔
// （vscode.setState 的 showTimes，见 migrateLegacy 的一次性迁移）。
//
// 独立成模块而不是留在 boot 里，理由与 outline/stateCard 相同：它有自己的状态机、自己的持久化、
// 自己的控件，因而可以在桩 DOM 里被单独驱动（boot 的 init() 要接十几个元素，桩不出来）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20261008-200
export const timesClient = `
(function (NS) {
  'use strict';

  var messagesEl = null;
  var toggleEl = null;
  // 谁在聚焦（由 boot 的焦点咽喉点喂进来）—— 拨开关时要记到它名下。
  var currentSessionId = null;
  var timesBySession = {};
  var timesDefault = false;
  // 本面当前知道的会话 id：写回宿主前用它裁表（见 pruned）。
  var timesKnown = [];

  /**
   * 显示开 / 关。只翻两个类，不重渲染：.rec-time 元素一直在 DOM 里
   * （transcriptView.place 建立的槽位），所以切换是纯粹的样式翻转。
   */
  function apply(on) {
    if (messagesEl) {
      if (on) { messagesEl.classList.add('show-times'); } else { messagesEl.classList.remove('show-times'); }
    }
    if (toggleEl) { toggleEl.className = on ? 'nest-toggle' : 'nest-toggle off'; }
    // [CUSTOM-20260928-103] 置顶副本是 #messages **外面**的克隆体，它带的是自己那份类
    // （stickyUser.render 抄过去）。光切上面的类够不着已经在屏上的副本 ⇒ 重渲染它一次。
    if (NS.stickyUser && NS.stickyUser.refresh) { NS.stickyUser.refresh(); }
  }

  /** 这个会话此刻该显示的值：它自己的记录，没有就回落默认（草稿页与空态走的也是这一条）。 */
  function timesOnFor(sessionId) {
    if (sessionId && Object.prototype.hasOwnProperty.call(timesBySession, sessionId)) {
      return timesBySession[sessionId] === true;
    }
    return timesDefault === true;
  }

  /**
   * 写回宿主时只带**本面知道的会话**那几条。这张表随用户拨开关增长，而"关掉/裁掉的会话"
   * 再打开时回落到默认值即可（如实、且有界 —— 宿主那一侧还有第二道上限，
   * 见 ChatPanelHost.sanitizeTimesMap）。
   */
  function pruned() {
    var out = {};
    for (var i = 0; i < timesKnown.length; i++) {
      var id = timesKnown[i];
      if (Object.prototype.hasOwnProperty.call(timesBySession, id)) { out[id] = timesBySession[id] === true; }
    }
    return out;
  }

  function persist() {
    NS.bridge.post({ type: 'setUiPref', timesBySession: pruned(), timesDefault: timesDefault === true });
  }

  /** 会话列表的旁观者。调用点就在 boot 里既有那两处 setSessions 旁边（boot / sessionsChanged）。 */
  function noteSessions(sessions) {
    var ids = [];
    for (var i = 0; i < sessions.length; i++) {
      var id = sessions[i] && sessions[i].sessionId;
      if (id) { ids.push(id); }
    }
    timesKnown = ids;
  }

  /**
   * 焦点变了：换成**这个会话**的值。放在 boot 的 applyFocus 里调 —— 那是焦点变化的唯一
   * 咽喉点（与 stickyUser.setSession 同一形态），换会话、切草稿、回到空态都会经过它。
   */
  function setFocus(sessionId) {
    currentSessionId = sessionId || null;
    // 聚焦的会话一定存在（宿主刚推过来），"会话列表"那条消息还没到也不算"不认识它" —— 否则
    // 此刻拨的开关会被 pruned() 裁掉，用户看到的就是"开了，下次回来又关着"。
    if (currentSessionId && timesKnown.indexOf(currentSessionId) < 0) { timesKnown.push(currentSessionId); }
    apply(timesOnFor(currentSessionId));
  }

  /**
   * 收下宿主那份 Times（uiPrefs 消息）。**缺字段 = 那个字段从来没被写过**，这时保留本地值
   * 而不是清成 false —— 否则第一条只带大纲偏好（或只带 tab 顺序）的消息就会把用户开着的
   * Times 关掉。收完按当前焦点应用：改它的可能是**另一个面**。
   */
  function applyPrefs(prefs) {
    if (prefs && prefs.timesBySession && typeof prefs.timesBySession === 'object') {
      var next = {};
      for (var key in prefs.timesBySession) {
        if (Object.prototype.hasOwnProperty.call(prefs.timesBySession, key)) {
          next[key] = prefs.timesBySession[key] === true;
        }
      }
      timesBySession = next;
    }
    if (prefs && typeof prefs.timesDefault === 'boolean') { timesDefault = prefs.timesDefault; }
    apply(timesOnFor(currentSessionId));
  }

  /**
   * 一次性迁移：Times 以前只存在 webview 本地（vscode.setState 的 showTimes，一个全局布尔）。
   * 本地记着"开着"而宿主那边还没有这条记录时，把它播上去一次 —— 迁移标记落在同一份本地 state
   * 里，所以每个文档最多跑一次。本地值胜出的理由：它是用户真实拨过的那个值，而宿主那一份是
   * 本次改动才出现的（没有更"新"的信息可言）。
   */
  function migrateLegacy() {
    var ui = NS.boot && NS.boot.recallUi ? NS.boot.recallUi() : {};
    if (ui.timesMigrated === true) { return; }
    if (NS.boot && NS.boot.persistUi) { NS.boot.persistUi({ timesMigrated: true }); }
    if (ui.showTimes !== true) { return; }
    timesDefault = true;
    persist();
    console.warn('[acpc] times: migrated the webview-local showTimes=true to the host prefs');
  }

  function init() {
    messagesEl = NS.dom.qs('messages');
    toggleEl = NS.dom.qs('timeToggle');
    migrateLegacy();
    apply(timesOnFor(currentSessionId));
    if (toggleEl) {
      toggleEl.addEventListener('click', function () {
        var on = !(messagesEl && messagesEl.classList.contains('show-times'));
        apply(on);
        // 一笔动作写成两处：记到这个会话名下，同时成为默认值（新会话沿用最后一次拨的值）。
        timesDefault = on;
        if (currentSessionId) { timesBySession[currentSessionId] = on; }
        persist();
      });
    }
  }

  NS.times = {
    init: init,
    apply: apply,
    setFocus: setFocus,
    applyPrefs: applyPrefs,
    noteSessions: noteSessions,
    // 桩测试的读法：此刻这个会话该不该显示时刻。
    isOn: function () { return timesOnFor(currentSessionId); }
  };
})(window.__acpc = window.__acpc || {});
`;
