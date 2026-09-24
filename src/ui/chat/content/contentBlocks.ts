// [CUSTOM-BEGIN] CUSTOM-20260923-011 - 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// ContentBlock → 可序列化视图模型。旧面板只读 `.text`，把 image / audio / resource_link /
// resource 全部静默丢弃；这里保留全部 5 种类型，交给 webview 分别渲染。
// [CUSTOM-END] CUSTOM-20260923-011
import type { ContentBlock } from '@agentclientprotocol/sdk';

/** Serializable rendering of an ACP {@link ContentBlock}. */
export type ContentBlockView =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataUri: string; name: string }
  | { type: 'audio'; mimeType: string; name: string; byteLength: number }
  | { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; byteLength?: number };

/** Convert one ACP content block into its view model. */
export function toContentView(block: ContentBlock | null | undefined): ContentBlockView | null {
  if (!block) { return null; }
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image':
      return {
        type: 'image',
        mimeType: block.mimeType,
        // Data URI so the webview can render it with `img-src ... data:` in the
        // CSP, without any network access.
        dataUri: `data:${block.mimeType};base64,${block.data}`,
        name: block.uri ? basename(block.uri) : 'image',
      };

    case 'audio':
      return {
        type: 'audio',
        mimeType: block.mimeType,
        name: 'audio',
        byteLength: Math.floor((block.data?.length ?? 0) * 0.75),
      };

    case 'resource_link':
      return {
        type: 'resource_link',
        uri: block.uri,
        name: block.name,
        title: block.title ?? undefined,
        description: block.description ?? undefined,
        mimeType: block.mimeType ?? undefined,
      };

    case 'resource': {
      const resource = block.resource as { uri?: string; mimeType?: string | null; text?: string; blob?: string };
      const hasText = typeof resource.text === 'string';
      return {
        type: 'resource',
        uri: resource.uri ?? '',
        mimeType: resource.mimeType ?? undefined,
        text: hasText ? resource.text : undefined,
        byteLength: hasText ? undefined : Math.floor((resource.blob?.length ?? 0) * 0.75),
      };
    }

    default:
      return null;
  }
}

/** Convert a list of content blocks, dropping anything unrecognised. */
export function toContentViews(blocks: ReadonlyArray<ContentBlock | null | undefined> | null | undefined): ContentBlockView[] {
  if (!blocks) { return []; }
  const out: ContentBlockView[] = [];
  for (const block of blocks) {
    const view = toContentView(block);
    if (view) { out.push(view); }
  }
  return out;
}

/** Extract the plain text of a block list (used for transcripts and prompts). */
export function textOfBlocks(blocks: ReadonlyArray<ContentBlock | null | undefined> | null | undefined): string {
  if (!blocks) { return ''; }
  return blocks
    .map(b => (b && b.type === 'text' ? b.text : ''))
    .join('');
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
