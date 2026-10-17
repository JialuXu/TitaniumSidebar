// 代码沙箱在真实 Chromium 里的隔离与恢复（验收标准第 39 条）
//
// 沙箱页的不透明源与 CSP 只有作为扩展加载时才生效，这里把 extension/ 整个拷进临时目录，
// 另放一张宿主页（harness.html）扮演侧边栏：它用真实的 sandbox-host.js 与 Worker 引导代码，
// 走的是与侧边栏同一条路。侧边栏只能由用户手势打开，所以用同一扩展的普通标签页代替。
// 加载扩展要用完整版 Chromium（channel: 'chromium'）；没装 Playwright 时整体跳过。

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EXTENSION_DIR } from '../helpers/core.mjs';
import { loadPlaywright } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

const HARNESS_HTML = '<!doctype html><meta charset="utf-8"><script type="module" src="harness.js"></script>';
const HARNESS_JS = `
import { createSandboxHost } from './sandbox-host.js';
import { runSandboxedCode } from './core/sandbox-runner.js';
const host = createSandboxHost({ src: 'sandbox.html', runner: String(runSandboxedCode) });
window.run = (code, { tables = [], timeoutMs = 5000, abortAfter = 0 } = {}) => {
  const controller = new AbortController();
  if (abortAfter) setTimeout(() => controller.abort(), abortAfter);
  return host.run({ code, tables, timeoutMs, strings: {}, signal: controller.signal });
};
// 宿主主线程的心跳：代码跑死循环时侧边栏是否还能响应
window.ticks = 0;
setInterval(() => { window.ticks++; }, 50);
`;

describe('代码沙箱（真实扩展）', { skip: !playwright && '未安装 playwright' }, () => {
  let dir;
  let context;
  let page;
  let worker;
  let server;
  let base;
  const hits = [];

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titanium-sandbox-'));
    const ext = path.join(dir, 'extension');
    fs.cpSync(fileURLToPath(EXTENSION_DIR), ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'harness.html'), HARNESS_HTML);
    fs.writeFileSync(path.join(ext, 'harness.js'), HARNESS_JS);

    // 本机服务：记下收到的每一个请求，验证代码出不了网
    server = http.createServer((req, res) => { hits.push(req.url); res.end('print("reached")'); });
    server.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    context = await playwright.chromium.launchPersistentContext(path.join(dir, 'profile'), {
      channel: 'chromium',
      headless: true,
      // 压低 V8 堆上限，内存爆掉那条用例几百兆就触发，不必真吃到几个 G
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--js-flags=--max-old-space-size=256'],
    });
    [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/harness.html`);
    await page.waitForFunction(() => typeof window.run === 'function');
  });

  after(async () => {
    if (context) await context.close();
    if (server) server.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (code, opts) => page.evaluate(([c, o]) => window.run(c, o), [code, opts || {}]);

  test('代码在 Worker 里运行：源是 null、拿不到扩展 API，表格经 tables 传入', async () => {
    const r = await run(`print(self.origin, typeof chrome === 'undefined' || !chrome.runtime); return tables[0][1][1] * 2`, {
      tables: [[['名称', '数量'], ['甲', '21']]],
    });
    assert.deepEqual(r, { stdout: 'null true\n42\n', stderr: '', exitCode: 0 });
  });

  test('出网通道全部被 CSP 拦下，本机服务一个请求都收不到；WebRTC 不存在', async () => {
    const attempts = {
      fetch: `await fetch('${base}/fetch?d=secret')`,
      noCors: `await fetch('${base}/no-cors', { mode: 'no-cors' })`,
      xhr: `const x = new XMLHttpRequest(); x.open('GET', '${base}/xhr', false); x.send()`,
      importScripts: `importScripts('${base}/script.js')`,
      worker: `new Worker('${base}/worker.js')`,
      websocket: `const ws = new WebSocket('${base.replace('http', 'ws')}/ws');
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws blocked')); })`,
      eventSource: `const es = new EventSource('${base}/es');
        await new Promise((resolve, reject) => { es.onopen = resolve; es.onerror = () => reject(new Error('es blocked')); })`,
      nestedBlobWorker: `const w = new Worker(URL.createObjectURL(new Blob(["fetch('${base}/nested').then(() => postMessage('reached'), (e) => postMessage('blocked'))"])));
        const answer = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); });
        if (answer === 'blocked') throw new Error('blocked')`,
    };
    for (const [name, code] of Object.entries(attempts)) {
      const r = await run(code);
      assert.equal(r.exitCode, 1, `${name} 应当失败：${r.stdout}`);
    }
    const webrtc = await run(`print(typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof WebTransport)`);
    assert.equal(webrtc.stdout, 'undefined undefined undefined\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(hits, []);
  });

  test('死循环按时终止，期间宿主照常响应，随后照常运行', async () => {
    const before = await page.evaluate(() => window.ticks);
    const started = Date.now();
    const r = await run('while (true) {}', { timeoutMs: 2000 });
    assert.deepEqual(r, { timedOut: true });
    assert.ok(Date.now() - started < 3500);
    assert.ok(await page.evaluate(() => window.ticks) - before >= 30, '宿主心跳没停');
    assert.equal((await run(`print('alive')`)).stdout, 'alive\n');
  });

  test('停止：正在运行的代码立即终止，随后照常运行', async () => {
    const started = Date.now();
    assert.deepEqual(await run('while (true) {}', { abortAfter: 200 }), { aborted: true });
    assert.ok(Date.now() - started < 1500);
    assert.equal((await run(`print('alive')`)).stdout, 'alive\n');
  });

  // Chrome 124 起沙箱 iframe 才是独立进程；更早的版本上侧边栏会一起崩溃（Playwright 自带的 Chromium 远高于此）
  test('内存爆掉：崩的只是沙箱，兜底后重建，宿主与后台都不受影响', async () => {
    const r = await run('const a = []; for (;;) a.push(new Array(1e6).fill(a.length));', { timeoutMs: 3000 });
    assert.ok(r.crashed || r.timedOut, JSON.stringify(r));
    assert.equal(await page.evaluate(() => 1 + 1), 2);
    assert.equal(await worker.evaluate(() => 1 + 1), 2);
    assert.equal((await run(`print('alive')`)).stdout, 'alive\n');
  });

  test('代码绕过引导代码、自己回一个超长结果：整个作废，随后照常运行', async () => {
    const r = await run(`postMessage({ stdout: 'x'.repeat(5e6), stderr: '', exitCode: 0 }); await new Promise(() => {})`);
    assert.deepEqual(r, { error: 'oversized result' });
    assert.equal((await run(`print('alive')`)).stdout, 'alive\n');
  });

  test('5 张 × 5 万字的表格一秒内送达', async () => {
    const tables = Array.from({ length: 5 }, () => Array.from({ length: 5000 }, (_, i) => Array.from({ length: 10 }, (_, j) => String((i + j) % 10))));
    const started = Date.now();
    const r = await run('print(tables.map((t) => t.length * t[0].length).join())', { tables });
    assert.equal(r.stdout, '50000,50000,50000,50000,50000\n');
    assert.ok(Date.now() - started < 1000);
  });
});
