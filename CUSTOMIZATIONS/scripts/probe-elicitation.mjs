#!/usr/bin/env node
// =============================================================================
// probe-elicitation.mjs — 真 agent 会不会把 AskUserQuestion 当表单送来？送来的形状我们认不认得？
//
// **为什么需要它**：`clientCapabilities.elicitation.form` 是本扩展在 2026-09-29 才声明的东西
// （CUSTOM-20260929-119），而"声明之后 agent 到底发什么"**只存在于协议流量里**：
//   · 不声明时 adapter 连 AskUserQuestion 工具都禁用（`disallowedTools`）——用户看到的就是
//     "会话卡在那个工具卡上，官方插件却弹出了选项面板"；
//   · 声明后它走 `unstable_createElicitation`（form 模式），字段表由 adapter 从题目的
//     `questions[]` 生成（每题一个 `oneOf`，外加一个 `_meta` 标记的"Other"文本框）。
// 单元测试只能验证"给定形状我们处理得对"，验证不了"adapter 真的会按这个形状发"。
//
// **它怎么做到不复制知识**：探针把 `src/handlers/ElicitationBridge.ts` 的**编译产物**
// （`out/handlers/ElicitationBridge.js` 里的 `fieldsOf`）借过来用——即"真代码解析真流量"。
// 该文件 import 了 Logger（→ vscode），所以这里给 `require` 打一个只认 'vscode' 的桩。
// 跑之前先 `npm run compile-tests`。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/probe-elicitation.mjs [--answer <选项序号>] [--custom <文本>]
//   --answer  选第几个选项（默认 0 = 第一个）
//   --custom  用"Other"自由文本回答（优先于 --answer）
//
// **代价**：会真的拉起 agent、真的花一轮额度，并在该 agent 的会话历史里留下一个会话
// （跑在一次性临时目录，不在仓库内）。它是一次性探针，不产出夹具。
// =============================================================================
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const answerIndex = Number(argOf('--answer', '0'));
const customAnswer = argOf('--custom', null);
/**
 * `--no-answer` 把表单**挂着不答**（模拟"用户根本没看到，agent 一直在等"），
 * `--reopen <sessionId>` 只做 `session/load`（不新建、不提问）——这一对就是用户的真实场景：
 * 会话停在 AskUserQuestion 上，官方插件重开它会弹面板，我们呢？
 */
const noAnswer = argv.includes('--no-answer');
const reopenSessionId = argOf('--reopen', null);

// --- 借真代码：给 require 打一个只认 'vscode' 的桩，然后加载编译后的 fieldsOf ---
const compiledBridge = join(repoRoot, 'out', 'handlers', 'ElicitationBridge.js');
if (!existsSync(compiledBridge)) {
  console.log('  [SKIP] 还没有 out/：先跑 `npm run compile-tests`');
  process.exit(0);
}
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') { return 'vscode'; }
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { fieldsOf } = require(compiledBridge);

const PROMPT = '请用 AskUserQuestion 工具问我一个二选一的问题：两个选项分别是「A 方案」「B 方案」，'
  + '问题标题用「选哪个方案」。问完就停下来，不要自己回答。';

const cwd = resolve(argOf('--cwd', mkdtempSync(join(tmpdir(), 'acpe-elicitation-'))));
const proc = spawn('npx', ['@agentclientprotocol/claude-agent-acp@latest'], {
  cwd, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'],
});
proc.stderr.on('data', () => { /* the agent is chatty on stderr */ });

let elicitationSeen = 0;
let answered = null;

const client = {
  async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
  async sessionUpdate(params) {
    const u = params?.update;
    if (!u) { return; }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const title = u.title ?? u.rawInput?.questions ? 'AskUserQuestion' : '';
      console.log(`  [update] ${u.sessionUpdate} status=${u.status ?? ''} title=${title} content=${JSON.stringify(u.content)?.slice(0, 120) ?? ''}`);
    } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      process.stdout.write(u.content.text);
    }
  },
  async writeTextFile() { return {}; },
  async readTextFile() { return { content: '' }; },
  async createTerminal() { return { terminalId: 't' }; },
  async terminalOutput() { return { output: '', truncated: false }; },
  async waitForTerminalExit() { return { exitCode: 0 }; },
  async killTerminal() { return {}; },
  async releaseTerminal() { return {}; },

  /**
   * 这一条就是探针要验的东西：agent 送来的 form 长什么样，我们的 fieldsOf 认得多少，
   * 以及我们按 ACP 形状回过去的答案 agent 收不收。
   */
  // [CUSTOM-20261003-175] 方法名必须跟着 SDK 走：1.x 起叫 `createElicitation`
  //（旧的 `unstable_createElicitation` 已不存在，用旧名字 SDK 不会派发到它 —— 探针会静默地
  // 一次表单都收不到）。
  async createElicitation(params) {
    elicitationSeen++;
    console.log('\n  ===== ELICITATION =====');
    console.log('  mode      :', params.mode);
    console.log('  sessionId :', params.sessionId ?? '(none)');
    console.log('  toolCallId:', params.toolCallId ?? '(none)');
    console.log('  message   :', params.message);
    console.log('  raw schema:', JSON.stringify(params.requestedSchema));

    const fields = fieldsOf(params.requestedSchema);
    console.log('  our fields:', JSON.stringify(fields.map(f => ({
      name: f.name, kind: f.kind, title: f.title, customFor: f.customFor,
      // [CUSTOM-20261003-175] 打印每个选项**有没有说明**（2026-10-03 的案子：SDK 的 zod
      // schema 曾把 option.description 削掉，真机就是靠这一眼看出来的）。
      options: (f.options ?? []).map(o => o.value + (o.description ? ' [desc ' + o.description.length + '字]' : ' [无 desc]')),
    }))));

    if (noAnswer) {
      console.log('  (--no-answer) 挂着不答，等进程退出');
      return new Promise(() => { /* never resolves: the agent waits, like the user saw */ });
    }
    const content = {};
    const select = fields.find(f => f.kind === 'select');
    if (customAnswer !== null && select) {
      const customField = fields.find(f => f.customFor === select.name);
      if (customField) { content[customField.name] = customAnswer; }
      console.log(`  answering  : custom "${customAnswer}"`);
    } else if (select && select.options?.length) {
      const chosen = select.options[Math.min(answerIndex, select.options.length - 1)];
      content[select.name] = chosen.value;
      console.log(`  answering  : ${select.name} = ${JSON.stringify(chosen.value)}`);
    } else {
      console.log('  answering  : (no select field found — declining instead)');
      return { action: 'decline' };
    }
    answered = content;
    console.log('  =======================\n');
    return { action: 'accept', content };
  },
};

// Argument order matters: ndJsonStream(output, input) — see capture-acp-replay.mjs.
const stream = ndJsonStream(
  Writable.toWeb(proc.stdin),
  Readable.toWeb(proc.stdout),
);
const connection = new ClientSideConnection(() => client, stream);

const timeout = setTimeout(() => {
  console.log('\n  [TIMEOUT] 6 分钟未结束，收工');
  shutdown(1);
}, 360_000);

function shutdown(code) {
  clearTimeout(timeout);
  try { proc.kill(); } catch { /* already gone */ }
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* busy on Windows is fine */ }
  console.log(`\n  elicitation 次数: ${elicitationSeen}；我们的答案: ${JSON.stringify(answered)}`);
  console.log(`  判定: ${elicitationSeen > 0 && answered ? '收到表单并按 ACP 形状回答了 ✓' : '没有收到表单 —— 声明没生效或提问没触发'}`);
  process.exit(code);
}

try {
  // --cwd 之外还要能指定"从哪里读转录"：把 CLAUDE_CONFIG_DIR 指到临时目录就能**隔离复现**
  // 任意一个已存在的会话（复制它的 .jsonl 过去即可），不碰原会话、也不花额度。
  const configDir = argOf('--config-dir', null);
  if (configDir) { process.env.CLAUDE_CONFIG_DIR = resolve(configDir); }
  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vscode-acp-client', version: 'probe' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      elicitation: { form: {} },
    },
  });
  console.log(`  initialized: ${init.agentInfo?.name} v${init.agentInfo?.version}`);
  if (reopenSessionId) {
    console.log(`  session/load ${reopenSessionId}（只看它是否重新抛出未决提问）`);
    await connection.loadSession({ sessionId: reopenSessionId, cwd, mcpServers: [] });
    // 给 replay / 重抛留一点时间再收工。
    await new Promise(resolve => setTimeout(resolve, 5000));
    shutdown(0);
  }
  const session = await connection.newSession({ cwd, mcpServers: [] });
  console.log(`  session: ${session.sessionId}`);
  console.log(`  prompt: ${PROMPT}`);
  await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: PROMPT }] });
  if (noAnswer) {
    // 提问到达后挂 45 秒再退出：进程被杀 = 那条请求永远没被回答，正是用户会话的状态。
    await new Promise(resolve => setTimeout(resolve, 45_000));
  }
  shutdown(0);
} catch (e) {
  console.log('  [ERROR]', e?.message ?? e);
  shutdown(1);
}
