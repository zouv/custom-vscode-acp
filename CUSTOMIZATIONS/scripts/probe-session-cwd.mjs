#!/usr/bin/env node
// [CUSTOM-BEGIN] CUSTOM-20260925-056 - 探针：agent 适配器是否遵守**会话级** cwd。
//
// **这是一个 make-or-break 的可行性闸门**，在写任何产品代码之前先跑它。
//
// 背景：ACP 把「会话的工作目录」定义成会话级属性——
// `NewSessionRequest.cwd` 的原文是 "The working directory for this session"，
// 与**进程**的 cwd 无关。但本扩展是 `spawnAgent(name, config, workspaceCwd)`，
// 进程被 spawn 在工作区。于是有两种可能：
//   · 适配器只看 `session/new` 的 cwd  ⇒ 每会话一个目录**只是改一条链**；
//   · 适配器沿用进程 cwd（或两者混用）⇒ 必须**按 (agent, cwd) 分进程**，工作量差一个量级。
//
// 探针做法（非对称设计，一次就够）：
//   · 建两个临时目录 A（进程 cwd）与 B（会话 cwd），各放一份**同名不同内容**的
//     `which-dir.txt`，以及一个**只在一边存在**的文件；
//   · 用 cwd=A 拉起 agent，再 `session/new({cwd: B})`；
//   · 让 agent ① 跑 `pwd` + `ls -1`，② 用读文件工具读**相对路径** `which-dir.txt`；
//   · 产物里出现的**标记字符串**只会来自输出，因此判定是机械的：
//       - `only-in-session.txt` / `MARKER=SESSION-DIR` ⇒ 走的是 B（遵守会话 cwd）
//       - `only-in-process.txt` / `MARKER=PROCESS-DIR` ⇒ 走的是 A（沿用进程 cwd）
//   · 同时记录**每一个客户端方法调用**（`fs/read_text_file`、`terminal/create`…），
//     因为若适配器把命令委托给客户端的 terminal 能力，那"shell 在哪跑"其实由我们决定——
//     那样的话测试就必须看 `terminal/create` 的 `cwd` 参数，而不是看 agent 的措辞。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/probe-session-cwd.mjs --out src/test/fixtures/session-cwd-probe.json
//
// **它会真的拉起 agent、花额度、并在该 agent 的会话历史里留下一个新会话。**
// 自动批准所有权限请求（否则会卡在等人点按钮）。**在一次性临时目录里跑，绝不在仓库内跑。**
// [CUSTOM-END] CUSTOM-20260925-056
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const outPath = resolve(argOf('--out', 'src/test/fixtures/session-cwd-probe.json'));
const agentCommand = argOf('--agent', 'npx @agentclientprotocol/claude-agent-acp@latest');
const timeoutMs = Number(argOf('--timeout', '300000'));
const keepDirs = argv.includes('--keep');

const MARKER_PROCESS = 'MARKER=PROCESS-DIR';
const MARKER_SESSION = 'MARKER=SESSION-DIR';
const ONLY_PROCESS = 'only-in-process.txt';
const ONLY_SESSION = 'only-in-session.txt';

// --- 两个一次性目录：A=进程 cwd，B=会话 cwd ---------------------------------
const stamp = `${Date.now()}`;
const procDir = mkdtempSync(join(tmpdir(), `acp-cwd-probe-${stamp}-proc-`));
const sessDir = mkdtempSync(join(tmpdir(), `acp-cwd-probe-${stamp}-sess-`));
writeFileSync(join(procDir, 'which-dir.txt'), `${MARKER_PROCESS}\n`);
writeFileSync(join(procDir, ONLY_PROCESS), 'process side only\n');
writeFileSync(join(sessDir, 'which-dir.txt'), `${MARKER_SESSION}\n`);
writeFileSync(join(sessDir, ONLY_SESSION), 'session side only\n');

const prompt = [
  'Do exactly these three things and report their RAW output, no commentary:',
  '1. Run the shell command `pwd` and print its exact output after "PWD:".',
  '2. Run the shell command `ls -1` and print its exact output after "LS:".',
  '3. Read the file at the RELATIVE path `which-dir.txt` and print its exact contents after "READ:".',
].join('\n');

// --- 记录 ----------------------------------------------------------------
const notifications = [];
const clientCalls = [];
const notes = [];
let child;

const kill = proc => { try { proc.kill(); } catch { /* gone */ } };

const terminals = new Map();
let terminalSeq = 0;

const client = {
  async sessionUpdate(params) {
    notifications.push({ at: Date.now(), update: params });
  },
  async requestPermission(params) {
    const options = params.options ?? [];
    const allow = options.find(o => String(o.kind ?? '').startsWith('allow')) ?? options[0];
    notes.push(`permission: ${params.toolCall?.title ?? '(none)'} -> ${allow?.optionId ?? 'cancelled'}`);
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  },
  async readTextFile(params) {
    // 关键记录：适配器若自己做相对路径解析，它传进来的应当已是绝对路径。
    clientCalls.push({ method: 'fs/read_text_file', params });
    const { readFileSync } = await import('node:fs');
    return { content: readFileSync(params.path, 'utf8') };
  },
  async writeTextFile(params) {
    clientCalls.push({ method: 'fs/write_text_file', params });
    const { writeFileSync: wf } = await import('node:fs');
    wf(params.path, params.content ?? '');
    return {};
  },
  async createTerminal(params) {
    // 关键记录：若适配器委托命令执行，`params.cwd` 就是它对("命令该在哪跑")的声明。
    clientCalls.push({ method: 'terminal/create', params });
    const id = `t${++terminalSeq}`;
    const proc = spawn(params.command, params.args ?? [], {
      // 刻意**不**回退到 procDir：让"适配器没给 cwd"这件事显式暴露出来。
      cwd: params.cwd || undefined,
      env: { ...process.env, ...Object.fromEntries((params.env ?? []).map(v => [v.name, v.value])) },
      shell: true,
    });
    const state = { proc, output: '', exitCode: null, signal: null, waiters: [] };
    const append = d => { if (state.output.length < 200_000) { state.output += d.toString(); } };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('exit', (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      for (const w of state.waiters) { w(); }
      state.waiters.length = 0;
    });
    terminals.set(id, state);
    return { terminalId: id };
  },
  async terminalOutput(params) {
    clientCalls.push({ method: 'terminal/output', params });
    const t = terminals.get(params.terminalId);
    if (!t) { throw new Error(`unknown terminal ${params.terminalId}`); }
    return { output: t.output, truncated: false };
  },
  async waitForTerminalExit(params) {
    clientCalls.push({ method: 'terminal/wait_for_exit', params });
    const t = terminals.get(params.terminalId);
    if (!t) { throw new Error(`unknown terminal ${params.terminalId}`); }
    if (t.exitCode === null && t.signal === null) { await new Promise(r => t.waiters.push(r)); }
    return { exitCode: t.exitCode, signal: t.signal };
  },
  async killTerminal(params) {
    clientCalls.push({ method: 'terminal/kill', params });
    const t = terminals.get(params.terminalId);
    if (t) { kill(t.proc); }
    return {};
  },
  async releaseTerminal(params) {
    clientCalls.push({ method: 'terminal/release', params });
    return {};
  },
  async extMethod(method, params) {
    clientCalls.push({ method: `ext/${method}`, params });
    return {};
  },
  async extNotification(method, params) {
    clientCalls.push({ method: `ext-notify/${method}`, params });
    return {};
  },
};

// --- 主流程 --------------------------------------------------------------
async function main() {
  process.stderr.write(`probe: process cwd = ${procDir}\nprobe: session cwd = ${sessDir}\n`);
  child = spawn(agentCommand, {
    cwd: procDir,                  // ← 进程 cwd = A
    env: process.env,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[agent stderr] ${d}`));

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vscode-acp-client', version: 'cwd-probe' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });

  const created = await connection.newSession({ cwd: sessDir, mcpServers: [] });   // ← 会话 cwd = B
  const sessionId = created.sessionId;
  process.stderr.write(`probe: session=${sessionId}\n`);

  const response = await connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] });
  process.stderr.write(`probe: stopReason=${response.stopReason}\n`);

  return { init, sessionId, response };
}

const timer = new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
});

let result = null;
let failure = null;
try {
  result = await Promise.race([main(), timer]);
} catch (e) {
  failure = String(e?.stack ?? e);
  process.stderr.write(`probe FAILED: ${failure}\n`);
} finally {
  if (child) { kill(child); }
}

// --- 判定（机械：标记字符串只会出现在**输出**里，不会出现在我们发给 agent 的文本里）----
const allText = JSON.stringify({ notifications, clientCalls });
const sawProcess = allText.includes(MARKER_PROCESS) || allText.includes(ONLY_PROCESS);
const sawSession = allText.includes(MARKER_SESSION) || allText.includes(ONLY_SESSION);

const terminalCreateCalls = clientCalls.filter(c => c.method === 'terminal/create');
const termCwds = terminalCreateCalls.map(c => c.params?.cwd ?? '(no cwd)');
const fsReadPaths = clientCalls.filter(c => c.method === 'fs/read_text_file').map(c => c.params?.path);

let verdict = 'inconclusive';
if (sawSession && !sawProcess) { verdict = 'honours-session-cwd'; }
else if (sawProcess && !sawSession) { verdict = 'uses-process-cwd'; }
else if (sawProcess && sawSession) { verdict = 'mixed'; }

const verdictNote = {
  'honours-session-cwd': '适配器遵守 session/new 的 cwd ⇒ 每会话一个目录只需改一条链',
  'uses-process-cwd': '适配器沿用**进程** cwd ⇒ 必须按 (agent, cwd) 分进程，需重新估工作量',
  mixed: '两个能力（shell 与读文件）不一致 ⇒ 必须逐能力列清哪些可靠',
  inconclusive: '标记字符串一个都没看到 ⇒ 探针本身没跑通（看 error 与 notifications）',
}[verdict];

const fixture = {
  _comment: 'CUSTOM-20260925-056 - 由 CUSTOMIZATIONS/scripts/probe-session-cwd.mjs 生成。'
    + '回答一个问题：agent 适配器是否遵守会话级 cwd。',
  capturedAt: new Date().toISOString(),
  agentCommand,
  processCwd: procDir,
  sessionCwd: sessDir,
  dirsKept: keepDirs,
  prompt,
  agentInfo: result?.init?.agentInfo ?? null,
  agentCapabilities: result?.init?.agentCapabilities ?? null,
  sessionId: result?.sessionId ?? null,
  stopReason: result?.response?.stopReason ?? null,
  evidence: {
    sawProcessMarker: sawProcess,
    sawSessionMarker: sawSession,
    terminalCreateCount: terminalCreateCalls.length,
    terminalCreateCwds: termCwds,
    fsReadPaths,
  },
  verdict,
  verdictNote,
  notes,
  notifications,
  clientCalls,
  error: failure,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);

process.stderr.write('\n================ 探针结论 ================\n');
process.stderr.write(`进程 cwd : ${procDir}\n`);
process.stderr.write(`会话 cwd : ${sessDir}\n`);
process.stderr.write(`看到的标记: process=${sawProcess} session=${sawSession}\n`);
process.stderr.write(`terminal/create 调用: ${terminalCreateCalls.length} 次, cwd=${JSON.stringify(termCwds)}\n`);
process.stderr.write(`fs/read_text_file 路径: ${JSON.stringify(fsReadPaths)}\n`);
process.stderr.write(`\n>>> ${verdict}\n>>> ${verdictNote}\n`);
process.stderr.write(`产物: ${outPath}\n`);

if (!keepDirs) {
  for (const dir of [procDir, sessDir]) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { process.stderr.write(`probe: note: could not remove ${dir} (${e?.code ?? e})\n`); }
  }
}
process.exit(failure || verdict === 'inconclusive' ? 1 : 0);
