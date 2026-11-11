// core/text-highlight.js —— 按原文在页面上标出一段文字（平台无关层）
//
// 重要约束：highlightText 必须保持“完全自包含”（同 snapshot.js，经 executeScript 序列化注入）。
// 与 highlight.js 分成两个文件：每个注入函数独占一个模块，自包含的静态检查才查得住。

/**
 * 在页面上找到一段原文并高亮（引用卡片的「来自当前页面」徽标点击后调用）。
 * 与 highlightElement 同一条只读边界：滚动到位、画几秒后自动移除的覆盖层。
 * 比对忽略全部空白（与 core/citation.js 的校验同一口径）；needle 里的 * 是脱敏打的码，
 * 页面上那一位是真实的数字，按「任意一个数字」匹配。同样必须完全自包含。
 * @param {{ text: string, durationMs?: number }} payload
 * @returns {{ ok: true, rects: number } | { ok: false, reason: 'gone'|'not-found'|'hidden' }}
 *   not-found：页面上没有这段连续文字（表格被转成 Markdown 的引用、跨了框架的引用、页面已变）
 */
export function highlightText(payload) {
  const opts = payload || {};
  const durationMs = opts.durationMs || 4000;
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'gone' };
  const win = doc.defaultView;

  const needle = String(opts.text || '').replace(/\s+/g, '');
  if (needle.length < 6) return { ok: false, reason: 'not-found' };

  // 把看得见的文字去掉空白后连成一串，逐字记下它来自哪个文本节点的第几位
  const MAX_SCAN = 400000;
  const nodes = [];
  const offsets = [];
  let hay = '';
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, TEXTAREA: 1, SELECT: 1 };
  function walk(root) {
    for (let node = root.firstChild; node && hay.length < MAX_SCAN; node = node.nextSibling) {
      if (node.nodeType === 3) {
        const data = node.data;
        for (let i = 0; i < data.length; i++) {
          if (/\s/.test(data[i])) continue;
          hay += data[i];
          nodes.push(node);
          offsets.push(i);
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toUpperCase();
      if (SKIP[tag]) continue;
      const view = node.ownerDocument.defaultView;
      const style = view ? view.getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      if (tag === 'IFRAME' || tag === 'FRAME') {
        // 同源框架下钻，跨域框架读不到
        let inner = null;
        try { inner = node.contentDocument; } catch { inner = null; }
        if (inner && inner.body) walk(inner.body);
        continue;
      }
      walk(node);
    }
  }
  walk(doc.body);

  let at = -1;
  if (needle.includes('*')) {
    const pattern = needle.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\dXx*]');
    const m = new RegExp(pattern).exec(hay);
    at = m ? m.index : -1;
  } else {
    at = hay.indexOf(needle);
  }
  if (at < 0) return { ok: false, reason: 'not-found' };

  const startNode = nodes[at];
  const endNode = nodes[at + needle.length - 1];
  const edoc = startNode.ownerDocument;
  const ewin = edoc.defaultView;
  // 一段引用跨了两份文档（框架内外各一半）时画不出一个范围
  if (!ewin || endNode.ownerDocument !== edoc) return { ok: false, reason: 'not-found' };
  const range = edoc.createRange();
  range.setStart(startNode, offsets[at]);
  range.setEnd(endNode, offsets[at + needle.length - 1] + 1);

  // behavior:'instant'：平滑滚动与紧随其后的测量存在竞态，框会画偏
  if (startNode.parentElement) startNode.parentElement.scrollIntoView({ block: 'center', behavior: 'instant' });

  const OVERLAY_ID = '__titanium-highlight__';
  for (const d of [doc, edoc]) {
    const old = d.getElementById(OVERLAY_ID);
    if (old) {
      if (old.__cleanup) old.__cleanup();
      old.remove();
    }
  }
  const overlay = edoc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

  // 一个范围按行拆成多个矩形，各画一块；零尺寸的（换行处的空矩形）不画
  function draw() {
    overlay.textContent = '';
    let count = 0;
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      if (++count > 200) break;
      const box = edoc.createElement('div');
      box.style.cssText =
        'position:fixed;box-sizing:border-box;background:rgba(26,95,180,0.18);' +
        'border-bottom:2px solid #1a5fb4;border-radius:2px;' +
        `left:${r.left - 1}px;top:${r.top - 1}px;width:${r.width + 2}px;height:${r.height + 2}px;`;
      overlay.appendChild(box);
    }
    return count;
  }
  const rects = draw();
  if (!rects) return { ok: false, reason: 'hidden' };

  const redraw = () => { if (startNode.isConnected && endNode.isConnected) draw(); };
  ewin.addEventListener('scroll', redraw, { passive: true, capture: true });
  ewin.addEventListener('resize', redraw, { passive: true });
  // 定时器挂在顶层 window：框架中途被移除时它自己的定时器不再触发，清理会落空
  const timer = win.setTimeout(() => {
    overlay.__cleanup();
    overlay.remove();
  }, durationMs);
  overlay.__cleanup = () => {
    win.clearTimeout(timer);
    ewin.removeEventListener('scroll', redraw, { capture: true });
    ewin.removeEventListener('resize', redraw);
  };
  edoc.documentElement.appendChild(overlay);
  return { ok: true, rects };
}
