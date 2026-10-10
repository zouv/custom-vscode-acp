// [CUSTOM-BEGIN] CUSTOM-20260927-094 - 从 agent 自己的会话目录补全历史列表（Claude Code 专用）。
//
// **为什么需要**：agent 的 `session/list` **不是全集**。实测（`CUSTOMIZATIONS/scripts/probe-session-list.mjs`
// 的"磁盘 ↔ agent"对账）：本项目磁盘上 8 个会话、agent 只报了 6 个，少掉的两条**从头到尾不在回复里**
// （其中一条正是当时**正在运行**的那个会话）。而 Claude Code 官方插件看到的正是全部 8 条——因为它
// **直接读那个目录**。于是"ACP 面板比官方少几条"的观感，根源在这里。
//
// **代价与边界（必须如实说清）**：
//   · 这是**厂商私有格式**：Claude Code 把每个工作目录的会话放在
//     `<config>/projects/<路径里所有非字母数字字符换成 '-' 的 slug>/<sessionId>.jsonl`。
//     格式变了这里就会读不到——所以**任何一步失败都只当作"没有补充"，绝不影响 agent 的那份列表**。
//   · 只读、只读**每个文件的前若干行**（转录文件能长到几十 MB，且**第一行本身就可能很大**，
//     所以按行流式读、超长行跳过，而不是按字符切一刀）。
//   · 只扫**当前工作目录**对应的那一个 slug（与本地缓存的作用域一致）。
//   · 只对 `Claude Code` 这个 agent 生效——别的 agent 没有这个目录。
// [CUSTOM-END] CUSTOM-20260927-094
import { existsSync } from 'node:fs';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { toContentView, isBlankText } from './content/contentBlocks';
import type { ContentBlockView } from './content/contentBlocks';
// [CUSTOM-20261009-216] 同一段文本形状的判定（回放里引用是一段文本而不是块）。
import { fileMentionViews } from './markdown';

/**
 * The agent whose transcripts these are. A SEPARATE constant from
 * `panelContract.MODERN_AGENTS` on purpose: that one decides which panel to render, this
 * one decides whose private storage we are willing to read — they happen to hold the same
 * name today, and neither should inherit the other's changes (pitfalls #19).
 */
export const CLAUDE_CODE_AGENT = 'Claude Code';

/** One row recovered from the transcript files. */
export interface DiskSessionRow {
  sessionId: string;
  cwd?: string;
  title?: string;
  /** File mtime, ISO — the transcript is appended to as the session runs. */
  updatedAt?: string;
}

/** How many lines of a transcript are inspected before giving up. */
const MAX_LINES = 200;
/** A single line larger than this is skipped (a pasted image or a huge tool result). */
const MAX_LINE_CHARS = 4_000_000;
/** [CUSTOM-20260928-100] Upper bound for the full-file timeline scan (see readTranscriptTimes). */
const MAX_TIMELINE_LINES = 200_000;

/** The directory Claude Code keeps this working directory's transcripts in. */
export function claudeTranscriptDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CLAUDE_CONFIG_DIR
    || join(env.USERPROFILE || env.HOME || '', '.claude');
  return join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** The first visible user prompt of a transcript record, or undefined. */
function titleOf(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'user') { return undefined; }
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content)
      ? (content.find(b => (b as { type?: string })?.type === 'text') as { text?: unknown } | undefined)?.text
      : undefined);
  if (typeof text !== 'string') { return undefined; }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  // Local command output is not a title anybody wants to see.
  return trimmed.length > 0 && !trimmed.startsWith('<local-command') ? trimmed.slice(0, 80) : undefined;
}

/**
 * [CUSTOM-20260928-095] The summary title the agent generated (`ai-title` record).
 * Preferred over the first prompt: it is exactly what Claude Code's own panel shows,
 * whereas the first prompt can be a `/model` command or a verbose paragraph.
 */
function aiTitleOf(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'ai-title') { return undefined; }
  const title = (record as { aiTitle?: unknown }).aiTitle;
  if (typeof title !== 'string') { return undefined; }
  const trimmed = title.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : undefined;
}

/**
 * Every session the transcripts in `dir` know about.
 *
 * Never throws: a missing directory, an unreadable file or a malformed line all degrade to
 * "fewer rows" — this is a supplement, and it must not be able to break the list that the
 * agent reported.
 *
 * `fallbackCwd` is the directory we looked up by, which IS the bucket's meaning — used when
 * a transcript's own records carry no `cwd` yet (a session that is being written right now
 * has not recorded its head yet: measured on the live session of this very project).
 */
export async function readDiskSessions(dir: string, fallbackCwd?: string): Promise<DiskSessionRow[]> {
  if (!existsSync(dir)) { return []; }
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }

  const rows: DiskSessionRow[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) { continue; }
    const file = join(dir, name);
    const row: DiskSessionRow = { sessionId: name.slice(0, -'.jsonl'.length) };
    try { row.updatedAt = new Date(statSync(file).mtimeMs).toISOString(); } catch { /* keep going */ }
    rows.push(row);

    // Stop once the summary title and cwd are both known; the rest of the file can be
    // megabytes. The summary sits a few records after the first prompt, so the loop keeps
    // reading past the prompt rather than locking in the verbose one.
    let lines = 0;
    let firstPrompt: string | undefined;
    const input = createReadStream(file, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (++lines > MAX_LINES || (row.cwd && row.title)) { break; }
        if (line.length > MAX_LINE_CHARS) { continue; }
        let record: Record<string, unknown>;
        try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!record || typeof record !== 'object') { continue; }
        if (!row.cwd && typeof record.cwd === 'string') { row.cwd = record.cwd; }
        // [CUSTOM-20260928-095] Prefer the agent's summary; the first prompt is the fallback.
        row.title = row.title ?? aiTitleOf(record);
        firstPrompt = firstPrompt ?? titleOf(record);
      }
    } catch { /* unreadable transcript: the row still carries id + mtime */ } finally {
      reader.close();
      input.destroy();
    }
    if (!row.title) { row.title = firstPrompt; }
    if (!row.cwd && fallbackCwd) { row.cwd = fallbackCwd; }
  }
  return rows;
}

// [CUSTOM-BEGIN] CUSTOM-20260928-100 - replay 记录的真实时刻。
//
// **为什么需要**：ACP 的 `session/update` **没有任何时间字段**（核对过 SDK 的
// `SessionNotification`：只有 `_meta` / `sessionId` / `update`），所以宿主给 replay 出来的
// 每条记录都打 `Date.now()` —— 于是一个几十条对话的历史会话，右侧大纲里的时间**全部挤在
// 同一秒**（用户报：「时间也不准，都几乎显示在同一秒，实际间隔了几十分钟」）。
//
// **转录文件知道真实时间**：它每条记录都有 `timestamp`，而 replay 分片携带的
// `messageId` **恰好**是转录里的标识（对着一次真实抓包核对过：
//   · `user_message_chunk.messageId`  == user 记录的 `uuid`
//   · `agent_{message,thought}_chunk.messageId` == assistant 记录的 `message.id`）。
// 于是可以建一张 `messageId → 最早 timestamp` 表，replay 时逐条查。
//
// **边界与代价**：与 094 同源（厂商私有格式、只对 Claude Code、任何失败都只是"没有时间"
// 而回退到 `Date.now()`）。它会**读整个转录文件**（不是前 200 行）—— 对话的时间线分布在全篇，
// 截断就只能拿到开头的几条。超过 `MAX_LINES` 就放弃，宁可没有时间也不拖垮打开会话。
// [CUSTOM-END] CUSTOM-20260928-100

/**
 * `messageId` → real epoch ms for every message the transcript knows about.
 *
 * Never throws: a missing file, an unreadable line or a lost race all degrade to
 * "no times" and the caller keeps its own clock.
 */
export async function readTranscriptTimes(dir: string, sessionId: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const file = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) { return times; }

  let lines = 0;
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (++lines > MAX_TIMELINE_LINES) { break; }
      if (line.length > MAX_LINE_CHARS) { continue; }
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!record || typeof record !== 'object') { continue; }
      const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(stamp)) { continue; }
      const message = record.message as { id?: unknown } | undefined;
      const id = record.type === 'user'
        ? record.uuid
        : (message && typeof message.id === 'string' ? message.id : undefined);
      if (typeof id !== 'string' || id.length === 0) { continue; }
      // Earliest wins: one assistant message id spans several records (thinking,
      // text, tool use), and the message *started* at the first of them.
      const seen = times.get(id);
      if (seen === undefined || stamp < seen) { times.set(id, stamp); }
    }
  } catch { /* unreadable transcript: no times, the caller falls back */ } finally {
    reader.close();
    input.destroy();
  }
  return times;
}

// [CUSTOM-BEGIN] CUSTOM-20261009-216 - 一条用户消息带的附件，以及"它有没有正文"。
//
// 为什么要有 `hasProse`（**不是**可有可无的补充字段）：回放时一条消息的正文、图片、文件引用
// 是**各一条 chunk**（100/111 的教训），而"引用已经并进气泡了"这件事**不能**用"转录里知道这条
// messageId"来判断 —— 用户完全可以**只引用文件、不打字**（215 的发送路径支持：空文字 + 附件落成
// `content` 条目）。那种消息回放时**只有**那条引用 chunk，若按"知道 messageId 就丢弃"处理，
// 它会连记录一起消失（比现在显示成原文更糟）。真正的判据是**这条记录有没有正文**：
// 有正文 ⇒ 附件由正文那条 chunk 承载；没有 ⇒ 附件 chunk 自己渲染。
//
// 顺带把 111 留下的同类洞一起修了（同一个判据）：只有图片、没有正文的消息，图片 chunk 原先也
// 被无条件丢弃 ⇒ 重开后什么都不剩。
//
// 【为什么一个函数收两遍】这个文件 5–13MB、上限 20 万行，open 会话时原先被扫三遍
// （times / images / 本函数）。图片与附件本来就是同一条记录的同一批块，一次扫描收齐更实在。
//
// 边界与代价与 094/100/111 完全同源：厂商私有格式、只对 Claude Code、任何失败都只是
// "没有附件"而绝不抛错（转录读不到时回放分支退化为把附件 chunk 自己渲染出来）。
// [CUSTOM-END] CUSTOM-20261009-216
export interface TranscriptUserParts {
  /** 图片附件视图（111 的既有形状）。 */
  images: ContentBlockView[];
  /** 文件引用视图 —— mention 文本块与真正的 `resource_link` 块都在这里。 */
  files: ContentBlockView[];
  /** 这条消息除引用之外还有可见正文 ⇒ 回放会另发一条正文 chunk 承载这些附件。 */
  hasProse: boolean;
}

/**
 * `messageId` → the images and file references of every user record in the transcript,
 * plus whether the record has prose of its own.
 *
 * Never throws: a missing file, an unreadable line or a lost race all degrade to
 * "no attachments" and the caller renders the message without them.
 */
export async function readTranscriptUserAttachments(
  dir: string,
  sessionId: string,
): Promise<Map<string, TranscriptUserParts>> {
  const parts = new Map<string, TranscriptUserParts>();
  const file = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) { return parts; }

  let lines = 0;
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (++lines > MAX_TIMELINE_LINES) { break; }
      if (line.length > MAX_LINE_CHARS) { continue; }
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!record || record.type !== 'user') { continue; }
      const uuid = typeof record.uuid === 'string' ? record.uuid : undefined;
      if (!uuid) { continue; }
      const message = record.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) { continue; }

      const images: ContentBlockView[] = [];
      const files: ContentBlockView[] = [];
      let hasProse = false;
      for (const block of content) {
        const b = block as {
          type?: string;
          text?: unknown;
          source?: { type?: string; media_type?: unknown; data?: unknown };
          name?: unknown;
        };
        if (b?.type === 'image') {
          // Claude Code 的转录格式：{ type:'image', source:{ type:'base64', media_type, data } }
          const src = b.source;
          const data = src?.data;
          const mimeType = src?.media_type;
          if (src?.type !== 'base64' || typeof data !== 'string' || typeof mimeType !== 'string') { continue; }
          images.push({
            type: 'image',
            mimeType,
            dataUri: `data:${mimeType};base64,${data}`,
            name: typeof b.name === 'string' && b.name ? b.name : 'image',
          });
          continue;
        }
        // 真正的内容块形状（未来 Claude Code 直接存 `resource_link` 时不必再来改这里）。
        if (b?.type === 'resource_link') {
          const view = toContentView(block as ContentBlock);
          if (view && view.type === 'resource_link') { files.push(view); }
          continue;
        }
        if (b?.type === 'text') {
          const text = typeof b.text === 'string' ? b.text : '';
          // 这条文本块本身就是一串文件引用（`[@名](file:///…)`，见 markdown.fileMentionViews）。
          const mentions = fileMentionViews(text);
          if (mentions) { files.push(...mentions); continue; }
          if (!isBlankText(text)) { hasProse = true; }
        }
      }
      parts.set(uuid, { images, files, hasProse });
    }
  } catch { /* unreadable transcript: no attachments, the caller renders without them */ } finally {
    reader.close();
    input.destroy();
  }
  return parts;
}
