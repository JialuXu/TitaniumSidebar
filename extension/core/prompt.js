// core/prompt.js —— Prompt 组装（平台无关层）
//
// 刻意保持简单：不规定输出模板、章节名或固定条数，
// 让模型根据页面类型和问题自行组织结构。
// 提示词正文按语言存在 core/i18n.js 里（中英各一套，含「用什么语言作答」这一句），
// 本文件只负责按本次请求的可用能力拼装。

import { t } from './i18n.js';

/**
 * 组装 system prompt：基础人设 + （可选）技能正文 + （可选）工具指引 + 操作/只读边界 + （可选）视觉指引。
 * 各段必须与本次请求实际注册的 tools 一致，否则会指引模型调用不存在的工具——
 * 因此技能的 body 恒拼（纯文本降级后任务约束仍有效），而提及具体工具名的
 * toolHint 只在真的带 tools 时拼；只读/动作护栏段永远排在技能段之后，技能无法越权。
 * @param {{ tools?: boolean, vision?: boolean, actions?: boolean, skill?: string|null }} [caps]
 *   本次请求可用的能力；skill 为激活技能的 id（外壳保证只传合法 id），null 表示未启用
 */
export function buildSystemPrompt({ tools = false, vision = false, actions = false, skill = null } = {}) {
  let prompt = t('prompt.base');
  if (skill) prompt += '\n' + t(`skill.${skill}.body`);
  if (tools) prompt += '\n' + t('prompt.tools');
  if (tools && skill) prompt += '\n' + t(`skill.${skill}.toolHint`);
  if (tools) prompt += '\n' + t(actions ? 'prompt.actions' : 'prompt.readonly');
  if (tools && vision) prompt += '\n' + t('prompt.vision');
  return prompt;
}

/**
 * 组装压缩上下文（/compact）那一轮的 system prompt。
 * 这一轮不注册 tools，因此不拼任何提及工具名的段落；与普通问答不同，
 * 摘要提示词可以规定摘要须覆盖的要点（普通问答仍不规定输出模板）。
 * @param {string} [instruction] 用户随命令给出的摘要指示（如 `/compact 只保留财报数字`）
 */
export function buildCompactPrompt(instruction = '') {
  let prompt = t('prompt.compact');
  if (instruction) prompt += '\n' + t('prompt.compactInstruction', { instruction });
  return prompt;
}

/**
 * 组装用户消息内容：带页面内容时包 <页面内容> 标签（结构骨架紧随其后），
 * 否则原样返回用户输入。每条消息发送前都会比对页面，只有内容确实变化时才重新携带；
 * 页面没变的消息原样返回，历史里那一份继续有效。
 * 标签名随语言变化（中文 <页面内容>，英文 <page_content>），与 prompt 里的写法一致。
 * @param {string} userInput 用户输入
 * @param {string|null} pageText 脱敏后的页面文本，null 表示不携带
 * @param {string|null} [outlineText] 脱敏后的结构骨架文本，可缺省
 * @param {string} [lead] 页面块之前的一句说明（如「用户已切换到新页面」），可缺省
 */
export function buildUserContent(userInput, pageText, outlineText, lead) {
  if (!pageText) return userInput;
  const cTag = t('tag.content');
  const oTag = t('tag.outline');
  const leadBlock = lead ? `${lead}\n\n` : '';
  const outlineBlock = outlineText ? `<${oTag}>\n${outlineText}\n</${oTag}>\n\n` : '';
  return `${leadBlock}<${cTag}>\n${pageText}\n</${cTag}>\n\n${outlineBlock}${userInput}`;
}

/**
 * 组装「页面有小幅变化」的用户消息：只带差异摘要，不重发全文。
 * 用于同一网址下页面内容被改动（用户翻页/展开、AI 操作了页面）的场景——
 * 全文重发一次就是上万字符，而差异通常只有几十行。
 * @param {string} userInput 用户输入
 * @param {string} diffText formatTextDiff 产出的变化摘要
 */
export function buildPageUpdate(userInput, diffText) {
  const uTag = t('tag.update');
  return `<${uTag}>\n${diffText}\n</${uTag}>\n\n${userInput}`;
}
