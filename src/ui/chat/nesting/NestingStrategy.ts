// [CUSTOM-BEGIN] CUSTOM-20260923-013 - 子 agent 调用树（Phase 4）：新增文件。
// 嵌套策略接口。
//
// 为什么需要「策略」而不是直接写死：**ACP 协议里根本没有父子/子 agent 概念**——
// 枚举 SDK 全部 239 个 schema 定义，`parent|subagent|delegate|nested|child|spawn` 零命中。
// 工具调用是**扁平集合**，只以 `toolCallId` 为键。因此任何"树"都是**事后推断**，
// 而推断依据是 agent 自定义的 `rawInput` / `rawOutput` / `_meta`（三者都是 `unknown`）。
// 不同 agent 的键名不同、甚至可能没有，所以推断必须可插拔、且**默认是空实现**。
//
// 诚实性原则：推断出来的边必须在 UI 上可区分（`inferredParent`），绝不伪装成协议事实。
// [CUSTOM-END] CUSTOM-20260923-013
import type { ToolInvocation } from '../transcript/types';
import { ClaudeCodeNesting } from './ClaudeCodeNesting';

export interface NestingStrategy {
  /** Stable id, used in logs and (potentially) persisted UI preferences. */
  readonly id: string;
  /** Human-readable description of HOW the link is derived, shown as a tooltip. */
  readonly label: string;
  /**
   * Recompute parent links for every invocation of one session.
   *
   * Deliberately a whole-session pass rather than per-invocation: a parent's
   * `rawOutput` often arrives AFTER its children (via `tool_call_update`), so
   * links must be re-derivable and self-healing. Implementations must be
   * idempotent — this runs on every tool update.
   *
   * @returns the `toolCallId`s whose `parentId` CHANGED, so the host can push
   *          just those to the webview.
   */
  apply(all: readonly ToolInvocation[]): string[];
}

/**
 * Pick the strategy for an agent. Matched against the `acpc.agents`
 * configuration key, same as the panel router.
 */
export function resolveNestingStrategy(agentName: string | null | undefined): NestingStrategy {
  if (agentName === 'Claude Code') {
    return claudeCodeNesting;
  }
  return flatNesting;
}

/** Shared instance — the strategy is stateless (all state lives on the invocations). */
const claudeCodeNesting: NestingStrategy = new ClaudeCodeNesting();

/**
 * Default strategy: no nesting at all. This is the **default path**, not a
 * fallback branch — for agents whose shape we have not studied, showing a flat
 * chronological list is correct, whereas a wrong tree is worse than no tree.
 */
export const flatNesting: NestingStrategy = {
  id: 'flat',
  label: 'Flat list — no nesting information is available for this agent',
  apply(): string[] {
    return [];
  },
};
