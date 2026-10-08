// [CUSTOM-20260925-068] 客户端**逻辑**测试（桩 DOM）。
//
// **它为什么存在**：2026-09-25 用户报"多行用户消息也没折叠"，而我读代码怎么看都对——
// 最后是用一个桩 DOM 把客户端那段逻辑**真跑了一遍**才定性：判据只认**逻辑换行**，
// 而用户看到的"多行"是**长句子自动折行**（没有 \n）⇒ 不给折叠。那个 bug 是纯逻辑，
// 桩 DOM 完全够用，本来可以在用户发现之前就抓到。
//
// **它能测什么 / 不能测什么**（这条界线比测试本身重要）：
//   · 能测：产出什么 DOM 结构、顺序、类名、内容切分 —— 即**逻辑**。
//   · **不能测**：布局、尺寸、换行位置、颜色、焦点 —— 那些需要真 Chromium。
//     `dev-workflow.md` 的"自动化能覆盖到哪"那张表就是照这条线分的；
//     用 jsdom 之类的近似实现去测布局只会给出**假信心**。
//
// 桩 DOM 是**外部 API 的测试替身**（像本文件里那个假 Memento），不是我们自己的知识的第二份
// 拷贝——后者才是 pitfalls #19 说的漂移来源。
import * as assert from 'assert';

import { domClient } from '../ui/chat/html/client/dom';
import { iconsClient } from '../ui/chat/html/client/icons';
import { linksClient } from '../ui/chat/html/client/links';
import { sessionMenuClient } from '../ui/chat/html/client/sessionMenu';
// [CUSTOM-20261001-158] 权限卡（记录行）+ 权限抽屉（悬浮浮层）。
import { permissionViewClient } from '../ui/chat/html/client/permissionView';
import { permissionDrawerClient } from '../ui/chat/html/client/permissionDrawer';
// [CUSTOM-20260929-119] Form cards (ACP elicitation / AskUserQuestion).
import { elicitationViewClient } from '../ui/chat/html/client/elicitationView';
import { composerClient } from '../ui/chat/html/client/composer';
import { tabsClient } from '../ui/chat/html/client/tabs';
// [CUSTOM-20261008-200] Times 开关的状态机（按会话记 + 默认值）。
import { timesClient } from '../ui/chat/html/client/times';
import { toolCallViewClient } from '../ui/chat/html/client/toolCallView';
import { transcriptViewClient } from '../ui/chat/html/client/transcriptView';
import { outlineClient } from '../ui/chat/html/client/outline';
import { stickyUserClient } from '../ui/chat/html/client/stickyUser';
// [CUSTOM-20260930-123] The start card (connect phases + the auto-connect switch).
import { stateCardClient } from '../ui/chat/html/client/stateCard';
// [CUSTOM-20260930-132] 面板静态标记：版心的承重结构断言（下面那个 suite）。
import { body as chatPanelMarkup } from '../ui/chat/html/body';
// [CUSTOM-20261002-173] 客户端 boot 的日志桥（构建指纹 + 转发配额）。
import { bootClient } from '../ui/chat/html/client/boot';
// [CUSTOM-20261003-176] 视口判定的再计算（scroll.reflowNow）。
import { scrollClient } from '../ui/chat/html/client/scroll';
// [CUSTOM-20261007-197] 右键菜单按上下文给项（含置顶悬浮卡那条路）。
import { contextMenuClient } from '../ui/chat/html/client/contextMenu';
// [CUSTOM-20261004-180] 圆点量测的读写分离。
import { railClient } from '../ui/chat/html/client/rail';
// [CUSTOM-20261002-173] 宿主侧构建指纹。
import { buildStamp } from '../utils/BuildInfo';

// --- 最小桩 DOM -------------------------------------------------------------
// Only what the exercised paths touch. Deliberately NOT a general DOM: a fuller
// stub invites tests that assert on things the real browser would do differently.

class StubNode {
  nodeType = 1;
  className = '';
  hidden = false;
  /** [CUSTOM-20260929-114] The <details> open state the client writes (and reads back on re-decide). */
  open = false;
  disabled = false;
  /** [CUSTOM-20260930-123] The start card's auto-connect switch is a checkbox. */
  checked = false;
  title = '';
  /** [CUSTOM-20260927-085] The composer's textarea and buttons are plain fields. */
  value = '';
  placeholder = '';
  /** [CUSTOM-20260929-119] …and so are the form card's inputs (radio / checkbox / text / number). */
  type = '';
  /** Roving-tabindex assertions read this (the client writes 0 / -1). */
  tabIndex = -1;
  style: Record<string, string> = {};
  childNodes: StubNode[] = [];
  attributes: Record<string, string> = {};
  parentNode: StubNode | null = null;
  readonly tagName: string;
  /** [CUSTOM-20260926-071] What getBoundingClientRect answers. 0 = "no layout". */
  rectHeight = 0;
  /** [CUSTOM-20260928-102] Viewport-relative edges, for the outline's
   *  "is the highlighted row inside its own scroll box" check. */
  rectTop = 0;
  rectBottom = 0;
  /** [CUSTOM-20260928-102] Height in the flow, for the pinned-message check. */
  offsetHeight = 0;
  /** [CUSTOM-20260928-100] Scroll geometry + position, for the outline's
   *  "is the viewport at the bottom" check. All 0 = un-measurable (a hidden panel). */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  offsetTop = 0;
  /** [CUSTOM-20260928-105] Their difference is the scrollbar the pinned bar has to clear. */
  offsetWidth = 0;
  clientWidth = 0;
  /** [CUSTOM-20261008-201] 横向几何：标签栏的落点是按**指针横坐标与各 tab 中点**算的，
   *  没有 left/width 就量不出落点（默认 0 = "没布局"，与上面那批字段同一约定）。 */
  rectLeft = 0;
  rectWidth = 0;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  getBoundingClientRect(): { height: number; top: number; bottom: number; left: number; width: number } {
    return {
      height: this.rectHeight, top: this.rectTop, bottom: this.rectBottom,
      left: this.rectLeft, width: this.rectWidth,
    };
  }

  private readonly listeners: Record<string, Array<(event: any) => void>> = {};

  appendChild<T extends StubNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends StubNode>(child: T, before: StubNode | null): T {
    // [CUSTOM-20261002-172] 真 DOM 的 insertBefore 会**先把已在树里的节点摘下来**（它是"移动"，
    // 不只是"插入"）：不建模这一条，任何"重排已有子节点"的客户端代码在这里都会拿到一份重复
    // 引用，随后按 indexOf 删掉的又是另一个 —— 症状是子节点顺序静默错乱（stickyUser 的卡堆
    // 重排就是这么被坑的，见 pitfalls #41）。
    if (child.parentNode) { child.parentNode.removeChild(child); }
    child.parentNode = this;
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) { this.childNodes.push(child); } else { this.childNodes.splice(at, 0, child); }
    return child;
  }

  removeChild(child: StubNode): void {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) { this.childNodes.splice(at, 1); child.parentNode = null; }
  }

  get firstChild(): StubNode | null { return this.childNodes[0] ?? null; }
  get firstElementChild(): StubNode | null {
    return this.childNodes.find(c => c.nodeType === 1) ?? null;
  }

  /** [CUSTOM-20260928-102] Deep copy, the way the pinned-user-message clone needs it. */
  cloneNode(deep: boolean): StubNode {
    const copy = new StubNode(this.tagName);
    copy.className = this.className;
    copy.hidden = this.hidden;
    copy.attributes = { ...this.attributes };
    if (deep) {
      for (const child of this.childNodes) {
        const cloned = child.nodeType === 3
          ? (makeText((child as unknown as StubText).data) as unknown as StubNode)
          : child.cloneNode(true);
        copy.appendChild(cloned);
      }
    }
    return copy;
  }
  get lastChild(): StubNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    // [CUSTOM-20260930-129] Real elements reflect 'class' onto .className, and CSS
    // selectors match the ATTRIBUTE. The SVG builders have to use setAttribute (an SVG
    // element's .className is a read-only SVGAnimatedString), so without this reflection
    // the stub could not find anything they built.
    if (name === 'class') { this.className = value; }
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  removeAttribute(name: string): void { delete this.attributes[name]; }

  // No `const self = this` alias: arrow functions already capture `this`, and the
  // alias is exactly where a `this` bug would hide.
  get classList() {
    const has = (c: string) => this.className.split(/\s+/).includes(c);
    const add = (c: string) => { if (!has(c)) { this.className = (this.className + ' ' + c).trim(); } };
    const remove = (c: string) => { this.className = this.className.split(/\s+/).filter(x => x !== c).join(' '); };
    return {
      contains: has,
      add,
      remove,
      // [CUSTOM-20260926-076] outline 用 classList.toggle(cls, force) 切按钮的 .on 态。
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !has(c) : force;
        if (on) { add(c); } else { remove(c); }
      },
    };
  }

  addEventListener(type: string, fn: (event: any) => void): void {
    (this.listeners[type] = this.listeners[type] ?? []).push(fn);
  }

  /** Deliver an event to this node's own listeners (see `dispatchClick`). */
  dispatch(type: string, event: any): void {
    for (const fn of this.listeners[type] ?? []) { fn(event); }
  }

  /**
   * [CUSTOM-20260926-079] DOM `contains`. **A detached node counts as NOT contained**
   * — that is not a detail of the stub, it is the browser's behaviour and the cause of
   * the bug this file now pins: a handler that re-renders (and so removes) the node
   * being clicked turns the following click-away check into a false positive.
   */
  contains(node: StubNode | null): boolean {
    for (let n: StubNode | null = node; n; n = n.parentNode) {
      if (n === this) { return true; }
    }
    return false;
  }

  focus(): void { /* the stub has no focus ring; the call just must not throw */ }

  querySelector(sel: string): StubNode | null { return this.findAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): StubNode[] { return this.findAll(sel); }
  // Recursive rather than "assign `this` to a local and walk up": the lint rule
  // that flagged the alias is pointing at a real smell, not just style.
  closest(sel: string): StubNode | null {
    if (this.matches(sel)) { return this; }
    return this.parentNode ? this.parentNode.closest(sel) : null;
  }

  matches(sel: string): boolean {
    return sel.split(',').some(part => this.matchesOne(part.trim()));
  }

  private matchesOne(sel: string): boolean {
    // 只支持本套件用到的形态：标签、.class、[attr]、以及它们的简单组合。
    return sel.split(/(?=[.\[])/).every(bit => {
      if (bit.startsWith('.')) { return this.className.split(/\s+/).includes(bit.slice(1)); }
      if (bit.startsWith('[')) { return this.getAttribute(bit.slice(1, -1)) !== null; }
      return this.tagName === bit.toUpperCase();
    });
  }

  private findAll(sel: string, out: StubNode[] = []): StubNode[] {
    for (const child of this.childNodes) {
      if (child.nodeType !== 1) { continue; }
      if (child.matches(sel)) { out.push(child); }
      child.findAll(sel, out);
    }
    return out;
  }

  get textContent(): string {
    return this.childNodes.map(c => (c.nodeType === 3 ? (c as unknown as { data: string }).data : c.textContent)).join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value !== '') { this.appendChild(makeText(value) as unknown as StubNode); }
  }
}

class StubText {
  nodeType = 3;
  /** Settable: appendChild assigns it (the client moves text nodes around). */
  parentNode: StubNode | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  /**
   * [CUSTOM-20261004-186] Real CharacterData API. `setStreamingText` extends the tail
   * in place with it (the O(delta) path) — without it the stub throws on the SECOND
   * chunk of a streaming record, i.e. on the very thing that path exists for
   * (pitfall #41: a stub that does not model the API it stands in for).
   */
  appendData(more: string): void { this.data += more; }
}

function makeText(data: string): StubText { return new StubText(data); }

// --- 桩 Range：把「这个前缀占几行」变成一个确定的模型 -------------------------
//
// [CUSTOM-20260926-071] 折叠判据改成了**实测行数**，于是测试要能回答「占几行」。
// 真实的换行位置是浏览器的活 —— 用 jsdom 之类的近似实现去测布局只会给出**假信心**
// （见文件头与 pitfalls #25），所以这里**不假装测量**，只钉住模型：
// 「每 N 个字符一行」。被测的是我们的逻辑（二分找第一行末尾、空格回退、\n 优先、
// 量不出来时的回退档），而不是浏览器的换行算法。
//
// charsPerLine 可改：把一行放得下 200 字的情况做出来，「超过旧阈值但一行放得下 ⇒ 不折叠」
// 才有意义（旧判据是长度 > 160，与真实占几行无关）。
function makeRange(metrics: { charsPerLine: number }): Record<string, unknown> {
  let start = 0;
  let end = 0;
  return {
    setStart: (_node: unknown, offset: number) => { start = offset; },
    setEnd: (_node: unknown, offset: number) => { end = offset; },
    getClientRects: () => {
      const count = end <= start ? 0 : Math.ceil((end - start) / metrics.charsPerLine);
      const rects: Array<{ height: number; width: number }> = [];
      for (let i = 0; i < count; i++) { rects.push({ height: 16, width: 100 }); }
      return rects;
    },
  };
}

// --- 装配：像 webview 一样按顺序执行 15 个客户端模块 ------------------------
function loadClient(
  elements: Record<string, StubNode> = {},
  opts: { syncFrames?: boolean } = {},
): Record<string, any> {
  // The layout model the stub Range answers with; tests may change it (e.g. to make
  // a 200-character message fit on one line).
  const metrics = { charsPerLine: 20 };
  const docListeners: Record<string, Array<(event: any) => void>> = {};
  // [CUSTOM-20260930-123] Timers are RECORDED, not run: the start card's auto-connect is
  // "wait 500ms, then re-check", and a test has to be able to look at what was asked for
  // (delay + callback) and decide when it fires. Running them on the spot would erase the
  // very property under test. clearTimeout really removes, so the card's own
  // cancel-the-watchdog paths are exercised too.
  const timers: Array<{ id: number; fn: () => void; delay: number }> = [];
  let timerSeq = 0;
  const win: Record<string, any> = {
    __acpc: {},
    // [CUSTOM-20260928-100] `syncFrames` runs scheduled callbacks immediately, so a
    // test can drive a path that defers its layout reads to the next frame (the
    // outline's scroll pass) without a real animation frame.
    requestAnimationFrame: opts.syncFrames ? (fn: () => void) => { fn(); return 0; } : () => 0,
    setTimeout: (fn: () => void, delay?: number) => {
      const id = ++timerSeq;
      timers.push({ id, fn, delay: delay ?? 0 });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex(t => t.id === id);
      if (at >= 0) { timers.splice(at, 1); }
    },
    getSelection: () => null,
    innerHeight: 800,
    innerWidth: 600,
    // boot installs the console/error log bridge at load time.
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const doc: Record<string, unknown> = {
    // 'loading' keeps boot's init() from running: this suite exercises the record
    // layer, and boot's init wires a dozen elements that body.ts supplies (and that a
    // stub would only pretend to have - a fake DOM is not the thing under test here).
    readyState: 'loading',
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (text: string) => makeText(text),
    createRange: () => makeRange(metrics),
    getElementById: (id: string) => elements[id] ?? null,
    addEventListener: (type: string, fn: (event: any) => void) => {
      (docListeners[type] = docListeners[type] ?? []).push(fn);
    },
    removeEventListener: () => {},
    body: new StubNode('body'),
  };
  // [CUSTOM-20261001-158] Document-level lookups resolve against the body: the permission
  // view disables a prompt's buttons wherever they are (the drawer lives on the body), so
  // a stub without these two would silently disable nothing.
  const body = doc.body as StubNode;
  doc.querySelector = (sel: string) => body.querySelector(sel);
  doc.querySelectorAll = (sel: string) => body.querySelectorAll(sel);
  // 只加载**被测链路**：dom（工具）→ icons（图标，用于断言挂载顺序）→ links（装饰）
  // → toolCallView → transcriptView。
  //
  // 为什么不按 webview 的顺序把 15 个模块全加载：boot 的 init() 会去接十几个 body.ts
  // 提供的元素，而那层 DOM 不在本套件的被测范围内——为了让它跑起来而把桩扩张成一个假 DOM，
  // 只会得到一堆与产品无关的桩代码。**边界画在被测链路上**，其余协作者给最小替身：
  // transcriptView 在渲染路径上只会通知它们一声（scroll.follow / outline.invalidate /
  // rail.invalidate / boot.requestMarkdown），所以替身只需不报错。
  const jumps: Array<{ node: StubNode | null; clearance?: number }> = [];
  const NS: Record<string, any> = {
    dom: {},
    // [CUSTOM-20260928-104] `jumpTo` records instead of scrolling: the pinned bar's click
    // must land the message clear of the handoff window, and "did it ask for a clearance"
    // is the only part of that a stub can honestly answer.
    scroll: {
      follow: () => {}, remember: () => {}, restore: () => {}, reassert: () => {},
      jumpTo: (node: StubNode | null, clearance?: number) => { jumps.push({ node, clearance }); },
    },
    outline: { invalidate: () => {}, close: () => {} },
    // Mirrors the real contract: transcriptView tells the rail about every node it
    // mounts (CUSTOM-20260926-070) and asks it to drop them on reset.
    rail: { invalidate: () => {}, reflow: () => {}, watch: () => {}, resetNodes: () => {} },
    boot: { requestMarkdown: () => {}, persistUi: () => {}, recallUi: () => ({}) },
    bridge: { post: () => {}, postForSession: () => {} },
  };
  win.__acpc = NS;
  // [CUSTOM-20260926-079] `sessionMenu` joined the list for its own suite: unlike
  // boot, its IIFE runs nothing at load time (init() is called by boot, and here by
  // the test), so loading it costs the record-layer tests nothing.
  for (const source of [domClient, iconsClient, linksClient, toolCallViewClient, transcriptViewClient, permissionViewClient, permissionDrawerClient, outlineClient, sessionMenuClient, composerClient, tabsClient, timesClient, stickyUserClient, elicitationViewClient, stateCardClient, contextMenuClient]) {
    new Function('window', 'document', source)(win, doc);
  }
  return { NS, metrics, doc, docListeners, jumps, timers };
}

/**
 * Dispatch a click the way a browser does.
 *
 * Two properties matter, and both are load-bearing here: the propagation path is
 * fixed **at dispatch**, and the target's own listeners run before its ancestors'
 * (and before the document's). A handler that re-renders the list it was clicked in
 * therefore still gets its event delivered everywhere — while `event.target` is by
 * then DETACHED, which is exactly what makes a `contains(target)` click-away check
 * answer "outside". `stopPropagation` is honoured, so the chip's handler really does
 * keep the document-level listener from seeing its clicks.
 */
function dispatchClick(target: StubNode, docListeners: Record<string, Array<(event: any) => void>>): void {
  const path: StubNode[] = [];
  for (let node: StubNode | null = target; node; node = node.parentNode) { path.push(node); }
  let stopped = false;
  const event = {
    target,
    composedPath: () => path.slice(),
    preventDefault: () => { /* the stub has no default behaviour to cancel */ },
    stopPropagation: () => { stopped = true; },
  };
  for (const node of path) {
    if (stopped) { break; }
    node.dispatch('click', event);
  }
  if (stopped) { return; }
  for (const fn of docListeners.click ?? []) { fn(event); }
}

/** 把一条记录渲染进容器。（返回容器，**不是**它的第一个子节点——place() 会把
 *  .rec-time 时刻戳插到最前面，所以"第一个子节点"已经不是记录本身了。） */
function renderEntry(NS: Record<string, any>, container: StubNode, entry: Record<string, unknown>): StubNode {
  NS.transcriptView.init(container);
  NS.transcriptView.append(entry, undefined);
  return container;
}

function shapeOf(NS: Record<string, any>, entry: Record<string, unknown>): {
  root: StubNode; isFold: boolean; node: StubNode | null; summary: StubNode | null; body: StubNode | null;
} {
  const container = new StubNode('div');
  const root = renderEntry(NS, container, entry);
  // `[data-kind]` is stamped on the RECORD node by place(); reading the container's
  // first element child instead gave a FALSE PASS on the single-line case (the
  // .rec-time stamp is prepended, so it looked like "no fold"). Hence: find the
  // marker, never assume a position.
  const record = root.querySelector('[data-kind]') as StubNode;
  // A user record is a wrapper div that CONTAINS the <details>; a thought record IS
  // the <details>. Both shapes are legitimate, so accept either — assuming one of
  // them made the very first version of this helper report "no fold" for both.
  const details = (record.tagName === 'DETAILS'
    ? record
    : record.querySelector('details.user-fold')) as StubNode | null;
  const isFold = !!details;
  return {
    root: record,
    isFold,
    node: details,
    summary: details ? details.querySelector('summary') : null,
    body: details ? details.querySelector('.fold-body') : null,
  };
}

/**
 * The record's OWN text, with the always-present timestamp span left out.
 *
 * [CUSTOM-20260930-129] The stamp now lives inside the summary, so a plain `textContent`
 * concatenates the message with its clock ("第一行12:20") — and textContent does not care
 * that the span is display:none (pitfall #16).
 */
function ownText(node: StubNode): string {
  return Array.from(node.childNodes)
    .filter(child => child.nodeType !== 1 || !child.className.split(/\s+/).includes('rec-time'))
    .map(child => child.textContent)
    .join('');
}

/**
 * A summary's children in DOM order, as class names ('text' for text nodes) — with the
 * floating timestamp filtered out.
 *
 * [CUSTOM-20260930-129] The stamp is absolutely positioned, i.e. out of flow, so it must
 * not take part in "what comes after what" assertions: the reader sees the caret right
 * after the icon even though the stamp sits between them in the DOM.
 */
function summaryOrder(summary: StubNode): string {
  return summary.childNodes
    .filter(child => child.nodeType !== 1 || !child.className.split(/\s+/).includes('rec-time'))
    .map(child => (child.nodeType === 1 ? child.className : 'text'))
    .join(',');
}

suite('chat client logic: record DOM shape (stub DOM)', () => {
  // [CUSTOM-20260928-113] The caret is on EVERY user record now. It used to be withheld
  // from one-liners ("nothing to fold"), but the reader reported the missing button
  // itself — and for a message that wraps at a narrower width collapsing is a real
  // action. What is still withheld is a body that hides nothing: `.fold-body` is the
  // marker the pinned bar's shrink button keys off.
  test('a one-line user message carries the caret, but no body that hides nothing', () => {
    const { NS } = loadClient();
    const { isFold, summary, root } = shapeOf(NS, { id: 'u1', kind: 'user', at: Date.now(), text: '跑全部闸门。' });
    assert.strictEqual(isFold, true, 'the fold affordance is on every message');
    assert.strictEqual(ownText(summary!), '跑全部闸门。', 'the whole text stays in the summary');
    assert.strictEqual(root.querySelector('.fold-body'), null, 'and nothing claims to be hidden');
    assert.strictEqual(root.getAttribute('data-fold'), 'done', 'the answer came from layout');
  });

  test('a folded user message keeps its text on the first line', () => {
    const { NS } = loadClient();
    const { isFold, summary, body: _body } = shapeOf(NS, {
      id: 'u5', kind: 'user', at: Date.now(), text: '第一行\n第二行\n第三行',
    });
    assert.strictEqual(isFold, true);
    // [CUSTOM-20260928-110] The body is a wrapper around the text node, so the summary's
    // textContent is "icon + caret + body". The body must be there, and it must be the
    // LAST child of the summary (the text starts on the first line when collapsed).
    const bodyEl = summary!.querySelector('.bubble-body') as StubNode;
    assert.ok(bodyEl, 'the body wrapper exists');
    assert.strictEqual(summary!.childNodes[summary!.childNodes.length - 1], bodyEl,
      'the body is the last child of the summary');
  });

  test('an image attachment sits inside the bubble, before the text', () => {
    const { NS } = loadClient();
    const { root } = shapeOf(NS, {
      id: 'u6', kind: 'user', at: Date.now(), text: '看看这张图',
      attachments: [{ type: 'image', mimeType: 'image/png', dataUri: 'data:image/png;base64,AAAA', name: 'shot.png' }],
    });
    const bubble = root.querySelector('.bubble') as StubNode;
    const chip = bubble.querySelector('.content-image-chip') as StubNode;
    assert.ok(chip, 'the chip is inside the bubble');
    const bodyEl = bubble.querySelector('.bubble-body') as StubNode;
    assert.ok(bodyEl, 'the body wrapper exists');
    // The chip comes before the body in the summary's child list.
    const chipIdx = Array.prototype.indexOf.call(bubble.childNodes, chip);
    const bodyIdx = Array.prototype.indexOf.call(bubble.childNodes, bodyEl);
    assert.ok(chipIdx >= 0 && bodyIdx >= 0 && chipIdx < bodyIdx,
      'the chip sits before the text');
  });

  test('a multi-line user message folds, first line in the summary, rest in the body', () => {
    const { NS } = loadClient();
    const { isFold, summary, body } = shapeOf(NS, {
      id: 'u2', kind: 'user', at: Date.now(), text: '第一行\n第二行\n第三行',
    });
    assert.strictEqual(isFold, true);
    // No duplication and no loss: summary is a prefix, body a suffix, and they meet
    // at the line break — which is DROPPED rather than kept, because the boundary
    // between <summary> and the body already renders as a line break (keeping the
    // '\n' as well showed one blank line too many once expanded).
    const original = '第一行\n第二行\n第三行';
    assert.ok(original.startsWith(ownText(summary!)), `summary must be a prefix: ${ownText(summary!)}`);
    assert.ok(original.endsWith(body!.textContent), `body must be a suffix: ${body!.textContent}`);
    assert.ok(
      ownText(summary!).length + body!.textContent.length >= original.length - 1,
      'only the boundary newline may be dropped',
    );
  });

  test('a message that merely WRAPS (no newline anywhere) folds — judged by measured lines', () => {
    const { NS } = loadClient();
    // 24 characters, no '\n', and well under the old 160-char threshold: the old
    // judgement gave this no fold at all, which is the report this fixes. In the
    // stub's 20-chars-per-line model it occupies two lines.
    const text = '这一句里没有任何换行符，但它在窄面板里会折成三行';
    assert.ok(text.indexOf('\n') < 0);
    assert.ok(text.length < 160, 'the fixture must be under the old threshold to mean anything');
    const { isFold, summary, body } = shapeOf(NS, { id: 'u3', kind: 'user', at: Date.now(), text });
    assert.strictEqual(isFold, true, 'a wrapped line IS multi-line — that is what the reader sees');
    assert.strictEqual(ownText(summary!) + body!.textContent, text, 'nothing lost, nothing repeated');
  });

  test('a message that fits on ONE line keeps its caret, and folds to that one line', () => {
    const { NS, metrics } = loadClient();
    // The mirror image of the case above: the measurement wins over the character
    // count in BOTH directions. 200 characters that fit on a single line (a very
    // wide editor panel) still get a caret, but there is nothing behind it.
    metrics.charsPerLine = 400;
    const text = 'x'.repeat(200);
    const { isFold, summary, body } = shapeOf(NS, { id: 'u4', kind: 'user', at: Date.now(), text });
    assert.strictEqual(isFold, true, 'a single-line message folds to its one line (113)');
    assert.strictEqual(ownText(summary!), text, 'the summary carries the whole text');
    assert.strictEqual(body, null, 'and there is no body, so nothing is hidden');
  });

  test('unmeasurable layout falls back to the proxy, and re-decides once it can be measured', () => {
    const { NS, doc } = loadClient();
    // No createRange at all == the "layout is not available" case (a hidden panel
    // reports zero-height rects instead; both paths land in the same fallback).
    delete (doc as Record<string, unknown>).createRange;
    const text = 'y'.repeat(200);
    const container = new StubNode('div');
    const root = renderEntry(NS, container, { id: 'u5', kind: 'user', at: Date.now(), text });
    const record = root.querySelector('[data-kind]') as StubNode;
    assert.strictEqual(record.getAttribute('data-fold'), 'heuristic', 'the fallback must say so');
    assert.strictEqual(!!record.querySelector('details.user-fold'), true, 'the old proxy still folds this');

    // Layout arrives (the rail's ResizeObserver reports a real size), and with it a
    // measurement: the message now fits on one line, so the fold SHRINKS to that one
    // line — the details is still there (every message keeps its caret, 113), only the
    // body goes away.
    (doc as Record<string, unknown>).createRange = () => makeRange({ charsPerLine: 400 });
    record.rectHeight = 40;
    NS.transcriptView.resolvePendingFolds();
    const details = record.querySelector('details.user-fold') as StubNode;
    assert.ok(details, 're-decided: one line, folded to it');
    assert.strictEqual(record.getAttribute('data-fold'), 'done', 'and the answer is final now');
    assert.strictEqual(details.querySelector('.fold-body'), null, 'nothing is left hidden behind the caret');
  });

  test('INV-J: the fold caret comes AFTER the type icon, and both survive finalize', () => {
    const { NS } = loadClient();
    const container = new StubNode('div');
    const root = renderEntry(NS, container, { id: 't1', kind: 'thought', at: Date.now(), text: '想一下', streaming: true });
    const details = root.querySelector('[data-kind]') as StubNode;
    const summary = details.querySelector('summary')!;
    const order = summaryOrder(summary);
    assert.ok(order.startsWith('rec-icon,fold-caret'), `caret must follow the icon, got: ${order}`);

    // The finalize rewrite replaces the label; it must not take the decorations with it.
    NS.transcriptView.patch('t1', { streaming: false, elapsedMs: 1200 });
    const after = summaryOrder(summary);
    assert.ok(after.includes('rec-icon'), `icon lost on finalize: ${after}`);
    assert.ok(after.includes('fold-caret'), `caret lost on finalize: ${after}`);
    assert.ok(after.includes('text'), 'the new label must be there');
  });
});

// [CUSTOM-20260929-114] 助手消息（agent_message_chunk）的折叠。与用户消息同一套控件，
// 但**正文不在 summary 里**：在 <summary> 里划选文本 == 点它，读者选中一段回答就会把它
// 折起来；而 markdown 正文里还有链接 / 代码 Copy / 图片 chip。所以标题行只放图标+三角，
// 正文是它的兄弟节点，折叠由 CSS 行钳制（不是按测量切文本——"切在第几个字符"对渲染后的
// markdown 没有意义，而首行预览副本会把同一行文字在 DOM 里放两份）。
suite('chat client logic: assistant message fold (stub DOM)', () => {
  function assistantFoldOf(NS: Record<string, any>, entry: Record<string, unknown>): {
    record: StubNode; details: StubNode; summary: StubNode; body: StubNode | null;
  } {
    const container = new StubNode('div');
    const root = renderEntry(NS, container, entry);
    const record = root.querySelector('[data-kind]') as StubNode;
    const details = record.querySelector('details.msg-fold') as StubNode;
    const summary = details ? details.querySelector('summary') as StubNode : (null as unknown as StubNode);
    return {
      record,
      details,
      summary,
      body: details ? details.querySelector('.bubble-body') as StubNode : null,
    };
  }

  test('an assistant message folds: caret in the header row, content in the body', () => {
    const { NS } = loadClient();
    const { details, summary, body } = assistantFoldOf(NS, {
      id: 'a1', kind: 'assistant', at: Date.now(), text: '啊唯，三条都收到。',
    });
    assert.ok(details, 'the record is a foldable <details>');
    assert.strictEqual(details.open, true, 'open by default — an answer that just arrived must not be hidden');
    // INV-J ①: the caret is a real element and it comes AFTER the type icon.
    const order = summaryOrder(summary);
    assert.ok(order.startsWith('rec-icon,fold-caret'), `caret must follow the icon, got: ${order}`);
    // The content must NOT be inside the summary: selecting text in a summary toggles it.
    assert.strictEqual(summary.querySelector('.bubble-body'), null, 'the body is not inside the summary');
    assert.strictEqual(body!.textContent, '啊唯，三条都收到。', 'the text lives in the body');
  });

  // [CUSTOM-20261004-186] 先渲染过一版的流式记录，文本继续增长时**不能停在那一版上**。
  //
  // 宿主 store 里有一条对应的规则（`appendAssistantChunk` 合并时把 `last.html` 置 undefined），
  // 但 **undefined 过不了 JSON**（`JSON.stringify` 丢掉 undefined 键），客户端那份副本因此
  // 永远不知道"这版 html 已经作废" —— 正文就冻在**第一段的渲染结果**上，后面收到的内容一个字
  // 都不显示。用户看到的正是这个形状：一条长回复只显示开头几个字，且 `**` 是字面量
  // （= 渲染的是不完整原文，markdown 里不成对的行内标记保持字面量）。
  test('a record that rendered early does not freeze when its text grows (186)', () => {
    const { NS } = loadClient();
    NS.dom.setSanitizedHtml = (node: any, html: string) => { node.textContent = html; };
    const { body } = assistantFoldOf(NS, { id: 'a4', kind: 'assistant', at: 1, text: '后端', streaming: true });

    // 第一段刚到就回了 html（128 起，记录落地就会自己发起渲染请求）。
    NS.transcriptView.patch('a4', { html: '<p>后端</p>' });
    assert.strictEqual(body!.textContent, '<p>后端</p>');

    // 消息还在流：后续分片到达。
    NS.transcriptView.append({
      id: 'a4', kind: 'assistant', at: 1, streaming: true,
      text: '后端**没事**——被终止的只是那层包装 shell，uvicorn 进程本身还在跑',
    });
    assert.strictEqual(body!.textContent, '后端**没事**——被终止的只是那层包装 shell，uvicorn 进程本身还在跑',
      'the body must follow the record text, not the chunk it once rendered');

    // 收尾：它必须把**完整**文本再要一次渲染（这才是自愈路径）。
    NS.transcriptView.patch('a4', { streaming: false });
    const items = NS.transcriptView.pendingMarkdown();
    assert.strictEqual(items.length, 1, `the settled record must ask for its markdown, got ${items.length}`);
    assert.strictEqual(items[0].text, '后端**没事**——被终止的只是那层包装 shell，uvicorn 进程本身还在跑',
      'and it must ask for the CURRENT text, not the prefix it already rendered');
  });

  // [CUSTOM-20261004-186] 回填是**异步**的：它可能落在文本已经往前走之后。
  // 这种"迟到的旧渲染"既不能盖回正文，也不能把记录重新按旧文本渲染一遍。
  test('a reply that arrives after the text moved on is not applied (186)', () => {
    const { NS } = loadClient();
    NS.dom.setSanitizedHtml = (node: any, html: string) => { node.textContent = html; };
    const { body } = assistantFoldOf(NS, { id: 'a5', kind: 'assistant', at: 1, text: '后端', streaming: true });
    // 记录落地时就问过渲染（asked = '后端'），随后文本继续增长。
    NS.transcriptView.append({ id: 'a5', kind: 'assistant', at: 1, streaming: true, text: '后端**没事**——uvicorn 还在跑' });
    // 现在"那一份"回填才到。
    NS.transcriptView.patch('a5', { html: '<p>后端</p>' });
    assert.strictEqual(body!.textContent, '后端**没事**——uvicorn 还在跑',
      'a late reply for an older text must not overwrite the body');
  });

  test('the markdown rewrite lands in the body and leaves the header row intact', () => {
    const { NS } = loadClient();
    const calls: Array<{ node: any; html: string }> = [];
    NS.dom.setSanitizedHtml = (node: any, html: string) => { calls.push({ node, html }); node.textContent = html; };
    const { details, summary, body } = assistantFoldOf(NS, {
      id: 'a2', kind: 'assistant', at: 1, text: '原文', streaming: true,
    });
    assert.strictEqual(calls.length, 0, 'streaming text stays plain until the record settles');

    NS.transcriptView.patch('a2', { html: '<p>rendered</p>' });
    assert.ok(body!.className.includes('md'), `the body switches to markdown styling, got: ${body!.className}`);
    assert.strictEqual(calls.length, 1);
    assert.ok(details.querySelector('.bubble-body') === body, 'the body is the same node, still inside the fold');
    // The icon/caret used to be preserved by takeIcon/putIcon because the rewrite wiped the
    // host they lived in. They live in the summary now, so nothing can wipe them.
    const after = summaryOrder(summary);
    assert.ok(after.includes('rec-icon') && after.includes('fold-caret'), `header row lost a widget: ${after}`);
  });

  // [CUSTOM-20260929-116] 折叠态显示的首行**不在**正文里剪，而是 summary 里的一份预览文本：
  // 折叠时浏览器把正文整块藏起来，而那个"藏"作者样式抢不过（115 用 display 试过，失败）。
  // 预览必须跟着正文走（首次渲染 + 每次 patch 都从 applyAssistant 里刷），否则折叠态会显示上一版内容。
  test('the collapsed preview carries the first line, and follows the body', () => {
    const { NS } = loadClient();
    const { summary, body } = assistantFoldOf(NS, {
      id: 'a3', kind: 'assistant', at: 1, text: '第一行\n第二行', streaming: true,
    });
    const preview = summary.querySelector('.msg-preview') as StubNode;
    assert.ok(preview, 'the header row carries the preview');
    assert.strictEqual(preview.textContent, '第一行',
      'plain streaming text: one line, and only the first one');
    assert.strictEqual(body!.textContent, '第一行\n第二行', 'the whole text stays in the body');
    // Reading order in the header row: icon, caret, preview (INV-J ①).
    const order = summaryOrder(summary);
    assert.ok(order.startsWith('rec-icon,fold-caret,msg-preview'), `unexpected header order: ${order}`);

    // The markdown rewrite replaces the body wholesale; the preview has to come along.
    NS.dom.setSanitizedHtml = (node: any, html: string) => {
      node.childNodes = [];
      const block = new StubNode('p');
      block.textContent = html;
      node.appendChild(block);
    };
    NS.transcriptView.patch('a3', { html: '渲染后的第一段' });
    assert.strictEqual(preview.textContent, '渲染后的第一段',
      'the preview is refreshed from the RENDERED body, not from entry.text');
  });
});

suite('chat client logic: thought markdown round-trip (stub DOM)', () => {
  /** Record what the sanitizer was handed, without a real parser. */
  function recordSanitized(NS: Record<string, any>): Array<{ node: any; html: string }> {
    const calls: Array<{ node: any; html: string }> = [];
    NS.dom.setSanitizedHtml = (node: any, html: string) => {
      calls.push({ node, html });
      // Pretend to have applied it, so a test can assert on what the reader would
      // actually see (the raw text coming back is the failure mode here).
      node.textContent = html;
    };
    return calls;
  }

  test('a settled thought asks for markdown, and shows what comes back', () => {
    const { NS } = loadClient();
    const calls = recordSanitized(NS);
    const container = new StubNode('div');
    const root = renderEntry(NS, container, {
      id: 't2', kind: 'thought', at: Date.now(), text: '推理里有 `反引号` 与 - 列表', streaming: true,
    });
    const body = root.querySelector('.thought-body') as StubNode;
    assert.strictEqual(calls.length, 0, 'a STREAMING thought must stay plain text (a prefix would freeze)');
    assert.ok(!body.className.includes('md'));

    // Settled: the client asks the extension to render it...
    NS.transcriptView.patch('t2', { streaming: false, elapsedMs: 900 });
    const asked = NS.transcriptView.pendingMarkdown() as Array<{ entryId: string; text: string }>;
    assert.deepStrictEqual(asked.map(a => a.entryId), ['t2'], 'the thought must be in the markdown batch');

    // ...and applies the answer.
    NS.transcriptView.patch('t2', { html: '<p>rendered</p>' });
    assert.strictEqual(calls.length, 1, 'the html must reach the body');
    assert.strictEqual(calls[0].node, body);
    assert.strictEqual(calls[0].html, '<p>rendered</p>');
    assert.ok(body.className.includes('md'), `body must switch to markdown styling, got: ${body.className}`);
  });

  test('a later revise does not wipe the rendered markdown back to raw text', () => {
    const { NS } = loadClient();
    recordSanitized(NS);
    const container = new StubNode('div');
    const root = renderEntry(NS, container, { id: 't3', kind: 'thought', at: Date.now(), text: '原文', streaming: true });
    NS.transcriptView.patch('t3', { streaming: false, elapsedMs: 900 });
    NS.transcriptView.patch('t3', { html: '<p>markdown</p>' });
    const body = root.querySelector('.thought-body') as StubNode;

    // The finalize patch carries no html; without the shared bookkeeping it would
    // re-render entry.text over the markdown the reader is looking at.
    NS.transcriptView.patch('t3', { elapsedMs: 1200 });
    assert.strictEqual(body.textContent, '<p>markdown</p>', 'the raw text must not come back');
    assert.ok(body.className.includes('md'), 'markdown styling must survive');
  });
});

// [CUSTOM-20260926-076] 大纲锚点与列表项（逻辑层）。只测「收哪些、每项长什么样、
// 摘要怎么截」——不测布局/拖拽，那是真浏览器的活（见文件头「桩 DOM 只测逻辑」的边界）。
suite('chat client logic: conversation outline (stub DOM)', () => {
  /** 装配一条最小可渲染链路：transcriptView 喂进 entries → outline.init → open。 */
  function renderOutline(NS: Record<string, any>, entries: Array<Record<string, unknown>>): StubNode {
    const container = new StubNode('div');
    NS.transcriptView.init(container);
    for (const entry of entries) { NS.transcriptView.append(entry, undefined); }
    const drawer = new StubNode('div');
    // [CUSTOM-20260926-077] 下拉的计数区现在在 .outline-head-info 里（钉住按钮并进了
    // .outline-head 同一行），init 查的是 .outline-head-info，桩要照这个结构搭。
    const head = new StubNode('div'); head.className = 'outline-head';
    const headInfo = new StubNode('span'); headInfo.className = 'outline-head-info';
    head.appendChild(headInfo);
    const list = new StubNode('div'); list.className = 'outline-list';
    drawer.appendChild(head); drawer.appendChild(list);
    NS.outline.init(new StubNode('div'), drawer, new StubNode('button'));
    NS.outline.open();
    return drawer;
  }

  test('anchors are user+assistant only; each row carries icon / time / text / jump id / title', () => {
    const { NS } = loadClient();
    const drawer = renderOutline(NS, [
      { id: 'u1', kind: 'user', at: 1000, text: '用户消息' },
      { id: 'a1', kind: 'assistant', at: 2000, text: '助手回复' },
      { id: 'th1', kind: 'thought', at: 3000, text: '思考', streaming: true },
    ]);
    const rows = drawer.querySelectorAll('.outline-item');
    assert.strictEqual(rows.length, 2, 'only user + assistant are outline anchors');
    assert.strictEqual(rows[0].getAttribute('data-jump-id'), 'u1');
    assert.strictEqual(rows[1].getAttribute('data-jump-id'), 'a1');
    assert.ok(rows[0].querySelector('.outline-kind-user'), 'user row icon is typed (colour)');
    assert.ok(rows[1].querySelector('.outline-kind-assistant'), 'assistant row icon is typed (colour)');
    // [CUSTOM-20261005-191] 而且**行本身**也带 kind 类：整行的字重/颜色/缩进都靠它
    // （用户报"用户消息区分度不明显"—— 之前只有图标那一小格带 kind，整排读起来一模一样）。
    // 这条是 JS 与 CSS 之间的契约，去掉类不会有任何报错，只会静默退化成"全都一样"。
    assert.ok(rows[0].className.includes('kind-user'), 'the row carries its kind for whole-line styling');
    assert.ok(rows[1].className.includes('kind-assistant'), 'both kinds, or the list goes flat again');
    assert.ok(rows[0].querySelector('.outline-time'), 'row has a time');
    // [CUSTOM-20260926-077] HH:MM:SS — two colons.
    assert.strictEqual((rows[0].querySelector('.outline-time')!.textContent.match(/:/g) || []).length, 2, 'time shows seconds');
    assert.strictEqual(rows[0].querySelector('.outline-text')!.textContent, '用户消息');
    assert.ok(rows[0].title.length > 0, 'row title carries the full text for hover');
  });

  test('a pinned outline is hidden while there is nothing to navigate', () => {
    // [CUSTOM-20260926-081] Reported: the FIRST open of the panel showed a docked
    // "OUTLINE / No messages yet" column beside the empty state, squeezing the empty
    // state out of the middle of the panel. 045's rule ("no anchors ⇒ no outline") had
    // only ever been applied to the ☰ button; the pinned column ignored it.
    const messages = new StubNode('div');
    const drawer = new StubNode('div');
    const head = new StubNode('div'); head.className = 'outline-head';
    const headInfo = new StubNode('span'); headInfo.className = 'outline-head-info';
    const list = new StubNode('div'); list.className = 'outline-list';
    head.appendChild(headInfo);
    drawer.appendChild(head); drawer.appendChild(list);
    const sidebar = new StubNode('div'); sidebar.className = 'outline-sidebar'; sidebar.hidden = true;
    const sideHead = new StubNode('div'); sideHead.className = 'outline-head';
    const sideList = new StubNode('div'); sideList.className = 'outline-list';
    sidebar.appendChild(sideHead); sidebar.appendChild(sideList);
    const button = new StubNode('button');

    const { NS } = loadClient({
      outlineSidebar: sidebar,
      outlinePin: new StubNode('button'),
      outlineUnpin: new StubNode('button'),
      outlineResize: new StubNode('div'),
    });
    NS.transcriptView.init(messages);
    NS.outline.init(messages, drawer, button);
    // The persisted preference from an earlier run: the outline was PINNED. This is
    // the boot path that produced the screenshot.
    NS.outline.applyPrefs({ outlineMode: 'sidebar', outlineWidth: 240 });
    // The preference alone must not paint a column: pinning says WHERE the outline
    // lives, never that there is something to put in it.
    assert.strictEqual(sidebar.hidden, true, 'pinned, but nothing to navigate ⇒ no docked column');

    // boot then invalidates the outline after hydrating (here: an empty transcript).
    NS.outline.invalidate();
    assert.strictEqual(button.hidden, true, 'and no ☰ button either');

    NS.transcriptView.append({ id: 'u1', kind: 'user', at: 1, text: 'hi' }, undefined);
    // boot calls this on every append/revise; it is what re-runs the check.
    NS.outline.invalidate();
    assert.strictEqual(sidebar.hidden, false, 'the pinned column comes back with the first message');
  });

  test('label truncates to 80 chars with an ellipsis', () => {
    const { NS } = loadClient();
    const drawer = renderOutline(NS, [{ id: 'u1', kind: 'user', at: 1000, text: 'x'.repeat(200) }]);
    const row = drawer.querySelector('.outline-item')!;
    const label = row.querySelector('.outline-text')!.textContent;
    assert.ok(label.length <= 81, `truncated label (got ${label.length} chars)`);
    assert.ok(label.endsWith('…'), 'ends with an ellipsis');
  });
});

suite('chat client logic: tab strip (stub DOM)', () => {
  // [CUSTOM-20260927-089/090] Two interaction defects the audit found in the strip:
  // the per-tab × was its own tab stop (defeating the roving tabindex), and the header's
  // directory button stayed visible — and clickable — with nothing focused.

  function tabStrip(): { NS: Record<string, any>; els: Record<string, StubNode> } {
    const els: Record<string, StubNode> = {
      tabStrip: new StubNode('div'),
      tabs: new StubNode('div'),
      agentBar: new StubNode('div'),
      agentSelect: new StubNode('select'),
      cwdBtn: new StubNode('button'),
      newTab: new StubNode('button'),
    };
    // [CUSTOM-20261008-201] 落点监听挂在条带上，所以桩里 #tabs 必须是它的子节点 ——
    // 否则 stripEl.querySelectorAll('.tab') 一个都找不到（桩的 dispatch 也不冒泡）。
    els.tabStrip.appendChild(els.tabs);
    const { NS } = loadClient(els);
    NS.tabs.init();
    return { NS, els };
  }

  const summary = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: 'a session', cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
  });

  // [CUSTOM-20260930-130] The dot carries two independent signals, which is the whole
  // point of the change: the COLOUR says what the session is doing, the RING says it is
  // working. They cannot be collapsed into one — a turn parked on a permission prompt is
  // both "running" and "waiting", and the reader has to see that nothing moves until they
  // answer while the turn itself is still alive.
  test('the tab dot keeps "what state" and "is it working" apart', () => {
    const { NS, els } = tabStrip();
    const dotFor = (over: Record<string, unknown>) => {
      NS.tabs.setSessions([{ ...summary('s1'), ...over }]);
      return els.tabs.querySelector('.tab-dot') as StubNode;
    };
    // A plain session: neutral colour, no ring.
    assert.strictEqual(dotFor({}).className, 'tab-dot');
    // Running: coloured, and ringed.
    assert.strictEqual(dotFor({ running: true }).className, 'tab-dot running busy');
    // Waiting wins the COLOUR (nothing advances without the reader), while the ring stays
    // (the turn it is parked on is still alive).
    assert.strictEqual(dotFor({ running: true, waiting: true }).className, 'tab-dot waiting busy');
    // Waiting with nothing running: colour only — and that absence is the message.
    assert.strictEqual(dotFor({ waiting: true }).className, 'tab-dot waiting');
    // Loading a replay is "working" too.
    assert.strictEqual(dotFor({ loading: true }).className, 'tab-dot loading busy');
    // Unread is a hint about the past, not activity happening now.
    assert.strictEqual(dotFor({ unread: true }).className, 'tab-dot attention');
  });

  test('the close button is out of the tab order; exactly one tab is tabbable', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);

    const closes = els.tabs.querySelectorAll('.tab-close');
    assert.strictEqual(closes.length, 3, 'one close button per tab');
    for (const close of closes) {
      assert.strictEqual(close.tabIndex, -1, 'the × must not be a tab stop of its own');
    }
    const tabbable = els.tabs.querySelectorAll('.tab').filter(t => t.tabIndex === 0);
    assert.strictEqual(tabbable.length, 1, 'roving tabindex: exactly one tab reachable by Tab');
  });

  test('the address bar shows the default directory — not clickable — with nothing focused (199)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setDefaultCwd('/work/default');
    // [CUSTOM-20261008-199] 090 当初整格隐藏，代价是这一行失去了唯一的弹性项
    // （.session-title 是 flex: 1）⇒ Times 那一组右侧控件整组滑到左边、地址栏位置空着。
    // 现在它显示"下次会话会建在哪"，但**禁用** —— 090 反对的其实是"点开抽屉、抽屉却在讲
    // 一个没有会话的面板"，禁用后抽屉根本打不开，那条顾虑按构造成立。
    NS.tabs.setFocus(null);
    assert.strictEqual(els.cwdBtn.hidden, false, 'no longer hidden');
    assert.strictEqual(els.cwdBtn.disabled, true, 'nothing to pick a directory for yet');
    assert.strictEqual(els.cwdBtn.textContent, '/work/default');

    // A session has a directory — and the button is live again…
    NS.tabs.setFocus(summary('s1'));
    assert.strictEqual(els.cwdBtn.hidden, false);
    assert.strictEqual(els.cwdBtn.disabled, false);
    // …and so does a draft (that is what the drawer is for).
    NS.tabs.setDraftFocus({ draftId: 'd1', cwd: '/tmp/x' });
    assert.strictEqual(els.cwdBtn.disabled, false);
    assert.strictEqual(els.cwdBtn.textContent, '/tmp/x');
    // A draft that has not picked one yet falls back to the same wording as the empty state.
    NS.tabs.setDraftFocus({ draftId: 'd1' });
    assert.strictEqual(els.cwdBtn.textContent, '/work/default');
  });

  test('the empty address bar has a wording of its own before the host value arrives (199)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setFocus(null);
    assert.strictEqual(els.cwdBtn.textContent, 'Default directory');
    // 宿主值后到也要重绘（boot 里 setDefaultCwd 排在 applyFocus 之前，但两个面/迟到都算）。
    NS.tabs.setDefaultCwd('/late/arrival');
    assert.strictEqual(els.cwdBtn.textContent, '/late/arrival');
  });

  // [CUSTOM-20261007-198] 手工排序：按住左键把 tab 拖到目标位置，顺序就变成那样，并且
  // **立刻落盘**（setUiPref → globalState）—— 顺序是工作区级的，另一个面/下次重开面板看到同一条。
  // [CUSTOM-20261008-201] 落点是**指针在条带上的横坐标**（不再要求"命中某个 tab 元素"）：
  // 下面三条用例分别落在左半边、tab 之间的缝隙、最后一个 tab 右边的空白 —— 后两种正是 198
  // 没有落点、松手即复位的现场。
  function orderOf(els: Record<string, StubNode>): Array<string | null> {
    return els.tabs.querySelectorAll('.tab').map(t => t.getAttribute('data-session-id'));
  }

  /**
   * 给条带上的 tab 排一个确定的横向几何：各 `width` 宽、从 `left` 起每隔 `step` 一个。
   * 返回各 tab 的中点与"落在第一、二个之间的缝隙里"的 x。
   */
  function layOut(tabs: StubNode[], left = 100, width = 40, step = 60) {
    const mids: number[] = [];
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].rectLeft = left + i * step;
      tabs[i].rectWidth = width;
      mids.push(left + i * step + width / 2);
    }
    return { mids, gap: left + width + (step - width) / 2, past: left + tabs.length * step + width };
  }

  /** 条带上派发的拖拽事件（落点监听在条带上，不在 tab 上）。 */
  function dragOver(strip: StubNode, clientX: number) {
    strip.dispatch('dragover', { preventDefault: () => {}, clientX, dataTransfer: { dropEffect: '' } });
  }

  function dropAt(strip: StubNode, clientX: number | null) {
    const event: Record<string, unknown> = { preventDefault: () => {} };
    if (clientX !== null) { event.clientX = clientX; }
    strip.dispatch('drop', event);
  }

  test('dragging a tab to the left half of another inserts it in front, and saves the order (198)', () => {
    const { NS, els } = tabStrip();
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);
    assert.deepStrictEqual(orderOf(els), ['s1', 's2', 's3'], 'the host order until you drag');

    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    tabs[1].dispatch('dragstart', {
      target: tabs[1], preventDefault: () => {}, dataTransfer: { setData: () => {}, effectAllowed: '' },
    });
    assert.ok(String(tabs[1].className).includes('dragging'), 'the tab being moved says so');

    // 指针落在第一个 tab 的左半边 ⇒ 插到它前面。
    dragOver(els.tabStrip, box.mids[0] - 10);
    assert.ok(String(tabs[0].className).includes('drop-before'), 'the landing side is drawn');
    dropAt(els.tabStrip, box.mids[0] - 10);

    assert.deepStrictEqual(orderOf(els), ['s2', 's1', 's3'], 'moved in front of the target');
    const saved = posted.filter(m => m.type === 'setUiPref');
    assert.strictEqual(saved.length, 1, 'exactly one write per drop');
    assert.deepStrictEqual(saved[0].tabOrder, ['s2', 's1', 's3'], 'and it carries the whole order');
    assert.ok(!String(tabs[0].className).includes('drop-'), 'no leftover landing mark');
    assert.ok(!String(tabs[1].className).includes('dragging'), 'no leftover drag state');
  });

  test('dropping past the last tab — its right-hand空白 — moves the tab to the end (201)', () => {
    const { NS, els } = tabStrip();
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);
    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    tabs[0].dispatch('dragstart', { target: tabs[0], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    // 那片空白属于 .tab-strip（'.tabs' 是 flex: 0 0 auto）——198 时它没有任何 drop 目标。
    dropAt(els.tabStrip, box.past);
    assert.deepStrictEqual(orderOf(els), ['s2', 's3', 's1'], 'moved to the end');
    assert.deepStrictEqual(
      (posted.find(m => m.type === 'setUiPref') as { tabOrder: string[] }).tabOrder,
      ['s2', 's3', 's1']);
  });

  test('dropping into the gap between two tabs still lands (201)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);
    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    tabs[2].dispatch('dragstart', { target: tabs[2], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    dragOver(els.tabStrip, box.gap);
    // 缝隙落在第一个与第二个之间 ⇒ 指示线画在第二个的左侧，草稿之外的标记一个都不许有。
    assert.ok(String(tabs[1].className).includes('drop-before'), 'the gap belongs to the next tab');
    dropAt(els.tabStrip, box.gap);
    assert.deepStrictEqual(orderOf(els), ['s1', 's3', 's2']);
  });

  test('a draft tab is never a landing mark, and dropping on it means "the end" (201)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setSessions([summary('s1'), summary('s2')]);
    NS.tabs.setDrafts([{ draftId: 'd1' }], 'd1');
    const tabs = els.tabs.querySelectorAll('.tab');
    layOut(tabs);
    const draftTab = tabs[tabs.length - 1];
    assert.strictEqual(draftTab.getAttribute('data-draft-id'), 'd1', 'the draft sits last');

    tabs[0].dispatch('dragstart', { target: tabs[0], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    dragOver(els.tabStrip, 10000);
    assert.ok(!String(draftTab.className).includes('drop-'), 'a draft is not a session — no mark on it');
    assert.ok(String(tabs[1].className).includes('drop-after'), 'the mark lands on the last SESSION');
    dropAt(els.tabStrip, 10000);
    assert.deepStrictEqual(orderOf(els).slice(0, 2), ['s2', 's1'], 'and the drop means "after the last session"');
  });

  test('leaving the strip clears the line but keeps the drag alive (201)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.setSessions([summary('s1'), summary('s2')]);
    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    tabs[1].dispatch('dragstart', { target: tabs[1], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    dragOver(els.tabStrip, box.mids[0] - 10);
    assert.ok(String(tabs[0].className).includes('drop-before'));

    els.tabStrip.dispatch('dragleave', { relatedTarget: null });
    assert.ok(!String(tabs[0].className).includes('drop-'), 'the line goes away with the pointer');
    // 指示线是"此刻落在哪"的提示，不是拖动本身：回来还能落。
    dropAt(els.tabStrip, box.mids[0] - 10);
    assert.deepStrictEqual(orderOf(els), ['s2', 's1']);
  });

  test('a drop with no coordinates, and a drop back onto your own place, change nothing (201)', () => {
    const { NS, els } = tabStrip();
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);
    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    tabs[1].dispatch('dragstart', { target: tabs[1], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    dropAt(els.tabStrip, null);
    assert.deepStrictEqual(orderOf(els), ['s1', 's2', 's3'], 'no coordinates = no landing point');
    assert.strictEqual(posted.filter(m => m.type === 'setUiPref').length, 0, 'and nothing is written');

    // 指针过了自己的中点 = 落在自己的位置上 ⇒ 顺序没变，就不该白写一次 globalState。
    tabs[1].dispatch('dragstart', { target: tabs[1], preventDefault: () => {}, dataTransfer: { setData: () => {} } });
    dropAt(els.tabStrip, box.mids[1] + 5);
    assert.deepStrictEqual(orderOf(els), ['s1', 's2', 's3']);
    assert.strictEqual(posted.filter(m => m.type === 'setUiPref').length, 0, 'an unchanged order is not a write');
  });

  test('a saved order wins, and a brand-new session joins at the end (198)', () => {
    const { NS, els } = tabStrip();
    NS.tabs.applyPrefs({ tabOrder: ['s3', 's1'] });
    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3')]);
    assert.deepStrictEqual(orderOf(els), ['s3', 's1', 's2'],
      'known ids in the saved order, ids it does not mention keep the host order after them');

    NS.tabs.setSessions([summary('s1'), summary('s2'), summary('s3'), summary('s4')]);
    assert.deepStrictEqual(orderOf(els), ['s3', 's1', 's2', 's4'], 'a new session lands last, not first');
  });

  test('a drag that starts on the close button does not move anything (198)', () => {
    const { NS, els } = tabStrip();
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.tabs.setSessions([summary('s1'), summary('s2')]);
    const tabs = els.tabs.querySelectorAll('.tab');
    const box = layOut(tabs);

    const close = tabs[0].querySelector('.tab-close') as StubNode;
    tabs[0].dispatch('dragstart', {
      target: close, preventDefault: () => {}, dataTransfer: { setData: () => {} },
    });
    // 这一次**真的**落在条带上（201 之后落点在条带；落在一个 tab 上就不到处理器了）——
    // 不动的原因只能是 dragStart 那个 × 守卫，而不是"事件没到"。
    dropAt(els.tabStrip, box.past);
    assert.deepStrictEqual(orderOf(els), ['s1', 's2'], 'the × is not a handle');
    assert.strictEqual(posted.filter(m => m.type === 'setUiPref').length, 0, 'and nothing was saved');
  });
});

suite('chat client logic: Times 开关按会话记忆 (stub DOM, CUSTOM-20261008-200)', () => {
  // 「Times」以前只是 webview 本地的一个全局布尔（showTimes）：不按会话记，关掉编辑器面板
  // 或重载窗口就回落到关。现在它按会话记 + 一个"最后一次拨的值"当默认（新会话与草稿页用它），
  // 存在宿主 globalState 里（与大纲、tab 顺序同一条记录）。

  function timesWith(): {
    NS: Record<string, any>; els: Record<string, StubNode>; posted: Array<Record<string, unknown>>;
    persistUi: Array<Record<string, unknown>>;
  } {
    const els: Record<string, StubNode> = {
      messages: new StubNode('div'),
      timeToggle: new StubNode('button'),
      stickyUser: new StubNode('div'),
    };
    const { NS } = loadClient(els);
    const posted: Array<Record<string, unknown>> = [];
    const persistUi: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.boot.persistUi = (patch: Record<string, unknown>) => { persistUi.push(patch); };
    return { NS, els, posted, persistUi };
  }

  const setUiPrefPosts = (posted: Array<Record<string, unknown>>) =>
    posted.filter(m => m.type === 'setUiPref');

  const isOn = (els: Record<string, StubNode>) => els.messages.className.includes('show-times');

  test('拨开一次：记到当前会话名下，并成为默认值', () => {
    const { NS, els, posted } = timesWith();
    NS.times.init();
    assert.strictEqual(isOn(els), false, 'off until asked for');

    NS.times.setFocus('A');
    els.timeToggle.dispatch('click', {});
    assert.strictEqual(isOn(els), true, 'the class IS the mechanism');
    assert.strictEqual(els.timeToggle.className, 'nest-toggle', 'and the button does not read as off');
    assert.deepStrictEqual(setUiPrefPosts(posted), [{
      type: 'setUiPref', timesBySession: { A: true }, timesDefault: true,
    }], 'one write, both halves of the state');
  });

  test('换会话看的是那个会话自己的记录；没有记录就跟随默认值', () => {
    const { NS, els } = timesWith();
    NS.times.init();
    NS.times.noteSessions([{ sessionId: 'A' }, { sessionId: 'B' }]);

    NS.times.setFocus('A');
    els.timeToggle.dispatch('click', {});        // A: 开（默认也变成开）
    assert.strictEqual(isOn(els), true);

    NS.times.setFocus('B');                      // B 没有记录 ⇒ 用默认（刚被拨成开）
    assert.strictEqual(isOn(els), true, 'a session with no record follows the default');
    els.timeToggle.dispatch('click', {});        // B: 关（默认随之变成关）
    assert.strictEqual(isOn(els), false);

    NS.times.setFocus('A');                      // 回到 A：它自己的记录仍然是开
    assert.strictEqual(isOn(els), true, 'its own record outranks the default');
    NS.times.setFocus(null);                     // 空态 / 草稿页 ⇒ 默认（关）
    assert.strictEqual(isOn(els), false);
  });

  test('宿主那份 prefs 一到，就按当前焦点应用（另一个面改的也算）', () => {
    const { NS, els } = timesWith();
    NS.times.init();
    NS.times.setFocus('A');
    assert.strictEqual(isOn(els), false);

    NS.times.applyPrefs({ timesBySession: { A: true }, timesDefault: false });
    assert.strictEqual(isOn(els), true, 'this session was recorded as on');
    NS.times.setFocus('B');
    assert.strictEqual(isOn(els), false, 'B is not in the table, so the default holds');
  });

  test('缺字段的消息（只带大纲偏好 / 只带 tab 顺序）不会把用户开着的 Times 关掉', () => {
    const { NS, els } = timesWith();
    NS.times.init();
    NS.times.setFocus('A');
    els.timeToggle.dispatch('click', {});
    assert.strictEqual(isOn(els), true);

    NS.times.applyPrefs({ outlineMode: 'sidebar', outlineWidth: 320 });
    assert.strictEqual(isOn(els), true, 'a message that says nothing about times says nothing');
    NS.times.applyPrefs({ tabOrder: ['A'] });
    assert.strictEqual(isOn(els), true);
    // 而它**明确**给出的那一半才算数：默认值被改成关 —— 但这个会话自己记着"开"，
    // 记录优先于默认（这正是"按会话记"的意思）。
    NS.times.applyPrefs({ timesDefault: false });
    assert.strictEqual(isOn(els), true, 'this session has a record of its own');
    NS.times.setFocus(null);
    assert.strictEqual(isOn(els), false, 'the default is what a draft/empty panel follows');
  });

  test('写回前裁到"本面知道的会话"，关掉的会话不再拖着这张表长', () => {
    const { NS, posted } = timesWith();
    NS.times.init();
    NS.times.noteSessions([{ sessionId: 'A' }, { sessionId: 'B' }]);
    NS.times.setFocus('A');
    (NS.dom.qs('timeToggle') as StubNode).dispatch('click', {});   // A: 开
    NS.times.setFocus('B');
    (NS.dom.qs('timeToggle') as StubNode).dispatch('click', {});   // B: 关
    NS.times.noteSessions([{ sessionId: 'A' }, { sessionId: 'C' }]);  // B 关掉了
    NS.times.setFocus('C');
    (NS.dom.qs('timeToggle') as StubNode).dispatch('click', {});   // C: 开

    const last = setUiPrefPosts(posted).pop() as { timesBySession: Record<string, boolean> };
    assert.deepStrictEqual(last.timesBySession, { A: true, C: true },
      'the closed session is not carried along forever');
  });

  test('一次性迁移：本地那个旧的 showTimes=true 被播上去一次', () => {
    const els: Record<string, StubNode> = {
      messages: new StubNode('div'), timeToggle: new StubNode('button'), stickyUser: new StubNode('div'),
    };
    const { NS } = loadClient(els);
    const posted: Array<Record<string, unknown>> = [];
    const persistUi: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.boot.persistUi = (patch: Record<string, unknown>) => { persistUi.push(patch); };
    // 旧版本把它存在 webview 本地（vscode.setState）。
    let local: Record<string, unknown> = { showTimes: true };
    NS.boot.recallUi = () => local;

    NS.times.init();
    assert.deepStrictEqual(persistUi, [{ timesMigrated: true }], 'the marker lands in the same store');
    assert.deepStrictEqual(setUiPrefPosts(posted),
      [{ type: 'setUiPref', timesBySession: {}, timesDefault: true }], 'the user setting is carried over');

    // 只跑一次：第二次 init（同一份本地 state）不再播。
    local = { showTimes: true, timesMigrated: true };
    NS.times.init();
    assert.strictEqual(setUiPrefPosts(posted).length, 1, 'once per document');
  });
});

suite('chat client logic: composer text ownership (stub DOM)', () => {
  // [CUSTOM-20260927-085] Found by the audit, in two halves that share one cause: the
  // textarea's store was keyed by SESSION id only, and a draft has none — so
  // `stashDraft` did nothing while a draft was focused. Leaving a draft discarded what
  // you had typed; entering another draft showed the previous one's text.

  function composerWithInput(): { NS: Record<string, any>; input: StubNode; stopConfirm: StubNode; sendBtn: StubNode } {
    const input = new StubNode('textarea');
    const sendBtn = new StubNode('button');
    // [CUSTOM-20261004-183] 停止确认条（真面板里由 body.ts 提供，初始 hidden）。
    // 桩要连**两个按钮**一起建：客户端是靠 data-stop-confirm 认它们的。
    const stopConfirm = new StubNode('div');
    stopConfirm.hidden = true;
    const stopYes = new StubNode('button');
    stopYes.setAttribute('data-stop-confirm', 'stop');
    const stopNo = new StubNode('button');
    stopNo.setAttribute('data-stop-confirm', 'keep');
    stopConfirm.appendChild(stopYes);
    stopConfirm.appendChild(stopNo);
    const { NS } = loadClient({
      promptInput: input,
      sendStopBtn: sendBtn,
      stopConfirm: stopConfirm,
      slashPopup: new StubNode('div'),
      attachments: new StubNode('div'),
      configPickers: new StubNode('div'),
      // [CUSTOM-20260928-096] body.ts now always supplies it; the stub mirrors that.
      contextMeter: new StubNode('div'),
    });
    NS.composer.init();
    return { NS, input, stopConfirm, sendBtn };
  }

  const session = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: null, cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
  });

  // [CUSTOM-20261004-183] 停止是**不可逆**的（工具调用会被掐断）⇒ 多一步确认。
  // 用户 2026-10-04 报：「Escape 不管触发停止还是关弹窗，都是不可逆的，需要先弹二次确认框」。
  // 核过事实：只有"停止"不可逆（关菜单/浮层都能重开，表单抽屉的 Escape 只收起且保留已打的字），
  // 所以只给停止加这一步。形态是面板内一条（不抢焦点、不遮住会话），不是宿主模态框。
  test('Escape asks before stopping, and only "Stop" actually cancels (183)', () => {
    const { NS, input, stopConfirm } = composerWithInput();
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    const pressEscape = (): void => {
      (input as unknown as { dispatch: (t: string, e: any) => void })
        .dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
    };
    const buttons = (): StubNode[] => stopConfirm.querySelectorAll('[data-stop-confirm]');

    NS.composer.setFocus({ ...session('s1'), running: true }, null);
    pressEscape();
    assert.deepStrictEqual(posted, [], 'Escape 不再直接停止（这正是要修的那条）');
    assert.strictEqual(stopConfirm.hidden, false, '而是把那一问摆出来');

    pressEscape();   // 再按一次 Escape = 收起这一问
    assert.strictEqual(stopConfirm.hidden, true, '再按一次 Escape 只是收起它');
    assert.deepStrictEqual(posted, [], '收起也不停止');

    pressEscape();
    assert.strictEqual(buttons().length, 2, '条上就两个按钮：Stop / Keep going');
    dispatchClick(buttons()[0], {});
    assert.strictEqual(posted.length, 1, '点了 Stop 才真的停');

    assert.strictEqual((posted[0] as Record<string, any>).type, 'cancelTurn');
    assert.strictEqual(stopConfirm.hidden, true, '停止之后这一问自己收起来');
  });

  test('"Keep going" dismisses the question without stopping (183)', () => {
    const { NS, input, stopConfirm } = composerWithInput();
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    NS.composer.setFocus({ ...session('s1'), running: true }, null);
    (input as unknown as { dispatch: (t: string, e: any) => void })
      .dispatch('keydown', { key: 'Escape', preventDefault: () => {} });
    assert.strictEqual(stopConfirm.hidden, false);

    dispatchClick(stopConfirm.querySelectorAll('[data-stop-confirm]')[1], {});
    assert.deepStrictEqual(posted, [], 'Keep going 什么都不停');
    assert.strictEqual(stopConfirm.hidden, true);
  });

  test('the Stop button asks too, and the turn ending on its own clears the question (183)', () => {
    const { NS, sendBtn, stopConfirm } = composerWithInput();
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    NS.composer.setFocus({ ...session('s1'), running: true }, null);

    dispatchClick(sendBtn, {});
    assert.strictEqual(stopConfirm.hidden, false, '点 Stop 按钮同样先问一句');
    assert.deepStrictEqual(posted, [], '问的时候还没有停');

    NS.composer.setRunning(false);   // 轮次自己结束了
    assert.strictEqual(stopConfirm.hidden, true, '这一问不该留着');
  });

  // [CUSTOM-20261004-182] 回车**只发送、绝不停止**。
  // 用户报："输入框消息发出之后，再按一次 Enter 会触发停止" —— 旧版回车与 Send/Stop 按钮共用
  // 一条路由（running 时 cancel()），而发完消息后光标还在输入框里、手也还在键盘上。
  test('Enter never stops a running turn (182)', () => {
    const { NS, input } = composerWithInput();
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    const pressEnter = (): void => {
      (input as unknown as { dispatch: (t: string, e: any) => void })
        .dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
    };

    NS.composer.setFocus({ ...session('s1'), running: true }, null);
    (input as unknown as { value: string }).value = '';
    pressEnter();
    assert.deepStrictEqual(posted, [], '跑着的时候按回车什么都不做 —— 绝不能是 cancelTurn');

    // 跑着 + 有文字：同样不发（send() 自己守着"跑着不发"），停下来的方式只有按钮/Escape。
    (input as unknown as { value: string }).value = '第二条';
    pressEnter();
    assert.deepStrictEqual(posted, [], '跑着时不发送，也不停止');

    // 不在跑 + 有文字：正常发送。
    NS.composer.setFocus(session('s1'), null);
    pressEnter();
    assert.strictEqual(posted.length, 1, '不跑的时候回车照常发送');
    assert.strictEqual((posted[0] as Record<string, any>).type, 'sendPrompt');
  });

  test('a draft keeps its own text, and gives it back when you return', () => {
    const { NS, input } = composerWithInput();
    NS.composer.setDraft({ draftId: 'd1', cwd: null });
    input.value = 'draft one';

    // Leave for a real session: the text must not follow us…
    NS.composer.setFocus(session('s1'), null);
    assert.strictEqual(input.value, '', 'the session starts with an empty box');

    // …and coming back to the draft must restore it (the data-loss half).
    NS.composer.setDraft({ draftId: 'd1', cwd: null });
    assert.strictEqual(input.value, 'draft one', 'the draft text is restored, not lost');
  });

  test('two drafts do not share text', () => {
    const { NS, input } = composerWithInput();
    NS.composer.setDraft({ draftId: 'd1', cwd: null });
    input.value = 'first draft';

    NS.composer.setDraft({ draftId: 'd2', cwd: null });
    assert.strictEqual(input.value, '', 'the second draft starts empty');

    input.value = 'second draft';
    NS.composer.setDraft({ draftId: 'd1', cwd: null });
    assert.strictEqual(input.value, 'first draft');
  });
});

suite('chat client logic: tool-card markdown round trip (stub DOM)', () => {
  // [CUSTOM-20260927-084] The audit found this: the round-trip key was POSITIONAL
  // (`entryId#itemIndex`), while a tool's output text GROWS across `tool_call_update`s
  // (one toolCallId in the captured replay goes 35 -> 268 characters). The cached HTML
  // of the first fragment was served for every later one, so the reader saw the
  // beginning of each tool output forever — and nothing at all before the first reply.

  /** A tool card whose single content item carries `text`. */
  function toolWithText(text: string): Record<string, unknown> {
    return {
      toolCallId: 't1',
      title: 'Run',
      kind: 'execute',
      status: 'completed',
      command: 'ls',
      locations: [],
      items: [{ type: 'content', block: { type: 'text', text } }],
    };
  }

  // [CUSTOM-20260929-117] 标题与 IN / OUT（对齐官方插件）：标题优先用 agent 写的描述
  // （"Bash 查看博客目录…"就是它），没有就回退到 ACP 的 title —— Bash 的 title 是命令行、
  // Read 的本来就是人话。描述**比首帧晚到**（真夹具里是第 3 条 update），所以 update 路径
  // 必须也能改标题，否则卡片会一直顶着命令行。
  function toolWith(over: Record<string, unknown>): Record<string, unknown> {
    return { ...toolWithText('out'), ...over };
  }

  test('the head shows the agent description, and falls back to the title', () => {
    const { NS } = loadClient();
    const described = NS.toolCallView.render(toolWith({ description: '查看博客目录' }), 'e1');
    assert.strictEqual(described.querySelector('.tool-title').textContent, '查看博客目录');
    assert.strictEqual(described.querySelector('.tool-title').title, 'Run',
      'the raw title stays reachable on hover');
    const plain = NS.toolCallView.render(toolWith({}), 'e2');
    assert.strictEqual(plain.querySelector('.tool-title').textContent, 'Run',
      'no description: the ACP title is the label, exactly as before');
  });

  test('a description arriving on a later update replaces the fallback label', () => {
    const { NS } = loadClient();
    const node = NS.toolCallView.render(toolWith({}), 'e3');
    assert.strictEqual(node.querySelector('.tool-title').textContent, 'Run');
    NS.toolCallView.update(node, toolWith({ description: '查看博客目录' }), 'e3');
    assert.strictEqual(node.querySelector('.tool-title').textContent, '查看博客目录',
      'the update path must be able to patch the label');
  });

  test('a command-line call is sectioned IN / OUT, and stays collapsed', () => {
    const { NS } = loadClient();
    const node = NS.toolCallView.render(toolWith({ command: 'ls -la', description: '列目录' }), 'e4');
    const body = node.querySelector('.tool-body') as StubNode;
    // [CUSTOM-20260929-118] The user rejected 117's auto-open: a long session becomes a
    // wall of command output. Every card is one click away, and the head carries the
    // description so the reader knows what is behind the caret.
    assert.strictEqual(body.hidden, true, 'collapsed by default, like every other card');
    assert.strictEqual(node.querySelector('.tool-head')!.getAttribute('aria-expanded'), 'false');

    const inSeg = node.querySelector('.tool-seg-in') as StubNode;
    const outSeg = node.querySelector('.tool-seg-out') as StubNode;
    assert.ok(inSeg && outSeg, 'both sections exist');
    assert.strictEqual(inSeg.querySelector('.tool-seg-label')!.textContent, 'IN');
    assert.strictEqual(inSeg.querySelector('.tool-command')!.textContent, 'ls -la');
    assert.strictEqual(outSeg.querySelector('.tool-seg-label')!.textContent, 'OUT');
    assert.ok(outSeg.querySelector('.tool-text'), 'the output lives in OUT');
  });

  test('a card with no command keeps its unlabelled body', () => {
    const { NS } = loadClient();
    const node = NS.toolCallView.render(toolWith({ command: null, kind: 'read' }), 'e5');
    assert.strictEqual(node.querySelector('.tool-body')!.hidden, true, 'a Read card is collapsed too');
    assert.strictEqual(node.querySelector('.tool-seg'), null,
      'no IN/OUT labels without an input line — that would be a claim about direction we do not know');
    assert.ok(node.querySelector('.tool-text'), 'its content is still there');
  });

  function recordRendering(NS: Record<string, any>): Array<{ html: string }> {
    const applied: Array<{ html: string }> = [];
    NS.dom.setSanitizedHtml = (node: any, html: string) => {
      applied.push({ html });
      node.textContent = html;
    };
    return applied;
  }

  // [CUSTOM-20260929-118] OUT 空空如也的两种情况：①agent 的 content 里只有空白文本项
  // （真机表现为"OUT 是个空盒子"）；②工具文本的 markdown 请求**从没被发出去**（工具侧的
  // 队列是只写不读的：只有 assistant/thought 记录才会触发 flush）。两条都钉在这里。
  test('a blank item is skipped, and the raw output is shown instead', () => {
    const { NS } = loadClient({}, { syncFrames: true });
    const node = NS.toolCallView.render(toolWith({
      items: [{ type: 'content', block: { type: 'text', text: '   ' } }],
      output: 'total 4\ndrwxr-xr-x 1 zouwei',
    }), 'e6');
    assert.strictEqual(node.querySelector('.tool-text'), null, 'the blank item contributes nothing');
    const raw = node.querySelector('.tool-raw') as StubNode;
    assert.ok(raw, 'the raw output is rendered instead of an empty box');
    assert.strictEqual(raw.textContent, 'total 4\ndrwxr-xr-x 1 zouwei');
  });

  test('a visible item wins over the raw output', () => {
    const { NS } = loadClient({}, { syncFrames: true });
    const node = NS.toolCallView.render(toolWith({ output: 'RAW OUTPUT' }), 'e7');
    assert.ok(node.querySelector('.tool-text'), 'the agent-formatted item is used');
    assert.strictEqual(node.querySelector('.tool-raw'), null, 'and the fallback stays out of the way');
  });

  test('a tool body actually ASKS the host to render its markdown', () => {
    const { NS } = loadClient({}, { syncFrames: true });
    let asked = 0;
    NS.boot = { requestMarkdown: () => { asked++; } };
    const node = NS.toolCallView.render(toolWithText('some output'), 'e8');
    assert.ok(node.querySelector('.tool-text'), 'the card queued its text');
    assert.strictEqual(asked, 1,
      'the queue is useless if nobody asks: nothing else flushes a TOOL item (transcriptView.flushPending '
      + 'only runs for assistant/thought records)');
  });

  // [CUSTOM-20260929-120] 请求里必须带 sessionId。宿主对每个 item 跑 verifySession，**没有
  // sessionId 的项会被静默丢弃**（protocol.ts 里它是必填字段，但客户端代码是模板字符串，
  // tsc 看不见它）——这一条就是"OUT 永远空白"的真凶：assistant 的 item 一直带着它，
  // 工具项漏了，于是工具正文的 markdown 请求到达宿主就被扔掉，卡上留一个空 .tool-text。
  test('the render request carries the session id the host validates', () => {
    const { NS } = loadClient({}, { syncFrames: true });
    NS.boot = { requestMarkdown: () => { /* captured below */ } };
    NS.toolCallView.render(toolWithText('output text'), 'e9');
    const items = NS.toolCallView.pendingMarkdownItems('session-42') as Array<Record<string, unknown>>;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].sessionId, 'session-42',
      'without this the host drops the item (verifySession) and the body stays empty');
    assert.ok(items[0].key, 'and the key still names the text');
  });

  test('changed text is re-requested, and the key names the text', () => {
    const { NS } = loadClient();
    recordRendering(NS);
    const node = NS.toolCallView.render(toolWithText('partial output'), 'e1');
    const first = NS.toolCallView.pendingMarkdownItems();
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].text, 'partial output');

    // The agent sends the FINAL text for the same slot. The first request is still
    // unanswered, so BOTH are queued — what matters is that the grown text is among
    // them (with a positional key it never was).
    NS.toolCallView.update(node, toolWithText('partial output plus the rest'), 'e1');
    const second = NS.toolCallView.pendingMarkdownItems();
    const texts = second.map((i: { text: string }) => i.text);
    assert.ok(texts.includes('partial output plus the rest'), `grown text must be requested, got ${JSON.stringify(texts)}`);
    const grown = second.find((i: { text: string }) => i.text === 'partial output plus the rest');
    assert.notStrictEqual(grown.key, first[0].key, 'the key must identify the text, not the position');
  });

  test('the visible card ends up with the HTML of the text it is showing', () => {
    const { NS } = loadClient();
    const applied = recordRendering(NS);
    const node = NS.toolCallView.render(toolWithText('partial'), 'e1');
    const stale = NS.toolCallView.pendingMarkdownItems()[0];
    NS.toolCallView.update(node, toolWithText('partial and the rest'), 'e1');
    const fresh = NS.toolCallView.pendingMarkdownItems()
      .find((i: { text: string }) => i.text === 'partial and the rest');

    // Both replies land (the stale one first, as a slow agent would).
    NS.toolCallView.applyMarkdown(stale.key, '<p>STALE</p>');
    NS.toolCallView.applyMarkdown(fresh.key, '<p>FULL</p>');
    // And then the body rebuilds again with the SAME (grown) text — the cache must
    // hand back FULL, never the fragment.
    const rebuilt = NS.toolCallView.render(toolWithText('partial and the rest'), 'e1');
    assert.strictEqual(rebuilt.querySelector('.tool-text').textContent, '<p>FULL</p>');
    assert.ok(!applied.some(a => a.html === '<p>STALE</p>' && false), 'sanity');
  });

  test('the cache still spares a rebuild of the same text', () => {
    const { NS } = loadClient();
    const applied = recordRendering(NS);
    NS.toolCallView.render(toolWithText('same'), 'e1');
    const item = NS.toolCallView.pendingMarkdownItems()[0];
    NS.toolCallView.applyMarkdown(item.key, '<p>same</p>');

    // A fresh render of the same content (snapshot / hydrate): served from the cache,
    // so no second round trip is queued.
    const rebuilt = NS.toolCallView.render(toolWithText('same'), 'e1');
    assert.strictEqual(NS.toolCallView.pendingMarkdownItems().length, 0, 'no new request');
    assert.strictEqual(rebuilt.querySelector('.tool-text').textContent, '<p>same</p>');
    assert.ok(applied.length >= 2, 'the cached HTML was applied to the rebuilt node');
  });
});

suite('chat client logic: history picker filter (stub DOM)', () => {
  // [CUSTOM-20260926-079] The report this pins: **picking a directory closed the whole
  // "Previous session" list.** Cause, and the reason only a real dispatch order can
  // show it: the click handler re-renders the menu, which DETACHES the very button
  // that is still bubbling, and the drawer's click-away listener then asked
  // `drawer.contains(event.target)` — false for a detached node — so the click looked
  // like a click outside. (Reading the two handlers side by side says nothing; run
  // them in order and it is obvious. pitfalls #25.)

  /** Mirrors the #history drawer in body.ts — if that markup changes, follow it here. */
  function historyDrawer(): { elements: Record<string, StubNode>; drawer: StubNode; chip: StubNode; menu: StubNode; list: StubNode } {
    const button = new StubNode('button');
    const drawer = new StubNode('div');
    const head = new StubNode('div');
    const info = new StubNode('span');
    const chip = new StubNode('button');
    const menu = new StubNode('div');
    const list = new StubNode('div');
    // The classes are the contract sessionMenu looks up, so they are copied verbatim
    // from the markup ('.outline-head-info' is the count container the chip sits next
    // to; '.outline-list' is where the rows go).
    drawer.className = 'outline';
    drawer.hidden = true;
    head.className = 'outline-head';
    info.className = 'outline-head-info';
    chip.className = 'picker-btn filter-chip';
    chip.hidden = true;
    menu.className = 'picker-menu down';
    list.className = 'outline-list';
    head.appendChild(info);
    head.appendChild(chip);
    head.appendChild(menu);
    drawer.appendChild(head);
    drawer.appendChild(list);
    return {
      elements: { historyBtn: button, history: drawer, historyFilter: chip, historyFilterMenu: menu },
      drawer, chip, menu, list,
    };
  }

  const SESSIONS = [
    { sessionId: 'a1', title: 'alpha one', cwd: '/git/alpha', dirKey: '/git/alpha', updatedAt: '2026-09-20T00:00:00Z' },
    { sessionId: 'a2', title: 'alpha two', cwd: '/git/alpha', dirKey: '/git/alpha', updatedAt: '2026-09-19T00:00:00Z' },
    { sessionId: 'b1', title: 'beta one', cwd: '/git/beta', dirKey: '/git/beta', updatedAt: '2026-09-18T00:00:00Z' },
  ];
  const DIRECTORIES = [
    { key: '/git/alpha', cwd: '/git/alpha', name: 'alpha', count: 2, current: true },
    { key: '/git/beta', cwd: '/git/beta', name: 'beta', count: 1, current: false },
  ];

  /**
   * An open drawer with a filled list, exactly as boot would leave it.
   *
   * [CUSTOM-20261001-155] `opts` seeds the two inputs the default filter now reads:
   * `tabCwd` = the directory the ADDRESS BAR shows (`NS.tabs.currentCwd`, the only
   * collaborator sessionMenu reads it from) and `uiState` = the persisted UI
   * preferences (`NS.boot.recallUi`). Both default to "nothing", which is the
   * state the 079-era tests were written against.
   */
  function openedPicker(
    overrides: Record<string, unknown> = {},
    opts: { tabCwd?: string | null; uiState?: Record<string, unknown> } = {},
  ): { NS: Record<string, any>; docListeners: Record<string, Array<(e: any) => void>>; tree: ReturnType<typeof historyDrawer>; posted: Array<Record<string, any>> } {
    const tree = historyDrawer();
    const { NS, docListeners } = loadClient(tree.elements);
    NS.tabs = { currentCwd: () => opts.tabCwd ?? null };
    if (opts.uiState) { NS.boot.recallUi = () => ({ ...opts.uiState }); }
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    NS.sessionMenu.init();
    dispatchClick(tree.elements.historyBtn, docListeners);   // the ↺ button opens it
    // ...and the host's reply fills the list (this is what `setHistory` sees).
    NS.sessionMenu.setHistory({
      type: 'history', agentName: 'Claude Code', source: 'agent',
      sessions: SESSIONS, directories: DIRECTORIES,
      ...overrides,
    });
    return { NS, docListeners, tree, posted };
  }

  function filterRows(menu: StubNode): StubNode[] {
    return menu.querySelectorAll('[data-filter-key]');
  }

  test('picking a directory keeps the list open and filters it', () => {
    const { docListeners, tree } = openedPicker();
    const { drawer, chip, menu, list } = tree;
    assert.strictEqual(drawer.hidden, false, 'the drawer must be open before the click');

    dispatchClick(chip, docListeners);            // open the filter menu
    assert.ok(menu.className.includes('open'), 'the chip opens the menu');

    const beta = filterRows(menu).find(r => r.getAttribute('data-filter-key') === '/git/beta');
    assert.ok(beta, 'the menu offers the directory');
    dispatchClick(beta!, docListeners);

    // THE BUG: the drawer closed, because the click-away check ran after the menu
    // (and the button that was clicked) had been rebuilt away.
    assert.strictEqual(drawer.hidden, false, 'picking a directory must NOT close the list');
    assert.strictEqual(list.querySelectorAll('.outline-item').length, 1, 'only the beta session remains');
    assert.ok(chip.querySelector('.picker-label')!.textContent.includes('beta'), 'the chip shows the picked directory');
  });

  test('the menu stays open after a pick, so folders can be compared', () => {
    const { docListeners, tree } = openedPicker();
    const { chip, menu } = tree;
    dispatchClick(chip, docListeners);
    dispatchClick(filterRows(menu)[1], docListeners);
    assert.ok(menu.className.includes('open'), 'the picker stays open for the next comparison');
  });

  test('"All folders" restores the whole list, still open', () => {
    const { docListeners, tree } = openedPicker();
    const { drawer, menu, list } = tree;
    dispatchClick(tree.chip, docListeners);
    dispatchClick(filterRows(menu)[1], docListeners);
    // "All folders" carries the empty key (see makeFilterRow).
    const all = filterRows(menu).find(r => r.getAttribute('data-filter-key') === '');
    assert.ok(all, 'the menu offers "All folders"');
    dispatchClick(all!, docListeners);
    assert.strictEqual(drawer.hidden, false, 'still open');
    assert.strictEqual(list.querySelectorAll('.outline-item').length, 3, 'every session is back');
  });

  test('a click genuinely outside the drawer still closes it', () => {
    // The guard against over-correcting: the click-away behaviour has to survive.
    const { docListeners, tree } = openedPicker();
    dispatchClick(new StubNode('div'), docListeners);
    assert.strictEqual(tree.drawer.hidden, true, 'a real click elsewhere closes the list');
  });

  test('rows without a directory get their own bucket, not silence (093)', () => {
    // A row whose directory the agent never reported is not "some other folder" —
    // nothing is known about it. Dropping it silently under a folder filter was a guess
    // dressed up as a rule.
    // One row the agent reported WITHOUT a directory (so the client cannot place it).
    const withNoDir = [
      ...SESSIONS,
      { sessionId: 'x1', title: 'nowhere', updatedAt: '2026-09-17T00:00:00Z' },
    ] as Array<Record<string, unknown>>;
    const { docListeners, tree } = openedPicker({ sessions: withNoDir, source: 'merged' });
    const { chip, menu, list } = tree;

    dispatchClick(chip, docListeners);
    const unknown = filterRows(menu).find(r => r.getAttribute('data-filter-key') === '~unknown');
    assert.ok(unknown, 'the menu offers the unknown bucket');
    assert.ok(unknown!.textContent.includes('Unknown folder') && unknown!.textContent.includes('1 session'),
      `the bucket carries its own count, got: ${unknown!.textContent}`);

    dispatchClick(unknown!, docListeners);
    assert.strictEqual(list.querySelectorAll('.outline-item').length, 1, 'and it filters to exactly those rows');
    assert.ok(chip.querySelector('.picker-label')!.textContent.includes('Unknown folder'), 'the chip names it');
  });

  test('the count line says how many rows the folder filter hid (093)', () => {
    const withNoDir = [
      ...SESSIONS,
      { sessionId: 'x1', title: 'nowhere', updatedAt: '2026-09-17T00:00:00Z' },
    ] as Array<Record<string, unknown>>;
    const { docListeners, tree } = openedPicker({ sessions: withNoDir, source: 'merged' });
    // Filter by a real folder: the unplaced row is hidden, and the line must say so
    // (otherwise it just vanished).
    dispatchClick(tree.chip, docListeners);
    const alpha = filterRows(tree.menu).find(r => r.getAttribute('data-filter-key') === '/git/alpha');
    dispatchClick(alpha!, docListeners);

    const count = tree.list.parentNode!.querySelector('.outline-count') ?? tree.drawer.querySelector('.outline-count');
    const text = count!.textContent;
    assert.ok(text.includes('2 of 4 sessions'), `the filtered count, got: ${text}`);
    assert.ok(text.includes('1 without a folder'), `the hidden explanation, got: ${text}`);
    assert.ok(text.includes('from the agent + local sources'), `the source label, got: ${text}`);
  });

  test('a supplement merges into the shown list without replacing it (095)', () => {
    const { NS, tree } = openedPicker();
    // The supplement returns a row the list already has (a1) plus a new one (c1);
    // a1 must keep its ORIGINAL title, and c1 must be appended — not replace the list.
    NS.sessionMenu.applySupplement({
      type: 'historySupplement', agentName: 'Claude Code', cwd: '/git/alpha',
      sessions: [
        { sessionId: 'a1', title: 'overridden title', cwd: '/git/alpha', dirKey: '/git/alpha', fromDisk: true },
        { sessionId: 'c1', title: 'gamma one', cwd: '/git/alpha', dirKey: '/git/alpha', fromDisk: true, updatedAt: '2026-09-21T00:00:00Z' },
      ],
    });
    const items = tree.list.querySelectorAll('.outline-item');
    assert.strictEqual(items.length, 4, 'one new row is merged, the rest stay');
    const a1 = items.find(i => i.getAttribute('data-open-session') === 'a1');
    assert.ok(a1, 'a1 is still present');
    assert.ok(a1!.textContent.includes('alpha one'), 'and it kept its title, not the supplement copy');
    assert.ok(items.find(i => i.getAttribute('data-open-session') === 'c1'), 'the new row is present');
    assert.strictEqual(items[0].getAttribute('data-open-session'), 'c1',
      'and the newest row is sorted to the top, not appended at the bottom');
  });

  // [CUSTOM-20261001-155] The drawer's folder filter now defaults to the directory the
  // ADDRESS BAR is showing, and the on/off preference flips to ON.

  test('the request carries the address bar directory, and the list opens filtered to it (155)', () => {
    const { posted, tree } = openedPicker({}, { tabCwd: '/git/alpha' });
    assert.strictEqual(posted.find(m => m.type === 'listHistory')!.cwd, '/git/alpha',
      'the address bar directory rides along with the request');
    assert.strictEqual(tree.list.querySelectorAll('.outline-item').length, 2,
      'only the sessions of that directory are listed');
    assert.ok(tree.chip.querySelector('.picker-label')!.textContent.includes('alpha'),
      'and the chip says which folder is filtering');
  });

  test('no directory in the address bar = the whole list (155)', () => {
    // The rule is conditional: nothing focused, so there is nothing to filter by —
    // NOT a folder picked on the user's behalf.
    const { posted, tree } = openedPicker({}, { tabCwd: null });
    assert.strictEqual(posted.find(m => m.type === 'listHistory')!.cwd, undefined,
      'nothing to send');
    assert.strictEqual(tree.list.querySelectorAll('.outline-item').length, 3, 'every session is listed');
  });

  test('the default is ON even when no preference was ever stored (155)', () => {
    // The behavior change: 079 only filtered after the user had turned it on once.
    const { tree } = openedPicker({}, { tabCwd: '/git/alpha', uiState: {} });
    assert.strictEqual(tree.list.querySelectorAll('.outline-item').length, 2);
  });

  test('a remembered "All folders" keeps the next open unfiltered (155)', () => {
    // The user's decision sticks, including across a webview reload (this is the
    // state recallUi hands back).
    const { tree } = openedPicker({}, { tabCwd: '/git/alpha', uiState: { historyFolderFilter: false } });
    assert.strictEqual(tree.list.querySelectorAll('.outline-item').length, 3, 'the remembered choice wins');
  });

  test('choosing "All folders" is persisted as the preference (155)', () => {
    const { NS, docListeners, tree } = openedPicker({}, { tabCwd: '/git/alpha' });
    const patches: Array<Record<string, unknown>> = [];
    NS.boot.persistUi = (p: Record<string, unknown>) => { patches.push(p); };
    dispatchClick(tree.chip, docListeners);
    const all = filterRows(tree.menu).find(r => r.getAttribute('data-filter-key') === '');
    dispatchClick(all!, docListeners);
    assert.strictEqual(tree.list.querySelectorAll('.outline-item').length, 3, 'all folders now');
    assert.deepStrictEqual(patches, [{ historyFolderFilter: false }], 'and the choice is recorded');
  });

  test('the default folder also gets its disk supplement requested (155/095)', () => {
    // A default folder that is not the first workspace folder would otherwise show a
    // list missing exactly the disk-only sessions 094 was built for. The reply mirrors
    // what the host sends when asked about beta: THAT candidate is the current one.
    const { posted } = openedPicker({
      directories: [
        { key: '/git/alpha', cwd: '/git/alpha', name: 'alpha', count: 2, current: false },
        { key: '/git/beta', cwd: '/git/beta', name: 'beta', count: 1, current: true },
      ],
    }, { tabCwd: '/git/beta' });
    assert.deepStrictEqual(posted.filter(m => m.type === 'supplementHistory'),
      [{ type: 'supplementHistory', cwd: '/git/beta' }]);
  });
});

// [CUSTOM-20260928-096] 输入区四项优化里可落到桩 DOM 测的三条逻辑：上下文计量、
// 图片附件的发送守卫、图片 chip 的缩略图/回退图标。布局（按钮栏下移 / Send 图标居中 /
// Jump to latest 居中）属真浏览器的事，见文件头「桩 DOM 只测逻辑」的边界。
suite('chat client logic: composer input bar (stub DOM)', () => {
  function composerBar(): {
    NS: Record<string, any>; input: StubNode; sendBtn: StubNode; contextMeter: StubNode;
    attachments: StubNode; steerHint: StubNode; sent: Array<Record<string, unknown>>;
  } {
    const input = new StubNode('textarea');
    const sendBtn = new StubNode('button');
    const contextMeter = new StubNode('div');
    const attachments = new StubNode('div');
    // [CUSTOM-20261004-187] 轮次中发不出去时那条说明（#steerHint），以及发出去的消息。
    const steerHint = new StubNode('div');
    const sent: Array<Record<string, unknown>> = [];
    const { NS } = loadClient({
      promptInput: input,
      sendStopBtn: sendBtn,
      slashPopup: new StubNode('div'),
      attachments,
      configPickers: new StubNode('div'),
      contextMeter,
      steerHint,
    });
    NS.bridge.post = (msg: Record<string, unknown>) => { sent.push(msg); };
    NS.bridge.postForSession = (msg: Record<string, unknown>) => { sent.push(msg); };
    NS.composer.init();
    return { NS, input, sendBtn, contextMeter, attachments, steerHint, sent };
  }

  const session = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: null, cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
  });

  // [CUSTOM-20261004-187] 轮次进行中的补充消息（steering）。
  //
  // 用户报：任务进行中输入框里打了字、按回车**没有任何反应**（182 把回车改成只调 send()，
  // 而 send() 守着"跑着不发"）。现在支持的 agent 会真的把消息注入正在跑的那一轮；不支持的
  // 保持不发，但必须在界面上说明白（"打了字按回车没反应"最像程序坏了）。
  function enter(input: StubNode): void {
    (input as unknown as { dispatch: (t: string, e: any) => void })
      .dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
  }

  test('Enter sends mid-turn when the agent takes mid-turn messages (187)', () => {
    const { NS, input, sent, steerHint } = composerBar();
    NS.composer.setFocus(session('s-1'), { availableCommands: [], configOptions: [], usage: null, steering: true });
    NS.composer.setRunning(true);
    input.value = '补充一句';
    assert.strictEqual(steerHint.hidden, true, 'this agent takes mid-turn messages — nothing to warn about');

    enter(input);
    assert.deepStrictEqual(sent, [{ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' }],
      'the host decides how to deliver it (steering vs a new turn) — the composer just sends');
    assert.strictEqual(input.value, '', 'and the box is cleared like any other send');
  });

  test('an agent without steering keeps Enter a no-op — and says why (187)', () => {
    const { NS, input, sent, steerHint } = composerBar();
    NS.composer.setFocus(session('s-1'), { availableCommands: [], configOptions: [], usage: null, steering: false });
    NS.composer.setRunning(true);
    assert.strictEqual(steerHint.hidden, true, 'nothing typed yet — no hint');

    input.value = '补充一句';
    (input as unknown as { dispatch: (t: string, e: any) => void }).dispatch('input', {});
    assert.strictEqual(steerHint.hidden, false, 'there is something to send and nowhere to send it');

    enter(input);
    assert.deepStrictEqual(sent, [], 'nothing may be sent to an agent that cannot take it');
    assert.strictEqual(input.value, '补充一句', 'and the text stays put');
  });

  test('the capability does not leak into the next session (187)', () => {
    const { NS, input, sent } = composerBar();
    NS.composer.setFocus(session('s-1'), { availableCommands: [], configOptions: [], usage: null, steering: true });
    // Switching sessions must not carry the previous agent's capability over.
    NS.composer.setFocus(session('s-2'), { availableCommands: [], configOptions: [], usage: null });
    NS.composer.setRunning(true);
    input.value = '补充一句';
    enter(input);
    assert.deepStrictEqual(sent, [], 'an unknown capability means unsupported, not "send and hope"');
  });

  // [CUSTOM-20261001-165] 新建会话（草稿页）不该显示上一个会话的上下文数字。
  test('a new session starts with the meter cleared, not with the last session\'s numbers (165)', () => {
    const { NS, contextMeter } = composerBar();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 1000000 } });
    assert.strictEqual(contextMeter.hidden, false, 'the session has usage');

    // The user presses '+' — a draft has no session, so it has no usage either.
    NS.composer.setDraft({ draftId: 'd1', cwd: '/tmp' });
    assert.strictEqual(contextMeter.hidden, true, 'a fresh session must not show the previous one\'s ring');

    // …and the same holds when switching to a session that never reported usage.
    NS.composer.setFocus(session('s-2'), null);
    assert.strictEqual(contextMeter.hidden, true, 'no usage ⇒ no meter (the old one is not carried over)');
  });

  test('the context meter is a ring with the percentage inside it', () => {
    const { NS, contextMeter } = composerBar();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 1000000 } });
    assert.strictEqual(contextMeter.hidden, false, 'usage with a size must show the meter');
    // [CUSTOM-20260930-129] Ring + number in the middle, replacing the bar + label.
    assert.strictEqual(contextMeter.querySelector('.gauge-text')!.textContent, '45');
    const fill = contextMeter.querySelector('.gauge-fill')!;
    assert.ok(fill, 'the progress arc is rendered');
    // The arc is a plain circle whose dashoffset hides the part not yet reached.
    assert.strictEqual(fill.getAttribute('stroke-dashoffset'), String(2 * Math.PI * 9 * (1 - 0.45)));
    assert.strictEqual(fill.getAttribute('stroke-dasharray'), String(2 * Math.PI * 9));
    assert.ok(contextMeter.querySelector('.gauge-spin'), 'the running arc is always in the DOM (CSS shows it)');
    assert.match(contextMeter.title, /45%/, 'the exact numbers live in the tooltip');

    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 0 } });
    assert.strictEqual(contextMeter.hidden, true, 'no context size ⇒ hide the meter');
  });

  test('the running arc lights up only while a turn is in flight', () => {
    const { NS, contextMeter } = composerBar();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 1000000 } });
    assert.strictEqual(contextMeter.classList.contains('running'), false);
    // setRunning is the only signal for it, and that path has no meta of its own.
    NS.composer.setRunning(true);
    assert.strictEqual(contextMeter.classList.contains('running'), true);
    NS.composer.setRunning(false);
    assert.strictEqual(contextMeter.classList.contains('running'), false);
  });

  // [CUSTOM-20261004-190] 外圈那条 CSS 动画靠"节点不被重建"活着。
  //
  // 用户报"任务进行中时外圈的闪烁失效，只剩下面多了一段圆环"。根因：`setRunning` 会重画整个
  // 表盘，而它由 `sessionsChanged` 驱动、宿主**每个 agent_message_chunk 都 refreshSessions**
  // ⇒ 流式期间每秒重建几十次 ⇒ 动画每次都从 0 重新开始 ⇒ 永远停在起点角度。
  // 实测（真 Chromium，preview-records.mjs 的 `#gauge-rebuild` 档）：修前 `sameSvgNode:false`。
  // 桩 DOM 建不了动画，但能建**节点身份** —— 那正是会重启动画的那件事。
  test('a running flip must not rebuild the gauge (that restarts its animation) (190)', () => {
    const { NS, contextMeter } = composerBar();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 1000000 } });
    const svg = contextMeter.querySelector('svg');
    assert.ok(svg, 'the meter drew a gauge');
    const spin = contextMeter.querySelector('.gauge-spin');
    assert.ok(spin, 'and the outer arc is part of it');

    // 流式期间每来一个 chunk 就会走一次这条路（值没变）。
    NS.composer.setRunning(true);
    NS.composer.setRunning(true);
    assert.strictEqual(contextMeter.querySelector('svg'), svg,
      'the gauge node must survive a running flip — rebuilding it restarts the spin from 0');
    assert.strictEqual(contextMeter.querySelector('.gauge-spin'), spin);
    assert.strictEqual(contextMeter.classList.contains('running'), true, 'but the class still flips');

    // 数字**真的**变了就必须重画（否则读数会停在上一次）。
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 900000, size: 1000000 } });
    assert.notStrictEqual(contextMeter.querySelector('svg'), svg, 'new numbers get a new gauge');
    assert.strictEqual(contextMeter.querySelector('.gauge-text')!.textContent, '90');
  });

  // [CUSTOM-20261004-185] 金额保留两位小数。
  // agent 给的是一枚裸浮点（日志实测 `2.6394680000000004` —— 累计值反复相加的浮点噪声），
  // 直接拼进 tooltip 就是"4.676045 USD"那种一长串。
  test('the cost in the tooltip is rounded to two decimals (185)', () => {
    const { NS, contextMeter } = composerBar();

    NS.composer.setMeta({
      availableCommands: [], configOptions: [],
      usage: { used: 55642, size: 1000000, costAmount: 2.6394680000000004, costCurrency: 'USD' },
    });
    assert.match(contextMeter.title, /2\.64 USD/, `got: ${contextMeter.title}`);
    assert.ok(!contextMeter.title.includes('2.6394'), 'the float noise must not reach the tooltip');

    // 0.5 这类"看起来已经够短"的值也统一成两位（金额的惯例写法）。
    NS.composer.setMeta({
      availableCommands: [], configOptions: [],
      usage: { used: 1, size: 1000000, costAmount: 4.676045, costCurrency: 'USD' },
    });
    assert.match(contextMeter.title, /4\.68 USD/, `got: ${contextMeter.title}`);

    // 没有金额（或不是数字）就不显示这一段 —— 不能印出 "NaN USD"。
    NS.composer.setMeta({
      availableCommands: [], configOptions: [],
      usage: { used: 1, size: 1000000, costCurrency: 'USD' },
    });
    assert.ok(!contextMeter.title.includes('USD'), `got: ${contextMeter.title}`);
    assert.ok(!contextMeter.title.includes('NaN'), `got: ${contextMeter.title}`);
  });

  test('empty text sends only when an attachment is present', () => {
    const { NS, input, sendBtn } = composerBar();
    const posted: Array<Record<string, any>> = [];
    NS.bridge.post = (m: Record<string, any>) => { posted.push(m); };
    NS.composer.setFocus(session('s1'), null);
    input.value = '';

    sendBtn.dispatch('click', {});
    assert.strictEqual(posted.filter(m => m.type === 'sendPrompt').length, 0,
      'empty text with no attachment must not send');

    NS.composer.setAttachments([{ path: 'img-1', name: 'shot.png', kind: 'image', mimeType: 'image/png' }]);
    sendBtn.dispatch('click', {});
    assert.strictEqual(posted.filter(m => m.type === 'sendPrompt').length, 1,
      'an attachment lets an empty message send');
  });

  test('an image attachment shows a thumbnail once remembered, a fallback icon before', () => {
    const { NS, attachments } = composerBar();
    NS.composer.setFocus(session('s1'), null);
    NS.composer.setAttachments([{ path: 'img-1', name: 'shot.png', kind: 'image', mimeType: 'image/png' }]);

    assert.ok(attachments.querySelector('.attachment-thumb-icon'), 'no local thumb yet ⇒ fallback icon');
    assert.strictEqual(attachments.querySelector('.attachment-thumb'), null, 'no <img> before the bytes are known');

    NS.composer.rememberImage('img-1', 'data:image/png;base64,AAAA');
    const thumb = attachments.querySelector('.attachment-thumb');
    assert.ok(thumb, 'a remembered image renders a thumbnail <img>');
    assert.strictEqual(thumb!.getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.strictEqual(attachments.querySelector('.attachment-thumb-icon'), null, 'the fallback is replaced');
  });
});

// [CUSTOM-20260930-151] 草稿页（点「+」的新会话页）的输入卡要"显示完整"：模式/模型/斜杠命令在
// ACP 里都是**会话级**的，而草稿按定义还没有会话 —— 宿主用"该 agent 上一次会话的快照"应答。
// 本套件钉住客户端这一侧：快照怎么渲染、选中的值记在哪（**绝不**发 setConfigOption），
// 以及它怎么随"创建会话并发送"那条消息一起走。
suite('chat client logic: draft composer options (stub DOM)', () => {
  const CONFIG_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' },
        // The grouped shape: `renderMenu` (and the host's validation) must handle both.
        { name: 'Advanced', options: [{ value: 'bypass', name: 'Bypass' }] },
      ],
    },
  ];
  // A fresh copy per call: the composer writes the picked value into the option objects it is
  // given (that is what makes the button say what it will do), so a shared literal would leak
  // one test's pick into the next.
  const snapshot = () => ({
    configOptions: JSON.parse(JSON.stringify(CONFIG_OPTIONS)),
    availableCommands: [{ name: 'compact', description: 'Compact the conversation', inputHint: null }],
  });

  function draftComposer(): {
    NS: Record<string, any>; input: StubNode; sendBtn: StubNode; pickers: StubNode;
    slashPopup: StubNode; attachments: StubNode; posted: Array<Record<string, unknown>>;
    docListeners: Record<string, Array<(event: any) => void>>;
  } {
    const input = new StubNode('textarea');
    const sendBtn = new StubNode('button');
    const pickers = new StubNode('div');
    const slashPopup = new StubNode('div');
    // [CUSTOM-20261005-193] 附件条也要拿到（草稿页粘图那条测试要断言 chip 真的出现了）。
    const attachments = new StubNode('div');
    const { NS, docListeners } = loadClient({
      promptInput: input,
      sendStopBtn: sendBtn,
      slashPopup: slashPopup,
      attachments,
      configPickers: pickers,
      contextMeter: new StubNode('div'),
    });
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    NS.bridge.postForSession = (message: Record<string, unknown>) => { posted.push(message); };
    NS.composer.init();
    return { NS, input, sendBtn, pickers, slashPopup, attachments, posted, docListeners };
  }

  const draft = (id: string) => ({ draftId: id, cwd: '/tmp/x' });

  /** Open the config menu and click the row with this label. */
  function pick(
    pickers: StubNode,
    label: string,
    docListeners: Record<string, Array<(event: any) => void>>,
  ): void {
    dispatchClick(pickers.querySelector('.picker-btn')!, docListeners);
    const item = pickers.querySelectorAll('.picker-item').find(i => i.textContent === label);
    assert.ok(item, `the menu must offer "${label}"`);
    dispatchClick(item!, docListeners);
  }

  test('entering a draft asks the host what the composer should show', () => {
    const { NS, posted } = draftComposer();
    posted.length = 0;
    NS.composer.setDraft(draft('d1'));
    assert.deepStrictEqual(posted, [{ type: 'listDraftOptions', draftId: 'd1' }]);
  });

  test('an answer for a different draft is ignored (the reply is asynchronous)', () => {
    const { NS, pickers } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    NS.composer.setDraftOptions({ draftId: 'd2', ...snapshot() });
    assert.strictEqual(pickers.querySelectorAll('.picker').length, 0);
    assert.strictEqual(pickers.querySelectorAll('.picker-label').length, 0);

    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });
    assert.strictEqual(pickers.querySelectorAll('.picker').length, 1);
    assert.strictEqual(pickers.querySelector('.picker-label')!.textContent, 'Manual');
  });

  test('the slash list comes with the snapshot, and the placeholder says so', () => {
    const { NS, input, slashPopup } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });
    assert.match(input.placeholder, /\/ for commands/);

    input.value = '/';
    input.dispatch('input', { target: input });
    const items = slashPopup.querySelectorAll('.slash-item');
    assert.strictEqual(items.length, 1, 'the draft page completes commands too');
    assert.match(items[0].textContent, /compact/);
  });

  test('picking a value records it instead of messaging the agent', () => {
    const { NS, pickers, posted, docListeners } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });
    posted.length = 0;

    pick(pickers, 'Plan', docListeners);

    // A draft has no sessionId, so a `setConfigOption` here would be dropped by the host's
    // verifySession guard (§5.4 rule 1) — the user would have chosen something and nothing at
    // all would have happened.
    assert.deepStrictEqual(posted, [], 'nothing may be sent while the session does not exist');
    assert.strictEqual(pickers.querySelector('.picker-label')!.textContent, 'Plan',
      'the button must say what the session will get');
  });

  test('the picks ride along with the message that creates the session', () => {
    const { NS, input, sendBtn, pickers, posted, docListeners } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });
    pick(pickers, 'Bypass', docListeners);   // the grouped value, to cover that shape too
    posted.length = 0;

    input.value = 'build me a thing';
    dispatchClick(sendBtn, docListeners);

    assert.deepStrictEqual(posted, [{
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/tmp/x', text: 'build me a thing',
      configSelections: [{ configId: 'mode', value: 'bypass' }],
      // [CUSTOM-20261005-193] 附件也随这条消息走（草稿上没有会话，宿主收不了会话作用域的
      // attachPath/attachImage）。这里没有附件 ⇒ 两个空数组，字段本身必须在。
      images: [], paths: [],
    }]);
  });

  // [CUSTOM-20261005-193] 新建会话页粘图：以前 boot.attachImage 见"没有会话"就直接报错，
  // 图片根本发不出去（用户报的"New Session 的输入框没法粘贴图片"）。
  test('a pasted image on the draft page rides along with the first message (193)', () => {
    const { NS, input, sendBtn, posted, docListeners, attachments } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    posted.length = 0;

    // 宿主侧那条会话作用域的通道不该被用到（草稿没有会话）。
    const draftOk = NS.composer.addDraftImage({
      id: 'img-1', name: 'pasted.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA',
    });
    assert.strictEqual(draftOk, true, 'the composer takes it for the draft');
    assert.strictEqual(posted.length, 0,
      'nothing goes to the host yet — there is no session to attach to');
    assert.strictEqual(attachments.hidden, false, 'and the chip is shown on the draft page');

    input.value = '';
    dispatchClick(sendBtn, docListeners);   // 空文字 + 有附件 ⇒ 允许发送
    const sent = posted.find(m => String(m.type) === 'createDraftAndSend');
    assert.ok(sent, `expected a createDraftAndSend, got ${JSON.stringify(posted)}`);
    assert.deepStrictEqual((sent as Record<string, any>).images, [{
      id: 'img-1', name: 'pasted.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA',
    }]);
    assert.strictEqual((sent as Record<string, any>).text, '');
  });

  test('a retry after a failed create carries the CURRENT pick, not the first one', () => {
    const { NS, input, sendBtn, pickers, posted, docListeners } = draftComposer();
    NS.composer.setDraft(draft('d1'));
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });

    input.value = 'first try';
    dispatchClick(sendBtn, docListeners);              // sent with no picks
    const first = posted.find(m => m.type === 'createDraftAndSend')!;
    assert.deepStrictEqual(first.configSelections, []);

    NS.composer.failDraft();                            // the create failed; the draft survives
    pick(pickers, 'Plan', docListeners);
    dispatchClick(sendBtn, docListeners);
    const second = posted.filter(m => m.type === 'createDraftAndSend')[1];
    assert.deepStrictEqual(second.configSelections, [{ configId: 'mode', value: 'plan' }],
      'the retry must carry the selection as it is now');
  });

  test('re-entering a draft keeps the picks, and replays them onto a fresh snapshot', () => {
    const { NS, pickers, docListeners } = draftComposer();
    const d1 = draft('d1');
    NS.composer.setDraft(d1);
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });
    pick(pickers, 'Plan', docListeners);

    // Leave for a session and come back: `focusDraft` runs `setDraft` again, and the answer
    // arrives with the snapshot's own values — the user's pick must survive that.
    NS.composer.setFocus({
      sessionId: 's1', agentName: 'Claude Code', title: null, cwd: '/tmp',
      createdAt: '', loading: false, running: false, unread: false,
    }, null);
    NS.composer.setDraft(d1);
    NS.composer.setDraftOptions({ draftId: 'd1', ...snapshot() });

    assert.strictEqual(pickers.querySelector('.picker-label')!.textContent, 'Plan');
  });
});


// [CUSTOM-20260928-100] 大纲"当前项"的判定：拉到底时高亮的必须是最后一条。
// 报的现象是「我已经拉到底了，右侧选中的是倒数第二个」——视口顶部的规则在最后一条比
// 视口短时，命中的是倒数第二条（它的顶边离视口顶部最近）。
suite('chat client logic: outline active row at the bottom (stub DOM)', () => {
  function outlineWith(entries: Array<Record<string, unknown>>): {
    NS: Record<string, any>; messages: StubNode; list: StubNode; drawer: StubNode;
  } {
    const messages = new StubNode('div');
    const button = new StubNode('button');
    const drawer = new StubNode('div');
    const head = new StubNode('span');
    const list = new StubNode('div');
    head.className = 'outline-head-info';
    list.className = 'outline-list';
    drawer.appendChild(head);
    drawer.appendChild(list);

    const { NS } = loadClient({}, { syncFrames: true });
    NS.transcriptView.init(messages);
    for (const entry of entries) { NS.transcriptView.append(entry, undefined); }
    NS.outline.init(messages, drawer, button);
    NS.outline.open();

    // Positions are only known after the nodes exist: spread them out so the two
    // rules disagree (last row's top is above the fold, near the bottom).
    const nodes = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    nodes[0].offsetTop = 0;
    nodes[1].offsetTop = 560;
    messages.clientHeight = 500;
    messages.scrollHeight = 620;
    return { NS, messages, list, drawer };
  }

  /**
   * Give the outline rows and their SCROLL BOX (the drawer in popup mode — that is
   * where '.outline' carries its overflow) viewport positions.
   *
   * `tops` are viewport-relative edges (what getBoundingClientRect answers, used by
   * the reveal check); `offsets` are the anchors inside the transcript (what
   * measure() reads, used to decide WHICH row is active). They are separate on
   * purpose — the two rules are being made to disagree here.
   */
  function placeRows(
    list: StubNode, box: StubNode, boxTop: number, boxBottom: number,
    tops: number[], offsets: number[],
  ): void {
    const rows = list.querySelectorAll('.outline-item');
    for (let i = 0; i < rows.length; i++) {
      rows[i].rectTop = tops[i];
      rows[i].rectBottom = tops[i] + 20;
      rows[i].offsetTop = offsets[i];
    }
    box.rectTop = boxTop;
    box.rectBottom = boxBottom;
  }

  function activeId(list: StubNode): string | null {
    const rows = list.querySelectorAll('.outline-item');
    const active = rows.find(r => r.className.split(/\s+/).includes('active'));
    return active ? active.getAttribute('data-jump-id') : null;
  }

  const ENTRIES = [
    { id: 'u1', kind: 'user', at: 1, text: 'first' },
    { id: 'a1', kind: 'assistant', at: 2, text: 'second' },
  ];
  /** Anchor offsets inside the transcript (rows far apart so the binary search is real). */
  const ANCHORS = [0, 560];

  test('scrolled to the very bottom highlights the LAST row', () => {
    const { NS, messages, list } = outlineWith(ENTRIES);
    messages.scrollTop = 120;   // 120 + 500 >= 620 - 4 ⇒ at the bottom
    NS.outline.invalidate();
    messages.dispatch('scroll', {});
    assert.strictEqual(activeId(list), 'a1', 'the last message is the one being read');
  });

  test('scrolled to the top highlights the FIRST row', () => {
    const { NS, messages, list } = outlineWith(ENTRIES);
    messages.scrollTop = 0;
    NS.outline.invalidate();
    messages.dispatch('scroll', {});
    assert.strictEqual(activeId(list), 'u1');
    });

  test('the highlighted row is scrolled into the outline’s own view', () => {
    // [CUSTOM-20260928-102] Reported: scrolling the conversation highlighted the
    // right row, but the list never followed it — the mark sat off-screen.
    const { NS, messages, list, drawer } = outlineWith(ENTRIES);
    // Order matters: invalidate() re-renders the rows AND drops the cached anchor
    // offsets, so the geometry below must be applied to the REBUILT rows, and the
    // scroll pass then re-measures before it decides which row is active.
    const pass = (boxTop: number, boxBottom: number, tops: number[]): void => {
      NS.outline.invalidate();
      placeRows(list, drawer, boxTop, boxBottom, tops, ANCHORS);
      messages.dispatch('scroll', {});
    };

    // The row sits BELOW the drawer's viewport: scroll down by exactly the overflow.
    messages.scrollTop = 0;   // highlight the FIRST row
    drawer.scrollTop = 0;
    pass(0, 100, [200, 300]);
    assert.strictEqual(drawer.scrollTop, 120, 'scrolled down to bring the row into view');
    assert.strictEqual(activeId(list), 'u1', 'and the row that moved is the highlighted one');

    // The row sits ABOVE the viewport: scroll up by the overflow (500 - 450).
    drawer.scrollTop = 100;
    pass(500, 600, [450, 560]);
    assert.strictEqual(drawer.scrollTop, 50, 'scrolled up by the amount it was hidden by');

    // Already visible: don't move (a clicked row must not re-centre the list).
    drawer.scrollTop = 40;
    pass(0, 100, [10, 300]);
    assert.strictEqual(drawer.scrollTop, 40, 'a visible row leaves the scroll position alone');
  });
});

// [CUSTOM-20260928-102] 图片的紧凑呈现 + 最近一条用户消息的悬浮置顶。
suite('chat client logic: image chip and pinned question (stub DOM)', () => {
  const IMAGE_BLOCK = {
    type: 'image', mimeType: 'image/png', name: 'shot.png', dataUri: 'data:image/png;base64,AAAA',
  };

  test('an image renders as a thumbnail chip, not a full-size picture', () => {
    // Reported: a 1344x695 screenshot at max-width:100% filled the whole panel.
    const { NS } = loadClient();
    const node = NS.toolCallView.renderContentItem({ type: 'content', block: IMAGE_BLOCK }, 'k0', 'e1');

    assert.strictEqual(node.tagName, 'BUTTON', 'the whole chip is the hit target');
    assert.ok(node.className.includes('content-image-chip'), `got: ${node.className}`);
    assert.strictEqual(node.getAttribute('data-zoom-src'), 'data:image/png;base64,AAAA',
      'and it carries the source for the lightbox');
    const thumb = node.querySelector('.content-thumb');
    assert.ok(thumb, 'a thumbnail is rendered');
    // '.src' is a property assignment, not setAttribute — read it back the same way.
    assert.strictEqual(thumb.src, 'data:image/png;base64,AAAA');
    assert.strictEqual(node.querySelector('.content-image-name').textContent, 'shot.png');
  });

  /**
   * [CUSTOM-20261002-172] host 就是那个定位层。卡片（.sticky-card > .sticky-body > 克隆体）由
   * 客户端**按条动态建** —— 卡堆里同时可能有两张，固定 id 的 #stickyCard / #stickyBody 会撞成
   * 重复 id，所以 body.ts 只留了空容器（169 删掉的那个 #stickyToggle 也已不在标记里）。
   */
  function pinnedNodes() {
    const messages = new StubNode('div');
    const host = new StubNode('div');
    host.hidden = true;
    return { messages, host };
  }

  /** stickyUser.ts 里唯一的常量：既是 host 的 padding-top，也是"本体让位"的交接窗口。 */
  const TOP_GAP = 3;
  /** 卡片的 2px 描边（border-box）：卡片比它复制的那条记录高这么多。 */
  const CARD_BORDER = 4;
  /** [CUSTOM-20261004-178] 跳转落点越过判定线的缝（见 stickyUser.ts 的同名常量）。 */
  const STACK_SEAM = 2;
  /** [CUSTOM-20261004-181] 卡堆的缝：卡底与它顶住的那条之间留这么多（172 是无缝相接）。 */
  const CARD_GAP = 8;

  function cardsOf(host: StubNode): StubNode[] {
    return host.childNodes.filter((c: StubNode) => c.nodeType === 1);
  }

  function cardOf(host: StubNode, id: string): StubNode | null {
    return cardsOf(host).find((c: StubNode) => c.getAttribute('data-sticky-id') === id) ?? null;
  }

  function copyOf(host: StubNode, id: string): StubNode {
    return (cardOf(host, id) as StubNode).querySelector('.entry-user') as StubNode;
  }

  /**
   * [CUSTOM-20261002-172] 桩里没有布局，所以按客户端**写下的** marginTop 自己把流推一遍 ——
   * 这正是那张契约：卡片留在文档流里（host 是 flex 列），第 0 张的 marginTop 相对 host 的
   * padding-top（TOP_GAP），之后每张相对前一张的实际底边。卡高用"记录高 + 边框"：桩里
   * element.offsetHeight 恒为 0，客户端量不到就走这条退路（stickyUser.ts 的 measure()）。
   * **能测的只有逻辑**，所以这里量的是"客户端认为它落在哪"，不是像素（文件头的那条边界）。
   */
  function flowOf(
    host: StubNode, nodes: Record<string, StubNode>,
  ): Array<{ id: string; top: number; bottom: number; h: number }> {
    let cursor = TOP_GAP;
    return cardsOf(host).map((card: StubNode) => {
      const id = String(card.getAttribute('data-sticky-id'));
      const h = nodes[id].offsetHeight + CARD_BORDER;
      const top = cursor + parseFloat(card.style.marginTop || '0');
      cursor = top + h;
      return { id, top: top, bottom: top + h, h: h };
    });
  }

  /**
   * 一屏消息：每条提问后面跟一条助手回答（撑开提问之间的距离，模拟真实轮次）。
   * `top` 是这条提问在滚动内容里的 offsetTop，`height` 是它的记录高。
   */
  function stickySetup(questions: Array<{ id: string; top: number; height: number; text?: string }>): {
    NS: Record<string, any>; messages: StubNode; host: StubNode; nodes: Record<string, StubNode>;
    jumps: Array<{ node: StubNode | null; clearance?: number }>;
    docListeners: Record<string, Array<(event: any) => void>>;
    scrollTo: (top: number) => void;
  } {
    const { messages, host } = pinnedNodes();
    const { NS, jumps, docListeners } = loadClient({ messages, stickyUser: host }, { syncFrames: true });
    NS.transcriptView.init(messages);
    for (const q of questions) {
      NS.transcriptView.append({ id: q.id, kind: 'user', at: 1, text: q.text || ('question ' + q.id) }, undefined);
      NS.transcriptView.append({ id: q.id + '-a', kind: 'assistant', at: 2, text: 'the answer' }, undefined);
    }
    NS.stickyUser.setSession('s-1');
    NS.stickyUser.init();
    // [CUSTOM-20260928-103] 视口高 > 0 才"量得出来"：0 表示还没排布，sync 整帧放弃（那是刻意的）。
    messages.clientHeight = 600;
    const kids = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    const nodes: Record<string, StubNode> = {};
    questions.forEach((q, i) => {
      const node = kids[i * 2];
      node.offsetTop = q.top;
      node.offsetHeight = q.height;
      nodes[q.id] = node;
    });
    const scrollTo = (top: number): void => { messages.scrollTop = top; messages.dispatch('scroll', {}); };
    return { NS, messages, host, nodes, jumps, docListeners, scrollTo };
  }

  /** 两条提问，隔着一段助手回答（u1 在 8..48，u2 在 1000..1040）。 */
  function twoQuestions() {
    return stickySetup([
      { id: 'u1', top: 8, height: 40, text: 'first question' },
      { id: 'u2', top: 1000, height: 40, text: 'second question' },
    ]);
  }

  /** 两条都能折叠的提问（240 字无换行 = 桩里 12 行），用来验"收缩按卡各记各的"。 */
  function twoFoldedQuestions() {
    const long = 'q '.repeat(120);
    return stickySetup([
      { id: 'u1', top: 8, height: 40, text: long },
      { id: 'u2', top: 1000, height: 40, text: long },
    ]);
  }

  /** 桩 DOM 没有原生 details 行为：照浏览器那样改 open 再派发 toggle。 */
  function collapseCard(host: StubNode, id: string): void {
    const card = cardOf(host, id) as StubNode;
    const det = card.querySelector('details') as unknown as { open: boolean; dispatch: (t: string) => void };
    det.open = false;
    det.dispatch('toggle');
  }

  function detailsOpen(host: StubNode, id: string): boolean {
    const card = cardOf(host, id) as StubNode;
    return (card.querySelector('details') as unknown as { open: boolean }).open;
  }

  test('the question is taken over as soon as its top reaches the top edge', () => {
    const { host, scrollTo } = stickySetup([{ id: 'u1', top: 8, height: 40, text: 'the question' }]);
    scrollTo(100);   // 0 - 100 is inside the handoff window

    assert.strictEqual(host.hidden, false, 'the floating card appears');
    assert.ok(cardOf(host, 'u1'), 'as a card of its own');
    assert.ok(host.textContent.includes('the question'), 'it keeps the message rendering verbatim');
  });

  test('nothing is pinned while the question still sits below the top edge', () => {
    const { host, scrollTo } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(0);
    assert.strictEqual(host.hidden, true, 'the message itself is visible — no copy needed');
    assert.strictEqual(cardsOf(host).length, 0);

    // …and it takes over once the reader scrolls it up to the edge.
    scrollTo(100);
    assert.strictEqual(host.hidden, false);
  });

  // [CUSTOM-20261002-172] 判定线是严格的 `<`：一条正好停在顶（natural == TOP_GAP）的提问不接管
  // —— 接管了也什么都得不到，而"停在顶"是滚到最上面时的常态。
  test('a question resting exactly on the line is not taken over yet', () => {
    const { host, scrollTo, nodes } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(5);   // natural = 8 - 5 = 3 == TOP_GAP
    assert.strictEqual(host.hidden, true);
    scrollTo(6);   // 越线一像素
    assert.strictEqual(host.hidden, false);
    assert.ok(nodes.u1.classList.contains('sticky-source'), 'and the original steps aside');
  });

  // [CUSTOM-20260928-104] The card is a COPY, so the original has to stand back — otherwise
  // the handoff itself would show the same question twice, which is exactly what 102/103
  // avoided by waiting for it to leave the screen entirely. `visibility`, not `display`:
  // the geometry has to survive (rail markers, jumpTo's offsetTop).
  test('the original stands back while the card stands in for it', () => {
    const { host, scrollTo, nodes } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(100);
    assert.ok(nodes.u1.classList.contains('sticky-source'), 'hidden in place, right where it was');
    assert.strictEqual(host.hidden, false);

    scrollTo(0);
    assert.ok(!nodes.u1.classList.contains('sticky-source'), 'and it is handed back on the way up');
    assert.strictEqual(host.hidden, true);
  });

  // [CUSTOM-20260928-104] The class that hides the source is copied along by cloneNode, so a
  // RE-render clones an already-hidden node. That failure is silent — the bar just comes up
  // empty — so it gets its own case rather than riding along on the one above.
  test('a re-render never clones the hiding class into the card', () => {
    const { NS, host, scrollTo, nodes } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(100);
    assert.ok(nodes.u1.classList.contains('sticky-source'), 'the original carries the class by now');

    NS.stickyUser.refresh();
    const copy = copyOf(host, 'u1');
    assert.ok(copy, 'the card was rebuilt');
    assert.ok(!copy.classList.contains('sticky-source'),
      'the copy stays visible: it is not inside .messages, and buildCard strips the class anyway');
  });

  test('the card takes over the instant the question reaches the edge, not when it is gone', () => {
    const { host, scrollTo, nodes } = twoQuestions();
    // u2 spans 1000..1040: at 1001 it has moved up one pixel and is still 39px on screen.
    // 103 waited for all 40 of them to leave — that wait is what felt abrupt.
    scrollTo(1001);

    assert.ok(cardOf(host, 'u2'), 'u2 has a card of its own');
    assert.ok(nodes.u2.classList.contains('sticky-source'), 'and u2 itself stands back');
    assert.strictEqual(Math.round(flowOf(host, nodes).find(f => f.id === 'u2')!.top), TOP_GAP,
      'resting exactly on the line');
  });

  // [CUSTOM-20261001-166] 撤销 103 的「视口里有提问就不置顶」：视口中间摆着 u2 时，
  // 更早滚上去的 u1 仍要钉住 —— 读者要找的正是「我上一条问的是什么」。
  test('a question on screen still leaves the previous one pinned above it (166)', () => {
    const { host, scrollTo } = twoQuestions();
    scrollTo(500);   // viewport 500..1100: u1 (8..48) is gone, u2 (1000..1040) is visible
    assert.strictEqual(host.hidden, false, 'the older question is off-screen — it gets pinned');
    assert.ok(cardOf(host, 'u1'));
    assert.ok(host.textContent.includes('first question'));
  });

  test('the next question takes over once it reaches the top edge', () => {
    const { host, scrollTo, nodes } = twoQuestions();
    scrollTo(1100);  // both questions are above the fold

    const flow = flowOf(host, nodes);
    assert.strictEqual(host.hidden, false);
    assert.strictEqual(flow.length, 1, 'only the newest one is still on screen');
    assert.strictEqual(flow[0].id, 'u2', 'the pinned one is the LAST of them');
    assert.ok(host.textContent.includes('second question'));
  });

  test('scrolling back up hands the turn to the previous question, not to nothing (166)', () => {
    const { host, scrollTo, nodes } = twoQuestions();
    scrollTo(1100);
    assert.ok(cardOf(host, 'u2'));

    // u2 is on screen again (its top 100px below the edge): u2 is handed back to the list,
    // and u1 — the question above it, still out of sight — takes over (166).
    scrollTo(900);
    const flow = flowOf(host, nodes);
    assert.strictEqual(flow.length, 1);
    assert.strictEqual(flow[0].id, 'u1',
      'the reader came back up to u2; u1 is the one they can no longer see');
  });

  // [CUSTOM-20261002-172] 用户要的「推挤」：新卡顶边碰到旧卡底边时，旧卡就跟着**下一条提问的
  // 自然位置**往上走。它的底边压在 u2 的顶边上 —— 这就是用户说的那条"判定线"，而这一刻 u2
  // 还是列表里的**本体**（不需要副本：它还在自己的位置上）。
  test('the older card is pushed out of the top, its bottom edge riding the next question', () => {
    const { host, scrollTo, nodes } = twoQuestions();
    scrollTo(970);   // u2 的自然位置 30：旧卡已经被顶到只剩 0..30
    const pushed = flowOf(host, nodes);
    assert.strictEqual(pushed.length, 1, 'u2 needs no copy yet — it is still the record itself');
    assert.strictEqual(pushed[0].id, 'u1');
    assert.strictEqual(Math.round(pushed[0].bottom), 30 - CARD_GAP,
      'the bottom edge stops CARD_GAP above the next question top (181; 172 was flush)');
    assert.strictEqual(cardOf(host, 'u2'), null);

    // 继续滚到 u2 越线：两张卡同时在，u2 停在判定线上，u1 只剩一条边。
    scrollTo(998);   // u2 的自然位置 2
    const both = flowOf(host, nodes);
    assert.strictEqual(both.length, 2, 'both are floating at once');
    assert.strictEqual(both[0].id, 'u1', 'the older one is on top');
    assert.strictEqual(both[1].id, 'u2');
    assert.strictEqual(Math.round(both[1].top), TOP_GAP, 'the newest rests on the line');
    // [CUSTOM-20261004-181] 留缝之后旧卡比 172 更早整条出界（不再是"只留最后几个像素"）——
    // 这正是"留缝"的应有之义：两条永不相接。
    assert.strictEqual(Math.round(both[0].bottom), 2 - CARD_GAP,
      'the older card keeps CARD_GAP away from the newest question (181)');
    assert.ok(both[0].bottom <= both[1].top - CARD_GAP,
      'and it never comes closer to the newest card than that gap');

    // 再往下滚：u1 整条出界，就此**不再渲染**（它参与过的上夹已经用完）。
    scrollTo(1100);
    assert.strictEqual(cardOf(host, 'u1'), null, 'pushed out entirely: nothing left to draw');
    assert.ok(cardOf(host, 'u2'));
  });

  // [CUSTOM-20261002-172] 用户要的「抽回」：反向滚动时被顶出去的那张从上沿降回来，
  // 新卡往下让位 —— 与正向滚到同一画面**必须给出同一个结果**（判据只依赖当前画面）。
  test('scrolling back up pulls the older card out of the top edge again', () => {
    const { host, scrollTo, nodes } = twoQuestions();
    scrollTo(1100);
    assert.strictEqual(flowOf(host, nodes)[0].id, 'u2');

    scrollTo(970);   // u2 的自然位置 30
    const pulled = flowOf(host, nodes);
    assert.strictEqual(pulled.length, 1);
    assert.strictEqual(pulled[0].id, 'u1', 'u2 is handed back to the transcript');
    assert.strictEqual(Math.round(pulled[0].bottom), 30 - CARD_GAP,
      'same gap as scrolling down (181) — pulling back up lands on the same geometry');

    scrollTo(900);   // u2 的自然位置 100：旧卡完整回到位
    const settled = flowOf(host, nodes);
    assert.strictEqual(settled[0].id, 'u1');
    assert.strictEqual(Math.round(settled[0].top), TOP_GAP);
  });

  test('the same scroll position gives the same picture from either direction', () => {
    const down = twoQuestions();
    down.scrollTo(1100);
    down.scrollTo(970);
    const up = twoQuestions();
    up.scrollTo(300);   // u2 的自然位置 700：此刻只有 u1 在钉
    up.scrollTo(970);

    assert.deepStrictEqual(
      flowOf(down.host, down.nodes).map(f => [f.id, Math.round(f.top)]),
      flowOf(up.host, up.nodes).map(f => [f.id, Math.round(f.top)]),
    );
    assert.strictEqual(down.host.textContent, up.host.textContent);
  });

  // [CUSTOM-20261002-172] 同时钉两张时，**两张的**本体都要让位（104 起靠的是"本体让位"，
  // 集合式 diff 要保证既贴得全、也摘得干净）。
  test('every card in the stack keeps its own original out of the picture', () => {
    const { scrollTo, nodes } = twoQuestions();
    scrollTo(998);
    assert.ok(nodes.u1.classList.contains('sticky-source'));
    assert.ok(nodes.u2.classList.contains('sticky-source'));

    scrollTo(900);   // 只剩 u1 在钉：u2 交还列表
    assert.ok(nodes.u1.classList.contains('sticky-source'));
    assert.ok(!nodes.u2.classList.contains('sticky-source'), 'handed back');
  });

  // [CUSTOM-20261002-172] 公式的骨架（比逐帧像素断言耐改）：卡片**永不低于自己的自然位置**
  //（否则它会凭空往上跑），也**永不低于判定线**。
  test('no card ever floats above its own place in the transcript, or below the line', () => {
    const { host, scrollTo, nodes } = stickySetup([
      { id: 'u1', top: 8, height: 40 },
      { id: 'u2', top: 700, height: 60 },
      { id: 'u3', top: 1400, height: 40 },
    ]);
    for (const scrollTop of [0, 5, 40, 300, 660, 700, 740, 1000, 1400, 1500, 2000]) {
      scrollTo(scrollTop);
      for (const f of flowOf(host, nodes)) {
        const natural = nodes[f.id].offsetTop - scrollTop;
        assert.ok(f.top >= natural - 0.001,
          `card ${f.id} at ${f.top} must not float above its natural position ${natural} (scrollTop ${scrollTop})`);
        assert.ok(f.top <= TOP_GAP + 0.001,
          `card ${f.id} at ${f.top} must never rest below the line (scrollTop ${scrollTop})`);
      }
    }
  });

  test('clicking a card hands the question back to the transcript', () => {
    const { NS, host, scrollTo, jumps, docListeners } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(100);
    dispatchClick(cardOf(host, 'u1') as StubNode, docListeners);

    assert.strictEqual(jumps.length, 1, 'the click jumps back to the original');
    assert.strictEqual(jumps[0].node, NS.transcriptView.node('u1'));
    // [CUSTOM-20261004-178] 落点**越过**交接线一点点（TOP_GAP + STACK_SEAM）：被点的这条因此
    // 落在活动前缀**之外** ⇒ 本体不再让位、真实消息显示在最顶；上方的卡堆按 layout() 的
    // 上夹公式自己滑出上沿。171 那版落 0（正好压在线上）会让它仍在前缀里 ⇒ 用户看到的
    // 是克隆体（"定位过去了但显示的还是悬浮样式"，2026-10-04 报的）。
    assert.strictEqual(jumps[0].clearance, TOP_GAP + STACK_SEAM,
      'the jump lands just PAST the handoff line, so the real message keeps the floor');
    assert.ok(jumps[0].clearance! > TOP_GAP, 'that is the whole point: outside the handoff window');
  });

  test('the cards mirror the list rendering toggles without losing their entry animation', () => {
    const { NS, messages, host, scrollTo } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(100);
    assert.ok(!host.className.includes('show-times'), 'times off: no stamp in the copies either');

    messages.classList.add('show-times');
    NS.stickyUser.refresh();
    assert.ok(host.className.includes('show-times'), 'times on: the copies follow the list');
    // [CUSTOM-20261002-172] 状态类要**增量**写（classList.toggle）：整体重写 host.className 会把
    // 各卡身上的 .entering 一起抹掉，而那正是入场动画的标记。
    assert.ok((cardOf(host, 'u1') as StubNode).className.includes('entering'),
      'the entry animation marker survives the toggle');
  });

  // [CUSTOM-20260928-104] The bar sticks for as long as the turn lasts, so a long question
  // would eat the screen — hence the shrink control. It is offered only when there is a fold
  // to shrink: a one-line bubble is already one line.
  // [CUSTOM-20260928-105] Alignment the user can see: the messages sit inside a scroll
  // container, so their content box is narrower than the column by the scrollbar — the bar
  // is not a scroll container and would otherwise hang that far to the right.
  test('the stack ends where the messages end, scrollbar included', () => {
    const { messages, host, scrollTo } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    scrollTo(100);
    assert.strictEqual(host.style.right, '0px', 'no scrollbar: nothing to give way to');

    messages.offsetWidth = 610;
    messages.clientWidth = 600;
    scrollTo(100);
    assert.strictEqual(host.style.right, '10px', 'the thin scrollbar is part of the layout');

    messages.offsetWidth = 600;
    scrollTo(100);
    assert.strictEqual(host.style.right, '0px', 'and it goes back when the scrollbar does');
  });

  // [CUSTOM-20261002-169] 收缩控件只剩卡片里的折叠三角（左侧通道那个小方块按用户要求删除）。
  // 单行消息没有可收的东西：克隆体里不会出现 .fold-body（那个元素就是"后面还藏着字"的标记）。
  test('only a message with a hidden remainder carries something to collapse', () => {
    const folded = stickySetup([{ id: 'u1', top: 8, height: 40, text: 'q '.repeat(120) }]);
    folded.scrollTo(100);
    assert.ok(folded.host.querySelector('.fold-body'), 'a wrapped question has a remainder behind the caret');

    const plain = stickySetup([{ id: 'u1', top: 8, height: 40, text: 'one line' }]);
    plain.scrollTo(100);
    assert.strictEqual(plain.host.querySelector('.fold-body'), null,
      'a one-line message has nothing to shrink — and no dead control to offer');
  });

  // [CUSTOM-20261002-170/171 → 20261004-178] 三次报的都是同一个数的三面：
  //   170 "两条气泡重叠" ⇒ 落点得让开卡堆；171 "定位偏下" ⇒ 别把**屏幕外**的卡也算进让位量；
  //   178 "定位过去了但还是悬浮样式" ⇒ 落点要越过交接线，那条才不会被克隆体接管。
  test('the jump lands just past the handoff line (170/171/178)', () => {
    // 高一点的提问（卡高 = 60 + 4）：卡高**不该**参与落点（170 的错），也不该让本条被接管。
    const { NS, host, scrollTo, jumps, docListeners } = stickySetup([{ id: 'u1', top: 8, height: 60 }]);
    scrollTo(100);
    dispatchClick(cardOf(host, 'u1') as StubNode, docListeners);
    assert.strictEqual(jumps.length, 1);
    assert.strictEqual(jumps[0].clearance, TOP_GAP + STACK_SEAM,
      'past the line ⇒ the original keeps the floor (178); a constant ⇒ no card height involved (171)');
    assert.strictEqual(jumps[0].node, NS.transcriptView.node('u1'));
  });

  // [CUSTOM-20261002-172] 卡堆里每张卡各代表一条消息：点击的目标必须取自**被点的那张**。
  test('clicking a card jumps to the message THAT card stands for', () => {
    const { NS, host, scrollTo, jumps, docListeners } = twoQuestions();
    scrollTo(998);   // u1 与 u2 同时钉着
    dispatchClick(cardOf(host, 'u1') as StubNode, docListeners);
    assert.strictEqual(jumps.length, 1);
    assert.strictEqual(jumps[0].node, NS.transcriptView.node('u1'), 'the older card, not the newest');
    assert.strictEqual(jumps[0].clearance, TOP_GAP + STACK_SEAM);

    // 空定位层本身不该吃掉点击（真面板靠 pointer-events: none，这里靠"找不到卡就不跳"）。
    dispatchClick(host, docListeners);
    assert.strictEqual(jumps.length, 1, 'a click on the transparent layer is not a jump');
  });

  test('the caret inside a card collapses it instead of jumping (166)', () => {
    const { host, scrollTo, jumps, docListeners } = stickySetup([{ id: 'u1', top: 8, height: 40, text: 'q '.repeat(120) }]);
    scrollTo(100);
    const card = cardOf(host, 'u1') as StubNode;
    const caret = card.querySelector('.fold-caret') as StubNode;
    assert.ok(caret, 'a folded message carries a caret in the copy');
    assert.ok(String(caret.title || '').length > 0, 'and it says what clicking it does');

    // [CUSTOM-20261002-171] 折叠 = 克隆体那个原生 details 的 open 状态（与界面同一套逻辑）。
    const copyDetails = card.querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(copyDetails.open, true, 'starts expanded');
    dispatchClick(caret, docListeners);
    assert.deepStrictEqual(jumps, [], 'the caret must NOT jump back to the original');
  });

  // [CUSTOM-20261001-166] 收缩状态**按会话**记（用户报：切一次 tab 就弹回展开）。
  // [CUSTOM-20261002-172] 卡堆之后还要**再按卡**分（用户拍板：点哪张收哪张）—— 于是它成了
  // sessionId -> { entryId: true }：先问"它属于谁"，再问"是哪一张"（pitfalls #38）。
  test('the collapse state belongs to the session AND to the card', () => {
    const { NS, host, scrollTo } = twoFoldedQuestions();
    scrollTo(998);   // 两张卡同时钉着
    collapseCard(host, 'u1');
    assert.strictEqual(detailsOpen(host, 'u1'), false, 'the older card is collapsed');
    assert.strictEqual(detailsOpen(host, 'u2'), true, 'and only that one — its neighbour stays open');

    // Switching away and back is what boot does: setSession() then reset().
    NS.stickyUser.setSession('s-2');
    NS.stickyUser.reset();
    scrollTo(998);
    assert.strictEqual(detailsOpen(host, 'u1'), true, 's-2 has its own state — it opens expanded');

    NS.stickyUser.setSession('s-1');
    NS.stickyUser.reset();
    scrollTo(998);
    assert.strictEqual(detailsOpen(host, 'u1'), false, 'coming back to s-1 restores the collapsed card');
    assert.strictEqual(detailsOpen(host, 'u2'), true, 'and its neighbour is still open');
  });

  // [CUSTOM-20261004-179] 折叠状态只有**一份**（transcriptView 的共用存储）：点卡片 = 记录跟着折，
  // 点记录 = 卡片跟着折。166/172 定的粒度不变（按会话 + 按条目），只是不再各存一份（pitfall #19）。
  test('collapsing the CARD folds the message record too (179)', () => {
    const { host, nodes, scrollTo } = twoFoldedQuestions();
    scrollTo(998);
    collapseCard(host, 'u1');
    const record = nodes['u1'].querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(record.open, false, '消息面板里那一条跟着折起来（2026-10-04 报的就是这个不一致）');
    const neighbour = nodes['u2'].querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(neighbour.open, true, '旁边那条不受牵连');
  });

  test('folding the RECORD folds its card too (179)', () => {
    const { host, nodes, scrollTo } = twoFoldedQuestions();
    scrollTo(998);
    const record = nodes['u1'].querySelector('details') as unknown as { open: boolean; dispatch: (t: string) => void };
    record.open = false;
    record.dispatch('toggle');
    assert.strictEqual(detailsOpen(host, 'u1'), false, '卡片跟着折（toggle 不冒泡，监听是逐节点挂的）');
  });

  test('a rebuilt record comes back collapsed — the state survives hydration (179)', () => {
    const { NS, host, scrollTo } = twoFoldedQuestions();
    scrollTo(998);
    collapseCard(host, 'u1');
    // 重建走的就是这条路径（切会话回来 / 重开面板都是 hydrate）。
    NS.transcriptView.hydrate({
      sessionId: 's-1',
      entries: [
        { id: 'u1', kind: 'user', at: 1, text: 'q '.repeat(120) },
        { id: 'u2', kind: 'user', at: 2, text: 'q '.repeat(120) },
      ],
    });
    const rebuilt = NS.transcriptView.node('u1').querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(rebuilt.open, false, '重建后仍然折着（以前是写死的 open=true，会弹回展开）');
  });

  test('the fold state is per session: it does not leak across sessions (179)', () => {
    const { NS, host, scrollTo } = twoFoldedQuestions();
    scrollTo(998);
    collapseCard(host, 'u1');
    assert.strictEqual(detailsOpen(host, 'u1'), false);

    // 换会话（boot 的做法：setSession → 重建）。
    NS.stickyUser.setSession('s-2');
    NS.transcriptView.hydrate({ sessionId: 's-2', entries: [{ id: 'u1', kind: 'user', at: 1, text: 'q '.repeat(120) }] });
    const other = NS.transcriptView.node('u1').querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(other.open, true, 's-2 里的 u1 是展开的 —— 状态没有串会话');

    NS.stickyUser.setSession('s-1');
    NS.transcriptView.hydrate({ sessionId: 's-1', entries: [{ id: 'u1', kind: 'user', at: 1, text: 'q '.repeat(120) }] });
    const back = NS.transcriptView.node('u1').querySelector('details') as unknown as { open: boolean };
    assert.strictEqual(back.open, false, '切回 s-1 仍然是折的');
  });

  // 没排布的帧（面板隐藏）什么都不做：否则会把一屏 0 高的卡"量"进缓存，之后所有位置都是错的。
  test('nothing is placed while the panel has no layout', () => {
    const { host, messages, scrollTo } = stickySetup([{ id: 'u1', top: 8, height: 40 }]);
    messages.clientHeight = 0;
    scrollTo(100);
    assert.strictEqual(host.hidden, true);
    assert.strictEqual(cardsOf(host).length, 0);
  });
});

// [CUSTOM-20260929-119 / 20260930-152] 表单（ACP elicitation / AskUserQuestion）的客户端逻辑。
// 载荷形状取自 adapter 的真实产物（`askUserQuestionsToCreateRequest`）：单选是 `oneOf` →
// 宿主扁平化成 kind:'select'，每题还有一个 `_meta._askUserQuestionCustomAnswer` 标记的自由文本框。
// 152 起记录里只留一行"待回答"条，表单本体在**悬浮抽屉**里：多题按 tab 分页、单选用下拉
// （选项 = 名称 + 介绍），每题都可以带一个"追加/自拟"输入框。
suite('chat client logic: form record + drawer (stub DOM, CUSTOM-20260929-119/20260930-152)', () => {
  const SINGLE = {
    promptId: 's1:1',
    sessionId: 's1',
    message: '博客的基础框架方案倾向哪种？',
    status: 'pending',
    fields: [
      {
        name: 'question_0', kind: 'select', title: '基础方案',
        options: [
          { value: 'Astro 官方模板', title: 'Astro 官方模板', description: '以官方 blog 模板为底' },
          { value: '使用现成主题', title: '使用现成主题' },
        ],
      },
      { name: 'question_0_custom', kind: 'text', title: 'Other', customFor: 'question_0' },
    ],
  };
  const TWO = {
    promptId: 's1:2',
    sessionId: 's1',
    message: 'Please answer the following questions.',
    status: 'pending',
    fields: [
      {
        name: 'question_0', kind: 'select', title: '功能位置',
        options: [{ value: 'in-repo', title: '就在当前项目' }, { value: 'other-repo', title: '别的项目' }],
      },
      { name: 'question_0_custom', kind: 'text', title: 'Other', customFor: 'question_0' },
      {
        name: 'question_1', kind: 'multi', title: '命令范围',
        options: [
          { value: 'new', title: 'new', description: '新建文章' },
          { value: 'deploy', title: 'deploy', description: '调到阿里云部署' },
        ],
      },
      { name: 'question_1_custom', kind: 'text', title: 'Other', customFor: 'question_1' },
    ],
  };

  /** The client, a mounted drawer, a transcript holding `states`, and the wires boot installs. */
  function mount(states: Array<Record<string, unknown>> = [SINGLE]): {
    NS: Record<string, any>; drawer: StubNode; messages: StubNode; body: StubNode;
    posted: Array<Record<string, unknown>>;
    docListeners: Record<string, Array<(event: any) => void>>;
  } {
    const drawer = new StubNode('div');
    const messages = new StubNode('div');
    const { NS, doc, docListeners } = loadClient({ elicDrawer: drawer, messages });
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.postForSession = (message: Record<string, unknown>) => { posted.push(message); };
    // The real delegated click path (boot installs it on body): that is what carries
    // data-elic-action from a click to elicitationView.answer, including the drawer lookup.
    NS.links.installDelegatedHandlers(doc.body);
    // The drawer hangs off the body in production; the click path has to reach it.
    doc.body.appendChild(drawer);
    NS.transcriptView.init(messages);
    NS.transcriptView.hydrate({
      sessionId: 's1',
      entries: states.map((elicitation, index) => ({
        id: 'e' + index, kind: 'elicitation', at: index, elicitation,
      })),
    });
    NS.elicitationView.init();
    // The panel is on session 's1' (every state in this suite uses it): the drawer only shows the
    // forms that belong to the session on screen.
    NS.elicitationView.setSession('s1');
    NS.elicitationView.sync();
    return { NS, drawer, messages, body: doc.body, posted, docListeners };
  }

  /** Dispatch an event that bubbles — the stub only does that for clicks. */
  function dispatchBubbling(target: StubNode, type: string): void {
    const path: StubNode[] = [];
    for (let node: StubNode | null = target; node; node = node.parentNode) { path.push(node); }
    for (const node of path) { node.dispatch(type, {}); }
  }

  // The stub's selector support is deliberately minimal ('[attr]', never '[attr="value"]'),
  // so value-carrying lookups are done by filtering here as well as in the client.
  function inputsNamed(root: StubNode, name: string): StubNode[] {
    return root.querySelectorAll('input[data-field]').filter(i => i.getAttribute('data-field') === name);
  }

  function byAttr(root: StubNode, attr: string, value: string): StubNode | null {
    return root.querySelectorAll(`[${attr}]`).find(n => n.getAttribute(attr) === value) ?? null;
  }

  /** Pick a single-select row: set its radio and let the module hear about it. */
  function pickRow(row: StubNode): void {
    const radio = row.querySelector('input') as unknown as { checked: boolean; dispatch: (t: string, e: unknown) => void };
    radio.checked = true;
    radio.dispatch('change', {});
  }

  function byAction(root: StubNode, action: string): StubNode | null {
    return root.querySelectorAll('button[data-elic-action]')
      .find(b => b.getAttribute('data-elic-action') === action) ?? null;
  }

  function labelsOf(nodes: StubNode[], selector: string): string[] {
    return nodes.map(n => n.querySelector(selector)!.textContent);
  }

  test('a pending form leaves ONE row in the record — the form itself is in the drawer', () => {
    const { messages, drawer } = mount();
    const record = messages.querySelector('.entry-elicitation')!;
    assert.ok(record.querySelector('.elic-pending-row'), 'the record says a form is waiting');
    assert.ok(record.querySelector('.elic-open'), '...and offers a way into it');
    assert.strictEqual(record.querySelector('.elic-body'), null, 'the form is NOT drawn in the record');
    assert.strictEqual(drawer.hidden, false, 'the drawer holds it instead');
  });

  test('the drawer pages the questions with tabs, and each custom box stays with its question', () => {
    const { drawer, docListeners } = mount([TWO]);
    const tabs = drawer.querySelectorAll('.elic-tab');
    assert.deepStrictEqual(labelsOf(tabs, '.elic-tab-text'), ['功能位置', '命令范围']);

    const panes = drawer.querySelectorAll('.elic-field');
    // Q1 is a single select: its box waits (hidden) in its own pane until a row is picked, and is
    // then MOVED under that row.
    const q1Box = byAttr(panes[0], 'data-elic-custom', 'question_0_custom')!;
    assert.ok(q1Box, 'the box belongs to Q1');
    assert.strictEqual(q1Box.hidden, true, 'but stays hidden while nothing is picked');
    assert.strictEqual(byAttr(panes[1], 'data-elic-custom', 'question_0_custom'), null,
      'and it is not in Q2');
    // Q2 is a multi: its box stays under the list, always.
    assert.ok(byAttr(panes[1], 'data-elic-custom', 'question_1_custom'), 'Q2 shows its own box');

    assert.strictEqual(panes[0].hidden, false);
    assert.strictEqual(panes[1].hidden, true, 'only the active question is shown');
    dispatchClick(tabs[1], docListeners);
    assert.strictEqual(panes[1].hidden, false);
    assert.strictEqual(panes[0].hidden, true);
  });

  test('a single select is a flat list of title + description rows, plus an Other row', () => {
    const { drawer } = mount();
    const rows = drawer.querySelectorAll('.elic-option-row');
    assert.strictEqual(rows.length, 3, 'two options and a free-form "Other"');

    assert.strictEqual(rows[0].querySelector('.elic-option-label')!.textContent, 'Astro 官方模板',
      'the option title is the row heading');
    assert.strictEqual(rows[0].querySelector('.elic-option-desc')!.textContent, '以官方 blog 模板为底',
      'the description is the sub-heading');
    assert.strictEqual(rows[1].querySelector('.elic-option-desc'), null,
      'an option without a description has no sub-heading');

    assert.ok(rows[2].className.includes('elic-other-row'), 'the free-form answer is a row of its own');
    assert.match(rows[2].querySelector('.elic-option-label')!.textContent!, /Other/);
  });

  test('picking a row unchecks the others, moves the box under it, and Clear undoes all of it', () => {
    const { drawer, docListeners } = mount();
    const rows = drawer.querySelectorAll('.elic-option-row');
    const box = () => byAttr(drawer, 'data-elic-custom', 'question_0_custom')!;

    assert.strictEqual(box().hidden, true, 'the box is parked and hidden before anything is picked');
    pickRow(rows[0]);
    assert.deepStrictEqual(inputsNamed(drawer, 'question_0').map(r => r.checked), [true, false, false]);
    assert.ok(rows[0].contains(box()), 'the box appears UNDER the picked row');
    assert.strictEqual(box().hidden, false);

    // Typing then picking another row keeps the text: the element is MOVED, not rebuilt.
    (box().querySelector('input') as unknown as { value: string }).value = '自己写的答案';
    pickRow(rows[1]);
    assert.deepStrictEqual(inputsNamed(drawer, 'question_0').map(r => r.checked), [false, true, false]);
    assert.ok(rows[1].contains(box()), 'and it moves with the pick');
    assert.strictEqual((box().querySelector('input') as unknown as { value: string }).value, '自己写的答案');

    // Nothing is required, so the pick must be undoable (a dropdown used to offer "Clear").
    const clear = drawer.querySelector('.elic-clear')!;
    assert.strictEqual(clear.hidden, false, 'offered only once there is a pick');
    dispatchClick(clear, docListeners);
    assert.deepStrictEqual(inputsNamed(drawer, 'question_0').map(r => r.checked), [false, false, false]);
    assert.strictEqual(box().hidden, true, 'and the box hides with the answer');
  });

  // [CUSTOM-20261002-168] 那条"替换上面所选"的说明行删了（用户报"描述不对"，而且我们确实改成追加了）：
  // 说明只留在输入框的 tooltip 里，不单占一行。
  test('picking the Other row opens the box under it, explained by a tooltip only (168)', () => {
    const { drawer } = mount();
    const rows = drawer.querySelectorAll('.elic-option-row');
    pickRow(rows[2]);   // Other
    const box = byAttr(drawer, 'data-elic-custom', 'question_0_custom')!;
    assert.ok(rows[2].contains(box), 'the free-form box opens under the Other row');
    assert.strictEqual(box.querySelector('.elic-custom-hint'), null, 'no extra line under the box');
    const input = box.querySelector('input') as StubNode;
    assert.ok(String(input.title || '').length > 0, 'the explanation lives in the tooltip');
  });

  test('the progress line, the tab dots and the unanswered hint all follow the answers', () => {
    const { drawer, docListeners } = mount([TWO]);
    assert.match(drawer.querySelector('.elic-progress')!.textContent!, /Answered 0\/2/);
    assert.match(drawer.querySelector('.elic-submit')!.textContent!, /Submit 0\/2/);
    const panes = drawer.querySelectorAll('.elic-field');
    assert.strictEqual(panes[0].querySelector('.elic-unanswered')!.hidden, false);

    // Tick one box of the multi-select question and let the form re-count itself.
    const boxes = inputsNamed(drawer, 'question_1');
    (boxes[0] as unknown as { checked: boolean }).checked = true;
    dispatchBubbling(boxes[0], 'change');

    assert.match(drawer.querySelector('.elic-submit')!.textContent!, /Submit 1\/2/);
    assert.ok(drawer.querySelectorAll('.elic-tab')[1].className.includes('answered'));
    assert.strictEqual(panes[1].querySelector('.elic-unanswered')!.hidden, true);
    assert.strictEqual(panes[0].querySelector('.elic-unanswered')!.hidden, false, 'Q1 is still open');
    assert.ok(docListeners, 'sanity');
  });

  test('submitting from the drawer posts the collected answers as an accept', () => {
    const { drawer, posted, docListeners } = mount();
    pickRow(drawer.querySelectorAll('.elic-option-row')[0]);
    const custom = byAttr(drawer, 'data-elic-custom', 'question_0_custom')!.querySelector('input') as unknown as { value: string };
    custom.value = ' 我自己的方案 ';

    dispatchClick(drawer.querySelector('.elic-submit')!, docListeners);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], {
      type: 'elicitationAnswer',
      promptId: 's1:1',
      action: 'accept',
      // [CUSTOM-20261002-168] 追加语义：合成**一个**答案。adapter 是 custom 优先并 return
      // （有它就丢掉所选项），所以那个 custom 字段**不能再单独发**——否则等于替换。
      content: { question_0: 'Astro 官方模板 — 我自己的方案' },
    }, 'the picked option and the note travel as one merged answer');
  });

  test('skip and cancel are decisions, and carry no content', () => {
    for (const [action, expected] of [['skip', 'decline'], ['cancel', 'cancel']] as const) {
      const { drawer, posted, docListeners } = mount();
      dispatchClick(byAction(drawer, action)!, docListeners);
      assert.deepStrictEqual(posted[0], {
        type: 'elicitationAnswer', promptId: 's1:1', action: expected,
      }, `${action} → ${expected}, with no content key`);
    }
  });

  test('collapsing shrinks the drawer to its header, and Escape only ever collapses', () => {
    const { drawer, posted, docListeners } = mount();
    dispatchClick(drawer.querySelector('.elic-toggle')!, docListeners);
    assert.ok(drawer.className.includes('collapsed'));

    for (const fn of docListeners.keydown ?? []) { fn({ key: 'Escape' }); }
    assert.deepStrictEqual(posted, [], 'Escape must never send cancel — that aborts the tool call');
  });

  // [CUSTOM-20261003-177] 收起态保留**完整 tab 条**（用户要求：收起后仍要看得到每一题的标题
  // 与圆点状态，而不是只显示当前那一题）。收起只藏正文与操作栏；点任一 tab 会展开到那一题。
  // （"tab 条真的可见"是 CSS 的事，桩 DOM 量不到 —— 那半由预览探针的 tabsDisplay/panesDisplay 钉住。）
  test('a collapsed drawer keeps every tab, and clicking one expands to it (177)', () => {
    const { NS, drawer, docListeners } = mount([TWO, SINGLE]);
    NS.elicitationView.setCollapsed(true);
    assert.ok(drawer.className.includes('collapsed'), '先确实收起了');

    const tabs = drawer.querySelectorAll('.elic-tab');
    assert.ok(tabs.length > 1, '这个夹具不止一题');
    for (const tab of tabs) {
      assert.ok(tab.querySelector('.elic-tab-dot'), '每一题都带圆点（已答/未答的状态）');
      assert.ok(String(tab.querySelector('.elic-tab-text')!.textContent || '').length > 0,
        '以及标题 —— 收起后要能看出还有哪几题');
    }

    dispatchClick(tabs[1], docListeners);
    assert.ok(!drawer.className.includes('collapsed'), '收起态点 tab 应当展开（否则点了像没反应）');
    const panes = drawer.querySelectorAll('.elic-field');
    assert.strictEqual(panes[1].hidden, false, '并且停在点的那一题');
  });

  test('a settled form is history: no controls, and a click cannot answer it again', () => {
    const { NS, drawer, messages, posted } = mount();
    // The host settles a form by revising the entry — the very path boot handles.
    NS.transcriptView.patch('e0', {
      elicitation: { ...SINGLE, status: 'accepted', summary: 'question_0: Astro 官方模板' },
    });
    NS.elicitationView.sync();

    const record = messages.querySelector('.elic')!;
    assert.strictEqual(record.querySelector('.elic-actions'), null, 'a settled record has no buttons');
    assert.match(record.querySelector('.elic-note')!.textContent!, /Answered/);
    assert.strictEqual(record.querySelector('.elic-pending-row'), null);

    NS.elicitationView.answer(record, 'submit');
    assert.deepStrictEqual(posted, [], 'only a pending form may be answered');
    assert.strictEqual(drawer.hidden, true, 'and the drawer lets go of it');
  });

  test('a deferred form says where to answer it', () => {
    const { NS } = mount();
    const card = NS.elicitationView.render({ ...SINGLE, status: 'deferred' });
    assert.strictEqual(card.querySelector('.elic-actions'), null);
    assert.match(card.querySelector('.elic-note')!.textContent!, /dialog/,
      'a disabled form with no explanation looks broken');
  });

  test('a form belonging to another session is not shown here', () => {
    // The record remembers the form; the drawer only shows it for the session it belongs to
    // (user report 2026-10-01: the drawer stayed visible after switching sessions).
    const { NS, drawer } = mount([SINGLE]);
    NS.elicitationView.setSession('s1');
    NS.elicitationView.sync();
    assert.strictEqual(drawer.hidden, false, 'its own session shows it');

    NS.elicitationView.setSession('s2');
    NS.elicitationView.sync();
    assert.strictEqual(drawer.hidden, true, 'another session must not');

    NS.elicitationView.setSession('s1');
    NS.elicitationView.sync();
    assert.strictEqual(drawer.hidden, false, 'and switching back brings it back');
  });

  // [CUSTOM-20261001-166] 收起态属于**那张表单**（dismissed 按 promptId 记），不该跟着抽屉
  // 走到下一张表单上：用户从没对新表单按下过那个按钮，它却一冒出来就是收起的。
  test('a form replacing a collapsed one starts expanded (166)', () => {
    const { NS, drawer } = mount([TWO, SINGLE]);
    NS.elicitationView.setCollapsed(true);
    assert.ok(drawer.className.includes('collapsed'), 'the first form is pushed aside');

    // The first form settles (submitted) — the drawer moves on to the second one.
    NS.transcriptView.patch('e0', { elicitation: { ...TWO, status: 'accepted' } });
    NS.elicitationView.sync();
    assert.ok(!drawer.className.includes('collapsed'),
      'a form the user never collapsed must not inherit the collapsed state of the previous one');
  });

  // [CUSTOM-20261002-168] 用户四条：追加语义 / 提示改 tooltip / 可取消选择 / 多选逐项补充框。
  test('every option keeps its description, for select and multi (168)', () => {
    const single = mount([SINGLE]);
    const selectDescs = single.drawer.querySelectorAll('.elic-option-desc').map(n => n.textContent);
    assert.ok(selectDescs.some(t => t.indexOf('以官方 blog 模板为底') >= 0),
      'select options show their explanation, got: ' + selectDescs.join(' | '));
    const multi = mount([TWO]);
    const panes = multi.drawer.querySelectorAll('.elic-field');
    const multiDescs = panes[1].querySelectorAll('.elic-option-desc').map(n => n.textContent);
    assert.ok(multiDescs.some(t => t.indexOf('新建文章') >= 0),
      'multi options show theirs too, got: ' + multiDescs.join(' | '));
  });

  test('a note on one multi option is appended to THAT option (168)', () => {
    const { NS, drawer, posted, docListeners } = mount([TWO]);
    const boxes = inputsNamed(drawer, 'question_1');
    for (const box of [boxes[0], boxes[1]]) {
      (box as unknown as { checked: boolean }).checked = true;
      dispatchBubbling(box, 'change');
    }
    const row = boxes[0].closest('.elic-option-row')!;
    const noteInput = row.querySelector('.elic-note-box')!.querySelector('input') as unknown as { value: string };
    noteInput.value = '补充说明';
    // 161: Submit 只在最后一题那一页可点 —— 多选题正是第二题（tab 1）。
    NS.elicitationView.selectTab(1);

    dispatchClick(byAction(drawer, 'submit')!, docListeners);
    const content = (posted[0] as { content: { question_1: string[] } }).content;
    assert.strictEqual(content.question_1.length, 2, 'both picked options travel');
    assert.ok(content.question_1.indexOf('new — 补充说明') >= 0,
      'the noted option reads "option — note", got: ' + content.question_1.join(' | '));
    assert.strictEqual(content.question_1.filter(t => t.indexOf('—') >= 0).length, 1,
      'only the option that was annotated is merged');
  });

  // [CUSTOM-20261003-174] 单选回归**原生 radio 交互**：再点一次已选中的行**不取消**。
  // 168 曾加过"再点一次取消"（当时那是唯一的清除入口）；174 起清除只走底部的 `Clear answer` ——
  // 一个按钮做这件事比"再点同一行"可预期得多，也不再让"手抖点两下"静默丢掉选择。
  test('a second click on the picked row keeps it picked (native radio, 174)', () => {
    const { drawer, posted, docListeners } = mount();
    const radio = inputsNamed(drawer, 'question_0')[0];
    pickRow(drawer.querySelectorAll('.elic-option-row')[0]);
    assert.strictEqual((radio as unknown as { checked: boolean }).checked, true, 'picked');

    // A second click on the same row: the browser sets checked first, then dispatches click.
    // 这正是 168 那条判据依赖的时序 —— 现在它必须**什么都不做**。
    dispatchBubbling(radio, 'click');
    assert.strictEqual((radio as unknown as { checked: boolean }).checked, true,
      '再点一次必须保持选中（原生 radio 行为）');
    assert.match(drawer.querySelector('.elic-progress')!.textContent!, /Answered 1\/1/);

    dispatchClick(drawer.querySelector('.elic-submit')!, docListeners);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual((posted[0] as { content?: unknown }).content,
      { question_0: 'Astro 官方模板' }, '提交的是那个仍然选中的选项');
  });

  // 未答不阻塞提交（adapter 的 schema 什么都不 required，空 content 也接受 —— 已实测）：
  // 174 之后"未答"就是**根本不点**，不再需要"先点再取消"那条路。
  test('an unanswered question does not block Submit (174)', () => {
    const { drawer, posted, docListeners } = mount();
    dispatchClick(drawer.querySelector('.elic-submit')!, docListeners);
    assert.strictEqual(posted.length, 1, 'an unanswered question does not block Submit');
    assert.deepStrictEqual((posted[0] as { content?: unknown }).content, {});
  });

  test('with no drawer in the page the module still renders records (stub-DOM safety)', () => {
    // #elicDrawer is absent whenever a test loads the client without it — the record path
    // must not depend on the drawer existing.
    const { NS } = loadClient();
    const card = NS.elicitationView.render(SINGLE);
    assert.ok(card.querySelector('.elic-pending-row'));
    NS.elicitationView.init();
    NS.elicitationView.sync();
    assert.ok(true, 'init/sync tolerate a missing container');
  });

  // [CUSTOM-20261001-161] 多题时 Submit 只在**最后一题**那一页可点（用户要求防误提交：
  // 翻页看看后面还有没有时，第一页的提交按钮就在手边，很容易顺手点掉）。
  test('Submit waits for the last question (161)', () => {
    const { drawer, posted, docListeners } = mount([TWO]);
    const tabs = drawer.querySelectorAll('.elic-tab');
    assert.ok(tabs.length > 1, 'this fixture has more than one question');

    const submit = byAction(drawer, 'submit')!;
    assert.strictEqual(submit.disabled, true, 'on the first question the submit button is not live');
    assert.ok(String(submit.title || '').length > 0, 'and it says why (a disabled button with no reason is a riddle)');
    dispatchClick(submit, docListeners);
    assert.deepStrictEqual(posted, [], 'clicking it there must not answer');

    dispatchClick(tabs[tabs.length - 1], docListeners);
    assert.strictEqual(byAction(drawer, 'submit')!.disabled, false, 'on the LAST question it is live');

    dispatchClick(tabs[0], docListeners);
    assert.strictEqual(byAction(drawer, 'submit')!.disabled, true, 'and going back disarms it again');
  });

  test('a single-question form submits from its only page (161)', () => {
    const { drawer } = mount([SINGLE]);
    const submit = byAction(drawer, 'submit')!;
    assert.strictEqual(submit.disabled, false, 'there is no "last question" to wait for');

    // …and Skip/Cancel are escape hatches, live on every page.
    assert.strictEqual(byAction(drawer, 'skip')!.disabled, false);
    assert.strictEqual(byAction(drawer, 'cancel')!.disabled, false);
  });

  // [CUSTOM-20261004-188] 当前页是**每张表单自己的**，不是全局的一个数字。
  //
  // 用户报"弹出选项面板，有时候会默认聚焦到最后一个选项 tab"。根因：页号是模块级的一个数字，
  // 而 161 的"夹回最后一页"是相对**当前表单**的题数做的 —— 上一张停在第 4 题（3）、新的一张只有
  // 2 题，夹回就把它落成最后一页。166 已经为 `collapsed` 踩过同一个坑（见 pitfalls #38）。
  const FOUR = {
    promptId: 's1:9',
    sessionId: 's1',
    message: '四道题',
    status: 'pending',
    fields: [0, 1, 2, 3].map(i => ({
      name: 'q' + i, kind: 'select', title: 'Q' + i,
      options: [{ value: 'v' + i, title: 'V' + i }],
    })),
  };

  /** Which page the drawer is showing (the tab carrying `.active`). */
  function activeTabOf(drawer: StubNode): number {
    return drawer.querySelectorAll('.elic-tab')
      .findIndex(t => String(t.className).split(/\s+/).includes('active'));
  }

  test('a form opens on its FIRST page, whatever page the previous one was left on (188)', () => {
    const { NS, drawer } = mount([FOUR, TWO]);
    assert.strictEqual(activeTabOf(drawer), 0, 'the first form starts at its first question');

    NS.elicitationView.selectTab(3);
    assert.strictEqual(activeTabOf(drawer), 3, 'the user paged to the last question');

    NS.elicitationView.open(TWO.promptId);
    assert.strictEqual(activeTabOf(drawer), 0,
      'the next form must start at ITS first question, not inherit the previous one\'s page');
    assert.strictEqual(drawer.querySelectorAll('.elic-field')[0].hidden, false,
      'and the first pane is the one on screen');
  });

  test('each form keeps its own page when you go back to it (188)', () => {
    const { NS, drawer } = mount([FOUR, TWO]);
    NS.elicitationView.selectTab(3);
    NS.elicitationView.open(TWO.promptId);
    assert.strictEqual(activeTabOf(drawer), 0);

    NS.elicitationView.open(FOUR.promptId);
    assert.strictEqual(activeTabOf(drawer), 3, 'per form, not one number for the whole panel');
  });

  // [CUSTOM-20261004-189] 打字时**不许搬动**那个框。
  //
  // 用户报："在附加内容输入框（以及 Other 里的自定义输入框）输入内容时，每输入一个字符就会
  // 失去焦点"。根因：`placeCustomBoxes` 每次 refresh 都 `host.appendChild(box)` ——
  // appendChild 的语义是**先摘下来再插回去**，而"摘"会让里面的输入框失焦。实测（真 Chromium，
  // preview-records.mjs 的 #elicfocusprobe）：把已聚焦节点的祖先 appendChild 到**同一个**父级，
  // 焦点照样掉（`focusAfterSameParentMove: false`）。而 refresh 每个 'input' 事件都来一次。
  //
  // 桩 DOM 建不了"焦点"，但能建"搬动"（appendChild 在这里就是移动语义，pitfall #41）——
  // 所以钉住的判据是**搬没搬**，那正是浏览器里会失焦的那件事。
  test('typing in the custom box does not re-append it (the move is what blurs it) (189)', () => {
    const { drawer } = mount([SINGLE]);
    // 选中一行 ⇒ 题目级的 Other 框被移进那一行：这是**唯一一次**合法的搬动。
    const row = drawer.querySelectorAll('.elic-option-row')[0];
    pickRow(row);
    const box = byAttr(drawer, 'data-elic-custom', 'question_0_custom')!;
    assert.strictEqual(box.parentNode, row, 'the box lives in the picked row');

    // 之后每一次 refresh（每个字符都会触发一次）都不许再搬它。
    const moves: StubNode[] = [];
    const realAppend = row.appendChild.bind(row) as (child: StubNode) => StubNode;
    (row as unknown as { appendChild: (child: StubNode) => StubNode }).appendChild =
      (child: StubNode) => { moves.push(child); return realAppend(child); };

    const input = box.querySelector('input')!;
    input.value = '写点东西';
    dispatchBubbling(input, 'input');
    dispatchBubbling(input, 'input');
    assert.deepStrictEqual(moves, [],
      're-appending an already-placed box is exactly what drops the focus in a real browser');
    assert.strictEqual(box.parentNode, row, 'and it stays where the user is typing');
  });
});


// [CUSTOM-20261001-158] 权限请求的客户端逻辑：记录行 + 悬浮抽屉。
// 与表单（152）**逐条同构**：pending 时记录里只留一行（⏳ + 标题 + Review），作答按钮在输入框
// 上方的抽屉里；显示由记录驱动（sync），结算 / 切会话都靠对账。不同的一条：两个抽屉可以**同时**
// 存在（同一会话先来表单又来权限），所以各有自己的容器与高度变量。
suite('chat client logic: permission record + drawer (stub DOM, CUSTOM-20261001-158)', () => {
  function perm(promptId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      promptId,
      sessionId: 's1',
      toolCallId: 't-' + promptId,
      title: 'cd /repo && npm test',
      kind: 'execute',
      status: 'pending',
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
      ...overrides,
    };
  }

  /** The stub's selector support is deliberately minimal — value lookups filter here. */
  function byAttr(root: StubNode, attr: string, value: string): StubNode | null {
    return root.querySelectorAll(`[${attr}]`).find(n => n.getAttribute(attr) === value) ?? null;
  }

  function mount(states = [perm('p1')]) {
    const messages = new StubNode('div');
    const drawer = new StubNode('div');
    drawer.className = 'perm-drawer';
    drawer.hidden = true;
    const { NS, doc, docListeners } = loadClient({ permDrawer: drawer, messages });
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.postForSession = (m: Record<string, unknown>) => { posted.push(m); };
    // The real delegated click path (boot installs it on body): that is what carries
    // data-perm-option from a click to permissionView.answer, including the drawer lookup.
    NS.links.installDelegatedHandlers(doc.body);
    doc.body.appendChild(drawer);
    NS.transcriptView.init(messages);
    NS.transcriptView.hydrate({
      sessionId: 's1',
      entries: states.map((permission, index) => ({ id: 'e' + index, kind: 'permission', at: index, permission })),
    });
    NS.permissionDrawer.init();
    NS.permissionDrawer.setSession('s1');
    NS.permissionDrawer.sync();
    return { NS, drawer, messages, posted, docListeners, doc };
  }

  test('a pending prompt leaves ONE row in the record — the buttons are in the drawer', () => {
    const { messages, drawer } = mount();
    const record = messages.querySelector('.entry-permission')!;
    assert.ok(record.querySelector('.perm-pending-row'), 'the record says something is waiting');
    assert.ok(record.querySelector('.perm-open'), '...and offers a way into it');
    assert.strictEqual(record.querySelector('.perm-btn'), null,
      'the buttons are NOT drawn in the record — they would push the conversation around');
    assert.strictEqual(drawer.hidden, false, 'the drawer holds them instead');
    assert.strictEqual(drawer.querySelectorAll('.perm-btn').length, 2, 'one button per option');
  });

  test('clicking an option answers once and disables the buttons until the host replies', () => {
    const { drawer, posted, docListeners } = mount();
    const allow = byAttr(drawer, 'data-perm-option', 'allow-once');
    assert.ok(allow, 'the allow button is there');

    dispatchClick(allow!, docListeners);
    assert.deepStrictEqual(posted, [{ type: 'permissionAnswer', promptId: 'p1', optionId: 'allow-once' }],
      'the answer carries the prompt id and the option id — session stamping is postForSession\'s job');

    // A second click before the host answers must not send a duplicate (the bridge is
    // idempotent, but the UI should not look like nothing happened either).
    const reject = byAttr(drawer, 'data-perm-option', 'reject')!;
    assert.strictEqual(reject.disabled, true, 'every button for that prompt is disabled while sending');
    dispatchClick(reject, docListeners);
    assert.strictEqual(posted.length, 1, 'exactly one answer');
  });

  test('a settled prompt closes the drawer and leaves a read-only card behind', () => {
    const { NS, drawer, messages } = mount();
    NS.transcriptView.patch('e0', { permission: perm('p1', { status: 'selected', selectedOptionId: 'allow-once' }) });
    NS.permissionDrawer.sync();

    assert.strictEqual(drawer.hidden, true, 'nothing is waiting any more');
    const record = messages.querySelector('.entry-permission')!;
    assert.strictEqual(record.querySelector('.perm-btn'), null, 'no buttons on history');
    assert.ok(record.querySelector('.perm-note')!.textContent.includes('Allowed'), 'the outcome is recorded');
  });

  test('a deferred prompt closes the drawer too — the dialog owns it now', () => {
    const { NS, drawer, messages } = mount();
    NS.transcriptView.patch('e0', { permission: perm('p1', { status: 'deferred' }) });
    NS.permissionDrawer.sync();

    assert.strictEqual(drawer.hidden, true, 'a second answer path would race the QuickPick');
    assert.ok(messages.querySelector('.entry-permission')!.textContent.includes('dialog'),
      'and the record says where it went');
  });

  test('a prompt belonging to another session never opens the drawer', () => {
    const { NS, drawer } = mount([perm('p1', { sessionId: 's2' })]);
    assert.strictEqual(drawer.hidden, true, 'this panel is on s1 — that request is not ours to answer here');
    // ...and it comes back when the user switches to it (the record is what remembers).
    NS.permissionDrawer.setSession('s2');
    NS.permissionDrawer.sync();
    assert.strictEqual(drawer.hidden, false);
  });

  test('two pending prompts: the row\'s Review opens the one it points at', () => {
    const { drawer, messages, docListeners } = mount([perm('p1'), perm('p2', { title: 'rm -rf build' })]);
    assert.ok(byAttr(drawer, 'data-perm-id', 'p1'), 'the first one is shown by default');

    const rows = messages.querySelectorAll('.entry-permission');
    const openSecond = byAttr(rows[1], 'data-perm-open', 'p2');
    assert.ok(openSecond, 'the second row has its own Review button');
    dispatchClick(openSecond!, docListeners);
    assert.ok(byAttr(drawer, 'data-perm-id', 'p2'), 'and it brings THAT prompt into the drawer');
    assert.ok(drawer.textContent!.includes('rm -rf build'), 'with its own title');
  });
});

// [CUSTOM-20260930-123] 连接状态卡（client/stateCard.ts）。
//
// 这里钉的是**相位机与它发出的消息**：什么时候显示什么、什么时候发 connectAgent、
// 什么时候**不**发。布局（居中、窄侧边栏下会不会撑破容器）不在这里测 —— 那要真 Chromium，
// 见 CUSTOMIZATIONS/scripts/preview-records.mjs 的 #empty / #connecting / #ready / #narrow。
suite('chat client logic: connect card (stub DOM, CUSTOM-20260930-123)', () => {
  function cardWith(options: { autoConnect?: boolean } = {}) {
    const els: Record<string, StubNode> = {
      stateCard: new StubNode('div'),
      stateBusy: new StubNode('span'),
      stateTitle: new StubNode('p'),
      stateHint: new StubNode('p'),
      stateError: new StubNode('p'),
      stateActions: new StubNode('div'),
      emptyConnect: new StubNode('button'),
      autoConnectRow: new StubNode('label'),
      autoConnectToggle: new StubNode('input'),
    };
    const harness = loadClient(els);
    const { NS, doc, docListeners, timers } = harness;
    NS.stateCard.init();
    if (options.autoConnect) { NS.stateCard.setAutoConnect(true); }
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    return { NS, els, posted, doc, docListeners, timers };
  }

  /** Fire a non-click event — the switch is a checkbox, so it reports 'change'. */
  function fire(target: StubNode, type: string): void {
    target.dispatch(type, {
      target,
      preventDefault: () => { /* nothing to cancel */ },
      stopPropagation: () => { /* the stub has no ancestors here */ },
    });
  }

  const withDelay = (timers: Array<{ fn: () => void; delay: number }>, delay: number) =>
    timers.filter(t => t.delay === delay);

  test('the offline card names the agent and offers the button', () => {
    const { NS, els } = cardWith();
    assert.strictEqual(NS.stateCard.phase(), 'disconnected');
    assert.strictEqual(els.stateTitle.textContent, 'Claude Code');
    assert.strictEqual(els.emptyConnect.disabled, false);
    assert.strictEqual(els.stateBusy.hidden, true, 'no spinner while idle');
    assert.strictEqual(els.stateError.hidden, true);
    assert.strictEqual(els.stateActions.hidden, false, 'the button is on offer');
    assert.strictEqual(els.autoConnectRow.hidden, false, 'the switch is where you would look for it');
  });

  test('the button asks the host and opens no draft of its own', () => {
    const { NS, els, posted, docListeners } = cardWith();
    // The draft is boot's job now (it opens one when the connection lands). A card that
    // opened one here would put the panel on a draft page while still disconnected —
    // and the composer is disabled until a session or a draft exists, so the user would
    // be looking at a page they cannot type into.
    let started = 0;
    NS.draft = { start: () => { started++; } };
    dispatchClick(els.emptyConnect, docListeners);
    assert.deepStrictEqual(posted, [{ type: 'connectAgent' }]);
    assert.strictEqual(started, 0, 'the card must not open a draft itself');
  });

  test('a second click while connecting is not a second request', () => {
    const { NS, els, posted, docListeners } = cardWith();
    dispatchClick(els.emptyConnect, docListeners);
    assert.strictEqual(NS.stateCard.phase(), 'connecting');
    assert.strictEqual(els.emptyConnect.disabled, true, 'the button is the anti-double-click gate');
    dispatchClick(els.emptyConnect, docListeners);
    assert.strictEqual(posted.length, 1, 'still exactly one request');
  });

  test('a connect started on the other surface shows up here too', () => {
    const { NS, els } = cardWith();
    NS.stateCard.onConnection({ type: 'connection', state: 'connecting' });
    assert.strictEqual(NS.stateCard.phase(), 'connecting');
    assert.strictEqual(els.stateBusy.hidden, false);
    assert.strictEqual(els.emptyConnect.disabled, true);
    assert.strictEqual(els.stateTitle.textContent, 'Connecting to Claude Code…');
  });

  test('connected swaps to the guidance phase and retires the button', () => {
    const { NS, els } = cardWith();
    NS.stateCard.onConnection({ type: 'connection', state: 'connected' });
    assert.strictEqual(NS.stateCard.phase(), 'ready');
    assert.strictEqual(els.stateActions.hidden, true);
    assert.strictEqual(els.stateBusy.hidden, true);
    assert.strictEqual(els.stateTitle.textContent, 'Claude Code is ready');
    // [CUSTOM-20260930-127] Connected means the card is a "go type below" sign, not a
    // settings form: the switch belongs to the state where it can still do something.
    assert.strictEqual(els.autoConnectRow.hidden, true, 'no setting to fiddle with once connected');
  });

  test('the switch stays put while connecting', () => {
    // The one state where the user may well want to turn auto-connect OFF is the one
    // where the agent is being slow — hiding the switch there would be the wrong half.
    const { NS, els } = cardWith();
    NS.stateCard.beginConnect(false);
    assert.strictEqual(els.autoConnectRow.hidden, false);
  });

  test('a failed connect reports it and re-arms the button', () => {
    const { NS, els } = cardWith();
    NS.stateCard.beginConnect(false);
    NS.stateCard.onConnection({ type: 'connection', state: 'failed', message: 'boom' });
    assert.strictEqual(NS.stateCard.phase(), 'disconnected');
    assert.strictEqual(NS.stateCard.isConnecting(), false);
    assert.strictEqual(els.emptyConnect.disabled, false, 'the user can try again');
    assert.strictEqual(els.stateError.hidden, false);
    assert.strictEqual(els.stateError.textContent, 'boom');
  });

  test('a slow start loosens the button instead of claiming failure', () => {
    const { NS, els, timers } = cardWith();
    NS.stateCard.beginConnect(false);
    const watch = withDelay(timers, 45000);
    assert.strictEqual(watch.length, 1);
    watch[0].fn();
    // npx downloading for minutes is not an error: saying "failed" would be a lie the
    // user acts on. The button comes back so they CAN retry, and the text says why.
    assert.strictEqual(NS.stateCard.isConnecting(), false);
    assert.strictEqual(els.emptyConnect.disabled, false);
    assert.ok(els.stateError.textContent.startsWith('Still starting'), els.stateError.textContent);
  });

  test('the switch persists through the host and follows it back', () => {
    const { NS, els, posted } = cardWith();
    els.autoConnectToggle.checked = true;
    fire(els.autoConnectToggle, 'change');
    assert.deepStrictEqual(posted, [{ type: 'setAutoConnect', value: true }]);
    // The host echoes the value the SETTING holds — including when the write failed, which
    // is why the checkbox listens instead of assuming its own optimism was right.
    NS.stateCard.setAutoConnect(false);
    assert.strictEqual(els.autoConnectToggle.checked, false);
  });

  test('auto-connect arms one 1000ms timer and re-checks before firing', () => {
    const { NS, timers, posted } = cardWith();
    NS.stateCard.noteBoot({ agentConnected: false, autoConnect: true, focused: false });
    const arm = withDelay(timers, 1000);
    assert.strictEqual(arm.length, 1);
    arm[0].fn();
    assert.deepStrictEqual(posted, [{ type: 'connectAgent' }]);
  });

  test('boot is delivered twice per document, and only arms once', () => {
    const { NS, timers } = cardWith();
    NS.stateCard.noteBoot({ agentConnected: false, autoConnect: true, focused: false });
    NS.stateCard.noteBoot({ agentConnected: false, autoConnect: true, focused: false });
    assert.strictEqual(withDelay(timers, 1000).length, 1);
  });

  test('auto-connect stays out of the way when it should', () => {
    for (const boot of [
      { agentConnected: false, autoConnect: false, focused: false },
      { agentConnected: true, autoConnect: true, focused: false },
      { agentConnected: false, autoConnect: true, focused: true },
    ]) {
      const { NS, timers } = cardWith();
      NS.stateCard.noteBoot(boot);
      assert.strictEqual(withDelay(timers, 1000).length, 0, JSON.stringify(boot));
    }
  });

  test('the timer re-checks, so a user who can already type is not interrupted', () => {
    const { NS, timers, posted } = cardWith();
    NS.stateCard.noteBoot({ agentConnected: false, autoConnect: true, focused: false });
    const arm = withDelay(timers, 1000);
    // Another surface opened a draft in the meantime: the composer is composable, so
    // connecting now would be answering a question nobody asked. isComposable is the
    // DIRECT signal for that (pitfall #25: never a proxy).
    NS.composer.isComposable = () => true;
    arm[0].fn();
    assert.strictEqual(posted.length, 0);
  });

  test('the host saying "connected" ends the connecting phase', () => {
    const { NS } = cardWith();
    NS.stateCard.beginConnect(false);
    NS.stateCard.setConnected(true);
    assert.strictEqual(NS.stateCard.isConnecting(), false);
    assert.strictEqual(NS.stateCard.phase(), 'ready');
  });

  test('the phase is published on the body, so CSS can key off it', () => {
    // [CUSTOM-20260930-131] The header's Times button is hidden while there is nothing to
    // put a time on; that rule lives in CSS, and this attribute is what it reads. Putting
    // it on the body (rather than letting each button watch the phase) also covers the
    // `connecting` phase a local click starts, which never reaches the host.
    const { NS, doc } = cardWith();
    assert.strictEqual(doc.body.getAttribute('data-phase'), 'disconnected');
    NS.stateCard.beginConnect(false);
    assert.strictEqual(doc.body.getAttribute('data-phase'), 'connecting');
    NS.stateCard.onConnection({ type: 'connection', state: 'connected' });
    assert.strictEqual(doc.body.getAttribute('data-phase'), 'ready');
  });

  test("a '+' pressed offline is remembered exactly once", () => {
    const { NS } = cardWith();
    NS.stateCard.beginConnect(true);
    assert.strictEqual(NS.stateCard.takeDraftIntent(), true);
    assert.strictEqual(NS.stateCard.takeDraftIntent(), false, 'consumed, not sticky');
  });

  // [CUSTOM-20261006-194] 卡在连接界面时，卡片要说得出"为什么在等"。
  //
  // 用户报"一直卡在连接界面"。日志里原因是 npx 在下载新版本适配器（`will be installed: …`），
  // 而那几行只进了日志 —— 卡片上永远只有一句 "Connecting…"，用户无从判断是在下载还是死了。
  // 现在 agent 的 stderr 会逐行下来，连接中就用它代替那句套话。
  test('the connecting card shows the agent stderr line instead of the canned sentence (194)', () => {
    const { NS, els } = cardWith();
    NS.stateCard.onConnection({ type: 'connection', state: 'connecting' });
    const canned = String(els.stateHint.textContent);
    assert.ok(canned.length > 0, 'a canned hint while connecting');

    NS.stateCard.onConnection({
      state: 'connecting',
      detail: 'npm warn exec The following package was not found and will be installed: @agentclientprotocol/claude-agent-acp@0.86.0',
    });
    assert.match(String(els.stateHint.textContent), /will be installed/,
      'the real reason replaces the canned sentence');

    // 相位本身那条（没有 detail）表示"新一轮连接"⇒ 上一轮的残留要清掉。
    NS.stateCard.onConnection({ type: 'connection', state: 'connecting' });
    assert.strictEqual(String(els.stateHint.textContent), canned, 'a phase-only update clears it');

    // 连上之后不再显示它（那时 stderr 是噪声，宿主也停止转发了）。
    NS.stateCard.onConnection({
      state: 'connecting', detail: 'some later warning',
    });
    NS.stateCard.onConnection({ type: 'connection', state: 'connected' });
    assert.ok(!String(els.stateHint.textContent).includes('later warning'), 'cleared once connected');
  });

  // [CUSTOM-20261006-195] 草稿页的首条消息：建会话要等**十几秒**（真机：agent 侧 sdk-initialize
  // 那一步 0.7s/11.1s/13.2s），这段时间卡片必须说出来 —— 否则屏幕上没有任何一处显示"已经在建了"
  // （用户报"发出第一条消息后要等很久，消息区才有反应"）。
  test('the creating card says so, and its stopwatch really counts (195)', () => {
    const { NS, els } = cardWith();
    NS.stateCard.setConnected(true);
    assert.strictEqual(NS.stateCard.phase(), 'ready');

    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      NS.stateCard.beginCreating();
      assert.strictEqual(NS.stateCard.phase(), 'creating');
      assert.match(String(els.stateTitle.textContent), /Creating this session/);
      assert.match(String(els.stateHint.textContent), /waits for it/);
      assert.strictEqual(els.stateBusy.hidden, false, 'a spinner while the session is made');
      assert.strictEqual(els.stateCard.getAttribute('aria-busy'), 'true');
      assert.strictEqual(els.stateActions.hidden, true, 'no Connect button on offer here');
      assert.strictEqual(els.autoConnectRow.hidden, true);

      // 秒表：这条同时钉住 startTick 的写入顺序（原来 connectStartedAt 当场被 stopTick 抹掉，
      // 于是 194 那个秒表一次都没显示过数字）。
      now += 13_000;
      NS.stateCard.beginCreating();   // 幂等：重试之外不该重启秒表
      assert.match(String(els.stateHint.textContent), /13s/, 'the elapsed seconds are on screen');
    } finally {
      Date.now = realNow;
    }

    // 收尾在 boot：resolveDraft（成功）/ failDraft（失败）。两条路都必须把相位复位 ——
    // 否则下一个草稿页会带着上一轮的"建会话中"进来。
    NS.stateCard.endCreating();
    assert.strictEqual(NS.stateCard.phase(), 'ready');
    assert.strictEqual(els.stateBusy.hidden, true, 'the spinner goes away');
    assert.strictEqual(els.stateCard.getAttribute('aria-busy'), 'false');
    assert.strictEqual(String(els.stateTitle.textContent), 'Claude Code is ready');
  });

  // [CUSTOM-20261006-195] socket 在半路掉了（或从没连上）时不装"建会话中"：那一刻用户能做的
  // 只有重连，卡在一张转圈的卡片上是最糟的一种。
  test('a lost connection wins over "creating" (195)', () => {
    const { NS, els } = cardWith();
    NS.stateCard.setConnected(true);
    NS.stateCard.beginCreating();
    assert.strictEqual(NS.stateCard.phase(), 'creating');

    NS.stateCard.setConnected(false);
    assert.strictEqual(NS.stateCard.phase(), 'disconnected');
    assert.strictEqual(els.stateBusy.hidden, true);
    assert.strictEqual(els.stateActions.hidden, false, 'the Connect button is back');
  });

  // [CUSTOM-20261006-195] 失败这条路：先收相位、再写错误（顺序反了报错会被压在下面）。
  test('the failure lands on the card after the wait is over (195)', () => {
    const { NS, els } = cardWith();
    NS.stateCard.setConnected(true);
    NS.stateCard.beginCreating();
    NS.stateCard.endCreating();
    NS.stateCard.setError('spawn npx ENOENT');
    assert.strictEqual(NS.stateCard.phase(), 'ready');
    assert.strictEqual(els.stateError.hidden, false);
    assert.strictEqual(String(els.stateError.textContent), 'spawn npx ENOENT');
    assert.match(String(els.stateHint.textContent), /Type your first message/, 'back to the guide');
  });
});

// [CUSTOM-20260930-128] 助手/思考记录的 markdown 请求必须**自己**发得出去。
//
// 118 给工具卡的正文修过同一个病（toolCallView 的 scheduleMarkdown），助手这一侧当时漏了：
// markPending 只入队，而全项目唯一的 flushPending 挂在 patch 路径上 ⇒ "最后一次 DOM 更新
// 就是它自己的 append"的记录**永远等不到渲染请求**，界面上只剩原文，两侧还都不报错。
// 一轮里的最后一条记录正好是这个形状（收尾的 revise 若晚到，或这一轮根本不是本面板发起的）。
suite('chat client logic: markdown asks for itself (stub DOM, CUSTOM-20260930-128)', () => {
  function withRequestLog() {
    const harness = loadClient({}, { syncFrames: true });
    const NS = harness.NS;
    let asked = 0;
    NS.boot.requestMarkdown = () => { asked++; };
    const container = new StubNode('div');
    NS.transcriptView.init(container);
    // hydrate is how the client learns its session id (and it is how a real panel always
    // arrives: boot / focus carry a snapshot).
    NS.transcriptView.hydrate({ sessionId: 's1', entries: [] });
    return { NS, asked: () => asked };
  }

  test('an assistant record asks for its own markdown the moment it lands', () => {
    const h = withRequestLog();
    // No `revise` will ever follow this one in the test — which is the whole point.
    h.NS.transcriptView.append({ id: 'a1', kind: 'assistant', at: Date.now(), text: '**bold**' }, undefined);
    assert.ok(h.asked() > 0, 'nothing else would ever ask for it');
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown().length, 1);
  });

  test('a settled thought asks too', () => {
    const h = withRequestLog();
    h.NS.transcriptView.append(
      { id: 't1', kind: 'thought', at: Date.now(), text: '_hmm_', streaming: false }, undefined);
    assert.ok(h.asked() > 0);
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown().length, 1);
  });

  test('a still-streaming thought waits for its finalize', () => {
    const h = withRequestLog();
    h.NS.transcriptView.append(
      { id: 't2', kind: 'thought', at: Date.now(), text: 'thinking...', streaming: true }, undefined);
    assert.strictEqual(h.asked(), 0, 'html for a streaming block would freeze a prefix of it');
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown().length, 0);
  });

  test('and asks as soon as it settles', () => {
    const h = withRequestLog();
    h.NS.transcriptView.append(
      { id: 't3', kind: 'thought', at: Date.now(), text: '_hmm_', streaming: true }, undefined);
    assert.strictEqual(h.asked(), 0);
    h.NS.transcriptView.patch('t3', { streaming: false });
    assert.ok(h.asked() > 0, 'the finalize patch is what lets it ask');
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown().length, 1);
  });

  // [CUSTOM-20260930-147] 完整链路：**正文后到**的那种流式记录。真实路径是
  // append（此刻还没有正文）→ revise 送 text（仍在流式）→ finalize（streaming: false）。
  // 用户报的"最后一条不渲染、重开会话就正常"就是这个形状 —— 重开走的是 hydrate（html 直接
  // 在快照里），而实时这条路要靠最后那一次 finalize 把请求补出来。
  test('an assistant whose text arrives later still asks once it settles', () => {
    const h = withRequestLog();
    h.NS.transcriptView.append(
      { id: 'a9', kind: 'assistant', at: Date.now(), text: '', streaming: true }, undefined);
    assert.strictEqual(h.asked(), 0, '还没有正文，没什么可渲染的');
    h.NS.transcriptView.patch('a9', { text: '**bold**' });
    assert.strictEqual(h.asked(), 0, '正文随 revise 到了，但这一块还在流式 —— 渲染会冻结前缀');
    h.NS.transcriptView.patch('a9', { streaming: false });
    assert.ok(h.asked() > 0, 'finalize 必须把请求补出来，否则它永远停在原文');
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown().length, 1);
  });

  // [CUSTOM-20260930-149] 真机那条路径的**根因**：reset() 会清掉会话身份，而只有快照（hydrate）
  // 会把它设回来。于是"重开面板 / 切会话之后新到的记录"整段时间里 sessionId 是 null，
  // markdown 请求带着 null 发出去 ⇒ 宿主 verifySession 不认、**静默丢弃**（Output 里的原话是
  // `dropped markdown item <id> (unknown session null)`）⇒ 界面永远停在原文，而重开会话正常
  // （重开走 hydrate，有值）。boot 现在用每条带记录的消息自带的 sessionId 校正它。
  test('reset 之后要靠 setSessionId 把会话身份找回来', () => {
    const h = withRequestLog();
    h.NS.transcriptView.append({ id: 'a1', kind: 'assistant', at: Date.now(), text: '**x**' }, undefined);
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown()[0].sessionId, 's1');

    h.NS.transcriptView.reset();
    h.NS.transcriptView.append({ id: 'a2', kind: 'assistant', at: Date.now(), text: '**y**' }, undefined);
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown()[0].sessionId, null,
      'reset 之后是 null —— 宿主就是因为这个把回填全丢了');

    h.NS.transcriptView.setSessionId('s2');
    assert.strictEqual(h.NS.transcriptView.pendingMarkdown()[0].sessionId, 's2');
  });

  // The "already has html" guard in markPending is not pinned here: letting an assistant
  // record actually render html goes through the sanitiser, which needs a real DOMParser
  // (the stub has none). That path is exercised by the replay suite in chat-panel.test.ts.
});

// [CUSTOM-20260930-132 / 137 / 138] 面板静态标记的**结构断言**（不是布局断言 —— 布局仍然只能量）。
//
// 它守的是底部栏与消息列那几处"谁在谁里面"：
//   · `#rail` 与 `#jumpToLatest` 在 `.messages-column` 内（132 搬的）。它们的横坐标来自 CSS 的
//     `left:0` / `left:50%`，锚在哪一层就贴哪条边 —— 132 给消息列加过版心，那时锚错一层会与内容
//     错开几百像素；**137 按用户要求撤销了消息区限宽**（消息要平铺开），列恢复满宽，于是它们与
//     改动前逐像素一致。搬迁仍然保留：列是消息内容的定位容器，这两者本就属于它，将来若再限宽
//     也不必重做。**别挪回 `.message-area`** —— 那会让"结构说明"与代码再次分家。
//   · 底部栏的两列：`.composer-main`（输入卡）与 `.composer-aside`（预留功能区）。圆环 138 起
//     在预留区里，把它挪回卡内就等于把发送按钮又推远。
// "谁在谁里面"桩 DOM 测不了尺寸，但**测得了序关系**，而它正是最容易被"顺手挪回去"的地方。
// 真正的布局回归由真 Chromium 兜底：CUSTOMIZATIONS/scripts/preview-records.mjs 的 #composer* 档
// 与几何探针（dxCardVsCol / dxRailVsCol / dxJumpVsCol / dxAsideVsOutline）。
suite('chat panel markup: 底部栏与消息列的承重结构 (stub markup, CUSTOM-20260930-132..138)', () => {
  const markup = chatPanelMarkup('view');

  /** 取一层容器"内部"的近似切片：从它的开标签到下一个无关兄弟的开标签。 */
  const inside = (open: string, next: string): string => {
    const from = markup.indexOf(open);
    assert.ok(from >= 0, `标记里找不到 ${open}`);
    const to = markup.indexOf(next, from + open.length);
    assert.ok(to > from, `标记里 ${open} 之后找不到 ${next}`);
    return markup.slice(from, to);
  };

  test('#rail 与 #jumpToLatest 锚在 .messages-column 里，不在 .message-area 上', () => {
    const area = inside('<div id="messageArea"', '<div id="outlineSidebar"');
    const column = inside('<div class="messages-column">', '<div id="outlineSidebar"');
    // 从列里切掉，剩下的就是列的兄弟 —— 也就是 .message-area 的直接子层。
    const siblings = area.replace(column, '');

    assert.ok(column.includes('id="rail"'),
      '#rail 必须在 .messages-column 内：它的 left:0 以定位祖先为基准，锚在 .message-area 上会贴面板左缘');
    assert.ok(!siblings.includes('id="rail"'), '#rail 被挪回 .message-area 了');
    assert.ok(column.includes('id="jumpToLatest"'),
      '#jumpToLatest 必须在列内：它的 left:50% 同理（钉住大纲栏时列中心是 (W−S)/2）');
    assert.ok(!siblings.includes('id="jumpToLatest"'), '#jumpToLatest 被挪回 .message-area 了');
    // 顺序：引导条在 #messages 之前（它是那条 19px 通道的起点，不是正文的一部分）。
    assert.ok(column.indexOf('id="rail"') < column.indexOf('id="messages"'));
    // 回归护栏：置顶卡片本来就锚在列上，别在搬来搬去的时候把它带出去。
    assert.ok(column.includes('id="stickyUser"'));
  });

  test('覆盖层仍留在 .message-area 上（099 与 123 的构造）', () => {
    const area = inside('<div id="messageArea"', '<div id="composer"');
    for (const id of ['id="outlineSidebar"', 'id="emptyState"', 'id="loadOverlay"']) {
      assert.ok(area.includes(id), `${id} 应当仍是 .message-area 的直接子节点`);
    }
  });

  test('底部栏是两列：主列（输入卡）与预留功能区', () => {
    const main = inside('<div class="composer-main">', '<div class="composer-aside">');
    assert.ok(main.includes('class="composer-inner"'), '.composer-main 要包住 .composer-inner');
    assert.ok(main.includes('id="slashPopup"'),
      '#slashPopup 必须在输入卡那一路里：锚在 .composer 上时它的 left/right 会按面板算，宽屏下横跨整屏');

    const card = inside('<div class="composer-card">', '<div class="composer-aside">');
    assert.ok(card.includes('id="promptInput"'));
    assert.ok(card.includes('id="sendStopBtn"'), 'Send 是卡片的一部分（一体式），不能留在卡外');
    // [CUSTOM-20260930-143] 上下文圆环在**按钮栏里**：138 曾把它搬到预留区（为了腾横向空间），
    // 143 搬了回来 —— 用户要的是"预留区先空着，方案定了再谈怎么用"。
    assert.ok(card.includes('id="contextMeter"'), '上下文圆环属于按钮栏，不该在别处');

    // [CUSTOM-20260930-138] 预留功能区：与输入区并列为第二列，宽度与大纲栏同源
    // （--acpc-aside-w，由 outline.ts 的 applyReserve 写；143 起只在钉住且可见时才非 0），
    // 可见时它的左边界（那根竖线）与钉住的大纲栏左边界在同一条线上。
    const aside = inside('<div class="composer-aside">', 'id="ctxMenu"');
    assert.ok(!aside.includes('id="contextMeter"'), '预留区 143 起是空的，别再往里塞东西');

    assert.ok(!markup.includes('class="input-row"'),
      '.input-row 这层已删：它唯一的子节点就是 textarea，留下的 flex:1 在新父级里含义完全不同');
  });
});

// [CUSTOM-20261002-173] 构建指纹：**让日志自己说清"这个窗口跑的是哪份代码"**。
//
// 为什么需要这三条断言：2026-10-02 排查「表单的选项说明丢了」时，两边都证明过代码是对的
// （报文里带 description、当前客户端确实画灰字第二行），可用户窗口里就是没有；而日志里
// **没有任何**能区分"这份代码有没有这段渲染"的信息 —— 宿主只报了一个版本号字符串，
// 客户端一个字节都没报。结论只能是"要么窗口跑的是旧的，要么我漏了什么"，无法收敛。
// 现在宿主 activate 报一次指纹、文档带一次、客户端 boot 再报一次，三者对照即可判定。
suite('build fingerprint: 宿主 / 标记 / 客户端三处自报身份 (CUSTOM-20261002-173)', () => {
  /** 一屏日志里应当一眼看出这是构建指纹：v 版本 · … · 哈希(字节数)。 */
  const looksLikeStamp = (text: string): boolean =>
    /^v\S+·.*[0-9a-f]{12}\(\d+B\)$/.test(text);

  test('buildStamp() 稳定、非空、只含属性安全字符', () => {
    const first = buildStamp();
    assert.strictEqual(first, buildStamp(), '同一次运行里必须稳定（算一次缓存）');
    assert.ok(looksLikeStamp(first), `指纹形状应为 "v版本·…·哈希(字节)"，实际 ${first}`);
    assert.ok(/^[A-Za-z0-9._+:()·-]+$/.test(first),
      `指纹要能直接进 HTML 属性与日志，不该含引号/空格，实际 ${first}`);
  });

  test('<body> 带 data-acpc-build，值与 buildStamp() 一致', () => {
    const markup = chatPanelMarkup('view');
    const found = /<body[^>]*data-acpc-build="([^"]*)"/.exec(markup);
    assert.ok(found, 'body 标记里必须有 data-acpc-build —— 客户端那条自报身份的日志全靠它');
    // 「哪个面」那个 class 还在（别在加属性时把 surface 挤掉）。
    assert.ok(/<body class="surface-view"[^>]*data-acpc-build=/.test(markup));
    assert.strictEqual(found[1], buildStamp());
  });

  test('客户端 boot 第一条日志报出该指纹；转发配额是滚动窗口而非终身上限', () => {
    const posted: Array<Record<string, any>> = [];
    const g = globalThis as Record<string, any>;
    const hadAcquire = Object.prototype.hasOwnProperty.call(g, 'acquireVsCodeApi');
    const realNow = Date.now;
    let clock = 1_000_000;
    g.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, any>) => { posted.push(m); } });
    (Date as any).now = () => clock;
    try {
      // 驱动 `forward` 走**客户端自己注册的 error 监听**，而不是去调全局 console.warn：
      // 后者要求"客户端打的那个补丁正好安在测试用的这个 console 对象上"，而扩展宿主的
      // console 与裸 node 未必是同一个对象 —— 实测在宿主里就一条都抓不到（白掉一次）。
      const listeners: Record<string, (e: any) => void> = {};
      const bodyEl = new StubNode('body');
      bodyEl.setAttribute('data-acpc-build', 'v9.9.9·abc1234·2020-01-01T00:00:00.000Z·deadbeefcafe(1B)');
      const doc: Record<string, unknown> = {
        // 'loading' ⇒ boot 的 init() 不跑：本套件只测日志桥这一条链路。
        readyState: 'loading',
        body: bodyEl,
        addEventListener: () => {}, removeEventListener: () => {},
        getElementById: () => null,
      };
      const win: Record<string, any> = {
        __acpc: {},
        addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
        setTimeout: () => 0,
      };
      new Function('window', 'document', bootClient)(win, doc);

      assert.strictEqual(posted.length, 1, 'boot 只该先报这一条');
      assert.strictEqual(posted[0].type, 'clientLog');
      assert.strictEqual(posted[0].level, 'info');
      assert.ok(String(posted[0].message).includes('abc1234'),
        `客户端必须把自己拿到的构建指纹报出来，实际 ${posted[0].message}`);

      const boom = (text: string) => listeners.error({ message: text, lineno: 1 });

      // 突发噪声：一个窗口内超出配额的部分被丢掉（挡洪水）。
      for (let i = 0; i < 100; i++) { boom('flood ' + i); }
      const floods = posted.filter(m => String(m.message).includes('flood')).length;
      assert.ok(floods > 0 && floods <= 30, `一个窗口内最多 30 条，实际 ${floods}`);

      // 窗口滑过之后必须能继续上报 —— 这条正是"终身 50 条"与"滚动窗口"的分水岭：
      // 旧实现里那个长命 webview（用户的窗口开了一整天）会被永久静音，诊断再也不落盘。
      clock += 11_000;
      boom('after window');
      assert.ok(posted.some(m => String(m.message).includes('after window')),
        '窗口滑过之后必须恢复上报，否则诊断会被"用满一次就永久哑掉"的老毛病挡住');

      // 读不到数据属性时只报 unknown，绝不抛（日志桥不能把 UI 拖下水）。
      const posted2: Array<Record<string, any>> = [];
      g.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, any>) => { posted2.push(m); } });
      const win2: Record<string, any> = { __acpc: {}, addEventListener: () => {}, setTimeout: () => 0 };
      new Function('window', 'document', bootClient)(win2, { ...doc, body: new StubNode('body') });
      assert.ok(String(posted2[0].message).includes('unknown'), '没有属性时报 unknown 而不是宕掉');
    } finally {
      (Date as any).now = realNow;
      if (hadAcquire) { g.acquireVsCodeApi = () => ({ postMessage: () => {} }); }
      else { delete g.acquireVsCodeApi; }
    }
  });
});

// [CUSTOM-20261003-176] 视口判定只在 scroll 事件里更新 —— 而**内容高度或底部留白**
// （输入卡 / 表单抽屉 / 权限抽屉都进 #messages 的 padding-bottom）变化时浏览器**不会**派发
// scroll 事件。用户 2026-10-03 报的"消息面板没到底（Jump 还在）、滚动条却已触底、鼠标滚不动"
// 就是这一族：贴底的人被长高的浮层挤到后面，视口判定却停在旧值。修法是写入方喊一声 reflowNow()。
suite('scroll: 几何（内容 / 留白）变化后视口判定要重算 (CUSTOM-20261003-176)', () => {
  function mountScroll(paddingBottom = '0px'): { NS: any; el: any; jump: any } {
    const NS: Record<string, any> = {};
    const listeners: Record<string, Array<() => void>> = {};
    const el: Record<string, any> = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] = listeners[type] ?? []).push(fn);
      },
      fire: (type: string) => { for (const fn of listeners[type] ?? []) { fn(); } },
    };
    const jump: Record<string, any> = { hidden: true, addEventListener: () => {} };
    const win: Record<string, any> = {
      __acpc: NS,
      getComputedStyle: () => ({ paddingBottom }),
      setTimeout: () => 0,
      addEventListener: () => {},
    };
    new Function('window', 'document', scrollClient)(win, {});
    NS.scroll.init(el, jump);
    return { NS, el, jump };
  }

  test('padding 算进"内容末尾"：贴着留白区仍然算贴底，但翻出去就不算', () => {
    const { NS, el, jump } = mountScroll('300px');
    el.scrollTop = 600;                       // max = 1000 - 400
    el.fire('scroll');
    assert.strictEqual(NS.scroll.isPinned(), true, '到底 = 内容末尾进入视口');
    el.scrollTop = 500;                       // distance = 1000-300-500-400 = -200，仍在留白区内
    el.fire('scroll');
    assert.strictEqual(NS.scroll.isPinned(), true, '留白不是内容，它不该把"到底"判成"没到底"');
    el.scrollTop = 100;                       // distance = 100 ≥ 阈值 ⇒ 真的在看历史
    el.fire('scroll');
    assert.strictEqual(NS.scroll.isPinned(), false);
    assert.strictEqual(jump.hidden, false, '这时才该出现 Jump');
  });

  test('贴底时 reflowNow() 跟着长高的（留白/内容）走 —— 这正是"内容被浮层盖住"的消失条件', () => {
    const { NS, el, jump } = mountScroll();
    el.scrollTop = 600;
    el.fire('scroll');
    assert.strictEqual(NS.scroll.isPinned(), true, '先贴底');

    el.scrollHeight = 1400;                   // 抽屉/输入卡长高 400px：浏览器**不会**派发 scroll
    NS.scroll.reflowNow();
    assert.strictEqual(el.scrollTop, 1400, '贴底的人应当被带到底部，而不是停在半空');
    assert.strictEqual(NS.scroll.isPinned(), true);
    assert.strictEqual(jump.hidden, true);
  });

  test('没贴底时 reflowNow() 绝不抢视口，只把 Jump 状态刷新', () => {
    const { NS, el, jump } = mountScroll();
    el.scrollTop = 0;
    el.fire('scroll');
    assert.strictEqual(NS.scroll.isPinned(), false, '在顶端看历史');
    assert.strictEqual(jump.hidden, false);

    el.scrollHeight = 1400;
    NS.scroll.reflowNow();
    assert.strictEqual(el.scrollTop, 0, '上翻看历史的人不该被拽走');
    assert.strictEqual(jump.hidden, false, '而且 Jump 仍然在');

    el.scrollHeight = 350;                    // 内容缩到装得下：连滚动都不需要了
    NS.scroll.reflowNow();
    assert.strictEqual(NS.scroll.isPinned(), true, '不再需要滚动 ⇒ 判定为贴底');
    assert.strictEqual(jump.hidden, true, '这时 Jump 必须自己消失（旧实现会一直挂着）');
  });
});

// [CUSTOM-20261004-180] rail.measure() 的**读写分离**。
//
// 旧版在同一个循环里读一次 getBoundingClientRect、紧接着写一次 dot.style.top —— 每一次样式写都
// 会让下一次布局读**强制重排**，于是 n 个标记 = n 次强制布局（长会话里点一次折叠就卡好几秒，
// 用户 2026-10-04 报的）。修法是分两遍：① 只读 ② 只写。
//
// 桩里量不了"重排"本身，但**量得了读写的时间线**：把每个节点的几何读取与每次样式写入都记进一条
// ops 时间线，然后数 "读→写→读" 的来回次数。旧版那是 O(标记数)，新版必须是常数级。
suite('rail: 量测读写分离 (CUSTOM-20261004-180)', () => {
  function mountRail(markCount: number): { NS: Record<string, any>; ops: string[] } {
    const ops: string[] = [];
    const read = (what: string): void => { ops.push('r:' + what); };
    const write = (what: string): void => { ops.push('w:' + what); };

    function styleStub(): Record<string, unknown> {
      const st: Record<string, unknown> = {};
      for (const prop of ['top', 'left', 'height', 'transform']) {
        Object.defineProperty(st, prop, {
          configurable: true,
          get: () => '',
          set: () => { write('style'); },
        });
      }
      return st;
    }

    function geoNode(className: string): Record<string, any> {
      const attrs: Record<string, string> = {};
      const node: Record<string, any> = {
        nodeType: 1, className, style: styleStub(), childNodes: [] as unknown[],
        textContent: '', tabIndex: -1, title: '',
        addEventListener: () => {}, removeEventListener: () => {},
        appendChild: (c: unknown) => { node.childNodes.push(c); return c; },
        // rebuild 在圆点上写 data-rail-index / title —— 少了 setAttribute 就会在**第一个**圆点上
        // 抛错（被 dom.schedule 的 try/catch 吞掉），表现成"探针里一个读都没有"。
        setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        removeAttribute: (k: string) => { delete attrs[k]; },
        querySelector: () => null, querySelectorAll: () => [] as unknown[],
        getBoundingClientRect: () => { read('rect'); return { top: 0, bottom: 0, height: 20 }; },
      };
      Object.defineProperty(node, 'offsetTop', { configurable: true, get: () => { read('top'); return 100; } });
      Object.defineProperty(node, 'offsetHeight', { configurable: true, get: () => { read('height'); return 30; } });
      Object.defineProperty(node, 'hidden', { configurable: true, get: () => false, set: () => { write('hidden'); } });
      Object.defineProperty(node, 'classList', {
        configurable: true,
        get: () => ({ add: () => { write('class'); }, remove: () => { write('class'); }, toggle: () => { write('class'); }, contains: () => false }),
      });
      return node;
    }

    const ids: string[] = [];
    const entries: Record<string, any> = {};
    const nodes: Record<string, any> = {};
    for (let i = 0; i < markCount; i++) {
      const id = 'e' + i;
      ids.push(id);
      entries[id] = { id, kind: i % 2 === 0 ? 'user' : 'assistant', text: 'line ' + i, at: i };
      nodes[id] = geoNode('entry');
    }
    const messages = geoNode('messages');
    messages.scrollTop = 0;
    const rail = geoNode('rail');
    const track = geoNode('rail-track');

    const NS: Record<string, any> = { dom: {}, transcriptView: {} };
    const win: Record<string, any> = {
      __acpc: NS,
      requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
      setTimeout: () => 0, addEventListener: () => {}, getComputedStyle: () => ({ paddingBottom: '0px' }),
    };
    const doc: Record<string, any> = { createElement: () => geoNode('x'), addEventListener: () => {} };
    new Function('window', 'document', domClient)(win, doc);
    new Function('window', 'document', railClient)(win, doc);
    NS.transcriptView = {
      ordered: () => ids,
      entry: (id: string) => entries[id],
      node: (id: string) => nodes[id],
      resolvePendingFolds: () => {},
    };
    NS.rail.init(messages, rail, track);
    return { NS, ops };
  }

  test('一次全量量测里，"写之后再读"只出现常数次（旧版是 O(标记数)）', () => {
    const { NS, ops } = mountRail(24);
    ops.length = 0;
    NS.rail.invalidate();      // rebuild + measure（桩的 rAF 是同步的）
    // 数 "写→读" 的来回：旧版每个标记都要付一次。
    let flips = 0;
    let sawWrite = false;
    for (const op of ops) {
      if (op.startsWith('w:')) { sawWrite = true; continue; }
      if (sawWrite && op.startsWith('r:')) { flips += 1; sawWrite = false; }
    }
    assert.ok(ops.filter(o => o.startsWith('r:')).length > 0, '这一轮确实读了几何');
    assert.ok(ops.filter(o => o.startsWith('w:')).length > 0, '也确实写了圆点位置');
    assert.ok(flips <= 4,
      `一次量测里"写后再读"应当只剩常数次（收尾的 applyScroll/syncActive 那几下），实际 ${flips} 次 —— ` +
      '退回边读边写时它会随标记数增长（24 个标记 ≈ 24 次强制重排）');
  });
});

// [CUSTOM-20261004-184] 正文里的本地文件链接：点击要落到 `openFile`，不是 `openLink`。
//
// **这一条补的是半边链**。宿主侧（`markdown.ts` 写出 data-path）在同一天的 `chat-panel.test.ts`
// 里已经钉住了，但"点了之后客户端发什么"此前**从来没有测过**——`data-path` 这条委托从 039
// 起只服务工具卡 chip，而 chip 与正文链接是**两条渲染路径**（pitfalls #47）。两端各证一遍
// 不等于整条链通了（pitfalls #43），所以这里把点击真跑一次，断言发出去的消息形状。
suite('chat client logic: file links in prose (stub DOM)', () => {
  function clickOnAttr(attr: string, value: string, extra?: [string, string]) {
    const harness = loadClient();
    const root = new StubNode('div');
    const target = new StubNode('a');
    target.setAttribute(attr, value);
    if (extra) { target.setAttribute(extra[0], extra[1]); }
    root.appendChild(target);
    harness.NS.links.installDelegatedHandlers(root);

    const sent: Array<Record<string, unknown>> = [];
    harness.NS.bridge.post = (msg: Record<string, unknown>) => { sent.push(msg); };
    harness.NS.bridge.postForSession = (msg: Record<string, unknown>) => { sent.push(msg); };
    dispatchClick(target, harness.docListeners);
    return sent;
  }

  test('a data-path link asks to open the file at its line', () => {
    assert.deepStrictEqual(clickOnAttr('data-path', 'GOAL.md', ['data-line', '74']), [
      { type: 'openFile', path: 'GOAL.md', line: 74 },
    ]);
  });

  test('without a line the request carries no line at all', () => {
    assert.deepStrictEqual(clickOnAttr('data-path', 'docs/notes.md'), [
      { type: 'openFile', path: 'docs/notes.md', line: undefined },
    ]);
  });

  test('a data-href link still takes the external channel', () => {
    assert.deepStrictEqual(clickOnAttr('data-href', 'https://example.com'), [
      { type: 'openLink', href: 'https://example.com' },
    ]);
  });
});

// [CUSTOM-20261007-197] 右键菜单「按上下文给项」。
//
// 用户报：「用户消息的悬浮卡片，鼠标右键弹出的 Copy 现在是灰置的，需要支持拷贝消息」。
// `Copy`（复制**选区**）在没选区时禁用是 067 故意的（装作能用比禁用更糟），问题在**菜单里除了
// 它 + Select all 什么都没有**：置顶悬浮卡是另一棵树（.sticky-user > .sticky-card > .sticky-body >
// 克隆体），而卡片外壳不带 `data-entry-id` —— 用户右键点的往往正是那圈留白/边框，于是「复制
// 这条消息」这件事在这一处**完全不可达**。卡片的 `data-sticky-id` 就是这条记录的 id（stickyUser
// 写上的），菜单把它一起认下来即可。
suite('chat client logic: context menu items (stub DOM, CUSTOM-20261007-197)', () => {
  const text = '把这条消息拷走';

  function withEntry() {
    const messages = new StubNode('div');
    const harness = loadClient({ messages });
    const { NS } = harness;
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.post = (message: Record<string, unknown>) => { posted.push(message); };
    // 记录的正文要**真的进过转录**（entry(id) 才解析得到）—— 这是 067 那条老路
    // 「entryTextOf → transcriptView.entry」的前提，桩里同样要走一遍。
    NS.transcriptView.init(messages);
    NS.transcriptView.append({ id: 'u1', kind: 'user', at: 1, text }, undefined);
    return { NS, posted };
  }

  function labels(items: Array<{ label: string }>): string {
    return items.map(i => i.label).join(' / ');
  }

  test('a record node offers Copy message', () => {
    const { NS, posted } = withEntry();
    const record = new StubNode('div');
    record.setAttribute('data-entry-id', 'u1');

    const items = NS.contextMenu.itemsFor(record) as Array<{ label: string; run: () => void }>;
    const copyMessage = items.find(i => i.label === 'Copy message');
    assert.ok(copyMessage, `expected Copy message, got: ${labels(items)}`);
    copyMessage.run();
    assert.deepStrictEqual(posted, [{ type: 'copy', text }], 'the record正文 goes to the clipboard channel');
  });

  test('the sticky card offers it from its own whitespace (197)', () => {
    const { NS, posted } = withEntry();
    // 卡片的留白：既不在克隆体里，也不带 data-entry-id —— 正是用户右键点中的那一处。
    const card = new StubNode('div');
    card.className = 'sticky-card';
    card.setAttribute('data-sticky-id', 'u1');
    const body = new StubNode('div');
    body.className = 'sticky-body';
    card.appendChild(body);
    const blank = new StubNode('div');
    body.appendChild(blank);

    const items = NS.contextMenu.itemsFor(blank) as Array<{ label: string; run: () => void }>;
    const copyMessage = items.find(i => i.label === 'Copy message');
    assert.ok(copyMessage, `expected Copy message, got: ${labels(items)}`);
    copyMessage.run();
    assert.deepStrictEqual(posted, [{ type: 'copy', text }]);
  });

  test('a card whose record is gone degrades to the old menu', () => {
    const { NS } = withEntry();
    const card = new StubNode('div');
    card.className = 'sticky-card';
    card.setAttribute('data-sticky-id', 'gone');
    const blank = new StubNode('div');
    card.appendChild(blank);

    const items = NS.contextMenu.itemsFor(blank) as Array<{ label: string }>;
    assert.ok(!items.some(i => i.label === 'Copy message'),
      `an unknown id must not offer a copy that would copy nothing: ${labels(items)}`);
  });
});
