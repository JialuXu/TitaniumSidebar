// core/key-effect.js —— 调试通道里按键的实际效果（验收标准第 38 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyEffectFromProbes } from '../../extension/core/key-effect.js';

const probe = (extra) => ({ ok: true, active: '描述', field: true, caret: 0, length: 100, fieldTop: 0, areaTop: null, pageTop: 0, ...extra });

test('文本框里光标移动、滚动：报光标位置与文本框滚动量', () => {
  assert.deepEqual(keyEffectFromProbes(probe(), probe({ caret: 40, fieldTop: 120 })),
    { kind: 'caret', moved: true, from: 0, to: 40, px: 120 });
  assert.deepEqual(keyEffectFromProbes(probe({ caret: 100 }), probe({ caret: 100 })),
    { kind: 'caret', moved: false, from: 100, to: 100, px: 0 });
});

test('内容变短：报删掉了几个字', () => {
  assert.deepEqual(keyEffectFromProbes(probe({ caret: 5 }), probe({ caret: 4, length: 99 })),
    { kind: 'delete', moved: true, removed: 1 });
});

test('焦点不在文本框：先看所在区域，再看整页', () => {
  const off = { active: '', field: false, caret: null, length: null, fieldTop: null };
  assert.deepEqual(keyEffectFromProbes(probe({ ...off, areaTop: 0 }), probe({ ...off, areaTop: 40 })),
    { kind: 'scroll', moved: true, where: 'area', px: 40 });
  assert.deepEqual(keyEffectFromProbes(probe(off), probe({ ...off, pageTop: 600 })),
    { kind: 'scroll', moved: true, where: 'page', px: 600 });
  assert.deepEqual(keyEffectFromProbes(probe(off), probe(off)),
    { kind: 'scroll', moved: false, where: 'page', px: 0 });
});

test('焦点换了元素或快照缺失：说不清效果就不说', () => {
  assert.equal(keyEffectFromProbes(probe(), probe({ active: '提交' })), null);
  assert.equal(keyEffectFromProbes(null, probe()), null);
  assert.equal(keyEffectFromProbes(probe(), { ok: false, reason: 'no-body' }), null);
});
