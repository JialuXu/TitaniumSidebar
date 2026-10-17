// sandbox.js —— 代码沙箱页的脚本（经典脚本，运行在 manifest 声明的 sandbox 页里）
//
// 只做三件事：收到请求后用 Blob 建 Worker 运行代码、转发 Worker 的结果、超时 terminate()。
// 代码跑在 Worker 里而不是本页主线程：死循环卡不住本页，超时一定终止得了。
// 本页运行在不透明源里、拿不到扩展 API；Worker 继承本页的 CSP（connect-src 'none'），出不了网。
//
// 协议（与 extension/sandbox-host.js 对应，targetOrigin 只能写 '*'：本页的源是 null）：
//   本页 → 宿主  { type: 'ready' }                                   加载完成
//   宿主 → 本页  { type: 'run', id, runner, code, tables, timeoutMs, strings }
//   宿主 → 本页  { type: 'cancel', id }                              用户点了停止
//   本页 → 宿主  { id, stdout, stderr, exitCode } | { id, timedOut: true } | { id, error }
'use strict';

const running = new Map(); // id → { worker, timer, url }

// 回包里输出的长度上限，只拦绕过引导代码、自己调 postMessage 回的超大结果：几百兆的字符串
// 原样转给侧边栏会把它拖垮，这种结果整个作废。刻意比引导代码的截断上限（64K 字）高出一个量级，
// 调整那边的上限不必回来改这里
const MAX_OUTPUT = 1 << 20;

function stop(id) {
  const job = running.get(id);
  if (!job) return;
  clearTimeout(job.timer);
  job.worker.terminate();
  URL.revokeObjectURL(job.url);
  running.delete(id);
}

function reply(id, msg) {
  stop(id);
  parent.postMessage({ id, ...msg }, '*');
}

addEventListener('message', (e) => {
  // 只认宿主（侧边栏）发来的消息
  if (e.source !== parent) return;
  const msg = e.data || {};
  if (msg.type === 'cancel') {
    stop(msg.id);
    return;
  }
  if (msg.type !== 'run') return;

  const { id } = msg;
  const url = URL.createObjectURL(new Blob([`(${msg.runner})(self);`], { type: 'text/javascript' }));
  let worker;
  try {
    worker = new Worker(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    parent.postMessage({ id, error: String((err && err.message) || err) }, '*');
    return;
  }
  const timer = setTimeout(() => reply(id, { timedOut: true }), msg.timeoutMs);
  running.set(id, { worker, timer, url });
  worker.onmessage = (ev) => {
    const r = ev.data || {};
    const stdout = typeof r.stdout === 'string' ? r.stdout : '';
    const stderr = typeof r.stderr === 'string' ? r.stderr : '';
    if (stdout.length > MAX_OUTPUT || stderr.length > MAX_OUTPUT) {
      reply(id, { error: 'oversized result' });
      return;
    }
    reply(id, { stdout, stderr, exitCode: Number(r.exitCode) || 0 });
  };
  // 引导代码自己没接住的错误（正常情况下不会发生：用户代码的异常由引导代码收进 stderr）
  worker.onerror = (ev) => {
    ev.preventDefault();
    reply(id, { error: ev.message || 'worker error' });
  };
  worker.postMessage({ code: msg.code, tables: msg.tables, strings: msg.strings });
});

parent.postMessage({ type: 'ready' }, '*');
