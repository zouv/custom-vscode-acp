// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';
// [CUSTOM-BEGIN] CUSTOM-20260928-095 - Opt-in serialized logging in the VS Code per-window extension log directory.
import { BoundedLogWriter } from './BoundedLogWriter';
// [CUSTOM-END] CUSTOM-20260928-095

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

// [CUSTOM-BEGIN] CUSTOM-20260928-095 - BoundedLogWriter rotates continuously; persistLogs defaults to false.
let writer: BoundedLogWriter | undefined;

export function initLogger(logUri: vscode.Uri): void {
  writer = new BoundedLogWriter(vscode.Uri.joinPath(logUri, 'acpc.log').fsPath);
}

function persistLog(line: string): void {
  if (vscode.workspace.getConfiguration('acpc').get<boolean>('persistLogs', false)) { writer?.append(line); }
}
// [CUSTOM-END] CUSTOM-20260928-095

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client (Custom)');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic (Custom)');
  }
  return _trafficChannel;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
  // [CUSTOM-20260928-095] Persist only when the user explicitly enables persistLogs.
  persistLog(formatted);
}

// [CUSTOM-BEGIN] CUSTOM-20261101-005 - Persist errors and stacks only with explicit opt-in.
export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  const line = `[${timestamp}] ERROR: ${message} ${errMsg}`;
  getOutputChannel().appendLine(line);
  persistLog(line);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
    persistLog(error.stack);
  }
}

// [CUSTOM-END] CUSTOM-20261101-005

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acpc');
  if (!config.get<boolean>('logTraffic', false)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type
  const msg = data as Record<string, unknown> | null;
  let label = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
    } else if ('method' in msg && !('id' in msg)) {
      label = ` [NOTIFICATION] ${msg.method}`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
    }
  }

  const text = `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`;
  getTrafficChannel().appendLine(text);
  // [CUSTOM-20260929-118] Full traffic is sensitive; persistence requires BOTH logTraffic and persistLogs.
  persistLog(text);
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
