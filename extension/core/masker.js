// core/masker.js —— 发送前脱敏（平台无关层）
//
// 对提取文本做正则替换并统计命中数。匹配顺序刻意“先长后短”：
// 18 位身份证若放在后面，会先被 14–19 位银行卡规则误伤；
// 替换产物中间是 *，不会再被后续规则二次命中。
// 两侧加 (?<!\d)/(?!\d) 断言，避免从更长的数字串中间截取。

const RULES = [
  {
    key: 'idCard', // 身份证号：18 位，末位可为 X —— 保留前 4 后 2，中间打码
    re: /(?<!\d)\d{17}[\dXx](?![\dXx])/g,
    mask: (m) => m.slice(0, 4) + '*'.repeat(12) + m.slice(16),
  },
  {
    key: 'bankCard', // 银行卡号：14–19 位连续数字 —— 保留后 4 位，其余打码
    re: /(?<!\d)\d{14,19}(?!\d)/g,
    mask: (m) => '*'.repeat(m.length - 4) + m.slice(-4),
  },
  {
    key: 'phone', // 手机号：1[3-9] 开头共 11 位 —— 全部打码只留首位
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    mask: () => '1**********',
  },
];

/**
 * 脱敏并统计命中数。
 * @param {string} text 待脱敏文本
 * @returns {{ text: string, hits: { idCard: number, bankCard: number, phone: number } }}
 */
export function maskSensitive(text) {
  const hits = { idCard: 0, bankCard: 0, phone: 0 };
  let result = text || '';
  for (const rule of RULES) {
    result = result.replace(rule.re, (m) => {
      hits[rule.key] += 1;
      return rule.mask(m);
    });
  }
  return { text: result, hits };
}
