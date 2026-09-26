// 约束：双语必须做全，包括发给模型的文案（CONTRIBUTING「双语必须做全」）
//
// ZH / EN 两套目录不导出，这里读 i18n.js 源码、在末尾补一行导出后以 data: URL 加载——
// i18n.js 不 import 任何模块，这样加载与扩展里的行为完全一致，又不必为测试改动扩展代码。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { corePath, EXTENSION_DIR } from '../helpers/core.mjs';
import { PRESET_SKILLS } from '../../extension/core/skills.js';

const source = fs.readFileSync(corePath('i18n.js'), 'utf8');
const { __ZH: ZH, __EN: EN } = await import(
  'data:text/javascript,' + encodeURIComponent(`${source}\nexport { ZH as __ZH, EN as __EN };`)
);
const CATALOGS = { ZH, EN };

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const read = (rel) => fs.readFileSync(new URL(rel, EXTENSION_DIR), 'utf8');

/** 扩展里全部 .js 源文件（外壳 + core） */
function extensionScripts() {
  const core = fs.readdirSync(new URL('core/', EXTENSION_DIR)).filter((f) => f.endsWith('.js')).map((f) => `core/${f}`);
  return ['sidepanel.js', 'background.js', ...core];
}

test('两套目录的 key 完全一致', () => {
  const zh = Object.keys(ZH);
  const en = new Set(Object.keys(EN));
  assert.deepEqual(zh.filter((k) => !en.has(k)), [], '只在 ZH 里有的 key');
  assert.deepEqual([...en].filter((k) => !(k in ZH)), [], '只在 EN 里有的 key');
});

test('同一个 key 在两种语言里的占位符一致', () => {
  const mismatched = Object.keys(ZH).filter((k) => placeholders(ZH[k]).join() !== placeholders(EN[k]).join());
  assert.deepEqual(mismatched, []);
});

test('文案都是非空字符串', () => {
  for (const [name, dict] of Object.entries(CATALOGS)) {
    const bad = Object.entries(dict).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
    assert.deepEqual(bad, [], name);
  }
});

test('代码里以字面量取的 key 都有定义', () => {
  const missing = [];
  for (const file of extensionScripts()) {
    for (const m of read(file).matchAll(/\bt\(\s*['"]([\w.-]+)['"]\s*[,)]/g)) {
      if (!(m[1] in ZH)) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('sidepanel.html 的 data-i18n* 属性引用的 key 都有定义', () => {
  const html = read('sidepanel.html');
  const missing = [...html.matchAll(/data-i18n(?:-[\w]+)?="([^"]+)"/g)].map((m) => m[1]).filter((k) => !(k in ZH));
  assert.deepEqual(missing, []);
});

test('拼接出来的 key 整族齐全：技能、滚动方向、通用活动行', () => {
  const families = [
    ...PRESET_SKILLS.flatMap((s) => ['name', 'desc', 'body', 'toolHint'].map((f) => `skill.${s.id}.${f}`)),
    ...['up', 'down', 'top', 'bottom'].flatMap((d) => [`act.scroll.${d}`, `res.scrolled.${d}`]),
    ...['run', 'done', 'fail'].map((p) => `act.generic.${p}`),
  ];
  assert.deepEqual(families.filter((k) => !(k in ZH)), []);
});

test('manifest 的 _locales 两套 key 一致', () => {
  const en = JSON.parse(read('_locales/en/messages.json'));
  const zh = JSON.parse(read('_locales/zh_CN/messages.json'));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [k, v] of Object.entries({ ...en, ...zh })) assert.ok(v.message, k);
});
