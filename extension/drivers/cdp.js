// drivers/cdp.js —— 调试通道：经 chrome.debugger 发真实的鼠标、键盘与文字输入
//
// 真实输入由浏览器自己执行默认行为（移光标、滚动、删字、label 转发、表单提交），
// 也通过「事件是否可信」的检查；网络域看得到这次动作发出的请求何时返回，就位判定因此能
// 等到接口回来，而不只是 DOM 静下来。
//
// 代价是浏览器顶部的「正在调试此浏览器」横幅：一个回合里第一次动作时附加，回合结束（release）
// 时断开，横幅只在 AI 操作页面期间出现。附加失败、用户点了横幅上的「取消」、或真实点击会点错
// （中心点被遮挡、落在内部另一个控件上）时，这一步退回合成事件通道，结果里注明 fallback。
//
// 只接管点击、按键与文字输入；选择原生下拉、滚动、只读提取仍走合成事件通道。
// 删掉本文件、在 drivers/index.js 里不再创建它，并从 manifest 去掉 debugger 权限，
// 扩展就回到纯合成事件通道（行内定制版即如此）。

import { performAction } from '../core/actions.js';
import { keyEffectFromProbes } from '../core/key-effect.js';

// 键名 → CDP Input.dispatchKeyEvent 参数（与 core/actions.js 的 KEYS 表、tools.js 的 ALLOWED_KEYS 同一份名单）
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

// 就位判定只等这几类请求：页面拉数据用的接口与文档本身。图片、字体、样式、长连接不算
const DATA_REQUESTS = { XHR: 1, Fetch: 1, Document: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {(tabId: number, func: Function, args?: object) => Promise<any>} o.inject 外壳的注入函数
 * @param {object} o.fallback 合成事件通道的驱动（drivers/synthetic.js）
 * @param {object} [o.debuggerApi] chrome.debugger（测试时换成替身）
 */
export function createCdpDriver({ inject, fallback, debuggerApi = chrome.debugger }) {
  // tabId → { since: 本次动作开始的时刻, requests: Map<requestId, 发出时刻> }
  const sessions = new Map();
  let canceledByUser = false; // 用户点了横幅上的「取消」：本回合不再附加，回合结束后复位

  debuggerApi.onEvent.addListener((source, method, params) => {
    const s = sessions.get(source.tabId);
    if (!s) return;
    if (method === 'Network.requestWillBeSent' && DATA_REQUESTS[params.type]) {
      s.requests.set(params.requestId, Date.now());
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      s.requests.delete(params.requestId);
    }
  });
  debuggerApi.onDetach.addListener((source, reason) => {
    sessions.delete(source.tabId);
    if (reason === 'canceled_by_user') canceledByUser = true;
  });

  const send = (tabId, method, params) => debuggerApi.sendCommand({ tabId }, method, params || {});

  // 附加并打开网络域；已附加则直接复用。失败（受限页、用户取消、别的调试器占着）返回 false
  async function ensure(tabId) {
    if (sessions.has(tabId)) return true;
    if (canceledByUser) return false;
    try {
      await debuggerApi.attach({ tabId }, '1.3');
    } catch {
      return false;
    }
    sessions.set(tabId, { since: 0, requests: new Map() });
    try { await send(tabId, 'Network.enable'); } catch { /* 网络域打不开就只看 DOM */ }
    return true;
  }

  // 这次动作发出、还没返回的数据请求数
  function pending(tabId) {
    const s = sessions.get(tabId);
    if (!s) return 0;
    let n = 0;
    for (const at of s.requests.values()) if (at >= s.since) n++;
    return n;
  }

  async function click(tabId, payload) {
    const loc = await inject(tabId, performAction, { ...payload, action: 'locate' });
    if (!loc || !loc.ok) return loc;
    if (!loc.safe) return { ...(await fallback.act(tabId, payload)), fallback: 'unsafe-point' };
    const at = { x: loc.x, y: loc.y };
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
    return { ok: true, action: 'click', ref: payload.ref, name: loc.name, channel: 'cdp' };
  }

  async function pressKey(tabId, payload) {
    const spec = KEYS[payload.key];
    if (!spec) return { ok: false, reason: 'bad-key' };
    if (payload.ref != null) {
      const focused = await inject(tabId, performAction, { ...payload, action: 'focus' });
      if (!focused || !focused.ok) return focused;
    }
    const probe = () => inject(tabId, performAction, { session: payload.session, action: 'probe' });
    const before = await probe();
    const base = { key: payload.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
    await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', ...(spec.text ? { text: spec.text } : {}) });
    await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    const after = await probe();
    const movedTo = before && after && after.ok && before.active !== after.active ? after.active || null : null;
    return {
      ok: true, action: 'key', key: payload.key, channel: 'cdp',
      target: before && before.ok ? before.active : '', movedTo,
      effect: keyEffectFromProbes(before, after),
    };
  }

  async function typeText(tabId, payload) {
    const focused = await inject(tabId, performAction, { ...payload, action: 'focus', select: true });
    if (!focused || !focused.ok) return focused;
    if (!focused.editable) return { ok: false, reason: 'not-editable', name: focused.name };
    const text = String(payload.text == null ? '' : payload.text);
    // 内容已全选：有字就整体替换成新文字，空串就删掉选中的内容
    if (text) await send(tabId, 'Input.insertText', { text });
    else {
      const del = { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 };
      await send(tabId, 'Input.dispatchKeyEvent', { ...del, type: 'rawKeyDown' });
      await send(tabId, 'Input.dispatchKeyEvent', { ...del, type: 'keyUp' });
    }
    const S = payload.i18n || {};
    const shown = text.replace(/\s+/g, ' ').trim();
    return {
      ok: true, action: 'input', ref: payload.ref, name: focused.name, channel: 'cdp',
      value: focused.password ? (S.passwordMasked || '***') : (shown.length > 80 ? shown.slice(0, 80) + '…' : shown),
    };
  }

  const HANDLERS = { click, key: pressKey, input: typeText };

  return {
    kind: 'cdp',

    // 动作开始：记下时刻（就位判定只等这之后发出的请求），附加后交给对应的处理函数
    async act(tabId, payload) {
      const handler = HANDLERS[payload.action];
      if (!handler) return fallback.act(tabId, payload);
      if (!(await ensure(tabId))) return { ...(await fallback.act(tabId, payload)), fallback: 'unavailable' };
      sessions.get(tabId).since = Date.now();
      try {
        return await handler(tabId, payload);
      } catch {
        // 附加在动作中途断开（页面跳转、用户取消）：这一步按合成事件重做不安全，如实报失败
        return null;
      }
    },

    // DOM 静下来之后，再等这次动作发出的数据请求返回；请求回来后 DOM 往往还要再变一阵，再判一次
    async settle(tabId, budget) {
      if (!sessions.has(tabId)) return fallback.settle(tabId, budget);
      const started = Date.now();
      const maxMs = (budget && budget.maxMs) || 5000;
      let dom = await fallback.settle(tabId, budget);
      if (!dom || !dom.ok) return dom;
      let waitedForNetwork = false;
      while (pending(tabId) > 0 && Date.now() - started < maxMs) {
        waitedForNetwork = true;
        await sleep(100);
      }
      const left = maxMs - (Date.now() - started);
      if (waitedForNetwork && pending(tabId) === 0 && left > 0) {
        dom = (await fallback.settle(tabId, { ...budget, maxMs: left })) || dom;
      }
      const requests = pending(tabId);
      return { ...dom, settled: Boolean(dom.settled) && requests === 0, requests, waitedMs: Date.now() - started };
    },

    // 回合结束：断开全部附加，横幅随之消失；用户的「取消」只管到本回合
    async release() {
      const tabs = [...sessions.keys()];
      sessions.clear();
      canceledByUser = false;
      await Promise.all(tabs.map((tabId) => debuggerApi.detach({ tabId }).catch(() => {})));
    },
  };
}
