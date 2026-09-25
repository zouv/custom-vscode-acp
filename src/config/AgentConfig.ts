// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acpc');
  const agents = config.get<Record<string, AgentConfigEntry>>('agents', {});
  return agents;
}

/**
 * Get the list of agent names available.
 */
// [CUSTOM-BEGIN] CUSTOM-20260925-030 - 主用 agent 固定在第一位。
// 顺序来自 `acpc.agents` 的键序，而用户自建的配置很容易把 Claude Code 排到后面；
// 这里做一次**稳定**调整：只把主用 agent 提到最前，其余保持原顺序（不做全排序，
// 否则会打乱用户刻意安排的次序）。
// 与 `panelContract.MODERN_AGENTS` 是两件事：那个管「哪些 agent 用新面板」，
// 这个只管「谁排第一」。两者目前取值相同，但改动理由不同，不合并。
const PRIMARY_AGENT = 'Claude Code';

export function getAgentNames(): string[] {
  const names = Object.keys(getAgentConfigs());
  const at = names.indexOf(PRIMARY_AGENT);
  if (at > 0) {
    names.splice(at, 1);
    names.unshift(PRIMARY_AGENT);
  }
  return names;
}
// [CUSTOM-END] CUSTOM-20260925-030

/**
 * Get a specific agent config by name.
 */
export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}
