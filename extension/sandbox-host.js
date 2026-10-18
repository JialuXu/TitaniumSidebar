// sandbox-host.js —— 代码沙箱的宿主端（扩展外壳）：管理隐藏的 sandbox.html iframe，按请求 id 收发
//
// run_javascript 经 provider.runCode 走到这里，代码在沙箱页的 Worker 里运行（见 sandbox.js）。
// 沙箱页的源是 null，postMessage 的 targetOrigin 只能写 '*'，所以发出去的只有代码与已脱敏的表格；
// 回包只认这个 iframe 发来、且 id 对得上的那一条。
//
// 两道超时：沙箱页按 timeoutMs 终止 Worker 并回包「超时」；宿主在请求发出时另设 timeoutMs + 1 秒兜底，
// 与沙箱页的计时同时起跑（沙箱页迟迟加载不起来时，从调用起算同样的时长）。
// 内存爆掉时，Chrome 124 起崩的只是沙箱 iframe 所在的进程，侧边栏不受影响，但崩掉的 iframe 不会再回包，
// 也不会自行恢复——兜底到点就销毁它，下一次执行重新建一个。124 以前沙箱 iframe 与侧边栏同一进程，
// 会一起崩溃，这里救不回来。
// iframe 在第一次执行时才建：多数会话用不到它。

const FALLBACK_MS = 1000;

/**
 * @param {{ src: string, runner: string, container?: HTMLElement }} o
 *   src     沙箱页地址
 *   runner  Worker 引导代码的源码（String(runSandboxedCode)，见 core/sandbox-runner.js）
 *   container  iframe 挂在哪里，缺省 document.body
 */
export function createSandboxHost({ src, runner, container }) {
  let frame = null;
  let ready = null;
  let unlisten = null; // 摘掉等 ready 的监听：沙箱页没加载起来就被销毁时，监听不能留在 window 上
  let seq = 0;

  function mount() {
    const el = document.createElement('iframe');
    el.hidden = true;
    el.src = src;
    ready = new Promise((resolve) => {
      const onReady = (e) => {
        if (e.source !== el.contentWindow || !e.data || e.data.type !== 'ready') return;
        unlisten();
        resolve(true);
      };
      window.addEventListener('message', onReady);
      unlisten = () => window.removeEventListener('message', onReady);
    });
    (container || document.body).appendChild(el);
    frame = el;
  }

  function destroy(el) {
    if (frame !== el) return; // 已经换过一个新的
    unlisten();
    el.remove();
    frame = null;
    ready = null;
  }

  /**
   * 运行一次代码。
   * @param {{ code: string, tables: Array, timeoutMs: number, strings: object, signal?: AbortSignal }} req
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }
   *   | { timedOut: true } | { aborted: true } | { crashed: true } | { error: string }>}
   *   crashed：兜底到点仍无回包（沙箱进程崩溃或页面没加载起来），iframe 已销毁；
   *   error：沙箱页建不起 Worker、引导代码出错，或回包里的输出超长（代码绕过了引导代码）
   */
  async function run({ code, tables, timeoutMs, strings, signal }) {
    if (signal && signal.aborted) return { aborted: true };
    if (!frame) mount();
    const el = frame;
    const loaded = ready;
    const id = ++seq;
    return new Promise((resolve) => {
      let fallback = 0;
      let settled = false;
      const finish = (result) => {
        settled = true;
        clearTimeout(fallback);
        window.removeEventListener('message', onMessage);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onMessage = (e) => {
        if (e.source !== el.contentWindow || !e.data || e.data.id !== id) return;
        const { id: _id, ...result } = e.data;
        finish(result);
      };
      const onAbort = () => {
        if (el.contentWindow) el.contentWindow.postMessage({ type: 'cancel', id }, '*');
        finish({ aborted: true });
      };
      window.addEventListener('message', onMessage);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      // 兜底计时：先从调用起算，iframe 迟迟加载不起来同样由它收场；请求发出时重新起算。
      // 首次运行要先起沙箱进程，加载慢的那一两秒不能算进代码的运行时间，否则真超时会被报成崩溃
      const arm = () => {
        clearTimeout(fallback);
        fallback = setTimeout(() => {
          destroy(el);
          finish({ crashed: true });
        }, timeoutMs + FALLBACK_MS);
      };
      arm();
      loaded.then(() => {
        if (!settled && el.contentWindow) {
          arm();
          el.contentWindow.postMessage({ type: 'run', id, runner, code, tables, timeoutMs, strings }, '*');
        }
      });
    });
  }

  return { run };
}
