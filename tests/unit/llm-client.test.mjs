// core/llm-client.js —— 请求形状、SSE 解析与错误分类（验收标准第 6、9、29、34 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, testConnection, LlmError, isContextOverflow } from '../../extension/core/llm-client.js';
import {
  CONFIG, data, deltaChunk, toolChunk, streamResponse, sseResponse, mockFetch, drain,
} from '../helpers/fake-llm.mjs';

const MSGS = [{ role: 'user', content: 'hi' }];

/* ========== 请求形状 ========== */

test('请求：拼接 /chat/completions、带 Bearer、流式', async (t) => {
  const calls = mockFetch(t, () => sseResponse([data('[DONE]')]));
  await drain(streamChat({ ...CONFIG, baseUrl: 'https://llm.example.test/v1///' }, MSGS));
  assert.equal(calls[0].url, 'https://llm.example.test/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body, { model: 'test-model', messages: MSGS, stream: true });
});

test('请求：没有 Key 不带 Authorization；tools 非空才带；不加 stream_options', async (t) => {
  const calls = mockFetch(t, () => sseResponse([data('[DONE]')]));
  await drain(streamChat({ ...CONFIG, apiKey: '' }, MSGS, { tools: [] }));
  await drain(streamChat(CONFIG, MSGS, { tools: [{ type: 'function' }] }));
  assert.equal('Authorization' in calls[0].init.headers, false);
  assert.equal('tools' in calls[0].body, false);
  assert.deepEqual(calls[1].body.tools, [{ type: 'function' }]);
  assert.equal('stream_options' in calls[1].body, false);
});

test('配置缺 baseUrl 或 model：badconfig，且不发请求', async (t) => {
  const calls = mockFetch(t, () => sseResponse([]));
  for (const cfg of [null, { ...CONFIG, baseUrl: '' }, { ...CONFIG, model: '' }]) {
    const { error } = await drain(streamChat(cfg, MSGS));
    assert.equal(error.kind, 'badconfig');
  }
  assert.equal(calls.length, 0);
});

/* ========== 错误分类 ========== */

test('非 2xx：http 错误带状态码与响应体', async (t) => {
  mockFetch(t, () => new Response('{"error":"invalid key"}', { status: 401 }));
  const { error } = await drain(streamChat(CONFIG, MSGS));
  assert.ok(error instanceof LlmError);
  assert.equal(error.kind, 'http');
  assert.equal(error.status, 401);
  assert.equal(error.detail, '{"error":"invalid key"}');
});

test('fetch 失败为 network，中止为 abort', async (t) => {
  mockFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.equal((await drain(streamChat(CONFIG, MSGS))).error.kind, 'network');
  t.mock.restoreAll();
  mockFetch(t, () => { throw new DOMException('aborted', 'AbortError'); });
  assert.equal((await drain(streamChat(CONFIG, MSGS))).error.kind, 'abort');
});

/* ========== 正文流 ========== */

test('正文增量逐个交出，[DONE] 收尾', async (t) => {
  mockFetch(t, () => sseResponse([data(deltaChunk('你')), data(deltaChunk('好')), data('[DONE]')]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'delta', text: '你' }, { type: 'delta', text: '好' }]);
});

test('只发 finish_reason 不发 [DONE] 也算正常结束', async (t) => {
  mockFetch(t, () => sseResponse([data(deltaChunk('ok', 'stop'))]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'delta', text: 'ok' }]);
});

test('行被切在两个 chunk 之间、CRLF 换行、keep-alive 注释与脏行都能容忍', async (t) => {
  const line = data(deltaChunk('拼接'));
  mockFetch(t, () => streamResponse([
    ': keep-alive\r\n\r\n',
    line.slice(0, 15),
    line.slice(15) + '\r\n\r\n',
    'data: {not json}\n\n',
    'data: [DONE]\n\n',
  ]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'delta', text: '拼接' }]);
});

test('没有结束标记就断流：stream 错误，已收到的增量照常交出', async (t) => {
  mockFetch(t, () => sseResponse([data(deltaChunk('半截'))]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.deepEqual(events, [{ type: 'delta', text: '半截' }]);
  assert.equal(error.kind, 'stream');
});

test('接口在流里报用量时交出 usage 事件（含 choices 为空的收尾块）', async (t) => {
  mockFetch(t, () => sseResponse([
    data(deltaChunk('x', 'stop')),
    data({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } }),
    data('[DONE]'),
  ]));
  const { events } = await drain(streamChat(CONFIG, MSGS));
  // finish_reason 已经到了、没有工具调用时流还在读，收尾块的 usage 不能丢
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', promptTokens: 1234, completionTokens: 5 });
});

/* ========== 工具调用 ========== */

const CALL_FRAGS = [
  data(toolChunk([{ index: 0, id: 'call_1', name: 'click_', arguments: '' }])),
  data(toolChunk([{ index: 0, name: 'element', arguments: '{"ref"' }])),
  data(toolChunk([{ index: 0, arguments: ':12}' }, { index: 1, id: 'call_2', name: 'list_tabs', arguments: '{}' }])),
];
const EXPECTED_CALLS = [
  { id: 'call_1', name: 'click_element', arguments: '{"ref":12}' },
  { id: 'call_2', name: 'list_tabs', arguments: '{}' },
];

test('分片拼装：按 index 聚合，名称与参数累加，finish_reason 时一次交出', async (t) => {
  mockFetch(t, () => sseResponse([...CALL_FRAGS, data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'tool_calls', calls: EXPECTED_CALLS }]);
});

test('网关对工具调用报 stop 也照样交出', async (t) => {
  mockFetch(t, () => sseResponse([...CALL_FRAGS, data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })]));
  const { events } = await drain(streamChat(CONFIG, MSGS));
  assert.deepEqual(events, [{ type: 'tool_calls', calls: EXPECTED_CALLS }]);
});

test('第 29 条 ①：只发 [DONE] 不发 finish_reason', async (t) => {
  mockFetch(t, () => sseResponse([...CALL_FRAGS, data('[DONE]')]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'tool_calls', calls: EXPECTED_CALLS }]);
});

test('第 29 条 ②：最后一行 data: [DONE] 不带换行', async (t) => {
  mockFetch(t, () => streamResponse([CALL_FRAGS.map((l) => l + '\n\n').join('') + 'data: [DONE]']));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'tool_calls', calls: EXPECTED_CALLS }]);
});

test('第 29 条 ③：既无 [DONE] 也无 finish_reason，但参数是完整 JSON', async (t) => {
  mockFetch(t, () => sseResponse(CALL_FRAGS));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error, null);
  assert.deepEqual(events, [{ type: 'tool_calls', calls: EXPECTED_CALLS }]);
});

test('第 29 条 ④：参数截在半截就断流，报 stream 且不交出工具调用', async (t) => {
  mockFetch(t, () => sseResponse([data(toolChunk([{ index: 0, id: 'c', name: 'click_element', arguments: '{"ref":1' }]))]));
  const { events, error } = await drain(streamChat(CONFIG, MSGS));
  assert.equal(error.kind, 'stream');
  assert.equal(events.some((e) => e.type === 'tool_calls'), false);
});

/* ========== 超窗识别 ========== */

test('超窗：400/413/422 且响应体含上下文超限措辞', () => {
  const http = (status, detail) => new LlmError('http', { status, detail });
  for (const detail of [
    '{"error":{"code":"context_length_exceeded"}}',
    "This model's maximum context length is 65536 tokens",
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Input is too long for requested model',
    'Request exceeds the model context window',
  ]) {
    assert.equal(isContextOverflow(http(400, detail)), true, detail);
  }
  assert.equal(isContextOverflow(http(413, 'token limit reached')), true);
  assert.equal(isContextOverflow(http(422, 'too many tokens')), true);
});

test('非超窗：tools 不被支持、状态码不对、非 http 错误', () => {
  assert.equal(isContextOverflow(new LlmError('http', { status: 400, detail: 'tools is not supported' })), false);
  assert.equal(isContextOverflow(new LlmError('http', { status: 500, detail: 'maximum context length' })), false);
  assert.equal(isContextOverflow(new LlmError('stream')), false);
  assert.equal(isContextOverflow(new Error('maximum context length')), false);
});

/* ========== 测试连接 ========== */

test('测试连接：非流式、max_tokens 1', async (t) => {
  const calls = mockFetch(t, () => new Response('{}', { status: 200 }));
  await testConnection(CONFIG);
  assert.deepEqual(calls[0].body, { model: 'test-model', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
});

test('测试连接：404 与断网分别报 http / network', async (t) => {
  mockFetch(t, () => new Response('not found', { status: 404 }));
  await assert.rejects(testConnection(CONFIG), (e) => e.kind === 'http' && e.status === 404);
  t.mock.restoreAll();
  mockFetch(t, () => { throw new TypeError('fetch failed'); });
  await assert.rejects(testConnection(CONFIG), (e) => e.kind === 'network');
  await assert.rejects(testConnection({ baseUrl: '' }), (e) => e.kind === 'badconfig');
});
