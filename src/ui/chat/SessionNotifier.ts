// [CUSTOM-BEGIN] CUSTOM-20261001-156 - 会话状态通知（等待权限 / 等待表单 / 轮次完成）：新增文件。
//
// 为什么需要：多会话是这个面板的常态，而"某个 agent 在后台被挂住"从前只有一条出路 ——
// 弹到窗口顶部一个 QuickPick（标题 `ACP Agent Permission Request`）。用户看到的正是它：
// 10:29 他在会话 A 里发消息，10:30 会话 B 请求权限，于是顶部弹出一个跟当前工作无关的问句。
// 现在改成：**哪个会话在等你，就发一条右下角通知**（带「打开会话」按钮），点它跳过去、
// 在那个会话里作答。
//
// 为什么把 vscode UI 收在一个注入缝里：与 PermissionHandler 同一个理由 —— 桥不 import vscode
// 才能被单测直接驱动。本文件因此**完全不 import vscode**（真实通道是 ChatPanelHost 里的
// `vscodeNoticeChannel()`，与 `vscodePanelPrefs()` 并排），`npx mocha --ui tdd
// out/test/session-notifier.test.js` 就能跑。
//
// 去重键由**本模块**拼成 `sessionId::kind::token`，调用方只给 token（等待类 = promptId，
// 完成类 = 每会话自增的轮次号）。这样 `forget(sessionId)` 才是前缀匹配，而不是让调用方
// 各自记着格式（pitfall #19：同一份知识两处存，迟早只改一边）。
//
// 本文件**不 import vscode，也不 import Logger**（后者会把它拖进 vscode）：纯逻辑 + 注入的
// 渠道，所以 `npx mocha --ui tdd out/test/session-notifier.test.js` 能直接跑。日志由宿主
// 负责（`notify()` 把"发没发出去"作为返回值交回去）。
//
// 级别是有理由的：VS Code 的 **info 通知会自动消失**（进通知中心），**warning 会一直挂着**。
// 等待类（权限 / 表单）agent 被挂住，不能错过 ⇒ warning；完成 ⇒ info。
// [CUSTOM-END] CUSTOM-20261001-156

export type SessionNoticeKind = 'waiting-permission' | 'waiting-form' | 'turn-done' | 'background-stalled';

/** What to tell the user about one session, and how to name it. */
export interface SessionNotice {
  kind: SessionNoticeKind;
  sessionId: string;
  /** Dedupe token, unique within (sessionId, kind): a promptId, or a turn counter. */
  token: string;
  /** "Claude Code · 修复登录 bug" — resolved by the host (it owns the title map). */
  label: string;
  /** One line of context: the command awaiting permission, the question, the stop reason. */
  detail?: string;
  /** turn-done only: the turn ended badly (error / refusal / token limit). */
  failed?: boolean;
}
/**
 * The one vscode UI call this module makes. Kept behind an interface so tests can
 * drive the notifier without a real notification (and without a window). The real
 * implementation lives in ChatPanelHost (`vscodeNoticeChannel`) — this file must not
 * import vscode, or its unit test could not run outside the Extension Host.
 */
export interface NoticeChannel {
  show(level: 'info' | 'warning', message: string, action: string): Promise<string | undefined>;
}

/** The single button every notification carries. Clicking it jumps to that session. */
const ACTION = '打开会话';

/** Notifications are a glance, not a report: the detail line is clipped to one line. */
const DETAIL_MAX = 80;

export class SessionNotifier {
  /** Keys already shown, so one prompt / one turn can never notify twice. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly channel: NoticeChannel,
    private readonly onClick: (notice: SessionNotice) => void,
  ) {}

  /**
   * Show one notification. Returns false when this key was already shown (the
   * caller owns the log line — see the file header for why this module stays
   * dependency-free).
   */
  notify(notice: SessionNotice): boolean {
    const key = `${notice.sessionId}::${notice.kind}::${notice.token}`;
    if (this.seen.has(key)) { return false; }
    this.seen.add(key);
    // Waiting kinds are warnings (they stay on screen until dismissed — the agent
    // cannot move); everything else is an FYI that may disappear on its own.
    const waiting = notice.kind === 'waiting-permission' || notice.kind === 'waiting-form';
    const level = waiting ? 'warning' : 'info';
    const message = composeNotice(notice);
    void this.channel.show(level, message, ACTION).then(choice => {
      if (choice === ACTION) { this.onClick(notice); }
    });
    return true;
  }

  /**
   * The session is gone (closed): its keys can never fire again, so let them go.
   * Without this the set grows for the life of the window — small, but it is the
   * kind of leak that later reads as "we never re-notify after reopening".
   */
  forget(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of Array.from(this.seen)) {
      if (key.startsWith(prefix)) { this.seen.delete(key); }
    }
  }
}

/**
 * The notification text. A pure function so the wording is unit-testable without a
 * notifier, a channel, or a window.
 */
export function composeNotice(notice: SessionNotice): string {
  const detail = notice.detail ? clip(oneLine(notice.detail)) : '';
  switch (notice.kind) {
    case 'waiting-permission':
      return `${notice.label} 正在等待权限确认` + (detail ? `：${detail}` : '');
    case 'waiting-form':
      return `${notice.label} 正在等待你的回答` + (detail ? `：${detail}` : '');
    case 'turn-done':
      return notice.failed
        ? `${notice.label} 的轮次已结束（${detail || '失败'}）`
        : `${notice.label} 已完成这一轮`;
    // [CUSTOM-20261001-162] 后台子任务长时间没有动静：等待到此为止（发送按钮已恢复），
    // 但**说出来**——静默地变回"可以发消息"正是用户报的那个 bug 的观感。
    case 'background-stalled':
      return `${notice.label} 的后台任务${detail ? `（${detail}）` : ''}超时未汇报，已恢复为可发送`;
  }
}

function oneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}
