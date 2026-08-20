// core/compact.js —— 压缩上下文（/compact）：命令解析与请求链裁剪（平台无关层）
//
// 压缩 = 另调一次模型把此前对话收成一份摘要，之后发给模型的请求只带
// 「摘要 + 压缩点之后的新消息」。界面上的气泡与历史回放仍是原文，变的只是请求链。
// 本模块只管两件纯数据的事：把输入解析成命令、把消息数组裁成请求链；
// 调模型、UI 提示与落库都在外壳。
//
// 摘要正文的语言在压缩那一刻就定了（与「切语言不改写历史」同一原则），
// 因此包摘要标签也在那一刻完成——buildCompactState 存的是包好的整段内容，
// 后续切语言不会把已生成的摘要改写成另一种语言。

import { t } from './i18n.js';

/**
 * 解析压缩命令。整段以 /compact 开头才算，大小写不敏感、允许前导空白；
 * 要求词边界——`/compact` 之后必须是空白或行尾，`/compaction` 这类同前缀输入
 * 仍按普通提问发出。其后的文字是可选的摘要指示（如 `/compact 只保留财报数字`）。
 * @param {string} text 输入框整段文本
 * @returns {{ instruction: string }|null} 不是压缩命令时返回 null
 */
export function parseCompactCommand(text) {
  const m = /^\s*\/compact(?=\s|$)([\s\S]*)$/i.exec(String(text || ''));
  return m ? { instruction: m[1].trim() } : null;
}

/**
 * 把模型产出的摘要包成压缩状态。boundary 是压缩点在消息数组中的下标：
 * 该下标之前的原文不再进入请求，之后的新消息照常携带。
 * @param {string} summary 模型返回的摘要正文
 * @param {number} boundary 压缩点下标（压缩成功时即当时的 messages.length）
 */
export function buildCompactState(summary, boundary) {
  const tag = t('tag.summary');
  return {
    summary: `<${tag}>\n${String(summary || '').trim()}\n</${tag}>`,
    boundary: Math.max(0, boundary | 0),
  };
}

/**
 * 请求链裁剪：未压缩时原样返回，已压缩则返回「摘要消息 + boundary 之后的新消息」。
 * 摘要用 role:'user' 而非 assistant——部分后端要求首条非 system 消息必须是 user；
 * 代价是刚压缩完的下一条请求会出现两条连续 user 消息，OpenAI 兼容实现接受。
 *
 * 传入的是未净化的原始消息数组（`_` 前缀字段由外壳在这之后统一剔除）：
 * boundary 是原始数组的下标，必须先裁后净化，否则被过滤掉的消息会让下标漂移。
 * boundary 只会落在「用户消息之前」或「数组末尾」（见外壳的压缩成功与重新生成两处写入），
 * 因此裁剪不会把 assistant(tool_calls) 与其 tool 消息拆散。
 *
 * @param {Array<object>} messages 完整消息数组
 * @param {{summary: string, boundary: number}|null} compact 压缩状态，null 表示未压缩
 */
export function compactRequestTail(messages, compact) {
  const list = messages || [];
  if (!compact || !compact.summary) return list.slice();
  const boundary = Math.max(0, Math.min(compact.boundary || 0, list.length));
  return [{ role: 'user', content: compact.summary }, ...list.slice(boundary)];
}
