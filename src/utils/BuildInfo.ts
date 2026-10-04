// [CUSTOM-BEGIN] CUSTOM-20261002-173 - 运行时构建指纹：让日志能回答"这个窗口/这个 webview 跑的是哪份代码"。
//
// **为什么需要它**（2026-10-02「表单选项说明丢了」排查的真实卡点）：
// 那次两边都证明过"代码是对的"——报文里选项带 `description`（日志原文）、当前客户端也确实把它
// 渲染成灰字第二行（无头截图）。可用户在自己的窗口里就是看不到。要判定"是不是那个窗口跑的是
// 旧构建"，我手里只有**间接**证据：宿主 04:08 之后没重启过、客户端代码 12:05 才重新编译。
// 而"04:08 载入的那份 dist 里有没有这段代码"**无从查证**：未提交的中间态已经不存在，日志里也读
// 不到客户端收到的字段形状。**缺的就是这个指纹**。
//
// 三个部分各自回答一个问题：
//   · `v<version>`   —— package.json 的版本（README 的 frontmatter 口径），对齐"插件版本号"。
//   · `<git sha>`    —— 由 webpack DefinePlugin 在**打包时**注入（`--dirty` 表示打包时工作区不干净），
//                       回答"这份代码对应哪个提交"。没有它时是 `unknown`（如 tsc 产物 out/）。
//   · `<打包时间>`   —— 同样是打包时注入，回答"什么时候编的"。
//   · `<bundle 哈希>` —— 运行时对 `__filename`（打包产物 dist/extension.js）取 sha256 前 12 位。
//                       它是**唯一真正识别代码**的那一项：同一个版本、同一天编两次，哈希不同。
//
// 用法（两处，缺一不可）：
//   宿主：`extension.ts` 激活时写进日志 → 知道**宿主进程**载入的是哪份代码。
//   客户端：`html/body.ts` 把指纹写进 `<body data-acpc-build>`，客户端 boot 的第一条日志把它
//   报出来 → 知道**这个 webview 拿到的文档**是哪次渲染生成的。两者对照即可判定：
//   哈希=当前构建 → 跑的是当前代码；哈希是旧值 → 旧构建；日志里压根没有这行 → 窗口根本没重载。
//
// **不要 import `vscode`**：本模块也被无头预览（`preview-records.mjs` 直接 require
// `out/ui/chat/html/body.js`）与单元测试在裸 node 下加载，一旦牵进 vscode 就会在那里炸。
// 版本号因此走"从 __dirname 往上找 package.json"，全程 try/catch，**任何一步失败都不许抛**。
// [CUSTOM-END] CUSTOM-20261002-173
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

// 打包时由 webpack DefinePlugin 注入（见 webpack.config.js）。tsc 产物 out/ 里不存在，
// 所以只能 `typeof` 判断——不能直接引用，那会 ReferenceError。
declare const __ACPC_BUILD_GIT__: string | undefined;
declare const __ACPC_BUILD_TIME__: string | undefined;

const UNKNOWN = 'unknown';
/**
 * 指纹是给日志和 HTML 属性看的，只保留我们**故意使用**的字符（`·` 分隔、`()` 包字节数）。
 * 其余一律换成 `_` —— 版本号/git 描述来自外部，不该有机会把属性或日志行弄坏。
 */
const SAFE = /[^A-Za-z0-9._+:()·-]/g;

let cached: string | undefined;

/**
 * 本份代码的构建指纹，形如 `v0.2.0-custom.6·a1b2c3d·2026-10-02T12:05:00.000Z·9f3e1a2b4c5d`。
 *
 * 第一次调用时算好并缓存（要读一次打包产物算哈希，约几毫秒）。
 */
export function buildStamp(): string {
  if (cached === undefined) { cached = compute(); }
  return cached;
}

function compute(): string {
  const parts = [versionPart(), injectedGit(), injectedTime(), bundleHash()];
  return sanitize(parts.join('·'));
}

function versionPart(): string {
  const version = readPackageVersion();
  return version === '' ? `v${UNKNOWN}` : `v${version}`;
}

/** 从 __dirname 往上最多两级找 package.json —— 兼容 dist/（webpack 单文件）与 out/**（tsc 产物）。 */
function readPackageVersion(): string {
  try {
    for (const hops of [['..'], ['..', '..']]) {
      try {
        const raw = readFileSync(join(__dirname, ...hops, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch { /* 这一级没有/不是包描述，试下一级 */ }
    }
  } catch { /* 读不动就算了 */ }
  return '';
}

function injectedGit(): string {
  try {
    return typeof __ACPC_BUILD_GIT__ === 'string' && __ACPC_BUILD_GIT__ !== ''
      ? __ACPC_BUILD_GIT__ : UNKNOWN;
  } catch { return UNKNOWN; }
}

function injectedTime(): string {
  try {
    return typeof __ACPC_BUILD_TIME__ === 'string' && __ACPC_BUILD_TIME__ !== ''
      ? __ACPC_BUILD_TIME__ : UNKNOWN;
  } catch { return UNKNOWN; }
}

/**
 * 打包产物的内容指纹：sha256 前 12 位。它比版本号/时间都可靠 —— 同一版本重新编译后
 * 只有它变化，而"运行中的窗口是不是当前代码"正是靠比对它来回答的。
 */
function bundleHash(): string {
  try {
    const bytes = readFileSync(__filename);
    const size = statSync(__filename).size;
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return `${digest}(${size}B)`;
  } catch { return UNKNOWN; }
}

function sanitize(text: string): string {
  return text.replace(SAFE, '_').slice(0, 160);
}
