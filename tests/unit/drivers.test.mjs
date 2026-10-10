// extension/drivers/ —— 执行驱动的挑选：没有调试权限的构建恒走合成事件通道（验收标准第 38 条）

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrivers, debuggerAvailable } from '../../extension/drivers/index.js';

afterEach(() => { delete globalThis.chrome; });

const noop = { addListener: () => {} };

test('manifest 没有 debugger 权限（chrome.debugger 不存在）：开关打开也走合成事件通道', () => {
  globalThis.chrome = {};
  assert.equal(debuggerAvailable(), false);
  const drivers = createDrivers(async () => null);
  assert.equal(drivers.cdp, null);
  assert.equal(drivers.pick(true).kind, 'synthetic');
});

test('有调试权限：开关决定走哪条通道', () => {
  globalThis.chrome = { debugger: { onEvent: noop, onDetach: noop } };
  const drivers = createDrivers(async () => null);
  assert.equal(drivers.pick(false).kind, 'synthetic');
  assert.equal(drivers.pick(true).kind, 'cdp');
});

test('调试通道只接管点击、按键、输入，其余动作交给合成事件通道', async () => {
  const calls = [];
  globalThis.chrome = {
    debugger: {
      onEvent: noop, onDetach: noop,
      attach: async () => { calls.push('attach'); },
      detach: async () => {},
      sendCommand: async () => {},
    },
  };
  const drivers = createDrivers(async (tabId, fn, args) => { calls.push(`inject:${args.action}`); return { ok: true }; });
  await drivers.pick(true).act(1, { action: 'scroll', direction: 'down' });
  await drivers.pick(true).act(1, { action: 'select', ref: 2, option: '甲' });
  assert.deepEqual(calls, ['inject:scroll', 'inject:select']);
});
