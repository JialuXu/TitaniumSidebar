// core/context-meter.js —— 上下文用量估算（平台无关层）
//
// 为什么要提醒：压缩本身也要把此前对话整段发给模型，等普通请求已经超窗报错，
// 压缩同样会失败，只剩「新对话」。所以得在还压得动的时候就提醒用户。
//
// 怎么估：拿「下一次请求实际会发出去的那条链」（system prompt + 请求链 + tools 定义）
// 按字符数估 token。各家分词器差得远（同一段中文，DeepSeek 与 Llama 能差一倍），
// 所以只把字符估算当基线：接口在流里报了 usage.prompt_tokens，就用它与同一请求的
// 估算值之比校准，此后的估算都乘上这个系数。不报 usage 的接口就一直用基线。
//
// 本模块只做纯计算；何时测、提示长什么样、系数存在哪都是外壳的事。

/** 接口套没填上下文窗口时的估算口径：取常见部署里偏保守的一档，宁可早提醒 */
export const DEFAULT_CONTEXT_WINDOW = 64000;

/** 提醒阈值（占窗口的比例）：warn 建议压缩，high 催促压缩 */
export const CONTEXT_WARN = 0.7;
export const CONTEXT_HIGH = 0.85;

// 一张图的粗估：各家按分辨率计费，差异很大；截图在回合收尾就换成占位，这里只求量级
const IMAGE_TOKENS = 1000;
// 每条消息的角色标记等固定开销
const MESSAGE_OVERHEAD = 4;
// 汉字、假名、韩文与全角符号按字计，其余按字符数折算
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/g;

function textTokens(s) {
  const str = String(s || '');
  if (!str) return 0;
  const cjk = (str.match(CJK) || []).length;
  return cjk * 0.8 + (str.length - cjk) / 3.5;
}

function contentTokens(content) {
  if (typeof content === 'string') return textTokens(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (part && part.type === 'image_url') n += IMAGE_TOKENS;
    else if (part && typeof part.text === 'string') n += textTokens(part.text);
  }
  return n;
}

/**
 * 估算一次请求的 prompt token 数（未校准的基线）。
 * @param {Array<object>} messages 出网形态的请求消息（buildRequestMessages 的返回值）
 * @param {Array<object>} [tools] 本次请求注册的工具定义
 */
export function estimateTokens(messages, tools) {
  let n = 0;
  for (const m of messages || []) {
    n += MESSAGE_OVERHEAD + contentTokens(m.content);
    for (const c of m.tool_calls || []) {
      n += textTokens(c.function && c.function.name) + textTokens(c.function && c.function.arguments);
    }
  }
  if (tools && tools.length) n += textTokens(JSON.stringify(tools));
  return Math.round(n);
}

/**
 * 由接口报的真实 prompt_tokens 与同一请求的估算值得出校准系数。
 * 数据不可用时返回 null（调用方沿用原系数）；系数夹在合理区间，防个别网关报出离谱的数。
 */
export function calibrationRatio(promptTokens, estimated) {
  if (!(promptTokens > 0) || !(estimated > 0)) return null;
  return Math.min(Math.max(promptTokens / estimated, 0.25), 4);
}

/**
 * 用量与提醒档位。
 * @param {number} estimated estimateTokens 的基线估算
 * @param {{ratio?: number, window?: number}} opts ratio 校准系数（缺省 1），window 上下文窗口
 * @returns {{ used: number, window: number, pct: number, level: 'ok'|'warn'|'high' }}
 */
export function contextUsage(estimated, { ratio = 1, window = DEFAULT_CONTEXT_WINDOW } = {}) {
  const win = window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  const used = Math.round((estimated || 0) * (ratio > 0 ? ratio : 1));
  const share = used / win;
  return {
    used,
    window: win,
    pct: Math.round(share * 100),
    level: share >= CONTEXT_HIGH ? 'high' : share >= CONTEXT_WARN ? 'warn' : 'ok',
  };
}

/** 档位的先后，外壳据此判断「是否升档」（同一档只提醒一次） */
export const LEVEL_RANK = { ok: 0, warn: 1, high: 2 };

/** token 数的简写：12345 → 12K；不足 1000 原样 */
export function formatTokens(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.max(0, Math.round(n || 0)));
}
