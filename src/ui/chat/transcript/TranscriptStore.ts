// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 扩展侧的每会话记录存储。这是「切标签瞬时完成」的关键：transcript 不在 webview 里，
// 而在扩展宿主中，切走再切回只需推一次快照，不需要重新 session/load。
// [CUSTOM-END] CUSTOM-20260923-011
// [CUSTOM-BEGIN] CUSTOM-20260924-026
import { isBlankText } from '../content/contentBlocks';
// [CUSTOM-END] CUSTOM-20260924-026
import type {
  AssistantEntry,
  ContentEntry,
  EntryPatch,
  NoticeEntry,
  PermissionEntry,
  PermissionState,
  PlanEntryRecord,
  ThoughtEntry,
  ToolEntry,
  TranscriptEntry,
  TranscriptSnapshot,
  UserEntry,
} from './types';

const MAX_ENTRIES_PER_SESSION = 500;
const MAX_SESSIONS = 24;
const MAX_TEXT_PER_ENTRY = 64 * 1024;

interface SessionTranscript {
  sessionId: string;
  agentName: string;
  entries: TranscriptEntry[];
  /** Monotonic counter for entry-id generation. */
  seq: number;
  /** LRU stamp. */
  touched: number;
}

function clampText(text: string): string {
  if (text.length <= MAX_TEXT_PER_ENTRY) { return text; }
  return `${text.slice(0, MAX_TEXT_PER_ENTRY)}\n\n…[truncated ${text.length - MAX_TEXT_PER_ENTRY} chars]`;
}

/**
 * Per-session transcripts held in the extension host.
 *
 * Capacity is bounded three ways: entries per session, sessions overall (LRU),
 * and characters per entry. Live sessions are exempt from LRU eviction —
 * a dropped transcript on a running session would look like data loss.
 */
export class TranscriptStore {
  private sessions: Map<string, SessionTranscript> = new Map();
  private entrySeq = 0;
  private clock = 0;
  /** Session ids exempt from LRU eviction (their process is running). */
  private liveSessionIds: Set<string> = new Set();

  /** Replace the live-session exemption set. Called by ChatPanelHost. */
  setLiveSessionIds(ids: Iterable<string>): void {
    this.liveSessionIds = new Set(ids);
  }

  /** Create a transcript bucket if absent. Idempotent. */
  ensureSession(sessionId: string, agentName: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.touched = ++this.clock;
      return;
    }
    this.sessions.set(sessionId, {
      sessionId,
      agentName,
      entries: [],
      seq: 0,
      touched: ++this.clock,
    });
    this.evictIfNeeded();
  }

  /** Drop a session's transcript (session closed / agent disconnected). */
  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.liveSessionIds.delete(sessionId);
  }

  /** Drop every transcript belonging to an agent. */
  dropAgent(agentName: string): void {
    for (const [sessionId, t] of Array.from(this.sessions)) {
      if (t.agentName === agentName) {
        this.sessions.delete(sessionId);
        this.liveSessionIds.delete(sessionId);
      }
    }
  }

  /** Snapshot for the webview (a deep-enough copy: entries are replaced, not mutated). */
  snapshot(sessionId: string): TranscriptSnapshot | null {
    const t = this.sessions.get(sessionId);
    if (!t) { return null; }
    t.touched = ++this.clock;
    return {
      sessionId: t.sessionId,
      agentName: t.agentName,
      entries: t.entries.map(e => ({ ...e })),
    };
  }

  /** True when any session of this agent holds content (confirm dialogs). */
  hasContent(agentName: string | null): boolean {
    if (!agentName) { return false; }
    for (const t of this.sessions.values()) {
      if (t.agentName === agentName && t.entries.length > 0) { return true; }
    }
    return false;
  }

  // [CUSTOM-20260925-052] `sessionHasContent`, `listSessionIds` and `size` were
  // removed here — all three had no callers. The live-session bookkeeping the
  // host actually needs goes the other way (setLiveSessionIds below).

  // --- Appends -------------------------------------------------------------

  appendUser(sessionId: string, text: string): UserEntry | null {
    return this.append<UserEntry>(sessionId, t => ({
      id: this.nextEntryId(t),
      kind: 'user',
      at: Date.now(),
      text: clampText(text),
    }));
  }

  appendNotice(sessionId: string, level: NoticeEntry['level'], text: string): NoticeEntry | null {
    return this.append<NoticeEntry>(sessionId, t => ({
      id: this.nextEntryId(t),
      kind: 'notice',
      at: Date.now(),
      level,
      text,
    }));
  }

  appendPlan(sessionId: string, entries: PlanEntryRecord['entries']): PlanEntryRecord | null {
    return this.append<PlanEntryRecord>(sessionId, t => ({
      id: this.nextEntryId(t),
      kind: 'plan',
      at: Date.now(),
      entries,
    }));
  }

  /** Non-text content the agent attached to a message chunk. */
  appendContent(sessionId: string, blocks: ContentEntry['blocks']): ContentEntry | null {
    return this.append<ContentEntry>(sessionId, t => ({
      id: this.nextEntryId(t),
      kind: 'content',
      at: Date.now(),
      blocks,
    }));
  }

  // [CUSTOM-BEGIN] CUSTOM-20260924-020 - 权限卡：一个 promptId 一条记录。
  // 与 plan 同一套路（ACP 也是"同一件事的重复通知"），重复到达时复用已有记录而不是堆卡片。
  appendPermission(sessionId: string, permission: PermissionState): PermissionEntry | null {
    const t = this.sessions.get(sessionId);
    if (t) {
      const existing = t.entries.find(
        e => e.kind === 'permission' && (e as PermissionEntry).permission.promptId === permission.promptId,
      );
      if (existing) {
        (existing as PermissionEntry).permission = permission;
        t.touched = ++this.clock;
        return existing as PermissionEntry;
      }
    }
    return this.append<PermissionEntry>(sessionId, s => ({
      id: this.nextEntryId(s),
      kind: 'permission',
      at: Date.now(),
      permission,
    }));
  }
  // [CUSTOM-END] CUSTOM-20260924-020

  appendTool(sessionId: string, toolCallId: string): ToolEntry | null {    // One transcript row per tool call, even if the agent re-announces it.
    const t = this.sessions.get(sessionId);
    if (t) {
      const existing = t.entries.find(
        e => e.kind === 'tool' && (e as ToolEntry).toolCallId === toolCallId,
      );
      if (existing) { return existing as ToolEntry; }
    }
    return this.append<ToolEntry>(sessionId, s => ({
      id: this.nextEntryId(s),
      kind: 'tool',
      at: Date.now(),
      toolCallId,
    }));
  }

  /** Append raw text to the current assistant entry, creating one if needed. */
  appendAssistantChunk(sessionId: string, text: string, messageId?: string): AssistantEntry | null {
    const t = this.sessions.get(sessionId);
    if (!t) { return null; }
    const last = t.entries[t.entries.length - 1];
    const merges = !!last && last.kind === 'assistant' && last.streaming
      && (messageId === undefined || last.messageId === undefined || last.messageId === messageId);
    // [CUSTOM-20260924-026] Merging blank text into an open bubble is fine (it
    // is how paragraph breaks arrive), but STARTING a bubble from blank text is
    // never wanted: the agent sends "\n\n" after a tool call, and the old code
    // opened a new entry for it, which rendered as an empty bordered bubble.
    if (!merges && isBlankText(text)) { return null; }
    if (merges) {
      last.text = clampText(last.text + text);
      last.html = undefined;
      t.touched = ++this.clock;
      return last;
    }
    return this.append<AssistantEntry>(sessionId, s => ({
      id: this.nextEntryId(s),
      kind: 'assistant',
      at: Date.now(),
      text: clampText(text),
      streaming: true,
      messageId,
    }));
  }

  /** Append raw text to the current thought entry, creating one if needed. */
  appendThoughtChunk(sessionId: string, text: string, messageId?: string): ThoughtEntry | null {
    const t = this.sessions.get(sessionId);
    if (!t) { return null; }
    const last = t.entries[t.entries.length - 1];
    const merges = !!last && last.kind === 'thought' && last.streaming
      && (messageId === undefined || last.messageId === undefined || last.messageId === messageId);
    // [CUSTOM-20260924-026] Same rule as the assistant entry above: never start
    // a reasoning block that has nothing in it (it showed up as a bare
    // "Thought" row with an empty body).
    if (!merges && isBlankText(text)) { return null; }
    if (merges) {
      last.text = clampText(last.text + text);
      t.touched = ++this.clock;
      return last;
    }
    return this.append<ThoughtEntry>(sessionId, s => ({
      id: this.nextEntryId(s),
      kind: 'thought',
      at: Date.now(),
      text: clampText(text),
      streaming: true,
      messageId,
    }));
  }

  /**
   * Close open streaming entries — called when a thought block ends, when a
   * tool call interrupts the prose, and at turn end.
   *
   * `only` restricts which entry kind is closed. It exists because closing
   * *everything* on every `agent_message_chunk` was a real bug: it marked the
   * still-growing assistant entry as finished, so the next chunk started a
   * new entry and one reply rendered as one bubble per chunk.
   */
  finalizeStreaming(sessionId: string, opts: { only?: 'assistant' | 'thought' } = {}): string[] {
    const t = this.sessions.get(sessionId);
    if (!t) { return []; }
    const finalized: string[] = [];
    for (const entry of t.entries) {
      if (entry.kind !== 'assistant' && entry.kind !== 'thought') { continue; }
      if (!entry.streaming) { continue; }
      if (opts.only && entry.kind !== opts.only) { continue; }
      entry.streaming = false;
      if (entry.kind === 'thought' && entry.elapsedMs === undefined) {
        entry.elapsedMs = Math.max(0, Date.now() - entry.at);
      }
      finalized.push(entry.id);
    }
    return finalized;
  }

  /** Apply a partial update to an entry. Returns the updated entry, if any. */
  patch(sessionId: string, entryId: string, patch: EntryPatch): TranscriptEntry | null {
    const t = this.sessions.get(sessionId);
    if (!t) { return null; }
    const entry = t.entries.find(e => e.id === entryId);
    if (!entry) { return null; }
    if (entry.kind === 'assistant') {
      if (patch.text !== undefined) { entry.text = clampText(patch.text); }
      if (patch.html !== undefined) { entry.html = patch.html; }
      if (patch.streaming !== undefined) { entry.streaming = patch.streaming; }
    } else if (entry.kind === 'thought') {
      if (patch.text !== undefined) { entry.text = clampText(patch.text); }
      if (patch.streaming !== undefined) { entry.streaming = patch.streaming; }
      if (patch.elapsedMs !== undefined) { entry.elapsedMs = patch.elapsedMs; }
    } else if (entry.kind === 'plan') {
      // [CUSTOM-20260925-038] 键名 = 记录字段名（`entries`），不要写成 `plan`。
      if (patch.entries !== undefined) { entry.entries = patch.entries; }
    } else if (entry.kind === 'content') {
      // [CUSTOM-20260925-038] 同上，键名 = `blocks`。
      if (patch.blocks !== undefined) { entry.blocks = patch.blocks; }
    } else if (entry.kind === 'permission') {
      // [CUSTOM-20260924-020]
      if (patch.permission !== undefined) { entry.permission = patch.permission; }
    }
    t.touched = ++this.clock;
    return entry;
  }

  /** Look up an entry (used to answer `renderMarkdown` requests). */
  getEntry(sessionId: string, entryId: string): TranscriptEntry | undefined {
    return this.sessions.get(sessionId)?.entries.find(e => e.id === entryId);
  }

  /** Assistant entries that still need markdown rendering. */
  // [CUSTOM-20260925-052] `entriesNeedingMarkdown` was removed here: no callers.
  // The markdown round-trip is driven from the CLIENT side (transcriptView keeps
  // its own `pending` map and posts `renderMarkdown`), so a host-side query for
  // "who still needs html" was never on the path.

  // --- Internals -----------------------------------------------------------

  private nextEntryId(t: SessionTranscript): string {
    return `${t.sessionId}:${++t.seq}:${++this.entrySeq}`;
  }

  private append<T extends TranscriptEntry>(
    sessionId: string,
    build: (t: SessionTranscript) => T,
  ): T | null {
    const t = this.sessions.get(sessionId);
    if (!t) { return null; }
    const entry = build(t);
    t.entries.push(entry);
    t.touched = ++this.clock;
    if (t.entries.length > MAX_ENTRIES_PER_SESSION) {
      t.entries.splice(0, t.entries.length - MAX_ENTRIES_PER_SESSION);
    }
    return entry;
  }

  /** LRU-evict non-live transcripts beyond MAX_SESSIONS. */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) { return; }
    const evictable = Array.from(this.sessions.values())
      .filter(t => !this.liveSessionIds.has(t.sessionId))
      .sort((a, b) => a.touched - b.touched);
    let overflow = this.sessions.size - MAX_SESSIONS;
    for (const t of evictable) {
      if (overflow <= 0) { break; }
      this.sessions.delete(t.sessionId);
      overflow--;
    }
  }
}
