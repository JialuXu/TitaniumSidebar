// core/sandbox-runner.js —— run_javascript 的 Worker 引导代码（验收标准第 39 条）
//
// 引导代码只依赖传进来的全局对象，这里给它一个假的 scope，在 Node 里直接跑。
// 隔离（不透明源、CSP、Worker）由运行环境保证，见 tests/dom/sandbox.test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSandboxedCode } from '../../extension/core/sandbox-runner.js';

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'];

/**
 * 假的 Worker 全局对象：发一条消息、等回一条结果。
 * 用户代码由 AsyncFunction 编译，里面的 console 是真正的全局 console（Worker 里 scope 就是 self），
 * 所以 scope.console 也给全局那个，跑完把方法换回来。
 */
async function run(code, tables = [], strings) {
  const saved = Object.fromEntries(CONSOLE_METHODS.map((k) => [k, console[k]]));
  try {
    return await new Promise((resolve) => {
      const scope = { console, postMessage: resolve };
      runSandboxedCode(scope);
      scope.onmessage({ data: { code, tables, strings } });
    });
  } finally {
    Object.assign(console, saved);
  }
}

test('print、console.log 与 return 的值都进输出，对象按 JSON 打印', async () => {
  const r = await run(`print('a', 1, { x: [1, 2] }); console.log('b'); return 42`);
  assert.deepEqual(r, { stdout: 'a 1 {"x":[1,2]}\nb\n42\n', stderr: '', exitCode: 0 });
});

test('NaN、Infinity 照原样打印，Map 与 Set 打印出内容：算坏了的结果不能读成 null 或空对象', async () => {
  const r = await run(`print(0 / 0, 1 / 0, -1 / 0); print([1, NaN], { avg: NaN }); print(new Map([['a', 1]]), new Set([2])); return NaN`);
  assert.equal(r.stdout, 'NaN Infinity -Infinity\n[1,"NaN"] {"avg":"NaN"}\n{"a":1} [2]\nNaN\n');
});

test('表格经 tables 传入，代码可以 await', async () => {
  const r = await run(`await null; print(Number(tables[0][1][0]) * 2)`, [[['金额'], ['21']]]);
  assert.equal(r.stdout, '42\n');
});

test('抛出的异常与语法错误进错误输出，退出码 1；之前的输出保留', async () => {
  const thrown = await run(`print('before'); throw new RangeError('boom')`);
  assert.deepEqual(thrown, { stdout: 'before\n', stderr: 'RangeError: boom\n', exitCode: 1 });
  const syntax = await run('this is not js');
  assert.equal(syntax.exitCode, 1);
  assert.match(syntax.stderr, /^SyntaxError: /);
  const odd = await run(`throw 'plain string'`);
  assert.equal(odd.stderr, 'Uncaught plain string\n');
});

test('console.warn / console.error 进错误输出，不影响退出码', async () => {
  const r = await run(`console.warn('w'); console.error('e'); print('ok')`);
  assert.deepEqual(r, { stdout: 'ok\n', stderr: 'w\ne\n', exitCode: 0 });
});

test('超长输出保留头尾，中间注明省略了多少字', async () => {
  const r = await run(`for (let i = 0; i < 20000; i++) print('line ' + i)`, [], { outputOmitted: '<省略 {n} 字>' });
  let total = 0;
  for (let i = 0; i < 20000; i++) total += `line ${i}\n`.length;
  const m = r.stdout.match(/<省略 (\d+) 字>/);
  assert.ok(m);
  assert.ok(r.stdout.startsWith('line 0\n'));
  assert.ok(r.stdout.endsWith('line 19999\n'), '结论常在末尾，尾部必须保留');
  assert.ok(r.stdout.length < 65536 + 100);
  assert.equal(r.stdout.length - m[0].length + Number(m[1]), total);
});

test('只运行第一条消息', async () => {
  let posts = 0;
  const scope = { console: {}, postMessage: () => { posts++; } };
  runSandboxedCode(scope);
  const first = scope.onmessage;
  await first({ data: { code: 'return 1' } });
  assert.equal(scope.onmessage, null);
  assert.equal(posts, 1);
});
