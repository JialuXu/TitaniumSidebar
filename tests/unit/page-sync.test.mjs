// core/page-sync.js —— 发送前的页面同步（验收标准第 5、13、26、30 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initialSentPage, decidePageSync, composeSendContent } from '../../extension/core/page-sync.js';
import { setLocale, t } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

const BODY = Array.from({ length: 60 }, (_, i) => `第 ${i} 条：一段足够长的页面正文，确保差异摘要比全文便宜。`).join('\n');

function page(overrides = {}) {
  return {
    url: 'https://a.test/list', title: '列表', maskedText: BODY, outlineText: '- main',
    textTotal: BODY.length, textShown: BODY.length, textCapped: false, ...overrides,
  };
}

/** 模拟一次发送：判定 + 组装，返回新的 sentPage 与内容 */
function send(sentPage, p, input = '问题') {
  const sync = decidePageSync(sentPage, p, false);
  return { sync, ...composeSendContent(input, p, sentPage, sync) };
}

test('第一条消息带全文', () => {
  const r = send(initialSentPage(), page());
  assert.deepEqual(r.sync, { kind: 'full', first: true, loading: false });
  assert.ok(r.content.includes('<页面内容>\n' + BODY));
  assert.ok(r.content.includes('<页面结构>\n- main'));
  assert.ok(r.content.endsWith('问题'));
  assert.equal(r.sentPage.url, 'https://a.test/list');
  assert.equal(r.sentPage.textTotal, BODY.length);
});

test('第 5 条：页面没变，第二条消息不重复携带', () => {
  const first = send(initialSentPage(), page());
  const second = send(first.sentPage, page(), '追问');
  assert.deepEqual(second.sync, { kind: 'none' });
  assert.equal(second.content, '追问');
  assert.equal(second.sentPage, first.sentPage);
});

test('第 5 条：小幅变化只带差异块，并累计差异量', () => {
  const first = send(initialSentPage(), page());
  const changed = page({ maskedText: BODY + '\n展开后多出的一行', textTotal: 999 });
  const r = send(first.sentPage, changed);
  assert.equal(r.sync.kind, 'diff');
  assert.ok(r.content.startsWith('<页面更新>\n'));
  assert.ok(r.content.includes('+ 展开后多出的一行'));
  assert.equal(r.sentPage.diffChars, r.sync.diff.length);
  assert.equal(r.sentPage.text, changed.maskedText);
  // 差异块不重发全文，模型手里那份的长度基准不变
  assert.equal(r.sentPage.textTotal, BODY.length);
});

test('累计差异超过上限后改发全文', () => {
  const first = send(initialSentPage(), page());
  const r = send({ ...first.sentPage, diffChars: 3990 }, page({ maskedText: BODY + '\n又一行' }));
  assert.equal(r.sync.kind, 'full');
  assert.equal(r.sentPage.diffChars, 0);
});

test('第 13 条：换了网址发全文，并前置「页面已经变了」', () => {
  const first = send(initialSentPage(), page());
  const r = send(first.sentPage, page({ url: 'https://a.test/detail' }));
  assert.equal(r.sync.navigated, true);
  assert.ok(r.content.startsWith(t('prompt.leadSwitched')));
});

test('第 26 条：读取时仍在加载，页面块前加一句', () => {
  const sync = decidePageSync(initialSentPage(), page(), true);
  const { content } = composeSendContent('q', page(), initialSentPage(), sync);
  assert.ok(content.startsWith(t('prompt.leadLoading')));
});

test('页面读不到：交代一句并记下，再次可读时无条件重发', () => {
  const first = send(initialSentPage(), page());
  const gone = composeSendContent('q', page(), first.sentPage, { kind: 'unreadable', changed: true });
  assert.ok(gone.content.startsWith(t('prompt.leadPageGone')));
  assert.equal(gone.sentPage.gone, true);

  // 回到同一页、内容一字不差，也要重发
  const back = send(gone.sentPage, page());
  assert.equal(back.sync.kind, 'full');
  assert.equal(back.sentPage.gone, undefined);

  // 页面本来就读不到、也没给模型看过：什么都不说
  assert.equal(composeSendContent('q', page(), initialSentPage(), { kind: 'unreadable', changed: false }).content, 'q');
});

test('第 30 条：只有控件没有正文的页面照样给页面块，之后不重复发', () => {
  const blank = page({ maskedText: '', textTotal: 0, textShown: 0 });
  const first = send(initialSentPage(), blank);
  assert.ok(first.content.includes(`<页面内容>\n${t('prompt.pageNoText')}\n</页面内容>`));
  assert.equal(send(first.sentPage, blank).sync.kind, 'none');
});

test('English 下标签名随语言切换', () => {
  setLocale('en');
  const r = send(initialSentPage(), page());
  assert.ok(r.content.includes('<page_content>'));
  assert.ok(r.content.includes('<page_outline>'));
});
