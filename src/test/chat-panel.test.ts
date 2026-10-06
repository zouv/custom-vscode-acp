// [CUSTOM-BEGIN] CUSTOM-20260925-054 - 聊天面板的宿主侧回归测试（真实 replay 夹具驱动）。
//
// **它存在的理由**：2026-09-25 用户报"重开会话看到的内容与实时不一样"，而这条链路
// （`session/load` → replay → 重建 transcript）此前**没有任何自动检查**——排查只能靠
// 人肉看截图 + 猜，一次迭代一个来回。这个文件把那类问题变成可自动复现的断言。
//
// **测什么（宿主侧协议流）**：用真实抓包的 `session/update` 流驱动 `ChatPanelHost`，
// 断言它**准备发给 webview 的每一条消息**。这样能判定的问题：
//   · replay 里的正文有没有被静默丢掉；
//   · 有没有记录永远停在 `streaming: true`（会导致客户端 aria-busy 卡住、读屏静默）；
//   · 快照（boot/hydrate）与增量（append）是否一致。
//
// **为什么不测 DOM**：这一层不需要。上面三类问题全都能在协议流上判定，而这样测试不依赖
// webview、跑得快、也不会因为布局细节而脆。**布局类问题**（空白条、条目被压扁、diff 被
// 折叠、按钮化后外观错位）需要另一层"真 webview + 客户端回传 DOM dump"的测试——
// 那层没写，所以那类问题仍然只能人工验收（见 docs/dev-workflow.md 的验收清单）。
//
// **夹具从哪来**：`CUSTOMIZATIONS/scripts/capture-acp-replay.mjs` 用真实 agent 抓的。
// 协议形状变了才需要重抓；抓包脚本的用法写在该文件头。
// [CUSTOM-END] CUSTOM-20260925-054
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// [CUSTOM-20261004-184] Builds a valid file: URI for whatever platform runs the tests.
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

import type { SessionNotification } from '@agentclientprotocol/sdk';

import type { PromptResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
// [CUSTOM-20261001-156] The background-form test builds a real AskUserQuestion request.
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';

import { AgentManager } from '../core/AgentManager';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionHistoryStore } from '../core/SessionHistoryStore';
import { SessionManager, pickDefaultCwd, type SessionInfo } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
// [CUSTOM-20260930-130] The tab dot's "waiting" state is read from these two bridges.
import { PermissionBridge } from '../handlers/PermissionBridge';
import { ElicitationBridge } from '../handlers/ElicitationBridge';
import { isBlankText } from '../ui/chat/content/contentBlocks';
// [CUSTOM-20261004-184] The markdown link router under test.
import { SafeMarkdown } from '../ui/chat/markdown';
import { choiceChanges, choiceSnapshotFromState, choiceSnapshotPatched } from '../ui/chat/sessionChoices';
import { directoryKey, directoryOptions } from '../ui/chat/historyDirs';
import { panelIdForAgent } from '../ui/chat/panelContract';
import { readDiskSessions, readTranscriptTimes } from '../ui/chat/diskSessions';
import { ToolInvocationStore } from '../ui/chat/transcript/ToolInvocationStore';
import type { ChatSurface, SurfaceKey } from '../ui/chat/ChatSurface';
// [CUSTOM-20260930-124/125] `resolveAutoConnect` / `PanelPrefsIO` are exported so this
// file can drive the settings seam with a stub instead of the developer's settings.json.
import { ChatPanelHost, resolveAutoConnect, type PanelPrefsIO } from '../ui/chat/ChatPanelHost';
// [CUSTOM-20261001-156] The notification seam (see RecordingChannel).
import type { NoticeChannel } from '../ui/chat/SessionNotifier';
import { stopReasonText, turnOutcome } from '../ui/chat/ChatPanelHost';
import type { ExtToChatMessage, TranscriptSnapshotWire } from '../ui/chat/protocol';
import type { TranscriptEntry } from '../ui/chat/transcript/types';

const FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', 'src', 'test', 'fixtures', 'claude-code-session-load.json',
);

interface FixtureNotification {
  phase: string;
  turn: number;
  at: number;
  update: SessionNotification;
}

interface Fixture {
  capturedAt: string;
  agentInfo?: { name?: string; version?: string };
  sessionId: string | null;
  prompts?: string[];
  notifications: FixtureNotification[];
  error?: string | null;
}

function loadFixture(): Fixture | null {
  if (!fs.existsSync(FIXTURE_PATH)) { return null; }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

/**
 * Captures everything the host would have posted into a webview.
 *
 * A stub rather than a real `WebviewPanel` on purpose: the question here is
 * "what did the host decide to send", and a real panel would add a renderer
 * process to the loop without answering it. `ChatSurface` is a six-member
 * interface, so a faithful stub is cheap.
 */
class RecordingSurface implements ChatSurface {
  readonly key: SurfaceKey = 'view';
  readonly sent: ExtToChatMessage[] = [];
  html = '';
  reveals = 0;
  // [CUSTOM-20261001-156] Settable so a test can hide the panel behind an editor:
  // "the user is not looking at it" is now what decides card-vs-notification.
  visibleFlag = true;
  readonly webview = {
    options: {} as vscode.WebviewOptions,
    cspSource: 'vscode-webview://chat-panel-test',
    postMessage: (message: ExtToChatMessage) => {
      this.sent.push(message);
      return Promise.resolve(true);
    },
  } as unknown as vscode.Webview;

  get visible(): boolean { return this.visibleFlag; }
  setHtml(html: string): void { this.html = html; }
  reveal(): void { this.reveals++; }
  onDidDispose(): vscode.Disposable { return new vscode.Disposable(() => { /* nothing */ }); }
}

/**
 * Register a session as live without standing up an agent connection.
 *
 * `ChatPanelHost` resolves the session on every record (`getSession` for the
 * agent name, `getLiveSessions` for the tab strip). Spawning a real Claude Code
 * process just to satisfy that lookup would make this file credentialed, slow
 * and flaky — so the private maps are seeded directly. **The cast is confined to
 * this one helper on purpose**: if a second one ever appears, that is the signal
 * that the host should take its session lookup as an injected dependency
 * instead of reaching into `SessionManager`.
 */
function registerFakeSession(
  manager: SessionManager,
  sessionId: string,
  agentName: string,
  // [CUSTOM-20260930-151] 需要"这个会话有真实的 configOptions / 可用命令"的用例（草稿页快照
  // 就靠它）。字段名故意是宽松的：种的是协议形状的普通对象，不需要在测试里构造 SDK 类型。
  seed: Record<string, unknown> = {},
): Record<string, unknown> {
  const internals = manager as unknown as {
    sessions: Map<string, unknown>;
    agentSessions: Map<string, Set<string>>;
    agentProcesses: Map<string, string>;
  };
  const session: Record<string, unknown> = {
    sessionId,
    agentId: 'fake-agent-id',
    agentName,
    agentDisplayName: agentName,
    cwd: '/tmp',
    createdAt: new Date().toISOString(),
    initResponse: {},
    modes: null,
    models: null,
    configOptions: null,
    availableCommands: [],
  };
  Object.assign(session, seed);
  internals.sessions.set(sessionId, session);
  internals.agentProcesses.set(agentName, 'fake-agent-id');
  const ids = internals.agentSessions.get(agentName) ?? new Set<string>();
  ids.add(sessionId);
  internals.agentSessions.set(agentName, ids);
  // [CUSTOM-20260930-151] 返回这个对象：`loadSession` 那类"先注册、后写字段"的时序要靠调用方
  // 就地改它来复现（见下面草稿快照的用例），这样那个 cast 仍然只留在本 helper 里。
  return session;
}

/** Minimal in-memory Memento — touches no real user or workspace settings. */
class FakeMemento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] { return Array.from(this.store.keys()); }
  get<T>(key: string, fallback?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.store.delete(key); } else { this.store.set(key, value); }
    return Promise.resolve();
  }
}

interface Harness {
  host: ChatPanelHost;
  surface: RecordingSurface;
  handler: SessionUpdateHandler;
  sessionManager: SessionManager;
  sessionId: string;
  agentName: string;
  /** [CUSTOM-20260930-125] The settings seam the host was given. */
  prefs: StubPrefs;
  /** [CUSTOM-20261001-156] The notification seam the host was given. */
  notices: RecordingChannel;
}

/**
 * [CUSTOM-20261001-156] Captures the notifications the host decided to send.
 *
 * The same reason `StubPrefs`/`FakeMemento` exist: this suite must not pop real
 * VS Code notifications (the test host swallows them, so there would be nothing to
 * assert). Clicking is driven explicitly — `answer()` is what a user's click does.
 */
class RecordingChannel implements NoticeChannel {
  readonly shown: Array<{ level: string; message: string; action: string }> = [];
  private readonly resolvers: Array<(choice: string | undefined) => void> = [];

  show(level: 'info' | 'warning', message: string, action: string): Promise<string | undefined> {
    this.shown.push({ level, message, action });
    return new Promise(resolve => { this.resolvers.push(resolve); });
  }

  /** Press the action button on the n-th notification. */
  async click(index: number): Promise<void> {
    this.resolvers[index](this.shown[index].action);
    // The notifier's .then runs on a microtask; give it one turn to reach the host.
    await Promise.resolve();
  }
}

/**
 * [CUSTOM-20260930-125] Stands in for `vscode.workspace.getConfiguration`.
 *
 * The same reason `FakeMemento` exists: this suite must not read or write the developer's
 * real settings. It also makes the interesting failure reachable — a write that throws —
 * which a real configuration object will not do on demand.
 */
class StubPrefs implements PanelPrefsIO {
  readonly writes: boolean[] = [];
  failWith: Error | null = null;
  constructor(private value = false) {}
  getAutoConnect(): boolean { return this.value; }
  async setAutoConnect(value: boolean): Promise<void> {
    this.writes.push(value);
    if (this.failWith) { throw this.failWith; }
    this.value = value;
  }
}

function makeHarness(
  sessionId: string,
  agentName = 'Claude Code',
  managerFactory?: (handler: SessionUpdateHandler) => SessionManager,
  prefs = new StubPrefs(),
  // [CUSTOM-20260930-130] Optional bridges: the tab dot's "waiting" state is read from
  // them, and a test needs to be able to park a request on a session.
  bridges: { permission?: PermissionBridge; elicitation?: ElicitationBridge } = {},
  // [CUSTOM-20260930-151] Optional globalState: the draft page's option snapshot is
  // persisted there, and "survives a window reload" is only testable with one.
  globalState?: vscode.Memento,
  // [CUSTOM-20261001-162] How long a background task may stay quiet before the panel
  // stops waiting. Millisecond-scale in tests; the host's default is two minutes.
  backgroundQuietMs?: number,
): Harness {
  const handler = new SessionUpdateHandler();
  const sessionManager = managerFactory
    ? managerFactory(handler)
    : new SessionManager(new AgentManager(), new ConnectionManager(handler), handler);
  registerFakeSession(sessionManager, sessionId, agentName);
  // [CUSTOM-20261001-156] A recording notification channel: the host's default is
  // the real VS Code notification, which a test host swallows silently.
  const notices = new RecordingChannel();
  const host = new ChatPanelHost(
    vscode.Uri.file('/tmp/chat-panel-test'), sessionManager, handler,
    bridges.permission, globalState, bridges.elicitation, prefs, notices, backgroundQuietMs,
  );
  const surface = new RecordingSurface();
  host.attachSurface(surface, { agentName, sessionId });
  return { host, surface, handler, sessionManager, sessionId, agentName, prefs, notices };
}

function feed(harness: Harness, notifications: readonly FixtureNotification[]): void {
  for (const notification of notifications) {
    harness.handler.handleUpdate(notification.update);
  }
}

/**
 * Play a replay the way `SessionManager.loadSession` does: every notification,
 * then the `session-load-end` event.
 *
 * Emitting the event is part of the lifecycle, not decoration — it is what tells
 * the host the (finite) replay is over and anything still open must be closed.
 * Feeding only the notification stream would test a sequence that never happens
 * in the product.
 */
function feedReplay(harness: Harness, notifications: readonly FixtureNotification[]): void {
  feed(harness, notifications);
  harness.sessionManager.emit('session-load-end', harness.sessionId, harness.agentName, true);
}

function phaseOf(fixture: Fixture, phase: string): FixtureNotification[] {
  return fixture.notifications.filter(n => n.phase === phase);
}

// --- 协议流 → 记录（判据用，不是渲染器的复制品）---------------------------
// 这是一个**极简**的归约：只为了把文本取出来做断言。它刻意不模仿任何布局或补丁细节，
// 所以它不会随客户端渲染逻辑漂移；如果哪天它需要"也处理一下样式"，那说明测错了层。

interface TranscriptState {
  entries: TranscriptEntry[];
  patched: Map<string, Partial<TranscriptEntry>>;
}

function reduce(sent: readonly ExtToChatMessage[]): TranscriptState {
  let entries: TranscriptEntry[] = [];
  const patched = new Map<string, Partial<TranscriptEntry>>();
  for (const message of sent) {
    if (message.type === 'boot' || message.type === 'focus') {
      // A snapshot REPLACES the transcript (the client hydrates), so the model
      // does too — including the `null` case, which resets to empty.
      const snapshot = (message as { snapshot: TranscriptSnapshotWire | null }).snapshot;
      entries = snapshot ? [...snapshot.entries] : [];
    } else if (message.type === 'append') {
      entries.push(...message.entries);
    } else if (message.type === 'revise') {
      patched.set(message.entryId, { ...(patched.get(message.entryId) ?? {}), ...message.patch });
    }
  }
  return { entries, patched };
}

/**
 * Flush the coalescing queue, then read the state a client would be showing.
 *
 * The host batches non-structural messages (`append` / `revise` / `toolUpdate`)
 * through `Outbox` and only flushes on a 16ms timer or right before a structural
 * message. A synchronous test therefore sees an EMPTY append stream unless it
 * forces a flush — which is a property of the test, not a bug in the host.
 *
 * `onFocusChanged` is used as the flush because it is public and, more
 * importantly, because it is **exactly what the path under test produces**: a
 * fresh `focus` snapshot is what re-opening or re-focusing a session gives the
 * client. So this asserts "what a re-open would show", which is the reported
 * symptom verbatim.
 */
function settle(harness: Harness, agentName: string, sessionId: string): TranscriptState {
  harness.host.onFocusChanged({ agentName, sessionId });
  return reduce(harness.surface.sent);
}

/** Entry text with any `revise` patches applied, as the client would show it. */
function visibleText(state: TranscriptState): string {
  return state.entries
    .map(entry => {
      const patch = state.patched.get(entry.id) as { text?: string } | undefined;
      return patch?.text ?? textOfEntry(entry);
    })
    .join('\n');
}

function textOfEntry(entry: TranscriptEntry): string {
  const withText = entry as { text?: string };
  return typeof withText.text === 'string' ? withText.text : '';
}

/** Non-blank prose the agent sent in one phase, in order. */
function proseChunks(notifications: readonly FixtureNotification[]): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  for (const n of notifications) {
    const update = (n.update as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update;
    const kind = update?.sessionUpdate;
    if (kind !== 'agent_message_chunk' && kind !== 'user_message_chunk') { continue; }
    const content = update?.content;
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
    if (text.trim().length === 0) { continue; }
    out.push({ kind: kind === 'user_message_chunk' ? 'user' : 'assistant', text });
  }
  return out;
}

function kindHistogram(notifications: readonly FixtureNotification[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of notifications) {
    const kind = (n.update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ?? '?';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** Entries still marked as streaming — the client never gets a finalize for these. */
function danglingStreaming(state: TranscriptState): string[] {
  return state.entries
    .filter(e => (e as { streaming?: boolean }).streaming === true)
    .map(e => `${e.kind}:${e.id}`);
}

// --- 测试 ----------------------------------------------------------------

// Loaded once at module scope: both suites use it, and a missing fixture should
// produce one clear failure rather than a confusing one per test.
const fixture = loadFixture();

// --- 每会话工作目录（CUSTOM-20260925-057）---------------------------------

suite('chat panel: default working directory policy', () => {
  const WS = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
  const PROC = process.platform === 'win32' ? 'C:\\process' : '/process';
  const EXISTS = (p: string) => p === WS;
  const REL = process.platform === 'win32' ? 'relative\\dir' : 'relative/dir';

  // The chain exists because `acpc.defaultWorkingDirectory` was declared in
  // package.json and read by NOTHING — the same "declared but never wired"
  // shape as `acpc.turnInProgress` (pitfalls #5). These cases pin the policy.

  test('an unset setting falls through to the workspace folder', () => {
    assert.deepStrictEqual(pickDefaultCwd(undefined, WS, PROC, EXISTS), { cwd: WS, reason: 'workspace' });
    assert.deepStrictEqual(pickDefaultCwd('   ', WS, PROC, EXISTS), { cwd: WS, reason: 'workspace' });
  });

  test('no workspace folder at all falls through to process.cwd()', () => {
    assert.deepStrictEqual(pickDefaultCwd(undefined, undefined, PROC, EXISTS), { cwd: PROC, reason: 'process' });
  });

  test('a valid absolute directory wins', () => {
    assert.deepStrictEqual(pickDefaultCwd(WS, undefined, PROC, EXISTS), { cwd: WS, reason: 'configured' });
  });

  test('a RELATIVE setting is rejected rather than resolved by the extension host', () => {
    // A relative path would be resolved against the extension host's cwd, which
    // the user cannot see — so it must never reach session/new.
    const decision = pickDefaultCwd(REL, WS, PROC, EXISTS);
    assert.strictEqual(decision.cwd, WS);
    assert.strictEqual(decision.ignoredConfigured, 'relative');
  });

  test('a setting pointing at something that is not a directory is rejected', () => {
    const missing = pickDefaultCwd(`${WS}-nope`, WS, PROC, EXISTS);
    assert.strictEqual(missing.cwd, WS);
    assert.strictEqual(missing.ignoredConfigured, 'missing');
  });
});

suite('chat panel: recent directories for the picker', () => {
  const entry = (agentName: string, cwd: string, sessionId: string, lastActiveAt: string) => ({
    agentName, cwd, sessionId, createdAt: lastActiveAt, lastActiveAt,
  });

  function storeWith(entries: unknown[]): SessionHistoryStore {
    const memento = new FakeMemento();
    // Seeded through the store's own persisted shape (and its deliberate
    // Memento key, see pitfall #4) so we control the timestamps exactly —
    // `upsertNew` stamps "now", which would make ordering assertions flaky.
    void memento.update('acp.sessionHistory.v1', { version: 1, entries });
    return new SessionHistoryStore(memento as unknown as vscode.Memento);
  }

  test('directories are de-duplicated and most-recently-active first', () => {
    const store = storeWith([
      entry('Claude Code', '/a', 's1', '2026-01-01T00:00:00Z'),
      entry('Claude Code', '/b', 's2', '2026-03-01T00:00:00Z'),
      entry('Claude Code', '/a', 's3', '2026-02-01T00:00:00Z'),
    ]);
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/b', '/a']);
  });

  test('other agents and entries without a cwd are excluded', () => {
    const store = storeWith([
      entry('Claude Code', '/a', 's1', '2026-01-01T00:00:00Z'),
      entry('GitHub Copilot', '/elsewhere', 's2', '2026-09-01T00:00:00Z'),
      entry('Claude Code', '', 's3', '2026-09-01T00:00:00Z'),
    ]);
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/a']);
  });
});

suite('chat panel: isBlankText polarity', () => {
  // [CUSTOM-20260925-055] This one-line predicate shipped INVERTED for a day
  // (CUSTOM-20260924-026 → 055) and every automated check stayed green, because
  // nothing about a swapped `return true` / `return false` is visible to the
  // compiler — and its name made the wrong behaviour look right. These cases are
  // the cheapest possible guard against a repeat.
  //
  // Zero-width characters are built with String.fromCharCode on purpose: pasting
  // them into the source as literals makes the file unreadable and is exactly
  // what pitfalls #12 is about.
  const ZWSP = String.fromCharCode(0x200b);
  const BOM = String.fromCharCode(0xfeff);
  const WORD_JOINER = String.fromCharCode(0x2060);

  test('empty-ish input is blank', () => {
    assert.strictEqual(isBlankText(''), true);
    assert.strictEqual(isBlankText(undefined), true);
    assert.strictEqual(isBlankText(null), true);
  });

  test('whitespace-only is blank', () => {
    assert.strictEqual(isBlankText(' '), true);
    assert.strictEqual(isBlankText('\n\n'), true);
    assert.strictEqual(isBlankText('\t \r\n'), true);
  });

  test('zero-width characters alone are blank', () => {
    assert.strictEqual(isBlankText(ZWSP), true);
    assert.strictEqual(isBlankText(BOM), true);
    assert.strictEqual(isBlankText(WORD_JOINER), true);
    assert.strictEqual(isBlankText(ZWSP + BOM + WORD_JOINER + '\n'), true);
  });

  test('anything a reader can see is NOT blank', () => {
    assert.strictEqual(isBlankText('a'), false);
    assert.strictEqual(isBlankText(' a '), false);
    assert.strictEqual(isBlankText('| File | Lines |'), false);
    assert.strictEqual(isBlankText('\n\nThree files in this directory'), false);
    assert.strictEqual(isBlankText(ZWSP + 'x'), false);
  });

  test('every real prose chunk in the captured replay is NOT blank', function () {
    // Ground truth rather than invented cases: these are the exact strings whose
    // misclassification dropped assistant prose and thoughts from every
    // re-opened session.
    if (!fixture) { return this.skip(); }
    const chunks = proseChunks(fixture.notifications);
    assert.ok(chunks.length > 0, 'fixture carried no prose to check');
    for (const chunk of chunks) {
      assert.strictEqual(
        isBlankText(chunk.text), false,
        `a real ${chunk.kind} chunk was classified as blank: `
        + JSON.stringify(chunk.text.slice(0, 60)),
      );
    }
  });
});

suite('chat panel: history picker carries the session directory', () => {
  // [CUSTOM-20260925-057] The picker shows sessions from OTHER directories (it
  // is the agent's list, not this workspace's). Until this change the host had
  // nothing to hand the agent but the current workspace, so a session belonging
  // to `D:\some\other\project` was reopened as if it lived here.

  /** A recording subclass, not a hand-written double: everything else stays the
   *  real implementation (and returns 'live' so nothing reaches the wire). */
  class RecordingSessionManager extends SessionManager {
    readonly opened: Array<{ agentName: string; sessionId: string; cwd?: string; title?: string }> = [];
    override async openExistingSession(
      agentName: string,
      sessionId: string,
      opts: { cwd?: string; title?: string } = {},
    ): Promise<'live' | 'load' | 'resume'> {
      this.opened.push({ agentName, sessionId, cwd: opts.cwd, ...(opts.title ? { title: opts.title } : {}) });
      return 'live';
    }
  }

  function harnessWithRecorder(): { harness: Harness; manager: RecordingSessionManager } {
    let manager!: RecordingSessionManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new RecordingSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    return { harness, manager };
  }

  /** [CUSTOM-20260928-100] The open is no longer the handler's first await — the host
   *  reads the transcript timeline before replaying — so a single microtask is not
   *  enough: wait for the effect instead. */
  async function waitForOpen(manager: RecordingSessionManager): Promise<void> {
    for (let i = 0; i < 100 && manager.opened.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  test("a session's own directory is passed through to the open call", async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      cwd: 'D:\\other\\project',
    });
    await Promise.resolve();
    await waitForOpen(manager);
    assert.deepStrictEqual(manager.opened, [
      { agentName: 'Claude Code', sessionId: 'other-session', cwd: 'D:\\other\\project' },
    ]);
  });

  test('an omitted directory stays undefined, so loadSession can fall back to the cache', async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 's' });
    await waitForOpen(manager);
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].cwd, undefined);
  });

  test('the title travels with the open call, so the tab matches the list', async function () {
    // [CUSTOM-20260928-098] The replay does not always re-send session_info_update,
    // so the title must ride along with the click — otherwise the tab shows the id
    // prefix while the picker showed the name.
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      title: 'The session name',
    });
    await waitForOpen(manager);
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].title, 'The session name');
  });

  test('picking a history session replaces the focused tab instead of adding one', async function () {
    // [CUSTOM-20260928-099] Reported: every visit to the history list added another
    // tab ("还是会自动新建并切换到新 session"). A history list is navigation — the
    // session being left steps aside so the picked one takes its place.
    class ReplacingManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: ReplacingManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ReplacingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'other-session' });

    for (let i = 0; i < 100 && manager.closed.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(manager.closed, ['dummy-session'],
      'the focused session must step aside so the tab count does not grow');
  });

  test('a history session that is already a tab is focused, nothing closes', async function () {
    // The other half: there is nothing to replace when the pick is already live —
    // closing it would be destroying the tab the user just clicked.
    class ReplacingManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: ReplacingManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ReplacingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    registerFakeSession(harness.sessionManager, 'other-session', 'Claude Code');
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'other-session' });

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepStrictEqual(manager.closed, [], 'an already-live pick must not close anything');
  });
});

suite('chat panel: opening a history session while disconnected', () => {
  // [CUSTOM-20260926-083] Reported: before connecting anything, the history picker
  // listed sessions ("3 sessions · from the local cache" — by design, the cache is
  // readable offline) and every click answered
  //   Agent "Claude Code" does not support loading or resuming sessions.
  // Capabilities come from the ACP `initialize` handshake, so an agent that was never
  // connected has NONE — and the old code read that as "unsupported".
  //
  // The REAL `openExistingSession` runs here (only the ACP boundary is faked): that is
  // where the decision lives, and both the panel's picker and the tree's
  // `acpc.openSession` command go through it.

  /** Records the order of the calls; capabilities appear only after connecting. */
  class ConnectOnDemandManager extends SessionManager {
    readonly calls: string[] = [];
    private connected = false;

    override async ensureConnected(agentName: string): Promise<any> {
      this.calls.push(`ensureConnected:${agentName}`);
      this.connected = true;
      return {} as any;
    }

    override getCachedCapabilities(): any {
      return this.connected ? { load: true, resume: true } : undefined;
    }

    override async loadSession(agentName: string, sessionId: string, requestedCwd?: string): Promise<any> {
      this.calls.push(`loadSession:${sessionId}:${requestedCwd ?? ''}`);
      return {} as any;
    }
  }

  async function settle(manager: { calls: string[] }, expected: number): Promise<void> {
    for (let i = 0; i < 100 && manager.calls.length < expected; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  test('the click connects first, then loads the session with its own directory', async () => {
    let manager!: ConnectOnDemandManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ConnectOnDemandManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'old-session', cwd: 'D:\\old',
    });
    await settle(manager, 2);

    assert.deepStrictEqual(manager.calls, [
      'ensureConnected:Claude Code',       // capabilities are unknowable without this
      'loadSession:old-session:D:\\old',   // and the session's OWN directory is used
    ]);
    assert.strictEqual(
      harness.surface.sent.filter(m => m.type === 'error').length, 0,
      'no error notice: the agent supports session/load, we just had to ask it',
    );
  });

  test('an agent that genuinely cannot replay still reports the error, after connecting', async () => {
    // The guard that must survive: connecting must not turn a real capability gap into
    // a silent no-op.
    class UnsupportedManager extends ConnectOnDemandManager {
      override getCachedCapabilities(): any { return {}; }
    }
    let manager!: UnsupportedManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new UnsupportedManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'old-session' });
    await settle(manager, 1);
    for (let i = 0; i < 100 && harness.surface.sent.filter(m => m.type === 'error').length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.deepStrictEqual(manager.calls, ['ensureConnected:Claude Code'], 'no load was attempted');
    const errors = harness.surface.sent.filter(m => m.type === 'error') as Array<{ message?: string }>;
    assert.strictEqual(errors.length, 1);
    assert.ok(/does not support/.test(errors[0].message ?? ''), errors[0].message);
  });
});

suite('chat panel: draft page creates the session on first send', () => {
  // [CUSTOM-20260925-058] The draft page exists so that the directory is chosen
  // BEFORE a session exists. That has two host-side consequences worth pinning:
  // the chosen directory must reach `createSession`, and a failure must leave the
  // draft alone (the client keeps the tab and the typed text).

  class DraftSessionManager extends SessionManager {
    readonly created: Array<{ agentName: string; cwd?: string }> = [];
    readonly sent: Array<{ sessionId: string; prompt: unknown }> = [];
    readonly ensured: string[] = [];
    failCreateWith: string | null = null;
    // [CUSTOM-20260930-151] The session the draft creates carries a real config-option list
    // (the draft's picks are validated against it), and the applies are recorded in order with
    // the send — "before the first message" is the whole point of applying them there.
    configOptionsForNew: unknown[] | null = null;
    readonly applied: Array<{ configId: string; value: string }> = [];
    readonly order: string[] = [];
    failApplyWith: string | null = null;

    override async ensureConnected(agentName: string): Promise<ConnectionInfo> {
      this.ensured.push(agentName);
      return {} as ConnectionInfo;
    }

    override async createSession(
      agentName: string,
      opts: { focus?: boolean; cwd?: string } = {},
    ): Promise<SessionInfo> {
      if (this.failCreateWith) { throw new Error(this.failCreateWith); }
      this.created.push({ agentName, cwd: opts.cwd });
      const sessionId = `draft-session-${this.created.length}`;
      registerFakeSession(this, sessionId, agentName, { configOptions: this.configOptionsForNew });
      return {
        sessionId,
        agentId: 'fake-agent-id',
        agentName,
        agentDisplayName: agentName,
        cwd: opts.cwd ?? '',
        createdAt: new Date().toISOString(),
        initResponse: {},
        modes: null,
        models: null,
        configOptions: this.configOptionsForNew,
        availableCommands: [],
      } as unknown as SessionInfo;
    }

    override async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
      if (this.failApplyWith) { throw new Error(this.failApplyWith); }
      this.applied.push({ configId, value });
      this.order.push(`apply:${configId}=${value}`);
      // Mirror the real one: the agent's response IS the new option list, and the host's switch
      // baseline is read back from it. A stub that does not write it would make the "applying a
      // draft pick must not announce a switch" invariant untestable (and untrue in the test).
      const options = (this.getSession(sessionId)?.configOptions ?? []) as Array<Record<string, unknown>>;
      const next = options.map(option => (option.id === configId ? { ...option, currentValue: value } : option));
      this.applyConfigOptions(sessionId, next as unknown as SessionConfigOption[]);
      return next as unknown as SessionConfigOption[];
    }

    override async sendPrompt(sessionId: string, prompt: unknown): Promise<PromptResponse> {
      this.sent.push({ sessionId, prompt });
      this.order.push('send');
      return { stopReason: 'end_turn' } as PromptResponse;
    }
  }

  /** The host's handlers are async and fire-and-forget; wait for their effects. */
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  function draftHarness(memento?: FakeMemento): { harness: Harness; manager: DraftSessionManager } {
    let manager!: DraftSessionManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new DraftSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    }, new StubPrefs(), {}, memento as unknown as vscode.Memento | undefined);
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  function messagesOf(harness: Harness, type: string): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === type) as Array<Record<string, unknown>>;
  }

  test('the chosen directory reaches createSession, then the prompt is sent', async function () {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/chosen/dir', text: 'hello',
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.created, [{ agentName: 'Claude Code', cwd: '/chosen/dir' }]);
    assert.strictEqual(manager.sent.length, 1, 'exactly one prompt');
    assert.strictEqual(manager.sent[0].sessionId, 'draft-session-1');

    const resolved = messagesOf(harness, 'draftResolved');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].draftId, 'd1');
    assert.strictEqual(resolved[0].sessionId, 'draft-session-1');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0);
  });

  // [CUSTOM-20261005-193] 草稿页粘的图必须**跟着首条消息进 agent**。
  // 用户报的是"New Session 的输入框没法粘贴图片"—— 以前客户端在"没有会话"处就拒了，
  // 而现在图先本地攒着、随 createDraftAndSend 交上来，宿主建完会话再走**同一条**附件通道。
  test('an image pasted on the draft page rides into the first prompt', async () => {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/dir', text: '看看这张图',
      images: [{ id: 'img-1', name: 'pasted.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const blocks = manager.sent[0].prompt as Array<Record<string, unknown>>;
    assert.deepStrictEqual(blocks.map(b => b.type), ['text', 'image'],
      'the image rides with the very first prompt, not a second turn');
    assert.strictEqual(blocks[1].data, 'QUJD', 'the data URL prefix is stripped before the wire');
    assert.strictEqual(blocks[1].mimeType, 'image/png');
    // 面板要被通知到（与普通 attachImage 同一条通道）。注意会有两条：一条是落账、
    // 一条是 handleSendPrompt 发完把附件清空（`attachments: []`）—— 所以看第一条。
    const attachmentMsgs = messagesOf(harness, 'attachments');
    assert.ok(attachmentMsgs.length >= 1, 'the panel is told about the attachment');
    const listed = attachmentMsgs[0].attachments as Array<Record<string, unknown>>;
    assert.deepStrictEqual(listed.map(a => a.path), ['img-1'],
      'and it is the same shape a normal attachImage produces (path = the image id)');
  });

  test('an image with no text is a valid draft send', async () => {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: '   ',
      images: [{ id: 'img-2', name: 'p.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0,
      'an attachment alone is something to send (the client allows it too)');
  });

  test('an empty draft is refused without creating anything', async function () {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: '   ',
    });
    await waitFor(() => messagesOf(harness, 'draftFailed').length > 0, 'draftFailed');
    assert.deepStrictEqual(manager.created, [], 'no session may be created for an empty draft');
    assert.strictEqual(messagesOf(harness, 'draftResolved').length, 0);
  });

  test('a failed creation reports back and does NOT resolve the draft', async function () {
    const { harness, manager } = draftHarness();
    manager.failCreateWith = 'agent would not start';
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd3', cwd: '/dir', text: 'hello',
    });
    await waitFor(() => messagesOf(harness, 'draftFailed').length > 0, 'draftFailed');

    const failed = messagesOf(harness, 'draftFailed')[0];
    assert.strictEqual(failed.draftId, 'd3');
    assert.match(String(failed.message), /agent would not start/);
    // The client keeps the draft AND its typed text on this path.
    assert.strictEqual(messagesOf(harness, 'draftResolved').length, 0);
  });

  test('directory choices carry the workspace folders, recents and the default', async function () {
    const { harness } = draftHarness();
    harness.host.onMessage({ type: 'listDirectoryChoices' });
    await waitFor(() => messagesOf(harness, 'directoryChoices').length > 0, 'directoryChoices');

    const reply = messagesOf(harness, 'directoryChoices')[0];
    assert.ok(Array.isArray(reply.workspaceFolders), 'workspaceFolders must be an array');
    assert.ok(Array.isArray(reply.recent), 'recent must be an array');
    assert.strictEqual(typeof reply.defaultCwd, 'string');
    assert.ok((reply.defaultCwd as string).length > 0, 'the default must never be empty');
  });

  test('connect only ensures the process — it does not create a session', async function () {
    // Creating one here would leave an empty session in the agent's history for a
    // user who only wanted to check that the agent starts.
    const { harness, manager } = draftHarness();
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => manager.ensured.length > 0, 'ensureConnected');
    assert.deepStrictEqual(manager.ensured, ['Claude Code']);
    assert.deepStrictEqual(manager.created, [], 'connect must not create a session');
  });

  // [CUSTOM-20260930-151] 草稿页的输入卡要"显示完整"（模式/模型/斜杠命令）。这些在 ACP 里
  // 都是**会话级**的（`session/new` 没有 mode/model 入参），草稿按定义还没有会话 —— 所以宿主
  // 回的是「该 agent 上一次会话的快照」。钉住三条：没有快照也必须回话、快照跟着会话走、
  // 快照跨窗口重载存活（否则全新窗口点「+」时输入卡还是空的，那正是用户报的现象）。
  const SNAPSHOT_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'plan',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
  ];

  function seedAgentOptions(manager: SessionManager, sessionId: string, options: unknown[]): void {
    registerFakeSession(manager, sessionId, 'Claude Code', {
      configOptions: options,
      availableCommands: [{ name: 'compact', description: 'Compact the conversation', input: { hint: 'what to keep' } }],
    });
    // The host learns the snapshot from these two events (it subscribes to both).
    manager.emit('config-options-changed', sessionId);
    manager.emit('available-commands-changed', sessionId);
  }

  test('with no known snapshot the reply is empty — but it IS a reply', function () {
    const { harness } = draftHarness();
    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd1' });

    const replies = messagesOf(harness, 'draftOptions');
    assert.strictEqual(replies.length, 1, 'the client waits for this reply (pitfall #29)');
    assert.strictEqual(replies[0].draftId, 'd1');
    assert.strictEqual(replies[0].agentName, 'Claude Code');
    assert.deepStrictEqual(replies[0].configOptions, []);
    assert.deepStrictEqual(replies[0].availableCommands, []);
  });

  test('the snapshot is the agent\'s last session, commands included', function () {
    const { harness, manager } = draftHarness();
    seedAgentOptions(manager, 'seeded-session', SNAPSHOT_OPTIONS);

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd2' });
    const reply = messagesOf(harness, 'draftOptions')[0];
    assert.deepStrictEqual(reply.configOptions, SNAPSHOT_OPTIONS);
    assert.deepStrictEqual(reply.availableCommands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'what to keep' },
    ]);
  });

  test('the snapshot survives a window reload (globalState)', function () {
    const memento = new FakeMemento();
    const first = draftHarness(memento);
    seedAgentOptions(first.manager, 'seeded-session', SNAPSHOT_OPTIONS);

    // A reloaded window: no live session carries these options any more, only globalState.
    const second = draftHarness(memento);
    second.harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd3' });
    assert.deepStrictEqual(
      messagesOf(second.harness, 'draftOptions')[0].configOptions, SNAPSHOT_OPTIONS,
      'a fresh window must still be able to render the full composer');
  });

  test('opening a history session does not empty the snapshot (load writes its options late)', function () {
    const { harness, manager } = draftHarness();
    // `loadSession` registers the placeholder FIRST, emits `session-created`, and only writes
    // the response's configOptions afterwards — and it does not go through
    // `applyConfigOptions`. Missing the second read leaves the draft page with no pickers right
    // after the user opened a history session, which is the reported symptom all over again.
    const placeholder = registerFakeSession(manager, 'loading-session', 'Claude Code');
    manager.emit('session-created', 'loading-session');
    placeholder.configOptions = SNAPSHOT_OPTIONS;
    manager.emit('session-load-end', 'loading-session', 'Claude Code', true);

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-load' });
    assert.deepStrictEqual(messagesOf(harness, 'draftOptions')[0].configOptions, SNAPSHOT_OPTIONS);
  });

  test('an empty list does not displace a good snapshot (resume reports no commands)', function () {
    const { harness, manager } = draftHarness();
    seedAgentOptions(manager, 'with-options', SNAPSHOT_OPTIONS);
    // `resumeSession` returns `availableCommands: []` and never replays, so taking its empty
    // answer at face value would erase the slash list — a "degenerated" snapshot is worse than
    // a stale one, because stale only means "a value that gets skipped when the session exists".
    registerFakeSession(manager, 'resumed-session', 'Claude Code', { configOptions: SNAPSHOT_OPTIONS });
    manager.emit('session-created', 'resumed-session');

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-resume' });
    const reply = messagesOf(harness, 'draftOptions')[0];
    assert.deepStrictEqual(reply.configOptions, SNAPSHOT_OPTIONS);
    assert.deepStrictEqual(reply.availableCommands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'what to keep' },
    ]);
  });

  // --- 阶段 3：草稿上选的值怎么落到新建的会话上 ---------------------------------
  // [CUSTOM-20260930-151] 会话存在之前没有地方可下发，所以选择随 createDraftAndSend 一起走，
  // 并在首条消息**之前**应用。三条边界：陈旧的选项要跳过、单项失败不能挡住发消息、应用本身
  // 不能被当成一次"切换"播报出来。

  const NEW_SESSION_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'model', name: 'Model', description: 'AI model to use', category: 'model',
      type: 'select', currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
    },
  ];

  /** Every notice text the host appended to a session (read through the coalescing queue). */
  function noticesOf(harness: Harness): string[] {
    const out: string[] = [];
    for (const message of messagesOf(harness, 'append')) {
      for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
        if (entry.kind === 'notice') { out.push(String(entry.text)); }
      }
    }
    return out;
  }

  test('the picks are applied to the new session BEFORE its first message', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/dir', text: 'hello',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.applied, [{ configId: 'mode', value: 'plan' }]);
    assert.deepStrictEqual(manager.order, ['apply:mode=plan', 'send'],
      'the first turn has to run with what the draft page showed');
  });

  test('a value this session no longer offers is skipped, and the message still goes out', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: 'hi',
      configSelections: [
        { configId: 'mode', value: 'plan' },
        { configId: 'ghost', value: 'x' },
        { configId: 'model', value: 'haiku-9000' },
      ],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.applied, [{ configId: 'mode', value: 'plan' }],
      'only the pick this session still recognises may be sent to the agent');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0);
  });

  test('a pick the agent rejects is reported, not silently snapped back', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    manager.failApplyWith = 'agent refused';
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd3', cwd: '/dir', text: 'hi',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    await waitFor(() => noticesOf(harness).length > 0, 'the failure notice');

    assert.match(noticesOf(harness)[0], /Mode/);
    assert.strictEqual(manager.sent.length, 1, 'a failed pick must not block the message');
  });

  test('applying the picks is not announced as a switch the user never made', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd4', cwd: '/dir', text: 'hi',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    const sessionId = manager.sent[0].sessionId;

    // The agent then reports the state we just applied — the usual `config_option_update`.
    harness.handler.handleUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: (manager.getSession(sessionId)?.configOptions ?? []),
      } as unknown as SessionNotification['update'],
    });
    await new Promise(resolve => setTimeout(resolve, 40));   // let the coalescing queue flush
    assert.deepStrictEqual(noticesOf(harness), [],
      'the session started in that mode; the user never switched to it');
  });
});

suite('chat panel: unread marker for background sessions', () => {
  // [CUSTOM-20260925-063] The marker lives on the HOST (it alone knows both "which
  // session got output" and "which one is focused"), so it is observable from the
  // protocol stream — no DOM needed.

  const chunk = (sessionId: string, text: string): FixtureNotification => ({
    phase: 'live',
    turn: 1,
    at: Date.now(),
    update: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    } as unknown as SessionNotification,
  });

  interface SummaryWire { sessionId: string; unread: boolean }

  function summaries(harness: Harness): SummaryWire[] {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as { type?: string; sessions?: SummaryWire[] };
      if (message.type === 'sessionsChanged') { return message.sessions ?? []; }
    }
    return [];
  }

  test('output on a BACKGROUND session marks it unread; focusing clears it', function () {
    const harness = makeHarness('session-A', 'Claude Code');
    registerFakeSession(harness.sessionManager, 'session-B', 'Claude Code');
    harness.surface.sent.length = 0;

    harness.handler.handleUpdate(chunk('session-B', 'output while you were away').update);

    const marked = summaries(harness).find(s => s.sessionId === 'session-B');
    assert.ok(marked, 'sessionsChanged must mention session B');
    assert.strictEqual(marked.unread, true,
      'output on a non-focused session must mark it unread — and the strip has to be '
      + 'told, which only happens if refreshSessions includes unread in its signature');

    // Focusing it consumes the marker.
    harness.sessionManager.emit('active-session-changed', 'session-B', 'Claude Code');
    const afterFocus = summaries(harness).find(s => s.sessionId === 'session-B');
    assert.strictEqual(afterFocus?.unread, false, 'focusing a session must clear its unread marker');
  });

  test('output on the FOCUSED session is never unread', function () {
    const harness = makeHarness('session-A', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate(chunk('session-A', 'this is the one you are watching').update);
    const focused = summaries(harness).find(s => s.sessionId === 'session-A');
    assert.strictEqual(focused?.unread, false);
  });
});

suite('chat panel: real session/load replay', () => {

  test('fixture exists and covers both phases', function () {
    if (!fixture) {
      // 夹具缺失时给出可操作的信息，而不是一个看不懂的失败。
      assert.fail(
        `missing fixture ${FIXTURE_PATH} — regenerate it with:\n`
        + '  node CUSTOMIZATIONS/scripts/capture-acp-replay.mjs',
      );
    }
    if (fixture.error) {
      assert.fail(`fixture was captured with an error: ${fixture.error}`);
    }
    assert.ok(fixture.notifications.length > 0, 'fixture has no notifications');
    assert.ok(phaseOf(fixture, 'replay').length > 0, 'fixture has no replay notifications');
    assert.ok(
      fixture.agentInfo?.name !== undefined,
      'fixture does not name the agent it was captured from',
    );
  });

  test('replay: no prose from the agent is silently dropped', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const replay = phaseOf(fixture, 'replay');
    const chunks = proseChunks(replay);
    assert.ok(chunks.length > 0, 'replayed stream carried no prose at all');

    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, replay);
    const state = settle(harness, 'Claude Code', fixture.sessionId);
    const transcript = visibleText(state);

    for (const chunk of chunks) {
      const needle = chunk.text.trim();
      assert.ok(
        transcript.includes(needle),
        `${chunk.kind} prose missing from a re-opened transcript: ${JSON.stringify(needle.slice(0, 90))}\n`
        + `the replay carried ${chunks.length} prose chunks; the transcript has `
        + `${state.entries.length} records: ${state.entries.map(e => e.kind).join(',')}`,
      );
    }
  });

  test('replay: no entry is left dangling as streaming', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, phaseOf(fixture, 'replay'));
    const dangling = danglingStreaming(settle(harness, 'Claude Code', fixture.sessionId));
    assert.deepStrictEqual(
      dangling, [],
      'records stayed streaming after the replay — the client keeps them in the '
      + 'streaming state (and aria-busy stays true, muting the screen reader)',
    );
  });

  test('live: no prose is dropped either (control)', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const live = phaseOf(fixture, 'live');
    const chunks = proseChunks(live);
    const harness = makeHarness(fixture.sessionId);
    feed(harness, live);
    const transcript = visibleText(settle(harness, 'Claude Code', fixture.sessionId));
    for (const chunk of chunks) {
      assert.ok(
        transcript.includes(chunk.text.trim()),
        `live prose missing: ${JSON.stringify(chunk.text.trim().slice(0, 90))}`,
      );
    }
  });

  test('snapshot agrees with the incremental stream', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, phaseOf(fixture, 'replay'));
    const appended = settle(harness, 'Claude Code', fixture.sessionId).entries.length;
    assert.ok(appended > 0, 'the replay produced no records at all');

    // A second surface attaching gets a fresh `boot` snapshot of the same
    // session: everything the incremental stream produced must be in it (INV-E
    // says the queue is flushed first, so the snapshot cannot be behind).
    const second = new RecordingSurface();
    harness.host.attachSurface(second, { agentName: 'Claude Code', sessionId: fixture.sessionId });
    const boot = second.sent.find(m => m.type === 'boot') as
      { snapshot: TranscriptSnapshotWire | null } | undefined;
    assert.ok(boot, 'attaching a second surface produced no boot message');
    const snapshotted = boot.snapshot?.entries.length ?? 0;
    assert.ok(
      snapshotted >= appended,
      `snapshot has ${snapshotted} entries but the stream delivered ${appended} `
      + '— a re-open would show less than the live view (the reported symptom)',
    );
  });

  test('diagnostic: live vs replay shape', function () {
    if (!fixture) { this.skip(); }
    const live = kindHistogram(phaseOf(fixture, 'live'));
    const replay = kindHistogram(phaseOf(fixture, 'replay'));
    // Printed unconditionally: when a "re-open looks different" report comes in,
    // this table is the first thing worth looking at — it says whether the AGENT
    // replayed the content or whether WE dropped it.
    console.log('[chat-panel-test] notification shapes');
    console.log('  live  :', JSON.stringify(live));
    console.log('  replay:', JSON.stringify(replay));
    console.log('  agent :', fixture.agentInfo?.name, fixture.agentInfo?.version);
    assert.ok(Object.keys(live).length > 0 && Object.keys(replay).length > 0);
  });
});

suite('chat panel: switch snapshot diff (model / mode / options)', () => {
  // [CUSTOM-20260926-073] All of the switch-notice judgement lives in
  // src/ui/chat/sessionChoices.ts; ChatPanelHost only caches snapshots and posts the
  // line (see syncChoices). These cases pin the diff against the REAL ACP payload
  // shapes, including the rule that is easiest to get wrong: one switch is reported
  // twice — once by our own setter, once by the agent's `config_option_update` — and
  // the second report must diff to nothing.
  const CONFIG_OPTIONS: any[] = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'deepseek-v4-pro[1m]',
      options: [
        { value: 'deepseek-v4-pro[1m]', name: 'deepseek-v4-pro[1M]' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    },
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
      currentValue: 'high',
      // Grouped shape: ACP allows one level of grouping, and the label lives inside.
      options: [{ group: 'levels', name: 'Levels', options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] }],
    },
  ];
  const MODES = {
    currentModeId: 'default',
    availableModes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }],
  };

  /** The same option list with one option's value replaced. */
  function withValue(id: string, value: string): any[] {
    return CONFIG_OPTIONS.map(option => (option.id === id ? { ...option, currentValue: value } : option));
  }

  test('a model switch reads like the reference implementation', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('model', 'sonnet'));
    assert.deepStrictEqual(choiceChanges(before, after), ['Switched to Sonnet']);
  });

  test('a mode switch is labelled the same way whether it arrives as a mode or as an option', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    // (a) An agent that expresses modes ONLY through `session.modes` (no mode option at
    // all): the fallback branch still has to work.
    const withoutModeOption = CONFIG_OPTIONS.filter(option => option.id !== 'mode');
    assert.deepStrictEqual(
      choiceChanges(
        choiceSnapshotFromState(MODES, withoutModeOption),
        choiceSnapshotFromState({ ...MODES, currentModeId: 'plan' }, withoutModeOption),
      ),
      ['Switched to Plan mode'],
    );
    // (b) Through a config option with category 'mode' — which is how Claude Code
    // reports it. The reader must not be able to tell which channel was used.
    assert.deepStrictEqual(
      choiceChanges(before, choiceSnapshotFromState(MODES, withValue('mode', 'plan'))),
      ['Switched to Plan mode'],
    );
  });

  test('an option with no model/mode meaning names itself', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('effort', 'low'));
    // The label comes out of the GROUPED options list, and a bare "Switched to Low"
    // would be a riddle — hence the option's own name.
    assert.deepStrictEqual(choiceChanges(before, after), ['Reasoning effort: Low']);
  });

  test('the primary fact comes first when a switch cascades', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('effort', 'low').map(o => (
      o.id === 'model' ? { ...o, currentValue: 'sonnet' } : o
    )));
    assert.deepStrictEqual(
      choiceChanges(before, after),
      ['Switched to Sonnet', 'Reasoning effort: Low'],
      'a model switch often adjusts a derived option in the same response; the reader wants the cause first',
    );
  });

  test('the second report of the same switch is silent', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('model', 'sonnet'));
    assert.strictEqual(choiceChanges(before, after).length, 1);
    // This is the de-duplication: whichever of the two reporters lands first
    // announces, and the other one diffs against the cache we just wrote.
    assert.deepStrictEqual(choiceChanges(after, after), []);
    // Nothing moved at all is also empty (e.g. re-opening a session).
    assert.deepStrictEqual(choiceChanges(before, before), []);
  });

  test('a notification payload patches the snapshot without losing the rest', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const fromConfig = choiceSnapshotPatched(before, { configOptions: withValue('model', 'sonnet') });
    assert.deepStrictEqual(choiceChanges(before, fromConfig), ['Switched to Sonnet']);
    // A mode payload carries an id and nothing else: the option map and the mode
    // NAME must both survive, or the line would read "Switched to plan mode".
    const fromMode = choiceSnapshotPatched(before, { modeId: 'plan' });
    assert.deepStrictEqual(choiceChanges(before, fromMode), ['Switched to Plan mode']);
    // [CUSTOM-20260930-128] A mode payload carries an id and nothing else, so every OTHER
    // option must survive — and the mode option itself is the same fact, so it is written
    // through (the setter path reads that copy; leaving it behind is what made one switch
    // print two lines).
    const { mode: patchedMode, ...patchedRest } = fromMode.options;
    const { mode: beforeMode, ...beforeRest } = before.options;
    assert.deepStrictEqual(patchedRest, beforeRest, 'every other option must survive');
    assert.strictEqual(patchedMode.value, 'plan');
    // The name comes from the mode list, since the payload does not carry one — otherwise
    // the line would read "Switched to plan mode".
    assert.strictEqual(patchedMode.valueName, 'Plan');
    assert.strictEqual(beforeMode.valueName, 'Manual');
  });

  test('one switch reported through both channels is announced once', () => {
    // [CUSTOM-20260930-128] The two reporters see different HALVES of the same change:
    // the notification path patches the mode id from its payload (leaving the option
    // behind), while the setter path reads SessionManager — where `modes.currentModeId`
    // is frozen, because `setMode` early-returns when the session has configOptions
    // (Claude Code's shape). Their snapshots used to disagree forever, so the
    // "the second report diffs to nothing" rule failed and the user saw two lines,
    // the second one naming a state that never existed ("Manual mode · Bypass
    // permissions mode").
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const fromNotification = choiceSnapshotPatched(before, { modeId: 'plan' });
    // MODES still says 'default' on purpose: that frozen copy IS the setter path's view.
    const fromSetter = choiceSnapshotFromState(MODES, withValue('mode', 'plan'));

    assert.deepStrictEqual(choiceChanges(before, fromNotification), ['Switched to Plan mode']);
    assert.deepStrictEqual(choiceChanges(fromNotification, fromSetter), [],
      'the second report of the same switch must be silent');
    // ...and the other arrival order has no silent gap either.
    assert.deepStrictEqual(choiceChanges(before, fromSetter), ['Switched to Plan mode']);
    assert.deepStrictEqual(choiceChanges(fromSetter, fromNotification), []);
  });

  test('a state that APPEARS is initialization, not a switch', () => {
    // The first snapshot of a session is empty (SessionManager has nothing yet) and
    // the option list lands a moment later. Announcing that would print a line full
    // of "Model: … · Mode: … · Reasoning effort: …" for every session.
    const empty = choiceSnapshotFromState(null, null);
    assert.deepStrictEqual(choiceChanges(empty, empty), []);
    assert.deepStrictEqual(choiceChanges(empty, choiceSnapshotFromState(MODES, CONFIG_OPTIONS)), []);
    // But once the state is KNOWN, a real change is announced as usual.
    assert.deepStrictEqual(
      choiceChanges(choiceSnapshotFromState(MODES, CONFIG_OPTIONS), choiceSnapshotFromState(MODES, withValue('model', 'sonnet'))),
      ['Switched to Sonnet'],
    );
  });
});

suite('chat panel: focusing a session the host already has', () => {
  // [CUSTOM-20260926-080] The reported bug: with a client-local **draft page** on
  // screen (058 — the host does not know drafts exist), clicking the tab of the very
  // session the host is already focused on did nothing at all. The click posts
  // `focusSession`; `SessionManager.focusSession` early-returns when the id is already
  // active (it emits only on a CHANGE), so no `focus` ever came back and the panel
  // stayed on the draft forever.
  //
  // The rule this pins: **an explicit focus request must always be answered.** What the
  // client is showing is not derivable from the host's state — the client can be on a
  // draft (or on nothing) while the host's `focused` already names this session.

  test('an explicit focus request is answered even when nothing changed', () => {
    const harness = makeHarness('session-a', 'Claude Code');
    // A first click establishes the host's focus (that one emits regardless).
    harness.host.onMessage({ type: 'focusSession', sessionId: 'session-a' });
    harness.surface.sent.length = 0;

    // The click that used to be silent: the host is already on 'session-a', and the
    // panel needs the reply to get back off a draft page.
    harness.host.onMessage({ type: 'focusSession', sessionId: 'session-a' });

    const focus = harness.surface.sent.filter(m => m.type === 'focus');
    assert.strictEqual(focus.length, 1, 'the request must be answered, not swallowed');
    assert.strictEqual((focus[0] as { summary?: { sessionId?: string } }).summary?.sessionId, 'session-a');
  });

  test('a request for a session the host does not know is still dropped', () => {
    // The guard that must survive the fix above: answering blindly would push a
    // snapshot for a session that no longer exists.
    const harness = makeHarness('session-a', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'focusSession', sessionId: 'never-existed' });
    assert.strictEqual(harness.surface.sent.filter(m => m.type === 'focus').length, 0);
  });
});

suite('chat panel: transcript-directory supplement', () => {
  // [CUSTOM-20260927-094] The agent's `session/list` is not the whole truth — the probe
  // (CUSTOMIZATIONS/scripts/probe-session-list.mjs) reconciled disk vs agent for this very
  // project: 8 transcripts on disk, 6 reported, and the two missing ones are the sessions
  // still open in another window. The official Claude Code panel reads that directory
  // directly, which is why it shows them.

  test('transcripts are read line by line, and an oversized line does not defeat it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-disk-'));
    try {
      // One huge NON-user record first (a tool result): a character-slice reader would cut
      // inside it and parse nothing — the first version of the probe did exactly that.
      fs.writeFileSync(path.join(dir, 'aaaa1111-2222.jsonl'), [
        JSON.stringify({ type: 'queue-operation', payload: 'x'.repeat(300_000) }),
        JSON.stringify({ type: 'user', cwd: 'D:\\proj', message: { content: '第一个问题' } }),
      ].join('\n'));
      // A session that is being written right now: no cwd/title recorded yet.
      fs.writeFileSync(path.join(dir, 'bbbb3333-4444.jsonl'),
        JSON.stringify({ type: 'queue-operation' }) + '\n');
      fs.writeFileSync(path.join(dir, 'not-a-transcript.txt'), 'ignore me');

      const rows = await readDiskSessions(dir, 'D:\\fallback');
      assert.strictEqual(rows.length, 2, 'only .jsonl files count');
      const byId = new Map(rows.map(r => [r.sessionId, r]));
      assert.strictEqual(byId.get('aaaa1111-2222')!.cwd, 'D:\\proj');
      assert.strictEqual(byId.get('aaaa1111-2222')!.title, '第一个问题');
      assert.ok(byId.get('aaaa1111-2222')!.updatedAt, 'the mtime is the activity time');
      // The head-less one still gets a cwd: the bucket it lives in IS the directory.
      assert.strictEqual(byId.get('bbbb3333-4444')!.cwd, 'D:\\fallback');
      assert.strictEqual(byId.get('bbbb3333-4444')!.title, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing directory is "no supplement", never an error', async () => {
    const rows = await readDiskSessions(path.join(os.tmpdir(), 'acpc-does-not-exist-' + Date.now()));
    assert.deepStrictEqual(rows, []);
  });

  test('the summary title (ai-title) wins over the first prompt (095)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-aititle-'));
    try {
      fs.writeFileSync(path.join(dir, 'cccc1111-2222.jsonl'), [
        JSON.stringify({ type: 'user', cwd: 'D:\\proj', message: { content: 'a verbose first question about the parser' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the parser' }),
      ].join('\n'));
      const rows = await readDiskSessions(dir, 'D:\\fallback');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].title, 'Fix the parser', 'the summary title wins over the first prompt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the reply includes sessions only the transcripts know about', async () => {
    // The supplement is driven by CLAUDE_CONFIG_DIR (the same override Claude Code
    // honours), so a temp root is all it takes to exercise it end to end.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ there is no transcript bucket to read

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-claude-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, 'dddd5555-6666.jsonl'), [
        JSON.stringify({ type: 'user', cwd, message: { content: 'the session the agent hides' } }),
      ].join('\n'));

      class EmptyHistoryManager extends SessionManager {
        override isAgentConnected(): boolean { return true; }
        override getCachedCapabilities(): any { return { list: true }; }
        override async listSessions(): Promise<any> { return { sessions: [] }; }
      }
      const harness = makeHarness('dummy-session', 'Claude Code', handler =>
        new EmptyHistoryManager(new AgentManager(), new ConnectionManager(handler), handler));
      harness.surface.sent.length = 0;
      harness.host.onMessage({ type: 'listHistory' });

      let reply: any;
      for (let i = 0; i < 100 && !reply; i++) {
        reply = harness.surface.sent.find(m => m.type === 'history');
        if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      assert.ok(reply, 'the host must answer listHistory');
      const row = (reply.sessions as any[]).find(s => s.sessionId === 'dddd5555-6666');
      assert.ok(row, 'the transcript-only session is offered');
      assert.strictEqual(row.fromDisk, true, 'and it says where it came from');
      assert.strictEqual(row.cwd, cwd);
      assert.match(String(row.title), /the session the agent hides/);
      // The agent reported nothing, so every row here came from a local source.
      assert.strictEqual(reply.source, 'merged');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the supplement scans the directory the filter selected, not the workspace', async () => {
    // [CUSTOM-20260928-095] The picker filter may point at any folder the agent lists —
    // NOT just workspaceFolders[0]. supplementHistory must scan THAT folder's transcripts.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-supplement-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const cwdA = 'D:\\proj-a';
      const cwdB = 'D:\\proj-b';
      const bucketA = path.join(root, 'projects', cwdA.replace(/[^A-Za-z0-9]/g, '-'));
      const bucketB = path.join(root, 'projects', cwdB.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucketA, { recursive: true });
      fs.mkdirSync(bucketB, { recursive: true });
      fs.writeFileSync(path.join(bucketA, 'aaaa1111-2222.jsonl'),
        JSON.stringify({ type: 'user', cwd: cwdA, message: { content: 'in folder a' } }) + '\n');
      fs.writeFileSync(path.join(bucketB, 'bbbb3333-4444.jsonl'),
        JSON.stringify({ type: 'user', cwd: cwdB, message: { content: 'in folder b' } }) + '\n');

      class EmptyHistoryManager extends SessionManager {
        override isAgentConnected(): boolean { return true; }
        override getCachedCapabilities(): any { return { list: true }; }
        override async listSessions(): Promise<any> { return { sessions: [] }; }
      }
      const harness = makeHarness('dummy-session', 'Claude Code', handler =>
        new EmptyHistoryManager(new AgentManager(), new ConnectionManager(handler), handler));
      harness.surface.sent.length = 0;
      harness.host.onMessage({ type: 'supplementHistory', cwd: cwdB });

      let reply: any;
      for (let i = 0; i < 100 && !reply; i++) {
        reply = harness.surface.sent.find(m => m.type === 'historySupplement');
        if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      assert.ok(reply, 'the host must answer supplementHistory');
      const ids = (reply.sessions as any[]).map(s => s.sessionId);
      assert.deepStrictEqual(ids, ['bbbb3333-4444'], 'only the selected folder is scanned');
      const row = (reply.sessions as any[])[0];
      assert.strictEqual(row.fromDisk, true, 'and it says where it came from');
      assert.strictEqual(row.dirKey, directoryKey(cwdB), 'and carries the folder identity');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('chat panel: audit round — routing, close, empty state', () => {
  // [CUSTOM-20260927-086..090] Four findings from the panel audit, all in the
  // "client-local state the host cannot see" family the repo keeps paying for.

  test('the reply is the UNION of the agent list and the local cache', async () => {
    // [CUSTOM-20260927-092] The agent's `session/list` is not the whole truth: it omits
    // sessions still open in another Claude Code window (measured with
    // CUSTOMIZATIONS/scripts/probe-session-list.mjs). A session this workspace opened
    // earlier is in OUR cache regardless, so the union is what keeps "the list I saw
    // before" and "the list I see now" in agreement.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/tmp';
    const memento = new FakeMemento();
    void memento.update('acp.sessionHistory.v1', {
      version: 1,
      entries: [
        // Shared with the agent's list (the agent's version of it wins).
        { agentName: 'Claude Code', cwd, sessionId: 'shared', createdAt: '2026-09-20T00:00:00Z', lastActiveAt: '2026-09-20T00:00:00Z', title: 'cached title' },
        // Cache-only: the agent did not mention it.
        { agentName: 'Claude Code', cwd, sessionId: 'cache-only', createdAt: '2026-09-19T00:00:00Z', lastActiveAt: '2026-09-19T00:00:00Z', title: 'only in the cache' },
      ],
    });
    const store = new SessionHistoryStore(memento as unknown as vscode.Memento);

    class UnionManager extends SessionManager {
      override isAgentConnected(): boolean { return true; }
      override getCachedCapabilities(): any { return { list: true }; }
      override async listSessions(): Promise<any> {
        return {
          sessions: [
            { sessionId: 'shared', title: 'agent title', cwd, updatedAt: '2026-09-21T00:00:00Z' },
            { sessionId: 'agent-only', title: 'only from the agent', cwd, updatedAt: '2026-09-22T00:00:00Z' },
          ],
        };
      }
    }

    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      const manager = new UnionManager(new AgentManager(), new ConnectionManager(handler), handler);
      manager.setHistoryStore(store);
      return manager;
    });
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'listHistory' });

    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply, 'the host must answer listHistory');
    assert.strictEqual(reply.source, 'merged', 'both sources contributed');

    const byId = new Map<string, any>(reply.sessions.map((s: any) => [s.sessionId, s]));
    assert.deepStrictEqual(Array.from(byId.keys()).sort(), ['agent-only', 'cache-only', 'shared']);
    assert.strictEqual(byId.get('shared').title, 'agent title', 'the agent wins for a session it knows');
    assert.strictEqual(byId.get('shared').fromCache, undefined, 'and it is not marked as cache-only');
    assert.strictEqual(byId.get('cache-only').fromCache, true, 'a cache-only row says so');
    // Newest first — the picker is for "the session I was just in".
    assert.deepStrictEqual(reply.sessions.map((s: any) => s.sessionId),
      ['agent-only', 'shared', 'cache-only']);
  });

  test('an agent-less panel routes to the MODERN panel, never legacy', () => {
    // Legacy replaces the sidebar document on attach, so routing "nothing focused" to it
    // destroyed client-local state (a draft page and its text) and made the modern empty
    // state unreachable.
    assert.strictEqual(panelIdForAgent(null), 'modern');
    assert.strictEqual(panelIdForAgent(undefined), 'modern');
    assert.strictEqual(panelIdForAgent(''), 'modern');
    assert.strictEqual(panelIdForAgent('Claude Code'), 'modern');
    assert.strictEqual(panelIdForAgent('GitHub Copilot'), 'legacy', 'a known non-modern agent still uses the upstream panel');
  });

  /** Records the cancel; the in-flight state is ours to decide. */
  class RecordingCloseManager extends SessionManager {
    readonly cancelled: string[] = [];
    private readonly busy = new Set<string>();
    markBusy(sessionId: string): void { this.busy.add(sessionId); }
    override isTurnInFlight(sessionId: string): boolean { return this.busy.has(sessionId); }
    override async cancelTurn(sessionId: string): Promise<void> { this.cancelled.push(sessionId); }
  }

  test('closing a session cancels its in-flight turn first', async () => {
    // Dropping `inFlightTurns` without a cancel left the agent working on a turn nobody
    // would see — and, per the ACP contract honoured in cancelTurn, a pending
    // session/request_permission must be answered 'cancelled' or the agent hangs (pitfall #14).
    let manager!: RecordingCloseManager;
    const harness = makeHarness('busy-session', 'Claude Code', handler => {
      manager = new RecordingCloseManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    manager.markBusy('busy-session');
    await manager.closeSession('Claude Code', 'busy-session');
    assert.deepStrictEqual(manager.cancelled, ['busy-session']);
    assert.strictEqual(manager.getSession('busy-session'), undefined, 'and it is still closed');
    assert.strictEqual(harness.sessionManager.getSession('busy-session'), undefined);
  });

  test('idle sessions are closed without a spurious cancel', async () => {
    let manager!: RecordingCloseManager;
    makeHarness('idle-session', 'Claude Code', handler => {
      manager = new RecordingCloseManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    await manager.closeSession('Claude Code', 'idle-session');
    assert.deepStrictEqual(manager.cancelled, [], 'nothing was running');
  });

  test('every message that can change the empty state carries the connection flag', () => {
    // A sessionless panel can have a LIVE agent (closing the last session keeps the
    // process), so the empty state's copy must come from the host rather than assuming
    // "no session ⇒ not connected".
    const harness = makeHarness('dummy-session', 'Claude Code');
    const boot = harness.surface.sent.find(m => m.type === 'boot') as { agentConnected?: unknown };
    assert.strictEqual(boot.agentConnected, true, 'the harness registers a live agent process');

    harness.sessionManager.emit('active-session-changed', 'dummy-session', 'Claude Code');
    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as { agentConnected?: unknown };
    assert.strictEqual(focus.agentConnected, true);
  });
});

suite('chat panel: history picker directory filter', () => {
  // [CUSTOM-20260926-079] The picker lists the AGENT's sessions, which span every
  // directory it has ever been used in (232 of them in the report) — unusable without
  // a filter. Two halves are covered here:
  //   · the pure functions that decide "is this the same folder?" and "what is worth
  //     offering" — the only place platform differences live;
  //   · the reply the host builds, where EVERY row must carry a `dirKey` (a row
  //     without one silently disappears from any filtered list).
  // The client half (chip, menu, placement, Escape layering) is layout/interaction:
  // it is verified by hand, see dev-workflow.md's split.

  test('directory identity folds case on Windows/macOS, not on Linux', () => {
    assert.strictEqual(directoryKey('D:\\Git\\Repo\\', 'win32'), 'd:/git/repo');
    assert.strictEqual(directoryKey('d:/git/repo', 'win32'), 'd:/git/repo');
    // The case rule is a property of the PLATFORM: on Linux these are two folders.
    assert.notStrictEqual(directoryKey('/Home/Me', 'linux'), directoryKey('/home/me', 'linux'));
    assert.strictEqual(directoryKey('/home/me/', 'linux'), '/home/me');
    // Roots: 'C:\' and 'C:' are the same place, so they must share ONE identity
    // ('c:'), while POSIX '/' survives because there is nothing to strip.
    assert.strictEqual(directoryKey('C:\\', 'win32'), 'c:');
    assert.strictEqual(directoryKey('C:', 'win32'), 'c:');
    assert.strictEqual(directoryKey('/', 'linux'), '/');
    // A session with no directory has no identity to compare.
    assert.strictEqual(directoryKey(undefined), undefined);
    assert.strictEqual(directoryKey('   '), undefined);
  });

  test('candidates come from the list; the current folder is always offered', () => {
    const options = directoryOptions(
      [
        { cwd: 'D:\\Git\\alpha' },
        { cwd: 'D:\\Git\\alpha\\' },   // same folder, different spelling → ONE option
        { cwd: 'D:\\Git\\beta' },
        { cwd: undefined },            // nothing to filter by
      ],
      'D:/Git/alpha',
      'win32',
    );
    assert.deepStrictEqual(options.map(o => [o.name, o.count, o.current]), [
      ['alpha', 2, true],   // 两种拼写合成一项（count=2）；顺序按名称（它恰好也在前面）
      ['beta', 1, false],
    ]);
  });

  test('the current folder is offered even with no sessions in it', () => {
    // Otherwise "the filter defaults to the current folder" would open onto an empty
    // list with no hint of why — the control would look broken.
    const options = directoryOptions([{ cwd: '/other' }], '/here');
    assert.deepStrictEqual(options.map(o => [o.name, o.count, o.current]), [
      ['here', 0, true],
      ['other', 1, false],
    ]);
    // No current directory (a draft, or a session the agent gave no cwd for): the
    // client is then told to open unfiltered, which is the honest answer.
    assert.deepStrictEqual(directoryOptions([{ cwd: '/other' }], undefined).map(o => o.current), [false]);
    assert.deepStrictEqual(directoryOptions([], undefined), []);
  });

  test('two candidates with the same folder name are told apart', () => {
    // The first real list had "UniverseEditor" twice (two checkouts of one repo), and
    // two identical labels cannot be picked between — so the label grows leftwards.
    const options = directoryOptions([{ cwd: '/x/git/UniverseEditor' }, { cwd: '/y/zdev/UniverseEditor' }]);
    assert.deepStrictEqual(options.map(o => [o.name, o.label]), [
      ['UniverseEditor', 'git/UniverseEditor'],
      ['UniverseEditor', 'zdev/UniverseEditor'],
    ]);
    // A unique name stays as short as it was.
    assert.deepStrictEqual(
      directoryOptions([{ cwd: '/a/alpha' }, { cwd: '/a/beta' }]).map(o => o.label),
      ['alpha', 'beta'],
    );
  });

  test('ordering: by name (CUSTOM-20260930-142)', () => {
    // 用户要求"目录列表排下序（按字母顺序）"。原来是 current 优先 → 会话数降序 → 名称，
    // 前两个键把字母序盖住了 —— 看起来就像"根本没排序"。现在纯按名称；当前目录只保留
    // current 标记（客户端据此高亮），不再置顶。
    const options = directoryOptions(
      [{ cwd: '/b' }, { cwd: '/b' }, { cwd: '/a' }, { cwd: '/c' }, { cwd: '/c' }], '/z');
    assert.deepStrictEqual(options.map(o => o.name), ['a', 'b', 'c', 'z']);
    // 会话数（b 与 c 各 2）与 current（z）都不再影响顺序。
    assert.deepStrictEqual(options.map(o => o.current), [false, false, false, true]);
  });

  /** An agent whose history spans directories — the case the filter exists for. */
  class MultiDirSessionManager extends SessionManager {
    override isAgentConnected(): boolean { return true; }
    override getCachedCapabilities(): any { return { list: true }; }
    override async listSessions(): Promise<any> {
      return {
        sessions: [
          // The focused session's own directory ('/tmp', from the fake session).
          { sessionId: 'in-here', title: 'here one', cwd: '/tmp', updatedAt: '2026-09-20T00:00:00Z' },
          { sessionId: 'elsewhere-a', title: 'a', cwd: 'D:\\Git\\alpha', updatedAt: '2026-09-19T00:00:00Z' },
          // Same directory as the row above, spelled with a trailing separator: the
          // fixtures differ only in that way ON PURPOSE, so this test says the same
          // thing on every platform (case-only differences would not).
          { sessionId: 'elsewhere-b', title: 'b', cwd: 'D:\\Git\\alpha\\', updatedAt: '2026-09-18T00:00:00Z' },
          { sessionId: 'no-dir', title: 'c', updatedAt: '2026-09-17T00:00:00Z' },
        ],
      };
    }
  }

  test('the reply carries a per-row dirKey and the filter candidates', async function () {
    const harness = makeHarness('dummy-session', 'Claude Code', handler =>
      new MultiDirSessionManager(new AgentManager(), new ConnectionManager(handler), handler));
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    harness.host.onMessage({ type: 'listHistory' });

    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply, 'the host must answer listHistory');

    const byId = new Map<string, any>(reply.sessions.map((s: any) => [s.sessionId, s]));
    assert.strictEqual(byId.get('in-here').dirKey, directoryKey('/tmp'));
    // Two spellings of one directory share an identity — and the ROWS keep their own
    // spelling, because that is what gets handed back to the agent on open.
    assert.strictEqual(byId.get('elsewhere-a').dirKey, byId.get('elsewhere-b').dirKey);
    assert.strictEqual(byId.get('elsewhere-b').cwd, 'D:\\Git\\alpha\\');
    // A row with no directory has no key: it can only ever show in an unfiltered list.
    assert.strictEqual(byId.get('no-dir').dirKey, undefined);

    // The two spellings of alpha are ONE candidate with a count of 2, and the order is
    // by name — '/tmp' is the current directory but no longer leads (CUSTOM-20260930-142).
    assert.deepStrictEqual(reply.directories.map((d: any) => [d.name, d.count, d.current]), [
      ['alpha', 2, false],
      ['tmp', 1, true],
    ]);
  });

  test('the current (live) session is offered in the history list', async function () {
    // [CUSTOM-20260928-097] Live sessions used to be hidden ("they are already
    // tabs"), but the current session should still appear — clicking it re-focuses.
    class LiveListManager extends SessionManager {
      override isAgentConnected(): boolean { return true; }
      override getCachedCapabilities(): any { return { list: true }; }
      override async listSessions(): Promise<any> {
        return {
          sessions: [
            { sessionId: 'dummy-session', title: 'the live one', cwd: '/tmp', updatedAt: '2026-09-20T00:00:00Z' },
          ],
        };
      }
    }
    const harness = makeHarness('dummy-session', 'Claude Code', handler =>
      new LiveListManager(new AgentManager(), new ConnectionManager(handler), handler));
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'listHistory' });
    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply);
    assert.ok(reply.sessions.some((s: any) => s.sessionId === 'dummy-session'),
      'the live session must appear in the history list');
  });
});

// [CUSTOM-20260928-096] 输入区图片：宿主把 image 附件转成 ACP `image` ContentBlock、
// 字节只留宿主内存（不进 meta），file 附件仍转 resource_link，发送后清掉 image 字节。
suite('chat panel: image attachments (CUSTOM-20260928-096)', () => {
  class RecordingSendManager extends SessionManager {
    readonly sent: Array<{ sessionId: string; prompt: unknown }> = [];
    override async sendPrompt(sessionId: string, prompt: unknown): Promise<PromptResponse> {
      this.sent.push({ sessionId, prompt });
      return { stopReason: 'end_turn' } as PromptResponse;
    }
  }

  function imageHarness(): { harness: Harness; manager: RecordingSendManager } {
    let manager!: RecordingSendManager;
    const harness = makeHarness('image-session', 'Claude Code', handler => {
      manager = new RecordingSendManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  function latestAttachments(harness: Harness): Array<Record<string, unknown>> {
    const msgs = harness.surface.sent.filter(m => m.type === 'attachments') as Array<Record<string, unknown>>;
    const last = msgs[msgs.length - 1];
    return (last && (last.attachments as Array<Record<string, unknown>>)) || [];
  }

  test('an image attachment is broadcast without its bytes on the wire', () => {
    const { harness } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });

    const img = latestAttachments(harness).find(a => a.path === 'img-1');
    assert.ok(img, 'the image attachment is in the list');
    assert.strictEqual(img.kind, 'image');
    assert.strictEqual(img.mimeType, 'image/png');
    // The base64 lives host-side only — putting it on the wire would re-send the
    // whole image on every boot/focus.
    assert.strictEqual(img.dataUrl, undefined);
  });

  test('send turns an image into an image block and a file into a resource_link', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({ type: 'attachPath', sessionId: 'image-session', paths: ['/tmp/notes.txt'] });
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '' });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const blocks = manager.sent[0].prompt as Array<Record<string, any>>;
    assert.deepStrictEqual(blocks.find(b => b.type === 'image'),
      { type: 'image', data: 'AAAA', mimeType: 'image/png' });
    const link = blocks.find(b => b.type === 'resource_link');
    assert.ok(link, 'the file attachment is still a resource_link');
    assert.ok(String(link.uri).indexOf('notes.txt') >= 0, 'the resource_link names the file');
    // Empty text ⇒ no text block.
    assert.strictEqual(blocks.find(b => b.type === 'text'), undefined, 'empty text yields no text block');
  });

  test('a send with text and an image records the image inside the user bubble (108)', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '看看这张图' });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const snap = (harness.host as any).transcripts.snapshot('image-session');
    assert.ok(snap);
    const users = snap.entries.filter((e: any) => e.kind === 'user');
    const contents = snap.entries.filter((e: any) => e.kind === 'content');
    assert.strictEqual(users.length, 1, 'one user entry');
    assert.strictEqual(contents.length, 0, 'no separate content entry: the image lives in the bubble');
    assert.ok(users[0].attachments, 'the user entry carries the attachments field');
    assert.strictEqual(users[0].attachments!.length, 1);
    assert.strictEqual(users[0].attachments![0].type, 'image');
    assert.strictEqual(users[0].attachments![0].name, 'shot.png', 'the attachment name survives');
  });

  test('an image-only send records a content entry and no empty user bubble', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '' });
    await waitFor(() => manager.sent.length > 0, 'the prompt');

    const state = settle(harness, 'Claude Code', 'image-session');
    assert.strictEqual(state.entries.filter(e => e.kind === 'content').length, 1,
      'the image becomes one content entry');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'no empty user bubble for an image-only send');
  });
});

// [CUSTOM-20260928-097] 会话元数据：tab 标题落地、重开会话记录目录（Recently used）。
suite('chat panel: session metadata (CUSTOM-20260928-097)', () => {
  test('a session_info_update applies the title to the tab summary', () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: 'The session name', updatedAt: '2026-09-20T00:00:00Z' },
    } as any);

    const changed = harness.surface.sent.filter(m => m.type === 'sessionsChanged');
    const last = changed[changed.length - 1] as { sessions: Array<{ sessionId: string; title: string | null }> };
    assert.ok(last, 'a sessionsChanged must be emitted after the title lands');
    const s = last.sessions.find(x => x.sessionId === 'dummy-session');
    assert.strictEqual(s?.title, 'The session name');
  });

  // [CUSTOM-20261001-163] 标题跟随 agent，但**不再在对话里插一行"改名"提示**（用户报：
  // 会话进行中会自己改名并跳出一行 `Session renamed to “…”`）。adapter 每轮结束去读 SDK 的标题，
  // 而那个标题先是"第一条 prompt"、之后才被后台生成的摘要替换 —— 这次跃迁不是用户做的，
  // 也不在对话的语义里。
  test('a retitle follows the tab but never writes a record into the conversation (163)', () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    harness.surface.sent.length = 0;

    // The adapter's first title is the first prompt…
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '检查一下文档', updatedAt: '2026-09-20T00:00:00Z' },
    } as any);
    // …and the generated summary replaces it a turn later.
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: 'Governance sync infrastructure analysis', updatedAt: '2026-09-20T00:01:00Z' },
    } as any);

    const appends = harness.surface.sent.filter(m => m.type === 'append') as Array<{ entries?: Array<{ kind?: string; text?: string }> }>;
    const notices = appends.flatMap(m => m.entries ?? []).filter(e => e.kind === 'notice');
    assert.deepStrictEqual(notices, [], 'a rename the user did not make is not a record in their conversation');

    const changed = harness.surface.sent.filter(m => m.type === 'sessionsChanged');
    const last = changed[changed.length - 1] as { sessions: Array<{ sessionId: string; title: string | null }> };
    assert.strictEqual(last.sessions.find(x => x.sessionId === 'dummy-session')?.title,
      'Governance sync infrastructure analysis',
      'but the tab still follows the newest title — that is where a name belongs');
  });

  // [CUSTOM-20261001-164] 标题由**第一次对话**定：那一刻已经拿到的自动命名就是它的名字；
  // 没拿到就用第一条消息（`toSummary` 的回退链），之后**任何**标题都不再改 —— 包括几轮之后
  // 才生成的那个"第一个自动命名"（用户规则：那时对话内容已经脱离第一次对话了）。
  async function settleFor(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }

  function titleOf(harness: Harness): string | null | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessions?: Array<{ sessionId: string; title: string | null }>;
      };
      if (message.type !== 'sessionsChanged') { continue; }
      const row = (message.sessions ?? []).find(s => s.sessionId === 'dummy-session');
      if (row) { return row.title; }
    }
    return undefined;
  }

  test('a title that lands with the first exchange IS the name (164)', async () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    Object.assign(harness.sessionManager, { sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }) });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第一条消息' });
    await settleFor(20);
    // The adapter polls the SDK title at turn end, so this one belongs to the first exchange.
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '自动命名 A' },
    } as any);
    assert.strictEqual(titleOf(harness), '自动命名 A');
  });

  test('a title generated several exchanges later never renames the session (164)', async () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    Object.assign(harness.sessionManager, { sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }) });

    // Turn 1, and no title by the time it ends.
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第一条消息' });
    await settleFor(20);
    assert.strictEqual(titleOf(harness), null, 'nothing named it yet');

    // Turn 2: the name is now fixed (in production the tab falls back to the stored
    // first prompt — the harness has no history store, so the title simply stays unset).
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第二条消息' });
    await settleFor(20);
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '几轮之后才生成的标题' },
    } as any);
    assert.strictEqual(titleOf(harness), null, 'a late auto-title must not become the name');
  });

  test('upsertNew records the directory, and updates a stale one', () => {
    const store = new SessionHistoryStore(new FakeMemento());
    store.upsertNew('Claude Code', '/dir/x', 's1');
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/dir/x']);

    // Reopening the same session with a corrected directory must update it (the
    // "opened a session in a directory, then New Session should offer it" case).
    store.upsertNew('Claude Code', '/dir/y', 's1');
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/dir/y']);
    assert.strictEqual(store.get('Claude Code', 's1')?.cwd, '/dir/y');
  });
});


// [CUSTOM-20260928-100] replay 的三项修复：用户消息里的图片不再丢、记录用转录里的真实
// 时刻、在草稿页选历史会话时让位的是草稿而不是聚焦会话。
suite('chat panel: replay fidelity (CUSTOM-20260928-100)', () => {
  test('an image in a replayed user message becomes a content record', () => {
    // ACP delivers a multi-part user message as several chunks; the non-text ones
    // used to be dropped here, so a reopened conversation lost the picture.
    const harness = makeHarness('img-replay', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'img-replay',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-image',
        content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'img-replay');
    const content = state.entries.find(e => e.kind === 'content') as { blocks: Array<{ type: string }> } | undefined;
    assert.ok(content, 'the image must survive a replay');
    assert.strictEqual(content!.blocks[0].type, 'image');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'an image-only chunk is not an empty user bubble');
  });

  test('the transcript timeline maps message ids to their real times', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-times-'));
    try {
      fs.writeFileSync(path.join(dir, 's1.jsonl'), [
        // user records are keyed by `uuid`; assistant records by `message.id`.
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T10:05:00.000Z', message: { id: 'a1' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T10:05:30.000Z', message: { id: 'a1' } }),
        'not json at all',
      ].join('\n'));

      const times = await readTranscriptTimes(dir, 's1');
      assert.strictEqual(times.get('u1'), Date.parse('2026-09-25T10:00:00.000Z'));
      assert.strictEqual(times.get('a1'), Date.parse('2026-09-25T10:05:00.000Z'),
        'the EARLIEST record wins: one message id spans several records');
      assert.strictEqual(times.size, 2, 'a malformed line is skipped, not fatal');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a replayed record carries the real time from the transcript', async () => {
    // End to end: the host reads the timeline before replaying, then stamps the
    // records the agent streams back. Without it every row of a reopened
    // conversation showed `Date.now()` — one identical second for the whole thing.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ there is no transcript bucket to read

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-replay-times-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      const realTime = '2026-09-25T10:00:00.000Z';
      fs.writeFileSync(path.join(bucket, 'replayed-session.jsonl'), [
        JSON.stringify({ type: 'user', cwd, uuid: 'msg-1', timestamp: realTime, message: { role: 'user' } }),
      ].join('\n'));

      class LiveOpenManager extends SessionManager {
        readonly closed: string[] = [];
        override async closeSession(agentName: string, sessionId: string): Promise<void> {
          this.closed.push(sessionId);
          return super.closeSession(agentName, sessionId);
        }
        override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
      }
      let manager!: LiveOpenManager;
      const harness = makeHarness('dummy-session', 'Claude Code', handler => {
        manager = new LiveOpenManager(new AgentManager(), new ConnectionManager(handler), handler);
        return manager;
      });
      harness.surface.sent.length = 0;

      harness.host.onMessage({
        type: 'openHistorySession',
        agentName: 'Claude Code',
        sessionId: 'replayed-session',
        cwd,
      });
      // The preload happens before the open, so waiting for the open to land is enough.
      for (let i = 0; i < 100 && manager.closed.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      // Now the replay streams a chunk carrying that message id.
      registerFakeSession(harness.sessionManager, 'replayed-session', 'Claude Code');
      harness.handler.handleUpdate({
        sessionId: 'replayed-session',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'hello' } },
      } as any);

      const state = settle(harness, 'Claude Code', 'replayed-session');
      const user = state.entries.find(e => e.kind === 'user') as { at: number } | undefined;
      assert.ok(user, 'the replayed user message is in the transcript');
      assert.strictEqual(user!.at, Date.parse(realTime),
        'the record carries the time the message was actually sent');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('opening a session while on a draft page leaves the focused session alone', async () => {
    // [CUSTOM-20260928-100] Reported: picking a history session while on the "New
    // session" page replaced the FIRST TAB instead, and the draft page never changed.
    // The draft is client-local, so the host's `focused` names some other session —
    // `fromDraft` is how the client says "that session is not the one to retire".
    class RecordingOpenManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: RecordingOpenManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new RecordingOpenManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      fromDraft: true,
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepStrictEqual(manager.closed, [],
      'the draft steps aside; the focused session must keep its tab');
  });

  // [CUSTOM-20260928-109] 注入块（<task-notification> 等）走 user_message_chunk 通道，
  // 但它们不是用户输入。渲染成蓝色用户气泡会把 agent 的回报误读成用户说过的话。
  test('a task-notification chunk is a meta notice, not a user bubble', () => {
    const harness = makeHarness('notify', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'notify',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-notify',
        content: { type: 'text', text: '<task-notification>\n<status>completed</status>\n<summary>explore done</summary>\n</task-notification>' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'notify');
    const userEntries = state.entries.filter(e => e.kind === 'user');
    const noticeEntries = state.entries.filter(e => e.kind === 'notice');
    assert.strictEqual(userEntries.length, 0, 'an injected block is NOT a user bubble');
    assert.strictEqual(noticeEntries.length, 1, 'it becomes a notice');
    const notice = noticeEntries[0] as { level: string; text: string };
    assert.strictEqual(notice.level, 'meta');
    assert.ok(notice.text.includes('completed'), 'the preview keeps the payload');
  });

  test('a system-reminder chunk is also a meta notice', () => {
    const harness = makeHarness('reminder', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'reminder',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-reminder',
        content: { type: 'text', text: '<system-reminder>Do something.</system-reminder>' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'reminder');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0);
    assert.strictEqual(state.entries.filter(e => e.kind === 'notice').length, 1);
  });

  test('a plain user message is still a user bubble', () => {
    const harness = makeHarness('plain', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'plain',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-plain',
        content: { type: 'text', text: 'hello, this is a real question' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'plain');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 1,
      'a real user message is not diverted');
  });

  // [CUSTOM-20260928-111] Replay delivers a user message's text and its images as
  // separate chunks (100). The bubble has nothing to merge with unless the host reads
  // the transcript — so the image rides in on the text chunk, and the image chunk that
  // follows must NOT become a second row.
  test('a replayed user message carries its images in the bubble, and the image chunk is dropped', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ no transcript bucket to read
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpc-img-replay-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, 's-img.jsonl'), [
        JSON.stringify({
          type: 'user', uuid: 'u-img', timestamp: '2026-09-25T10:00:00.000Z',
          message: { role: 'user', content: [
            { type: 'text', text: 'look at this' },
            // Claude Code 的转录格式：source:{ type:'base64', media_type, data }
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ] },
        }),
      ].join('\n'));

      const harness = makeHarness('s-img', 'Claude Code');
      harness.surface.sent.length = 0;
      await (harness.host as any).preloadTranscriptTimes('Claude Code', 's-img');

      harness.handler.handleUpdate({
        sessionId: 's-img',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-img', content: { type: 'text', text: 'look at this' } },
      } as any);
      harness.handler.handleUpdate({
        sessionId: 's-img',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-img', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
      } as any);

      const state = settle(harness, 'Claude Code', 's-img');
      const users = state.entries.filter(e => e.kind === 'user');
      const contents = state.entries.filter(e => e.kind === 'content');
      assert.strictEqual(users.length, 1, 'one user entry');
      assert.strictEqual(contents.length, 0, 'the image chunk does not become a second row');
      const user = users[0] as { attachments?: Array<{ type: string; dataUri: string }> };
      assert.ok(user.attachments, 'the bubble carries the images');
      assert.strictEqual(user.attachments!.length, 1);
      assert.strictEqual(user.attachments![0].type, 'image');
      assert.ok(user.attachments![0].dataUri.startsWith('data:image/png;base64,'));
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// [CUSTOM-20260929-117] 工具卡标题（agent 写的 description）——对齐官方插件的
// "Bash 查看博客目录及父目录现有内容"。数据来源是抓包夹具里**真实**的 Bash 载荷：
// `rawInput.description` 与 `_meta.claudeCode.title` 同一个字符串，而 Read 卡两者都没有
// （用来钉"没有就回退"这一半）。
//
// 为什么要 latch：真夹具里 description 出现在**第 3 条 update**，而 `_meta` 是整体替换、
// 之后那条 toolResponse update 就把 `_meta.claudeCode.title` 抹掉了。任何"要用时再读一遍"
// 的写法都会让标题在下一个 chunk 闪回命令行——而且**没有任何报错**。
suite('chat panel: tool card description (CUSTOM-20260929-117)', () => {
  test('the description is latched: it survives the update that replaces _meta', () => {
    const store = new ToolInvocationStore();
    const meta = (extra: Record<string, unknown>) => ({ claudeCode: { toolName: 'Bash', ...extra } });
    store.upsertCall('s1', {
      toolCallId: 'c1', title: 'Terminal', kind: 'execute', status: 'pending',
      content: [], locations: [], rawInput: {}, _meta: meta({}),
    } as never);
    store.upsertUpdate('s1', { toolCallId: 'c1', rawInput: { command: 'ls -la' }, _meta: meta({}) } as never);
    store.upsertUpdate('s1', {
      toolCallId: 'c1', title: 'ls -la', rawInput: { command: 'ls -la', description: 'List files' },
      _meta: meta({ title: 'List files' }),
    } as never);
    // The shape the real capture ends on: _meta replaced WITHOUT the title, no rawInput key.
    store.upsertUpdate('s1', { toolCallId: 'c1', _meta: meta({ toolResponse: { stdout: 'x' } }) } as never);

    assert.strictEqual(store.get('s1', 'c1')!.description, 'List files',
      'the description must survive every later update');
  });

  test('a call that publishes no description is left without one', () => {
    const store = new ToolInvocationStore();
    store.upsertCall('s1', {
      toolCallId: 'c2', title: 'Read File', kind: 'read', status: 'pending',
      content: [], locations: [], rawInput: { file_path: 'a.ts' }, _meta: { claudeCode: { toolName: 'Read' } },
    } as never);
    assert.strictEqual(store.get('s1', 'c2')!.description, undefined);
  });

  test('the live replay carries the description through to the webview', () => {
    if (!fixture?.sessionId) { return; }
    // The harness session must BE the fixture's session: the host routes every
    // notification by sessionId and silently drops unknown ones (the first version of
    // this test used a made-up id and asserted on an empty message list).
    const harness = makeHarness(fixture.sessionId, 'Claude Code');
    feed(harness, phaseOf(fixture, 'live'));
    settle(harness, 'Claude Code', fixture.sessionId);

    // Every path a view model can take to the client: `append` (the card's first
    // paint) carries it on the entry, `toolUpdate` carries it on its own, and a
    // snapshot (boot / focus) carries entries too. Which one fires is the host's
    // business — the assertion is about the view model that reaches the client.
    const views: Array<{ toolCallId: string; title: string; description?: string; command: string | null }> = [];
    for (const message of harness.surface.sent as Array<Record<string, unknown>>) {
      if (message.type === 'toolUpdate') { views.push(message.tool as never); }
      if (message.type === 'append') {
        for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
          if (entry.toolView) { views.push(entry.toolView as never); }
        }
      }
      if (message.type === 'boot' || message.type === 'focus') {
        const snapshot = message.snapshot as { entries?: Array<Record<string, unknown>> } | null;
        for (const entry of snapshot?.entries ?? []) {
          if (entry.toolView) { views.push(entry.toolView as never); }
        }
      }
    }
    const bash = views.filter(v => v.command === 'ls -la').pop();
    assert.ok(bash, `the Bash card must have reached the webview (saw ${views.length} views)`);
    assert.strictEqual(bash!.description, 'List files in the working directory',
      'the agent-written description travels in the view model');
    assert.strictEqual(bash!.title, 'ls -la',
      'the ACP title is untouched — it is the IN line and the rail tooltip');
    // …and a tool that publishes none is left alone, so the client falls back to title.
    const read = views.filter(v => (v.command ?? null) === null && v.title.startsWith('Read')).pop();
    assert.ok(read, 'the Read card must have reached the webview too');
    assert.strictEqual(read!.description, undefined, 'no invented description');
  });
});

// [CUSTOM-20260929-118] 真数据驱动的工具卡回归：`src/test/fixtures/claude-code-bash-tools.json`
// 是 2026-09-29 用 `capture-acp-replay.mjs` 抓的一次真实 Bash 轮次（两条命令：一条成功、
// 一条失败）。它存在的理由：工具卡的 OUT 曾经是**空的**，而"空"有两个独立成因
// （空白文本项 / markdown 请求没人发），只看桩数据发现不了——夹具里那两条更新的形状
// 就是真机的样子：中段 update 的 content 是**描述**，最后一条才是 ```console 输出块 +
// rawOutput。判据必须跟着真载荷走。
const BASH_FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', 'src', 'test', 'fixtures', 'claude-code-bash-tools.json',
);

function loadBashFixture(): Fixture | null {
  if (!fs.existsSync(BASH_FIXTURE_PATH)) { return null; }
  return JSON.parse(fs.readFileSync(BASH_FIXTURE_PATH, 'utf8')) as Fixture;
}

// [CUSTOM-20260929-120] 宿主对 renderMarkdown 的**逐项**校验：没有 sessionId 的项被静默跳过。
// 这条规则一直存在（协议里 sessionId 是必填），而客户端**工具项**曾经不带它 —— 于是工具正文的
// markdown 请求全部被丢弃、卡上留一个空 .tool-text，两个进程都不报错。这里把规则钉死，
// 客户端侧的对应断言在 chat-client.test.ts（'the render request carries the session id'）。
suite('chat panel: renderMarkdown item validation (CUSTOM-20260929-120)', () => {
  test('an item without a sessionId is dropped; the same item with one is rendered', () => {
    if (!fixture?.sessionId) { return; }
    const harness = makeHarness(fixture.sessionId, 'Claude Code');
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [
        { entryId: 'e-nosession', text: 'no session' },
        { entryId: 'e-ok', sessionId: fixture.sessionId, key: 'slot#1', text: 'hi there' },
      ],
    } as never);

    // The reply goes through the Outbox (one frame of coalescing) — flush it the way a
    // focus change does, or the assertion below sees an empty message list.
    settle(harness, 'Claude Code', fixture.sessionId);
    const replies = harness.surface.sent.filter(m => m.type === 'markdownRendered') as Array<{
      items: Array<{ entryId: string; html: string; key?: string }>;
    }>;
    assert.strictEqual(replies.length, 1, 'the host answers what it accepted');
    const answered = replies[0].items;
    assert.deepStrictEqual(answered.map(i => i.entryId), ['e-ok'],
      'the item with no session id never comes back — a silent drop, which is why the client must send it');
    assert.ok(answered[0].html.includes('hi there'), 'and the accepted one really was rendered');
  });
});

suite('chat panel: Bash tool payloads (real capture, CUSTOM-20260929-118)', () => {
  const bash = loadBashFixture();

  function toolViewsFor(fixture: Fixture, phase: string): Array<Record<string, unknown>> {
    const harness = makeHarness(fixture.sessionId as string, 'Claude Code');
    feed(harness, phaseOf(fixture, phase));
    settle(harness, 'Claude Code', fixture.sessionId as string);
    const views: Array<Record<string, unknown>> = [];
    for (const message of harness.surface.sent as Array<Record<string, unknown>>) {
      if (message.type === 'toolUpdate') { views.push(message.tool as Record<string, unknown>); }
      if (message.type === 'append') {
        for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
          if (entry.toolView) { views.push(entry.toolView as Record<string, unknown>); }
        }
      }
      if (message.type === 'boot' || message.type === 'focus') {
        const snapshot = message.snapshot as { entries?: Array<Record<string, unknown>> } | null;
        for (const entry of snapshot?.entries ?? []) {
          if (entry.toolView) { views.push(entry.toolView as Record<string, unknown>); }
        }
      }
    }
    return views;
  }

  /** The text of a view's content items, joined. */
  function itemText(view: Record<string, unknown>): string {
    const items = (view.items as Array<{ block?: { text?: string } }>) ?? [];
    return items.map(i => i.block?.text ?? '').join('\n');
  }

  test('live: the Bash output reaches the view model as renderable text', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'live').filter(v => v.command === 'ls -la');
    assert.ok(views.length > 0, 'the Bash card reached the webview');
    const last = views[views.length - 1];
    assert.strictEqual(last.description, 'List files in current directory',
      'the human description is latched (it arrives mid-stream)');
    const text = itemText(last);
    assert.ok(text.includes('total 38147'),
      `the OUTPUT must be in the items — an empty OUT is the bug this fixture pins. Got: ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(typeof last.output === 'string' && (last.output as string).includes('total 38147'),
      'and rawOutput is exposed too, as the fallback when no item is renderable');
  });

  test('replay: the same output survives a re-opened session', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'replay').filter(v => v.command === 'ls -la');
    assert.ok(views.length > 0, 'the replayed Bash card reached the webview');
    const last = views[views.length - 1];
    assert.ok(itemText(last).includes('total 38147'),
      'a re-opened session shows the same output (the replayed payload carries it)');
    assert.strictEqual(last.description, 'List files in current directory');
  });

  test('a failed command keeps its output and its failed status', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'live').filter(v => v.command === 'git status --short');
    assert.ok(views.length > 0, 'the failing card reached the webview');
    const last = views[views.length - 1];
    assert.strictEqual(last.status, 'failed');
    assert.ok(itemText(last).includes('not a git repository'),
      'the error text is what the reader needs here — it must not be dropped');
  });
});

// [CUSTOM-20260930-124/125] 连接相位与自动连接开关（宿主侧协议流）。
//
// 最要紧的是**无条件回话**：`refreshSessions` 靠签名去重，而 `ensureConnected` 在进程
// 已经起来时不发任何事件 ⇒ 少了 `connection` 消息，「已连接 + 无会话 + 点 Connect」这条路上
// 宿主一句话都不会说，客户端的「连接中」就永久卡死（pitfalls #29 的形态）。
// 下面第二个用例就是那条回归钉。
suite('chat panel: connection phase and the auto-connect switch', () => {
  /** The phases the host reported, in order. */
  function phases(harness: Harness): string[] {
    return harness.surface.sent
      .filter(m => m.type === 'connection')
      .map(m => String((m as { state?: string }).state));
  }

  function connectedAt(harness: Harness): number {
    return harness.surface.sent
      .findIndex(m => m.type === 'connection' && (m as { state?: string }).state === 'connected');
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  class ConnectSessionManager extends SessionManager {
    readonly ensured: string[] = [];
    readonly liveIds: string[] = [];
    readonly created: string[] = [];
    failWith: string | null = null;

    override async ensureConnected(agentName: string): Promise<ConnectionInfo> {
      this.ensured.push(agentName);
      if (this.failWith) { throw new Error(this.failWith); }
      return {} as ConnectionInfo;
    }

    override getSessionIdsForAgent(): string[] { return this.liveIds; }

    /** [CUSTOM-20260930-131] A connect with no session to focus now creates one. */
    override async createSession(agentName: string): Promise<SessionInfo> {
      this.created.push(agentName);
      const sessionId = `fresh-session-${this.created.length}`;
      registerFakeSession(this, sessionId, agentName);
      return {
        sessionId,
        agentId: 'fake-agent-id',
        agentName,
        agentDisplayName: agentName,
        cwd: '/tmp',
        createdAt: new Date().toISOString(),
        initResponse: {},
        modes: null,
        models: null,
        configOptions: null,
        availableCommands: [],
      } as unknown as SessionInfo;
    }
  }

  function connectHarness(liveIds: string[] = [], prefs = new StubPrefs()): {
    harness: Harness; manager: ConnectSessionManager;
  } {
    let manager!: ConnectSessionManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new ConnectSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      // Registered for real: `focusSession` looks the id up, and a focus is what the
      // "connected comes last" ordering test needs to observe.
      for (const id of liveIds) { registerFakeSession(manager, id, 'Claude Code'); }
      manager.liveIds.push(...liveIds);
      return manager;
    }, prefs);
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  test('a connect reports connecting, then connected', async () => {
    const { harness, manager } = connectHarness();
    harness.host.onMessage({ type: 'connectAgent' });
    // Immediate: this is the phase that disables the button, so a frame of delay is a
    // frame in which a second click gets through.
    assert.deepStrictEqual(phases(harness), ['connecting']);
    await waitFor(() => phases(harness).length >= 2, 'connected');
    assert.deepStrictEqual(phases(harness), ['connecting', 'connected']);
    // [CUSTOM-20260930-131] Nothing to focus ⇒ a session is created, so the composer the
    // user gets is a real one (images, mode/model pickers all hang off a session).
    assert.deepStrictEqual(manager.created, ['Claude Code']);
  });

  test('a connect with a session to focus does not create another one', async () => {
    const { harness, manager } = connectHarness(['other-session']);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('connected'), 'connected');
    assert.deepStrictEqual(manager.created, [], 'reuse, do not pile up');
  });

  test('a panel whose process is already up still hears "connected"', async () => {
    // The regression this message exists for: on this path nothing else speaks — no
    // `agent-connected` event, no signature change to trip `refreshSessions` — so a
    // silent host would leave the client on "Connecting…" forever.
    const { harness, manager } = connectHarness([]);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('connected'), 'connected');
    assert.deepStrictEqual(manager.ensured, ['Claude Code']);
    assert.deepStrictEqual(phases(harness), ['connecting', 'connected']);
  });

  test('the focus lands before "connected"', async () => {
    // Load-bearing order: the client opens a draft on 'connected' only when no session is
    // focused. Sending the phase first would hand the user a spare tab next to the session
    // the connect just found.
    const { harness } = connectHarness(['other-session']);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => connectedAt(harness) >= 0, 'connected');
    const focusAt = harness.surface.sent.findIndex(m => m.type === 'focus');
    assert.ok(focusAt >= 0, 'the session the connect found must be focused');
    assert.ok(focusAt < connectedAt(harness),
      `focus@${focusAt} must precede connected@${connectedAt(harness)}`);
  });

  test('a failed connect reports the phase and the error', async () => {
    const { harness, manager } = connectHarness();
    manager.failWith = 'agent would not start';
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('failed'), 'failed');
    assert.deepStrictEqual(phases(harness), ['connecting', 'failed']);
    const failure = harness.surface.sent
      .find(m => m.type === 'connection' && (m as { state?: string }).state === 'failed');
    assert.match(String((failure as { message?: string }).message), /agent would not start/);
    assert.ok(harness.surface.sent.some(m => m.type === 'error'), 'and the usual error line');
  });

  test('the switch writes through the seam and is echoed back', async () => {
    const prefs = new StubPrefs(false);
    const { harness } = connectHarness([], prefs);
    harness.host.onMessage({ type: 'setAutoConnect', value: true });
    await waitFor(() => prefs.writes.length > 0, 'the write');
    assert.deepStrictEqual(prefs.writes, [true]);
    await waitFor(() => harness.surface.sent.some(m => m.type === 'autoConnectPref'), 'the echo');
    const echo = harness.surface.sent.filter(m => m.type === 'autoConnectPref');
    assert.strictEqual((echo[echo.length - 1] as { value?: boolean }).value, true);
  });

  test('a write that fails echoes the value the setting actually holds', async () => {
    const prefs = new StubPrefs(false);
    prefs.failWith = new Error('read-only');
    const { harness } = connectHarness([], prefs);
    harness.host.onMessage({ type: 'setAutoConnect', value: true });
    await waitFor(() => harness.surface.sent.some(m => m.type === 'autoConnectPref'), 'the echo');
    const echo = harness.surface.sent.filter(m => m.type === 'autoConnectPref');
    // Not `true`: the write threw, so the setting still says false. Echoing the request
    // back would leave the checkbox showing a value settings.json does not have.
    assert.strictEqual((echo[echo.length - 1] as { value?: boolean }).value, false);
  });

  test('boot carries the setting', () => {
    const { harness } = connectHarness([], new StubPrefs(true));
    harness.host.onMessage({ type: 'ready' });
    const boot = harness.surface.sent.filter(m => m.type === 'boot').pop();
    assert.strictEqual((boot as { autoConnect?: boolean }).autoConnect, true);
  });

  test('only the boolean true turns auto-connect on', () => {
    for (const raw of [undefined, null, 'true', 'yes', 0, 1, {}, []]) {
      assert.strictEqual(resolveAutoConnect(raw), false, JSON.stringify(raw));
    }
    assert.strictEqual(resolveAutoConnect(true), true);
  });
});

// [CUSTOM-20260930-130] 标签圆点的「等待回答」：宿主从两个桥读（它们才是 pending 的唯一
// 持有者），并且**必须计入 refreshSessions 的签名**——漏签名的后果在 022/063 上踩过两次：
// 数据变了，标签栏却永远不刷新。
suite('chat panel: the tab dot and the waiting state', () => {
  interface SummaryWire { sessionId: string; waiting: boolean }

  function summaries(harness: Harness): SummaryWire[] {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as { type?: string; sessions?: SummaryWire[] };
      if (message.type === 'sessionsChanged') { return message.sessions ?? []; }
    }
    return [];
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  test('a session parked on a permission prompt is marked waiting, and cleared when answered', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.surface.sent.length = 0;

    void permission.request(
      { sessionId: 's-1', toolCall: { toolCallId: 't1', title: 'Run the tests' } } as never,
      // Only the dialog path uses the fallback; the harness has a presenter, so the
      // prompt lands in the panel and this never runs.
      (async () => ({ outcome: { outcome: 'cancelled' } })) as never,
    );

    await waitFor(() => summaries(harness).some(row => row.waiting), 'a waiting summary');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, true,
      'nothing advances until the reader answers — the strip has to be able to say so');

    // Settling it has to reach the strip too, or the dot would stay orange forever.
    permission.cancelSession('s-1');
    await waitFor(() => summaries(harness).some(row => row.waiting === false), 'the flag cleared');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, false);
  });
});

// [CUSTOM-20261001-156] 后台会话的权限 / 表单请求：从"窗口顶部的 QuickPick"改成"面板拥有 +
// 右下角通知"。用户截图里的那一幕（他在会话 A 里打字，会话 B 的权限请求弹到了窗口顶部）
// 正是旧判据的产物：canPresent 要求请求会话**必须聚焦**。这一档把"谁拥有请求"与"谁正在看它"
// 拆开——拥有 = 现代面板 + 有面（记录照建、跳过去就能答）；在不在屏幕上只决定要不要发通知。
suite('chat panel: background prompts notify instead of interrupting (CUSTOM-20261001-156)', () => {
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  /** Fire a permission request; returns the dialog-path spy (empty = the panel owns it). */
  function requestPermission(bridge: PermissionBridge, sessionId: string, title = 'Run the tests'): string[] {
    const calls: string[] = [];
    void bridge.request(
      { sessionId, toolCall: { toolCallId: `t-${sessionId}`, title } } as never,
      (async () => { calls.push('dialog'); return { outcome: { outcome: 'cancelled' } }; }) as never,
    );
    return calls;
  }

  /** A background session (registered, not focused — the harness focuses its own). */
  function addBackgroundSession(harness: Harness, sessionId: string, agentName = 'Claude Code'): void {
    registerFakeSession(harness.sessionManager, sessionId, agentName);
  }

  /** The permission record the host appended for one session, if any. */
  function permissionRecord(harness: Harness, sessionId: string): { permission?: { promptId?: string; status?: string } } | null {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessionId?: string;
        entries?: Array<{ kind?: string; permission?: { promptId?: string; status?: string } }>;
      };
      if (message.type !== 'append' || message.sessionId !== sessionId) { continue; }
      const entry = message.entries?.find(e => e.kind === 'permission');
      if (entry) { return entry; }
    }
    return null;
  }

  /** The last permission status the webview was told about for one session. */
  function permissionStatus(harness: Harness, sessionId: string): string | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessionId?: string; patch?: { permission?: { status?: string } };
      };
      if (message.sessionId !== sessionId) { continue; }
      if (message.type === 'revise' && message.patch?.permission) { return message.patch.permission.status; }
      if (message.type === 'append') { return permissionRecord(harness, sessionId)?.permission?.status; }
    }
    return undefined;
  }

  /** Let the async half of a prompt (a resolve on a microtask/macrotask) run out. */
  async function settleTurns(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  test('a background request is owned by the panel: record + notification, no dialog', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    addBackgroundSession(harness, 's-2');
    harness.surface.sent.length = 0;

    const dialogCalls = requestPermission(permission, 's-2', 'cd /repo && npm test');

    assert.deepStrictEqual(dialogCalls, [], 'the window-level QuickPick must not open for a session the panel owns');
    // `append` rides the outbox (coalesced), so the record lands a frame later.
    await waitFor(() => !!permissionRecord(harness, 's-2'), 'the record');
    assert.ok(permissionRecord(harness, 's-2'), 'the record is built now — jumping over finds the prompt waiting');
    assert.strictEqual(harness.notices.shown.length, 1, 'exactly one notification');
    assert.strictEqual(harness.notices.shown[0].level, 'warning', 'waiting is a warning: it stays on screen');
    assert.ok(harness.notices.shown[0].message.includes('等待权限确认'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('npm test'), 'and it says what is being asked for');
  });

  test('the focused session on a visible surface is NOT notified — the card is right there', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });

    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, []);
    await waitFor(() => !!permissionRecord(harness, 's-1'), 'the record');
    assert.deepStrictEqual(harness.notices.shown, [], 'a notification for a card the user is looking at is noise');
  });

  test('hiding the panel notifies even for the focused session', () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.surface.visibleFlag = false;

    requestPermission(permission, 's-1');
    assert.strictEqual(harness.notices.shown.length, 1, 'the panel is behind an editor — the user cannot see the card');
  });

  test('clicking the notification focuses that session, and the request can then be answered', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    addBackgroundSession(harness, 's-2');
    requestPermission(permission, 's-2');

    await harness.notices.click(0);
    await waitFor(() => harness.sessionManager.getActiveSessionId() === 's-2', 'focus moved to the notified session');
    assert.ok(harness.surface.reveals >= 1, 'and the panel came to the front (an explicit user action may take focus)');

    // The answer path a card/drawer click uses. It must be accepted: the prompt was
    // owned by the panel all along, so nothing has to be "re-activated" first.
    const promptId = permissionRecord(harness, 's-2')?.permission?.promptId;
    assert.ok(promptId, 'the record carries the prompt id the answer needs');
    harness.host.onMessage({ type: 'permissionAnswer', sessionId: 's-2', promptId, optionId: 'allow-once' });
    await waitFor(() => permissionStatus(harness, 's-2') === 'selected', 'the prompt settled');
    assert.strictEqual(harness.notices.shown.length, 1, 'and no second notification appeared');
  });

  test('a legacy agent still gets the dialog — the panel can never render it', () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    registerFakeSession(harness.sessionManager, 'legacy-1', 'Gemini CLI');

    const dialogCalls = requestPermission(permission, 'legacy-1');
    assert.deepStrictEqual(dialogCalls, ['dialog'], 'no modern panel exists for that agent, so the dialog is the only way to answer');
    assert.strictEqual(permissionRecord(harness, 'legacy-1'), null, 'and nothing was appended to a transcript it does not have');
  });

  test('with no surface at all the dialog stays the exit that cannot hang the agent', () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.host.detachSurface('view');

    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, ['dialog'], 'nothing can be drawn, so the request must reach the dialog (pitfall #14)');
  });

  test('losing the last surface still demotes a parked request (the #14 guard)', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, [], 'owned by the panel while a surface exists');

    harness.host.detachSurface('view');
    await waitFor(() => dialogCalls.length === 1, 'the parked request was demoted');
    assert.deepStrictEqual(dialogCalls, ['dialog'], 'onPresenterLost keeps its meaning: no surface ⇒ dialog');
  });

  test('a background form notifies with its question', () => {
    const elicitation = new ElicitationBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { elicitation });
    addBackgroundSession(harness, 's-2');

    void elicitation.request(askRequest('s-2'), async () => { throw new Error('the dialog must not open'); });

    assert.strictEqual(harness.notices.shown.length, 1, 'waiting-form is part of the set');
    assert.ok(harness.notices.shown[0].message.includes('等待你的回答'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('Which framework?'), 'the question itself rides along');
  });

  test('a finished background turn notifies once; a cancelled one stays silent', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    addBackgroundSession(harness, 's-2');

    // Resolve turns without an agent process (same trick as registerFakeSession, one
    // level up: `sendPrompt` is the only thing that needs a connection here).
    let stopReason = 'end_turn';
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await waitFor(() => harness.notices.shown.length === 1, 'the turn-done notification');
    assert.strictEqual(harness.notices.shown[0].level, 'info', 'a finished turn is information, not an alarm');
    assert.ok(harness.notices.shown[0].message.includes('已完成这一轮'), harness.notices.shown[0].message);

    // …and then a turn the user cancelled: they pressed Stop, they know.
    stopReason = 'cancelled';
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await settleTurns();
    assert.strictEqual(harness.notices.shown.length, 1, 'cancelling is not news');
  });

  test('a failed turn reuses the record\'s wording', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    addBackgroundSession(harness, 's-2');
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'refusal' }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await waitFor(() => harness.notices.shown.length === 1, 'the failure notification');
    // The toast carries the SAME wording the record does, clipped to fit (the detail
    // is one line by design — see composeNotice). Comparing the head of the string is
    // what keeps the two from drifting apart (pitfall #19).
    const expected = stopReasonText('refusal')!;
    assert.ok(harness.notices.shown[0].message.includes(expected.slice(0, 60)),
      `the notification and the transcript notice must not tell two stories, got: ${harness.notices.shown[0].message}`);
  });

  test('the focused, visible session gets no turn-done notification', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await settleTurns();
    assert.deepStrictEqual(harness.notices.shown, [], 'the user is watching this one finish');
  });

  /** An AskUserQuestion-shaped form request (same shape as elicitation-bridge.test.ts). */
  function askRequest(sessionId: string): CreateElicitationRequest {
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
            oneOf: [{ const: 'Astro official', title: 'Astro official' }],
          },
        },
      },
    } as unknown as CreateElicitationRequest;
  }
});

suite('chat panel: turn outcome wording (CUSTOM-20261001-157)', () => {
  test('a normal turn, a cancelled turn and a failed one are three different things', () => {
    assert.deepStrictEqual(turnOutcome('end_turn'), {}, 'a normal end says nothing extra');
    assert.strictEqual(turnOutcome('cancelled').silent, true, 'the user pressed Stop — no toast');
    assert.strictEqual(turnOutcome('refusal').failed, true);
    assert.strictEqual(turnOutcome('max_tokens').failed, true);
    assert.strictEqual(turnOutcome(undefined).silent, undefined, 'a missing reason is not "cancelled"');
  });

  test('only non-normal reasons have wording (shared by the record and the toast)', () => {
    assert.strictEqual(stopReasonText('end_turn'), null);
    assert.strictEqual(stopReasonText('cancelled'), null);
    assert.strictEqual(stopReasonText(undefined), null);
    assert.ok(stopReasonText('max_turn_requests')!.includes('agent-request limit'));
    assert.ok(stopReasonText('something-new')!.includes('something-new'), 'unknown reasons are still reported verbatim');
  });
});

// [CUSTOM-20261001-159/160] 记住用户选过的模式：新建会话套用、打开历史**不**套、草稿页显示它。
// 这条链最容易错的不是"记没记住"，而是**什么时候不该动** —— 把 load/resume 也当成"新会话"，
// 会改掉用户重新打开的那个会话自己的模式（那个模式是"重新打开它"的一部分）。
suite('chat panel: the remembered mode (CUSTOM-20261001-159/160)', () => {
  async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 20)); }

  const MODE_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' },
        { value: 'bypassPermissions', name: 'Bypass' },
      ],
    },
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
    },
  ];

  function modeHarness(remembered?: { configId: string; value: string }): { harness: Harness; memento: FakeMemento } {
    const memento = new FakeMemento();
    if (remembered) { void memento.update('acpc.lastMode.v1', { 'Claude Code': remembered }); }
    return { harness: makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento), memento };
  }

  /** Record the config-option writes the host makes, and reflect them on the session. */
  function spyWrites(harness: Harness, sessionId: string): Array<{ configId: string; value: string }> {
    const calls: Array<{ configId: string; value: string }> = [];
    Object.assign(harness.sessionManager, {
      setConfigOption: async (_sid: string, configId: string, value: string) => {
        calls.push({ configId, value });
        const session = harness.sessionManager.getSession(sessionId) as unknown as { configOptions?: unknown[] } | undefined;
        if (session) {
          session.configOptions = MODE_OPTIONS.map(o => (o.id === configId ? { ...o, currentValue: value } : o));
        }
      },
    });
    return calls;
  }

  /** Notice entries the host appended for one session (the switch announcement lands here). */
  function noticesOf(harness: Harness, sessionId: string): string[] {
    const out: string[] = [];
    for (const message of harness.surface.sent as Array<{
      type?: string; sessionId?: string; entries?: Array<{ kind?: string; text?: string }>;
    }>) {
      if (message.type !== 'append' || message.sessionId !== sessionId) { continue; }
      for (const entry of message.entries ?? []) {
        if (entry.kind === 'notice') { out.push(String(entry.text ?? '')); }
      }
    }
    return out;
  }

  test('a NEW session starts on the mode the user last chose', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    registerFakeSession(harness.sessionManager, 's-new', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-new');

    harness.sessionManager.emit('session-created', 's-new', 'Claude Code', 'new');
    await settle();

    assert.deepStrictEqual(calls, [{ configId: 'mode', value: 'bypassPermissions' }],
      'the new session is put on the mode the user last chose — the whole point of remembering it');
    await settle();
    assert.deepStrictEqual(noticesOf(harness, 's-new'), [],
      'and it is NOT announced as a switch the user never made (the baseline is seeded, 073/151)');
  });

  test('reopening a session from history does NOT touch its mode', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    registerFakeSession(harness.sessionManager, 's-old', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-old');

    // load and resume take the same event; an older caller may pass no origin at all.
    harness.sessionManager.emit('session-created', 's-old', 'Claude Code', 'load');
    harness.sessionManager.emit('session-created', 's-old', 'Claude Code', 'resume');
    harness.sessionManager.emit('session-created', 's-old');
    await settle();

    assert.deepStrictEqual(calls, [], 'a session reopened from history keeps the mode it was left in');
  });

  test('a remembered value the new session no longer offers is skipped, quietly', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'ghost-mode' });
    registerFakeSession(harness.sessionManager, 's-new', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-new');

    harness.sessionManager.emit('session-created', 's-new', 'Claude Code', 'new');
    await settle();

    assert.deepStrictEqual(calls, [], 'a stale default must not become a request the agent would reject');
    assert.deepStrictEqual(harness.notices.shown, [], 'and nobody is notified about a default that did not apply');
  });

  test('the mode the user picks is remembered (and persisted for the next window)', async () => {
    const { harness, memento } = modeHarness();
    registerFakeSession(harness.sessionManager, 's-2', 'Claude Code', { configOptions: MODE_OPTIONS });
    spyWrites(harness, 's-2');

    harness.host.onMessage({ type: 'setConfigOption', sessionId: 's-2', configId: 'mode', value: 'plan' });
    await settle();

    assert.deepStrictEqual(memento.get('acpc.lastMode.v1'), { 'Claude Code': { configId: 'mode', value: 'plan' } },
      'the value comes from the config option (the authoritative copy), and it survives a reload');
  });

  test('changing something that is NOT the mode remembers nothing', async () => {
    const { harness, memento } = modeHarness();
    registerFakeSession(harness.sessionManager, 's-3', 'Claude Code', { configOptions: MODE_OPTIONS });
    spyWrites(harness, 's-3');

    harness.host.onMessage({ type: 'setConfigOption', sessionId: 's-3', configId: 'model', value: 'opus' });
    await settle();

    assert.strictEqual(memento.get('acpc.lastMode.v1'), undefined,
      'one message carries every option — only the mode one is a remembered preference');
  });

  test('the draft page shows the remembered mode as the current value (160)', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    // The draft snapshot is the agent's last-seen options; the remembered mode overlays it.
    registerFakeSession(harness.sessionManager, 'seeded', 'Claude Code', { configOptions: MODE_OPTIONS });
    harness.sessionManager.emit('config-options-changed', 'seeded');
    harness.sessionManager.emit('available-commands-changed', 'seeded');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd1' });
    const reply = harness.surface.sent.find(m => m.type === 'draftOptions') as unknown as {
      configOptions: Array<{ id: string; currentValue: string }>;
    };
    assert.ok(reply, 'the draft page always gets an answer (pitfall #29)');
    assert.strictEqual(reply.configOptions.find(o => o.id === 'mode')?.currentValue, 'bypassPermissions',
      'what the picker shows is what the new session will get');
    assert.strictEqual(reply.configOptions.find(o => o.id === 'model')?.currentValue, 'sonnet',
      'other options stay the agent\'s own last-seen values');
  });
});

// [CUSTOM-20261001-162] 轮次之外的 agent 工作（后台子任务）。用户报的现象：任务还在跑（在等
// 子 agent），发送按钮却已经变回普通状态。判据原本只看"轮次请求还没返回"，而后台子任务会在
// 轮次结束后继续干活。这里钉住这台状态机的四条边：进入要有证据、产出会续期、汇报即结束、
// 静默超时要**说出来**（静默复原正是用户看到的那种"没人告诉我发生了什么"）。
suite('chat panel: background work keeps the session running (CUSTOM-20261001-162)', () => {
  async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 15)); }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  /** The host's picture of one session, as the client receives it. */
  function runningOf(harness: Harness, sessionId: string): boolean | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessions?: Array<{ sessionId: string; running: boolean }>;
      };
      if (message.type !== 'sessionsChanged') { continue; }
      const row = (message.sessions ?? []).find(s => s.sessionId === sessionId);
      if (row) { return row.running; }
    }
    return undefined;
  }

  function note(harness: Harness, update: Record<string, unknown>, sessionId = harness.sessionId): void {
    harness.handler.handleUpdate({ sessionId, update } as never);
  }

  /** A Task tool call that asks the agent to run it in the background — the only
   *  evidence we get that work will outlive the turn. */
  const launch = {
    sessionUpdate: 'tool_call', toolCallId: 't-task', title: 'Task', kind: 'other',
    rawInput: { description: 'diff a third file', prompt: '…', run_in_background: true },
  };

  test('a launched background task keeps the session running', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    // NOTE: nothing to assert before the launch — until something changes, the host has
    // not pushed a `sessionsChanged` at all (the harness only attaches a surface).

    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true,
      'the agent said it launched background work — the composer must not offer Send');
  });

  test('housekeeping notifications never arm it', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 20);
    note(harness, { sessionUpdate: 'session_info_update', title: 'x' });
    note(harness, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    note(harness, { sessionUpdate: 'usage_update', used: 1, size: 2 });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false,
      'a title/command/usage notification is not work — a Stop button there would be a lie');
  });

  test('output keeps the wait alive; silence ends it', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    note(harness, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still going…' } });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true, 'a chunk re-arms the watchdog');

    await waitFor(() => runningOf(harness, 's-1') === false, 'the wait to time out');
  });

  test('the quiet timeout says so instead of silently coming back', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 30);
    // The user is looking elsewhere: the notice is the only way they learn the wait ended.
    harness.surface.visibleFlag = false;
    note(harness, launch);

    await waitFor(() => runningOf(harness, 's-1') === false, 'the wait to time out');
    assert.strictEqual(harness.notices.shown.length, 1, 'exactly one notice');
    assert.ok(harness.notices.shown[0].message.includes('后台任务'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('超时'), harness.notices.shown[0].message);
  });

  test('the task reporting back ends the wait without a notice', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    note(harness, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: '<task-notification>\nBackground task finished.\n</task-notification>' },
    });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false, 'the work we were waiting for reported back');
    assert.deepStrictEqual(harness.notices.shown, [], 'and the expected end is not news');
  });

  test('a new turn clears the background wait (no lingering Stop)', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }),
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false,
      'the turn is over and the background wait was already cleared — nothing keeps it "running"');
  });
});

// [CUSTOM-20261004-184] Markdown links to local files.
//
// The bug: `[GOAL.md:74](GOAL.md:74)` rendered as a struck-through grey span
// (title="Blocked link scheme") — it LOOKED clickable and did nothing, because
// `link()` only allowlisted http/https/mailto and dumped every other href into
// the "blocked scheme" branch. Fixing that is invisible to every existing check
// (a wrong href shape still renders *something*), so the routing is pinned here.
suite('chat panel: markdown links to local files', () => {
  const md = new SafeMarkdown();
  const render = (link: string) => md.render(link);

  test('a relative path with a line number becomes an openFile link', () => {
    const html = render('[GOAL.md:74](GOAL.md:74)');
    assert.ok(html.includes('data-path="GOAL.md"'), `expected a file link, got ${html}`);
    assert.ok(html.includes('data-line="74"'), `expected the line to travel, got ${html}`);
    assert.ok(!html.includes('link-blocked'), 'it must not be inert any more');
    assert.ok(html.includes('>GOAL.md:74</a>'), `label must be preserved, got ${html}`);
  });

  test('a GitHub-style fragment carries the line too', () => {
    const html = render('[a.ts](./src/a.ts#L12)');
    assert.ok(html.includes('data-path="./src/a.ts"'), `got ${html}`);
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
  });

  test('a fragment range jumps to its first line', () => {
    const html = render('[a.ts](src/a.ts#L12-L30)');
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
  });

  test('an absolute path survives the line split', () => {
    // Forward slashes: CommonMark reads `\r` in a link destination as an escape,
    // so a backslash path never reaches us as a link at all (measured, not
    // assumed) — and fileUri() accepts `C:/…` just as well as `C:\…`.
    const html = render('[a.ts](C:/repo/src/a.ts:12)');
    assert.ok(html.includes('data-path="C:/repo/src/a.ts"'), `got ${html}`);
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
  });

  test('a file: URI opens the local file instead of warning about the scheme', () => {
    const url = pathToFileURL(path.resolve(__dirname, 'fixtures')).toString();
    const html = render(`[f](${url})`);
    assert.ok(html.includes('data-path="'), `got ${html}`);
    assert.ok(!html.includes('link-blocked'), `got ${html}`);
  });

  test('a path without a line still opens, with no data-line', () => {
    const html = render('[notes.md](docs/notes.md)');
    assert.ok(html.includes('data-path="docs/notes.md"'), `got ${html}`);
    assert.ok(!html.includes('data-line='), `got ${html}`);
  });

  test('quotes in a path are escaped, not able to break out of the attribute', () => {
    // Angle-bracket destination: the only form CommonMark lets carry a `"`.
    const html = render('[x](<a"b.ts>)');
    assert.ok(html.includes('data-path="a&quot;b.ts"'), `got ${html}`);
  });

  test('http links keep taking the external channel', () => {
    const html = render('[site](https://example.com/x#L12)');
    assert.ok(html.includes('data-href="https://example.com/x#L12"'), `got ${html}`);
  });

  test('unknown schemes stay inert', () => {
    for (const link of ['[x](javascript:alert(1))', '[x](command:workbench.action.closeAllEditors)', '[x](data:text/html,<b>x</b>)']) {
      const html = render(link);
      assert.ok(html.includes('link-blocked'), `${link} must stay blocked, got ${html}`);
      assert.ok(!html.includes('data-path'), `${link} must not become a file link, got ${html}`);
    }
  });

  test('a fragment on its own is not a file target', () => {
    // Opening "line 74 of nothing" (i.e. some unrelated file at line 74) would be
    // a worse outcome than leaving the link inert.
    const html = render('[see](#L74)');
    assert.ok(html.includes('link-blocked'), `got ${html}`);
    const section = render('[see](#section)');
    assert.ok(section.includes('link-blocked'),
      `an anchor we cannot resolve must not silently open a file: ${section}`);
  });
});

// [CUSTOM-20261004-185] 上下文圆环只认 usage_update。
//
// 起因（用户报"上下文进度会出现超过上限的情况"，截图 tooltip：`100% · 1841k / 1000k tokens`）：
// 宿主曾在每次轮次结束时把 `PromptResponse.usage.totalTokens` 折进圆环的 `used`。而 ACP 协议里
// 那个字段是 *Sum of all token types **across session*** —— claude-agent-acp 的实现是每轮
// `accumulatedUsage.inputTokens += …`（cache read 每轮重算），是个只增不减的累计量；`size` 却是
// **窗口大小**。两者不是一回事，会话一长必然出现 1841k / 1000k。
// 这条测试钉住"响应里的 usage 不许动圆环"（旧代码在下面第二次断言处失败）。
suite('chat panel: the context ring only trusts usage_update', () => {
  function usageOf(harness: Harness): unknown {
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'focus' || message.type === 'boot') { return message.meta?.usage ?? null; }
    }
    return 'no snapshot was posted';
  }

  test('a prompt response carrying cumulative tokens does not touch the meter', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'usage_update', used: 55642, size: 1000000,
        // The shape the agent really sends (measured, see the log): a raw float.
        cost: { amount: 2.6394680000000004, currency: 'USD' },
      },
    } as never);
    const reported = {
      used: 55642, size: 1000000,
      costAmount: 2.6394680000000004, costCurrency: 'USD',
    };
    assert.deepStrictEqual(usageOf(harness), reported,
      'the agent-reported context usage is what the ring shows');

    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({
        stopReason: 'end_turn',
        usage: { totalTokens: 1_841_000, inputTokens: 1_840_000, outputTokens: 1000 },
      }),
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepStrictEqual(usageOf(harness), reported,
      'a session-cumulative token total must never be rendered as context-window occupancy');
  });
});

// [CUSTOM-20261004-186] 渲染回填只对"它就是照这段文本渲染的"那一版生效。
//
// 客户端发起渲染请求时给的是**那一刻**的文本（记录一落地就发，128），而正文还在流；
// 回填补上时记录往往已经更长。旧代码把这份 html 照收进 store，下一次快照（切会话 / 重开）
// 就会把"只渲染了开头几个字"的版本当成当前内容发给客户端 —— 记录看上去就是"显示不全"。
suite('chat panel: a stale markdown reply is not stored', () => {
  function chunk(harness: Harness, text: string): void {
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
    } as never);
  }

  /** The id the host assigned to the assistant record it just appended. */
  function assistantId(harness: Harness): string {
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'append') {
        const entry = message.entries.find(e => e.kind === 'assistant');
        if (entry) { return entry.id; }
      }
    }
    throw new Error('no assistant record was appended');
  }

  /** The assistant entry the host is holding, as a snapshot would carry it. */
  function entryOf(harness: Harness, entryId: string): { text?: string; html?: string } | undefined {
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'focus' || message.type === 'boot') {
        const found = (message.snapshot?.entries ?? []).find(e => e.id === entryId);
        return found as { text?: string; html?: string } | undefined;
      }
    }
    return undefined;
  }

  test('a reply rendered from an older text never reaches the record', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, '后端');
    const id = assistantId(harness);
    // The record grows while the reply is in flight.
    chunk(harness, '**没事**——被终止的只是那层包装 shell');

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [{ entryId: id, sessionId: 's-1', text: '后端' }],
    } as never);

    const entry = entryOf(harness, id);
    assert.strictEqual(entry?.text, '后端**没事**——被终止的只是那层包装 shell', 'the record kept the text');
    assert.strictEqual(entry?.html, undefined,
      'the rendering of the prefix must not be stored as if it were the record');
  });

  test('a reply for the text the record actually has is stored', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, '完整正文');
    const id = assistantId(harness);

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [{ entryId: id, sessionId: 's-1', text: '完整正文' }],
    } as never);

    assert.ok(entryOf(harness, id)?.html, 'the matching reply is still applied (this is the normal path)');
  });
});

// [CUSTOM-20261004-187] 轮次进行中发消息 = 注入**正在跑的那一轮**（steering），不是第二个轮次。
//
// 关键不变量：steering 不产生第二个 PromptResponse。走普通路径要么被"已有轮次在跑"守卫拒掉
// （用户报的"任务进行中按回车没反应"），要么永远 await 不到响应（Stop 按钮永不熄灭、
// finalizeTurn 永不执行）。
suite('chat panel: a message sent mid-turn steers the running turn', () => {
  function steerHarness(supported: boolean, outcome: 'steered' | 'idle') {
    const harness = makeHarness('s-1', 'Claude Code');
    const steered: Array<{ sessionId: string; blocks: unknown }> = [];
    const prompted: string[] = [];
    Object.assign(harness.sessionManager, {
      hasRunningTurn: () => true,
      supportsSteering: () => supported,
      steerPrompt: (sessionId: string, blocks: unknown) => {
        steered.push({ sessionId, blocks });
        return Promise.resolve(outcome);
      },
      sendPrompt: (sessionId: string) => {
        prompted.push(sessionId);
        return Promise.resolve({ stopReason: 'end_turn' });
      },
    });
    return { harness, steered, prompted };
  }

  test('the message is injected, and the running turn is left alone', async () => {
    const { harness, steered, prompted } = steerHarness(true, 'steered');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(steered.length, 1, 'the message went out through the steering channel');
    assert.strictEqual(steered[0].sessionId, 's-1');
    assert.deepStrictEqual(steered[0].blocks, [{ type: 'text', text: '补充一句' }]);
    assert.deepStrictEqual(prompted, [], 'and NOT as a second prompt (that would be a second turn)');
    assert.deepStrictEqual(harness.notices.shown, [],
      'the turn is still running — a "turn finished" notice here would be a lie');
    const state = settle(harness, harness.agentName, harness.sessionId);
    assert.ok(visibleText(state).includes('补充一句'), 'the message still lands in the transcript');
  });

  test('an idle agent falls back to a normal prompt instead of swallowing it', async () => {
    const { harness, steered, prompted } = steerHarness(true, 'idle');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(steered.length, 1, 'steering was attempted (our own flag said a turn was running)');
    assert.deepStrictEqual(prompted, ['s-1'],
      'the agent said no turn was running, so the message must go out as an ordinary prompt');
  });

  test('an agent without steering never gets one', async () => {
    const { harness, steered, prompted } = steerHarness(false, 'steered');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepStrictEqual(steered, [], 'a capability we do not have must not be exercised');
    assert.deepStrictEqual(prompted, ['s-1'], 'it goes down the ordinary path');
  });
});

// [CUSTOM-20261006-194] 连接期间，agent 的 stderr 要送到面板上。
//
// 用户报"一直卡在连接界面"。日志里的原因是 npx 在下载新版本适配器
// （`The following package was not found and will be installed: …`），而 `initialize` 要等它 ——
// 那几行此前只进日志，卡片上永远只有 "Connecting…"。这条把"送上去"这一跳钉住；
// "连上之后不再送"同样钉住（那时的 stderr 只是噪声）。
suite('chat panel: the connecting card hears why it is slow', () => {
  function connectionMessages(harness: Harness): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === 'connection') as Array<Record<string, unknown>>;
  }

  test('an agent stderr line rides the connecting phase, and stops after it', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    // 让 ensureConnected 永远挂着：停在 connecting 相位，不去真的 spawn 一个进程。
    Object.assign(harness.sessionManager, { ensureConnected: () => new Promise(() => { /* never */ }) });
    harness.host.onMessage({ type: 'connectAgent', agentName: 'Claude Code' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(connectionMessages(harness).some(m => m.state === 'connecting'),
      'the connecting phase went out first');

    harness.sessionManager.emit('agent-stderr', {
      agentId: 'agent_1',
      line: 'npm warn exec The following package was not found and will be installed: @agentclientprotocol/claude-agent-acp@0.86.0',
    });

    const withDetail = connectionMessages(harness).filter(m => m.detail !== undefined);
    assert.strictEqual(withDetail.length, 1, `expected one detail line, got ${JSON.stringify(withDetail)}`);
    assert.match(String(withDetail[0].detail), /will be installed/);
    assert.strictEqual(withDetail[0].state, 'connecting', 'and it stays in the connecting phase');

    // 相位结束（让这次连接失败收尾）之后，同样的 stderr 不再上卡片。
    Object.assign(harness.sessionManager, { ensureConnected: () => Promise.reject(new Error('nope')) });
    harness.host.onMessage({ type: 'connectAgent', agentName: 'Claude Code' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(connectionMessages(harness).some(m => m.state === 'failed'), 'the phase is over');

    const before = connectionMessages(harness).length;
    harness.sessionManager.emit('agent-stderr', { agentId: 'agent_1', line: 'a later, harmless warning' });
    assert.strictEqual(connectionMessages(harness).length, before, 'no stderr noise once the phase is over');
  });
});
