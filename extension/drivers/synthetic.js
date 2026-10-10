// drivers/synthetic.js —— 合成事件通道：页内动作与就位判定都靠注入 core 的自包含函数
//
// 所有形态都有这条路（未来的 SDK 形态在页内运行，只有它）。外壳通过驱动接口调用，
// 不关心底下走的是哪条通道；接口见 drivers/index.js。

import { performAction } from '../core/actions.js';
import { waitForSettle } from '../core/settle.js';

/**
 * @param {(tabId: number, func: Function, args?: object) => Promise<any>} inject
 *   外壳的注入函数：在标签页里执行 core 导出的自包含函数，失败返回 null
 */
export function createSyntheticDriver(inject) {
  return {
    kind: 'synthetic',
    act: (tabId, payload) => inject(tabId, performAction, payload),
    settle: (tabId, budget) => inject(tabId, waitForSettle, budget),
    release: async () => {},
  };
}
