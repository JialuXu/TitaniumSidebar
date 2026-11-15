// 引用原文在页面上的定位高亮（验收标准第 48 条）
//
// highlightText 按「去掉全部空白后的连续文字」在活页面上找引用，范围要跨行内标签、
// 跳过看不见的内容，脱敏打码的位按任意数字匹配。没装 Playwright 时整体跳过，见 tests/README.md。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { highlightText } from '../../extension/core/text-highlight.js';
import { loadPlaywright, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>定位</title></head>
<body style="margin:0">
  <div style="height:3000px">占位，把正文推到视口之外</div>
  <p id="p">公司全年实现营业收入 <b>128.5 亿元</b>，
     同比增长 <em>12.3%</em>，净利润创历史新高。</p>
  <p>联系人手机 13812345678，请在工作日联系。</p>
  <p style="display:none">这段文字被隐藏起来了不应当命中</p>
  <script>var s = '脚本里的文字不应当命中的';</script>
  <iframe id="f" srcdoc="<p style='margin:0'>框架里的一段说明文字也能定位</p>" style="width:300px;height:60px;border:0"></iframe>
</body></html>`;

const OVERLAY = '#__titanium-highlight__';

describe('引用定位（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    if (page) await page.close();
    page = await browser.newPage();
    await page.setViewportSize({ width: 600, height: 400 });
    await page.setContent(PAGE);
    await page.waitForFunction(() => {
      const f = document.getElementById('f');
      return f.contentDocument && f.contentDocument.querySelector('p');
    });
  });

  test('第 48 条：跨行内标签、忽略空白差异找到原文，滚动到位并画出覆盖层', async () => {
    const res = await inject(page, highlightText, { text: '营业收入128.5 亿元， 同比增长 12.3%' });
    assert.equal(res.ok, true);
    assert.ok(res.rects >= 1);
    const state = await page.evaluate((sel) => {
      const boxes = [...document.querySelectorAll(`${sel} > div`)].map((b) => b.getBoundingClientRect());
      const p = document.getElementById('p').getBoundingClientRect();
      return {
        scrolled: window.scrollY > 1000,
        inside: boxes.every((b) => b.top >= p.top - 2 && b.bottom <= p.bottom + 2),
        inView: boxes.every((b) => b.top >= 0 && b.bottom <= window.innerHeight),
        clickThrough: getComputedStyle(document.querySelector(sel)).pointerEvents === 'none',
      };
    }, OVERLAY);
    assert.deepEqual(state, { scrolled: true, inside: true, inView: true, clickThrough: true });
  });

  test('第 48 条：覆盖层到时自动移除，再次定位先撤掉上一个', async () => {
    // 前两次都给足时长：数覆盖层个数时它们不能已经到时消失（慢机器上 60ms 早过了）
    await inject(page, highlightText, { text: '净利润创历史新高', durationMs: 30000 });
    await inject(page, highlightText, { text: '请在工作日联系', durationMs: 30000 });
    assert.equal(await page.locator(OVERLAY).count(), 1);
    await inject(page, highlightText, { text: '请在工作日联系', durationMs: 60 });
    await page.waitForFunction((sel) => !document.querySelector(sel), OVERLAY);
  });

  test('第 48 条：脱敏打过码的引用按任意数字匹配页面上的原号码', async () => {
    const res = await inject(page, highlightText, { text: '联系人手机 1**********，请在工作日联系' });
    assert.equal(res.ok, true);
  });

  test('第 48 条：隐藏的文字、脚本里的文字、页面上没有的文字都报 not-found，不画任何东西', async () => {
    for (const text of ['这段文字被隐藏起来了不应当命中', '脚本里的文字不应当命中的', '页面上根本没有这句话', '太短']) {
      assert.deepEqual(await inject(page, highlightText, { text }), { ok: false, reason: 'not-found' }, text);
    }
    assert.equal(await page.locator(OVERLAY).count(), 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  });

  test('第 48 条：同源框架里的原文在框架自己的文档里高亮', async () => {
    const res = await inject(page, highlightText, { text: '框架里的一段说明文字也能定位' });
    assert.equal(res.ok, true);
    const where = await page.evaluate((sel) => ({
      top: Boolean(document.querySelector(sel)),
      frame: Boolean(document.getElementById('f').contentDocument.querySelector(sel)),
    }), OVERLAY);
    assert.deepEqual(where, { top: false, frame: true });
  });
});
