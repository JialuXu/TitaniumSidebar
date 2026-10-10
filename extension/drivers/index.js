// drivers/index.js —— 页内动作的执行驱动：合成事件通道与调试通道，外壳只认这一个接口
//
// 驱动接口：
//   act(tabId, payload)     执行一个页内动作，返回 performAction 同一形状的结果；
//                           调试通道退回合成事件时结果带 fallback（'unavailable' | 'unsafe-point'）
//   settle(tabId, budget)   等页面就位，返回 waitForSettle 同一形状，调试通道另带 requests（未返回的请求数）
//   release()               回合结束时调用，释放通道占用的资源（调试通道在此断开附加）

import { createSyntheticDriver } from './synthetic.js';
import { createCdpDriver } from './cdp.js';

/** 当前环境有没有调试通道可用：manifest 没声明 debugger 权限时 chrome.debugger 不存在 */
export function debuggerAvailable() {
  return typeof chrome !== 'undefined' && Boolean(chrome.debugger);
}

/**
 * 建好两个驱动，按开关挑选。
 * @param {(tabId: number, func: Function, args?: object) => Promise<any>} inject
 * @returns {{ synthetic: object, cdp: object|null, pick: (useDebugger: boolean) => object }}
 */
export function createDrivers(inject) {
  const synthetic = createSyntheticDriver(inject);
  const cdp = debuggerAvailable() ? createCdpDriver({ inject, fallback: synthetic }) : null;
  return {
    synthetic,
    cdp,
    pick: (useDebugger) => (useDebugger && cdp) || synthetic,
  };
}
