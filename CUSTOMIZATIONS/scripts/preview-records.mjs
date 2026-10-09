#!/usr/bin/env node
// =============================================================================
// preview-records.mjs — 在**真 Chromium** 里渲染记录区并截图（布局验收用）
//
// 为什么需要它（真实的两次翻车）：
//   记录区的布局问题一直是"推理 + 让用户 F5 看"两条腿走——而本项目的测试边界写得很清楚：
//   桩 DOM 能测**逻辑**（结构/顺序/类名/切分），**测不了布局**（尺寸/换行/对齐）。
//   2026-09-29 一天之内在同一个点上翻了两次：
//     · 以为"作者样式能覆盖 details 折叠时隐藏子节点" ⇒ 折叠态其实什么都看不到；
//     · 以为 flex-wrap + flex-basis:100% 会让正文换行 ⇒ 展开态正文跑到了图标行。
//   两次都是**纯布局**的假设，两次都靠用户 F5 才发现。这个脚本把这一环自动化：
//   它**不重写**任何标记与样式，直接把 webview 真正用的 CSS + 客户端脚本搬进一个
//   独立 HTML，让真浏览器渲染，再截图（可以让人看，也可以让 AI 读图）。
//
// 它复用生产代码，不复制知识（pitfall #19）：
//   · CSS  = src/ui/chat/html/styles.ts 的模板体
//   · 标记 = src/ui/chat/html/body.ts 的模板体（surface 固定为 view）
//   · 脚本 = src/ui/chat/html/client/index.ts 里 MODULES 的全部客户端模块（按同一顺序）
//   所有这些都通过"抽取模板字符串"得到——与 check-webview-client.mjs 同一套机制。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/preview-records.mjs [--out <dir>] [--keep]
//     生成 <dir>/records.html，并对下面 SHOTS 里的每一档各截一张图。
//     默认 <dir> = 系统临时目录/acpc-preview，默认截图后删除 HTML（--keep 保留）。
//     需要本机有 Chrome 或 Edge（Windows 上 Edge 一定有）。没有浏览器时**跳过**并 exit 0。
//   node CUSTOMIZATIONS/scripts/preview-records.mjs --print  # 只打印 HTML 路径，不截图
//
// [CUSTOM-20260930-136] 改前 / 改后对比配方（布局改动的标准验收姿势，pitfall #31）：
//   1) 改动前：git stash → npm run compile-tests → 本脚本 --out <tmp>/acpc-before
//   2) 改动后：git stash pop → npm run compile-tests → 本脚本 --out <tmp>/acpc-after
//   3) 并排看两张同名图（如 composer-wide.png），差异就是改动本身。
//   要读数字而不只是看图：
//     <浏览器> --headless=new --disable-gpu --hide-scrollbars --user-data-dir=<tmp>/p \
//       --virtual-time-budget=2500 --window-size=1440,1000 \
//       --dump-dom "file:///<dir>/records.html#composerwideprobe" | grep -o '{"kind":"composer".*}'
//   ⚠️ 宽度类问题必须显式给 --window-size（且记住 innerWidth ≈ 窗口宽 − 16），因为默认的
//   500 是**故意的窄档** —— 输入卡的限宽（720px）与右侧的预留功能区（240px）在它下面根本
//   不显形，截出来的"改前/改后"会一模一样。
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(SCRIPT_DIR, '..', '..');
const HTML_DIR = join(ROOT, 'src', 'ui', 'chat', 'html');
const CLIENT_DIR = join(HTML_DIR, 'client');

// [CUSTOM-20260930-147] 启动自检：driver() 的返回值是**模板字符串**，里面出现反引号会把它提前
// 结束 —— 而本脚本不在 check-webview-client.mjs 的扫描范围内（它只看 src/ui/chat/html/**），
// 于是这类错误要到运行时才炸，而且报错位置指向别处。这个文件已经踩过十次，直接自检。
(function assertNoBackticksInDriver() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // [CUSTOM-20261004-179] ⚠️ 这里曾经是 src.indexOf("function driver()") —— 而它命中的是**本自检
  // 自己那行代码里的字面量**（就在上面几行），于是 bt/end 落在几十字符的空当里，自检一直在
  // 校验一段几乎空的区域：我在驱动里写进两个反引号（模板提前终止、整个脚本语法错误、浏览器里
  // 所有探针一起哑掉），它照样报 OK。定位真身的判据必须是**行首**那个定义，且取**最后一个**
  // 匹配（本文件里只有一处真定义）。守卫自己坏掉的方式就是静默放行 —— 见 pitfalls #19/#27。
  const start = src.lastIndexOf(String.fromCharCode(10) + "function driver()");
  const bt = src.indexOf("`", start);
  const end = src.indexOf("`;", bt + 1);
  const body = src.slice(bt + 1, end);
  if (bt < 0 || end < bt || body.length < 1000) {
    console.error("  [FATAL] 找不到真正的 driver 模板体（自检自身可能又跑偏了）—— 别信这次 OK");
    process.exit(1);
  }
  if (body.indexOf("`") >= 0) {
    console.error("  [FATAL] driver() 的模板体里有反引号（pitfalls #11）—— 它会被当成字符串结束符");
    process.exit(1);
  }
})();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT_DIR = value('--out', join(tmpdir(), 'acpc-preview'));
const PRINT_ONLY = flag('--print');
const KEEP = flag('--keep') || PRINT_ONLY;

/**
 * The REAL runtime strings, taken from the compiled modules.
 *
 * [CUSTOM-20260929-117] This script used to re-parse the `.ts` template literals
 * itself — and that copy was WRONG in a way that mattered: TypeScript unescapes
 * `\\u25b8` to `▸`, while a raw text extraction hands the literal 6-character
 * string to the browser, so every escaped glyph came out as text (`▸` visible
 * on the card). Rather than re-implement the TS lexer, take what the compiler
 * produced: `npm run compile-tests` writes `out/**`, and importing it means this
 * harness renders the same bytes the webview gets — no second source of truth
 * (pitfall #19).
 */
function loadCompiled() {
  const url = pathToFileURL(join(ROOT, 'out', 'ui', 'chat', 'html', 'index.js')).href;
  if (!existsSync(fileURLToPath(url))) {
    console.log('  [SKIP] 还没有 out/ 编译产物：先跑 `npm run compile-tests`（或 npm test）');
    process.exit(0);
  }
  const require = createRequire(import.meta.url);
  const dir = join(ROOT, 'out', 'ui', 'chat', 'html');
  return {
    styles: require(join(dir, 'styles')).styles,
    body: require(join(dir, 'body')).body,
    clientSource: require(join(dir, 'client', 'index')).clientSource,
    // [CUSTOM-20261004-184] 宿主侧 SafeMarkdown 的**真实输出**，不做手写近似 ——
    // #linkclick 档要验的正是"宿主写出来的 HTML 经过真 sanitize / 真点击之后还剩什么"，
    // 于是它的**输入**必须是真产物（同 #bootround 用真 clientSource 的道理）。
    fileLinkHtml: new (require(join(dir, '..', 'markdown')).SafeMarkdown)()
      .render('[GOAL.md:74](GOAL.md:74)'),
  };
}

/**
 * The records to render. Shapes come from the real entry model
 * (src/ui/chat/transcript/types.ts); `html` is what SafeMarkdown would have returned
 * (the extension-side round trip is not part of what this script measures, and
 * pretending it returned something is honest here — it is the input, not the subject).
 */
const AT = Date.parse('2026-09-29T10:24:00Z');
const FIXTURES = [
  { id: 'u1', kind: 'user', at: AT, text: '请继续' },
  {
    id: 'a1', kind: 'assistant', at: AT + 1000,
    text: '啊唯，三条都收到。先读现有代码确认 #2 和 #3 的现状。',
    html: '<p>啊唯，三条都收到。先读现有代码确认 #2 和 #3 的现状。</p>',
  },
  { id: 'u2', kind: 'user', at: AT + 2000, text: '第一行\n第二行\n第三行' },
  {
    id: 'a2', kind: 'assistant', at: AT + 3000, streaming: false,
    text: '这是助手消息的折叠验收。',
    html: '<p>这是助手消息的折叠验收。</p>'
      + '<ul><li>折叠后应当只占一行：图标 + 三角 + 正文首行</li>'
      + '<li>展开后正文应当在标题行的下面</li></ul>'
      + '<pre><code>npm test\nnpm run lint</code></pre>'
      + '<p>最后一段，用来撑出高度。</p>',
  },
  {
    id: 't1', kind: 'thought', at: AT + 4000, streaming: false, elapsedMs: 3200,
    text: '推理内容', html: '<p>思考块本来就能折叠，这里只是对照。</p>',
  },
  // [CUSTOM-20260929-117] 工具卡的 IN / OUT 段（对齐官方插件）。第一张带 description
  // （官方那个"Bash 查看博客目录…"就是它），第二张刻意没有 —— 用来对照回退到命令行。
  {
    id: 'tool1', kind: 'tool', at: AT + 5000,
    toolView: {
      toolCallId: 'call_bash_1', title: 'ls -la "D:/Git/zgame/zgame_blog_astro"', kind: 'execute',
      status: 'completed', toolName: 'Bash', description: '查看博客目录及父目录现有内容',
      command: 'ls -la "D:/Git/zgame/zgame_blog_astro" 2>/dev/null && echo "---" && ls "D:/Git/zgame" 2>/dev/null',
      locations: [], elapsedMs: 420,
      items: [{ type: 'content', block: { type: 'text', text: 'total 4\ndrwxr-xr-x 1 zouwei 1049089 0 Sep 29 16:06 .\ndrwxr-xr-x 1 zouwei 1049089 0 Sep 29 16:06 ..\n---\nzgame_blog\nzgame_blog_astro' } }],
    },
  },
  {
    id: 'tool2', kind: 'tool', at: AT + 6000,
    toolView: {
      toolCallId: 'call_bash_2', title: 'npm test', kind: 'execute',
      status: 'completed', toolName: 'Bash',
      command: 'npm test',
      locations: [], elapsedMs: 91000,
      items: [{ type: 'content', block: { type: 'text', text: '136 passing (1s)\n[main] Extension host exited with code: 0' } }],
    },
  },
  // [CUSTOM-20260929-118] 兜底：content 里没有可渲染的项（这里给一个空白文本块，真机上
  // 表现为"OUT 是个空盒子"），但 agent 报了 rawOutput ⇒ OUT 显示原始输出。
  // [CUSTOM-20260929-119] 表单卡（AskUserQuestion）。字段表取自**真 adapter v0.84.0** 在
  // 本机实跑时送来的 requestedSchema（见 CUSTOMIZATIONS/scripts/probe-elicitation.mjs）：
  // 每题一个 oneOf（选项标签即 const）+ 一个 "Other" 自由文本框。
  {
    id: 'ask1', kind: 'elicitation', at: AT + 8000,
    elicitation: {
      promptId: 's1:1', sessionId: 's1', message: '选哪个方案？', status: 'pending',
      fields: [
        {
          name: 'question_0', kind: 'select', title: '选哪个方案',
          options: [{ value: 'A 方案', title: 'A 方案' }, { value: 'B 方案', title: 'B 方案' }],
        },
        { name: 'question_0_custom', kind: 'text', title: 'Other' },
      ],
    },
  },
  {
    id: 'tool3', kind: 'tool', at: AT + 7000,
    toolView: {
      toolCallId: 'call_bash_3', title: 'git status --short', kind: 'execute',
      status: 'completed', toolName: 'Bash', description: '查看工作区状态',
      command: 'git status --short',
      locations: [], elapsedMs: 120,
      output: ' M src/ui/chat/html/client/toolCallView.ts\n?? CUSTOMIZATIONS/scripts/preview-records.mjs',
      items: [{ type: 'content', block: { type: 'text', text: '   ' } }],
    },
  },
];

const THEME = `:root {
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-panel-border: #2b2b2b;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryForeground: #ffffff;
  --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-textLink-foreground: #4daafc;
  --vscode-progressBar-background: #0e70c0;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-toolbar-hoverBackground: #2a2d2e;
  --vscode-focusBorder: #0078d4;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
  --vscode-input-background: #313131;
  --vscode-editor-font-family: Consolas, monospace;
}`;

/** The driver: render the fixtures, then honour '#collapsed' by closing every fold. */
function driver() {
  return `
(function () {
  var NS = window.__acpc;
  var messages = document.getElementById('messages');
  NS.transcriptView.init(messages);
  var fixtures = ${JSON.stringify(FIXTURES)};
  var failed = 0;
  var hash = location.hash;
  // [CUSTOM-20260930-123] 状态卡模式：不喂记录，让卡片独占消息区。
  // 原因是几何：.empty-state 是 inset:0 的覆盖层，但**只有 .state-card 有背景色**，
  // 底下有记录时正文会从卡片四周透出来 —— 那样截出来的图不是用户看到的样子。
  var CARD_MODE = hash.indexOf('empty') >= 0 || hash.indexOf('connecting') >= 0 || hash.indexOf('ready') >= 0
    // [CUSTOM-20260930-151] 草稿页（点「+」的新会话页）的用户现场就是"卡片 + 底栏"，
    // 底下有记录时正文会从卡片四周透出来，截出来不是用户看到的样子。
    || hash.indexOf('draft') >= 0;
  // [CUSTOM-20260930-123] #narrow：把消息区钉死在 260px。**不要**改用 --window-size 来
  // 测窄侧边栏——实测它只影响截图的裁剪，布局视口是另一回事（dump-dom 与 screenshot
  // 两种模式下的视口宽度甚至互不相同），于是"卡片溢出了吗"这个问题的答案会随模式变化。
  // 卡片溢出的判据是**容器**宽度，把容器钉死才是同一件事。
  if (hash.indexOf('narrow') >= 0) {
    var area = document.getElementById('messageArea');
    if (area) { area.style.width = '260px'; }
  }
  if (CARD_MODE) {
    NS.stateCard.init();
    NS.stateCard.setAutoConnect(true);
    if (hash.indexOf('connecting') >= 0) {
      NS.stateCard.onConnection({ type: 'connection', state: 'connecting' });
    } else if (hash.indexOf('ready') >= 0 || hash.indexOf('draft') >= 0) {
      NS.stateCard.setConnected(true);
    }
  }
  // HYDRATE, not append: a real panel always arrives as a snapshot (boot/focus), and
  // hydrating is what gives the client its session id — the very thing the host
  // validates on every renderMarkdown item (see the reply below).
  var SESSION = 'preview-session';
  if (!CARD_MODE) {
    try { NS.transcriptView.hydrate({ sessionId: SESSION, entries: fixtures }); }
    catch (err) { failed++; console.warn('hydrate failed:', err); }
  }
  // Tool text goes through the same markdown round-trip as an assistant bubble, so
  // without an extension on the other end the item would stay EMPTY. Answer with what
  // SafeMarkdown would answer for a block of plain output — the harness supplies the
  // INPUT here, exactly like the assistant fixtures already supply their html.
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  try {
    var toolItems = NS.toolCallView.pendingMarkdownItems(SESSION) || [];
    var dropped = 0;
    for (var p = 0; p < toolItems.length; p++) {
      // Mirror the host: EVERY item is validated by verifySession, and one without a
      // session id is dropped silently. The harness used to skip this check and answer
      // everything itself — which is exactly how the "tool bodies stay empty" bug
      // stayed invisible here while the real panel showed empty boxes.
      if (!toolItems[p].sessionId) { dropped++; continue; }
      NS.toolCallView.applyMarkdown(
        toolItems[p].key, '<pre><code>' + escapeHtml(String(toolItems[p].text || '')) + '</code></pre>');
    }
    if (dropped > 0) { console.warn(dropped + ' tool markdown item(s) DROPPED: the request carried no sessionId'); }
  } catch (err) { console.warn('markdown reply failed', err); }
  if (location.hash.indexOf('collapsed') >= 0) {
    var folds = messages.querySelectorAll('details');
    for (var f = 0; f < folds.length; f++) { folds[f].open = false; }
  }
  // [CUSTOM-20260930-130] #tabs：标签栏上的状态点。颜色说"处在什么状态"，外圈说"正在做事"，
  // 五个标签把全部组合各摆一个（空闲 / 轮次在跑 / 等权限 / 载入历史 / 后台有新输出）。
  if (location.hash.indexOf('tabs') >= 0) {
    NS.tabs.init();
    var row = function (id, title, over) {
      var base = { sessionId: id, agentName: 'Claude Code', title: title, cwd: '/tmp',
        createdAt: '', loading: false, running: false, unread: false, waiting: false };
      for (var k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) { base[k] = over[k]; } }
      return base;
    };
    NS.tabs.setSessions([
      row('s1', '空闲', {}),
      row('s2', '轮次在跑', { running: true }),
      row('s3', '等你回答', { running: true, waiting: true }),
      row('s4', '载入历史', { loading: true }),
      row('s5', '后台有新输出', { unread: true }),
    ]);
  }
  // [CUSTOM-20260930-129] #times：打开每条记录的时刻（真面板里由 header 的 Times 开关切，
  // 这里只是给 #messages 加那个类）。
  if (location.hash.indexOf('times') >= 0) {
    messages.classList.add('show-times');
  }
  // [CUSTOM-20261008-202] markdown 回填"整批一次跑完" vs "分帧"的**对照读数**。
  //
  // 现场（2026-10-08 真机）：在草稿页打开一条 581 条记录的历史会话，客户端连着 50 秒写不出一行
  // 日志（输入被浏览器压后/丢掉），用户那时正在点标签栏 —— "loading 里切不了 tab"。同一批 139 条
  // 回填是一条长任务：每条都要解析 HTML、消毒、插 DOM，还要读一次几何（patch 收尾的 follow()）。
  // 这里把两种形状放在**同一份 DOM、同一批条目**上各量一次，数字写进 #probe：
  //   lump  = 旧形状（driver 里直接 for 一遍应用全部，就是切分前 boot 那段循环）
  //   slice = 新形状（NS.transcriptView.queueMarkdown，按时间片落地）
  // 读数：总时长 / 最长单任务 / 长任务条数。判据不是"总时长变小"（总量本来就一样），
  // 而是 **slice 的最长单任务必须远小于 lump 的**（输入能不能被处理，只看最长那一个）。
  if (hash.indexOf('mdsliceprobe') >= 0) {
    // 这一档量的就是**真面板**里的代价：先把 boot 补起来（模块加载时 document 还是 'loading'，
    // 它把 init 挂给了 DOMContentLoaded，而这个事件在预览里早就过去了）—— 否则 scroll/rail/
    // sticky 全是未初始化的空壳，patch 收尾的那次几何读就成了免费操作（第一版就是这么量出
    // "8ms"的：不是不贵，是根本没在量真东西）。
    document.dispatchEvent(new Event('DOMContentLoaded'));
    var perfTasks = [];
    try {
      if (typeof PerformanceObserver === 'function') {
        new PerformanceObserver(function (list) {
          var es = list.getEntries();
          for (var pi = 0; pi < es.length; pi++) { perfTasks.push(Math.round(es[pi].duration)); }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch (e) { /* 不支持就只读总时长 */ }

    var RECORDS = 600;
    var OPS = 300;
    function bigHtml(i) {
      return '<p>回填 ' + i + '</p><ul>'
        + '<li>' + '一段不短的正文，用来看消毒与插入的真实代价。'.repeat(6) + '</li>'
        + '<li>' + '第二行同样长，再来一段凑到几 KB。'.repeat(6) + '</li>'
        + '</ul><pre><code>' + ('const x = 1;' + String.fromCharCode(10)).repeat(40) + '</code></pre>';
    }
    var started = Date.now();
    function makeEntries() {
      var out = [];
      for (var i = 0; i < RECORDS; i++) {
        // 一半助手、一半工具卡（回放里的体量主要来自这两类；工具卡没有 view model 时
        // place() 会建一张最简卡，仍是真 DOM、真占位）。
        if (i % 2 === 0) {
          out.push({ id: 'p-a' + i, kind: 'assistant', at: started + i * 10, streaming: false,
            text: '条目 ' + i + '：' + '很长的一段正文，用来把 DOM 撑大。'.repeat(12) });
        } else {
          out.push({ id: 'p-t' + i, kind: 'tool', at: started + i * 10, toolCallId: 'call-' + i });
        }
      }
      return out;
    }
    function batchItems() {
      var out = [];
      // 助手记录的 id 是偶数位（见 makeEntries）。
      for (var i = 0; i < OPS; i++) { out.push({ entryId: 'p-a' + (i * 2), html: bigHtml(i) }); }
      return out;
    }
    function runLump(items) {
      var t0 = performance.now();
      for (var i = 0; i < items.length; i++) { NS.transcriptView.patch(items[i].entryId, { html: items[i].html }); }
      return performance.now() - t0;
    }
    function runSliced(items, done) {
      var t0 = performance.now();
      NS.transcriptView.queueMarkdown(items);
      // 排空的判据：这一批落的正文都进了 DOM（队列是排帧跑的，不能只看一帧）。
      // 用 querySelectorAll 数类名，别用 innerHTML —— 后者每帧序列化整棵树，量出来的就是它自己。
      var frames = 0;
      var wait = function () {
        frames++;
        var body = NS.dom.qs('messages');
        var landed = body && body.querySelectorAll('.bubble-body.md').length >= items.length;
        if (landed || frames >= 600) { done(performance.now() - t0, frames); return; }
        requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    }
    (function () {
      var report = { kind: 'mdslice' };
      NS.transcriptView.reset();
      NS.transcriptView.hydrate({ sessionId: 'perf', entries: makeEntries() });
      var tLump = runLump(batchItems());
      report.lumpMs = Math.round(tLump);
      report.lumpLongest = perfTasks.length > 0 ? Math.max.apply(null, perfTasks) : 0;
      report.lumpTasks = perfTasks.length;
      perfTasks.length = 0;
      NS.transcriptView.reset();
      NS.transcriptView.hydrate({ sessionId: 'perf', entries: makeEntries() });
      runSliced(batchItems(), function (ms) {
        report.slicedMs = Math.round(ms);
        report.slicedLongest = perfTasks.length > 0 ? Math.max.apply(null, perfTasks) : 0;
        report.slicedTasks = perfTasks.length;
        var pre = document.getElementById('probe') || (function () {
          var el = document.createElement('pre'); el.id = 'probe'; document.body.appendChild(el); return el;
        })();
        pre.textContent += String.fromCharCode(10) + JSON.stringify(report);
      });
    })();
  }
  // [CUSTOM-20261009-209] #restorecard：会话恢复的提问态（真 boot + 真卡片）。
  // 走真路径：补一次 DOMContentLoaded 让 boot 真的 init，再喂一条带 recoverable 的 boot 消息。
  // 带 probe 时**额外点一次【Restore】**，然后读"客户端发出去的是什么"与 tab 栏里那几个待恢复的 tab
  // —— 这一段（boot 里的 restoreChoice）桩 DOM 够不着，只有真环境能验。
  if (hash.indexOf('restorecard') >= 0) {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    var restorePosts = [];
    NS.bridge.post = function (m) { restorePosts.push(m); };
    window.postMessage({
      type: 'boot', focused: null, sessions: [], snapshot: null, meta: null,
      agentConnected: true, autoConnect: false, defaultCwd: '/work/example-project',
      recoverable: [
        { agentName: 'Claude Code', sessionId: 'aaaaaaaa-1111', cwd: '/tmp', title: 'Piano gameplay' },
        { agentName: 'Claude Code', sessionId: 'bbbbbbbb-2222', cwd: '/tmp', title: 'Commit both repos' },
        { agentName: 'Claude Code', sessionId: 'cccccccc-3333', cwd: '/tmp', title: 'Restore tabs' }
      ],
      restorePref: 'ask'
    }, '*');
    if (hash.indexOf('probe') >= 0) {
      window.setTimeout(function () {
        var accept = document.getElementById('restoreAccept');
        if (accept) { accept.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        var restoreTabs = document.querySelectorAll('.tab[data-restore-id]');
        var pre = document.getElementById('probe') || (function () {
          var el = document.createElement('pre'); el.id = 'probe'; document.body.appendChild(el); return el;
        })();
        pre.textContent += String.fromCharCode(10) + JSON.stringify({
          kind: 'restoreclick',
          phase: document.body.getAttribute('data-phase'),
          title: (document.getElementById('stateTitle') || {}).textContent,
          accept: (document.getElementById('restoreAccept') || {}).textContent,
          acceptHidden: (document.getElementById('restoreActions') || {}).hidden === true,
          hasChoice: !!(NS.boot && NS.boot.restoreChoice),
          bootKeys: Object.keys(NS.boot || {}),
          sameNs: window.__acpc === NS,
          posted: restorePosts.map(function (m) { return m.type; }),
          restoreTabs: restoreTabs.length,
          labels: Array.prototype.map.call(restoreTabs, function (t) { return String(t.textContent).trim(); }),
        });
      }, 200);
    }
  }

  // [CUSTOM-20261008-206] #filechip：用户气泡里的**文件** chip（走真渲染路径 hydrate）。
  // 判据两条：①它与 caret / 图片 chip **同在第一行**（以前文件 chip 掉到第二行）；
  // ②tag 高一点、带 </> 图标。图片那一条是对照（它一直就在第一行）。
  if (hash.indexOf('filechip') >= 0) {
    NS.transcriptView.reset();
    NS.transcriptView.hydrate({ sessionId: 'filechip', entries: [
      { id: 'f1', kind: 'user', at: 1000, text: '两边都提交git', attachments: [{
        type: 'resource_link', uri: 'f:/P4/x/PianoGameplayDefine.cs',
        name: 'PianoGameplayDefine.cs', title: 'PianoGameplayDefine.cs',
        path: 'f:/P4/x/PianoGameplayDefine.cs',
      }] },
      { id: 'f2', kind: 'user', at: 2000, text: '带图片的', attachments: [{
        type: 'image', mimeType: 'image/png', name: 'shot.png',
        dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtQ9RvAAAAAElFTkSuQmCC',
      }] },
    ] });
  }
  // [CUSTOM-20261008-206] #refchip：输入框引用栏里的「编辑器当前文件」格（'+' 还没引用）。
  // 走真路径：composer.init + setFocus（有会话）+ setActiveFile（宿主推来的那个文件）。
  if (hash.indexOf('refchip') >= 0) {
    // 相位必须是"已连接"：未连接时整块底栏 display:none（143），引用栏根本看不见。
    NS.stateCard.init();
    NS.stateCard.setConnected(true);
    NS.transcriptView.init(messages);
    NS.transcriptView.reset();
    NS.composer.init();
    NS.composer.setFocus({ sessionId: 'ref-session', agentName: 'Claude Code', title: null,
      cwd: '/tmp', createdAt: '', running: false, loading: false, unread: false }, null);
    NS.composer.setActiveFile({
      path: 'f:/P4/x/PianoGameplayDefine.cs', name: 'PianoGameplayDefine.cs',
      lineStart: 12, lineEnd: 40,
    });
  }

  // [CUSTOM-20261008-199] #nosessionheader：**已连接但还没有会话**时的那条 header ——
  // 用户报的现场就是它（连接适配器要下载几十秒，这期间地址栏空着、Times 被挤到左边）。
  // 状态照真面板来：stateCard 置成已连接（它写 body[data-phase]，Times 的显隐由那个属性决定），
  // 再喂一份宿主会发的默认目录。
  if (location.hash.indexOf('nosessionheader') >= 0) {
    NS.tabs.init();
    NS.stateCard.init();
    NS.stateCard.setConnected(true);
    NS.tabs.setDefaultCwd('/work/example-project');
    NS.tabs.setFocus(null);
  }
  // [CUSTOM-20260930-129] #gauge：底部那颗上下文圆环。#gaugehot 造高用量（红），
  // #gaugebusy 造"有轮次在跑"（外圈转起来）。composer.init 需要的那几个元素 body 里都有。
  if (location.hash.indexOf('gauge') >= 0) {
    var used = location.hash.indexOf('gaugehot') >= 0 ? 960000 : (location.hash.indexOf('gaugewarn') >= 0 ? 780000 : 450000);
    NS.composer.init();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: used, size: 1000000 } });
    if (location.hash.indexOf('gaugebusy') >= 0) { NS.composer.setRunning(true); }
    // #gaugebig：把圆环放大若干倍，好看清环宽、圆心字号、外圈弧长这类细节（24px 的
    // 原尺寸在整页截图里只有几个像素大）。
    // 判据用 'big' 而不是 'gaugebig'：#gaugebusybig 里并没有 'gaugebig' 这个子串
    // （中间隔着 busy），按后者匹配会静默地什么都不做。
    if (location.hash.indexOf('big') >= 0) {
      var meter = document.getElementById('contextMeter');
      if (meter) {
        meter.style.transform = 'scale(5)';
        meter.style.transformOrigin = 'bottom right';
        meter.style.marginRight = '80px';
        meter.style.marginBottom = '40px';
      }
      // 标签栏：7px 的圆点与它的外圈在整页截图里只有几个像素，整体放大才看得清。
      var strip = document.getElementById('tabStrip');
      if (strip) {
        strip.style.transform = 'scale(2.5)';
        strip.style.transformOrigin = 'top left';
        strip.style.padding = '10px';
      }
    }
  }
  // [CUSTOM-20260930-136] 底部栏（输入卡 + 预留功能区）的验收档（#composer*）。
  // 为什么要专门给档：输入卡的限宽与右侧预留区只在面板够宽时才显形，而本脚本默认 500 ——
  // 不给宽档的话"改前 / 改后"两张截图会一模一样（见 shoot 的尺寸注释）。记录区在这一档里
  // 同样要有内容：rail 的点与大纲栏的锚点都从它来（上面已 hydrate）。
  if (location.hash.indexOf('composer') >= 0) {
    // rail 平时由 boot 初始化，这里补上 —— 引导条是"版心居中后脱不脱节"的第一现场，
    // 而它的横向位置**全靠 CSS**（.rail{left:0}），所以要把它挂到真节点上才看得见。
    NS.rail.init(document.getElementById('messages'),
      document.getElementById('rail'),
      document.getElementById('railTrack'));
    // hydrate 不会通知 rail（真面板里是 boot 在 append / renderMarkdown 后调 invalidate），
    // 少了这一句 railEl.hidden 会一直是 true —— 而引导条恰恰是"版心居中后脱不脱节"的第一
    // 现场，它不显示这一档就白截了。
    NS.rail.invalidate();
    // [CUSTOM-20260930-144] 滚动模块平时由 boot 初始化。不接上它，"贴底让位"那条规则在预览里
    // 永远不会生效（onScroll 没绑上），下面 composerbottom / composermid 两个档就白测了。
    NS.scroll.init(document.getElementById('messages'),
      document.getElementById('jumpToLatest'));
    NS.composer.init();
    // 三个 picker（Manual / Opus / Default）是这块界面既有的视觉重量：不给的话卡片底部
    // 空荡荡，截出来的观感不作数。形状照 protocol.ts 的 SessionConfigOption。
    var composerMeta = {
      availableCommands: [
        { name: 'clear', description: '清空当前会话' },
        { name: 'compact', description: '压缩上下文' },
        { name: 'init', description: '生成 AGENTS.md' },
      ],
      configOptions: [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'manual',
          options: [{ value: 'manual', name: 'Manual' }, { value: 'auto', name: 'Auto' }] },
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus',
          options: [{ value: 'opus', name: 'Opus (1M context)' }, { value: 'sonnet', name: 'Sonnet' }] },
        { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }] },
      ],
      usage: { used: 450000, size: 1000000 },
    };
    NS.composer.setFocus(
      { sessionId: SESSION, agentName: 'Claude Code', running: false, loading: false }, composerMeta);
    // 一律走"设 value + 派发 input"而不是内部函数：这是用户真会触发的那条路径（监听器里
    // 才会 autoGrow / 弹斜杠菜单），与 preview 一贯的"别绕开真入口"一致。
    var inputEl = document.getElementById('promptInput');
    if (inputEl) {
      inputEl.value = '这一行用来撑出输入框的真实高度，看版心与卡片的观感。';
      inputEl.dispatchEvent(new Event('input'));
    }
    if (location.hash.indexOf('outline') >= 0) {
      // 钉住式侧栏这一档专门验 .composer 的 padding-right 有没有把侧栏宽度扣掉：
      // 不扣的话输入区的中心会比消息列的中心偏 S/2（S=240 时就是 120px）。
      NS.outline.init(document.getElementById('messages'),
        document.getElementById('outline'),
        document.getElementById('outlineBtn'));
      // hydrate 不会通知大纲（真面板里是 boot 在 append/hydrate 后调 invalidate），
      // 少了这一句 anchorsPresent 仍是 false，钉住的栏根本不会显示。
      NS.outline.invalidate();
      NS.outline.applyPrefs({ outlineMode: 'sidebar', outlineWidth: 240 });
    }
    if (location.hash.indexOf('focus') >= 0 && inputEl) { inputEl.focus(); }
    if (location.hash.indexOf('slash') >= 0 && inputEl) {
      inputEl.value = '/';
      inputEl.dispatchEvent(new Event('input'));
    }
    if (location.hash.indexOf('tall') >= 0 && inputEl) {
      var tallLines = [];
      for (var tl = 1; tl <= 24; tl++) { tallLines.push('第 ' + tl + ' 行 —— 用来把 autoGrow 顶到上限。'); }
      inputEl.value = tallLines.join('\\n');
      inputEl.dispatchEvent(new Event('input'));
    }
    // [CUSTOM-20260930-151] 草稿页：输入卡必须**完整**。走真路径 —— 先 setDraft（它会向宿主
    // 请求），再把宿主的应答喂给 setDraftOptions。改之前这一档只有光秃秃一个输入框，正是用户
    // 报的"输入框没显示完整（模式转换、模型选择等）"。
    if (location.hash.indexOf('draft') >= 0) {
      NS.composer.setDraft({ draftId: 'draft-1', cwd: null });
      // setDraft 清空了 configOptions（草稿本来没有会话），所以上面那个 value 也不该留着：
      // 真机上草稿是空的。这两句的顺序就是"用户点 + 之后，应答到达"那个瞬间。
      if (inputEl) { inputEl.value = ''; inputEl.dispatchEvent(new Event('input')); }
      NS.composer.setDraftOptions({
        draftId: 'draft-1',
        agentName: 'Claude Code',
        configOptions: composerMeta.configOptions,
        availableCommands: composerMeta.availableCommands
      });
    }
  }
  // [CUSTOM-20260930-152] 表单抽屉（ACP elicitation / AskUserQuestion）：记录里只留一行
  // "待回答"条，表单本体在悬浮抽屉里 —— 多题按 tab 分页、单选用下拉（选项 = 名称 + 介绍）、
  // 可收起成一行。载荷形状照 adapter 的产物（'askUserQuestionsToCreateRequest'）：每题一个
  // 'oneOf'/'anyOf' 字段，外加一个 '_meta' 标记的自由文本框。
  if (location.hash.indexOf('elic') >= 0) {
    var elicState = {
      promptId: 'preview:1',
      sessionId: SESSION,
      status: 'pending',
      message: '「导出项目」→ 生成「发布1-图文」文档，这个功能在哪个位置？',
      fields: [
        { name: 'question_0', kind: 'select', title: '功能位置',
          options: [
            { value: 'in-repo', title: '就在当前项目（ai-vibe-creator）', description: '和现有脚本放在一起，共用一套配置。' },
            { value: 'sibling', title: '同工作区的另一个项目', description: '跨仓库引用，需要额外的依赖声明。' },
            { value: 'elsewhere', title: '在别的目录的项目', description: '与当前工作区无关，导出时才拉取。' }
          ] },
        { name: 'question_0_custom', kind: 'text', title: 'Other', customFor: 'question_0' },
        { name: 'question_1', kind: 'multi', title: '命令范围',
          options: [
            { value: 'new', title: 'new —— 新建文章', description: '骨架：交互式问模块/分类/标题/标签，生成带 frontmatter 的 md。' },
            { value: 'dev', title: 'dev / build / preview', description: '起 astro dev（4311）、build（含 pagefind 索引）、preview。' },
            { value: 'deploy', title: 'deploy —— 调阿里云部署', description: '转发到 .claude/skills/deploy-aliyun，默认 --dry-run。' }
          ] },
        { name: 'question_1_custom', kind: 'text', title: 'Other', customFor: 'question_1' }
      ]
    };
    // [CUSTOM-20260930-153] 'real' 档：**照抄 2026-10-01 那次真机请求**（日志
    // ~/.claude/acp-client-custom.log 里的 'elicitation/create'）—— 用来复现用户报的两个现象：
    //   · 选项**带描述**（真 schema 里 4 个选项都有 description）；
    //   · 那个自由文本框**没有** _meta 标记 ⇒ 宿主算不出 customFor ⇒ 它成了独立的一题
    //     "Other"，问题块里因此看不到追加输入框（用户报的"缺少自定义内容"）。
    if (location.hash.indexOf('real') >= 0) {
      elicState = {
        promptId: 'preview:real',
        sessionId: SESSION,
        status: 'pending',
        message: '你说的「这个功能」指哪一个？想知道的是它在 UI 上的入口，还是它在代码里的位置？',
        fields: [
          { name: 'question_0', kind: 'select', title: '定位哪个',
            options: [
              { value: '📖 图文故事书 PDF', title: '📖 图文故事书 PDF',
                description: '「发布1-图文」→ AI 版面设计 → HTML → PDF 的书籍版式（services/book/ 十个小模块 + 五个端点 + 预览弹层）' },
              { value: '🗂 首页任务显示区', title: '🗂 首页任务显示区',
                description: '首页任务显示区 + 项目类型筛选记忆（background_tasks 表 + GET /api/tasks 聚合）' },
              { value: 'UI 上的入口位置', title: 'UI 上的入口位置',
                description: '进入某个项目后，这个功能的入口按钮/菜单挂在界面的哪一处（我来指路或建议放哪）' },
              { value: '代码里的所在位置', title: '代码里的所在位置',
                description: '我先把代码链路图谱作用域内的小节读出来，告诉你它在哪些文件/分层里' }
            ] },
          { name: 'question_0_custom', kind: 'text', title: 'Other', customFor: 'question_0',
            description: 'Type your own answer, or add a note to the option you chose above (optional).' }
        ]
      };
    }
    // [CUSTOM-20261001-153] 钉住大纲栏那一档：抽屉必须与输入卡**同一条中线**（用户报的"没居中"）。
    // 输入卡的中心是"面板宽 − --acpc-aside-w"再居中，所以这一档没有它根本量不出来。
    // 记录层：hydrate 一条 pending 的表单记录 —— 内联那行"待回答"就是它画的。
    try {
      NS.transcriptView.hydrate({
        sessionId: SESSION,
        entries: [{ id: 'preview-elic', kind: 'elicitation', at: Date.now(), elicitation: elicState }]
      });
    } catch (err) { failed++; console.warn('elicitation hydrate failed:', err); }
    // 底栏先初始化：抽屉的 bottom 用的是 --acpc-composer-h（composer.ts 的观察器写的）。
    NS.composer.init();
    NS.elicitationView.init();
    NS.elicitationView.setSession(SESSION);
    NS.elicitationView.sync();
    // [CUSTOM-20261001-153] 钉住大纲栏那一档：抽屉必须与输入卡**同一条中线**（用户报的"没居中"）。
    // 输入卡的中心是"面板宽 − --acpc-aside-w"再居中，所以这一档没有它根本量不出来。
    // 这里**直接写那个变量**而不是去驱动真大纲：抽屉与输入卡都只认这一个变量（CSS 的单一真相），
    // 而本档的记录里没有 user/assistant 锚点，真大纲栏不会显示（旁栏宽度就还是 0）。
    if (location.hash.indexOf('sidebar') >= 0) {
      if (document.body && document.body.style) {
        document.body.style.setProperty('--acpc-aside-w', '240px');
      }
    }
    // 分档：默认第一题（单选，菜单关着）；menu 打开下拉；multi 切到第二题（多选）；
    // shrunk 收起成一行。**不要**用 collapsed 命名 —— 那个子串会命中记录区的折叠档。
    //
    // ⚠️ 下拉菜单的位置在**截图**里看着不对（会盖住抽屉的标题栏），那是本脚本的已知假象：
    // 截图模式与 dump-dom 模式的视口高度不一致（实测同一次 --window-size=1440,900，
    // dump-dom 报 innerH=808 而截图画布是 900），而菜单是 position: fixed、按视口算坐标。
    // **判定菜单落在哪一侧要用探针读数字**（'#elicmenuprobe' 的 menuBelowBtn / menuTopVsDrawerTop），
    // 不要照着截图改代码 —— 我为此白改了两版规则（pitfall #31）。
    if (location.hash.indexOf('multi') >= 0) {
      NS.elicitationView.selectTab(1);
      // [CUSTOM-20261002-168] 勾上第一项，好让"每项自带的补充框"显形（它跟着勾选态）。
      var firstMulti = document.querySelector('.elic-field input[data-kind="multi"]');
      // ⚠️ new Event('change') 默认 **不冒泡** —— 委托在抽屉上的 change 处理器收不到，
      // 于是 placeCustomBoxes 不会重跑（截图里就是"勾了却没长出补充框"）。
      if (firstMulti) { firstMulti.checked = true; firstMulti.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    if (location.hash.indexOf('shrunk') >= 0) { NS.elicitationView.setCollapsed(true); }
    // 单选那一档：点第一行（真实路径 —— 点 label 里的 radio 会触发 change）。
    if (location.hash.indexOf('pick') >= 0) {
      var firstRadio = document.querySelector('.elic-option-row input');
      if (firstRadio) { firstRadio.click(); }
    }
  }
  // [CUSTOM-20261001-158] 权限抽屉：记录区只留一行（⏳ + 标题 + Review），作答按钮在输入框
  // 上方的浮层里 —— 形状与表单抽屉一致（用户要求"跟选项弹框类似"）。
  // 'both' 档：表单 + 权限**同时** pending（同一会话先来表单又来权限的真实组合），
  // 两个抽屉上下堆叠，各自的高度变量相加；这一档是量"谁压在谁上面、有没有相交"的唯一现场。
  if (location.hash.indexOf('permdrawer') >= 0) {
    var permEntries = [{
      id: 'preview-perm', kind: 'permission', at: Date.now(),
      permission: {
        promptId: 'preview:perm',
        sessionId: SESSION,
        toolCallId: 'call_preview',
        title: 'cd /d/Git/zdev/zdev_ai_goal_loop && ls ai-starter/ 2>/dev/null && echo "--- ai-starter docs ---"',
        kind: 'execute',
        status: 'pending',
        options: [
          { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
          { optionId: 'allow-with-updates', name: 'Yes, and allow access to zdev_ai_goal_loop and similar commands', kind: 'allow_always' },
          { optionId: 'reject', name: 'No', kind: 'reject_once' }
        ]
      }
    }];
    if (location.hash.indexOf('both') >= 0) {
      permEntries.push({
        id: 'preview-elic-both', kind: 'elicitation', at: Date.now(),
        elicitation: {
          promptId: 'preview:elic-both', sessionId: SESSION, status: 'pending',
          message: 'Which framework?',
          fields: [{ name: 'question_0', kind: 'select', title: 'Base',
            options: [{ value: 'astro', title: 'Astro official' }] }]
        }
      });
    }
    try {
      NS.transcriptView.hydrate({ sessionId: SESSION, entries: permEntries });
    } catch (err) { failed++; console.warn('permission hydrate failed:', err); }
    // 底栏先初始化：两个抽屉的 bottom 都认 --acpc-composer-h。
    NS.composer.init();
    NS.permissionDrawer.init();
    NS.permissionDrawer.setSession(SESSION);
    NS.permissionDrawer.sync();
    if (location.hash.indexOf('both') >= 0) {
      NS.elicitationView.init();
      NS.elicitationView.setSession(SESSION);
      NS.elicitationView.sync();
    }
  }
  // [CUSTOM-20261001-166] 置顶条：规则改成「上方有用户消息就钉住最后那条滚出上沿的」。
  // 这一档摆出用户报的场景 —— 视口中间还有一条用户消息（u2），而更早的 u1 已经滚上去。
  // [CUSTOM-20261002-172] 卡堆之后同时可能有**多张**卡（旧卡被顶出上沿的那几帧），所以这一档
  // 又分出了 stickystack* 三种姿态（相接 / 两卡同钉 / 整条出界），见下面那段。
  // （169 删掉了卡片左侧那个收缩按钮，原先 stickyshrunk 档的"点一下按钮"随之作废 ——
  //   现在收缩控件是卡片里的折叠三角，走的是 stickystickyclick 档的真实点击。）
  if (hash.indexOf('sticky') >= 0) {
    // 滚动模块必须先 init：悬浮条的点击跳转走 NS.scroll.jumpTo（没 init 就静默不滚，
    // 探针量到的落点会一直是原位 —— 第一版就是这么白量了一轮）。
    NS.scroll.init(messages, document.getElementById('jumpToLatest'));
    NS.stickyUser.init();
    NS.stickyUser.setSession(SESSION);
    // 固件记录本身撑不满视口（scrollHeight == clientHeight ⇒ scrollTop 永远是 0），
    // 补几条把内容顶出去，否则这一档什么都量不到。
    for (var sx = 0; sx < 6; sx++) {
      NS.transcriptView.append({ id: 'sx-u' + sx, kind: 'user', at: 9000 + sx * 2,
        text: '填充提问 ' + (sx + 1) + '：' + '这一条用来把内容撑过视口。'.repeat(2) }, undefined);
      NS.transcriptView.append({ id: 'sx-a' + sx, kind: 'assistant', at: 9001 + sx * 2,
        text: '填充回答 ' + (sx + 1) + '：' + '内容 '.repeat(30) }, undefined);
    }
    NS.rail.invalidate();
    NS.outline.invalidate();
    // 先读一次 scrollHeight 强制布局：驱动脚本跑在解析期，此时还没有布局，
    // 直接写 scrollTop 会被钳成 0（截图里就表现为"根本没滚"）。
    void messages.scrollHeight;
    messages.scrollTop = Number((hash.match(/top=(\d+)/) || [])[1] || 260);
    messages.dispatchEvent(new Event('scroll'));
    NS.stickyUser.sync();
    // 窄档 + 引导条：真面板是窄侧边栏且**引导条的点就在同一条通道里**（x≈0..20），
    // 只初始化 sticky 而不摆出它们，等于漏掉了唯一的竞争者。
    if (hash.indexOf('narrow') >= 0) {
      NS.rail.init(document.getElementById('messages'),
        document.getElementById('rail'), document.getElementById('railTrack'));
      NS.rail.invalidate();
      NS.dom.schedule(function () { NS.rail.reflow(); });
    }
  }
  // [CUSTOM-20261002-172] 卡堆的三种姿态：三条**挨得近**的提问（各带一句短回答），顶边间距一百多
  // 像素 —— 只有挨得近，才会出现"新卡刚碰到旧卡底边"的那几帧。填充档里问答交替、回答很长，
  // 相邻提问隔了半屏，永远只钉得到一条。
  if (hash.indexOf('stickystack') >= 0) {
    for (var sk = 0; sk < 3; sk++) {
      NS.transcriptView.append({ id: 'stk-u' + sk, kind: 'user', at: 9500 + sk * 2,
        text: '紧凑提问 ' + (sk + 1) + '：这一条用来把卡堆撑出来，它是一个单行气泡。' }, undefined);
      NS.transcriptView.append({ id: 'stk-a' + sk, kind: 'assistant', at: 9501 + sk * 2,
        text: '一句话回答 ' + (sk + 1) }, undefined);
    }
    // 卡堆后面还要垫一大段内容：滚动范围只到 scrollHeight - clientHeight，垫不够的话
    // "把第二条提问滚到判定线附近"这个目标位置根本到不了 —— scrollTop 会被静默钳到最底，
    // 三档于是长得一模一样（第一版就是这么白量一轮的）。
    for (var sf = 0; sf < 8; sf++) {
      NS.transcriptView.append({ id: 'stk-fill' + sf, kind: 'assistant', at: 9600 + sf,
        text: '垫底内容 ' + (sf + 1) + '：' + '内容 '.repeat(40) }, undefined);
    }
    NS.rail.invalidate();
    NS.outline.invalidate();
    // 先读一次 scrollHeight 强制布局（理由同上面那段：驱动脚本跑在解析期，还没有布局）。
    void messages.scrollHeight;
    // 姿态由**量出来的**位置定，不猜一个 scrollTop：第二条提问的 offsetTop 只有布局之后才知道。
    //   push：它的顶边停在判定线下方 30px ⇒ 旧卡的底边应当正好压在它上面（相接，只有一张卡）
    //   two ：它的顶边只剩 2px      ⇒ 两张卡同时在（新卡钉在判定线上）
    //   gone：它的顶边已滚过 100px  ⇒ 旧卡整条出界，不再渲染
    // natural = u2.offsetTop - scrollTop，所以 scrollTop = u2.offsetTop + offset。
    var stackU2 = NS.transcriptView.node('stk-u1');
    if (stackU2) {
      var stackOffset = hash.indexOf('gone') >= 0 ? 100 : (hash.indexOf('two') >= 0 ? -2 : -30);
      messages.scrollTop = stackU2.offsetTop + stackOffset;
      messages.dispatchEvent(new Event('scroll'));
      NS.stickyUser.sync();
    }
  }
  // [CUSTOM-20260930-141] 目录过滤菜单：它挂在历史浮层内部的 .outline-head 里，而浮层原先
  // 是个 overflow: auto 的滚动容器 ⇒ 绝对定位的菜单会被裁成几行（历史列表越短越矮）。
  // 这一档手动搭出那个嵌套结构（渲染逻辑由桩 DOM 测试覆盖，这里只看**布局**：溢出有没有被裁）。
  if (location.hash.indexOf('historyfilter') >= 0) {
    var drawerEl2 = document.getElementById('history');
    var listEl2 = drawerEl2 ? drawerEl2.querySelector('.outline-list') : null;
    var chipEl = document.getElementById('historyFilter');
    var filterMenuEl2 = document.getElementById('historyFilterMenu');
    if (drawerEl2 && listEl2 && filterMenuEl2) {
      drawerEl2.hidden = false;
      if (chipEl) { chipEl.hidden = false; chipEl.textContent = 'ai-gateway-viewer'; }
      // 历史列表只放 4 行：修好之前，菜单的可见高度 = head 底边到浮层底边，短得只剩两三行。
      for (var si = 0; si < 4; si++) {
        listEl2.appendChild(NS.dom.el('div', 'outline-item', '会话记录 ' + (si + 1)));
      }
      // 菜单 20 行：内容高度远超它自己的 max-height（260px），所以"显示不完整"只可能是被裁。
      for (var di = 0; di < 20; di++) {
        filterMenuEl2.appendChild(NS.dom.el('div', 'picker-item filter-item', 'folder-' + (di + 1)));
      }
      filterMenuEl2.className = 'picker-menu down filter-menu open';
    }
  }
  // [CUSTOM-20261001-155] 历史会话的**默认筛选**：走真路径（真 boot → 真 ↺ → 宿主形状的
  // history 回复 → 真标记 #history/#historyFilter），桩 DOM 测试测的是逻辑、这里测的是
  // **接线与真标记**（body.ts 的 id/class 与测试里手抄的那份对不对得上）。
  // 探针读 askedCwd（请求里带没带地址栏目录）/ rows（默认筛出几行）/ chip（chip 上写的是谁）。
  //
  // **必须等真的 DOMContentLoaded / load 之后再驱动**：本档手动派发过一次 DOMContentLoaded
  // 只是为了**提前**跑 boot，而真的那个事件随后还会到 —— 于是 boot.init 跑第二遍、
  // sessionMenu.init 的第二遍末尾一次 close() 会把刚打开的抽屉关掉（数字对、图里却没有抽屉）。
  // 等 load 再点，那个"第二次 init"就已经过去了。
  function historyDefaultMode() {
    var histSent = [];
    var nativeHistPost = NS.bridge.post;
    NS.bridge.post = function (m) { histSent.push(m); if (nativeHistPost) { nativeHistPost(m); } };
    var histSummary = { sessionId: 's1', agentName: 'Claude Code', title: 'here', cwd: 'D:/Git/alpha',
      createdAt: '2026-09-20T00:00:00Z', loading: false, running: false, unread: false };
    NS.tabs.setSessions([histSummary]);
    NS.tabs.setFocus(histSummary);
    document.getElementById('historyBtn').click();
    NS.sessionMenu.setHistory({
      type: 'history', agentName: 'Claude Code', source: 'agent',
      sessions: [
        { sessionId: 'a1', title: 'alpha one', cwd: 'D:/Git/alpha', dirKey: 'd:/git/alpha', updatedAt: '2026-09-20T00:00:00Z' },
        { sessionId: 'a2', title: 'alpha two', cwd: 'D:/Git/alpha', dirKey: 'd:/git/alpha', updatedAt: '2026-09-19T00:00:00Z' },
        { sessionId: 'b1', title: 'beta one', cwd: 'D:/Git/beta', dirKey: 'd:/git/beta', updatedAt: '2026-09-18T00:00:00Z' }
      ],
      directories: [
        { key: 'd:/git/alpha', cwd: 'D:/Git/alpha', name: 'alpha', label: 'alpha', count: 2, current: true },
        { key: 'd:/git/beta', cwd: 'D:/Git/beta', name: 'beta', label: 'beta', count: 1, current: false }
      ]
    });
    var histList = document.querySelector('#history .outline-list');
    var histChip = document.getElementById('historyFilter');
    var histCwdBtn = document.getElementById('cwdBtn');
    var histLine = JSON.stringify({
      kind: 'history-default',
      askedCwd: histSent.filter(function (m) { return m.type === 'listHistory'; }).map(function (m) { return m.cwd; })[0] || null,
      rows: histList ? histList.querySelectorAll('.outline-item').length : null,
      firstRow: histList && histList.querySelector('.outline-item') ? String(histList.querySelector('.outline-item').textContent).slice(0, 20) : null,
      chip: histChip ? String(histChip.textContent) : null,
      drawerHidden: document.getElementById('history') ? document.getElementById('history').hidden : null,
      cwdBtn: histCwdBtn ? String(histCwdBtn.textContent) : null
    });
    var histPre = document.createElement('pre');
    histPre.id = 'history-probe';
    histPre.textContent = histLine;
    document.body.appendChild(histPre);
  }
  if (location.hash.indexOf('historydefault') >= 0) {
    if (document.readyState === 'complete') { historyDefaultMode(); }
    else { window.addEventListener('load', historyDefaultMode); }
  }
  // [CUSTOM-20261009-212] 历史列表行的悬停动作（Archive / Rename）。桩 DOM 测的是逻辑；
  // 这一档在真 Chromium 里量**布局与接线**：默认隐藏（计算值）、按钮落在行内、图标画出来了、
  // 点击真的发出 archiveSession、回执后列表就地更新。
  // ⚠️ :hover 在无头里没法程序触发 —— "默认隐藏"读计算值，"显示态"用内联样式把悬停后的
  // 最终值摆出来（图给人看观感，数字看右侧布局）。
  function historyRowMode() {
    var rowSent = [];
    var nativeRowPost = NS.bridge.post;
    NS.bridge.post = function (m) { rowSent.push(m); if (nativeRowPost) { nativeRowPost(m); } };
    document.getElementById('historyBtn').click();
    NS.sessionMenu.setHistory({
      type: 'history', agentName: 'Claude Code', source: 'agent',
      sessions: [
        { sessionId: 'a1', title: 'alpha one', cwd: 'D:/Git/alpha', dirKey: 'd:/git/alpha', updatedAt: '2026-09-20T00:00:00Z' },
        { sessionId: 'a2', title: 'alpha two', cwd: 'D:/Git/alpha', dirKey: 'd:/git/alpha', updatedAt: '2026-09-19T00:00:00Z' },
        { sessionId: 'b1', title: 'beta one', cwd: 'D:/Git/beta', dirKey: 'd:/git/beta', updatedAt: '2026-09-18T00:00:00Z' }
      ],
      directories: [
        { key: 'd:/git/alpha', cwd: 'D:/Git/alpha', name: 'alpha', label: 'alpha', count: 2, current: true },
        { key: 'd:/git/beta', cwd: 'D:/Git/beta', name: 'beta', label: 'beta', count: 1, current: false }
      ]
    });
    var rows = document.querySelectorAll('#history .session-row');
    var firstActions = rows.length ? rows[0].querySelector('.row-actions') : null;
    var defaultOpacity = firstActions ? getComputedStyle(firstActions).opacity : null;
    var defaultPE = firstActions ? getComputedStyle(firstActions).pointerEvents : null;
    // 点一次 Archive（元素 .click() 走真事件路径），再喂回执，看列表就地更新。
    var firstArchive = rows.length ? rows[0].querySelector('[data-session-action="archive"]') : null;
    if (firstArchive) { firstArchive.click(); }
    var sentArchive = rowSent.filter(function (m) { return m.type === 'archiveSession'; }).length;
    NS.sessionMenu.applyAction({ action: 'archive', sessionId: 'a1' });
    var afterArchive = document.querySelectorAll('#history .session-row').length;
    // 把剩下第一行的悬停动作摆出来并量几何（右缘在行内、纵向近似居中、按钮尺寸与图标）。
    var reveal = document.querySelectorAll('#history .session-row')[0];
    var revealActions = reveal ? reveal.querySelector('.row-actions') : null;
    var rect = null; var btnSizes = [];
    if (revealActions) {
      revealActions.style.opacity = '1';
      revealActions.style.pointerEvents = 'auto';
      var rowRect = reveal.getBoundingClientRect();
      var actRect = revealActions.getBoundingClientRect();
      rect = {
        insideRow: actRect.right <= rowRect.right + 0.5 && actRect.left >= rowRect.left,
        centred: Math.abs((actRect.top + actRect.bottom) / 2 - (rowRect.top + rowRect.bottom) / 2) <= 3
      };
      var btns = revealActions.querySelectorAll('.row-action');
      for (var bi = 0; bi < btns.length; bi++) {
        var br = btns[bi].getBoundingClientRect();
        btnSizes.push(Math.round(br.width) + 'x' + Math.round(br.height)
          + (btns[bi].firstChild && btns[bi].firstChild.childNodes && btns[bi].firstChild.childNodes.length ? '+icon' : ''));
      }
    }
    var rowPre = document.createElement('pre');
    rowPre.id = 'history-row-probe';
    rowPre.textContent = JSON.stringify({
      kind: 'history-row-actions',
      rowCount: rows.length,
      actionsPerRow: rows.length ? rows[0].querySelectorAll('[data-session-action]').length : null,
      // 动作**不能**嵌在行按钮里（button 嵌套 button 是无效 HTML）——这个选择器应当查不到。
      actionsInsideRowButton: !!document.querySelector('#history .outline-item .row-actions'),
      defaultOpacity: defaultOpacity, defaultPointerEvents: defaultPE,
      sentArchive: sentArchive, rowsAfterArchive: afterArchive, rect: rect, btnSizes: btnSizes
    });
    document.body.appendChild(rowPre);
  }
  // [CUSTOM-20261009-213 补] 用户气泡展开态"正文第一行可框选"的读数：第一行在 summary 里，
  // 而 summary 是 user-select: none 的切换区 —— 展开态必须给它解禁（userSelect=text）。
  // 只量不推（pitfall #31）：CSS 的 user-select 是否真的被覆盖，读 getComputedStyle 才算数。
  function userFoldSelectMode() {
    var out = {};
    var openBody = document.querySelector('.entry-user details.user-fold[open] .bubble-body');
    if (openBody) {
      var cs = getComputedStyle(openBody);
      out.openBody = { userSelect: cs.userSelect, cursor: cs.cursor };
      // 展开态：正文里划选一下（Range API，不需要真鼠标），看能不能选出文字。
      if (document.createRange && window.getSelection) {
        try {
          var range = document.createRange();
          range.selectNodeContents(openBody);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          out.selectedChars = String(sel.toString() || '').length;
        } catch (e) { out.selectError = String(e && e.message); }
      }
    }
    var openSummary = document.querySelector('.entry-user details.user-fold[open] > summary');
    if (openSummary) { out.summaryUserSelect = getComputedStyle(openSummary).userSelect; }
    var pre = document.createElement('pre');
    pre.id = 'userfold-select-probe';
    pre.textContent = JSON.stringify({ kind: 'userfold-select', ...out });
    document.body.appendChild(pre);
  }
  if (location.hash.indexOf('userfold') >= 0) {
    if (document.readyState === 'complete') { userFoldSelectMode(); }
    else { window.addEventListener('load', userFoldSelectMode); }
  }
  if (location.hash.indexOf('historyrow') >= 0) {
    if (document.readyState === 'complete') { historyRowMode(); }
    else { window.addEventListener('load', historyRowMode); }
  }
  // [CUSTOM-20260930-143] 未连接（disconnected / connecting）时底栏应当**整块消失** —— 那时
  // 输入框本来就用不了，露着一个"看得见却打不了字"的框只会让人以为它坏了。相位是 stateCard
  // 写在 body[data-phase] 上的，这里直接设属性来摆出那个状态。
  if (location.hash.indexOf('phasedisconnected') >= 0) {
    if (document.body) { document.body.setAttribute('data-phase', 'disconnected'); }
  }
  // [CUSTOM-20260930-140/144] 真悬浮的验收档：滚到最底，看最后一条记录有没有被输入卡压住
  // （贴底时 #messages 会拿到 .pin-bottom，把输入卡的高度让出来）。
  // [CUSTOM-20261004-183] 停止确认条：摆出来看观感（在输入卡上方、同宽同中线），
  // 并读一下它的高度有没有被算进底部留白（它长在 #composer 里 ⇒ 观察器应当自己认出来）。
  if (location.hash.indexOf('stopconfirm') >= 0) {
    var scEl = document.getElementById('stopConfirm');
    if (scEl) { scEl.hidden = false; }
    NS.composer.init();
  }
  if (location.hash.indexOf('composerbottom') >= 0) {
    messages.scrollTop = messages.scrollHeight;
    // scroll 事件是**异步派发**的，而探针在同一个同步块里读数 —— 手动派发一次，让 scroll.ts
    // 的 onScroll（pinned 判定与 pin-bottom 类）先跑完。
    messages.dispatchEvent(new Event('scroll'));
  }
  // [CUSTOM-20261009-210] 「到底了、尾巴还被输入卡压住」的**自愈**复现。把 --acpc-composer-h
  // 人为踩回 0px（模拟观测器在"文档没渲染"时段哑火后变量停在 0 的形态——真机截图里就是它），
  // 再滚到底派发 scroll：recompute 的按结果判据（末条底边 vs 卡片顶边）应当发现，并让
  // composer 重测、重写变量、跟到底。读三样：varAfter（应回到真实高度）、covered（应假）、
  // lastGap（应 ≥ 卡片高，即尾巴在卡片上方）。
  if (location.hash.indexOf('composerbottomtail') >= 0) {
    var tailMessages = document.getElementById('messages');
    var tailComposer = document.getElementById('composer');
    var tailLast = tailMessages.lastElementChild;
    document.body.style.setProperty('--acpc-composer-h', '0px');
    // 变量一变留白立刻回落 —— 这正是真机里"变量停在 0"的形态：内容末尾会被卡片压住。
    tailMessages.scrollTop = tailMessages.scrollHeight;
    tailMessages.dispatchEvent(new Event('scroll'));
    var tailComposerRect = tailComposer.getBoundingClientRect();
    var tailLastRect = tailLast ? tailLast.getBoundingClientRect() : null;
    var tailLine = JSON.stringify({
      kind: 'tail-covered-heal',
      varAfter: (document.body.style.getPropertyValue('--acpc-composer-h') || '').trim(),
      composerH: Math.round(tailComposerRect.height),
      padBottom: getComputedStyle(tailMessages).paddingBottom,
      covered: tailLastRect ? tailLastRect.bottom > tailComposerRect.top : null,
      lastGap: tailLastRect
        ? Math.round(tailMessages.getBoundingClientRect().bottom - tailLastRect.bottom) : null
    });
    var tailPre = document.createElement('pre');
    tailPre.id = 'tail-covered-probe';
    tailPre.textContent = tailLine;
    document.body.appendChild(tailPre);
  }
  // [CUSTOM-20260930-147] 端到端：boot 自己初始化（真机就是这么走的），再由本档**模拟宿主**
  // 把 renderMarkdown 渲染成 html 回填进来。这是"最后一条不渲染"唯一能在本地复现的姿势 ——
  // 以前预览里没有 vscode API，boot 模块一加载就抛错，整条链路从来没被覆盖。
  if (location.hash.indexOf('bootround') >= 0) {
    // boot 模块在脚本加载时**自己**就 init 了（模块末尾那句自调用），不需要这里再调一次；
    // 本档只负责模拟宿主的那一半。
    // 先把 console.warn 抓下来：147 加的三条诊断（请求发出 / 回填到达 / patch 落空）都走它，
    // 预览里没有 Output 通道，抓进探针才能一次看出卡在哪一步。
    // boot 模块在脚本加载时**自己**就 init 了（模块末尾那句自调用）—— 但它那时看到的
    // document.readyState 还是 'loading'，于是把 init 挂给了 DOMContentLoaded；预览里这个
    // 事件早已派发过，所以监听**永远没注册**，回填也就永远到不了（这正是本档要复现的那一半）。
    // 手动补一次这个事件。
    document.dispatchEvent(new Event('DOMContentLoaded'));
    var warns = [];
    var nativeWarn2 = console.warn;
    console.warn = function () {
      warns.push('warn: ' + Array.prototype.slice.call(arguments).join(' '));
      nativeWarn2.apply(console, arguments);
    };
    // console.error 也抓：boot.init 中途抛错的话，installLogBridge 是把它转成 clientLog 消息的
    // （不进 warn），预览里就看不到 —— 而那正好能让"监听没注册"这种失败变得无声。
    var nativeError2 = console.error;
    console.error = function () {
      warns.push('error: ' + Array.prototype.slice.call(arguments).join(' '));
      nativeError2.apply(console, arguments);
    };
    // 自测监听：window.postMessage 到底有没有派发到本窗口。
    var seenMessages = 0;
    window.addEventListener('message', function () { seenMessages++; });
    var mdAsked = [];
    var mdDropped = 0;
    NS.bridge.post = function (m) {
      if (!m || m.type !== 'renderMarkdown') { return; }
      var items = [];
      for (var bi = 0; bi < m.items.length; bi++) {
        // 像真宿主那样**校验 sessionId**（verifySession）：没有会话身份就丢弃。
        // 这正是真机上那条 Output 日志（dropped markdown item … unknown session null）的来源。
        if (!m.items[bi].sessionId) { mdDropped++; continue; }
        mdAsked.push(m.items[bi].entryId + ':' + m.items[bi].text);
        items.push({
          entryId: m.items[bi].entryId, sessionId: m.items[bi].sessionId,
          html: '<p>' + m.items[bi].text + '</p>',
        });
      }
      window.postMessage({ type: 'markdownRendered', items: items }, '*');
    };
    NS.transcriptView.init(messages);
    // 真机那条路径：先来一次 boot（重开面板就是这样 —— **boot 的 currentSessionId 因此有值**，
    // 而 transcriptView 也被 hydrate 过）；随后 reset（切会话 / 清空）**只清掉后者**，而新记录
    // 照样会到。于是：
    //   · boot.currentSessionId 有值 ⇒ append 那道守卫放行、记录正常显示（用户看到的就是这个）
    //   · transcriptView.sessionId 是 null ⇒ markdown 请求带 null 出去 ⇒ **宿主静默丢弃**
    // 这正是 Output 里 dropped markdown item … unknown session null 的来源。
    window.postMessage({ type: 'boot', sessions: [], snapshot: { sessionId: 's1', entries: [] },
      focused: { sessionId: 's1', agentName: 'Claude Code', running: false, loading: false } }, '*');
    NS.transcriptView.reset();
    window.postMessage({ type: 'append', sessionId: 's1',
      entries: [{ id: 'md1', kind: 'assistant', at: Date.now(), text: 'v1', streaming: true }] }, '*');
    window.postMessage({ type: 'revise', sessionId: 's1', entryId: 'md1', patch: { text: 'v2' } }, '*');
    window.postMessage({ type: 'revise', sessionId: 's1', entryId: 'md1',
      patch: { streaming: false } }, '*');
    window.__acpcMdAsked = mdAsked;
    window.__acpcMdDropped = function () { return mdDropped; };
    // 采样必须**晚于**回填：window.postMessage 是异步派发的，而通用探针块是同步跑的 ——
    // 在那个时刻读永远看不出渲染过没有（假阴性）。挂一个 0ms 定时器（virtual-time 会推到），
    // 把结果**追加**到通用探针写好的 <pre id="probe"> 里。
    // 采样必须**足够晚**：window.postMessage 的派发是一个独立的 task，排在 setTimeout(0) 之后
    // —— 用 0 会在回填还没被处理时就下结论（这一版之前就是这么误判的）。
    window.setTimeout(function () {
      var mdBody = messages.querySelector('.bubble-body.md');
      var preEl = document.getElementById('probe');
      var line = JSON.stringify({
        kind: 'markdown-round',
        asked: mdAsked,
        hasMdClass: !!mdBody,
        text: mdBody ? String(mdBody.textContent).slice(0, 30) : null,
        warns: warns,
        droppedNoSession: window.__acpcMdDropped ? window.__acpcMdDropped() : null,
        seenMessages: seenMessages,
        bootErrors: window.__acpcErrors || [],
      });
      if (preEl) { preEl.textContent = preEl.textContent + '\\n' + line; }
      else { document.title = line; }
      // 采样必须**足够晚**：window.postMessage 的派发是独立的一次 task，排在 setTimeout(0) 之后
      // —— 用 0 会在回填还没被处理时就下结论（这一版之前就是这么误判的）。
    }, 120);
  }
  // [CUSTOM-20260930-144] **编辑区面**：用户一直在编辑区面板里用，而本脚本默认渲染的是
  // 侧边栏面（body('view') 那个面）—— 两面只差 .surface-editor 那几条 CSS，而其中一条给
  // .composer 刷了 editor-background 背景，于是那条"浮在消息上的透明底栏"在编辑区里变成了
  // 一块**不透明带**：输入卡两侧、右侧大纲栏的底部全被它盖住。这一档就是把那个面摆出来。
  // ⚠️ 本函数的返回值是**模板字符串**：注释里不要写反引号（driver 不在 check-webview-client
  // 的扫描范围内，写错了要到运行时才炸 —— 这里踩过两次）。
  if (location.hash.indexOf('surfaceeditor') >= 0) {
    if (document.body) { document.body.className = 'surface-editor'; }
  }
  // [CUSTOM-20260930-144] 大纲侧栏的滚动：把列表塞到需要滚动，看最后一条能不能露出来
  // （用户报"滚动条已经拉到最后，但有几个条目被遮挡"）。塞假行是因为 fixtures 的锚点不够长 ——
  // 这一档看的是**布局**（flex 压缩 / 裁切），不是渲染逻辑。
  if (location.hash.indexOf('outlinescroll') >= 0) {
    var sideListEl0 = document.querySelector('.outline-sidebar .outline-list');
    if (sideListEl0) {
      for (var oi = 0; oi < 30; oi++) {
        sideListEl0.appendChild(NS.dom.el('div', 'outline-item', '大纲条目 ' + (oi + 1)));
      }
      sideListEl0.scrollTop = sideListEl0.scrollHeight;
    }
  }
  // [CUSTOM-20260930-144] 走**真实路径**复现（而不是手动 dispatch 一个 scroll 事件）：
  // 切换会话 / 重开面板走的是 NS.scroll.toBottom()（或 restore()）。它给 scrollTop 赋一个
  // **没变**的值时浏览器不派发 scroll 事件 ⇒ onScroll 不跑 ⇒ 画面看起来在底部（Jump 被藏了）
  // 却没有让位留白，最后一条紧贴输入卡 —— 用户第二次报的"还是遮挡"就是这个。
  if (location.hash.indexOf('composerrealbottom') >= 0) {
    messages.scrollTop = messages.scrollHeight;   // 先真滚到底（值变了，事件异步派发）
    NS.scroll.toBottom();                          // 再走一次程序路径：此刻值没变 ⇒ 没有事件
  }
  // [CUSTOM-20260930-144] 复现用户截图里的位置：**滚到底之后又上滚 40px**。
  // 那里 Jump to latest 是可见的（distance 高于阈值），所以留白**不该**还在 —— 第一版把
  // padding 从判据里减掉，"贴底区"被撑成 卡片高 + 阈值（108+32），这个位置仍被判成贴底。
  if (location.hash.indexOf('composerjustup') >= 0) {
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event('scroll'));
    messages.scrollTop = messages.scrollTop - 40;
    messages.dispatchEvent(new Event('scroll'));
  }
  // [CUSTOM-20260930-144] 中途档：不在底部时**不该**有那段留白 —— 消息要一路铺到面板底，
  // 卡片两侧仍能看到内容（用户报的"悬浮没出来"就是这里）。
  if (location.hash.indexOf('composermid') >= 0) {
    messages.scrollTop = Math.round((messages.scrollHeight - messages.clientHeight) / 2);
    messages.dispatchEvent(new Event('scroll'));
  }
  // 工具卡默认收起（118），要看 IN/OUT 就得把 body 展开 —— 这里直接模拟"用户点了 head"：
  // 产品代码里那一步是 links.toggleBody（它由 boot.init 的委托处理器驱动，本脚本不跑 boot）。
  if (location.hash.indexOf('tools') >= 0) {
    var bodies = messages.querySelectorAll('.tool-body');
    for (var b = 0; b < bodies.length; b++) { bodies[b].hidden = false; }
    var heads = messages.querySelectorAll('.tool-head');
    for (var h = 0; h < heads.length; h++) {
      heads[h].setAttribute('aria-expanded', 'true');
      var car = heads[h].querySelector('.tool-caret');
      if (car) { car.textContent = '\\u25be'; }
    }
  }
  // #probe：把 IN/OUT 两栏的**实测几何**写进 DOM，配合 chrome --dump-dom 读回来。
  // 对齐这类问题肉眼判断经常骗人（字体度量、内边距、UA 默认样式各差几像素），量一次最省事。
  if (location.hash.indexOf('probe') >= 0) {
    var out = [];
    // [CUSTOM-20261001-158] 权限抽屉：贴着输入卡（或表单抽屉）上沿、与输入卡同宽同中线；
    // 与表单同时 pending 时两者不得相交（gap 期望 0，权限在上）。这些只能量，不能推。
    // [CUSTOM-20261001-166] 置顶条：钉的是谁、收缩按钮在不在、以及它的**命中测试**
    // （elementFromPoint 必须命中按钮自己 —— 引导条与它同在左侧那条 18px 通道里）。
    // [CUSTOM-20261001-166] 真实点击：按 elementFromPoint 的**命中目标**点下去 —— 那就是用户
    // 的鼠标会落到的东西 —— 并临时挂钩 scroll.jumpTo，看这次点击有没有触发跳转。
    // 只在 stickyclick 档跑：它会改变状态（点击本来就是有副作用的）。
    // [CUSTOM-20261002-170/171] 点卡片跳转之后：卡片与"跳到的那个节点"的几何关系。
    // [CUSTOM-20261002-172] 目标取自**被点的那张卡**（卡堆里每张各代表一条消息），这里点最下面
    // 那张（最新的、也就是"本轮提问"）。
    if (location.hash.indexOf('stickyjump') >= 0) { try {
      var sjHost = document.getElementById('stickyUser');
      var sjCardEls = sjHost ? sjHost.querySelectorAll('.sticky-card') : [];
      var sjCard = sjCardEls.length ? sjCardEls[sjCardEls.length - 1] : null;
      var targetId = sjCard ? sjCard.getAttribute('data-sticky-id') : null;
      if (sjCard && sjCard.click) { sjCard.click(); }
      NS.stickyUser.sync();
      var node = targetId ? NS.transcriptView.node(targetId) : null;
      var an = node ? node.getBoundingClientRect() : null;
      // 量**最新那张卡**：用户报的"界面里的和悬浮的两条对话重叠"说的就是它 —— 它代表的正是
      // 刚跳过去的那条消息，所以两者的矩形不该相交（卡片接管原位、本体让位）。
      var landedCards = sjHost ? sjHost.querySelectorAll('.sticky-card') : [];
      var landed = landedCards.length ? landedCards[landedCards.length - 1] : null;
      var ac = landed ? landed.getBoundingClientRect() : null;
      out.push(JSON.stringify({
        kind: 'sticky-jump',
        target: targetId,
        scrollTop: Math.round(document.getElementById('messages').scrollTop),
        targetTop: an ? Math.round(an.top) : null, targetBottom: an ? Math.round(an.bottom) : null,
        cardTop: ac ? Math.round(ac.top) : null, cardBottom: ac ? Math.round(ac.bottom) : null,
        // [CUSTOM-20261004-178] 判据翻面了：落点**越过**交接线（natural >= TOP_GAP+缝）⇒ 本体
        // **不再让位**（visibility 仍可见）、上方卡堆按上夹公式自己滑出上沿 ⇒ 两者不相交。
        // 171 那版（落 0）读数是反的：targetVisibility='hidden'、overlap=true（克隆体接管）。
        nodeNatural: node ? Math.round(node.offsetTop - document.getElementById('messages').scrollTop) : null,
        overlap: (ac && an) ? (an.top < ac.bottom && an.bottom > ac.top) : null,
        targetVisibility: node ? getComputedStyle(node).visibility : null,
        stickyVisible: sjHost ? !sjHost.hidden : null,
        // [CUSTOM-20261004-178] 可见卡堆的区间（NS.stickyUser.stackInfo）：170 当年错用了
        // host.offsetHeight（含屏幕外的卡）来算让位量 —— 这个读数就是"该问的那个量"。
        stackBottom: NS.stickyUser.stackInfo ? NS.stickyUser.stackInfo().bottom : null,
        stackCards: NS.stickyUser.stackInfo ? NS.stickyUser.stackInfo().cards : null,
        seam: (function () {
          var info = NS.stickyUser.stackInfo ? NS.stickyUser.stackInfo() : null;
          var nat = node ? node.offsetTop - document.getElementById('messages').scrollTop : null;
          return (info && info.bottom !== null && nat !== null) ? Math.round(nat - info.bottom) : null;
        })()
      }));
    } catch (e) { out.push(JSON.stringify({ kind: 'sticky-jump-error', message: String((e && e.message) || e) })); } }
    var stickyHostEl2 = document.getElementById('stickyUser');
    if (stickyHostEl2 && location.hash.indexOf('stickyclick') >= 0) { try {
      var jumped = false;
      var origJump = NS.scroll.jumpTo;
      NS.scroll.jumpTo = function () { jumped = true; return origJump.apply(NS.scroll, arguments); };
      var caret2 = stickyHostEl2.querySelector('.fold-caret');
      var clickCard = caret2 && caret2.closest ? caret2.closest('.sticky-card') : null;
      // [CUSTOM-20261002-172] 卡片里的折叠三角是**唯一**收缩控件（169 删了左侧那个小方块），
      // 它走原生 <details>（171）—— 所以量的是那张卡的 details.open 与卡高，不是某个类名。
      function snap() {
        var det = clickCard ? clickCard.querySelector('details') : null;
        var fb0 = clickCard ? clickCard.querySelector('.fold-body') : null;
        // [CUSTOM-20261004-179] 同时读**记录本体**的 details.open：点卡片三角时它必须跟着折
        // （用户 2026-10-04 报的"消息面板里还是展开的"）。两份状态必须永远相等。
        var recId = clickCard ? clickCard.getAttribute('data-sticky-id') : null;
        var recNode = recId ? NS.transcriptView.node(recId) : null;
        var recDet = recNode && recNode.querySelector ? recNode.querySelector('details') : null;
        return {
          open: det ? det.open : null,
          recordOpen: recDet ? recDet.open : null,
          // 共用存储读到的那一位（定位断点：没写进去 / 写了但没应用 / 应用了但节点不对）。
          storeCollapsed: (recId && NS.transcriptView.userCollapsed) ? NS.transcriptView.userCollapsed(recId) : null,
          recFound: !!recNode,
          foldDisplay: fb0 ? getComputedStyle(fb0).display : null,
          cardH: clickCard ? Math.round(clickCard.getBoundingClientRect().height) : null
        };
      }
      var s0 = snap();
      if (caret2 && caret2.click) { caret2.click(); }
      var s1 = snap();
      if (caret2 && caret2.click) { caret2.click(); }
      var s2 = snap();
      NS.scroll.jumpTo = origJump;
      // [CUSTOM-20261004-179] 诊断：**直接**调一次共用存储的写入口（绕过 toggle 监听）。
      // 这一步能把"函数坏了"与"监听没挂上"分开 —— 两侧症状一模一样。
      var directOk = false;
      var directErr = null;
      try {
        var rid = clickCard ? clickCard.getAttribute('data-sticky-id') : null;
        if (rid && NS.transcriptView.setUserCollapsed) {
          NS.transcriptView.setUserCollapsed(rid, true);
          directOk = NS.transcriptView.userCollapsed(rid) === true;
        }
      } catch (e) { directErr = String((e && e.message) || e); }
      var s3 = snap();
      // ⚠️ details 的 toggle 事件是**异步派发**的（浏览器把它排成独立 task）——上面那三个
      // 同步快照读到的都是"监听还没跑"的状态，会得出"没同步"的错觉（本档第一版就是这么误判的）。
      // 所以真正的判据在下面的延时采样里（同 #bootround 的先例）。
      window.setTimeout(function () {
        try {
          var preLate = document.getElementById('probe');
          if (!preLate) { return; }
          var lateStore = null;
          var lateRecord = null;
          var rid2 = clickCard ? clickCard.getAttribute('data-sticky-id') : null;
          if (rid2 && NS.transcriptView.userCollapsed) { lateStore = NS.transcriptView.userCollapsed(rid2); }
          var rn2 = rid2 ? NS.transcriptView.node(rid2) : null;
          var rd2 = rn2 && rn2.querySelector ? rn2.querySelector('details') : null;
          if (rd2) { lateRecord = rd2.open; }
          preLate.textContent = preLate.textContent + String.fromCharCode(10) + JSON.stringify({
            kind: 'sticky-click-late', id: rid2, store: lateStore, recordOpen: lateRecord, snapshot: snap()
          });
        } catch (e) { /* 采样失败不该影响别的档 */ }
      }, 80);
      out.push(JSON.stringify({
        kind: 'sticky-click', caretFound: !!caret2, caretTitle: caret2 ? String(caret2.title || '') : null,
        directCall: directOk, directError: directErr, afterDirectCall: s3,
        cardId: clickCard ? clickCard.getAttribute('data-sticky-id') : null,
        jumped: jumped,
        initial: s0, afterFirstClick: s1, afterSecondClick: s2
      }));
    } catch (e) { out.push(JSON.stringify({ kind: 'sticky-click-error', message: String((e && e.message) || e) })); } }
    // [CUSTOM-20261004-179] 反向：点**记录本体**的三角，卡片要跟着折（toggle 不冒泡，
    // 客户端是逐节点挂的监听 —— 这一档就是为了证明那条监听真的挂上了）。
    if (stickyHostEl2 && location.hash.indexOf('stickyrecordclick') >= 0) { try {
      var recIds = NS.transcriptView.ordered();
      var recUser = null;
      for (var ri = 0; ri < recIds.length; ri++) {
        var re = NS.transcriptView.entry(recIds[ri]);
        if (re && re.kind === 'user' && NS.transcriptView.node(re.id).querySelector('.fold-caret')) { recUser = re; break; }
      }
      var recN = recUser ? NS.transcriptView.node(recUser.id) : null;
      var recCaret = recN ? recN.querySelector('.fold-caret') : null;
      var recBefore = recN && recN.querySelector('details') ? recN.querySelector('details').open : null;
      if (recCaret && recCaret.click) { recCaret.click(); }
      var recAfter = recN && recN.querySelector('details') ? recN.querySelector('details').open : null;
      var cardNow = recUser ? document.getElementById('stickyUser').querySelector('[data-sticky-id="' + recUser.id + '"]') : null;
      var cardDet = cardNow ? cardNow.querySelector('details') : null;
      out.push(JSON.stringify({
        kind: 'sticky-record-click',
        recordId: recUser ? recUser.id : null,
        caretFound: !!recCaret,
        recordBefore: recBefore, recordAfter: recAfter,
        cardFound: !!cardNow,
        cardOpen: cardDet ? cardDet.open : null
      }));
    } catch (e) { out.push(JSON.stringify({ kind: 'sticky-record-click-error', message: String((e && e.message) || e) })); } }
    var stickyHost = document.getElementById('stickyUser');
    if (stickyHost) {
      // [CUSTOM-20261002-172] 卡堆：**逐张**量几何（子节点顺序 = 从旧到新）。判定靠这些数字，不靠
      // 肉眼。坐标统一用"host 空间"（y=0 就是滚动口顶边）：用户消息的自然位置 = offsetTop -
      // scrollTop（与客户端同一条算式），卡片则是 rect.top - hostRect.top。
      var sRect = stickyHost.getBoundingClientRect();
      var userTops = [];
      (function () {
        var ids = NS.transcriptView.ordered();
        for (var k = 0; k < ids.length; k++) {
          var e = NS.transcriptView.entry(ids[k]);
          if (!e || e.kind !== 'user') { continue; }
          var n = NS.transcriptView.node(e.id);
          if (!n) { continue; }
          userTops.push({ id: e.id, top: Math.round(n.offsetTop - messages.scrollTop) });
        }
      })();
      var cardEls = stickyHost.querySelectorAll('.sticky-card');
      var cardsInfo = [];
      for (var ci = 0; ci < cardEls.length; ci++) {
        var cr = cardEls[ci].getBoundingClientRect();
        var cTop = Math.round(cr.top - sRect.top);
        var cBottom = Math.round(cr.bottom - sRect.top);
        // 下一条用户消息的顶边就是用户说的那条"判定线"：被顶出去的卡片底边应当压在它上面。
        var nextTop = null;
        for (var ui = 0; ui < userTops.length; ui++) {
          if (userTops[ui].top >= cTop) { nextTop = userTops[ui].top; break; }
        }
        cardsInfo.push({
          id: cardEls[ci].getAttribute('data-sticky-id'),
          top: cTop, bottom: cBottom, h: Math.round(cr.height),
          visible: Math.max(0, Math.round(Math.min(cr.bottom, sRect.bottom) - Math.max(cr.top, sRect.top))),
          nextUserTop: nextTop,
          contact: nextTop === null ? null : Math.abs(cBottom - nextTop) <= 1
        });
      }
      var hostStyle = getComputedStyle(stickyHost);
      out.push(JSON.stringify({
        kind: 'sticky',
        hidden: !!stickyHost.hidden,
        hostTop: Math.round(sRect.top), hostH: Math.round(sRect.height),
        padTop: hostStyle.paddingTop,
        // maxHeight 必须是 none（172 去掉了 40% —— 它会裁掉最下面、也就是**最新**的那张卡）。
        maxHeight: hostStyle.maxHeight, overflowY: hostStyle.overflowY,
        cards: cardsInfo,
        dbgScrollTop: Math.round(messages.scrollTop),
        dbgScrollHeight: messages.scrollHeight, dbgClientHeight: messages.clientHeight,
        dbgUsers: userTops,
        text: String(stickyHost.textContent || '').slice(0, 40)
      }));
    }
    var permDrawerEl = document.getElementById('permDrawer');
    if (permDrawerEl) {
      var pdRect = permDrawerEl.getBoundingClientRect();
      var elicEl = document.getElementById('elicDrawer');
      var elicRect = elicEl && !elicEl.hidden ? elicEl.getBoundingClientRect() : null;
      var bodyStyle = getComputedStyle(document.body);
      var composerEl = document.querySelector('.composer-card') || document.querySelector('.composer');
      var cardRect = composerEl ? composerEl.getBoundingClientRect() : null;
      out.push(JSON.stringify({
        kind: 'perm-drawer',
        hidden: !!permDrawerEl.hidden,
        permH: bodyStyle.getPropertyValue('--acpc-perm-h').trim(),
        elicH: bodyStyle.getPropertyValue('--acpc-elic-h').trim(),
        // 抽屉下沿到输入卡上沿的距离：没有表单时应当就是 0（贴住）。
        gapToComposer: cardRect ? Math.round(cardRect.top - pdRect.bottom) : null,
        // 有表单时：权限的下沿应当等于表单的上沿（堆叠，不相交）。
        gapToElic: elicRect ? Math.round(elicRect.top - pdRect.bottom) : null,
        overlapsElic: elicRect ? pdRect.bottom > elicRect.top + 1 : null,
        buttons: permDrawerEl.querySelectorAll('.perm-btn').length,
        recordRow: !!document.querySelector('.perm-pending-row')
      }));
    }
    var segs = messages.querySelectorAll('.tool-seg');
    for (var s2 = 0; s2 < segs.length; s2++) {
      var seg = segs[s2];
      var label = seg.querySelector('.tool-seg-label');
      var kids = [];
      for (var c = 0; c < seg.childNodes.length; c++) {
        var n = seg.childNodes[c];
        if (n.nodeType === 1 && !(n.className || '').indexOf('tool-seg-label') === 0) { }
        if (n.nodeType === 1) { kids.push(n); }
      }
      var content = null;
      for (var k = 0; k < kids.length; k++) { if ((kids[k].className || '').indexOf('tool-seg-label') !== 0) { content = kids[k]; break; } }
      var inner = content ? content.querySelector('pre, code, span') || content : null;
      out.push(JSON.stringify({
        seg: (seg.className || ''),
        labelLeft: label ? Math.round(label.getBoundingClientRect().left) : null,
        contentLeft: content ? Math.round(content.getBoundingClientRect().left) : null,
        contentPadLeft: content ? getComputedStyle(content).paddingLeft : null,
        innerTag: inner ? inner.tagName : null,
        innerLeft: inner ? Math.round(inner.getBoundingClientRect().left) : null,
        innerPadLeft: inner ? getComputedStyle(inner).paddingLeft : null,
        innerMarginLeft: inner ? getComputedStyle(inner).marginLeft : null,
      }));
    }
    // [CUSTOM-20260930-123] 状态卡的实测几何。卡片是这次改动里唯一需要"量而不是推"的东西：
    // 居中是否真的居中、窄侧边栏下会不会被裁顶（pitfall #31）。
    var card = document.getElementById('stateCard');
    var area = document.getElementById('messageArea');
    if (card && area) {
      var cr = card.getBoundingClientRect();
      var ar = area.getBoundingClientRect();
      out.push(JSON.stringify({
        card: 'geometry',
        innerW: window.innerWidth,
        areaW: Math.round(ar.width), areaH: Math.round(ar.height),
        cardW: Math.round(cr.width), cardH: Math.round(cr.height),
        dx: Math.round((cr.left + cr.width / 2) - (ar.left + ar.width / 2)),
        dy: Math.round((cr.top + cr.height / 2) - (ar.top + ar.height / 2)),
        clippedTop: cr.top < ar.top - 0.5,
        clippedBottom: cr.bottom > ar.bottom + 0.5,
        cardOverflow: getComputedStyle(card).overflow,
        areaScrollH: area.scrollHeight, areaClientH: area.clientHeight,
      }));
    }
    // [CUSTOM-20260930-136 / 138] 底部栏与消息列的实测几何。主验收数字是
    // **dxCardVsCol**（输入卡片中心 − 消息列中心，期望 0）与 **dxAsideVsOutline**（预留功能区
    // 左边界 − 钉住的大纲栏左边界，期望 0 —— 也就是用户要的那根竖线究竟有没有对齐）。
    // 这类偏差肉眼根本看不出来（差 8px 就足以让线"看着歪了"却说不上来），量一次就知道。
    // 配套看：dxCardVsPanel 未钉住时应为 −A/2（A = 预留区宽，那是有意为之）；
    // dxRailVsCol 应恒为 0（引导条与内容左缘同一条线 —— 靠"搬进列"而不是靠算式，见
    // CUSTOM-20260930-132）。
    var colEl = document.querySelector('.messages-column');
    var cardEl = document.querySelector('.composer-card');
    var asideEl = document.querySelector('.composer-aside');
    var sideEl = document.getElementById('outlineSidebar');
    var jumpEl = document.getElementById('jumpToLatest');
    var railEl = document.getElementById('rail');
    var inputEl2 = document.getElementById('promptInput');
    var slashEl = document.getElementById('slashPopup');
    function midOf(el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; }
    // [CUSTOM-20260930-152] 表单抽屉的实测几何：抽屉与输入卡是否同宽同中线、下拉菜单落在
    // 按钮的哪一侧（"菜单把问题盖住了"这种事只能量，pitfall #31 —— 我一开始就是靠推断，
    // 连试了两版规则都没生效）。
    (function () {
      var elicDrawerEl = document.getElementById('elicDrawer');
      if (!elicDrawerEl || elicDrawerEl.hidden) { return; }
      var dRect = elicDrawerEl.getBoundingClientRect();
      var btnEl = document.querySelector('.elic-select-btn');
      var menuEl2 = document.querySelector('.elic-menu');
      var composerEl3 = document.getElementById('composer');
      var cRect3 = composerEl3 ? composerEl3.getBoundingClientRect() : null;
      var bRect = btnEl ? btnEl.getBoundingClientRect() : null;
      var mRect = menuEl2 ? menuEl2.getBoundingClientRect() : null;
      var innerEl = document.querySelector('.composer-inner');
      out.push(JSON.stringify({
        kind: 'elicitation',
        innerW: window.innerWidth, innerH: window.innerHeight,
        drawerW: Math.round(dRect.width), drawerCenter: Math.round(midOf(elicDrawerEl)),
        // 验收 1：抽屉中线必须等于输入卡中线（钉住大纲栏时最容易露馅 —— 差 asideW/2）。
        cardCenter: innerEl ? Math.round(midOf(innerEl)) : null,
        asideVar: getComputedStyle(document.body).getPropertyValue('--acpc-aside-w').trim(),
        drawerTop: Math.round(dRect.top), drawerBottom: Math.round(dRect.bottom),
        composerTop: cRect3 ? Math.round(cRect3.top) : null,
        btnBottom: bRect ? Math.round(bRect.bottom) : null,
        // [CUSTOM-20261001-154] 单选改平铺后不再有下拉菜单；这两项改读"自拟框的落点"：
        // 没选时应当 hidden，选了一行之后应当落在**那一行**里（用户规则 2）。
        progress: document.querySelector('.elic-progress')
          ? document.querySelector('.elic-progress').textContent : null,
        // [CUSTOM-20261001-161] Submit 的门禁：多题时**第一页必须禁用、最后一页才可点**。
        // 探针临时把 tab 切一圈再切回来（同 136 的先例：为了量到真实状态，允许摆一下 DOM），
        // 因为"只看当前这一档"永远量不出另一半。
        submitGating: (function () {
          var submit = document.querySelector('.elic-submit');
          var tabs = document.querySelectorAll('.elic-tab');
          if (!submit) { return null; }
          if (tabs.length <= 1) { return { tabs: tabs.length, singleEnabled: submit.disabled === false }; }
          var current = 0;
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('aria-selected') === 'true') { current = i; }
          }
          NS.elicitationView.selectTab(0);
          var firstDisabled = document.querySelector('.elic-submit').disabled;
          NS.elicitationView.selectTab(tabs.length - 1);
          var lastDisabled = document.querySelector('.elic-submit').disabled;
          NS.elicitationView.selectTab(current);
          return {
            tabs: tabs.length, firstTabDisabled: firstDisabled,
            lastTabDisabled: lastDisabled, restoredTab: current
          };
        })(),
        customHidden: document.querySelector('.elic-custom') ? document.querySelector('.elic-custom').hidden : null,
        customInPickedRow: (function () {
          var rows = document.querySelectorAll('.elic-option-row');
          for (var i = 0; i < rows.length; i++) {
            var radio = rows[i].querySelector('input');
            if (radio && radio.checked) { return rows[i].contains(document.querySelector('.elic-custom')); }
          }
          return null;
        })(),
        // 让位：消息区的底部留白必须把抽屉的高度也加进去（--acpc-elic-h），否则最后一条记录
        // 会被抽屉压住 —— 同 144 对输入卡做的那件事。
        // [CUSTOM-20261003-177] 收起态必须**保留完整 tab 条**（用户要求）：每一题的标题与圆点
        // 状态都要在，藏起来的只有正文与操作栏。这两项是 CSS 的 display，桩 DOM 量不到 —— 只能在这量。
        tabsDisplay: (function () {
          var t = document.querySelector('.elic-tabs');
          return t ? getComputedStyle(t).display : null;
        })(),
        panesDisplay: (function () {
          var p = document.querySelector('.elic-panes');
          return p ? getComputedStyle(p).display : null;
        })(),
        tabSummary: (function () {
          var out = [];
          var tabs = document.querySelectorAll('.elic-tab');
          for (var ti = 0; ti < tabs.length; ti++) {
            var dot = tabs[ti].querySelector('.elic-tab-dot');
            var text = tabs[ti].querySelector('.elic-tab-text');
            out.push({
              title: text ? text.textContent : null,
              hasDot: !!dot,
              answered: tabs[ti].className.indexOf('answered') >= 0
            });
          }
          return out;
        })(),
        elicVar: document.body ? document.body.style.getPropertyValue('--acpc-elic-h') : null,
        messagesPadBottom: document.getElementById('messages')
          ? getComputedStyle(document.getElementById('messages')).paddingBottom : null,
      }));
    })();
    // rail 与 jump-latest 在预览里通常都是 hidden 的（rail 由 transcriptView 的标记驱动、
    // jump-latest 由滚动位置驱动，而 hydrate 不会通知它们）。量位置之前先临时显示一下：
    // hidden 只决定"显不显示"，位置完全由 CSS（left:0 / left:50%）与**定位祖先**决定，
    // 所以这样量到的 left 与真面板一致 —— 而 display:none 的元素 rect 全为 0，不这么做
    // 根本量不到它们（本次改动的两处 DOM 搬迁就靠这两个读数验收）。
    var wasHidden = [];
    if (railEl && railEl.hidden) { railEl.hidden = false; wasHidden.push(railEl); }
    if (jumpEl && jumpEl.hidden) { jumpEl.hidden = false; wasHidden.push(jumpEl); }
    if (colEl && cardEl) {
      var colRect = colEl.getBoundingClientRect();
      var cardRect = cardEl.getBoundingClientRect();
      out.push(JSON.stringify({
        // [CUSTOM-20261004-183] 停止确认条：它的高度必须进 --acpc-composer-h（消息让位）。
        bodyPhase: (document.body && document.body.getAttribute) ? document.body.getAttribute('data-phase') : null,
        composerDisplay: (function () {
          var el = document.getElementById('composer');
          return el ? getComputedStyle(el).display : null;
        })(),
        composerTop: (function () {
          var el = document.getElementById('composer');
          return el ? Math.round(el.getBoundingClientRect().top) : null;
        })(),
        composerBottom: (function () {
          var el = document.getElementById('composer');
          return el ? Math.round(el.getBoundingClientRect().bottom) : null;
        })(),
        stopConfirmHidden: (function () {
          var el = document.getElementById('stopConfirm');
          return el ? el.hidden : null;
        })(),
        stopConfirmH: (function () {
          var el = document.getElementById('stopConfirm');
          return el && !el.hidden ? Math.round(el.getBoundingClientRect().height) : 0;
        })(),
        kind: 'composer',
        innerW: window.innerWidth,
        colW: Math.round(colRect.width), colLeft: Math.round(colRect.left),
        colCenter: Math.round(midOf(colEl)),
        cardW: Math.round(cardRect.width), cardLeft: Math.round(cardRect.left),
        cardCenter: Math.round(midOf(cardEl)),
        dxCardVsCol: Math.round(midOf(cardEl) - midOf(colEl)),
        dxCardVsPanel: Math.round(midOf(cardEl) - window.innerWidth / 2),
        sidebarW: sideEl ? Math.round(sideEl.getBoundingClientRect().width) : null,
        sidebarHidden: sideEl ? !!sideEl.hidden : null,
        // [CUSTOM-20260930-138] 预留功能区：它的左边界（= 那根竖线）要与钉住的大纲栏左边界
        // 落在同一条竖线上 —— dxAsideVsOutline 就是这条要求的读数（期望 0）。
        asideW: asideEl ? Math.round(asideEl.getBoundingClientRect().width) : null,
        asideLeft: asideEl ? Math.round(asideEl.getBoundingClientRect().left) : null,
        dxAsideVsOutline: (asideEl && sideEl && !sideEl.hidden)
          ? Math.round(asideEl.getBoundingClientRect().left - sideEl.getBoundingClientRect().left) : null,
        asideVar: document.body.style.getPropertyValue
          ? (document.body.style.getPropertyValue('--acpc-aside-w') || '(unset)') : '(no setProperty)',
        jumpHidden: jumpEl ? !!jumpEl.hidden : null,
        jumpCenter: jumpEl ? Math.round(midOf(jumpEl)) : null,
        dxJumpVsCol: jumpEl ? Math.round(midOf(jumpEl) - midOf(colEl)) : null,
        railParent: railEl && railEl.parentElement
          ? (railEl.parentElement.className || railEl.parentElement.id) : null,
        railLeft: railEl ? Math.round(railEl.getBoundingClientRect().left) : null,
        railW: railEl ? Math.round(railEl.getBoundingClientRect().width) : null,
        dxRailVsCol: railEl ? Math.round(railEl.getBoundingClientRect().left - colRect.left) : null,
        forcedVisible: wasHidden.length > 0,
        inputH: inputEl2 ? Math.round(inputEl2.getBoundingClientRect().height) : null,
        inputMaxH: inputEl2 ? getComputedStyle(inputEl2).maxHeight : null,
        cardRadius: getComputedStyle(cardEl).borderRadius,
        cardOverflow: getComputedStyle(cardEl).overflow,
        cardFocusWithin: cardEl.matches(':focus-within'),
        cardBorderColor: getComputedStyle(cardEl).borderTopColor,
        focusBorder: getComputedStyle(document.documentElement)
          .getPropertyValue('--vscode-focusBorder').trim(),
        slashW: (slashEl && !slashEl.hidden) ? Math.round(slashEl.getBoundingClientRect().width) : null,
        // ⚠️ --hide-scrollbars（见 shoot）会让这一项恒为 0，与真面板不符 —— 别拿无头截图的
        // 这个读数下结论，要看滚动条就单独去掉那个 flag 再跑一次。
        messagesOverflowX: messages.scrollWidth - messages.clientWidth,
      }));
    }
    for (var wh = 0; wh < wasHidden.length; wh++) { wasHidden[wh].hidden = true; }
    // [CUSTOM-20260930-140] 真悬浮：底栏是绝对定位，消息区要靠 padding-bottom 给它让位。
    // 判据是"滚到底时最后一条记录底边到面板底边的距离"（lastGap）≥ 底栏高度 ——
    // 小于就会被输入卡压住（而且是滚不动的那种压）。
    var composerEl2 = document.getElementById('composer');
    if (composerEl2) {
      var kidEls = messages.children;
      var lastGap = null;
      if (kidEls.length) {
        var lr = kidEls[kidEls.length - 1].getBoundingClientRect();
        lastGap = Math.round(messages.getBoundingClientRect().bottom - lr.bottom);
      }
      out.push(JSON.stringify({
        kind: 'layout',
        composerPosition: getComputedStyle(composerEl2).position,
        // [CUSTOM-20260930-143] 未连接时应当是 'none'（整块消失）。
        composerDisplay: getComputedStyle(composerEl2).display,
        composerBg: getComputedStyle(composerEl2).backgroundColor,
        composerH: composerEl2.offsetHeight,
        composerVar: document.body.style.getPropertyValue
          ? (document.body.style.getPropertyValue('--acpc-composer-h') || '(unset)') : '(no setProperty)',
        messagesPadBottom: getComputedStyle(messages).paddingBottom,
        // [CUSTOM-20260930-144] 贴底时应当含 pin-bottom —— 它是那段留白的开关。
        messagesClasses: messages.className,
        lastGap: lastGap,
        // 诊断三件套：滚到底之后最后一次布局的实际数字（lastGap 为负时用它们定位原因）。
        messagesScrollTop: messages.scrollTop,
        messagesScrollH: messages.scrollHeight,
        messagesClientH: messages.clientHeight,
        messagesRectBottom: Math.round(messages.getBoundingClientRect().bottom),
        lastRectBottom: kidEls.length
          ? Math.round(kidEls[kidEls.length - 1].getBoundingClientRect().bottom) : null,
        jumpBottom: getComputedStyle(document.getElementById('jumpToLatest')).bottom,
      }));
    }
    // [CUSTOM-20260930-141] 目录过滤菜单：drawerOverflowY 应当是 visible（修好之前是 auto，
    // 会把 menuOverhang 那一段裁掉）；menuH 应当接近它自己的 max-height（260px）而不是几行。
    // [CUSTOM-20260930-144] 大纲侧栏的滚动：滚到底时最后一条应当落在侧栏可视区内
    // （overflowBeyondSidebar > 0 就说明它被挤到侧栏外面、被裁掉了）。
    var sideListEl = document.querySelector('.outline-sidebar .outline-list');
    var sidebarEl = document.getElementById('outlineSidebar');
    if (sideListEl && sidebarEl && !sidebarEl.hidden) {
      var sideItems = sideListEl.children;
      var lastSideItem = sideItems.length ? sideItems[sideItems.length - 1] : null;
      var sidebarRect = sidebarEl.getBoundingClientRect();
      out.push(JSON.stringify({
        kind: 'outline-scroll',
        listClientH: sideListEl.clientHeight,
        listScrollH: sideListEl.scrollHeight,
        listScrollTop: sideListEl.scrollTop,
        sidebarH: Math.round(sidebarRect.height),
        sidebarBottom: Math.round(sidebarRect.bottom),
        lastItemBottom: lastSideItem
          ? Math.round(lastSideItem.getBoundingClientRect().bottom) : null,
        overflowBeyondSidebar: lastSideItem
          ? Math.round(lastSideItem.getBoundingClientRect().bottom - sidebarRect.bottom) : null,
        // **最直接的遮挡判据**：在大纲最后一条的底边中点取样，看最上层元素是谁。
        // 被底栏盖住时这里返回的是 composer / composer-inner 之类，而不是 outline-item。
        topElementAtLastItem: (function () {
          if (!lastSideItem || !document.elementFromPoint) { return null; }
          var r = lastSideItem.getBoundingClientRect();
          var el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.bottom - 3));
          return el ? String(el.className || el.tagName) : null;
        })(),
        panelBottom: window.innerHeight,
      }));
    }
    // [CUSTOM-20260930-145 / 146] Times 的读数。146 起**只有工具卡**的时刻是可见的
    // （普通记录的元素还在 DOM 里，但选择器不放它出来），所以先按"可见"过滤再量位置 ——
    // visible 应当等于工具卡的数量，rows 里也只该出现 tool。
    if (messages.classList.contains('show-times')) {
      var stamps = messages.querySelectorAll('.rec-time');
      var rows = [];
      var visibleCount = 0;
      var msgRight = messages.getBoundingClientRect().right;
      for (var si2 = 0; si2 < stamps.length; si2++) {
        var sr = stamps[si2].getBoundingClientRect();
        if (sr.width === 0) { continue; }
        visibleCount++;
        var owner = stamps[si2].closest('[data-kind]') || stamps[si2].parentNode;
        var or2 = owner ? owner.getBoundingClientRect() : null;
        rows.push({
          kind: owner && owner.getAttribute ? owner.getAttribute('data-kind') : null,
          gapRight: Math.round(msgRight - sr.right),
          gapTop: or2 ? Math.round(sr.top - or2.top) : null,
        });
      }
      out.push(JSON.stringify({
        kind: 'times', visible: visibleCount, total: stamps.length, rows: rows,
      }));
    }
    // [CUSTOM-20261008-199] 空态 header 的几何（#nosessionheader 档）：地址栏该有内容且点不动，
    // 而 Times 该被顶到右边 —— 它原先靠 '.session-title' 的 flex:1 顶，那一格一隐藏整组就滑到左边。
    if (location.hash.indexOf('nosessionheader') >= 0) {
      var headerEl = document.getElementById('sessionHeader');
      var cwdEl = document.getElementById('cwdBtn');
      var timeEl = document.getElementById('timeToggle');
      if (headerEl && cwdEl && timeEl) {
        var hr = headerEl.getBoundingClientRect();
        var tr = timeEl.getBoundingClientRect();
        var cr2 = cwdEl.getBoundingClientRect();
        out.push(JSON.stringify({
          kind: 'header',
          phase: document.body.getAttribute('data-phase'),
          cwdHidden: cwdEl.hidden === true,
          cwdDisabled: cwdEl.disabled === true,
          cwdText: cwdEl.textContent,
          cwdWidth: Math.round(cr2.width),
          timeVisible: tr.width > 0,
          // Times 右缘与 header 右缘之差：应当只剩 header 的右内边距。
          gapRight: Math.round(hr.right - tr.right),
          padRight: Math.round(parseFloat(getComputedStyle(headerEl).paddingRight) || 0),
        }));
      }
    }
    // [CUSTOM-20261008-206] 引用栏那一格：#refchip 档下读"开关字形 / tag 文本 / 是否算出可点"。
    if (location.hash.indexOf('refchip') >= 0) {
      var refChip = document.querySelector('.ref-chip');
      var refToggle = document.querySelector('.ref-toggle');
      var refTag = document.querySelector('.ref-tag');
      out.push(JSON.stringify({
        kind: 'refchip',
        present: !!refChip,
        // [CUSTOM-20261009-214] 原 on=（两态里的"已引用"）随那一态退役 —— 引用栏只剩预选态，
        // 已引用时这格整个不渲染（下面的 refChipAfterAttach 读的就是它）。
        toggle: refToggle ? String(refToggle.textContent) : null,
        label: refTag ? String(refTag.textContent).trim() : null,
        href: refTag ? refTag.getAttribute('data-path') : null,
        barHidden: (function () { var b = document.getElementById('attachments'); return b ? b.hidden === true : null; })(),
        // [CUSTOM-20261008-207] 开关排在 tag **之后**（用户要求 + 与 × 一致）。
        toggleAfterTag: !!(refChip && refChip.lastChild && String(refChip.lastChild.className || '').indexOf('ref-toggle') >= 0),
        // [CUSTOM-20261008-208] 开关要在 **chip 里面**（预选态的强调色底 + 虚线由 styleOff 读）。
        toggleInside: !!(refChip && refToggle && refChip.contains && refChip.contains(refToggle)),
        styleOff: readRefStyle(refChip),
        // [CUSTOM-20261009-214] 探针自己翻一次状态（把这一段标成已引用）再读第二遍：
        // 引用栏那一格应当**整个消失**（重复 tag 的修法 —— 已引用的在附件行里有自己的 chip），
        // 且附件行里那条要带上 </> 图标。两态各一次读数，一次就把整条链看到底。
        refChipAfterAttach: (function () {
          if (!refChip || !NS.composer.setAttachments) { return null; }
          // 区间必须与当前选区一致 —— 同一性 = 路径 + 区间（207），不然这里翻不过去。
          NS.composer.setAttachments([{ path: 'f:/P4/x/PianoGameplayDefine.cs', name: 'x', kind: 'file', lineStart: 12, lineEnd: 40 }]);
          return !!document.querySelector('.ref-chip');
        })(),
        attachmentIconAfterAttach: !!document.querySelector('#attachments .attachment .chip-icon'),
      }));
      function readRefStyle(node) {
        if (!node || !window.getComputedStyle) { return null; }
        var cs = window.getComputedStyle(node);
        return { bg: cs.backgroundColor, border: cs.borderStyle };
      }
    }

    // [CUSTOM-20261008-206] 文件 chip 的几何：#filechip 档下量"同栏"与"tag 高度"。
    if (location.hash.indexOf('filechip') >= 0) {
      var bubbles = messages.querySelectorAll('.entry-user');
      for (var bi = 0; bi < bubbles.length; bi++) {
        var caret = bubbles[bi].querySelector('.fold-caret');
        var chip = bubbles[bi].querySelector('.chip');
        var img = bubbles[bi].querySelector('.content-image-chip');
        var cRect = caret ? caret.getBoundingClientRect() : null;
        var chipRect = chip ? chip.getBoundingClientRect() : null;
        var imgRect = img ? img.getBoundingClientRect() : null;
        out.push(JSON.stringify({
          kind: 'filechip',
          which: chip ? 'file' : (img ? 'image' : 'none'),
          // 同一行 ⇒ 两个 top 相差不到半个行高；差一整个 tag 高就是"掉到第二行"。
          caretTop: cRect ? Math.round(cRect.top) : null,
          chipTop: chipRect ? Math.round(chipRect.top) : (imgRect ? Math.round(imgRect.top) : null),
          chipH: chipRect ? Math.round(chipRect.height) : (imgRect ? Math.round(imgRect.height) : null),
          hasIcon: !!(chip && chip.querySelector('.chip-icon')),
          // [CUSTOM-20261008-207] 图标必须在**最前**（appendChild 会把它放到名字后面）。
          iconFirst: !!(chip && chip.firstChild && String(chip.firstChild.className || '').indexOf('chip-icon') >= 0),
          label: chip ? String(chip.textContent || '').trim() : '',
        }));
      }
    }
    var drawerEl3 = document.getElementById('history');
    var filterMenuEl3 = document.getElementById('historyFilterMenu');    if (drawerEl3 && filterMenuEl3) {
      out.push(JSON.stringify({
        kind: 'history-filter',
        drawerH: Math.round(drawerEl3.getBoundingClientRect().height),
        drawerOverflowY: getComputedStyle(drawerEl3).overflowY,
        menuH: Math.round(filterMenuEl3.getBoundingClientRect().height),
        menuScrollH: filterMenuEl3.scrollHeight,
        menuBorderColor: getComputedStyle(filterMenuEl3).borderTopColor,
        menuOverhang: Math.round(filterMenuEl3.getBoundingClientRect().bottom
          - drawerEl3.getBoundingClientRect().bottom),
      }));
    }
    // [CUSTOM-20261003-176] 复现用户 2026-10-03 报的"消息面板没到底（Jump 还在），可滚动条已经触底、
    // 鼠标再也滚不动"。**只能量不能推**（pitfall #31）：把滚动状态与"内容 / 表单抽屉 / 输入卡"三者的
    // 几何一起读出来。elic 档只 hydrate 了表单本身（滚不动），这里把标准夹具一并具上，才有得滚。
    if (location.hash.indexOf('bottomstuck') >= 0) { try {
      // 标准夹具重复几遍：本档要复现的是"长会话里滚到底"的状态，而 FIXTURES 只有一屏多一点
      // （内容只比视口短 ~96px）——那种状态下"上翻"根本翻不动，量出来的东西没有代表性。
      var longStuck = [];
      for (var repStuck = 0; repStuck < 4; repStuck++) {
        for (var fi = 0; fi < fixtures.length; fi++) {
          var cloned = {};
          for (var fk in fixtures[fi]) { if (Object.prototype.hasOwnProperty.call(fixtures[fi], fk)) { cloned[fk] = fixtures[fi][fk]; } }
          cloned.id = fixtures[fi].id + '-r' + repStuck;
          longStuck.push(cloned);
        }
      }
      NS.transcriptView.hydrate({
        sessionId: SESSION,
        entries: longStuck.concat([{ id: 'preview-elic', kind: 'elicitation', at: Date.now(), elicitation: elicState }])
      });
      NS.elicitationView.setSession(SESSION);
      NS.elicitationView.sync();
      // 真滚到底（值变了 ⇒ 浏览器异步派发 scroll），再手动派发一次让 onScroll 在同一同步块里跑完。
      messages.scrollTop = messages.scrollHeight;
      messages.dispatchEvent(new Event('scroll'));
      function measureStuck(tag) {
        var padStuck = parseFloat(getComputedStyle(messages).paddingBottom) || 0;
      var maxStuck = messages.scrollHeight - messages.clientHeight;
      var jumpStuck = document.getElementById('jumpToLatest');
      var drawerStuck = document.getElementById('elicDrawer');
      var dRectStuck = (drawerStuck && !drawerStuck.hidden) ? drawerStuck.getBoundingClientRect() : null;
      var compStuck = document.getElementById('composer');
      var cRectStuck = compStuck ? compStuck.getBoundingClientRect() : null;
      var orderStuck = NS.transcriptView.ordered() || [];
      var lastStuck = orderStuck.length ? NS.transcriptView.node(orderStuck[orderStuck.length - 1]) : null;
      var lRectStuck = lastStuck ? lastStuck.getBoundingClientRect() : null;
      out.push(JSON.stringify({
        kind: 'bottom-stuck-' + tag,
        scrollTop: Math.round(messages.scrollTop), max: Math.round(maxStuck),
        atMax: Math.abs(messages.scrollTop - maxStuck) < 1,
        padBottom: Math.round(padStuck),
        distance: Math.round(messages.scrollHeight - padStuck - messages.scrollTop - messages.clientHeight),
        pinned: NS.scroll.isPinned(),
        jumpHidden: jumpStuck ? jumpStuck.hidden : null,
        composerH: cRectStuck ? Math.round(cRectStuck.height) : -1,
        composerTop: cRectStuck ? Math.round(cRectStuck.top) : null,
        drawerH: dRectStuck ? Math.round(dRectStuck.height) : 0,
        drawerOffsetH: drawerStuck ? drawerStuck.offsetHeight : -1,
        drawerTop: dRectStuck ? Math.round(dRectStuck.top) : null,
        lastRecordBottom: lRectStuck ? Math.round(lRectStuck.bottom) : null,
        coveredByComposer: (lRectStuck && cRectStuck) ? lRectStuck.bottom > cRectStuck.top : null,
        coveredByDrawer: (lRectStuck && dRectStuck) ? lRectStuck.bottom > dRectStuck.top : null,
        elicVar: (document.body.style.getPropertyValue('--acpc-elic-h') || '').trim(),
        composerVar: (document.body.style.getPropertyValue('--acpc-composer-h') || '').trim(),
      }));
      }
      // ⚠️ 预览驱动**默认不接** scroll.ts（见本文件里 'onScroll 没绑上' 那条注释）——那会让
      // pinned / jumpHidden 两列恒为初值，读出来是假数据。本档要验的正是"几何变了之后视口判定
      // 有没有重算"，所以这里显式接上真监听。
      NS.scroll.init(messages, document.getElementById('jumpToLatest'));
      // 变高方向：基线先切到**较矮**的那一题，迁移时切回较高的一题 ⇒ 抽屉长高。
      if (location.hash.indexOf('tallgrow') >= 0) { NS.elicitationView.selectTab(1); }
      var padStuck0 = parseFloat(getComputedStyle(messages).paddingBottom) || 0;
      measureStuck('base');
      // 迁移：先上翻一点（Jump 出现、pinned=false），再让抽屉长高（换到更高的那一题）。
      // 这两步在真机上都不会产生 scroll 事件 —— 正是"Jump 还在、内容却被盖住"的嫌疑路径。
      // pullup：上翻到**留白之外**（真的 un-pin，Jump 出现）——"在看历史的人"那种状态。
      if (location.hash.indexOf('pullup') >= 0) {
        messages.scrollTop = Math.max(0, messages.scrollTop - (padStuck0 + 120));
        messages.dispatchEvent(new Event('scroll'));
      }
      if (location.hash.indexOf('growdrawer') >= 0) {
        NS.elicitationView.selectTab(1);
      }
      if (location.hash.indexOf('tallgrow') >= 0) {
        NS.elicitationView.selectTab(0);
      }
      measureStuck('after');
    } catch (e) { out.push(JSON.stringify({ kind: 'bottom-stuck-error', message: String((e && e.message) || e) })); } }
    // [CUSTOM-20261004-180] 长会话里"点一次折叠"的代价。
    // 量的是**布局读取次数**（确定性，不受 --virtual-time 影响）与两帧内的毫秒数：
    // 改前 rail.measure 边读边写（读一次 rect → 写一次 dot.top），每次写都让下一次读强制重排
    // ⇒ O(n) 次强制布局；改后只读一遍再只写一遍 ⇒ O(n) 次读、一次重排。
    // 计数口是三个（rect / offsetTop / offsetHeight），页面里别的模块也会读 —— 所以看的是
    // **同一个操作在改前/改后两次运行里的差**，不是绝对值。
    // [CUSTOM-20261004-184] 正文里的本地文件链接：**整条链**走一遍。
    //
    // 为什么要真浏览器：宿主侧（markdown.ts 写出 data-path）与客户端（点击委托发 openFile）
    // 各自都有单元测试，中间那一跳**只在真 webview 里存在** —— 宿主 HTML 要经过客户端的
    // sanitize()（真 DOMParser + 属性白名单）才会变成 DOM，而白名单正是"没列进去的属性
    // 静默消失"的地方。两端各证一遍 != 整条链通了（pitfalls #43）。
    // 输入用的是宿主 SafeMarkdown 的真实产物（buildHtml 现算的），不是手写近似。
    // ⚠️ 本模板体里**不能出现反引号**（pitfalls #11）：注释里也别写，用 sanitize() 这种写法。
    if (location.hash.indexOf('linkclick') >= 0) { try {
      var sent = [];
      var realPost = NS.bridge.post;
      // 只在桥的出口拦一道。这里**看不到 sessionId**：本页没有走过 boot 消息，boot 的
      // currentSessionId 是 null（postForSession 只在有聚焦会话时才补写）—— 这一档量的是
      // "点击有没有落到 openFile 这条通道上"，补写那一步由 boot 自己的路径负责。
      NS.bridge.post = function (m) { sent.push(m); return realPost(m); };
      NS.transcriptView.hydrate({ sessionId: SESSION, entries: [
        { id: 'link1', kind: 'assistant', at: Date.now(), streaming: false,
          text: '[GOAL.md:74](GOAL.md:74)', html: window.__acpcLinkHtml }
      ]});
      var anchor = messages.querySelector('a[data-path]');
      var inert = messages.querySelector('.link-blocked');
      // boot 的 init 挂在 DOMContentLoaded 上，而驱动脚本在**解析期**就跑（文件末尾的
      // <script>）—— 那一刻委托还没装上。rail / composer 两个档也是这么各自补一次的。
      if (anchor) { NS.links.installDelegatedHandlers(document.body); }
      if (anchor) {
        // 真点击（冒泡 + 可取消），走的是 boot 装在 document.body 上的那条委托。
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      out.push(JSON.stringify({
        kind: 'link-click',
        anchorFound: !!anchor,
        dataPath: anchor ? anchor.getAttribute('data-path') : null,
        dataLine: anchor ? anchor.getAttribute('data-line') : null,
        inertSpans: inert ? 1 : 0,
        sent: sent,
      }));
    } catch (e) { out.push(JSON.stringify({ kind: 'link-click-error', message: String((e && e.message) || e) })); } }
    // [CUSTOM-20261004-189] 表单里打字时**焦点会不会掉**。
    //
    // 用户报："在附加内容输入框（以及 Other 里的自定义输入框）输入内容时，每输入一个字符就
    // 失去焦点"。这是一个**浏览器行为**的断言（移动一个已聚焦的节点会不会让它失焦），按本仓库
    // 的规矩只能量不能推（pitfall #31）。做法完全照用户的操作：选中一行 → 点进那个框 → 派发
    // 一次真的 'input' 事件（打字就是它）→ 看 document.activeElement 还是不是那个框。
    if (location.hash.indexOf('elicfocus') >= 0) { try {
      // 计一次"这个宿主被 appendChild 了几次"：只有计数 > 0 才谈得上"是不是搬动弄丢了焦点"。
      function spyAppend(node) {
        var host = node && node.parentNode;
        if (!host) { return { moves: 0 }; }
        if (!host.__acpcAppendCount) {
          var original = host.appendChild.bind(host);
          host.__acpcAppendCount = 0;
          host.appendChild = function (child) { host.__acpcAppendCount += 1; return original(child); };
        }
        return host;
      }
      function probeFocus(label, find, pick) {
        var result = { label: label, found: false, moves: 0, focusedBefore: null, focusedAfter: null, note: null };
        if (pick) { pick(); }
        var input = find();
        if (!input) { result.note = 'no input'; return result; }
        result.found = true;
        input.focus();
        result.focusedBefore = document.activeElement === input;
        var host = spyAppend(input);
        var chainBefore = [];
        for (var n = input; n; n = n.parentNode) { chainBefore.push(n); }
        // [CUSTOM-20261004-189] 先直接量**那条浏览器原语**：把已聚焦节点的祖先重新
        // appendChild 到**同一个**父级，焦点还在吗？appendChild 的语义是"先摘下来再插回去"，
        // 而"摘下来"正是会触发失焦的那一步 —— 这一格是"是不是搬动造成的"的判据本身，
        // 不靠推理（pitfall #31）。
        var box = input.closest ? input.closest('[data-elic-custom], .elic-note-box') : null;
        if (box && box.parentNode) {
          var keeper = box.parentNode;
          keeper.appendChild(box);          // 同一个父级，纯搬动
          result.focusAfterSameParentMove = document.activeElement === input;
          input.focus();
        }
        // 连打三个字符（每次 input 事件都是用户敲一下键）。
        for (var k = 0; k < 3; k++) {
          input.value += String(k);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        result.moves = host && host.__acpcAppendCount ? host.__acpcAppendCount : 0;
        result.focusedAfter = document.activeElement === input;
        result.sameChain = (function () {
          var now = []; for (var m = input; m; m = m.parentNode) { now.push(m); }
          return now.length === chainBefore.length;
        })();
        result.activeNow = document.activeElement
          ? String(document.activeElement.tagName + '.' + (document.activeElement.className || '')) : 'none';
        return result;
      }
      var otherResults = probeFocus('other', function () {
        var box = document.querySelector('[data-elic-custom]');
        return box ? box.querySelector('input') : null;
      }, function () {
        var radio = document.querySelector('.elic-field input[type="radio"]');
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      // 多选那一题在第二页：先切过去，它的每行补充框才可能拿到焦点。
      var noteResults = probeFocus('note', function () {
        var box = document.querySelector('.elic-note-box');
        return box ? box.querySelector('input') : null;
      }, function () {
        if (NS.elicitationView.selectTab) { NS.elicitationView.selectTab(1); }
        var noteRow = document.querySelector('.elic-note-box');
        var cb = noteRow && noteRow.parentNode ? noteRow.parentNode.querySelector('input[type="checkbox"]') : null;
        if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      out.push(JSON.stringify({ kind: 'elic-focus', other: otherResults, note: noteResults }));
    } catch (e) { out.push(JSON.stringify({ kind: 'elic-focus-error', message: String((e && e.message) || e) })); } }
    // [CUSTOM-20261004-190] 圆环外圈那条动画有没有被重建打断。
    //
    // 截图看不出动没动（一帧而已），而无头 Edge 里 prefers-reduced-motion 恒为 true（实测），
    // 那条全局 animation:none!important 会把一切动画摁死 —— 所以本档**量不了动效**，
    // 也不装作量了。能确定量的是它的**成因**：动画会被节点被重建重置。
    // 判据 = 节点身份：调一次 setRunning（流式期间每个 chunk 都会来一次）后，那颗 svg 还是不是同一颗。
    // 修前 sameSvgNode:false（外圈永远停在起点 = 用户报的只剩下面多了一段圆环），修后 true。
    if (location.hash.indexOf('gauge') >= 0) { try {
      var meterEl = document.getElementById('contextMeter');
      var spinBefore = meterEl ? meterEl.querySelector('.gauge-spin') : null;
      var svgBefore = meterEl ? meterEl.querySelector('svg') : null;
      if (NS.composer && NS.composer.setRunning) { NS.composer.setRunning(true); }
      var svgAfter1 = meterEl ? meterEl.querySelector('svg') : null;
      if (NS.composer && NS.composer.setRunning) { NS.composer.setRunning(true); }
      var svgAfter2 = meterEl ? meterEl.querySelector('svg') : null;
      if (NS.composer && NS.composer.setRunning) { NS.composer.setRunning(true); }
      var svgAfter3 = meterEl ? meterEl.querySelector('svg') : null;
      out.push(JSON.stringify({
        kind: 'gauge-rebuild',
        className: meterEl ? String(meterEl.className) : null,
        hasSpin: !!spinBefore,
        sameSpinNode: !!spinBefore && spinBefore === (meterEl ? meterEl.querySelector('.gauge-spin') : null),
        sameSvgNode: !!svgBefore && svgBefore === svgAfter1,
        secondCallKept: !!svgAfter1 && svgAfter1 === svgAfter2,
        thirdCallKept: !!svgAfter2 && svgAfter2 === svgAfter3,
        hiddenBefore: !meterEl || meterEl.hidden,
        reducedMotion: window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : null,
        meterBox: (meterEl && meterEl.getBoundingClientRect)
          ? Math.round(meterEl.getBoundingClientRect().width) + 'x' + Math.round(meterEl.getBoundingClientRect().height)
          : null,
      }));
    } catch (e) { out.push(JSON.stringify({ kind: 'gauge-rebuild-error', message: String((e && e.message) || e) })); } }
    // [CUSTOM-20261005-192] 滚动诊断到底会不会打 —— 造两次几何变化（输入卡长高、抽屉/权限变量）
    // 与一次「到底再上翻」，把 console 捕下来看。
    if (location.hash.indexOf('scrolllog') >= 0) { try {
      var logLines = [];
      var nativeWarn3 = console.warn;
      console.warn = function () {
        logLines.push(Array.prototype.slice.call(arguments).join(' '));
        nativeWarn3.apply(console, arguments);
      };
      // ① 输入卡长高（多行 → autoGrow → --acpc-composer-h 变化 → noteGeometry）
      var inputEl = document.getElementById('promptInput');
      if (inputEl) {
        inputEl.value = 'a\\nb\\nc\\nd\\ne\\nf';
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // ② 滚到底，再上翻一点（user-scroll 两条 + pinned 翻转）
      var msgsEl = document.getElementById('messages');
      if (msgsEl) {
        msgsEl.scrollTop = msgsEl.scrollHeight;
        msgsEl.dispatchEvent(new Event('scroll'));
        if (NS.scroll && NS.scroll.reflowNow) { NS.scroll.reflowNow(); }
        msgsEl.scrollTop = Math.max(0, msgsEl.scrollTop - 300);
        msgsEl.dispatchEvent(new Event('scroll'));
      }
      // ③ 手势落点：在"记录区"与"大纲栏"各按一下（看 press@ 标签对不对）。
      // 隔 800ms 再按：诊断自带 700ms 节流，紧跟在前三条 geom 后面会被合理地压掉。
      window.setTimeout(function () {
        var msgsEl2 = document.getElementById('messages');
        if (msgsEl2) {
          var rect2 = msgsEl2.getBoundingClientRect();
          msgsEl2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect2.left + msgsEl2.clientWidth + 5 }));
        }
        var outlineEl = document.querySelector('.outline-sidebar') || document.getElementById('outline');
        if (outlineEl) { outlineEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }
      }, 800);
      window.setTimeout(function () {
        var preEl = document.getElementById('probe');
        if (preEl) {
          preEl.textContent += '\\n' + JSON.stringify({ kind: 'scroll-log', count: logLines.length, lines: logLines.slice(0, 10) });
        }
      }, 1200);
    } catch (e) { out.push(JSON.stringify({ kind: 'scroll-log-error', message: String((e && e.message) || e) })); } }
    var pre = document.createElement('pre');
    pre.id = 'probe';
    pre.textContent = out.join('\\n');
    document.body.appendChild(pre);
  }
  document.title = 'records' + location.hash + (failed ? ' (' + failed + ' failed)' : '');
})();
`;
}

function buildHtml() {
  const compiled = loadCompiled();
  // The module ships the <style> / <body> wrappers inline (that is how the webview
  // document is assembled); this page provides its own shell, so they are peeled off.
  const style = compiled.styles().replace(/^<style>/, '').replace(/<\/style>$/, '');
  const markup = compiled.body('view');
  const script = compiled.clientSource();
  const title = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>records</title></head>`;
  // [CUSTOM-20260930-147] webview API 的替身，**必须放在客户端脚本之前**：`boot.ts` 顶层就有
  // `var vscode = acquireVsCodeApi();`，本脚本以前没提供它 ⇒ boot 模块一加载就抛错 ⇒ `NS.boot`
  // 根本不存在 ⇒ markdown 的请求-回填那条链路**从来没被预览覆盖过**（`flushPending` 里有
  // `if (!hasNS.boot) return;` 的守卫，于是它静默什么都不做）。#bootround 档就靠它做端到端。
  const vscodeStub = '<script>window.acquireVsCodeApi = function () { return {'
    + ' postMessage: function () {}, setState: function () {}, getState: function () { return null; } }; };</script>';
  // [CUSTOM-20260930-147] 最早的未捕获错误收集器，**必须排在客户端脚本之前**：boot 是在模块
  // 加载时自调用 init 的，它若中途抛错，"注册 message 监听"那一步就永远不会执行 —— 而那正是
  // "请求发出去了、回填却像没发生"的成因之一。driver 里再监听就太晚了。
  const earlyErrors = '<script>window.__acpcErrors = [];'
    + ' window.addEventListener("error", function (e) {'
    + ' window.__acpcErrors.push(String(e.message || e) + " @" + (e.lineno || 0)); });</script>';
  // [CUSTOM-20261004-184] #linkclick 档的输入：宿主 SafeMarkdown 对
  // `[GOAL.md:74](GOAL.md:74)` 的真实产物。`<` 转义掉，免得序列化后提前结束脚本标签。
  const linkHtmlScript = '<script>window.__acpcLinkHtml = '
    + JSON.stringify(compiled.fileLinkHtml).replace(/</g, '\\u003c') + ';</script>';
  return [title, `<style>${THEME}</style>`, `<style>${style}</style>`, markup,
    vscodeStub, earlyErrors, linkHtmlScript,
    `<script>${script}</script>`, `<script>${driver()}</script>`].join('\n');
}

/** Chrome then Edge, whichever exists first. Never a dependency: absent ⇒ skip. */
function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// [CUSTOM-20260930-136] size 参数化。默认的 500 是**故意的窄档**：Chrome 有约 500px 的
// 最小窗口宽度，给 430 时**布局视口仍是 500**、只有截图被裁到 430 —— 于是"卡片右边被切掉
// 一块"看起来像溢出，其实是假象（实测：window-size=430 ⇒ innerWidth=500；window-size=900
// ⇒ 884）。真要看窄侧边栏，用 #narrow 把消息区钉死（见 driver），不要调这里。
//
// 但输入卡的限宽（--acpc-composer-max，720px）与右侧预留功能区（--acpc-aside-w，默认 240）
// **只在面板够宽时才显形** —— 照默认档截，"改前/改后"两张图会一模一样。所以宽档必须往**上**
// 给（SHOTS 里写 '1440,1000'），并记得换算：window-size ⇒ innerWidth 要减约 16
// （1440 ⇒ 1424、900 ⇒ 884）。
function shoot(browser, htmlPath, outPath, hash, size) {
  const profile = join(OUT_DIR, 'profile');
  const res = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=2000',
    `--window-size=${size || '500,1500'}`,
    `--screenshot=${outPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}${hash}`,
  ], { encoding: 'utf8' });
  if (!existsSync(outPath)) {
    console.log(`  [WARN] 截图失败（${hash || 'plain'}）：${(res.stderr || '').split('\n')[0]}`);
    return false;
  }
  return true;
}

mkdirSync(OUT_DIR, { recursive: true });
const htmlPath = join(OUT_DIR, 'records.html');
writeFileSync(htmlPath, buildHtml(), 'utf8');
console.log(`  [OK] 生成 ${htmlPath}`);

if (PRINT_ONLY) { process.exit(0); }

const browser = findBrowser();
if (!browser) {
  console.log('  (本机没有 Chrome/Edge，跳过截图；HTML 已生成，可手动打开)');
  process.exit(0);
}
console.log(`  浏览器：${browser}`);
const shots = [];
// [CUSTOM-20260930-123] 三个状态卡相位各截一张。窄侧边栏档用 #narrow（把消息区钉到
// 260px）而不是 --window-size —— 后者只影响截图裁剪，测不出"卡片撑破容器没有"。
const SHOTS = [
  ['#expanded', 'expanded'],
  ['#collapsed', 'collapsed'],
  ['#tools', 'tools'],
  ['#empty', 'empty'],
  ['#connecting', 'connecting'],
  ['#ready', 'ready'],
  ['#emptynarrow', 'empty-narrow'],
  ['#readynarrow', 'ready-narrow'],
  // [CUSTOM-20260930-129] 时刻改挂到标题行右侧（含折叠态），以及底部那颗上下文圆环的
  // 三档（正常 / 高用量 / 有轮次在跑）。
  ['#times', 'times'],
  // [CUSTOM-20260930-145] 窄面板下的 Times：工具卡的时刻到底贴不贴右缘（用户报的"不对齐"）。
  ['#timesnarrow', 'times-narrow', '1440,900'],
  ['#timescollapsed', 'times-collapsed'],
  // [CUSTOM-20261009-209] 会话恢复的提问卡片（空态 + 上次开着的三个会话）。
  ['#restorecard', 'restore-card'],
  // [CUSTOM-20261008-206] 输入框引用栏的当前文件格（`+` + 文件名 + 行区间）。
  ['#refchip', 'ref-chip'],
  // [CUSTOM-20261008-206] 用户气泡里的文件 chip（与 caret 同栏 + 加高 + </> 图标）。
  ['#filechip', 'file-chip'],
  // [CUSTOM-20261008-199] 空态 header（已连接、还没有会话）：地址栏该有内容、Times 该贴右缘。
  // 带 probe：判据是数字（Times 右缘与 header 右缘之差），不是肉眼看截图。
  ['#nosessionheaderprobe', 'no-session-header', '1440,900'],
  ['#gauge', 'gauge'],
  ['#gaugewarn', 'gauge-warn'],
  ['#gaugehot', 'gauge-hot'],
  ['#gaugebusy', 'gauge-busy'],
  ['#gaugebusybig', 'gauge-busy-big'],
  ['#gaugehotbig', 'gauge-hot-big'],
  // [CUSTOM-20260930-130] 标签栏状态点：颜色 = 状态，外圈 = 正在做事。
  ['#tabs', 'tabs'],
  ['#tabsbig', 'tabs-big'],
  // [CUSTOM-20260930-136] 底部栏（输入卡 + 预留功能区）。窄档走默认的 500（退化档：卡片随
  // 主列收缩、圆角与内边距不变，证明没有 media query 也能正常退化）；其余宽档必须显式给
  // 1440，否则输入卡的限宽与预留区根本不显形（见 shoot 的注释）。tall 档同一个 hash 截两个
  // 高度，验 max-height: min(320px, 38vh) 里那个 38vh 是否真的夹住了。
  // composeroutline 是 138 那条"竖线与大纲栏左边界对齐"的验收档（探针读 dxAsideVsOutline）。
  ['#composer', 'composer-narrow'],
  ['#composerwide', 'composer-wide', '1440,1000'],
  ['#composeroutline', 'composer-wide-outline', '1440,1000'],
  ['#composerfocus', 'composer-focus', '1440,1000'],
  ['#composerslash', 'composer-slash', '1440,1000'],
  ['#composertall', 'composer-tall', '1440,1000'],
  ['#composertall', 'composer-tall-short', '1440,560'],
  // [CUSTOM-20260930-140/141] 真悬浮（滚到最底，看最后一条会不会被卡片压住）与目录过滤菜单
  // （历史浮层里的嵌套菜单能不能完整显示）。
  // ⚠️ hash 必须是 `#composerbottom`：`#composerwidebottom` 里**不含** 'composerbottom' 这个
  // 子串（'wide' 夹在中间），driver 的 indexOf 判断会静默不匹配 —— 这个坑在本文件里出现过
  // 第二次了（`#gaugebusybig` 不含 'gaugebig'），凡是"给现有档加后缀"都要先念一遍。
  // [CUSTOM-20261004-183] 停止确认条（在输入卡上方）。
  // ⚠️ 截图档**不能**带 'probe'：探针会把几十行 <pre> 追加到 body 末尾，正好盖住底部的
  // composer（它是绝对定位）。数字用另一个 hash（#stopconfirmprobe）读。
  ['#stopconfirm', 'stop-confirm', '1440,1000'],
  // 已连接相位下再出一张（draft 页走 setConnected(true)）：composer 在纯 composer 档里
  // 一直截不到（既有现象，与 183 无关），借这个相位才能看到确认条的观感。
  ['#composerdraftstopconfirm', 'stop-confirm-connected', '1440,1000'],
  ['#composerbottom', 'composer-wide-bottom', '1440,1000'],
  // [CUSTOM-20261009-210] 「到底了、尾巴还被卡片压住」的自愈：变量被踩回 0px 后，滚到底
  // 派发 scroll 应当自己修复（varAfter 回真实高度、covered=false、lastGap ≥ 卡片高）。
  ['#composerbottomtailprobe', 'tail-covered', '1440,900'],
  // [CUSTOM-20260930-144] 中途（不在底部）：不该有那段让位留白，消息应当铺到面板底。
  ['#composermid', 'composer-mid', '1440,900'],
  // 贴底后上滚 40px（用户截图里的位置）：留白必须撤掉。
  ['#composerjustup', 'composer-just-up', '1440,900'],
  // 走 toBottom() 的程序路径贴底（切换会话/重开面板）：留白必须挂上。
  ['#composerrealbottom', 'composer-real-bottom', '1440,900'],
  // [CUSTOM-20260930-144] 大纲滚到底（最后一条会不会被底栏盖住），以及**编辑区面**下同一件事
  // ——用户报的遮挡只在编辑区面里出现（`.surface-editor .composer` 的不透明背景）。
  ['#composeroutlinescroll', 'outline-scroll', '1440,900'],
  ['#composeroutlinescrollsurfaceeditor', 'outline-scroll-editor', '1440,900'],
  // [CUSTOM-20260930-149] markdown 往返：走真机路径（boot → reset → append → revise），
  // 探针读 asked / hasMdClass / droppedNoSession —— 这三项一起看才能判定整条链路。
  ['#bootroundprobe', 'markdown-round', '1440,900'],
  ['#historyfilter', 'history-filter', '1440,900'],
  // [CUSTOM-20261001-155] 默认筛选（地址栏有目录 ⇒ 列表只出该目录）：截图看列表本身，
  // 探针（同 hash 带 probe）读 askedCwd / rows / chip —— 数字比肉眼可靠。
  ['#historydefaultprobe', 'history-default', '1440,900'],
  // [CUSTOM-20261009-212] 历史列表行的悬停动作：布局（默认隐藏 / 落在行内）+ 接线
  // （点击发出 archiveSession、回执后列表就地更新）。图里第一行是"悬停后"的摆法。
  ['#historyrowprobe', 'history-row-actions', '1440,900'],
  // [CUSTOM-20261001-158] 权限抽屉：记录一行 + 输入框上方的浮层（与表单抽屉同形）。
  // `both` 档把表单与权限**同时**摆出来 —— 两个抽屉上下堆叠，探针量 gapToElic / overlapsElic。
  ['#permdrawerprobe', 'perm-drawer', '1440,900'],
  // [CUSTOM-20261001-166] 置顶条：上面那条滚出上沿、视口里还摆着一条（新规则）。
  ['#stickyprobetop=260', 'sticky-prev', '1440,900'],
  // [CUSTOM-20261002-172] 卡堆的三种姿态（三条挨得近的提问，档位由脚本**量出来**的 offsetTop 定）：
  //   push = 旧卡的底边正压在下一条的顶边上（相接，只有一张卡）
  //   two  = 两张卡同时在（新卡钉在判定线上，旧卡只剩一条边）
  //   gone = 旧卡整条出界、不再渲染
  // 探针读 cards[] 的 top/bottom/contact + maxHeight（必须是 none）——
  // 169 删掉了左侧那个收缩按钮，原先的 sticky-shrunk 档随之作废。
  ['#stickystackpushprobe', 'sticky-stack-push', '1440,900'],
  ['#stickystacktwoprobe', 'sticky-stack-two', '1440,900'],
  ['#stickystackgoneprobe', 'sticky-stack-gone', '1440,900'],
  // [166] 窄档 + 引导条 + 真实点击：点卡片里的折叠三角，看它折叠了没有、跳转了没有。
  ['#stickynarrowstickyclickprobetop=260', 'sticky-click-narrow'],
  // [170] 点卡片跳转后，量与节点的重叠。
  ['#stickynarrowstickyjumpprobetop=260', 'sticky-jump-narrow'],
  ['#permdrawerbothprobe', 'perm-drawer-both', '1440,1000'],
  // [CUSTOM-20260930-143] 未连接时底栏应当整块消失。
  ['#phasedisconnected', 'phase-disconnected', '1440,900'],
  // [CUSTOM-20260930-151] 草稿页（点「+」的新会话页）的输入卡：模式/模型/努力度三个选择器
  // 与斜杠补全都必须出现（数据来自宿主回的 draftOptions 快照）。窄档走默认 500 看退化，
  // 宽档显式 1440 让限宽与选择器排布显形。
  ['#composerdraft', 'draft-narrow'],
  ['#composerdraftwide', 'draft-wide', '1440,1000'],
  // [CUSTOM-20260930-152] 表单抽屉：记录里的"待回答"条 + 抽屉本体（tab 分页 / 单选下拉 /
  // 多选 / 收起成一行）。窄档看侧边栏里的退化，宽档看 tab 与选项介绍的排布。
  ['#elic', 'elic-narrow'],
  ['#elicmenu', 'elic-wide', '1440,900'],
  ['#elicmulti', 'elic-multi', '1440,900'],
  ['#elicshrunk', 'elic-shrunk'],
  // [CUSTOM-20260930-153] 真机形状（照抄日志里那次请求）：选项带长描述、自拟框那题没有 _meta 标记。
  // [CUSTOM-20261003-176] 「贴底却看不全」的复现档（读的是几何与滚动状态，不是肉眼）。
  ['#elicbottomstuckprobe', 'bottom-stuck', '1440,1000'],
  ['#elicreal', 'elic-real', '1440,1000'],
  ['#elicrealpick', 'elic-real-pick', '1440,1000'],
  // 钉住大纲栏：抽屉与输入卡必须同一条中线（asideW/2 = 120px 的偏移就是用户看到的"没居中"）。
  // [CUSTOM-20261004-189] 表单里打字掉不掉焦点（真 Chromium 量，不推）。
  ['#elicfocusprobe', 'elic-focus', '1440,900'],
  ['#elicrealsidebar', 'elic-real-sidebar', '1440,1000'],
  // [CUSTOM-20261004-184] 正文里的本地文件链接：宿主 SafeMarkdown 的真实 HTML → 真 sanitize →
  // 真点击 → 桥的出口。探针读 anchorFound / dataPath / dataLine / inertSpans / sent ——
  // 五项一起看才算"整条链通了"；截图看它长成了能点的样子（而不是带删除线的灰字）。
  // ⚠️ 档位必须带 'probe'：探针块整体在 `indexOf('probe')` 那道门后面（879 行），
  // 不带的话 hydrate 与点击都不会发生，截出来是普通夹具图（差点当成"渲染没生效"）。
  ['#linkclickprobe', 'file-link', '1440,900'],
];
for (const [hash, name, size] of SHOTS) {
  const out = join(OUT_DIR, `${name}.png`);
  if (shoot(browser, htmlPath, out, hash, size)) { shots.push(out); console.log(`  [OK] ${out}`); }
}
rmSync(join(OUT_DIR, 'profile'), { recursive: true, force: true });
if (!KEEP) { rmSync(htmlPath, { force: true }); }
if (!shots.length) { process.exit(1); }
