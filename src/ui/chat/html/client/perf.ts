// [CUSTOM-BEGIN] CUSTOM-20261008-202 - 长任务看门狗：主线程被卡住时，日志里要有一行。
//
// 为什么常驻：客户端"点了没反应"这类症状，一半是**输入被浏览器压后/丢掉**（主线程在跑一个长任务），
// 而它在界面上与"处理器没接上""状态没同步"长得一模一样 —— 肉眼、截图、单测都分不出来。
// 2026-10-08 那次（打开 581 条记录的历史会话，客户端 50 秒一行日志都没有）就是靠"日志突然断了"反推出来的，
// 当时没有任何一处能直接说出"谁卡了多久"。这一条把它变成一行可读的日志。
//
// 判据用浏览器的 longtask 条目（Chromium 有；没有就静默不装 —— 这是诊断，不该影响界面），
// 并带上**当前耗时活的名字**（由调用方 phase() 标一个），于是日志能回答"卡在哪一段"。
// 名字是**粘性**的：longtask 条目在任务结束后才投递，那时可能已经切到下一段了；标签报的是
// "最近一次标过的重活"，够定位用（写清这一条，免得以后有人拿它当精确的因果）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
// [CUSTOM-END] CUSTOM-20261008-202
export const perfClient = `
(function (NS) {
  'use strict';

  // 300ms 是"人已经能感觉到"的下限：低于它的卡顿不值得占用日志桥的配额（173 的规矩）。
  var THRESHOLD_MS = 300;
  // 看门狗自己也要守配额：同一秒最多一行（长任务往往是成串来的）。
  var MIN_GAP_MS = 1000;
  var lastReportAt = 0;
  var currentPhase = '-';
  var installed = false;

  /** 标记"当前这一段是耗时活"。看门狗把它写进日志行（粘性，见文件头）。 */
  function phase(label) {
    currentPhase = label || '-';
  }

  /**
   * 这一条值得报吗？**纯函数**（只判阈值）—— 抽出来是因为它是这一档唯一的判据，而"报一行"这个
   * 动作本身在测试里抓不到（扩展宿主的 console 与裸 node 未必是同一个对象，见 chat-client.test.ts
   * 里那条既有说明）。配额/节流不在这里，在 report() 里。
   */
  function shouldReport(duration) {
    return typeof duration === 'number' && duration >= THRESHOLD_MS;
  }

  function report(ms) {
    var now = Date.now();
    if (now - lastReportAt < MIN_GAP_MS) { return; }
    lastReportAt = now;
    console.warn('[acpc] longtask ' + Math.round(ms) + 'ms during=' + currentPhase);
  }

  function init() {
    if (installed || typeof PerformanceObserver !== 'function') { return; }
    installed = true;
    try {
      var observer = new PerformanceObserver(function (list) {
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length; i++) {
          if (entries[i] && shouldReport(entries[i].duration)) { report(entries[i].duration); }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 不支持就算了 */ }
  }

  NS.perf = {
    init: init,
    phase: phase,
    shouldReport: shouldReport
  };
})(window.__acpc = window.__acpc || {});
`;
