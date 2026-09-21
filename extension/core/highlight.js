// core/highlight.js —— 按 ref 在页面上画临时高亮框（平台无关层）
//
// 重要约束：highlightElement 必须保持“完全自包含”（同 snapshot.js，经 executeScript 序列化注入）。
//
// 「只读」边界说明：高亮是加在页面上的临时视觉覆盖层（pointer-events:none，
// 数秒后自动移除），必要时 scrollIntoView 滚动到元素——不点击、不输入、
// 不修改页面任何数据。ref 来自 window.__titanium（snapshot 建立的映射）。

/**
 * 高亮指定 ref 的元素。
 * @param {{ ref: number, session: string, durationMs?: number, scroll?: boolean }} payload
 * @returns {{ ok: true, name: string, bbox: object }  bbox 以元素所在文档的视口为原点
 *          | { ok: false, reason: 'stale'|'gone'|'hidden'|'bad-ref' }}
 */
export function highlightElement(payload) {
  const opts = payload || {};
  const ref = opts.ref;
  const durationMs = opts.durationMs || 3000;
  const doScroll = opts.scroll !== false;

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'gone' };
  const win = doc.defaultView;

  const store = win.__titanium;
  if (!store || !Array.isArray(store.elements)) return { ok: false, reason: 'stale' };
  // session 必填：空 session 不是「不校验」而是「没有有效映射」——
  // 否则不重读页面的路径（恢复历史会话等）会拿旧 ref 命中当前页面的陌生元素。
  // 与 actions.js 的 resolveElement、snapshot.js 的 mode:'elements' 同一条判定。
  if (!opts.session || store.session !== opts.session) return { ok: false, reason: 'stale' };
  if (!Number.isInteger(ref) || ref < 1 || ref > store.elements.length) {
    return { ok: false, reason: 'bad-ref' };
  }

  const el = store.elements[ref - 1];
  if (!el || !el.isConnected) return { ok: false, reason: 'gone' };
  // 同源框架里的元素：覆盖层画在元素自己那份文档里，fixed 定位与 getBoundingClientRect
  // 同一原点，不必换算坐标，框架内滚动时也能就地跟随。框架被移除或跳走后旧文档
  // 没有视图，元素按失效处理（与 actions.js / snapshot.js 同一口径）。
  const edoc = el.ownerDocument;
  const ewin = edoc.defaultView || (edoc === doc ? win : null);
  if (!ewin) return { ok: false, reason: 'gone' };
  const style = ewin.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) {
    return { ok: false, reason: 'hidden' };
  }

  // behavior:'instant'：平滑滚动与紧随其后的 bbox 测量存在竞态，定位会画偏
  if (doScroll) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  let rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { ok: false, reason: 'hidden' };

  // 唯一 id 覆盖层：已有旧高亮先移除（连同其监听器一起，避免叠加）
  const OVERLAY_ID = '__titanium-highlight__';
  // 上一个覆盖层可能画在另一份文档里（上次高亮的是别的框架里的元素），句柄随店保存
  const old = store.overlay && store.overlay.isConnected ? store.overlay : edoc.getElementById(OVERLAY_ID);
  if (old) {
    if (old.__cleanup) old.__cleanup();
    old.remove();
  }

  const overlay = edoc.createElement('div');
  overlay.id = OVERLAY_ID;
  const label = edoc.createElement('span');
  label.textContent = String(ref);

  function position() {
    rect = el.getBoundingClientRect();
    overlay.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
      'border:2px solid #1a5fb4;background:rgba(26,95,180,0.08);border-radius:2px;' +
      `left:${rect.left - 3}px;top:${rect.top - 3}px;` +
      `width:${rect.width + 6}px;height:${rect.height + 6}px;`;
    label.style.cssText =
      'position:absolute;left:-2px;top:-20px;padding:1px 6px;' +
      'font:600 12px/1.4 system-ui,sans-serif;color:#fff;background:#1a5fb4;border-radius:2px;';
  }
  position();
  overlay.appendChild(label);

  // 随滚动/缩放重定位（passive，不影响页面滚动性能）
  const reposition = () => { if (el.isConnected) position(); };
  ewin.addEventListener('scroll', reposition, { passive: true, capture: true });
  ewin.addEventListener('resize', reposition, { passive: true });
  // 定时器挂在顶层 window：框架中途被移除时它自己的定时器不再触发，清理会落空
  const timer = win.setTimeout(() => {
    if (overlay.__cleanup) overlay.__cleanup();
    overlay.remove();
  }, durationMs);
  overlay.__cleanup = () => {
    win.clearTimeout(timer);
    ewin.removeEventListener('scroll', reposition, { capture: true });
    ewin.removeEventListener('resize', reposition);
  };

  edoc.documentElement.appendChild(overlay);
  store.overlay = overlay;

  const name = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    ok: true,
    name,
    bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}
