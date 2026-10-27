// core/action-guard.js —— 高风险动作的风险判定与执行前确认（验收标准第 14 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction, guardAction, needsInspect } from '../../extension/core/action-guard.js';
import { setLocale } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

// inspect 结果的底子：点击一个命令类控件
const click = (label, extra = {}) => ({
  ok: true, of: 'click', key: '', via: 'click', name: label, label, command: true, post: false, nearby: [], context: '', print: `p:${label}`, ...extra,
});
const required = (info, o) => classifyAction(info, o).required;
const risks = (info, o) => classifyAction(info, o).risks;

/* ========== 风险判定 ========== */

test('普通按钮不需要确认', () => {
  for (const label of ['下一步', '保存', '登录', '查询', 'Search', 'Next', '编辑', '取消']) {
    assert.equal(required(click(label)), false, label);
  }
});

test('命令名称里的高风险说法：中英文各类别', () => {
  assert.deepEqual(risks(click('删除')), ['delete']);
  assert.deepEqual(risks(click('批量删除')), ['delete']);
  assert.deepEqual(risks(click('Delete')), ['delete']);
  assert.deepEqual(risks(click('立即支付 ¥199.00')), ['pay']);
  assert.deepEqual(risks(click('转账')), ['transfer']);
  assert.deepEqual(risks(click('提交订单')), ['order']);
  assert.deepEqual(risks(click('Place order')), ['order']);
  assert.deepEqual(risks(click('提交审批')), ['approve']);
  assert.deepEqual(risks(click('发送')), ['send']);
  assert.deepEqual(risks(click('Send')), ['send']);
  assert.deepEqual(risks(click('发布')), ['publish']);
  assert.deepEqual(risks(click('Post')), ['publish']);
  assert.deepEqual(risks(click('确认授权')), ['authorize']);
});

test('英文按整词匹配：PayPal、Posts、Repost 不算', () => {
  for (const label of ['PayPal', 'Posts', 'Repost', 'Removed items']) {
    assert.equal(required(click(label)), false, label);
  }
});

test('链接与长名称是内容不是命令：新闻标题里的「发布」、邮件主题里的「支付」不确认', () => {
  assert.equal(required(click('央行发布新规', { command: false })), false);
  assert.equal(required(click('您的支付宝账单已出，请及时查看并完成支付，逾期将影响信用记录哦', { command: true })), false);
});

test('排除词：删除线、支付宝、发验证码；「支付宝支付」仍命中', () => {
  assert.equal(required(click('删除线')), false);
  assert.equal(required(click('支付宝')), false);
  assert.equal(required(click('发送验证码')), false);
  assert.equal(required(click('Send code')), false);
  assert.deepEqual(risks(click('支付宝支付')), ['pay']);
});

test('弱信号单独出现不确认；所在对话框写着高风险或后果时确认', () => {
  assert.equal(required(click('确定')), false);
  assert.equal(required(click('OK')), false);
  assert.deepEqual(risks(click('确 定', { context: '提示 确定要删除这条记录吗？ 取消 确 定' })), ['delete']);
  assert.deepEqual(risks(click('确定', { context: '此操作不可恢复，是否继续？' })), ['consequence']);
  assert.deepEqual(risks(click('Confirm', { context: 'This cannot be undone.' })), ['consequence']);
});

test('对话框语境只抬高弱信号：同一个删除确认框里的「取消」「编辑」不确认', () => {
  const context = '确定要删除这条记录吗？';
  assert.equal(required(click('取消', { context })), false);
  assert.equal(required(click('编辑', { context })), false);
});

test('弱信号提交 post 表单时确认；具名的普通提交（登录、保存）不确认', () => {
  assert.deepEqual(risks(click('提交', { post: true })), ['submit']);
  assert.equal(required(click('登录', { post: true })), false);
  assert.equal(required(click('保存', { post: true })), false);
  assert.equal(required(click('提交', { post: false })), false);
});

test('回车提交表单：按默认提交按钮的名称判定，没有具名按钮时按弱信号算', () => {
  const submit = (label, post) => ({ ...click(label), of: 'key', key: 'Enter', via: 'submit', name: '金额', post });
  assert.deepEqual(risks(submit('确认转账', true)), ['transfer']);
  assert.equal(required(submit('登录', true)), false);
  assert.deepEqual(risks(submit('', true)), ['submit']);
  assert.equal(required(submit('', false)), false);
});

test('回车发出：附近有「发送 / 发布」按钮时确认，消息上的「删除」不算', () => {
  const send = (nearby) => ({ ...click(''), of: 'key', key: 'Enter', via: 'send', command: false, nearby });
  assert.deepEqual(risks(send(['表情', '发送'])), ['send']);
  assert.deepEqual(risks(send(['Post'])), ['publish']);
  assert.equal(required(send(['删除', '撤回', '表情'])), false);
  assert.equal(required(send(['发送验证码'])), false);
  assert.equal(required(send([])), false);
});

test('via 为 none（勾选框上回车、焦点在页面空白处）不按名称判定', () => {
  assert.equal(required({ ...click('删除'), via: 'none', command: false }), false);
});

test('模型声明不可逆时恒确认，与规则命中的类别并列', () => {
  assert.deepEqual(risks(click('垃圾桶'), { declared: true }), ['declared']);
  assert.deepEqual(risks(click('删除'), { declared: true }), ['delete', 'declared']);
});

test('需要预检的动作：点击、回车，以及声明过不可逆的按键', () => {
  assert.equal(needsInspect({ action: 'click', ref: 1 }, false), true);
  assert.equal(needsInspect({ action: 'key', key: 'Enter' }, false), true);
  assert.equal(needsInspect({ action: 'key', key: 'Tab' }, false), false);
  assert.equal(needsInspect({ action: 'key', key: 'Delete' }, true), true);
  for (const action of ['input', 'select', 'scroll']) assert.equal(needsInspect({ action }, true), false, action);
});

/* ========== 门控 ========== */

function gate({ info = click('删除'), answer = true, confirm, inspect, signal, denials = new Set(), payload = { action: 'click', ref: 7 }, declared, step } = {}) {
  const log = { inspected: [], asked: [], executed: [] };
  const run = () => guardAction({
    payload,
    declared,
    inspect: inspect === null ? null : (inspect || (async (p) => { log.inspected.push(p); return info; })),
    confirm: confirm === null ? null : (confirm || (async (request, sig) => { log.asked.push({ request, sig }); return typeof answer === 'function' ? answer() : answer; })),
    execute: async (p) => { log.executed.push(p); return { result: { ok: true }, change: null }; },
    denials,
    signal,
    step,
  });
  return { run, log, denials };
}

test('不需要确认的动作直接执行，载荷原样、不带 expect', async () => {
  const { run, log } = gate({ info: click('下一步') });
  const out = await run();
  assert.equal(out.result.ok, true);
  assert.equal(log.asked.length, 0);
  assert.deepEqual(log.executed, [{ action: 'click', ref: 7 }]);
});

test('输入、选择、滚动不预检，直接执行', async () => {
  for (const payload of [{ action: 'input', ref: 1, text: 'x' }, { action: 'select', ref: 1, option: 'a' }, { action: 'scroll', direction: 'down', pages: 1 }]) {
    const { run, log } = gate({ payload });
    await run();
    assert.equal(log.inspected.length, 0, payload.action);
    assert.equal(log.executed.length, 1, payload.action);
  }
});

test('批准后才执行一次，执行载荷带上预检指纹；确认块文案写明动作、类别与对话框原文', async () => {
  const info = click('确定', { name: '确定', context: '确定要删除这条记录吗？' });
  const { run, log } = gate({ info, step: 3 });
  await run();
  assert.equal(log.asked.length, 1);
  const { request } = log.asked[0];
  assert.equal(request.action, '第 3 步：点击 [7] "确定"');
  assert.equal(request.reason, '可能涉及：删除数据');
  assert.ok(request.details.some((d) => d.includes('确定要删除这条记录吗？')));
  assert.deepEqual(log.executed, [{ action: 'click', ref: 7, expect: info.print }]);
});

test('拒绝时 execute 零调用，同一回合再请求同一个动作直接拒绝、不再弹窗', async () => {
  const denials = new Set();
  const first = gate({ answer: false, denials });
  const out = await first.run();
  assert.deepEqual(out, { result: { ok: false, reason: 'denied' }, change: null });
  assert.equal(first.log.executed.length, 0);

  const again = gate({ answer: true, denials });
  assert.equal((await again.run()).result.reason, 'denied');
  assert.equal(again.log.asked.length, 0);
  assert.equal(again.log.executed.length, 0);
});

test('拒绝只记那一个动作：别的目标仍要单独确认；批准不缓存', async () => {
  const denials = new Set();
  await gate({ answer: false, denials }).run();
  const other = gate({ info: click('删除', { print: 'p:另一行' }), answer: true, denials });
  await other.run();
  assert.equal(other.log.asked.length, 1);
  assert.equal(other.log.executed.length, 1);

  const twice = gate({ info: click('删除', { print: 'p:另一行' }), answer: true, denials });
  await twice.run();
  assert.equal(twice.log.asked.length, 1, '批准过的同一个动作再来一次仍要确认');
});

test('没有确认渠道、确认抛错时不执行', async () => {
  const none = gate({ confirm: null });
  assert.equal((await none.run()).result.reason, 'unconfirmed');
  assert.equal(none.log.executed.length, 0);

  const broken = gate({ confirm: async () => { throw new Error('boom'); } });
  assert.equal((await broken.run()).result.reason, 'unconfirmed');
  assert.equal(broken.log.executed.length, 0);
});

test('没有预检：点击与回车不执行，输入照常', async () => {
  const blocked = gate({ inspect: null });
  assert.equal((await blocked.run()).result.reason, 'unconfirmed');
  assert.equal(blocked.log.executed.length, 0);
  const typing = gate({ inspect: null, payload: { action: 'input', ref: 1, text: 'x' } });
  await typing.run();
  assert.equal(typing.log.executed.length, 1);
});

test('等待确认期间停止：即使随后点了批准也不执行', async () => {
  const controller = new AbortController();
  const { run, log } = gate({ signal: controller.signal, answer: () => { controller.abort(); return true; } });
  assert.equal((await run()).result.reason, 'aborted');
  assert.equal(log.executed.length, 0);
  assert.equal(log.asked[0].sig, controller.signal, '确认收到本回合的中止信号');
});

test('已中止时不再发起确认', async () => {
  const controller = new AbortController();
  controller.abort();
  const { run, log } = gate({ signal: controller.signal });
  assert.equal((await run()).result.reason, 'aborted');
  assert.equal(log.asked.length, 0);
  assert.equal(log.executed.length, 0);
});

test('预检失败按该失败返回（编号过期、元素不可见），不执行', async () => {
  const { run, log } = gate({ info: { ok: false, reason: 'stale' } });
  assert.deepEqual(await run(), { result: { ok: false, reason: 'stale' }, change: null });
  assert.equal(log.asked.length, 0);
  assert.equal(log.executed.length, 0);
});

test('回车的确认文案写明焦点所在与提交的表单', async () => {
  const info = { ...click('确认转账'), of: 'key', key: 'Enter', via: 'submit', name: '金额', post: true };
  const { run, log } = gate({ info, payload: { action: 'key', key: 'Enter' } });
  await run();
  const { request } = log.asked[0];
  assert.equal(request.action, '按 Enter（「金额」）');
  assert.equal(request.reason, '可能涉及：转账');
  assert.ok(request.details[0].includes('「确认转账」'));
});

test('确认文案随界面语言', async () => {
  setLocale('en');
  const { run, log } = gate({ info: click('Delete') });
  await run();
  assert.equal(log.asked[0].request.reason, 'May involve: deleting data');
});
