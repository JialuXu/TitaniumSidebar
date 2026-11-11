// core/masker.js —— 发送前脱敏（验收标准第 4、24、46 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitive } from '../../extension/core/masker.js';

test('手机号只留首位', () => {
  const { text, hits } = maskSensitive('联系人 13812345678，工作日可打');
  assert.equal(text, '联系人 1**********，工作日可打');
  assert.deepEqual(hits, { idCard: 0, bankCard: 0, phone: 1 });
});

test('18 位身份证保留前 4 后 2，末位 X 大小写都认', () => {
  assert.equal(maskSensitive('110101199003071234').text, '1101************34');
  assert.equal(maskSensitive('11010119900307123X').text, '1101************3X');
  assert.equal(maskSensitive('11010119900307123x').text, '1101************3x');
});

test('身份证先于银行卡匹配，不被 14–19 位银行卡规则误伤', () => {
  const { hits } = maskSensitive('证件号 110101199003071234');
  assert.deepEqual(hits, { idCard: 1, bankCard: 0, phone: 0 });
});

test('银行卡号保留后 4 位', () => {
  assert.equal(maskSensitive('卡号 6222021234567890123').text, '卡号 ***************0123');
  assert.equal(maskSensitive('62220212345678').text, '**********5678');
});

test('不从更长的数字串中间截取', () => {
  // 20 位流水号：比银行卡长，不应被截出一段打码
  assert.equal(maskSensitive('12345678901234567890').text, '12345678901234567890');
  // 13 位数字里嵌着一个手机号形状的片段
  assert.deepEqual(maskSensitive('0138123456789').hits, { idCard: 0, bankCard: 0, phone: 0 });
});

test('多处命中分别计数，打码产物不被二次命中', () => {
  const { text, hits } = maskSensitive('A 13812345678 B 13987654321 C 6222021234567890');
  assert.deepEqual(hits, { idCard: 0, bankCard: 1, phone: 2 });
  assert.equal(maskSensitive(text).hits.phone, 0);
  assert.equal(maskSensitive(text).hits.bankCard, 0);
});

test('第 46 条：带连字符或 +86 前缀的手机号', () => {
  for (const s of ['138-1234-5678', '+86 13812345678', '+86-138-1234-5678', '+86 138 1234 5678', '8613812345678']) {
    assert.deepEqual(maskSensitive(s), { text: '1**********', hits: { idCard: 0, bankCard: 0, phone: 1 } }, s);
  }
});

test('第 46 条：四位一组的卡号保留后 4 位与分隔符', () => {
  assert.equal(maskSensitive('卡号 6222 0212 3456 7894').text, '卡号 **** **** **** 7894');
  assert.equal(maskSensitive('4111-1111-1111-1111').text, '****-****-****-1111');
  assert.equal(maskSensitive('6222 0212 3456 7890 128').text, '**** **** **** ***0 128'); // 19 位
  assert.equal(maskSensitive('4111 1111 1111 1111').hits.bankCard, 1);
});

test('第 46 条：并排的数字不被当成分组写法的号码', () => {
  const same = (s) => assert.deepEqual(maskSensitive(s), { text: s, hits: { idCard: 0, bankCard: 0, phone: 0 } }, s);
  same('2021 2022 2023 2024');   // 财报表头的年份
  same('4111 1111 1111 1112');   // 四位一组但过不了 Luhn 校验
  same('1200 3400 5600 7800');   // 首位不是发卡行标识
  same('135 2023 2024');         // 没有前缀的空格分组不当手机号
  same('营收 1,381,234.5678');
});

test('空值返回空串', () => {
  assert.deepEqual(maskSensitive(''), { text: '', hits: { idCard: 0, bankCard: 0, phone: 0 } });
  assert.equal(maskSensitive(null).text, '');
  assert.equal(maskSensitive(undefined).text, '');
});
