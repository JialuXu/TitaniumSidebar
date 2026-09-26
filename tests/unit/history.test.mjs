// core/history.js —— 历史会话存储与按条数/字节淘汰（验收标准第 32 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistoryStore, deriveSessionTitle, countTurns, isQuotaError,
  HistoryTooLargeError, HISTORY_RECORD_VERSION,
} from '../../extension/core/history.js';
import { createMemoryStorage } from '../helpers/memory-storage.mjs';

const INDEX = 'history.index';
const key = (id) => `history.session.${id}`;

function record(id, { size = 0, updatedAt = 0 } = {}) {
  return {
    v: HISTORY_RECORD_VERSION, id, title: `会话 ${id}`, createdAt: 0, updatedAt, turns: 1,
    messages: [{ role: 'user', content: 'x'.repeat(size), displayContent: 'q' }],
  };
}

const bytesOf = (id, r) => key(id).length + new TextEncoder().encode(JSON.stringify(r)).length;

test('标题压缩空白并截断', () => {
  assert.equal(deriveSessionTitle('  一 \n 二  '), '一 二');
  assert.equal(deriveSessionTitle('a'.repeat(70)), 'a'.repeat(60) + '…');
  assert.equal(deriveSessionTitle('abcdef', 3), 'abc…');
  assert.equal(deriveSessionTitle(null), '');
});

test('轮数只数用户真实发出的消息', () => {
  assert.equal(countTurns([
    { role: 'user', content: 'x', displayContent: 'x' },
    { role: 'user', content: '截图注入' },
    { role: 'assistant', content: 'y' },
    { role: 'user', content: 'z', displayContent: '' },
  ]), 2);
  assert.equal(countTurns(undefined), 0);
});

test('配额错误识别：chrome.storage 与 localStorage 两种说法', () => {
  assert.equal(isQuotaError(new Error('QUOTA_BYTES quota exceeded')), true);
  assert.equal(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true);
  assert.equal(isQuotaError(new TypeError('Converting circular structure to JSON')), false);
  assert.equal(isQuotaError(null), false);
});

test('保存、列出、载入、删除、清空', async () => {
  const storage = createMemoryStorage();
  const store = createHistoryStore(storage);
  assert.deepEqual(await store.list(), []);

  await store.save(record('a'));
  await store.save(record('b'));
  assert.deepEqual((await store.list()).map((e) => e.id), ['b', 'a']);
  assert.equal((await store.load('a')).title, '会话 a');
  assert.equal(await store.load('nope'), null);

  // 覆盖保存：挪到最前、不重复
  await store.save({ ...record('a'), title: '改过的标题' });
  const list = await store.list();
  assert.deepEqual(list.map((e) => e.id), ['a', 'b']);
  assert.equal(list[0].title, '改过的标题');
  assert.equal(typeof list[0].bytes, 'number');

  assert.deepEqual((await store.remove('a')).map((e) => e.id), ['b']);
  assert.equal(storage.data.has(key('a')), false);

  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.equal(storage.data.has(key('b')), false);
});

test('记录版本对不上按不存在处理', async () => {
  const storage = createMemoryStorage();
  await storage.set(key('old'), { ...record('old'), v: HISTORY_RECORD_VERSION + 1 });
  assert.equal(await createHistoryStore(storage).load('old'), null);
});

test('超过会话数上限淘汰最旧的，记录键同步删除', async () => {
  const storage = createMemoryStorage();
  const store = createHistoryStore(storage, { maxSessions: 3 });
  for (const id of ['1', '2', '3', '4']) await store.save(record(id));
  assert.deepEqual((await store.list()).map((e) => e.id), ['4', '3', '2']);
  assert.equal(storage.data.has(key('1')), false);
});

test('超过字节预算淘汰最旧的，合计不超预算', async () => {
  const r = (id) => record(id, { size: 1000 });
  const one = bytesOf('1', r('1'));
  const storage = createMemoryStorage();
  const store = createHistoryStore(storage, { maxBytes: one * 2 + 10 });
  for (const id of ['1', '2', '3']) await store.save(r(id));
  const list = await store.list();
  assert.deepEqual(list.map((e) => e.id), ['3', '2']);
  assert.ok(list.reduce((n, e) => n + e.bytes, 0) <= one * 2 + 10);
  assert.equal(storage.data.has(key('1')), false);
});

test('单段会话本身超预算：抛 HistoryTooLargeError，其他会话一条不动', async () => {
  const storage = createMemoryStorage();
  const store = createHistoryStore(storage, { maxBytes: 2000 });
  await store.save(record('small'));
  await assert.rejects(store.save(record('huge', { size: 5000 })), (err) => {
    assert.ok(err instanceof HistoryTooLargeError);
    assert.ok(err.bytes > 2000);
    return true;
  });
  assert.deepEqual((await store.list()).map((e) => e.id), ['small']);
  assert.ok(storage.data.has(key('small')));
});

test('旧索引项没有 bytes：下一次保存时补齐', async () => {
  const storage = createMemoryStorage();
  const legacy = record('legacy');
  await storage.set(key('legacy'), legacy);
  await storage.set(INDEX, [{ id: 'legacy', title: 't', createdAt: 0, updatedAt: 0, turns: 1 }]);
  await createHistoryStore(storage).save(record('new'));
  const list = await storage.get(INDEX);
  assert.equal(list.find((e) => e.id === 'legacy').bytes, bytesOf('legacy', legacy));
});

test('估算放得下但真实写入报配额满：逐条淘汰最旧的重试', async () => {
  const r = (id) => record(id, { size: 3000 });
  // 配额只够三条多一点：第四条写入时真实计量超限
  const storage = createMemoryStorage({ quotaBytes: bytesOf('1', r('1')) * 3 + 1500 });
  const store = createHistoryStore(storage);
  for (const id of ['1', '2', '3']) await store.save(r(id));
  await store.save(r('4'));
  assert.deepEqual((await store.list()).map((e) => e.id), ['4', '3', '2']);
  assert.equal(storage.data.has(key('1')), false);
  assert.ok(storage.data.has(key('4')));
});

test('非配额类写入失败原样抛出，不淘汰任何会话', async () => {
  const storage = createMemoryStorage({
    failOn: (k) => (k === key('bad') ? new TypeError('cannot serialize') : null),
  });
  const store = createHistoryStore(storage);
  await store.save(record('a'));
  await store.save(record('b'));
  await assert.rejects(store.save(record('bad')), TypeError);
  assert.deepEqual((await store.list()).map((e) => e.id), ['b', 'a']);
});
