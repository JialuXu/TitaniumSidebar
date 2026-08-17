// core/skills.js —— 预置技能目录与 URL 匹配（平台无关层）
//
// 技能 = 声明式提示词包（纯文本，无代码，不动工具集）：本文件只登记 id 与
// URL 建议名单，全部文案按约定 key 存在 core/i18n.js：
//   skill.<id>.name      技能名（菜单项、chip、建议条）
//   skill.<id>.desc      一句话说明（选择器 tooltip）
//   skill.<id>.body      技能指令正文——激活后恒拼入 system prompt
//   skill.<id>.toolHint  提及具体工具名的指引段——仅本次请求真的带 tools 时拼
// 零 chrome.*、零 DOM，SDK 外壳可原封复用；取当前标签页 URL 的动作留给外壳。

export const PRESET_SKILLS = [
  // 表格提取整理（CSV）：任何带表格的页面都适用，无 URL 名单，仅手动启用
  { id: 'csv-table', urlHosts: [] },
  // 财报/财务分析：信息披露与交易所站点
  {
    id: 'fin-report',
    urlHosts: ['cninfo.com.cn', 'data.eastmoney.com', 'sse.com.cn', 'szse.cn', 'hkexnews.hk'],
  },
  // 股市行情解读：行情站点
  {
    id: 'market-brief',
    urlHosts: [
      'quote.eastmoney.com', 'xueqiu.com', '10jqka.com.cn',
      'finance.sina.com.cn', 'futunn.com', 'finance.yahoo.com',
    ],
  },
];

/** 全部预置技能（返回浅拷贝，防外部误改目录） */
export function listSkills() {
  return PRESET_SKILLS.slice();
}

/** 按 id 取技能，不存在返回 null */
export function getSkill(id) {
  return PRESET_SKILLS.find((s) => s.id === id) || null;
}

/**
 * 取 URL 的 hostname（小写、不含端口）；解析失败或非 http/https 返回 ''。
 * 外壳用它生成建议条的 dismissed key（`host|skillId`），不必自行解析 URL。
 */
export function hostOfUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.hostname.toLowerCase();
}

// host 后缀匹配：必须对齐完整域名段——'eastmoney.com' 命中 'quote.eastmoney.com'，
// 但 'money.com' 不命中 'eastmoney.com'（裸 endsWith 会误伤，段边界用 '.' 保证）
function hostMatches(host, pattern) {
  return host === pattern || host.endsWith('.' + pattern);
}

/** 按 URL 命中技能建议名单，返回命中的技能数组（可多个）；受限页/非法 URL 返回 [] */
export function matchSkillsByUrl(url) {
  const host = hostOfUrl(url);
  if (!host) return [];
  return PRESET_SKILLS.filter((s) => s.urlHosts.some((p) => hostMatches(host, p)));
}
