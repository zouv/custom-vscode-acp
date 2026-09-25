#!/usr/bin/env node
// =============================================================================
// check-webview-client.mjs — webview 内联模板字符串的语法自检
//
// 为什么需要它（真实踩过三次的坑）：
//   `src/ui/chat/html/**/*.ts` 把 webview 的 HTML / CSS / JS 放在 **TypeScript 模板字符串**里。
//   这带来两类只在运行时才炸、且报错位置极具误导性的错误：
//     1. 模板字符串**内部**（含注释）出现反引号 → 字符串提前终止，后续内容溢出到 TS 语法层，
//        tsc 报 TS1005 但位置指向文件中段一行**看起来完全正常**的代码。
//     2. 想出现在生成脚本里的反斜杠忘记双写（`\n` 应为 `\\n`）→ 生成的 JS 里是真实换行。
//
// ⚠️ 覆盖范围（第一版这里有过缺口，别再犯）：
//   本脚本最初只扫 `html/client/*.ts`，结果 `html/styles.ts` 的注释里出现反引号时
//   **它报 OK 而 tsc 报错**。现在扫的是整个 `html/` 树下所有 `.ts`。
//   **新增任何模板字符串模块，只要放在 `src/ui/chat/html/` 下就会被自动覆盖**——
//   这也是不要在别处新建同类模块的原因。
//
// 用法：node CUSTOMIZATIONS/scripts/check-webview-client.mjs [--fix]
//   --fix：把模板体内（**只在模板体内**）的反引号就地换成单引号，然后照常校验。
//          加它的理由：这一类错误在本项目复发过七次以上，而修法永远是同一个机械动作。
//          按 pitfall #11 自己的教训——「能自动化的纪律就不要留给记忆」。
//          （文件头注释里的反引号不受影响：范围只覆盖模板体。）
// 退出码：0 通过；1 有语法错误或模板体里出现反引号
// =============================================================================
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..', '..');
const HTML_DIR = join(PROJECT_ROOT, 'src', 'ui', 'chat', 'html');
const CLIENT_DIR = join(HTML_DIR, 'client');

const toPosix = (p) => p.split(sep).join('/');
const rel = (p) => toPosix(relative(PROJECT_ROOT, p));

if (!existsSync(HTML_DIR)) {
  console.log('  (未找到 src/ui/chat/html/，跳过)');
  process.exit(0);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); }
    else if (entry.isFile() && entry.name.endsWith('.ts')) { out.push(full); }
  }
  return out;
}

/** A template literal opens on a line like `export const XClient = \`` or `return \`<style>`. */
const isOpenLine = (line) => /^\s*(export const \w+Client = |return )`/.test(line);
/** ...and closes on a line ending with a backtick + semicolon (e.g. `\`;` or `</style>\`;`). */
const isCloseLine = (line) => /`;\s*$/.test(line);

/**
 * Extract a module's template body while flagging stray backticks.
 *
 * Returns `{ body }` on success, or `{ error }` / `{ backtick }` describing the
 * first problem. The state machine is deliberately simple and matches the
 * uniform formatting this directory follows (see the file header rules).
 */
function extractTemplate(text) {
  const lines = text.split('\n');
  let inTemplate = false;
  let start = -1;
  let body = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('`')) {
      if (inTemplate) { body.push(line); }
      continue;
    }

    const ticks = (line.match(/`/g) || []).length;

    if (!inTemplate) {
      // Outside a template literal a backtick is legitimate TypeScript — the
      // module headers document `acpc.*` ids and `\\` escapes in markdown-style
      // backticks all the time. Only what happens INSIDE the template matters.
      if (isOpenLine(line) && !(isCloseLine(line) && ticks >= 2) && ticks === 1) {
        inTemplate = true;
        start = i + 1;
      }
      continue;
    }

    if (isCloseLine(line) && ticks === 1) {
      inTemplate = false;
      return { body: body.join('\n') };
    }
    return { backtick: { line: i + 1, text: line.trim(), why: '模板体内出现反引号，字符串会在此提前终止' } };
  }

  if (inTemplate) {
    return { error: start >= 0 ? `模板字符串自第 ${start} 行起未闭合` : '模板字符串未闭合' };
  }
  // No template literal at all (e.g. nonce.ts, html/index.ts) — perfectly normal,
  // those files only mention backticks in their own comments.
  return {};
}

let errors = 0;
// Only modules that actually contain a template literal are interesting —
// nonce.ts / html/index.ts are plain TS and legitimately have none.
const moduleFiles = walk(HTML_DIR)
  .filter((abs) => readFileSync(abs, 'utf8').includes('`'))
  .sort();

/**
 * The template body as a LINE RANGE (open line → last closing line).
 *
 * `extractTemplate` stops at the first stray backtick, which is what makes it a
 * good checker and a useless fixer. Locating the range first lets `--fix`
 * rewrite the whole body in one pass.
 *
 * Only lines with EXACTLY one backtick count, so a single-line template
 * (`return \`<script …>\`;`) is left alone — it cannot contain a stray one.
 */
function templateRange(lines) {
  let open = -1;
  let close = -1;
  for (let i = 0; i < lines.length; i++) {
    const ticks = (lines[i].match(/`/g) || []).length;
    if (open < 0) {
      if (isOpenLine(lines[i]) && ticks === 1) { open = i; }
      continue;
    }
    if (isCloseLine(lines[i]) && ticks === 1) { close = i; }
  }
  return open >= 0 && close > open ? { open, close } : null;
}

if (process.argv.includes('--fix')) {
  let fixedFiles = 0;
  let fixedTicks = 0;
  for (const abs of moduleFiles) {
    // Split/join on '\n' only: the '\r' stays at each line's end, so CRLF files
    // are not silently converted to LF (see pitfalls #7).
    const lines = readFileSync(abs, 'utf8').split('\n');
    const range = templateRange(lines);
    if (!range) { continue; }
    let here = 0;
    for (let i = range.open + 1; i < range.close; i++) {
      const ticks = (lines[i].match(/`/g) || []).length;
      if (ticks > 0) { lines[i] = lines[i].split('`').join("'"); here += ticks; }
    }
    if (here > 0) {
      writeFileSync(abs, lines.join('\n'));
      console.log(`  [FIX] ${rel(abs)}: 模板体内 ${here} 处反引号 → 单引号`);
      fixedFiles++;
      fixedTicks += here;
    }
  }
  if (fixedTicks > 0) {
    console.log(`  → 已修复 ${fixedFiles} 个文件、${fixedTicks} 处；下面是修复后的校验`);
  }
}

// --- 1) 每个模板模块：反引号 / 闭合 检查 -------------------------------------
for (const abs of moduleFiles) {
  const text = readFileSync(abs, 'utf8');
  const result = extractTemplate(text);
  if (result.backtick) {
    console.log(`  [BACKTICK] ${rel(abs)}:${result.backtick.line}: ${result.backtick.why}`);
    console.log(`             ${result.backtick.text}`);
    console.log('             → 模板字符串内的注释请一律用单引号');
    errors++;
  } else if (result.error) {
    console.log(`  [EXTRACT] ${rel(abs)}: ${result.error}`);
    errors++;
  }
}

// --- 2) client/ 下的模块：拼接后交给 new Function 做语法校验 -------------------
const clientFiles = existsSync(CLIENT_DIR)
  ? readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort()
  : [];

if (clientFiles.length > 0 && errors === 0) {
  const parts = [];
  const namespaces = [];

  for (const file of clientFiles) {
    const text = readFileSync(join(CLIENT_DIR, file), 'utf8');
    const result = extractTemplate(text);
    if (!result.body) { continue; }  // already reported above

    const nsMatch = result.body.match(/NS\.(\w+) = \{/);
    if (!nsMatch) {
      console.log(`  [NAMESPACE] client/${file}: 未找到 "NS.<name> = {" 导出`);
      errors++;
      continue;
    }
    namespaces.push(`${nsMatch[1]}(${file})`);
    parts.push(result.body);
  }

  // index.ts must not reference a module that no longer exists.
  try {
    const indexText = readFileSync(join(CLIENT_DIR, 'index.ts'), 'utf8');
    const imported = [...indexText.matchAll(/from '\.\/([\w.-]+)'/g)].map((m) => `${m[1]}.ts`);
    for (const f of imported) {
      if (!clientFiles.includes(f)) {
        console.log(`  [MISSING] client/index.ts 引用了不存在的模块 ${f}`);
        errors++;
      }
    }
  } catch { /* index.ts 缺失由 tsc 报 */ }

  if (errors === 0) {
    try {
      // Syntax-only: never executed. `new Function` parses the body eagerly.
      // eslint-disable-next-line no-new-func
      new Function(parts.join('\n'));
      console.log(`  [OK] ${clientFiles.length} 个客户端模块拼接后可解析（${namespaces.join(', ')}）`);
    } catch (e) {
      console.log(`  [SYNTAX] 拼接后的客户端脚本无法解析: ${e.message}`);
      errors++;
    }
  }
}

if (errors > 0) {
  console.log(`  → 共 ${errors} 处问题（常见原因：模板字符串内部出现反引号，或反斜杠未双写）`);
  process.exit(1);
}

const others = moduleFiles.length - clientFiles.length - (existsSync(CLIENT_DIR) ? 1 : 0);
console.log(`  [OK] ${moduleFiles.length} 个模板模块已扫描（client/ 下 ${clientFiles.length} 个做拼接校验，其余 ${others} 个做反引号/闭合检查）`);
process.exit(0);
