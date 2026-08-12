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
