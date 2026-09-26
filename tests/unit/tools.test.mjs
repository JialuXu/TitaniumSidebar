// core/tools.js —— 工具定义与分发（验收标准第 4、7、10、24、26、28 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolDefs, dispatchToolCall, WRITE_TOOL_NAMES, MAX_TOOL_ROUNDS, MAX_ACTION_ROUNDS, MAX_WAIT_SECONDS,
} from '../../extension/core/tools.js';
import { BUDGETS } from '../../extension/core/format.js';
import { maskSensitive } from '../../extension/core/masker.js';
import { setLocale, t } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

const PERCEPTION = ['find_in_page', 'read_page_text', 'list_elements', 'highlight_element', 'extract_table', 'get_element_html', 'wait_for_page'];
const names = (defs) => defs.map((d) => d.function.name);
const registeredFor = (caps) => new Set(names(buildToolDefs(caps)));
const call = (name, args, id = 'call_1') => ({ id, name, arguments: args === undefined ? '' : JSON.stringify(args) });

/**
 * 假 provider：每个方法记下调用参数；默认返回值可按测试覆写。
 * mask 用真实的脱敏函数，验证工具结果统一过脱敏。
 */
function fakeProvider(overrides = {}) {
  const calls = [];
  const record = (name, value) => async (arg) => {
    calls.push({ name, arg });
    return typeof value === 'function' ? value(arg) : value;
  };
  const base = {
    searchInPage: { ok: true, total: 0, results: [] },
    readPageText: ({ offset, length }) => ({ ok: true, text: 'x'.repeat(length), start: offset, end: offset + length, total: 50000, url: 'https://a.test/' }),
    listElements: { elements: [], total: 0 },
    highlight: { ok: true, name: '提交' },
    captureScreenshot: { dataUrl: 'data:image/png;base64,', markCount: 3, viewport: { w: 800, h: 600 } },
    waitForPage: { navigated: false, newElements: [], waitedMs: 2000, loading: null },
    act: { result: { ok: true, name: '提交' }, change: { navigated: false, newElements: [] } },
    navigate: { navigated: true, title: '新页', url: 'https://b.test/', stats: { textTotal: 777 } },
    listTabs: [],
  };
  const provider = { mask: (s) => maskSensitive(s).text };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) provider[k] = record(k, v);
  return { provider, calls };
}

/* ========== 工具定义 ========== */

test('第 10 条：缺省只注册只读的感知工具', () => {
  assert.deepEqual(names(buildToolDefs()), PERCEPTION);
});

test('视觉与页面操作各自加一组', () => {
  assert.deepEqual(names(buildToolDefs({ vision: true })), [...PERCEPTION, 'capture_screenshot']);
  const withActions = names(buildToolDefs({ actions: true }));
  for (const w of WRITE_TOOL_NAMES) assert.ok(withActions.includes(w), w);
  assert.ok(withActions.includes('scroll_page') && withActions.includes('list_tabs'));
});

test('有副作用的工具都在动作组里，感知组一个都没有', () => {
  for (const w of WRITE_TOOL_NAMES) assert.ok(!PERCEPTION.includes(w), w);
});

test('工具定义符合 OpenAI 协议形状，必填参数都声明过', () => {
  for (const def of buildToolDefs({ vision: true, actions: true })) {
    assert.equal(def.type, 'function');
    assert.equal(def.function.parameters.type, 'object');
    assert.ok(def.function.description, def.function.name);
    for (const r of def.function.parameters.required || []) {
      assert.ok(r in def.function.parameters.properties, `${def.function.name}.${r}`);
    }
  }
});

test('轮数上限：纯感知 5 轮、开启操作 15 轮；等待上限 15 秒', () => {
  assert.equal(MAX_TOOL_ROUNDS, 5);
  assert.equal(MAX_ACTION_ROUNDS, 15);
  assert.equal(MAX_WAIT_SECONDS, 15);
});

/* ========== 分发：闸门 ========== */

test('第 28 条：未注册的工具不执行，provider 一次都不调', async () => {
  const { provider, calls } = fakeProvider();
  const res = await dispatchToolCall(call('click_element', { ref: 1 }), provider, {}, registeredFor({}));
  assert.equal(calls.length, 0);
  assert.equal(res.meta.ok, false);
  assert.equal(res.meta.data.reason, 'not-registered');
  assert.equal(res.toolMessage.content, t('res.notRegistered', { name: 'click_element' }));
  assert.equal(res.toolMessage.tool_call_id, 'call_1');
});

test('缺省视为什么都没注册', async () => {
  const { provider, calls } = fakeProvider();
  const res = await dispatchToolCall(call('find_in_page', { query: 'x' }), provider);
  assert.equal(res.meta.data.reason, 'not-registered');
  assert.equal(calls.length, 0);
});

test('参数不是合法 JSON：把错误还给模型', async () => {
  const { provider } = fakeProvider();
  const res = await dispatchToolCall({ id: 'c', name: 'find_in_page', arguments: '{"query":' }, provider, {}, registeredFor({}));
  assert.equal(res.toolMessage.content, t('res.badJson'));
});

test('provider 抛错：错误文案直接作为工具结果', async () => {
  const { provider } = fakeProvider({ searchInPage: () => { throw new Error('标签页已切换'); } });
  const res = await dispatchToolCall(call('find_in_page', { query: 'x' }), provider, {}, registeredFor({}));
  assert.equal(res.toolMessage.content, '标签页已切换');
});

/* ========== 分发：感知 ========== */

test('find_in_page：空查询不调 provider；结果统一过脱敏（第 4 条）', async () => {
  const { provider, calls } = fakeProvider({
    searchInPage: { ok: true, total: 1, results: [{ index: 5, snippet: '联系 13812345678', section: '' }] },
  });
  const empty = await dispatchToolCall(call('find_in_page', { query: '  ' }), provider, {}, registeredFor({}));
  assert.equal(empty.toolMessage.content, t('res.missingQuery'));
  assert.equal(calls.length, 0);

  const res = await dispatchToolCall(call('find_in_page', { query: '联系' }), provider, {}, registeredFor({}));
  assert.ok(res.toolMessage.content.includes('1**********'));
  assert.ok(!res.toolMessage.content.includes('13812345678'));
  assert.deepEqual(res.meta.data, { query: '联系', total: 1 });
});

test('read_page_text：长度夹到单次上限，结果带 _read 标记并记账', async () => {
  const { provider, calls } = fakeProvider();
  const turn = { url: 'https://a.test/', textTotal: 50000 };
  const res = await dispatchToolCall(call('read_page_text', { offset: 12000, length: 99999 }), provider, turn, registeredFor({}));
  assert.deepEqual(calls[0].arg, { offset: 12000, length: BUDGETS.readMax });
  assert.deepEqual(res.toolMessage._read, { start: 12000, end: 12000 + BUDGETS.readMax, url: 'https://a.test/' });
  assert.equal(turn.readChars, BUDGETS.readMax);
  assert.ok(!res.toolMessage.content.startsWith(t('res.readStale')));
});

test('read_page_text：每回合读取总量到顶后拒绝，不再调 provider', async () => {
  const { provider, calls } = fakeProvider();
  const res = await dispatchToolCall(call('read_page_text', { offset: 0 }), provider, { readChars: BUDGETS.readPerTurn - 500 }, registeredFor({}));
  assert.equal(res.toolMessage.content, t('res.readBudget'));
  assert.equal(calls.length, 0);
});

test('read_page_text：剩余额度不足单次长度时只读剩下的', async () => {
  const { provider, calls } = fakeProvider();
  await dispatchToolCall(call('read_page_text', { offset: 0, length: 6000 }), provider, { readChars: BUDGETS.readPerTurn - 2000 }, registeredFor({}));
  assert.equal(calls[0].arg.length, 2000);
});

test('第 24 条：页面长度与模型手里那份对不上时，结果首行告警位置可能偏移', async () => {
  const { provider } = fakeProvider();
  const res = await dispatchToolCall(call('read_page_text', { offset: 0 }), provider, { url: 'https://a.test/', textTotal: 40000 }, registeredFor({}));
  assert.ok(res.toolMessage.content.startsWith(t('res.readStale')));
});

test('wait_for_page：秒数夹在 1–15，缺省 3', async () => {
  const { provider, calls } = fakeProvider();
  const reg = registeredFor({});
  await dispatchToolCall(call('wait_for_page', {}), provider, {}, reg);
  await dispatchToolCall(call('wait_for_page', { seconds: 99 }), provider, {}, reg);
  await dispatchToolCall(call('wait_for_page', { seconds: 0 }), provider, {}, reg);
  assert.deepEqual(calls.map((c) => c.arg.seconds), [3, MAX_WAIT_SECONDS, 3]);
});

test('capture_screenshot：tool 消息之后紧跟一条多模态 user 消息', async () => {
  const { provider } = fakeProvider();
  const res = await dispatchToolCall(call('capture_screenshot'), provider, {}, registeredFor({ vision: true }));
  assert.equal(res.followUpMessage.role, 'user');
  assert.equal(res.followUpMessage._kind, 'tool-image');
  assert.equal(res.followUpMessage.content[1].type, 'image_url');
});

/* ========== 分发：动作 ========== */

test('click_element：成功时拼结果与页面变化', async () => {
  const { provider, calls } = fakeProvider();
  const res = await dispatchToolCall(call('click_element', { ref: 12 }), provider, {}, registeredFor({ actions: true }));
  assert.deepEqual(calls[0].arg, { action: 'click', ref: 12 });
  assert.equal(res.meta.ok, true);
  assert.deepEqual(res.meta.data, { ref: 12, navigated: false, name: '提交' });
  assert.ok(res.toolMessage.content.includes(t('fmt.chgNoNew')));
});

test('click_element：失败原因映射成可读文案', async () => {
  const { provider } = fakeProvider({ act: { result: { ok: false, reason: 'gone' }, change: null } });
  const res = await dispatchToolCall(call('click_element', { ref: 3 }), provider, {}, registeredFor({ actions: true }));
  assert.equal(res.meta.ok, false);
  assert.equal(res.meta.data.reason, 'gone');
  assert.equal(res.toolMessage.content, t('fail.gone', { ref: 3 }));
});

test('跳转后把本回合的页面基准同步到新页，后续读取不误报偏移', async () => {
  const { provider } = fakeProvider({
    readPageText: ({ offset, length }) => ({ ok: true, text: 'y', start: offset, end: offset + 1, total: 777, url: 'https://b.test/' }),
  });
  const reg = registeredFor({ actions: true });
  const turn = { url: 'https://a.test/', textTotal: 50000 };
  await dispatchToolCall(call('navigate', { url: 'https://b.test/' }), provider, turn, reg);
  assert.equal(turn.url, 'https://b.test/');
  assert.equal(turn.textTotal, 777);
  const res = await dispatchToolCall(call('read_page_text', { offset: 0 }), provider, turn, reg);
  assert.ok(!res.toolMessage.content.startsWith(t('res.readStale')));
});

test('English 下工具结果也是英文', async () => {
  setLocale('en');
  const { provider } = fakeProvider();
  const res = await dispatchToolCall(call('click_element', { ref: 1 }), provider, {}, registeredFor({}));
  assert.equal(res.toolMessage.content, t('res.notRegistered', { name: 'click_element' }));
  assert.ok(!/[一-鿿]/.test(res.toolMessage.content));
});

/* ========== 过滤与网址校验（从外壳下沉） ========== */

test('list_elements：范围与关键词在这里过滤，名称或行锚点命中都算', async () => {
  const elements = [
    { ref: 1, role: 'checkbox', name: '', context: 'Cursor Team 周报', inViewport: true },
    { ref: 2, role: 'button', name: '删除', context: 'Cursor Team 周报', inViewport: false },
    { ref: 3, role: 'link', name: '设置', inViewport: true },
  ];
  const { provider } = fakeProvider({ listElements: { elements } });
  const reg = registeredFor({});
  const viewport = await dispatchToolCall(call('list_elements', { scope: 'viewport' }), provider, {}, reg);
  assert.deepEqual([viewport.meta.data.count, viewport.meta.data.total], [2, 2]);
  const q = await dispatchToolCall(call('list_elements', { scope: 'page', query: 'cursor team' }), provider, {}, reg);
  assert.equal(q.meta.data.count, 2);
  assert.ok(q.toolMessage.content.includes('[1]') && q.toolMessage.content.includes('[2]'));
  assert.ok(!q.toolMessage.content.includes('[3]'));
});

test('第 13 条：navigate / open_tab 只放行 http/https，别的网址不交给 provider', async () => {
  const { provider, calls } = fakeProvider();
  const reg = registeredFor({ actions: true });
  for (const name of ['navigate', 'open_tab']) {
    const res = await dispatchToolCall(call(name, { url: 'javascript:alert(1)' }), provider, {}, reg);
    assert.equal(res.meta.ok, false);
    assert.equal(res.toolMessage.content, t('sys.badUrl'));
  }
  assert.equal(calls.length, 0);
  await dispatchToolCall(call('navigate', { url: ' https://b.test/ ' }), provider, {}, reg);
  assert.deepEqual(calls[0], { name: 'navigate', arg: { url: 'https://b.test/' } });
});
