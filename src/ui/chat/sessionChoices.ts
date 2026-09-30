// [CUSTOM-BEGIN] CUSTOM-20260926-073 - 会话级「切换」提示（模型 / 模式 / 配置项）：新增文件。
//
// 背景：面板里切了模型或模式之后，transcript 里不留任何痕迹（宿主只 pushMeta），
// 读者回看时不知道从哪一句起换的模型。Claude 官方插件在切换处插一条分隔式提示，
// 这里做同一件事。
//
// 为什么把「取快照」和「算差异」放在这个文件里（纯函数）而不是直接写进 ChatPanelHost：
//   · 差异判定的分支（谁是先到的那条、同一改动来了两次要不要重复提示、级联变更怎么表述）
//     是这块逻辑里唯一会出错的部分，而它在编排器里没法单测；
//   · 抽成纯函数后可以用真实载荷直接钉住（见 src/test/chat-panel.test.ts）。
// 宿主只负责**缓存**与**发帖**（见 ChatPanelHost.syncChoices）。
// [CUSTOM-END] CUSTOM-20260926-073
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';

/** One config option's current selection, in display-ready form. */
export interface ChoiceValue {
  /** The option's own label, e.g. "Model" (agent-supplied). */
  name: string;
  /** ACP `category`: 'mode' / 'model' / 'thought_level' / anything else. */
  category: string;
  /** The raw selected value id. */
  value: string;
  /** The selected choice's label, falling back to its raw value. */
  valueName: string;
}

/**
 * A session's switchable state. Kept as a flat, serializable shape so a diff is a
 * plain comparison — and so a *notification payload* (which carries either the
 * full config-option list or just a mode id) can patch it without a round trip to
 * SessionManager. That matters: the two paths (our own setter vs. an agent-pushed
 * `*_update`) race against SessionManager's listener order, but they cannot race
 * against a snapshot we own.
 */
export interface ChoiceSnapshot {
  /** modeId -> display name, so an id-only update can still be labelled. */
  modes: Record<string, string>;
  modeId?: string;
  options: Record<string, ChoiceValue>;
}

// [CUSTOM-BEGIN] CUSTOM-20260930-128 - 模式在两个通道之间收敛。
//
// `session.modes.currentModeId` 与 `configOptions[category='mode'].currentValue` 是**同一事实的
// 两份副本**，而它们**不会同时被写**：`SessionManager.setMode` 在 configOptions 存在时提前
// return（Claude Code 正是这种），而 `current_mode_update` 也从不落到 SessionManager。
// 于是宿主的两条上报路径各自只看到一半：
//   · 通知路径（用 payload patch）拿到新 modeId，却留着**旧的** mode option；
//   · setter 路径（读 SessionManager）拿到新 mode option，却读到**冻结**的 currentModeId。
// 两份快照永不相等 ⇒ "先到的那条提示、后到的那条 diff 为空"这个去重前提失效 ⇒ 同一次切换
// 被报两次，且第二条是现实中不存在的混合态（实测："Manual mode · Bypass permissions mode"）。
//
// 修法是**让 config option 成为权威**（Claude Code 用它表达模式）：快照里的 modeId 由它派生；
// 收到只带 modeId 的 payload 时把新值写回那份副本。这样两条路径给出同一个快照。
// [CUSTOM-END] CUSTOM-20260930-128

/** The option that carries the mode, when the agent exposes one. */
function modeOptionKey(options: Record<string, ChoiceValue>): string | undefined {
  for (const id of Object.keys(options)) {
    if (options[id].category === 'mode') { return id; }
  }
  return undefined;
}

/** That option's current value, or undefined when there is no mode option. */
function modeOptionValue(options: Record<string, ChoiceValue>): string | undefined {
  const key = modeOptionKey(options);
  if (!key) { return undefined; }
  const value = options[key].value;
  return value === '' ? undefined : value;
}

/**
 * Snapshot from the live session state (post-change, after a setter resolves).
 *
 * [CUSTOM-20260930-128] `modeId` is derived from the config option when there is one:
 * `modes.currentModeId` is the copy that goes stale (see the block at the top of file).
 */
export function choiceSnapshotFromState(
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[] | null | undefined,
): ChoiceSnapshot {
  const names: Record<string, string> = {};
  for (const mode of modes?.availableModes ?? []) {
    names[String(mode.id)] = String(mode.name ?? mode.id);
  }
  const options = snapshotOptions(configOptions);
  return {
    modes: names,
    modeId: modeOptionValue(options)
      ?? (modes?.currentModeId === undefined ? undefined : String(modes.currentModeId)),
    options,
  };
}

/** Snapshot after applying a `config_option_update` / `current_mode_update` payload. */
export function choiceSnapshotPatched(
  previous: ChoiceSnapshot,
  patch: { modeId?: string | null; configOptions?: SessionConfigOption[] | null },
): ChoiceSnapshot {
  const options = patch.configOptions === undefined || patch.configOptions === null
    ? { ...previous.options }
    : snapshotOptions(patch.configOptions);
  const fromPayload = patch.modeId === undefined || patch.modeId === null ? undefined : String(patch.modeId);
  let modeId: string | undefined;
  if (fromPayload !== undefined) {
    modeId = fromPayload;
    // [CUSTOM-20260930-128] A mode payload carries no option list, so the mode option would
    // keep its OLD value and the two copies would disagree. Write it through: the next
    // setter-path snapshot reads the option, and both paths must agree for the diff to
    // come out empty.
    const key = modeOptionKey(options);
    if (key) {
      options[key] = { ...options[key], value: modeId, valueName: previous.modes[modeId] ?? modeId };
    }
  } else {
    modeId = modeOptionValue(options) ?? previous.modeId;
  }
  return {
    // A mode payload carries no name: the names map from the previous snapshot is
    // still the best thing we have (the mode list itself rarely changes).
    modes: previous.modes,
    modeId,
    options,
  };
}

/**
 * Human-readable labels for everything that moved between two KNOWN states, in a
 * stable order (mode first, then options). Empty when nothing moved — which is what
 * makes a change announced by our setter *not* announced again when the agent's own
 * notification for the same change arrives right after.
 *
 * A value that appears where there was none is NOT a switch, it is initialization:
 * the first snapshot of a session is empty (SessionManager has nothing yet), and the
 * option list usually lands a moment later. Announcing that would print a line full
 * of "Model: X · Mode: Y · …" for every session — see the baseline rule in
 * ChatPanelHost.syncChoices.
 */
export function choiceChanges(before: ChoiceSnapshot, after: ChoiceSnapshot): string[] {
  const out: string[] = [];
  if (after.modeId !== undefined && before.modeId !== undefined && after.modeId !== before.modeId) {
    out.push(`Switched to ${after.modes[after.modeId] ?? after.modeId} mode`);
  }
  const ids = Array.from(new Set([...Object.keys(before.options), ...Object.keys(after.options)]));
  // The PRIMARY fact goes first: a model switch often cascades (the agent adjusts
  // e.g. its reasoning effort in the same response), and the reader should see
  // "Switched to Sonnet" before the knock-on setting. Ties break on id, so the
  // order is stable rather than incidental.
  ids.sort((a, b) => rank(after.options[a] ?? before.options[a]) - rank(after.options[b] ?? before.options[b])
    || a.localeCompare(b));
  for (const id of ids) {
    const was = before.options[id];
    const now = after.options[id];
    // Known before (not initialization) and actually different.
    if (!was || !now || was.value === now.value) { continue; }
    // [CUSTOM-20260930-128] The mode option is skipped here: it is the same fact as
    // `modeId` above, which is where the line comes from. Reporting it twice would print
    // "Switched to Plan mode · Switched to Plan mode" for one switch.
    if (now.category === 'mode') { continue; }
    out.push(describeChange(now));
  }
  return out;
}

/** Display priority: mode, then model, then everything else. */
function rank(value: ChoiceValue | undefined): number {
  if (value?.category === 'mode') { return 0; }
  if (value?.category === 'model') { return 1; }
  return 2;
}

/** One option's change, in the reader's terms. */
function describeChange(now: ChoiceValue): string {
  const label = now.valueName || now.value;
  // The model case is spelled like the reference implementation ("Switched to
  // deepseek-v4-pro[1M]"), and a bare model name is unambiguous.
  if (now.category === 'model') { return `Switched to ${label}`; }
  // [CUSTOM-20260930-128] A `category === 'mode'` option no longer reaches here: it is
  // the same fact as `modeId`, announced once by choiceChanges' first branch. (The old
  // wording — "a mode is a mode whether it arrived as session.modes or as a config
  // option" — described two channels for one fact, which is exactly what made the
  // switch get announced twice.)
  // Anything else (thought_level, …): naming the option is the only way the line
  // means something — "Switched to High" alone would be a riddle.
  return `${now.name}: ${label}`;
}

function snapshotOptions(configOptions: SessionConfigOption[] | null | undefined): Record<string, ChoiceValue> {
  const out: Record<string, ChoiceValue> = {};
  for (const option of configOptions ?? []) {
    const raw = option as { currentValue?: unknown; options?: unknown; category?: unknown; name?: unknown };
    const value = raw.currentValue === undefined || raw.currentValue === null ? '' : String(raw.currentValue);
    out[String(option.id)] = {
      name: String(raw.name ?? option.id),
      category: String(raw.category ?? ''),
      value,
      valueName: valueNameOf(raw.options, value),
    };
  }
  return out;
}

/**
 * The label of the currently selected choice. ACP nests select options one level
 * (groups) or not at all, and the payload is typed as a union, so both shapes are
 * walked here rather than being narrowed at every call site.
 */
function valueNameOf(options: unknown, value: string): string {
  if (!Array.isArray(options)) { return value; }
  for (const entry of options as Array<{ options?: unknown; value?: unknown; name?: unknown }>) {
    if (Array.isArray(entry.options)) {
      const inner = valueNameOf(entry.options, value);
      // `valueNameOf` returns the value itself when it cannot find it, so a hit is
      // "something other than the raw value came back".
      if (inner !== value) { return inner; }
      continue;
    }
    if (String(entry.value ?? '') === value) { return String(entry.name ?? value); }
  }
  return value;
}
