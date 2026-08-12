// core/search.js —— 页面全文搜索（平台无关层）
//
// 重要约束：searchPage 必须保持“完全自包含”（同 snapshot.js，经 executeScript 序列化注入）。
//
// 与快照的关系：<页面内容> 受 12000 字截断，搜索则在活页面上重新序列化“完整”文本
// （上限 maxScan 防极端页面），因此能命中截断之外的内容——这是本工具存在的意义。
// 不用 window.find()：它会改变页面 selection，破坏「只读」边界。

/**
 * 在当前页面全文中做字面搜索（大小写不敏感，空白差异不敏感）。
 * @param {{ query: string, maxResults?: number, contextChars?: number, maxScan?: number }} payload
 * @returns {{ ok: true, total: number, results: Array<{ index: number, snippet: string }> }
 *          | { ok: false, reason: 'empty-query'|'no-body' }}
 */
export function searchPage(payload) {
  const opts = payload || {};
  const query = (opts.query || '').replace(/\s+/g, ' ').trim();
  const maxResults = Math.min(Math.max(opts.maxResults || 5, 1), 10);
  const contextChars = opts.contextChars || 120;
  const maxScan = opts.maxScan || 200000;

  if (!query) return { ok: false, reason: 'empty-query' };
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };
  const win = doc.defaultView;

  // 简化版文本序列化：隐藏剪枝 + 黑名单跳过 + 块级换行。
  // 搜索场景不需要表格转 Markdown（单元格文本按行带出即可）。
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'UL', 'OL', 'LI',
    'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'PRE', 'FORM', 'FIELDSET', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'TR',
    'HR', 'DETAILS', 'SUMMARY', 'TABLE', 'BR',
  ]);
  const out = [];
  let outLen = 0;
  function visit(node) {
    if (outLen > maxScan) return;
    if (node.nodeType === 3) {
      const s = node.nodeValue || '';
      out.push(s);
      outLen += s.length;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'IFRAME') return;
    const style = win.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out.push(' ');
    for (const child of node.childNodes) visit(child);
    if (isBlock) out.push(' ');
  }
  visit(doc.body);

  // 统一压成单行（全部空白 → 单空格）：搜索词跨换行也能命中，snippet 也更干净
  const haystack = out.join('').replace(/\s+/g, ' ').trim().slice(0, maxScan);
  const lower = haystack.toLowerCase();
  const needle = query.toLowerCase();

  let total = 0;
  const results = [];
  let pos = lower.indexOf(needle);
  while (pos !== -1) {
    total++;
    if (results.length < maxResults) {
      const start = Math.max(0, pos - contextChars);
      const end = Math.min(haystack.length, pos + needle.length + contextChars);
      results.push({
        index: pos,
        snippet:
          haystack.slice(start, pos) +
          '【' + haystack.slice(pos, pos + needle.length) + '】' +
          haystack.slice(pos + needle.length, end),
      });
    }
    pos = lower.indexOf(needle, pos + needle.length);
  }
  return { ok: true, total, results };
}
