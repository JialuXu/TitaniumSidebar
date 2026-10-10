// 勾选类控件在真实 Chromium 里的编号、点击与状态回读（验收标准第 12、35 条）
//
// 夹具按组件库的真实结构复刻（tests/dom/fixtures/controls.html），注入函数按 executeScript
// 的方式序列化后在页面里执行。没装 Playwright 时整体跳过，见 tests/README.md。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { performAction } from '../../extension/core/actions.js';
import { highlightElement } from '../../extension/core/highlight.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, fixture, inject, settle } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

describe('勾选类控件（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;
  let session;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
    await page.setContent(fixture('controls.html'));
    const snap = await full();
    session = snap.session;
  });

  const S = () => injectedStrings();
  const full = () => inject(page, snapshotPage, { mode: 'full', i18n: S() });
  const elements = () => inject(page, snapshotPage, { mode: 'elements', session, i18n: S() });
  const click = (ref) => inject(page, performAction, { action: 'click', ref, session, i18n: S() });
  /** 选择器对应元素的 ref；没编号返回 0 */
  const refFor = (selector) => page.evaluate(
    (sel) => window.__titanium.elements.indexOf(document.querySelector(sel)) + 1, selector);
  const rectOf = (selector) => page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, selector);
  const infoOf = (list, ref) => list.find((e) => e.ref === ref);
  /** 点击并等页面更新完，返回增量刷新的结果 */
  const clickAndRefresh = async (ref) => {
    const res = await click(ref);
    assert.equal(res.ok, true, JSON.stringify(res));
    await settle(page);
    return { res, snap: await elements() };
  };

  test('Element 数据行：0×0 的 input 编号，label 不另编号，框取 label', async () => {
    const ref = await refFor('#el-row1 input');
    assert.ok(ref > 0);
    assert.equal(await refFor('#el-row1'), 0);
    const info = infoOf((await elements()).elements, ref);
    assert.ok(info, '增量刷新里看得到它');
    assert.equal(info.role, 'checkbox');
    assert.equal(info.name, '张三');
    assert.equal(info.inViewport, true);
    assert.deepEqual(info.bbox, await rectOf('#el-row1'));
  });

  test('Element 数据行：点击经 label 转发给控件，增量里报「未选中 → 已选中」', async () => {
    const ref = await refFor('#el-row1 input');
    const { res, snap } = await clickAndRefresh(ref);
    assert.equal(res.checked, true);
    assert.equal(res.name, '张三');
    assert.equal(await page.evaluate(() => document.querySelector('#el-row1 .el-checkbox__input').classList.contains('is-checked')), true);
    const info = infoOf(snap.elements, ref);
    assert.equal(info.value, S().checked);
    assert.deepEqual(info.changes, [{ key: 'value', from: null, to: S().checked }]);
    assert.equal(snap.stats.changedElements, 1);
  });

  test('Element 表头半选：外层 span 报「部分选中」；点成全选后它交出角色，input 作为新元素出现', async () => {
    const host = await refFor('#el-head .el-checkbox__input');
    assert.ok(host > 0);
    assert.equal(await refFor('#el-head input'), 0, '半选态下 input 是 aria-hidden');
    assert.equal(infoOf((await elements()).elements, host).value, S().mixed);

    const { snap } = await clickAndRefresh(host);
    const before = infoOf(snap.elements, host);
    assert.deepEqual(before.changes, [
      { key: 'role', from: 'checkbox', to: 'clickable' },
      { key: 'value', from: S().mixed, to: null },
    ]);
    const input = infoOf(snap.elements, await refFor('#el-head input'));
    assert.equal(input.isNew, true);
    assert.equal(input.role, 'checkbox');
    assert.equal(input.value, S().checked);
  });

  test('Element 开关：同一控件只编外层 switch 一个号，点击后回读 aria-checked', async () => {
    assert.equal(await refFor('#el-switch input'), 0);
    const ref = await refFor('#el-switch');
    assert.equal(infoOf((await elements()).elements, ref).role, 'switch');
    const { snap } = await clickAndRefresh(ref);
    assert.deepEqual(infoOf(snap.elements, ref).changes, [{ key: 'value', from: null, to: S().checked }]);
  });

  test('antd：透明铺满的 input 自己就是视觉代理', async () => {
    const ref = await refFor('#antd input');
    const info = infoOf((await elements()).elements, ref);
    assert.deepEqual(info.bbox, await rectOf('#antd input'));
    const { res } = await clickAndRefresh(ref);
    assert.equal(res.checked, true);
  });

  test('sr-only + label[for]：框取 label，点击勾上', async () => {
    const ref = await refFor('#sr-cb');
    const info = infoOf((await elements()).elements, ref);
    assert.equal(info.name, '记住我');
    assert.deepEqual(info.bbox, await rectOf('label[for=sr-cb]'));
    const { res } = await clickAndRefresh(ref);
    assert.equal(res.checked, true);
  });

  test('原生单选：选乙之后再选甲，乙的「已选中」消失也报出来', async () => {
    assert.equal(await page.evaluate(() => document.querySelectorAll('#native label').length), 3);
    const r1 = await refFor('#native-r1');
    const r2 = await refFor('#native-r2');
    await clickAndRefresh(r2);
    const { snap } = await clickAndRefresh(r1);
    assert.deepEqual(infoOf(snap.elements, r1).changes, [{ key: 'value', from: null, to: S().checked }]);
    assert.deepEqual(infoOf(snap.elements, r2).changes, [{ key: 'value', from: S().checked, to: null }]);
  });

  test('纯 ARIA 勾选框：状态读 aria-checked；点了没反应的不出现在变化里', async () => {
    const live = await refFor('#aria-cb');
    const dead = await refFor('#aria-dead');
    const first = await clickAndRefresh(live);
    assert.deepEqual(infoOf(first.snap.elements, live).changes, [{ key: 'value', from: null, to: S().checked }]);
    const second = await clickAndRefresh(dead);
    const info = infoOf(second.snap.elements, dead);
    assert.equal(info.value, null);
    assert.equal(info.changes, undefined);
  });

  test('勾选协议后「下一步」由不可用变可用', async () => {
    const next = await refFor('#next');
    const { snap } = await clickAndRefresh(await refFor('#agree'));
    assert.deepEqual(infoOf(snap.elements, next).changes, [{ key: 'disabled', from: true, to: false }]);
  });

  test('自定义下拉：展开态与新选项；选完后名称回填、收起', async () => {
    const city = await refFor('#city');
    assert.equal(infoOf((await elements()).elements, city).expanded, false);

    const opened = await clickAndRefresh(city);
    assert.deepEqual(infoOf(opened.snap.elements, city).changes, [{ key: 'expanded', from: false, to: true }]);
    const options = opened.snap.elements.filter((e) => e.isNew && e.role !== 'listbox');
    assert.deepEqual(options.map((o) => o.name), ['北京', '上海']);

    const picked = await clickAndRefresh(options[1].ref);
    assert.deepEqual(infoOf(picked.snap.elements, city).changes, [
      { key: 'name', from: '请选择城市', to: '上海' },
      { key: 'expanded', from: true, to: false },
    ]);
  });

  test('高亮：0×0 控件的框画在 label 上', async () => {
    const ref = await refFor('#el-row1 input');
    const res = await inject(page, highlightElement, { ref, session, durationMs: 50, scroll: false });
    assert.equal(res.ok, true);
    assert.deepEqual(res.bbox, await rectOf('#el-row1'));
  });
});
