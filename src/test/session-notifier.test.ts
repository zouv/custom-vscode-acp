// [CUSTOM-BEGIN] CUSTOM-20261001-156 - 会话状态通知的纯逻辑单测。
//
// **为什么值得单独写**：通知是这次改造里唯一"用户看不到就等于没发生"的东西——一条没发出去的
// 通知，表现是"agent 在后台被挂住、界面安安静静"，跟功能没做一模一样。所以把这些规则钉死：
// 文案（权限 / 表单 / 完成 / 失败）、级别（等待=warning 会一直挂着，完成=info 会自动消失）、
// 去重（同一条 prompt / 同一轮只发一次）、`forget`（会话关掉后键要能重新用）。
//
// 本模块**不 import vscode 的 UI 类型**（渠道由调用方注入），所以这里不需要 Extension Host：
// `npx mocha --ui tdd out/test/session-notifier.test.js` 就能跑。
// [CUSTOM-END] CUSTOM-20261001-156
import * as assert from 'assert';

import {
  SessionNotifier,
  composeNotice,
  type NoticeChannel,
  type SessionNotice,
} from '../ui/chat/SessionNotifier';

/** Records every notification and lets a test "click" one of them. */
class RecordingChannel implements NoticeChannel {
  readonly shown: Array<{ level: string; message: string; action: string }> = [];
  private readonly resolvers: Array<(choice: string | undefined) => void> = [];

  show(level: 'info' | 'warning', message: string, action: string): Promise<string | undefined> {
    this.shown.push({ level, message, action });
    return new Promise(resolve => { this.resolvers.push(resolve); });
  }

  /** Press the action button (or dismiss, with `click = false`) on one notification. */
  async answer(index: number, click = true): Promise<void> {
    this.resolvers[index](click ? this.shown[index].action : undefined);
    await Promise.resolve();
  }
}

function notice(overrides: Partial<SessionNotice> = {}): SessionNotice {
  return {
    kind: 'waiting-permission',
    sessionId: 's-1',
    token: 'p-1',
    label: 'Claude Code · 修复登录 bug',
    ...overrides,
  };
}

suite('session notifier: wording and levels (CUSTOM-20261001-156)', () => {
  test('a permission request says what is waiting and what for', () => {
    const text = composeNotice(notice({ detail: 'cd /repo && npm test' }));
    assert.ok(text.includes('Claude Code · 修复登录 bug'), `names the session, got: ${text}`);
    assert.ok(text.includes('等待权限确认'), `says what it is waiting for, got: ${text}`);
    assert.ok(text.includes('npm test'), `carries the command, got: ${text}`);
  });

  test('a form says the user is being asked something', () => {
    const text = composeNotice(notice({ kind: 'waiting-form', detail: 'Which database?' }));
    assert.ok(text.includes('等待你的回答'), text);
    assert.ok(text.includes('Which database?'), text);
  });

  test('a finished turn and a failed turn say different things', () => {
    const done = composeNotice(notice({ kind: 'turn-done' }));
    assert.ok(done.includes('已完成这一轮'), done);
    const failed = composeNotice(notice({ kind: 'turn-done', failed: true, detail: 'The turn was cut short by the token limit.' }));
    assert.ok(failed.includes('已结束'), failed);
    assert.ok(failed.includes('token limit'), failed);
  });

  test('the detail is one line and clipped — a notification is a glance, not a report', () => {
    const long = `line one\nline two ${'x'.repeat(200)}`;
    const text = composeNotice(notice({ detail: long }));
    assert.ok(!text.includes('\n'), 'newlines are collapsed');
    assert.ok(text.length < 160, `clipped, got ${text.length} chars`);
    assert.ok(text.includes('…'), 'and it says so with an ellipsis');
  });

  test('waiting is a warning (stays on screen), done is info (goes away)', () => {
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice());
    notifier.notify(notice({ kind: 'turn-done', token: 't-1' }));
    assert.deepStrictEqual(channel.shown.map(n => n.level), ['warning', 'info']);
  });

  test('a stalled background task says so, with the wait time (CUSTOM-20261001-162)', () => {
    const text = composeNotice(notice({ kind: 'background-stalled', detail: '已 120 秒没有输出' }));
    assert.ok(text.includes('后台任务'), text);
    assert.ok(text.includes('120 秒'), 'the wait time is the part that makes it actionable');
    assert.ok(text.includes('已恢复'), 'and it says the composer is usable again');

    // It reports a state, it does not block anything: info, not a lingering warning.
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice({ kind: 'background-stalled', token: 'stalled-1' }));
    assert.strictEqual(channel.shown[0].level, 'info');
  });
});

suite('session notifier: dedupe and clicks (CUSTOM-20261001-156)', () => {
  test('the same prompt never notifies twice', () => {
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice());
    notifier.notify(notice());
    assert.strictEqual(channel.shown.length, 1, 'one prompt, one notification');
  });

  test('the same turn number never notifies twice, but the next turn does', () => {
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice({ kind: 'turn-done', token: '1' }));
    notifier.notify(notice({ kind: 'turn-done', token: '1' }));
    notifier.notify(notice({ kind: 'turn-done', token: '2' }));
    assert.strictEqual(channel.shown.length, 2, 'dedupe is per (session, kind, token)');
  });

  test('a different session with the same prompt id is its own notification', () => {
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice());
    notifier.notify(notice({ sessionId: 's-2' }));
    assert.strictEqual(channel.shown.length, 2);
  });

  test('clicking the action hands the notice back; dismissing does not', async () => {
    const channel = new RecordingChannel();
    const clicked: SessionNotice[] = [];
    const notifier = new SessionNotifier(channel, n => clicked.push(n));
    notifier.notify(notice({ token: 'p-1' }));
    notifier.notify(notice({ token: 'p-2' }));

    await channel.answer(0, false);          // dismissed
    await channel.answer(1);                 // clicked
    assert.strictEqual(clicked.length, 1, 'only the clicked one comes back');
    assert.strictEqual(clicked[0].token, 'p-2', 'and it is the right one');
  });

  test('forget drops that session\'s keys and nothing else', () => {
    const channel = new RecordingChannel();
    const notifier = new SessionNotifier(channel, () => { /* no click */ });
    notifier.notify(notice({ sessionId: 's-1' }));
    notifier.notify(notice({ sessionId: 's-2' }));   // same token, another session
    assert.strictEqual(channel.shown.length, 2);

    notifier.forget('s-1');
    notifier.notify(notice({ sessionId: 's-1' }));   // fresh again
    notifier.notify(notice({ sessionId: 's-2' }));   // still deduped
    assert.strictEqual(channel.shown.length, 3, 'only s-1 was forgotten');
  });
});
