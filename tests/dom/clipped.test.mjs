// 零尺寸裁剪容器在真实 Chromium 里的剪枝（验收标准第 41 条）
//
// 「高度 0 + overflow:hidden」收起的内容不进正文、骨架、表格序号与元素列表；
// 收起之前编过号的元素，增量刷新不再列出，按 ref 动作与高亮都报 hidden。
// 护栏：sr-only 文字、static 的收起容器、「body overflow:hidden + 绝对定位的应用根」照常读出。
// 没装 Playwright 时整体跳过，见 tests/README.md。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { performAction } from '../../extension/core/actions.js';
import { highlightElement } from '../../extension/core/highlight.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, fixture, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

const count = (text, word) => text.split(word).length - 1;

describe('零尺寸裁剪容器（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
    await page.setContent(fixture('clipped.html'));
  });

  const S = () => injectedStrings();
  const full = () => inject(page, snapshotPage, { mode: 'full', i18n: S() });
  const refFor = (selector) => page.evaluate(
    (sel) => window.__titanium.elements.indexOf(document.querySelector(sel)) + 1, selector);

  test('第 41 条：正文里只有选中值，收起的选项清单不出现、不编号', async () => {
    const snap = await full();
    assert.equal(snap.ok, true);
    assert.equal(count(snap.text, '投研＋投管'), 1, snap.text);
    assert.equal(count(snap.text, '已领'), 1, snap.text);
    for (const word of ['审计', '风险合规', '投行与融资', '待领']) {
      assert.equal(snap.text.includes(word), false, `${word} 不该出现：${snap.text}`);
    }
    assert.equal(snap.elements.some((e) => e.name === '审计' || e.name === '待领'), false);
  });

  test('第 41 条：全文搜索与正文同一口径，搜不到收起的选项', async () => {
    const res = await inject(page, snapshotPage, { mode: 'text', query: '风险合规', i18n: S() });
    assert.equal(res.total, 0);
    assert.equal(res.outside.total, 0);
  });

  test('第 41 条：护栏——sr-only 文字、static 收起容器的内容照常读出', async () => {
    const snap = await full();
    assert.ok(snap.text.includes('仅供读屏器朗读的说明'));
    assert.ok(snap.text.includes('静态收起区里的文字'));
  });

  test('第 41 条：只剪内容不剪自身——Chromium 默认 overflow:clip 的 0 宽输入框照常编号', async () => {
    const snap = await full();
    assert.ok(snap.elements.some((e) => e.name === '隐藏的取值框'), JSON.stringify(snap.elements.map((e) => e.name)));
  });

  test('第 41 条：收起区里的表不计序号，extract_table 的 #1 与骨架一致', async () => {
    const snap = await full();
    assert.equal(snap.stats.tables, 1);
    const res = await inject(page, performAction, { action: 'extract_table', tableIndex: 1, i18n: S() });
    assert.equal(res.ok, true);
    assert.equal(res.total, 1);
    assert.ok(res.data.includes('看得见的表'), res.data);
  });

  test('第 41 条：展开时编过号的选项，收起后增量刷新不再列出，点击与高亮都报 hidden', async () => {
    await page.evaluate(() => document.getElementById('dd1').classList.add('open'));
    const snap = await full();
    const session = snap.session;
    const ref = await refFor('#dd1 .opt:nth-child(2)');
    assert.ok(ref > 0, '展开时选项编了号');
    assert.ok(snap.elements.some((e) => e.ref === ref && e.name === '审计'));

    await page.evaluate(() => document.getElementById('dd1').classList.remove('open'));
    const fresh = await inject(page, snapshotPage, { mode: 'elements', session, i18n: S() });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.elements.some((e) => e.ref === ref), false, '收起后不再列出');

    const clicked = await inject(page, performAction, { action: 'click', ref, session, i18n: S() });
    assert.deepEqual([clicked.ok, clicked.reason], [false, 'hidden']);
    const lit = await inject(page, highlightElement, { ref, session, scroll: false });
    assert.deepEqual([lit.ok, lit.reason], [false, 'hidden']);
  });

  test('第 41 条：护栏——body overflow:hidden、内容全是绝对定位时整页照常读出', async () => {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head>
      <body style="margin:0;overflow:hidden;position:relative">
        <div style="position:absolute;inset:0"><h1>应用标题</h1><p>整页应用的正文</p><button>提交</button></div>
      </body></html>`);
    const snap = await full();
    assert.equal(snap.ok, true);
    assert.equal(await page.evaluate(() => document.body.getBoundingClientRect().height), 0, '夹具前提：body 高度为 0');
    assert.ok(snap.text.includes('整页应用的正文'), snap.text);
    assert.ok(snap.elements.some((e) => e.name === '提交'));
  });

  test('第 41 条：护栏——static 的根容器高度为 0、内容绝对定位时照常读出', async () => {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
        <div id="root" style="overflow:hidden"><div style="position:absolute;top:0;left:0;width:400px">挂在根容器下的正文</div></div>
      </body></html>`);
    assert.equal(await page.evaluate(() => document.getElementById('root').getBoundingClientRect().height), 0, '夹具前提：根容器高度为 0');
    const snap = await full();
    assert.ok(snap.text.includes('挂在根容器下的正文'), snap.text);
  });
});
