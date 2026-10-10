// core/settle.js —— 等待页面内容就位（平台无关层）
//
// 重要约束：waitForSettle 必须保持“完全自包含”（同 snapshot.js，经 executeScript 序列化注入）。
//
// 为什么需要它：动作之后页面要时间响应——展开的下拉、联想候选、校验提示、跳转后的新内容，
// 都是随后几百毫秒才画出来的。动作一返回就读，模型看到的是半截页面。
//
// 判定口径：文档已解析完，且一段时间内没有元素级增删。到达上限仍在变动就如实返回 settled:false，
// 由调用方在工具结果里提醒模型「页面内容仍在变动」。
//   - 只数元素节点的增删：行情页每秒改几十个单元格的文字、时钟每秒跳一次，都是文字或属性变动，
//     算进去的话这类页面每次动作都要等到上限。新内容到位（下拉展开、结果行插入、遮罩移除）都是元素级增删。
//   - 页面上是不是「加载中」「暂无数据」这类占位，交给模型读页面内容判断：它看得到这些文字，
//     提示词要求它遇到占位先 wait_for_page 再核实。注入函数只回答「DOM 还在不在变」这一件事。

/**
 * 等待页面内容就位。
 * @param {{ quietMs?: number, maxMs?: number, tolerance?: number }} [payload]
 *   quietMs   多长时间没有元素级变动算静默（同时也是最短观察时长），默认 500
 *   maxMs     最长等待，默认 5000；到点不管稳不稳都返回
 *   tolerance 静默窗口内允许的元素增删个数（闪烁光标、提示气泡这类零星变动），默认 2
 * @returns {Promise<{ ok: true, settled: boolean, changes: number, waitedMs: number }
 *          | { ok: false, reason: 'no-body' }>}
 *   settled 是否在上限内达成就位；changes 观察期间元素增删总数
 */
export function waitForSettle(payload) {
  const opts = payload || {};
  const quietMs = opts.quietMs || 500;
  const maxMs = opts.maxMs || 5000;
  const tolerance = typeof opts.tolerance === 'number' ? opts.tolerance : 2;
  const TICK = 100;

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.documentElement) return Promise.resolve({ ok: false, reason: 'no-body' });
  const win = doc.defaultView;
  const OVERLAY_ID = '__titanium-highlight__'; // 自己画的高亮层不算页面变化

  const started = Date.now();
  const recent = []; // [时间戳, 元素增删数]，只留静默窗口内的
  let changes = 0;

  const countElements = (nodes) => {
    let n = 0;
    for (const node of nodes) if (node.nodeType === 1 && node.id !== OVERLAY_ID) n++;
    return n;
  };
  const weightOf = (record) => {
    if (record.type !== 'childList') return 0;
    const target = record.target;
    // head 里的变动（统计脚本塞 script/style）与高亮层内部的重绘都与内容无关
    if (target && target.nodeType === 1 && (target.closest('head') || target.closest('#' + OVERLAY_ID))) return 0;
    return countElements(record.addedNodes) + countElements(record.removedNodes);
  };
  const observer = new MutationObserver((records) => {
    let w = 0;
    for (const r of records) w += weightOf(r);
    if (w) {
      recent.push([Date.now(), w]);
      changes += w;
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  return new Promise((resolve) => {
    const finish = (settled) => {
      observer.disconnect();
      resolve({ ok: true, settled, changes, waitedMs: Date.now() - started });
    };
    const tick = () => {
      const now = Date.now();
      while (recent.length && now - recent[0][0] > quietMs) recent.shift();
      let pending = 0;
      for (const [, w] of recent) pending += w;
      // readyState 只要求解析完成：complete 还要等所有图片，一张慢图不该拖住整次判定
      const parsed = doc.readyState !== 'loading';
      if (parsed && pending <= tolerance && now - started >= quietMs) return finish(true);
      if (now - started >= maxMs) return finish(false);
      win.setTimeout(tick, TICK);
    };
    win.setTimeout(tick, TICK);
  });
}
