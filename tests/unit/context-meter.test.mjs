// core/context-meter.js —— 上下文用量估算与提醒档位（验收标准第 34 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, calibrationRatio, contextUsage, formatTokens,
  DEFAULT_CONTEXT_WINDOW, CONTEXT_WARN, CONTEXT_HIGH, LEVEL_RANK,
} from '../../extension/core/context-meter.js';

test('拉丁字符按 3.5 个折 1 token，每条消息另加 4 的固定开销', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'abcdefg' }]), 6); // 4 + 7/3.5
});

test('汉字按 0.8 token/字计', () => {
  assert.equal(estimateTokens([{ role: 'user', content: '你好世界你好' }]), Math.round(4 + 6 * 0.8));
});

test('多模态内容：图片按固定量级计，文本部分照常计', () => {
  const n = estimateTokens([{
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:' } }, { type: 'text', text: 'abcdefg' }],
  }]);
  assert.equal(n, 4 + 1000 + 2);
});

test('tool_calls 的名称与参数、tools 定义都计入', () => {
  const base = estimateTokens([{ role: 'assistant', content: '' }]);
  const withCall = estimateTokens([{
    role: 'assistant', content: '',
    tool_calls: [{ id: '1', function: { name: 'x'.repeat(35), arguments: 'y'.repeat(35) } }],
  }]);
  assert.equal(withCall - base, 20);
  const tools = [{ type: 'function', function: { name: 'find_in_page' } }];
  assert.equal(
    estimateTokens([], tools),
    Math.round(JSON.stringify(tools).length / 3.5)
  );
});

test('空输入为 0', () => {
  assert.equal(estimateTokens(), 0);
  assert.equal(estimateTokens([], []), 0);
});

test('校准系数 = 真实用量 / 估算，夹在 [0.25, 4]', () => {
  assert.equal(calibrationRatio(200, 100), 2);
  assert.equal(calibrationRatio(10000, 100), 4);
  assert.equal(calibrationRatio(1, 100), 0.25);
});

test('数据不可用时不给校准系数', () => {
  assert.equal(calibrationRatio(0, 100), null);
  assert.equal(calibrationRatio(100, 0), null);
  assert.equal(calibrationRatio(undefined, 100), null);
  assert.equal(calibrationRatio(NaN, 100), null);
});

test('70% 提醒、85% 催促', () => {
  const win = DEFAULT_CONTEXT_WINDOW;
  assert.equal(contextUsage(win * CONTEXT_WARN - 1).level, 'ok');
  assert.equal(contextUsage(win * CONTEXT_WARN).level, 'warn');
  assert.equal(contextUsage(win * CONTEXT_HIGH).level, 'high');
  assert.deepEqual(contextUsage(44800), { used: 44800, window: 64000, pct: 70, level: 'warn' });
});

test('超过 100% 仍报 high，pct 如实给出', () => {
  const u = contextUsage(20000, { window: 16000 });
  assert.equal(u.level, 'high');
  assert.equal(u.pct, 125);
});

test('按校准系数放大估算；窗口或系数非法时回落缺省', () => {
  assert.equal(contextUsage(1000, { ratio: 2, window: 10000 }).used, 2000);
  assert.equal(contextUsage(1000, { ratio: 0 }).used, 1000);
  assert.equal(contextUsage(1000, { window: 0 }).window, DEFAULT_CONTEXT_WINDOW);
  assert.equal(contextUsage(undefined).used, 0);
});

test('档位先后', () => {
  assert.ok(LEVEL_RANK.ok < LEVEL_RANK.warn && LEVEL_RANK.warn < LEVEL_RANK.high);
});

test('token 数简写', () => {
  assert.equal(formatTokens(12345), '12K');
  assert.equal(formatTokens(1500), '2K');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens(undefined), '0');
});
