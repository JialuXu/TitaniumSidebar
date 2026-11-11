// 高风险动作的预检与执行时复验（验收标准第 14 条）
//
// inspect 只读页面：不滚动、不聚焦、不派发事件；报出动作实际触发什么（点击、回车提交、回车发出）、
// 触发控件叫什么、所在对话框或表单写了什么。批准后的执行载荷带 expect，指纹对不上时一个事件都不发。
// 风险判定本身在 core/action-guard.js（tests/unit/action-guard.test.mjs）。没装 Playwright 时整体跳过。

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../../extension/core/snapshot.js';
import { performAction } from '../../extension/core/actions.js';
import { classifyAction } from '../../extension/core/action-guard.js';
import { setLocale, injectedStrings } from '../../extension/core/i18n.js';
import { loadPlaywright, fixture, inject } from '../helpers/browser.mjs';

const playwright = loadPlaywright();

describe('执行前确认的预检（真实 DOM）', { skip: !playwright && '未安装 playwright' }, () => {
  let browser;
  let page;
  let session;

  before(async () => { browser = await playwright.chromium.launch(); });
  after(async () => { if (browser) await browser.close(); });

  beforeEach(async () => {
    setLocale('zh');
    if (page) await page.close();
    page = await browser.newPage();
    await page.setContent(fixture('guard.html'));
    session = (await inject(page, snapshotPage, { mode: 'full', i18n: injectedStrings() })).session;
  });

  const refFor = (id) => page.evaluate(`window.__titanium.elements.indexOf(document.getElementById(${JSON.stringify(id)})) + 1`);
  const run = (payload) => inject(page, performAction, { session, i18n: injectedStrings(), ...payload });
  const inspectClick = async (id) => run({ action: 'inspect', of: 'click', ref: await refFor(id) });
  const inspectEnter = async (id) => run({ action: 'inspect', of: 'key', key: 'Enter', ...(id ? { ref: await refFor(id) } : {}) });
  const events = () => page.evaluate('window.__events.splice(0)');
  const pageState = () => page.evaluate('({ y: window.scrollY, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })');

  test('预检不滚动、不聚焦、不派发事件', async () => {
    await events();
    const before = await pageState();
    const info = await inspectClick('far');
    assert.equal(info.ok, true);
    assert.equal(info.via, 'click');
    assert.equal(info.label, '删除');
    assert.deepEqual(await pageState(), before, '视口外的按钮也不滚过去');
    assert.deepEqual(await events(), []);
    await inspectEnter('amount');
    assert.deepEqual(await pageState(), before, '按 ref 预检回车不聚焦输入框');
    assert.deepEqual(await events(), []);
  });

  test('对话框里的「确 定」：带上对话框正文，判定为删除', async () => {
    const info = await inspectClick('ok');
    assert.equal(info.label, '确 定');
    assert.ok(info.context.includes('确定要删除这条记录吗？'));
    assert.deepEqual(classifyAction(info).risks, ['delete']);
    assert.equal(classifyAction(await inspectClick('cancel')).required, false);
  });

  test('post 表单的提交按钮：post 为真，语境取表单标题；input[type=submit] 的名称取 value', async () => {
    const submit = await inspectClick('submit');
    assert.equal(submit.post, true);
    assert.equal(submit.context, '报销申请');
    assert.deepEqual(classifyAction(submit).risks, ['submit']);
    const pay = await inspectClick('pay');
    assert.equal(pay.label, '立即支付');
    assert.equal(pay.post, true);
    assert.deepEqual(classifyAction(pay).risks, ['pay']);
  });

  test('输入框里回车提交表单：触发控件是默认提交按钮', async () => {
    const info = await inspectEnter('amount');
    assert.equal(info.via, 'submit');
    assert.equal(info.name, '金额');
    assert.equal(info.label, '提交');
    assert.equal(info.post, true);
    const search = await inspectEnter('q');
    assert.equal(search.via, 'submit');
    assert.equal(search.post, false);
    assert.equal(classifyAction(search).required, false);
  });

  test('聊天框里回车：报出附近按钮，名称取占位而不是草稿内容', async () => {
    const info = await inspectEnter('chat');
    assert.equal(info.via, 'send');
    assert.equal(info.name, '输入消息');
    assert.deepEqual(info.nearby, ['表情', '发送']);
    assert.ok(!info.print.includes('草稿内容'));
    assert.deepEqual(classifyAction(info).risks, ['send']);
  });

  test('回车提交与浏览器一致：点默认提交按钮，按钮上的 formmethod 与预检同一判定', async () => {
    const info = await inspectEnter('code');
    assert.equal(info.via, 'submit');
    assert.equal(info.label, '提交');
    assert.equal(info.post, false);
    await events();
    const res = await run({ action: 'key', key: 'Enter', ref: await refFor('code') });
    assert.equal(res.submitted, true);
    assert.deepEqual((await events()).filter((e) => /^(click|submit):/.test(e)), ['click:lookup-go', 'submit:lookup-go']);
    // 焦点在另一个提交按钮上：点的是它本身，与预检一致
    assert.equal((await inspectEnter('lookup-alt')).label, '另存');
    await run({ action: 'key', key: 'Enter', ref: await refFor('lookup-alt') });
    assert.deepEqual((await events()).filter((e) => /^(click|submit):/.test(e)), ['click:lookup-alt', 'submit:lookup-alt']);
  });

  test('表单外的搜索框里回车不算发出', async () => {
    const info = await inspectEnter('find');
    assert.equal(info.via, 'none');
    assert.equal(classifyAction(info).required, false);
  });

  test('不带 ref 的回车读真实焦点：焦点在按钮上等于点击它', async () => {
    await page.evaluate("document.getElementById('send').focus()");
    const info = await inspectEnter(null);
    assert.equal(info.via, 'click');
    assert.equal(info.label, '发送');
  });

  test('不带编号的回车：预检报出焦点元素的编号，名称、语境与指纹相同的两个输入框也能区分', async () => {
    await page.evaluate(() => {
      const box = document.getElementById('composer');
      for (const id of ['extra-a', 'extra-b']) {
        const input = document.createElement('input');
        input.id = id;
        input.placeholder = '消息';
        box.appendChild(input);
      }
    });
    session = (await inject(page, snapshotPage, { mode: 'full', i18n: injectedStrings() })).session;
    await page.evaluate("document.getElementById('extra-a').focus()");
    const first = await inspectEnter(null);
    await page.evaluate("document.getElementById('extra-b').focus()");
    const second = await inspectEnter(null);
    assert.equal(first.print, second.print);
    assert.equal(first.targetRef, await refFor('extra-a'));
    assert.equal(second.targetRef, await refFor('extra-b'));
  });

  test('带真实地址的链接与勾选框不是命令，# 链接是', async () => {
    assert.equal((await inspectClick('news')).command, false);
    assert.equal((await inspectClick('agree')).command, false);
    const del = await inspectClick('del-link');
    assert.equal(del.command, true);
    assert.deepEqual(classifyAction(del).risks, ['delete']);
  });

  test('编号过期时预检与执行同样报 stale', async () => {
    const ref = await refFor('ok');
    assert.deepEqual(await inject(page, performAction, { action: 'inspect', of: 'click', ref, session: 'old' }), { ok: false, reason: 'stale' });
  });

  test('点击：对话框正文在等待确认期间变了，带 expect 执行时一个事件都不发', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.evaluate("document.getElementById('dlg-text').textContent = '确定要删除全部 300 条记录吗？'");
    await events();
    assert.deepEqual(await run({ action: 'click', ref, expect: print }), { ok: false, reason: 'changed' });
    assert.deepEqual(await run({ action: 'locate', ref, expect: print }), { ok: false, reason: 'changed' });
    assert.deepEqual(await events(), []);
    const fresh = await inspectClick('ok');
    const done = await run({ action: 'click', ref, expect: fresh.print });
    assert.equal(done.ok, true);
    assert.ok((await events()).includes('click:ok'));
  });

  test('等待确认期间用户点过、输入过页面：带 expect 执行时不执行，报 touched；重新预检后从头记起', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.click('#amount');
    await page.keyboard.type('5');
    await events();
    assert.deepEqual(await run({ action: 'click', ref, expect: print }), { ok: false, reason: 'touched' });
    assert.deepEqual(await run({ action: 'locate', ref, expect: print }), { ok: false, reason: 'touched' });
    assert.deepEqual(await events(), []);
    const fresh = await inspectClick('ok');
    assert.equal(fresh.print, print, '指纹本身没变：这些操作只有记录拦得住');
    assert.equal((await run({ action: 'click', ref, expect: fresh.print })).ok, true);
  });

  test('页面脚本改值、派发合成事件不算用户操作', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.evaluate(() => {
      const amount = document.getElementById('amount');
      amount.value = '999';
      amount.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      amount.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true }));
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal((await run({ action: 'click', ref, expect: print })).ok, true);
  });

  test('滚动看页面不算操作：滚轮与拖滚动条都照常执行', async () => {
    // 无头浏览器缺省隐藏滚动条，这里单开一个显示滚动条的
    const shown = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const p = await shown.newPage({ viewport: { width: 800, height: 600 } });
      await p.setContent(fixture('guard.html'));
      const s = (await inject(p, snapshotPage, { mode: 'full', i18n: injectedStrings() })).session;
      const ref = await p.evaluate("window.__titanium.elements.indexOf(document.getElementById('ok')) + 1");
      const { print } = await inject(p, performAction, { action: 'inspect', of: 'click', ref, session: s });
      await p.mouse.move(400, 300);
      await p.mouse.wheel(0, 400);
      const half = await p.evaluate('(window.innerWidth - document.documentElement.clientWidth) / 2');
      assert.ok(half > 0, '视口有滚动条');
      await p.mouse.move(800 - half, 300);
      await p.mouse.down();
      await p.mouse.move(800 - half, 350);
      await p.mouse.up();
      const res = await inject(p, performAction, { action: 'click', ref, session: s, expect: print, i18n: injectedStrings() });
      assert.equal(res.ok, true, JSON.stringify(res));
    } finally {
      await shown.close();
    }
  });

  test('同源框架里的用户输入也算', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.frameLocator('#frame').locator('#inner').click();
    assert.deepEqual(await run({ action: 'click', ref, expect: print }), { ok: false, reason: 'touched' });
  });

  test('等待期间新插入的同源框架：上面没挂监听，复验按变了处理', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'late-frame';
      frame.srcdoc = "<input id='late-input' placeholder='备注'>";
      document.body.appendChild(frame);
    });
    await page.frameLocator('#late-frame').locator('#late-input').click();
    assert.deepEqual(await run({ action: 'click', ref, expect: print }), { ok: false, reason: 'changed' });
  });

  test('同源框架等待期间重新加载：新文档上没挂监听，复验按变了处理', async () => {
    const ref = await refFor('ok');
    const { print } = await inspectClick('ok');
    await page.evaluate(() => { document.getElementById('frame').srcdoc = "<input id='renewed-input' placeholder='备注'>"; });
    await page.frameLocator('#frame').locator('#renewed-input').click();
    assert.deepEqual(await run({ action: 'click', ref, expect: print }), { ok: false, reason: 'changed' });
  });

  test('回车：焦点换了一个输入框，带 expect 的按键与按键前的 probe 都不执行', async () => {
    await page.evaluate("document.getElementById('chat').focus()");
    const { print } = await inspectEnter(null);
    await page.evaluate("document.getElementById('amount').focus()");
    await events();
    assert.deepEqual(await run({ action: 'key', key: 'Enter', expect: print }), { ok: false, reason: 'changed' });
    assert.deepEqual(await run({ action: 'probe', key: 'Enter', expect: print }), { ok: false, reason: 'changed' });
    assert.deepEqual(await events(), []);
  });
});
