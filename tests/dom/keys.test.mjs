// 合成按键的默认行为补偿与输入框当前值的读取（验收标准第 37 条）
//
// 合成键盘事件只派发事件、不触发浏览器默认动作：这里验证 performAction 按键语义补上的那部分，
// 以及补偿结果如实回报（移了多少、滚了多少、什么都没变）。没装 Playwright 时整体跳过。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { performAction } from '../../extension/core/actions.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, fixture, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

describe('按键补偿（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;
  let session;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
    await page.setContent(fixture('keys.html'));
    session = (await inject(page, snapshotPage, { mode: 'full', i18n: injectedStrings() })).session;
  });

  const refFor = (selector) => page.evaluate(
    (sel) => window.__titanium.elements.indexOf(document.querySelector(sel)) + 1, selector);
  const key = (k, ref) => inject(page, performAction, {
    action: 'key', key: k, session, i18n: injectedStrings(), ...(ref ? { ref } : {}),
  });
  const caretAt = (selector, pos) => page.evaluate(([sel, p]) => {
    const el = document.querySelector(sel);
    el.focus();
    el.setSelectionRange(p, p);
  }, [selector, pos]);
  const field = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { caret: el.selectionStart, scrollTop: el.scrollTop, value: el.value };
  }, selector);

  test('文本框 PageDown / PageUp 滚动文本框本身', async () => {
    const ref = await refFor('#wrap');
    const down = await key('PageDown', ref);
    assert.equal(down.effect.kind, 'scroll');
    assert.equal(down.effect.where, 'field');
    assert.ok(down.effect.px > 0);
    assert.equal((await field('#wrap')).scrollTop, down.effect.px);
    const up = await key('PageUp', ref);
    assert.equal(up.effect.px, -down.effect.px);
  });

  test('多行文本框：Home / End 到本行首尾，上下方向键按行移动并保持列', async () => {
    const ref = await refFor('#lines');
    await caretAt('#lines', 5); // 「第二行比较长」的第 2 个字后面
    assert.deepEqual((await key('End', ref)).effect, { kind: 'caret', moved: true, from: 5, to: 10, px: 0 });
    assert.deepEqual((await key('Home', ref)).effect, { kind: 'caret', moved: true, from: 10, to: 4, px: 0 });
    await caretAt('#lines', 6);
    assert.equal((await key('ArrowDown', ref)).effect.to, 12); // 下一行「三」只有一个字，落到行尾
    assert.equal((await key('ArrowUp', ref)).effect.to, 5);
    assert.equal((await key('ArrowUp', ref)).effect.to, 1);
    assert.equal((await key('ArrowUp', ref)).effect.to, 0); // 首行再往上到开头
  });

  test('长段落里光标移到末尾时，文本框跟着滚到光标所在行', async () => {
    const ref = await refFor('#wrap');
    await caretAt('#wrap', 0);
    const res = await key('ArrowDown', ref); // 第一行是整段长文本，往下一行就到「末段」
    assert.equal(res.effect.moved, true);
    const after = await field('#wrap');
    assert.equal(after.caret, after.value.indexOf('末段'));
    assert.ok(after.scrollTop > 0, '光标所在行滚进了可见范围');
  });

  test('光标已在开头、文本框被翻到下面时按 Home：滚回顶部，算有变化', async () => {
    const ref = await refFor('#wrap');
    await caretAt('#wrap', 0);
    await key('PageDown', ref);
    await key('PageDown', ref);
    assert.ok((await field('#wrap')).scrollTop > 0);
    const res = await key('Home', ref);
    assert.equal(res.effect.moved, true);
    assert.equal(res.effect.to, 0);
    assert.ok(res.effect.px < 0);
    assert.equal((await field('#wrap')).scrollTop, 0);
    // 已在顶部再按一次：光标与滚动都不变
    assert.deepEqual((await key('Home', ref)).effect, { kind: 'caret', moved: false, from: 0, to: 0, px: 0 });
  });

  test('单行输入框：Home / End / 左右方向键移光标', async () => {
    const ref = await refFor('#one');
    await caretAt('#one', 3);
    assert.equal((await key('Home', ref)).effect.to, 0);
    assert.equal((await key('ArrowRight', ref)).effect.to, 1);
    assert.equal((await key('End', ref)).effect.to, 6);
    assert.equal((await key('ArrowLeft', ref)).effect.to, 5);
  });

  test('Backspace / Delete 真的删字，并触发 input 事件', async () => {
    const ref = await refFor('#one');
    await caretAt('#one', 3);
    assert.deepEqual((await key('Backspace', ref)).effect, { kind: 'delete', moved: true, removed: 1 });
    assert.deepEqual((await key('Delete', ref)).effect, { kind: 'delete', moved: true, removed: 1 });
    assert.equal((await field('#one')).value, 'abef');
    assert.equal(await page.evaluate(() => window.inputs), 2);
  });

  test('焦点不在可编辑区时，PageDown / End / Home 滚动整页；到顶再按 Home 如实报没动', async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const down = await key('PageDown');
    assert.equal(down.effect.where, 'page');
    assert.ok(down.effect.px > 0);
    assert.ok((await key('End')).effect.px > 0);
    assert.ok((await key('Home')).effect.px < 0);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual((await key('Home')).effect, { kind: 'scroll', moved: false, where: 'page', px: 0 });
  });

  test('可滚动区域：方向键与 PageDown 滚它而不是整页', async () => {
    const ref = await refFor('#area');
    const res = await key('ArrowDown', ref);
    assert.equal(res.effect.where, 'area');
    assert.equal(res.effect.px, 40);
    assert.equal(await page.evaluate(() => scrollY), 0);
  });

  test('富文本编辑区：方向键按视觉行移动光标', async () => {
    const ref = await refFor('#ce');
    await page.evaluate(() => {
      const ce = document.getElementById('ce');
      ce.focus();
      getSelection().collapse(ce.firstChild, 0);
    });
    assert.deepEqual((await key('ArrowDown', ref)).effect, { kind: 'caret', moved: true });
    assert.equal(await page.evaluate(() => getSelection().anchorNode.textContent), '第二行');
  });

  test('页面自己处理的按键不补偿；原生下拉框的键盘行为不模拟', async () => {
    const lb = await key('ArrowDown', await refFor('#lb'));
    assert.equal(lb.prevented, true);
    assert.equal(lb.effect, null);
    assert.equal(await page.evaluate(() => document.getElementById('lb').getAttribute('aria-activedescendant')), 'o2');
    assert.equal((await key('ArrowDown', await refFor('#sel'))).effect, null);
  });

  test('get_html 读输入框与文本框的当前值：改过的内容、超过 80 字的值完整给出，密码打码', async () => {
    await page.evaluate(() => { document.getElementById('lines').value = '已改过的当前值'; });
    const html = (ref) => inject(page, performAction, {
      action: 'get_html', ref, session, maxLen: 4000, i18n: injectedStrings(),
    });
    assert.equal((await html(await refFor('#lines'))).data, '<textarea id="lines">已改过的当前值</textarea>');
    assert.ok((await html(await refFor('#long'))).data.includes(`value="${'长'.repeat(120)}"`));
    const pwd = (await html(await refFor('#pwd'))).data;
    assert.ok(!pwd.includes('secret'));
    assert.ok(pwd.includes(injectedStrings().passwordMasked));
  });
});
