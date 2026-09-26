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
import { toolCallViewClient } from '../ui/chat/html/client/toolCallView';
import { transcriptViewClient } from '../ui/chat/html/client/transcriptView';
import { outlineClient } from '../ui/chat/html/client/outline';

// --- 最小桩 DOM -------------------------------------------------------------
// Only what the exercised paths touch. Deliberately NOT a general DOM: a fuller
// stub invites tests that assert on things the real browser would do differently.

class StubNode {
  nodeType = 1;
  className = '';
  hidden = false;
  disabled = false;
  title = '';
  style: Record<string, string> = {};
  childNodes: StubNode[] = [];
  attributes: Record<string, string> = {};
  parentNode: StubNode | null = null;
  readonly tagName: string;
  /** [CUSTOM-20260926-071] What getBoundingClientRect answers. 0 = "no layout". */
  rectHeight = 0;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  getBoundingClientRect(): { height: number } { return { height: this.rectHeight }; }

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

  addEventListener(): void { /* 本套件不驱动事件 */ }

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
function loadClient(): Record<string, any> {
  // The layout model the stub Range answers with; tests may change it (e.g. to make
  // a 200-character message fit on one line).
  const metrics = { charsPerLine: 20 };
  const win: Record<string, any> = {
    __acpc: {},
    requestAnimationFrame: () => 0,
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
    getElementById: () => null,
    addEventListener: () => {},
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
  const NS: Record<string, any> = {
    dom: {},
    scroll: { follow: () => {}, remember: () => {}, restore: () => {}, reassert: () => {} },
    outline: { invalidate: () => {}, close: () => {} },
    // Mirrors the real contract: transcriptView tells the rail about every node it
    // mounts (CUSTOM-20260926-070) and asks it to drop them on reset.
    rail: { invalidate: () => {}, reflow: () => {}, watch: () => {}, resetNodes: () => {} },
    boot: { requestMarkdown: () => {}, persistUi: () => {}, recallUi: () => ({}) },
    bridge: { post: () => {}, postForSession: () => {} },
  };
  win.__acpc = NS;
  for (const source of [domClient, iconsClient, linksClient, toolCallViewClient, transcriptViewClient, outlineClient]) {
    new Function('window', 'document', source)(win, doc);
  }
  return { NS, metrics, doc };
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
  test('a single-line user message gets no fold affordance', () => {
    const { NS } = loadClient();
    const { isFold } = shapeOf(NS, { id: 'u1', kind: 'user', at: Date.now(), text: '跑全部闸门。' });
    assert.strictEqual(isFold, false, 'nothing to fold in a one-line message');
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

  test('a message that fits on ONE line is not folded, however long it is', () => {
    const { NS, metrics } = loadClient();
    // The mirror image of the case above: the measurement wins over the character
    // count in BOTH directions. 200 characters that fit on a single line (a very
    // wide editor panel) must not grow a fold triangle.
    metrics.charsPerLine = 400;
    const text = 'x'.repeat(200);
    const { isFold } = shapeOf(NS, { id: 'u4', kind: 'user', at: Date.now(), text });
    assert.strictEqual(isFold, false, 'the old length>160 proxy folded this; layout says it is one line');
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
    // measurement: the message now fits on one line, so the fold has to GO AWAY.
    // This is the half a one-way implementation would get wrong.
    (doc as Record<string, unknown>).createRange = () => makeRange({ charsPerLine: 400 });
    record.rectHeight = 40;
    NS.transcriptView.resolvePendingFolds();
    assert.strictEqual(record.querySelector('details.user-fold'), null, 're-decided: one line, no fold');
    assert.strictEqual(record.getAttribute('data-fold'), 'done', 'and the answer is final now');
    assert.strictEqual((record.querySelector('.bubble') as StubNode).textContent, text);
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

  test('label truncates to 80 chars with an ellipsis', () => {
    const { NS } = loadClient();
    const drawer = renderOutline(NS, [{ id: 'u1', kind: 'user', at: 1000, text: 'x'.repeat(200) }]);
    const row = drawer.querySelector('.outline-item')!;
    const label = row.querySelector('.outline-text')!.textContent;
    assert.ok(label.length <= 81, `truncated label (got ${label.length} chars)`);
    assert.ok(label.endsWith('…'), 'ends with an ellipsis');
  });
});
