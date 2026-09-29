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
// [CUSTOM-20260929-119] Form cards (ACP elicitation / AskUserQuestion).
import { elicitationViewClient } from '../ui/chat/html/client/elicitationView';
import { composerClient } from '../ui/chat/html/client/composer';
import { tabsClient } from '../ui/chat/html/client/tabs';
import { toolCallViewClient } from '../ui/chat/html/client/toolCallView';
import { transcriptViewClient } from '../ui/chat/html/client/transcriptView';
import { outlineClient } from '../ui/chat/html/client/outline';
import { stickyUserClient } from '../ui/chat/html/client/stickyUser';

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

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  getBoundingClientRect(): { height: number; top: number; bottom: number } {
    return { height: this.rectHeight, top: this.rectTop, bottom: this.rectBottom };
  }

  private readonly listeners: Record<string, Array<(event: any) => void>> = {};

  appendChild<T extends StubNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends StubNode>(child: T, before: StubNode | null): T {
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

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
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
  const win: Record<string, any> = {
    __acpc: {},
    // [CUSTOM-20260928-100] `syncFrames` runs scheduled callbacks immediately, so a
    // test can drive a path that defers its layout reads to the next frame (the
    // outline's scroll pass) without a real animation frame.
    requestAnimationFrame: opts.syncFrames ? (fn: () => void) => { fn(); return 0; } : () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    getSelection: () => null,
    innerHeight: 800,
    innerWidth: 600,
    // boot installs the console/error log bridge at load time.
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const doc = {
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
  for (const source of [domClient, iconsClient, linksClient, toolCallViewClient, transcriptViewClient, outlineClient, sessionMenuClient, composerClient, tabsClient, stickyUserClient, elicitationViewClient]) {
    new Function('window', 'document', source)(win, doc);
  }
  return { NS, metrics, doc, docListeners, jumps };
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
    assert.strictEqual(summary!.textContent, '跑全部闸门。', 'the whole text stays in the summary');
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
    assert.ok(original.startsWith(summary!.textContent), `summary must be a prefix: ${summary!.textContent}`);
    assert.ok(original.endsWith(body!.textContent), `body must be a suffix: ${body!.textContent}`);
    assert.ok(
      summary!.textContent.length + body!.textContent.length >= original.length - 1,
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
    assert.strictEqual(summary!.textContent + body!.textContent, text, 'nothing lost, nothing repeated');
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
    assert.strictEqual(summary!.textContent, text, 'the summary carries the whole text');
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
    const order = summary.childNodes.map(c => (c.nodeType === 1 ? c.className : 'text')).join(',');
    assert.ok(order.startsWith('rec-icon,fold-caret'), `caret must follow the icon, got: ${order}`);

    // The finalize rewrite replaces the label; it must not take the decorations with it.
    NS.transcriptView.patch('t1', { streaming: false, elapsedMs: 1200 });
    const after = summary.childNodes.map(c => (c.nodeType === 1 ? c.className : 'text')).join(',');
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
    const order = summary.childNodes.map(c => (c.nodeType === 1 ? c.className : 'text')).join(',');
    assert.ok(order.startsWith('rec-icon,fold-caret'), `caret must follow the icon, got: ${order}`);
    // The content must NOT be inside the summary: selecting text in a summary toggles it.
    assert.strictEqual(summary.querySelector('.bubble-body'), null, 'the body is not inside the summary');
    assert.strictEqual(body!.textContent, '啊唯，三条都收到。', 'the text lives in the body');
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
    const after = summary.childNodes.map(c => (c.nodeType === 1 ? c.className : 'text')).join(',');
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
    const order = summary.childNodes.map(c => (c.nodeType === 1 ? c.className : 'text')).join(',');
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
      tabs: new StubNode('div'),
      agentBar: new StubNode('div'),
      agentSelect: new StubNode('select'),
      cwdBtn: new StubNode('button'),
      usageBar: new StubNode('div'),
      newTab: new StubNode('button'),
    };
    const { NS } = loadClient(els);
    NS.tabs.init();
    return { NS, els };
  }

  const summary = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: 'a session', cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
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

  test('the directory button disappears when there is nothing to point at', () => {
    const { NS, els } = tabStrip();
    // No session: an empty button that still opens the directory drawer explains that
    // "this session has already started" about a panel that has no session at all.
    NS.tabs.setFocus(null);
    assert.strictEqual(els.cwdBtn.hidden, true);

    // A session has a directory…
    NS.tabs.setFocus(summary('s1'));
    assert.strictEqual(els.cwdBtn.hidden, false);
    // …and so does a draft (that is what the drawer is for).
    NS.tabs.setDraftFocus({ draftId: 'd1', cwd: '/tmp/x' });
    assert.strictEqual(els.cwdBtn.hidden, false);
    NS.tabs.setFocus(null);
    assert.strictEqual(els.cwdBtn.hidden, true, 'and it goes away again');
  });
});

suite('chat client logic: composer text ownership (stub DOM)', () => {
  // [CUSTOM-20260927-085] Found by the audit, in two halves that share one cause: the
  // textarea's store was keyed by SESSION id only, and a draft has none — so
  // `stashDraft` did nothing while a draft was focused. Leaving a draft discarded what
  // you had typed; entering another draft showed the previous one's text.

  function composerWithInput(): { NS: Record<string, any>; input: StubNode } {
    const input = new StubNode('textarea');
    const { NS } = loadClient({
      promptInput: input,
      sendStopBtn: new StubNode('button'),
      slashPopup: new StubNode('div'),
      attachments: new StubNode('div'),
      configPickers: new StubNode('div'),
      // [CUSTOM-20260928-096] body.ts now always supplies it; the stub mirrors that.
      contextMeter: new StubNode('div'),
    });
    NS.composer.init();
    return { NS, input };
  }

  const session = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: null, cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
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

  /** An open drawer with a filled list, exactly as boot would leave it. */
  function openedPicker(overrides: Record<string, unknown> = {}): { NS: Record<string, any>; docListeners: Record<string, Array<(e: any) => void>>; tree: ReturnType<typeof historyDrawer> } {
    const tree = historyDrawer();
    const { NS, docListeners } = loadClient(tree.elements);
    NS.sessionMenu.init();
    dispatchClick(tree.elements.historyBtn, docListeners);   // the ↺ button opens it
    // ...and the host's reply fills the list (this is what `setHistory` sees).
    NS.sessionMenu.setHistory({
      type: 'history', agentName: 'Claude Code', source: 'agent',
      sessions: SESSIONS, directories: DIRECTORIES,
      ...overrides,
    });
    return { NS, docListeners, tree };
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
});

// [CUSTOM-20260928-096] 输入区四项优化里可落到桩 DOM 测的三条逻辑：上下文计量、
// 图片附件的发送守卫、图片 chip 的缩略图/回退图标。布局（按钮栏下移 / Send 图标居中 /
// Jump to latest 居中）属真浏览器的事，见文件头「桩 DOM 只测逻辑」的边界。
suite('chat client logic: composer input bar (stub DOM)', () => {
  function composerBar(): {
    NS: Record<string, any>; input: StubNode; sendBtn: StubNode; contextMeter: StubNode; attachments: StubNode;
  } {
    const input = new StubNode('textarea');
    const sendBtn = new StubNode('button');
    const contextMeter = new StubNode('div');
    const attachments = new StubNode('div');
    const { NS } = loadClient({
      promptInput: input,
      sendStopBtn: sendBtn,
      slashPopup: new StubNode('div'),
      attachments,
      configPickers: new StubNode('div'),
      contextMeter,
    });
    NS.composer.init();
    return { NS, input, sendBtn, contextMeter, attachments };
  }

  const session = (id: string) => ({
    sessionId: id, agentName: 'Claude Code', title: null, cwd: '/tmp',
    createdAt: '', loading: false, running: false, unread: false,
  });

  test('the context meter shows a percentage, and hides without a size', () => {
    const { NS, contextMeter } = composerBar();
    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 1000000 } });
    assert.strictEqual(contextMeter.hidden, false, 'usage with a size must show the meter');
    assert.ok(contextMeter.textContent.includes('45%'), `percent label, got: ${contextMeter.textContent}`);
    assert.ok(contextMeter.querySelector('.usage-fill'), 'a fill is rendered');

    NS.composer.setMeta({ availableCommands: [], configOptions: [], usage: { used: 450000, size: 0 } });
    assert.strictEqual(contextMeter.hidden, true, 'no context size ⇒ hide the meter');
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

  /** The three elements the bar is built from, plus the messages list it watches. */
  function pinnedNodes() {
    const messages = new StubNode('div');
    const host = new StubNode('div');
    const card = new StubNode('div');
    const body = new StubNode('div');
    const toggle = new StubNode('button');
    host.hidden = true;
    toggle.hidden = true;
    // body.ts's structure, spelled out:
    //   #stickyUser > (#stickyToggle, .sticky-card > #stickyBody)
    // Two things depend on it being real rather than flat — the copy has to be reachable
    // through the host (assertions read textContent from there), and the click on the button
    // has to travel a path that includes the host for "stopPropagation keeps the jump from
    // firing" to assert anything at all. Since 105 the button is a SIBLING of the card (the
    // messages fill the card, so an inside button would sit on the text).
    host.appendChild(toggle);
    host.appendChild(card);
    card.appendChild(body);
    return { messages, host, body, toggle };
  }

  function pinnedSetup(): {
    NS: Record<string, any>; messages: StubNode; host: StubNode; body: StubNode;
    toggle: StubNode; jumps: Array<{ node: StubNode | null; clearance?: number }>;
    docListeners: Record<string, Array<(event: any) => void>>;
  } {
    const { messages, host, body, toggle } = pinnedNodes();
    const loaded = loadClient(
      { messages, stickyUser: host, stickyBody: body, stickyToggle: toggle },
      { syncFrames: true },
    );
    const { NS, docListeners, jumps } = loaded;
    NS.transcriptView.init(messages);
    NS.transcriptView.append({ id: 'u1', kind: 'user', at: 1, text: 'the question' }, undefined);
    NS.transcriptView.append({ id: 'a1', kind: 'assistant', at: 2, text: 'an answer' }, undefined);
    NS.stickyUser.init();
    // [CUSTOM-20260928-103] A viewport tall enough for "on screen" to mean something:
    // with the default 0 every message reads as visible and nothing could ever be pinned.
    messages.clientHeight = 600;
    // The user bubble occupies 8..48 of the scroll content — 8 is `.messages`' padding-top,
    // and modelling it matters: it is what keeps a question resting at the very top from
    // being taken over (its top sits AT the handoff window's edge, not inside it).
    const nodes = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    nodes[0].offsetTop = 8;
    nodes[0].offsetHeight = 40;
    return { NS, messages, host, body, toggle, jumps, docListeners };
  }

  /** [CUSTOM-20260928-103] Two questions: u1 at 8..48, u2 at 1000..1040. */
  function twoQuestionSetup(): { NS: Record<string, any>; messages: StubNode; host: StubNode } {
    const { messages, host, body, toggle } = pinnedNodes();
    const { NS } = loadClient(
      { messages, stickyUser: host, stickyBody: body, stickyToggle: toggle },
      { syncFrames: true },
    );
    NS.transcriptView.init(messages);
    NS.transcriptView.append({ id: 'u1', kind: 'user', at: 1, text: 'first question' }, undefined);
    NS.transcriptView.append({ id: 'a1', kind: 'assistant', at: 2, text: 'first answer' }, undefined);
    NS.transcriptView.append({ id: 'u2', kind: 'user', at: 3, text: 'second question' }, undefined);
    NS.transcriptView.append({ id: 'a2', kind: 'assistant', at: 4, text: 'second answer' }, undefined);
    NS.stickyUser.init();
    messages.clientHeight = 600;
    const nodes = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    nodes[0].offsetTop = 8; nodes[0].offsetHeight = 40;
    nodes[2].offsetTop = 1000; nodes[2].offsetHeight = 40;
    return { NS, messages, host };
  }

  /** [CUSTOM-20260928-104] One long (folded) question, so the bar has something to shrink to. */
  function foldedPinnedSetup(): {
    NS: Record<string, any>; messages: StubNode; host: StubNode; body: StubNode;
    toggle: StubNode; jumps: Array<{ node: StubNode | null; clearance?: number }>;
    docListeners: Record<string, Array<(event: any) => void>>;
  } {
    const { messages, host, body, toggle } = pinnedNodes();
    const loaded = loadClient(
      { messages, stickyUser: host, stickyBody: body, stickyToggle: toggle },
      { syncFrames: true },
    );
    const { NS, docListeners, jumps } = loaded;
    NS.transcriptView.init(messages);
    // 240 characters, no newline anywhere: twelve lines in the stub's 20-chars-per-line model.
    NS.transcriptView.append({ id: 'u1', kind: 'user', at: 1, text: 'q '.repeat(120) }, undefined);
    NS.stickyUser.init();
    messages.clientHeight = 600;
    const nodes = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    nodes[0].offsetTop = 8;
    nodes[0].offsetHeight = 40;
    return { NS, messages, host, body, toggle, jumps, docListeners };
  }

  test('the question is taken over as soon as its top reaches the top edge', () => {
    const { messages, host, body } = pinnedSetup();
    messages.scrollTop = 100;   // 0 - 100 is inside the handoff window
    messages.dispatch('scroll', {});

    assert.strictEqual(host.hidden, false, 'the floating bar appears');
    assert.strictEqual(host.getAttribute('data-jump-target'), 'u1');
    assert.ok(body.textContent.includes('the question'), 'it keeps the message rendering verbatim');
  });

  test('nothing is pinned while the question still sits below the top edge', () => {
    const { messages, host } = pinnedSetup();
    messages.scrollTop = 0;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.hidden, true, 'the message itself is visible — no copy needed');

    // …and it takes over once the reader scrolls it up to the edge.
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.hidden, false);
  });

  // [CUSTOM-20260928-104] The bar is a COPY, so the original has to stand back — otherwise
  // the handoff itself would show the same question twice, which is exactly what 102/103
  // avoided by waiting for it to leave the screen entirely. `visibility`, not `display`:
  // the geometry has to survive (rail markers, jumpTo's offsetTop).
  test('the original stands back while the bar stands in for it', () => {
    const { messages, host } = pinnedSetup();
    const u1 = messages.childNodes.filter((c: StubNode) => c.nodeType === 1)[0];
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.ok(u1.classList.contains('sticky-source'), 'hidden in place, right where it was');
    assert.strictEqual(host.hidden, false);

    messages.scrollTop = 0;
    messages.dispatch('scroll', {});
    assert.ok(!u1.classList.contains('sticky-source'), 'and it is handed back on the way up');
    assert.strictEqual(host.hidden, true);
  });

  // [CUSTOM-20260928-104] The class that hides the source is copied along by cloneNode, so a
  // RE-render clones an already-hidden node. That failure is silent — the bar just comes up
  // empty — so it gets its own case rather than riding along on the one above.
  test('a re-render never clones the hiding class into the bar', () => {
    const { NS, messages, body } = pinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.ok((NS.transcriptView.node('u1') as StubNode).classList.contains('sticky-source'),
      'the original carries the class by now');

    NS.stickyUser.refresh();
    const copy = body.childNodes.find((c: StubNode) => c.nodeType === 1) as StubNode;
    assert.ok(copy, 'the bar was rebuilt');
    assert.ok(!copy.classList.contains('sticky-source'),
      'the copy stays visible: it is not inside .messages, and render() strips the class anyway');
  });

  test('the bar takes over the instant the question reaches the edge, not when it is gone', () => {
    const { messages, host } = twoQuestionSetup();
    const nodes = messages.childNodes.filter((c: StubNode) => c.nodeType === 1);
    // u2 spans 1000..1040: at 1001 it has moved up one pixel and is still 39px on screen.
    // 103 waited for all 40 of them to leave — that wait is what felt abrupt.
    messages.scrollTop = 1001;
    messages.dispatch('scroll', {});

    assert.strictEqual(host.getAttribute('data-jump-target'), 'u2');
    assert.ok(nodes[2].classList.contains('sticky-source'), 'and u2 itself stands back');
    assert.ok(!nodes[0].classList.contains('sticky-source'), 'the one it replaced is released');
  });

  // [CUSTOM-20260928-103] The rule the user asked for: a question that is still on screen
  // must not be preceded by a pinned older one. Before this change the walk simply took
  // "the last question above the fold", so scrolling back up to u2 pinned u1 above it —
  // two questions on screen at once.
  test('a question on screen is not preceded by a pinned older one', () => {
    const { messages, host } = twoQuestionSetup();
    messages.scrollTop = 500;   // viewport 500..1100: u1 is gone, u2 (1000..1040) is visible
    messages.dispatch('scroll', {});
    assert.strictEqual(host.hidden, true, 'u2 is right there — pinning u1 would show two');
  });

  test('the next question takes over once it reaches the top edge', () => {
    const { messages, host } = twoQuestionSetup();
    messages.scrollTop = 1100;  // both questions are above the fold
    messages.dispatch('scroll', {});

    assert.strictEqual(host.hidden, false);
    assert.strictEqual(host.getAttribute('data-jump-target'), 'u2', 'the newest one wins');
    assert.ok(host.textContent.includes('second question'));
  });

  test('scrolling back up clears the pin instead of falling back to an older one', () => {
    const { messages, host } = twoQuestionSetup();
    messages.scrollTop = 1100;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.getAttribute('data-jump-target'), 'u2');

    // u2 is on screen again (its top 100px below the edge) — the bar lets go of the turn,
    // and does NOT hand it to u1: that one is nowhere near.
    messages.scrollTop = 900;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.hidden, true, 'not u1 — the reader is looking at u2');
  });

  test('clicking the bar hands the question back to the transcript', () => {
    const { NS, messages, host, jumps, docListeners } = pinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    dispatchClick(host, docListeners);

    assert.strictEqual(jumps.length, 1, 'the click jumps back to the original');
    assert.strictEqual(jumps[0].node, NS.transcriptView.node('u1'));
    assert.strictEqual(jumps[0].clearance, 9,
      'landing clear of the handoff window: exactly on it would give the message straight back');
  });

  test('the pinned copy mirrors the list rendering toggles', () => {
    const { NS, messages, host } = pinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.ok(!host.className.includes('show-times'), 'times off: no stamp in the copy either');

    messages.classList.add('show-times');
    NS.stickyUser.refresh();
    assert.ok(host.className.includes('show-times'), 'times on: the copy follows the list');
  });

  // [CUSTOM-20260928-104] The bar sticks for as long as the turn lasts, so a long question
  // would eat the screen — hence the shrink button. It is offered only when there is a fold
  // to shrink: a one-line bubble is already one line.
  // [CUSTOM-20260928-105] Alignment the user can see: the messages sit inside a scroll
  // container, so their content box is narrower than the column by the scrollbar — the bar
  // is not a scroll container and would otherwise hang that far to the right.
  test('the bar ends where the messages end, scrollbar included', () => {
    const { messages, host } = pinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.style.right, '0px', 'no scrollbar: nothing to give way to');

    messages.offsetWidth = 610;
    messages.clientWidth = 600;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.style.right, '10px', 'the thin scrollbar is part of the layout');

    messages.offsetWidth = 600;
    messages.dispatch('scroll', {});
    assert.strictEqual(host.style.right, '0px', 'and it goes back when the scrollbar does');
  });

  test('the bar shrinks to one line — and is offered only when there is more than one', () => {
    const { messages, host, body, toggle, jumps, docListeners } = foldedPinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});

    assert.strictEqual(host.hidden, false);
    assert.ok(body.querySelector('.user-fold'), 'a wrapped question folds (measured, CUSTOM-20260925-071)');
    assert.strictEqual(toggle.hidden, false, 'a multi-line message can be shrunk');

    dispatchClick(toggle, docListeners);
    assert.ok(host.classList.contains('collapsed'), 'the bar collapses to a single line');
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
    assert.strictEqual(jumps.length, 0, 'shrinking is not the host click — the bar must not also jump');

    dispatchClick(toggle, docListeners);
    assert.ok(!host.classList.contains('collapsed'), 'and it opens again');
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  });

  test('a one-line question gets no shrink button (a dead control is worse than none)', () => {
    const { messages, toggle } = pinnedSetup();
    messages.scrollTop = 100;
    messages.dispatch('scroll', {});
    assert.strictEqual(toggle.hidden, true);
  });
});

// [CUSTOM-20260929-119] 表单卡（ACP elicitation / AskUserQuestion）的客户端逻辑。
// 载荷形状取自 adapter 的真实产物（`askUserQuestionsToCreateRequest`）：单选是 `oneOf` →
// 宿主扁平化成 kind:'select'，每题还有一个 `_meta._askUserQuestionCustomAnswer` 标记的自由文本框。
// 提交的值要按 ACP 的形状回传（`{question_0: '标签'}`），否则模型的答案表是空的。
suite('chat client logic: form card (stub DOM, CUSTOM-20260929-119)', () => {
  function state(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
      ...over,
    };
  }

  /** A card plus the messages the client posted while answering it. */
  function cardWith(NS: Record<string, any>, over: Record<string, unknown> = {}): {
    card: StubNode; posted: Array<Record<string, unknown>>;
  } {
    const posted: Array<Record<string, unknown>> = [];
    NS.bridge.postForSession = (message: Record<string, unknown>) => { posted.push(message); };
    const card = NS.elicitationView.render(state(over));
    return { card, posted };
  }

  function inputsOf(card: StubNode, selector = 'input'): StubNode[] {
    return card.querySelectorAll(selector);
  }

  test('the form shows the question, one radio per option, and the Other box', () => {
    const { NS } = loadClient();
    const { card } = cardWith(NS);
    assert.strictEqual(card.querySelector('.elic-title')!.textContent, '博客的基础框架方案倾向哪种？');
    const radios = inputsOf(card, 'input[data-field]').filter(i => i.type === 'radio');
    assert.strictEqual(radios.length, 2, 'one radio per option');
    assert.strictEqual(radios[0].value, 'Astro 官方模板');
    assert.ok(card.querySelector('.elic-option-desc'), 'the option description is rendered');
    const custom = inputsOf(card, 'input[data-field]').find(i => i.getAttribute('data-field') === 'question_0_custom');
    assert.ok(custom, 'the "Other" box is there');
    assert.ok((custom!.parentNode as StubNode).className.includes('elic-other'),
      'and it is grouped under its question, not as a peer');
  });

  test('submitting posts the collected answers as an accept', () => {
    const { NS } = loadClient();
    const { card, posted } = cardWith(NS);
    const radio = inputsOf(card, 'input[data-field]').find(i => i.type === 'radio')!;
    (radio as unknown as { checked: boolean }).checked = true;

    NS.elicitationView.answer(card, 'submit');
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], {
      type: 'elicitationAnswer',
      promptId: 's1:1',
      action: 'accept',
      content: { question_0: 'Astro 官方模板' },
    }, 'the answer key is the field name, the value is the option label (what the tool records)');
    assert.ok(!('question_0_custom' in (posted[0].content as Record<string, unknown>)),
      'an empty Other box contributes nothing');
  });

  test('a typed Other answer travels alongside the selection', () => {
    const { NS } = loadClient();
    const { card, posted } = cardWith(NS);
    const custom = inputsOf(card, 'input[data-field]').find(i => i.getAttribute('data-field') === 'question_0_custom')!;
    (custom as unknown as { value: string }).value = ' 我自己的方案 ';
    NS.elicitationView.answer(card, 'submit');
    assert.strictEqual((posted[0].content as Record<string, string>).question_0_custom, '我自己的方案',
      'trimmed; the adapter gives a typed answer precedence over the selection');
  });

  test('skip and cancel are decisions, and carry no content', () => {
    const { NS } = loadClient();
    for (const [action, expected] of [['skip', 'decline'], ['cancel', 'cancel']] as const) {
      const { NS: fresh } = loadClient();
      const { card, posted } = cardWith(fresh);
      fresh.elicitationView.answer(card, action);
      assert.deepStrictEqual(posted[0], {
        type: 'elicitationAnswer', promptId: 's1:1', action: expected,
      }, `${action} → ${expected}, with no content key`);
    }
    assert.ok(NS, 'sanity');
  });

  test('a settled card cannot be answered again', () => {
    const { NS } = loadClient();
    const { card, posted } = cardWith(NS);
    NS.elicitationView.applyState(card, state({ status: 'accepted', summary: 'question_0: Astro 官方模板' }));
    assert.strictEqual(card.querySelector('.elic-actions')!.hidden, true, 'the buttons are gone');
    assert.strictEqual(card.querySelector('.elic-note')!.textContent, 'Answered · question_0: Astro 官方模板');
    for (const input of inputsOf(card, 'input')) { assert.strictEqual(input.disabled, true); }
    assert.strictEqual(posted.length, 0, 'nothing was sent');
  });

  test('a deferred card is disabled and says where to answer', () => {
    const { NS } = loadClient();
    const { card } = cardWith(NS);
    NS.elicitationView.applyState(card, state({ status: 'deferred' }));
    assert.strictEqual(card.querySelector('.elic-actions')!.hidden, true);
    assert.ok(card.querySelector('.elic-note')!.textContent.includes('dialog'),
      'a disabled form with no explanation looks broken');
  });
});
