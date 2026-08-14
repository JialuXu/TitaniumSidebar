// core/snapshot.js —— 页面快照：文本 + 结构骨架 + 可交互元素，单次遍历三通道同过（平台无关层）
//
// 重要约束：snapshotPage 必须保持“完全自包含”——函数体内不引用任何模块级变量
// 或外部辅助函数。扩展外壳把整个函数对象交给 chrome.scripting.executeScript
// 序列化后注入目标页面执行（运行在 ISOLATED world，闭包全部丢失）；
// SDK/测试场景则直接在宿主页面环境调用。
//
// ref → 元素句柄的映射保存在 isolated world 的 window.__titanium 全局里
// （不污染宿主页面的 JS 环境、不修改宿主 DOM，页面导航后自动失效），
// 供后续的高亮/动作注入、元素列表刷新按 ref 找回元素。返回值只含 JSON 数据。
//
// window.__titanium = {
//   session,          // 本次 full 快照的标识，ref 的有效期凭证
//   elements,         // 稀疏数组，下标 +1 = ref；失效元素留空槽，保证 ref 永不左移
//   seenMax,          // 已序列化给模型看过的最大 ref，超过它的元素标记为「新出现」
// }

/**
 * 页面快照。两种模式：
 *   mode:'full'     —— 首条消息/「重新读取」：完整遍历，产出文本、结构骨架、元素列表，
 *                      并重建 window.__titanium 的 ref 映射（session 换新）。
 *                      传 inheritRefs 时尝试让新映射继承旧 ref（见下）。
 *   mode:'elements' —— 工具调用（元素列表/截图标注前）：基于既有 ref 映射增量刷新——
 *                      老元素保号、失效元素跳过、新元素续编 ref；session 不符返回 stale。
 * @param {{ mode?: 'full'|'elements', session?: string, inheritRefs?: boolean,
 *           maxTextLen?: number, maxElements?: number }} [options] 经 executeScript args 传入
 */
export function snapshotPage(options) {
  const opts = options || {};
  const mode = opts.mode || 'full';
  const MAX_TEXT = opts.maxTextLen || 12000;
  // 元素编号上限是防失控的宽松保险丝，不是 token 预算——token 由序列化端的
  // 字符预算与同构折叠约束。收得太紧会让增量刷新编不进新元素（动作后新出现的
  // 按钮拿不到 ref），且必须配合把 elementsTruncated 显式告知模型。
  const MAX_ELEMENTS = opts.maxElements || 1500;

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return { ok: false, reason: 'no-window' };

  /* ---------- 公共辅助（两种模式共用，必须定义在模式分支之前） ---------- */

  // 遍历黑名单：无文字价值或无法跨文档读取
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, IFRAME: 1 };

  // ARIA 交互角色白名单：显式声明这些 role 的元素按其语义当作可操作控件
  const INTERACTIVE_ROLES = {
    button: 1, link: 1, tab: 1, checkbox: 1, radio: 1, combobox: 1, menuitem: 1,
    switch: 1, textbox: 1, searchbox: 1, slider: 1, spinbutton: 1,
    menuitemcheckbox: 1, menuitemradio: 1, listbox: 1,
  };

  // “整体可点”的容器角色：其内部后代若被完全覆盖则不重复编号（见 dedupeCandidates）
  const CONTAINER_ROLES = { link: 1, button: 1, clickable: 1, tab: 1, menuitem: 1 };

  function clamp(s, max) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  // 可见性判定：可见则返回 computed style（供 cursor 等后续判定复用），隐藏返回 null（子树整体剪枝）
  function visibleStyle(el) {
    const style = win.getComputedStyle(el);
    if (!style) return null;
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    return style;
  }

  // 禁用态：原生 disabled 与 aria-disabled 一并识别（不排除出列表，而是作为标记告知模型）
  function isDisabled(el) {
    return Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
  }

  // 元素自身是否可编辑。浏览器有 isContentEditable 计算属性，
  // 无排版引擎的环境（core 独立测试时）退化到属性判断。
  function selfEditable(el) {
    if (typeof el.isContentEditable === 'boolean') return el.isContentEditable;
    const v = el.getAttribute('contenteditable');
    return v === '' || (v || '').toLowerCase() === 'true';
  }

  // 可交互元素判定：命中返回 { role, weak }，未命中返回 null。
  // weak=true 表示靠启发式（onclick/tabindex/图标尺寸/cursor）猜出来的，
  // 这类候选可能只是可点容器内部的一层包装，会参与包含去重；
  // 由语义标签或显式 ARIA role 认定的强候选永不被父级吞并。
  // style/parentCursor 由调用方在遍历时提供，避免重复 getComputedStyle。
  function interactiveRole(el, style, parentCursor) {
    const tag = el.tagName ? el.tagName.toUpperCase() : '';

    // <label> 点击会转发给关联控件（for 指向的，或内部包裹的），与控件本身重复；
    // 排除以免同一操作出现两个 ref。antd/element-ui 的勾选框全是 label 包裹写法。
    // 内部控件若被 display:none 隐藏则不排除——此时 label 是唯一可点的目标。
    if (tag === 'LABEL') {
      if (el.getAttribute('for')) return null;
      const inner = el.querySelector ? el.querySelector('input,select,textarea,button') : null;
      if (inner && visibleStyle(inner)) return null;
    }

    const strong = (role) => ({ role, weak: false });
    if (tag === 'A') return el.hasAttribute('href') ? strong('link') : null;
    if (tag === 'BUTTON') return strong('button');
    if (tag === 'SELECT') return strong('select');
    if (tag === 'TEXTAREA') return strong('textbox');
    if (tag === 'SUMMARY') return strong('button');
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return strong('button');
      if (t === 'checkbox') return strong('checkbox');
      if (t === 'radio') return strong('radio');
      return strong('textbox');
    }

    const role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES[role]) return strong(role);

    // 富文本编辑器：只取最顶层 contenteditable，内部子节点不重复编号
    if (selfEditable(el) && !(el.parentElement && selfEditable(el.parentElement))) {
      return strong('textbox');
    }

    if (el.hasAttribute('onclick')) return { role: 'clickable', weak: true };
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) >= 0) return { role: 'clickable', weak: true };

    // 图标按钮：无文字的小方块（10–50px 见方），靠 aria-label/data-action 表明可操作
    if (el.getAttribute('aria-label') || el.getAttribute('data-action')) {
      const r = el.getBoundingClientRect();
      if (r.width >= 10 && r.width <= 50 && r.height >= 10 && r.height <= 50) {
        return { role: 'button', weak: true };
      }
    }

    // 兜底：自身声明 cursor:pointer。继承自父级的不算，否则整棵子树都会命中
    if (style && style.cursor === 'pointer' && parentCursor !== 'pointer') {
      return { role: 'clickable', weak: true };
    }

    return null;
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

  // 行锚点：无名或短名控件（列表页每行重复的勾选框、「编辑」「删除」按钮）补所在行
  // 的文字，让模型能区分「哪一行的按钮」；也参与 list_elements 的 query 过滤。
  // 只认语义行容器（tr/li/role=row…）；祖先文本超 300 字说明那是区块而非行，不作锚点
  // （否则会把整个卡片/章节的正文当成锚点，纯噪声）。长名元素自身已可区分，不补。
  function rowContext(el, ownName) {
    if (ownName && ownName.length > 12) return null;
    if (!el.closest) return null;
    const row = el.closest('tr,li,[role="row"],[role="listitem"],article');
    if (!row || row === el) return null;
    const t = (row.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 300) return null;
    const ctx = clamp(t, 40);
    return ctx === ownName ? null : ctx;
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
      if (selfEditable(el)) return clamp(el.textContent, 80) || null;
      return el.value ? clamp(el.value, 80) : null;
    }
    return null;
  }

  // 单个元素的角色（脱离遍历上下文时重算，供输出阶段使用）
  function roleOf(el) {
    const style = win.getComputedStyle(el);
    const parentCursor = el.parentElement ? (win.getComputedStyle(el.parentElement) || {}).cursor : '';
    const hit = interactiveRole(el, style, parentCursor);
    return (hit && hit.role) || 'clickable';
  }

  // 生成单个元素的 ElementInfo（bbox 为相对视口的 CSS 像素）
  function elementInfo(el, ref) {
    const role = roleOf(el);
    const rect = el.getBoundingClientRect();
    const bbox = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
    const tag = el.tagName.toLowerCase();
    const name = accessibleName(el);
    const info = {
      ref, role, tag, name,
      href: tag === 'a' ? clamp(el.getAttribute('href') || '', 120) || null : null,
      value: controlValue(el, role),
      disabled: isDisabled(el),
      bbox,
      inViewport: bbox.w > 0 && bbox.h > 0 &&
        bbox.x < win.innerWidth && bbox.y < win.innerHeight &&
        bbox.x + bbox.w > 0 && bbox.y + bbox.h > 0,
    };
    const ctx = rowContext(el, name);
    if (ctx) info.context = ctx;
    return info;
  }

  function viewportInfo() {
    return {
      w: win.innerWidth, h: win.innerHeight,
      dpr: win.devicePixelRatio || 1,
      scrollX: Math.round(win.scrollX), scrollY: Math.round(win.scrollY),
      docW: doc.documentElement.scrollWidth, docH: doc.documentElement.scrollHeight,
    };
  }

  // 候选收集：与 full 模式主遍历同一套判定规则，供 mode:'elements' 独立遍历使用。
  // aria-hidden 子树对辅助技术不可见，不作为操作目标（文本通道不受影响）。
  function collectCandidates(root) {
    const out = [];
    (function walk(node, parentCursor, ariaHidden) {
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (SKIP_TAGS[tag]) return;
      const style = visibleStyle(node);
      if (!style) return;
      const ah = ariaHidden || node.getAttribute('aria-hidden') === 'true';
      if (!ah) {
        const hit = interactiveRole(node, style, parentCursor);
        if (hit) out.push({ el: node, role: hit.role, weak: hit.weak });
      }
      for (const child of node.children) walk(child, style.cursor, ah);
    })(root, '', false);
    return out;
  }

  // 包含去重：靠启发式认出的弱候选，若被“整体可点”的祖先几乎完全覆盖，就不单独编号。
  // 典型噪音是可点卡片/链接内部那层带 onclick 或 tabindex 的包装 div——
  // 它和外层指向同一次点击，两个 ref 只会让模型犹豫。
  // 语义标签与显式 ARIA role 认定的强候选一律保留：卡片链接里的「加入购物车」按钮
  // 同样是 100% 被包含的，但它是真正独立的操作目标。
  function dedupeCandidates(list) {
    const index = new Map();
    list.forEach((c, i) => index.set(c.el, i));
    const rects = list.map((c) => c.el.getBoundingClientRect());
    return list.filter((c, i) => {
      if (!c.weak) return true;
      let p = c.el.parentElement;
      while (p) {
        const pi = index.get(p);
        if (pi !== undefined) {
          if (!CONTAINER_ROLES[list[pi].role]) return true; // 祖先不是整体可点的容器，保留
          const a = rects[i];
          const b = rects[pi];
          const area = a.width * a.height;
          if (area <= 0) return true;
          const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          return (ox * oy) / area < 0.99; // 被覆盖 ≥99% → 剔除
        }
        p = p.parentElement;
      }
      return true;
    });
  }

  // 元素指纹：祖先标签链 + 自身标签 + 静态属性 + 可访问名。
  // 用于 SPA 重渲染后把旧 ref 继承给“同一个”元素，降低模型手里的编号失效概率。
  // 不含 class（框架会往上刷 hover/active 等瞬态类）、不含 bbox（布局会变）。
  function fingerprint(el) {
    const chain = [];
    let p = el.parentElement;
    while (p && chain.length < 6) {
      chain.push(p.tagName);
      p = p.parentElement;
    }
    const at = (name) => el.getAttribute(name) || '';
    return [
      chain.join('>'), el.tagName,
      at('id'), at('name'), at('aria-label'), at('role'), at('type'), at('placeholder'),
      accessibleName(el),
    ].join('|');
  }

  // 旧映射的指纹表；指纹冲突（多个元素同指纹）整组弃用，宁可重编也不错认。
  // 指纹取自建店时存下的那一份：SPA 重渲染后旧元素已脱离文档，
  // 此刻再算祖先链只会得到空链，与新元素永远对不上。
  function buildFingerprintMap(store) {
    const map = new Map();
    const dup = [];
    const saved = Array.isArray(store.fingerprints) ? store.fingerprints : [];
    store.elements.forEach((el, i) => {
      if (!el) return;
      let fp = saved[i];
      if (!fp) {
        try { fp = fingerprint(el); } catch { return; }
      }
      if (map.has(fp)) { dup.push(fp); return; }
      map.set(fp, i + 1);
    });
    for (const fp of dup) map.delete(fp);
    return map;
  }

  /* ---------- mode:'elements'：基于既有映射增量刷新 ---------- */

  if (mode === 'elements') {
    const store = win.__titanium;
    if (!store || !Array.isArray(store.elements)) return { ok: false, reason: 'stale' };
    if (opts.session && store.session !== opts.session) return { ok: false, reason: 'stale' };

    // 本次刷新之前模型已看过的最大 ref：超过它的都是「上次动作后新出现」
    const seenMax = typeof store.seenMax === 'number' ? store.seenMax : store.elements.length;

    // 扫描当前 DOM：既有元素保号（数组下标即 ref-1），新元素续编
    const known = new Set(store.elements);
    if (!Array.isArray(store.fingerprints)) store.fingerprints = [];
    let overflow = false;
    for (const c of dedupeCandidates(collectCandidates(doc.body))) {
      if (known.has(c.el)) continue;
      if (store.elements.length >= MAX_ELEMENTS) { overflow = true; break; }
      store.elements.push(c.el);
      // 指纹与元素同步入店：将来重建时靠它把编号还给同一个元素
      store.fingerprints[store.elements.length - 1] = fingerprint(c.el);
      known.add(c.el);
    }

    // 产出仍然存活的元素（脱离文档或已无盒子的跳过，但保留槽位保证 ref 稳定）
    const elements = [];
    let newCount = 0;
    store.elements.forEach((el, i) => {
      if (!el || !el.isConnected || !visibleStyle(el)) return;
      const info = elementInfo(el, i + 1);
      if (info.bbox.w === 0 && info.bbox.h === 0) return;
      if (i + 1 > seenMax) { info.isNew = true; newCount++; }
      elements.push(info);
    });
    store.seenMax = store.elements.length; // 本次已交付给模型，下次不再算新

    return {
      ok: true, elements, viewport: viewportInfo(), session: store.session,
      stats: { totalElements: elements.length, elementsTruncated: overflow, newElements: newCount },
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
  const candidates = []; // { el, role }，遍历结束后统一去重与编号
  let tableCount = 0;
  let iframeCount = 0;

  // —— 主遍历 ——
  // textOn：进入 nav/header/footer 或表格内部后置 false（文本不采，元素/骨架继续）；
  // depth：骨架层级，进入 landmark 时 +1（封顶 4 级）；
  // parentCursor / ariaHidden：沿树下传，供元素通道判定使用。
  function visit(node, textOn, depth, parentCursor, ariaHidden) {
    if (node.nodeType === 3) {
      if (textOn) pushText(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (tag === 'IFRAME') { iframeCount++; return; } // 跨文档内容读不到，仅计数告知模型
    if (SKIP_TAGS[tag]) return;
    const style = visibleStyle(node);
    if (!style) return;
    const ariaOff = ariaHidden || node.getAttribute('aria-hidden') === 'true';

    // 元素通道
    if (!ariaOff) {
      const hit = interactiveRole(node, style, parentCursor);
      if (hit) candidates.push({ el: node, role: hit.role, weak: hit.weak });
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
      // 序号与 extract_table 的 table_index 对齐（同样的遍历顺序与隐藏剪枝规则）
      tableCount++;
      const rows = node.querySelectorAll('tr').length;
      const cols = node.querySelector('tr') ? node.querySelector('tr').children.length : 0;
      pushOutline({ kind: 'block', tag: 'table', name: '', depth, meta: `#${tableCount} · ${rows}行×${cols}列` });
      if (textOn) pushText('\n\n' + tableToMarkdown(node) + '\n\n');
      // 表格文字已随 Markdown 带出，下钻只为收集表内交互元素
      for (const child of node.childNodes) visit(child, false, depth, style.cursor, ariaOff);
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (textOn && isBlock) pushText('\n');
    if (textOn && tag === 'LI') pushText('- ');
    for (const child of node.childNodes) visit(child, textOn, depth, style.cursor, ariaOff);
    if (textOn && isBlock) pushText('\n');
  }

  visit(doc.body, true, 0, '', false);

  // 空白压缩 + 截断（与原 extractor 一致）
  let text = textOut
    .join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const textTruncated = text.length > MAX_TEXT;
  if (textTruncated) text = text.slice(0, MAX_TEXT) + '……（内容过长已截断）';

  // —— 元素去重与 ref 分配 ——
  const kept = dedupeCandidates(candidates);
  const totalInteractive = kept.length;
  const capped = kept.slice(0, MAX_ELEMENTS);

  const prevStore = win.__titanium;
  const canInherit = Boolean(opts.inheritRefs) && prevStore && Array.isArray(prevStore.elements);
  const liveRefs = []; // 稀疏数组，下标 +1 = ref
  const elements = [];

  if (canInherit) {
    // SPA 重渲染后的全量重建：指纹相同的元素继承旧 ref，模型手里的编号继续有效
    const fpMap = buildFingerprintMap(prevStore);
    const used = new Set();
    const fresh = [];
    for (const c of capped) {
      const oldRef = fpMap.get(fingerprint(c.el));
      if (oldRef && !used.has(oldRef)) {
        used.add(oldRef);
        liveRefs[oldRef - 1] = c.el;
      } else {
        fresh.push(c);
      }
    }
    let next = prevStore.elements.length; // 未继承者从旧映射长度之后续编，绝不与旧 ref 撞号
    for (const c of fresh) {
      liveRefs[next] = c.el;
      next++;
    }
    liveRefs.forEach((el, i) => {
      const info = elementInfo(el, i + 1);
      if (i >= prevStore.elements.length) info.isNew = true;
      elements.push(info);
    });
  } else {
    capped.forEach((c) => {
      liveRefs.push(c.el);
      elements.push(elementInfo(c.el, liveRefs.length));
    });
  }

  // 重建 ref 映射（session 换新，旧 session 的 ref 全部作废）。
  // 指纹在此刻算好并随店保存——元素一旦被 SPA 换掉就再也算不出正确的祖先链。
  const fingerprints = [];
  liveRefs.forEach((el, i) => { fingerprints[i] = fingerprint(el); });
  const session = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  win.__titanium = { session, elements: liveRefs, fingerprints, seenMax: liveRefs.length };

  const title = (doc.title || '').trim();
  const url = doc.location ? doc.location.href : '';
  if (!text && !elements.length) return { ok: false, reason: 'empty', title, url };
  return {
    ok: true, title, url, text, outline, elements,
    viewport: viewportInfo(), session,
    stats: {
      totalElements: totalInteractive,
      textTruncated,
      elementsTruncated: totalInteractive > capped.length,
      tables: tableCount,
      iframes: iframeCount,
    },
  };
}
