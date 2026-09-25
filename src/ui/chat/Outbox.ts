// [CUSTOM-BEGIN] CUSTOM-20260924-022 - 流式消息合并队列：新增文件。
// 背景：扩展侧此前**每收到一个 ACP chunk 就 postMessage 一次**（一次回复几百条消息），
// 客户端则每条都整段重设文本并强制重排。这里把「可按条目合并」的消息攒一帧再发。
//
// 为什么可以只替换队尾：`TranscriptStore.appendAssistantChunk` 是**就地修改并返回同一个
// 对象**，所以队列里那份 entry 引用天然带着最新文本——攒着不发不会丢内容，反而省掉了中间态。
//
// 顺序不变式（改这个文件前必读，破了不会有任何自动检查报错）：
//   · INV-A 某条 entry 的 `revise` 不得越过创建它的 `append`——客户端 `patch()` 对未知 id
//           是**静默 no-op**（transcriptView.patch），越过等于那条更新凭空消失。
//           靠 FIFO + 只合并「队尾单条同 id 的 append」保证。
//   · INV-B `markdownRendered` 同理：它也只能按 FIFO 走，不得被"提前冲刷"。
//   · INV-C `sessionsChanged` 不得延迟/合并：它驱动 Send/Stop 按钮，晚了按钮状态就是错的。
//   · INV-D `sessionClosed` 不得延迟：关掉的标签要立刻消失。
//   · INV-E 每次 `boot` / `focus` 快照前必须先 `flush()`，否则接收端会先拿到快照、
//           再收到快照里已经包含的旧 append。
//
// 因此本类**只暴露一种合并**（队尾单条 append），其余一律按入队顺序原样发出；
// 结构性消息走 `flushThenPost`（先冲刷、再立即发）。
// [CUSTOM-END] CUSTOM-20260924-022
import type { ExtToChatMessage } from './protocol';

interface OutboxOptions {
  /** Where flushed messages go. In practice `ChatPanelHost.post` (broadcast). */
  send: (message: ExtToChatMessage) => void;
  log: (message: string) => void;
  /** Coalescing window. One animation frame at 60Hz. */
  flushMs?: number;
  /** Hard cap: exceeding it forces an immediate flush (backpressure). */
  maxQueued?: number;
}

export class Outbox {
  private queue: ExtToChatMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sent = 0;
  private merged = 0;

  constructor(private readonly opts: OutboxOptions) {}

  /** Queue an order-coupled message (append / revise / toolUpdate / markdownRendered). */
  enqueue(message: ExtToChatMessage): void {
    const tail = this.queue[this.queue.length - 1];
    if (this.canMerge(tail, message)) {
      this.queue[this.queue.length - 1] = message;
      this.merged++;
    } else {
      this.queue.push(message);
    }
    if (this.queue.length >= (this.opts.maxQueued ?? 256)) {
      this.flush();
      return;
    }
    this.schedule();
  }

  /** Flush what is pending, then send a structural message immediately. */
  flushThenPost(message: ExtToChatMessage): void {
    this.flush();
    this.opts.send(message);
    this.sent++;
  }

  /** Drain in insertion order. Also used as the barrier before every snapshot. */
  flush(): void {
    this.clearTimer();
    if (this.queue.length === 0) { return; }
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) {
      this.opts.send(message);
      this.sent++;
    }
  }

  stats(): { sent: number; merged: number; queued: number } {
    return { sent: this.sent, merged: this.merged, queued: this.queue.length };
  }

  /**
   * [CUSTOM-20260925-041] Zero the counters so the next `stats()` call reports
   * ONE turn rather than everything since the extension started.
   *
   * The counters used to be cumulative, which quietly destroyed the value of the
   * `outbox sent=/merged=/queued=` diagnostic line: `merged/sent` drifts toward
   * its long-run average and stops telling you anything about the turn you just
   * watched.
   */
  resetStats(): void {
    this.sent = 0;
    this.merged = 0;
  }

  dispose(): void {
    this.flush();
    this.clearTimer();
  }

  // --- Internals -----------------------------------------------------------

  /**
   * The ONLY merge rule: the queue's tail is a single-entry `append` for the
   * same entry the new `append` carries. Everything else (multi-entry batches,
   * different entries, different sessions, any other message type) is appended
   * verbatim so relative order can never change.
   */
  private canMerge(tail: ExtToChatMessage | undefined, message: ExtToChatMessage): boolean {
    if (!tail || tail.type !== 'append' || message.type !== 'append') { return false; }
    if (tail.sessionId !== message.sessionId) { return false; }
    if (tail.entries.length !== 1 || message.entries.length !== 1) { return false; }
    return tail.entries[0].id === message.entries[0].id;
  }

  private schedule(): void {
    if (this.timer) { return; }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.flushMs ?? 16);
  }

  private clearTimer(): void {
    if (!this.timer) { return; }
    clearTimeout(this.timer);
    this.timer = null;
  }
}
