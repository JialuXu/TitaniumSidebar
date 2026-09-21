// core/citation.js —— 引用块出处校验（平台无关层）
//
// 将模型输出的引用块文本与本次提取的页面文本做包含性校验（忽略空白差异）：
// 命中才允许 UI 打「来自当前页面」徽标，防止模型编造“原文”却被界面背书。

/**
 * 归一化：消除全部空白字符。只处理空白差异，其余字符必须逐字一致。
 * @param {string} s
 */
export function normalizeText(s) {
  return (s || '').replace(/\s+/g, '');
}

/**
 * 校验引用文本是否确为页面原文（包含性判断）。
 * 归一化后长度不足 6 个字符视为无校验意义（防止“。”之类的平凡命中）。
 * @param {string} quoteText 引用块文本（取渲染后 blockquote 的 textContent）
 * @param {string} pageText 本次提取（脱敏后）的页面文本——模型看到的就是它
 * @returns {boolean}
 */
export function verifyQuote(quoteText, pageText) {
  const q = normalizeText(quoteText);
  if (q.length < 6) return false;
  return normalizeText(pageText).includes(q);
}

/**
 * 校验用的「页面原文」全集 = 注入的页面文本 + 本会话按位置读取到的正文。
 * 页面文本只有前 12000 字，而 read_page_text 读到的同样是这一页的原文；
 * 不把它算进来的话，模型引用截断之外的真原文反而拿不到徽标（等于惩罚正确行为）。
 * 只认 url 与当前页一致、且还没被回收成占位的那些（`_read` 标记是唯一凭证）。
 * @param {string} pageText 脱敏后的页面文本
 * @param {string} url 当前页面网址
 * @param {Array} messages 会话消息数组
 */
export function buildQuoteCorpus(pageText, url, messages) {
  const parts = pageText ? [pageText] : [];
  for (const m of messages || []) {
    if (!m || !m._read || !m.content) continue;
    if (url && m._read.url && m._read.url !== url) continue;
    // 首尾两行是工具自述（「正文第 X–Y 字」「后面还有 N 字」），不是页面原文
    const lines = String(m.content).split('\n');
    parts.push(lines.slice(1, -1).join('\n'));
  }
  return parts.join('\n');
}
