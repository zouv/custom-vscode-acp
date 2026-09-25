// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 客户端模块装配：按依赖顺序拼接成一个 <script nonce>。
//
// webview 内没有模块系统（CSP 只允许带 nonce 的内联脚本），所以每个模块是一个 IIFE，
// 统一挂到 `window.__acpc` 命名空间下。顺序只影响**加载时**的相互引用；
// 运行时引用（如 NS.bridge 由 boot 提供）不受顺序影响。
// [CUSTOM-END] CUSTOM-20260923-011
import { domClient } from './dom';
import { iconsClient } from './icons';
import { scrollClient } from './scroll';
import { linksClient } from './links';
import { permissionViewClient } from './permissionView';
import { toolCallViewClient } from './toolCallView';
import { transcriptViewClient } from './transcriptView';
import { outlineClient } from './outline';
import { sessionMenuClient } from './sessionMenu';
import { directoryMenuClient } from './directoryMenu';
import { railClient } from './rail';
import { tabsClient } from './tabs';
import { composerClient } from './composer';
import { bootClient } from './boot';

const MODULES: ReadonlyArray<string> = [
  domClient,
  // Record-type icons are used by both transcriptView and toolCallView, so they
  // are registered before either of them.
  iconsClient,
  scrollClient,
  linksClient,
  // Must precede transcriptView: build() dispatches on entry kind at runtime,
  // which only works once every view module has been registered.
  permissionViewClient,
  toolCallViewClient,
  transcriptViewClient,
  outlineClient,
  sessionMenuClient,
  // [CUSTOM-20260925-058] The draft page's directory drawer (same drawer shape
  // as sessionMenu, which is why it sits next to it).
  directoryMenuClient,
  railClient,
  tabsClient,
  composerClient,
  bootClient,
];

/** Concatenate every client module into one nonce'd inline script. */
export function clientScript(nonce: string): string {
  return `<script nonce="${nonce}">\n${MODULES.join('\n')}\n</script>`;
}

/** The concatenated client code, exposed for syntax verification. */
export function clientSource(): string {
  return MODULES.join('\n');
}
