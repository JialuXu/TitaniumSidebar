// core/snapshot.js —— 页面快照：文本 + 结构骨架 + 可交互元素，单次遍历三通道同过（平台无关层）
//
// 重要约束：snapshotPage 必须保持“完全自包含”——函数体内不引用任何模块级变量
// 或外部辅助函数。扩展外壳把整个函数对象交给 chrome.scripting.executeScript
// 序列化后注入目标页面执行（运行在 ISOLATED world，闭包全部丢失）；
// SDK/测试场景则直接在宿主页面环境调用。
//
// ref → 元素句柄的映射保存在 isolated world 的 window.__titanium 全局里
// （不污染宿主页面的 JS 环境、不修改宿主 DOM，页面导航后自动失效），
// 供后续的高亮注入、元素列表刷新按 ref 找回元素。返回值只含 JSON 数据。

/**
 * 页面快照。两种模式：
 *   mode:'full'     —— 首条消息/「重新读取」：完整遍历，产出文本、结构骨架、元素列表，
 *                      并重建 window.__titanium 的 ref 映射（session 换新）。
 *   mode:'elements' —— 工具调用（元素列表/截图标注前）：基于既有 ref 映射增量刷新——
 *                      老元素保号、失效元素跳过、新元素续编 ref；session 不符返回 stale。
 * @param {{ mode?: 'full'|'elements', session?: string,
 *           maxTextLen?: number, maxElements?: number }} [options] 经 executeScript args 传入
 */
export function snapshotPage(options) {
  const opts = options || {};
  const mode = opts.mode || 'full';
  const MAX_TEXT = opts.maxTextLen || 12000;
  const MAX_ELEMENTS = opts.maxElements || 300;

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return { ok: false, reason: 'no-window' };

  /* ---------- 公共辅助 ---------- */

  function clamp(s, max) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  // 隐藏判定：display:none / visibility:hidden 的子树整体剪枝
  function isHidden(el) {
    const style = win.getComputedStyle(el);
    return style && (style.display === 'none' || style.visibility === 'hidden');
  }

  // 可交互元素判定：命中返回角色名，未命中返回空串
  function interactiveRole(el) {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return '';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button', 'link', 'tab', 'checkbox', 'radio', 'combobox', 'menuitem', 'switch'].indexOf(role) !== -1) {
      return role;
    }
    if (el.hasAttribute('onclick')) return 'clickable';
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) >= 0) return 'clickable';
    return '';
  }

  // 可访问名：可见文本 → aria-label → 关联 label → placeholder → 按钮 value → title → 内部图片 alt
  function accessibleName(el) {
    const text = (el.textContent || '').trim();
    if (text) return clamp(text, 80);
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clamp(aria, 80);
    if (el.labels && el.labels.length && el.labels[0].textContent.trim()) {
      return clamp(el.labels[0].textContent, 80);
    }
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return clamp(ph, 80);
    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.type || '') && el.value) {
      return clamp(el.value, 80);
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return clamp(title, 80);
    const img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img && img.getAttribute('alt') && img.getAttribute('alt').trim()) {
      return clamp(img.getAttribute('alt'), 80);
    }
    return '';
  }

  // 表单控件当前值：密码框一律不取（隐私）；勾选类返回勾选态
  function controlValue(el, role) {
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      return el.checked ? '已选中' : null;
    }
    if (role === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return opt ? clamp(opt.textContent, 80) : null;
    }
    if (role === 'textbox') {
      if ((el.getAttribute('type') || '').toLowerCase() === 'password') return null;
      return el.value ? clamp(el.value, 80) : null;
    }
    return null;
  }

  // 生成单个元素的 ElementInfo（bbox 为相对视口的 CSS 像素）
  function elementInfo(el, ref) {
    const role = interactiveRole(el) || 'clickable';
    const rect = el.getBoundingClientRect();
    const bbox = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
    const tag = el.tagName.toLowerCase();
    return {
      ref, role, tag,
      name: accessibleName(el),
      href: tag === 'a' ? clamp(el.getAttribute('href') || '', 120) || null : null,
      value: controlValue(el, role),
      disabled: Boolean(el.disabled),
      bbox,
      inViewport: bbox.w > 0 && bbox.h > 0 &&
        bbox.x < win.innerWidth && bbox.y < win.innerHeight &&
        bbox.x + bbox.w > 0 && bbox.y + bbox.h > 0,
    };
  }

  function viewportInfo() {
    return {
      w: win.innerWidth, h: win.innerHeight,
      dpr: win.devicePixelRatio || 1,
      scrollX: Math.round(win.scrollX), scrollY: Math.round(win.scrollY),
      docW: doc.documentElement.scrollWidth, docH: doc.documentElement.scrollHeight,
    };
  }

  // 遍历（隐藏剪枝 + 黑名单跳过），对每个命中的可交互元素回调
  function walkInteractive(root, onHit) {
    const tag = root.tagName ? root.tagName.toUpperCase() : '';
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'IFRAME') return;
    if (isHidden(root)) return;
    if (interactiveRole(root)) onHit(root);
    for (const child of root.children) walkInteractive(child, onHit);
  }

  /* ---------- mode:'elements'：基于既有映射增量刷新 ---------- */

  if (mode === 'elements') {
    const store = win.__titanium;
    if (!store || !Array.isArray(store.elements)) return { ok: false, reason: 'stale' };
    if (opts.session && store.session !== opts.session) return { ok: false, reason: 'stale' };

    // 扫描当前 DOM：既有元素保号（数组下标即 ref-1），新元素续编
    const known = new Set(store.elements);
    let overflow = false;
    walkInteractive(doc.body, (el) => {
      if (known.has(el)) return;
      if (store.elements.length >= MAX_ELEMENTS) { overflow = true; return; }
      store.elements.push(el);
      known.add(el);
    });

    // 产出仍然存活的元素（脱离文档或已无盒子的跳过，但保留槽位保证 ref 稳定）
    const elements = [];
    store.elements.forEach((el, i) => {
      if (!el || !el.isConnected || isHidden(el)) return;
      const info = elementInfo(el, i + 1);
      if (info.bbox.w === 0 && info.bbox.h === 0) return;
      elements.push(info);
    });

    return {
      ok: true, elements, viewport: viewportInfo(), session: store.session,
      stats: { totalElements: elements.length, elementsTruncated: overflow },
    };
  }

  /* ---------- mode:'full'：单次递归遍历，三通道同过 ---------- */

  // —— 文本通道（沿用原 extractor 的规则：块级补换行、li 前缀、表格转 Markdown）——
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'UL', 'OL', 'LI',
    'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'PRE', 'FORM', 'FIELDSET', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'TR',
    'HR', 'DETAILS', 'SUMMARY',
  ]);

  const textOut = [];
  let textLenApprox = 0;
  let textDone = false; // 攒够（留出压缩富余）后关闭文本通道，元素/骨架继续采
  function pushText(s) {
    if (textDone || !s) return;
    textOut.push(s);
    textLenApprox += s.length;
    if (textLenApprox > MAX_TEXT * 2) textDone = true;
  }

  function cellText(cell) {
    return (cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  }

  // <table> 转 Markdown：表头取首个含 th 的行（没有则取首行），列数以表头为准
  function tableToMarkdown(table) {
    const rows = Array.prototype.filter.call(
      table.querySelectorAll('tr'),
      (tr) => tr.closest('table') === table
    );
    if (!rows.length) return '';
    const rowCells = rows.map((tr) =>
      Array.prototype.filter.call(tr.children, (c) => c.tagName === 'TH' || c.tagName === 'TD')
    );
    let headerIdx = rowCells.findIndex((cells) => cells.some((c) => c.tagName === 'TH'));
    if (headerIdx === -1) headerIdx = 0;
    const header = (rowCells[headerIdx] || []).map(cellText);
    if (!header.length) return '';
    const lines = [];
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
    rowCells.forEach((cells, idx) => {
      if (idx === headerIdx || !cells.length) return;
      const texts = cells.map(cellText);
      while (texts.length < header.length) texts.push('');
      lines.push('| ' + texts.slice(0, header.length).join(' | ') + ' |');
    });
    return lines.join('\n');
  }

  // —— 骨架通道 ——
  const LANDMARK_TAGS = { HEADER: 'header', NAV: 'nav', MAIN: 'main', ASIDE: 'aside', FOOTER: 'footer', FORM: 'form' };
  const LANDMARK_ROLES = { banner: 'header', navigation: 'nav', main: 'main', complementary: 'aside', contentinfo: 'footer', form: 'form', region: 'section' };
  const MAX_OUTLINE_NODES = 150;
  const outline = [];

  // landmark 名称：aria-label → 内部首个标题 → 空
  function landmarkName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clamp(aria, 40);
    const h = el.querySelector ? el.querySelector('h1,h2,h3,h4') : null;
    if (h && h.textContent.trim()) return clamp(h.textContent, 40);
    return '';
  }

  function pushOutline(node) {
    if (outline.length < MAX_OUTLINE_NODES) outline.push(node);
  }

  // —— 元素通道 ——
  const elements = [];
  const liveRefs = []; // 与 elements 同序的元素句柄，遍历结束后写入 window.__titanium
  let totalInteractive = 0;

  // —— 主遍历 ——
  // textOn：进入 nav/header/footer 或表格内部后置 false（文本不采，元素/骨架继续）；
  // depth：骨架层级，进入 landmark 时 +1（封顶 4 级）。
  function visit(node, textOn, depth) {
    if (node.nodeType === 3) {
      if (textOn) pushText(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'IFRAME') return;
    if (isHidden(node)) return;

    // 元素通道
    if (interactiveRole(node)) {
      totalInteractive++;
      if (elements.length < MAX_ELEMENTS) {
        liveRefs.push(node);
        elements.push(elementInfo(node, liveRefs.length));
      }
    }

    // 骨架通道
    const role = (node.getAttribute('role') || '').toLowerCase();
    const landmark = LANDMARK_TAGS[tag] ||
      LANDMARK_ROLES[role] ||
      (tag === 'SECTION' && node.getAttribute('aria-label') ? 'section' : '');
    if (landmark) {
      pushOutline({ kind: 'landmark', tag: landmark, name: landmarkName(node), depth });
      depth = Math.min(depth + 1, 4);
    } else if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') {
      pushOutline({ kind: 'heading', tag: tag.toLowerCase(), level: Number(tag[1]), name: clamp(node.textContent, 40), depth });
    }

    // 文本通道
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') textOn = false;
    if (tag === 'BR') {
      if (textOn) pushText('\n');
      return;
    }
    if (tag === 'TABLE') {
      const rows = node.querySelectorAll('tr').length;
      const cols = node.querySelector('tr') ? node.querySelector('tr').children.length : 0;
      pushOutline({ kind: 'block', tag: 'table', name: '', depth, meta: `${rows}行×${cols}列` });
      if (textOn) pushText('\n\n' + tableToMarkdown(node) + '\n\n');
      // 表格文字已随 Markdown 带出，下钻只为收集表内交互元素
      for (const child of node.childNodes) visit(child, false, depth);
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (textOn && isBlock) pushText('\n');
    if (textOn && tag === 'LI') pushText('- ');
    for (const child of node.childNodes) visit(child, textOn, depth);
    if (textOn && isBlock) pushText('\n');
  }

  visit(doc.body, true, 0);

  // 空白压缩 + 截断（与原 extractor 一致）
  let text = textOut
    .join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const textTruncated = text.length > MAX_TEXT;
  if (textTruncated) text = text.slice(0, MAX_TEXT) + '……（内容过长已截断）';

  // 重建 ref 映射（session 换新，旧 session 的 ref 全部作废）
  const session = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  win.__titanium = { session, elements: liveRefs };

  const title = (doc.title || '').trim();
  const url = doc.location ? doc.location.href : '';
  if (!text && !elements.length) return { ok: false, reason: 'empty', title, url };
  return {
    ok: true, title, url, text, outline, elements,
    viewport: viewportInfo(), session,
    stats: {
      totalElements: totalInteractive,
      textTruncated,
      elementsTruncated: totalInteractive > elements.length,
    },
  };
}
