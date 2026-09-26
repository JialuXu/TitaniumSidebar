// core/citation.js —— 引用块出处校验（验收标准第 3、24 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, verifyQuote, buildQuoteCorpus } from '../../extension/core/citation.js';

const PAGE = '第一章 总则\n本办法所称 客户 是指在本行开立账户的个人。\n第二章 附则';

test('normalizeText 只消除空白', () => {
  assert.equal(normalizeText(' a b\n\tc '), 'abc');
  assert.equal(normalizeText(null), '');
});

test('原文引用（忽略空白差异）通过校验', () => {
  assert.equal(verifyQuote('本办法所称客户是指在本行开立账户的个人。', PAGE), true);
  assert.equal(verifyQuote('本办法所称 客户\n是指在本行', PAGE), true);
});

test('编造的引文不通过', () => {
  assert.equal(verifyQuote('本办法所称客户是指全体自然人。', PAGE), false);
});

test('归一化后不足 6 个字符不给徽标', () => {
  assert.equal(verifyQuote('第一章', PAGE), false);
  assert.equal(verifyQuote('。', PAGE), false);
});

test('引文语料 = 页面文本 + 同一网址下按位置读回的正文（去掉首尾两行自述）', () => {
  const messages = [
    { role: 'user', content: '问题' },
    { role: 'tool', content: '（已读取正文第 12000–12050 字）\n截断之外的原文段落在这里\n（后面还有 100 字）', _read: { start: 12000, end: 12050, url: 'https://a.test/' } },
    { role: 'tool', content: '头\n别的页面读到的原文\n尾', _read: { start: 0, end: 10, url: 'https://b.test/' } },
    { role: 'tool', content: '头\n已被回收成占位的消息\n尾' },
  ];
  const corpus = buildQuoteCorpus(PAGE, 'https://a.test/', messages);
  assert.ok(corpus.includes(PAGE));
  assert.ok(corpus.includes('截断之外的原文段落在这里'));
  assert.ok(!corpus.includes('已读取正文'), '工具自述的首行不算原文');
  assert.ok(!corpus.includes('后面还有'), '工具自述的末行不算原文');
  assert.ok(!corpus.includes('别的页面读到的原文'));
  assert.ok(!corpus.includes('已被回收成占位的消息'));
  assert.equal(verifyQuote('截断之外的原文段落在这里', corpus), true);
});

test('没有页面文本也能只用读回的正文', () => {
  const corpus = buildQuoteCorpus('', '', [{ content: 'h\n只读回的一段原文\nt', _read: { url: 'x' } }]);
  assert.equal(corpus, '只读回的一段原文');
});
