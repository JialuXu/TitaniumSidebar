// 页面块之外的事实在真实 Chromium 里的采集（验收标准第 42、43 条）
//
// 标题两端的格式字符剥掉；够大的画布计数并报最大一块的尺寸，画布的回退内容不进正文、
// 不编号、不占表格序号。没装 Playwright 时整体跳过，见 tests/README.md。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { performAction } from '../../extension/core/actions.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

const CANVAS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>画布页</title></head>
<body style="margin:0">
  <header><nav><a href="#">工具栏</a></nav></header>
  <main>
    <h1>报表</h1>
    <canvas id="grid" width="1058" height="716" style="display:block;width:1058px;height:716px">您的浏览器不支持 canvas
      <table><tr><th>回退内容里的表</th></tr></table><button>回退按钮</button></canvas>
    <canvas id="icon" width="83" height="32" style="width:83px;height:32px"></canvas>
    <canvas id="gone" width="400" height="300" style="display:none"></canvas>
    <div style="position:absolute;height:0;overflow:hidden"><canvas width="400" height="300" style="width:400px;height:300px"></canvas></div>
    <table><tr><th>看得见的表</th></tr><tr><td>1</td></tr></table>
  </main>
</body></html>`;

describe('页面事实（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
  });

  const S = () => injectedStrings();
  const full = () => inject(page, snapshotPage, { mode: 'full', i18n: S() });

  test('第 42 条：标题前缀的零宽字符与尾部 BOM 剥掉，中间的组合 emoji 不动', async () => {
    await page.setContent('<!doctype html><meta charset="utf-8"><body><p>正文</p></body>');
    await page.evaluate(() => {
      document.title = '​‌‍⁠⁢﻿'.repeat(7) + '季度报表 👩‍💻 - 在线文档﻿';
    });
    const snap = await full();
    assert.equal(snap.title, '季度报表 👩‍💻 - 在线文档');
  });

  test('第 43 条：够大的可见画布计数，报最大一块的尺寸与视口占比', async () => {
    await page.setContent(CANVAS_PAGE);
    const snap = await full();
    const vp = await page.evaluate(() => [innerWidth, innerHeight]);
    assert.equal(snap.stats.canvases, 1, '小图标、display:none、收起区里的画布都不计');
    assert.deepEqual(snap.stats.canvasMax, {
      w: 1058, h: 716, percent: Math.min(100, Math.round((1058 * 716 * 100) / (vp[0] * vp[1]))),
    });
  });

  test('第 43 条：画布的回退内容不进正文、不编号、不占表格序号', async () => {
    await page.setContent(CANVAS_PAGE);
    const snap = await full();
    assert.equal(snap.text.includes('不支持 canvas'), false, snap.text);
    assert.equal(snap.text.includes('回退内容里的表'), false);
    assert.equal(snap.elements.some((e) => e.name === '回退按钮'), false);
    assert.equal(snap.stats.tables, 1);
    const res = await inject(page, performAction, { action: 'extract_table', tableIndex: 1, i18n: S() });
    assert.equal(res.total, 1);
    assert.ok(res.data.includes('看得见的表'), res.data);
    const fresh = await inject(page, snapshotPage, { mode: 'elements', session: snap.session, i18n: S() });
    assert.equal(fresh.elements.some((e) => e.name === '回退按钮'), false);
  });

  test('第 43 条：没有画布的页面不报画布', async () => {
    await page.setContent('<!doctype html><meta charset="utf-8"><body><p>普通正文</p></body>');
    const snap = await full();
    assert.deepEqual([snap.stats.canvases, snap.stats.canvasMax], [0, null]);
  });
});
