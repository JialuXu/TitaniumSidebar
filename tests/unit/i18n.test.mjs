// core/i18n.js —— 取词与语言判定（验收标准第 17 条）
//
// 两套文案目录是否对齐由 tests/contracts/i18n-catalog.test.mjs 负责，这里只测取词函数本身。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, getLocale, detectLocale, t, q, injectedStrings, LOCALES, HTML_LANG, LOCALE_LABELS } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

test('setLocale 非法值回落中文', () => {
  assert.equal(setLocale('en'), 'en');
  assert.equal(getLocale(), 'en');
  assert.equal(setLocale('fr'), 'zh');
  assert.equal(setLocale(undefined), 'zh');
});

test('浏览器语言：第一个非空项决定，zh* 为中文，其余英文', () => {
  assert.equal(detectLocale(['zh-CN', 'en']), 'zh');
  assert.equal(detectLocale('zh-TW'), 'zh');
  assert.equal(detectLocale(['en-US', 'zh-CN']), 'en');
  assert.equal(detectLocale(['', 'zh']), 'zh');
  assert.equal(detectLocale([]), 'en');
  assert.equal(detectLocale(undefined), 'en');
});

test('占位符替换；缺参数与 null 替换为空串', () => {
  assert.equal(t('punc.q', { s: 'x' }), '「x」');
  assert.equal(t('punc.q', {}), '「」');
  assert.equal(t('punc.q', { s: null }), '「」');
  assert.equal(t('punc.q', { s: 0 }), '「0」');
});

test('缺词时返回 key 本身，便于暴露漏翻', () => {
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('引号随语言切换', () => {
  assert.equal(q('提交'), '「提交」');
  setLocale('en');
  assert.equal(q('Submit'), '"Submit"');
  assert.equal(q(null), '""');
});

test('注入函数需要的文案两种语言都齐全', () => {
  for (const loc of LOCALES) {
    setLocale(loc);
    for (const [k, v] of Object.entries(injectedStrings())) assert.ok(v && !v.startsWith('inj.'), `${loc}.${k}`);
  }
});

test('每种语言都有 <html lang> 与显示名', () => {
  for (const loc of LOCALES) {
    assert.ok(HTML_LANG[loc]);
    assert.ok(LOCALE_LABELS[loc]);
  }
});
