// core/actions.js —— 页面动作：点击/输入/选择/按键/滚动 + 只读的表格与 HTML 提取（平台无关层）
//
// 重要约束：performAction 必须保持“完全自包含”（同 snapshot.js/highlight.js，
// 经 executeScript 序列化注入 ISOLATED world 执行，闭包全部丢失）。
// 因此校验链、表格转 Markdown 等逻辑在本文件内重复实现一份，不从别处 import。
//
// 执行通道：合成事件（PointerEvent/MouseEvent/KeyboardEvent）+ 原生 value setter。
// 这是所有形态都有的通道（未来的 SDK 形态在页内运行，只有这一条路）。扩展外壳另有一条
// 调试通道（extension/drivers/cdp.js）发真实输入，它借本文件的 locate / focus / probe
// 三个动作在页面里定位元素、聚焦、读取光标与滚动状态，输入本身不经过这里。
//
// 与真实用户操作的差异（模型需要知道，已写进工具描述）：
//   1. 合成事件的 isTrusted 为 false，极少数站点会据此忽略；
//   2. 合成键盘事件不产生浏览器默认行为（不提交表单、不移焦点、不移光标、不滚动、不删字），
//      因此本文件按键语义逐个补偿：Enter 提交、Tab 移焦、导航键移光标或滚动、
//      Backspace/Delete 删字（见 keyDefault），并把补偿的实际效果如实回报。

/**
 * 在页面上执行一个动作。
 * @param {{ action: 'click'|'input'|'select'|'key'|'scroll'|'extract_table'|'get_html'|'locate'|'focus'|'probe',
 *           session: string, ref?: number, text?: string, option?: string, key?: string,
 *           direction?: 'up'|'down'|'top'|'bottom', pages?: number,
 *           tableIndex?: number, maxLen?: number,
 *           i18n?: { passwordMasked, tableTruncated, htmlTruncated } }} payload
 *   i18n 由外壳按当前语言传入（本函数注入页面执行，不能 import core/i18n.js）
 * @returns {{ ok: true, action, urlBefore, urlAfter, urlChanged, focus, ... }
 *          | { ok: false, reason: string, ... }}
 *   失败 reason 全集：no-body | bad-action | stale | bad-ref | gone | hidden |
 *                     disabled | not-editable | not-select | option-not-found |
 *                     bad-key | bad-table-index
 *   调试通道用的三个动作（不改动页面，focus 除外）：
 *     locate  { ref }           滚到可见处，返回点击点在顶层视口里的坐标 x/y；
 *                               safe=false 表示中心点被遮挡或落在内部另一个控件上，真实点击会点错
 *     focus   { ref, select? }  聚焦元素，select 时选中全部内容；返回 editable / password
 *     probe   {}                当前焦点元素与光标、滚动位置的快照，按键前后各取一次比较
 */
export function performAction(payload) {
  const opts = payload || {};
  const action = opts.action;
  // 缺省值保证脱离外壳直接调用时仍可用
  const S = Object.assign({
    passwordMasked: '（已写入，不回显）',
    tableTruncated: '\n……（表格过长已截断）',
    htmlTruncated: '…（已截断）',
  }, opts.i18n || {});

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return { ok: false, reason: 'no-body' };

  const urlBefore = doc.location ? doc.location.href : '';

  /* ---------- 公共辅助 ---------- */

  function clamp(s, max) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  // 元素所在文档的视图。同源框架里的元素，样式、事件、选区都归框架自己的 window/document；
  // 框架被移除或跳走之后旧文档的 defaultView 为 null，据此判定元素已失效（与 snapshot.js 同一口径）。
  function viewOf(el) {
    const d = el.ownerDocument;
    return (d && d.defaultView) || (d === doc ? win : null);
  }

  // 内嵌框架的可读正文根（与 snapshot.js 的 frameRoot 同一算法，自包含约束下各存一份）
  function frameRoot(frame) {
    let inner = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    if (inner && inner.body) return inner.body;
    const src = frame.getAttribute('srcdoc');
    if (src && win.DOMParser) {
      try {
        const parsed = new win.DOMParser().parseFromString(src, 'text/html');
        if (parsed && parsed.body) return parsed.body;
      } catch { /* 解析失败按读不到处理 */ }
    }
    return null;
  }

  // 可见性粗判（与 snapshot.js 的 visibleStyle 同一口径；离线解析件没有视图，只看属性与行内样式）
  function isHidden(el) {
    const view = viewOf(el);
    if (!view) {
      const inline = el.style || {};
      return el.hasAttribute('hidden') || inline.display === 'none' || inline.visibility === 'hidden';
    }
    const style = view.getComputedStyle(el);
    return !style || style.display === 'none' || style.visibility === 'hidden';
  }

  // 视觉代理：组件库常把原生勾选框/单选框缩成 0×0（Element UI 的 el-checkbox__original），
  // 用户点的是关联的 <label>，浏览器把这次点击转发给控件。名称、可用性与勾选态读控件本身，
  // 可见性、坐标与点击落点取自代理（与 snapshot.js 同一算法，自包含约束下各存一份）。
  function visualProxy(el) {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    const type = tag === 'INPUT' ? (el.getAttribute('type') || '').toLowerCase() : '';
    if (type !== 'checkbox' && type !== 'radio') return el;
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return el;
    for (const label of el.labels || []) {
      const lr = label.getBoundingClientRect();
      if (lr.width >= 2 && lr.height >= 2) return label;
    }
    return el;
  }

  // ref → 元素句柄，校验链与 highlight.js 保持一致（stale/bad-ref/gone/hidden）。
  // 成功时一并返回元素所在的 view：框架内元素的事件与选区不能用顶层 window 构造；
  // 以及视觉代理 box：尺寸校验、坐标与点击落点都按它算。
  function resolveElement(ref, needVisible) {
    const store = win.__titanium;
    if (!store || !Array.isArray(store.elements)) return { err: 'stale' };
    // session 必填：空 session 曾被当成「不校验」放行，于是恢复历史会话后直接「重新生成」
    // 这类不重读页面的路径上，旧 ref 会落在当前页面某个毫不相干的元素上——
    // 开着页面操作时那就是一次打在错误元素上的真实点击。没有凭证就是没有有效映射。
    if (!opts.session || store.session !== opts.session) return { err: 'stale' };
    if (!Number.isInteger(ref) || ref < 1 || ref > store.elements.length) return { err: 'bad-ref' };
    const el = store.elements[ref - 1];
    const view = el && el.isConnected ? viewOf(el) : null;
    if (!view) return { err: 'gone' };
    const box = visualProxy(el);
    if (needVisible !== false) {
      const style = view.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return { err: 'hidden' };
      const r = box.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { err: 'hidden' };
    }
    return { el, view, box };
  }

  function nameOf(el) {
    if (!el || !el.tagName) return '';
    const text = clamp(el.textContent || '', 80);
    if (text) return text;
    const attr = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || (el.tagName.toUpperCase() === 'INPUT' ? el.getAttribute('name') : '') || '';
    return clamp(attr, 80);
  }

  function isDisabled(el) {
    return Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
  }

  // 与 snapshot.js 同一套判定：浏览器用计算属性，无排版引擎的环境退化到属性
  function selfEditable(el) {
    if (typeof el.isContentEditable === 'boolean') return el.isContentEditable;
    const v = el.getAttribute('contenteditable');
    return v === '' || (v || '').toLowerCase() === 'true';
  }

  // 焦点落在同源框架内时，顶层的 activeElement 只是那个 <iframe>，逐层下钻才是真正的焦点元素
  function activeElement() {
    let a = doc.activeElement;
    while (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
      let inner = null;
      try { inner = a.contentDocument; } catch { inner = null; }
      if (!inner || !inner.activeElement) break;
      a = inner.activeElement;
    }
    return a;
  }

  function describeFocus() {
    const a = activeElement();
    if (!a) return null;
    // body 即「没有焦点」；富文本编辑器框架的 body 本身可编辑，是真焦点
    const d = a.ownerDocument;
    if ((a === d.body || a === d.documentElement) && !selfEditable(a)) return null;
    return { tag: a.tagName.toLowerCase(), name: nameOf(a) };
  }

  // 元素是否在用户看不见的地方：先看它在自己那一层视口里的位置，再逐层看所在框架
  function offscreen(node) {
    const view = viewOf(node);
    if (!view) return false;
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > view.innerHeight || r.right < 0 || r.left > view.innerWidth) return true;
    return view !== win && view.frameElement ? offscreen(view.frameElement) : false;
  }

  // 真实点击落在屏幕上的一个点：事件从该点最深层的元素发出、沿祖先链冒泡，途经被点的元素。
  // 直接向元素本身派发则只从它往上冒，挂在它内部子元素上的处理器永远收不到——
  // antd Select 的展开逻辑挂在内层 .ant-select-selector 上，点外层包裹 div 于是静默无效。
  // 因此派发给元素中心点上的命中元素（elementFromPoint 与真实点击同样跳过 pointer-events:none）。
  // 以下情形派发给元素本身：
  //   命中点不在元素内：被遮罩、浮层挡住，或中心点在视口外（返回别的元素或 null）；
  //   命中点落在元素内部另一个独立控件上：卡片正中的「删除」按钮，模型要点的是卡片。
  const INNER_CONTROLS = 'a[href],button,select,label,input[type=checkbox],input[type=radio],' +
    'input[type=button],input[type=submit],input[type=reset],input[type=image],' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],' +
    '[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option]';
  function hitTarget(el, x, y) {
    let hit = null;
    try { hit = el.ownerDocument.elementFromPoint(x, y); } catch { hit = null; }
    // 图标按钮的命中点常落在 <svg>/<path> 上，SVG 元素没有 click()（那是 HTMLElement 的方法），取最近的 HTML 祖先
    while (hit && typeof hit.click !== 'function') hit = hit.parentElement;
    if (!hit || hit === el || !el.contains(hit)) return el;
    const inner = hit.closest(INNER_CONTROLS);
    return inner && inner !== el && el.contains(inner) ? el : hit;
  }

  function viewportInfo() {
    return {
      w: win.innerWidth, h: win.innerHeight,
      dpr: win.devicePixelRatio || 1,
      scrollX: Math.round(win.scrollX), scrollY: Math.round(win.scrollY),
      docW: doc.documentElement.scrollWidth, docH: doc.documentElement.scrollHeight,
    };
  }

  // 写值走原型链上的原生 setter：React 会在元素实例上覆盖 value 描述符来做受控绑定，
  // 直接赋值可能被它的 value tracker 吞掉而不触发 onChange。取原型描述符可绕过。
  // （扩展的 ISOLATED world 看不到主世界的实例级描述符，本就安全；
  //   这样写是为了未来 SDK 形态直接跑在主世界时同样正确。）
  function setNativeValue(el, value, view) {
    const tag = el.tagName.toUpperCase();
    const proto = tag === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype
      : tag === 'SELECT' ? view.HTMLSelectElement.prototype
        : view.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  // 统一成功返回：附带动作前后 URL（同文档路由变化可当场测到，
  // 真导航是异步的，由外壳通过 chrome.tabs 判定）
  function finish(extra) {
    const urlAfter = doc.location ? doc.location.href : '';
    return Object.assign({
      ok: true, action, urlBefore, urlAfter,
      urlChanged: urlAfter !== urlBefore,
      focus: describeFocus(),
    }, extra || {});
  }

  /* ---------- 按键的默认行为补偿 ---------- */

  // 能用选区 API 编辑的单行/多行文本框（number、email 等类型的 selectionStart 读取会抛错或为 null）
  function textField(el) {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
    try { return typeof el.selectionStart === 'number'; } catch { return false; }
  }

  // 文本框里某个字符位置所在行的行框顶边（相对内容区，含上内边距）与行高。
  // 用一个排版相同、不可见的镜像 div 量：自动换行之后的视觉行，只能这样算出来
  function caretBox(field, pos, view) {
    const d = field.ownerDocument;
    const cs = view.getComputedStyle(field);
    const mirror = d.createElement('div');
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'textTransform', 'wordSpacing', 'textIndent', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight']) {
      mirror.style[k] = cs[k];
    }
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    mirror.style.cssText += ';position:absolute;visibility:hidden;left:-99999px;top:0;box-sizing:content-box;' +
      'white-space:pre-wrap;overflow-wrap:break-word;border:0;width:' + Math.max(0, field.clientWidth - padX) + 'px';
    mirror.textContent = field.value.slice(0, pos);
    const mark = d.createElement('span');
    mark.textContent = '\u200b';
    mirror.appendChild(mark);
    (d.body || d.documentElement).appendChild(mirror);
    // 零宽标记只有字形那么高，行框比它高出上下各半个行距
    const glyph = mark.offsetHeight || 16;
    const height = parseFloat(cs.lineHeight) || glyph * 1.2;
    const box = { top: mark.offsetTop - (height - glyph) / 2, height };
    mirror.remove();
    return box;
  }

  // 光标所在行滚进文本框的可见范围（setSelectionRange 本身不滚），返回实际滚动量
  function revealCaret(field, view) {
    if (field.scrollHeight <= field.clientHeight) return 0;
    const cs = view.getComputedStyle(field);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const box = caretBox(field, field.selectionEnd, view);
    const before = field.scrollTop;
    if (box.top - padTop < field.scrollTop) field.scrollTop = Math.max(0, Math.round(box.top - padTop));
    else if (box.top + box.height + padBottom > field.scrollTop + field.clientHeight) {
      field.scrollTop = Math.round(box.top + box.height + padBottom - field.clientHeight);
    }
    return Math.round(field.scrollTop - before);
  }

  // 元素自身或最近的可滚动祖先；都不能滚就是整页
  function scrollHost(node, view, vertical) {
    const d = node.ownerDocument;
    for (let n = node; n && n.nodeType === 1 && n !== d.body && n !== d.documentElement; n = n.parentElement) {
      const st = view.getComputedStyle(n);
      const ov = vertical ? st.overflowY : st.overflowX;
      const room = vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth;
      if (room && (ov === 'auto' || ov === 'scroll' || ov === 'overlay')) return { el: n, page: false };
    }
    return { el: d.scrollingElement || d.documentElement, page: true };
  }

  // 滚动一个容器并量出实际滚了多少（到顶/到底时为 0）
  function scrollBy(host, vertical, delta, to) {
    const prop = vertical ? 'scrollTop' : 'scrollLeft';
    const before = host[prop];
    host[prop] = to != null ? to : before + delta;
    return Math.round(host[prop] - before);
  }

  /**
   * 补上合成按键缺失的浏览器默认行为，返回实际效果（moved 表示有没有产生变化）：
   *   { kind:'caret', moved, from?, to?, px? }  移动光标；文本框带字符位置，并把光标所在行滚进可见范围，
   *                                         px 为这一步让文本框滚动的量（光标没动、只是滚回光标处也算有变化）
   *   { kind:'scroll', moved, where, px }   滚动文本框（field）、所在区域（area）或整页（page），px 为实际滚动量
   *   { kind:'delete', moved, removed }     Backspace/Delete 删掉的字符数
   * 不需要补偿的按键（Escape 等）与原生控件自有键盘行为的（select、勾选框、滑块等）返回 null。
   * 方向键上下按逻辑行移动（自动换行的长段落里一次跨过整段），PageUp/PageDown 按可见高度滚动。
   */
  function keyDefault(key, target, view) {
    const tag = target.tagName ? target.tagName.toUpperCase() : '';
    const NAV = { Home: 1, End: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1 };
    const isDelete = key === 'Backspace' || key === 'Delete';
    if (!NAV[key] && !isDelete) return null;
    const d = target.ownerDocument;

    // 文本框
    if (textField(target)) {
      if (isDelete) {
        const len = target.value.length;
        let ok = false;
        try { ok = d.execCommand(key === 'Delete' ? 'forwardDelete' : 'delete'); } catch { ok = false; }
        const removed = ok ? len - target.value.length : 0;
        return { kind: 'delete', moved: removed > 0, removed };
      }
      const multi = tag === 'TEXTAREA';
      if (multi && (key === 'PageUp' || key === 'PageDown')) {
        const px = scrollBy(target, true, (key === 'PageDown' ? 1 : -1) * Math.round(target.clientHeight * 0.9));
        return { kind: 'scroll', moved: px !== 0, where: 'field', px };
      }
      const v = target.value;
      const back = key === 'Home' || key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp';
      const from = back ? target.selectionStart : target.selectionEnd;
      const lineStart = (i) => v.lastIndexOf('\n', i - 1) + 1;
      const lineEnd = (i) => { const n = v.indexOf('\n', i); return n === -1 ? v.length : n; };
      let to = from;
      if (key === 'Home') to = multi ? lineStart(from) : 0;
      else if (key === 'End') to = multi ? lineEnd(from) : v.length;
      else if (key === 'ArrowLeft') to = Math.max(0, from - 1);
      else if (key === 'ArrowRight') to = Math.min(v.length, from + 1);
      else if (!multi) to = key === 'ArrowUp' || key === 'PageUp' ? 0 : v.length;
      else {
        // 上下移一行，保持列位置；首行再往上到开头，末行再往下到结尾
        const col = from - lineStart(from);
        if (key === 'ArrowUp') {
          const s = lineStart(from);
          to = s === 0 ? 0 : Math.min(lineStart(s - 1) + col, s - 1);
        } else {
          const e = lineEnd(from);
          to = e === v.length ? v.length : Math.min(e + 1 + col, lineEnd(e + 1));
        }
      }
      try { target.setSelectionRange(to, to); } catch { return null; }
      const px = multi ? revealCaret(target, view) : 0;
      return { kind: 'caret', moved: from !== to || px !== 0, from, to, px };
    }

    // 原生控件自带的键盘行为（下拉、勾选、滑块、日期等）不在这里模拟
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return null;

    // 富文本编辑区：Selection.modify 按视觉行移动光标，删字走 execCommand（产生真实的 input 事件）
    if (selfEditable(target) || (target.closest && target.closest('[contenteditable]:not([contenteditable=false])'))) {
      const sel = view.getSelection();
      if (isDelete) {
        const before = (target.textContent || '').length;
        try { d.execCommand(key === 'Delete' ? 'forwardDelete' : 'delete'); } catch { /* 按没删处理 */ }
        const removed = Math.max(0, before - (target.textContent || '').length);
        return { kind: 'delete', moved: removed > 0, removed };
      }
      const MOVES = {
        Home: ['backward', 'lineboundary'], End: ['forward', 'lineboundary'],
        ArrowLeft: ['backward', 'character'], ArrowRight: ['forward', 'character'],
        ArrowUp: ['backward', 'line'], ArrowDown: ['forward', 'line'],
      };
      if (MOVES[key] && sel && typeof sel.modify === 'function' && sel.rangeCount) {
        const r0 = sel.getRangeAt(0);
        const before = [r0.endContainer, r0.endOffset];
        sel.modify('move', MOVES[key][0], MOVES[key][1]);
        const r1 = sel.getRangeAt(0);
        const host = r1.endContainer.nodeType === 1 ? r1.endContainer : r1.endContainer.parentElement;
        if (host && host.scrollIntoView) host.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        return { kind: 'caret', moved: before[0] !== r1.endContainer || before[1] !== r1.endOffset };
      }
    }

    // 其余：滚动焦点所在的可滚动区域，没有就滚整页；Backspace/Delete 在可编辑区之外没有默认行为
    if (isDelete) return null;
    const vertical = key !== 'ArrowLeft' && key !== 'ArrowRight';
    const host = scrollHost(target, view, vertical);
    const page = Math.round((host.page ? view.innerHeight : host.el.clientHeight) * 0.9);
    const STEP = 40;
    let px = 0;
    if (key === 'PageDown' || key === 'PageUp') px = scrollBy(host.el, true, key === 'PageDown' ? page : -page);
    else if (key === 'Home') px = scrollBy(host.el, true, 0, 0);
    else if (key === 'End') px = scrollBy(host.el, true, 0, host.el.scrollHeight);
    else if (key === 'ArrowDown' || key === 'ArrowUp') px = scrollBy(host.el, true, key === 'ArrowDown' ? STEP : -STEP);
    else if (key === 'ArrowLeft' || key === 'ArrowRight') px = scrollBy(host.el, false, key === 'ArrowRight' ? STEP : -STEP);
    return { kind: 'scroll', moved: px !== 0, where: host.page ? 'page' : 'area', px };
  }

  // 可见表格收集：遍历顺序与剪枝规则必须与 snapshot.js 完全一致（含内嵌框架的下钻），
  // 否则 table_index 会与页面结构里标注的 #N 对不上
  function collectTables() {
    const out = [];
    (function walk(node) {
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') return;
      if (isHidden(node)) return;
      if (tag === 'IFRAME' || tag === 'FRAME') {
        const body = frameRoot(node);
        if (body) walk(body);
        return;
      }
      if (tag === 'TABLE') out.push(node);
      for (const child of node.children) walk(child);
    })(doc.body);
    return out;
  }

  function cellText(cell) {
    return (cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  }

  // <table> 转 Markdown（与 snapshot.js 同一算法，自包含约束下必须各存一份）
  function tableToMarkdown(table) {
    const rows = Array.prototype.filter.call(
      table.querySelectorAll('tr'),
      (tr) => tr.closest('table') === table
    );
    if (!rows.length) return { text: '', rowCount: 0, colCount: 0 };
    const rowCells = rows.map((tr) =>
      Array.prototype.filter.call(tr.children, (c) => c.tagName === 'TH' || c.tagName === 'TD')
    );
    let headerIdx = rowCells.findIndex((cells) => cells.some((c) => c.tagName === 'TH'));
    if (headerIdx === -1) headerIdx = 0;
    const header = (rowCells[headerIdx] || []).map(cellText);
    if (!header.length) return { text: '', rowCount: rows.length, colCount: 0 };
    const lines = [];
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
    rowCells.forEach((cells, idx) => {
      if (idx === headerIdx || !cells.length) return;
      const texts = cells.map(cellText);
      while (texts.length < header.length) texts.push('');
      lines.push('| ' + texts.slice(0, header.length).join(' | ') + ' |');
    });
    return { text: lines.join('\n'), rowCount: rows.length, colCount: header.length };
  }

  /* ---------- 动作分派 ---------- */

  switch (action) {
    /* —— 点击 —— */
    case 'click': {
      const got = resolveElement(opts.ref, true);
      if (got.err) return { ok: false, reason: got.err };
      const el = got.el;
      const box = got.box;
      const ewin = got.view;
      const name = nameOf(el) || nameOf(box);
      if (isDisabled(el)) return { ok: false, reason: 'disabled', name };

      // 视口外先滚到中央；instant 避免平滑滚动与随后的坐标测量产生竞态
      if (offscreen(box)) box.scrollIntoView({ block: 'center', behavior: 'instant' });
      // 事件坐标以元素所在文档的视口为原点，框架内元素不必换算到顶层
      const r = box.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const base = {
        bubbles: true, cancelable: true, composed: true, view: ewin,
        clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0,
      };
      const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
      // 点在代理上：label 的激活行为把点击转发给控件，与真实用户的路径一致
      const target = hitTarget(box, cx, cy);
      // 聚焦命中点所在、最近的可聚焦元素：真实点击由 mousedown 的默认行为完成这一步，合成事件没有。
      // 找到的在元素之外时（元素本身不可聚焦而祖先可聚焦）只尝试元素本身：动作只作用于模型点的元素及其内部
      const focusable = target.closest('a[href],button,input,select,textarea,[tabindex],[contenteditable]:not([contenteditable=false])');
      try { (focusable && box.contains(focusable) ? focusable : el).focus({ preventScroll: true }); } catch { /* 不可聚焦元素忽略 */ }
      // 完整还原真实鼠标事件序列：只发 click 会让依赖 mousedown 的菜单/拖拽组件失效
      target.dispatchEvent(new ewin.PointerEvent('pointerdown', { ...base, ...pointer, buttons: 1 }));
      target.dispatchEvent(new ewin.MouseEvent('mousedown', { ...base, buttons: 1 }));
      target.dispatchEvent(new ewin.PointerEvent('pointerup', { ...base, ...pointer, buttons: 0 }));
      target.dispatchEvent(new ewin.MouseEvent('mouseup', { ...base, buttons: 0 }));
      // 收尾用原生 click()：链接跳转、表单提交、勾选态切换等默认行为最稳；
      // 从内部子元素发起同样生效（激活行为沿冒泡路径找到最近的链接/按钮/label）
      target.click();

      const out = { ref: opts.ref, name };
      if (typeof el.checked === 'boolean') out.checked = el.checked;
      return finish(out);
    }

    /* —— 输入（整体替换原值） —— */
    case 'input': {
      const got = resolveElement(opts.ref, true);
      if (got.err) return { ok: false, reason: got.err };
      const el = got.el;
      const ewin = got.view;
      const name = nameOf(el);
      if (isDisabled(el) || el.readOnly) return { ok: false, reason: 'disabled', name };

      const text = String(opts.text == null ? '' : opts.text);
      const tag = el.tagName.toUpperCase();
      const isPassword = tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
      try { el.focus({ preventScroll: true }); } catch { /* 忽略 */ }

      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        setNativeValue(el, text, ewin);
      } else if (selfEditable(el)) {
        // 富文本编辑器：execCommand 产生真实 InputEvent，编辑器的内部模型与撤销栈才会同步。
        // 选区与 execCommand 都是按文档的：编辑区在框架里（TinyMCE 等）就得用框架自己的那一份
        let done = false;
        try {
          const sel = ewin.getSelection();
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          done = el.ownerDocument.execCommand('insertText', false, text);
        } catch { done = false; }
        if (!done) {
          el.textContent = text;
          el.dispatchEvent(new ewin.InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        }
      } else {
        return { ok: false, reason: 'not-editable', name };
      }

      return finish({
        ref: opts.ref, name,
        value: isPassword ? S.passwordMasked : clamp(text, 80),
      });
    }

    /* —— 下拉选择 —— */
    case 'select': {
      const got = resolveElement(opts.ref, true);
      if (got.err) return { ok: false, reason: got.err };
      const el = got.el;
      const name = nameOf(el);
      if (el.tagName.toUpperCase() !== 'SELECT') return { ok: false, reason: 'not-select', name };
      if (isDisabled(el)) return { ok: false, reason: 'disabled', name };

      const want = String(opts.option == null ? '' : opts.option).trim();
      const options = Array.prototype.map.call(el.options, (o) => ({
        value: o.value || '',
        text: (o.textContent || '').replace(/\s+/g, ' ').trim(),
      }));
      // 匹配顺序：选项文本精确 → 文本包含 → value 精确
      let hit = options.findIndex((o) => o.text === want);
      if (hit === -1 && want) hit = options.findIndex((o) => o.text.indexOf(want) !== -1);
      if (hit === -1) hit = options.findIndex((o) => o.value === want);
      if (hit === -1) {
        // 把可选项还给模型，让它用真实存在的选项重试
        return {
          ok: false, reason: 'option-not-found', name,
          options: options.slice(0, 20).map((o) => o.text || o.value),
          total: options.length,
        };
      }

      el.selectedIndex = hit;
      el.dispatchEvent(new got.view.Event('input', { bubbles: true }));
      el.dispatchEvent(new got.view.Event('change', { bubbles: true }));
      return finish({ ref: opts.ref, name, value: options[hit].text || options[hit].value });
    }

    /* —— 按键 —— */
    case 'key': {
      const KEYS = {
        Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
        Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
        Home: { key: 'Home', code: 'Home', keyCode: 36 },
        End: { key: 'End', code: 'End', keyCode: 35 },
      };
      const spec = KEYS[opts.key];
      if (!spec) return { ok: false, reason: 'bad-key' };

      let target;
      if (opts.ref != null) {
        const got = resolveElement(opts.ref, true);
        if (got.err) return { ok: false, reason: got.err };
        target = got.el;
        try { target.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      } else {
        target = activeElement() || doc.body;
      }
      const twin = viewOf(target) || win;
      const tdoc = target.ownerDocument || doc;

      // keyCode/which 已废弃但必须带：行内大量 jQuery 老系统仍在读它们
      const init = {
        key: spec.key, code: spec.code, keyCode: spec.keyCode, which: spec.keyCode,
        bubbles: true, cancelable: true, composed: true, view: twin,
      };
      const prevented = !target.dispatchEvent(new twin.KeyboardEvent('keydown', init));
      if (spec.key === 'Enter') target.dispatchEvent(new twin.KeyboardEvent('keypress', init));
      target.dispatchEvent(new twin.KeyboardEvent('keyup', init));

      // 合成键盘事件不触发浏览器默认行为，这里按键语义手动补全（页面已 preventDefault 的不补）
      let submitted = false;
      let movedTo = null;
      const effect = prevented ? null : keyDefault(spec.key, target, twin);
      const targetTag = target.tagName ? target.tagName.toUpperCase() : '';
      if (!prevented && spec.key === 'Enter') {
        if (targetTag === 'BUTTON' || targetTag === 'A' || targetTag === 'SUMMARY') {
          target.click();
        } else if (targetTag !== 'TEXTAREA') {
          // 单行输入框里的回车 = 提交所属表单（textarea 的回车是换行，不提交）
          const form = target.form || (target.closest ? target.closest('form') : null);
          if (form) {
            try { form.requestSubmit(); submitted = true; } catch { /* 无提交按钮等情况忽略 */ }
          }
        }
      }
      if (!prevented && spec.key === 'Tab') {
        const list = Array.prototype.filter.call(
          tdoc.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]'),
          (e) => {
            if (e.disabled) return false;
            const ti = e.getAttribute('tabindex');
            if (ti !== null && parseInt(ti, 10) < 0) return false;
            const st = twin.getComputedStyle(e);
            if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
            const rect = e.getBoundingClientRect();
            return rect.width > 0 || rect.height > 0;
          }
        );
        if (list.length) {
          const next = list[(list.indexOf(target) + 1) % list.length];
          try { next.focus({ preventScroll: true }); movedTo = nameOf(next); } catch { /* 忽略 */ }
        }
      }

      return finish({ key: spec.key, target: nameOf(target), prevented, submitted, movedTo, effect });
    }

    /* —— 滚动 —— */
    case 'scroll': {
      const dir = opts.direction || 'down';
      const pages = typeof opts.pages === 'number' && opts.pages > 0 ? Math.min(opts.pages, 10) : 1;
      // 每页按 0.9 屏计，留一成重叠让上下文不断裂
      const step = Math.round(win.innerHeight * 0.9 * pages);
      if (dir === 'top') {
        win.scrollTo({ top: 0, behavior: 'instant' });
      } else if (dir === 'bottom') {
        win.scrollTo({ top: doc.documentElement.scrollHeight, behavior: 'instant' });
      } else {
        win.scrollBy({ top: dir === 'up' ? -step : step, behavior: 'instant' });
      }
      return finish({ direction: dir, pages, viewport: viewportInfo() });
    }

    /* —— 表格完整提取（只读） —— */
    case 'extract_table': {
      const tables = collectTables();
      const idx = Number(opts.tableIndex);
      if (!Number.isInteger(idx) || idx < 1 || idx > tables.length) {
        return { ok: false, reason: 'bad-table-index', total: tables.length };
      }
      const maxLen = opts.maxLen || 50000;
      const { text, rowCount, colCount } = tableToMarkdown(tables[idx - 1]);
      const truncated = text.length > maxLen;
      return finish({
        tableIndex: idx, total: tables.length, rowCount, colCount, truncated,
        data: truncated ? text.slice(0, maxLen) + S.tableTruncated : text,
      });
    }

    /* —— 元素精简 HTML（只读） —— */
    case 'get_html': {
      const got = resolveElement(opts.ref, false);
      if (got.err) return { ok: false, reason: got.err };
      const maxLen = opts.maxLen || 4000;
      const ALLOWED = {
        id: 1, class: 1, href: 1, src: 1, alt: 1, title: 1, role: 1,
        type: 1, name: 1, value: 1, placeholder: 1, 'data-action': 1, 'data-testid': 1,
      };
      // 属性白名单 + 长值截断：保留结构语义，去掉框架生成的巨量噪音属性
      function filterAttrs(node) {
        for (const attr of Array.prototype.slice.call(node.attributes)) {
          const n = attr.name.toLowerCase();
          if (ALLOWED[n] || n.indexOf('aria-') === 0) {
            if (attr.value.length > 80) node.setAttribute(attr.name, attr.value.slice(0, 80) + '…');
          } else {
            node.removeAttribute(attr.name);
          }
        }
      }
      const clone = got.el.cloneNode(true);
      // 克隆只带着 HTML 里写的初值；输入框与文本框换成当前值，密码框打码（克隆与原件结构一一对应）
      const fieldsOf = (root) => [root, ...root.querySelectorAll('input,textarea')]
        .filter((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');
      const liveFields = fieldsOf(got.el);
      const cloneFields = fieldsOf(clone);
      filterAttrs(clone);
      (function strip(node) {
        for (const child of Array.prototype.slice.call(node.childNodes)) {
          if (child.nodeType === 8) { child.remove(); continue; } // 注释
          if (child.nodeType !== 1) continue;
          const tag = child.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') { child.remove(); continue; }
          filterAttrs(child);
          strip(child);
        }
      })(clone);
      liveFields.forEach((src, i) => {
        const dst = cloneFields[i];
        const type = (src.getAttribute('type') || '').toLowerCase();
        if (src.tagName === 'TEXTAREA') dst.textContent = src.value;
        else if (type === 'password') dst.setAttribute('value', src.value ? S.passwordMasked : '');
        else if (type !== 'checkbox' && type !== 'radio' && type !== 'hidden') dst.setAttribute('value', src.value);
      });

      let html = (clone.outerHTML || '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
      const truncated = html.length > maxLen;
      if (truncated) html = html.slice(0, maxLen) + S.htmlTruncated;
      return finish({ ref: opts.ref, name: nameOf(got.el), truncated, data: html });
    }

    /* —— 调试通道：定位点击点 —— */
    case 'locate': {
      const got = resolveElement(opts.ref, true);
      if (got.err) return { ok: false, reason: got.err };
      const el = got.el;
      const box = got.box;
      const name = nameOf(el) || nameOf(box);
      if (isDisabled(el)) return { ok: false, reason: 'disabled', name };
      if (offscreen(box)) box.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = box.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      // 真实点击落在哪里就作用于哪里：中心点被遮罩挡住、或落在卡片里另一个独立控件上时，
      // 合成事件可以直接派发给目标，真实点击做不到——标 unsafe，由调试通道退回合成事件
      let hit = null;
      try { hit = el.ownerDocument.elementFromPoint(cx, cy); } catch { hit = null; }
      while (hit && typeof hit.click !== 'function') hit = hit.parentElement;
      const safe = Boolean(hit) && (hit === box || box.contains(hit)) && hitTarget(box, cx, cy) === hit;
      // 框架内的坐标换算到顶层视口：逐层加上框架内容区的偏移
      let x = cx;
      let y = cy;
      for (let v = viewOf(el); v && v !== win && v.frameElement; v = viewOf(v.frameElement)) {
        const fr = v.frameElement.getBoundingClientRect();
        x += fr.left + v.frameElement.clientLeft;
        y += fr.top + v.frameElement.clientTop;
      }
      return finish({ ref: opts.ref, name, x: Math.round(x), y: Math.round(y), safe });
    }

    /* —— 调试通道：聚焦（输入前选中全部内容，真实输入随后整体替换） —— */
    case 'focus': {
      const got = resolveElement(opts.ref, true);
      if (got.err) return { ok: false, reason: got.err };
      const el = got.el;
      const name = nameOf(el);
      if (isDisabled(el) || el.readOnly) return { ok: false, reason: 'disabled', name };
      try { el.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      const editable = textField(el) || selfEditable(el);
      if (opts.select && editable) {
        if (textField(el)) el.select();
        else {
          const sel = got.view.getSelection();
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      const password = el.tagName.toUpperCase() === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
      return finish({ ref: opts.ref, name, editable, password });
    }

    /* —— 调试通道：焦点、光标与滚动的快照 —— */
    case 'probe': {
      const a = activeElement();
      const d = a ? a.ownerDocument : doc;
      const view = (a && viewOf(a)) || win;
      const field = Boolean(a) && textField(a);
      const scroller = d.scrollingElement || d.documentElement;
      const area = a && a !== d.body ? scrollHost(a, view, true) : null;
      return finish({
        active: a && a !== d.body ? nameOf(a) || a.tagName.toLowerCase() : '',
        field,
        caret: field ? a.selectionEnd : null,
        length: field ? a.value.length : (a && selfEditable(a) ? (a.textContent || '').length : null),
        fieldTop: field ? a.scrollTop : null,
        areaTop: area && !area.page ? area.el.scrollTop : null,
        pageTop: scroller.scrollTop,
      });
    }

    default:
      return { ok: false, reason: 'bad-action' };
  }
}
