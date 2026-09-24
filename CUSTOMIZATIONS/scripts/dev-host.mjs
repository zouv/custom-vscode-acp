#!/usr/bin/env node
// =============================================================================
// dev-host.mjs — 一条命令启动 Extension Development Host（供手动验收）
//
//   npm run dev:host              # 先编译，再启动宿主窗口
//   npm run dev:host -- --no-build
//   npm run dev:host -- <别的目录>   # 用别的目录当工作区（默认是本仓库）
//
// 为什么用 Node 而不是把命令直接写进 package.json 的 scripts：
//   npm 在 Windows 上默认用 cmd.exe、在 macOS/Linux 上用 sh，`%CD%` 与 `$PWD`
//   互不通用，而 `--extensionDevelopmentPath` 需要**绝对路径**。
//   本仓库已有同类先例：check-registry.mjs 从 bash 移植到 Node 就是为了消除
//   shell 方言差异（见 pitfalls #8）。这里同理。
//
// 与 F5 的区别：本脚本**不附加调试器**（没有断点、不读 launch.json）。
//   手工点击验收用本脚本最快；要断点调试请回仓库窗口按 F5。
// =============================================================================
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const positional = args.filter((a) => !a.startsWith('--'));
const workspace = positional[0] ? resolve(positional[0]) : PROJECT_ROOT;

/**
 * Locate the VS Code CLI. `code` is normally on PATH; the explicit candidates
 * cover a fresh install that was never added to PATH (common on Windows).
 */
function findCodeCli() {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
    }
    candidates.push('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd');
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) { return candidate; }
  }
  // Fall back to PATH resolution; verified below by spawning a --version probe.
  return 'code';
}

/**
 * `shell: true` is required to run `code.cmd` on Windows, but Node does NOT
 * quote the command for us — an install path containing spaces
 * (`C:\Program Files\…`) would be split into separate argv entries.
 */
function shellQuote(command) {
  return /\s/.test(command) ? `"${command}"` : command;
}

function codeWorks(cli) {
  const probe = spawnSync(shellQuote(cli), ['--version'], { shell: true, encoding: 'utf8' });
  return probe.status === 0;
}

if (!skipBuild) {
  console.log('[dev-host] 编译中…（npm run compile）');
  const build = spawnSync('npm', ['run', 'compile'], { cwd: PROJECT_ROOT, shell: true, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('[dev-host] 编译失败，已中止。');
    process.exit(build.status ?? 1);
  }
}

let cli = findCodeCli();
if (!codeWorks(cli)) {
  if (cli !== 'code' && codeWorks('code')) {
    cli = 'code';
  } else {
    console.error(
      '[dev-host] 找不到 VS Code 的 `code` 命令。\n'
      + '  请确认已安装 VS Code，并在命令面板执行一次\n'
      + '  "Shell Command: Install \'code\' command in PATH"，或把 code 的 bin 目录加进 PATH。',
    );
    process.exit(1);
  }
}

const spawnArgs = [
  '--new-window',
  `--extensionDevelopmentPath=${PROJECT_ROOT}`,
  workspace,
];

console.log(`[dev-host] 启动 Extension Development Host\n  扩展路径: ${PROJECT_ROOT}\n  工作区:   ${workspace}`);

// Detached: the host window must outlive this script, so `npm run dev:host` returns
// immediately instead of holding the terminal open.
const child = spawn(shellQuote(cli), spawnArgs, { detached: true, stdio: 'ignore', shell: true });
child.unref();

console.log('[dev-host] 已发出启动请求。窗口出现后：');
console.log('  · 命令面板 → "Developer: Open Webview Developer Tools"（webview 客户端报错只能在这里看到）');
console.log('  · 改了代码后：npm run compile，然后在宿主窗口按 Ctrl+R 重载（不必关掉重开）');
