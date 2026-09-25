// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// ToolInvocation → 可序列化视图模型。旧面板对工具调用**完全不渲染详情**（没有 content、
// 没有 diff、没有 terminal、没有 locations），这里把 ACP 能给的都保留下来。
// 注意 ToolKind/ToolCallStatus 用的是 ACP 的真实取值（旧面板的 getStatusIcon 判的是
// 'running'——那是个 ACP 从不发送的字符串，导致 pending/in_progress 都渲染成无色 '…'）。
// [CUSTOM-END] CUSTOM-20260923-011
import type { ToolCallStatus, ToolKind } from '@agentclientprotocol/sdk';

import { toContentView, type ContentBlockView } from './contentBlocks';
import type { ToolInvocation } from '../transcript/types';

/** One entry of a tool call's `content` collection. */
export type ToolContentItem =
  | { type: 'content'; block: ContentBlockView }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string };

export interface ToolLocationView {
  path: string;
  name: string;
  line?: number;
}

/** Serializable view model handed to the webview for one tool call. */
export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  /** Command line, when the raw input carries one (`execute` tools). */
  command: string | null;
  locations: ToolLocationView[];
  items: ToolContentItem[];
  /** Nesting parent, when a NestingStrategy inferred one (Phase 4). */
  parentId?: string;
  inferredParent?: boolean;
}

const DEFAULT_KIND: ToolKind = 'other';
const DEFAULT_STATUS: ToolCallStatus = 'pending';

/** Convert an indexed invocation into the serializable view model. */
export function toToolCallView(inv: ToolInvocation): ToolCallView {
  const view: ToolCallView = {
    toolCallId: inv.toolCallId,
    title: inv.title,
    kind: inv.kind ?? DEFAULT_KIND,
    status: inv.status ?? DEFAULT_STATUS,
    command: extractCommand(inv.rawInput),
    locations: inv.locations.map(l => ({
      path: l.path,
      name: basename(l.path),
      line: typeof l.line === 'number' ? l.line : undefined,
    })),
    items: toToolContentItems(inv.content),
  };
  if (inv.parentId) {
    view.parentId = inv.parentId;
    view.inferredParent = inv.inferredParent;
  }
  return view;
}

function toToolContentItems(content: unknown[]): ToolContentItem[] {
  const items: ToolContentItem[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') { continue; }
    const item = raw as { type?: string; [k: string]: unknown };
    switch (item.type) {
      case 'content': {
        const block = toContentView(item.content as never);
        if (block) { items.push({ type: 'content', block }); }
        break;
      }
      case 'diff': {
        items.push({
          type: 'diff',
          path: String(item.path ?? ''),
          oldText: typeof item.oldText === 'string' ? item.oldText : null,
          newText: typeof item.newText === 'string' ? item.newText : '',
        });
        break;
      }
      case 'terminal':
        items.push({ type: 'terminal', terminalId: String(item.terminalId ?? '') });
        break;
      default:
        break;
    }
  }
  return items;
}

/**
 * Best-effort command extraction. `rawInput` is typed `unknown` and is
 * agent-specific, so this only recognises the obvious `{ command }` shapes.
 */
function extractCommand(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') { return null; }
  const input = rawInput as Record<string, unknown>;
  const direct = input.command ?? input.cmd;
  if (typeof direct === 'string' && direct.length > 0) { return direct; }
  const args = input.args;
  if (Array.isArray(args) && args.every(a => typeof a === 'string')) {
    return args.join(' ');
  }
  return null;
}

// [CUSTOM-20260925-052] The three helpers below have no callers today — the
// client renders the glyphs and labels itself (see the STATUS_GLYPH / KIND_LABEL
// maps at the top of html/client/toolCallView.ts). They are kept rather than
// deleted because they are the HOST-side spelling of the same knowledge, and a
// host-side renderer (a log line, a tree item, a future panel) would want them.
//
// **If you change one, change the other.** Two copies of the same mapping is
// exactly the drift that produced CUSTOM-20260925-038 (a key renamed on one side
// only, updates silently dropped). Collapsing them properly means sending the
// glyph/label from the host in ToolCallView — a protocol change, not this round.

/** Human-readable status glyph. Keyed on the four real `ToolCallStatus` values. */
export function statusGlyph(status: ToolCallStatus): string {
  switch (status) {
    case 'pending': return '◷';
    case 'in_progress': return '◐';
    case 'completed': return '✓';
    case 'failed': return '✗';
    default: return '•';
  }
}

/** CSS class suffix for a status, matching the stylesheet. */
export function statusClass(status: ToolCallStatus): string {
  return `tc-${status}`;
}

/** Human-readable label for a tool kind. */
export function kindLabel(kind: ToolKind): string {
  switch (kind) {
    case 'read': return 'Read';
    case 'edit': return 'Edit';
    case 'delete': return 'Delete';
    case 'move': return 'Move';
    case 'search': return 'Search';
    case 'execute': return 'Run';
    case 'think': return 'Think';
    case 'fetch': return 'Fetch';
    case 'switch_mode': return 'Mode';
    default: return 'Tool';
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
