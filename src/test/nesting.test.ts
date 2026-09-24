// [CUSTOM-BEGIN] CUSTOM-20260923-013 - 子 agent 调用树（Phase 4）：嵌套推断的单元测试。
// 这是全项目最"猜"的一块（ACP 没有嵌套概念，全靠启发式），所以把行为钉死在测试里：
// 尤其是「宁可漏连不可错连」的那几条护栏，改动时必须先让测试说话。
// [CUSTOM-END] CUSTOM-20260923-013
import * as assert from 'assert';

import { ClaudeCodeNesting, isTaskLike } from '../ui/chat/nesting/ClaudeCodeNesting';
import { flatNesting, resolveNestingStrategy } from '../ui/chat/nesting/NestingStrategy';
import type { ToolInvocation } from '../ui/chat/transcript/types';

/** Build a ToolInvocation with only the fields the strategy looks at. */
function inv(partial: Partial<ToolInvocation> & { toolCallId: string }): ToolInvocation {
  return {
    toolCallId: partial.toolCallId,
    title: partial.title ?? partial.toolCallId,
    kind: partial.kind,
    status: partial.status ?? 'completed',
    content: partial.content ?? [],
    locations: partial.locations ?? [],
    rawInput: partial.rawInput,
    rawOutput: partial.rawOutput,
    meta: partial.meta,
    startedAt: partial.startedAt ?? 0,
    endedAt: partial.endedAt,
    parentId: partial.parentId,
    inferredParent: partial.inferredParent,
  };
}

/** Local depth walker, so the assertion does not reuse the implementation. */
function depthOf(invocation: ToolInvocation, all: readonly ToolInvocation[]): number {
  let depth = 0;
  let current = invocation;
  while (current.parentId && depth <= 10) {
    const parent = all.find(i => i.toolCallId === current.parentId);
    if (!parent) { break; }
    depth++;
    current = parent;
  }
  return depth;
}

function parentOf(all: readonly ToolInvocation[], id: string): string | undefined {
  return all.find(i => i.toolCallId === id)?.parentId;
}

function inferredFlag(all: readonly ToolInvocation[], id: string): boolean | undefined {
  return all.find(i => i.toolCallId === id)?.inferredParent;
}

suite('Sub-agent nesting inference', () => {
  test('isTaskLike recognises delegation calls, not ordinary ones', () => {
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'a', title: 'Task' })), true);
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'b', title: 'Task: explore src' })), true);
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'c', title: 'Spawn subagent' })), true);
    assert.strictEqual(
      isTaskLike(inv({ toolCallId: 'd', title: 'Do a thing', rawInput: { subagent_type: 'explore' } })),
      true,
    );
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'e', title: 'Edit src/a.ts', kind: 'edit' })), false);
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'f', title: 'Read src/a.ts', kind: 'read' })), false);
    // A "think" call is never a delegating parent.
    assert.strictEqual(isTaskLike(inv({ toolCallId: 'g', title: 'Task', kind: 'think' })), false);
  });

  test('flat strategy is a no-op and is the default for unknown agents', () => {
    const all = [
      inv({ toolCallId: 't', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 'c', title: 'Read', startedAt: 100, endedAt: 200 }),
    ];
    assert.deepStrictEqual(flatNesting.apply(all), []);
    assert.strictEqual(parentOf(all, 'c'), undefined);

    assert.strictEqual(resolveNestingStrategy('Gemini CLI').id, 'flat');
    assert.strictEqual(resolveNestingStrategy(null).id, 'flat');
    assert.strictEqual(resolveNestingStrategy('Claude Code').id, 'claude-code');
  });

  test('a call inside a Task window is grouped under it (inferred)', () => {
    const all = [
      inv({ toolCallId: 'task', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 'read', title: 'Read a.ts', kind: 'read', startedAt: 100, endedAt: 200 }),
    ];
    const changed = new ClaudeCodeNesting().apply(all);
    assert.strictEqual(parentOf(all, 'read'), 'task');
    assert.strictEqual(inferredFlag(all, 'read'), true, 'must be flagged as inferred');
    assert.deepStrictEqual(changed.sort(), ['read']);
  });

  test('ambiguous or near-identical windows are NOT linked (guardrails)', () => {
    // Identical spans: neither contains the other by the required margin.
    const identical = [
      inv({ toolCallId: 'task', title: 'Task', startedAt: 0, endedAt: 100 }),
      inv({ toolCallId: 'read', title: 'Read', kind: 'read', startedAt: 0, endedAt: 100 }),
    ];
    new ClaudeCodeNesting().apply(identical);
    assert.strictEqual(parentOf(identical, 'read'), undefined, 'equal spans must not link');

    // Two sibling Tasks with equal spans: ambiguous, so decline.
    const siblings = [
      inv({ toolCallId: 't1', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 't2', title: 'Task', startedAt: 0, endedAt: 1000 }),
    ];
    new ClaudeCodeNesting().apply(siblings);
    assert.strictEqual(parentOf(siblings, 't2'), undefined, 'a tie must not link');

    // A call that starts BEFORE the Task cannot be its child.
    const before = [
      inv({ toolCallId: 'task', title: 'Task', startedAt: 500, endedAt: 1000 }),
      inv({ toolCallId: 'read', title: 'Read', kind: 'read', startedAt: 0, endedAt: 200 }),
    ];
    new ClaudeCodeNesting().apply(before);
    assert.strictEqual(parentOf(before, 'read'), undefined);
  });

  test('an id mentioned in the parent payload is an EXPLICIT link', () => {
    const all = [
      inv({
        toolCallId: 'task',
        title: 'Task',
        startedAt: 0,
        endedAt: 1000,
        rawOutput: { content: [{ type: 'text', text: 'child used tooluse_abc123 here' }] },
      }),
      inv({ toolCallId: 'tooluse_abc123', title: 'Read', kind: 'read', startedAt: 100, endedAt: 200 }),
    ];
    new ClaudeCodeNesting().apply(all);
    assert.strictEqual(parentOf(all, 'tooluse_abc123'), 'task');
    assert.strictEqual(
      inferredFlag(all, 'tooluse_abc123'),
      false,
      'an id found in the parent output is evidence, not a guess',
    );
  });

  test('an explicit link is found in _meta too', () => {
    const all = [
      inv({
        toolCallId: 'task',
        title: 'Task',
        startedAt: 0,
        endedAt: 1000,
        meta: { nested: ['call_9'] },
      }),
      inv({ toolCallId: 'call_9', title: 'Edit', kind: 'edit', startedAt: 100, endedAt: 200 }),
    ];
    new ClaudeCodeNesting().apply(all);
    assert.strictEqual(parentOf(all, 'call_9'), 'task');
    assert.strictEqual(inferredFlag(all, 'call_9'), false);
  });

  test('the innermost Task wins, and Tasks can nest under Tasks', () => {
    const all = [
      inv({ toolCallId: 'outer', title: 'Task', startedAt: 0, endedAt: 2000 }),
      inv({ toolCallId: 'inner', title: 'Task', startedAt: 100, endedAt: 900 }),
      inv({ toolCallId: 'read', title: 'Read', kind: 'read', startedAt: 200, endedAt: 300 }),
    ];
    new ClaudeCodeNesting().apply(all);
    assert.strictEqual(parentOf(all, 'inner'), 'outer', 'a sub-agent may delegate further');
    assert.strictEqual(parentOf(all, 'read'), 'inner', 'innermost container wins');
  });

  test('nesting depth stays within the cap', () => {
    const all = [
      inv({ toolCallId: 't1', title: 'Task', startedAt: 0, endedAt: 100000 }),
      inv({ toolCallId: 't2', title: 'Task', startedAt: 100, endedAt: 90000 }),
      inv({ toolCallId: 't3', title: 'Task', startedAt: 200, endedAt: 80000 }),
      inv({ toolCallId: 't4', title: 'Task', startedAt: 300, endedAt: 70000 }),
      inv({ toolCallId: 't5', title: 'Task', startedAt: 400, endedAt: 60000 }),
      inv({ toolCallId: 'read', title: 'Read', kind: 'read', startedAt: 500, endedAt: 1000 }),
    ];
    new ClaudeCodeNesting().apply(all);
    for (const entry of all) {
      assert.ok(
        depthOf(entry, all) <= 3,
        `${entry.toolCallId} exceeded the depth cap (got ${depthOf(entry, all)})`,
      );
    }
  });

  test('apply is idempotent and only reports real changes', () => {
    const all = [
      inv({ toolCallId: 'task', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 'read', title: 'Read', kind: 'read', startedAt: 100, endedAt: 200 }),
    ];
    const strategy = new ClaudeCodeNesting();
    assert.deepStrictEqual(strategy.apply(all).sort(), ['read']);
    assert.deepStrictEqual(strategy.apply(all), [], 'a second pass must report no changes');

    // Re-running after the parent completes must not disturb the link.
    all[0].rawOutput = { done: true };
    assert.deepStrictEqual(strategy.apply(all), []);
    assert.strictEqual(parentOf(all, 'read'), 'task');
  });

  test('an explicit link upgrades an existing inferred one', () => {
    const all = [
      inv({ toolCallId: 'task_1', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 'toolu_01ABC', title: 'Read', kind: 'read', startedAt: 100, endedAt: 200 }),
    ];
    const strategy = new ClaudeCodeNesting();

    strategy.apply(all);
    assert.strictEqual(inferredFlag(all, 'toolu_01ABC'), true, 'starts as a guess');

    // A Task's output typically only arrives at the END of the call, which is
    // when an explicit link becomes discoverable.
    all[0].rawOutput = { log: 'used toolu_01ABC to read the file' };

    const changed = strategy.apply(all);
    assert.strictEqual(inferredFlag(all, 'toolu_01ABC'), false, 'explicit evidence must win');
    assert.strictEqual(parentOf(all, 'toolu_01ABC'), 'task_1');
    assert.ok(changed.includes('toolu_01ABC'), 'the upgrade must be reported');
  });

  test('two equally-sized containing Tasks are a tie, so nothing links', () => {
    const all = [
      inv({ toolCallId: 'task_a', title: 'Task', startedAt: 0, endedAt: 1000 }),
      inv({ toolCallId: 'task_b', title: 'Task', startedAt: 100, endedAt: 1100 }),
      inv({ toolCallId: 'toolu_01XYZ', title: 'Read', kind: 'read', startedAt: 200, endedAt: 300 }),
    ];
    new ClaudeCodeNesting().apply(all);
    assert.strictEqual(
      parentOf(all, 'toolu_01XYZ'),
      undefined,
      'equal spans are ambiguous evidence — decline rather than guess',
    );
  });
});
