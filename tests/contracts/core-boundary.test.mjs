// 约束：core / 外壳分层、注入函数自包含（CONTRIBUTING「core / 外壳分层」「注入函数必须保持自包含」）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CORE_DIR, corePath, coreUrl } from '../helpers/core.mjs';

const CORE_FILES = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort();
const src = (f) => fs.readFileSync(corePath(f), 'utf8');

/** 去掉注释行（与 CONTRIBUTING 里那条 git grep 过滤口径一致：// 与 * 开头的行） */
const codeLines = (text) => text.split('\n')
  .map((line, i) => ({ line, no: i + 1 }))
  .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));

/**
 * 经 chrome.scripting.executeScript({ func }) 整体序列化注入页面的函数。
 * 新增注入函数时在这里登记，约束检查自动覆盖。
 */
const INJECTED = [
  { file: 'snapshot.js', name: 'snapshotPage' },
  { file: 'actions.js', name: 'performAction' },
  { file: 'highlight.js', name: 'highlightElement' },
  { file: 'settle.js', name: 'waitForSettle' },
];

test('core 里没有 chrome.* 调用（注释除外）', () => {
  const hits = [];
  for (const f of CORE_FILES) {
    for (const { line, no } of codeLines(src(f))) if (/\bchrome\./.test(line)) hits.push(`${f}:${no}: ${line.trim()}`);
  }
  assert.deepEqual(hits, []);
});

test('core 只 import core 内部、真实存在的模块', () => {
  const bad = [];
  for (const f of CORE_FILES) {
    for (const m of src(f).matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (!/^\.\/[\w-]+\.js$/.test(spec) || !fs.existsSync(corePath(spec.slice(2)))) bad.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('每个 core 模块都能在 Node 里直接 import（不依赖浏览器扩展环境）', async () => {
  for (const f of CORE_FILES) {
    await assert.doesNotReject(import(coreUrl(f).href), f);
  }
});

for (const { file, name } of INJECTED) {
  test(`注入函数 ${name}：模块里只有这一个顶层声明、没有 import`, () => {
    // 顶格书写的声明即模块级声明；函数体内的一律有缩进
    const top = src(file).split('\n').filter((l) => /^(export\s+)?(async\s+)?(function|const|let|var|class|import)\b/.test(l));
    assert.equal(top.length, 1, top.join('\n'));
    assert.match(top[0], new RegExp(`^export function ${name}\\(`));
  });

  test(`注入函数 ${name}：序列化后能在空白作用域里重新编译`, async () => {
    const fn = (await import(coreUrl(file).href))[name];
    assert.equal(typeof fn, 'function');
    // executeScript 做的就是这件事：取函数源码，在页面里重新求值
    const revived = new Function(`return (${fn.toString()});`)();
    assert.equal(typeof revived, 'function');
    assert.equal(revived.length, fn.length);
  });
}

test('INJECTED 清单没有漏登记：外壳传给 injectFunc 的函数都在清单里', () => {
  const shell = fs.readFileSync(new URL('../sidepanel.js', CORE_DIR), 'utf8');
  const injected = new Set([...shell.matchAll(/\binjectFunc\(\s*[\w.]+\s*,\s*(\w+)/g)].map((m) => m[1]));
  injected.delete('func'); // injectFunc 自身的定义
  assert.ok(injected.size > 0, '没在外壳里找到 injectFunc 的调用，检查方式需要跟着外壳一起改');
  const listed = new Set(INJECTED.map((i) => i.name));
  assert.deepEqual([...injected].filter((n) => !listed.has(n)), []);
});
