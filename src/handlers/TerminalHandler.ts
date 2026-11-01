import * as vscode from 'vscode';
import { log, logError } from '../utils/Logger';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

// [CUSTOM-BEGIN] CUSTOM-20261101-002 - Safe argv spawning, synchronous UTF-8 output, session-scoped resources.
import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcess } from '../utils/ProcessLifecycle';
// [CUSTOM-END] CUSTOM-20261101-002

// [CUSTOM-BEGIN] CUSTOM-20261101-002 - Terminal identity includes the owning session and display emitter.
interface ManagedTerminal {
  id: string;
  sessionId: string;
  writeEmitter: vscode.EventEmitter<string>;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal?: vscode.Terminal;
}
// [CUSTOM-END] CUSTOM-20261101-002

/**
 * Manages terminals that ACP agents request (terminal/create, terminal/output, etc.).
 * Uses real child processes for capturing output, with VS Code terminals for display.
 */
export class TerminalHandler {
  private terminals: Map<string, ManagedTerminal> = new Map();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024; // 1MB default

    log(`createTerminal: ${params.command} ${(params.args || []).join(' ')} (id=${terminalId})`);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (params.env) {
      for (const v of params.env) {
        env[v.name] = v.value;
      }
    }

    // [CUSTOM-BEGIN] CUSTOM-20261101-002 - Update the managed state in the data callback, not on a polling timer.
    if (!Number.isSafeInteger(outputByteLimit) || outputByteLimit < 0) {
      throw new Error('outputByteLimit must be a non-negative integer');
    }
    const child = crossSpawn(params.command, params.args || [], {
      cwd: params.cwd || undefined, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const writeEmitter = new vscode.EventEmitter<string>();
    const vsTerminal = vscode.window.createTerminal({
      name: 'ACP: ' + params.command,
      pty: { onDidWrite: writeEmitter.event, open() { writeEmitter.fire('$ ' + params.command + '\r\n'); }, close() { terminateProcess(child, true); } },
    });
    let resolveExit!: () => void;
    const managed: ManagedTerminal = {
      id: terminalId, sessionId: params.sessionId, process: child, output: '', truncated: false,
      outputByteLimit, exitCode: null, exitSignal: null, exited: false,
      exitPromise: new Promise<void>(resolve => { resolveExit = resolve; }), vsTerminal, writeEmitter,
    };
    this.terminals.set(terminalId, managed);
    const append = (text: string) => {
      if (!text) { return; }
      writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
      const bytes = Buffer.from(managed.output + text, 'utf8');
      if (bytes.length <= outputByteLimit) { managed.output += text; return; }
      let start = bytes.length - outputByteLimit;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) { start++; }
      managed.output = bytes.subarray(start).toString('utf8');
      managed.truncated = true;
    };
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    child.stdout?.on('data', (data: Buffer) => append(stdout.write(data)));
    child.stderr?.on('data', (data: Buffer) => append(stderr.write(data)));
    const finish = (code: number | null, signal: string | null) => {
      if (managed.exited) { return; }
      append(stdout.end()); append(stderr.end());
      managed.exitCode = code; managed.exitSignal = signal; managed.exited = true;
      resolveExit();
    };
    child.once('close', finish);
    child.once('error', (error) => { logError('Terminal process failed', error); finish(1, null); });
    // [CUSTOM-END] CUSTOM-20261101-002

    return { terminalId };
  }

  // [CUSTOM-BEGIN] CUSTOM-20260923-012 - 只读访问器：让聊天面板能展示终端输出。
  // ACP 的 `Terminal` 工具内容只是一个引用（{terminalId}），终端归客户端所有、也由客户端渲染。
  // 上游只能通过 `terminalOutput()` 读到内容，但那条路径对未知 id **抛异常**，不适合 UI 调用。
  // [CUSTOM-END] CUSTOM-20260923-012
  /**
   * Read a managed terminal's current state without throwing.
   * Returns `null` when the terminal id is unknown (e.g. already released).
   */
  readOutput(terminalId: string): {
    output: string;
    truncated: boolean;
    exited: boolean;
    exitCode: number | null;
    exitSignal: string | null;
  } | null {
    const managed = this.terminals.get(terminalId);
    if (!managed) { return null; }
    return {
      output: managed.output,
      truncated: managed.truncated,
      exited: managed.exited,
      exitCode: managed.exitCode,
      exitSignal: managed.exitSignal,
    };
  }

  // [CUSTOM-BEGIN] CUSTOM-20261101-002 - Enforce session ownership and clean up process trees/emitters.
  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (managed && managed.sessionId !== params.sessionId) { throw new Error('Terminal belongs to another session'); }
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const response: TerminalOutputResponse = {
      output: managed.output,
      truncated: managed.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (managed && managed.sessionId !== params.sessionId) { throw new Error('Terminal belongs to another session'); }
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await managed.exitPromise;

    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (managed && managed.sessionId !== params.sessionId) { throw new Error('Terminal belongs to another session'); }
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    try {
      terminateProcess(managed.process, true);
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }

    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.terminals.get(params.terminalId);
    if (managed && managed.sessionId !== params.sessionId) { throw new Error('Terminal belongs to another session'); }
    if (!managed) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    log(`releaseTerminal: ${params.terminalId}`);

    // Kill if still running
    if (!managed.exited) {
      try {
        terminateProcess(managed.process, true);
      } catch {
        // ignore
      }
    }

    // Don't dispose VS Code terminal — keep output visible per ACP spec
    managed.writeEmitter.dispose();
    this.terminals.delete(params.terminalId);

    return {};
  }

  dispose(): void {
    for (const [, managed] of this.terminals) {
      try {
        if (!managed.exited) {
          terminateProcess(managed.process, true);
        }
        managed.vsTerminal?.dispose();
        managed.writeEmitter.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
  // [CUSTOM-END] CUSTOM-20261101-002
}
