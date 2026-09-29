// [CUSTOM-BEGIN] CUSTOM-20260923-001 - 全局命名空间重命名 acp.* → acpc.*：本文件内的命令 id / 视图 id / 配置键 / 输出通道名已改名。
// 上游合并后，若本文件出现新的 acp.* 引用，需按 CUSTOMIZATIONS/docs/pitfalls.md 重新应用重命名。
// [CUSTOM-END] CUSTOM-20260923-001
import * as vscode from 'vscode';
// [CUSTOM-BEGIN] CUSTOM-20260928-095 - 日志落盘：log() 除写输出通道外，异步追加写到
// ~/.claude/acp-client-custom.log，让 AI 排查时能直接读文件而不必用户手动贴日志。
import { appendFile, statSync, truncateSync } from 'node:fs';
// [CUSTOM-END] CUSTOM-20260928-095

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

// [CUSTOM-BEGIN] CUSTOM-20260928-095 - 落盘文件缓存（惰性求值 + 首次使用时截断超 5MB 的文件）。
let _logFile: string | undefined;
let _logFileReady = false;

/** 落盘一行日志到 ~/.claude/acp-client-custom.log（异步，失败静默）。 */
function persistLog(line: string): void {
  if (!_logFileReady) {
    _logFileReady = true;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (home) {
      const file = `${home}/.claude/acp-client-custom.log`;
      try {
        if (statSync(file).size > 5 * 1024 * 1024) { truncateSync(file, 0); }
      } catch { /* 文件不存在，忽略 */ }
      _logFile = file;
    }
  }
  if (_logFile) {
    appendFile(_logFile, `${line}\n`, () => { /* 忽略写入错误 */ });
  }
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
  // [CUSTOM-20260928-095] 落盘，供 AI 直接读文件排查。
  persistLog(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acpc');
  if (!config.get<boolean>('logTraffic', true)) {
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
  // [CUSTOM-20260929-118] 协议流也落盘。095 那次的目的是"让 AI 排查时能直接读日志文件
  // 而不必用户手动贴"——而协议流恰恰是排查里最值钱的一份（"这句载荷到底长什么样"），
  // 却一直只进输出通道。代价是文件长得快：persistLog 的 5MB 上限会截断它，够用。
  persistLog(text);
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
