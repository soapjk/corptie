import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const nativePath = join(__dirname, '..', 'native', 'corptie_native.node');

// .node 产物由 `npm run build:native` 生成（已被 .gitignore 忽略）。
// 新 clone 环境尚未构建时优雅跳过，避免 `npm test` 因缺产物而整体失败。
const native = existsSync(nativePath) ? require(nativePath) : null;
const skip = native ? false : 'native 模块未构建（先运行 npm run build:native）';

test('levenshteinDistance：等长替换', { skip }, () => {
  assert.equal(native.levenshteinDistance('kitten', 'sitting'), 3);
});

test('levenshteinDistance：空串边界', { skip }, () => {
  assert.equal(native.levenshteinDistance('', 'abc'), 3);
  assert.equal(native.levenshteinDistance('abc', ''), 3);
});

test('levenshteinDistance：相同串为 0', { skip }, () => {
  assert.equal(native.levenshteinDistance('abc', 'abc'), 0);
});

test('levenshteinDistance：按 Unicode 字符计（中文）', { skip }, () => {
  assert.equal(native.levenshteinDistance('你好', '你好吗'), 1);
});
