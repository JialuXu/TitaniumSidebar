// core/activity.js —— 活动行文案（验收标准第 11、27、28 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolActivity } from '../../extension/core/activity.js';
import { buildToolDefs } from '../../extension/core/tools.js';
import { setLocale, t, LOCALES } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

const ALL_TOOLS = buildToolDefs({ vision: true, actions: true }).map((d) => d.function.name);

test('每个工具的三个阶段都有文案，不会露出 act.* 这样的 key', () => {
  for (const loc of LOCALES) {
    setLocale(loc);
    for (const name of ALL_TOOLS) {
      for (const phase of ['run', 'done', 'fail']) {
        const s = describeToolActivity(name, {}, phase, {});
        assert.ok(s && !s.startsWith('act.'), `${loc} ${name} ${phase} → ${s}`);
      }
    }
  }
});

test('第 28 条：未注册的调用显示「未执行」，而不是套用该工具的失败文案', () => {
  assert.equal(
    describeToolActivity('click_element', { ref: 1 }, 'fail', { reason: 'not-registered' }),
    t('act.notRegistered', { name: 'click_element' })
  );
});

test('done 阶段以 meta.data 为准', () => {
  assert.equal(describeToolActivity('find_in_page', { query: 'a' }, 'done', { query: 'b', total: 3 }), t('act.find.done', { query: 'b', total: 3 }));
  assert.equal(describeToolActivity('find_in_page', { query: 'a' }, 'done', { query: 'b', total: 0 }), t('act.find.none', { query: 'b', total: 0 }));
});

test('输入预览截到 20 字', () => {
  const s = describeToolActivity('input_text', { ref: 1, text: 'x'.repeat(30) }, 'run');
  assert.ok(s.includes('x'.repeat(20) + '…'));
  assert.ok(!s.includes('x'.repeat(21)));
});

test('坏 JSON（args 为 null）按空值兜底', () => {
  assert.doesNotThrow(() => describeToolActivity('navigate', null, 'run'));
});

test('未知工具走通用文案', () => {
  assert.equal(describeToolActivity('mystery', {}, 'run'), t('act.generic.run', { name: 'mystery' }));
});
