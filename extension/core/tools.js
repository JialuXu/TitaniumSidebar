// core/tools.js —— 感知工具的定义与分发（平台无关层）
//
// 工具的“执行”由外壳注入的 provider 承担（executeScript/captureVisibleTab 等
// chrome.* 接线都在外壳），core 只负责：定义 OpenAI 工具协议、解析参数、
// 调 provider、把结果序列化成发给模型的文本，并统一过 provider.mask 脱敏。
// provider 接口：
//   searchInPage({ query, maxResults })  → searchPage 返回值
//   listElements({ scope, query })       → { elements, total, truncated }
//   highlight({ ref })                   → highlightElement 返回值
//   captureScreenshot()                  → { dataUrl, markCount, viewport }
//   mask(text)                           → string（未开脱敏时为恒等函数）
// provider 方法失败时 throw Error（message 为中文，将直接作为工具结果给模型）。

import { formatElements, formatSearchResults } from './format.js';

/** 每个用户回合允许的最大工具调用轮数，超过后强制模型直接作答 */
export const MAX_TOOL_ROUNDS = 5;

/**
 * 构建 OpenAI 工具定义列表。
 * @param {{ vision?: boolean }} [caps] vision=false 时不含 capture_screenshot
 */
export function buildToolDefs({ vision = false } = {}) {
  const defs = [
    {
      type: 'function',
      function: {
        name: 'find_in_page',
        description:
          '在当前网页的完整文本中搜索关键词。<页面内容> 可能因过长被截断，' +
          '其中找不到的信息用本工具查找。返回每处匹配的上下文片段。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或短语，字面匹配、大小写不敏感，不支持正则' },
            max_results: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回几处匹配，默认 5' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_elements',
        description:
          '列出当前网页的可交互元素（链接、按钮、输入框等），每项带稳定编号 ref。' +
          '用于了解页面有哪些操作入口，或为 highlight_element 提供编号。',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['viewport', 'page'],
              description: 'viewport=仅当前可见区域（默认），page=整个页面',
            },
            query: { type: 'string', description: '可选，按元素名称包含关系过滤' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'highlight_element',
        description:
          '在页面上用高亮框短暂标出指定编号的元素（必要时自动滚动到它），' +
          '帮用户在页面上找到它。只做视觉提示，绝不点击或修改页面。',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'integer', description: 'list_elements 或截图标注中的元素编号' },
          },
          required: ['ref'],
        },
      },
    },
  ];
  if (vision) {
    defs.push({
      type: 'function',
      function: {
        name: 'capture_screenshot',
        description:
          '截取当前浏览器可见视口的截图，图上自动用编号框标注可交互元素（编号即 ref）。' +
          '用于理解布局、图表、图片等文字无法表达的内容。注意：截图内容不经过脱敏。',
        parameters: { type: 'object', properties: {} },
      },
    });
  }
  return defs;
}

/**
 * 执行一次工具调用，产出回填消息历史所需的对象。
 * @param {{ id: string, name: string, arguments: string }} call llm-client 拼装好的调用
 * @param {object} provider 外壳注入的执行接口（见文件头注释）
 * @returns {Promise<{
 *   toolMessage: { role: 'tool', tool_call_id: string, content: string },
 *   followUpMessage?: object,   // 截图工具专用：紧随 tool 消息的多模态 user 消息
 *   meta: { name: string, args: object|null, ok: boolean, data: object },
 * }>}
 */
export async function dispatchToolCall(call, provider) {
  const meta = { name: call.name, args: null, ok: false, data: {} };
  const reply = (content, followUpMessage) => ({
    toolMessage: { role: 'tool', tool_call_id: call.id, content },
    ...(followUpMessage ? { followUpMessage } : {}),
    meta,
  });

  // 参数解析容错：坏 JSON 不中断循环，把错误还给模型让它自我纠正
  let args = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return reply('工具参数不是合法 JSON，请检查后重新调用。');
  }
  meta.args = args;

  try {
    switch (call.name) {
      case 'find_in_page': {
        const query = String(args.query || '').trim();
        if (!query) return reply('缺少 query 参数。');
        const res = await provider.searchInPage({ query, maxResults: args.max_results });
        meta.ok = Boolean(res && res.ok);
        meta.data = { query, total: (res && res.total) || 0 };
        return reply(provider.mask(formatSearchResults(res, query)));
      }
      case 'list_elements': {
        const scope = args.scope === 'page' ? 'page' : 'viewport';
        const query = args.query ? String(args.query).trim() : '';
        const res = await provider.listElements({ scope, query });
        meta.ok = true;
        meta.data = { scope, count: res.elements.length, total: res.total };
        const scopeNote = scope === 'viewport' ? '（当前可见区域' : '（整页';
        const header = `${scopeNote}${query ? `，按「${query}」过滤` : ''}，共 ${res.total} 个）\n`;
        return reply(provider.mask(header + formatElements(res.elements, { total: res.total })));
      }
      case 'highlight_element': {
        const ref = Number(args.ref);
        const res = await provider.highlight({ ref });
        if (res && res.ok) {
          meta.ok = true;
          meta.data = { ref, name: res.name };
          return reply(provider.mask(`已在页面上高亮元素 [${ref}]${res.name ? ` "${res.name}"` : ''}，数秒后自动消失。`));
        }
        const reason = res && res.reason;
        meta.data = { ref, reason };
        if (reason === 'stale') return reply('元素编号已过期（页面已刷新或跳转），请先调用 list_elements 获取最新编号。');
        if (reason === 'bad-ref') return reply(`没有编号为 ${args.ref} 的元素，请用 list_elements 确认编号。`);
        if (reason === 'hidden') return reply(`元素 [${ref}] 当前不可见（可能在折叠区域内），无法高亮。`);
        return reply(`元素 [${ref}] 已从页面上消失，无法高亮。`);
      }
      case 'capture_screenshot': {
        const shot = await provider.captureScreenshot();
        meta.ok = true;
        meta.data = { markCount: shot.markCount, w: shot.viewport.w, h: shot.viewport.h };
        return reply(
          `截图已完成，图片见紧随其后的一条消息。视口 ${shot.viewport.w}×${shot.viewport.h}，` +
            `标注了 ${shot.markCount} 个可交互元素（编号即 ref）。`,
          {
            role: 'user',
            content: [
              { type: 'text', text: '（系统注入）以下是当前视口截图，编号框对应元素 ref：' },
              { type: 'image_url', image_url: { url: shot.dataUrl } },
            ],
            _kind: 'tool-image',
          }
        );
      }
      default:
        return reply(`未知工具 ${call.name}，可用工具以本次请求的 tools 定义为准。`);
    }
  } catch (err) {
    // provider 抛出的中文错误（标签页切换、注入失败、截图失败等）直接作为工具结果
    return reply((err && err.message) || '工具执行失败。');
  }
}
