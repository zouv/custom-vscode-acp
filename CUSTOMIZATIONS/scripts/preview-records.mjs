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
  const start = src.indexOf("function driver()");
  const bt = src.indexOf("`", start);
  const end = src.indexOf("`;", bt + 1);
  const body = src.slice(bt + 1, end);
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
  var CARD_MODE = hash.indexOf('empty') >= 0 || hash.indexOf('connecting') >= 0 || hash.indexOf('ready') >= 0;
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
    } else if (hash.indexOf('ready') >= 0) {
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
  // [CUSTOM-20260930-143] 未连接（disconnected / connecting）时底栏应当**整块消失** —— 那时
  // 输入框本来就用不了，露着一个"看得见却打不了字"的框只会让人以为它坏了。相位是 stateCard
  // 写在 body[data-phase] 上的，这里直接设属性来摆出那个状态。
  if (location.hash.indexOf('phasedisconnected') >= 0) {
    if (document.body) { document.body.setAttribute('data-phase', 'disconnected'); }
  }
  // [CUSTOM-20260930-140/144] 真悬浮的验收档：滚到最底，看最后一条记录有没有被输入卡压住
  // （贴底时 #messages 会拿到 .pin-bottom，把输入卡的高度让出来）。
  if (location.hash.indexOf('composerbottom') >= 0) {
    messages.scrollTop = messages.scrollHeight;
    // scroll 事件是**异步派发**的，而探针在同一个同步块里读数 —— 手动派发一次，让 scroll.ts
    // 的 onScroll（pinned 判定与 pin-bottom 类）先跑完。
    messages.dispatchEvent(new Event('scroll'));
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
  return [title, `<style>${THEME}</style>`, `<style>${style}</style>`, markup,
    vscodeStub, earlyErrors,
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
  ['#composerbottom', 'composer-wide-bottom', '1440,1000'],
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
  // [CUSTOM-20260930-143] 未连接时底栏应当整块消失。
  ['#phasedisconnected', 'phase-disconnected', '1440,900'],
];
for (const [hash, name, size] of SHOTS) {
  const out = join(OUT_DIR, `${name}.png`);
  if (shoot(browser, htmlPath, out, hash, size)) { shots.push(out); console.log(`  [OK] ${out}`); }
}
rmSync(join(OUT_DIR, 'profile'), { recursive: true, force: true });
if (!KEEP) { rmSync(htmlPath, { force: true }); }
if (!shots.length) { process.exit(1); }
