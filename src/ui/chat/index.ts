// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 新 Chat 面板子系统的 barrel。外部（extension.ts）只依赖这一个入口。
// [CUSTOM-END] CUSTOM-20260923-011
export { ChatRouterProvider } from './ChatRouterProvider';
export { ChatPanelHost } from './ChatPanelHost';
export { LegacyPanelAdapter } from './LegacyPanelAdapter';
export { TranscriptStore } from './transcript/TranscriptStore';
export { ToolInvocationStore } from './transcript/ToolInvocationStore';
export { SafeMarkdown, escapeHtml } from './markdown';
export type { IChatPanel, PanelContext, PanelId } from './panelContract';
