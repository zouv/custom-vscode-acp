// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// ContentBlock → 可序列化视图模型。旧面板只读 `.text`，把 image / audio / resource_link /
// resource 全部静默丢弃；这里保留全部 5 种类型，交给 webview 分别渲染。
// [CUSTOM-END] CUSTOM-20260923-011
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { fileURLToPath } from 'node:url';

/** Serializable rendering of an ACP {@link ContentBlock}. */
export type ContentBlockView =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataUri: string; name: string }
  | { type: 'audio'; mimeType: string; name: string; byteLength: number }
  // [CUSTOM-20260925-039] `path` 存在 = 这是一个**本地文件**，客户端应当走文件通道
  // （`openFile`，由扩展侧按会话 cwd 解析相对路径）而不是 `openLink`。见 localPathOf。
  | { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string; path?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; byteLength?: number };

// [CUSTOM-20260925-039] `resource_link.uri` 是 agent 给的字符串，可能是 `file:///abs`、
// 裸绝对路径、相对路径，或 http(s)/mailto。**分类必须在宿主侧做完**，因为客户端只会照
// 属性干活：此前 chip 一律写 `data-href` → 点击落到 `openLink` → 被协议白名单
// （chat-panel.md §5.5）拦下（`file:` 不在白名单），于是点一个本地文件链接只会弹出
// 「Blocked link with unsupported scheme: file」而什么都不打开。
// 注意**顺序**：Windows 盘符（`C:\x`）符合 URI scheme 的语法，必须先于 scheme 判定。
const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** Local filesystem path for a file-ish URI, or undefined for anything else. */
function localPathOf(uri: string | null | undefined): string | undefined {
  const value = (uri ?? '').trim();
  if (!value) { return undefined; }
  if (WINDOWS_ABS.test(value) || value.startsWith('/') || value.startsWith('\\\\')) {
    return value;
  }
  const scheme = URI_SCHEME.exec(value)?.[1]?.toLowerCase();
  // No scheme at all: a relative path. The extension resolves it against the
  // session's working directory (ChatPanelHost.fileUri).
  if (scheme === undefined) { return value; }
  if (scheme === 'file') {
    // Handles percent-encoding and the Windows `file:///C:/x` form.
    try { return fileURLToPath(value); } catch { return undefined; }
  }
  return undefined;
}

/** Convert one ACP content block into its view model. */
export function toContentView(block: ContentBlock | null | undefined): ContentBlockView | null {
  if (!block) { return null; }
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      return {
        type: 'image',
        mimeType: block.mimeType,
        // Data URI so the webview can render it with `img-src ... data:` in the
        // CSP, without any network access.
        dataUri: `data:${block.mimeType};base64,${block.data}`,
        name: block.uri ? basename(block.uri) : 'image',
      };

    case 'audio':
      return {
        type: 'audio',
        mimeType: block.mimeType,
        name: 'audio',
        byteLength: Math.floor((block.data?.length ?? 0) * 0.75),
      };

    case 'resource_link':
      return {
        type: 'resource_link',
        uri: block.uri,
        name: block.name,
        title: block.title ?? undefined,
        description: block.description ?? undefined,
        mimeType: block.mimeType ?? undefined,
        // [CUSTOM-20260925-039] Pre-decide which channel a click must take.
        path: localPathOf(block.uri),
      };

    case 'resource': {
      const resource = block.resource as { uri?: string; mimeType?: string | null; text?: string; blob?: string };
      const hasText = typeof resource.text === 'string';
      return {
        type: 'resource',
        uri: resource.uri ?? '',
        mimeType: resource.mimeType ?? undefined,
        text: hasText ? resource.text : undefined,
        byteLength: hasText ? undefined : Math.floor((resource.blob?.length ?? 0) * 0.75),
      };
    }

    default:
      return null;
  }
}

// [CUSTOM-20260925-052] A `toContentViews()` batch helper was removed here: it
// had no callers. Callers convert one block at a time and decide individually
// whether the result is worth rendering (see hasVisibleContent).

// [CUSTOM-BEGIN] CUSTOM-20260924-026 - 「这一块到底有没有东西可看」。
// 起因：agent 会发**空文本块**当分片分隔符，而 toContentView 对它是合法的
// {type:'text', text:''}，于是被当成内容写成 content 记录，渲染成一条无边框的空白条
// （.tool-text 的 margin 撑出来的）——截图里成串的细白条就是它。
// 判据排掉两类"看不见的文本"：① trim() 能去掉的空白；② 零宽字符（U+200B..U+200D /
// U+2060 / U+FEFF）——它们**不在** trim 的范围内，所以必须单独按码点列出。
// 这里刻意**不用字符类正则**：往源码里贴不可见字符会让这个文件从"能读懂"变成
// "看不出改了什么"，而写 \\uXXXX 转义又会在工具链的转义层里被还原成真字符
// （两条都实际踩过，见 pitfalls #12）。
// [CUSTOM-END] CUSTOM-20260924-026
// [CUSTOM-20260925-055] ⚠️ 这个函数的**返回值曾经是反的**（026 → 055），而它的名字、
// 它的文档注释、以及客户端的同名副本**三者都是对的** —— 只有这里的函数体把
// `return true` / `return false` 写反了。
//
// 后果（不是"轻微"）：调用点的语义是「看不见就不建记录」
// （`if (!merges && isBlankText(text)) return null;`），而反过来的判据变成
// **「看得见就不建记录」** —— 每一个*新开一条记录*的正文分片都被丢掉，空白分片反而被保留。
//
// **为什么它藏了整整一天（026 → 055）而所有自动检查都是绿的**：
// 实时流里 agent 会先发一个换行 / 空白分片当分隔符，而按反了的判据它"不是空白"⇒ 记录被建出来，
// 之后的真切正文走的是**合并**分支（`merges === true` 时那个守卫被整段跳过）⇒ 正文正常追加。
// 于是**实时路径靠巧合是对的**。而 `session/load` 的 replay 是**单块真切正文、前面没有空白** ⇒
// 记录直接被丢 —— 表现就是"重开会话后助手正文与推理块全部消失，而用户消息和工具记录还在"。
//
// 判据无法靠类型/ lint / webpack / 客户端脚本校验发现：名字与实现相反时，
// 读代码的人会相信名字。（同族问题见 pitfalls #19：同一份知识存了两份。）
// 因此 `src/test/chat-panel.test.ts` 现在用真实 replay 夹具钉住这条路径的行为。
const BLANK_CODES = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** True when this text would render as nothing (whitespace or zero-width only). */
export function isBlankText(text: string | null | undefined): boolean {
  if (!text) { return true; }
  for (const ch of text) {
    // Zero-width characters are not matched by trim(), so they are listed by
    // code point instead of being written into the source as literals.
    if (BLANK_CODES.has(ch.codePointAt(0) ?? 0)) { continue; }
    if (ch.trim().length === 0) { continue; }
    // Something the reader can see: by definition not blank.
    return false;
  }
  // Nothing visible in the whole string.
  return true;
}

/** True when a view model would render as visible content. */
export function hasVisibleContent(view: ContentBlockView | null | undefined): boolean {
  if (!view) { return false; }
  if (view.type === 'text') { return !isBlankText(view.text); }
  if (view.type === 'resource') { return !isBlankText(view.text) || !!view.uri || (view.byteLength ?? 0) > 0; }
  return true;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
