// core/prompt.js —— 提示词组装（验收标准第 10、17、18、20、24、30 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildCompactPrompt, buildUserContent, buildPageUpdate } from '../../extension/core/prompt.js';
import { setLocale, t } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

test('纯文本（不带 tools）时不出现任何工具段', () => {
  const p = buildSystemPrompt();
  assert.equal(p, t('prompt.base'));
  assert.ok(!p.includes(t('prompt.tools')));
});

test('第 10 条：带 tools 时按开关拼只读或动作护栏', () => {
  const ro = buildSystemPrompt({ tools: true });
  assert.ok(ro.includes(t('prompt.readonly')));
  assert.ok(!ro.includes(t('prompt.actions')));
  const act = buildSystemPrompt({ tools: true, actions: true });
  assert.ok(act.includes(t('prompt.actions')));
  assert.ok(!act.includes(t('prompt.readonly')));
});

test('视觉指引只在带 tools 时拼', () => {
  assert.ok(buildSystemPrompt({ tools: true, vision: true }).includes(t('prompt.vision')));
  assert.ok(!buildSystemPrompt({ tools: false, vision: true }).includes(t('prompt.vision')));
});

test('第 18、20 条：技能正文恒拼、位于护栏段之前；toolHint 只在带 tools 时拼', () => {
  const withTools = buildSystemPrompt({ tools: true, skill: 'csv-table' });
  const body = t('skill.csv-table.body');
  assert.ok(withTools.indexOf(t('prompt.base')) < withTools.indexOf(body));
  assert.ok(withTools.indexOf(body) < withTools.indexOf(t('prompt.readonly')));
  assert.ok(withTools.includes(t('skill.csv-table.toolHint')));

  const degraded = buildSystemPrompt({ tools: false, skill: 'csv-table' });
  assert.ok(degraded.includes(body));
  assert.ok(!degraded.includes(t('skill.csv-table.toolHint')));
});

test('第 17 条：切到 English 后 system prompt 整段换成英文', () => {
  const zh = buildSystemPrompt({ tools: true });
  setLocale('en');
  const en = buildSystemPrompt({ tools: true });
  assert.notEqual(en, zh);
  assert.ok(!/[一-鿿]/.test(en), '英文 system prompt 里不应出现汉字');
});

test('压缩提示词：带上用户的摘要指示', () => {
  assert.equal(buildCompactPrompt(), t('prompt.compact'));
  assert.ok(buildCompactPrompt('只保留财报数字').includes('只保留财报数字'));
});

test('用户消息：说明语、页面块、字数事实、骨架、问题依次排列', () => {
  const out = buildUserContent('问题', '正文', '- h1', '用户切换了页面', { total: 30000, shown: 12000, capped: false });
  const order = ['用户切换了页面', '<页面内容>\n正文\n</页面内容>', t('prompt.pageTotal', { total: '30000', shown: 12000 }), '<页面结构>\n- h1\n</页面结构>', '问题'];
  let last = -1;
  for (const part of order) {
    const at = out.indexOf(part);
    assert.ok(at > last, `「${part.slice(0, 12)}」的位置不对`);
    last = at;
  }
});

test('第 24 条：字数事实在 <页面内容> 标签之外，且不提工具名', () => {
  const out = buildUserContent('q', '正文', '', '', { total: 30000, shown: 12000 });
  const close = out.indexOf('</页面内容>');
  assert.ok(out.indexOf(t('prompt.pageTotal', { total: '30000', shown: 12000 })) > close);
  assert.ok(!/read_page_text|find_in_page/.test(out));
});

test('第 30 条：没有正文也给页面块并交代一句', () => {
  assert.ok(buildUserContent('q', '', '', '').includes(`<页面内容>\n${t('prompt.pageNoText')}\n</页面内容>`));
});

test('差异块', () => {
  assert.equal(buildPageUpdate('q', '+ 一行'), '<页面更新>\n+ 一行\n</页面更新>\n\nq');
  assert.equal(buildPageUpdate('q', 'd', '仍在加载'), '仍在加载\n\n<页面更新>\nd\n</页面更新>\n\nq');
});
