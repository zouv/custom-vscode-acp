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
    if (!SAFE_LINK_SCHEME.test(raw)) {
      // Downgrade to plain text rather than emitting a dangerous href.
      // `command:` in particular would turn agent output into IDE command
      // execution, and `javascript:`/`data:` are outright script vectors.
      return `<span class="link-blocked" title="Blocked link scheme">${label}</span>`;
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    // No real href: navigation is handled by a delegated click handler that
    // round-trips through the extension for allowlisting + openExternal.
    return `<a href="#" data-href="${escapeHtml(raw)}"${titleAttr}>${label}</a>`;
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
