// core/format.js —— 感知数据的文本序列化与预算控制（平台无关层）
//
// 快照/搜索返回的是结构化数据，发给模型前需要转成紧凑、稳定的纯文本。
// 各通道的字符预算集中在 BUDGETS 里管理，超预算一律显式截断并注明，
// 不做静默丢弃（模型需要知道「还有更多」才会去调工具）。
//
// 这里产出的文本是给模型看的，因此同样随界面语言切换（文案见 core/i18n.js）。

import { t, q } from './i18n.js';

export const BUDGETS = {
  text: 12000,       // 页面正文（snapshot 内部已按此截断，这里仅作统一出处）
  outline: 1500,     // 结构骨架
  elements: 4000,    // 元素列表（工具结果）
  newElements: 1200, // 动作后的新增元素增量（回合内高频出现，预算收紧）
  pageDiff: 1800,    // 页面更新摘要（同一网址内容变化时替代 12000 字全文重发）
  html: 4000,        // 单个元素的精简 HTML
  table: 50000,      // 单个表格的完整 Markdown（刻意远超正文预算，这是它存在的意义）
  snippet: 120,      // 搜索结果单条上下文半径
  name: 80,          // 元素可访问名
};

/** 通用截断：超长切断并追加后缀 */
export function clampText(s, max, suffix = '…') {
  const str = s || '';
  return str.length > max ? str.slice(0, max) + suffix : str;
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
    const name = n.name ? ` ${q(n.name)}` : '';
    const meta = n.meta ? t('fmt.metaWrap', { s: n.meta }) : '';
    lines.push(`${indent}- ${n.tag}${name}${meta}`);
  }
  let out = lines.join('\n');
  if (out.length > budget) out = out.slice(0, budget) + t('fmt.outlineTruncated');
  return out;
}

/**
 * 元素列表 → 行式文本（工具结果）。行格式：
 *   [12] button "提交订单"
 *   [13] link "查看详情" → /order/1001
 *   [14] textbox "收货地址" 值:"北京市…"
 *   [15] button "确认"（不可用）
 *  *[16] button "展开更多"                       ← * 表示上次动作后新出现
 *   [17] checkbox（行：Slack - Set up Slack…）   ← 无名/短名控件带所在行锚点
 *
 * 同构折叠：role、标签、名称、禁用态**一字不差**且 ≥5 个的组（列表页每行重复的
 * 勾选框、星标、「删除」按钮）只展开前两个作样本，其余合并为一行 refs 摘要——
 * 它们本就靠行锚点区分，逐行列出只会挤爆预算。名称有任何差异的绝不折叠：
 * 「第1页」「第2页」是不同的操作目标。isNew 的元素永远不折叠（那是模型在等的信号）。
 * @param {Array} elements ElementInfo 数组（已按需过滤/排序）
 * @param {{ budget?: number, total?: number, collapse?: boolean }} [opts]
 *   total 为过滤前总数，用于「还有更多」提示；query 过滤时应传 collapse:false（用户在钻取）
 */
export function formatElements(elements, { budget = BUDGETS.elements, total, collapse = true } = {}) {
  if (!elements || !elements.length) return t('fmt.noElements');

  const renderLine = (el) => {
    const name = el.name ? ` "${el.name}"` : '';
    const ctx = el.context ? t('fmt.rowCtx', { s: el.context }) : '';
    const href = el.href ? ` → ${el.href}` : '';
    const value = el.value ? t('fmt.value', { v: el.value }) : '';
    const flag = el.disabled ? t('fmt.disabled') : '';
    return `${el.isNew ? '*' : ''}[${el.ref}] ${el.role}${name}${ctx}${href}${value}${flag}`;
  };

  // 组装条目序列：普通元素一行一条；被折叠组的隐藏成员合并为一条摘要（covers 记录代表几个元素）
  const COLLAPSE_MIN = 5;
  const SAMPLE = 2;
  const entries = [];
  let anyCollapsed = false;
  if (collapse) {
    const keyOf = (el) => `${el.role}|${el.tag}|${el.name || ''}|${el.disabled ? 1 : 0}`;
    const groups = new Map();
    for (const el of elements) {
      const k = keyOf(el);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(el);
    }
    // 决定每组隐藏哪些成员；只藏 1 个反而多占一行摘要，不划算
    const hiddenSet = new Set();
    const summaryByKey = new Map();
    for (const [k, members] of groups) {
      if (members.length < COLLAPSE_MIN) continue;
      let sampled = 0;
      const hidden = members.filter((el) => {
        if (el.isNew) return false;
        if (sampled < SAMPLE) { sampled++; return false; }
        return true;
      });
      if (hidden.length < 2) continue;
      for (const el of hidden) hiddenSet.add(el);
      const refs = hidden.slice(0, 8).map((e) => e.ref).join('/') + (hidden.length > 8 ? '/…' : '');
      summaryByKey.set(k, { text: t('fmt.collapsed', { n: hidden.length, refs }), covers: hidden.length });
    }
    for (const el of elements) {
      if (!hiddenSet.has(el)) { entries.push({ text: renderLine(el), covers: 1 }); continue; }
      const k = keyOf(el);
      const summary = summaryByKey.get(k);
      if (!summary) continue; // 摘要已在该组首个隐藏成员处输出
      summaryByKey.delete(k);
      entries.push(summary);
      anyCollapsed = true;
    }
  } else {
    for (const el of elements) entries.push({ text: renderLine(el), covers: 1 });
  }

  const lines = [];
  let used = 0;
  let shown = 0;
  for (const e of entries) {
    if (used + e.text.length + 1 > budget) break;
    lines.push(e.text);
    used += e.text.length + 1;
    shown += e.covers;
  }
  const grandTotal = typeof total === 'number' ? total : elements.length;
  if (shown < grandTotal) {
    lines.push(t('fmt.moreElements', { total: grandTotal, shown }));
  }
  if (anyCollapsed) {
    lines.push(t('fmt.collapseNote'));
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
        ? t('fmt.scrollPos', { percent, above: above.toFixed(1), below: below.toFixed(1) })
        : t('fmt.singleScreen')
    );
  }
  if (stats) {
    const parts = [];
    if (typeof stats.totalElements === 'number') parts.push(t('fmt.statElements', { n: stats.totalElements }));
    if (stats.tables) parts.push(t('fmt.statTables', { n: stats.tables }));
    if (stats.iframes) parts.push(t('fmt.statIframes', { n: stats.iframes }));
    if (parts.length) lines.push(t('fmt.statsPrefix') + parts.join(' · '));
    // 编号名额耗尽必须说出来——静默截断会让模型把「没编上号」当成「不存在」
    if (stats.elementsTruncated) {
      lines.push(t('fmt.elementsTruncated'));
    }
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
    return t('fmt.chgRestricted');
  }
  if (change.navigated) {
    const head = t('fmt.chgNavigated', { title: change.title || t('ui.untitled'), url: change.url || '' });
    const status = formatPageStatus(change.viewport, change.stats);
    return status ? head + '\n' + status : head;
  }
  const fresh = change.newElements || [];
  // 名额耗尽时「没有新增」是假象（新元素编不进号），必须区分说法——
  // Gmail 勾选邮件后工具栏按钮找不到，根因正是这句误导性的「没有新增」
  const truncated = change.stats && change.stats.elementsTruncated ? t('fmt.chgTruncNote') : '';
  if (!fresh.length) {
    return truncated ? `${t('fmt.chgNoNewTrunc')}\n${truncated}` : t('fmt.chgNoNew');
  }
  const head = t('fmt.chgNew', { n: fresh.length }) + '\n' +
    formatElements(fresh, { budget: BUDGETS.newElements });
  return truncated ? `${head}\n${truncated}` : head;
}

/**
 * 标签页列表 → 文本（list_tabs 工具结果）。
 * @param {Array<{id, title, url, active, isWork}>} tabs
 */
export function formatTabs(tabs) {
  if (!tabs || !tabs.length) return t('fmt.noTabs');
  const lines = [t('fmt.tabsHead', { n: tabs.length })];
  for (const tab of tabs) {
    let mark = '';
    if (tab.isWork) mark = t('fmt.metaWrap', { s: t('fmt.tabWork') });
    else if (tab.active) mark = t('fmt.metaWrap', { s: t('fmt.tabActive') });
    lines.push(
      `[tab_id=${tab.id}] ${clampText(tab.title || t('ui.untitled'), 60)}${mark}\n    ${clampText(tab.url || '', 120)}`
    );
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
    return t(result && result.reason === 'empty-query' ? 'fmt.searchFailEmpty' : 'fmt.searchFailUnreadable');
  }
  if (!result.total) return t('fmt.searchNone', { query });
  const partial = result.results.length < result.total;
  const lines = [
    partial
      ? t('fmt.searchHeadMore', { total: result.total, query, shown: result.results.length })
      : t('fmt.searchHead', { total: result.total, query }),
  ];
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. ……${r.snippet}……`);
  });
  return lines.join('\n');
}

/**
 * 两次页面文本的变化摘要——同一网址下内容变了（用户翻页/展开、AI 操作了页面）时，
 * 用它替代 12000 字全文重发，请求体里只多出几十行。
 *
 * 刻意用行级多重集比较而非 LCS：这里要的是「哪些内容新出现、哪些不见了」这一提示，
 * 不是精确补丁；多重集是 O(n)、不吃内存，位置移动的行在两侧计数相同因而不会误报为变化。
 * 只在「变化小且能完整列全」时才给摘要——列不全的差异会让模型误以为其余部分没变，
 * 因此变动行过多、或摘要本身省不下多少字符时一律返回 null，
 * 交由调用方重发全文（贵但完整，正确性优先）。
 *
 * @param {string} oldText 模型上次实际看到的页面文本（已脱敏）
 * @param {string} newText 本次快照的页面文本（已脱敏）
 * @param {{ budget?: number, maxLines?: number }} [opts]
 * @returns {string|null} 摘要文本；无变化或不适合用摘要表达时返回 null
 */
export function formatTextDiff(oldText, newText, { budget = BUDGETS.pageDiff, maxLines = 40 } = {}) {
  const split = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const a = split(oldText);
  const b = split(newText);
  if (!a.length || !b.length) return null;

  const tally = (lines) => {
    const map = new Map();
    for (const l of lines) map.set(l, (map.get(l) || 0) + 1);
    return map;
  };
  // 出现次数超出对方计数的那几次即为新增/消失，按文档顺序输出，模型据此判断变化位置
  const exceeding = (lines, other) => {
    const seen = new Map();
    const out = [];
    for (const l of lines) {
      const n = (seen.get(l) || 0) + 1;
      seen.set(l, n);
      if (n > (other.get(l) || 0)) out.push(l);
    }
    return out;
  };
  const added = exceeding(b, tally(a));
  const removed = exceeding(a, tally(b));
  if (!added.length && !removed.length) return null;
  // 变动行太多：一堆无序的增删行已经不足以让模型还原页面现状，交回全文更可靠
  if (added.length > maxLines || removed.length > maxLines) return null;

  const lines = [t('fmt.diffHead')];
  if (added.length) {
    lines.push(t('fmt.diffAdded'));
    for (const l of added) lines.push('+ ' + clampText(l, 200));
  }
  if (removed.length) {
    lines.push(t('fmt.diffRemoved'));
    for (const l of removed) lines.push('- ' + clampText(l, 200));
  }
  // 摘要必须明显比全文便宜才值得走这条路——短页面上「一句说明 + 几行差异」
  // 往往比整页还长，那就老老实实重发全文（同样正确，还更完整）
  const out = lines.join('\n');
  return out.length > Math.min(budget, newText.length * 0.6) ? null : out;
}
