// [CUSTOM-BEGIN] CUSTOM-20261101-002 - Process-tree cleanup shared by agents and ACP terminals.
import { spawn, type ChildProcess } from 'node:child_process';

export function terminateProcess(child: ChildProcess, force = false): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) { return; }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const fallback = () => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* stopped */ } };
    killer.on('error', fallback);
    killer.on('exit', code => { if (code !== 0) { fallback(); } });
    killer.unref();
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* stopped */ } }
  }
}
// [CUSTOM-END] CUSTOM-20261101-002
