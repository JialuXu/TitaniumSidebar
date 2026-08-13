// core/format.js —— 感知数据的文本序列化与预算控制（平台无关层）
//
// 快照/搜索返回的是结构化数据，发给模型前需要转成紧凑、稳定的纯文本。
// 各通道的字符预算集中在 BUDGETS 里管理，超预算一律显式截断并注明，
// 不做静默丢弃（模型需要知道「还有更多」才会去调工具）。

export const BUDGETS = {
  text: 12000,       // 页面正文（snapshot 内部已按此截断，这里仅作统一出处）
  outline: 1500,     // 结构骨架
  elements: 4000,    // 元素列表（工具结果）
  newElements: 1200, // 动作后的新增元素增量（回合内高频出现，预算收紧）
  html: 4000,        // 单个元素的精简 HTML
  table: 50000,      // 单个表格的完整 Markdown（刻意远超正文预算，这是它存在的意义）
  snippet: 120,      // 搜索结果单条上下文半径
  name: 80,          // 元素可访问名
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
 *  *[16] button "展开更多"          ← * 表示上次动作后新出现
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
    const line = `${el.isNew ? '*' : ''}[${el.ref}] ${el.role}${name}${href}${value}${flag}`;
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
 * 页面位置与规模概览（列元素/报告页面变化时附在头部）。
 * 让模型知道「还有多少内容在视口外」，据此决定滚动还是搜索。
 * @param {{ h, scrollY, docH }} viewport snapshotPage 返回的 viewport
 * @param {{ totalElements?, tables?, iframes? }} [stats] snapshotPage 返回的 stats
 */
export function formatPageStatus(viewport, stats) {
  const lines = [];
  if (viewport && viewport.docH && viewport.h) {
    const scrollable = Math.max(0, viewport.docH - viewport.h);
    const above = viewport.scrollY / viewport.h;
    const below = Math.max(0, viewport.docH - viewport.scrollY - viewport.h) / viewport.h;
    const percent = scrollable > 0 ? Math.round((viewport.scrollY / scrollable) * 100) : 100;
    lines.push(
      scrollable > 0
        ? `当前视口位于全文 ${percent}% 处，上方约 ${above.toFixed(1)} 屏、下方约 ${below.toFixed(1)} 屏。`
        : '当前页面一屏即可显示完整内容。'
    );
  }
  if (stats) {
    const parts = [];
    if (typeof stats.totalElements === 'number') parts.push(`交互元素 ${stats.totalElements} 个`);
    if (stats.tables) parts.push(`表格 ${stats.tables} 个（可用 extract_table 按序号完整提取）`);
    if (stats.iframes) parts.push(`内嵌框架 ${stats.iframes} 个（跨文档内容读取不到）`);
    if (parts.length) lines.push('页面统计：' + parts.join(' · '));
  }
  return lines.join('\n');
}

/**
 * 动作执行后的页面变化摘要（动作类工具结果的统一尾巴）。
 * 导航后刻意不带新页全文——那会让回合内 token 迅速膨胀；
 * 模型需要细节时自行调 find_in_page / list_elements。
 * @param {{ navigated, restricted?, title?, url?, newElements?, viewport?, stats? }} change
 */
export function formatPageChange(change) {
  if (!change) return '';
  if (change.restricted) {
    return '页面已跳转到无法读取的页面（浏览器内部页或受限页面），后续无法感知或操作该页。';
  }
  if (change.navigated) {
    const head = `页面已跳转：${change.title || '未命名页面'}（${change.url || ''}）。` +
      '元素编号已重置，操作前请先调用 list_elements 获取新编号。';
    const status = formatPageStatus(change.viewport, change.stats);
    return status ? head + '\n' + status : head;
  }
  const fresh = change.newElements || [];
  if (!fresh.length) return '页面未跳转，也没有新增可交互元素。';
  return `页面未跳转，新增 ${fresh.length} 个可交互元素（带 * 前缀）：\n` +
    formatElements(fresh, { budget: BUDGETS.newElements });
}

/**
 * 标签页列表 → 文本（list_tabs 工具结果）。
 * @param {Array<{id, title, url, active, isWork}>} tabs
 */
export function formatTabs(tabs) {
  if (!tabs || !tabs.length) return '没有可访问的标签页。';
  const lines = [`共 ${tabs.length} 个标签页：`];
  for (const t of tabs) {
    const marks = [];
    if (t.isWork) marks.push('当前工作页');
    else if (t.active) marks.push('浏览器当前激活页');
    const mark = marks.length ? `（${marks.join('、')}）` : '';
    lines.push(`[tab_id=${t.id}] ${clampText(t.title || '未命名页面', 60)}${mark}\n    ${clampText(t.url || '', 120)}`);
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
