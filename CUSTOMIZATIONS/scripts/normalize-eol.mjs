#!/usr/bin/env node
// =============================================================================
// normalize-eol.mjs — 把指定文件（或全部已跟踪的上游文件）的换行符统一为 CRLF
//
// 为什么需要：上游 vscode-acp 以 CRLF 入库，而 sed / Write / npm install 等
// 会产出 LF，导致整文件伪差异并破坏后续三点合并。详见 .gitattributes 与
// CUSTOMIZATIONS/docs/pitfalls.md #7。
//
// 规则（两类文件，不要混）：
//   - **上游也有的文件**（src/、package*.json、.github/、.gitignore、.vscodeignore …）必须 CRLF，
//     否则与上游 blob 逐行不等，产生整文件伪差异并毁掉三方合并；
//   - **纯自定义文件**（CUSTOMIZATIONS/、.agents/、AGENTS.md、.gitattributes）保持 LF ——
//     不参与合并，且其中的 .sh 带 CRLF 在 Linux/macOS 上会执行失败。
//
// 用法：
//   node CUSTOMIZATIONS/scripts/normalize-eol.mjs                # 全部已跟踪文件（自动跳过纯自定义路径）
//   node CUSTOMIZATIONS/scripts/normalize-eol.mjs package-lock.json src/extension.ts
//   node CUSTOMIZATIONS/scripts/normalize-eol.mjs --check        # 只报告，不改写（CI/自检用）
// =============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicit = args.filter((a) => !a.startsWith('--'));

// 二进制/无需处理：图片、exe、shim 等
const SKIP = /\.(png|jpe?g|gif|ico|svg|vsix|exe|dll|zip|gz|woff2?|icns)$/i;

// 纯自定义路径（上游没有这些文件）→ 保持 LF，**不要**转成 CRLF。
// 理由：①它们不与上游同名，不存在合并冲突风险；②其中的 .sh 脚本若带 CRLF，
// 在 Linux/macOS 上会因 shebang 解析失败而无法执行。
const CUSTOM_ONLY = /^(CUSTOMIZATIONS\/|\.agents\/|AGENTS\.md$|\.gitattributes$)/;

// 注意：这里必须同时列**未跟踪**文件（--others --exclude-standard）。
// 只用 `git ls-files` 会漏掉新建但尚未 `git add` 的文件，导致新文件带着 LF 通过检查、
// 直到提交后才被发现（pitfall #7 的复发路径）。本仓库曾因此让整个 src/ui/chat/ 新树
// 静默绕过 CRLF 检查。
const files = explicit.length
  ? explicit
  : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

let changed = 0;
const problems = [];

for (const file of files) {
  if (SKIP.test(file)) continue;
  if (CUSTOM_ONLY.test(file)) continue; // 纯自定义文件保持 LF
  let raw;
  try {
    raw = readFileSync(file);
  } catch {
    continue; // 已被删除或不可读
  }
  // 跳过含 NUL 的二进制
  if (raw.includes(0)) continue;

  const text = raw.toString('utf8');
  const normalized = text.replace(/\r?\n/g, '\r\n');

  if (normalized === text) continue;

  changed++;
  const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
  if (checkOnly) {
    problems.push(`  [LF] ${file}（${lfOnly} 行是 LF，应为 CRLF）`);
  } else {
    writeFileSync(file, normalized, 'utf8');
    console.log(`  已转为 CRLF: ${file}（修正 ${lfOnly} 行）`);
  }
}

if (checkOnly) {
  if (problems.length) {
    console.log(`[DIFF] ${problems.length} 个文件换行符不符合上游（应为 CRLF）：`);
    console.log(problems.join('\n'));
    console.log('\n运行 node CUSTOMIZATIONS/scripts/normalize-eol.mjs 修正');
    process.exit(1);
  }
  const upstreamFiles = files.filter((f) => !SKIP.test(f) && !CUSTOM_ONLY.test(f));
  console.log(`[OK] 全部 ${upstreamFiles.length} 个上游共有文件换行符一致（CRLF）`);
  process.exit(0);
}

console.log(changed ? `\n共修正 ${changed} 个文件` : '所有文件已是 CRLF，无需修正');
