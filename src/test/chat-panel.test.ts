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
import * as vscode from 'vscode';

import type { SessionNotification } from '@agentclientprotocol/sdk';

import type { PromptResponse } from '@agentclientprotocol/sdk';

import { AgentManager } from '../core/AgentManager';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionHistoryStore } from '../core/SessionHistoryStore';
import { SessionManager, pickDefaultCwd, type SessionInfo } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { isBlankText } from '../ui/chat/content/contentBlocks';
import type { ChatSurface, SurfaceKey } from '../ui/chat/ChatSurface';
import { ChatPanelHost } from '../ui/chat/ChatPanelHost';
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
  readonly webview = {
    options: {} as vscode.WebviewOptions,
    cspSource: 'vscode-webview://chat-panel-test',
    postMessage: (message: ExtToChatMessage) => {
      this.sent.push(message);
      return Promise.resolve(true);
    },
  } as unknown as vscode.Webview;

  get visible(): boolean { return true; }
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
function registerFakeSession(manager: SessionManager, sessionId: string, agentName: string): void {
  const internals = manager as unknown as {
    sessions: Map<string, unknown>;
    agentSessions: Map<string, Set<string>>;
    agentProcesses: Map<string, string>;
  };
  internals.sessions.set(sessionId, {
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
  });
  internals.agentProcesses.set(agentName, 'fake-agent-id');
  const ids = internals.agentSessions.get(agentName) ?? new Set<string>();
  ids.add(sessionId);
  internals.agentSessions.set(agentName, ids);
}

interface Harness {
  host: ChatPanelHost;
  surface: RecordingSurface;
  handler: SessionUpdateHandler;
  sessionManager: SessionManager;
  sessionId: string;
  agentName: string;
}

function makeHarness(
  sessionId: string,
  agentName = 'Claude Code',
  managerFactory?: (handler: SessionUpdateHandler) => SessionManager,
): Harness {
  const handler = new SessionUpdateHandler();
  const sessionManager = managerFactory
    ? managerFactory(handler)
    : new SessionManager(new AgentManager(), new ConnectionManager(handler), handler);
  registerFakeSession(sessionManager, sessionId, agentName);
  const host = new ChatPanelHost(vscode.Uri.file('/tmp/chat-panel-test'), sessionManager, handler);
  const surface = new RecordingSurface();
  host.attachSurface(surface, { agentName, sessionId });
  return { host, surface, handler, sessionManager, sessionId, agentName };
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
    readonly opened: Array<{ agentName: string; sessionId: string; cwd?: string }> = [];
    override async openExistingSession(
      agentName: string,
      sessionId: string,
      opts: { cwd?: string } = {},
    ): Promise<'live' | 'load' | 'resume'> {
      this.opened.push({ agentName, sessionId, cwd: opts.cwd });
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

  test("a session's own directory is passed through to the open call", async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      cwd: 'D:\\other\\project',
    });
    await Promise.resolve();
    assert.deepStrictEqual(manager.opened, [
      { agentName: 'Claude Code', sessionId: 'other-session', cwd: 'D:\\other\\project' },
    ]);
  });

  test('an omitted directory stays undefined, so loadSession can fall back to the cache', async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 's' });
    await Promise.resolve();
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].cwd, undefined);
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
      registerFakeSession(this, sessionId, agentName);
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
        configOptions: null,
        availableCommands: [],
      } as unknown as SessionInfo;
    }

    override async sendPrompt(sessionId: string, prompt: unknown): Promise<PromptResponse> {
      this.sent.push({ sessionId, prompt });
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

  function draftHarness(): { harness: Harness; manager: DraftSessionManager } {
    let manager!: DraftSessionManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new DraftSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
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
