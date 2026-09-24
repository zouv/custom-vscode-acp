#!/usr/bin/env node
// =============================================================================
// check-registry.mjs — 自定义开发机制的完整性自检（六节）
//   1) 代码里有 CUSTOM 标记但 registry.md 改动总览未登记
//   2) 总览表登记的文件但代码里找不到对应标记
//   3) 命名空间卫生：src/ 与 package.json 不应残留上游 acp.* 标识符
//   4) 换行符卫生：上游共有文件 CRLF、纯自定义文件 LF
//   5) webview 客户端脚本：模板字符串拼接后能否解析
//   6) 源码卫生：不得含 NUL 等控制字符（含 NUL 的文件会被 grep 当二进制跳过）
//
// 用法：node CUSTOMIZATIONS/scripts/check-registry.mjs
// 退出码：0 全部一致；1 有差异（按提示修文档或补标记）
//
// 为什么用 Node 而不是 bash（重要，别改回去）：
//   原 bash 版用了 declare -A（关联数组），而 **macOS 自带 bash 3.2** 不支持它，
//   在 macos-latest runner 上直接 `declare: -A: invalid option` 失败。
//   本项目强依赖 Node（npm install 是前置步骤），用 Node 实现可以在
//   Windows / Linux / macOS 上行为完全一致，彻底消除 shell 方言问题。
// =============================================================================
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..', '..');
const REGISTRY = join(PROJECT_ROOT, 'CUSTOMIZATIONS', 'registry.md');

const toPosix = (p) => p.split(sep).join('/');

// ---------------------------------------------------------------------------
// 收集代码中的 CUSTOM 标记：相对路径 -> Set(change-id)
// 排除：测试文件（不强制标记）、node_modules、release/dist 产物
// ---------------------------------------------------------------------------
const MARKER_INCLUDE = /\.(ts|tsx|sh|json|yml|yaml)$|\.gitignore$|\.vscodeignore$/;
const MARKER_ROOTS = ['src', 'CUSTOMIZATIONS', '.github'];
const MARKER_EXTRA_FILES = ['.gitignore', '.vscodeignore'];
const MARKER_SKIP_DIR = /(^|\/)(node_modules|dist|out|release|\.git|\.vscode-test)(\/|$)/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = toPosix(relative(PROJECT_ROOT, full));
    if (MARKER_SKIP_DIR.test(rel)) continue;
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const codeMarkers = new Map(); // relPath -> Set(id)
const collect = (abs) => {
  const rel = toPosix(relative(PROJECT_ROOT, abs));
  if (rel.includes('node_modules') || MARKER_SKIP_DIR.test(rel)) return;
  if (/\.test\./.test(rel)) return;              // 测试文件不要求标记
  if (rel.endsWith('registry.md')) return;        // 账本自身引用了标记语法
  if (!MARKER_INCLUDE.test(rel)) return;

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('CUSTOM-BEGIN')) continue;
    const m = line.match(/CUSTOM-(\d{8}-\d{3})/);
    if (!m) continue;
    if (!codeMarkers.has(rel)) codeMarkers.set(rel, new Set());
    codeMarkers.get(rel).add(`CUSTOM-${m[1]}`);
  }
};

for (const root of MARKER_ROOTS) {
  for (const abs of walk(join(PROJECT_ROOT, root))) collect(abs);
}
for (const f of MARKER_EXTRA_FILES) {
  const abs = join(PROJECT_ROOT, f);
  if (existsSync(abs)) collect(abs);
}

// ---------------------------------------------------------------------------
// 解析 registry.md 的「改动总览」表
//   docFiles    : Set(精确路径)  —— 参与 §2 严格校验
//   docPrefixes : Set(目录前缀)  —— 聚合行 / 通配行，仅参与 §1 前缀匹配
//   含「未改动 / 非改动」的整行是"故意保留"的说明行，跳过
// ---------------------------------------------------------------------------
const docFiles = new Set();
const docPrefixes = new Set();

const registryText = readFileSync(REGISTRY, 'utf8');
let inTable = false;
for (const line of registryText.split('\n')) {
  if (line.startsWith('## 改动总览')) { inTable = true; continue; }
  if (line.startsWith('## 变更日志')) break;
  if (!inTable || !line.startsWith('|')) continue;
  if (line.includes('未改动') || line.includes('非改动')) continue;

  const cell = line.split('|')[1] ?? '';
  const file = cell.trim();
  if (!file || file.startsWith('文件') || file.startsWith('--')) continue;

  if (file.includes('（') || file.includes('*')) {
    let prefix = file.split('（')[0].split('*')[0].trim();
    if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    if (prefix) docPrefixes.add(prefix);
    continue;
  }
  for (const p of file.split('、').map((s) => s.trim()).filter(Boolean)) {
    docFiles.add(p);
  }
}

const isDocRegistered = (rel) => {
  if (docFiles.has(rel)) return true;
  for (const doc of docFiles) {
    if (doc.includes('*') && rel.startsWith(doc.split('*')[0])) return true;
  }
  for (const prefix of docPrefixes) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// §1 代码有标记但总览未登记
// ---------------------------------------------------------------------------
let errors = 0;
console.log('== 1) 代码里有 CUSTOM 标记但总览表未登记（或路径写法对不上）==');
let missing = 0;
for (const [rel, ids] of [...codeMarkers].sort()) {
  if (isDocRegistered(rel)) continue;
  console.log(`  [MISSING-IN-DOC] ${rel}  (标记: ${[...ids].sort().join(' ')})`);
  missing++;
}
if (missing === 0) console.log('  (全部已登记)');
errors += missing;

// ---------------------------------------------------------------------------
// §2 总览登记的文件必须有对应代码标记
// ---------------------------------------------------------------------------
console.log('\n== 2) 总览表登记的文件但代码里找不到对应标记 ==');
const isCustomOnly = (p) =>
  p.startsWith('CUSTOMIZATIONS/') ||
  p.startsWith('.agents/') ||
  p === 'AGENTS.md' ||
  p === '.gitignore' ||
  p === '.vscodeignore' ||
  p === 'package.json' ||
  p === 'package-lock.json' ||
  p === '.gitattributes' ||
  /\.test\./.test(p);

let notFound = 0;
for (const doc of [...docFiles].sort()) {
  if (isCustomOnly(doc)) continue;
  const abs = join(PROJECT_ROOT, doc);
  if (!existsSync(abs)) {
    console.log(`  [FILE-NOT-FOUND] ${doc}`);
    notFound++;
    continue;
  }
  if (!readFileSync(abs, 'utf8').includes('CUSTOM-BEGIN')) {
    console.log(`  [NO-MARKER] ${doc}（若确属无标记的已知缺口，请在总览标注「已知无标记缺口」）`);
    notFound++;
  }
}
if (notFound === 0) console.log('  (全部匹配)');
errors += notFound;

// ---------------------------------------------------------------------------
// §3 命名空间卫生（只查"全局可冲突标识符"的典型形态）
// ---------------------------------------------------------------------------
console.log('\n== 3) 命名空间卫生：src/ 与 package.json 不应残留上游 acp.* 标识符 ==');
const NS_PATTERNS = [
  /registerCommand\('acp\./,
  /executeCommand\('acp\./,
  /getConfiguration\('acp'\)/,
  /createTreeView\('acp-/,
  /createOutputChannel\('ACP Client'\)/,
  /createOutputChannel\('ACP Traffic'\)/,
  /'acp-sessions'/,
  /'acp-chat'/,
  /== acp-sessions/,
  /== acp-chat/,
  /command:acp\./,
];
let nsHits = 0;
const nsTargets = [
  ...walk(join(PROJECT_ROOT, 'src')),
  join(PROJECT_ROOT, 'package.json'),
];
for (const abs of nsTargets) {
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const rel = toPosix(relative(PROJECT_ROOT, abs));
  text.split('\n').forEach((line, i) => {
    if (NS_PATTERNS.some((re) => re.test(line))) {
      console.log(`  [NS-RESIDUE] ${rel}:${i + 1}: ${line.trim()}`);
      nsHits++;
    }
  });
}
if (nsHits === 0) console.log('  (无残留)');
errors += nsHits;

// ---------------------------------------------------------------------------
// §4 换行符卫生（委托给 normalize-eol.mjs --check）
// ---------------------------------------------------------------------------
console.log('\n== 4) 换行符卫生：上游共有文件必须为 CRLF（纯自定义文件保持 LF）==');
try {
  const out = execFileSync(
    process.execPath,
    [join(PROJECT_ROOT, 'CUSTOMIZATIONS', 'scripts', 'normalize-eol.mjs'), '--check'],
    { encoding: 'utf8' },
  );
  console.log('  ' + out.trim().split('\n').pop());
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  for (const line of out.split('\n')) {
    if (line.includes('[LF]')) console.log(`  [EOL-RESIDUE]${line.slice(line.indexOf('[LF]') + 4)}`);
  }
  console.log('  → 运行 node CUSTOMIZATIONS/scripts/normalize-eol.mjs 修正');
  errors += 1;
}

// ---------------------------------------------------------------------------
// §5 webview 客户端脚本卫生（委托给 check-webview-client.mjs）
// ---------------------------------------------------------------------------
console.log('\n== 5) webview 客户端脚本：模板字符串拼接后能否解析 ==');
try {
  const out = execFileSync(
    process.execPath,
    [join(PROJECT_ROOT, 'CUSTOMIZATIONS', 'scripts', 'check-webview-client.mjs')],
    { encoding: 'utf8' },
  );
  console.log('  ' + out.trim());
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  for (const line of out.split('\n')) {
    if (line.trim().startsWith('[')) { console.log('  ' + line.trim()); }
  }
  errors += 1;
}

// ---------------------------------------------------------------------------
// §6 源码卫生：不得含 NUL 等控制字符
// 危害：文件一旦含 NUL，`grep` 会把它当**二进制**处理并跳过，搜索工具静默失效。
// 来源：编辑器/工具写入时把 `\0` 这类转义落成了真实控制字节（本仓库实际发生过，
// CUSTOM-20260923-011 的 ChatPanelHost.ts 注释里混入 2 个 NUL）。
// ---------------------------------------------------------------------------
console.log('\n== 6) 源码卫生：不得含 NUL 等控制字符 ==');
// 按码点判断而不是嵌字面控制字符的正则——否则检查脚本自己就带控制字符（本行上一版就踩了）。
const isBadControl = (code) => code === 0 || code < 9 || (code > 13 && code < 32);
let ctlHits = 0;
const ctlTargets = [...walk(join(PROJECT_ROOT, 'src')), ...walk(join(PROJECT_ROOT, 'CUSTOMIZATIONS', 'scripts'))];
for (const abs of ctlTargets) {
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isBadControl(code)) continue;
    const line = text.slice(0, i).split('\n').length;
    const hex = code.toString(16).padStart(2, '0');
    console.log(`  [CTRL-BYTE] ${toPosix(relative(PROJECT_ROOT, abs))}:${line}: 0x${hex}`);
    ctlHits++;
    break;
  }
}
if (ctlHits === 0) console.log('  (无控制字符)');
errors += ctlHits;


// ---------------------------------------------------------------------------
console.log('');
if (errors === 0) {
  console.log(`[OK] 代码标记与改动总览一致（${codeMarkers.size} 个含标记文件均已登记；命名空间无残留；换行符一致）`);
  process.exit(0);
}
console.log(`[DIFF] 发现 ${errors} 处不一致——修文档（路径写法对齐）或补代码标记后重跑`);
process.exit(1);
