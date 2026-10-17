// extract_table 的 rows 模式在真实 Chromium 里的行为（验收标准第 39 条）
//
// run_javascript 的 tables 参数靠它取表：合并单元格要展开成重复值，列号才与页面上看到的对齐。
// 没装 Playwright 时整体跳过，见 tests/README.md。

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { performAction } from '../../extension/core/actions.js';
import { loadPlaywright, fixture, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

describe('按行取表（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;

  before(async () => {
    browser = await playwright.chromium.launch();
    page = await browser.newPage();
    await page.setContent(fixture('tables.html'));
  });
  after(async () => { if (browser) await browser.close(); });

  const rows = (tableIndex, maxLen) => inject(page, performAction, { action: 'extract_table', tableIndex, format: 'rows', maxLen });

  test('rowspan / colspan 展开成重复值，单元格取原文（竖线不转义、空白压成一个）', async () => {
    const r = await rows(1);
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows, [
      ['地区', '营收（亿元）', '营收（亿元）'],
      ['华东', '2023', '1,234.5'],
      ['华东', '2024', '1,500 | 预计'],
      ['华北', '2024', '980'],
    ]);
    assert.deepEqual([r.rowCount, r.colCount, r.keptRows, r.total], [4, 3, 4, 7]);
  });

  test('rowspan="0" 占满所在区段；本行单元格用完后，右侧被上方占着的格子照样补上', async () => {
    const r = await rows(2);
    assert.deepEqual(r.rows, [['全年', 'Q1', '合计'], ['全年', 'Q2', '合计'], ['全年', 'Q3', '合计']]);
  });

  test('rowspan 与浏览器一样止于 thead / tbody 末尾，不串进下一个区段', async () => {
    assert.deepEqual((await rows(6)).rows, [
      ['地区', '营收'],
      ['华东', '100'],
      ['华北', '80'],
      ['华北', '90'],
      ['华南', '70'],
    ]);
  });

  test('colspan 盖住上方 rowspan 占着的格子时，上方单元格照样少占一行', async () => {
    assert.deepEqual((await rows(7)).rows, [['甲', '乙'], ['丙', '丙'], ['丁', '戊']]);
  });

  test('嵌套表格：外层只取自己的行，内层按自己的序号单独取', async () => {
    assert.deepEqual((await rows(3)).rows, [['外层', '内层']]);
    assert.deepEqual((await rows(4)).rows, [['内层']]);
  });

  test('超出预算只取前若干行，报出原表行数', async () => {
    const r = await rows(5, 2000);
    assert.equal(r.rowCount, 500);
    assert.ok(r.keptRows > 10 && r.keptRows < 500);
    assert.equal(r.rows.length, r.keptRows);
    assert.deepEqual(r.rows[0], ['1', '值'.repeat(20)]);
  });

  test('缺省仍返回 Markdown，与 rows 模式互不影响', async () => {
    const r = await inject(page, performAction, { action: 'extract_table', tableIndex: 1 });
    assert.match(r.data, /^\| 地区 \| 营收（亿元） \|/);
    assert.ok(r.data.includes('1,500 \\| 预计'));
  });

  test('序号越界照旧报 bad-table-index', async () => {
    assert.deepEqual(await rows(9), { ok: false, reason: 'bad-table-index', total: 7 });
  });
});
