// core/sandbox-runner.js —— run_javascript 的 Worker 引导代码（平台无关层）
//
// 重要约束：runSandboxedCode 必须保持“完全自包含”（同 snapshot.js 等注入函数）：
// 外壳取它的源码 String(fn)，随每次请求发给沙箱页（extension/sandbox.html），
// 沙箱页把 `(${源码})(self)` 装进 Blob 建 Worker 执行，闭包全部丢失。
// SDK 外壳将来把同一个函数塞进自己的沙箱 iframe。
//
// 隔离由运行环境保证：沙箱页运行在不透明源里、拿不到扩展 API，
// manifest 给它的 CSP 是 connect-src 'none'，Worker 继承这份 CSP，fetch / XHR / WebSocket
// 一律被拦；Worker 里也没有 RTCPeerConnection 与 DOM。本函数只管执行与收集输出。

/**
 * 在 Worker 全局作用域里调用一次：等第一条消息，运行其中的代码，回一条结果后结束。
 * 消息形状 { code, tables, strings }：
 *   code     用户代码，作为 async 函数体执行（可用 await；return 的值也会输出）
 *   tables   已脱敏的页面表格，二维字符串数组的数组，代码里以 tables[0]、tables[1] 读取
 *   strings  外壳按当前语言传入的文案（本函数不能 import core/i18n.js），缺省用中文
 * 回包 { stdout, stderr, exitCode }：exitCode 0 为正常结束，1 为抛出异常。
 * stdout 与 stderr 各自超过 OUTPUT_LIMIT 字时保留头尾、中间注明省略了多少字。这一刀只为限住
 * Worker 内存与回包大小：发给模型的结果另由 core/format.js 的 clipMiddle 截到 BUDGETS.code
 * （远小于这里），这一刀的切点落在 clipMiddle 省略掉的中段里，不必讲究切在哪。
 * @param {object} scope Worker 的全局对象（self）
 */
export function runSandboxedCode(scope) {
  const OUTPUT_LIMIT = 65536;
  const HALF = OUTPUT_LIMIT / 2;

  // 输出缓冲：头部攒满 HALF 字后，只滚动保留最近的 HALF 字。
  // 代码在循环里打印上百万行时，内存也不会跟着涨
  function buffer() {
    let head = '';
    let tail = '';
    let total = 0;
    return {
      append(s) {
        total += s.length;
        if (head.length < HALF) {
          const room = HALF - head.length;
          head += s.slice(0, room);
          s = s.slice(room);
        }
        if (!s) return;
        tail += s;
        if (tail.length > 2 * HALF) tail = tail.slice(-HALF);
      },
      done(omitted) {
        if (total <= OUTPUT_LIMIT) return head + tail;
        return head + omitted.replace('{n}', String(total - OUTPUT_LIMIT)) + tail.slice(-HALF);
      },
    };
  }

  // JSON 会把 NaN / Infinity 写成 null、把 Map / Set 写成 {}：模型会把算坏了的结果读成「缺值」，
  // 数字因此按 String 打印，嵌套在对象里的也照此换掉
  const plain = (k, x) => {
    if ((typeof x === 'number' && !Number.isFinite(x)) || typeof x === 'bigint') return String(x);
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Set) return [...x];
    return x;
  };

  function show(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') return String(v);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      const json = JSON.stringify(v, plain);
      return json === undefined ? String(v) : json;
    } catch {
      return String(v);
    }
  }

  function errorText(e) {
    if (e && typeof e === 'object' && 'message' in e) return `${e.name || 'Error'}: ${e.message}`;
    return `Uncaught ${show(e)}`;
  }

  scope.onmessage = async (ev) => {
    scope.onmessage = null; // 一个 Worker 只跑一次
    const msg = ev.data || {};
    const S = Object.assign({ outputOmitted: '\n……（中间省略 {n} 字）……\n' }, msg.strings || {});
    const out = buffer();
    const err = buffer();
    const line = (args) => Array.prototype.map.call(args, show).join(' ') + '\n';
    const print = (...args) => out.append(line(args));
    const console = scope.console || {};
    console.log = console.info = console.debug = print;
    console.warn = console.error = (...args) => err.append(line(args));
    // 回调里抛出的异常不会冒到 await 上：记进错误输出，代码主体照常跑完
    scope.onerror = (message) => { err.append(String(message) + '\n'); return true; };
    scope.onunhandledrejection = (e) => { err.append(errorText(e.reason) + '\n'); e.preventDefault(); };

    let exitCode = 0;
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const value = await new AsyncFunction('tables', 'print', String(msg.code || ''))(msg.tables || [], print);
      if (value !== undefined) print(value);
    } catch (e) {
      exitCode = 1;
      err.append(errorText(e) + '\n');
    }
    scope.postMessage({ stdout: out.done(S.outputOmitted), stderr: err.done(S.outputOmitted), exitCode });
  };
}
