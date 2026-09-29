#!/usr/bin/env node
// [CUSTOM-BEGIN] CUSTOM-20260927-091 - 探针：agent 的 `session/list` 到底报了哪些会话。
//
// 为什么需要它：本扩展的历史选择器**完全依赖 agent 的这一条回复**（未连接时退回本地缓存）。
// 于是"面板里少了几条会话"这类报告只有两种可能——**要么 agent 没报**，**要么我们过滤掉了**——
// 而这两者的修法完全不同。猜是没用的：跑一遍就知道了。
//
// 实测记录（2026-09-27）：报告"ACP 面板比官方插件少两条"，本探针一次定位——
// agent 报了 226 条，其中 cwd 指向本项目的 **只有 5 条**；磁盘上该项目却有 **8 个会话文件**
// （多出的三条是最近创建的）。⇒ 少的那几条**根本不在 agent 的回复里**，
// 不是本扩展的目录过滤或"活跃会话"过滤造成的。修法在"拿不到 cwd 的行怎么呈现"这一侧，
// 而不是"我们的过滤写错了"。
//
// 它**只读**：`initialize` + `session/list`，不建会话、不改任何东西（比 probe-session-cwd 便宜）。
// 但它仍会**拉起一个 agent 进程**（npx 会联网/装包）。跑完记得确认进程已退出。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/probe-session-list.mjs                  # 用仓库根作为 cwd
//   node CUSTOMIZATIONS/scripts/probe-session-list.mjs --cwd D:\some\dir
//   node CUSTOMIZATIONS/scripts/probe-session-list.mjs --agent "Claude Code"
// [CUSTOM-END] CUSTOM-20260927-091
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Claude Code stores one directory per working directory, named by the path with every
 * non-alphanumeric character replaced by '-' (`D:\Git\x` -> `D--Git-x`). Measured against
 * a real install; `CLAUDE_CONFIG_DIR` overrides the root.
 */
function transcriptDir(cwd) {
  const root = process.env.CLAUDE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  return join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/**
 * Read the id / cwd / title / mtime of every transcript in a directory.
 *
 * Line-by-line, not "the first 200 KB": a transcript's FIRST line can itself be larger
 * than that (a big tool result or a pasted image), and a character slice would then cut
 * inside it and parse nothing — which is how the first version of this probe reported
 * cwd/title as undefined for a session that has them.
 */
async function readDiskSessions(dir) {
  if (!existsSync(dir)) { return []; }
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) { continue; }
    const file = join(dir, name);
    const row = {
      sessionId: name.slice(0, -'.jsonl'.length),
      cwd: undefined,
      title: undefined,
      updatedAt: new Date(statSync(file).mtimeMs).toISOString(),
    };
    out.push(row);
    let lines = 0;
    const input = createReadStream(file, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (++lines > 200) { break; }
        if (line.length > 4_000_000) { continue; }
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record !== 'object') { continue; }
        if (!row.cwd && typeof record.cwd === 'string') { row.cwd = record.cwd; }
        if (!row.title && record.type === 'user') {
          const content = record.message?.content;
          const text = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content.find(b => b?.type === 'text')?.text : undefined);
          if (typeof text === 'string' && text.trim() && !text.startsWith('<local-command')) {
            row.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
          }
        }
        if (row.cwd && row.title) { break; }
      }
    } catch { /* unreadable transcript: keep the row with what we have */ } finally {
      reader.close();
      input.destroy();
    }
  }
  return out;
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

/** Agent definitions live in package.json (same source the extension reads). */
function agentConfig(name) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  const agents = pkg.contributes.configuration.properties['acpc.agents'].default;
  const config = agents[name];
  if (!config) {
    console.error(`Unknown agent "${name}". Known: ${Object.keys(agents).join(', ')}`);
    process.exit(2);
  }
  return config;
}

const agentName = arg('agent', 'Claude Code');
const cwd = arg('cwd', repoRoot);
const config = agentConfig(agentName);

console.log(`spawning ${agentName}: ${config.command} ${(config.args ?? []).join(' ')}  (cwd ${cwd})`);
const child = spawn(config.command, config.args ?? [], {
  cwd,
  env: { ...process.env, ...(config.env ?? {}) },
  shell: process.platform === 'win32',
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', d => process.stderr.write(`[agent stderr] ${d}`));

const client = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => ({}),
};

try {
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientSideConnection(() => client, stream);
  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'acpc-probe-session-list', version: '0' },
  });
  console.log('agentCapabilities:', JSON.stringify(init.agentCapabilities ?? null));

  const reply = await connection.listSessions({});
  const sessions = reply.sessions ?? [];
  console.log(`\nsession/list -> ${sessions.length} sessions, nextCursor=${reply.nextCursor ?? 'none'}`);

  const key = (s) => String(s.cwd ?? '');
  const mine = sessions.filter(s => key(s).toLowerCase().includes('custom-vscode-acp'));
  console.log(`\n--- ${mine.length} of them mention custom-vscode-acp in their cwd:`);
  for (const s of mine) {
    console.log(
      `  ${String(s.sessionId ?? '').slice(0, 8)}  cwd=${JSON.stringify(s.cwd)}`
      + `  title=${JSON.stringify(String(s.title ?? '').slice(0, 40))}  updatedAt=${s.updatedAt}`,
    );
  }
  const noCwd = sessions.filter(s => !key(s));
  console.log(`\n--- ${noCwd.length} sessions have NO cwd at all (the filter cannot place them)`);
  for (const s of noCwd.slice(0, 10)) {
    console.log(`  ${String(s.sessionId ?? '').slice(0, 8)}  title=${JSON.stringify(String(s.title ?? '').slice(0, 40))}`);
  }

  // --- the reconciliation the reports keep asking for ---------------------
  // Disk vs agent, for THIS working directory. Any id on disk that the agent did not
  // report is a gap in the agent's list, not in a client's filter.
  const dir = transcriptDir(cwd);
  const disk = await readDiskSessions(dir);
  const reported = new Set(sessions.map(s => String(s.sessionId ?? '')));
  const diskOnly = disk.filter(d => !reported.has(d.sessionId));
  console.log(`\n=== reconciliation for ${cwd}`);
  console.log(`  transcript dir : ${dir}`);
  console.log(`  on disk        : ${disk.length} sessions`);
  console.log(`  agent reported : ${disk.filter(d => reported.has(d.sessionId)).length} of them`);
  console.log(`  *** disk-only (agent did NOT list) : ${diskOnly.length}`);
  for (const d of diskOnly) {
    console.log(`      ${d.sessionId.slice(0, 8)}  ${d.updatedAt}  cwd=${JSON.stringify(d.cwd)}  title=${JSON.stringify(d.title)}`);
  }
  const agentOnly = sessions.filter(s => String(key(s)).toLowerCase() === cwd.toLowerCase()
    && !disk.some(d => d.sessionId === String(s.sessionId ?? '')));
  console.log(`  agent-only (no transcript file) : ${agentOnly.length}`);
  for (const s of agentOnly.slice(0, 10)) {
    console.log(`      ${String(s.sessionId ?? '').slice(0, 8)}  title=${JSON.stringify(String(s.title ?? '').slice(0, 40))}`);
  }
  console.log('\nHow to read this: a session the picker "lost" that does NOT appear above was never');
  console.log('reported by the agent — that is an agent-side list, not a filter of ours.');
} finally {
  child.kill();
}
