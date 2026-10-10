// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// SafeMarkdown：零新依赖的「安全由构造保证」markdown 渲染。
//
// 背景（已实测确认）：marked v15 默认 renderer 的 `html()` 原样返回原始 HTML，`link()` 只做
// cleanUrl（encodeURI 包装）而不做协议白名单——`[x](javascript:alert(1))` 会直通成
// `<a href="javascript:alert(1)">`。旧面板当前靠 CSP（script-src 带 nonce 且无 'unsafe-inline'）
// 兜住脚本执行，但 style-src 仍开 'unsafe-inline'，残留 UI 伪装风险。这里从渲染层根治。
//
// 三条硬性约束：
//   1. 必须用 `new Marked(...)` 而非 `marked.setOptions(...)`——旧面板
//      （ChatWebviewProvider.ts:29）改的是全局单例，共用会互相污染。
//   2. `html` / `link` / `image` 三个 renderer 必须覆盖；其余交给默认实现（已正确转义）。
//   3. webview 侧还有一层 DOMParser 白名单兜底（见 html/client/dom.ts）——即便将来
//      marked 新增了没人覆盖的钩子也能兜住。
// [CUSTOM-END] CUSTOM-20260923-011
import { Marked, type RendererObject, type Tokens } from 'marked';
// [CUSTOM-20261004-184] The one place that decides "is this href a local file".
import { localPathOf } from './content/contentBlocks';
// [CUSTOM-20261009-216] 也借用它的视图模型（mention 解析的产物与 ContentBlock 转出来的同形）。
import type { ContentBlockView } from './content/contentBlocks';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a string for safe interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

/** Link protocols we are willing to hand to `vscode.env.openExternal`. */
const SAFE_LINK_SCHEME = /^(https?:|mailto:)/i;

/** Keep code-block language classes to a boring character set. */
const UNSAFE_LANG_CHARS = /[^a-z0-9_+#.-]/gi;

// [CUSTOM-BEGIN] CUSTOM-20261004-184 - 让「本地文件链接」能点开。
//
// 现象：agent 写的 `[GOAL.md:74](GOAL.md:74)` / `[a.ts](./src/a.ts#L12)` 这类**本地路径链接**
// 一律落进下面的"协议白名单之外"分支，被渲染成一行带删除线的灰字（hover 显示
// "Blocked link scheme"）——用户点它没有任何反应，而它看上去像是能点的。
//
// 根因：`link()` 只认 http/https/mailto，把「没有 scheme 的相对路径」当成了「不认识的协议」
// （`file:` 同样被挡）。而宿主**早就有**这条通道：内容块 chip 用 `data-path` → links.ts 的
// 点击委托 → `openFile`（按会话 cwd 解析相对路径 + 跳行号，见 ChatPanelHost.handleOpenFile）。
// 这里只是把 markdown 链接接到**同一条**路上，判定复用 contentBlocks 的 localPathOf。
//
// 行号语法按 agent 实际写法剥掉：`path:12` / `path:12:5` / `path#L12` / `path#L12-L20`。
// 剥离必须**先于** localPathOf——`GOAL.md:74` 里 `GOAL.md` 本身符合 URI scheme 的语法
// （`.` 是合法 scheme 字符），不剥就会被当成 scheme `goal.md` 而判成"非本地路径"。
// [CUSTOM-END] CUSTOM-20261004-184
const LINE_SUFFIX = /^(.*?):(\d+)(?::\d+)?$/;
const FRAGMENT_LINE = /^L?(\d+)(?:-L?\d+)?$/i;

/**
 * [CUSTOM-20261004-184] Split `path[:line]` / `path#Lline` into a local path plus
 * an optional line, or undefined when the href is not a local file reference.
 */
export function fileLinkTarget(href: string): { path: string; line?: number } | undefined {
  const value = String(href ?? '').trim();
  if (!value) { return undefined; }

  let rest = value;
  let line: number | undefined;

  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const fragment = FRAGMENT_LINE.exec(rest.slice(hash + 1));
    // A fragment we do not understand (`#section`) is not a file target: opening
    // the file at line 1 would be worse than leaving the link inert.
    if (!fragment) { return undefined; }
    line = Number(fragment[1]);
    rest = rest.slice(0, hash);
  }

  const trailing = LINE_SUFFIX.exec(rest);
  if (trailing) {
    rest = trailing[1];
    if (line === undefined) { line = Number(trailing[2]); }
  }

  const path = localPathOf(rest);
  if (!path) { return undefined; }
  return { path, line };
}

// [CUSTOM-BEGIN] CUSTOM-20261009-216 - 回放里的「文件引用」不是内容块，是一段文本。
//
// 现象（用户报）：引用了文件的消息发送时气泡里有 chip，**会话 reload 后**变成原样显示的一串
// `[@GrapplingHookPointComponent.cs](file:///f%3A/P4/…#L437-440)`。
//
// 根因：面板把引用按 ACP `resource_link` 块发出去，而 Claude Code 把它**序列化成一段文本**存进
// 自己的转录（`[{text: 正文}, {text: '[@名](file:///…)'}]`），`session/load` 回放时又把这两块各发
// 一条 `user_message_chunk`（共用同一个 messageId，实测见 acp-client-custom.log）。宿主原先只认
// **块**，于是那段文本被当正文又建一条用户气泡 —— 而用户气泡正文是**纯文本节点**（不跑 markdown，
// 见 transcriptView.buildUserBubble），所以 markdown 原样露出来。
//
// 这里只做一件事：认出「整段就是若干条本地文件引用」，产出与 `toContentView` 同形的
// `resource_link` 视图，好让回放分支把它和图片一样**并进同一个气泡**。判据刻意窄，两条都要满足：
//   ①整段（trim 后）的每一段都是这种链接（用户随手在正文里写一个 `[@a](b.ts)` 不会中招）；
//   ②标签以 `@` 开头 —— 那是这个约定的形态，抓到的数据里没有例外。
// 行区间语法直接复用上面的 `fileLinkTarget`（184 已经把 `#L12-L20` / `path:12` 收在一处，不写第二份）。
// [CUSTOM-END] CUSTOM-20261009-216
const MENTION_LINK = /^\[@([^\]\n]*)\]\(([^()\s]+)\)$/;
/** 标签尾部的行区间（`Foo.cs#L437-440` / `Foo.cs#L437`），归一成 live chip 的 `:437-440`。 */
const MENTION_RANGE = /#L(\d+)(?:-L?(\d+))?$/;

/**
 * [CUSTOM-20261009-216] Views for a message that is nothing but file references
 * (Claude Code's serialisation of `resource_link` blocks), or null when the text
 * is ordinary prose that merely happens to contain a link.
 */
export function fileMentionViews(text: string): ContentBlockView[] | null {
  const value = String(text ?? '').trim();
  // 便宜的守卫：这类文本的第一段必然是链接（`^\[@`），长度不限 —— 于是普通正文
  // （每一段都要 split + 跑正则）在第一步就出去了。
  if (!value.startsWith('[@')) { return null; }
  const segments = value.split(/\s+/).filter(Boolean);
  if (segments.length === 0) { return null; }
  const views: ContentBlockView[] = [];
  for (const segment of segments) {
    const match = MENTION_LINK.exec(segment);
    if (!match) { return null; }
    const uri = match[2];
    const target = fileLinkTarget(uri);
    if (!target) { return null; }
    views.push({ type: 'resource_link', uri, name: mentionName(match[1]), path: target.path });
  }
  return views;
}

/**
 * The chip's label. The agent writes `Name.cs#L437-440`; the live path shows
 * `Name.cs:437-440` (`composer.ts` `refLabel`). Same file, same range, two spellings
 * — normalised so a reopened conversation looks like the one that was just sent.
 */
function mentionName(label: string): string {
  const range = MENTION_RANGE.exec(label);
  if (!range) { return label; }
  const end = range[2];
  return `${label.slice(0, range.index)}:${range[1]}${end && end !== range[1] ? `-${end}` : ''}`;
}

const renderer: RendererObject = {
  // Raw HTML is rendered as literal text: lossless (the reader still sees what
  // the agent wrote) and, once escaped, inert.
  html({ text }: Tokens.HTML | Tokens.Tag) {
    return escapeHtml(text);
  },

  code({ text, lang }: Tokens.Code) {
    const language = String(lang ?? '').replace(UNSAFE_LANG_CHARS, '').slice(0, 24);
    const attr = language ? ` data-lang="${escapeHtml(language)}"` : '';
    const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
    return `<pre${attr}><code${cls}>${escapeHtml(text)}</code></pre>\n`;
  },

  codespan({ text }: Tokens.Codespan) {
    return `<code>${escapeHtml(text)}</code>`;
  },

  // [CUSTOM-20260926-072] GFM task-list marker.
  //
  // marked's default emits `<input type="checkbox" disabled>`; the webview
  // allowlist (html/client/dom.ts) has no INPUT, so the sanitizer UNWRAPPED it —
  // "- [x] shipped" rendered with no mark at all, and done/not-done became visually
  // identical. Rendering the state as a glyph fixes it without widening the
  // allowlist to form controls (an input in agent-authored HTML is exactly the kind
  // of thing that allowlist exists to keep out).
  //
  // Overriding `checkbox` rather than `listitem` is deliberate: the default
  // listitem already knows how to splice the marker in for both tight and loose
  // lists, and reproducing that placement by hand is how the two drift apart.
  checkbox({ checked }: Tokens.Checkbox) {
    return `<span class="task-box">${checked ? '☑' : '☐'}</span>`;
  },

  link(this: { parser: { parseInline(tokens: unknown): string } }, { href, title, tokens }: Tokens.Link) {
    const label = this.parser.parseInline(tokens);
    const raw = String(href ?? '');
    if (SAFE_LINK_SCHEME.test(raw)) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      // No real href: navigation is handled by a delegated click handler that
      // round-trips through the extension for allowlisting + openExternal.
      return `<a href="#" data-href="${escapeHtml(raw)}"${titleAttr}>${label}</a>`;
    }
    // [CUSTOM-20261004-184] A local file reference: same round-trip, but down the
    // `openFile` channel (session cwd resolves relative paths, `data-line` jumps).
    // The client's delegated handler already reads exactly these two attributes —
    // this branch only had to start emitting them.
    const file = fileLinkTarget(raw);
    if (file) {
      const lineAttr = file.line && file.line > 0 ? ` data-line="${file.line}"` : '';
      const titleAttr = ` title="${escapeHtml(title || file.path)}"`;
      return `<a href="#" data-path="${escapeHtml(file.path)}"${lineAttr}${titleAttr}>${label}</a>`;
    }
    // Downgrade to plain text rather than emitting a dangerous href.
    // `command:` in particular would turn agent output into IDE command
    // execution, and `javascript:`/`data:` are outright script vectors.
    return `<span class="link-blocked" title="Blocked link scheme">${label}</span>`;
  },

  image({ href, text }: Tokens.Image) {
    // Remote images are not loadable under our CSP and data: images would be a
    // vector; render a chip instead of an <img>.
    return `<span class="img-chip" title="${escapeHtml(href)}">${escapeHtml(text || href || 'image')}</span>`;
  },
};

/**
 * A private, sanitizing markdown renderer.
 *
 * One instance per consumer — never the `marked` module singleton.
 */
export class SafeMarkdown {
  private readonly md: Marked;

  constructor() {
    this.md = new Marked({ gfm: true, breaks: true, async: false });
    this.md.use({ renderer });
  }

  /** Render markdown to HTML. Falls back to escaped plain text on failure. */
  render(text: string): string {
    try {
      return this.md.parse(text, { async: false }) as string;
    } catch {
      return `<pre>${escapeHtml(text)}</pre>`;
    }
  }
}
