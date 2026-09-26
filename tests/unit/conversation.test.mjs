// core/conversation.js —— 消息整理与请求链组装（验收标准第 5、8、21、24 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestMessages, buildCompactRequest, trimRetainedReads, stripImagesFromHistory,
} from '../../extension/core/conversation.js';
import { buildSystemPrompt, buildCompactPrompt } from '../../extension/core/prompt.js';
import { setLocale, t } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

const CAPS = { tools: true, vision: false, actions: false, skill: null };

function fullPage(title, text) {
  return { role: 'user', content: `<页面内容>\n${text}\n</页面内容>\n\n问`, displayContent: '问', _page: 'full', _pageTitle: title };
}

test('system prompt 按能力现拼，放在最前', () => {
  const out = buildRequestMessages(CAPS, [{ role: 'user', content: 'hi' }], null);
  assert.deepEqual(out[0], { role: 'system', content: buildSystemPrompt(CAPS) });
});

test('出网形态：剔除界面字段与 `_` 前缀字段，保留 tool_calls / tool_call_id', () => {
  const messages = [
    { role: 'user', content: 'q', displayContent: 'q', _page: 'full' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }], _ui: {} },
    { role: 'tool', content: 'r', tool_call_id: 'c1', _read: { start: 0, end: 1 } },
  ];
  const [, ...rest] = buildRequestMessages(CAPS, messages, null);
  assert.deepEqual(rest, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', content: 'r', tool_call_id: 'c1' },
  ]);
});

test('失败的空回复不进请求', () => {
  const out = buildRequestMessages(CAPS, [{ role: 'user', content: 'q' }, { role: 'assistant', content: '' }], null);
  assert.equal(out.length, 2);
});

test('第 5 条：新全文到来后，更早的页面块压成一行占位，消息条数不变', () => {
  const messages = [
    fullPage('旧页', '旧页全文'),
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: '<页面更新>…', displayContent: '问2', _page: 'diff', _pageTitle: '旧页' },
    { role: 'assistant', content: 'a2' },
    fullPage('新页', '新页全文'),
  ];
  const out = buildRequestMessages(CAPS, messages, null);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].content, `${t('sys.pageSuperseded', { title: '旧页' })}\n\n问`);
  assert.equal(messages[0]._page, undefined);
  assert.equal(messages[2]._page, undefined);
  assert.equal(messages[4]._page, 'full');
  // system prompt 本身会提到标签名，只数对话消息
  const bodies = out.slice(1).map((m) => m.content).join('\n');
  assert.equal(bodies.split('<页面内容>').length - 1, 1, '请求里始终只有一份全文');
  assert.ok(bodies.includes('新页全文'));
});

test('第 24 条：换页后旧页面上读到的正文片段作废', () => {
  const messages = [
    fullPage('旧页', 'x'),
    { role: 'tool', content: '头\n旧正文\n尾', tool_call_id: 'c', _read: { start: 12000, end: 12100 } },
    fullPage('新页', 'y'),
  ];
  buildRequestMessages(CAPS, messages, null);
  assert.equal(messages[1].content, t('sys.readOmitted', { start: 12000, end: 12100 }));
  assert.equal(messages[1]._read, undefined);
});

test('压缩后请求链为「system + 摘要 + 压缩点之后」', () => {
  const messages = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old-a' }, { role: 'user', content: 'new' }];
  const out = buildRequestMessages(CAPS, messages, { summary: '<对话摘要>\nS\n</对话摘要>', boundary: 2 });
  assert.deepEqual(out.slice(1), [{ role: 'user', content: '<对话摘要>\nS\n</对话摘要>' }, { role: 'user', content: 'new' }]);
});

test('压缩请求：用摘要提示词，同样走压缩后的请求链', () => {
  const messages = [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }];
  const out = buildCompactRequest('只保留数字', messages, { summary: 'S', boundary: 1 });
  assert.deepEqual(out[0], { role: 'system', content: buildCompactPrompt('只保留数字') });
  assert.deepEqual(out.slice(1).map((m) => m.content), ['S', 'new']);
});

test('跨回合保留读取：最近一次无条件保留，更早的超预算就压占位', () => {
  const read = (n, start) => ({ role: 'tool', content: 'x'.repeat(n), _read: { start, end: start + n } });
  const messages = [read(500, 0), read(500, 500), read(2000, 1000)];
  trimRetainedReads(messages, 1200);
  assert.equal(messages[2].content.length, 2000, '最近一次即使超预算也保留');
  assert.equal(messages[1]._read, undefined);
  assert.equal(messages[0]._read, undefined);

  const small = [read(300, 0), read(300, 300), read(300, 600)];
  trimRetainedReads(small, 700);
  assert.ok(small[2]._read && small[1]._read);
  assert.equal(small[0].content, t('sys.readOmitted', { start: 0, end: 300 }));
});

test('第 8 条：截图换成占位（含待回填队列），返回是否有替换', () => {
  const img = { role: 'user', content: [{ type: 'image_url' }], _kind: 'tool-image' };
  const pending = [{ role: 'user', content: [{ type: 'image_url' }], _kind: 'tool-image', _placeholder: '[自定义占位]' }];
  assert.equal(stripImagesFromHistory([img, { role: 'user', content: 'x' }], pending), true);
  assert.equal(img.content, t('sys.shotOmitted'));
  assert.equal(pending[0].content, '[自定义占位]');
  assert.equal(stripImagesFromHistory([img]), false);
});
