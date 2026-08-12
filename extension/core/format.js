// core/format.js —— 感知数据的文本序列化与预算控制（平台无关层）
//
// 快照/搜索返回的是结构化数据，发给模型前需要转成紧凑、稳定的纯文本。
// 各通道的字符预算集中在 BUDGETS 里管理，超预算一律显式截断并注明，
// 不做静默丢弃（模型需要知道「还有更多」才会去调工具）。

export const BUDGETS = {
  text: 12000,     // 页面正文（snapshot 内部已按此截断，这里仅作统一出处）
  outline: 1500,   // 结构骨架
  elements: 4000,  // 元素列表（工具结果）
  snippet: 120,    // 搜索结果单条上下文半径
  name: 80,        // 元素可访问名
};

/** 通用截断：超长切断并追加后缀 */
export function clampText(s, max, suffix = '…') {
  const t = s || '';
  return t.length > max ? t.slice(0, max) + suffix : t;
}

/**
 * 结构骨架 → 缩进文本。示例：
 *   - header 「站点导航」
 *   - main
 *     - h1 「2024 年度报告」
 *       - table（12行×5列）
 * @param {Array<{kind, tag, level?, name, depth, meta?}>} nodes snapshotPage 返回的 outline
 */
export function formatOutline(nodes, budget = BUDGETS.outline) {
  if (!nodes || !nodes.length) return '';
  const lines = [];
  for (const n of nodes) {
    // 标题在所属 landmark 内再缩进一级，层级感更接近视觉结构
    const indent = '  '.repeat(Math.min(n.depth + (n.kind === 'heading' ? 1 : 0), 5));
    const label = n.kind === 'heading' ? n.tag : n.tag;
    const name = n.name ? ` 「${n.name}」` : '';
    const meta = n.meta ? `（${n.meta}）` : '';
    lines.push(`${indent}- ${label}${name}${meta}`);
  }
  let out = lines.join('\n');
  if (out.length > budget) out = out.slice(0, budget) + '\n……（结构过长已截断）';
  return out;
}

/**
 * 元素列表 → 行式文本（工具结果）。行格式：
 *   [12] button "提交订单"
 *   [13] link "查看详情" → /order/1001
 *   [14] textbox "收货地址" 值:"北京市…"
 *   [15] button "确认"（不可用）
 * @param {Array} elements ElementInfo 数组（已按需过滤/排序）
 * @param {{ budget?: number, total?: number }} [opts] total 为过滤前总数，用于「还有更多」提示
 */
export function formatElements(elements, { budget = BUDGETS.elements, total } = {}) {
  if (!elements || !elements.length) return '（没有找到可交互元素）';
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const el of elements) {
    const name = el.name ? ` "${el.name}"` : '';
    const href = el.href ? ` → ${el.href}` : '';
    const value = el.value ? ` 值:"${el.value}"` : '';
    const flag = el.disabled ? '（不可用）' : '';
    const line = `[${el.ref}] ${el.role}${name}${href}${value}${flag}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const grandTotal = typeof total === 'number' ? total : elements.length;
  if (shown < grandTotal) {
    lines.push(`……（共 ${grandTotal} 个，仅列出前 ${shown} 个）`);
  }
  return lines.join('\n');
}

/**
 * 页面搜索结果 → 文本（工具结果）。
 * @param {{ ok, total?, results?: Array<{index, snippet}>, reason? }} result searchPage 返回值
 * @param {string} query 原始搜索词（用于文案）
 */
export function formatSearchResults(result, query) {
  if (!result || !result.ok) {
    return `搜索失败：${result && result.reason === 'empty-query' ? '搜索词为空' : '页面不可读'}`;
  }
  if (!result.total) return `页面中没有找到「${query}」。`;
  const lines = [`共找到 ${result.total} 处「${query}」${result.results.length < result.total ? `，以下为前 ${result.results.length} 处` : ''}：`];
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. ……${r.snippet}……`);
  });
  return lines.join('\n');
}
