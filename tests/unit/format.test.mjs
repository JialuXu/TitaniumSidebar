// core/format.js —— 感知数据的序列化与预算（验收标准第 5、12、24、33 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGETS, clampText, formatOutline, formatElements, formatTextDiff,
  formatReadResult, formatSearchResults, formatPageChange, formatPageStatus, formatTabs,
} from '../../extension/core/format.js';
import { setLocale, t } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

/** 「另有 N 个较细的标题未列出」这一行：按当前语言的文案生成匹配式 */
function omittedLine() {
  const [before, after] = t('fmt.outlineOmitted', { n: '\u0000' }).split('\u0000');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(before)}\\d+${esc(after)}$`);
}

test('clampText', () => {
  assert.equal(clampText('abcdef', 3), 'abc…');
  assert.equal(clampText('abc', 3), 'abc');
  assert.equal(clampText(null, 3), '');
});

test('read_page_text 的三道闸：跨回合保留量 ≥ 单次上限（最近一次读取必留）', () => {
  assert.ok(BUDGETS.readRetained >= BUDGETS.readMax);
  assert.ok(BUDGETS.readPerTurn >= BUDGETS.readMax);
});

/* ========== 结构骨架 ========== */

test('骨架缩进、名称与 @位置', () => {
  const out = formatOutline([
    { kind: 'landmark', tag: 'main', depth: 0 },
    { kind: 'heading', tag: 'h1', level: 1, name: '年报', depth: 0 },
    { kind: 'heading', tag: 'h2', level: 2, name: '第六章', depth: 0, pos: 21040 },
  ]);
  assert.equal(out, '- main\n  - h1 「年报」\n  - h2 「第六章」 @21040');
});

test('空骨架为空串', () => {
  assert.equal(formatOutline([]), '');
  assert.equal(formatOutline(null), '');
});

test('第 33 条：截断之外的标题另有预算，前半截再长也挤不掉，超预算先丢 h4 并在末尾注明', () => {
  const head = Array.from({ length: 200 }, (_, i) => ({ kind: 'heading', tag: 'h2', level: 2, name: `前半 ${i}`, depth: 0 }));
  const beyond = [];
  for (let i = 0; i < 60; i++) {
    beyond.push({ kind: 'heading', tag: 'h2', level: 2, name: `后半章 ${i}`, depth: 0, pos: 20000 + i * 100 });
    beyond.push({ kind: 'heading', tag: 'h4', level: 4, name: `后半小节 ${i}`, depth: 0, pos: 20050 + i * 100 });
  }
  const out = formatOutline([...head, ...beyond]);
  const lines = out.split('\n');
  // 后半截的章标题全部保留、位置完整
  for (let i = 0; i < 60; i++) assert.ok(out.includes(`「后半章 ${i}」 @${20000 + i * 100}`), `后半章 ${i}`);
  // 腾地方丢的是 h4（丢到放得下为止）
  assert.ok((out.match(/后半小节/g) || []).length < 60);
  // 按整行截断：每个 @ 后面都是一个完整位置
  for (const l of lines) if (l.includes('@')) assert.match(l, / @\d+$/);
  assert.match(lines.at(-1), omittedLine());
});

test('超预算时丢层级的先后：h4 丢完仍超才丢 h3，最后才从尾部截同级', () => {
  const nodes = [];
  for (let i = 0; i < 10; i++) {
    nodes.push({ kind: 'heading', tag: 'h2', level: 2, name: `章${i}`, depth: 0 });
    nodes.push({ kind: 'heading', tag: 'h3', level: 3, name: `节${i}`, depth: 0 });
    nodes.push({ kind: 'heading', tag: 'h4', level: 4, name: `小节${i}`, depth: 0 });
  }
  const size = (s) => s.split('\n').filter((l) => !omittedLine().test(l)).join('\n').length;
  const all = formatOutline(nodes, { budget: 10000 });
  const noH4 = all.split('\n').filter((l) => !l.includes('- h4')).join('\n');
  const noH3H4 = noH4.split('\n').filter((l) => !l.includes('- h3')).join('\n');

  // 预算恰好容得下「去掉全部 h4」：h2、h3 一个不少
  const a = formatOutline(nodes, { budget: noH4.length });
  assert.equal(size(a), noH4.length);
  assert.ok(!a.includes('- h4'));
  // 再紧一点：h3 也开始丢，h2 仍然全在
  const b = formatOutline(nodes, { budget: noH3H4.length });
  for (let i = 0; i < 10; i++) assert.ok(b.includes(`「章${i}」`));
  // 连 h2 都放不下：从尾部截
  const c = formatOutline(nodes, { budget: 30 });
  assert.ok(c.includes('「章0」'));
  assert.ok(!c.includes('「章9」'));
});

test('节点硬顶没收录的数量注明在末尾', () => {
  const out = formatOutline([{ kind: 'heading', tag: 'h1', level: 1, name: 'x', depth: 0 }], { dropped: 37 });
  assert.equal(out.split('\n').at(-1), t('fmt.outlineTruncated', { n: 37 }));
});

/* ========== 元素列表 ========== */

const el = (ref, extra = {}) => ({ ref, role: 'button', tag: 'button', name: '删除', ...extra });

test('行格式：新增星号、链接、值、禁用、行锚点', () => {
  const out = formatElements([
    el(1, { name: '提交', isNew: true }),
    { ref: 2, role: 'link', tag: 'a', name: '详情', href: '/o/1' },
    { ref: 3, role: 'textbox', tag: 'input', name: '地址', value: '北京' },
    el(4, { name: '确认', disabled: true }),
    { ref: 5, role: 'checkbox', tag: 'input', context: 'Slack' },
  ]);
  const lines = out.split('\n');
  assert.equal(lines[0], '*[1] button "提交"');
  assert.equal(lines[1], '[2] link "详情" → /o/1');
  assert.ok(lines[2].startsWith('[3] textbox "地址"') && lines[2].includes('北京'));
  assert.ok(lines[3].startsWith('[4] button "确认"') && lines[3] !== '[4] button "确认"');
  assert.ok(lines[4].startsWith('[5] checkbox') && lines[4].includes('Slack'));
});

test('同构组 ≥5 个时只展开两个样本，其余合并成一行', () => {
  const out = formatElements([1, 2, 3, 4, 5, 6].map((r) => el(r)));
  const lines = out.split('\n');
  assert.equal(lines[0], '[1] button "删除"');
  assert.equal(lines[1], '[2] button "删除"');
  assert.equal(lines[2], t('fmt.collapsed', { n: 4, refs: '3/4/5/6' }));
  assert.equal(lines.at(-1), t('fmt.collapseNote'));
});

test('名称不同、或新出现的元素绝不折叠；collapse:false 时逐项列出', () => {
  const pages = [1, 2, 3, 4, 5].map((r) => el(r, { name: `第${r}页` }));
  assert.equal(formatElements(pages).split('\n').length, 5);
  const withNew = [1, 2, 3, 4, 5].map((r) => el(r, { isNew: true }));
  assert.equal(formatElements(withNew).split('\n').length, 5);
  assert.equal(formatElements([1, 2, 3, 4, 5, 6].map((r) => el(r)), { collapse: false }).split('\n').length, 6);
});

test('超预算时截断并提示还有多少', () => {
  const many = Array.from({ length: 50 }, (_, i) => el(i, { name: `按钮${i}` }));
  const out = formatElements(many, { budget: 100, total: 80 });
  const lines = out.split('\n');
  const shown = lines.length - 1;
  assert.equal(lines.at(-1), t('fmt.moreElements', { total: 80, shown }));
});

test('没有元素', () => {
  assert.equal(formatElements([]), t('fmt.noElements'));
});

/* ========== 页面差异 ========== */

const PAGE = Array.from({ length: 60 }, (_, i) => `第 ${i} 行：这是一段足够长的页面正文，用来让差异摘要比全文便宜。`).join('\n');

test('没变化返回 null', () => {
  assert.equal(formatTextDiff(PAGE, PAGE), null);
});

test('新增与消失的行分别列出', () => {
  const next = PAGE.replace('第 3 行', '第 3 行（已展开）') + '\n新增的一行';
  const out = formatTextDiff(PAGE, next);
  assert.ok(out.startsWith(t('fmt.diffHead')));
  assert.ok(out.includes('+ 第 3 行（已展开）'));
  assert.ok(out.includes('+ 新增的一行'));
  assert.ok(out.includes('- 第 3 行：'));
});

test('只是挪了位置的行不算变化', () => {
  const lines = PAGE.split('\n');
  const moved = [...lines.slice(1), lines[0]].join('\n');
  assert.equal(formatTextDiff(PAGE, moved), null);
});

test('变动过多、摘要不够便宜、任一侧为空时交回全文', () => {
  const rewritten = PAGE.split('\n').map((l) => l + '改').join('\n');
  assert.equal(formatTextDiff(PAGE, rewritten), null);
  assert.equal(formatTextDiff('短页面', '短页面变了'), null);
  assert.equal(formatTextDiff('', PAGE), null);
});

/* ========== 读取、搜索、页面状态 ========== */

test('读取结果：头尾自述与续读位置', () => {
  const out = formatReadResult({ text: '正文', start: 100, end: 200, total: 500, capped: false, section: '第二章' });
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '正文');
  assert.equal(lines[2], t('res.readMore', { n: 300, next: 200 }));
  assert.equal(formatReadResult({ text: 'x', start: 0, end: 1, total: 1 }).split('\n')[2], t('res.readEnd'));
  assert.ok(formatReadResult({ text: 'x', start: 0, end: 1, total: 9 }, { warning: '告警' }).startsWith('告警\n'));
});

test('搜索结果：命中带 @位置，片段压成单行；失败与无结果', () => {
  const out = formatSearchResults({ ok: true, total: 1, results: [{ index: 42, snippet: '甲\n  乙', section: '附则' }] }, '甲');
  assert.equal(out.split('\n')[0], t('fmt.searchHeadOne', { query: '甲' }));
  assert.ok(out.split('\n')[1].startsWith('1. @42'));
  assert.ok(out.includes('……甲 乙……'));
  assert.equal(formatSearchResults({ ok: false, reason: 'empty-query' }), t('fmt.searchFailEmpty'));
  assert.equal(formatSearchResults(null), t('fmt.searchFailUnreadable'));
  assert.equal(formatSearchResults({ ok: true, total: 0, results: [] }, 'x'), t('fmt.searchNone', { query: 'x' }));
});

test('页面状态：单屏与滚动位置', () => {
  assert.equal(formatPageStatus({ h: 800, scrollY: 0, docH: 800 }), t('fmt.singleScreen'));
  assert.equal(
    formatPageStatus({ h: 1000, scrollY: 1000, docH: 3000 }),
    t('fmt.scrollPos', { percent: 50, above: '1.0', below: '1.0' })
  );
});

test('动作后的变化摘要：跳转、没有新增、用户自己切走', () => {
  assert.ok(formatPageChange({ navigated: true, title: '新页', url: 'https://x' }).startsWith(
    t('fmt.chgNavigated', { title: '新页', url: 'https://x' })
  ));
  assert.equal(formatPageChange({ navigated: false, newElements: [] }), t('fmt.chgNoNew'));
  const switched = formatPageChange({ navigated: false, newElements: [], userSwitched: { title: '别的页' } });
  assert.ok(switched.endsWith(t('fmt.chgUserSwitched', { title: '别的页' })));
  assert.equal(formatPageChange(null), '');
});

test('标签页列表标出工作页', () => {
  const out = formatTabs([{ id: 7, title: 'A', url: 'https://a', isWork: true }]);
  assert.ok(out.includes('[tab_id=7] A'));
  assert.ok(out.includes(t('fmt.tabWork')));
  assert.equal(formatTabs([]), t('fmt.noTabs'));
});

test('英文的搜索命中数分单复数', () => {
  setLocale('en');
  const hit = (n) => formatSearchResults({ ok: true, total: n, results: Array.from({ length: n }, (_, i) => ({ index: i, snippet: 'x' })) }, 'x').split('\n')[0];
  assert.match(hit(1), /^Found 1 occurrence of "x"/);
  assert.match(hit(2), /^Found 2 occurrences of "x"/);
});
