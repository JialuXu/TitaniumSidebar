// core/skills.js —— 预置技能目录与网址建议（验收标准第 19 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_SKILLS, listSkills, getSkill, hostOfUrl, matchSkillsByUrl, suggestSkills, suggestionKey,
} from '../../extension/core/skills.js';

const ids = (list) => list.map((s) => s.id);

test('目录：三个预置技能，listSkills 返回副本', () => {
  assert.deepEqual(ids(listSkills()), ['csv-table', 'fin-report', 'market-brief']);
  assert.notEqual(listSkills(), PRESET_SKILLS);
  assert.equal(getSkill('fin-report').id, 'fin-report');
  assert.equal(getSkill('nope'), null);
});

test('hostOfUrl：小写、去端口；非 http(s) 与非法网址返回空串', () => {
  assert.equal(hostOfUrl('HTTPS://Quote.EastMoney.com:8080/x?y=1'), 'quote.eastmoney.com');
  assert.equal(hostOfUrl('chrome://extensions'), '');
  assert.equal(hostOfUrl('file:///C:/a.html'), '');
  assert.equal(hostOfUrl('not a url'), '');
  assert.equal(hostOfUrl(undefined), '');
});

test('行情页建议「行情解读」，信息披露站点建议「财报分析」', () => {
  assert.deepEqual(ids(matchSkillsByUrl('https://quote.eastmoney.com/sh600000.html')), ['market-brief']);
  assert.deepEqual(ids(matchSkillsByUrl('https://data.eastmoney.com/bbsj/')), ['fin-report']);
  assert.deepEqual(ids(matchSkillsByUrl('http://www.cninfo.com.cn/new/disclosure')), ['fin-report']);
});

test('后缀匹配对齐完整域名段，不误伤同尾的其他域名', () => {
  assert.deepEqual(matchSkillsByUrl('https://fakesse.com.cn/'), []);
  assert.deepEqual(matchSkillsByUrl('https://xueqiu.com.evil.test/'), []);
  assert.deepEqual(ids(matchSkillsByUrl('https://m.xueqiu.com/')), ['market-brief']);
});

test('表格提取没有网址名单，受限页不出建议', () => {
  assert.deepEqual(getSkill('csv-table').urlHosts, []);
  assert.deepEqual(matchSkillsByUrl('chrome://newtab'), []);
  assert.deepEqual(matchSkillsByUrl('https://example.com/'), []);
});

test('第 19 条：建议条按 host + 技能记住关闭，受限页不建议', () => {
  const url = 'https://quote.eastmoney.com/sh600000.html';
  assert.deepEqual(suggestSkills(url), [{ id: 'market-brief', host: 'quote.eastmoney.com' }]);
  const dismissed = new Set([suggestionKey('quote.eastmoney.com', 'market-brief')]);
  assert.deepEqual(suggestSkills(url, dismissed), []);
  // 同一技能换个 host 照常建议
  assert.equal(suggestSkills('https://xueqiu.com/S/SH600000', dismissed).length, 1);
  assert.deepEqual(suggestSkills('chrome://newtab/'), []);
});
