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
 * 组装用户消息内容：带页面内容时包 <页面内容> 标签（结构骨架紧随其后），
 * 否则原样返回用户输入。同一会话只有首条消息（或「重新读取」后的下一条）携带。
 * 标签名随语言变化（中文 <页面内容>，英文 <page_content>），与 prompt 里的写法一致。
 * @param {string} userInput 用户输入
 * @param {string|null} pageText 脱敏后的页面文本，null 表示不携带
 * @param {string|null} [outlineText] 脱敏后的结构骨架文本，可缺省
 */
export function buildUserContent(userInput, pageText, outlineText) {
  if (!pageText) return userInput;
  const cTag = t('tag.content');
  const oTag = t('tag.outline');
  const outlineBlock = outlineText ? `<${oTag}>\n${outlineText}\n</${oTag}>\n\n` : '';
  return `<${cTag}>\n${pageText}\n</${cTag}>\n\n${outlineBlock}${userInput}`;
}
