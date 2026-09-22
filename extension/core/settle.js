// core/settle.js —— 等待页面内容就位（平台无关层）
//
// 重要约束：waitForSettle 必须保持“完全自包含”（同 snapshot.js，经 executeScript 序列化注入）。
//
// 为什么需要它：标签页 status 变成 complete 只说明**文档**加载完了。SPA 与后台业务系统的
// 数据都是随后再由接口拉回来的，这几百毫秒到几秒里页面上摆着骨架屏、转圈遮罩与「暂无数据」
// 占位（antd/element 的表格在 loading 时照样渲染空态文字，遮罩只是盖在上面）。在这个瞬间
// 拍快照，模型读到的就是「暂无数据」，据此断定列表为空、回退或改计划——一步错，步步错。
//
// 判定口径：**DOM 静默 且 看不见加载指示器**，两者同时满足才算就位；到达上限仍不满足则
// 如实返回 settled:false，由调用方在工具结果里提醒模型「页面可能仍在加载」（不变式 9）。
//   - DOM 静默只数**元素节点**的增删。行情页每秒改几十个单元格的文字、时钟每秒跳一次，
//     都是 characterData 或属性变动；把它们算进去，这类页面每次动作都要等到上限。数据到位
//     的典型形态（骨架屏换成正文、空态换成表格行、遮罩被移除）都是元素级增删，数得准。
//   - 加载指示器分三路：标准语义（aria-busy、不定进度条）、常见 UI 库与老系统的类名、
//     独立成行的「加载中…」标签文字。只算**可见**的：老 jQuery 系统常年藏着一个
//     display:none 的加载提示层，按需显示。
// 没有网络层可看：注入函数跑在隔离世界，页面的 fetch/XHR 从这里看不见，SDK 形态更没有
// webRequest。只看 DOM 意味着「接口慢、又不显示任何加载态、空态先渲染」这一种情形仍会漏，
// 由 prompt 护栏与 wait_for_page 工具兜底。

/**
 * 等待页面内容就位。
 * @param {{ quietMs?: number, maxMs?: number, tolerance?: number }} [payload]
 *   quietMs   多长时间没有元素级变动算静默（同时也是最短观察时长），默认 500
 *   maxMs     最长等待，默认 5000；到点不管稳不稳都返回
 *   tolerance 静默窗口内允许的元素增删个数（闪烁光标、提示气泡这类零星变动），默认 2
 * @returns {Promise<{ ok: true, settled: boolean, busy: number, changes: number, waitedMs: number }
 *          | { ok: false, reason: 'no-body' }>}
 *   settled 是否在上限内达成就位；busy 返回时仍可见的加载指示器数；changes 观察期间元素增删总数
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

  /* ---------- 通道一：元素级 DOM 变动 ---------- */
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

  /* ---------- 通道二：可见的加载指示器 ---------- */
  // 标准语义 + 常见 UI 库/老系统的确定类名（camelCase 的库名进不了下面的词法匹配，单列）
  const BUSY_SELECTOR = [
    '[aria-busy="true"]',
    '[role="progressbar"]:not([aria-valuenow])', // 不定进度 = 转圈；带具体进度的多是常驻进度条
    '.MuiSkeleton-root', '.MuiCircularProgress-root', '.MuiLinearProgress-root',
    '.layui-layer-loading', '.blockUI', '.blockOverlay',
  ].join(',');
  // 类名里独立成词的 loading/spinner/skeleton：is-loading、el-loading-mask、ant-spin-spinning、
  // spinner-border 都命中；lazyloading、preloaded 这类拼在一起的不算
  const CLASS_CANDIDATES = '[class*="loading" i],[class*="spinn" i],[class*="skeleton" i]';
  const CLASS_TOKEN = /(^|[-_])(loading|spinner|spinning|skeleton)([-_]|$)/i;
  // 独立成行的加载标签文字（整段只有这几个字才算，正文里提到「加载」不算）
  const LABEL = /^(?:加载中|正在加载|载入中|数据加载中|请稍候|loading|please wait)[\s.…]*$/i;
  const LABEL_XPATH =
    './/text()[contains(., "加载中") or contains(., "正在加载") or contains(., "载入中") ' +
    'or contains(., "请稍候") or contains(., "oading") or contains(., "lease wait")]';

  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return false;
    } else {
      const s = el.ownerDocument.defaultView.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    // 遮罩淡出：元素还在、已经透明（element-ui 的 loading 遮罩先过渡到 0 再移除）
    return parseFloat(el.ownerDocument.defaultView.getComputedStyle(el).opacity) !== 0;
  };

  const countBusy = () => {
    const seen = new Set();
    for (const el of doc.querySelectorAll(BUSY_SELECTOR)) {
      if (visible(el)) seen.add(el);
    }
    for (const el of doc.querySelectorAll(CLASS_CANDIDATES)) {
      if (seen.has(el)) continue;
      const cls = el.getAttribute('class') || '';
      if (cls.split(/\s+/).some((token) => CLASS_TOKEN.test(token)) && visible(el)) seen.add(el);
    }
    if (doc.body && typeof doc.evaluate === 'function') {
      const snap = doc.evaluate(LABEL_XPATH, doc.body, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
      for (let i = 0; i < snap.snapshotLength; i++) {
        const node = snap.snapshotItem(i);
        const text = (node.nodeValue || '').trim();
        if (text.length <= 20 && LABEL.test(text) && visible(node.parentElement)) seen.add(node.parentElement);
      }
    }
    return seen.size;
  };

  /* ---------- 轮询判定 ---------- */
  return new Promise((resolve) => {
    const finish = (settled, busy) => {
      observer.disconnect();
      resolve({ ok: true, settled, busy, changes, waitedMs: Date.now() - started });
    };
    const tick = () => {
      const now = Date.now();
      while (recent.length && now - recent[0][0] > quietMs) recent.shift();
      let pending = 0;
      for (const [, w] of recent) pending += w;
      const busy = countBusy();
      // readyState 只要求解析完成：complete 还要等所有图片，一张慢图不该拖住整次判定
      const parsed = doc.readyState !== 'loading';
      if (parsed && busy === 0 && pending <= tolerance && now - started >= quietMs) return finish(true, 0);
      if (now - started >= maxMs) return finish(false, busy);
      win.setTimeout(tick, TICK);
    };
    win.setTimeout(tick, TICK);
  });
}
