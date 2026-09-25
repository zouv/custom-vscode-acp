// [CUSTOM-BEGIN] CUSTOM-20260923-013 - 子 agent 调用树（Phase 4）：新增文件。
// Claude Code 的嵌套推断。
//
// ⚠️ 诚实性声明：ACP **没有**子 agent / 父子工具调用概念（见 NestingStrategy.ts 的说明）。
// 这里推断出的每一条边都只是**启发式猜测**，UI 上必须标注 `inferredParent`，
// 绝不能让用户以为这是协议事实。Phase 0 探针 (b) 若证明适配器在 `rawInput` / `rawOutput`
// / `_meta` 里提供了**显式**父子键，应当删除本文件的时序启发式、只保留显式链接。
//
// 两级推断，显式优先：
//   1. **显式链接**：某个 Task 类调用的 `rawOutput` 或 `_meta` 里**出现了子调用的 toolCallId**。
//      这是与厂商无关的判据——不需要知道键名叫什么，只要 id 出现在父的产出里就成立。
//   2. **时序包含回退**：子调用的生命周期区间被父区间包住，取**最内层**（跨度最小的）父。
//
// 护栏（宁可漏连，不可错连）：
//   · 父区间须比子区间长至少 50ms（否则同刻开始的两个调用会被误判）
//   · 嵌套深度上限 3（迭代收敛，一趟内即生效——见 apply 的说明）
//   · 并列（跨度相同）时不连
//   · 只有 Task 类调用能做父——因此 Task 可以挂在另一个 Task 下（子 agent 再派生），
//     但普通的 Edit/Read 不会被误归到某个 Task 下
// [CUSTOM-END] CUSTOM-20260923-013
import type { ToolInvocation } from '../transcript/types';
import type { NestingStrategy } from './NestingStrategy';

const MAX_DEPTH = 3;
const MIN_CONTAINMENT_MS = 50;
/** Cap on how much of a raw payload we stringify when searching for an id. */
const MAX_SCAN_CHARS = 200_000;

/** Titles that mark a call as a sub-agent/task delegation. */
const TASK_TITLE = /^(task|agent|subagent|sub-agent|delegate)\b/i;
const SUBAGENT_WORD = /\b(sub-?agent|delegate|spawn)\b/i;
/** rawInput keys that suggest a sub-agent descriptor. */
const SUBAGENT_INPUT_KEY = /sub-?agent|agent_?type|agenttype/i;

// [CUSTOM-20260925-043] The two caches behind the memoisation, declared up here
// so nothing reads them before initialisation. Both are keyed on object
// identity, which is what makes them safe: `ToolInvocationStore.upsert*`
// REPLACES `kind` / `title` / `rawInput` / `rawOutput` / `_meta` wholesale
// rather than mutating them in place, so a reference change is exactly the
// invalidation signal — no version counter to keep in sync, and no way for a
// stale entry to survive a real change.
//
// `taskLikeCache` is per-invocation; `payloadTextCache` is per-PAYLOAD (an
// invocation's `_meta` and `rawOutput` are separate objects, and the same
// payload can be probed for many different child ids).
const taskLikeCache = new WeakMap<
  ToolInvocation,
  { kind: unknown; title: unknown; rawInput: unknown; result: boolean }
>();
const payloadTextCache = new WeakMap<object, string>();

interface Decision {
  parentId?: string;
  inferred?: boolean;
}

export class ClaudeCodeNesting implements NestingStrategy {
  readonly id = 'claude-code';
  readonly label =
    'Sub-agent grouping inferred from tool timings and outputs — ACP has no nesting concept';

  /**
   * Decide, then apply — decisions never read values this pass is rewriting,
   * so the result does not depend on iteration order.
   *
   * Iterated to a fixed point because the depth guard reads depths derived from
   * the PREVIOUS decision set: a single pass would happily chain a fresh 5-deep
   * delegation chain (every depth starting at 0) and only trim it on the next
   * tool update. Converges in 2 rounds when there is nothing to nest, and in at
   * most MAX_DEPTH + 2 otherwise.
   */
  apply(all: readonly ToolInvocation[]): string[] {
    const now = Date.now();
    const before = new Map(all.map(inv => [inv.toolCallId, fingerprint(inv)]));

    let decisions = new Map<string, Decision>();
    for (let round = 0; round <= MAX_DEPTH + 1; round++) {
      const depth = depthFromDecisions(all, decisions);
      const next = new Map<string, Decision>();
      let moved = false;
      for (const inv of all) {
        const decision = this.decide(inv, all, depth, now);
        next.set(inv.toolCallId, decision);
        const previous = decisions.get(inv.toolCallId);
        if (!previous
          || previous.parentId !== decision.parentId
          || !!previous.inferred !== !!decision.inferred) {
          moved = true;
        }
      }
      decisions = next;
      if (!moved) { break; }
    }

    const changed: string[] = [];
    for (const inv of all) {
      const decision = decisions.get(inv.toolCallId) ?? {};
      inv.parentId = decision.parentId;
      inv.inferredParent = decision.inferred;
      if (before.get(inv.toolCallId) !== fingerprint(inv)) {
        changed.push(inv.toolCallId);
      }
    }
    return changed;
  }

  private decide(
    inv: ToolInvocation,
    all: readonly ToolInvocation[],
    depth: ReadonlyMap<string, number>,
    now: number,
  ): Decision {
    // Only a task-delegation call can be a parent — so a Task may itself be a
    // child of another Task (sub-agents can delegate further), while a plain
    // Edit/Read can never be grouped under one by accident.
    const candidates = all.filter(candidate =>
      candidate.toolCallId !== inv.toolCallId
      && isTaskLike(candidate)
      && (depth.get(candidate.toolCallId) ?? 0) < MAX_DEPTH
      && contains(candidate, inv, now),
    );
    if (candidates.length === 0) { return {}; }

    // (1) Explicit: the parent's own output mentions this child's id.
    const explicit = candidates.find(candidate => mentionsId(candidate, inv.toolCallId));
    if (explicit) {
      return { parentId: explicit.toolCallId, inferred: false };
    }

    // (2) Temporal fallback: innermost (smallest span) containing candidate.
    return pickInnermost(candidates, now);
  }
}

/** Parent/child links are only ever claimed for task-delegation calls. */
export function isTaskLike(inv: ToolInvocation): boolean {
  // [CUSTOM-20260925-043] Memoised: `apply()` calls this once per candidate per
  // round, and the answer only changes when one of its three inputs changes.
  // `ToolInvocationStore.upsert*` REPLACES those fields rather than mutating
  // them, so identity comparison is the exact invalidation signal — no version
  // counter needed, and a stale hit is impossible.
  const cached = taskLikeCache.get(inv);
  if (cached
    && cached.kind === inv.kind
    && cached.title === inv.title
    && cached.rawInput === inv.rawInput) {
    return cached.result;
  }
  const result = computeTaskLike(inv);
  taskLikeCache.set(inv, { kind: inv.kind, title: inv.title, rawInput: inv.rawInput, result });
  return result;
}

function computeTaskLike(inv: ToolInvocation): boolean {
  if (inv.kind === 'think') { return false; }

  const title = (inv.title ?? '').trim();
  if (TASK_TITLE.test(title) || SUBAGENT_WORD.test(title)) { return true; }

  const rawInput = inv.rawInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const keys = Object.keys(rawInput as Record<string, unknown>);
    if (keys.some(key => SUBAGENT_INPUT_KEY.test(key))) { return true; }
  }
  return false;
}

/** See `isTaskLike` — same identity-based invalidation. */
/**
 * Does `parent`'s payload mention `childId`?
 *
 * Vendor-agnostic on purpose: we do not need to know the key name, only that
 * the child's id appears in the parent's output (or `_meta`).
 */
function mentionsId(parent: ToolInvocation, childId: string): boolean {
  if (!childId) { return false; }
  return payloadContains(parent.rawOutput, childId) || payloadContains(parent.meta, childId);
}

// [CUSTOM-20260925-043] Serialised-payload cache.
//
// `payloadContains` used to `JSON.stringify` the parent's payload on EVERY
// candidate check of every round of every tool update. A Task's `rawOutput` is
// routinely tens or hundreds of KB, so re-serialising the same unchanged object
// dozens of times per update was the single most expensive thing in the host's
// chat path — and it was pure waste, because the payload only ever changes when
// the store replaces it wholesale.
//
// Keyed on the PAYLOAD OBJECT itself (not the invocation): the cache entry is
// invalidated by the identity change that `upsert*` performs, and a WeakMap
// guarantees it cannot outlive the payload. The stored value is the string
// already sliced to `MAX_SCAN_CHARS`, so the memory held is bounded by
// `min(payload size, MAX_SCAN_CHARS)` — strictly less than the transient string
// the old code built and threw away on every call.
/** Scan-limited serialisation of a payload, or null when it cannot be scanned. */
function scanText(value: unknown): string | null {
  if (typeof value === 'string') { return value.slice(0, MAX_SCAN_CHARS); }
  if (!value || typeof value !== 'object') { return null; }
  const cached = payloadTextCache.get(value);
  if (cached !== undefined) { return cached; }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== 'string') { return null; }
  // Slicing BEFORE caching keeps the cache bounded *and* is exactly what the
  // search below would do anyway — so this changes no semantics.
  text = text.slice(0, MAX_SCAN_CHARS);
  payloadTextCache.set(value, text);
  return text;
}

function payloadContains(value: unknown, needle: string): boolean {
  const text = scanText(value);
  return text === null ? false : text.includes(needle);
}

/** Effective end of an interval: a still-running call is open up to `now`. */
function endOf(inv: ToolInvocation, now: number): number {
  return inv.endedAt ?? now;
}

function spanOf(inv: ToolInvocation, now: number): number {
  return Math.max(0, endOf(inv, now) - inv.startedAt);
}

/**
 * Temporal containment with a margin. The margin exists because two calls that
 * start at the same millisecond would otherwise "contain" each other.
 */
function contains(parent: ToolInvocation, child: ToolInvocation, now: number): boolean {
  if (parent.startedAt > child.startedAt) { return false; }
  if (endOf(parent, now) < endOf(child, now)) { return false; }
  return spanOf(parent, now) - spanOf(child, now) >= MIN_CONTAINMENT_MS;
}

/**
 * Smallest containing candidate wins. A tie means the evidence is ambiguous,
 * so we decline to link rather than pick arbitrarily.
 */
function pickInnermost(candidates: readonly ToolInvocation[], now: number): Decision {
  let best = candidates[0];
  let tie = false;
  for (let i = 1; i < candidates.length; i++) {
    const span = spanOf(candidates[i], now);
    const bestSpan = spanOf(best, now);
    if (span < bestSpan) {
      best = candidates[i];
      tie = false;
    } else if (span === bestSpan) {
      tie = true;
    }
  }
  return tie ? {} : { parentId: best.toolCallId, inferred: true };
}

/** Distance from the root under a candidate decision set (cycle-guarded). */
function depthFromDecisions(
  all: readonly ToolInvocation[],
  decisions: ReadonlyMap<string, Decision>,
): Map<string, number> {
  const byId = new Map(all.map(inv => [inv.toolCallId, inv]));
  const depths = new Map<string, number>();
  for (const inv of all) {
    let depth = 0;
    let currentId = inv.toolCallId;
    const seen = new Set<string>([currentId]);
    while (depth <= MAX_DEPTH + 1) {
      const decision = decisions.get(currentId);
      if (!decision?.parentId || seen.has(decision.parentId)) { break; }
      seen.add(decision.parentId);
      if (!byId.has(decision.parentId)) { break; }
      depth++;
      currentId = decision.parentId;
    }
    depths.set(inv.toolCallId, depth);
  }
  return depths;
}

function fingerprint(inv: ToolInvocation): string {
  return `${inv.parentId ?? ''}|${inv.inferredParent ? 1 : 0}`;
}
