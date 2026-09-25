#!/usr/bin/env node
// [CUSTOM-BEGIN] CUSTOM-20260925-054 - 真实 ACP replay 抓包（聊天面板回归夹具生成器）。
//
// **为什么需要它**：聊天面板的 `session/load` 重开路径是按 **replay 流**重建 transcript 的
// （见 SessionManager.loadSession）。所以"重开后看到的内容"取决于 agent 到底回了什么，
// 而这件事**只存在于协议流量里**——不抓一次，任何关于它的判断都是猜。
// 2026-09-25 的排查就卡在这里：图1（实时）与图2（重开）内容不一致，
// 但无法从代码判断是"agent 没回放正文"还是"我们丢了正文"。
//
// 一次抓包同时产出两条流（**同一个会话**）：
//   · live   —— session/new + prompt 期间的通知（实时路径）
//   · replay —— session/load 期间的通知（重开路径）
// 两条流都进同一个夹具文件，因此测试可以直接做 **live vs replay 对比**——
// 这正是"重开与实时不一致"那个现象的形式化表达。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/capture-acp-replay.mjs --out src/test/fixtures/claude-code-session-load.json
// 可选：
//   --agent "npx @agentclientprotocol/claude-agent-acp@latest"
//   --prompt  "..."      --timeout 180000      --keep（保留临时工作目录）
//
// **注意**：它会真的拉起 agent、真的花额度，并会在该 agent 的会话历史里留下一个新会话。
// 夹具是一次性产物：协议形状变了才需要重抓。
// [CUSTOM-END] CUSTOM-20260925-054
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- 参数 ----------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const outPath = resolve(argOf('--out', 'src/test/fixtures/acp-session-load.json'));
const agentCommand = argOf('--agent', 'npx @agentclientprotocol/claude-agent-acp@latest');
// `--prompt` 可重复：一轮抓一次，多轮才能验证"回放是否覆盖全部轮次"
// （2026-09-25 的单轮抓包证明不了这一点，而用户看到的症状出现在三轮的会话里）。
const prompts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--prompt' && argv[i + 1] !== undefined) { prompts.push(argv[i + 1]); }
}
if (prompts.length === 0) {
  prompts.push(
    'List the files in this directory with their line counts in a markdown table, '
    + 'then write two short paragraphs about when a .csv and a .md file are each the right choice.',
  );
  prompts.push('Now add each file\'s byte size to a second markdown table.');
}
const timeoutMs = Number(argOf('--timeout', '420000'));
const keepScratch = argv.includes('--keep');

// --- 一次性的临时工作目录（**绝不**在仓库里跑：agent 会读/写文件）--------
const scratch = mkdtempSync(join(tmpdir(), 'acp-replay-capture-'));
writeFileSync(join(scratch, 'a.txt'), 'alpha\nbeta\ngamma\n');
writeFileSync(join(scratch, 'b.md'), '# Title\n\n- one\n- two\n\nSome prose.\n');
writeFileSync(join(scratch, 'c.csv'), 'id,name\n1,one\n2,two\n3,three\n');

// --- 记录 ----------------------------------------------------------------
/** @type {Array<{phase: string, turn: number, at: number, update: unknown}>} */
const notifications = [];
let phase = 'setup';
let currentTurn = 0;
const notes = [];

function kill(child) {
  try { child.kill(); } catch { /* already gone */ }
}

// --- 最小但忠实的 ACP client --------------------------------------------
// 能力集**与扩展一致**（fs 读写 + terminal），因为 agent 的行为可能取决于它宣称的能力。
const terminals = new Map();
let terminalSeq = 0;

function createTerminalStub(params) {
  const id = `t${++terminalSeq}`;
  const child = spawn(params.command, params.args ?? [], {
    cwd: params.cwd ?? scratch,
    env: { ...process.env, ...(params.env ?? {}) },
    shell: true,
  });
  const state = { child, output: '', exitCode: null, signal: null, waiters: [] };
  const append = d => {
    if (state.output.length > 200_000) { return; }
    state.output += d.toString();
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.signal = signal;
    for (const w of state.waiters) { w(); }
    state.waiters.length = 0;
  });
  terminals.set(id, state);
  return { terminalId: id };
}

const client = {
  async sessionUpdate(params) {
    notifications.push({ phase, turn: currentTurn, at: Date.now(), update: params });
  },
  async requestPermission(params) {
    // 自动批准，否则抓包会卡在等人点按钮上。
    const options = params.options ?? [];
    const allow = options.find(o => String(o.kind ?? '').startsWith('allow')) ?? options[0];
    notes.push(`permission: ${params.toolCall?.title ?? '(no title)'} -> ${allow?.optionId ?? 'cancelled'}`);
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  },
  async readTextFile(params) {
    const { readFileSync } = await import('node:fs');
    return { content: readFileSync(params.path, 'utf8') };
  },
  async writeTextFile(params) {
    const { writeFileSync: wf } = await import('node:fs');
    wf(params.path, params.content ?? '');
    return {};
  },
  async createTerminal(params) { return createTerminalStub(params); },
  async terminalOutput(params) {
    const t = terminals.get(params.terminalId);
    if (!t) { throw new Error(`unknown terminal ${params.terminalId}`); }
    return { output: t.output, truncated: false };
  },
  async waitForTerminalExit(params) {
    const t = terminals.get(params.terminalId);
    if (!t) { throw new Error(`unknown terminal ${params.terminalId}`); }
    if (t.exitCode === null && t.signal === null) {
      await new Promise(r => t.waiters.push(r));
    }
    return { exitCode: t.exitCode, signal: t.signal };
  },
  async killTerminal(params) {
    const t = terminals.get(params.terminalId);
    if (t) { kill(t.child); }
    return {};
  },
  async releaseTerminal(params) { return {}; },
  async extMethod() { return {}; },
  async extNotification() { return {}; },
};

// --- 主流程 --------------------------------------------------------------
let child;
let failure = null;

async function main() {
  process.stderr.write(`capture: cwd=${scratch}\ncapture: agent=${agentCommand}\n`);
  child = spawn(agentCommand, {
    cwd: scratch,
    env: process.env,
    shell: true,           // Windows 上 npx 是 .cmd，必须走 shell
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[agent stderr] ${d}`));

  const readable = Readable.toWeb(child.stdout);
  const writable = Writable.toWeb(child.stdin);
  const stream = ndJsonStream(writable, readable);
  const connection = new ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vscode-acp-client', version: 'capture-script' },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  process.stderr.write(`capture: agent=${init.agentInfo?.name} ${init.agentInfo?.version}\n`);

  phase = 'live';
  const created = await connection.newSession({ cwd: scratch, mcpServers: [] });
  const sessionId = created.sessionId;
  process.stderr.write(`capture: session=${sessionId}\n`);

  const responses = [];
  for (let i = 0; i < prompts.length; i++) {
    phase = 'live';
    currentTurn = i + 1;
    process.stderr.write(`capture: turn ${i + 1}/${prompts.length} …\n`);
    const response = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: prompts[i] }],
    });
    responses.push({ prompt: prompts[i], stopReason: response.stopReason });
    process.stderr.write(`capture:   stopReason=${response.stopReason}\n`);
  }

  // 关掉再用 session/load 重开 —— 这就是面板里"关掉标签再重开"走的那条路。
  try {
    await connection.closeSession({ sessionId });
    process.stderr.write('capture: session closed\n');
  } catch (e) {
    notes.push(`closeSession failed: ${e?.message ?? e}`);
  }

  const caps = init.agentCapabilities ?? {};
  if (!caps.loadSession) {
    notes.push('agent does NOT advertise loadSession — replay phase will be empty');
    process.stderr.write('capture: agent has no loadSession capability\n');
  } else {
    phase = 'replay';
    const loaded = await connection.loadSession({ sessionId, cwd: scratch, mcpServers: [] });
    process.stderr.write(`capture: replay done, ${notifications.filter(n => n.phase === 'replay').length} notifications\n`);
    notes.push(`loadSession response keys: ${Object.keys(loaded ?? {}).join(',') || '(none)'}`);
  }

  return {
    sessionId,
    init,
    responses,
    configOptions: created.configOptions ?? null,
    modes: created.modes ?? null,
  };
}

const timer = new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref?.();
});

let result = null;
try {
  result = await Promise.race([main(), timer]);
} catch (e) {
  failure = String(e?.stack ?? e);
  process.stderr.write(`capture FAILED: ${failure}\n`);
} finally {
  if (child) { kill(child); }
}

// --- 落盘（失败也写：部分抓包比没有强，且能看出卡在哪一步）----------------
const counts = notifications.reduce((acc, n) => {
  const key = `${n.phase}:${n.update?.update?.sessionUpdate ?? '?'}`;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

const fixture = {
  _comment: 'CUSTOM-20260925-054 - 由 CUSTOMIZATIONS/scripts/capture-acp-replay.mjs 抓取。协议形状变了才需要重抓。',
  capturedAt: new Date().toISOString(),
  agentCommand,
  prompts,
  scratchCwd: keepScratch ? scratch : undefined,
  protocolVersion: PROTOCOL_VERSION,
  sessionId: result?.sessionId ?? null,
  agentInfo: result?.init?.agentInfo ?? null,
  agentCapabilities: result?.init?.agentCapabilities ?? null,
  liveResponses: result?.responses ?? null,
  notes,
  notificationCounts: counts,
  notifications,
  error: failure,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
process.stderr.write(`capture: wrote ${outPath} (${notifications.length} notifications)\n`);
process.stderr.write(`capture: counts ${JSON.stringify(counts, null, 2)}\n`);
// 清理临时目录是 best-effort：Windows 上 agent 子进程可能还占着句柄（EBUSY），
// 那不该让一次**成功**的抓包以非零码退出（曾经如此，很误导）。
if (!keepScratch) {
  try { rmSync(scratch, { recursive: true, force: true }); }
  catch (e) { process.stderr.write(`capture: note: could not remove ${scratch} (${e?.code ?? e})\n`); }
}
process.exit(failure ? 1 : 0);
