// 调试通道（extension/drivers/cdp.js）在真实 Chromium 里的行为（验收标准第 38 条）
//
// chrome.debugger 换成 Playwright 的 CDP 会话：命令原样转发，网络事件原样回传，
// 因此这里的点击、按键、输入都是浏览器眼里的真实输入。没装 Playwright 时整体跳过。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { createSyntheticDriver } from '../../extension/drivers/synthetic.js';
import { createCdpDriver } from '../../extension/drivers/cdp.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, fixture, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();
const TAB = 1;

/** 用 Playwright 的 CDP 会话扮演 chrome.debugger */
function debuggerOver(session) {
  const onEvent = [];
  for (const method of ['Network.requestWillBeSent', 'Network.loadingFinished', 'Network.loadingFailed']) {
    session.on(method, (params) => onEvent.forEach((fn) => fn({ tabId: TAB }, method, params)));
  }
  return {
    attached: 0,
    onEvent: { addListener: (fn) => onEvent.push(fn) },
    onDetach: { addListener: () => {} },
    async attach() { this.attached++; },
    async detach() { this.attached--; },
    sendCommand: (target, method, params) => session.send(method, params),
  };
}

describe('调试通道（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;
  let driver;
  let synthetic;
  let api;
  let session;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
    // 同源页面才能 fetch：整站由路由供给，接口故意慢 1.5 秒
    await page.route('http://titanium.test/**', async (route) => {
      if (route.request().url().endsWith('/api/rows')) {
        await new Promise((r) => setTimeout(r, 1500));
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(['张三', '李四']) });
      }
      return route.fulfill({ contentType: 'text/html', body: fixture('cdp.html') });
    });
    await page.goto('http://titanium.test/');
    const run = (tabId, fn, args) => inject(page, fn, args);
    synthetic = createSyntheticDriver(run);
    api = debuggerOver(await page.context().newCDPSession(page));
    driver = createCdpDriver({ inject: run, fallback: synthetic, debuggerApi: api });
    session = (await inject(page, snapshotPage, { mode: 'full', i18n: injectedStrings() })).session;
  });

  const refFor = (selector) => page.evaluate(
    (sel) => window.__titanium.elements.indexOf(document.querySelector(sel)) + 1, selector);
  const act = (payload) => driver.act(TAB, { ...payload, session, i18n: injectedStrings() });
  const log = () => page.evaluate(() => window.log);

  test('Element 0×0 勾选框：真实点击落在 label 上，change 事件是可信的', async () => {
    const res = await act({ action: 'click', ref: await refFor('#el-row input') });
    assert.equal(res.ok, true);
    assert.equal(res.channel, 'cdp');
    assert.deepEqual(await log(), ['row:true:true']);
  });

  test('中心点落在卡片里的「删除」按钮上：不发真实点击，退回合成事件点卡片本身', async () => {
    const res = await act({ action: 'click', ref: await refFor('#card') });
    assert.equal(res.ok, true);
    assert.equal(res.fallback, 'unsafe-point');
    assert.deepEqual(await log(), ['card']);
  });

  test('文本框里的 PageDown 由浏览器自己执行：光标与滚动都动了；到底再按如实报没动', async () => {
    await page.evaluate(() => { const t = document.getElementById('long'); t.focus(); t.setSelectionRange(0, 0); t.scrollTop = 0; });
    const res = await act({ action: 'key', key: 'PageDown', ref: await refFor('#long') });
    assert.equal(res.channel, 'cdp');
    assert.equal(res.effect.kind, 'caret');
    assert.equal(res.effect.moved, true);
    assert.ok(res.effect.px > 0, JSON.stringify(res.effect));
    await page.evaluate(() => { const t = document.getElementById('long'); t.setSelectionRange(t.value.length, t.value.length); t.scrollTop = t.scrollHeight; });
    assert.equal((await act({ action: 'key', key: 'PageDown', ref: await refFor('#long') })).effect.moved, false);
  });

  test('输入：整体替换原值，input 事件是可信的', async () => {
    const res = await act({ action: 'input', ref: await refFor('#name'), text: '新值' });
    assert.equal(res.ok, true);
    assert.equal(res.value, '新值');
    assert.equal(await page.evaluate(() => document.getElementById('name').value), '新值');
    assert.ok((await log()).includes('input:新值:true'));
  });

  test('点「查询」后等到接口返回、结果行画出来才算就位', async () => {
    await act({ action: 'click', ref: await refFor('#query') });
    const settled = await driver.settle(TAB, { quietMs: 300, maxMs: 5000 });
    assert.equal(settled.settled, true);
    assert.equal(settled.requests, 0);
    assert.ok(settled.waitedMs >= 1000, `等了 ${settled.waitedMs}ms`);
    assert.equal(await page.evaluate(() => document.getElementById('result').textContent), '张三李四');
  });

  test('接口超过等待上限：如实报还有请求没返回', async () => {
    await act({ action: 'click', ref: await refFor('#query') });
    const res = await driver.settle(TAB, { quietMs: 300, maxMs: 800 });
    assert.equal(res.settled, false);
    assert.equal(res.requests, 1);
  });

  test('回合结束断开附加；附加失败时退回合成事件', async () => {
    await act({ action: 'click', ref: await refFor('#el-row input') });
    assert.equal(api.attached, 1);
    await driver.release();
    assert.equal(api.attached, 0);
    api.attach = async () => { throw new Error('Cannot attach'); };
    const res = await act({ action: 'click', ref: await refFor('#el-row input') });
    assert.equal(res.ok, true);
    assert.equal(res.fallback, 'unavailable');
  });
});
