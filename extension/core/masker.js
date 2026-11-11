// core/masker.js —— 发送前脱敏（平台无关层）
//
// 对提取文本做正则替换并统计命中数。匹配顺序刻意“先长后短”：
// 18 位身份证若放在后面，会先被 14–19 位银行卡规则误伤；
// 替换产物中间是 *，不会再被后续规则二次命中。
// 两侧加 (?<!\d)/(?!\d) 断言，避免从更长的数字串中间截取。
// 邮箱不在规则里：邮件、工单这类页面上，谁发给谁正是模型要读懂的内容。

// Luhn 校验：分组写法的卡号靠它与「恰好四个四位数排成一行」区分开
function luhnValid(digits) {
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// mask 返回 null 表示这一处不算命中，原样保留
const RULES = [
  {
    key: 'idCard', // 身份证号：18 位，末位可为 X —— 保留前 4 后 2，中间打码
    re: /(?<!\d)\d{17}[\dXx](?![\dXx])/g,
    mask: (m) => m.slice(0, 4) + '*'.repeat(12) + m.slice(16),
  },
  {
    key: 'bankCard', // 银行卡号：14–19 位连续数字 —— 保留后 4 位，其余打码
    // 不加 Luhn 校验：对公账号、存折账号不满足 Luhn，宁可多打码订单号也不漏账号
    re: /(?<!\d)\d{14,19}(?!\d)/g,
    mask: (m) => '*'.repeat(m.length - 4) + m.slice(-4),
  },
  {
    key: 'bankCard', // 分组写法的卡号：四位一组，空格或连字符分隔，16–19 位 —— 保留后 4 位与分隔符
    // 首位限 3–6、9（各卡组织的发卡行标识）且过 Luhn 校验：财报表头的「2021 2022 2023 2024」
    // 与并排的四位数金额同样是四位一组，没有这两道闸会被整行打码
    re: /(?<![\d*])[3-69]\d{3}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{1,3})?(?![\d*])/g,
    mask: (m) => (luhnValid(m.replace(/\D/g, '')) ? m.replace(/\d(?=(?:\D*\d){4})/g, '*') : null),
  },
  {
    key: 'phone', // 手机号：1[3-9] 开头共 11 位，可写成 3-4-4 分组、可带 +86 / 86 前缀 —— 只留首位
    // 空格分组只在带前缀时才认：并排的「135 2023 2024」三个数与空格分组的手机号长得一样
    re: /(?<![\d*])(?:(?:\+?86[ -]?)1[3-9]\d([ -]?)\d{4}\1\d{4}|1[3-9]\d(-?)\d{4}\2\d{4})(?!\d)/g,
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
      const masked = rule.mask(m);
      if (masked === null) return m;
      hits[rule.key] += 1;
      return masked;
    });
  }
  return { text: result, hits };
}
