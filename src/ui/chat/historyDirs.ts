// [CUSTOM-BEGIN] CUSTOM-20260926-079 - 历史选择器的目录过滤：路径归一化与候选目录（新增文件）。
//
// 为什么是纯函数（与 `SessionManager.pickDefaultCwd`、`sessionChoices.ts` 同一个理由）：
// **可测**。真正会出错的是"两个路径算不算同一个目录"与"候选怎么去重/排序"，
// 它们在编排器（`ChatPanelHost.handleListHistory`）里没法单测。
//
// 为什么不让客户端自己做：平台信息只有宿主有（见 directoryKey 的大小写规则），
// 客户端只比较宿主算好的 key —— 于是"同一目录的不同写法"这件事只有一个地方需要想清楚。
// [CUSTOM-END] CUSTOM-20260926-079

/** One working directory offered by the history picker's filter. */
export interface HistoryDirOption {
  /** Normalized identity (see {@link directoryKey}). The client compares ONLY this. */
  key: string;
  /** The path as first seen, for display and for the chip tooltip. */
  cwd: string;
  /** Last path segment. */
  name: string;
  /**
   * [CUSTOM-20260926-079] What the menu actually SHOWS: `name`, unless two candidates
   * share a basename — two checkouts of one repository, which is the normal case
   * ("UniverseEditor" appeared twice in the first real list) — in which case it grows
   * leftwards until it is unique ("git/UniverseEditor" vs "zdev/UniverseEditor").
   * A menu of two identical labels cannot be used to pick between them.
   */
  label: string;
  /** How many of the listed sessions live here. */
  count: number;
  /** True for the directory the filter defaults to (the current session's). */
  current: boolean;
}

/**
 * Identity of a working directory: what must be equal for two spellings to mean the
 * same folder.
 *
 * Three normalization steps, and **deliberately no `node:path`**: `path.normalize`
 * behaves differently on every platform (and on win32 would also collapse `\\?\`
 * prefixes and relative segments), which would make both the behavior and its test
 * environment-dependent. String operations give one answer everywhere, and the
 * platform only enters through the case rule below.
 *
 * The case rule is a property of the PLATFORM, not of the string: on Windows and
 * macOS the same folder is routinely spelled `D:\Git\x` and `d:\git\x`, while on
 * Linux `/Home` and `/home` are two different directories.
 */
export function directoryKey(cwd: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (typeof cwd !== 'string') { return undefined; }
  const trimmed = cwd.trim();
  if (trimmed.length === 0) { return undefined; }
  // A trailing separator is noise ("D:\x\" is "D:\x"). The regex leaves a LONE "/"
  // alone (nothing precedes the slashes), so the POSIX root survives as "/", while a
  // drive root collapses to "c:" — which is what makes "C:\", "C:" and "C:/" one
  // identity instead of three candidates for the same folder.
  const slashed = trimmed.replace(/\\/g, '/').replace(/([^/])\/+$/, '$1');
  return platform === 'linux' ? slashed : slashed.toLowerCase();
}

/** Last path segment ("D:\Git\x\" → "x"). Trailing separators are ignored. */
export function folderName(path: string): string {
  const trimmed = String(path ?? '').replace(/[\\/]+$/, '');
  if (trimmed.length === 0) { return ''; }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * The directories worth offering as filters, derived from the list being filtered.
 *
 * Only directories that actually APPEAR in the list (plus the current one) become
 * candidates: filtering by a folder with no sessions in it can only ever show an
 * empty list, so browsing to an arbitrary directory would be a dead end.
 *
 * The current directory is kept even at count 0 — the filter defaults to it, and a
 * default that is not on the menu would look like a broken control.
 *
 * Order: current first, then by session count, then by name.
 */
export function directoryOptions(
  rows: ReadonlyArray<{ cwd?: string }>,
  currentCwd?: string,
  platform: NodeJS.Platform = process.platform,
): HistoryDirOption[] {
  const byKey = new Map<string, Omit<HistoryDirOption, 'label'>>();
  for (const row of rows) {
    const key = directoryKey(row.cwd, platform);
    // A session whose directory the agent never reported has nothing to filter by.
    if (!key) { continue; }
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const cwd = String(row.cwd);
    byKey.set(key, { key, cwd, name: folderName(cwd), count: 1, current: false });
  }
  const currentKey = directoryKey(currentCwd, platform);
  if (currentKey) {
    const existing = byKey.get(currentKey);
    if (existing) {
      existing.current = true;
    } else {
      const cwd = String(currentCwd);
      byKey.set(currentKey, { key: currentKey, cwd, name: folderName(cwd), count: 0, current: true });
    }
  }
  // [CUSTOM-20260930-142] 按名称的字母序（用户要求"目录列表排下序"）。原来是
  // current 优先 → 会话数降序 → 名称，前两个键把字母序盖住了，看起来就像"没排序"。
  // 当前目录仍然带 current 标记（客户端据此高亮它），只是不再置顶 —— 字母序是用户要的。
  // 次键用 cwd：label 是下面才生成的（去重后的显示名），这里还拿不到。
  const ordered = Array.from(byKey.values()).sort((a, b) =>
    a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
  // Labels last: uniqueness is a property of the whole set, not of one entry.
  return ordered.map(option => ({ ...option, label: uniqueLabel(option, ordered) }));
}

function pathSegments(cwd: string): string[] {
  const trimmed = String(cwd ?? '').replace(/[\\/]+$/, '');
  return trimmed.length === 0 ? [] : trimmed.split(/[\\/]/);
}

function tailLabel(cwd: string, take: number): string {
  return pathSegments(cwd).slice(-take).join('/');
}

/**
 * The shortest right-hand slice of this path that no OTHER candidate shares, so two
 * folders with the same basename are still distinguishable. Falls back to the whole
 * path (two candidates that are literally the same string cannot be told apart — and
 * cannot exist either, since they would share a key).
 */
function uniqueLabel(option: Omit<HistoryDirOption, 'label'>, all: ReadonlyArray<Omit<HistoryDirOption, 'label'>>): string {
  const depth = pathSegments(option.cwd).length;
  for (let take = 1; take <= depth; take++) {
    const label = tailLabel(option.cwd, take);
    if (!all.some(other => other !== option && tailLabel(other.cwd, take) === label)) { return label; }
  }
  return option.cwd;
}
