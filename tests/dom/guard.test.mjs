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
