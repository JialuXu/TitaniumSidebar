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
//   fingerprints,     // 与 elements 同下标的指纹，建店时算好——重建时靠它把编号还给同一个元素
//   misses,           // 与 elements 同下标：该空槽连续多少次全量重建无人认领（空槽回收的依据）
//   seenMax,          // 已序列化给模型看过的最大 ref，超过它的元素标记为「新出现」
// }

/**
 * 页面快照。三种模式：
 *   mode:'full'     —— 首条消息/「重新读取」：完整遍历，产出文本、结构骨架、元素列表，
 *                      并重建 window.__titanium 的 ref 映射（session 换新）。
 *                      传 inheritRefs 时尝试让新映射继承旧 ref（见下）。
 *   mode:'elements' —— 工具调用（元素列表/截图标注前）：基于既有 ref 映射增量刷新——
 *                      老元素保号、失效元素跳过、新元素续编 ref；session 缺失或不符一律返回 stale
 *                      （session 是 ref 的有效期凭证，必传）。
 *   mode:'text'     —— 按字符位置读取正文（read_page_text）或全文搜索（find_in_page）：
 *                      走与 full 完全相同的遍历与空白压缩，在 ref 分配之前返回，
 *                      因此**零副作用**（不碰 window.__titanium、不需要 session），
 *                      而且位置与 <页面内容> 里那份文本严丝合缝——这正是复用同一段
 *                      文本通道而不是另写一个序列化函数的原因：续读要求逐字符对齐。
 *
 * 字符位置（offset）的口径：压缩后、截断前的「规范正文」下标。模型看到的前 12000 字
 * 就是它的前缀，因此骨架里的 @位置、搜索命中的 @位置、读取的 offset 三者同一坐标系。
 *
 * @param {{ mode?: 'full'|'elements'|'text', session?: string, inheritRefs?: boolean,
 *           maxTextLen?: number, maxScan?: number, maxElements?: number,
 *           offset?: number, length?: number, query?: string, maxResults?: number,
 *           i18n?: { textTruncated, checked, tableMeta } }} [options] 经 executeScript args 传入
 *   maxTextLen 是发给模型的截断长度，maxScan 是采集上限（不传则沿用 maxTextLen*2，
 *   让 `maxTextLen:1` 那条「只要元素映射」的重建路径继续省下文本通道的开销）。
 *   i18n 由外壳按当前语言传入（本函数注入页面执行，不能 import core/i18n.js）
 */
export function snapshotPage(options) {
  const opts = options || {};
  const mode = opts.mode || 'full';
  const MAX_TEXT = opts.maxTextLen || 12000;
  // 文本采集上限。默认留一倍富余给空白压缩；要拿到「完整正文」的调用方显式传 maxScan。
  const MAX_SCAN = opts.maxScan || MAX_TEXT * 2;
  // 元素编号上限是防失控的宽松保险丝，不是 token 预算——token 由序列化端的
  // 字符预算与同构折叠约束。收得太紧会让增量刷新编不进新元素（动作后新出现的
  // 按钮拿不到 ref），且必须配合把 elementsTruncated 显式告知模型。
  const MAX_ELEMENTS = opts.maxElements || 1500;
  // ref 映射表（含空槽）的长度上限。空槽是「ref 永不左移」的代价，但这份代价必须有界：
  // 表长过了 MAX_ELEMENTS 之后，新元素改吃回收来的死槽（见 full + inheritRefs 分支），
  // 回收也不够才继续往表尾续编，到 MAX_REFS 硬顶为止（编不进的如实计入 elementsTruncated）。
  const MAX_REFS = MAX_ELEMENTS * 2;
  // 连续这么多次全量重建都没有元素认领的空槽，判定为「死透」，编号可以回收。
  // 宽限期 + 回收槽一律标 isNew，为的是模型不至于拿记忆里的旧编号打在新元素上。
  const DEAD_GRACE = 3;
  // 文案由外壳按当前语言传入（本函数要整体序列化注入页面，不能 import core/i18n.js）；
  // 缺省值保证脱离外壳直接调用时仍可用。
  const S = Object.assign({
    textTruncated: '……（内容过长已截断）',
    checked: '已选中',
    tableMeta: '#{index} · {rows}行×{cols}列',
  }, opts.i18n || {});

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return { ok: false, reason: 'no-window' };

  /* ---------- 公共辅助（两种模式共用，必须定义在模式分支之前） ---------- */

  // 遍历黑名单：无文字价值。内嵌框架不在此列，由 frameRoot 决定读不读得到
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1 };

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

  // 元素所在文档的视图。同源框架里的元素要用框架自己的 window 算样式；
  // 框架被移除或跳走之后旧文档的 defaultView 为 null，据此判定元素已失效。
  function viewOf(el) {
    const d = el.ownerDocument;
    return (d && d.defaultView) || (d === doc ? win : null);
  }

  // 内嵌框架的可读正文根，读不到返回 null。
  // 同源框架（含 srcdoc、about:blank）直接取活文档，文字、骨架、元素三通道照常下钻；
  // 跨域框架的 contentDocument 为 null（个别实现抛异常）。沙箱隔离的 srcdoc 框架
  // （论坛帖子、邮件正文的常见嵌法）活文档同样够不着，但正文就写在 srcdoc 属性里：
  // 用 DOMParser 解析出一份离线文档（不执行脚本、不加载资源），只供文本与骨架通道——
  // 里面的节点不是页面上的真实元素，不能编号（live:false）。
  function frameRoot(frame, liveOnly) {
    let inner = null;
    try { inner = frame.contentDocument; } catch { inner = null; }
    if (inner && inner.body) return { body: inner.body, live: true };
    const src = liveOnly ? null : frame.getAttribute('srcdoc');
    if (src && win.DOMParser) {
      try {
        const parsed = new win.DOMParser().parseFromString(src, 'text/html');
        if (parsed && parsed.body) return { body: parsed.body, live: false };
      } catch { /* 解析失败按读不到处理 */ }
    }
    return null;
  }

  // 可见性判定：可见则返回 computed style（供 cursor 等后续判定复用），隐藏返回 null（子树整体剪枝）
  function visibleStyle(el) {
    const view = viewOf(el);
    if (!view) {
      // 离线解析件没有视图、算不出样式：只按 hidden 属性与行内样式粗判
      const inline = el.style || {};
      if (el.hasAttribute('hidden') || inline.display === 'none' || inline.visibility === 'hidden') return null;
      return inline;
    }
    const style = view.getComputedStyle(el);
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
      return el.checked ? S.checked : null;
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
    const view = viewOf(el) || win;
    const style = view.getComputedStyle(el);
    const parentCursor = el.parentElement ? (view.getComputedStyle(el.parentElement) || {}).cursor : '';
    const hit = interactiveRole(el, style, parentCursor);
    return (hit && hit.role) || 'clickable';
  }

  // 框架内元素的 getBoundingClientRect 以所在框架的视口为原点，而 bbox 要的是顶层视口坐标
  // （截图标注、视口过滤都按顶层算）：逐层累加框架内容区的偏移，并把各层框架的可见范围
  // 求交作为裁剪框——在框架里滚出去的元素，坐标仍可能落在顶层视口内，但用户看不见。
  // 框架的 padding 极少见，不计。一次快照内框架不会移动，按文档缓存。
  const frameBoxes = new Map();
  function frameBox(d) {
    if (d === doc) return { x: 0, y: 0, l: 0, t: 0, r: win.innerWidth, b: win.innerHeight };
    let box = frameBoxes.get(d);
    if (box) return box;
    const fe = d.defaultView ? d.defaultView.frameElement : null;
    if (!fe) {
      box = { x: 0, y: 0, l: 0, t: 0, r: 0, b: 0 }; // 框架已被移除：没有可见范围
    } else {
      const outer = frameBox(fe.ownerDocument);
      const r = fe.getBoundingClientRect();
      const x = outer.x + r.left + fe.clientLeft;
      const y = outer.y + r.top + fe.clientTop;
      box = {
        x, y,
        l: Math.max(outer.l, x), t: Math.max(outer.t, y),
        r: Math.min(outer.r, x + fe.clientWidth), b: Math.min(outer.b, y + fe.clientHeight),
      };
    }
    frameBoxes.set(d, box);
    return box;
  }

  // 生成单个元素的 ElementInfo（bbox 为相对顶层视口的 CSS 像素）
  function elementInfo(el, ref) {
    const role = roleOf(el);
    const rect = el.getBoundingClientRect();
    const box = frameBox(el.ownerDocument);
    const bbox = {
      x: Math.round(rect.x + box.x), y: Math.round(rect.y + box.y),
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
        bbox.x < box.r && bbox.y < box.b &&
        bbox.x + bbox.w > box.l && bbox.y + bbox.h > box.t,
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
      if (tag === 'IFRAME' || tag === 'FRAME') {
        // 只下钻活文档（与 full 模式同一口径：离线解析件不编号）
        const root = frameRoot(node, true);
        if (root) walk(root.body, '', ah);
        return;
      }
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
    // session 必填：空 session 曾被当成「不校验」放行，于是恢复历史会话这类不重读页面的
    // 路径上，旧编号会直接落在当前页面某个毫不相干的元素上。没有凭证就是没有有效映射。
    if (!opts.session || store.session !== opts.session) return { ok: false, reason: 'stale' };

    // 本次刷新之前模型已看过的最大 ref：超过它的都是「上次动作后新出现」
    const seenMax = typeof store.seenMax === 'number' ? store.seenMax : store.elements.length;

    // 扫描当前 DOM：既有元素保号（数组下标即 ref-1），新元素续编
    const known = new Set(store.elements);
    if (!Array.isArray(store.fingerprints)) store.fingerprints = [];
    // 名额算的是「当前存活的元素数」，不是映射表长度：表里的空槽是 ref 稳定的代价，
    // 不该占用新元素的名额——按表长判定的话，同一页面反复重建把表撑过上限后这里恒真，
    // 该标签页的增量刷新从此一个新元素都编不进（动作后新出现的按钮永远拿不到 ref）。
    let budget = MAX_ELEMENTS;
    store.elements.forEach((el) => { if (el && el.isConnected && viewOf(el)) budget--; });
    let overflow = false;
    for (const c of dedupeCandidates(collectCandidates(doc.body))) {
      if (known.has(c.el)) continue;
      if (budget <= 0 || store.elements.length >= MAX_REFS) { overflow = true; break; }
      budget--;
      store.elements.push(c.el);
      // 指纹与元素同步入店：将来重建时靠它把编号还给同一个元素
      store.fingerprints[store.elements.length - 1] = fingerprint(c.el);
      known.add(c.el);
    }

    // 产出仍然存活的元素（脱离文档或已无盒子的跳过，但保留槽位保证 ref 稳定）
    const elements = [];
    let newCount = 0;
    store.elements.forEach((el, i) => {
      if (!el || !el.isConnected || !viewOf(el) || !visibleStyle(el)) return;
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

  const textMode = mode === 'text';
  const collectChrome = textMode && opts.query != null; // 搜索才需要旁路缓冲，读取不需要

  const textOut = [];
  let textLenApprox = 0;
  let textDone = false; // 攒够（留出压缩富余）后关闭文本通道，元素/骨架继续采

  // 标题位置用哨兵字符测量：在标题的首个非空白字符之前插一个 U+FFFF，压缩之后
  // 第 k 个哨兵的下标减去 k 就是该标题在规范正文里的位置，随后把哨兵整体剔除。
  // 哨兵永远紧贴着一个非空白字符，因此切不断任何会被下面三条压缩正则当作一体的
  // 空白串——「带哨兵压缩再剔除」与「不带哨兵压缩」逐字节相同（已随机验证）。
  // 这样测位置的好处是不必重写空白压缩：改那三条正则的风险远大于本功能本身。
  const MARK = '￿';
  const marked = [];        // 按插入顺序记下每个哨兵对应的标题节点
  const headings = [];      // 全部带位置的标题（不受骨架 150 节点上限约束，小节标签要用全量）
  let pendingHeading = null; // 已进入标题元素、但还没遇到第一个非空白字符

  function pushText(s, heading) {
    if (textDone || !s) return;
    // 正文自带的 U+FFFF 会被当成哨兵而让其后所有位置整体偏移，入口一律剔除
    let str = s.indexOf(MARK) === -1 ? s : s.split(MARK).join('');
    if (heading) {
      const at = str.search(/\S/);
      if (at !== -1) {
        str = str.slice(0, at) + MARK + str.slice(at);
        marked.push(heading);
        pendingHeading = null; // 本标题已标记，后续文本节点不再重复插
      }
    }
    if (!str) return;
    textOut.push(str);
    textLenApprox += str.length;
    if (textLenApprox > MAX_SCAN) textDone = true;
  }

  // 页眉/导航/页脚的文字不进正文（现有行为），但搜索要够得着——文章署名、日期常在
  // <header> 里。单独收进旁路缓冲，命中时如实告知模型「不在正文内、没有位置」。
  const chromeOut = [];
  let chromeLen = 0;
  function pushChrome(s) {
    if (!s || chromeLen > MAX_SCAN) return;
    chromeOut.push(s);
    chromeLen += s.length;
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
  let iframeCount = 0; // 读不到的内嵌框架数（读得到的已并入正文，不计）

  // —— 主遍历 ——
  // textOn：进入 nav/header/footer 或表格内部后置 false（文本不采，元素/骨架继续）；
  // depth：骨架层级，进入 landmark 时 +1（封顶 4 级）；
  // parentCursor / ariaHidden：沿树下传，供元素通道判定使用；
  // inChrome：位于 nav/header/footer 子树内（文本不进正文，搜索模式下进旁路缓冲）。
  function visit(node, textOn, depth, parentCursor, ariaHidden, inChrome) {
    // 纯读取模式采够即收工：没有元素/骨架通道要喂，再走下去只是白算 getComputedStyle。
    // 搜索模式不能提前退——页脚在文档最后，旁路缓冲还等着它。
    if (textDone && textMode && !collectChrome) return;
    if (node.nodeType === 3) {
      if (textOn) pushText(node.nodeValue, pendingHeading);
      else if (collectChrome && inChrome) pushChrome(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (tag === 'IFRAME' || tag === 'FRAME') {
      if (!visibleStyle(node)) return;
      const root = frameRoot(node, false);
      if (!root) { iframeCount++; return; } // 跨域读不到，仅计数告知模型
      // 框架当块级处理，内容接在所在位置，与周围正文同一坐标系。
      // 离线解析件里没有真实元素：借 ariaHidden 关掉这棵子树的元素通道。
      const off = ariaHidden || node.getAttribute('aria-hidden') === 'true' || !root.live;
      if (textOn) pushText('\n');
      else if (collectChrome && inChrome) pushChrome(' ');
      visit(root.body, textOn, depth, '', off, inChrome);
      if (textOn) pushText('\n');
      else if (collectChrome && inChrome) pushChrome(' ');
      return;
    }
    if (SKIP_TAGS[tag]) return;
    const style = visibleStyle(node);
    if (!style) return;
    const ariaOff = ariaHidden || node.getAttribute('aria-hidden') === 'true';

    // 元素通道（text 模式不要：interactiveRole 会逐元素触发 getBoundingClientRect 强制排版，
    // 而这一趟只取文本，元素列表由 mode:'elements' 负责）
    if (!textMode && !ariaOff) {
      const hit = interactiveRole(node, style, parentCursor);
      if (hit) candidates.push({ el: node, role: hit.role, weak: hit.weak });
    }

    // 骨架通道
    const role = (node.getAttribute('role') || '').toLowerCase();
    const landmark = LANDMARK_TAGS[tag] ||
      LANDMARK_ROLES[role] ||
      (tag === 'SECTION' && node.getAttribute('aria-label') ? 'section' : '');
    let myHeading = null;
    if (landmark) {
      pushOutline({ kind: 'landmark', tag: landmark, name: textMode ? '' : landmarkName(node), depth });
      depth = Math.min(depth + 1, 4);
    } else if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const hNode = { kind: 'heading', tag: tag.toLowerCase(), level: Number(tag[1]), name: clamp(node.textContent, 40), depth };
      pushOutline(hNode);
      if (textOn) {
        // 骨架有 150 节点上限，小节标签却要用全量：两份分开登记，节点对象共用同一个
        headings.push(hNode);
        myHeading = hNode;
        pendingHeading = hNode;
      }
    }

    // 文本通道
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') { textOn = false; inChrome = true; }
    if (tag === 'BR') {
      if (textOn) pushText('\n');
      else if (collectChrome && inChrome) pushChrome(' ');
      return;
    }
    if (tag === 'TABLE') {
      // 序号与 extract_table 的 table_index 对齐（同样的遍历顺序与隐藏剪枝规则）
      tableCount++;
      if (!textMode) {
        const rows = node.querySelectorAll('tr').length;
        const cols = node.querySelector('tr') ? node.querySelector('tr').children.length : 0;
        const meta = S.tableMeta
          .replace('{index}', String(tableCount))
          .replace('{rows}', String(rows))
          .replace('{cols}', String(cols));
        pushOutline({ kind: 'block', tag: 'table', name: '', depth, meta });
      }
      // textDone 之后转出来的 Markdown 会被 pushText 直接丢掉，别白转一整张表
      if (textOn && !textDone) pushText('\n\n' + tableToMarkdown(node) + '\n\n');
      // 表格文字已随 Markdown 带出，下钻只为收集表内交互元素；
      // 页眉/导航/页脚里的表没有 Markdown 那一份，靠下面的旁路缓冲收文字
      if (!textMode || (collectChrome && inChrome)) {
        for (const child of node.childNodes) visit(child, false, depth, style.cursor, ariaOff, inChrome);
      }
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (textOn && isBlock) pushText('\n');
    else if (collectChrome && inChrome && isBlock) pushChrome(' ');
    if (textOn && tag === 'LI') pushText('- ');
    for (const child of node.childNodes) visit(child, textOn, depth, style.cursor, ariaOff, inChrome);
    if (textOn && isBlock) pushText('\n');
    else if (collectChrome && inChrome && isBlock) pushChrome(' ');
    // 空标题 / 只有空白的标题：没有可标记的字符，别把哨兵留给后面的文本节点
    if (myHeading && pendingHeading === myHeading) pendingHeading = null;
  }

  visit(doc.body, true, 0, '', false, false);

  // 空白压缩（与原 extractor 一致）。这三条正则是全文坐标系的地基，不要改动：
  // 哨兵测位置、read_page_text 的 offset、find_in_page 的命中下标都以它的产物为准。
  let text = textOut
    .join('')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 哨兵定位：第 k 个哨兵的下标减 k 即该标题的位置，随后整体剔除
  if (marked.length) {
    let at = text.indexOf(MARK);
    let k = 0;
    while (at !== -1) {
      if (marked[k]) marked[k].pos = at - k;
      k++;
      at = text.indexOf(MARK, at + 1);
    }
    text = text.split(MARK).join('');
  }
  const textTotal = text.length;
  const textCapped = textDone; // 采集在 MAX_SCAN 处停过，后面还有多少无从得知

  // 任何切点都不许落在数字串中间。脱敏规则靠「前后无数字」锚定（core/masker.js），
  // 一串卡号被切成两半，两半各自都不再命中任何规则，拼起来就是明文——
  // 页面块的截断点、读取片段的首尾、搜索片段的首尾，全走这一条。
  // 超过 40 位的数字串本就超出所有脱敏规则的长度上限，不必也不该为它把切点推得更远。
  const DIGIT_RUN = /[0-9Xx]/;
  function clampEdge(p) {
    if (p <= 0 || p >= text.length) return p;
    let q = p;
    while (q > 0 && p - q < 40 && DIGIT_RUN.test(text[q - 1]) && DIGIT_RUN.test(text[q])) q--;
    return q > 0 && DIGIT_RUN.test(text[q - 1]) && DIGIT_RUN.test(text[q]) ? p : q;
  }

  // 位置 → 所在小节：最后一个位置不晚于它的标题
  function sectionAt(pos) {
    let name = '';
    for (const h of headings) {
      if (typeof h.pos !== 'number' || h.pos > pos) continue;
      if (h.name) name = h.name;
    }
    return name;
  }

  /* ---------- mode:'text'：按位置读取 / 全文搜索（到此为止零副作用） ---------- */

  if (textMode) {
    const url = doc.location ? doc.location.href : '';

    if (opts.query != null) {
      const raw = String(opts.query);
      if (!raw.trim()) return { ok: false, reason: 'empty-query' };
      // 忽略空白、大小写不敏感的字面匹配：按空白切词，逐码位转义正则语法字符。
      // 词内相邻两个 ASCII 字母数字之间不许插空白，否则 "therapist" 会命中 "the rapist"；
      // 其余位置允许 [\s|]*，好让查询词跨换行、跨表格单元格（「营业收入 1,234」）。
      let re;
      try {
        const words = raw.trim().slice(0, 200).split(/\s+/).filter(Boolean);
        const isWord = (ch) => /[A-Za-z0-9]/.test(ch);
        let src = '';
        words.forEach((word, wi) => {
          const chars = Array.from(word);
          if (wi > 0) {
            const prev = Array.from(words[wi - 1]).pop();
            src += isWord(prev) && isWord(chars[0]) ? '[\\s|]+' : '[\\s|]*';
          }
          chars.forEach((ch, i) => {
            if (i > 0 && !(isWord(chars[i - 1]) && isWord(ch))) src += '[\\s|]*';
            src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          });
        });
        re = new RegExp(src, 'giu');
      } catch (err) {
        return { ok: false, reason: 'bad-query' };
      }

      const maxResults = Math.min(Math.max(opts.maxResults || 5, 1), 10);
      const CTX = 120;
      const results = [];
      let total = 0;
      let m = re.exec(text);
      while (m) {
        total++;
        if (results.length < maxResults) {
          const s = clampEdge(Math.max(0, m.index - CTX));
          const e = clampEdge(Math.min(text.length, m.index + m[0].length + CTX));
          results.push({
            index: m.index,
            section: sectionAt(m.index),
            snippet: text.slice(s, m.index) + '【' + m[0] + '】' + text.slice(m.index + m[0].length, e),
          });
        }
        if (m.index + m[0].length === re.lastIndex) re.lastIndex++; // 空匹配防死循环
        m = re.exec(text);
      }

      // 页眉/导航/页脚：命中也报，但没有正文位置
      const outside = [];
      let outsideTotal = 0;
      if (chromeOut.length) {
        const chromeText = chromeOut.join('').replace(/\s+/g, ' ').trim();
        re.lastIndex = 0;
        let c = re.exec(chromeText);
        while (c) {
          outsideTotal++;
          if (outside.length < 3) {
            const cs = Math.max(0, c.index - 60);
            const ce = Math.min(chromeText.length, c.index + c[0].length + 60);
            outside.push({
              snippet: chromeText.slice(cs, c.index) + '【' + c[0] + '】' + chromeText.slice(c.index + c[0].length, ce),
            });
          }
          if (c.index + c[0].length === re.lastIndex) re.lastIndex++;
          c = re.exec(chromeText);
        }
      }
      return {
        ok: true, url, total, results,
        outside: { total: outsideTotal, results: outside },
        bodyTotal: textTotal, capped: textCapped,
      };
    }

    // 读取：起点与终点各过一次 clampEdge。终点按「请求的 offset + length」算而不是
    // 按夹过的 start 算——相邻两段在同一个点上得到同一个结果，顺序续读与并行分段
    // 才都严丝合缝（既不留缝也不重叠）。
    const want = Math.min(Math.max(1, Math.floor(opts.length) || 6000), 200000);
    const o = Math.min(Math.max(0, Math.floor(opts.offset) || 0), textTotal);
    const start = clampEdge(o);
    let end = clampEdge(Math.min(textTotal, o + want));
    if (end <= start) end = Math.min(textTotal, o + want); // 整段都陷在一个数字串里：保证前进
    return {
      ok: true, url, text: text.slice(start, end),
      start, end, total: textTotal, capped: textCapped, section: sectionAt(start),
    };
  }

  const textTruncated = textTotal > MAX_TEXT;
  let textShown = textTotal;
  if (textTruncated) {
    textShown = clampEdge(MAX_TEXT);
    text = text.slice(0, textShown) + S.textTruncated;
  }
  // 骨架里只保留截断之外的标题位置：模型已经读到的部分不需要坐标，标了反而是噪声
  for (const h of headings) {
    if (!textTruncated || h.pos < textShown) delete h.pos;
  }

  // —— 元素去重与 ref 分配 ——
  const kept = dedupeCandidates(candidates);
  const totalInteractive = kept.length;
  const capped = kept.slice(0, MAX_ELEMENTS);

  const prevStore = win.__titanium;
  const canInherit = Boolean(opts.inheritRefs) && prevStore && Array.isArray(prevStore.elements);
  const liveRefs = []; // 稀疏数组，下标 +1 = ref
  const elements = [];
  const misses = [];   // 与 liveRefs 同下标的空槽未命中计数，随店保存（仅继承分支维护）
  let refOverflow = 0; // 映射表满、没能拿到编号的元素数（如实计入 elementsTruncated）

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
    // 空槽的未命中计数：本次无人认领的老 ref 记一次，连续超过 DEAD_GRACE 次判定为死透。
    // 同一网址上每条消息发送前都走这条继承路径，指纹对不上的元素（SPA 重渲染、虚拟列表、
    // 带时间戳的 aria-label）每轮都算新增；只往表尾续编的话映射表单调增长，
    // 越过上限后该标签页的增量刷新永久失效。回收死槽是让「ref 永不左移」的代价有界的办法。
    const prevMisses = Array.isArray(prevStore.misses) ? prevStore.misses : [];
    const recyclable = [];
    for (let i = 0; i < prevStore.elements.length; i++) {
      if (liveRefs[i]) continue; // 有元素认领：计数清零（不写即为 0）
      const n = (prevMisses[i] || 0) + 1;
      misses[i] = n;
      if (n > DEAD_GRACE) recyclable.push(i);
    }

    // 新元素的编号来源，按序：表尾续编（表长在保险丝以内时与以往完全一致，
    // 死掉的 ref 仍报 gone，最安全）→ 回收死透的空槽 → 续编到 MAX_REFS 硬顶为止。
    const freshRefs = new Set();
    let next = prevStore.elements.length; // 续编从旧映射长度之后开始，绝不与旧 ref 撞号
    for (const c of fresh) {
      let slot = -1;
      if (next < MAX_ELEMENTS) slot = next++;
      else if (recyclable.length) slot = recyclable.shift();
      else if (next < MAX_REFS) slot = next++;
      if (slot < 0) { refOverflow++; continue; }
      liveRefs[slot] = c.el;
      misses[slot] = 0;
      freshRefs.add(slot + 1);
    }
    // 表长只增不减：槽位身份必须跨重建稳定，否则表尾一旦缩回去，
    // 还没熬过宽限期的死 ref 会被当作从未用过的新号直接发出去。
    if (liveRefs.length < prevStore.elements.length) liveRefs.length = prevStore.elements.length;

    liveRefs.forEach((el, i) => {
      const info = elementInfo(el, i + 1);
      // 续编与回收来的编号都算「新出现」；回收槽尤其要标，模型才不会拿它当记忆里的旧目标
      if (freshRefs.has(i + 1)) info.isNew = true;
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
  win.__titanium = { session, elements: liveRefs, fingerprints, misses, seenMax: liveRefs.length };

  const title = (doc.title || '').trim();
  const url = doc.location ? doc.location.href : '';
  if (!text && !elements.length) return { ok: false, reason: 'empty', title, url };
  return {
    ok: true, title, url, text, outline, elements,
    viewport: viewportInfo(), session,
    stats: {
      totalElements: totalInteractive,
      textTruncated,
      elementsTruncated: totalInteractive > capped.length || refOverflow > 0,
      tables: tableCount,
      iframes: iframeCount,
      // 只有显式传了 maxScan 的调用方才采到了完整正文，也只有它能如实报总字数。
      // `maxTextLen:1` 那条「只要元素映射」的重建路径采了两个字，报出来就是假数据。
      ...(opts.maxScan ? { textTotal, textShown, textCapped } : {}),
    },
  };
}
