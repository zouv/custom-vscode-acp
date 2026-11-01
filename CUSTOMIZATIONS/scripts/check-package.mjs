#!/usr/bin/env node
// Inspect vsce's effective release file list, including ignore negation precedence.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const files = execFileSync(process.execPath, [cli, 'ls'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const bad = files.filter(p => /\.(map|d\.ts)$|^(src|out|node_modules|CUSTOMIZATIONS|\.agents|\.github|\.vscode-test)\//.test(p) || (p.startsWith('dist/') && p !== 'dist/extension.js'));
if (!files.includes('dist/extension.js') || bad.length) { console.error('Invalid VSIX runtime contents:', bad); process.exitCode = 1; }
else { console.log('VSIX contents check passed (' + files.length + ' files; only dist/extension.js is runtime code).'); }
