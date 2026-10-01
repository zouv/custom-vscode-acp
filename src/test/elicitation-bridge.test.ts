// [CUSTOM-BEGIN] CUSTOM-20260929-119 - elicitation 桥的纯逻辑单测。
//
// **为什么值得单独写**：`PermissionBridge`（它照抄的对象）至今**一条测试都没有**——FIFO、
// "恰好回答一次"、presenter 丢失时的降级，全都只靠人工。而这三条恰恰是"agent 永远挂住"
// 这一类事故的全部入口，所以这份测试同时是 elicitation 的守卫，也是那套机制的第一次固化。
//
// 桥**不 import vscode 的 UI 类型**（弹框由 handler 传进来），所以这里不需要 Extension Host：
// `npx mocha --ui tdd out/test/elicitation-bridge.test.js` 就能跑。
// [CUSTOM-END] CUSTOM-20260929-119
import * as assert from 'assert';

import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';

import {
  ElicitationBridge,
  fieldsOf,
  type ElicitationPresenter,
  type ElicitationState,
} from '../handlers/ElicitationBridge';

class RecordingPresenter implements ElicitationPresenter {
  readonly shown: ElicitationState[] = [];
  readonly updated: ElicitationState[] = [];
  constructor(private readonly presentable = true) {}
  canPresent(_sessionId: string): boolean { return this.presentable; }
  show(state: ElicitationState): void { this.shown.push(state); }
  update(state: ElicitationState): void { this.updated.push(state); }
}

/** An AskUserQuestion-shaped form request, exactly as the adapter builds it. */
function askRequest(sessionId = 's1'): CreateElicitationRequest {
  return {
    mode: 'form',
    sessionId,
    toolCallId: 'call_1',
    message: 'Which framework?',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Base',
          oneOf: [
            { const: 'Astro official', title: 'Astro official', description: 'Recommended' },
            { const: 'AstroPaper', title: 'AstroPaper' },
          ],
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } },
        },
      },
    },
  } as unknown as CreateElicitationRequest;
}

const never = () => new Promise<CreateElicitationResponse>(() => { /* a dialog that never returns */ });

suite('elicitation bridge: outcomes, ownership, lifecycle', () => {
  test('a panel form is answered exactly once', async () => {
    const bridge = new ElicitationBridge();
    const presenter = new RecordingPresenter();
    bridge.setPresenter(presenter);

    const pending = bridge.request(askRequest(), async () => { throw new Error('the dialog must not open'); });
    assert.deepStrictEqual(presenter.shown.map(s => s.status), ['pending']);
    assert.strictEqual(presenter.shown[0].fields.length, 2, 'both fields reached the panel');
    assert.strictEqual(presenter.shown[0].fields[0].kind, 'select');
    assert.strictEqual(presenter.shown[0].fields[1].customFor, 'question_0', 'the Other box knows its question');

    assert.strictEqual(bridge.submit('s1:1', 'accept', { question_0: 'Astro official' }), true);
    assert.strictEqual(bridge.submit('s1:1', 'accept', { question_0: 'AstroPaper' }), false,
      'a second answer must be ignored (double click / both surfaces)');
    assert.deepStrictEqual(await pending, { action: 'accept', content: { question_0: 'Astro official' } });
    assert.deepStrictEqual(presenter.updated.map(s => s.status), ['accepted'], 'the card settles');
    assert.strictEqual(bridge.pendingCount, 0);
  });

  test('skip is a decline, not a cancel — and neither carries content', async () => {
    const bridge = new ElicitationBridge();
    bridge.setPresenter(new RecordingPresenter());
    const skipped = bridge.request(askRequest(), never);
    bridge.submit('s1:1', 'decline');
    assert.deepStrictEqual(await skipped, { action: 'decline' });

    const bridge2 = new ElicitationBridge();
    const presenter2 = new RecordingPresenter();
    bridge2.setPresenter(presenter2);
    const cancelled = bridge2.request(askRequest('s2'), never);
    bridge2.submit('s2:1', 'cancel');
    assert.deepStrictEqual(await cancelled, { action: 'cancel' });
    assert.deepStrictEqual(presenter2.updated.map(s => s.status), ['cancelled']);
  });

  test('no presentable panel → the dialog answers instead, one at a time', async () => {
    const bridge = new ElicitationBridge();
    bridge.setPresenter(null);
    const order: string[] = [];
    const first = bridge.request(askRequest('s1'), async () => {
      order.push('first');
      return { action: 'accept', content: { question_0: 'A' } };
    });
    const second = bridge.request(askRequest('s1'), async () => {
      order.push('second');
      return { action: 'decline' };
    });
    const [a, b] = await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['first', 'second'], 'arrival order = dialog order (FIFO, one at a time)');
    assert.strictEqual(a.action, 'accept');
    assert.strictEqual(b.action, 'decline');
  });

  test('a dialog that throws resolves as cancel instead of hanging the agent', async () => {
    const bridge = new ElicitationBridge();
    bridge.setPresenter(null);
    const pending = bridge.request(askRequest('s1'), async () => { throw new Error('no UI'); });
    assert.deepStrictEqual(await pending, { action: 'cancel' });
  });

  test('cancelling a session retires its forms as cancel (the turn is over)', async () => {
    const bridge = new ElicitationBridge();
    const presenter = new RecordingPresenter();
    bridge.setPresenter(presenter);
    const pending = bridge.request(askRequest('s1'), never);
    bridge.cancelSession('s1');
    assert.deepStrictEqual(await pending, { action: 'cancel' });
    assert.deepStrictEqual(presenter.updated.map(s => s.status), ['cancelled']);
    assert.strictEqual(bridge.pendingCount, 0);
  });

  test('losing the last surface defers the form to the dialog', async () => {
    const bridge = new ElicitationBridge();
    const presenter = new RecordingPresenter();
    bridge.setPresenter(presenter);
    void bridge.request(askRequest('s1'), async () => ({ action: 'decline' }));
    bridge.onPresenterLost();
    assert.deepStrictEqual(presenter.updated.map(s => s.status), ['deferred']);
    assert.strictEqual(bridge.submit('s1:1', 'accept', { question_0: 'A' }), false,
      'a deferred card must not race the open dialog');
  });

  test('a deferred card is settled by the dialog, not by the panel', async () => {
    const bridge = new ElicitationBridge();
    const presenter = new RecordingPresenter();
    bridge.setPresenter(presenter);
    const pending = bridge.request(askRequest('s1'), never);
    bridge.onPresenterLost();
    // The dialog answers it; the panel's own answer (tested above) was refused.
    assert.strictEqual(bridge.pendingCount, 1, 'still pending, now owned by the dialog');
    bridge.cancelAll();
    assert.deepStrictEqual(await pending, { action: 'cancel' });
  });
});

suite('elicitation bridge: schema flattening', () => {
  test('the four renderable shapes are recognised', () => {
    const fields = fieldsOf({
      type: 'object',
      properties: {
        q0: { type: 'string', title: 'Single', oneOf: [{ const: 'x', title: 'X' }] },
        q1: { type: 'array', title: 'Multi', items: { anyOf: [{ const: 'a', title: 'A' }] } },
        q2: { type: 'boolean', title: 'Flag' },
        q3: { type: 'string', title: 'Free text' },
        q4: { type: 'integer', title: 'Count' },
      },
    });
    assert.deepStrictEqual(fields.map(f => [f.name, f.kind]), [
      ['q0', 'select'], ['q1', 'multi'], ['q2', 'boolean'], ['q3', 'text'], ['q4', 'number'],
    ]);
  });

  test('an unrecognised shape is left OUT of the form rather than mis-rendered', () => {
    const fields = fieldsOf({
      type: 'object',
      properties: {
        good: { type: 'string', title: 'Fine' },
        nested: { type: 'object', title: 'Not renderable' },
        list: { type: 'array', title: 'No enum' },
      },
    });
    assert.deepStrictEqual(fields.map(f => f.name), ['good'],
      'omitting a field is a valid answer (nothing is required) — guessing at it is not');
  });

  test('a schema with nothing renderable yields no fields', () => {
    assert.deepStrictEqual(fieldsOf({ type: 'object', properties: {} }), []);
    assert.deepStrictEqual(fieldsOf(undefined), []);
  });

  test('a custom box WITHOUT the _meta marker is still paired with its question', () => {
    // [CUSTOM-20261001-153] The real shape measured on 2026-10-01: the adapter sent
    // title 'Other' plus a description, but NO `_meta._askUserQuestionCustomAnswer`. Reading only
    // the marker left the box as a question of its own (an extra "Other" tab) and the question
    // block with no custom input at all — the user's "缺少自定义内容".
    const fields = fieldsOf({
      type: 'object',
      properties: {
        question_0: { type: 'string', title: '定位哪个', oneOf: [{ const: 'a', title: 'A' }] },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description: 'Type your own answer, or add a note to the option you chose above (optional).',
        },
      },
    });
    assert.deepStrictEqual(fields.map(f => [f.name, f.kind, f.customFor]), [
      ['question_0', 'select', undefined],
      ['question_0_custom', 'text', 'question_0'],
    ]);
  });

  test('a _custom field whose question does not exist is left on its own', () => {
    // The fallback must not invent a parent: an unpaired field stays a field (it still travels
    // back under its own name).
    const fields = fieldsOf({
      type: 'object',
      properties: { question_7_custom: { type: 'string', title: 'Other' } },
    });
    assert.deepStrictEqual(fields.map(f => [f.name, f.customFor]), [['question_7_custom', undefined]]);
  });
});
