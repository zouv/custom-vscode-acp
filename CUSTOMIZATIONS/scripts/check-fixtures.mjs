#!/usr/bin/env node
// Read-only privacy guard for checked-in ACP captures; never inspect user session databases.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { strictEqual } from 'node:assert';
const dir = fileURLToPath(new URL('../../src/test/fixtures/', import.meta.url));
const privatePath = /[a-z]:[\\/]+Users[\\/]+(?!user(?:[\\/]|$)|<[^>]+>)[^\\/"\s]+|\/home\/(?!user(?:\/|$)|<[^>]+>)[^\/"\s]+/i;
const listing = /^[bcdlps-][rwxstST-]{9}[+@.]?\s+\d+\s+(\S+)\s+(\S+)/gm;
const owners = new Set(['user', 'root', 'alice', 'bob', 'nobody', '1000', '0']);
const groups = new Set(['user', 'users', 'root', 'staff', 'nogroup', '1000', '0']);
function hasPrivateIdentity(value) {
  return privatePath.test(value) || [...value.matchAll(listing)].some(m => !owners.has(m[1]) || !groups.has(m[2]));
}
for (const [value, expected] of [
  ['C:/Users/user/project', false], ['C:/Users/fixture-owner/project', true],
  ['C:\\Users\\user\\project', false], ['C:\\Users\\fixture-owner\\project', true],
  ['/home/user/project', false], ['/home/fixture-owner/project', true],
  ['-rw-r--r-- 1 user 1000 12 Nov 1 file.txt', false],
  ['drwxr-xr-x 2 fixture-owner 1000 12 Nov 1 folder', true],
  ['-rw-r--r-- 1 user 99999 12 Nov 1 file.txt', true],
  ['ordinary text without a directory listing', false],
]) { strictEqual(hasPrivateIdentity(value), expected, 'Fixture privacy guard self-check failed (values omitted).'); }
const failures = [];
function check(value, path) {
  if (typeof value === 'string' && hasPrivateIdentity(value)) { failures.push(path); }
  else if (Array.isArray(value)) { value.forEach((v, i) => check(v, path + '[' + i + ']')); }
  else if (value && typeof value === 'object') { for (const [key, v] of Object.entries(value)) { check(v, path + '.' + key); } }
}
for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) { check(JSON.parse(readFileSync(join(dir, name), 'utf8')), name); }
if (failures.length) { console.error('Non-anonymized user paths or listing identities in fixtures (values omitted):\n' + failures.join('\n')); process.exitCode = 1; }
else { console.log('Fixture privacy check passed (user paths, listing identities; 10 guard self-checks).'); }
