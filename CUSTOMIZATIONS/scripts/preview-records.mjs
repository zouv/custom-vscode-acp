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
//     生成 <dir>/records.html，并对 #expanded / #collapsed 各截一张图。
//     默认 <dir> = 系统临时目录/acpc-preview，默认截图后删除 HTML（--keep 保留）。
//     需要本机有 Chrome 或 Edge（Windows 上 Edge 一定有）。没有浏览器时**跳过**并 exit 0。
//   node CUSTOMIZATIONS/scripts/preview-records.mjs --print  # 只打印 HTML 路径，不截图
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
  // HYDRATE, not append: a real panel always arrives as a snapshot (boot/focus), and
  // hydrating is what gives the client its session id — the very thing the host
  // validates on every renderMarkdown item (see the reply below).
  var SESSION = 'preview-session';
  try { NS.transcriptView.hydrate({ sessionId: SESSION, entries: fixtures }); }
  catch (err) { failed++; console.warn('hydrate failed:', err); }
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
  return [title, `<style>${THEME}</style>`, `<style>${style}</style>`, markup,
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

function shoot(browser, htmlPath, outPath, hash) {
  const profile = join(OUT_DIR, 'profile');
  const res = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=2000',
    '--window-size=430,1500',
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
for (const [hash, name] of [['#expanded', 'expanded'], ['#collapsed', 'collapsed'], ['#tools', 'tools']]) {
  const out = join(OUT_DIR, `${name}.png`);
  if (shoot(browser, htmlPath, out, hash)) { shots.push(out); console.log(`  [OK] ${out}`); }
}
rmSync(join(OUT_DIR, 'profile'), { recursive: true, force: true });
if (!KEEP) { rmSync(htmlPath, { force: true }); }
if (!shots.length) { process.exit(1); }
