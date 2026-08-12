// core/extractor.js —— 页面内容提取（平台无关层）
//
// 重要约束：extractPage 必须保持“完全自包含”——函数体内不引用任何模块级变量
// 或外部辅助函数。扩展外壳会把整个函数对象交给 chrome.scripting.executeScript
// 序列化后注入目标页面执行（此时函数已脱离本模块作用域）；SDK 外壳则直接传入
// 宿主页面的 document 调用。两种场景共用这一份实现。

/**
 * 提取页面正文文字（表格转 Markdown），返回 { ok, title, url, text }。
 * @param {Document} [rootDocument] 注入场景不传参（回落到页面全局 document），
 *                                  SDK/测试场景显式传入宿主 document。
 */
export function extractPage(rootDocument) {
  const doc = rootDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) {
    return { ok: false, title: '', url: '', text: '' };
  }

  const MAX_LEN = 12000; // 提取文本上限（字符）
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);

  // 单元格文本：压缩空白、单元格内换行替换为空格、竖线转义
  function cellText(cell) {
    return (cell.textContent || '')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  // <table> 转 Markdown：表头取首个含 th 的行（没有则取首行），列数以表头为准
  function tableToMarkdown(table) {
    // 只取直属本表的行；嵌套表格不展开（近似处理，其内容随单元格文本带出）
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

  // 块级文本序列化，代替 innerText——克隆体脱离文档没有布局，innerText 会退化为
  // textContent 并丢失全部段落换行，因此按标签语义手动补换行：
  // 块级标签前后补 \n、<br> 输出 \n、<li> 加“- ”前缀、表格整体转 Markdown 插入。
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'UL', 'OL', 'LI',
    'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'PRE', 'FORM', 'FIELDSET', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'TR',
    'HR', 'DETAILS', 'SUMMARY',
  ]);

  function serialize(node, out) {
    if (node.nodeType === 3) { // 文本节点
      out.push(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== 1) return; // 只处理元素节点
    const tag = node.tagName;
    if (tag === 'BR') {
      out.push('\n');
      return;
    }
    if (tag === 'TABLE') {
      out.push('\n\n' + tableToMarkdown(node) + '\n\n');
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push('\n');
    if (tag === 'LI') out.push('- ');
    for (const child of node.childNodes) serialize(child, out);
    if (isBlock) out.push('\n');
  }

  // 克隆 body，并基于 live 树的计算样式剔除隐藏元素。
  // getComputedStyle 对脱离文档的克隆节点拿不到样式，因此隐藏判定必须在原树上做；
  // cloneNode(true) 保证两棵树 querySelectorAll('*') 顺序一致，可按下标一一对应。
  const clone = doc.body.cloneNode(true);
  if (win && typeof win.getComputedStyle === 'function') {
    const liveEls = doc.body.querySelectorAll('*');
    const cloneEls = clone.querySelectorAll('*');
    const count = Math.min(liveEls.length, cloneEls.length);
    for (let i = 0; i < count; i++) {
      const style = win.getComputedStyle(liveEls[i]);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) {
        cloneEls[i].remove(); // 祖先已被移除时再次 remove 无害
      }
    }
  }
  // 黑名单标签整体剔除（必须在隐藏判定之后做，否则两棵树的下标会错位）
  clone
    .querySelectorAll('script,style,noscript,svg,iframe,nav,header,footer')
    .forEach((el) => el.remove());

  // 序列化 + 压缩连续空白与空行
  const out = [];
  serialize(clone, out);
  let text = out
    .join('')
    .replace(/[ \t\u00a0]+/g, ' ') // 连续空格/制表/不换行空格压为一个空格
    .replace(/ ?\n ?/g, '\n')      // 去除换行两侧残留空格
    .replace(/\n{3,}/g, '\n\n')    // 连续空行压为一个
    .trim();

  if (text.length > MAX_LEN) {
    text = text.slice(0, MAX_LEN) + '……（内容过长已截断）';
  }

  const title = (doc.title || '').trim();
  const url = doc.location ? doc.location.href : '';
  if (!text) {
    return { ok: false, title, url, text: '' };
  }
  return { ok: true, title, url, text };
}
