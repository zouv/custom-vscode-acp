// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 客户端模块装配：按依赖顺序拼接成一个 <script nonce>。
//
// webview 内没有模块系统（CSP 只允许带 nonce 的内联脚本），所以每个模块是一个 IIFE，
// 统一挂到 `window.__acpc` 命名空间下。顺序只影响**加载时**的相互引用；
// 运行时引用（如 NS.bridge 由 boot 提供）不受顺序影响。
// [CUSTOM-END] CUSTOM-20260923-011
import { domClient } from './dom';
import { scrollClient } from './scroll';
import { linksClient } from './links';
import { toolCallViewClient } from './toolCallView';
import { transcriptViewClient } from './transcriptView';
import { tabsClient } from './tabs';
import { composerClient } from './composer';
import { bootClient } from './boot';

const MODULES: ReadonlyArray<string> = [
  domClient,
  scrollClient,
  linksClient,
  toolCallViewClient,
  transcriptViewClient,
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
