// [CUSTOM-BEGIN] CUSTOM-20261101-009 - Standard ACP terminal auth runs the configured invocation interactively, not authenticate().
import * as vscode from 'vscode';
import type { AuthMethodTerminal } from '@agentclientprotocol/sdk';
import type { AgentConfigEntry } from '../config/AgentConfig';

/** cmd.exe metacharacter escaping follows cross-spawn's non-shell argv encoding. */
function windowsArgument(value: string, doubleEscape: boolean): string {
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  let escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1');
  escaped = ('"' + escaped + '"').replace(meta, '^$1');
  return doubleEscape ? escaped.replace(meta, '^$1') : escaped;
}

export function terminalAuthOptions(config: AgentConfigEntry, method: AuthMethodTerminal, cwd?: string): vscode.TerminalOptions {
  const args = [...(config.args ?? []), ...(method.args ?? [])];
  const base: vscode.TerminalOptions = { name: 'ACP Login: ' + method.name, cwd, env: { ...config.env, ...method.env }, isTransient: true };
  if (process.platform !== 'win32') { return { ...base, shellPath: config.command, shellArgs: args }; }
  const doubleEscape = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(config.command);
  const batch = /\.(?:cmd|bat)$/i.test(config.command);
  const command = batch ? config.command.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : '"' + config.command + '"';
  return { ...base, shellPath: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', shellArgs: '/d /s /c "' + [command, ...args.map(a => windowsArgument(a, doubleEscape))].join(' ') + '"' };
}

export class TerminalAuthHandler implements vscode.Disposable {
  private pending = new Map<vscode.Terminal, () => void>();
  constructor(private readonly api: Pick<typeof vscode.window, 'createTerminal' | 'onDidCloseTerminal'> = vscode.window) {}

  authenticate(config: AgentConfigEntry, method: AuthMethodTerminal, cwd?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const terminal = this.api.createTerminal(terminalAuthOptions(config, method, cwd));
      const finish = (error?: Error) => {
        listener.dispose(); this.pending.delete(terminal);
        if (error) { reject(error); } else { resolve(); }
      };
      const listener = this.api.onDidCloseTerminal(closed => {
        if (closed !== terminal) { return; }
        const code = terminal.exitStatus?.code;
        finish(code === 0 ? undefined : new Error('Terminal authentication failed or was cancelled (exit code: ' + String(code) + ').'));
      });
      this.pending.set(terminal, () => finish(new Error('Terminal authentication cancelled: client disposed.')));
      try { terminal.show(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); terminal.dispose(); }
    });
  }

  dispose(): void {
    for (const [terminal, cancel] of this.pending) { cancel(); terminal.dispose(); }
    this.pending.clear();
  }
}
// [CUSTOM-END] CUSTOM-20261101-009
