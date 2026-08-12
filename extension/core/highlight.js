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
 * @returns {{ ok: true, name: string, bbox: object }
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
  if (opts.session && store.session !== opts.session) return { ok: false, reason: 'stale' };
  if (!Number.isInteger(ref) || ref < 1 || ref > store.elements.length) {
    return { ok: false, reason: 'bad-ref' };
  }

  const el = store.elements[ref - 1];
  if (!el || !el.isConnected) return { ok: false, reason: 'gone' };
  const style = win.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) {
    return { ok: false, reason: 'hidden' };
  }

  // behavior:'instant'：平滑滚动与紧随其后的 bbox 测量存在竞态，定位会画偏
  if (doScroll) el.scrollIntoView({ block: 'center', behavior: 'instant' });
  let rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { ok: false, reason: 'hidden' };

  // 唯一 id 覆盖层：已有旧高亮先移除（连同其监听器一起，避免叠加）
  const OVERLAY_ID = '__titanium-highlight__';
  const old = doc.getElementById(OVERLAY_ID);
  if (old) {
    if (old.__cleanup) old.__cleanup();
    old.remove();
  }

  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  const label = doc.createElement('span');
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
  win.addEventListener('scroll', reposition, { passive: true, capture: true });
  win.addEventListener('resize', reposition, { passive: true });
  const timer = win.setTimeout(() => {
    if (overlay.__cleanup) overlay.__cleanup();
    overlay.remove();
  }, durationMs);
  overlay.__cleanup = () => {
    win.clearTimeout(timer);
    win.removeEventListener('scroll', reposition, { capture: true });
    win.removeEventListener('resize', reposition);
  };

  doc.documentElement.appendChild(overlay);

  const name = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    ok: true,
    name,
    bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}
