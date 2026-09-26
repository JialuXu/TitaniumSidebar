// core/agent.js —— 回合编排与压缩请求（验收标准第 6、8、9、10、15、21、28、34 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentTurn, requestCompaction, requestShape, measureNextRequest, describeError,
} from '../../extension/core/agent.js';
import { MAX_TOOL_ROUNDS, WRITE_TOOL_NAMES } from '../../extension/core/tools.js';
import { LlmError } from '../../extension/core/llm-client.js';
import { initialSentPage } from '../../extension/core/page-sync.js';
import { setLocale, t } from '../../extension/core/i18n.js';
import {
  CONFIG, data, deltaChunk, toolChunk, sseResponse, mockFetch, drain,
} from '../helpers/fake-llm.mjs';

beforeEach(() => setLocale('zh'));

const PROFILE = { ...CONFIG, id: 'p1', visionEnabled: false, contextWindow: 0 };

/* ========== 替身 ========== */

/** 按顺序应答每次请求；应答可以是 Response，也可以是返回 Response 的函数（收到请求体） */
function scripted(ctx, replies) {
  let i = 0;
  return mockFetch(ctx, (url, init) => {
    const r = replies[Math.min(i++, replies.length - 1)];
    return typeof r === 'function' ? r(JSON.parse(init.body)) : r;
  });
}

const text = (s) => sseResponse([data(deltaChunk(s, 'stop')), data('[DONE]')]);
const toolCalls = (...calls) => sseResponse([
  data(toolChunk(calls.map((c, index) => ({ index, id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) })), 'tool_calls')),
  data('[DONE]'),
]);
const httpError = (status, body = '{"error":"bad request"}') => new Response(body, { status });

/** 假 provider：记下每次调用；默认返回值可按测试覆写 */
function fakeProvider(overrides = {}) {
  const calls = [];
  const base = {
    searchInPage: () => ({ ok: true, total: 1, results: [{ start: 10, section: '', snippet: '命中' }] }),
    listElements: () => ({ elements: [] }),
    captureScreenshot: () => ({ dataUrl: 'data:image/png;base64,AAA', markCount: 2, viewport: { w: 800, h: 600 } }),
    act: () => ({ result: { ok: true, name: '提交' }, change: { navigated: false, newElements: [] } }),
    navigate: () => ({ navigated: true, title: '新页', url: 'https://b.test/', stats: { textTotal: 100 } }),
  };
  const provider = { mask: (s) => s };
  for (const [k, fn] of Object.entries({ ...base, ...overrides })) {
    provider[k] = async (arg) => {
      calls.push({ name: k, arg });
      return fn(arg);
    };
  }
  return { provider, calls };
}

const userMsg = (s = '问') => ({ role: 'user', content: s, displayContent: s });

/** 跑一个回合，返回事件与消息数组 */
async function turn(opts = {}) {
  const messages = opts.messages || [userMsg()];
  const { events, error } = await drain(runAgentTurn({
    messages,
    provider: opts.provider || fakeProvider().provider,
    profile: opts.profile || PROFILE,
    actionsEnabled: Boolean(opts.actionsEnabled),
    skillId: null,
    toolsBroken: Boolean(opts.toolsBroken),
    perceivable: () => opts.perceivable !== false,
    compact: null,
    sentPage: initialSentPage(),
    signal: opts.signal,
  }));
  assert.equal(error, null);
  return { events, messages, types: events.map((e) => e.type) };
}

const toolNames = (body) => (body.tools || []).map((d) => d.function.name);

/** tool 链完整：每条 assistant(tool_calls) 之后紧跟等量、按序对应的 tool 消息（不变式 7） */
function assertToolChain(messages) {
  messages.forEach((m, i) => {
    if (!m.tool_calls) return;
    m.tool_calls.forEach((c, k) => {
      const next = messages[i + 1 + k];
      assert.equal(next && next.role, 'tool', `第 ${i + 1 + k} 条应是 tool 消息`);
      assert.equal(next.tool_call_id, c.id);
    });
  });
}

/* ========== 回合 ========== */

test('纯文本回答：请求 → 增量 → 本段结束 → 收尾，只追加一条 assistant', async (ctx) => {
  const fetches = scripted(ctx, [sseResponse([data(deltaChunk('你')), data(deltaChunk('好', 'stop')), data('[DONE]')])]);
  const { types, events, messages } = await turn();
  assert.deepEqual(types, ['request', 'delta', 'delta', 'segment', 'final']);
  assert.equal(events[2].content, '你好'); // delta 带本段累计全文
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: '你好' });
  assert.equal(fetches.length, 1);
  assert.ok(toolNames(fetches[0].body).includes('find_in_page'));
});

test('工具轮：assistant(tool_calls) 与 tool 消息成对回填，活动行文案随消息落库', async (ctx) => {
  const fetches = scripted(ctx, [toolCalls({ id: 'c1', name: 'find_in_page', args: { query: '利润' } }), text('答')]);
  const { provider, calls } = fakeProvider();
  const { types, events, messages } = await turn({ provider });
  assert.deepEqual(types, [
    'request', 'segment', 'tool-round', 'tool-start', 'tool-done', 'next-round',
    'request', 'delta', 'segment', 'final',
  ]);
  assert.deepEqual(calls.map((c) => c.name), ['searchInPage']);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assertToolChain(messages);
  const done = events.find((e) => e.type === 'tool-done');
  assert.equal(done.ok, true);
  assert.deepEqual(messages[2]._ui, { text: done.text, ok: true, action: false });
  // 第二轮请求带着 tool 结果，且 `_` 字段不出网
  const sent = fetches[1].body.messages;
  assert.equal(sent.at(-1).role, 'tool');
  assert.equal(sent.at(-1)._ui, undefined);
});

test('第 28 条：未注册的动作不执行，补占位且不按动作行呈现', async (ctx) => {
  scripted(ctx, [toolCalls({ id: 'c1', name: 'click_element', args: { ref: 3 } }), text('好')]);
  const { provider, calls } = fakeProvider();
  const { events, messages } = await turn({ provider, actionsEnabled: false });
  assert.equal(calls.length, 0);
  assert.equal(messages[2].content, t('res.notRegistered', { name: 'click_element' }));
  const start = events.find((e) => e.type === 'tool-start');
  assert.equal(start.isAction, false);
  assert.equal(events.find((e) => e.type === 'tool-done').ok, false);
});

test('同批跳转中止：跳转之后的调用补占位不执行，tool 链仍完整', async (ctx) => {
  scripted(ctx, [
    toolCalls({ id: 'c1', name: 'navigate', args: { url: 'https://b.test/' } }, { id: 'c2', name: 'click_element', args: { ref: 1 } }),
    text('到了'),
  ]);
  const { provider, calls } = fakeProvider();
  const { events, messages } = await turn({ provider, actionsEnabled: true });
  assert.deepEqual(calls.map((c) => c.name), ['navigate']);
  assertToolChain(messages);
  assert.equal(messages[3].content, t('sys.batchBroken'));
  assert.deepEqual(messages[3]._ui, { text: t('ui.skipNavigated', { name: 'click_element' }), ok: false, action: true });
  // 被跳过的那次同样有一行活动行（先 start 再 done），且算作动作行
  const skipped = events.filter((e) => e.name === 'click_element');
  assert.deepEqual(skipped.map((e) => e.type), ['tool-start', 'tool-done']);
  assert.ok(skipped.every((e) => e.isAction));
  assert.ok(WRITE_TOOL_NAMES.has('navigate') && events.find((e) => e.name === 'navigate').isAction);
});

test('第 8 条：截图跟随消息等整批 tool 消息回填完才追加，回合结束换成占位', async (ctx) => {
  const fetches = scripted(ctx, [
    toolCalls({ id: 'c1', name: 'capture_screenshot' }, { id: 'c2', name: 'find_in_page', args: { query: 'x' } }),
    text('看到了'),
  ]);
  const { events, messages } = await turn({ profile: { ...PROFILE, visionEnabled: true } });
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
  assertToolChain(messages);
  // 第二轮请求里是真图
  const img = fetches[1].body.messages.find((m) => Array.isArray(m.content));
  assert.ok(img.content.some((p) => p.type === 'image_url'));
  // 活动行拿到缩略图地址；回合结束后历史里只剩占位
  assert.equal(events.find((e) => e.type === 'tool-done' && e.name === 'capture_screenshot').image, 'data:image/png;base64,AAA');
  assert.equal(messages[4].content, t('sys.shotOmittedMeta', { w: 800, h: 600, n: 2 }));
});

test('第 9 条：400 先去掉 tools 重试一次，并告知外壳本会话已降级', async (ctx) => {
  const fetches = scripted(ctx, [httpError(400), text('纯文本回答')]);
  const { types, messages } = await turn();
  assert.ok(types.includes('degraded'));
  assert.equal(fetches.length, 2);
  assert.ok(fetches[0].body.tools);
  assert.equal(fetches[1].body.tools, undefined);
  assert.equal(messages.at(-1).content, '纯文本回答');
  assert.equal(messages.at(-1)._error, undefined);
});

test('已降级纯文本时 400 再怀疑图片：去掉历史里的截图重试一次', async (ctx) => {
  const shot = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }], _kind: 'tool-image', _placeholder: '[图]' };
  const fetches = scripted(ctx, [httpError(422), text('好')]);
  const { events, messages } = await turn({ toolsBroken: true, messages: [userMsg(), shot] });
  assert.deepEqual(events.find((e) => e.type === 'degraded'), { type: 'degraded', what: 'images' });
  assert.equal(fetches.length, 2);
  assert.equal(messages[1].content, '[图]');
});

test('超窗的 400 不降级：直接报错，错误文案写在消息上', async (ctx) => {
  const fetches = scripted(ctx, [httpError(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}')]);
  const { types, events, messages } = await turn();
  assert.ok(!types.includes('degraded'));
  assert.equal(fetches.length, 1);
  assert.equal(messages.at(-1)._error, t('err.contextOverflow'));
  assert.equal(events.at(-1).aborted, false);
});

test('第 15 条：工具阶段中止，未执行的调用补占位，空回复不入历史，不再请求', async (ctx) => {
  const controller = new AbortController();
  const fetches = scripted(ctx, [
    toolCalls({ id: 'c1', name: 'find_in_page', args: { query: 'a' } }, { id: 'c2', name: 'find_in_page', args: { query: 'b' } }),
  ]);
  const { provider, calls } = fakeProvider({
    searchInPage: () => { controller.abort(); return { ok: true, total: 0, results: [] }; },
  });
  const { events, messages } = await turn({ provider, signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(fetches.length, 1);
  assertToolChain(messages);
  assert.equal(messages.at(-1).content, t('sys.aborted'));
  assert.deepEqual(events.at(-1), { type: 'final', message: { role: 'assistant', content: '' }, error: null, aborted: true });
});

test('轮数上限：到顶后插一条系统提示，下一轮不带 tools，网关仍返回的调用整批丢弃', async (ctx) => {
  let n = 0;
  const fetches = scripted(ctx, [() => toolCalls({ id: `c${n++}`, name: 'find_in_page', args: { query: 'x' } })]);
  const { messages } = await turn();
  assert.equal(fetches.length, MAX_TOOL_ROUNDS + 1);
  assert.ok(fetches.slice(0, MAX_TOOL_ROUNDS).every((f) => f.body.tools));
  assert.equal(fetches.at(-1).body.tools, undefined);
  assert.ok(messages.some((m) => m._kind === 'tool-limit' && m.content === t('sys.toolLimit')));
  // 最后那批 tool_calls 没进历史，也就不需要补占位
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: '' });
  assertToolChain(messages);
});

test('接口报了用量：得出校准系数', async (ctx) => {
  scripted(ctx, [sseResponse([data(deltaChunk('好', 'stop')), data({ choices: [], usage: { prompt_tokens: 5000 } }), data('[DONE]')])]);
  const { events } = await turn();
  const cal = events.find((e) => e.type === 'calibration');
  assert.ok(cal && cal.ratio > 0);
});

/* ========== 请求形态 ========== */

test('第 10 条：请求形态随开关与页面可读性变化，prompt 能力与 tools 一致', () => {
  const base = { profile: PROFILE, skillId: null, toolsBroken: false };
  const names = (shape) => [...shape.registered];

  const readonly = requestShape({ ...base, actionsEnabled: false, perceivable: true });
  assert.equal(readonly.caps.actions, false);
  assert.ok(!names(readonly).some((n) => WRITE_TOOL_NAMES.has(n)));

  // 页面读不到：只读模式不带 tools；开了页面操作仍带（open_tab 要靠它）
  const blind = requestShape({ ...base, actionsEnabled: false, perceivable: false });
  assert.equal(blind.tools, undefined);
  assert.equal(blind.caps.tools, false);
  assert.ok(names(requestShape({ ...base, actionsEnabled: true, perceivable: false })).includes('open_tab'));

  // 视觉随接口套；降级与轮数到顶都不带 tools
  assert.ok(names(requestShape({ ...base, profile: { ...PROFILE, visionEnabled: true }, perceivable: true })).includes('capture_screenshot'));
  assert.equal(requestShape({ ...base, toolsBroken: true, perceivable: true }).tools, undefined);
  assert.equal(requestShape({ ...base, perceivable: true, withinRounds: false }).caps.vision, false);
});

test('第 34 条：估算下一次请求，窗口取接口套、系数只放大估算值', () => {
  const messages = [userMsg('x'.repeat(7000))];
  const opts = { messages, compact: null, actionsEnabled: false, skillId: null, toolsBroken: false };
  const plain = measureNextRequest({ ...opts, profile: { ...PROFILE, contextWindow: 16000 } });
  assert.equal(plain.window, 16000);
  const doubled = measureNextRequest({ ...opts, profile: { ...PROFILE, contextWindow: 16000 }, ratio: 2 });
  assert.equal(doubled.used, plain.used * 2);
  // 降级纯文本后不再多估一份工具定义
  assert.ok(measureNextRequest({ ...opts, profile: PROFILE, toolsBroken: true }).used < measureNextRequest({ ...opts, profile: PROFILE }).used);
});

/* ========== 压缩上下文 ========== */

const HISTORY = [userMsg('第一问'), { role: 'assistant', content: '第一答' }];

test('第 21 条：压缩请求不带 tools，成功后压缩点落在数组末尾', async (ctx) => {
  const fetches = scripted(ctx, [text('要点')]);
  const seen = [];
  const res = await requestCompaction({ messages: HISTORY, compact: null, profile: PROFILE, onRequest: (m) => seen.push(m) });
  assert.equal(res.ok, true);
  assert.equal(res.compact.boundary, HISTORY.length);
  assert.ok(res.compact.summary.includes('要点'));
  assert.equal(fetches[0].body.tools, undefined);
  assert.equal(seen.length, 1);
});

test('压缩失败一律放弃：返回工具调用、空摘要、超窗、中止各有各的说法', async (ctx) => {
  const run = async (reply, signal) => {
    ctx.mock.restoreAll();
    scripted(ctx, [reply]);
    return requestCompaction({ messages: HISTORY, compact: null, profile: PROFILE, signal });
  };
  assert.equal((await run(toolCalls({ id: 'c', name: 'find_in_page' }))).errorText, t('ui.compactBadReply'));
  assert.equal((await run(text('  '))).errorText, t('ui.compactBadReply'));
  assert.equal((await run(httpError(400, 'prompt is too long'))).errorText, t('err.contextOverflowCompact'));
  const controller = new AbortController();
  controller.abort();
  const aborted = await run(() => { throw new DOMException('aborted', 'AbortError'); }, controller.signal);
  assert.deepEqual([aborted.ok, aborted.aborted, aborted.errorText], [false, true, '']);
});

/* ========== 错误文案 ========== */

test('第 6 条：错误映射成带排查建议的文案', () => {
  assert.equal(describeError(new LlmError('http', { status: 401 })), t('err.http401'));
  assert.equal(describeError(new LlmError('http', { status: 404 })), t('err.http404'));
  assert.equal(describeError(new LlmError('http', { status: 502 })), t('err.http5xx', { status: 502 }));
  assert.equal(describeError(new LlmError('network')), t('err.network'));
  assert.equal(describeError(new LlmError('http', { status: 400, detail: 'context_length_exceeded' })), t('err.contextOverflow'));
  assert.ok(describeError(new LlmError('http', { status: 418, detail: 'teapot' })).includes('teapot'));
  assert.equal(describeError(new Error('boom')), t('err.unknown', { message: 'boom' }));
});
