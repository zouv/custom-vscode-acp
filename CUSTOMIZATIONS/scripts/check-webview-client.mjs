#!/usr/bin/env node
// =============================================================================
// check-webview-client.mjs — webview 内联客户端脚本的语法自检
//
// 为什么需要它（真实踩过的坑）：
//   `src/ui/chat/html/client/*.ts` 把客户端 JS 放在 **TypeScript 模板字符串**里。
//   这带来两类只在运行时才炸的错误：
//     1. 模板字符串**内部**（含 JSDoc / 行内注释）出现反引号 → 直接终止字符串，
//        后续代码溢出到 TS 语法层面（tsc 会报 TS1005，但报错位置难以定位）。
//     2. 想出现在生成脚本里的反斜杠忘记双写（`\n` 应为 `\\n`）→ 生成的 JS 里是
//        真实换行，语法错误；`\uXXXX` 转义同样容易被写坏。
//   tsc 只看 TS 层，看不到拼接后的脚本；浏览器只在面板打开时才报错。本脚本把这一步
//   提前到命令行：抽出每个模块的模板内容，拼起来交给 `new Function()` 做语法校验。
//
// 用法：node CUSTOMIZATIONS/scripts/check-webview-client.mjs
// 退出码：0 通过；1 有语法错误或模块缺失
// =============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..', '..');
const CLIENT_DIR = join(PROJECT_ROOT, 'src', 'ui', 'chat', 'html', 'client');
const INDEX = join(CLIENT_DIR, 'index.ts');

if (!existsSync(CLIENT_DIR)) {
  console.log('  (未找到 src/ui/chat/html/client/，跳过)');
  process.exit(0);
}

/**
 * Extract the template-literal body of `export const <name>Client = ` ... `` `; ``.
 * Relies on the module format being uniform, which the same file's header
 * comment states as a hard rule.
 */
function extractTemplate(file, text) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^export const \w+Client = `\s*$/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return { error: 'no `export const <name>Client = ` line found' };
  }
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '`;') {
      return { body: lines.slice(start, i).join('\n') };
    }
  }
  return { error: 'template literal is not terminated by a line containing only `;' };
}

const files = readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort();
if (files.length === 0) {
  console.log('  (client 目录下没有模块)');
  process.exit(0);
}

let errors = 0;
const parts = [];
const namespaces = [];

for (const file of files) {
  const text = readFileSync(join(CLIENT_DIR, file), 'utf8');
  const result = extractTemplate(file, text);
  if (result.error) {
    console.log(`  [EXTRACT] ${file}: ${result.error}`);
    errors++;
    continue;
  }

  const nsMatch = result.body.match(/NS\.(\w+) = \{/);
  if (!nsMatch) {
    console.log(`  [NAMESPACE] ${file}: 未找到 "NS.<name> = {" 导出`);
    errors++;
    continue;
  }

  // 模板体里出现反引号 = 字符串被提前终止。tsc 会报 TS1005 但位置指向文件中段一行
  // **看起来完全正常**的代码，定位成本很高。这里提前给出可读的诊断。
  // （本检查器自己就抓到过一次：boot.ts 的 JSDoc 里写了 'running' 的反引号形式。）
  const bodyLines = result.body.split('\n');
  const tickLine = bodyLines.findIndex((l) => l.includes('`'));
  if (tickLine !== -1) {
    console.log(`  [BACKTICK] ${file}:${tickLine + 1}: 模板体里出现反引号，字符串会在此提前终止`);
    console.log(`             ${bodyLines[tickLine].trim()}`);
    console.log('             → 客户端代码里的注释请一律用单引号');
    errors++;
    continue;
  }

  namespaces.push(`${nsMatch[1]}(${file})`);
  parts.push(result.body);
}

// index.ts must still reference every module it did before we started passing
// the concatenation through here.
try {
  const indexText = readFileSync(INDEX, 'utf8');
  const imported = [...indexText.matchAll(/from '\.\/([\w.-]+)'/g)].map((m) => `${m[1]}.ts`);
  for (const f of imported) {
    if (f !== 'index.ts' && !files.includes(f)) {
      console.log(`  [MISSING] index.ts 引用了不存在的模块 ${f}`);
      errors++;
    }
  }
} catch {
  // index.ts missing is reported by tsc; nothing to add here.
}

const source = parts.join('\n');
try {
  // Syntax-only check: never executed. `new Function` parses the body eagerly.
  // eslint-disable-next-line no-new-func
  new Function(source);
  console.log(`  [OK] ${files.length} 个客户端模块拼接后可解析（${namespaces.join(', ')}）`);
} catch (e) {
  console.log(`  [SYNTAX] 拼接后的客户端脚本无法解析: ${e.message}`);
  errors++;
}

if (errors > 0) {
  console.log(`  → 共 ${errors} 处问题（常见原因：模板字符串内部出现反引号，或反斜杠未双写）`);
  process.exit(1);
}
process.exit(0);
