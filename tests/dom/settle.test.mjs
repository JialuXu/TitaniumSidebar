// 页面就位判定：只看文档是否解析完、元素级增删是否停下（验收标准第 26 条）
//
// 常驻的转圈、「加载中」「暂无数据」这类占位不拖住判定——是不是占位由模型读页面内容判断。
// 没装 Playwright 时整体跳过。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSettle } from '../../extension/core/settle.js';
import { loadPlaywright, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();
const BUDGET = { quietMs: 600, maxMs: 2000 };

describe('页面就位判定（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });
  beforeEach(async () => {
    if (page) await page.close();
    page = await browser.newPage();
  });

  const settle = (html) => page.setContent(html).then(() => inject(page, waitForSettle, BUDGET));

  test('常驻的转圈与「加载中」「暂无数据」占位：DOM 不动就算就位', async () => {
    const res = await settle(`
      <header><div class="ant-spin ant-spin-spinning" aria-busy="true" role="progressbar"><span>加载中</span></div></header>
      <table><tr><td>暂无数据</td></tr></table>`);
    assert.equal(res.settled, true);
    assert.ok(res.waitedMs < BUDGET.quietMs + 400, `等了 ${res.waitedMs}ms`);
  });

  test('元素一直在增删：等到上限，如实报没稳定', async () => {
    const res = await settle(`<ul id="l"></ul><script>
      setInterval(() => { const l = document.getElementById('l'); l.appendChild(document.createElement('li')); if (l.children.length > 3) l.firstChild.remove(); }, 100);
    </script>`);
    assert.equal(res.settled, false);
    assert.ok(res.waitedMs >= BUDGET.maxMs);
    assert.ok(res.changes > 10);
  });

  test('只有文字在跳（时钟、行情）：不算变动', async () => {
    const res = await settle(`<span id="c">0</span><script>
      let n = 0; setInterval(() => { document.getElementById('c').textContent = String(++n); }, 100);
    </script>`);
    assert.equal(res.settled, true);
  });

  test('内容稍后才插进来：等它到位再算就位', async () => {
    const res = await settle(`<div id="r"></div><script>
      setTimeout(() => { document.getElementById('r').innerHTML = '<p>第一条</p><p>第二条</p><p>第三条</p>'; }, 400);
    </script>`);
    assert.equal(res.settled, true);
    assert.equal(res.changes, 3);
    assert.ok(res.waitedMs >= 400 + BUDGET.quietMs - 100, `等了 ${res.waitedMs}ms`);
  });
});
