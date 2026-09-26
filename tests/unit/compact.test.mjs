// core/compact.js —— /compact 命令解析与请求链裁剪（验收标准第 21 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompactCommand, buildCompactState, compactRequestTail } from '../../extension/core/compact.js';
import { setLocale } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

test('整段以 /compact 开头才算命令，大小写不敏感、允许前导空白', () => {
  assert.deepEqual(parseCompactCommand('/compact'), { instruction: '' });
  assert.deepEqual(parseCompactCommand('  /COMPACT 只保留财报数字  '), { instruction: '只保留财报数字' });
  assert.deepEqual(parseCompactCommand('/compact\n第一行\n第二行'), { instruction: '第一行\n第二行' });
});

test('同前缀或不在开头的输入按普通提问发出', () => {
  assert.equal(parseCompactCommand('/compaction'), null);
  assert.equal(parseCompactCommand('请 /compact'), null);
  assert.equal(parseCompactCommand(''), null);
  assert.equal(parseCompactCommand(null), null);
});

test('摘要在压缩那一刻按当前语言包好标签，之后切语言不改写', () => {
  const zh = buildCompactState('  要点一\n要点二  ', 4);
  assert.deepEqual(zh, { summary: '<对话摘要>\n要点一\n要点二\n</对话摘要>', boundary: 4 });
  setLocale('en');
  assert.equal(zh.summary, '<对话摘要>\n要点一\n要点二\n</对话摘要>');
  assert.equal(buildCompactState('x', 1).summary, '<conversation_summary>\nx\n</conversation_summary>');
});

test('boundary 取非负整数', () => {
  assert.equal(buildCompactState('x', -3).boundary, 0);
  assert.equal(buildCompactState('x', 3.7).boundary, 3);
  assert.equal(buildCompactState('x', undefined).boundary, 0);
});

test('未压缩时原样返回请求链的副本', () => {
  const msgs = [{ role: 'user', content: 'a' }];
  const out = compactRequestTail(msgs, null);
  assert.deepEqual(out, msgs);
  assert.notEqual(out, msgs);
});

test('压缩后只带「摘要 + 压缩点之后的新消息」，摘要用 user 角色', () => {
  const msgs = ['m0', 'm1', 'm2', 'm3'].map((content) => ({ role: 'user', content }));
  const out = compactRequestTail(msgs, { summary: 'S', boundary: 2 });
  assert.deepEqual(out.map((m) => m.content), ['S', 'm2', 'm3']);
  assert.equal(out[0].role, 'user');
});

test('boundary 越界时夹到数组范围内', () => {
  const msgs = [{ role: 'user', content: 'a' }];
  assert.deepEqual(compactRequestTail(msgs, { summary: 'S', boundary: 99 }).map((m) => m.content), ['S']);
  assert.deepEqual(compactRequestTail(msgs, { summary: 'S', boundary: -1 }).map((m) => m.content), ['S', 'a']);
});
